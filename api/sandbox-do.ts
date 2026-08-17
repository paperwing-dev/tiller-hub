import { Container } from "@cloudflare/containers";
import type { Env, EnvLifecycleState } from "./types";
import { getEnvLifecycleStub } from "./helpers";
import { getHub, projectAndPersistEnvSummary } from "./env/service";
import { projectRuntimeFailure } from "./env/runtime-failure";
import type {
  EnvironmentRuntimeScope,
  EnvironmentStopScope,
  PreparedWorkspaceStopReceipt,
} from "./env/runner-backend";
import { CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES } from "../shared/cloudflare-timeout";

const STOP_CONTROL_PORT = 8790;
const STOP_CONTROL_PREPARE_PATH = "/prepare-stop";
const STOP_CONTROL_PREPARE_IDLE_PATH = "/prepare-idle-stop";
const STOP_CONTROL_WORKSPACE_ACK_OWNER_HEADER = "X-Tiller-Workspace-Ack-Owner";
const RUNTIME_SCOPE_STORAGE_KEY = "runtime-scope-v1";
const PREPARED_STOP_RECEIPT_STORAGE_KEY = "prepared-stop-receipt-v1";
const TERMINATION_INTENT_STORAGE_KEY = "termination-intent-v1";
const TERMINATE_PREPARED_STOP_CALLBACK = "terminatePreparedStop";
const IDLE_TIMEOUT_STORAGE_KEY = "idle-timeout-ms";
const CONTAINER_INSTANCE_WAIT_INTERVAL_MS = 300;

// The upstream Container class defaults to eight seconds. Cloudflare's own
// Sandbox SDK uses 30 seconds and recommends increasing it during traffic
// spikes. Keep enough of Workers' 30-second waitUntil grace period for the
// lifecycle binding/projection calls that follow runner dispatch.
export const CONTAINER_INSTANCE_ALLOCATION_TIMEOUT_MS = 25_000;

interface IdleStopPreparation {
  eligible: boolean;
  remainingIdleMs: number;
  reason: IdleStopPreparationReason;
  status?: "working" | "idle";
  idleSince?: number | null;
  claimId?: string;
  error?: true;
}

function isEnvironmentRuntimeScope(
  value: unknown,
): value is EnvironmentRuntimeScope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.envSlug === "string" && Boolean(record.envSlug.trim())
    && typeof record.incarnationId === "string" && Boolean(record.incarnationId.trim())
    && typeof record.startOperationId === "string" && Boolean(record.startOperationId.trim());
}

function isEnvironmentStopScope(value: unknown): value is EnvironmentStopScope {
  if (!isEnvironmentRuntimeScope(value)) return false;
  const stopOperationId = (value as EnvironmentStopScope).stopOperationId;
  return typeof stopOperationId === "string" && Boolean(stopOperationId.trim());
}

function isPreparedWorkspaceStopReceipt(
  value: unknown,
): value is PreparedWorkspaceStopReceipt {
  if (!isEnvironmentStopScope(value)) return false;
  const workspaceLastSyncedAt = (value as PreparedWorkspaceStopReceipt).workspaceLastSyncedAt;
  return typeof workspaceLastSyncedAt === "string"
    && Boolean(workspaceLastSyncedAt.trim())
    && !Number.isNaN(new Date(workspaceLastSyncedAt).getTime());
}

function sameRuntimeScope(
  left: EnvironmentRuntimeScope,
  right: EnvironmentRuntimeScope,
): boolean {
  return left.envSlug === right.envSlug
    && left.incarnationId === right.incarnationId
    && left.startOperationId === right.startOperationId;
}

function sameStopScope(left: EnvironmentStopScope, right: EnvironmentStopScope): boolean {
  return sameRuntimeScope(left, right)
    && left.stopOperationId === right.stopOperationId;
}

type IdleStopPreparationReason =
  | "eligible"
  | "working"
  | "insufficient_idle"
  | "claim_superseded"
  | "released"
  | "not_eligible"
  | "activity_unavailable"
  | "unknown";

type IdleAlarmDecisionDetail = IdleStopPreparationReason
  | "eligible_without_claim"
  | "unknown_claim_reason"
  | "container_not_running"
  | "idle_timeout_state_unavailable"
  | "environment_slug_unavailable"
  | "lifecycle_not_stoppable"
  | "durable_stop_preparation_failed"
  | "lifecycle_preparation_failed";

interface IdleAlarmDecision {
  component: "sandbox_idle_alarm";
  event: "decision";
  decision: "renew" | "stop";
  reason: "working" | "insufficient_idle" | "unavailable" | "failed_preparation" | "eligible";
  detail: IdleAlarmDecisionDetail;
  environmentSlug: string | null;
  timeoutMs: number;
  activityStatus: "working" | "idle" | null;
  idleSince: number | null;
  elapsedIdleMs: number | null;
  remainingIdleMs: number;
  timestamp: string;
}

const IDLE_ALARM_OUTCOME_BY_DETAIL = {
  eligible: { decision: "stop", reason: "eligible" },
  working: { decision: "renew", reason: "working" },
  insufficient_idle: { decision: "renew", reason: "insufficient_idle" },
  claim_superseded: { decision: "renew", reason: "unavailable" },
  released: { decision: "renew", reason: "unavailable" },
  not_eligible: { decision: "renew", reason: "unavailable" },
  activity_unavailable: { decision: "renew", reason: "unavailable" },
  unknown: { decision: "renew", reason: "unavailable" },
  eligible_without_claim: { decision: "renew", reason: "unavailable" },
  unknown_claim_reason: { decision: "renew", reason: "unavailable" },
  container_not_running: { decision: "renew", reason: "unavailable" },
  idle_timeout_state_unavailable: { decision: "renew", reason: "unavailable" },
  environment_slug_unavailable: { decision: "renew", reason: "failed_preparation" },
  lifecycle_not_stoppable: { decision: "renew", reason: "failed_preparation" },
  durable_stop_preparation_failed: { decision: "renew", reason: "failed_preparation" },
  lifecycle_preparation_failed: { decision: "renew", reason: "failed_preparation" },
} as const satisfies Record<
  IdleAlarmDecisionDetail,
  Pick<IdleAlarmDecision, "decision" | "reason">
>;

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

  private async requestWorkspaceStopPreparation(
    scope: EnvironmentStopScope,
    idleClaimId?: string | null,
  ): Promise<{ opId: string; workspaceLastSyncedAt: string }> {
    const controlPort = this.ctx.container!.getTcpPort(this.stopControlPort);
    const headers = new Headers();
    headers.set("X-Tiller-Lifecycle-Op-Id", scope.stopOperationId);
    headers.set(STOP_CONTROL_WORKSPACE_ACK_OWNER_HEADER, "hub");
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
    const body = (await response.text().catch(() => "")).trim();
    let parsed: { error?: unknown; receipt?: unknown } | null = null;
    if (body) {
      try {
        parsed = JSON.parse(body) as { error?: unknown; receipt?: unknown };
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      let message = body;
      if (parsed) {
        try {
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
    const receipt = parsed?.receipt;
    if (!receipt || typeof receipt !== "object") {
      throw new Error("Stop preparation returned no durable workspace receipt.");
    }
    const record = receipt as Record<string, unknown>;
    const opId = typeof record.opId === "string" ? record.opId.trim() : "";
    const rawSyncedAt = typeof record.workspaceLastSyncedAt === "string"
      ? record.workspaceLastSyncedAt.trim()
      : "";
    const syncedAt = new Date(rawSyncedAt);
    if (
      opId !== scope.stopOperationId
      || !rawSyncedAt
      || Number.isNaN(syncedAt.getTime())
    ) {
      throw new Error("Stop preparation returned a malformed or mismatched workspace receipt.");
    }
    return { opId, workspaceLastSyncedAt: syncedAt.toISOString() };
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
        status?: unknown;
        idleSince?: unknown;
        claimId?: unknown;
        error?: unknown;
      } | null;
      if (!body || typeof body.eligible !== "boolean") return fallback;
      return {
        eligible: response.ok && body.eligible,
        remainingIdleMs: typeof body.remainingIdleMs === "number" && Number.isFinite(body.remainingIdleMs)
          ? Math.max(0, body.remainingIdleMs)
          : idleTimeoutMs,
        reason: this.normalizeIdleStopPreparationReason(body.reason, response.ok),
        ...(body.status === "working" || body.status === "idle"
          ? { status: body.status }
          : {}),
        ...(body.idleSince === null
          ? { idleSince: null }
          : typeof body.idleSince === "number" && Number.isFinite(body.idleSince)
            ? { idleSince: body.idleSince }
            : {}),
        ...(typeof body.claimId === "string" ? { claimId: body.claimId } : {}),
        ...(typeof body.error === "string" && body.error.trim() ? { error: true as const } : {}),
      };
    } catch {
      console.warn("[sandbox] Idle activity control is unavailable; leaving container running.");
      return {
        ...fallback,
        error: true,
      };
    }
  }

  private normalizeIdleStopPreparationReason(
    value: unknown,
    responseOk: boolean,
  ): IdleStopPreparationReason {
    switch (value) {
      case "eligible":
      case "working":
      case "insufficient_idle":
      case "claim_superseded":
      case "released":
      case "not_eligible":
      case "activity_unavailable":
        return value;
      default:
        return responseOk ? "unknown" : "activity_unavailable";
    }
  }

  private idleRenewDecisionDetail(preparation: IdleStopPreparation): IdleAlarmDecisionDetail {
    if (preparation.reason === "working") {
      return "working";
    }
    if (preparation.reason === "insufficient_idle") {
      return "insufficient_idle";
    }
    if (preparation.reason === "eligible") {
      return "eligible_without_claim";
    }
    if (preparation.reason === "unknown") {
      return "unknown_claim_reason";
    }
    return preparation.reason;
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

  private emitIdleAlarmDecision(decision: IdleAlarmDecision): void {
    try {
      console.log(JSON.stringify(decision));
    } catch {
      // Diagnostics must never influence lifecycle decisions.
    }
  }

  async startSandbox(
    slug: string,
    envVars: Record<string, string>,
    idleTimeoutMinutes?: number,
    runtimeScope?: EnvironmentRuntimeScope | null,
  ): Promise<void> {
    if (
      !runtimeScope
      || !isEnvironmentRuntimeScope(runtimeScope)
      || runtimeScope.envSlug !== slug
    ) {
      throw new Error("Sandbox start requires an exact environment runtime scope.");
    }
    // Persist slug so onActivityExpired can update KV status
    await Promise.all([
      this.ctx.storage.put("slug", slug),
      this.ctx.storage.put(RUNTIME_SCOPE_STORAGE_KEY, runtimeScope),
      this.ctx.storage.put(this.lifecycleOpStorageKey, runtimeScope.startOperationId),
      this.ctx.storage.delete(PREPARED_STOP_RECEIPT_STORAGE_KEY),
      this.ctx.storage.delete(TERMINATION_INTENT_STORAGE_KEY),
    ]);
    this.deleteSchedules(TERMINATE_PREPARED_STOP_CALLBACK);

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

    await this.start(
      { envVars, enableInternet: true },
      {
        portToCheck: this.stopControlPort,
        retries: Math.ceil(
          CONTAINER_INSTANCE_ALLOCATION_TIMEOUT_MS / CONTAINER_INSTANCE_WAIT_INTERVAL_MS,
        ),
        waitInterval: CONTAINER_INSTANCE_WAIT_INTERVAL_MS,
      },
    );
  }

  async onStart(): Promise<void> {
    const slug = await this.ctx.storage.get<string>("slug");
    if (!slug) return;

    try {
      const opId = await this.ctx.storage.get<string>(this.lifecycleOpStorageKey);
      const lifecycle = await getEnvLifecycleStub(this.env, slug).noteInfraReady(opId ?? null);
      if (!lifecycle) return;
      await projectAndPersistEnvSummary(this.env, getHub(this.env), slug);
    } catch (error) {
      // Allocation succeeded. The harness runner-ready callback remains the
      // authoritative completion signal, so a projection failure here must not
      // turn a live container into a terminal Start failure.
      console.error(`[sandbox] Failed to mark env infra-ready on start:`, error);
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
    let environmentSlug: string | null = null;
    try {
      const diagnosticSlug = await this.ctx.storage.get<unknown>("slug");
      environmentSlug = typeof diagnosticSlug === "string" && diagnosticSlug.trim()
        ? diagnosticSlug
        : null;
    } catch {
      // The slug is diagnostic context only and is never used for authorization.
    }
    let decisionLogged = false;
    const decide = (
      detail: IdleAlarmDecision["detail"],
      timeoutMs: number,
      preparation?: IdleStopPreparation,
    ) => {
      if (decisionLogged) return;
      decisionLogged = true;
      const idleSince = typeof preparation?.idleSince === "number"
        ? preparation.idleSince
        : null;
      const outcome = IDLE_ALARM_OUTCOME_BY_DETAIL[detail];
      this.emitIdleAlarmDecision({
        component: "sandbox_idle_alarm",
        event: "decision",
        ...outcome,
        detail,
        environmentSlug,
        timeoutMs,
        activityStatus: preparation?.status ?? null,
        idleSince,
        elapsedIdleMs: idleSince === null ? null : Math.max(0, Date.now() - idleSince),
        remainingIdleMs: Math.max(0, Math.ceil(preparation?.remainingIdleMs ?? timeoutMs)),
        timestamp: new Date().toISOString(),
      });
    };

    const configuredTimeoutMs = this.configuredIdleTimeoutMs
      || CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES * 60_000;
    if (!this.ctx.container?.running) {
      decide("container_not_running", configuredTimeoutMs);
      return;
    }

    let storedTimeoutMs: number | undefined;
    try {
      storedTimeoutMs = await this.ctx.storage.get<number>(IDLE_TIMEOUT_STORAGE_KEY);
    } catch (error) {
      console.warn("[sandbox] Idle timeout state is unavailable; leaving container running:", error);
      decide("idle_timeout_state_unavailable", configuredTimeoutMs);
      this.scheduleNextIdleCheck(configuredTimeoutMs);
      return;
    }
    const idleTimeoutMs = Number.isFinite(storedTimeoutMs) && storedTimeoutMs! > 0
      ? storedTimeoutMs!
      : configuredTimeoutMs;
    const preparation = await this.requestIdleStopPreparation(idleTimeoutMs);
    if (!preparation.eligible || !preparation.claimId) {
      if (preparation.error) {
        console.warn(`[sandbox] Idle stop not eligible (${preparation.reason}).`);
      }
      decide(
        this.idleRenewDecisionDetail(preparation),
        idleTimeoutMs,
        preparation,
      );
      this.scheduleNextIdleCheck(preparation.remainingIdleMs || idleTimeoutMs);
      return;
    }

    let slug: string | undefined;
    try {
      slug = await this.ctx.storage.get<string>("slug");
      if (!slug) {
        decide("environment_slug_unavailable", idleTimeoutMs, preparation);
        await this.releaseIdleStopPreparation(preparation.claimId);
        this.scheduleNextIdleCheck(idleTimeoutMs);
        return;
      }

      const meta = await projectAndPersistEnvSummary(this.env, getHub(this.env), slug, {
        broadcast: false,
      });
      if (!meta || (meta.status !== "running" && meta.status !== "starting")) {
        decide("lifecycle_not_stoppable", idleTimeoutMs, preparation);
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
        const queued = await lifecycleStub.ensureStopDispatchScheduled(
          lifecycle.activeOpId,
          { idleClaimId: preparation.claimId },
        );
        if (!queued) {
          throw new Error("The idle Stop operation was superseded before dispatch.");
        }
        decide("eligible", idleTimeoutMs, preparation);
      } catch (error) {
        decide("durable_stop_preparation_failed", idleTimeoutMs, preparation);
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
      decide("lifecycle_preparation_failed", idleTimeoutMs, preparation);
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
      let lifecycleBefore: EnvLifecycleState | null = null;
      try {
        lifecycleBefore = await lifecycleStub.getState();
      } catch (error) {
        console.error(`[sandbox] Failed to read lifecycle before stopped callback for ${slug}:`, error);
      }
      const unexpectedFailure = lifecycleBefore?.phase === "starting" || lifecycleBefore?.phase === "running"
        ? projectRuntimeFailure(
            "runtime_stopped_unexpectedly",
            { reason: params.reason ?? null, exitCode: params.exitCode ?? null },
            { slug, opId: stopOpId ?? null, source: "cloudflare-container-on-stop" },
          )
        : null;
      const lifecycle = await lifecycleStub.noteRunnerStopped(
        stopOpId ?? null,
        unexpectedFailure?.message ?? null,
      );
      if (lifecycle) {
        await projectAndPersistEnvSummary(this.env, getHub(this.env), slug).catch((error) => {
          console.error(`[sandbox] Failed to project stopped env ${slug}:`, error);
        });
      }
      const stopConverged = lifecycle?.phase === "stopped"
        && lifecycle.activeOpId === stopOpId;
      const unexpectedExitRecorded = lifecycleBefore?.phase === "starting"
        || lifecycleBefore?.phase === "running";
      if (stopConverged || unexpectedExitRecorded || !lifecycle) {
        await this.ctx.storage.delete(this.lifecycleOpStorageKey);
      }
      if (stopConverged) {
        await Promise.all([
          this.ctx.storage.delete(PREPARED_STOP_RECEIPT_STORAGE_KEY),
          this.ctx.storage.delete(TERMINATION_INTENT_STORAGE_KEY),
        ]);
      }
    } catch (err) {
      console.error(`[sandbox] Failed to finalize stopped env ${slug}:`, err);
      // Container.stop() retries onStop while its persisted state still says
      // the process was running. Keep the exact operation and receipt until
      // LifecycleDO confirms convergence.
      throw err;
    }
  }

  async prepareWorkspaceStop(
    scope: EnvironmentStopScope,
    idleClaimId?: string | null,
  ): Promise<
    | { status: "prepared"; receipt: PreparedWorkspaceStopReceipt }
    | { status: "absent-unprepared" }
  > {
    if (!isEnvironmentStopScope(scope)) {
      throw new Error("Workspace stop preparation requires an exact Stop scope.");
    }
    const storedRuntimeScope = await this.ctx.storage.get<unknown>(RUNTIME_SCOPE_STORAGE_KEY);
    if (
      !isEnvironmentRuntimeScope(storedRuntimeScope)
      || !sameRuntimeScope(storedRuntimeScope, scope)
    ) {
      throw new Error("Workspace stop scope does not match the active sandbox runtime.");
    }
    const storedReceipt = await this.ctx.storage.get<unknown>(
      PREPARED_STOP_RECEIPT_STORAGE_KEY,
    );
    if (storedReceipt) {
      if (
        !isPreparedWorkspaceStopReceipt(storedReceipt)
        || !sameStopScope(storedReceipt, scope)
      ) {
        throw new Error("A different Stop operation already owns the prepared workspace receipt.");
      }
      return { status: "prepared", receipt: storedReceipt };
    }
    if (!this.ctx.container?.running) {
      return { status: "absent-unprepared" };
    }

    await this.ctx.storage.put(this.lifecycleOpStorageKey, scope.stopOperationId);
    const prepared = await this.requestWorkspaceStopPreparation(scope, idleClaimId);
    const receipt: PreparedWorkspaceStopReceipt = {
      ...scope,
      workspaceLastSyncedAt: prepared.workspaceLastSyncedAt,
    };
    await this.ctx.storage.put(PREPARED_STOP_RECEIPT_STORAGE_KEY, receipt);
    return { status: "prepared", receipt };
  }

  async schedulePreparedTermination(
    scope: EnvironmentStopScope,
  ): Promise<{ status: "scheduled" | "already-scheduled" | "already-stopped" }> {
    if (!isEnvironmentStopScope(scope)) {
      throw new Error("Sandbox termination requires an exact Stop scope.");
    }
    const [storedRuntimeScope, storedReceipt] = await Promise.all([
      this.ctx.storage.get<unknown>(RUNTIME_SCOPE_STORAGE_KEY),
      this.ctx.storage.get<unknown>(PREPARED_STOP_RECEIPT_STORAGE_KEY),
    ]);
    if (
      !isEnvironmentRuntimeScope(storedRuntimeScope)
      || !sameRuntimeScope(storedRuntimeScope, scope)
      || !isPreparedWorkspaceStopReceipt(storedReceipt)
      || !sameStopScope(storedReceipt, scope)
    ) {
      throw new Error("Sandbox termination does not match the prepared workspace receipt.");
    }
    if (!this.ctx.container?.running) {
      return { status: "already-stopped" };
    }

    const existing = await this.listSchedules<EnvironmentStopScope>(
      TERMINATE_PREPARED_STOP_CALLBACK,
    );
    if (existing.length > 0) {
      const scheduledScope = existing[0]?.payload;
      if (!isEnvironmentStopScope(scheduledScope) || !sameStopScope(scheduledScope, scope)) {
        throw new Error("A different Stop operation already owns sandbox termination.");
      }
      return { status: "already-scheduled" };
    }

    await this.ctx.storage.put(TERMINATION_INTENT_STORAGE_KEY, scope);
    await this.schedule(1, TERMINATE_PREPARED_STOP_CALLBACK, scope);
    return { status: "scheduled" };
  }

  async terminatePreparedStop(scope: EnvironmentStopScope): Promise<void> {
    const [storedRuntimeScope, storedReceipt, storedIntent] = await Promise.all([
      this.ctx.storage.get<unknown>(RUNTIME_SCOPE_STORAGE_KEY),
      this.ctx.storage.get<unknown>(PREPARED_STOP_RECEIPT_STORAGE_KEY),
      this.ctx.storage.get<unknown>(TERMINATION_INTENT_STORAGE_KEY),
    ]);
    if (
      !isEnvironmentStopScope(scope)
      || !isEnvironmentRuntimeScope(storedRuntimeScope)
      || !sameRuntimeScope(storedRuntimeScope, scope)
      || !isPreparedWorkspaceStopReceipt(storedReceipt)
      || !sameStopScope(storedReceipt, scope)
      || !isEnvironmentStopScope(storedIntent)
      || !sameStopScope(storedIntent, scope)
    ) {
      throw new Error("Scheduled sandbox termination is stale or unprepared.");
    }
    if (this.ctx.container?.running) {
      await this.stop("SIGTERM");
    }
  }

  async destroySandbox(): Promise<void> {
    await this.ctx.container!.destroy();
  }

  async getStatus(): Promise<string> {
    return this.ctx.container!.running ? "running" : "stopped";
  }
}
