import type { HarnessSettings, ScheduledRunProjection } from "../types";

export const SCHEDULED_RUN_RETRY_MS = 10 * 60_000;
export const SCHEDULED_RUN_CAPACITY_RETRY_MS = 60_000;
export const SCHEDULED_RUN_HARD_CAP_MS = 3 * 60 * 60_000;
export const SCHEDULED_RUN_EFFECT_RETRY_MS = 60_000;
export const SCHEDULED_RUN_PREPARATION_LEASE_MS = 2 * 60_000;
/** A live effect gets a longer grace period; its heartbeat still advances while the caller exists. */
export const SCHEDULED_RUN_PREPARATION_ABANDON_MS = 15 * 60_000;

export type ScheduledRunRequestedOutcome = "completed" | "interrupted";
export type ScheduledRunFinalOutcome = ScheduledRunRequestedOutcome | "failed";

/**
 * The selected plan is captured once for an environment incarnation.  It is
 * deliberately separate from the lifecycle record so ordinary starts can
 * keep using it after the Scheduled Run projection has been archived.
 */
export interface ImmutableEnvironmentPlan {
  incarnationId: string;
  artifactId: string;
  version: number;
  renderedPlanDocument: string;
  createdAt: string;
}

interface ScheduledRunIdentity {
  incarnationId: string;
  runAtMs: number;
  deadlineAtMs: number;
  timeZone: string;
  /** Persisted only for contributor loopback development; production resolves canonical trust fresh. */
  localDevOrigin: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentPlanSchedule extends ScheduledRunIdentity {
  kind: "schedule";
  /** Allocated before the first external capacity request. */
  attemptId: string | null;
  retryAtMs: number | null;
  lastError: string | null;
  capacityAcquired: boolean;
  acquireUncertain: boolean;
  cancelRequested: boolean;
  terminalRequested: boolean;
}

export interface ScheduledRunPreparation {
  claimedAtMs: number;
  heartbeatAtMs: number;
  effectMayBeLive: boolean;
}

export interface ScheduledRunCredentialScope {
  incarnationId: string;
  startOpId: string;
}

export interface ScheduledRunCredentialIds {
  githubBridgeId?: string;
}

export interface ActiveScheduledRunReceipt extends ScheduledRunIdentity {
  kind: "active";
  slug: string;
  attemptId: string;
  startOpId: string;
  startCause: "scheduled";
  runnerGeneration: number;
  harnessSettings: HarnessSettings;
  hostMachineId: string | null;
  preparation: ScheduledRunPreparation | null;
  credentialsMayExist: boolean;
  credentialIds: ScheduledRunCredentialIds;
  runnerDispatchStarted: boolean;
  runnerStoppedConfirmed: boolean;
  persistenceConfirmed: boolean;
  capacityReleased: boolean;
  requestedOutcome: ScheduledRunRequestedOutcome | null;
  stopOpId: string | null;
  stopRunnerGeneration: number | null;
  runnerCleanupRequired: boolean;
  runnerUncertaintyError: string | null;
  failure: string | null;
  startedAt: string;
}

export interface FinishedScheduledRunReceipt extends ScheduledRunIdentity {
  kind: "finished";
  started: boolean;
  attemptId: string | null;
  startOpId: string | null;
  requestedOutcome: ScheduledRunRequestedOutcome | null;
  outcome: ScheduledRunFinalOutcome;
  error: string | null;
  /** Only runner uncertainty sets this flag. */
  cleanupRequired: boolean;
  finishedAt: string;
  archivedAt: string | null;
}

export type ScheduledRunRecord =
  | EnvironmentPlanSchedule
  | ActiveScheduledRunReceipt
  | FinishedScheduledRunReceipt;

export function projectScheduledRun(
  record: ScheduledRunRecord | null,
): ScheduledRunProjection | null {
  if (!record || (record.kind === "finished" && record.archivedAt)) return null;
  const base = { runAtMs: record.runAtMs, timeZone: record.timeZone };
  if (record.kind === "schedule") {
    return {
      ...base,
      state: "scheduled",
      ...(record.cancelRequested
        || record.terminalRequested
        || record.acquireUncertain
        || record.capacityAcquired
        ? { stage: "saving" as const }
        : {}),
    };
  }
  if (record.kind === "active") {
    if (record.runnerCleanupRequired) {
      return {
        ...base,
        state: "failed",
        error: record.runnerUncertaintyError
          ?? record.failure
          ?? "Runner shutdown could not be confirmed.",
        cleanupRequired: true,
      };
    }
    return {
      ...base,
      state: "running",
      stage: record.requestedOutcome || record.stopOpId || record.failure ? "saving" : "implementing",
      ...(record.failure ? { error: record.failure } : {}),
    };
  }
  return {
    ...base,
    state: record.outcome,
    ...(record.error ? { error: record.error } : {}),
    ...(record.cleanupRequired ? { cleanupRequired: true } : {}),
  };
}

export function nextScheduledRunWakeAt(
  record: ScheduledRunRecord | null,
  now = Date.now(),
): number | null {
  if (!record) return null;
  if (record.kind === "finished") return record.cleanupRequired ? now + SCHEDULED_RUN_EFFECT_RETRY_MS : null;
  if (record.kind === "schedule") {
    if (record.acquireUncertain || record.capacityAcquired || record.cancelRequested) {
      return now + SCHEDULED_RUN_EFFECT_RETRY_MS;
    }
    return Math.min(record.retryAtMs ?? record.runAtMs, record.deadlineAtMs);
  }
  if (record.preparation) {
    const preparationExpiresAt = record.preparation.heartbeatAtMs + (
      record.preparation.effectMayBeLive
        ? SCHEDULED_RUN_PREPARATION_ABANDON_MS
        : SCHEDULED_RUN_PREPARATION_LEASE_MS
    );
    return now >= record.deadlineAtMs
      ? Math.max(now, preparationExpiresAt)
      : Math.min(preparationExpiresAt, record.deadlineAtMs);
  }
  if (
    record.requestedOutcome
    || record.failure
    || record.credentialsMayExist
    || !record.capacityReleased
    || !record.runnerStoppedConfirmed
  ) {
    return now >= record.deadlineAtMs
      ? now + SCHEDULED_RUN_EFFECT_RETRY_MS
      : Math.min(now + SCHEDULED_RUN_EFFECT_RETRY_MS, record.deadlineAtMs);
  }
  return record.deadlineAtMs;
}

export function finishedScheduledRun(
  record: EnvironmentPlanSchedule | ActiveScheduledRunReceipt,
  options: {
    outcome: ScheduledRunFinalOutcome;
    error?: string | null;
    cleanupRequired?: boolean;
    at?: string;
  },
): FinishedScheduledRunReceipt {
  const at = options.at ?? new Date().toISOString();
  return {
    kind: "finished",
    incarnationId: record.incarnationId,
    runAtMs: record.runAtMs,
    deadlineAtMs: record.deadlineAtMs,
    timeZone: record.timeZone,
    localDevOrigin: record.localDevOrigin,
    createdAt: record.createdAt,
    updatedAt: at,
    started: record.kind === "active",
    attemptId: record.attemptId,
    startOpId: record.kind === "active" ? record.startOpId : null,
    requestedOutcome: record.kind === "active" ? record.requestedOutcome : null,
    outcome: options.outcome,
    error: options.error?.trim() || null,
    cleanupRequired: options.cleanupRequired === true,
    finishedAt: at,
    archivedAt: null,
  };
}
