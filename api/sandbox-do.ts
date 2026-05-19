import { Container } from "@cloudflare/containers";
import type { Env } from "./types";
import { getEnvLifecycleStub } from "./helpers";
import { getHub, projectAndPersistEnvSummary } from "./env/service";

const STOP_CONTROL_PORT = 8790;
const STOP_CONTROL_PREPARE_PATH = "/prepare-stop";

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
  stopControlPort = STOP_CONTROL_PORT;
  lifecycleOpStorageKey = "lifecycle-op-id";

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

  private async prepareDurableStop(stopOpId?: string | null): Promise<void> {
    if (!this.ctx.container?.running) {
      return;
    }

    const controlPort = this.ctx.container.getTcpPort(this.stopControlPort);
    const headers = new Headers();
    if (stopOpId?.trim()) {
      headers.set("X-Tiller-Lifecycle-Op-Id", stopOpId.trim());
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
    }
    // When idleTimeoutMinutes is 0 or undefined, keep Container base default ("10m").
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
    }
    this.renewActivityTimeout();
  }

  /**
   * Called by the Container base class when the sleepAfter timer expires.
   * Requests a controller-owned stop, projects the saving state, then
   * durably stops the runner.
   *
   * Known limitation: WebSocket connections (debug terminal) don't renew
   * the sleepAfter timer after the initial upgrade (cloudflare/containers#147).
   */
  async onActivityExpired(): Promise<void> {
    if (!this.ctx.container?.running) return;

    const slug = await this.ctx.storage.get<string>("slug");
    if (slug) {
      try {
        const meta = await projectAndPersistEnvSummary(this.env, getHub(this.env), slug, {
          broadcast: false,
        });
        if (meta && (meta.status === "running" || meta.status === "starting")) {
          const lifecycleStub = getEnvLifecycleStub(this.env, slug);
          const lifecycle = await lifecycleStub.requestStop();
          await projectAndPersistEnvSummary(this.env, getHub(this.env), slug);

          try {
            await this.stopSandbox(lifecycle.activeOpId);
            return;
          } catch (err) {
            console.error("[sandbox] Failed to durably stop idle env:", err);
            await lifecycleStub.noteStopDispatchFailed(
              lifecycle.activeOpId,
              err instanceof Error ? err.message : String(err),
            );
            await projectAndPersistEnvSummary(this.env, getHub(this.env), slug);
            return;
          }
        }
      } catch (err) {
        console.error(`[sandbox] Failed to update status on idle stop for ${slug}:`, err);
      }
    }

    // Fallback: if the env row is gone or unreadable, still stop the container.
    try {
      await this.stopSandbox();
    } catch (err) {
      console.error("[sandbox] Failed to durably stop idle env:", err);
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

  async stopSandbox(stopOpId?: string | null): Promise<void> {
    if (stopOpId?.trim()) {
      await this.ctx.storage.put(this.lifecycleOpStorageKey, stopOpId.trim());
    } else {
      await this.ctx.storage.delete(this.lifecycleOpStorageKey);
    }
    await this.prepareDurableStop(stopOpId);
    await this.stop();
  }

  async destroySandbox(): Promise<void> {
    await this.ctx.container!.destroy();
  }

  async getStatus(): Promise<string> {
    return this.ctx.container!.running ? "running" : "stopped";
  }
}
