import type { EnvBranchStatus, EnvLifecyclePhase, EnvLifecycleState, EnvMeta, EnvStatus } from "./types";

// Workspace-sync fields that must survive a stale KV read during stop.
// Stored in EnvLifecycleDO (strongly consistent) so onStop / host-stop can
// build an accurate broadcast without reading from eventually-consistent KV.
export type StopWorkspaceSyncedMetaPatch = Pick<
  EnvMeta,
  | "workspaceDirty"
  | "workspaceNeedsAttention"
  | "workspaceLastSyncedAt"
  | "baseMainCommit"
  | "lastKnownMainCommit"
  | "branchStatus"
>;

export interface PendingStopWorkspaceSyncedMeta {
  opId: string;
  patch: StopWorkspaceSyncedMetaPatch;
}

export function buildEnvScmMetaPatch(
  meta: Pick<
    EnvMeta,
    | "workspaceDirty"
    | "workspaceNeedsAttention"
    | "workspaceLastSyncedAt"
    | "baseMainCommit"
    | "lastKnownMainCommit"
    | "branchStatus"
  >,
  overrides?: Partial<StopWorkspaceSyncedMetaPatch>,
): StopWorkspaceSyncedMetaPatch {
  return {
    workspaceDirty: overrides?.workspaceDirty ?? meta.workspaceDirty,
    workspaceNeedsAttention: overrides?.workspaceNeedsAttention ?? meta.workspaceNeedsAttention,
    workspaceLastSyncedAt: overrides?.workspaceLastSyncedAt ?? meta.workspaceLastSyncedAt,
    baseMainCommit: overrides?.baseMainCommit ?? meta.baseMainCommit,
    lastKnownMainCommit: overrides?.lastKnownMainCommit ?? meta.lastKnownMainCommit,
    branchStatus: overrides?.branchStatus ?? meta.branchStatus,
  };
}

export const ENV_LIFECYCLE_SAVE_TIMEOUT_MS = 75_000;
// Stop completion includes post-sync shutdown work inside the runner, so give
// the runner more headroom than the cleanup timeout itself before failing.
export const ENV_LIFECYCLE_STOP_TIMEOUT_MS = 60_000;
export const ENV_LIFECYCLE_START_TIMEOUT_MS = 90_000;
export const ENV_LIFECYCLE_RUNNER_EXIT_BEFORE_PERSIST_ERROR =
  "Container exited before workspace persistence completed. Recent workspace changes may not be saved.";
export const ENV_LIFECYCLE_SAVE_TIMEOUT_ERROR =
  "Stop did not confirm workspace persistence before timeout; recent workspace changes may not be saved.";
export const ENV_LIFECYCLE_STOP_TIMEOUT_ERROR =
  "Workspace persistence completed, but the runner did not stop before timeout.";
export const ENV_LIFECYCLE_START_TIMEOUT_ERROR =
  "Environment did not confirm runner readiness before timeout.";
export const ENV_LIFECYCLE_RUNNER_EXIT_WHILE_RUNNING_ERROR =
  "Container exited unexpectedly while the environment was running.";

export function envLifecyclePhaseToStatus(phase: EnvLifecyclePhase): EnvStatus {
  return phase;
}

export function applyLifecycleProjectionToMeta(
  meta: EnvMeta,
  lifecycle: EnvLifecycleState | null | undefined,
): EnvMeta {
  if (!lifecycle) {
    return {
      ...meta,
      lifecyclePhase: null,
      lifecycleOpId: null,
      lifecycleOperation: null,
      lifecycleDesiredState: null,
      lifecycleInfraState: null,
      lifecycleRuntimeReady: false,
      lifecycleUpdatedAt: null,
    };
  }

  const next: EnvMeta = {
    ...meta,
    status: envLifecyclePhaseToStatus(lifecycle.phase),
    lifecyclePhase: lifecycle.phase,
    lifecycleOpId: lifecycle.activeOpId,
    lifecycleOperation: lifecycle.activeOperation,
    lifecycleDesiredState: lifecycle.desiredState,
    lifecycleInfraState: lifecycle.infraState,
    lifecycleRuntimeReady: lifecycle.runtimeReady,
    lifecycleUpdatedAt: lifecycle.updatedAt,
  };

  if (lifecycle.lastError) {
    next.error = lifecycle.lastError;
    next.errorAt = lifecycle.lastErrorAt ?? meta.errorAt;
  } else if (lifecycle.phase !== "failed") {
    delete next.error;
    delete next.errorAt;
  }

  return next;
}

export function isLifecycleStopInProgress(
  target: Pick<EnvMeta, "status" | "lifecyclePhase"> | Pick<EnvLifecycleState, "phase">,
): boolean {
  const phase = "phase" in target ? target.phase : target.lifecyclePhase ?? target.status ?? null;
  return phase === "saving" || phase === "stopping";
}
