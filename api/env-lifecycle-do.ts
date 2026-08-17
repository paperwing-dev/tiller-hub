import { DurableObject } from "cloudflare:workers";
import type {
  Env,
  GitHubEnvPendingPublishProjection,
  EnvLifecycleDesiredState,
  EnvLifecycleOperation,
  EnvLifecyclePhase,
  EnvLifecycleState,
  EnvMeta,
  EnvMutableState,
  EnvDefinition,
  HarnessSettings,
  EnvStatus,
  StartupDiagnosticEvent,
  StartupDiagnosticFailure,
  StartupDiagnosticLogTails,
  StartupDiagnosticSeverity,
  StartupDiagnosticStepId,
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
  RunnerCommandClaim,
  CodexExecutionProfile,
  ResolvedClaudeAuthMode,
  CodexAuthPreference,
  ExecutionPlacement,
} from "./types";
import { projectEnvSummary } from "./sync/projectors";
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
import type { DraftPrContent } from "./github/pr-content";
import {
  getEnvDefinitionKey,
  persistEnvDefinition,
  persistEnvSummary,
  readEnvDefinition,
} from "./plan/store";
import { loadRepoProjection } from "./repo/access";
import {
  buildEnvMetaFromLayers,
  buildMutableStateFromMeta,
  createEmptyMutableState,
  normalizeMutableState,
} from "./env/state";
import {
  SCHEDULED_RUN_CAPACITY_RETRY_MS,
  SCHEDULED_RUN_EFFECT_RETRY_MS,
  SCHEDULED_RUN_HARD_CAP_MS,
  SCHEDULED_RUN_PREPARATION_ABANDON_MS,
  SCHEDULED_RUN_PREPARATION_LEASE_MS,
  SCHEDULED_RUN_RETRY_MS,
  finishedScheduledRun,
  nextScheduledRunWakeAt,
  projectScheduledRun,
  type ActiveScheduledRunReceipt,
  type EnvironmentPlanSchedule,
  type ImmutableEnvironmentPlan,
  type ScheduledRunCredentialIds,
  type ScheduledRunRecord,
  type ScheduledRunRequestedOutcome,
} from "./env/scheduled-run-state";
import { cleanupLaunchCredentialsBestEffort, startEnvAction, stopEnvAction } from "./env/lifecycle-actions";
import type { ScheduledRunCapacityDO } from "./scheduled-run-capacity-do";
import { codexExecutionAuthMode } from "./codex-execution";
import { EXISTING_EXECUTION_UNAVAILABLE_MESSAGE } from "./execution";
import { cleanupGitHubPublishRuntime } from "./github/publish-runtime";
import { revokeGitHubBridgesForEnvPublish } from "./github/bridge";
import { resolveCanonicalHubOrigin } from "./canonical-origin";
import { isLoopbackHostname } from "../shared/local-dev";
import { getDurableObjectStub } from "./durable-object";
import { isProjectedRuntimeFailure } from "./env/runtime-failure";

const MUTABLE_STATE_KEY = "env-mutable-state";
const ENV_SLUG_KEY = "env-slug";
const SCHEDULED_RUN_RECORD_KEY = "env-scheduled-run-record-v1";
const IMMUTABLE_PLAN_KEY = "env-immutable-plan-v1";
const SCHEDULED_RUN_LEASE_RELEASE_KEY = "env-scheduled-run-lease-release";
const SCHEDULED_RUN_ATTEMPT_SEQUENCE_KEY = "env-scheduled-run-attempt-sequence";
const RUNNER_COMMAND_GENERATION_KEY = "runner-command-generation";
const RUNNER_COMMAND_CLAIM_KEY = "runner-command-claim";
const ENV_PUBLICATION_KEY = "env-publication";
const PROJECTION_VERSION_KEY = "env-projection-version";
const PROJECTION_DIRTY_KEY = "env-projection-dirty-version";
const INITIAL_CREATE_CLAIM_KEY = "env-initial-create-claim";
const INITIAL_CREATE_CLAIM_TTL_MS = 5 * 60_000;
const STOP_WORKSPACE_SYNCED_META_KEY = "stop-workspace-synced-meta";
const STOP_RETRY_KEY = "stop-retry-v1";
const STOP_RETRY_INITIAL_DELAY_MS = 2_000;
const STOP_RETRY_MAX_DELAY_MS = 30_000;
const GITHUB_PUBLISH_OPERATION_KEY = "github-publish-operation";
const GITHUB_PUBLISH_OPERATION_TIMEOUT_MS = 10 * 60_000;
const GITHUB_PUBLISH_RESULT_CLAIM_TTL_MS = 10 * 60_000;
const STARTUP_DIAGNOSTICS_ACTIVE_KEY = "startup-diagnostics-active";
const STARTUP_DIAGNOSTICS_LAST_FAILED_KEY = "startup-diagnostics-last-failed";
const CODEX_EXECUTION_PROFILE_KEY = "codex-execution-profile-v1";
const STARTUP_DIAGNOSTICS_MAX_EVENTS = 50;
const STARTUP_DIAGNOSTICS_MAX_LOG_TAIL_CHARS = 4000;

interface StopRetryRecord {
  opId: string;
  attempt: number;
  nextAttemptAtMs: number;
  idleClaimId?: string;
}

function stopRetryDelayMs(attempt: number): number {
  return Math.min(
    STOP_RETRY_MAX_DELAY_MS,
    STOP_RETRY_INITIAL_DELAY_MS * (2 ** Math.min(20, Math.max(0, attempt))),
  );
}

function stopRetryProgressMessage(error: string): string {
  if (/active agent turn.+(?:idle|finish)/iu.test(error)) {
    return "Waiting for the active agent turn to finish safely…";
  }
  return "Retrying workspace save…";
}

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

function patchValue<K extends keyof StopWorkspaceSyncedMetaPatch>(
  patch: StopWorkspaceSyncedMetaPatch,
  current: EnvMutableState,
  key: K,
): StopWorkspaceSyncedMetaPatch[K] {
  return Object.prototype.hasOwnProperty.call(patch, key)
    ? patch[key]
    : current[key] as StopWorkspaceSyncedMetaPatch[K];
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
  implementationMode: "fresh" | "plan" | null = null,
  startedAt = nowIso(),
): StartupDiagnosticsSnapshot {
  return {
    opId,
    backend,
    implementationMode,
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
    implementationMode: value.implementationMode === "fresh" || value.implementationMode === "plan"
      ? value.implementationMode
      : null,
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

function inferDesiredState(phase: EnvLifecyclePhase | null): EnvLifecycleDesiredState | null {
  if (!phase) {
    return null;
  }
  return phase === "starting" || phase === "running" ? "running" : "stopped";
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

export interface GitHubPublishOperationRecord {
  operationId: string;
  envSlug: string;
  repoId: string;
  repoUrl: string;
  jobSlug: string;
  executionPlacement: ExecutionPlacement;
  branch: string;
  baseCommitSha: string;
  workspaceHash: string;
  expectedPriorHead: string | null;
  hmacKey: string;
  callbackToken: string;
  pullRequestContent: DraftPrContent;
  resultClaim: {
    claimId: string;
    expiresAtMs: number;
  } | null;
  cleanupPending: {
    terminalError: string;
  } | null;
  startedAt: string;
}

export interface EnvStartClaimResult {
  lifecycle: EnvLifecycleState | null;
  dispatchGranted: boolean;
  harnessSettings: HarnessSettings | null;
  claudeAuthMode?: ResolvedClaudeAuthMode;
  codexAuthPreference?: CodexAuthPreference;
}

interface StoredCodexExecutionProfile {
  startOpId: string;
  profile: CodexExecutionProfile;
  accountId: string | null;
  projectionUpdatedAt?: string;
}

export interface ActiveImplementorCodexRuntimeSubject {
  envSlug: string;
  incarnationId: string;
  startOpId: string;
  profile: CodexExecutionProfile;
}

interface InitialCreateClaim {
  incarnationId: string;
  createdAtMs: number;
}

interface PendingScheduledRunLeaseRelease {
  slug: string;
  attemptId: string;
  nextAttemptAtMs: number;
}

type StoredPendingScheduledRunLeaseReleases =
  | PendingScheduledRunLeaseRelease
  | PendingScheduledRunLeaseRelease[];

function normalizePendingScheduledRunLeaseReleases(
  stored: StoredPendingScheduledRunLeaseReleases | null | undefined,
): PendingScheduledRunLeaseRelease[] {
  if (!stored) return [];
  const candidates = Array.isArray(stored) ? stored : [stored];
  return candidates.filter((candidate) => Boolean(
    candidate
    && typeof candidate.slug === "string"
    && candidate.slug.trim()
    && typeof candidate.attemptId === "string"
    && candidate.attemptId.trim()
    && Number.isFinite(candidate.nextAttemptAtMs),
  ));
}

function nextPendingScheduledRunLeaseReleaseAt(
  pending: readonly PendingScheduledRunLeaseRelease[],
): number | null {
  if (pending.length === 0) return null;
  return Math.min(...pending.map((release) => release.nextAttemptAtMs));
}

export type EnvStoppedInitializationResult =
  | { created: true; claimId: string; mutableState: EnvMutableState }
  | { created: false; claimId: null; mutableState: EnvMutableState | null };

type ClaimedInitialEnvironmentResult = EnvStoppedInitializationResult;

export interface EnvPublicationRecord {
  incarnationId: string;
  state: "pending" | "visible" | "deleted";
  updatedAt: string;
}

export type ScheduledRunPublicStartGuard =
  | { action: "ordinary" }
  | { action: "blocked"; error: string };

export type ScheduledRunOutcomeResult =
  | {
      status: "accepted" | "idempotent";
      outcome: ScheduledRunRequestedOutcome;
      stop?: RunnerCommandClaim;
      lifecycle?: EnvLifecycleState;
      preparationInFlight?: boolean;
    }
  | { status: "rejected"; error: string };

export interface ScheduledRunAttemptSnapshot {
  attemptId: string;
  schedule: EnvironmentPlanSchedule;
  plan: ImmutableEnvironmentPlan;
}

export interface ScheduledRunStopClaimResult {
  scheduled: boolean;
  preparationInFlight: boolean;
  lifecycle: EnvLifecycleState;
  runnerCommand: RunnerCommandClaim;
}

export type EnvDeleteClaimResult =
  | { allowed: true; runnerCommand: RunnerCommandClaim; mutableState: EnvMutableState }
  | { allowed: false; error: string; mutableState: EnvMutableState | null };

export interface RebaseRejectedRunnerCommandInput {
  rejectedCommand: RunnerCommandClaim;
  currentCommandGeneration: number;
}

export class EnvLifecycleDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async readStoredMutableState(): Promise<EnvMutableState | null> {
    const stored = await this.ctx.storage.get<EnvMutableState>(MUTABLE_STATE_KEY);
    return stored ? normalizeMutableState(stored) : null;
  }

  private async markProjectionDirtyInTransaction(txn: DurableObjectTransaction): Promise<number> {
    const version = ((await txn.get<number>(PROJECTION_VERSION_KEY)) ?? 0) + 1;
    await txn.put(PROJECTION_VERSION_KEY, version);
    await txn.put(PROJECTION_DIRTY_KEY, version);
    return version;
  }

  private async readProjectionVersion(): Promise<number> {
    return (await this.ctx.storage.get<number>(PROJECTION_VERSION_KEY)) ?? 0;
  }

  private async readScheduledRun(): Promise<ScheduledRunRecord | null> {
    return (await this.ctx.storage.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY)) ?? null;
  }

  async getScheduledRun(): Promise<ScheduledRunRecord | null> {
    return this.readScheduledRun();
  }

  async getImmutablePlan(): Promise<ImmutableEnvironmentPlan | null> {
    return (await this.ctx.storage.get<ImmutableEnvironmentPlan>(IMMUTABLE_PLAN_KEY)) ?? null;
  }

  async getPublication(): Promise<EnvPublicationRecord | null> {
    return (await this.ctx.storage.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY)) ?? null;
  }

  private async rememberSlug(slug: string): Promise<void> {
    const normalized = slug.trim();
    if (!normalized) {
      return;
    }
    await this.ctx.storage.put(ENV_SLUG_KEY, normalized);
  }

  private async claimInitialCreation(incarnationId: string): Promise<string | null> {
    const claim: InitialCreateClaim = {
      incarnationId,
      createdAtMs: Date.now(),
    };
    return this.ctx.storage.transaction(async (txn) => {
      const [existingState, existingClaim, storedPendingLeaseReleases] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY),
        txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
      ]);
      const liveClaim = existingClaim
        && Number.isFinite(existingClaim.createdAtMs)
        && Date.now() - existingClaim.createdAtMs < INITIAL_CREATE_CLAIM_TTL_MS;
      if (existingState || liveClaim) return null;
      await txn.put(INITIAL_CREATE_CLAIM_KEY, claim);
      const claimExpiresAt = claim.createdAtMs + INITIAL_CREATE_CLAIM_TTL_MS;
      const pendingReleaseAt = nextPendingScheduledRunLeaseReleaseAt(
        normalizePendingScheduledRunLeaseReleases(storedPendingLeaseReleases),
      );
      await txn.setAlarm(pendingReleaseAt != null
        ? Math.min(claimExpiresAt, pendingReleaseAt)
        : claimExpiresAt);
      return claim.incarnationId;
    });
  }

  private async hasInitialCreationClaim(): Promise<boolean> {
    const claim = await this.ctx.storage.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY);
    return Boolean(claim);
  }

  async isInitialCreationPending(): Promise<boolean> {
    return this.hasInitialCreationClaim();
  }

  private async clearClaimedInitialState(claimId: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const [claim, publication, storedPendingLeaseReleases] = await Promise.all([
        txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
      ]);
      if (claim?.incarnationId !== claimId) return false;
      await txn.delete([
        INITIAL_CREATE_CLAIM_KEY,
        MUTABLE_STATE_KEY,
        SCHEDULED_RUN_RECORD_KEY,
        IMMUTABLE_PLAN_KEY,
        ENV_SLUG_KEY,
        PROJECTION_DIRTY_KEY,
        CODEX_EXECUTION_PROFILE_KEY,
      ]);
      if (publication?.incarnationId === claimId) {
        await txn.put(ENV_PUBLICATION_KEY, {
          ...publication,
          state: "deleted",
          updatedAt: nowIso(),
        } satisfies EnvPublicationRecord);
      }
      const pendingReleaseAt = nextPendingScheduledRunLeaseReleaseAt(
        normalizePendingScheduledRunLeaseReleases(storedPendingLeaseReleases),
      );
      if (pendingReleaseAt != null) {
        await txn.setAlarm(Math.max(Date.now(), pendingReleaseAt));
      } else {
        await txn.deleteAlarm();
      }
      return true;
    });
  }

  private async initializeClaimedEnvironment(options: {
    definition: EnvDefinition;
    initialMutableState: EnvMutableState;
    buildMutableState: (initial: EnvMutableState) => EnvMutableState;
    persistDefinition: boolean;
    retainClaim: boolean;
    scheduledRun?: {
      runAtMs: number;
      timeZone: string;
      localDevOrigin: string | null;
      plan: ImmutableEnvironmentPlan;
    };
    incarnationId?: string;
  }): Promise<ClaimedInitialEnvironmentResult> {
    const incarnationId = options.incarnationId
      ?? options.definition.incarnationId
      ?? crypto.randomUUID();
    const claimId = await this.claimInitialCreation(incarnationId);
    if (!claimId) {
      return {
        created: false,
        claimId: null,
        mutableState: await this.readStoredMutableState(),
      };
    }

    let definitionWriteAttempted = false;
    try {
      const existingDefinition = await readEnvDefinition(this.env, options.definition.slug);
      if (existingDefinition) {
        const publication = await this.getPublication();
        const staleUnpublishedDefinition = Boolean(
          existingDefinition.incarnationId
          && publication?.incarnationId !== existingDefinition.incarnationId,
        ) || Boolean(
          existingDefinition.incarnationId
          && publication?.incarnationId === existingDefinition.incarnationId
          && publication.state !== "visible",
        );
        if (!staleUnpublishedDefinition) {
          await this.clearClaimedInitialState(claimId);
          return { created: false, claimId: null, mutableState: null };
        }
      }
      if (options.persistDefinition) {
        definitionWriteAttempted = true;
        await persistEnvDefinition(this.env, options.definition);
      }
      let mutableState = normalizeMutableState(
        options.buildMutableState(normalizeMutableState(options.initialMutableState)),
      );
      const scheduledRun = options.scheduledRun
        ? {
            kind: "schedule",
            incarnationId,
            runAtMs: options.scheduledRun.runAtMs,
            deadlineAtMs: options.scheduledRun.runAtMs + SCHEDULED_RUN_HARD_CAP_MS,
            timeZone: options.scheduledRun.timeZone,
            localDevOrigin: options.scheduledRun.localDevOrigin,
            attemptId: null,
            retryAtMs: null,
            lastError: null,
            capacityAcquired: false,
            acquireUncertain: false,
            cancelRequested: false,
            terminalRequested: false,
            createdAt: nowIso(),
            updatedAt: nowIso(),
          } satisfies EnvironmentPlanSchedule
        : null;
      if (options.scheduledRun && options.scheduledRun.plan.incarnationId !== incarnationId) {
        throw new Error("The immutable plan belongs to a different environment incarnation.");
      }
      const projection = projectScheduledRun(scheduledRun);
      if (projection) {
        mutableState = normalizeMutableState({ ...mutableState, scheduledRun: projection });
      }
      await this.ctx.storage.transaction(async (txn) => {
        const claim = await txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY);
        if (
          claim?.incarnationId !== claimId
          || !Number.isFinite(claim.createdAtMs)
          || Date.now() - claim.createdAtMs >= INITIAL_CREATE_CLAIM_TTL_MS
        ) {
          throw new Error("Initial environment creation ownership was lost before commit.");
        }
        await txn.put(ENV_SLUG_KEY, options.definition.slug);
        await txn.put(MUTABLE_STATE_KEY, mutableState);
        await this.markProjectionDirtyInTransaction(txn);
        if (scheduledRun) {
          await txn.put(SCHEDULED_RUN_RECORD_KEY, scheduledRun);
          await txn.put(IMMUTABLE_PLAN_KEY, options.scheduledRun!.plan);
        }
        await txn.put(ENV_PUBLICATION_KEY, {
          incarnationId,
          state: options.retainClaim ? "pending" : "visible",
          updatedAt: nowIso(),
        } satisfies EnvPublicationRecord);
        if (!options.retainClaim) await txn.delete(INITIAL_CREATE_CLAIM_KEY);
        const startOpId = mutableState.lifecycleOperation === "start"
          && mutableState.lifecycleDesiredState === "running"
          && mutableState.lifecycleOpId
          ? mutableState.lifecycleOpId
          : null;
        if (startOpId) {
          await this.allocateRunnerCommandInTransaction(txn, startOpId, "running");
        }
      });
      if (!options.retainClaim) await this.scheduleNextAlarm(mutableState, scheduledRun);
      return { created: true, claimId, mutableState };
    } catch (error) {
      if (definitionWriteAttempted) {
        await this.env.ENVS_KV.delete(getEnvDefinitionKey(options.definition.slug)).catch(() => {});
      }
      await this.clearClaimedInitialState(claimId).catch(() => {});
      throw error;
    }
  }

  private async readStoredSlug(): Promise<string | null> {
    return (await this.ctx.storage.get<string>(ENV_SLUG_KEY)) ?? null;
  }

  async getOwnedEnvView(): Promise<EnvMeta | null> {
    const slug = await this.readStoredSlug();
    if (!slug) return null;
    const definition = await readEnvDefinition(this.env, slug);
    if (!definition?.incarnationId) return null;
    const snapshot = await this.ctx.storage.transaction(async (txn) => {
      const [publication, storedMutable, storedProfile] = await Promise.all([
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StoredCodexExecutionProfile>(CODEX_EXECUTION_PROFILE_KEY),
      ]);
      if (!storedMutable) return null;
      if (
        publication?.incarnationId !== definition.incarnationId
        || publication.state !== "visible"
      ) return null;
      return {
        mutable: normalizeMutableState(storedMutable),
        profile: storedProfile ?? null,
      };
    });
    if (!snapshot) return null;
    const repo = await loadRepoProjection(this.env, definition.repoId);
    if (!repo.ok) return null;

    const projectedDefinition = { ...definition };
    let profileProjectionUpdatedAt: string | undefined;
    if (definition.harness === "codex") {
      delete projectedDefinition.codexAuthMode;
      const awaitingCurrentProfile = snapshot.mutable.lifecyclePhase === "starting"
        && snapshot.mutable.lifecycleOperation === "start"
        && snapshot.mutable.lifecycleDesiredState === "running";
      const matchingCurrentProfile = snapshot.profile?.startOpId === snapshot.mutable.lifecycleOpId;
      const projectedProfile = awaitingCurrentProfile
        ? matchingCurrentProfile ? snapshot.profile : null
        : snapshot.profile;
      if (projectedProfile) {
        projectedDefinition.codexAuthMode = codexExecutionAuthMode(projectedProfile.profile);
        profileProjectionUpdatedAt = projectedProfile.projectionUpdatedAt;
      }
    }
    const projectedMutable = profileProjectionUpdatedAt
      && parseTimestamp(profileProjectionUpdatedAt) > parseTimestamp(snapshot.mutable.updatedAt)
      ? normalizeMutableState({ ...snapshot.mutable, updatedAt: profileProjectionUpdatedAt })
      : snapshot.mutable;
    return buildEnvMetaFromLayers(projectedDefinition, projectedMutable, repo.repo.repoUrl);
  }

  async persistOwnedProjection(
    options: { broadcast?: boolean } = {},
  ): Promise<EnvMeta | null> {
    const shouldBroadcast = options.broadcast !== false;
    const projectionVersion = shouldBroadcast
      ? await this.readProjectionVersion()
      : null;
    const meta = await this.getOwnedEnvView();
    if (!meta) return null;
    await persistEnvSummary(this.env, meta);
    if (!shouldBroadcast) return meta;

    const hub = getDurableObjectStub<{
      broadcastEnvUpsert: (env: EnvMeta) => Promise<void> | void;
    }>(this.env, this.env.HUB, "hub");
    await hub.broadcastEnvUpsert(projectEnvSummary(meta));
    await this.confirmProjectionDelivery(projectionVersion!);
    return meta;
  }

  private async confirmProjectionDelivery(projectionVersion: number): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const dirtyVersion = await txn.get<number>(PROJECTION_DIRTY_KEY);
      if (dirtyVersion === projectionVersion) {
        await txn.delete(PROJECTION_DIRTY_KEY);
      }
    });
    await this.scheduleNextAlarm(
      await this.readStoredMutableState(),
      await this.readScheduledRun(),
    );
  }

  private async writeMutableState(state: EnvMutableState | null): Promise<EnvMutableState | null> {
    if (!state) {
      await this.ctx.storage.delete(MUTABLE_STATE_KEY);
      await this.ctx.storage.delete(PROJECTION_DIRTY_KEY);
      await this.scheduleNextAlarm(null, await this.readScheduledRun());
      return null;
    }

    const next = normalizeMutableState(state);
    await this.ctx.storage.transaction(async (txn) => {
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
    });
    await this.scheduleNextAlarm(next, await this.readScheduledRun());
    return next;
  }

  private async writeScheduledRunInTransaction(
    txn: DurableObjectTransaction,
    mutable: EnvMutableState,
    record: ScheduledRunRecord | null,
  ): Promise<EnvMutableState> {
    if (record) await txn.put(SCHEDULED_RUN_RECORD_KEY, record);
    else await txn.delete(SCHEDULED_RUN_RECORD_KEY);
    const projection = projectScheduledRun(record);
    const next = normalizeMutableState({
      ...mutable,
      ...(projection ? { scheduledRun: projection } : {}),
      updatedAt: nowIso(),
    });
    if (!projection) delete next.scheduledRun;
    await txn.put(MUTABLE_STATE_KEY, next);
    await this.markProjectionDirtyInTransaction(txn);
    return next;
  }

  private async queueScheduledRunLeaseReleaseInTransaction(
    txn: DurableObjectTransaction,
    slug: string,
    attemptId: string,
  ): Promise<void> {
    const pending = normalizePendingScheduledRunLeaseReleases(
      await txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
    );
    if (pending.some((entry) => entry.slug === slug && entry.attemptId === attemptId)) return;
    await txn.put(SCHEDULED_RUN_LEASE_RELEASE_KEY, [...pending, {
      slug,
      attemptId,
      nextAttemptAtMs: Date.now(),
    } satisfies PendingScheduledRunLeaseRelease]);
  }

  private async scheduleNextAlarm(
    state: EnvMutableState | null,
    scheduledRun: ScheduledRunRecord | null,
  ): Promise<void> {
    const scheduledAlarmAt = nextScheduledRunWakeAt(scheduledRun);
    const activePreparation = scheduledRun?.kind === "active" ? scheduledRun.preparation : null;
    const preparationDefersStopTimeout = Boolean(
      activePreparation
      && state
      && state.lifecycleOperation === "stop"
      && (state.lifecyclePhase === "saving" || state.lifecyclePhase === "stopping"),
    );
    const lifecycleAlarmAt = state && !preparationDefersStopTimeout
      ? this.getLifecycleAlarmAt(state)
      : null;
    const projectionDirtyVersion = await this.ctx.storage.get<number>(PROJECTION_DIRTY_KEY);
    const publishOperation = await this.ctx.storage.get<GitHubPublishOperationRecord>(
      GITHUB_PUBLISH_OPERATION_KEY,
    );
    const pendingLeaseReleases = normalizePendingScheduledRunLeaseReleases(
      await this.ctx.storage.get<StoredPendingScheduledRunLeaseReleases>(
        SCHEDULED_RUN_LEASE_RELEASE_KEY,
      ),
    );
    const stopRetry = await this.ctx.storage.get<StopRetryRecord>(STOP_RETRY_KEY);
    const stateAlarmAt = lifecycleAlarmAt == null
      ? scheduledAlarmAt
      : scheduledAlarmAt == null ? lifecycleAlarmAt : Math.min(lifecycleAlarmAt, scheduledAlarmAt);
    const projectionAlarmAt = projectionDirtyVersion == null
      ? null
      : Date.now() + SCHEDULED_RUN_EFFECT_RETRY_MS;
    const scheduledBaseAlarmAt = stateAlarmAt == null
      ? projectionAlarmAt
      : projectionAlarmAt == null ? stateAlarmAt : Math.min(stateAlarmAt, projectionAlarmAt);
    const publishAlarmAt = publishOperation?.cleanupPending
      ? Date.now()
      : publishOperation?.resultClaim?.expiresAtMs
        ?? (publishOperation
          ? parseTimestamp(publishOperation.startedAt) + GITHUB_PUBLISH_OPERATION_TIMEOUT_MS
          : null);
    const baseAlarmAt = publishAlarmAt == null
      ? scheduledBaseAlarmAt
      : scheduledBaseAlarmAt == null
        ? publishAlarmAt
        : Math.min(scheduledBaseAlarmAt, publishAlarmAt);
    const pendingLeaseReleaseAt = nextPendingScheduledRunLeaseReleaseAt(pendingLeaseReleases);
    const baseWithLeaseAlarmAt = pendingLeaseReleaseAt == null
      ? baseAlarmAt
      : baseAlarmAt == null
        ? pendingLeaseReleaseAt
        : Math.min(baseAlarmAt, pendingLeaseReleaseAt);
    const alarmAt = stopRetry == null
      ? baseWithLeaseAlarmAt
      : baseWithLeaseAlarmAt == null
        ? stopRetry.nextAttemptAtMs
        : Math.min(baseWithLeaseAlarmAt, stopRetry.nextAttemptAtMs);
    const now = Date.now();
    const existingAlarm = await this.ctx.storage.getAlarm();
    if (alarmAt === null) {
      // A concurrent newer transition may have installed a future alarm after
      // this caller computed no work. Keep future alarms; an already-due alarm
      // is the delivery being finalized and can be cleared.
      if (existingAlarm !== null && existingAlarm <= now) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    const nextAlarm = Math.max(now, alarmAt);
    // Never let a stale post-transaction caller postpone an earlier alarm
    // installed by a newer transition. Extra early wakes are harmless and
    // recompute from canonical state; a missed hard cap or lifecycle deadline
    // is not.
    if (existingAlarm === null || existingAlarm <= now || nextAlarm < existingAlarm) {
      await this.ctx.storage.setAlarm(nextAlarm);
    }
  }

  private getLifecycleAlarmAt(state: EnvMutableState | EnvLifecycleState): number | null {
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

    const alarmAt = this.getLifecycleAlarmAt(state);
    if (alarmAt === null || now < alarmAt) {
      return state;
    }

    const candidate = {
      opId: state.lifecycleOpId,
      phase: state.lifecyclePhase,
      updatedAt: state.lifecycleUpdatedAt ?? state.updatedAt,
    };
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun, storedDiagnostics] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        !current
        || current.lifecycleOpId !== candidate.opId
        || current.lifecyclePhase !== candidate.phase
        || (current.lifecycleUpdatedAt ?? current.updatedAt) !== candidate.updatedAt
      ) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      const currentAlarmAt = this.getLifecycleAlarmAt(current);
      if (currentAlarmAt === null || now < currentAlarmAt) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      const preparationDefersStopTimeout = Boolean(
        scheduledRun?.kind === "active"
        && scheduledRun.preparation
        && current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && (current.lifecyclePhase === "saving" || current.lifecyclePhase === "stopping"),
      );
      if (preparationDefersStopTimeout) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }

      const timeoutError = current.lifecyclePhase === "starting"
        ? ENV_LIFECYCLE_START_TIMEOUT_ERROR
        : current.lifecyclePhase === "saving"
          ? ENV_LIFECYCLE_SAVE_TIMEOUT_ERROR
          : ENV_LIFECYCLE_STOP_TIMEOUT_ERROR;
      const updatedAt = nowIso();
      let diagnostics = storedDiagnostics
        ? normalizeStartupDiagnosticsSnapshot(storedDiagnostics)
        : null;
      if (
        current.lifecyclePhase === "starting"
        && current.lifecycleOpId
        && diagnostics?.opId === current.lifecycleOpId
      ) {
        const fallbackStepId = current.bootStepId ?? diagnostics.currentStepId ?? "startup-failed";
        const failureEvent = buildStartupDiagnosticEvent({
          at: updatedAt,
          opId: current.lifecycleOpId,
          stepId: fallbackStepId,
          severity: "error",
          message: timeoutError,
        });
        diagnostics = this.buildUpdatedStartupDiagnostics(diagnostics, {
          event: failureEvent,
          currentStepId: fallbackStepId,
          currentStepMessage: timeoutError,
          failure: {
            message: timeoutError,
            exitCode: null,
            signal: null,
            lastStepId: fallbackStepId,
          },
          updatedAt,
        });
        await txn.put(STARTUP_DIAGNOSTICS_ACTIVE_KEY, diagnostics);
      }

      const timedOutBase = diagnostics
        && current.lifecyclePhase === "starting"
        && diagnostics.opId === current.lifecycleOpId
        ? normalizeMutableState({
            ...current,
            bootMessage: diagnostics.currentStepMessage,
            bootStepId: diagnostics.currentStepId,
          })
        : current;
      const timedOut = applyLifecycleState(
        timedOutBase,
        {
          ...buildFailureState(timedOutBase, timeoutError),
          lastErrorAt: updatedAt,
          updatedAt,
        },
      );

      let nextScheduledRun = scheduledRun ?? null;
      if (
        nextScheduledRun?.kind === "active"
        && (
          nextScheduledRun.startOpId === current.lifecycleOpId
          || nextScheduledRun.stopOpId === current.lifecycleOpId
        )
      ) {
        const runnerStoppedConfirmed = current.lifecycleInfraState === "stopped"
          && current.lifecycleLastRunnerState === "stopped";
        const runnerCleanupRequired = nextScheduledRun.runnerDispatchStarted
          && !runnerStoppedConfirmed;
        nextScheduledRun = {
          ...nextScheduledRun,
          requestedOutcome: nextScheduledRun.requestedOutcome ?? "interrupted",
          failure: timeoutError,
          runnerStoppedConfirmed,
          runnerCleanupRequired,
          runnerUncertaintyError: runnerCleanupRequired ? timeoutError : null,
          updatedAt,
        };
      }
      const nextMutable = await this.writeScheduledRunInTransaction(
        txn,
        timedOut,
        nextScheduledRun,
      );
      return { mutable: nextMutable, scheduledRun: nextScheduledRun, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    }
    return result.mutable;
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

  private buildStartupDiagnosticsFailure(
    active: StartupDiagnosticsSnapshot | null,
    opId: string,
    options: {
      at?: string | null;
      stepId?: StartupDiagnosticStepId | null;
      message: string;
      detail?: string | null;
      exitCode?: number | null;
      signal?: string | null;
      logTails?: Partial<StartupDiagnosticLogTails> | null;
    },
  ): StartupDiagnosticsSnapshot | null {
    if (!active || active.opId !== opId) {
      return null;
    }

    const fallbackStepId = options.stepId ?? active.currentStepId ?? "startup-failed";
    const failureMessage = normalizeDiagnosticMessage(options.message);
    if (!failureMessage) {
      return active;
    }

    const failureEvent = buildStartupDiagnosticEvent({
      at: options.at,
      opId,
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
    return next;
  }

  private getOrCreateMutableState(current: EnvMutableState | null): EnvMutableState {
    return current ?? createEmptyMutableState({
      status: "stopped",
      lifecyclePhase: "stopped",
      lifecycleDesiredState: "stopped",
    });
  }

  private isExactActiveStart(current: EnvMutableState, opId: string | null): boolean {
    return Boolean(
      opId
      && current.lifecycleOpId === opId
      && current.lifecycleOperation === "start"
      && current.lifecycleDesiredState === "running"
      && (current.lifecyclePhase === "starting" || current.lifecyclePhase === "running"),
    );
  }

  private isImplementorCodexRuntimeAuthAllowed(
    current: EnvMutableState,
    startOpId: string | null,
  ): boolean {
    if (this.isExactActiveStart(current, startOpId)) return true;
    // Stop must first quiesce the exact running harness before it can persist
    // the workspace. Keep that harness's already-fenced subscription subject
    // usable only through this bounded save/termination window; otherwise a
    // token refresh can terminate the harness before stop-control reaches it.
    return Boolean(
      startOpId
      && current.lifecycleOperation === "stop"
      && current.lifecycleDesiredState === "stopped"
      && current.lifecycleLastRunnerState === "running"
      && (current.lifecyclePhase === "saving" || current.lifecyclePhase === "stopping"),
    );
  }

  private async mutateExistingMutableState(
    options: {
      opId?: string | null;
      startFenceRequested: boolean;
    },
    mutation: (current: EnvMutableState) => EnvMutableState,
  ): Promise<EnvMutableState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(options.opId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<EnvMutableState>(MUTABLE_STATE_KEY);
      if (!stored) return { state: null, changed: false };
      const current = normalizeMutableState(stored);
      if (
        options.startFenceRequested
        && !this.isExactActiveStart(current, resolvedOpId)
      ) {
        return { state: current, changed: false };
      }
      const next = normalizeMutableState(mutation(current));
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { state: next, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.state, await this.readScheduledRun());
    }
    return result.state;
  }

  private buildStartingMutableState(
    current: EnvMutableState,
    harnessSettings: HarnessSettings,
    opId = buildStartOpId(),
    authClaim: {
      claudeAuthMode?: ResolvedClaudeAuthMode | null;
      codexAuthPreference?: CodexAuthPreference | null;
    } = {},
  ): EnvMutableState {
    const starting = normalizeMutableState({
      ...applyLifecycleState({ ...current, harnessSettings }, {
        phase: "starting",
        activeOpId: opId,
        activeOperation: "start",
        desiredState: "running",
        lastRunnerState: current.lifecycleLastRunnerState,
        lastWorkspaceSyncedAckOpId: null,
        infraState: "unknown",
        runtimeReady: false,
        lastError: null,
        lastErrorAt: null,
        updatedAt: nowIso(),
      }),
      startClaudeAuthMode: authClaim.claudeAuthMode ?? null,
      startCodexAuthPreference: authClaim.codexAuthPreference ?? null,
      bootMessage: null,
      bootStepId: null,
    });
    return normalizeMutableState({
      ...starting,
      implementorAttentionState: {
        ...current.implementorAttentionState,
        runtimeStartOpId: starting.lifecycleOpId,
        lastCompletionSequence: 0,
      },
    });
  }

  private async resetStartupDiagnosticsForNewClaimInTransaction(
    txn: DurableObjectTransaction,
  ): Promise<void> {
    const stored = await txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
    if (stored) {
      const active = normalizeStartupDiagnosticsSnapshot(stored);
      if (active.failure) await txn.put(STARTUP_DIAGNOSTICS_LAST_FAILED_KEY, active);
    }
    await txn.delete(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
  }

  async initializeAndBeginStart(
    definition: EnvDefinition,
    initialMutableState: EnvMutableState,
    harnessSettings: HarnessSettings,
    authClaim: {
      claudeAuthMode?: ResolvedClaudeAuthMode | null;
      codexAuthPreference?: CodexAuthPreference | null;
    } = {},
  ): Promise<EnvStartClaimResult> {
    const initialization = await this.initializeClaimedEnvironment({
      definition,
      initialMutableState,
      buildMutableState: (initial) => this.buildStartingMutableState(initial, harnessSettings, undefined, authClaim),
      persistDefinition: true,
      retainClaim: false,
      incarnationId: definition.incarnationId,
    });
    if (!initialization.created) {
      return {
        lifecycle: buildLifecycleState(initialization.mutableState),
        dispatchGranted: false,
        harnessSettings: initialization.mutableState?.harnessSettings ?? null,
      };
    }
    return {
      lifecycle: buildLifecycleState(initialization.mutableState),
      dispatchGranted: true,
      harnessSettings: initialization.mutableState.harnessSettings,
      ...(initialization.mutableState.startClaudeAuthMode
        ? { claudeAuthMode: initialization.mutableState.startClaudeAuthMode }
        : {}),
      ...(initialization.mutableState.startCodexAuthPreference
        ? { codexAuthPreference: initialization.mutableState.startCodexAuthPreference }
        : {}),
    };
  }

  async initializeStoppedEnvironment(
    definition: EnvDefinition,
    initialMutableState: EnvMutableState,
    options?: {
      schedule: { runAtMs: number; timeZone: string; localDevOrigin: string | null };
      plan: Omit<ImmutableEnvironmentPlan, "incarnationId" | "createdAt">;
      incarnationId: string;
    },
  ): Promise<EnvStoppedInitializationResult> {
    return this.initializeClaimedEnvironment({
      definition,
      initialMutableState,
      buildMutableState: (initial) => initial,
      persistDefinition: false,
      retainClaim: true,
      scheduledRun: options ? {
        ...options.schedule,
        plan: {
          ...options.plan,
          incarnationId: options.incarnationId,
          createdAt: nowIso(),
        },
      } : undefined,
      incarnationId: options?.incarnationId,
    });
  }

  async publishStoppedInitialization(claimId: string, definition: EnvDefinition): Promise<boolean> {
    const claim = await this.ctx.storage.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY);
    if (claim?.incarnationId !== claimId) return false;
    if (definition.incarnationId && definition.incarnationId !== claimId) return false;
    const publication = await this.getPublication();
    if (
      !publication
      || publication.state !== "pending"
      || publication.incarnationId !== claimId
    ) return false;
    const existing = await readEnvDefinition(this.env, definition.slug);
    if (existing && (!definition.incarnationId || existing.incarnationId !== definition.incarnationId)) {
      const existingPublication = await this.getPublication();
      if (!existing.incarnationId || existingPublication?.state === "visible") return false;
    }
    await persistEnvDefinition(this.env, definition);
    return true;
  }

  async commitStoppedInitialization(claimId: string): Promise<boolean> {
    const committed = await this.ctx.storage.transaction(async (txn) => {
      const [claim, publication, scheduledRun, projectionDirtyVersion] = await Promise.all([
        txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<number>(PROJECTION_DIRTY_KEY),
      ]);
      const matchingPublication = publication?.incarnationId === claimId;
      if (matchingPublication && publication.state === "visible") {
        const wakeAt = nextScheduledRunWakeAt(scheduledRun ?? null);
        const projectionAt = projectionDirtyVersion == null ? null : Date.now() + SCHEDULED_RUN_EFFECT_RETRY_MS;
        const alarmAt = wakeAt == null
          ? projectionAt
          : projectionAt == null ? wakeAt : Math.min(wakeAt, projectionAt);
        if (alarmAt != null) await txn.setAlarm(Math.max(Date.now(), alarmAt));
        return true;
      }
      if (
        claim?.incarnationId !== claimId
        || !matchingPublication
        || publication.state !== "pending"
      ) return false;
      await txn.put(ENV_PUBLICATION_KEY, {
        ...publication,
        state: "visible",
        updatedAt: nowIso(),
      } satisfies EnvPublicationRecord);
      await txn.delete(INITIAL_CREATE_CLAIM_KEY);
      const wakeAt = nextScheduledRunWakeAt(scheduledRun ?? null);
      const projectionAt = projectionDirtyVersion == null ? null : Date.now() + SCHEDULED_RUN_EFFECT_RETRY_MS;
      const alarmAt = wakeAt == null
        ? projectionAt
        : projectionAt == null ? wakeAt : Math.min(wakeAt, projectionAt);
      if (alarmAt != null) await txn.setAlarm(Math.max(Date.now(), alarmAt));
      return true;
    });
    if (committed) {
      await this.scheduleNextAlarm(
        await this.readStoredMutableState(),
        await this.readScheduledRun(),
      );
    }
    return committed;
  }

  async rollbackStoppedInitialization(claimId: string): Promise<boolean> {
    const rollback = await this.ctx.storage.transaction(async (txn) => {
      const [claim, slug, publication] = await Promise.all([
        txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY),
        txn.get<string>(ENV_SLUG_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
      ]);
      if (claim?.incarnationId !== claimId) return null;
      if (publication?.incarnationId === claimId) {
        await txn.put(ENV_PUBLICATION_KEY, {
          ...publication,
          state: "deleted",
          updatedAt: nowIso(),
        } satisfies EnvPublicationRecord);
      }
      return { slug: slug ?? null };
    });
    if (!rollback) return false;

    const failures: unknown[] = [];
    try {
      const kvCleanup = rollback.slug
        ? await Promise.allSettled([
            this.env.ENVS_KV.delete(rollback.slug),
            this.env.ENVS_KV.delete(getEnvDefinitionKey(rollback.slug)),
          ])
        : [];
      for (const result of kvCleanup) {
        if (result.status === "rejected") failures.push(result.reason);
      }
      if (!rollback.slug) {
        failures.push(new Error("Initial environment rollback is missing its lifecycle-owned slug"));
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (!(await this.clearClaimedInitialState(claimId))) {
          failures.push(new Error("Initial environment rollback lost its lifecycle creation claim"));
        }
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "Initial environment KV rollback was incomplete",
      );
    }
    return true;
  }

  async initializeMutableStateFromMeta(meta: EnvMeta): Promise<EnvMutableState> {
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

  async peekMutableState(): Promise<EnvMutableState | null> {
    return await this.readStoredMutableState();
  }

  async getState(): Promise<EnvLifecycleState | null> {
    const current = await this.getMutableState();
    return buildLifecycleState(current);
  }

  async getEnvironmentRuntimeSubject(): Promise<{
    envSlug: string;
    incarnationId: string;
    startOperationId: string;
    lifecycle: EnvLifecycleState;
    failedStopFinalizationAuthorized: boolean;
  } | null> {
    const snapshot = await this.ctx.storage.transaction(async (txn) => {
      const [mutable, slug, publication, stopRetry] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<StopRetryRecord>(STOP_RETRY_KEY),
      ]);
      if (!mutable || !slug || !publication || publication.state !== "visible") return null;
      const normalized = normalizeMutableState(mutable);
      const startOperationId = normalized.implementorAttentionState.runtimeStartOpId?.trim() ?? "";
      if (!startOperationId) return null;
      const lifecycle = buildLifecycleState(normalized)!;
      return {
        envSlug: slug,
        incarnationId: publication.incarnationId,
        startOperationId,
        lifecycle,
        failedStopFinalizationAuthorized: Boolean(
          lifecycle.phase === "failed"
          && lifecycle.activeOperation === "stop"
          && lifecycle.desiredState === "stopped"
          && lifecycle.activeOpId
          && stopRetry?.opId === lifecycle.activeOpId
          && lifecycle.infraState !== "stopped"
        ),
      };
    });
    return snapshot;
  }

  async claimCodexExecutionProfile(
    startOpId: string,
    profile: CodexExecutionProfile,
  ): Promise<CodexExecutionProfile | null> {
    const resolvedOpId = this.resolveLifecycleOpId(startOpId);
    if (!resolvedOpId) return null;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, existing] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StoredCodexExecutionProfile>(CODEX_EXECUTION_PROFILE_KEY),
      ]);
      if (!storedMutable || !this.isExactActiveStart(normalizeMutableState(storedMutable), resolvedOpId)) {
        return { profile: null, mutable: null, claimed: false };
      }
      const current = normalizeMutableState(storedMutable);
      if (existing?.startOpId === resolvedOpId) {
        return { profile: existing.profile, mutable: current, claimed: false };
      }
      const currentUpdatedAtMs = parseTimestamp(current.updatedAt);
      const updatedAt = new Date(Math.max(Date.now(), currentUpdatedAtMs + 1)).toISOString();
      const next = normalizeMutableState({ ...current, updatedAt });
      await txn.put(CODEX_EXECUTION_PROFILE_KEY, {
        startOpId: resolvedOpId,
        profile,
        accountId: null,
        projectionUpdatedAt: updatedAt,
      } satisfies StoredCodexExecutionProfile);
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { profile, mutable: next, claimed: true };
    });
    if (result.profile && result.mutable) {
      await this.scheduleNextAlarm(result.mutable, await this.readScheduledRun());
    }
    return result.profile;
  }

  async acceptImplementorCodexRuntimeAuth(
    startOpId: string,
    accountId: string,
  ): Promise<"accepted" | "inactive" | "account_changed"> {
    const resolvedOpId = this.resolveLifecycleOpId(startOpId);
    const normalizedAccountId = accountId.trim();
    if (!resolvedOpId || !normalizedAccountId) return "inactive";
    return await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedProfile] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StoredCodexExecutionProfile>(CODEX_EXECUTION_PROFILE_KEY),
      ]);
      if (
        !storedMutable
        || !storedProfile
        || storedProfile.startOpId !== resolvedOpId
        || storedProfile.profile.kind !== "subscription-app-server"
        || storedProfile.profile.surface !== "implementor"
        || !this.isImplementorCodexRuntimeAuthAllowed(
          normalizeMutableState(storedMutable),
          resolvedOpId,
        )
      ) {
        return "inactive";
      }
      if (storedProfile.accountId && storedProfile.accountId !== normalizedAccountId) {
        return "account_changed";
      }
      if (!storedProfile.accountId) {
        await txn.put(CODEX_EXECUTION_PROFILE_KEY, {
          ...storedProfile,
          accountId: normalizedAccountId,
        } satisfies StoredCodexExecutionProfile);
      }
      return "accepted";
    });
  }

  async getCodexExecutionProfile(startOpId: string): Promise<CodexExecutionProfile | null> {
    const stored = await this.ctx.storage.get<StoredCodexExecutionProfile>(CODEX_EXECUTION_PROFILE_KEY);
    return stored?.startOpId === startOpId ? stored.profile : null;
  }

  async getActiveImplementorCodexRuntimeSubject(): Promise<ActiveImplementorCodexRuntimeSubject | null> {
    const snapshot = await this.ctx.storage.transaction(async (txn) => {
      const [mutable, slug, publication, storedProfile] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<StoredCodexExecutionProfile>(CODEX_EXECUTION_PROFILE_KEY),
      ]);
      if (!mutable || !slug || !publication || publication.state !== "visible" || !storedProfile) return null;
      const normalized = normalizeMutableState(mutable);
      if (!this.isImplementorCodexRuntimeAuthAllowed(normalized, storedProfile.startOpId)) return null;
      return {
        envSlug: slug,
        incarnationId: publication.incarnationId,
        startOpId: storedProfile.startOpId,
        profile: storedProfile.profile,
      };
    });
    return snapshot;
  }

  private async allocateRunnerCommandInTransaction(
    txn: DurableObjectTransaction,
    operationId: string,
    desiredState: RunnerCommandClaim["desiredState"],
  ): Promise<RunnerCommandClaim> {
    const existing = await txn.get<RunnerCommandClaim>(RUNNER_COMMAND_CLAIM_KEY);
    if (existing?.operationId === operationId) {
      if (existing.desiredState !== desiredState) {
        throw new Error("A runner command operation cannot change its desired state.");
      }
      return existing;
    }
    const highWater = (await txn.get<number>(RUNNER_COMMAND_GENERATION_KEY)) ?? 0;
    if (!Number.isSafeInteger(highWater) || highWater < 0 || highWater >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Runner command generation high-water mark is invalid or exhausted.");
    }
    const claim: RunnerCommandClaim = {
      commandGeneration: highWater + 1,
      operationId,
      desiredState,
    };
    await txn.put(RUNNER_COMMAND_GENERATION_KEY, claim.commandGeneration);
    await txn.put(RUNNER_COMMAND_CLAIM_KEY, claim);
    return claim;
  }

  async claimRunnerCommand(
    operationId: string,
    desiredState: RunnerCommandClaim["desiredState"],
  ): Promise<RunnerCommandClaim> {
    const normalizedOperationId = operationId.trim();
    if (!normalizedOperationId) throw new TypeError("Runner command operationId is required.");
    return this.ctx.storage.transaction(async (txn) => {
      const [existing, storedMutable] = await Promise.all([
        txn.get<RunnerCommandClaim>(RUNNER_COMMAND_CLAIM_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      if (existing?.operationId === normalizedOperationId && existing.desiredState !== desiredState) {
        throw new Error("A runner command operation cannot change its desired state.");
      }
      if (
        !existing
        || existing.operationId !== normalizedOperationId
        || existing.desiredState !== desiredState
      ) {
        throw new Error(existing
          ? "The runner command lifecycle operation has been superseded."
          : "The runner command was not allocated by the active lifecycle transition.");
      }
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const lifecycleOwnsCommand = desiredState === "running"
        ? Boolean(
            current
            && current.lifecycleOpId === normalizedOperationId
            && current.lifecycleOperation === "start"
            && current.lifecycleDesiredState === "running"
            && current.lifecyclePhase === "starting",
          )
        : desiredState === "stopped"
          ? Boolean(
              current
              && current.lifecycleOpId === normalizedOperationId
              && current.lifecycleOperation === "stop"
              && current.lifecycleDesiredState === "stopped"
              && (current.lifecyclePhase === "saving"
                || current.lifecyclePhase === "stopping"
                || current.lifecyclePhase === "failed"
                || current.lifecyclePhase === "stopped"),
            )
          : Boolean(current?.status === "deleting");
      if (!lifecycleOwnsCommand) {
        throw new Error("The runner command lifecycle operation has been superseded.");
      }
      return existing;
    });
  }

  async getRunnerCommandClaim(): Promise<RunnerCommandClaim | null> {
    const claim = await this.ctx.storage.get<RunnerCommandClaim>(RUNNER_COMMAND_CLAIM_KEY);
    if (
      !claim
      || !Number.isSafeInteger(claim.commandGeneration)
      || claim.commandGeneration <= 0
      || !claim.operationId?.trim()
      || (
        claim.desiredState !== "running"
        && claim.desiredState !== "stopped"
        && claim.desiredState !== "absent"
      )
    ) return null;
    return { ...claim, operationId: claim.operationId.trim() };
  }

  /**
   * Advances a command that the machine rejected before mutation because its
   * own durable fence is ahead of the Hub. The transaction is deliberately
   * bound to the exact lifecycle operation so a racing Stop/Delete cannot be
   * rebased into the stale caller.
   */
  async rebaseRejectedRunnerCommand(
    input: RebaseRejectedRunnerCommandInput,
  ): Promise<RunnerCommandClaim> {
    const rejected = input?.rejectedCommand;
    const operationId = rejected?.operationId?.trim();
    const runnerHighWater = input?.currentCommandGeneration;
    if (
      !rejected
      || !Number.isSafeInteger(rejected.commandGeneration)
      || rejected.commandGeneration <= 0
      || !operationId
      || (rejected.desiredState !== "running"
        && rejected.desiredState !== "stopped"
        && rejected.desiredState !== "absent")
      || !Number.isSafeInteger(runnerHighWater)
      || runnerHighWater <= rejected.commandGeneration
    ) {
      throw new TypeError("Rejected runner command reconciliation metadata is invalid.");
    }

    return this.ctx.storage.transaction(async (txn) => {
      const [existing, storedMutable, storedHighWater, scheduledRun] = await Promise.all([
        txn.get<RunnerCommandClaim>(RUNNER_COMMAND_CLAIM_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<number>(RUNNER_COMMAND_GENERATION_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const sameOperation = Boolean(
        existing
        && existing.operationId === operationId
        && existing.desiredState === rejected.desiredState,
      );
      const lifecycleOwnsCommand = rejected.desiredState === "running"
        ? Boolean(
            current
            && current.lifecycleOpId === operationId
            && current.lifecycleOperation === "start"
            && current.lifecycleDesiredState === "running"
            && current.lifecyclePhase === "starting",
          )
        : rejected.desiredState === "stopped"
          ? Boolean(
              current
              && current.lifecycleOpId === operationId
              && current.lifecycleOperation === "stop"
              && current.lifecycleDesiredState === "stopped"
              && (current.lifecyclePhase === "saving"
                || current.lifecyclePhase === "stopping"
                || current.lifecyclePhase === "failed"
                || current.lifecyclePhase === "stopped"),
            )
          : Boolean(current?.status === "deleting");
      if (!sameOperation || !lifecycleOwnsCommand || !existing) {
        throw new Error("The rejected runner command lifecycle operation has been superseded.");
      }

      const highWater = storedHighWater ?? 0;
      if (!Number.isSafeInteger(highWater) || highWater < 0) {
        throw new RangeError("Runner command generation high-water mark is invalid or exhausted.");
      }

      // A retry after the transaction committed receives the same claim.
      if (existing.commandGeneration !== rejected.commandGeneration) {
        if (
          Number.isSafeInteger(existing.commandGeneration)
          && existing.commandGeneration > runnerHighWater
          && existing.commandGeneration > rejected.commandGeneration
          && highWater === existing.commandGeneration
        ) {
          const scheduledGenerationMatches = scheduledRun?.kind !== "active"
            || (rejected.desiredState === "running" && scheduledRun.startOpId === operationId
              ? scheduledRun.runnerGeneration === existing.commandGeneration
              : rejected.desiredState === "stopped" && scheduledRun.stopOpId === operationId
                ? scheduledRun.stopRunnerGeneration === existing.commandGeneration
                : true);
          if (scheduledGenerationMatches) return existing;
        }
        throw new Error("The rejected runner command lifecycle operation has been superseded.");
      }

      const baseGeneration = Math.max(highWater, runnerHighWater);
      if (baseGeneration >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Runner command generation high-water mark is exhausted.");
      }
      const rebased: RunnerCommandClaim = {
        commandGeneration: baseGeneration + 1,
        operationId,
        desiredState: rejected.desiredState,
      };

      if (scheduledRun?.kind === "active") {
        if (rejected.desiredState === "running" && scheduledRun.startOpId === operationId) {
          if (scheduledRun.runnerGeneration !== rejected.commandGeneration) {
            throw new Error("The Scheduled Run runner command generation does not match the rejected command.");
          }
          await txn.put(SCHEDULED_RUN_RECORD_KEY, {
            ...scheduledRun,
            runnerGeneration: rebased.commandGeneration,
            updatedAt: nowIso(),
          } satisfies ActiveScheduledRunReceipt);
        } else if (rejected.desiredState === "stopped" && scheduledRun.stopOpId === operationId) {
          if (scheduledRun.stopRunnerGeneration !== rejected.commandGeneration) {
            throw new Error("The Scheduled Run Stop command generation does not match the rejected command.");
          }
          await txn.put(SCHEDULED_RUN_RECORD_KEY, {
            ...scheduledRun,
            stopRunnerGeneration: rebased.commandGeneration,
            updatedAt: nowIso(),
          } satisfies ActiveScheduledRunReceipt);
        }
      }
      await txn.put(RUNNER_COMMAND_GENERATION_KEY, rebased.commandGeneration);
      await txn.put(RUNNER_COMMAND_CLAIM_KEY, rebased);
      return rebased;
    });
  }

  async peekVisibleMutableState(incarnationId: string): Promise<EnvMutableState | null> {
    const expected = incarnationId.trim();
    if (!expected) return null;
    return this.ctx.storage.transaction(async (txn) => {
      const [publication, storedMutable] = await Promise.all([
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      if (
        publication?.incarnationId !== expected
        || publication.state !== "visible"
        || !storedMutable
      ) return null;
      return normalizeMutableState(storedMutable);
    });
  }

  private settleActiveScheduledRun(
    record: ActiveScheduledRunReceipt,
    at = nowIso(),
  ): ScheduledRunRecord {
    if (
      record.preparation
      || record.credentialsMayExist
      || !record.capacityReleased
      || !record.runnerStoppedConfirmed
      || !record.persistenceConfirmed
      || !record.requestedOutcome
      || record.runnerCleanupRequired
    ) return record;
    return finishedScheduledRun(record, {
      outcome: record.failure ? "failed" : record.requestedOutcome,
      error: record.failure,
      at,
    });
  }

  async cancelScheduledRun(): Promise<{ cancelled: boolean; finalizing?: boolean; error?: string }> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable, slug] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!record || record.kind === "finished") {
        return { cancelled: true as const, record: record ?? null, mutable };
      }
      if (record.kind === "active") {
        return {
          cancelled: false as const,
          error: "The Scheduled Run has already started.",
          record,
          mutable,
        };
      }
      if (!mutable) {
        return { cancelled: false as const, error: "Environment state not found.", record, mutable };
      }
      const possibleLease = Boolean(record.attemptId && (record.capacityAcquired || record.acquireUncertain));
      if (possibleLease) {
        if (!slug) throw new Error("Scheduled Run capacity release is missing its environment slug.");
        await this.queueScheduledRunLeaseReleaseInTransaction(txn, slug, record.attemptId!);
        const next: EnvironmentPlanSchedule = {
          ...record,
          cancelRequested: true,
          retryAtMs: null,
          updatedAt: nowIso(),
        };
        const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
        await txn.setAlarm(Date.now());
        return { cancelled: true as const, finalizing: true as const, record: next, mutable: nextMutable };
      }
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, null);
      return { cancelled: true as const, record: null, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.cancelled
      ? { cancelled: true, ...(result.finalizing ? { finalizing: true } : {}) }
      : { cancelled: false, error: result.error };
  }

  async preparePublicStart(): Promise<ScheduledRunPublicStartGuard> {
    const current = await this.readScheduledRun();
    if (!current || (current.kind === "finished" && !current.cleanupRequired)) {
      return { action: "ordinary" };
    }
    return {
      action: "blocked",
      error: current.kind === "schedule"
        ? "Cancel the Scheduled Run before starting this environment."
        : current.kind === "active" && current.runnerCleanupRequired
          ? EXISTING_EXECUTION_UNAVAILABLE_MESSAGE
          : "The Scheduled Run is active or finalizing. Stop it before starting this environment.",
    };
  }

  async beginScheduledRunAttempt(
    expectedIncarnationId?: string,
  ): Promise<ScheduledRunAttemptSnapshot> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedRecord, plan, publication, storedMutable] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<ImmutableEnvironmentPlan>(IMMUTABLE_PLAN_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      if (!storedRecord || storedRecord.kind !== "schedule" || !plan || !storedMutable) {
        throw new Error("No Scheduled Run is ready to start.");
      }
      if (
        (expectedIncarnationId && storedRecord.incarnationId !== expectedIncarnationId)
        || plan.incarnationId !== storedRecord.incarnationId
        || publication?.incarnationId !== storedRecord.incarnationId
        || publication.state !== "visible"
      ) throw new Error("The Scheduled Run belongs to a replaced environment incarnation.");
      if (storedRecord.cancelRequested || storedRecord.terminalRequested) {
        throw new Error("The Scheduled Run is finalizing and cannot start.");
      }
      if (storedRecord.acquireUncertain || storedRecord.capacityAcquired) {
        return { attemptId: storedRecord.attemptId!, schedule: storedRecord, plan, mutable: normalizeMutableState(storedMutable) };
      }
      const now = Date.now();
      if (now < (storedRecord.retryAtMs ?? storedRecord.runAtMs)) {
        throw new Error("The Scheduled Run is not due yet.");
      }
      if (now >= storedRecord.deadlineAtMs) {
        throw new Error("The Scheduled Run deadline passed before a runner could start.");
      }
      let attemptId = storedRecord.attemptId;
      if (!attemptId) {
        const stored = await txn.get<number>(SCHEDULED_RUN_ATTEMPT_SEQUENCE_KEY);
        const sequence = typeof stored === "number" && Number.isSafeInteger(stored) && stored >= 0 ? stored + 1 : 1;
        await txn.put(SCHEDULED_RUN_ATTEMPT_SEQUENCE_KEY, sequence);
        attemptId = `attempt-${sequence}-${crypto.randomUUID()}`;
      }
      const next: EnvironmentPlanSchedule = {
        ...storedRecord,
        attemptId,
        retryAtMs: null,
        lastError: null,
        updatedAt: nowIso(),
      };
      const mutable = await this.writeScheduledRunInTransaction(
        txn,
        normalizeMutableState(storedMutable),
        next,
      );
      return { attemptId, schedule: next, plan, mutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.schedule);
    return { attemptId: result.attemptId, schedule: result.schedule, plan: result.plan };
  }

  async recordScheduledPreStartFailure(options: {
    attemptId: string;
    error: string;
    retryable: boolean;
    capacityDenied?: boolean;
  }): Promise<ScheduledRunRecord | null> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedRecord, storedMutable, slug] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!storedRecord || storedRecord.kind !== "schedule" || storedRecord.attemptId !== options.attemptId || !mutable) {
        return { record: storedRecord ?? null, mutable };
      }
      const delay = options.capacityDenied ? SCHEDULED_RUN_CAPACITY_RETRY_MS : SCHEDULED_RUN_RETRY_MS;
      const retryAtMs = Date.now() + delay;
      const retryable = options.retryable
        && !storedRecord.cancelRequested
        && retryAtMs < storedRecord.deadlineAtMs;
      const possibleLease = storedRecord.capacityAcquired || storedRecord.acquireUncertain;
      let next: ScheduledRunRecord;
      if (possibleLease) {
        if (!slug) throw new Error("Scheduled Run capacity release is missing its environment slug.");
        await this.queueScheduledRunLeaseReleaseInTransaction(txn, slug, options.attemptId);
        next = {
          ...storedRecord,
          terminalRequested: !retryable,
          retryAtMs: retryable ? retryAtMs : null,
          lastError: options.error,
          updatedAt: nowIso(),
        };
        await txn.setAlarm(Date.now());
      } else if (retryable) {
        next = {
          ...storedRecord,
          retryAtMs,
          lastError: options.error,
          updatedAt: nowIso(),
        };
      } else {
        next = finishedScheduledRun(storedRecord, { outcome: "failed", error: options.error });
      }
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.record;
  }

  async markScheduledCapacityAcquireUncertain(attemptId: string, error: string): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable, slug] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!record || record.kind !== "schedule" || record.attemptId !== attemptId || !mutable || !slug) {
        return { changed: false, record: record ?? null, mutable };
      }
      const next: EnvironmentPlanSchedule = {
        ...record,
        acquireUncertain: true,
        lastError: error,
        updatedAt: nowIso(),
      };
      await this.queueScheduledRunLeaseReleaseInTransaction(txn, slug, attemptId);
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      await txn.setAlarm(Date.now());
      return { changed: true, record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.changed;
  }

  async recordScheduledCapacityAcquired(attemptId: string): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable, storedPending] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!record || record.kind !== "schedule" || record.attemptId !== attemptId || !mutable) {
        return { acquired: false, record: record ?? null, mutable };
      }
      if (record.cancelRequested || record.terminalRequested) {
        return { acquired: false, record, mutable };
      }
      const next: EnvironmentPlanSchedule = {
        ...record,
        capacityAcquired: true,
        acquireUncertain: false,
        updatedAt: nowIso(),
      };
      const retained = normalizePendingScheduledRunLeaseReleases(storedPending)
        .filter((entry) => entry.attemptId !== attemptId);
      if (retained.length > 0) await txn.put(SCHEDULED_RUN_LEASE_RELEASE_KEY, retained);
      else await txn.delete(SCHEDULED_RUN_LEASE_RELEASE_KEY);
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { acquired: true, record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.acquired;
  }

  async claimScheduledRunStart(options: {
    attemptId: string;
    harnessSettings: HarnessSettings;
    hostMachineId: string | null;
    authClaim?: {
      claudeAuthMode?: ResolvedClaudeAuthMode | null;
      codexAuthPreference?: CodexAuthPreference | null;
    };
  }): Promise<EnvStartClaimResult> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable, slug, pendingReleases] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
        txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!record || !mutable || !slug) {
        return { lifecycle: buildLifecycleState(mutable), dispatchGranted: false, harnessSettings: mutable?.harnessSettings ?? null, record: record ?? null };
      }
      if (record.kind === "active" && record.attemptId === options.attemptId) {
        const granted = this.isExactActiveStart(mutable, record.startOpId)
          && mutable.lifecyclePhase === "starting";
        return {
          lifecycle: buildLifecycleState(mutable),
          dispatchGranted: granted,
          harnessSettings: mutable.harnessSettings,
          claudeAuthMode: mutable.startClaudeAuthMode,
          codexAuthPreference: mutable.startCodexAuthPreference,
          record,
        };
      }
      const startable = mutable.lifecyclePhase === "stopped"
        || mutable.lifecyclePhase === "failed"
        || mutable.status === "stopped"
        || mutable.status === "failed"
        || mutable.status === "unknown";
      if (
        record.kind !== "schedule"
        || record.attemptId !== options.attemptId
        || !record.capacityAcquired
        || record.acquireUncertain
        || record.cancelRequested
        || record.terminalRequested
        || Date.now() >= record.deadlineAtMs
        || !startable
      ) {
        return { lifecycle: buildLifecycleState(mutable), dispatchGranted: false, harnessSettings: mutable.harnessSettings, record };
      }
      const opId = buildStartOpId();
      const nextMutable = this.buildStartingMutableState(
        mutable,
        options.harnessSettings,
        opId,
        options.authClaim,
      );
      const runnerCommand = await this.allocateRunnerCommandInTransaction(txn, opId, "running");
      const at = nowIso();
      const active: ActiveScheduledRunReceipt = {
        kind: "active",
        incarnationId: record.incarnationId,
        slug,
        runAtMs: record.runAtMs,
        deadlineAtMs: record.deadlineAtMs,
        timeZone: record.timeZone,
        localDevOrigin: record.localDevOrigin,
        createdAt: record.createdAt,
        updatedAt: at,
        attemptId: options.attemptId,
        startOpId: opId,
        startCause: "scheduled",
        runnerGeneration: runnerCommand.commandGeneration,
        harnessSettings: options.harnessSettings,
        hostMachineId: options.hostMachineId,
        preparation: { claimedAtMs: Date.now(), heartbeatAtMs: Date.now(), effectMayBeLive: false },
        credentialsMayExist: false,
        credentialIds: {},
        runnerDispatchStarted: false,
        runnerStoppedConfirmed: false,
        persistenceConfirmed: false,
        capacityReleased: false,
        requestedOutcome: null,
        stopOpId: null,
        stopRunnerGeneration: null,
        runnerCleanupRequired: false,
        runnerUncertaintyError: null,
        failure: null,
        startedAt: at,
      };
      const retainedReleases = normalizePendingScheduledRunLeaseReleases(pendingReleases)
        .filter((pending) => pending.slug !== slug || pending.attemptId !== options.attemptId);
      if (retainedReleases.length > 0) await txn.put(SCHEDULED_RUN_LEASE_RELEASE_KEY, retainedReleases);
      else await txn.delete(SCHEDULED_RUN_LEASE_RELEASE_KEY);
      await this.resetStartupDiagnosticsForNewClaimInTransaction(txn);
      const projected = await this.writeScheduledRunInTransaction(txn, nextMutable, active);
      return {
        lifecycle: buildLifecycleState(projected),
        dispatchGranted: true,
        harnessSettings: projected.harnessSettings,
        claudeAuthMode: projected.startClaudeAuthMode,
        codexAuthPreference: projected.startCodexAuthPreference,
        record: active,
      };
    });
    await this.scheduleNextAlarm(await this.readStoredMutableState(), result.record);
    return {
      lifecycle: result.lifecycle,
      dispatchGranted: result.dispatchGranted,
      harnessSettings: result.harnessSettings,
      ...(result.claudeAuthMode ? { claudeAuthMode: result.claudeAuthMode } : {}),
      ...(result.codexAuthPreference
        ? { codexAuthPreference: result.codexAuthPreference }
        : {}),
    };
  }

  async beginScheduledRunPreparation(opIdInput: string): Promise<number | null> {
    const opId = this.resolveLifecycleOpId(opIdInput);
    if (!opId) return null;
    const current = await this.readScheduledRun();
    return current?.kind === "active" && current.startOpId === opId
      ? current.preparation?.claimedAtMs ?? null
      : null;
  }

  async renewScheduledRunPreparation(options: { opId: string; claimedAtMs: number }): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY);
      if (
        record?.kind !== "active"
        || record.startOpId !== options.opId
        || record.preparation?.claimedAtMs !== options.claimedAtMs
      ) return false;
      await txn.put(SCHEDULED_RUN_RECORD_KEY, {
        ...record,
        preparation: { ...record.preparation, heartbeatAtMs: Date.now() },
        updatedAt: nowIso(),
      } satisfies ActiveScheduledRunReceipt);
      return true;
    });
  }

  async beginScheduledRunPreparationEffect(options: { opId: string; claimedAtMs: number }): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY);
      if (
        record?.kind !== "active"
        || record.startOpId !== options.opId
        || record.preparation?.claimedAtMs !== options.claimedAtMs
      ) return false;
      if (record.preparation.effectMayBeLive) return true;
      await txn.put(SCHEDULED_RUN_RECORD_KEY, {
        ...record,
        preparation: { ...record.preparation, effectMayBeLive: true, heartbeatAtMs: Date.now() },
        updatedAt: nowIso(),
      } satisfies ActiveScheduledRunReceipt);
      return true;
    });
  }

  async finishScheduledRunPreparationEffect(options: { opId: string; claimedAtMs: number }): Promise<boolean> {
    return this.ctx.storage.transaction(async (txn) => {
      const record = await txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY);
      if (
        record?.kind !== "active"
        || record.startOpId !== options.opId
        || record.preparation?.claimedAtMs !== options.claimedAtMs
      ) return false;
      if (!record.preparation.effectMayBeLive) return true;
      await txn.put(SCHEDULED_RUN_RECORD_KEY, {
        ...record,
        preparation: { ...record.preparation, effectMayBeLive: false, heartbeatAtMs: Date.now() },
        updatedAt: nowIso(),
      } satisfies ActiveScheduledRunReceipt);
      return true;
    });
  }

  async finishScheduledRunPreparation(options: { opId: string; claimedAtMs: number }): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        record?.kind !== "active"
        || record.startOpId !== options.opId
        || record.preparation?.claimedAtMs !== options.claimedAtMs
        || record.preparation.effectMayBeLive
        || !mutable
      ) return { released: false, record: record ?? null, mutable };
      const next = this.settleActiveScheduledRun({ ...record, preparation: null, updatedAt: nowIso() });
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { released: true, record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.released;
  }

  async expireScheduledRunPreparation(options: {
    opId: string;
    claimedAtMs: number;
    heartbeatAtMs: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        record?.kind !== "active"
        || record.startOpId !== options.opId
        || record.preparation?.claimedAtMs !== options.claimedAtMs
        || record.preparation.heartbeatAtMs !== options.heartbeatAtMs
        || options.now < options.heartbeatAtMs + (
          record.preparation.effectMayBeLive
            ? SCHEDULED_RUN_PREPARATION_ABANDON_MS
            : SCHEDULED_RUN_PREPARATION_LEASE_MS
        )
        || !mutable
      ) return { expired: false, record: record ?? null, mutable };
      const next: ActiveScheduledRunReceipt = {
        ...record,
        preparation: null,
        failure: record.failure ?? "Scheduled Run preparation was interrupted before it completed.",
        updatedAt: nowIso(),
      };
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { expired: true, record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.expired;
  }

  async markScheduledRunCredentialsMayExist(opId: string, claimedAtMs: number): Promise<boolean> {
    return this.updateActiveScheduledRun(opId, (record) => {
      if (record.preparation?.claimedAtMs !== claimedAtMs) return null;
      return { ...record, credentialsMayExist: true, updatedAt: nowIso() };
    });
  }

  async recordScheduledRunCredentialIds(opId: string, ids: ScheduledRunCredentialIds): Promise<boolean> {
    return this.updateActiveScheduledRun(opId, (record) => ({
      ...record,
      credentialsMayExist: true,
      credentialIds: { ...record.credentialIds, ...ids },
      updatedAt: nowIso(),
    }));
  }

  async markScheduledRunRunnerDispatch(opId: string, claimedAtMs: number): Promise<boolean> {
    return this.updateActiveScheduledRun(opId, (record) => {
      if (record.preparation?.claimedAtMs !== claimedAtMs) return null;
      return { ...record, runnerDispatchStarted: true, updatedAt: nowIso() };
    });
  }

  private async updateActiveScheduledRun(
    opId: string,
    update: (record: ActiveScheduledRunReceipt) => ActiveScheduledRunReceipt | null,
  ): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (record?.kind !== "active" || record.startOpId !== opId || !mutable) {
        return { changed: false, record: record ?? null, mutable };
      }
      const updated = update(record);
      if (!updated) return { changed: false, record, mutable };
      const next = this.settleActiveScheduledRun(updated);
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { changed: true, record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.changed;
  }

  async recordScheduledRunPostClaimFailure(options: {
    opId: string;
    error: string;
    runnerStoppedConfirmed: boolean;
    expectedIncarnationId?: string;
  }): Promise<boolean> {
    return this.updateActiveScheduledRun(options.opId, (record) => {
      if (options.expectedIncarnationId && record.incarnationId !== options.expectedIncarnationId) return null;
      return {
        ...record,
        failure: options.error,
        runnerStoppedConfirmed: record.runnerStoppedConfirmed || options.runnerStoppedConfirmed,
        updatedAt: nowIso(),
      };
    });
  }

  async recordScheduledRunCredentialsCleaned(
    opId: string,
    expectedIncarnationId?: string,
  ): Promise<boolean> {
    return this.updateActiveScheduledRun(opId, (record) => {
      if (expectedIncarnationId && record.incarnationId !== expectedIncarnationId) return null;
      return { ...record, credentialsMayExist: false, credentialIds: {}, updatedAt: nowIso() };
    });
  }

  async recordScheduledRunCredentialCleanupPending(
    opId: string,
    expectedIncarnationId?: string,
  ): Promise<boolean> {
    return this.updateActiveScheduledRun(opId, (record) => {
      if (expectedIncarnationId && record.incarnationId !== expectedIncarnationId) return null;
      return { ...record, credentialsMayExist: true, updatedAt: nowIso() };
    });
  }

  async requestScheduledRunOutcome(options: {
    opId?: string;
    outcome: ScheduledRunRequestedOutcome;
  }): Promise<ScheduledRunOutcomeResult> {
    const expectedStartOpId = this.resolveLifecycleOpId(options.opId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (record?.kind === "finished") {
        if (expectedStartOpId && record.startOpId !== expectedStartOpId) {
          return { result: { status: "rejected", error: "The lifecycle operation does not match the finished Scheduled Run." } as ScheduledRunOutcomeResult, record, mutable };
        }
        if (record.requestedOutcome === options.outcome || record.outcome === options.outcome) {
          return { result: { status: "idempotent", outcome: options.outcome } as ScheduledRunOutcomeResult, record, mutable };
        }
        return { result: { status: "rejected", error: `The Scheduled Run outcome is already ${record.requestedOutcome ?? record.outcome}.` } as ScheduledRunOutcomeResult, record, mutable };
      }
      if (record?.kind !== "active" || !mutable) {
        return { result: { status: "rejected", error: "No active Scheduled Run was found." } as ScheduledRunOutcomeResult, record: record ?? null, mutable };
      }
      if (expectedStartOpId && record.startOpId !== expectedStartOpId) {
        return { result: { status: "rejected", error: "The lifecycle operation does not match the active Scheduled Run." } as ScheduledRunOutcomeResult, record, mutable };
      }
      if (record.requestedOutcome && record.requestedOutcome !== options.outcome) {
        return { result: { status: "rejected", error: `The Scheduled Run outcome is already ${record.requestedOutcome}.` } as ScheduledRunOutcomeResult, record, mutable };
      }
      let nextMutable = mutable;
      let stopOpId = record.stopOpId;
      let stopCommand: RunnerCommandClaim;
      const alreadyStopping = mutable.lifecycleOperation === "stop"
        && mutable.lifecycleDesiredState === "stopped"
        && mutable.lifecycleOpId;
      if (alreadyStopping) {
        stopOpId = mutable.lifecycleOpId!;
        stopCommand = await this.allocateRunnerCommandInTransaction(txn, stopOpId, "stopped");
      } else {
        stopOpId = buildStopOpId();
        nextMutable = applyLifecycleState(mutable, {
          phase: "saving",
          activeOpId: stopOpId,
          activeOperation: "stop",
          desiredState: "stopped",
          lastRunnerState: mutable.lifecycleLastRunnerState,
          lastWorkspaceSyncedAckOpId: null,
          infraState: mutable.lifecycleInfraState,
          runtimeReady: false,
          lastError: null,
          lastErrorAt: null,
          updatedAt: nowIso(),
        });
        stopCommand = await this.allocateRunnerCommandInTransaction(txn, stopOpId, "stopped");
      }
      const next: ActiveScheduledRunReceipt = {
        ...record,
        requestedOutcome: record.requestedOutcome ?? options.outcome,
        stopOpId,
        stopRunnerGeneration: stopCommand.commandGeneration,
        updatedAt: nowIso(),
      };
      const projected = await this.writeScheduledRunInTransaction(txn, nextMutable, next);
      await txn.setAlarm(Date.now());
      return {
        result: {
          status: record.requestedOutcome ? "idempotent" : "accepted",
          outcome: next.requestedOutcome!,
          stop: stopCommand,
          lifecycle: buildLifecycleState(projected)!,
          preparationInFlight: next.preparation != null,
        } as ScheduledRunOutcomeResult,
        record: next,
        mutable: projected,
      };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.result;
  }

  async recordScheduledRunnerUncertainty(options: {
    stopOpId: string;
    error: string;
  }): Promise<boolean> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [record, storedMutable] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (record?.kind !== "active" || record.stopOpId !== options.stopOpId || !mutable) {
        return { changed: false, record: record ?? null, mutable };
      }
      const next: ActiveScheduledRunReceipt = {
        ...record,
        runnerCleanupRequired: true,
        runnerUncertaintyError: options.error,
        updatedAt: nowIso(),
      };
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { changed: true, record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.changed;
  }

  async prepareScheduledRunLeaseRelease(): Promise<{ slug: string; attemptId: string } | null> {
    return this.ctx.storage.transaction(async (txn) => {
      const pending = normalizePendingScheduledRunLeaseReleases(
        await txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
      );
      const now = Date.now();
      const index = pending.findIndex((entry) => entry.nextAttemptAtMs <= now);
      if (index < 0) return null;
      const selected = pending[index];
      pending[index] = { ...selected, nextAttemptAtMs: now + SCHEDULED_RUN_EFFECT_RETRY_MS };
      await txn.put(SCHEDULED_RUN_LEASE_RELEASE_KEY, pending);
      return { slug: selected.slug, attemptId: selected.attemptId };
    });
  }

  async confirmScheduledRunLeaseReleased(attemptId: string): Promise<ScheduledRunRecord | null> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedPending, record, storedMutable] = await Promise.all([
        txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      const pending = normalizePendingScheduledRunLeaseReleases(storedPending);
      const retained = pending.filter((entry) => entry.attemptId !== attemptId);
      if (retained.length > 0) await txn.put(SCHEDULED_RUN_LEASE_RELEASE_KEY, retained);
      else await txn.delete(SCHEDULED_RUN_LEASE_RELEASE_KEY);
      if (!record || record.attemptId !== attemptId || !mutable) {
        return { record: record ?? null, mutable };
      }
      let next: ScheduledRunRecord | null = record;
      if (record.kind === "schedule") {
        if (record.cancelRequested) {
          next = null;
        } else if (record.terminalRequested || Date.now() >= record.deadlineAtMs) {
          next = finishedScheduledRun(record, {
            outcome: "failed",
            error: record.lastError ?? "The Scheduled Run deadline passed before a runner could start.",
          });
        } else {
          next = {
            ...record,
            attemptId: null,
            capacityAcquired: false,
            acquireUncertain: false,
            retryAtMs: record.retryAtMs ?? Date.now() + SCHEDULED_RUN_RETRY_MS,
            updatedAt: nowIso(),
          };
        }
      } else if (record.kind === "active") {
        next = this.settleActiveScheduledRun({ ...record, capacityReleased: true, updatedAt: nowIso() });
      }
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
    return result.record;
  }

  async beginDelete(): Promise<EnvDeleteClaimResult> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun, publication, highWater, existingCommand, slug] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
        txn.get<number>(RUNNER_COMMAND_GENERATION_KEY),
        txn.get<RunnerCommandClaim>(RUNNER_COMMAND_CLAIM_KEY),
        txn.get<string>(ENV_SLUG_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!current) return { allowed: false as const, error: "Environment state not found.", mutableState: null };
      if (current.status === "deleting" && existingCommand?.desiredState === "absent") {
        return { allowed: true as const, runnerCommand: existingCommand, mutableState: current };
      }
      if (scheduledRun?.kind === "active" || (scheduledRun?.kind === "finished" && scheduledRun.cleanupRequired)) {
        return {
          allowed: false as const,
          error: scheduledRun.kind === "active" && scheduledRun.runnerCleanupRequired
            ? EXISTING_EXECUTION_UNAVAILABLE_MESSAGE
            : "Stop and finish the active Scheduled Run before deleting this environment.",
          mutableState: current,
        };
      }
      if (scheduledRun?.kind === "schedule" && scheduledRun.attemptId
        && (scheduledRun.capacityAcquired || scheduledRun.acquireUncertain)) {
        if (!slug) throw new Error("Scheduled Run capacity release is missing its environment slug.");
        await this.queueScheduledRunLeaseReleaseInTransaction(txn, slug, scheduledRun.attemptId);
        const finalizing: EnvironmentPlanSchedule = {
          ...scheduledRun,
          cancelRequested: true,
          retryAtMs: null,
          updatedAt: nowIso(),
        };
        await this.writeScheduledRunInTransaction(txn, current, finalizing);
        await txn.setAlarm(Date.now());
        return {
          allowed: false as const,
          error: "The Scheduled Run cancellation is still finalizing.",
          mutableState: current,
        };
      }
      const operationId = `destroy-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
      const runnerCommand: RunnerCommandClaim = {
        commandGeneration: (highWater ?? 0) + 1,
        operationId,
        desiredState: "absent",
      };
      const updatedAt = nowIso();
      const next = normalizeMutableState({
        ...current,
        status: "deleting",
        lifecyclePhase: null,
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: null,
        lifecycleLastRunnerState: null,
        lifecycleLastWorkspaceSyncedAckOpId: null,
        lifecycleInfraState: "unknown",
        lifecycleRuntimeReady: false,
        lifecycleUpdatedAt: null,
        error: null,
        errorAt: null,
        updatedAt,
      });
      delete next.scheduledRun;
      await txn.delete(SCHEDULED_RUN_RECORD_KEY);
      await txn.put(MUTABLE_STATE_KEY, next);
      await txn.put(RUNNER_COMMAND_GENERATION_KEY, runnerCommand.commandGeneration);
      await txn.put(RUNNER_COMMAND_CLAIM_KEY, runnerCommand);
      await this.markProjectionDirtyInTransaction(txn);
      if (publication) {
        await txn.put(ENV_PUBLICATION_KEY, { ...publication, state: "deleted", updatedAt });
      }
      return { allowed: true as const, runnerCommand, mutableState: next };
    });
    await this.scheduleNextAlarm(result.mutableState, await this.readScheduledRun());
    return result;
  }

  async abortDelete(error: string): Promise<EnvMutableState | null> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, publication] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY),
      ]);
      if (!storedMutable) return null;
      const updatedAt = nowIso();
      const next = normalizeMutableState({
        ...storedMutable,
        status: "failed",
        error,
        errorAt: updatedAt,
        updatedAt,
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      if (publication?.state === "deleted") {
        await txn.put(ENV_PUBLICATION_KEY, { ...publication, state: "visible", updatedAt });
      }
      return next;
    });
    await this.scheduleNextAlarm(result, await this.readScheduledRun());
    return result;
  }

  async finalizeDeletion(): Promise<void> {
    await this.ctx.storage.transaction(async (txn) => {
      const pendingLeaseReleases = normalizePendingScheduledRunLeaseReleases(
        await txn.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
      );
      await txn.delete([
        MUTABLE_STATE_KEY,
        SCHEDULED_RUN_RECORD_KEY,
        IMMUTABLE_PLAN_KEY,
        ENV_SLUG_KEY,
        INITIAL_CREATE_CLAIM_KEY,
        STOP_WORKSPACE_SYNCED_META_KEY,
        GITHUB_PUBLISH_OPERATION_KEY,
        STARTUP_DIAGNOSTICS_ACTIVE_KEY,
        STARTUP_DIAGNOSTICS_LAST_FAILED_KEY,
        PROJECTION_DIRTY_KEY,
        CODEX_EXECUTION_PROFILE_KEY,
      ]);
      const publication = await txn.get<EnvPublicationRecord>(ENV_PUBLICATION_KEY);
      if (publication) {
        await txn.put(ENV_PUBLICATION_KEY, { ...publication, state: "deleted", updatedAt: nowIso() });
      }
      const pendingReleaseAt = nextPendingScheduledRunLeaseReleaseAt(pendingLeaseReleases);
      if (pendingReleaseAt != null) {
        await txn.setAlarm(Math.max(Date.now(), pendingReleaseAt));
      } else {
        await txn.deleteAlarm();
      }
    });
  }

  async getStartupDiagnostics(): Promise<StartupDiagnosticsState> {
    return this.readStartupDiagnosticsState();
  }

  async beginStartupDiagnostics(options: {
    opId: string | null | undefined;
    backend: "cf" | "host";
    implementationMode?: "fresh" | "plan" | null;
    stepId?: StartupDiagnosticStepId | null;
    message?: string | null;
    detail?: string | null;
  }): Promise<StartupDiagnosticsState> {
    const resolvedOpId = this.resolveLifecycleOpId(options.opId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedActive, storedLastFailed] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_LAST_FAILED_KEY),
      ]);
      const existing: StartupDiagnosticsState = {
        active: storedActive ? normalizeStartupDiagnosticsSnapshot(storedActive) : null,
        lastFailed: storedLastFailed ? normalizeStartupDiagnosticsSnapshot(storedLastFailed) : null,
      };
      if (!storedMutable || !this.isExactActiveStart(normalizeMutableState(storedMutable), resolvedOpId)) {
        return { diagnostics: existing, mutableState: null, changed: false };
      }

      let active = createEmptyStartupDiagnostics(
        resolvedOpId!,
        options.backend,
        options.implementationMode ?? null,
      );
      const initialEvent =
        options.stepId && options.message
          ? buildStartupDiagnosticEvent({
              opId: resolvedOpId!,
              stepId: options.stepId,
              severity: "info",
              message: options.message,
              detail: options.detail,
            })
          : null;
      if (initialEvent) {
        active = this.buildUpdatedStartupDiagnostics(active, { event: initialEvent });
      }

      const lastFailed = existing.active?.failure ? existing.active : existing.lastFailed;
      await txn.put(STARTUP_DIAGNOSTICS_ACTIVE_KEY, active);
      if (lastFailed) await txn.put(STARTUP_DIAGNOSTICS_LAST_FAILED_KEY, lastFailed);
      else await txn.delete(STARTUP_DIAGNOSTICS_LAST_FAILED_KEY);
      const nextMutable = normalizeMutableState({
        ...storedMutable,
        bootMessage: active.currentStepMessage,
        bootStepId: active.currentStepId,
        updatedAt: active.updatedAt,
      });
      await txn.put(MUTABLE_STATE_KEY, nextMutable);
      await this.markProjectionDirtyInTransaction(txn);
      return {
        diagnostics: { active, lastFailed },
        mutableState: nextMutable,
        changed: true,
      };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.mutableState, await this.readScheduledRun());
    }
    return result.diagnostics;
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
    const resolvedOpId = this.resolveLifecycleOpId(options.opId);
    if (!resolvedOpId) return null;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedDiagnostics, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const active = storedDiagnostics
        ? normalizeStartupDiagnosticsSnapshot(storedDiagnostics)
        : null;
      if (
        !current
        || !this.isExactActiveStart(current, resolvedOpId)
        || !active
        || active.opId !== resolvedOpId
      ) {
        return {
          diagnostics: null,
          mutable: current,
          scheduledRun: scheduledRun ?? null,
          changed: false,
        };
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
        return {
          diagnostics: active,
          mutable: current,
          scheduledRun: scheduledRun ?? null,
          changed: false,
        };
      }
      const nextDiagnostics = this.buildUpdatedStartupDiagnostics(active, {
        event,
        logTails: options.logTails,
        updatedAt: event.at,
      });
      const nextMutable = normalizeMutableState({
        ...current,
        bootMessage: nextDiagnostics.currentStepMessage,
        bootStepId: nextDiagnostics.currentStepId,
        updatedAt: nextDiagnostics.updatedAt,
      });
      await txn.put(STARTUP_DIAGNOSTICS_ACTIVE_KEY, nextDiagnostics);
      await txn.put(MUTABLE_STATE_KEY, nextMutable);
      await this.markProjectionDirtyInTransaction(txn);
      return {
        diagnostics: nextDiagnostics,
        mutable: nextMutable,
        scheduledRun: scheduledRun ?? null,
        changed: true,
      };
    });
    if (result.changed) await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return result.diagnostics;
  }

  async reportStartupFailure(options: {
    opId: string | null | undefined;
    stepId?: StartupDiagnosticStepId | null;
    message: string;
    runnerMayExist?: boolean;
    detail?: string | null;
    exitCode?: number | null;
    signal?: string | null;
    at?: string | null;
    logTails?: Partial<StartupDiagnosticLogTails> | null;
    /** Record a lead-harness crash under the same exact Start operation. */
    leadHarnessFailure?: boolean;
  }): Promise<EnvLifecycleState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(options.opId);
    if (!resolvedOpId) return buildLifecycleState(await this.getMutableState());
    const normalizedFailureMessage = normalizeDiagnosticMessage(options.message) ?? "Startup failed";
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun, storedDiagnostics] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!current || current.lifecycleOpId !== resolvedOpId) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      const activeDiagnostics = storedDiagnostics
        ? normalizeStartupDiagnosticsSnapshot(storedDiagnostics)
        : null;
      const diagnostics = this.buildStartupDiagnosticsFailure(
        activeDiagnostics,
        resolvedOpId,
        options,
      );
      const failureMessage = diagnostics?.failure?.message ?? normalizedFailureMessage;
      const updatedAt = diagnostics?.updatedAt ?? nowIso();
      const withHarnessFailure = (state: EnvMutableState): EnvMutableState => options.leadHarnessFailure
        ? normalizeMutableState({
            ...state,
            leadHarnessStatus: "failed",
            leadHarnessError: failureMessage,
            leadHarnessUpdatedAt: updatedAt,
          })
        : state;
      const matchingScheduledRun = scheduledRun?.kind === "active"
        && scheduledRun.startOpId === resolvedOpId;
      if (scheduledRun?.kind === "active" && !matchingScheduledRun) {
        return { mutable: current, scheduledRun, changed: false };
      }

      let next = current;
      if (
        options.leadHarnessFailure
        && current.lifecyclePhase === "running"
        && current.lifecycleOperation === "start"
        && current.lifecycleDesiredState === "running"
      ) {
        next = withHarnessFailure(normalizeMutableState({ ...current, updatedAt }));
      } else if (current.lifecyclePhase === "starting") {
        const withDiagnostics = diagnostics
          ? normalizeMutableState({
              ...current,
              bootMessage: diagnostics.currentStepMessage,
              bootStepId: diagnostics.currentStepId,
              updatedAt: diagnostics.updatedAt,
            })
          : current;
        const failedBase = options.runnerMayExist
          ? { ...withDiagnostics, lifecycleRuntimeReady: false }
          : {
              ...withDiagnostics,
              lifecycleLastRunnerState: "stopped" as const,
              lifecycleInfraState: "stopped" as const,
              lifecycleRuntimeReady: false,
            };
        next = withHarnessFailure(applyLifecycleState(failedBase, {
          ...buildFailureState(failedBase, failureMessage),
          lastErrorAt: updatedAt,
          updatedAt,
        }));
      } else if (current.lifecyclePhase === "failed" && current.lifecycleDesiredState === "running") {
        next = withHarnessFailure(normalizeMutableState({
          ...current,
          ...(diagnostics
            ? { bootMessage: diagnostics.currentStepMessage, bootStepId: diagnostics.currentStepId }
            : {}),
          error: failureMessage,
          errorAt: updatedAt,
          updatedAt,
        }));
      } else {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }

      let nextScheduledRun = scheduledRun ?? null;
      if (matchingScheduledRun) {
        nextScheduledRun = {
          ...scheduledRun,
          failure: failureMessage,
          runnerStoppedConfirmed: scheduledRun.runnerStoppedConfirmed || !options.runnerMayExist,
          updatedAt,
        };
      }
      if (diagnostics) await txn.put(STARTUP_DIAGNOSTICS_ACTIVE_KEY, diagnostics);
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      return { mutable: projected, scheduledRun: nextScheduledRun, changed: true };
    });
    if (result.changed) await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return buildLifecycleState(result.mutable);
  }

  async clearMutableState(): Promise<null> {
    await this.writeMutableState(null);
    await this.ctx.storage.delete(STOP_WORKSPACE_SYNCED_META_KEY);
    await this.ctx.storage.delete(STOP_RETRY_KEY);
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

  async requestStop(expectedIncarnationId?: string): Promise<EnvLifecycleState> {
    const currentAtRequest = await this.getMutableState();
    const scheduled = await this.readScheduledRun();
    if (scheduled?.kind === "active") {
      if (expectedIncarnationId && scheduled.incarnationId !== expectedIncarnationId) {
        throw new Error("The Scheduled Run belongs to a replaced environment incarnation.");
      }
      const claimed = await this.requestScheduledRunOutcome({
        outcome: scheduled.requestedOutcome ?? "interrupted",
      });
      if (claimed.status === "rejected" || !claimed.lifecycle) throw new Error(claimed.status === "rejected" ? claimed.error : "Failed to claim Scheduled Run Stop.");
      return claimed.lifecycle;
    }
    if (scheduled?.kind === "finished" && scheduled.cleanupRequired) {
      throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    }
    if (
      currentAtRequest?.lifecyclePhase === "failed"
      && currentAtRequest.lifecycleOperation === "stop"
      && currentAtRequest.lifecycleDesiredState === "stopped"
      && currentAtRequest.lifecycleOpId
    ) {
      const resumed = await this.resumeStopRetry(currentAtRequest.lifecycleOpId);
      if (resumed) return resumed;
    }
    const next = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, creationClaim] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY),
      ]);
      const current = this.getOrCreateMutableState(
        storedMutable ? normalizeMutableState(storedMutable) : null,
      );
      if (creationClaim) return current;
      if (
        current.lifecycleOperation === "stop"
        && (current.lifecyclePhase === "saving" || current.lifecyclePhase === "stopping")
        && current.lifecycleOpId
      ) {
        await this.allocateRunnerCommandInTransaction(txn, current.lifecycleOpId, "stopped");
        return current;
      }
      const claimed = applyLifecycleState(current, {
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
      await txn.put(MUTABLE_STATE_KEY, claimed);
      await this.allocateRunnerCommandInTransaction(txn, claimed.lifecycleOpId!, "stopped");
      await this.markProjectionDirtyInTransaction(txn);
      return claimed;
    });
    await this.scheduleNextAlarm(next, await this.readScheduledRun());
    return buildLifecycleState(next)!;
  }

  /**
   * Durably queue the exact active Stop for alarm-owned dispatch.
   *
   * Cloudflare Stop can spend longer than the HTTP invocation's post-response
   * waitUntil window quiescing the harness and synchronizing the workspace.
   * Recording the dispatch before returning lets the lifecycle alarm own that
   * long-running work without minting a second Stop operation.
   */
  async ensureStopDispatchScheduled(
    opId: string | null | undefined,
    options?: { idleClaimId?: string | null },
  ): Promise<boolean> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!resolvedOpId) return false;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, retry, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StopRetryRecord>(STOP_RETRY_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const exactStop = Boolean(
        current
        && current.lifecycleOpId === resolvedOpId
        && current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && (
          current.lifecyclePhase === "saving"
          || current.lifecyclePhase === "stopping"
          || current.lifecyclePhase === "failed"
        ),
      );
      if (!current || !exactStop) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, queued: false };
      }
      if (retry?.opId !== resolvedOpId) {
        await txn.put(STOP_RETRY_KEY, {
          opId: resolvedOpId,
          attempt: 0,
          nextAttemptAtMs: Date.now(),
          ...(options?.idleClaimId?.trim()
            ? { idleClaimId: options.idleClaimId.trim() }
            : {}),
        } satisfies StopRetryRecord);
      } else if (options?.idleClaimId?.trim() && !retry.idleClaimId) {
        await txn.put(STOP_RETRY_KEY, {
          ...retry,
          idleClaimId: options.idleClaimId.trim(),
        } satisfies StopRetryRecord);
      }
      return { mutable: current, scheduledRun: scheduledRun ?? null, queued: true };
    });
    if (!result.queued) return false;
    await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return true;
  }

  /**
   * Re-arm the exact active Stop operation, preserving its runtime fence.
   * This deliberately reads storage without resolving lifecycle timeouts first:
   * an alarm or explicit retry may arrive after the save deadline has moved the
   * operation to failed. A missing or stale retry timer must never mint a new
   * Stop ID while the runtime still owns the original fence.
   */
  async resumeStopRetry(opId: string | null | undefined): Promise<EnvLifecycleState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!resolvedOpId) return null;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, retry, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<StopRetryRecord>(STOP_RETRY_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const exactStop = Boolean(
        current
        && current.lifecycleOpId === resolvedOpId
        && current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && (
          current.lifecyclePhase === "saving"
          || current.lifecyclePhase === "stopping"
          || current.lifecyclePhase === "failed"
        ),
      );
      if (!current || !exactStop) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, resumed: false };
      }

      const acknowledged = current.lifecycleLastWorkspaceSyncedAckOpId === resolvedOpId;
      const updatedAt = nowIso();
      const lifecycleUpdatedAt = current.lifecyclePhase === "failed"
        ? updatedAt
        : current.lifecycleUpdatedAt ?? current.updatedAt;
      const next = normalizeMutableState({
        ...applyLifecycleState(current, {
          phase: acknowledged ? "stopping" : "saving",
          activeOpId: resolvedOpId,
          activeOperation: "stop",
          desiredState: "stopped",
          lastRunnerState: current.lifecycleLastRunnerState,
          lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
          infraState: current.lifecycleInfraState,
          runtimeReady: false,
          lastError: null,
          lastErrorAt: null,
          updatedAt: lifecycleUpdatedAt,
        }),
        ...(!acknowledged
          ? { bootMessage: "Saving workspace…", bootStepId: "workspace-sync" as const }
          : {}),
        error: null,
        errorAt: null,
        updatedAt,
      });
      const nextScheduledRun = scheduledRun?.kind === "active" && scheduledRun.stopOpId === resolvedOpId
        ? {
            ...scheduledRun,
            persistenceConfirmed: acknowledged || scheduledRun.persistenceConfirmed,
            updatedAt,
          }
        : scheduledRun ?? null;
      if (retry?.opId !== resolvedOpId) {
        await txn.put(STOP_RETRY_KEY, {
          opId: resolvedOpId,
          attempt: 0,
          nextAttemptAtMs: Date.now() + STOP_RETRY_INITIAL_DELAY_MS,
        } satisfies StopRetryRecord);
      }
      await this.allocateRunnerCommandInTransaction(txn, resolvedOpId, "stopped");
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      return { mutable: projected, scheduledRun: nextScheduledRun, resumed: true };
    });
    if (!result.resumed) return null;
    await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return buildLifecycleState(result.mutable);
  }

  async beginStart(
    harnessSettings: HarnessSettings,
    authClaim: {
      claudeAuthMode?: ResolvedClaudeAuthMode | null;
      codexAuthPreference?: CodexAuthPreference | null;
    } = {},
  ): Promise<EnvStartClaimResult> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun, creationClaim] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!current) {
        return { lifecycle: null, dispatchGranted: false, harnessSettings: null, scheduledRun: scheduledRun ?? null };
      }
      const terminalCanArchive = scheduledRun?.kind === "finished" && !scheduledRun.cleanupRequired;
      const scheduledRunBlocksStart = Boolean(scheduledRun && !terminalCanArchive);
      const startable = !creationClaim
        && !scheduledRunBlocksStart
        && (
          current.lifecyclePhase === "stopped"
          || current.lifecyclePhase === "failed"
          || current.status === "stopped"
          || current.status === "failed"
          || current.status === "unknown"
        );
      if (!startable) {
        return {
          lifecycle: buildLifecycleState(current),
          dispatchGranted: false,
          harnessSettings: current.harnessSettings,
          scheduledRun: scheduledRun ?? null,
        };
      }
      let nextScheduledRun = scheduledRun ?? null;
      if (terminalCanArchive) {
        nextScheduledRun = { ...scheduledRun, archivedAt: nowIso(), updatedAt: nowIso() };
      }
      const next = this.buildStartingMutableState(current, harnessSettings, undefined, authClaim);
      await this.resetStartupDiagnosticsForNewClaimInTransaction(txn);
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      await this.allocateRunnerCommandInTransaction(txn, projected.lifecycleOpId!, "running");
      return {
        lifecycle: buildLifecycleState(projected),
        dispatchGranted: true,
        harnessSettings: projected.harnessSettings,
        ...(projected.startClaudeAuthMode ? { claudeAuthMode: projected.startClaudeAuthMode } : {}),
        ...(projected.startCodexAuthPreference ? { codexAuthPreference: projected.startCodexAuthPreference } : {}),
        scheduledRun: nextScheduledRun,
      };
    });
    await this.scheduleNextAlarm(await this.readStoredMutableState(), result.scheduledRun);
    return {
      lifecycle: result.lifecycle,
      dispatchGranted: result.dispatchGranted,
      harnessSettings: result.harnessSettings,
      ...(result.claudeAuthMode ? { claudeAuthMode: result.claudeAuthMode } : {}),
      ...(result.codexAuthPreference ? { codexAuthPreference: result.codexAuthPreference } : {}),
    };
  }

  async reportImplementorCompletion(
    runtimeStartOpId: string,
    sequence: number,
  ): Promise<{ accepted: boolean; changed: boolean }> {
    const normalizedOpId = runtimeStartOpId.trim();
    if (!normalizedOpId || !Number.isSafeInteger(sequence) || sequence <= 0) {
      return { accepted: false, changed: false };
    }
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<EnvMutableState>(MUTABLE_STATE_KEY);
      if (!stored) return { accepted: false, changed: false };
      const current = normalizeMutableState(stored);
      const attention = current.implementorAttentionState;
      if (attention.runtimeStartOpId !== normalizedOpId) {
        return { accepted: false, changed: false };
      }
      if (sequence <= attention.lastCompletionSequence) {
        return { accepted: true, changed: false };
      }
      const updatedAt = nowIso();
      const next = normalizeMutableState({
        ...current,
        implementorAttentionState: {
          ...attention,
          runtimeStartOpId: normalizedOpId,
          lastCompletionSequence: sequence,
          unreadToken: crypto.randomUUID(),
        },
        updatedAt,
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { accepted: true, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(
        await this.readStoredMutableState(),
        await this.readScheduledRun(),
      );
    }
    return result;
  }

  async reportReviewerCompletion(
    runId: string,
  ): Promise<{ accepted: boolean; changed: boolean }> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return { accepted: false, changed: false };
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<EnvMutableState>(MUTABLE_STATE_KEY);
      if (!stored) return { accepted: false, changed: false };
      const current = normalizeMutableState(stored);
      const attention = current.implementorAttentionState;
      if (attention.lastReviewerCompletionRunId === normalizedRunId) {
        return { accepted: true, changed: false };
      }
      const next = normalizeMutableState({
        ...current,
        implementorAttentionState: {
          ...attention,
          lastReviewerCompletionRunId: normalizedRunId,
          unreadToken: crypto.randomUUID(),
        },
        updatedAt: nowIso(),
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { accepted: true, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(
        await this.readStoredMutableState(),
        await this.readScheduledRun(),
      );
    }
    return result;
  }

  async acknowledgeImplementorAttention(
    token: string,
  ): Promise<"acknowledged" | "conflict" | "missing"> {
    const normalizedToken = token.trim();
    if (!normalizedToken) return "conflict";
    const outcome = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<EnvMutableState>(MUTABLE_STATE_KEY);
      if (!stored) return { result: "missing", changed: false } as const;
      const current = normalizeMutableState(stored);
      const unreadToken = current.implementorAttentionState.unreadToken;
      if (unreadToken === null) {
        return { result: "acknowledged", changed: false } as const;
      }
      if (unreadToken !== normalizedToken) {
        return { result: "conflict", changed: false } as const;
      }
      const next = normalizeMutableState({
        ...current,
        implementorAttentionState: {
          ...current.implementorAttentionState,
          unreadToken: null,
        },
        updatedAt: nowIso(),
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { result: "acknowledged", changed: true } as const;
    });
    if (outcome.changed) {
      await this.scheduleNextAlarm(
        await this.readStoredMutableState(),
        await this.readScheduledRun(),
      );
    }
    return outcome.result;
  }

  async noteInfraReady(opId?: string | null): Promise<EnvLifecycleState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const stored = await txn.get<EnvMutableState>(MUTABLE_STATE_KEY);
      const current = stored ? normalizeMutableState(stored) : null;
      if (
        !current
        || !resolvedOpId
        || !this.isExactActiveStart(current, resolvedOpId)
      ) return { state: current, changed: false };

      const updatedAt = nowIso();
      const next = normalizeMutableState({
        ...current,
        lifecycleInfraState: "ready",
        lifecycleLastRunnerState: "running",
        lifecycleUpdatedAt: updatedAt,
        updatedAt,
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { state: next, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.state, await this.readScheduledRun());
    }
    return buildLifecycleState(result.state);
  }

  async noteRunnerStarted(opId?: string | null): Promise<EnvLifecycleState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    if (!resolvedOpId) return buildLifecycleState(await this.getMutableState());
    await this.getMutableState();
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun, activeDiagnostics] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!current || current.lifecycleOpId !== resolvedOpId) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      const matchingScheduledRun = scheduledRun?.kind === "active"
        && scheduledRun.startOpId === resolvedOpId;
      const scheduledRunBlocksOrdinaryStart = scheduledRun?.kind === "schedule"
        || (scheduledRun?.kind === "active" && !matchingScheduledRun)
        || (scheduledRun?.kind === "finished" && scheduledRun.cleanupRequired);
      if (scheduledRunBlocksOrdinaryStart) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      const startable = current.lifecyclePhase === "starting"
        || (current.lifecyclePhase === "failed" && current.lifecycleDesiredState === "running");
      if (!startable) return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      const updatedAt = nowIso();
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
          updatedAt,
        }),
        bootMessage: null,
        bootStepId: null,
      });
      const nextScheduledRun = matchingScheduledRun
        ? { ...scheduledRun, runnerDispatchStarted: true, updatedAt } satisfies ActiveScheduledRunReceipt
        : scheduledRun ?? null;
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      if (activeDiagnostics?.opId === resolvedOpId) {
        await txn.delete(STARTUP_DIAGNOSTICS_ACTIVE_KEY);
        await txn.delete(STARTUP_DIAGNOSTICS_LAST_FAILED_KEY);
      }
      return { mutable: projected, scheduledRun: nextScheduledRun, changed: true };
    });
    await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return buildLifecycleState(result.mutable);
  }

  async noteRunnerStartFailed(
    opId: string | null | undefined,
    error: string,
  ): Promise<EnvLifecycleState | null> {
    return this.reportStartupFailure({
      opId,
      message: error,
      runnerMayExist: false,
    });
  }

  async setRunnerBinding(options: {
    runnerId?: string | null;
    opId?: string | null;
  }): Promise<EnvMutableState | null> {
    return this.mutateExistingMutableState(
      {
        opId: options.opId,
        startFenceRequested: Object.prototype.hasOwnProperty.call(options, "opId"),
      },
      (current) => ({
        ...current,
        runnerId:
          options.runnerId !== undefined
            ? (options.runnerId?.trim() || null)
            : current.runnerId,
        updatedAt: nowIso(),
      }),
    );
  }

  async setBootProgress(
    message: string | null,
    stepId?: StartupDiagnosticStepId | null,
  ): Promise<EnvMutableState | null> {
    return this.mutateExistingMutableState(
      { startFenceRequested: false },
      (current) => normalizeMutableState({
        ...current,
        bootMessage: message?.trim() || null,
        bootStepId:
          stepId !== undefined
            ? (stepId ?? null)
            : current.bootStepId,
        updatedAt: nowIso(),
      }),
    );
  }

  async clearLeadHarnessState(
    options?: { opId?: string | null },
  ): Promise<EnvMutableState | null> {
    return this.mutateExistingMutableState(
      {
        opId: options?.opId,
        startFenceRequested: Boolean(
          options && Object.prototype.hasOwnProperty.call(options, "opId"),
        ),
      },
      (current) => ({
        ...current,
        leadHarnessStatus: null,
        leadHarnessError: null,
        leadHarnessUpdatedAt: null,
        updatedAt: nowIso(),
      }),
    );
  }

  async recordStopWorkspaceSynced(
    patch: StopWorkspaceSyncedMetaPatch,
    options?: {
      opId?: string | null;
      stopFinalize?: boolean;
      clearError?: boolean;
    },
  ): Promise<EnvMutableState | null> {
    const resolvedStopFinalizeOpId = options?.stopFinalize
      ? this.resolveLifecycleOpId(options.opId)
      : null;
    const startFenceRequested = !options?.stopFinalize
      && Boolean(options && Object.prototype.hasOwnProperty.call(options, "opId"));
    const resolvedStartOpId = startFenceRequested
      ? this.resolveLifecycleOpId(options?.opId)
      : null;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [stored, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      if (!stored) return { state: null, scheduledRun: scheduledRun ?? null, changed: false };
      const current = normalizeMutableState(stored);

      if (startFenceRequested && !this.isExactActiveStart(current, resolvedStartOpId)) {
        return { state: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      if (options?.stopFinalize) {
        const matchingStop = Boolean(
          resolvedStopFinalizeOpId
          && current.lifecycleOpId === resolvedStopFinalizeOpId
          && current.lifecycleOperation === "stop"
          && current.lifecycleDesiredState === "stopped"
          && (
            current.lifecyclePhase === "saving"
            || current.lifecyclePhase === "stopping"
            || current.lifecyclePhase === "failed"
            || (
              current.lifecyclePhase === "stopped"
              && current.lifecycleLastWorkspaceSyncedAckOpId === resolvedStopFinalizeOpId
            )
          ),
        );
        if (!matchingStop) {
          console.warn(
            `[env-lifecycle] stale workspace-synced ack ignored: ${JSON.stringify({
              opId: resolvedStopFinalizeOpId,
              currentPhase: current.lifecyclePhase,
              currentOpId: current.lifecycleOpId,
              currentOperation: current.lifecycleOperation,
              desiredState: current.lifecycleDesiredState,
            })}`,
          );
          return { state: current, scheduledRun: scheduledRun ?? null, changed: false };
        }
      }

      const updatedAt = nowIso();
      let next = normalizeMutableState({
        ...current,
        workspaceDirty: patchValue(patch, current, "workspaceDirty"),
        workspaceNeedsAttention: patchValue(patch, current, "workspaceNeedsAttention"),
        workspaceLastSyncedAt: patchValue(patch, current, "workspaceLastSyncedAt"),
        baseMainCommit: patchValue(patch, current, "baseMainCommit"),
        lastKnownMainCommit: patchValue(patch, current, "lastKnownMainCommit"),
        branchStatus: patchValue(patch, current, "branchStatus"),
        githubBaseBranch: patchValue(patch, current, "githubBaseBranch"),
        githubBaseCommitSha: patchValue(patch, current, "githubBaseCommitSha"),
        githubHeadCommitSha: patchValue(patch, current, "githubHeadCommitSha"),
        githubPrNumber: patchValue(patch, current, "githubPrNumber"),
        githubPrUrl: patchValue(patch, current, "githubPrUrl"),
        githubPrState: patchValue(patch, current, "githubPrState"),
        githubMergedAt: patchValue(patch, current, "githubMergedAt"),
        githubPublishStatus: patchValue(patch, current, "githubPublishStatus"),
        githubPublishOperationId: patchValue(patch, current, "githubPublishOperationId"),
        githubPublishError: patchValue(patch, current, "githubPublishError"),
        githubLastPublishedAt: patchValue(patch, current, "githubLastPublishedAt"),
        githubLastPublishedWorkspaceHash: patchValue(patch, current, "githubLastPublishedWorkspaceHash"),
        githubPendingPublish: patchValue(patch, current, "githubPendingPublish"),
        error: options?.clearError ? null : current.error,
        errorAt: options?.clearError ? null : current.errorAt,
        updatedAt,
      });

      let nextScheduledRun = scheduledRun ?? null;
      if (options?.stopFinalize) {
        const resolvedOpId = resolvedStopFinalizeOpId!;
        const runnerAlreadyStopped = current.lifecycleLastRunnerState === "stopped"
          && current.lifecycleInfraState === "stopped";

        if (current.lifecycleOperation === "stop" && runnerAlreadyStopped) {
          next = normalizeMutableState({
            ...applyLifecycleState(next, {
              phase: "stopped",
              activeOpId: current.lifecycleOpId,
              activeOperation: "stop",
              desiredState: "stopped",
              lastRunnerState: "stopped",
              lastWorkspaceSyncedAckOpId: resolvedOpId,
              infraState: "stopped",
              runtimeReady: false,
              lastError: null,
              lastErrorAt: null,
              updatedAt,
            }),
            bootMessage: null,
            bootStepId: null,
          });
          await txn.delete(STOP_WORKSPACE_SYNCED_META_KEY);
          await txn.delete(STOP_RETRY_KEY);
        } else {
          await txn.put(STOP_WORKSPACE_SYNCED_META_KEY, {
            opId: resolvedOpId,
            patch,
          } satisfies PendingStopWorkspaceSyncedMeta);
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
        }
      }

      if (
        options?.stopFinalize
        && nextScheduledRun?.kind === "active"
        && nextScheduledRun.stopOpId === resolvedStopFinalizeOpId
      ) {
        const runnerStoppedConfirmed = nextScheduledRun.runnerStoppedConfirmed
          || (current.lifecycleLastRunnerState === "stopped" && current.lifecycleInfraState === "stopped");
        nextScheduledRun = this.settleActiveScheduledRun({
          ...nextScheduledRun,
          persistenceConfirmed: true,
          runnerStoppedConfirmed,
          runnerCleanupRequired: runnerStoppedConfirmed
            ? false
            : nextScheduledRun.runnerCleanupRequired,
          runnerUncertaintyError: runnerStoppedConfirmed
            ? null
            : nextScheduledRun.runnerUncertaintyError,
          updatedAt,
        });
      }
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      return { state: projected, scheduledRun: nextScheduledRun, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.state, result.scheduledRun);
    }
    return result.state;
  }

  async noteStopWorkspaceSynced(
    opId?: string | null,
    workspacePatch?: Partial<StopWorkspaceSyncedMetaPatch> | null,
  ): Promise<EnvLifecycleState | null> {
    // Keep omitted fields omitted so recordStopWorkspaceSynced resolves them
    // from the exact current operation inside its transaction. Expanding this
    // partial patch from an earlier read would reintroduce a stale overwrite.
    const next = await this.recordStopWorkspaceSynced(
      { ...(workspacePatch ?? {}) } as StopWorkspaceSyncedMetaPatch,
      {
      opId,
      stopFinalize: true,
      clearError: true,
      },
    );
    return buildLifecycleState(next);
  }

  async acceptStopWorkspaceSynced(
    opId: string | null | undefined,
    workspacePatch?: Partial<StopWorkspaceSyncedMetaPatch> | null,
  ): Promise<{ accepted: boolean; opId: string | null; state: EnvLifecycleState | null }> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    const next = await this.recordStopWorkspaceSynced(
      { ...(workspacePatch ?? {}) } as StopWorkspaceSyncedMetaPatch,
      {
        opId: resolvedOpId,
        stopFinalize: true,
        clearError: true,
      },
    );
    const accepted = Boolean(
      next
      && resolvedOpId
      && next.lifecycleOpId === resolvedOpId
      && next.lifecycleOperation === "stop"
      && next.lifecycleDesiredState === "stopped"
      && next.lifecycleLastWorkspaceSyncedAckOpId === resolvedOpId,
    );
    return {
      accepted,
      opId: accepted ? resolvedOpId : null,
      state: buildLifecycleState(next),
    };
  }

  async getStopWorkspaceSyncedMeta(): Promise<PendingStopWorkspaceSyncedMeta | null> {
    return (await this.ctx.storage.get<PendingStopWorkspaceSyncedMeta>(STOP_WORKSPACE_SYNCED_META_KEY)) ?? null;
  }

  async clearStopWorkspaceSyncedMeta(): Promise<void> {
    await this.ctx.storage.delete(STOP_WORKSPACE_SYNCED_META_KEY);
  }

  async getGitHubPublishOperation(): Promise<GitHubPublishOperationRecord | null> {
    return (await this.ctx.storage.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY)) ?? null;
  }

  async claimGitHubPublishResult(input: {
    operationId: string;
    callbackToken: string;
    workspaceHash: string;
    claimId: string;
  }): Promise<
    | { status: "claimed"; operation: GitHubPublishOperationRecord }
    | { status: "inactive" | "invalid" | "cleanup_pending" | "in_progress" }
  > {
    const claimId = input.claimId.trim();
    if (!claimId) throw new Error("GitHub publish result claims require a claim ID.");
    const now = Date.now();
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedOperation] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        !current
        || current.githubPublishOperationId !== input.operationId
        || storedOperation?.operationId !== input.operationId
      ) {
        return { response: { status: "inactive" as const }, state: current };
      }
      if (
        storedOperation.callbackToken !== input.callbackToken
        || storedOperation.workspaceHash !== input.workspaceHash
      ) {
        return { response: { status: "invalid" as const }, state: current };
      }
      if (storedOperation.cleanupPending) {
        return { response: { status: "cleanup_pending" as const }, state: current };
      }
      if (storedOperation.resultClaim) {
        if (storedOperation.resultClaim.expiresAtMs > now) {
          return { response: { status: "in_progress" as const }, state: current };
        }
        await txn.put(GITHUB_PUBLISH_OPERATION_KEY, {
          ...storedOperation,
          resultClaim: null,
          cleanupPending: {
            terminalError: "GitHub publish result processing was interrupted. Retry publishing.",
          },
        } satisfies GitHubPublishOperationRecord);
        await txn.setAlarm(now);
        return { response: { status: "cleanup_pending" as const }, state: current };
      }
      const operation: GitHubPublishOperationRecord = {
        ...storedOperation,
        resultClaim: {
          claimId,
          expiresAtMs: now + GITHUB_PUBLISH_RESULT_CLAIM_TTL_MS,
        },
      };
      await txn.put(GITHUB_PUBLISH_OPERATION_KEY, operation);
      const existingAlarm = await txn.getAlarm();
      if (
        existingAlarm === null
        || existingAlarm > operation.resultClaim!.expiresAtMs
      ) {
        await txn.setAlarm(operation.resultClaim!.expiresAtMs);
      }
      return {
        response: { status: "claimed" as const, operation },
        state: current,
      };
    });
    return result.response;
  }

  async beginGitHubPublishOperation(input: Omit<
    GitHubPublishOperationRecord,
    "resultClaim" | "cleanupPending"
  > & {
    projection: GitHubEnvPendingPublishProjection;
  }): Promise<
    | { claimed: true; state: EnvMutableState }
    | { claimed: false; state: EnvMutableState | null }
  > {
    const updatedAt = nowIso();
    const record: GitHubPublishOperationRecord = {
      operationId: input.operationId,
      envSlug: input.envSlug,
      repoId: input.repoId,
      repoUrl: input.repoUrl,
      jobSlug: input.jobSlug,
      executionPlacement: input.executionPlacement,
      branch: input.branch,
      baseCommitSha: input.baseCommitSha,
      workspaceHash: input.workspaceHash,
      expectedPriorHead: input.expectedPriorHead,
      hmacKey: input.hmacKey,
      callbackToken: input.callbackToken,
      pullRequestContent: input.pullRequestContent,
      resultClaim: null,
      cleanupPending: null,
      startedAt: input.startedAt,
    };
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedOperation] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        current?.githubPublishOperationId === input.operationId
        && storedOperation?.operationId === input.operationId
      ) {
        return { claimed: true as const, state: current, changed: false };
      }
      if (
        !current
        || current.githubPublishOperationId
        || current.githubPublishStatus === "publishing"
        || storedOperation
      ) {
        return { claimed: false as const, state: current, changed: false };
      }
      const next = normalizeMutableState({
        ...current,
        githubBranch: input.branch,
        githubPublishStatus: "publishing",
        githubPublishOperationId: input.operationId,
        githubPublishError: null,
        githubPendingPublish: {
          ...input.projection,
          updatedAt,
        },
        workspaceNeedsAttention: false,
        branchStatus: current.branchStatus === "needs-attention" ? "ready-to-merge" : current.branchStatus,
        updatedAt,
      });
      await txn.put(GITHUB_PUBLISH_OPERATION_KEY, record);
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { claimed: true as const, state: next, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.state, await this.readScheduledRun());
    }
    return result.claimed
      ? { claimed: true, state: result.state }
      : { claimed: false, state: result.state };
  }

  async updateGitHubPublishOperation(input: {
    operationId: string;
    resultClaimId: string;
    projection?: GitHubEnvPendingPublishProjection | null;
    patch?: Partial<Pick<
      EnvMutableState,
      | "githubHeadCommitSha"
      | "githubPublishStatus"
      | "githubPublishError"
      | "githubPendingPublish"
      | "workspaceNeedsAttention"
      | "branchStatus"
    >>;
  }): Promise<{ applied: boolean }> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedOperation] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        !current
        || current.githubPublishOperationId !== input.operationId
        || storedOperation?.operationId !== input.operationId
        || storedOperation.cleanupPending
        || storedOperation.resultClaim?.claimId !== input.resultClaimId
      ) {
        return { applied: false, state: current, changed: false };
      }
      const updatedAt = nowIso();
      const renewedClaim = {
        claimId: input.resultClaimId,
        expiresAtMs: Date.now() + GITHUB_PUBLISH_RESULT_CLAIM_TTL_MS,
      };
      await txn.put(GITHUB_PUBLISH_OPERATION_KEY, {
        ...storedOperation,
        resultClaim: renewedClaim,
      } satisfies GitHubPublishOperationRecord);
      const existingAlarm = await txn.getAlarm();
      if (existingAlarm === null || existingAlarm > renewedClaim.expiresAtMs) {
        await txn.setAlarm(renewedClaim.expiresAtMs);
      }
      const next = normalizeMutableState({
        ...current,
        ...input.patch,
        ...(input.projection !== undefined
          ? {
              githubPendingPublish: input.projection
                ? { ...input.projection, updatedAt }
                : null,
            }
          : {}),
        updatedAt,
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { applied: true, state: next, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.state, await this.readScheduledRun());
    }
    return { applied: result.applied };
  }

  async markGitHubPublishCleanupPending(input: {
    operationId: string;
    terminalError: string;
    resultClaimId?: string;
  }): Promise<boolean> {
    const terminalError = input.terminalError.trim() || "GitHub publish cleanup was interrupted.";
    const resultClaimId = input.resultClaimId?.trim() || null;
    return await this.ctx.storage.transaction(async (txn) => {
      const [stored, current] = await Promise.all([
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      if (
        !stored
        || stored.operationId !== input.operationId
        || !current
        || current.githubPublishOperationId !== input.operationId
        || (stored.resultClaim?.claimId ?? null) !== resultClaimId
      ) return false;
      await txn.put(GITHUB_PUBLISH_OPERATION_KEY, {
        ...stored,
        resultClaim: null,
        cleanupPending: {
          terminalError: stored.cleanupPending?.terminalError ?? terminalError,
        },
      } satisfies GitHubPublishOperationRecord);
      await txn.setAlarm(Date.now());
      return true;
    });
  }

  async finishGitHubPublishOperation(input: {
    operationId: string;
    resultClaimId?: string;
    patch: Partial<Pick<
      EnvMutableState,
      | "githubHeadCommitSha"
      | "githubPrNumber"
      | "githubPrUrl"
      | "githubPrState"
      | "githubMergedAt"
      | "githubPublishStatus"
      | "githubPublishError"
      | "githubLastPublishedAt"
      | "githubLastPublishedWorkspaceHash"
      | "workspaceDirty"
      | "workspaceNeedsAttention"
      | "branchStatus"
    >>;
  }): Promise<{ applied: boolean }> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, storedOperation] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const resultClaimId = input.resultClaimId?.trim() || null;
      if (
        !current
        || current.githubPublishOperationId !== input.operationId
        || storedOperation?.operationId !== input.operationId
        || (storedOperation.resultClaim?.claimId ?? null) !== resultClaimId
        || (storedOperation.cleanupPending !== null && resultClaimId !== null)
      ) {
        return { applied: false, state: current, changed: false };
      }
      await txn.delete(GITHUB_PUBLISH_OPERATION_KEY);
      const updatedAt = nowIso();
      const next = normalizeMutableState({
        ...current,
        ...input.patch,
        githubPublishOperationId: null,
        githubPendingPublish: null,
        updatedAt,
      });
      await txn.put(MUTABLE_STATE_KEY, next);
      await this.markProjectionDirtyInTransaction(txn);
      return { applied: true, state: next, changed: true };
    });
    if (result.changed) {
      await this.scheduleNextAlarm(result.state, await this.readScheduledRun());
    }
    return { applied: result.applied };
  }

  private async expireGitHubPublishResultClaim(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const [operation, current] = await Promise.all([
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      if (
        !operation?.resultClaim
        || operation.resultClaim.expiresAtMs > now
        || !current
        || current.githubPublishOperationId !== operation.operationId
      ) return;
      await txn.put(GITHUB_PUBLISH_OPERATION_KEY, {
        ...operation,
        resultClaim: null,
        cleanupPending: {
          terminalError: "GitHub publish result processing was interrupted. Retry publishing.",
        },
      } satisfies GitHubPublishOperationRecord);
      await txn.setAlarm(now);
    });
  }

  private async expireGitHubPublishWithoutResult(): Promise<void> {
    const now = Date.now();
    await this.ctx.storage.transaction(async (txn) => {
      const [operation, current] = await Promise.all([
        txn.get<GitHubPublishOperationRecord>(GITHUB_PUBLISH_OPERATION_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      if (
        !operation
        || operation.resultClaim
        || operation.cleanupPending
        || parseTimestamp(operation.startedAt) + GITHUB_PUBLISH_OPERATION_TIMEOUT_MS > now
        || !current
        || current.githubPublishOperationId !== operation.operationId
      ) return;
      await txn.put(GITHUB_PUBLISH_OPERATION_KEY, {
        ...operation,
        cleanupPending: {
          terminalError: "GitHub publish timed out before reporting a result. Retry publishing.",
        },
      } satisfies GitHubPublishOperationRecord);
      await txn.setAlarm(now);
    });
  }

  private async runGitHubPublishCleanupEffect(): Promise<void> {
    const operation = await this.getGitHubPublishOperation();
    if (!operation?.cleanupPending) return;
    await cleanupGitHubPublishRuntime(this.env, operation);
    await revokeGitHubBridgesForEnvPublish(this.env, {
      repoId: operation.repoId,
      operationId: operation.operationId,
    });

    const current = await this.getMutableState();
    await this.finishGitHubPublishOperation({
      operationId: operation.operationId,
      patch: {
        githubPublishStatus: "failed",
        githubPublishError: operation.cleanupPending.terminalError,
        workspaceNeedsAttention: false,
        branchStatus: current?.branchStatus === "needs-attention"
          ? "ready-to-merge"
          : current?.branchStatus ?? null,
      },
    });
  }

  async recordWorkspaceSyncFailed(
    opId: string | null | undefined,
    error: string,
  ): Promise<EnvMutableState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const matchingStop = Boolean(
        current
        && resolvedOpId
        && current.lifecycleOpId === resolvedOpId
        && current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && (
          current.lifecyclePhase === "saving"
          || current.lifecyclePhase === "stopping"
          || current.lifecyclePhase === "failed"
        ),
      );
      if (!current || !matchingStop) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false };
      }
      const acknowledged = current.lifecycleLastWorkspaceSyncedAckOpId === resolvedOpId
        && (current.lifecyclePhase === "stopping" || current.lifecyclePhase === "stopped");
      const updatedAt = nowIso();
      const next = acknowledged
        ? normalizeMutableState({
            ...current,
            error: null,
            errorAt: null,
            lifecycleUpdatedAt: updatedAt,
            updatedAt,
          })
        : normalizeMutableState({
            ...applyLifecycleState(current, {
              phase: "saving",
              activeOpId: resolvedOpId,
              activeOperation: "stop",
              desiredState: "stopped",
              lastRunnerState: current.lifecycleLastRunnerState,
              lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
              infraState: current.lifecycleInfraState,
              runtimeReady: false,
              lastError: null,
              lastErrorAt: null,
              updatedAt,
            }),
            bootMessage: stopRetryProgressMessage(error),
            bootStepId: "workspace-sync",
            error: null,
            errorAt: null,
          });
      const nextScheduledRun = scheduledRun?.kind === "active" && scheduledRun.stopOpId === resolvedOpId
        ? {
            ...scheduledRun,
            persistenceConfirmed: acknowledged || scheduledRun.persistenceConfirmed,
            updatedAt,
          }
        : scheduledRun ?? null;
      const existingRetry = await txn.get<StopRetryRecord>(STOP_RETRY_KEY);
      const attempt = existingRetry?.opId === resolvedOpId ? existingRetry.attempt : 0;
      await txn.put(STOP_RETRY_KEY, {
        opId: resolvedOpId!,
        attempt,
        nextAttemptAtMs: Date.now() + stopRetryDelayMs(attempt),
        ...(existingRetry?.opId === resolvedOpId && existingRetry.idleClaimId
          ? { idleClaimId: existingRetry.idleClaimId }
          : {}),
      } satisfies StopRetryRecord);
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      return { mutable: projected, scheduledRun: nextScheduledRun, changed: true };
    });
    if (result.changed) {
      console.error(`[env-lifecycle] Stop persistence will retry automatically: ${JSON.stringify({
        opId: resolvedOpId,
        detail: error,
      })}`);
    }
    if (result.changed) {
      await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    }
    return result.mutable;
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

  async noteFencedRunnerAbsentBeforeScheduledStart(
    stopOpId: string,
    startRejectedBeforeWorkspace = false,
  ): Promise<boolean> {
    const resolvedStopOpId = this.resolveLifecycleOpId(stopOpId);
    if (!resolvedStopOpId) return false;
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        !current
        || current.lifecycleOpId !== resolvedStopOpId
        || current.lifecycleOperation !== "stop"
        || current.lifecycleDesiredState !== "stopped"
        || !scheduledRun
        || scheduledRun.kind !== "active"
        || scheduledRun.stopOpId !== resolvedStopOpId
        || scheduledRun.preparation
        || (scheduledRun.runnerDispatchStarted && !startRejectedBeforeWorkspace)
      ) return { finalized: false, mutable: current, scheduledRun: scheduledRun ?? null };
      const updatedAt = nowIso();
      const nextMutable = normalizeMutableState({
        ...applyLifecycleState(current, {
          phase: "stopped",
          activeOpId: resolvedStopOpId,
          activeOperation: "stop",
          desiredState: "stopped",
          lastRunnerState: "stopped",
          lastWorkspaceSyncedAckOpId: resolvedStopOpId,
          infraState: "stopped",
          runtimeReady: false,
          lastError: null,
          lastErrorAt: null,
          updatedAt,
        }),
        bootMessage: null,
        bootStepId: null,
      });
      const nextScheduledRun = this.settleActiveScheduledRun({
        ...scheduledRun,
        runnerStoppedConfirmed: true,
        persistenceConfirmed: true,
        runnerCleanupRequired: false,
        runnerUncertaintyError: null,
        updatedAt,
      });
      const projected = await this.writeScheduledRunInTransaction(txn, nextMutable, nextScheduledRun);
      return { finalized: true, mutable: projected, scheduledRun: nextScheduledRun };
    });
    if (result.finalized) {
      await this.ctx.storage.delete(STOP_WORKSPACE_SYNCED_META_KEY);
      await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    }
    return result.finalized;
  }

  async noteFencedScheduledStartRejectedBeforeMutation(startOpId: string): Promise<boolean> {
    const resolvedStartOpId = this.resolveLifecycleOpId(startOpId);
    if (!resolvedStartOpId) return false;
    const record = await this.readScheduledRun();
    return record?.kind === "active"
      && record.startOpId === resolvedStartOpId
      && Boolean(record.stopOpId)
      ? this.noteFencedRunnerAbsentBeforeScheduledStart(record.stopOpId!, true)
      : false;
  }

  async noteRunnerStopped(
    opId: string | null | undefined,
    reason?: string | null,
  ): Promise<EnvLifecycleState | null> {
    const resolvedOpId = this.resolveLifecycleOpId(opId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun, storedDiagnostics] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<StartupDiagnosticsSnapshot>(STARTUP_DIAGNOSTICS_ACTIVE_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (!current || !resolvedOpId || current.lifecycleOpId !== resolvedOpId) {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false, runnerStoppedBeforeWorkspace: false };
      }
      const updatedAt = nowIso();
      let next = current;
      let failure: string | null = null;
      let runnerStoppedBeforeWorkspace = false;
      const finalizeStopped = () => normalizeMutableState({
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
          updatedAt,
        }),
        bootMessage: null,
        bootStepId: null,
      });
      if (
        current.lifecyclePhase === "stopping"
        || (
          current.lifecyclePhase === "failed"
          && current.lifecycleDesiredState === "stopped"
          && current.lifecycleLastWorkspaceSyncedAckOpId === resolvedOpId
        )
      ) {
        next = finalizeStopped();
        await txn.delete(STOP_WORKSPACE_SYNCED_META_KEY);
      } else if (current.lifecyclePhase === "failed" && current.lifecycleDesiredState === "stopped") {
        failure = current.error?.trim() || ENV_LIFECYCLE_RUNNER_EXIT_BEFORE_PERSIST_ERROR;
        next = normalizeMutableState({
          ...current,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
          lifecycleUpdatedAt: updatedAt,
          updatedAt,
        });
      } else if (current.lifecyclePhase === "saving") {
        next = normalizeMutableState({
          ...current,
          lifecycleLastRunnerState: "stopped",
          lifecycleInfraState: "stopped",
          lifecycleRuntimeReady: false,
          updatedAt,
        });
        runnerStoppedBeforeWorkspace = true;
      } else if (current.lifecyclePhase === "starting" || current.lifecyclePhase === "running") {
        failure = isProjectedRuntimeFailure(reason)
          ? reason!.trim()
          : current.lifecyclePhase === "starting"
            ? reason?.trim()
              ? `Container exited before the environment finished starting (${reason.trim()}).`
              : "Container exited before the environment finished starting."
            : reason?.trim()
              ? `Container exited unexpectedly while the environment was running (${reason.trim()}).`
              : ENV_LIFECYCLE_RUNNER_EXIT_WHILE_RUNNING_ERROR;
        let diagnostics = storedDiagnostics
          ? normalizeStartupDiagnosticsSnapshot(storedDiagnostics)
          : null;
        if (current.lifecyclePhase === "starting" && diagnostics?.opId === resolvedOpId) {
          const fallbackStepId = current.bootStepId ?? diagnostics.currentStepId ?? "startup-failed";
          const failureEvent = buildStartupDiagnosticEvent({
            opId: resolvedOpId,
            stepId: fallbackStepId,
            severity: "error",
            message: failure,
          });
          diagnostics = this.buildUpdatedStartupDiagnostics(diagnostics, {
            event: failureEvent,
            currentStepId: fallbackStepId,
            currentStepMessage: failure,
            failure: { message: failure, exitCode: null, signal: null, lastStepId: fallbackStepId },
            updatedAt,
          });
          await txn.put(STARTUP_DIAGNOSTICS_ACTIVE_KEY, diagnostics);
        }
        const stoppedCurrent = {
          ...current,
          ...(current.lifecyclePhase === "starting"
            ? { bootMessage: diagnostics?.currentStepMessage ?? failure, bootStepId: diagnostics?.currentStepId ?? current.bootStepId }
            : {}),
          lifecycleLastRunnerState: "stopped" as const,
          lifecycleInfraState: "stopped" as const,
          lifecycleRuntimeReady: false,
        };
        next = applyLifecycleState(stoppedCurrent, buildFailureState(stoppedCurrent, failure));
      } else {
        return { mutable: current, scheduledRun: scheduledRun ?? null, changed: false, runnerStoppedBeforeWorkspace: false };
      }

      // A stopped runner can still have an exact prepared receipt in SandboxDO.
      // Keep the Stop retry until both persistence and runner exit converge so
      // LifecycleDO can recover that receipt after an early onStop callback.
      if (
        current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && next.lifecyclePhase === "stopped"
        && next.lifecycleLastWorkspaceSyncedAckOpId === resolvedOpId
      ) {
        await txn.delete(STOP_RETRY_KEY);
      }

      let nextScheduledRun = scheduledRun ?? null;
      if (
        scheduledRun?.kind === "active"
        && (scheduledRun.stopOpId === resolvedOpId || scheduledRun.startOpId === resolvedOpId)
      ) {
        nextScheduledRun = this.settleActiveScheduledRun({
          ...scheduledRun,
          runnerStoppedConfirmed: true,
          runnerCleanupRequired: false,
          runnerUncertaintyError: null,
          ...(failure ? { failure } : {}),
          updatedAt,
        });
      }
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      return { mutable: projected, scheduledRun: nextScheduledRun, changed: true, runnerStoppedBeforeWorkspace };
    });
    if (result.runnerStoppedBeforeWorkspace) {
      console.warn(`[env-lifecycle] runner stopped before workspace-synced ack: ${JSON.stringify({ opId: resolvedOpId, reason: reason?.trim() ?? null })}`);
    }
    if (result.changed) await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return buildLifecycleState(result.mutable);
  }

  /**
   * Reconciles a fresh execution-owner proof that no runner exists before a
   * replacement Start. This never treats a merely stopped host container as
   * absent; callers must supply an exact fresh `absent` inspection result.
   * When a Stop lost its final acknowledgement with the runner itself, the
   * next Start intentionally recovers from the latest fully converged
   * WorkspaceDO state.
   */
  async confirmRunnerAbsentForRestart(
    expectedOpId: string | null,
  ): Promise<boolean> {
    const normalizedExpectedOpId = this.resolveLifecycleOpId(expectedOpId);
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [storedMutable, scheduledRun] = await Promise.all([
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (
        !current
        || current.lifecycleOpId !== normalizedExpectedOpId
        || current.lifecyclePhase === "starting"
        || current.lifecyclePhase === "running"
      ) {
        return { changed: false, mutable: current, scheduledRun: scheduledRun ?? null };
      }

      const stopRecovery = current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && (
          current.lifecyclePhase === "saving"
          || current.lifecyclePhase === "stopping"
          || current.lifecyclePhase === "failed"
          || current.lifecyclePhase === "stopped"
        );
      const failedStartRecovery = current.lifecycleOperation === "start"
        && current.lifecycleDesiredState === "running"
        && current.lifecyclePhase === "failed";
      const alreadyRestartable = current.lifecyclePhase === "stopped"
        || current.status === "stopped"
        || current.status === "failed"
        || current.status === "unknown";
      if (!stopRecovery && !failedStartRecovery && !alreadyRestartable) {
        return { changed: false, mutable: current, scheduledRun: scheduledRun ?? null };
      }

      const updatedAt = nowIso();
      const runnerAbsent = normalizeMutableState({
        ...current,
        lifecycleLastRunnerState: "stopped",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
        lifecycleUpdatedAt: updatedAt,
        updatedAt,
      });
      const next = stopRecovery
        ? normalizeMutableState({
            ...applyLifecycleState(runnerAbsent, {
              phase: "stopped",
              activeOpId: current.lifecycleOpId,
              activeOperation: "stop",
              desiredState: "stopped",
              lastRunnerState: "stopped",
              lastWorkspaceSyncedAckOpId: current.lifecycleLastWorkspaceSyncedAckOpId,
              infraState: "stopped",
              runtimeReady: false,
              lastError: null,
              lastErrorAt: null,
              updatedAt,
            }),
            bootMessage: null,
            bootStepId: null,
          })
        : runnerAbsent;

      let nextScheduledRun = scheduledRun ?? null;
      if (
        nextScheduledRun?.kind === "active"
        && (
          nextScheduledRun.stopOpId === normalizedExpectedOpId
          || nextScheduledRun.startOpId === normalizedExpectedOpId
        )
      ) {
        nextScheduledRun = this.settleActiveScheduledRun({
          ...nextScheduledRun,
          runnerStoppedConfirmed: true,
          runnerCleanupRequired: false,
          runnerUncertaintyError: null,
          updatedAt,
        });
      }
      if (stopRecovery) await txn.delete(STOP_WORKSPACE_SYNCED_META_KEY);
      if (stopRecovery) await txn.delete(STOP_RETRY_KEY);
      const projected = await this.writeScheduledRunInTransaction(txn, next, nextScheduledRun);
      return { changed: true, mutable: projected, scheduledRun: nextScheduledRun };
    });
    if (result.changed) await this.scheduleNextAlarm(result.mutable, result.scheduledRun);
    return result.changed;
  }

  private getScheduledRunCapacityStub(): ScheduledRunCapacityDO {
    return getDurableObjectStub<ScheduledRunCapacityDO>(
      this.env,
      this.env.SCHEDULED_RUN_CAPACITY,
      "scheduled-runs",
    );
  }

  private alarmExecutionContext(): ExecutionContext {
    return {
      waitUntil: (promise: Promise<unknown>) => this.ctx.waitUntil(promise),
      passThroughOnException: () => {},
      props: {},
    } as unknown as ExecutionContext;
  }

  private async ownsScheduledRunIncarnation(record: ScheduledRunRecord): Promise<boolean> {
    const publication = await this.getPublication();
    return publication?.incarnationId === record.incarnationId && publication.state === "visible";
  }

  private async resolveScheduledRunOrigin(
    schedule: EnvironmentPlanSchedule,
  ): Promise<string> {
    if (schedule.localDevOrigin === null) {
      return resolveCanonicalHubOrigin(this.env);
    }
    if (typeof schedule.localDevOrigin !== "string") {
      throw new Error("Scheduled workload was created by an unsupported version.");
    }
    const local = new URL(schedule.localDevOrigin);
    if (
      local.origin !== schedule.localDevOrigin
      || !isLoopbackHostname(local.hostname)
    ) {
      throw new Error("Scheduled workload has an invalid contributor origin.");
    }
    return local.origin;
  }

  private async runScheduledRunStartEffect(schedule: EnvironmentPlanSchedule): Promise<void> {
    if (!(await this.ownsScheduledRunIncarnation(schedule))) return;
    const meta = await this.getOwnedEnvView();
    if (!(await this.ownsScheduledRunIncarnation(schedule))) return;
    if (!meta) {
      const attempt = schedule.attemptId
        ? schedule
        : (await this.beginScheduledRunAttempt(schedule.incarnationId)).schedule;
      await this.recordScheduledPreStartFailure({
        attemptId: attempt.attemptId!,
        error: "The scheduled environment or its repository is missing.",
        retryable: false,
      });
      return;
    }
    try {
      const requestOrigin = await this.resolveScheduledRunOrigin(schedule);
      const result = await startEnvAction({
        env: this.env,
        executionCtx: this.alarmExecutionContext(),
        request: new Request(requestOrigin),
        requestUrl: requestOrigin,
        slug: meta.slug,
        intent: "scheduled",
        schedulerDeadlineAtMs: schedule.deadlineAtMs,
        expectedIncarnationId: schedule.incarnationId,
        lifecycleStub: this,
        cachedMeta: meta,
      });
      if (result.status < 400 || result.scheduledRunTransitionApplied) return;
      const current = await this.readScheduledRun();
      const error = typeof (result.body as { error?: unknown } | null)?.error === "string"
        ? (result.body as { error: string }).error
        : "Scheduled Run preparation failed.";
      if (current?.kind === "schedule" && current.attemptId) {
        await this.recordScheduledPreStartFailure({
          attemptId: current.attemptId,
          error,
          retryable: result.retryDisposition === "retry-pre-start",
        });
      } else if (current?.kind === "active") {
        await this.recordScheduledRunPostClaimFailure({
          opId: current.startOpId,
          error,
          runnerStoppedConfirmed: !current.runnerDispatchStarted,
          expectedIncarnationId: current.incarnationId,
        });
      }
    } catch (error) {
      const current = await this.readScheduledRun();
      const message = error instanceof Error ? error.message : String(error);
      if (current?.kind === "schedule" && current.attemptId) {
        await this.recordScheduledPreStartFailure({
          attemptId: current.attemptId,
          error: message,
          retryable: true,
        });
      } else if (current?.kind === "active") {
        await this.recordScheduledRunPostClaimFailure({
          opId: current.startOpId,
          error: message,
          runnerStoppedConfirmed: !current.runnerDispatchStarted,
          expectedIncarnationId: current.incarnationId,
        });
      }
    }
  }

  private async runScheduledRunStopEffect(record: ActiveScheduledRunReceipt): Promise<void> {
    if (record.preparation || !(await this.ownsScheduledRunIncarnation(record))) return;
    const meta = await this.getOwnedEnvView();
    if (!meta || !(await this.ownsScheduledRunIncarnation(record))) return;
    try {
      const result = await stopEnvAction({
        env: this.env,
        executionCtx: this.alarmExecutionContext(),
        slug: meta.slug,
        intent: "scheduled",
        requestedOutcome: record.requestedOutcome ?? "interrupted",
        expectedStartOpId: record.startOpId,
        lifecycleStub: this,
        cachedMeta: meta,
        expectedIncarnationId: record.incarnationId,
        awaitRunnerDispatch: true,
      });
      if (result.status >= 400 && result.runnerUncertain) {
        const message = typeof (result.body as { error?: unknown } | null)?.error === "string"
          ? (result.body as { error: string }).error
          : "Scheduled Run runner shutdown could not be confirmed.";
        const current = await this.readScheduledRun();
        if (current?.kind === "active" && current.stopOpId) {
          await this.recordScheduledRunnerUncertainty({ stopOpId: current.stopOpId, error: message });
        }
      }
    } catch (error) {
      const current = await this.readScheduledRun();
      if (current?.kind === "active" && current.stopOpId) {
        await this.recordScheduledRunnerUncertainty({
          stopOpId: current.stopOpId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async ensureScheduledRunLeaseReleaseQueued(record: ActiveScheduledRunReceipt): Promise<void> {
    if (record.capacityReleased) return;
    await this.ctx.storage.transaction(async (txn) => {
      const current = await txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY);
      if (current?.kind !== "active" || current.attemptId !== record.attemptId || current.capacityReleased) return;
      await this.queueScheduledRunLeaseReleaseInTransaction(txn, current.slug, current.attemptId);
      await txn.setAlarm(Date.now());
    });
  }

  private async runScheduledRunLeaseReleaseEffect(): Promise<void> {
    const release = await this.prepareScheduledRunLeaseRelease();
    if (!release) return;
    try {
      const result = await this.getScheduledRunCapacityStub().release(release);
      if (result.released) await this.confirmScheduledRunLeaseReleased(release.attemptId);
    } catch (error) {
      console.error("[env-lifecycle] Failed to release Scheduled Run capacity:", error);
    }
  }

  private async runScheduledRunCleanupEffect(record: ActiveScheduledRunReceipt): Promise<void> {
    if (record.preparation || !(await this.ownsScheduledRunIncarnation(record))) return;
    if (!record.stopOpId || !record.requestedOutcome) {
      await this.requestScheduledRunOutcome({
        opId: record.startOpId,
        outcome: record.requestedOutcome ?? "interrupted",
      });
      return;
    }
    if (!record.runnerStoppedConfirmed || !record.persistenceConfirmed) {
      await this.runScheduledRunStopEffect(record);
      return;
    }
    if (record.credentialsMayExist) {
      const cleanup = await cleanupLaunchCredentialsBestEffort(
        this.env,
        record.slug,
        {
          scope: { incarnationId: record.incarnationId, startOpId: record.startOpId },
          ids: record.credentialIds,
        },
      );
      if (cleanup.complete) {
        await this.recordScheduledRunCredentialsCleaned(record.startOpId, record.incarnationId);
      } else {
        await this.recordScheduledRunCredentialCleanupPending(record.startOpId, record.incarnationId);
      }
      return;
    }
    await this.ensureScheduledRunLeaseReleaseQueued(record);
  }

  private async expireScheduledRunBeforeStart(record: EnvironmentPlanSchedule): Promise<void> {
    const result = await this.ctx.storage.transaction(async (txn) => {
      const [current, storedMutable, slug] = await Promise.all([
        txn.get<ScheduledRunRecord>(SCHEDULED_RUN_RECORD_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
        txn.get<string>(ENV_SLUG_KEY),
      ]);
      const mutable = storedMutable ? normalizeMutableState(storedMutable) : null;
      if (current?.kind !== "schedule" || current.updatedAt !== record.updatedAt || !mutable) {
        return { record: current ?? null, mutable };
      }
      const error = "The Scheduled Run deadline passed before a runner could start.";
      let next: ScheduledRunRecord;
      if (current.attemptId && (current.capacityAcquired || current.acquireUncertain)) {
        if (!slug) throw new Error("Scheduled Run capacity release is missing its environment slug.");
        await this.queueScheduledRunLeaseReleaseInTransaction(txn, slug, current.attemptId);
        next = { ...current, terminalRequested: true, lastError: error, retryAtMs: null, updatedAt: nowIso() };
        await txn.setAlarm(Date.now());
      } else {
        next = finishedScheduledRun(current, { outcome: "failed", error });
      }
      const nextMutable = await this.writeScheduledRunInTransaction(txn, mutable, next);
      return { record: next, mutable: nextMutable };
    });
    await this.scheduleNextAlarm(result.mutable, result.record);
  }

  /** Returns true while an exact Stop retry record owns retry dispatch. */
  private async runStopRetryEffect(): Promise<boolean> {
    const storedRetry = await this.ctx.storage.get<StopRetryRecord>(STOP_RETRY_KEY);
    if (!storedRetry) return false;
    const now = Date.now();
    const claim = await this.ctx.storage.transaction(async (txn) => {
      const [retry, storedMutable] = await Promise.all([
        txn.get<StopRetryRecord>(STOP_RETRY_KEY),
        txn.get<EnvMutableState>(MUTABLE_STATE_KEY),
      ]);
      const current = storedMutable ? normalizeMutableState(storedMutable) : null;
      const exactStop = Boolean(
        retry
        && current
        && current.lifecycleOpId === retry.opId
        && current.lifecycleOperation === "stop"
        && current.lifecycleDesiredState === "stopped"
        && (
          current.lifecyclePhase === "saving"
          || current.lifecyclePhase === "stopping"
          || current.lifecyclePhase === "failed"
        ),
      );
      if (!retry || !current || !exactStop) {
        if (retry) await txn.delete(STOP_RETRY_KEY);
        return { owned: false, due: false, retry: null as StopRetryRecord | null };
      }
      if (now < retry.nextAttemptAtMs) {
        return { owned: true, due: false, retry };
      }
      const updatedAt = nowIso();
      const attempt = retry.attempt + 1;
      const nextRetry: StopRetryRecord = {
        ...retry,
        opId: retry.opId,
        attempt,
        nextAttemptAtMs: now + stopRetryDelayMs(attempt),
      };
      await txn.put(STOP_RETRY_KEY, nextRetry);
      await txn.put(MUTABLE_STATE_KEY, normalizeMutableState({
        ...current,
        updatedAt,
      }));
      await this.markProjectionDirtyInTransaction(txn);
      return { owned: true, due: true, retry: nextRetry };
    });
    if (!claim.owned || !claim.retry) return false;
    if (!claim.due) return true;

    const meta = await this.getOwnedEnvView();
    if (!meta) return true;
    const scheduledRun = await this.readScheduledRun();
    const matchingScheduledRun = scheduledRun?.kind === "active"
      && scheduledRun.stopOpId === claim.retry.opId
      ? scheduledRun
      : null;
    try {
      const result = await stopEnvAction({
        env: this.env,
        executionCtx: this.alarmExecutionContext(),
        slug: meta.slug,
        ...(matchingScheduledRun
          ? {
              intent: "scheduled" as const,
              requestedOutcome: matchingScheduledRun.requestedOutcome ?? "interrupted" as const,
              expectedStartOpId: matchingScheduledRun.startOpId,
              expectedIncarnationId: matchingScheduledRun.incarnationId,
            }
          : {}),
        lifecycleStub: this,
        cachedMeta: meta,
        expectedStopOpId: claim.retry.opId,
        idleClaimId: claim.retry.idleClaimId ?? null,
        awaitRunnerDispatch: true,
      });
      if (result.status >= 400) {
        console.warn(`[env-lifecycle] Stop retry was not dispatched: ${JSON.stringify({
          opId: claim.retry.opId,
          status: result.status,
          detail: result.body,
        })}`);
      }
    } catch (error) {
      console.error(`[env-lifecycle] Stop retry failed: ${JSON.stringify({
        opId: claim.retry.opId,
        detail: error instanceof Error ? error.message : String(error),
      })}`);
    }
    return true;
  }

  private async runAlarmPass(): Promise<void> {
    await this.runScheduledRunLeaseReleaseEffect();
    const creationClaim = await this.ctx.storage.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY);
    if (creationClaim) {
      const expiresAt = creationClaim.createdAtMs + INITIAL_CREATE_CLAIM_TTL_MS;
      if (Date.now() < expiresAt) {
        const pending = normalizePendingScheduledRunLeaseReleases(
          await this.ctx.storage.get<StoredPendingScheduledRunLeaseReleases>(SCHEDULED_RUN_LEASE_RELEASE_KEY),
        );
        const releaseAt = nextPendingScheduledRunLeaseReleaseAt(pending);
        await this.ctx.storage.setAlarm(releaseAt == null ? expiresAt : Math.min(expiresAt, releaseAt));
        return;
      }
      try {
        await this.rollbackStoppedInitialization(creationClaim.incarnationId);
      } catch (error) {
        console.error("[env-lifecycle] Failed to clean expired environment creation KV:", error);
        if (await this.ctx.storage.get<InitialCreateClaim>(INITIAL_CREATE_CLAIM_KEY)) {
          await this.ctx.storage.setAlarm(Date.now() + SCHEDULED_RUN_EFFECT_RETRY_MS);
        }
      }
      return;
    }

    await this.getMutableState();
    const stopRetryOwnsDispatch = await this.runStopRetryEffect();
    await this.expireGitHubPublishWithoutResult();
    await this.expireGitHubPublishResultClaim();
    await this.runGitHubPublishCleanupEffect();
    let record = await this.readScheduledRun();
    const now = Date.now();
    if (
      record?.kind === "active"
      && record.preparation
      && now >= record.preparation.heartbeatAtMs + (
        record.preparation.effectMayBeLive
          ? SCHEDULED_RUN_PREPARATION_ABANDON_MS
          : SCHEDULED_RUN_PREPARATION_LEASE_MS
      )
    ) {
      await this.expireScheduledRunPreparation({
        opId: record.startOpId,
        claimedAtMs: record.preparation.claimedAtMs,
        heartbeatAtMs: record.preparation.heartbeatAtMs,
        now,
      });
      record = await this.readScheduledRun();
    }

    if (record?.kind === "schedule" && now >= record.deadlineAtMs) {
      await this.expireScheduledRunBeforeStart(record);
      record = await this.readScheduledRun();
    } else if (record?.kind === "active" && now >= record.deadlineAtMs && !record.requestedOutcome) {
      await this.requestScheduledRunOutcome({ opId: record.startOpId, outcome: "interrupted" });
      record = await this.readScheduledRun();
    }

    if (record?.kind === "schedule") {
      const dueAt = record.retryAtMs ?? record.runAtMs;
      if (
        !record.cancelRequested
        && !record.terminalRequested
        && !record.acquireUncertain
        && !record.capacityAcquired
        && now >= dueAt
        && now < record.deadlineAtMs
      ) await this.runScheduledRunStartEffect(record);
    } else if (record?.kind === "active") {
      if (!record.preparation && (record.requestedOutcome || record.failure)) {
        if (!stopRetryOwnsDispatch) await this.runScheduledRunCleanupEffect(record);
      }
    }

    await this.runScheduledRunLeaseReleaseEffect();
    try {
      await this.persistOwnedProjection();
    } catch (error) {
      console.error("[env-lifecycle] Failed to publish environment projection:", error);
    }
    await this.scheduleNextAlarm(
      await this.readStoredMutableState(),
      await this.readScheduledRun(),
    );
  }

  async alarm(): Promise<void> {
    try {
      await this.runAlarmPass();
    } catch (error) {
      console.error("[env-lifecycle] Alarm pass failed; scheduling recovery:", error);
      // Cloudflare's automatic alarm retries are finite. Persist our own next
      // wake so a transient dependency or a bad deployment cannot strand the
      // lifecycle after those retries are exhausted.
      await this.ctx.storage.setAlarm(Date.now() + SCHEDULED_RUN_EFFECT_RETRY_MS);
    }
  }

}
