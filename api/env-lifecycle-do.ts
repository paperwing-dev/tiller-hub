import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  EnvInfraState,
  EnvDefinition,
  EnvLifecycleDesiredState,
  EnvLifecycleOperation,
  EnvLifecyclePhase,
  EnvLifecycleState,
  EnvMeta,
  EnvMutableState,
  EnvStatus,
  ScmOperationType,
  StartupDiagnosticEvent,
  StartupDiagnosticFailure,
  StartupDiagnosticLogTails,
  StartupDiagnosticSeverity,
  StartupDiagnosticStepId,
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
} from "./types";
import { assertExplicitEnvScmFields, assertExplicitEnvSummaryFields, projectEnvSummary } from "./sync/projectors";
import {
  ENV_LIFECYCLE_RUNNER_EXIT_WHILE_RUNNING_ERROR,
  ENV_LIFECYCLE_RUNNER_EXIT_BEFORE_PERSIST_ERROR,
  ENV_LIFECYCLE_SAVE_TIMEOUT_ERROR,
  ENV_LIFECYCLE_SAVE_TIMEOUT_MS,
  ENV_LIFECYCLE_START_TIMEOUT_ERROR,
  ENV_LIFECYCLE_START_TIMEOUT_MS,
  ENV_LIFECYCLE_STOP_TIMEOUT_ERROR,
  ENV_LIFECYCLE_STOP_TIMEOUT_MS,
} from "./env-lifecycle";
import type { PendingStopWorkspaceSyncedMeta, StopWorkspaceSyncedMetaPatch } from "./env-lifecycle";
import { readEnvDefinition } from "./plan/store";

const MUTABLE_STATE_KEY = "env-mutable-state";
const ENV_SLUG_KEY = "env-slug";
const STOP_WORKSPACE_SYNCED_META_KEY = "stop-workspace-synced-meta";
const STARTUP_DIAGNOSTICS_ACTIVE_KEY = "startup-diagnostics-active";
const STARTUP_DIAGNOSTICS_LAST_FAILED_KEY = "startup-diagnostics-last-failed";
const STARTUP_DIAGNOSTICS_MAX_EVENTS = 50;
const STARTUP_DIAGNOSTICS_MAX_LOG_TAIL_CHARS = 4000;

function nowIso(): string {
  return new Date().toISOString();
}

function parseTimestamp(value?: string | null): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildStopOpId(): string {
  return `stop-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function buildStartOpId(): string {
  return `start-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function normalizeDiagnosticMessage(message?: string | null): string | null {
  const trimmed = message?.trim() ?? "";
  return trimmed || null;
}

function normalizeDiagnosticDetail(detail?: string | null): string | null {
  const trimmed = detail?.trim() ?? "";
  return trimmed || null;
}

function normalizeDiagnosticSeverity(
  severity?: StartupDiagnosticSeverity | null,
): StartupDiagnosticSeverity {
  return severity === "warn" || severity === "error" ? severity : "info";
}

function capDiagnosticLogTail(value?: string | null): string | null {
  const normalized = normalizeDiagnosticMessage(value);
  if (!normalized) {
    return null;
  }
  return normalized.length > STARTUP_DIAGNOSTICS_MAX_LOG_TAIL_CHARS
    ? normalized.slice(-STARTUP_DIAGNOSTICS_MAX_LOG_TAIL_CHARS)
    : normalized;
}

function normalizeDiagnosticLogTails(
  value?: Partial<StartupDiagnosticLogTails> | null,
): StartupDiagnosticLogTails {
  return {
    harness: capDiagnosticLogTail(value?.harness),
    stopControl: capDiagnosticLogTail(value?.stopControl),
    bootstrap: capDiagnosticLogTail(value?.bootstrap),
  };
}

function mergeDiagnosticLogTails(
  current: StartupDiagnosticLogTails,
  next?: Partial<StartupDiagnosticLogTails> | null,
): StartupDiagnosticLogTails {
  return {
    harness:
      next?.harness !== undefined
        ? capDiagnosticLogTail(next.harness)
        : current.harness,
    stopControl:
      next?.stopControl !== undefined
        ? capDiagnosticLogTail(next.stopControl)
        : current.stopControl,
    bootstrap:
      next?.bootstrap !== undefined
        ? capDiagnosticLogTail(next.bootstrap)
        : current.bootstrap,
  };
}

function createEmptyStartupDiagnostics(
  opId: string,
  backend: "cf" | "host",
  startedAt = nowIso(),
): StartupDiagnosticsSnapshot {
  return {
    opId,
    backend,
    startedAt,
    updatedAt: startedAt,
    currentStepId: null,
    currentStepMessage: null,
    events: [],
    failure: null,
    logTails: normalizeDiagnosticLogTails(),
  };
}

function normalizeStartupDiagnosticEvent(
  value: StartupDiagnosticEvent,
): StartupDiagnosticEvent {
  return {
    at: normalizeDiagnosticMessage(value.at) ?? nowIso(),
    opId: normalizeDiagnosticMessage(value.opId) ?? "",
    stepId: value.stepId,
    severity: normalizeDiagnosticSeverity(value.severity),
    message: normalizeDiagnosticMessage(value.message) ?? "",
    detail: normalizeDiagnosticDetail(value.detail),
  };
}

function normalizeStartupDiagnosticFailure(
  value?: StartupDiagnosticFailure | null,
): StartupDiagnosticFailure | null {
  if (!value) {
    return null;
  }
  const message = normalizeDiagnosticMessage(value.message);
  if (!message) {
    return null;
  }
  return {
    message,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
    signal: normalizeDiagnosticMessage(value.signal),
    lastStepId: value.lastStepId ?? null,
  };
}

function normalizeStartupDiagnosticsSnapshot(
  value: StartupDiagnosticsSnapshot,
): StartupDiagnosticsSnapshot {
  const startedAt = normalizeDiagnosticMessage(value.startedAt) ?? nowIso();
  const updatedAt = normalizeDiagnosticMessage(value.updatedAt) ?? startedAt;
  return {
    opId: normalizeDiagnosticMessage(value.opId) ?? "",
    backend: value.backend === "host" ? "host" : "cf",
    startedAt,
    updatedAt,
    currentStepId: value.currentStepId ?? null,
    currentStepMessage: normalizeDiagnosticMessage(value.currentStepMessage),
    events: Array.isArray(value.events)
      ? value.events
          .map((event) => normalizeStartupDiagnosticEvent(event))
          .filter((event) => event.opId && event.message)
          .slice(-STARTUP_DIAGNOSTICS_MAX_EVENTS)
      : [],
    failure: normalizeStartupDiagnosticFailure(value.failure),
    logTails: normalizeDiagnosticLogTails(value.logTails),
  };
}

function buildStartupDiagnosticEvent(input: {
  at?: string | null;
  opId: string;
  stepId: StartupDiagnosticStepId;
  severity?: StartupDiagnosticSeverity | null;
  message: string;
  detail?: string | null;
}): StartupDiagnosticEvent | null {
  const message = normalizeDiagnosticMessage(input.message);
  const opId = normalizeDiagnosticMessage(input.opId);
  if (!message || !opId) {
    return null;
  }
  return {
    at: normalizeDiagnosticMessage(input.at) ?? nowIso(),
    opId,
    stepId: input.stepId,
    severity: normalizeDiagnosticSeverity(input.severity),
    message,
    detail: normalizeDiagnosticDetail(input.detail),
  };
}

function inferLifecyclePhaseFromStatus(status?: EnvStatus | null): EnvLifecyclePhase | null {
  switch (status ?? null) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "saving":
      return "saving";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

function inferDesiredState(phase: EnvLifecyclePhase | null): EnvLifecycleDesiredState | null {
  if (!phase) {
    return null;
  }
  return phase === "starting" || phase === "running" ? "running" : "stopped";
}

function inferLastRunnerState(
  phase: EnvLifecyclePhase | null,
  status: EnvStatus,
): string | null {
  switch (phase ?? status) {
    case "running":
    case "saving":
    case "stopping":
      return "running";
    case "starting":
      return null;
    case "stopped":
    case "failed":
      return "stopped";
    default:
      return null;
  }
}

function inferInfraState(
  phase: EnvLifecyclePhase | null,
  status: EnvStatus,
): EnvInfraState {
  switch (phase ?? status) {
    case "running":
    case "saving":
    case "stopping":
      return "ready";
    case "stopped":
    case "failed":
      return "stopped";
    default:
      return "unknown";
  }
}

function inferRuntimeReady(
  phase: EnvLifecyclePhase | null,
  status: EnvStatus,
): boolean {
  return (phase ?? status) === "running";
}

function createEmptyMutableState(overrides: Partial<EnvMutableState> = {}): EnvMutableState {
  const updatedAt = overrides.updatedAt ?? nowIso();
  return {
    status: overrides.status ?? "unknown",
    lifecyclePhase: overrides.lifecyclePhase ?? null,
    lifecycleOpId: overrides.lifecycleOpId ?? null,
    lifecycleOperation: overrides.lifecycleOperation ?? null,
    lifecycleDesiredState: overrides.lifecycleDesiredState ?? null,
    lifecycleLastRunnerState: overrides.lifecycleLastRunnerState ?? null,
    lifecycleLastWorkspaceSyncedAckOpId: overrides.lifecycleLastWorkspaceSyncedAckOpId ?? null,
    lifecycleInfraState: overrides.lifecycleInfraState ?? "unknown",
    lifecycleRuntimeReady: overrides.lifecycleRuntimeReady ?? false,
    lifecycleUpdatedAt: overrides.lifecycleUpdatedAt ?? null,
    runnerId: overrides.runnerId ?? null,
    runnerMachineId: overrides.runnerMachineId ?? null,
    bootMessage: overrides.bootMessage ?? null,
    bootStepId: overrides.bootStepId ?? null,
    authWarning: overrides.authWarning ?? null,
    branchStatus: overrides.branchStatus ?? null,
    workspaceDirty: overrides.workspaceDirty ?? null,
    workspaceNeedsAttention: overrides.workspaceNeedsAttention ?? null,
    workspaceLastSyncedAt: overrides.workspaceLastSyncedAt ?? null,
    baseMainCommit: overrides.baseMainCommit ?? null,
    lastKnownMainCommit: overrides.lastKnownMainCommit ?? null,
    scmOperationType: overrides.scmOperationType ?? null,
    scmOperationId: overrides.scmOperationId ?? null,
    scmOperationPhase: overrides.scmOperationPhase ?? null,
    scmOperationStartedAt: overrides.scmOperationStartedAt ?? null,
    scmOperationUpdatedAt: overrides.scmOperationUpdatedAt ?? null,
    scmLastCompletedAt: overrides.scmLastCompletedAt ?? null,
    scmLastDurationMs: overrides.scmLastDurationMs ?? null,
    scmLastTimings: overrides.scmLastTimings ?? null,
    leadHarnessStatus: overrides.leadHarnessStatus ?? null,
    leadHarnessError: overrides.leadHarnessError ?? null,
    leadHarnessUpdatedAt: overrides.leadHarnessUpdatedAt ?? null,
    error: overrides.error ?? null,
    errorAt: overrides.errorAt ?? null,
    updatedAt,
  };
}

function normalizeMutableState(state: EnvMutableState): EnvMutableState {
  return createEmptyMutableState(state);
}

function buildMutableStateFromMeta(meta: EnvMeta): EnvMutableState {
  assertExplicitEnvSummaryFields(meta);
  assertExplicitEnvScmFields(meta);
  const lifecyclePhase = meta.lifecyclePhase ?? inferLifecyclePhaseFromStatus(meta.status);
  const lifecycleUpdatedAt = meta.lifecycleUpdatedAt ?? meta.updatedAt;

  return normalizeMutableState({
    status: meta.status,
    lifecyclePhase,
    lifecycleOpId: meta.lifecycleOpId ?? null,
    lifecycleOperation: meta.lifecycleOperation ?? null,
    lifecycleDesiredState: meta.lifecycleDesiredState ?? inferDesiredState(lifecyclePhase),
    lifecycleLastRunnerState: inferLastRunnerState(lifecyclePhase, meta.status),
    lifecycleLastWorkspaceSyncedAckOpId:
      lifecyclePhase === "stopping" ? meta.lifecycleOpId ?? null : null,
    lifecycleInfraState: meta.lifecycleInfraState ?? inferInfraState(lifecyclePhase, meta.status),
    lifecycleRuntimeReady:
      typeof meta.lifecycleRuntimeReady === "boolean"
        ? meta.lifecycleRuntimeReady
        : inferRuntimeReady(lifecyclePhase, meta.status),
    lifecycleUpdatedAt,
    runnerId: meta.runnerId ?? null,
    runnerMachineId: meta.runnerMachineId ?? null,
    bootMessage: meta.bootMessage ?? null,
    bootStepId: meta.bootStepId ?? null,
    authWarning: meta.authWarning ?? null,
    branchStatus: meta.branchStatus,
    workspaceDirty: meta.workspaceDirty,
    workspaceNeedsAttention: meta.workspaceNeedsAttention,
    workspaceLastSyncedAt: meta.workspaceLastSyncedAt,
    baseMainCommit: meta.baseMainCommit,
    lastKnownMainCommit: meta.lastKnownMainCommit,
    scmOperationType: meta.scmOperationType,
    scmOperationId: meta.scmOperationId,
    scmOperationPhase: meta.scmOperationPhase,
    scmOperationStartedAt: meta.scmOperationStartedAt,
    scmOperationUpdatedAt: meta.scmOperationUpdatedAt,
    scmLastCompletedAt: meta.scmLastCompletedAt,
    scmLastDurationMs: meta.scmLastDurationMs,
    scmLastTimings: meta.scmLastTimings,
    leadHarnessStatus: meta.leadHarnessStatus ?? null,
    leadHarnessError: meta.leadHarnessError ?? null,
    leadHarnessUpdatedAt: meta.leadHarnessUpdatedAt ?? null,
    error: meta.error ?? null,
    errorAt: meta.errorAt ?? null,
    updatedAt: meta.updatedAt,
  });
}

function buildEnvMetaFromLayers(
  definition: EnvDefinition,
  mutableState: EnvMutableState,
): EnvMeta {
  const next: EnvMeta = {
    slug: definition.slug,
    repoUrl: definition.repoUrl,
    ...(definition.repoId ? { repoId: definition.repoId } : {}),
    backend: definition.backend,
    ...(mutableState.runnerId ? { runnerId: mutableState.runnerId } : {}),
    ...(mutableState.runnerMachineId ? { runnerMachineId: mutableState.runnerMachineId } : {}),
    harness: definition.harness,
    ...(definition.authMode ? { authMode: definition.authMode } : {}),
    ...(definition.resolvedAuthMode ? { resolvedAuthMode: definition.resolvedAuthMode } : {}),
    ...(definition.codexAuthMode ? { codexAuthMode: definition.codexAuthMode } : {}),
    ...(definition.opencodeProvider ? { opencodeProvider: definition.opencodeProvider } : {}),
    ...(definition.opencodeModel ? { opencodeModel: definition.opencodeModel } : {}),
    ...(definition.modelRoute ? { modelRoute: definition.modelRoute } : {}),
    ...(mutableState.authWarning ? { authWarning: mutableState.authWarning } : {}),
    createdAt: definition.createdAt,
    updatedAt: mutableState.updatedAt,
    status: mutableState.status,
    ...(mutableState.bootMessage ? { bootMessage: mutableState.bootMessage } : {}),
    bootStepId: mutableState.bootStepId,
    startupPlanId: definition.startupPlanId,
    branchName: definition.branchName,
    branchStatus: mutableState.branchStatus,
    workspaceDirty: mutableState.workspaceDirty,
    workspaceNeedsAttention: mutableState.workspaceNeedsAttention,
    workspaceLastSyncedAt: mutableState.workspaceLastSyncedAt,
    baseMainCommit: mutableState.baseMainCommit,
    lastKnownMainCommit: mutableState.lastKnownMainCommit,
    scmOperationType: mutableState.scmOperationType,
    scmOperationId: mutableState.scmOperationId,
    scmOperationPhase: mutableState.scmOperationPhase,
    scmOperationStartedAt: mutableState.scmOperationStartedAt,
    scmOperationUpdatedAt: mutableState.scmOperationUpdatedAt,
    scmLastCompletedAt: mutableState.scmLastCompletedAt,
    scmLastDurationMs: mutableState.scmLastDurationMs,
    scmLastTimings: mutableState.scmLastTimings,
    lifecyclePhase: mutableState.lifecyclePhase,
    lifecycleOpId: mutableState.lifecycleOpId,
    lifecycleOperation: mutableState.lifecycleOperation,
    lifecycleDesiredState: mutableState.lifecycleDesiredState,
    lifecycleInfraState: mutableState.lifecycleInfraState,
    lifecycleRuntimeReady: mutableState.lifecycleRuntimeReady,
    lifecycleUpdatedAt: mutableState.lifecycleUpdatedAt,
    leadHarnessStatus: mutableState.leadHarnessStatus,
    leadHarnessError: mutableState.leadHarnessError,
    leadHarnessUpdatedAt: mutableState.leadHarnessUpdatedAt,
    ...(mutableState.error ? { error: mutableState.error } : {}),
    ...(mutableState.errorAt ? { errorAt: mutableState.errorAt } : {}),
  };

  return projectEnvSummary(next);
}

function buildLifecycleState(state: EnvMutableState | null): EnvLifecycleState | null {
  if (!state?.lifecyclePhase) {
    return null;
  }

  return {
    phase: state.lifecyclePhase,
    activeOpId: state.lifecycleOpId,
    activeOperation: state.lifecycleOperation,
    desiredState: state.lifecycleDesiredState ?? inferDesiredState(state.lifecyclePhase) ?? "stopped",
    lastRunnerState: state.lifecycleLastRunnerState,
    lastWorkspaceSyncedAckOpId: state.lifecycleLastWorkspaceSyncedAckOpId,
    infraState: state.lifecycleInfraState,
    runtimeReady: state.lifecycleRuntimeReady,
    lastError: state.error,
    lastErrorAt: state.errorAt,
    updatedAt: state.lifecycleUpdatedAt ?? state.updatedAt,
  };
}

function applyLifecycleState(
  current: EnvMutableState,
  lifecycle: EnvLifecycleState | null,
  options?: { status?: EnvStatus },
): EnvMutableState {
  if (!lifecycle) {
    return normalizeMutableState({
      ...current,
      lifecyclePhase: null,
      lifecycleOpId: null,
      lifecycleOperation: null,
      lifecycleDesiredState: null,
      lifecycleLastRunnerState: null,
      lifecycleLastWorkspaceSyncedAckOpId: null,
      lifecycleInfraState: "unknown",
      lifecycleRuntimeReady: false,
      lifecycleUpdatedAt: null,
      updatedAt: nowIso(),
    });
  }

  return normalizeMutableState({
    ...current,
    status: options?.status ?? lifecycle.phase,
    lifecyclePhase: lifecycle.phase,
    lifecycleOpId: lifecycle.activeOpId,
    lifecycleOperation: lifecycle.activeOperation,
    lifecycleDesiredState: lifecycle.desiredState,
    lifecycleLastRunnerState: lifecycle.lastRunnerState,
    lifecycleLastWorkspaceSyncedAckOpId: lifecycle.lastWorkspaceSyncedAckOpId,
    lifecycleInfraState: lifecycle.infraState,
    lifecycleRuntimeReady: lifecycle.runtimeReady,
    lifecycleUpdatedAt: lifecycle.updatedAt,
    error: lifecycle.lastError,
    errorAt: lifecycle.lastErrorAt,
    updatedAt: lifecycle.updatedAt,
  });
}

function buildFailureState(current: EnvMutableState, error: string): EnvLifecycleState {
  const existing = buildLifecycleState(current);
  const updatedAt = nowIso();

  return {
    phase: "failed",
    activeOpId: existing?.activeOpId ?? null,
    activeOperation: existing?.activeOperation ?? null,
    desiredState: existing?.desiredState ?? "stopped",
    lastRunnerState: existing?.lastRunnerState ?? current.lifecycleLastRunnerState,
    lastWorkspaceSyncedAckOpId: existing?.lastWorkspaceSyncedAckOpId ?? current.lifecycleLastWorkspaceSyncedAckOpId,
    infraState: current.lifecycleInfraState,
    runtimeReady: false,
    lastError: error,
    lastErrorAt: updatedAt,
    updatedAt,
  };
}

type ScmProjectionInput = {
  type: ScmOperationType;
  operationId: string;
  phase: string;
  startedAt?: string | null;
};

type ClearedScmProjectionResult = {
  completedAt?: string | null;
  durationMs?: number | null;
  timings?: string | null;
};

export class EnvLifecycleDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async readStoredMutableState(): Promise<EnvMutableState | null> {
    const stored = await this.ctx.storage.get<EnvMutableState>(MUTABLE_STATE_KEY);
    return stored ? normalizeMutableState(stored) : null;
  }

  private async rememberSlug(slug: string): Promise<void> {
    const normalized = slug.trim();
    if (!normalized) {
      return;
    }
    await this.ctx.storage.put(ENV_SLUG_KEY, normalized);
  }

  private async readStoredSlug(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(ENV_SLUG_KEY)) ?? null;
  }

  private async persistProjectedSummary(mutableState: EnvMutableState | null): Promise<void> {
    if (!mutableState) {
      return;
    }

    const slug = await this.readStoredSlug();
    if (!slug) {
      return;
    }

    const definition = await readEnvDefinition(this.env, slug);
    if (!definition) {
      return;
    }

    const meta = buildEnvMetaFromLayers(definition, mutableState);
    await this.env.ENVS_KV.put(meta.slug, JSON.stringify(meta));
    const hubId = this.env.HUB.idFromName("hub");
    const hub = this.env.HUB.get(hubId) as unknown as {
      broadcastEnvUpsert: (env: EnvMeta) => Promise<void> | void;
    };
    await hub.broadcastEnvUpsert(projectEnvSummary(meta));
  }

  private async writeMutableState(state: EnvMutableState | null): Promise<EnvMutableState | null> {
    if (!state) {
      await this.ctx.storage.delete(MUTABLE_STATE_KEY);
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (existingAlarm !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return null;
    }

    const next = normalizeMutableState(state);
    await this.ctx.storage.put(MUTABLE_STATE_KEY, next);

    const alarmAt = this.getAlarmAt(next);
    if (alarmAt === null) {
      const existingAlarm = await this.ctx.storage.getAlarm();
      if (existingAlarm !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return next;
    }

    const existingAlarm = await this.ctx.storage.getAlarm();
    if (existingAlarm === null || existingAlarm !== alarmAt) {
      await this.ctx.storage.setAlarm(alarmAt);
    }
    return next;
  }

  private getAlarmAt(state: EnvMutableState | EnvLifecycleState): number | null {
    const phase = "lifecyclePhase" in state ? state.lifecyclePhase : state.phase;
    const updatedAt = "lifecycleUpdatedAt" in state
      ? state.lifecycleUpdatedAt ?? state.updatedAt
      : state.updatedAt;
    const updatedAtMs = parseTimestamp(updatedAt);

    if (phase === "starting") {
      return updatedAtMs + ENV_LIFECYCLE_START_TIMEOUT_MS;
    }
    if (phase === "saving") {
      return updatedAtMs + ENV_LIFECYCLE_SAVE_TIMEOUT_MS;
    }
    if (phase === "stopping") {
      return updatedAtMs + ENV_LIFECYCLE_STOP_TIMEOUT_MS;
    }
    return null;
  }

  private async resolveTimeoutState(
    state: EnvMutableState | null,
    now = Date.now(),
  ): Promise<EnvMutableState | null> {
    if (!state) {
      return null;
    }

    const alarmAt = this.getAlarmAt(state);
    if (alarmAt === null || now < alarmAt) {
      return state;
    }

    if (state.lifecyclePhase === "starting") {
      await this.recordStartupDiagnosticsFailure(state.lifecycleOpId, {
        stepId: state.bootStepId ?? undefined,
        message: ENV_LIFECYCLE_START_TIMEOUT_ERROR,
      });
    }

    const diagnostics =
      state.lifecyclePhase === "starting"
        ? await this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY)
        : null;
    const timedOut = applyLifecycleState(
      diagnostics
        ? {
            ...state,
            bootMessage: diagnostics.currentStepMessage,
            bootStepId: diagnostics.currentStepId,
          }
        : state,
      buildFailureState(
        state,
        state.lifecyclePhase === "starting"
          ? ENV_LIFECYCLE_START_TIMEOUT_ERROR
          : state.lifecyclePhase === "saving"
            ? ENV_LIFECYCLE_SAVE_TIMEOUT_ERROR
            : ENV_LIFECYCLE_STOP_TIMEOUT_ERROR,
      ),
    );
    await this.writeMutableState(timedOut);
    return timedOut;
  }

  private resolveLifecycleOpId(
    opId: string | null | undefined,
  ): string | null {
    const trimmed = opId?.trim() ?? "";
    return trimmed || null;
  }

  private async readStartupDiagnosticsSnapshot(
    key: typeof STARTUP_DIAGNOSTICS_ACTIVE_KEY | typeof STARTUP_DIAGNOSTICS_LAST_FAILED_KEY,
  ): Promise<StartupDiagnosticsSnapshot | null> {
    const stored = await this.ctx.storage.get<StartupDiagnosticsSnapshot>(key);
    return stored ? normalizeStartupDiagnosticsSnapshot(stored) : null;
  }

  private async writeStartupDiagnosticsSnapshot(
    key: typeof STARTUP_DIAGNOSTICS_ACTIVE_KEY | typeof STARTUP_DIAGNOSTICS_LAST_FAILED_KEY,
    snapshot: StartupDiagnosticsSnapshot | null,
  ): Promise<StartupDiagnosticsSnapshot | null> {
    if (!snapshot) {
      await this.ctx.storage.delete(key);
      return null;
    }

    const normalized = normalizeStartupDiagnosticsSnapshot(snapshot);
    await this.ctx.storage.put(key, normalized);
    return normalized;
  }

  private async setStartupDiagnosticsState(
    state: StartupDiagnosticsState,
  ): Promise<StartupDiagnosticsState> {
    const active = await this.writeStartupDiagnosticsSnapshot(
      STARTUP_DIAGNOSTICS_ACTIVE_KEY,
      state.active,
    );
    const lastFailed = await this.writeStartupDiagnosticsSnapshot(
      STARTUP_DIAGNOSTICS_LAST_FAILED_KEY,
      state.lastFailed,
    );
    return { active, lastFailed };
  }

  private async readStartupDiagnosticsState(): Promise<StartupDiagnosticsState> {
    const [active, lastFailed] = await Promise.all([
      this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
      this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_LAST_FAILED_KEY),
    ]);
    return { active, lastFailed };
  }

  private async clearStartupDiagnosticsState(): Promise<void> {
    await this.setStartupDiagnosticsState({
      active: null,
      lastFailed: null,
    });
  }

  private async updateBootSummary(
    current: EnvMutableState | null,
    summary: { message?: string | null; stepId?: StartupDiagnosticStepId | null },
    updatedAt?: string,
  ): Promise<EnvMutableState | null> {
    if (!current) {
      return null;
    }

    const next = normalizeMutableState({
      ...current,
      bootMessage: normalizeDiagnosticMessage(summary.message),
      bootStepId: summary.stepId ?? null,
      updatedAt: updatedAt ?? nowIso(),
    });
    await this.writeMutableState(next);
    return next;
  }

  private buildUpdatedStartupDiagnostics(
    snapshot: StartupDiagnosticsSnapshot,
    options: {
      event?: StartupDiagnosticEvent | null;
      currentStepId?: StartupDiagnosticStepId | null;
      currentStepMessage?: string | null;
      failure?: StartupDiagnosticFailure | null;
      logTails?: Partial<StartupDiagnosticLogTails> | null;
      updatedAt?: string | null;
    },
  ): StartupDiagnosticsSnapshot {
    const event = options.event ?? null;
    const updatedAt = normalizeDiagnosticMessage(options.updatedAt) ?? event?.at ?? nowIso();
    return normalizeStartupDiagnosticsSnapshot({
      ...snapshot,
      updatedAt,
      currentStepId:
        options.currentStepId !== undefined
          ? options.currentStepId
          : event?.stepId ?? snapshot.currentStepId,
      currentStepMessage:
        options.currentStepMessage !== undefined
          ? normalizeDiagnosticMessage(options.currentStepMessage)
          : event?.message ?? snapshot.currentStepMessage,
      events: event
        ? [...snapshot.events, event].slice(-STARTUP_DIAGNOSTICS_MAX_EVENTS)
        : snapshot.events,
      failure:
        options.failure !== undefined
          ? normalizeStartupDiagnosticFailure(options.failure)
          : snapshot.failure,
      logTails: mergeDiagnosticLogTails(snapshot.logTails, options.logTails),
    });
  }

  private async recordStartupDiagnosticsEvent(
    opId: string | null | undefined,
    options: {
      at?: string | null;
      stepId: StartupDiagnosticStepId;
      severity?: StartupDiagnosticSeverity | null;
      message: string;
      detail?: string | null;
      logTails?: Partial<StartupDiagnosticLogTails> | null;
    },
  ): Promise<StartupDiagnosticsSnapshot | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!resolvedOpId) {
      return null;
    }

    const active = await this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
    if (!active || active.opId !== resolvedOpId) {
      return null;
    }

    const event = buildStartupDiagnosticEvent({
      at: options.at,
      opId: resolvedOpId,
      stepId: options.stepId,
      severity: options.severity,
      message: options.message,
      detail: options.detail,
    });
    if (!event) {
      return active;
    }

    const next = this.buildUpdatedStartupDiagnostics(active, {
      event,
      logTails: options.logTails,
      updatedAt: event.at,
    });
    await this.writeStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY, next);
    return next;
  }

  private async recordStartupDiagnosticsFailure(
    opId: string | null | undefined,
    options: {
      at?: string | null;
      stepId?: StartupDiagnosticStepId | null;
      message: string;
      detail?: string | null;
      exitCode?: number | null;
      signal?: string | null;
      logTails?: Partial<StartupDiagnosticLogTails> | null;
    },
  ): Promise<StartupDiagnosticsSnapshot | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!resolvedOpId) {
      return null;
    }

    const active = await this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
    if (!active || active.opId !== resolvedOpId) {
      return null;
    }

    const fallbackStepId = options.stepId ?? active.currentStepId ?? "startup-failed";
    const failureMessage = normalizeDiagnosticMessage(options.message);
    if (!failureMessage) {
      return active;
    }

    const failureEvent = buildStartupDiagnosticEvent({
      at: options.at,
      opId: resolvedOpId,
      stepId: fallbackStepId,
      severity: "error",
      message: failureMessage,
      detail: options.detail,
    });
    const next = this.buildUpdatedStartupDiagnostics(active, {
      event: failureEvent,
      currentStepId: fallbackStepId,
      currentStepMessage: failureMessage,
      failure: {
        message: failureMessage,
        exitCode: typeof options.exitCode === "number" ? options.exitCode : null,
        signal: normalizeDiagnosticMessage(options.signal),
        lastStepId: fallbackStepId,
      },
      logTails: options.logTails,
      updatedAt: normalizeDiagnosticMessage(options.at),
    });
    await this.writeStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY, next);
    return next;
  }

  private getOrCreateMutableState(current: EnvMutableState | null): EnvMutableState {
    return current ?? createEmptyMutableState({
      status: "stopped",
      lifecyclePhase: "stopped",
      lifecycleDesiredState: "stopped",
    });
  }

  async hydrateFromSummary(meta: EnvMeta): Promise<EnvMutableState> {
    const current = await this.getMutableState();
    await this.rememberSlug(meta.slug);
    if (current) {
      return current;
    }

    const next = buildMutableStateFromMeta(meta);
    await this.writeMutableState(next);
    return next;
  }

  async getMutableState(): Promise<EnvMutableState | null> {
    return await this.resolveTimeoutState(await this.readStoredMutableState());
  }

  async getState(): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    return buildLifecycleState(current);
  }

  async getStartupDiagnostics(): Promise<StartupDiagnosticsState> {
    return this.readStartupDiagnosticsState();
  }

  async beginStartupDiagnostics(options: {
    opId: string | null | undefined;
    backend: "cf" | "host";
    stepId?: StartupDiagnosticStepId | null;
    message?: string | null;
    detail?: string | null;
  }): Promise<StartupDiagnosticsState> {
    const resolvedOpId = this.resolveLifecycleOpId(options.opId);
    const current = this.getOrCreateMutableState(await this.getMutableState());
    const existing = await this.readStartupDiagnosticsState();

    if (!resolvedOpId) {
      return existing;
    }

    let active = createEmptyStartupDiagnostics(resolvedOpId, options.backend);
    const initialEvent =
      options.stepId && options.message
        ? buildStartupDiagnosticEvent({
            opId: resolvedOpId,
            stepId: options.stepId,
            severity: "info",
            message: options.message,
            detail: options.detail,
          })
        : null;
    if (initialEvent) {
      active = this.buildUpdatedStartupDiagnostics(active, { event: initialEvent });
    }

    const nextDiagnostics = await this.setStartupDiagnosticsState({
      active,
      lastFailed: existing.active?.failure ? existing.active : existing.lastFailed,
    });
    await this.updateBootSummary(
      current,
      {
        message: nextDiagnostics.active?.currentStepMessage,
        stepId: nextDiagnostics.active?.currentStepId,
      },
      nextDiagnostics.active?.updatedAt,
    );
    return nextDiagnostics;
  }

  async reportStartupEvent(options: {
    opId: string | null | undefined;
    stepId: StartupDiagnosticStepId;
    severity?: StartupDiagnosticSeverity | null;
    message: string;
    detail?: string | null;
    at?: string | null;
    logTails?: Partial<StartupDiagnosticLogTails> | null;
  }): Promise<StartupDiagnosticsSnapshot | null> {
    const current = await this.getMutableState();
    const next = await this.recordStartupDiagnosticsEvent(options.opId, options);
    if (!next) {
      return null;
    }
    await this.updateBootSummary(
      current,
      {
        message: next.currentStepMessage,
        stepId: next.currentStepId,
      },
      next.updatedAt,
    );
    return next;
  }

  async reportStartupFailure(options: {
    opId: string | null | undefined;
    stepId?: StartupDiagnosticStepId | null;
    message: string;
    detail?: string | null;
    exitCode?: number | null;
    signal?: string | null;
    at?: string | null;
    logTails?: Partial<StartupDiagnosticLogTails> | null;
  }): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    const resolvedOpId = this.resolveLifecycleOpId(options.opId);
    if (!current || !resolvedOpId) {
      return buildLifecycleState(current);
    }

    const diagnostics = await this.recordStartupDiagnosticsFailure(resolvedOpId, options);
    const failureMessage = diagnostics?.failure?.message ?? normalizeDiagnosticMessage(options.message) ?? "Startup failed";

    let nextCurrent = current;
    if (diagnostics) {
      nextCurrent = normalizeMutableState({
        ...nextCurrent,
        bootMessage: diagnostics.currentStepMessage,
        bootStepId: diagnostics.currentStepId,
        updatedAt: diagnostics.updatedAt,
      });
    }

    if (current.lifecycleOpId !== resolvedOpId) {
      await this.writeMutableState(nextCurrent);
      return buildLifecycleState(nextCurrent);
    }

    if (current.lifecyclePhase === "starting") {
      const failed = applyLifecycleState(
        {
          ...nextCurrent,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
        },
        buildFailureState(
          {
            ...nextCurrent,
            lifecycleLastRunnerState: "stopped",
            lifecycleInfraState: "stopped",
            lifecycleRuntimeReady: false,
          },
          failureMessage,
        ),
      );
      await this.writeMutableState(failed);
      return buildLifecycleState(failed);
    }

    if (current.lifecyclePhase === "failed" && current.lifecycleDesiredState === "running") {
      const failed = normalizeMutableState({
        ...nextCurrent,
        error: failureMessage,
        errorAt: diagnostics?.updatedAt ?? nowIso(),
        updatedAt: diagnostics?.updatedAt ?? nowIso(),
      });
      await this.writeMutableState(failed);
      return buildLifecycleState(failed);
    }

    await this.writeMutableState(nextCurrent);
    return buildLifecycleState(nextCurrent);
  }

  async clearMutableState(): Promise<null> {
    await this.writeMutableState(null);
    await this.ctx.storage.delete(STOP_WORKSPACE_SYNCED_META_KEY);
    await this.clearStartupDiagnosticsState();
    return null;
  }

  async clearState(): Promise<null> {
    return this.clearMutableState();
  }

  async setStatus(
    status: EnvStatus,
    options?: { clearLifecycle?: boolean },
  ): Promise<EnvMutableState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      status,
      updatedAt,
      ...(options?.clearLifecycle
          ? {
            lifecyclePhase: null,
            lifecycleOpId: null,
            lifecycleOperation: null,
            lifecycleDesiredState: null,
            lifecycleLastRunnerState: null,
            lifecycleLastWorkspaceSyncedAckOpId: null,
            lifecycleInfraState: "unknown",
            lifecycleRuntimeReady: false,
            lifecycleUpdatedAt: null,
          }
        : {}),
    });
    await this.writeMutableState(next);
    return next;
  }

  async requestStop(): Promise<EnvLifecycleState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    if (
      current.lifecycleOperation === "stop" &&
      (current.lifecyclePhase === "saving" || current.lifecyclePhase === "stopping")
    ) {
      return buildLifecycleState(current)!;
    }

    const next = applyLifecycleState(current, {
      phase: "saving",
      activeOpId: buildStopOpId(),
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: current.lifecycleInfraState,
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: nowIso(),
    });
    await this.writeMutableState(next);
    return buildLifecycleState(next)!;
  }

  async requestStart(): Promise<EnvLifecycleState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    if (
      current.lifecycleOperation === "start" &&
      (current.lifecyclePhase === "starting" || current.lifecyclePhase === "running")
    ) {
      return buildLifecycleState(current)!;
    }

    const next = applyLifecycleState(current, {
      phase: "starting",
      activeOpId: buildStartOpId(),
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: current.lifecycleLastRunnerState,
      lastWorkspaceSyncedAckOpId: null,
      infraState: "unknown",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: nowIso(),
    });
    await this.writeMutableState(next);
    return buildLifecycleState(next)!;
  }

  async noteInfraReady(opId?: string | null): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!current || !resolvedOpId || current.lifecycleOpId !== resolvedOpId) {
      return buildLifecycleState(current);
    }
    if (current.lifecycleDesiredState !== "running") {
      return buildLifecycleState(current);
    }

    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      lifecycleInfraState: "ready",
      lifecycleLastRunnerState: "running",
      lifecycleUpdatedAt: updatedAt,
      updatedAt,
    });
    await this.writeMutableState(next);
    return buildLifecycleState(next);
  }

  async noteRunnerStarted(opId?: string | null): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!current || !resolvedOpId || current.lifecycleOpId !== resolvedOpId) {
      return buildLifecycleState(current);
    }
    if (
      current.lifecyclePhase !== "starting" &&
      !(current.lifecyclePhase === "failed" && current.lifecycleDesiredState === "running")
    ) {
      return buildLifecycleState(current);
    }

    const next = normalizeMutableState({
      ...applyLifecycleState(current, {
        phase: "running",
        activeOpId: current.lifecycleOpId,
        activeOperation: current.lifecycleOperation ?? "start",
        desiredState: "running",
        lastRunnerState: "running",
        lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
        infraState: "ready",
        runtimeReady: true,
        lastError: null,
        lastErrorAt: null,
        updatedAt: nowIso(),
      }),
      bootMessage: null,
      bootStepId: null,
    });
    await this.writeMutableState(next);
    await this.clearStartupDiagnosticsState();
    return buildLifecycleState(next);
  }

  async noteRunnerStartFailed(
    opId: string | null | undefined,
    error: string,
  ): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!current || !resolvedOpId || current.lifecycleOpId !== resolvedOpId) {
      return buildLifecycleState(current);
    }
    if (current.lifecyclePhase !== "starting") {
      return buildLifecycleState(current);
    }

    await this.recordStartupDiagnosticsFailure(resolvedOpId, {
      stepId: current.bootStepId ?? undefined,
      message: error,
    });
    const diagnostics = await this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
    const next = applyLifecycleState(
      {
        ...current,
        bootMessage: diagnostics?.currentStepMessage ?? normalizeDiagnosticMessage(error),
        bootStepId: diagnostics?.currentStepId ?? current.bootStepId,
      },
      buildFailureState(
        {
          ...current,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
        },
        error,
      ),
    );
    await this.writeMutableState(next);
    return buildLifecycleState(next);
  }

  async setRunnerBinding(options: {
    runnerId?: string | null;
    runnerMachineId?: string | null;
  }): Promise<EnvMutableState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      runnerId:
        options.runnerId !== undefined
          ? (options.runnerId?.trim() || null)
          : current.runnerId,
      runnerMachineId:
        options.runnerMachineId !== undefined
          ? (options.runnerMachineId?.trim() || null)
          : current.runnerMachineId,
      updatedAt,
    });
    await this.writeMutableState(next);
    return next;
  }

  async setBootProgress(
    message: string | null,
    stepId?: StartupDiagnosticStepId | null,
  ): Promise<EnvMutableState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    const next = normalizeMutableState({
      ...current,
      bootMessage: message?.trim() || null,
      bootStepId:
        stepId !== undefined
          ? (stepId ?? null)
          : current.bootStepId,
      updatedAt: nowIso(),
    });
    await this.writeMutableState(next);
    return next;
  }

  async setAuthWarning(warning: string | null): Promise<EnvMutableState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    const next = normalizeMutableState({
      ...current,
      authWarning: warning?.trim() || null,
      updatedAt: nowIso(),
    });
    await this.writeMutableState(next);
    return next;
  }

  async clearLeadHarnessState(): Promise<EnvMutableState> {
    const current = this.getOrCreateMutableState(await this.getMutableState());
    const next = normalizeMutableState({
      ...current,
      leadHarnessStatus: null,
      leadHarnessError: null,
      leadHarnessUpdatedAt: null,
      updatedAt: nowIso(),
    });
    await this.writeMutableState(next);
    return next;
  }

  async recordStopWorkspaceSynced(
    patch: StopWorkspaceSyncedMetaPatch,
    options?: {
      opId?: string | null;
      stopFinalize?: boolean;
      clearError?: boolean;
    },
  ): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    if (!current) {
      return null;
    }

    const updatedAt = nowIso();
    let next = normalizeMutableState({
      ...current,
      workspaceDirty: patch.workspaceDirty ?? current.workspaceDirty,
      workspaceNeedsAttention: patch.workspaceNeedsAttention ?? current.workspaceNeedsAttention,
      workspaceLastSyncedAt: patch.workspaceLastSyncedAt ?? current.workspaceLastSyncedAt,
      baseMainCommit: patch.baseMainCommit ?? current.baseMainCommit,
      lastKnownMainCommit: patch.lastKnownMainCommit ?? current.lastKnownMainCommit,
      branchStatus: patch.branchStatus ?? current.branchStatus,
      error: options?.clearError ? null : current.error,
      errorAt: options?.clearError ? null : current.errorAt,
      updatedAt,
    });

    if (options?.stopFinalize) {
      const resolvedOpId = this.resolveLifecycleOpId(options.opId);
      if (resolvedOpId) {
        await this.ctx.storage.put(STOP_WORKSPACE_SYNCED_META_KEY, {
          opId: resolvedOpId,
          patch,
        } satisfies PendingStopWorkspaceSyncedMeta);
      }

      if (resolvedOpId && current.lifecycleOpId === resolvedOpId && current.lifecyclePhase === "saving") {
        next = applyLifecycleState(
          next,
          {
            phase: "stopping",
            activeOpId: current.lifecycleOpId,
            activeOperation: current.lifecycleOperation,
            desiredState: "stopped",
            lastRunnerState: current.lifecycleLastRunnerState,
            lastWorkspaceSyncedAckOpId: resolvedOpId,
            infraState: current.lifecycleInfraState,
            runtimeReady: false,
            lastError: null,
            lastErrorAt: null,
            updatedAt,
          },
          { status: "stopping" },
        );
        console.info(
          `[env-lifecycle] workspace-synced ack advanced lifecycle: ${JSON.stringify({
            opId: resolvedOpId,
            fromPhase: current.lifecyclePhase,
            toPhase: "stopping",
            currentOpId: current.lifecycleOpId,
          })}`,
        );
      } else if (
        (current.lifecyclePhase === "running" || current.lifecyclePhase === "starting") &&
        current.lifecycleDesiredState === "running"
      ) {
        next = applyLifecycleState(
          next,
          {
            phase: "stopping",
            activeOpId: current.lifecycleOpId,
            activeOperation: "stop",
            desiredState: "stopped",
            lastRunnerState: current.lifecycleLastRunnerState,
            lastWorkspaceSyncedAckOpId: current.lifecycleOpId,
            infraState: current.lifecycleInfraState,
            runtimeReady: false,
            lastError: null,
            lastErrorAt: null,
            updatedAt,
          },
          { status: "stopping" },
        );
        console.info(
          `[env-lifecycle] workspace-synced ack treated as self-stop: ${JSON.stringify({
            opId: resolvedOpId,
            fromPhase: current.lifecyclePhase,
            toPhase: "stopping",
            currentOpId: current.lifecycleOpId,
            desiredState: current.lifecycleDesiredState,
          })}`,
        );
      } else {
        console.warn(
          `[env-lifecycle] workspace-synced ack did not advance lifecycle: ${JSON.stringify({
            opId: resolvedOpId,
            currentPhase: current.lifecyclePhase,
            currentOpId: current.lifecycleOpId,
            desiredState: current.lifecycleDesiredState,
            lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
          })}`,
        );
      }
    }

    await this.writeMutableState(next);
    return next;
  }

  async noteStopWorkspaceSynced(
    opId?: string | null,
    workspacePatch?: Partial<StopWorkspaceSyncedMetaPatch> | null,
  ): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    const patch: StopWorkspaceSyncedMetaPatch = {
      workspaceDirty: workspacePatch?.workspaceDirty ?? current?.workspaceDirty ?? null,
      workspaceNeedsAttention:
        workspacePatch?.workspaceNeedsAttention ?? current?.workspaceNeedsAttention ?? null,
      workspaceLastSyncedAt:
        workspacePatch?.workspaceLastSyncedAt ?? current?.workspaceLastSyncedAt ?? null,
      baseMainCommit: workspacePatch?.baseMainCommit ?? current?.baseMainCommit ?? null,
      lastKnownMainCommit: workspacePatch?.lastKnownMainCommit ?? current?.lastKnownMainCommit ?? null,
      branchStatus: workspacePatch?.branchStatus ?? current?.branchStatus ?? null,
    };
    const next = await this.recordStopWorkspaceSynced(patch, {
      opId,
      stopFinalize: true,
      clearError: true,
    });
    return buildLifecycleState(next);
  }

  async getStopWorkspaceSyncedMeta(): Promise<PendingStopWorkspaceSyncedMeta | null> {
    return (await this.ctx.storage.get<PendingStopWorkspaceSyncedMeta>(STOP_WORKSPACE_SYNCED_META_KEY)) ?? null;
  }

  async clearStopWorkspaceSyncedMeta(): Promise<void> {
    await this.ctx.storage.delete(STOP_WORKSPACE_SYNCED_META_KEY);
  }

  async recordWorkspaceSyncFailed(
    opId: string | null | undefined,
    error: string,
  ): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!current || !resolvedOpId || current.lifecycleOpId !== resolvedOpId) {
      return current;
    }

    const next = applyLifecycleState(current, buildFailureState(current, error));
    await this.writeMutableState(next);
    return next;
  }

  async noteWorkspaceSyncFailed(
    opId: string | null | undefined,
    error: string,
  ): Promise<EnvLifecycleState | null> {
    const next = await this.recordWorkspaceSyncFailed(opId, error);
    return buildLifecycleState(next);
  }

  async noteStopDispatchFailed(
    opId: string | null | undefined,
    error: string,
  ): Promise<EnvLifecycleState | null> {
    return this.noteWorkspaceSyncFailed(opId, error);
  }

  async setLeadHarnessFailed(message: string): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    if (!current) {
      return null;
    }
    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      leadHarnessStatus: "failed",
      leadHarnessError: message.trim() || "Lead harness exited unexpectedly",
      leadHarnessUpdatedAt: updatedAt,
      updatedAt,
    });
    await this.writeMutableState(next);
    return next;
  }

  async setScmProjection(state: ScmProjectionInput): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    if (!current) {
      return null;
    }
    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      scmOperationType: state.type,
      scmOperationId: state.operationId,
      scmOperationPhase: state.phase,
      scmOperationStartedAt: state.startedAt ?? current.scmOperationStartedAt ?? updatedAt,
      scmOperationUpdatedAt: updatedAt,
      updatedAt,
    });
    await this.writeMutableState(next);
    return next;
  }

  async clearScmProjection(result?: ClearedScmProjectionResult): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    if (!current) {
      return null;
    }
    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      scmOperationType: null,
      scmOperationId: null,
      scmOperationPhase: null,
      scmOperationStartedAt: null,
      scmOperationUpdatedAt: null,
      scmLastCompletedAt: result?.completedAt ?? current.scmLastCompletedAt,
      scmLastDurationMs: result?.durationMs ?? current.scmLastDurationMs,
      scmLastTimings: result?.timings ?? current.scmLastTimings,
      updatedAt,
    });
    await this.writeMutableState(next);
    return next;
  }

  async setError(message: string): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    if (!current) {
      return null;
    }
    const updatedAt = nowIso();
    const next = normalizeMutableState({
      ...current,
      error: message.trim() || current.error,
      errorAt: updatedAt,
      updatedAt,
    });
    await this.writeMutableState(next);
    return next;
  }

  async clearError(): Promise<EnvMutableState | null> {
    const current = await this.getMutableState();
    if (!current) {
      return null;
    }
    const next = normalizeMutableState({
      ...current,
      error: null,
      errorAt: null,
      updatedAt: nowIso(),
    });
    await this.writeMutableState(next);
    return next;
  }

  async noteRunnerStopped(
    opId: string | null | undefined,
    reason?: string | null,
  ): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!current || !resolvedOpId || current.lifecycleOpId !== resolvedOpId) {
      return buildLifecycleState(current);
    }

    if (current.lifecyclePhase === "stopping") {
      const next = normalizeMutableState({
        ...applyLifecycleState(current, {
          phase: "stopped",
          activeOpId: current.lifecycleOpId,
          activeOperation: current.lifecycleOperation,
          desiredState: "stopped",
          lastRunnerState: "stopped",
          lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
          infraState: "stopped",
          runtimeReady: false,
          lastError: null,
          lastErrorAt: null,
          updatedAt: nowIso(),
        }),
        bootMessage: null,
        bootStepId: null,
      });
      await this.writeMutableState(next);
      return buildLifecycleState(next);
    }

    if (
      current.lifecyclePhase === "failed"
      && current.lifecycleDesiredState === "stopped"
      && current.lifecycleLastWorkspaceSyncedAckOpId === resolvedOpId
    ) {
      const next = normalizeMutableState({
        ...applyLifecycleState(current, {
          phase: "stopped",
          activeOpId: current.lifecycleOpId,
          activeOperation: current.lifecycleOperation,
          desiredState: "stopped",
          lastRunnerState: "stopped",
          lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
          infraState: "stopped",
          runtimeReady: false,
          lastError: null,
          lastErrorAt: null,
          updatedAt: nowIso(),
        }),
        bootMessage: null,
        bootStepId: null,
      });
      await this.writeMutableState(next);
      return buildLifecycleState(next);
    }

    if (current.lifecyclePhase === "saving") {
      console.warn(
        `[env-lifecycle] runner stopped before workspace-synced ack: ${JSON.stringify({
          opId: resolvedOpId,
          currentPhase: current.lifecyclePhase,
          currentOpId: current.lifecycleOpId,
          lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
          reason: reason?.trim() ?? null,
        })}`,
      );
      const detail = reason?.trim()
        ? `Container exited before workspace persistence completed (${reason.trim()}). Recent workspace changes may not be saved.`
        : ENV_LIFECYCLE_RUNNER_EXIT_BEFORE_PERSIST_ERROR;
      const next = applyLifecycleState(
        {
          ...current,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
        },
        buildFailureState(
          {
            ...current,
            lifecycleLastRunnerState: "stopped",
            lifecycleInfraState: "stopped",
            lifecycleRuntimeReady: false,
          },
          detail,
        ),
      );
      await this.writeMutableState(next);
      return buildLifecycleState(next);
    }

    if (current.lifecyclePhase === "starting") {
      const detail = reason?.trim()
        ? `Container exited before the environment finished starting (${reason.trim()}).`
        : "Container exited before the environment finished starting.";
      await this.recordStartupDiagnosticsFailure(resolvedOpId, {
        stepId: current.bootStepId ?? undefined,
        message: detail,
      });
      const diagnostics = await this.readStartupDiagnosticsSnapshot(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
      const next = applyLifecycleState(
        {
          ...current,
          bootMessage: diagnostics?.currentStepMessage ?? detail,
          bootStepId: diagnostics?.currentStepId ?? current.bootStepId,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
        },
        buildFailureState(
          {
            ...current,
            lifecycleLastRunnerState: "stopped",
            lifecycleInfraState: "stopped",
            lifecycleRuntimeReady: false,
          },
          detail,
        ),
      );
      await this.writeMutableState(next);
      return buildLifecycleState(next);
    }

    if (current.lifecyclePhase === "running") {
      const detail = reason?.trim()
        ? `Container exited unexpectedly while the environment was running (${reason.trim()}).`
        : ENV_LIFECYCLE_RUNNER_EXIT_WHILE_RUNNING_ERROR;
      const next = applyLifecycleState(
        {
          ...current,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
        },
        buildFailureState(
          {
            ...current,
            lifecycleLastRunnerState: "stopped",
            lifecycleInfraState: "stopped",
            lifecycleRuntimeReady: false,
          },
          detail,
        ),
      );
      await this.writeMutableState(next);
      return buildLifecycleState(next);
    }

    return buildLifecycleState(current);
  }
  async alarm(): Promise<void> {
    const before = await this.readStoredMutableState();
    const next = await this.getMutableState();
    if (!before || !next) {
      return;
    }
    if (JSON.stringify(before) === JSON.stringify(next)) {
      return;
    }
    await this.persistProjectedSummary(next);
  }
}
