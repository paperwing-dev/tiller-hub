import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { getEnvLifecycleStub } from "./helpers";
import { getHub, projectAndPersistEnvSummary } from "./env/service";
import { CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES } from "../shared/cloudflare-timeout";

const STOP_CONTROL_PORT = 8790;
const STOP_CONTROL_PREPARE_PATH = "/prepare-stop";
const STOP_CONTROL_PREPARE_IDLE_PATH = "/prepare-idle-stop";
const IDLE_TIMEOUT_STORAGE_KEY = "idle-timeout-ms";

interface IdleStopPreparation {
  eligible: boolean;
  remainingIdleMs: number;
  reason: string;
  claimId?: string;
  error?: string;
}

// Cloudflare Container DO for sandboxed coding environments.
// Workspace state now lives in WorkspaceDO so this class only manages
// container lifecycle and idle auto-stop.
//
// IMPORTANT: onStart / onStop must NOT write full env rows back to KV.
// KV is eventually consistent — a read-modify-write here can clobber
// fresh snapshot metadata written by the snapshot upload handler,
// causing file loss on restart. EnvLifecycleDO is the runtime-phase
// authority; all API read paths project its state onto KV metadata.

export class SandboxDO extends Container<Env> {
  sleepAfter = `${CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES}m`;
  stopControlPort = STOP_CONTROL_PORT;
  lifecycleOpStorageKey = "lifecycle-op-id";
  configuredIdleTimeoutMs = CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES * 60_000;

  private formatStopControlUnavailableError(error: unknown): Error {
    const message = error instanceof Error ? error.message : String(error);
    if (
      message.includes("not listening in the TCP address")
      || message.includes("ECONNREFUSED")
      || message.includes("fetch failed")
    ) {
      return new Error(
        "Sandbox image is missing the internal stop-control service. Rebuild and redeploy the sandbox image so it matches the current hub worker.",
      );
    }
    return error instanceof Error ? error : new Error(message);
  }

  private async prepareDurableStop(
    stopOpId?: string | null,
    idleClaimId?: string | null,
  ): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }

    const controlPort = this.ctx.container.getTcpPort(this.stopControlPort);
    const headers = new Headers();
    if (stopOpId?.trim()) {
      headers.set("X-Tiller-Lifecycle-Op-Id", stopOpId.trim());
    }
    if (idleClaimId?.trim()) {
      headers.set("X-Tiller-Idle-Stop-Claim-Id", idleClaimId.trim());
    }
    let response: Response;
    try {
      response = await controlPort.fetch(`http://127.0.0.1${STOP_CONTROL_PREPARE_PATH}`, {
        method: "POST",
        headers,
      });
    } catch (error) {
      throw this.formatStopControlUnavailableError(error);
    }
    if (!response.ok) {
      const body = (await response.text().catch(() => "")).trim();
      let message = body;
      if (body) {
        try {
          const parsed = JSON.parse(body) as { error?: unknown };
          if (typeof parsed.error === "string" && parsed.error.trim()) {
            message = parsed.error.trim();
          }
        } catch {
          // Keep the raw response body when it is not JSON.
        }
      }
      throw new Error(
        message || `Stop preparation failed (HTTP ${response.status}).`,
      );
    }
  }

  private async requestIdleStopPreparation(idleTimeoutMs: number): Promise<IdleStopPreparation> {
    const fallback: IdleStopPreparation = {
      eligible: false,
      remainingIdleMs: idleTimeoutMs,
      reason: "activity_unavailable",
    };
    if (!this.ctx.container?.running) return fallback;
    try {
      const controlPort = this.ctx.container.getTcpPort(this.stopControlPort);
      const response = await controlPort.fetch(`http://127.0.0.1${STOP_CONTROL_PREPARE_IDLE_PATH}`, {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ idleTimeoutMs }),
      });
      const body = await response.json().catch(() => null) as {
        eligible?: unknown;
        remainingIdleMs?: unknown;
        reason?: unknown;
        claimId?: unknown;
        error?: unknown;
      } | null;
      if (!body || typeof body.eligible !== "boolean") return fallback;
      return {
        eligible: response.ok && body.eligible,
        remainingIdleMs: typeof body.remainingIdleMs === "number" && Number.isFinite(body.remainingIdleMs)
          ? Math.max(0, body.remainingIdleMs)
          : idleTimeoutMs,
        reason: typeof body.reason === "string"
          ? body.reason
          : response.ok ? "not_eligible" : "activity_unavailable",
        ...(typeof body.claimId === "string" ? { claimId: body.claimId } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
      };
    } catch (error) {
      console.warn("[sandbox] Idle activity control is unavailable; leaving container running:", error);
      return {
        ...fallback,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async releaseIdleStopPreparation(claimId?: string): Promise<void> {
    if (!claimId || !this.ctx.container?.running) return;
    try {
      const controlPort = this.ctx.container.getTcpPort(this.stopControlPort);
      await controlPort.fetch(`http://127.0.0.1${STOP_CONTROL_PREPARE_IDLE_PATH}`, {
        method: "POST",
        headers: new Headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action: "release", claimId }),
      });
    } catch (error) {
      console.warn("[sandbox] Failed to release idle-stop input fence:", error);
    }
  }

  private scheduleNextIdleCheck(delayMs: number): void {
    const safeDelayMs = Math.max(1_000, Math.ceil(delayMs));
    this.sleepAfter = `${Math.ceil(safeDelayMs / 1_000)}s`;
    this.renewActivityTimeout();
  }

  async startSandbox(
    slug: string,
    envVars: Record<string, string>,
    idleTimeoutMinutes?: number,
    startOpId?: string | null,
  ): Promise<void> {
    // Persist slug so onActivityExpired can update KV status
    await this.ctx.storage.put("slug", slug);
    if (startOpId?.trim()) {
      await this.ctx.storage.put(this.lifecycleOpStorageKey, startOpId.trim());
    }

    if (idleTimeoutMinutes !== undefined && idleTimeoutMinutes > 0) {
      this.sleepAfter = `${idleTimeoutMinutes}m`;
      this.configuredIdleTimeoutMs = idleTimeoutMinutes * 60_000;
    }
    await this.ctx.storage.put(
      IDLE_TIMEOUT_STORAGE_KEY,
      this.configuredIdleTimeoutMs || CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES * 60_000,
    );
    // When idleTimeoutMinutes is 0 or undefined, keep Tiller's shared default.
    // There is no way to truly disable sleepAfter; the settings UI caps at 1440 (24h).

    await this.startAndWaitForPorts({
      ports: [this.stopControlPort],
      cancellationOptions: {
        portReadyTimeoutMS: 30_000,
      },
      startOptions: { envVars, enableInternet: true },
    });
  }

  async onStart(): Promise<void> {
    const slug = await this.ctx.storage.get<string>("slug");
    if (!slug) return;

    try {
      const opId = await this.ctx.storage.get<string>(this.lifecycleOpStorageKey);
      const lifecycle = await getEnvLifecycleStub(this.env, slug).noteInfraReady(opId ?? null);
      if (!lifecycle) {
        return;
      }

      await projectAndPersistEnvSummary(this.env, getHub(this.env), slug);
    } catch (err) {
      console.error(`[sandbox] Failed to mark env infra-ready on start:`, err);
      throw err;
    }
  }

  /** Update the idle timeout at runtime (e.g. when settings change). */
  async setSleepTimeout(minutes: number): Promise<void> {
    if (minutes > 0) {
      this.sleepAfter = `${minutes}m`;
      this.configuredIdleTimeoutMs = minutes * 60_000;
      await this.ctx.storage.put(IDLE_TIMEOUT_STORAGE_KEY, this.configuredIdleTimeoutMs);
    }
    this.renewActivityTimeout();
  }

  /**
   * Called by the Container base class when the sleepAfter timer expires.
   * Treats the Cloudflare timeout as a request to atomically prove provider
   * idleness. Unknown, active, or insufficiently idle runtimes are renewed.
   *
   * Known limitation: WebSocket connections (debug terminal) don't renew
   * the sleepAfter timer after the initial upgrade (cloudflare/containers#147).
   */
  async onActivityExpired(): Promise<void> {
    if (!this.ctx.container?.running) return;

    let storedTimeoutMs: number | undefined;
    try {
      storedTimeoutMs = await this.ctx.storage.get<number>(IDLE_TIMEOUT_STORAGE_KEY);
    } catch (error) {
      console.warn("[sandbox] Idle timeout state is unavailable; leaving container running:", error);
      this.scheduleNextIdleCheck(this.configuredIdleTimeoutMs);
      return;
    }
    const idleTimeoutMs = Number.isFinite(storedTimeoutMs) && storedTimeoutMs! > 0
      ? storedTimeoutMs!
      : this.configuredIdleTimeoutMs || CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES * 60_000;
    const preparation = await this.requestIdleStopPreparation(idleTimeoutMs);
    if (!preparation.eligible || !preparation.claimId) {
      if (preparation.error) {
        console.warn(`[sandbox] Idle stop not eligible (${preparation.reason}): ${preparation.error}`);
      }
      this.scheduleNextIdleCheck(preparation.remainingIdleMs || idleTimeoutMs);
      return;
    }

    let slug: string | undefined;
    try {
      slug = await this.ctx.storage.get<string>("slug");
      if (!slug) {
        await this.releaseIdleStopPreparation(preparation.claimId);
        this.scheduleNextIdleCheck(idleTimeoutMs);
        return;
      }

      const meta = await projectAndPersistEnvSummary(this.env, getHub(this.env), slug, {
        broadcast: false,
      });
      if (!meta || (meta.status !== "running" && meta.status !== "starting")) {
        await this.releaseIdleStopPreparation(preparation.claimId);
        this.scheduleNextIdleCheck(idleTimeoutMs);
        return;
      }

      const lifecycleStub = getEnvLifecycleStub(this.env, slug);
      const lifecycle = await lifecycleStub.requestStop();
      await projectAndPersistEnvSummary(this.env, getHub(this.env), slug).catch((error) => {
        console.warn(`[sandbox] Failed to project saving state for ${slug}; continuing durable stop:`, error);
      });
      try {
        await this.stopSandbox(lifecycle.activeOpId, preparation.claimId);
      } catch (error) {
        await this.releaseIdleStopPreparation(preparation.claimId);
        console.error("[sandbox] Failed to durably stop idle env:", error);
        await lifecycleStub.noteStopDispatchFailed(
          lifecycle.activeOpId,
          error instanceof Error ? error.message : String(error),
        );
        await projectAndPersistEnvSummary(this.env, getHub(this.env), slug);
        this.scheduleNextIdleCheck(idleTimeoutMs);
      }
    } catch (err) {
      await this.releaseIdleStopPreparation(preparation.claimId);
      console.error(`[sandbox] Failed to update status on idle stop for ${slug ?? "unknown env"}:`, err);
      this.scheduleNextIdleCheck(idleTimeoutMs);
    }
  }

  async onStop(params: { exitCode?: number; reason?: string }): Promise<void> {
    const slug = await this.ctx.storage.get<string>("slug");
    if (!slug) return;

    try {
      const stopOpId = await this.ctx.storage.get<string>(this.lifecycleOpStorageKey);
      const lifecycleStub = getEnvLifecycleStub(this.env, slug);
      const lifecycle = await lifecycleStub.noteRunnerStopped(
        stopOpId ?? null,
        params.reason ?? null,
      );
      if (!lifecycle) {
        return;
      }

      await projectAndPersistEnvSummary(this.env, getHub(this.env), slug);
    } catch (err) {
      console.error(`[sandbox] Failed to finalize stopped env ${slug}:`, err);
    } finally {
      await this.ctx.storage.delete(this.lifecycleOpStorageKey);
      const slug2 = await this.ctx.storage.get<string>("slug");
      if (slug2) {
        await getEnvLifecycleStub(this.env, slug2).clearStopWorkspaceSyncedMeta().catch(() => {});
      }
    }
  }

  async stopSandbox(
    stopOpId?: string | null,
    idleClaimId?: string | null,
  ): Promise<void> {
    if (stopOpId?.trim()) {
      await this.ctx.storage.put(this.lifecycleOpStorageKey, stopOpId.trim());
    } else {
      await this.ctx.storage.delete(this.lifecycleOpStorageKey);
    }
    await this.prepareDurableStop(stopOpId, idleClaimId);
    await this.stop();
  }

  async destroySandbox(): Promise<void> {
    await this.ctx.container!.destroy();
  }

  async getStatus(): Promise<string> {
    return this.ctx.container!.running ? "running" : "stopped";
  }
}
