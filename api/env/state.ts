import type {
  EnvDefinition,
  EnvInfraState,
  EnvLifecycleDesiredState,
  EnvLifecyclePhase,
  EnvMeta,
  EnvMutableState,
  EnvStatus,
} from "../types";
import {
  assertExplicitEnvScmFields,
  assertExplicitEnvSummaryFields,
  projectEnvSummary,
} from "../sync/projectors";

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

export function createEmptyMutableState(overrides: Partial<EnvMutableState> = {}): EnvMutableState {
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
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

export function normalizeMutableState(state: EnvMutableState): EnvMutableState {
  return createEmptyMutableState(state);
}

export function buildMutableStateFromMeta(meta: EnvMeta): EnvMutableState {
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

export function createFallbackMutableState(definition: EnvDefinition): EnvMutableState {
  return createEmptyMutableState({
    status: "unknown",
    updatedAt: definition.createdAt,
  });
}

export function buildEnvMetaFromLayers(
  definition: EnvDefinition,
  mutableState: EnvMutableState,
  repoUrl: string,
): EnvMeta {
  const next: EnvMeta = {
    slug: definition.slug,
    repoUrl,
    repoId: definition.repoId,
    backend: definition.backend,
    ...(mutableState.runnerId ? { runnerId: mutableState.runnerId } : {}),
    ...(mutableState.runnerMachineId ? { runnerMachineId: mutableState.runnerMachineId } : {}),
    harness: definition.harness,
    ...(definition.authMode ? { authMode: definition.authMode } : {}),
    ...(definition.resolvedAuthMode ? { resolvedAuthMode: definition.resolvedAuthMode } : {}),
    ...(definition.codexAuthPreference ? { codexAuthPreference: definition.codexAuthPreference } : {}),
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
