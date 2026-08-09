import {
  hasExplicitGitHubPublishFields,
  hasExplicitEnvScmFields,
  hasExplicitRepoScmFields,
  isExecutionPlacement,
  isEnvHarness,
  isEnvStatus,
  isRepoGitStatus,
} from "../api/types";
import type {
  StoredSession,
  StoredPermission,
  StoredMachine,
  WsServerMessage,
  EnvMeta,
  RepoMeta,
  EnvHarness,
  HarnessSettings,
  StartupDiagnosticsState,
} from "../api/types";
import {
  isHarnessCredentialRequirement,
  isHarnessProviderKind,
  validateHarnessSettings,
} from "../shared/harness-catalog";
import {
  isCloudflareIdleTimeoutMinutes,
} from "../shared/cloudflare-timeout";
import type {
  Artifact,
  AgentRoute,
  AgentSkillDefinition,
  ArtifactRef,
  PlanArtifact,
  PlanContribution,
  PlannerEffort,
  PlannerProviderMetadata,
  PlannerRun,
  PlannerRunEvent,
  PlanStatus,
  ReviewerRegistryEntry,
  PlanSkillInvocation,
  RepoPlanWriterSettings,
  PlanWriterState,
  PlanWriterProvider,
  ThreadMessage,
} from "../api/coordination/types";
import type {
  EnvReviewFeedback,
  EnvReviewRun,
  EnvReviewRunEvent,
  EnvReviewSession,
  EnvReviewState,
  EnvReviewTab,
  ReviewSkillInvocation,
} from "../api/env-review/types";
import type {
  HubUpdateRepoCandidate,
  HubUpdateRepoState,
  InstallerMaintenanceUpdateCheckResult,
  LegacyUpdateCheckResult,
  StableReleaseSummary,
  TillerUpdateMetadata,
  UpdateApplyResult,
  UpdateBuildDiagnostics,
  UpdateCheckResult,
} from "../api/update/types";
import type { BillingMode } from "../shared/billing";
import { isPlacementRegion, type PlacementRegion } from "../shared/placement";
import { TerminalRecoveryOverflowError } from "./terminal-recovery";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeArrayResponse<T>(payload: unknown): T[] {
  return Array.isArray(payload) ? payload as T[] : [];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStringOr(value: unknown, fallback: string): string {
  return readString(value) ?? fallback;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readErrorMessage(value: unknown): string | null {
  return isRecord(value) ? readString(value.error) : null;
}

function readBooleanOr(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readIntegerOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function normalizeHarnessPresentation(
  value: unknown,
): EnvMeta["harnessPresentation"] {
  if (!isRecord(value)) return undefined;
  const modelLabel = readString(value.modelLabel);
  const credentialRequirement = readString(value.credentialRequirement);
  const providerKind = readString(value.providerKind);
  const providerLabel = readString(value.providerLabel);
  if (
    !modelLabel
    || !isHarnessCredentialRequirement(credentialRequirement)
    || !isHarnessProviderKind(providerKind)
    || !providerLabel
  ) {
    return undefined;
  }
  return {
    modelLabel,
    credentialRequirement,
    providerKind,
    providerLabel,
  };
}

function readPlanStatusOr(value: unknown, fallback: PlanStatus = "draft"): PlanStatus {
  return value === "draft" || value === "evaluating" || value === "todo" || value === "completed" || value === "archived"
    ? value
    : fallback;
}

function readNumberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStrictArrayResponse<T>(
  payload: unknown,
  normalize: (value: unknown) => T | null,
  errorMessage: string,
): T[] {
  return normalizeArrayResponse(payload).map((value) => {
    const normalized = normalize(value);
    if (!normalized) {
      throw new Error(errorMessage);
    }
    return normalized;
  });
}

function normalizeStoredSession(payload: unknown): StoredSession | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const tag = readString(payload.tag);
  if (!id || !tag) return null;

  return {
    id,
    tag,
    machine_id: readNullableString(payload.machine_id),
    metadata: readStringOr(payload.metadata, "{}"),
    agent_state: readStringOr(payload.agent_state, "{}"),
    todos: readStringOr(payload.todos, "[]"),
    allowed_tools: readStringOr(payload.allowed_tools, "[]"),
    active: payload.active === 1 ? 1 : 0,
    metadata_version: readIntegerOr(payload.metadata_version, 1),
    agent_state_version: readIntegerOr(payload.agent_state_version, 1),
    todos_version: readIntegerOr(payload.todos_version, 1),
    seq: readIntegerOr(payload.seq, 0),
    ended_at: readNullableString(payload.ended_at),
    created_at: readStringOr(payload.created_at, ""),
    updated_at: readStringOr(payload.updated_at, ""),
  };
}

function normalizeStoredPermission(payload: unknown): StoredPermission | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const sessionId = readString(payload.session_id);
  const toolName = readString(payload.tool_name);
  if (!id || !sessionId || !toolName) return null;

  const status = payload.status === "allowed" || payload.status === "denied"
    ? payload.status
    : "pending";

  return {
    id,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: readStringOr(payload.tool_input, "{}"),
    status,
    decision_reason: readNullableString(payload.decision_reason),
    created_at: readStringOr(payload.created_at, ""),
    resolved_at: readNullableString(payload.resolved_at),
  };
}

function normalizeStoredMachine(payload: unknown): StoredMachine | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  if (!id) return null;

  return {
    id,
    metadata: readStringOr(payload.metadata, "{}"),
    runner_state: readStringOr(payload.runner_state, "{}"),
    active: payload.active === 1 ? 1 : 0,
    metadata_version: readIntegerOr(payload.metadata_version, 1),
    runner_state_version: readIntegerOr(payload.runner_state_version, 1),
    seq: readIntegerOr(payload.seq, 0),
    created_at: readStringOr(payload.created_at, ""),
    updated_at: readStringOr(payload.updated_at, ""),
  };
}

function normalizeEnvMetaObject(payload: unknown): EnvMeta | null {
  if (!isRecord(payload)) return null;
  const slug = readString(payload.slug);
  const incarnationId = readString(payload.incarnationId);
  const repoUrl = readString(payload.repoUrl);
  const repoId = readString(payload.repoId);
  const executionPlacement = isExecutionPlacement(payload.executionPlacement)
    ? payload.executionPlacement
    : null;
  const harness = readString(payload.harness);
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  const status = readString(payload.status);
  if (
    !slug
    || !incarnationId
    || !repoUrl
    || !repoId
    || !executionPlacement
    || payload.backend !== executionPlacement.backend
    || !harness
    || !createdAt
    || !updatedAt
    || !status
  ) return null;
  if (!isEnvHarness(harness)) return null;
  if (!isEnvStatus(status)) return null;
  if (!hasExplicitEnvScmFields(payload)) return null;
  const harnessSettings = validateHarnessSettings(harness, payload.harnessSettings);

  return {
    ...(payload as Partial<EnvMeta>),
    slug,
    incarnationId,
    sidebarSlot: typeof payload.sidebarSlot === "number"
      && Number.isInteger(payload.sidebarSlot)
      && payload.sidebarSlot > 0
      ? payload.sidebarSlot
      : undefined,
    repoUrl,
    repoId,
    scmModel: "github",
    backend: executionPlacement.backend,
    executionPlacement,
    harness,
    harnessSettings,
    harnessPresentation: harnessSettings
      ? normalizeHarnessPresentation(payload.harnessPresentation)
      : undefined,
    scheduledRun: isRecord(payload.scheduledRun)
      && (payload.scheduledRun.state === "scheduled"
        || payload.scheduledRun.state === "running"
        || payload.scheduledRun.state === "completed"
        || payload.scheduledRun.state === "interrupted"
        || payload.scheduledRun.state === "failed")
      && typeof payload.scheduledRun.runAtMs === "number"
      && Number.isFinite(payload.scheduledRun.runAtMs)
      && typeof payload.scheduledRun.timeZone === "string"
      ? {
          state: payload.scheduledRun.state,
          ...(payload.scheduledRun.stage === "implementing" || payload.scheduledRun.stage === "saving"
            ? { stage: payload.scheduledRun.stage }
            : {}),
          runAtMs: payload.scheduledRun.runAtMs,
          timeZone: payload.scheduledRun.timeZone,
          ...(typeof payload.scheduledRun.error === "string" ? { error: payload.scheduledRun.error } : {}),
          ...(payload.scheduledRun.cleanupRequired === true ? { cleanupRequired: true } : {}),
        }
      : undefined,
    createdAt,
    updatedAt,
    status,
    startupPlanId: payload.startupPlanId,
    branchName: payload.branchName,
    branchStatus: payload.branchStatus,
    workspaceDirty: payload.workspaceDirty,
    workspaceNeedsAttention: payload.workspaceNeedsAttention,
    workspaceLastSyncedAt: payload.workspaceLastSyncedAt,
    baseMainCommit: payload.baseMainCommit,
    lastKnownMainCommit: payload.lastKnownMainCommit,
    scmOperationType: payload.scmOperationType,
    scmOperationId: payload.scmOperationId,
    scmOperationPhase: payload.scmOperationPhase,
    scmOperationStartedAt: payload.scmOperationStartedAt,
    scmOperationUpdatedAt: payload.scmOperationUpdatedAt,
    scmLastCompletedAt: payload.scmLastCompletedAt,
    scmLastDurationMs: payload.scmLastDurationMs,
    scmLastTimings: payload.scmLastTimings,
    githubBaseBranch: readNullableString(payload.githubBaseBranch),
    githubBaseCommitSha: readNullableString(payload.githubBaseCommitSha),
    githubBranch: readNullableString(payload.githubBranch),
    githubHeadCommitSha: readNullableString(payload.githubHeadCommitSha),
    githubPrNumber: typeof payload.githubPrNumber === "number" && Number.isInteger(payload.githubPrNumber) ? payload.githubPrNumber : null,
    githubPrUrl: readNullableString(payload.githubPrUrl),
    githubPrState: payload.githubPrState === "open" || payload.githubPrState === "closed" || payload.githubPrState === "merged" ? payload.githubPrState : null,
    githubMergedAt: readNullableString(payload.githubMergedAt),
    githubPublishStatus:
      payload.githubPublishStatus === "publishing" ||
      payload.githubPublishStatus === "published" ||
      payload.githubPublishStatus === "up-to-date" ||
      payload.githubPublishStatus === "failed" ||
      payload.githubPublishStatus === "attention" ||
      payload.githubPublishStatus === "merged"
        ? payload.githubPublishStatus
        : "idle",
    githubPublishOperationId: readNullableString(payload.githubPublishOperationId),
    githubPublishError: readNullableString(payload.githubPublishError),
    githubLastPublishedAt: readNullableString(payload.githubLastPublishedAt),
    githubLastPublishedWorkspaceHash: readNullableString(payload.githubLastPublishedWorkspaceHash),
    githubPendingPublish: isRecord(payload.githubPendingPublish)
      ? {
          operationId: readStringOr(payload.githubPendingPublish.operationId, ""),
          status:
            payload.githubPendingPublish.status === "pushed" ||
            payload.githubPendingPublish.status === "finalizing" ||
            payload.githubPendingPublish.status === "failed"
              ? payload.githubPendingPublish.status
              : "starting",
          branch: readStringOr(payload.githubPendingPublish.branch, ""),
          baseCommitSha: readStringOr(payload.githubPendingPublish.baseCommitSha, ""),
          workspaceHash: readStringOr(payload.githubPendingPublish.workspaceHash, ""),
          expectedPriorHead: readNullableString(payload.githubPendingPublish.expectedPriorHead),
          pushedCommitSha: readNullableString(payload.githubPendingPublish.pushedCommitSha),
          startedAt: readStringOr(payload.githubPendingPublish.startedAt, ""),
          updatedAt: readStringOr(payload.githubPendingPublish.updatedAt, ""),
          error: readNullableString(payload.githubPendingPublish.error),
        }
      : null,
  } as EnvMeta;
}

function normalizeRepoMetaObject(payload: unknown): RepoMeta | null {
  if (!isRecord(payload)) return null;
  const repoId = readString(payload.repoId);
  const repoUrl = readString(payload.repoUrl);
  const githubInstallationId = typeof payload.githubInstallationId === "number" && Number.isInteger(payload.githubInstallationId) && payload.githubInstallationId > 0
    ? payload.githubInstallationId
    : null;
  const githubFullName = readString(payload.githubFullName);
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  const gitStatus = readString(payload.gitStatus);
  if (!repoId || !repoUrl || !githubInstallationId || !githubFullName || !createdAt || !updatedAt || !gitStatus) return null;
  if (!isRepoGitStatus(gitStatus)) return null;
  if (!hasExplicitRepoScmFields(payload)) return null;
  const githubPublish = payload.githubPublish === undefined
    ? undefined
    : payload.githubPublish === null
      ? null
      : hasExplicitGitHubPublishFields(payload.githubPublish)
        ? {
            status: payload.githubPublish.status,
            branch: payload.githubPublish.branch,
            commitSha: payload.githubPublish.commitSha ?? null,
            prNumber: payload.githubPublish.prNumber ?? null,
            prUrl: payload.githubPublish.prUrl ?? null,
            sourceEnvSlug: payload.githubPublish.sourceEnvSlug ?? null,
            operationId: payload.githubPublish.operationId ?? null,
            updatedAt: payload.githubPublish.updatedAt,
            error: payload.githubPublish.error ?? null,
          }
        : undefined;
  if (payload.githubPublish !== undefined && githubPublish === undefined) return null;

  return {
    ...(payload as Partial<RepoMeta>),
    repoId,
    repoUrl,
    scmModel: payload.scmModel === "github" ? "github" : "github",
    githubInstallationId,
    githubFullName,
    githubDefaultBranch: readNullableString(payload.githubDefaultBranch),
    githubDefaultBranchHeadSha: readNullableString(payload.githubDefaultBranchHeadSha),
    githubWebhookConfigured: readBooleanOr(payload.githubWebhookConfigured, false),
    githubWebhookError: readNullableString(payload.githubWebhookError),
    mainCommit: payload.mainCommit,
    gitArtifactId: payload.gitArtifactId,
    gitStatus,
    gitError: payload.gitError,
    gitFormatVersion: payload.gitFormatVersion,
    gitProgressPhase: payload.gitProgressPhase,
    gitProgressStartedAt: payload.gitProgressStartedAt,
    gitProgressUpdatedAt: payload.gitProgressUpdatedAt,
    gitLastBootstrapDurationMs: payload.gitLastBootstrapDurationMs,
    gitLastBootstrapTimings: payload.gitLastBootstrapTimings,
    createdAt,
    updatedAt,
    bootstrappedFromRef: readNullableString(payload.bootstrappedFromRef),
    ...(githubPublish === undefined ? {} : { githubPublish }),
  } as RepoMeta;
}

function normalizeArtifact(payload: unknown): Artifact | null {
  if (!isRecord(payload) || !isRecord(payload.basis)) return null;
  const id = readString(payload.id);
  const repoId = readString(payload.repoId);
  const type = readString(payload.type);
  const title = readString(payload.title);
  const createdAt = readString(payload.createdAt);
  if (!id || !repoId || !type || title === null || !createdAt) return null;

  return {
    ...(payload as Partial<Artifact>),
    id,
    repoId,
    type: type as Artifact["type"],
    title,
    createdAt,
    status: readPlanStatusOr(payload.status),
    updatedAt: readStringOr(payload.updatedAt, createdAt),
    version: readIntegerOr(payload.version, 1),
    basis: {
      repoId: readStringOr(payload.basis.repoId, repoId),
      mainCommit: readNullableString(payload.basis.mainCommit),
      ...(readNullableString(payload.basis.envSlug)
        ? { envSlug: readNullableString(payload.basis.envSlug) }
        : {}),
    },
  } as Artifact;
}

function normalizeReviewerRegistryEntry(payload: unknown): ReviewerRegistryEntry | null {
  if (!isRecord(payload)) return null;
  const threadId = readString(payload.threadId);
  const planArtifactId = readString(payload.planArtifactId);
  const repoId = readString(payload.repoId);
  const provider = readString(payload.provider);
  const model = readString(payload.model);
  const effort = payload.effort === "low" || payload.effort === "medium" || payload.effort === "high"
    || payload.effort === "xhigh" || payload.effort === "ultra" || payload.effort === "max"
    ? payload.effort
    : null;
  const skill = readString(payload.skill);
  const reviewerModel = readString(payload.reviewerModel) ?? model;
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  if (!threadId || !planArtifactId || !repoId || !provider || !model || !reviewerModel || !createdAt || !updatedAt) return null;
  return {
    threadId,
    planArtifactId,
    repoId,
    provider,
    model,
    ...(effort ? { effort } : {}),
    ...(skill ? { skill } : {}),
    role: "reviewer",
    ...(readNullableString(payload.runId) ? { runId: readNullableString(payload.runId) ?? undefined } : {}),
    ...(payload.status === "queued" || payload.status === "running" || payload.status === "saving" || payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled"
      ? { status: payload.status }
      : {}),
    ...(readNullableString(payload.error) ? { error: readNullableString(payload.error) ?? undefined } : {}),
    reviewerModel,
    ...(readNullableString(payload.removedAt) ? { removedAt: readNullableString(payload.removedAt) ?? undefined } : {}),
    createdAt,
    updatedAt,
  };
}

function normalizePlannerEffortId(payload: unknown): PlannerEffort | null {
  return payload === "low"
    || payload === "medium"
    || payload === "high"
    || payload === "xhigh"
    || payload === "ultra"
    || payload === "max"
    ? payload
    : null;
}

function normalizePlannerEfforts(payload: unknown): PlannerProviderMetadata["efforts"] {
  return normalizeArrayResponse(payload)
    .map((effort) => {
      if (!isRecord(effort)) return null;
      const id = normalizePlannerEffortId(effort.id);
      const displayName = readString(effort.displayName);
      return id && displayName ? { id, displayName } : null;
    })
    .filter(isPresent);
}

function normalizePlannerProviderModel(payload: unknown): PlannerProviderMetadata["models"][number] | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const displayName = readString(payload.displayName);
  const authStatus = payload.authStatus === "available" || payload.authStatus === "missing" || payload.authStatus === "unavailable"
    ? payload.authStatus
    : null;
  if (!id || !displayName || !authStatus) return null;
  const efforts = normalizePlannerEfforts(payload.efforts);
  const defaultEffort = normalizePlannerEffortId(payload.defaultEffort);
  return {
    id,
    displayName,
    available: readBooleanOr(payload.available, false),
    authStatus,
    ...(readNullableString(payload.disabledReason) ? { disabledReason: readNullableString(payload.disabledReason) ?? undefined } : {}),
    ...(efforts.length ? { efforts } : {}),
    ...(defaultEffort && efforts.some((effort) => effort.id === defaultEffort) ? { defaultEffort } : {}),
  };
}

function normalizePlannerProvider(payload: unknown): PlannerProviderMetadata | null {
  if (!isRecord(payload) || !isRecord(payload.capabilities)) return null;
  const id = readString(payload.id);
  const displayName = readString(payload.displayName);
  const authStatus = payload.authStatus === "available" || payload.authStatus === "missing" || payload.authStatus === "unavailable"
    ? payload.authStatus
    : null;
  if (!id || !displayName || !authStatus) return null;
  const efforts = normalizePlannerEfforts(payload.efforts);
  const defaultEffort = normalizePlannerEffortId(payload.defaultEffort);
  if (!defaultEffort || !efforts.some((effort) => effort.id === defaultEffort)) return null;
  return {
    id,
    displayName,
    available: readBooleanOr(payload.available, false),
    authStatus,
    disabledReasons: normalizeStringArray(payload.disabledReasons),
    capabilities: {
      writer: readBooleanOr(payload.capabilities.writer, false),
      reviewer: readBooleanOr(payload.capabilities.reviewer, false),
      chatContinuation: readBooleanOr(payload.capabilities.chatContinuation, false),
      cancellation: readBooleanOr(payload.capabilities.cancellation, false),
      planDelta: readBooleanOr(payload.capabilities.planDelta, false),
      checklist: readBooleanOr(payload.capabilities.checklist, false),
    },
    models: normalizeArrayResponse(payload.models).map(normalizePlannerProviderModel).filter(isPresent),
    efforts,
    defaultEffort,
  };
}

function normalizeAgentRoute(payload: unknown): AgentRoute | null {
  if (!isRecord(payload)) return null;
  const key = readString(payload.key);
  const label = readString(payload.label);
  const harness = payload.harness === "codex" || payload.harness === "claude-code" || payload.harness === "opencode"
    ? payload.harness
    : null;
  const provider = readString(payload.provider);
  const model = readString(payload.model);
  const modelId = readString(payload.modelId);
  if (!key || !label || !harness || !provider || !model || !modelId) return null;
  return payload as unknown as AgentRoute;
}

function normalizeAgentSkill(payload: unknown): AgentSkillDefinition | null {
  if (!isRecord(payload)) return null;
  if (
    !readString(payload.id)
    || (payload.surface !== "plan" && payload.surface !== "review")
    || !readString(payload.command)
    || !readString(payload.label)
    || !readString(payload.sharedInstructions)
    || !Array.isArray(payload.agents)
    || payload.agents.length < 1
    || payload.agents.length > 4
  ) return null;
  return payload as unknown as AgentSkillDefinition;
}

export type {
  AgentRoute,
  AgentSkillDefinition,
  PlanSkillInvocation,
  RepoPlanWriterSettings,
  ReviewSkillInvocation,
};

function normalizePlanContribution(payload: unknown): PlanContribution | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const repoId = readString(payload.repoId);
  const planArtifactId = readString(payload.planArtifactId);
  const provider = readString(payload.provider);
  const model = readString(payload.model);
  const text = readString(payload.text);
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  const status = payload.status === "pending" || payload.status === "incorporated" || payload.status === "dismissed"
    ? payload.status
    : null;
  if (!id || !repoId || !planArtifactId || !provider || !model || !text || !status || !createdAt || !updatedAt) return null;
  return {
    id,
    repoId,
    planArtifactId,
    sourceKind: payload.sourceKind === "reviewer_message"
      || payload.sourceKind === "reviewer_run"
      || payload.sourceKind === "skill_guidance"
      ? payload.sourceKind
      : "manual",
    provider,
    model,
    text,
    status,
    createdAt,
    updatedAt,
    ...(readNullableString(payload.sourceRunId) ? { sourceRunId: readNullableString(payload.sourceRunId) ?? undefined } : {}),
    ...(readNullableString(payload.sourceThreadId) ? { sourceThreadId: readNullableString(payload.sourceThreadId) ?? undefined } : {}),
    ...(readNullableString(payload.sourceMessageId) ? { sourceMessageId: readNullableString(payload.sourceMessageId) ?? undefined } : {}),
    ...(typeof payload.sourcePlanVersion === "number" ? { sourcePlanVersion: payload.sourcePlanVersion } : {}),
    ...(readNullableString(payload.skill) ? { skill: readNullableString(payload.skill) ?? undefined } : {}),
    ...(readNullableString(payload.incorporatedAt) ? { incorporatedAt: readNullableString(payload.incorporatedAt) ?? undefined } : {}),
    ...(readNullableString(payload.dismissedAt) ? { dismissedAt: readNullableString(payload.dismissedAt) ?? undefined } : {}),
  };
}

function normalizePlannerRunInput(payload: unknown): PlannerRun["input"] | undefined {
  if (!isRecord(payload)) return undefined;
  const skillSnapshot = isRecord(payload.skillSnapshot)
    && readString(payload.skillSnapshot.id)
    && readString(payload.skillSnapshot.command)
    && readString(payload.skillSnapshot.label)
    && readString(payload.skillSnapshot.instructions)
    ? {
      id: readString(payload.skillSnapshot.id) ?? "",
      command: readString(payload.skillSnapshot.command) ?? "",
      label: readString(payload.skillSnapshot.label) ?? "",
      instructions: readString(payload.skillSnapshot.instructions) ?? "",
    }
    : null;
  const skillDefinitionSnapshot = normalizeAgentSkill(payload.skillDefinitionSnapshot);
  const basis = isRecord(payload.basis)
    && readString(payload.basis.artifactId)
    && readString(payload.basis.title)
    && typeof payload.basis.markdown === "string"
    && typeof payload.basis.version === "number"
    ? payload.basis as unknown as NonNullable<PlannerRun["input"]>["basis"]
    : null;
  const effort = payload.effort === "low"
    || payload.effort === "medium"
    || payload.effort === "high"
    || payload.effort === "xhigh"
    || payload.effort === "ultra"
    || payload.effort === "max"
    ? payload.effort
    : null;
  return {
    ...(readNullableString(payload.instruction) ? { instruction: readNullableString(payload.instruction) ?? undefined } : {}),
    ...(typeof payload.sourcePlanVersion === "number" ? { sourcePlanVersion: payload.sourcePlanVersion } : {}),
    ...(payload.githubBaseCommitSha === null
      ? { githubBaseCommitSha: null }
      : readNullableString(payload.githubBaseCommitSha)
        ? { githubBaseCommitSha: readNullableString(payload.githubBaseCommitSha) ?? undefined }
        : {}),
    ...(skillSnapshot ? { skillSnapshot } : {}),
    ...(skillDefinitionSnapshot ? { skillDefinitionSnapshot } : {}),
    ...(basis ? { basis } : {}),
    ...(effort ? { effort } : {}),
  };
}

function normalizePlannerRun(payload: unknown): PlannerRun | null {
  if (!isRecord(payload)) return null;
  const runId = readString(payload.runId);
  const repoId = readString(payload.repoId);
  const planArtifactId = readString(payload.planArtifactId);
  const role = payload.role === "reviewer" ? payload.role : null;
  const provider = readString(payload.provider);
  const model = readString(payload.model);
  const status = payload.status === "queued" || payload.status === "running" || payload.status === "saving" || payload.status === "completed" || payload.status === "failed" || payload.status === "cancelled"
    ? payload.status
    : null;
  const startedAt = readString(payload.startedAt);
  if (!runId || !repoId || !planArtifactId || !role || !provider || !model || !status || !startedAt) return null;
  const input = normalizePlannerRunInput(payload.input);
  const skillRunRole = payload.skillRunRole === "child_initial"
    || payload.skillRunRole === "child_followup"
    || payload.skillRunRole === "overview"
    ? payload.skillRunRole
    : null;
  const runtime = isRecord(payload.runtime)
    && (payload.runtime.backend === "cf" || payload.runtime.backend === "host")
    && readString(payload.runtime.jobSlug)
    ? payload.runtime as unknown as NonNullable<PlannerRun["runtime"]>
    : null;
  const codexAuthMode = payload.codexAuthMode === "subscription" || payload.codexAuthMode === "api-key"
    ? payload.codexAuthMode
    : null;
  return {
    runId,
    repoId,
    planArtifactId,
    role,
    provider,
    model,
    status,
    startedAt,
    ...(readNullableString(payload.skill) ? { skill: readNullableString(payload.skill) ?? undefined } : {}),
    ...(readNullableString(payload.completedAt) ? { completedAt: readNullableString(payload.completedAt) ?? undefined } : {}),
    ...(readNullableString(payload.error) ? { error: readNullableString(payload.error) ?? undefined } : {}),
    ...(readNullableString(payload.threadId) ? { threadId: readNullableString(payload.threadId) ?? undefined } : {}),
    ...(readNullableString(payload.skillInvocationId) ? { skillInvocationId: readNullableString(payload.skillInvocationId) ?? undefined } : {}),
    ...(readNullableString(payload.skillAgentId) ? { skillAgentId: readNullableString(payload.skillAgentId) ?? undefined } : {}),
    ...(skillRunRole ? { skillRunRole } : {}),
    ...(runtime ? { runtime } : {}),
    ...(codexAuthMode ? { codexAuthMode } : {}),
    ...(readNullableString(payload.lastContactAt) ? { lastContactAt: readNullableString(payload.lastContactAt) ?? undefined } : {}),
    ...(input ? { input } : {}),
  };
}

function normalizePlannerRunEvent(payload: unknown): PlannerRunEvent | null {
  if (!isRecord(payload)) return null;
  const runId = readString(payload.runId);
  const repoId = readString(payload.repoId);
  const planArtifactId = readString(payload.planArtifactId);
  const type = readString(payload.type);
  const createdAt = readString(payload.createdAt);
  if (!runId || !repoId || !planArtifactId || !type || !createdAt) return null;
  return {
    runId,
    repoId,
    planArtifactId,
    seq: readIntegerOr(payload.seq, 0),
    type,
    ...(readNullableString(payload.message) ? { message: readNullableString(payload.message) ?? undefined } : {}),
    ...(payload.data === undefined ? {} : { data: payload.data }),
    createdAt,
  };
}

function normalizeThreadMessage(payload: unknown): ThreadMessage | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const threadId = readString(payload.threadId);
  const senderSessionId = readString(payload.senderSessionId);
  const createdAt = readString(payload.createdAt);
  if (!id || !threadId || !senderSessionId || !createdAt) return null;
  return {
    id,
    threadId,
    seq: readIntegerOr(payload.seq, 0),
    senderSessionId,
    kind: payload.kind === "status" || payload.kind === "question" || payload.kind === "ack" ? payload.kind : "chat",
    body: payload.body,
    ...(readNullableString(payload.localId) ? { localId: readNullableString(payload.localId) ?? undefined } : {}),
    artifactIds: normalizeStringArray(payload.artifactIds),
    createdAt,
  };
}

function normalizeEnvReviewSession(payload: unknown): EnvReviewSession | null {
  if (!isRecord(payload)) return null;
  const envSlug = readString(payload.envSlug);
  const repoId = readString(payload.repoId);
  const mainSessionId = readString(payload.mainSessionId);
  if (!envSlug || !repoId || !mainSessionId) return null;
  return payload as unknown as EnvReviewSession;
}

function normalizeEnvReviewTab(payload: unknown): EnvReviewTab | null {
  if (!isRecord(payload)) return null;
  const threadId = readString(payload.threadId);
  const envSlug = readString(payload.envSlug);
  const repoId = readString(payload.repoId);
  const provider = readString(payload.provider);
  const model = readString(payload.model);
  if (!threadId || !envSlug || !repoId || !provider || !model) return null;
  return payload as unknown as EnvReviewTab;
}

function normalizeEnvReviewRun(payload: unknown): EnvReviewRun | null {
  if (!isRecord(payload)) return null;
  const runId = readString(payload.runId);
  const threadId = readString(payload.threadId);
  const envSlug = readString(payload.envSlug);
  const repoId = readString(payload.repoId);
  if (!runId || !threadId || !envSlug || !repoId) return null;
  return payload as unknown as EnvReviewRun;
}

function normalizeEnvReviewRunEvent(payload: unknown): EnvReviewRunEvent | null {
  if (!isRecord(payload)) return null;
  const runId = readString(payload.runId);
  const type = readString(payload.type);
  const createdAt = readString(payload.createdAt);
  if (!runId || !type || !createdAt) return null;
  return payload as unknown as EnvReviewRunEvent;
}

function normalizeEnvReviewFeedback(payload: unknown): EnvReviewFeedback | null {
  if (!isRecord(payload)) return null;
  const feedbackId = readString(payload.feedbackId);
  const runId = readString(payload.runId);
  const text = readString(payload.text);
  if (!feedbackId || !runId || !text) return null;
  return payload as unknown as EnvReviewFeedback;
}

function normalizeEnvReviewState(payload: unknown): EnvReviewState {
  if (!isRecord(payload)) {
    throw new Error("Malformed env review state");
  }
  const session = normalizeEnvReviewSession(payload.session);
  if (!session) throw new Error("Malformed env review session");
  return {
    session,
    tabs: normalizeArrayResponse(payload.tabs).map(normalizeEnvReviewTab).filter(isPresent),
    runs: normalizeArrayResponse(payload.runs).map(normalizeEnvReviewRun).filter(isPresent),
    feedback: normalizeArrayResponse(payload.feedback).map(normalizeEnvReviewFeedback).filter(isPresent),
  };
}

function normalizeArtifactRef(payload: unknown): ArtifactRef | null {
  if (!isRecord(payload)) return null;
  const repoId = readString(payload.repoId);
  const name = readString(payload.name);
  const artifactId = readString(payload.artifactId);
  if (!repoId || !name || !artifactId) return null;

  return {
    repoId,
    name,
    artifactId,
    version: readIntegerOr(payload.version, 1),
    updatedAt: readStringOr(payload.updatedAt, ""),
  };
}

function normalizeStringArray(value: unknown): string[] {
  return normalizeArrayResponse(value).filter((item): item is string => typeof item === "string");
}

function normalizeVerifyModelAuthResult(payload: unknown): VerifyModelAuthResult | null {
  if (!isRecord(payload)) return null;
  const key = readString(payload.key);
  const mode = readString(payload.mode);
  if (!key || !mode) return null;

  return {
    key,
    mode,
    ok: payload.ok === true,
    ...(readNullableString(payload.error) ? { error: readNullableString(payload.error) ?? undefined } : {}),
    ...(readNullableString(payload.warning) ? { warning: readNullableString(payload.warning) ?? undefined } : {}),
    ...(readNullableString(payload.note) ? { note: readNullableString(payload.note) ?? undefined } : {}),
  };
}

function normalizeSetupMutationResult(
  payload: unknown,
): { ok: boolean; saved?: string[]; error?: string } | null {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") return null;
  if (
    payload.saved !== undefined
    && (!Array.isArray(payload.saved) || payload.saved.some((value) => typeof value !== "string"))
  ) {
    return null;
  }
  return {
    ok: payload.ok,
    ...(Array.isArray(payload.saved) ? { saved: normalizeStringArray(payload.saved) } : {}),
    ...(readString(payload.error) ? { error: readString(payload.error) ?? undefined } : {}),
  };
}

function normalizeUpdateApplyResult(payload: unknown): UpdateApplyResult | null {
  if (!isRecord(payload)) return null;
  const expectedSourceId = readString(payload.expectedSourceId);
  if (payload.ok === true && payload.status === "queued") {
    const commitSha = readString(payload.commitSha);
    return expectedSourceId && commitSha
      ? { ok: true, status: "queued", expectedSourceId, commitSha }
      : null;
  }
  if (payload.ok === true && payload.status === "noop") {
    return expectedSourceId
      ? { ok: true, status: "noop", expectedSourceId }
      : null;
  }
  const failureStatus = payload.status === "hub_repo_not_configured"
    || payload.status === "not_a_tiller_hub_repo"
    || payload.status === "managed_files_removed"
    || payload.status === "advanced_repair_required"
    || payload.status === "update_branch_moved"
    || payload.status === "direct_update_rejected"
    ? payload.status
    : null;
  const error = readString(payload.error);
  if (payload.ok !== false || !failureStatus || !error) return null;
  return {
    ok: false,
    status: failureStatus,
    error,
    ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
    ...(Array.isArray(payload.missingManagedFiles)
      && payload.missingManagedFiles.every((value) => typeof value === "string")
      ? { missingManagedFiles: normalizeStringArray(payload.missingManagedFiles) }
      : {}),
  };
}

function normalizeCodexRouteStatus(value: unknown): SetupStatus["codexRouteStatus"] {
  return isCodexRouteStatus(value)
    ? value
    : "unavailable";
}

function isCodexRouteStatus(value: unknown): value is SetupStatus["codexRouteStatus"] {
  return value === "available"
    || value === "backend_offline"
    || value === "runtime_update_required"
    || value === "environment_not_connected"
    || value === "authentication_unavailable"
    || value === "direct_api"
    || value === "unavailable";
}

function normalizeUpdateMetadata(payload: unknown): TillerUpdateMetadata | null {
  if (!isRecord(payload)) return null;
  if (
    payload.schemaVersion !== 1 ||
    payload.channel !== "deploy-button" ||
    payload.updateMode !== "full-source" ||
    payload.sourceRepo !== "paperwing-dev/tiller-hub"
  ) {
    return null;
  }
  const sourceId = readString(payload.sourceId);
  const version = readString(payload.version);
  const label = readString(payload.label);
  const managedFiles = normalizeStringArray(payload.managedFiles);
  if (!sourceId || !version || !label || managedFiles.length === 0) return null;
  const selfHostRuntime = isRecord(payload.selfHostRuntime)
    && typeof payload.selfHostRuntime.imageSourceId === "string"
    && typeof payload.selfHostRuntime.sandboxImage === "string"
    ? {
        imageSourceId: payload.selfHostRuntime.imageSourceId,
        sandboxImage: payload.selfHostRuntime.sandboxImage,
      }
    : null;
  return {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId,
    version,
    label,
    managedFiles,
    ...(selfHostRuntime ? { selfHostRuntime } : {}),
  };
}

function normalizeHubUpdateRepoCandidate(payload: unknown): HubUpdateRepoCandidate | null {
  if (!isRecord(payload)) return null;
  const owner = readString(payload.owner);
  const repo = readString(payload.repo);
  const fullName = readString(payload.fullName);
  const label = readString(payload.label);
  const branch = readString(payload.branch);
  const sourceId = readString(payload.sourceId);
  const repoId = readIntegerOr(payload.repoId, 0);
  const installationId = readIntegerOr(payload.installationId, 0);
  if (!owner || !repo || !fullName || !label || !branch || !sourceId || repoId <= 0 || installationId <= 0) return null;
  return {
    owner,
    repo,
    fullName,
    label,
    repoId,
    installationId,
    branch,
    private: readBooleanOr(payload.private, false),
    defaultBranch: readNullableString(payload.defaultBranch),
    sourceId,
  };
}

function normalizeHubUpdateRepoState(payload: unknown): HubUpdateRepoState {
  if (!isRecord(payload)) {
    return { status: "not_checked", lastDetectedAt: null };
  }
  if (payload.status === "detected") {
    const owner = readString(payload.owner);
    const repo = readString(payload.repo);
    const fullName = readString(payload.fullName);
    const label = readString(payload.label);
    const branch = readString(payload.branch);
    const lastDetectedAt = readString(payload.lastDetectedAt);
    const repoId = readIntegerOr(payload.repoId, 0);
    const installationId = readIntegerOr(payload.installationId, 0);
    if (owner && repo && fullName && label && branch && lastDetectedAt && repoId > 0 && installationId > 0) {
      return {
        status: "detected",
        owner,
        repo,
        fullName,
        label,
        repoId,
        installationId,
        branch,
        lastDetectedAt,
        detectedBy: payload.detectedBy === "manual" || payload.detectedBy === "selection" ? payload.detectedBy : "auto",
      };
    }
  }
  if (payload.status === "missing") {
    return {
      status: "missing",
      lastDetectedAt: readNullableString(payload.lastDetectedAt),
      visibleGitHubOwners: normalizeStringArray(payload.visibleGitHubOwners),
    };
  }
  if (payload.status === "ambiguous") {
    return {
      status: "ambiguous",
      lastDetectedAt: readStringOr(payload.lastDetectedAt, ""),
      candidates: normalizeArrayResponse(payload.candidates)
        .map(normalizeHubUpdateRepoCandidate)
        .filter(isPresent),
    };
  }
  return { status: "not_checked", lastDetectedAt: null };
}

function normalizeBuildDiagnostics(payload: unknown): UpdateBuildDiagnostics {
  if (!isRecord(payload)) {
    return {
      channel: "release",
      version: "",
      workersCiCommitSha: null,
      workersCiBranch: null,
    };
  }

  return {
    channel: payload.channel === "development" ? "development" : "release",
    version: readStringOr(payload.version, ""),
    workersCiCommitSha: readNullableString(payload.workersCiCommitSha),
    workersCiBranch: readNullableString(payload.workersCiBranch),
  };
}

function normalizeUpdateCheckResult(payload: unknown): UpdateCheckResult | null {
  if (!isRecord(payload)) return null;
  const currentUpdate = normalizeUpdateMetadata(payload.currentUpdate);
  if (typeof payload.updateAvailable !== "boolean" || !currentUpdate) {
    return null;
  }

  const issue = isRecord(payload.issue) && readString(payload.issue.code) && readString(payload.issue.message)
    ? {
        code: readString(payload.issue.code) as NonNullable<UpdateCheckResult["issue"]>["code"],
        message: readString(payload.issue.message) ?? "",
        retryable: readBooleanOr(payload.issue.retryable, false),
      }
    : null;
  const common = {
    updateAvailable: payload.updateAvailable,
    currentUpdate,
    buildDiagnostics: normalizeBuildDiagnostics(payload.buildDiagnostics),
    ...(issue ? { issue } : {}),
  };

  if (payload.kind === "installer-maintenance") {
    const installedReleaseId = readString(payload.installedReleaseId);
    let stableRelease: StableReleaseSummary | null = null;
    if (payload.stableRelease !== null) {
      if (!isRecord(payload.stableRelease)) return null;
      const releaseId = readString(payload.stableRelease.releaseId);
      const version = readString(payload.stableRelease.version);
      const releaseNotesUrl = readString(payload.stableRelease.releaseNotesUrl);
      if (!releaseId || !version || !releaseNotesUrl) return null;
      stableRelease = { releaseId, version, releaseNotesUrl };
    }
    if (!installedReleaseId) return null;
    return {
      kind: "installer-maintenance",
      ...common,
      installedReleaseId,
      stableRelease,
    } satisfies InstallerMaintenanceUpdateCheckResult;
  }

  if (payload.kind !== "legacy") return null;
  const latestUpdate = normalizeUpdateMetadata(payload.latestUpdate);
  const releaseNotesUrl = readString(payload.releaseNotesUrl);
  if (!latestUpdate || !releaseNotesUrl) return null;
  return {
    kind: "legacy",
    ...common,
    latestUpdate,
    hubRepo: normalizeHubUpdateRepoState(payload.hubRepo),
    updateMethod: payload.updateMethod === "github_repo" || payload.updateMethod === "connect_hub_repo" || payload.updateMethod === "advanced_repair"
      ? payload.updateMethod
      : "advanced_repair",
    releaseNotesUrl,
  } satisfies LegacyUpdateCheckResult;
}

export class ApiAuthenticationError extends Error {
  readonly status: number | null;

  constructor(message = "Browser authentication is required.", status: number | null = null) {
    super(message);
    this.name = "ApiAuthenticationError";
    this.status = status;
  }
}

export function isApiAuthenticationError(error: unknown): error is ApiAuthenticationError {
  return error instanceof ApiAuthenticationError;
}

export class ApiActionError extends Error {
  readonly code?: string;
  readonly hint?: string;
  readonly missingPermissions: string[];

  constructor(body: { error?: string; code?: string; hint?: string; missingPermissions?: string[] }, fallback: string) {
    super(body.error || fallback);
    this.name = "ApiActionError";
    this.code = body.code;
    this.hint = body.hint;
    this.missingPermissions = Array.isArray(body.missingPermissions) ? body.missingPermissions : [];
  }
}

export type {
  HubUpdateRepoCandidate,
  HubUpdateRepoState,
  InstallerMaintenanceUpdateCheckResult,
  LegacyUpdateCheckResult,
  StableReleaseSummary,
  TillerUpdateMetadata,
  UpdateApplyResult,
  UpdateBuildDiagnostics,
  UpdateCheckResult,
} from "../api/update/types";
export type {
  Artifact,
  ArtifactRef,
  PlanArtifact,
  PlanContribution,
  PlannerEffort,
  PlannerProviderMetadata,
  PlannerRun,
  PlannerRunEvent,
  PlanStatus,
  ReviewerRegistryEntry,
  ThreadMessage,
} from "../api/coordination/types";
export type {
  EnvReviewFeedback,
  EnvReviewRun,
  EnvReviewRunEvent,
  EnvReviewSession,
  EnvReviewState,
  EnvReviewTab,
} from "../api/env-review/types";

function normalizeRepoArtifactState(
  payload: unknown,
): { artifacts: Artifact[]; refs: ArtifactRef[] } {
  if (!isRecord(payload)) {
    return {
      artifacts: [],
      refs: [],
    };
  }

  return {
    artifacts: normalizeArrayResponse(payload.artifacts)
      .map((artifact) => normalizeArtifact(artifact))
      .filter(isPresent),
    refs: normalizeArrayResponse(payload.refs)
      .map((ref) => normalizeArtifactRef(ref))
      .filter(isPresent),
  };
}

const SETUP_BOOLEAN_FIELDS = [
  "needsSetup",
  "isLocalDev",
  "installerManaged",
  "modelAuthConfigured",
  "workersAiConfigured",
  "hasClaudeSubscription",
  "hasAnthropicKey",
  "hasChatGPTAuth",
  "hasOpenAIKey",
  "openaiPlannerConfigured",
  "openaiPlannerAvailable",
  "hostRegistered",
  "renewalRecommended",
  "hostConnected",
  "githubAppAvailable",
  "githubAppConfigured",
  "githubAppReady",
  "githubAppPublicHubDisabled",
] as const;

const SETUP_STATUS_KEYS = [
  ...SETUP_BOOLEAN_FIELDS,
  "setupPhase",
  "workersDevHubUrl",
  "installationRegion",
  "claudeBillingMode",
  "openaiBillingMode",
  "chatgptAuthStatus",
  "codexRouteStatus",
  "openaiPlannerRoute",
  "openaiPlannerReason",
  "codexBackendReadiness",
  "enabledHarnesses",
  "protectionMode",
  "tokenExpiresAt",
  "idleTimeoutMinutes",
  "githubAppSlug",
  "githubAppInstallUrl",
  "githubAppManageUrl",
  "buildDiagnostics",
  "selfUpdateRepo",
  "dashboardOnboarding",
] as const;

function isNullableSetupString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function assertCurrentSetupStatusPayload(payload: Record<string, unknown>): void {
  if (Object.keys(payload).sort().join(",") !== [...SETUP_STATUS_KEYS].sort().join(",")) {
    throw new Error("Malformed setup status: exact current setup schema is required.");
  }
  for (const field of SETUP_BOOLEAN_FIELDS) {
    if (typeof payload[field] !== "boolean") {
      throw new Error(`Malformed setup status: ${field} must be boolean.`);
    }
  }
  if (
    (
      payload.setupPhase !== "github-app"
      && payload.setupPhase !== "complete"
    )
    || payload.needsSetup !== (payload.setupPhase !== "complete")
    || (payload.protectionMode !== "public" && payload.protectionMode !== "cf-access")
    || !Array.isArray(payload.enabledHarnesses)
    || payload.enabledHarnesses.length === 0
    || payload.enabledHarnesses.some((value) =>
      value !== "claude-code" && value !== "codex" && value !== "opencode"
    )
    || !isCloudflareIdleTimeoutMinutes(payload.idleTimeoutMinutes)
    || (payload.installationRegion !== null && !isPlacementRegion(payload.installationRegion))
    || typeof payload.githubAppManageUrl !== "string"
    || !isRecord(payload.codexBackendReadiness)
    || !isCodexRouteStatus(payload.codexRouteStatus)
    || !isCodexRouteStatus(payload.codexBackendReadiness.cf)
    || !isCodexRouteStatus(payload.codexBackendReadiness.host)
    || !isRecord(payload.buildDiagnostics)
    || !isRecord(payload.selfUpdateRepo)
    || !isRecord(payload.dashboardOnboarding)
    || typeof payload.dashboardOnboarding.dismissed !== "boolean"
    || typeof payload.dashboardOnboarding.executionReady !== "boolean"
  ) {
    throw new Error("Malformed setup status: current setup schema is required.");
  }
  for (const field of [
    "workersDevHubUrl",
    "tokenExpiresAt",
    "openaiPlannerReason",
    "githubAppSlug",
    "githubAppInstallUrl",
  ] as const) {
    if (!isNullableSetupString(payload[field])) {
      throw new Error(`Malformed setup status: ${field} must be a string or null.`);
    }
  }
  if (
    (payload.claudeBillingMode !== null
      && payload.claudeBillingMode !== "subscription"
      && payload.claudeBillingMode !== "api")
    || (payload.openaiBillingMode !== null
      && payload.openaiBillingMode !== "subscription"
      && payload.openaiBillingMode !== "api")
    || (
      payload.chatgptAuthStatus !== "missing"
      && payload.chatgptAuthStatus !== "connected"
      && payload.chatgptAuthStatus !== "refreshing"
      && payload.chatgptAuthStatus !== "needs_reconnect"
      && payload.chatgptAuthStatus !== "temporarily_unavailable"
    )
    || (
      payload.openaiPlannerRoute !== null
      && payload.openaiPlannerRoute !== "api-key"
      && payload.openaiPlannerRoute !== "subscription-app-server"
    )
  ) {
    throw new Error("Malformed setup status: current setup enum values are required.");
  }
}

function normalizeSetupStatus(payload: unknown): SetupStatus {
  if (!isRecord(payload)) {
    throw new Error("Malformed setup status: expected an object.");
  }

  assertCurrentSetupStatusPayload(payload);
  const current = payload as unknown as SetupStatus;
  return {
    ...current,
    enabledHarnesses: [...current.enabledHarnesses],
    codexBackendReadiness: { ...current.codexBackendReadiness },
    buildDiagnostics: normalizeBuildDiagnostics(payload.buildDiagnostics),
    selfUpdateRepo: normalizeHubUpdateRepoState(payload.selfUpdateRepo),
    dashboardOnboarding: {
      dismissed: current.dashboardOnboarding.dismissed,
      executionReady: current.dashboardOnboarding.executionReady,
    },
  };
}

function normalizeWsServerMessage(payload: unknown): WsServerMessage | null {
  if (!isRecord(payload) || typeof payload.type !== "string") return null;

  switch (payload.type) {
    case "pong":
      return { type: "pong" };
    case "capabilities":
      return {
        type: "capabilities",
        terminalFastLane: readBooleanOr(payload.terminalFastLane),
      };
    case "error": {
      const message = readString(payload.message);
      return message ? { type: "error", message } : null;
    }
    case "terminal-input-ack": {
      const sessionId = readString(payload.sessionId);
      const clientId = readString(payload.clientId);
      const inputSeq = readIntegerOr(payload.inputSeq, 0);
      if (!sessionId || !clientId || inputSeq <= 0) return null;
      return {
        type: "terminal-input-ack",
        sessionId,
        clientId,
        inputSeq,
        ok: readBooleanOr(payload.ok),
        ...(readNullableString(payload.error) ? { error: readNullableString(payload.error) ?? undefined } : {}),
      };
    }
    case "terminal-control-ack": {
      const sessionId = readString(payload.sessionId);
      const clientId = readString(payload.clientId);
      const controlSeq = readIntegerOr(payload.controlSeq, 0);
      if (!sessionId || !clientId || controlSeq <= 0) return null;
      return {
        type: "terminal-control-ack",
        sessionId,
        clientId,
        controlSeq,
        ok: readBooleanOr(payload.ok),
        ...(readNullableString(payload.error) ? { error: readNullableString(payload.error) ?? undefined } : {}),
      };
    }
    case "message-received": {
      const id = readString(payload.id);
      const sessionId = readString(payload.sessionId);
      if (!id || !sessionId) return null;
      return {
        type: "message-received",
        id,
        sessionId,
        content: payload.content,
        seq: readIntegerOr(payload.seq, 0),
        ...(readNullableString(payload.localId) ? { localId: readNullableString(payload.localId) ?? undefined } : {}),
      };
    }
    case "session-updated": {
      const session = normalizeStoredSession(payload.session);
      return session ? { type: "session-updated", session } : null;
    }
    case "session-deleted": {
      const sessionId = readString(payload.sessionId);
      return sessionId ? { type: "session-deleted", sessionId } : null;
    }
    case "machine-updated": {
      const machine = normalizeStoredMachine(payload.machine);
      return machine ? { type: "machine-updated", machine } : null;
    }
    case "replay":
      return {
        type: "replay",
        events: normalizeArrayResponse(payload.events)
          .map((event) => normalizeWsServerMessage(event))
          .filter(isPresent),
      };
    case "permission-created": {
      const permission = normalizeStoredPermission(payload.permission);
      return permission ? { type: "permission-created", permission } : null;
    }
    case "permission-resolved": {
      const permission = normalizeStoredPermission(payload.permission);
      return permission ? { type: "permission-resolved", permission } : null;
    }
    case "env-upsert": {
      const env = normalizeEnvMetaObject(payload.env);
      return env ? { type: "env-upsert", env } : null;
    }
    case "env-remove": {
      const slug = readString(payload.slug);
      return slug ? { type: "env-remove", slug } : null;
    }
    case "repo-upsert": {
      const repo = normalizeRepoMetaObject(payload.repo);
      return repo ? { type: "repo-upsert", repo } : null;
    }
    case "repo-remove": {
      const repoId = readString(payload.repoId);
      return repoId ? { type: "repo-remove", repoId } : null;
    }
    case "plan-artifact-updated":
    case "plan-writer-state": {
      const repoId = readString(payload.repoId);
      const planArtifactId = readString(payload.planArtifactId);
      return repoId && planArtifactId ? { type: payload.type, repoId, planArtifactId } : null;
    }
    case "repo-main-changed": {
      const repoId = readString(payload.repoId);
      const repoUrl = readString(payload.repoUrl);
      if (!repoId || !repoUrl) return null;
      return {
        type: "repo-main-changed",
        repoId,
        repoUrl,
        previousMainCommit: readNullableString(payload.previousMainCommit),
        currentMainCommit: readNullableString(payload.currentMainCommit),
        ...(readNullableString(payload.sourceEnvSlug) ? { sourceEnvSlug: readNullableString(payload.sourceEnvSlug) } : {}),
      };
    }
    default:
      return null;
  }
}

function buildApiActionError(
  body: { error?: string; code?: string; hint?: string; missingPermissions?: string[] },
  fallback: string,
): ApiActionError {
  return new ApiActionError(body, fallback);
}

async function parseApiError(
  res: Response,
  fallback: string,
): Promise<Error> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await res.json().catch(() => null);
    if (isRecord(body)) {
      return buildApiActionError({
        error: readString(body.error) ?? undefined,
        code: readString(body.code) ?? undefined,
        hint: readString(body.hint) ?? undefined,
        missingPermissions: Array.isArray(body.missingPermissions)
          ? body.missingPermissions.filter((value): value is string => typeof value === "string")
          : undefined,
      }, fallback);
    }
  }
  const text = (await res.text().catch(() => "")).trim();
  return new Error(text || fallback);
}

// ── REST helpers ──────────────────────────────────────────────────

async function readJsonWithinLimit(
  response: Response,
  maxBytes: number,
  onBytes: (receivedBytes: number) => void,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new TerminalRecoveryOverflowError();
  }

  if (!response.body) {
    const text = await response.text();
    const receivedBytes = new TextEncoder().encode(text).byteLength;
    if (receivedBytes > maxBytes) {
      throw new TerminalRecoveryOverflowError();
    }
    onBytes(receivedBytes);
    return JSON.parse(text);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new TerminalRecoveryOverflowError();
      }
      onBytes(totalBytes);
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const payload = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(payload));
}

export async function fetchSessions(hubUrl: string): Promise<StoredSession[]> {
  const res = await fetch(`${hubUrl}/api/sessions`, {
    headers: { Accept: "application/json" },
    credentials: "include",
    cache: "no-store",
    redirect: "manual",
  });
  await throwIfBrowserAuthenticationRequired(res);
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return normalizeArrayResponse(await res.json().catch(() => null))
    .map((session) => normalizeStoredSession(session))
    .filter(isPresent);
}

export async function fetchMessages(
  hubUrl: string,
  sessionId: string,
  opts: {
    limit?: number;
    beforeSeq?: number;
    afterSeq?: number;
    maxBytes: number;
    signal: AbortSignal;
    onBytes(receivedBytes: number): void;
  },
): Promise<Array<{
  id: string;
  session_id: string;
  content: unknown;
  seq: number;
  local_id: string | null;
  created_at: string;
}>> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.beforeSeq != null) params.set("before_seq", String(opts.beforeSeq));
  if (opts.afterSeq != null) params.set("after_seq", String(opts.afterSeq));
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/messages${qs}`, {
    credentials: "include",
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
  const payload = await readJsonWithinLimit(res, opts.maxBytes, opts.onBytes);
  if (!Array.isArray(payload)) throw new Error("Invalid terminal history response");
  return payload.map((message) => {
    if (
      !isRecord(message) ||
      typeof message.id !== "string" ||
      message.id.length === 0 ||
      message.session_id !== sessionId ||
      typeof message.content !== "string" ||
      !Number.isInteger(message.seq) ||
      (message.seq as number) < 1 ||
      !("local_id" in message) ||
      (message.local_id !== null && typeof message.local_id !== "string") ||
      typeof message.created_at !== "string"
    ) {
      throw new Error("Invalid terminal history response");
    }
    let content: unknown;
    try {
      content = JSON.parse(message.content);
    } catch {
      throw new Error("Invalid terminal history response");
    }
    return {
      id: message.id,
      session_id: message.session_id,
      content,
      seq: message.seq as number,
      local_id: message.local_id ?? null,
      created_at: message.created_at,
    };
  });
}

export async function fetchPendingPermissions(hubUrl: string, sessionId: string): Promise<StoredPermission[]> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch permissions: ${res.status}`);
  return normalizeArrayResponse(await res.json().catch(() => null))
    .map((permission) => normalizeStoredPermission(permission))
    .filter(isPresent);
}

export async function resolvePermission(
  hubUrl: string,
  sessionId: string,
  permId: string,
  status: string,
  allowForSession = false,
): Promise<StoredPermission> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions/${permId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status, allow_for_session: allowForSession }),
  });
  if (!res.ok) throw new Error(`Failed to resolve permission: ${res.status}`);
  const permission = normalizeStoredPermission(await res.json().catch(() => null));
  if (!permission) {
    throw new Error("Malformed permission response");
  }
  return permission;
}

// ── Environment (sandbox) helpers ─────────────────────────────────

export type { CodexAuthPreference, EnvHarness, EnvMeta, RepoMeta, StartupDiagnosticsState } from "../api/types";

export type StartupPlanSelection =
  | { mode: "todo" }
  | { mode: "specific"; artifactId: string }
  | { mode: "none" };

export async function fetchEnvs(hubUrl: string): Promise<EnvMeta[]> {
  const res = await fetch(`${hubUrl}/api/envs`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch envs: ${res.status}`);
  return normalizeStrictArrayResponse(
    await res.json().catch(() => null),
    normalizeEnvMetaObject,
    "Malformed env response",
  );
}

export async function fetchEnv(hubUrl: string, slug: string): Promise<EnvMeta> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch env: ${res.status}`);
  const env = normalizeEnvMetaObject(await res.json().catch(() => null));
  if (!env) {
    throw new Error("Malformed env response");
  }
  return env;
}

export async function fetchEnvStartupDiagnostics(
  hubUrl: string,
  slug: string,
): Promise<StartupDiagnosticsState> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/startup-diagnostics`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch startup diagnostics: ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!isRecord(body)) {
    return { active: null, lastFailed: null };
  }
  return {
    active: isRecord(body.active) ? body.active as unknown as StartupDiagnosticsState["active"] : null,
    lastFailed: isRecord(body.lastFailed) ? body.lastFailed as unknown as StartupDiagnosticsState["lastFailed"] : null,
  };
}

export interface CreateEnvOptions {
  harness: EnvHarness;
  planSelection?: StartupPlanSelection;
  harnessSettings?: HarnessSettings;
  schedule?: { runAtMs: number; timeZone: string };
}

export async function createEnv(
  hubUrl: string,
  repoId: string,
  options: CreateEnvOptions,
): Promise<EnvMeta> {
  const {
    harness,
    planSelection,
    harnessSettings,
    schedule,
  } = options;
  const res = await fetch(`${hubUrl}/api/envs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ repoId, harness, planSelection, harnessSettings, schedule }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as { error?: string };
    throw new Error(body.error || `Failed to create env: ${res.status}`);
  }
  const env = normalizeEnvMetaObject(await res.json().catch(() => null));
  if (!env) {
    throw new Error("Malformed env response");
  }
  return env;
}

export async function cancelScheduledRun(hubUrl: string, slug: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/scheduled-run/cancel`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to cancel Scheduled Run: ${res.status}`);
}

export async function startEnv(
  hubUrl: string,
  slug: string,
  options?: { harnessSettings?: HarnessSettings },
): Promise<{ ok: boolean; slug: string; status: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to start env: ${res.status}`);
  const body = await res.json().catch(() => null);
  return {
    ok: isRecord(body) ? readBooleanOr(body.ok, true) : true,
    slug: isRecord(body) ? readStringOr(body.slug, slug) : slug,
    status: isRecord(body) ? readStringOr(body.status, "starting") : "starting",
  };
}

export async function stopEnv(hubUrl: string, slug: string): Promise<{ ok: boolean; slug: string; status: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/stop`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to stop env: ${res.status}`);
  const body = await res.json().catch(() => null);
  return {
    ok: isRecord(body) ? readBooleanOr(body.ok, true) : true,
    slug: isRecord(body) ? readStringOr(body.slug, slug) : slug,
    status: isRecord(body) ? readStringOr(body.status, "saving") : "saving",
  };
}

export async function publishEnvDraftPr(
  hubUrl: string,
  slug: string,
): Promise<{
  ok: boolean;
  slug: string;
  operationId?: string;
  pending?: boolean;
  noChanges?: boolean;
  branch?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
}> {
  const res = await fetch(`${hubUrl}/api/envs/${encodeURIComponent(slug)}/github/publish-draft-pr`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Publish Draft PR failed: ${res.status}`);
  return res.json();
}

export type EnvChangeStatus = "added" | "modified" | "deleted";

export interface EnvChangeEntry {
  path: string;
  status: EnvChangeStatus;
  oldSize: number | null;
  newSize: number | null;
  oldHash: string | null;
  newHash: string | null;
  previewableHint?: "unknown" | "text" | "binary" | "too-large";
}

export interface EnvChangesResponse {
  slug: string;
  repoId: string;
  repoUrl: string;
  comparisonBasis: "draft-pr-diff";
  oldCommit: string | null;
  newBaseCommit: string | null;
  branchStatus: "ready-to-merge" | "up-to-date" | "behind-main" | "needs-attention";
  summary: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
  };
  files: EnvChangeEntry[];
}

export interface EnvChangeFileResponse {
  path: string;
  status: EnvChangeStatus;
  previewable: boolean;
  reason?: "binary" | "too-large" | "not-found";
  maxPreviewBytes: number;
  oldString: string;
  newString: string;
  oldSize: number | null;
  newSize: number | null;
}

export async function fetchEnvChanges(hubUrl: string, slug: string): Promise<EnvChangesResponse> {
  const res = await fetch(`${hubUrl}/api/envs/${encodeURIComponent(slug)}/changes`, {
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to load draft diff: ${res.status}`);
  return res.json();
}

export async function fetchEnvChangeFile(
  hubUrl: string,
  slug: string,
  path: string,
): Promise<EnvChangeFileResponse> {
  const url = new URL(`${hubUrl}/api/envs/${encodeURIComponent(slug)}/changes/file`);
  url.searchParams.set("path", path);
  const res = await fetch(url.toString(), {
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to load file diff: ${res.status}`);
  return res.json();
}

export async function resetEnvToRepo(
  hubUrl: string,
  slug: string,
): Promise<{ ok: boolean; slug: string; repoId: string; currentMainCommit: string | null }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/reset-to-repo`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to reset env to repo: ${res.status}`);
  return res.json();
}

export async function deleteEnv(hubUrl: string, slug: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to delete env: ${res.status}`);
}

export async function deleteRepo(
  hubUrl: string,
  repoId: string,
): Promise<{ ok: true; repoId: string; deletedEnvSlugs: string[] }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(readErrorMessage(body) || `Failed to delete repo: ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  return {
    ok: true,
    repoId: isRecord(body) ? readStringOr(body.repoId, repoId) : repoId,
    deletedEnvSlugs: isRecord(body)
      ? normalizeArrayResponse(body.deletedEnvSlugs).filter((candidate): candidate is string => typeof candidate === "string")
      : [],
  };
}

export async function fetchRepoArtifacts(
  hubUrl: string,
  repoId: string,
): Promise<{ artifacts: Artifact[]; refs: ArtifactRef[] }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/artifacts`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch artifacts: ${res.status}`);
  return normalizeRepoArtifactState(await res.json().catch(() => null));
}

export async function fetchPlannerProviders(
  hubUrl: string,
  repoId: string,
): Promise<{ providers: PlannerProviderMetadata[]; skillRoutes: AgentRoute[] }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/planner-providers`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch planner providers: ${res.status}`);
  const body = await res.json().catch(() => null);
  return {
    providers: isRecord(body)
      ? normalizeArrayResponse(body.providers).map(normalizePlannerProvider).filter(isPresent)
      : [],
    skillRoutes: isRecord(body)
      ? normalizeArrayResponse(body.skillRoutes).map(normalizeAgentRoute).filter(isPresent)
      : [],
  };
}

export async function fetchEnvReviewState(
  hubUrl: string,
  envSlug: string,
  sessionId: string,
): Promise<EnvReviewState> {
  const params = new URLSearchParams({ sessionId });
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch env review state: ${res.status}`);
  return normalizeEnvReviewState(await res.json().catch(() => null));
}

export async function addEnvReviewer(
  hubUrl: string,
  envSlug: string,
  input: { sessionId: string; provider: string; model: string; effort?: PlannerEffort },
): Promise<EnvReviewState> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/tabs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to add env reviewer: ${res.status}`);
  return normalizeEnvReviewState(await res.json().catch(() => null));
}

export async function removeEnvReviewer(
  hubUrl: string,
  envSlug: string,
  threadId: string,
  sessionId: string,
): Promise<EnvReviewState> {
  const params = new URLSearchParams({ sessionId });
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/tabs/${encodeURIComponent(threadId)}?${params}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to remove env reviewer: ${res.status}`);
  return normalizeEnvReviewState(await res.json().catch(() => null));
}

export async function cancelEnvReviewRun(
  hubUrl: string,
  envSlug: string,
  runId: string,
  input: { sessionId: string },
): Promise<EnvReviewState> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to cancel env review: ${res.status}`);
  return normalizeEnvReviewState(await res.json().catch(() => null));
}

export async function fetchEnvReviewMessages(
  hubUrl: string,
  envSlug: string,
  threadId: string,
  sessionId: string,
): Promise<ThreadMessage[]> {
  const params = new URLSearchParams({ sessionId });
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/tabs/${encodeURIComponent(threadId)}/messages?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch env reviewer messages: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body)
    ? normalizeArrayResponse(body.messages).map(normalizeThreadMessage).filter(isPresent)
    : [];
}

export async function sendEnvReviewMessage(
  hubUrl: string,
  envSlug: string,
  threadId: string,
  input: { sessionId: string; text: string },
): Promise<{ run: EnvReviewRun | null; messages: ThreadMessage[]; state: EnvReviewState }> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/tabs/${encodeURIComponent(threadId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to send env reviewer message: ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!isRecord(body)) throw new Error("Malformed env reviewer message response");
  return {
    run: normalizeEnvReviewRun(body.run),
    messages: normalizeArrayResponse(body.messages).map(normalizeThreadMessage).filter(isPresent),
    state: normalizeEnvReviewState(body.state),
  };
}

export async function fetchEnvReviewRun(
  hubUrl: string,
  envSlug: string,
  runId: string,
  sessionId: string,
  afterSeq?: number,
): Promise<{ run: EnvReviewRun; events: EnvReviewRunEvent[] }> {
  const params = new URLSearchParams({ sessionId });
  if (afterSeq != null) params.set("afterSeq", String(afterSeq));
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/runs/${encodeURIComponent(runId)}?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch env review run: ${res.status}`);
  const body = await res.json().catch(() => null);
  const run = isRecord(body) ? normalizeEnvReviewRun(body.run) : null;
  if (!run) throw new Error("Malformed env review run response");
  return {
    run,
    events: isRecord(body)
      ? normalizeArrayResponse(body.events).map(normalizeEnvReviewRunEvent).filter(isPresent)
      : [],
  };
}

export interface ReviewSkillInvocationDetail {
  invocation: ReviewSkillInvocation;
  tabs: EnvReviewTab[];
  runs: EnvReviewRun[];
}

export async function invokeReviewSkill(
  hubUrl: string,
  envSlug: string,
  parentThreadId: string,
  skillId: string,
  input: { sessionId: string; requestId: string; overviewMode?: "auto" | "manual" },
): Promise<{ kind: "preset"; run: EnvReviewRun } | ({ kind: "fanout" } & ReviewSkillInvocationDetail)> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/tabs/${encodeURIComponent(parentThreadId)}/skills/${encodeURIComponent(skillId)}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to invoke Review skill: ${res.status}`);
  return await res.json() as any;
}

export async function fetchReviewSkillInvocations(
  hubUrl: string,
  envSlug: string,
  sessionId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ invocations: Array<Record<string, unknown>>; nextCursor: string | null }> {
  const params = new URLSearchParams({ sessionId });
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/skill-invocations?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch Review skill history: ${res.status}`);
  return await res.json() as any;
}

export async function fetchReviewSkillInvocation(
  hubUrl: string,
  envSlug: string,
  sessionId: string,
  invocationId: string,
): Promise<ReviewSkillInvocationDetail> {
  const params = new URLSearchParams({ sessionId });
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/skill-invocations/${encodeURIComponent(invocationId)}?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch Review skill invocation: ${res.status}`);
  return await res.json() as ReviewSkillInvocationDetail;
}

export async function updateReviewSkillControls(
  hubUrl: string,
  envSlug: string,
  invocationId: string,
  input: { sessionId: string; overviewMode: "auto" | "manual"; includedMessageIds: string[] },
): Promise<ReviewSkillInvocation> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/skill-invocations/${encodeURIComponent(invocationId)}/controls`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to update Overview controls: ${res.status}`);
  const body = await res.json() as { invocation: ReviewSkillInvocation };
  return body.invocation;
}

export async function sendReviewSkillOverview(
  hubUrl: string,
  envSlug: string,
  invocationId: string,
  input: { sessionId: string; guidance?: string | null },
): Promise<Record<string, unknown>> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/skill-invocations/${encodeURIComponent(invocationId)}/overview`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to send Review Overview: ${res.status}`);
  return await res.json() as Record<string, unknown>;
}

export async function cancelReviewSkillInvocation(
  hubUrl: string,
  envSlug: string,
  invocationId: string,
  sessionId: string,
): Promise<ReviewSkillInvocation> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/skill-invocations/${encodeURIComponent(invocationId)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to cancel Review skill invocation: ${res.status}`);
  const body = await res.json() as { invocation: ReviewSkillInvocation };
  return body.invocation;
}

export async function markEnvReviewFeedback(
  hubUrl: string,
  envSlug: string,
  feedbackId: string,
  status: "pending" | "sent" | "dismiss",
  input: { sessionId: string; deliveredText?: string | null },
): Promise<EnvReviewFeedback> {
  const res = await fetch(`${hubUrl}/api/envs/${envSlug}/review/feedback/${encodeURIComponent(feedbackId)}/${status}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to update env review feedback: ${res.status}`);
  const body = await res.json().catch(() => null);
  const feedback = isRecord(body) ? normalizeEnvReviewFeedback(body.feedback) : null;
  if (!feedback) throw new Error("Malformed env review feedback response");
  return feedback;
}

export async function createPlan(
  hubUrl: string,
  repoId: string,
  title?: string,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to create plan: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed plan response");
  }
  return artifact;
}

export async function savePlan(
  hubUrl: string,
  repoId: string,
  id: string,
  markdown: string,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to save plan: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed save plan response");
  }
  return artifact;
}

export async function updatePlanStatus(
  hubUrl: string,
  repoId: string,
  id: string,
  status: PlanStatus,
  expectedVersion?: number | null,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/artifacts/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status, expectedVersion }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to update plan status: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed plan status response");
  }
  return artifact;
}

export async function discardPlan(
  hubUrl: string,
  repoId: string,
  id: string,
  expectedVersion?: number | null,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ expectedVersion }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to discard plan: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed discard plan response");
  }
  return artifact;
}

export async function fetchPlanContributions(
  hubUrl: string,
  repoId: string,
  artifactId: string,
): Promise<PlanContribution[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/contributions`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch contributions: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body)
    ? normalizeArrayResponse(body.contributions).map(normalizePlanContribution).filter(isPresent)
    : [];
}

function normalizePlanWriterState(payload: unknown): PlanWriterState | null {
  if (!isRecord(payload)) return null;
  const lifecycle = payload.lifecycle === "not_running" || payload.lifecycle === "starting" || payload.lifecycle === "running"
    ? payload.lifecycle
    : null;
  const provider: PlanWriterProvider | null = payload.provider === "claude-code" || payload.provider === "codex"
    ? payload.provider
    : null;
  const effort = normalizePlannerEffortId(payload.effort);
  const synchronization = isRecord(payload.synchronization) ? payload.synchronization : null;
  const syncState = synchronization?.state === "up_to_date"
    || synchronization?.state === "saving"
    || synchronization?.state === "sync_failed"
    ? synchronization.state
    : null;
  if (!lifecycle || !syncState || typeof payload.editable !== "boolean") return null;
  return {
    lifecycle,
    generation: Number.isInteger(payload.generation) ? payload.generation as number : null,
    provider,
    model: readNullableString(payload.model),
    effort,
    basisCommit: readNullableString(payload.basisCommit),
    terminalId: readNullableString(payload.terminalId),
    ...(payload.codexAuthMode === "subscription" || payload.codexAuthMode === "api-key"
      ? { codexAuthMode: payload.codexAuthMode }
      : {}),
    ...(readNullableString(payload.stopReason) ? { stopReason: readNullableString(payload.stopReason) as PlanWriterState["stopReason"] } : {}),
    ...(readNullableString(payload.startupError) ? { startupError: readNullableString(payload.startupError) ?? undefined } : {}),
    ...(readNullableString(payload.cleanupError) ? { cleanupError: readNullableString(payload.cleanupError) ?? undefined } : {}),
    synchronization: {
      state: syncState,
      ...(readNullableString(synchronization?.error) ? { error: readNullableString(synchronization?.error) ?? undefined } : {}),
    },
    editable: payload.editable,
  };
}

export async function fetchPlanWriter(
  hubUrl: string,
  repoId: string,
  artifactId: string,
): Promise<PlanWriterState> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/live-writer`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch Scribe: ${res.status}`);
  const body = await res.json().catch(() => null);
  const writer = isRecord(body) ? normalizePlanWriterState(body.writer) : null;
  if (!writer) throw new Error("Malformed Scribe response");
  return writer;
}

export async function startPlanWriter(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  input: { provider?: PlanWriterProvider; model?: string; effort?: PlannerEffort } = {},
): Promise<PlanWriterState> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/live-writer/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw await parseApiError(new Response(JSON.stringify(body), { status: res.status, headers: { "Content-Type": "application/json" } }), `Failed to start Scribe: ${res.status}`);
  const writer = isRecord(body) ? normalizePlanWriterState(body.writer) : null;
  if (!writer) throw new Error("Malformed Scribe response");
  return writer;
}

export async function stopPlanWriter(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  expectedGeneration: number,
): Promise<PlanWriterState> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/live-writer/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ expectedGeneration }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to stop Scribe: ${res.status}`);
  const body = await res.json().catch(() => null);
  const writer = isRecord(body) ? normalizePlanWriterState(body.writer) : null;
  if (!writer) throw new Error("Malformed Scribe response");
  return writer;
}

export async function fetchAgentSkills(
  hubUrl: string,
  repoId: string,
  surface: "plan" | "review",
): Promise<AgentSkillDefinition[]> {
  const params = new URLSearchParams({ surface });
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/skills?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch ${surface} skills: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body)
    ? normalizeArrayResponse(body.skills).map(normalizeAgentSkill).filter(isPresent)
    : [];
}

export async function createAgentSkill(
  hubUrl: string,
  repoId: string,
  input: Omit<AgentSkillDefinition, "id" | "origin" | "customized" | "createdAt" | "updatedAt">,
): Promise<AgentSkillDefinition> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/skills`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to create skill: ${res.status}`);
  const body = await res.json().catch(() => null);
  const skill = isRecord(body) ? normalizeAgentSkill(body.skill) : null;
  if (!skill) throw new Error("Malformed skill response");
  return skill;
}

export async function updateAgentSkill(
  hubUrl: string,
  repoId: string,
  surface: "plan" | "review",
  skillId: string,
  input: Partial<AgentSkillDefinition>,
): Promise<AgentSkillDefinition> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/skills/${surface}/${encodeURIComponent(skillId)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to save skill: ${res.status}`);
  const body = await res.json().catch(() => null);
  const skill = isRecord(body) ? normalizeAgentSkill(body.skill) : null;
  if (!skill) throw new Error("Malformed skill response");
  return skill;
}

export async function deleteAgentSkill(
  hubUrl: string,
  repoId: string,
  surface: "plan" | "review",
  skillId: string,
): Promise<AgentSkillDefinition | null> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/skills/${surface}/${encodeURIComponent(skillId)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to delete skill: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body) ? normalizeAgentSkill(body.skill) : null;
}

export async function fetchRepoPlanWriterSettings(hubUrl: string, repoId: string): Promise<RepoPlanWriterSettings> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plan-writer-settings`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch Scribe Settings: ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!isRecord(body) || !isRecord(body.settings)) throw new Error("Malformed Scribe Settings response");
  return body.settings as unknown as RepoPlanWriterSettings;
}

export async function updateRepoPlanWriterSettings(
  hubUrl: string,
  repoId: string,
  input: Pick<RepoPlanWriterSettings, "routeKey" | "effort" | "planFormat">,
): Promise<RepoPlanWriterSettings> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plan-writer-settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to save Scribe Settings: ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!isRecord(body) || !isRecord(body.settings)) throw new Error("Malformed Scribe Settings response");
  return body.settings as unknown as RepoPlanWriterSettings;
}

export interface PlanSkillInvocationDetail {
  invocation: PlanSkillInvocation;
  reviewers: ReviewerRegistryEntry[];
  runs: PlannerRun[];
}

export async function invokePlanSkill(
  hubUrl: string,
  repoId: string,
  planArtifactId: string,
  skillId: string,
  requestId: string,
): Promise<{ kind: "fanout" } & PlanSkillInvocationDetail> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${planArtifactId}/skills/${encodeURIComponent(skillId)}/invoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ requestId }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to invoke Plan skill: ${res.status}`);
  return await res.json() as { kind: "fanout" } & PlanSkillInvocationDetail;
}

export async function fetchPlanSkillInvocations(
  hubUrl: string,
  repoId: string,
  planArtifactId: string,
  options: { cursor?: string | null; limit?: number } = {},
): Promise<{ invocations: Array<Record<string, unknown>>; nextCursor: string | null }> {
  const params = new URLSearchParams();
  if (options.cursor) params.set("cursor", options.cursor);
  if (options.limit) params.set("limit", String(options.limit));
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${planArtifactId}/skill-invocations?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch Plan skill history: ${res.status}`);
  return await res.json() as any;
}

export async function fetchPlanSkillInvocation(
  hubUrl: string,
  repoId: string,
  planArtifactId: string,
  invocationId: string,
): Promise<PlanSkillInvocationDetail> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${planArtifactId}/skill-invocations/${encodeURIComponent(invocationId)}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch Plan skill invocation: ${res.status}`);
  return await res.json() as PlanSkillInvocationDetail;
}

export async function cancelPlanSkillInvocation(
  hubUrl: string,
  repoId: string,
  planArtifactId: string,
  invocationId: string,
): Promise<PlanSkillInvocation> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${planArtifactId}/skill-invocations/${encodeURIComponent(invocationId)}/cancel`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to cancel Plan skill invocation: ${res.status}`);
  const body = await res.json() as { invocation: PlanSkillInvocation };
  return body.invocation;
}

export async function forwardPlanSkillReports(
  hubUrl: string,
  repoId: string,
  planArtifactId: string,
  invocationId: string,
  input: { requestId: string; messageIds: string[]; guidance?: string | null },
): Promise<{ contributions: PlanContribution[] }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${planArtifactId}/skill-invocations/${encodeURIComponent(invocationId)}/forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to forward Plan skill reports: ${res.status}`);
  return await res.json() as { contributions: PlanContribution[] };
}

export async function createPlanContribution(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  input: {
    text: string;
    provider: string;
    model: string;
    skill?: string;
    sourceRunId?: string;
    sourceThreadId?: string;
  },
): Promise<PlanContribution> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/contributions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to create contribution: ${res.status}`);
  const body = await res.json().catch(() => null);
  const contribution = isRecord(body) ? normalizePlanContribution(body.contribution) : null;
  if (!contribution) throw new Error("Malformed contribution response");
  return contribution;
}

export async function dismissPlanContribution(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  contributionId: string,
): Promise<PlanContribution> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/contributions/${contributionId}/dismiss`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to dismiss contribution: ${res.status}`);
  const body = await res.json().catch(() => null);
  const contribution = isRecord(body) ? normalizePlanContribution(body.contribution) : null;
  if (!contribution) throw new Error("Malformed contribution response");
  return contribution;
}

export async function incorporatePlanContribution(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  contributionId: string,
): Promise<PlanContribution> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/contributions/${contributionId}/incorporate`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to mark contribution incorporated: ${res.status}`);
  const body = await res.json().catch(() => null);
  const contribution = isRecord(body) ? normalizePlanContribution(body.contribution) : null;
  if (!contribution) throw new Error("Malformed contribution response");
  return contribution;
}

export async function sendReviewerMessageToWriter(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  threadId: string,
  messageId: string,
): Promise<{ contribution: PlanContribution; created: boolean }> {
  const res = await fetch(
    `${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers/${threadId}/messages/${messageId}/send-to-writer`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: "{}",
    },
  );
  if (!res.ok) throw await parseApiError(res, `Failed to share context with Scribe: ${res.status}`);
  const body = await res.json().catch(() => null);
  const contribution = isRecord(body) ? normalizePlanContribution(body.contribution) : null;
  if (!contribution) throw new Error("Malformed send-to-writer response");
  return {
    contribution,
    created: isRecord(body) ? body.created === true : false,
  };
}

export async function fetchLatestPlannerRun(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  role: "reviewer",
  threadId: string,
): Promise<{ run: PlannerRun | null; events: PlannerRunEvent[] }> {
  const params = new URLSearchParams();
  params.set("role", role);
  if (threadId) params.set("threadId", threadId);
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/runs/latest?${params}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch latest planner run: ${res.status}`);
  const body = await res.json().catch(() => null);
  const run = isRecord(body) && body.run != null ? normalizePlannerRun(body.run) : null;
  return {
    run,
    events: isRecord(body) ? normalizeArrayResponse(body.events).map(normalizePlannerRunEvent).filter(isPresent) : [],
  };
}

export async function fetchPlanReviewers(
  hubUrl: string,
  repoId: string,
  artifactId: string,
): Promise<ReviewerRegistryEntry[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch reviewers: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body)
    ? normalizeArrayResponse(body.reviewers).map(normalizeReviewerRegistryEntry).filter(isPresent)
    : [];
}

export async function addPlanReviewer(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  input: { provider: string; model: string; effort: PlannerEffort },
): Promise<{ reviewer: ReviewerRegistryEntry; run?: PlannerRun }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to add reviewer: ${res.status}`);
  const body = await res.json().catch(() => null);
  const reviewer = isRecord(body) ? normalizeReviewerRegistryEntry(body.reviewer) : null;
  if (!reviewer) {
    throw new Error("Malformed reviewer response");
  }
  const run = isRecord(body) ? normalizePlannerRun(body.run) : null;
  return {
    reviewer,
    ...(run ? { run } : {}),
  };
}

export async function removePlanReviewer(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  threadId: string,
): Promise<void> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers/${threadId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to remove reviewer: ${res.status}`);
}

export async function fetchReviewerMessages(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  threadId: string,
): Promise<ThreadMessage[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers/${threadId}/messages`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch reviewer messages: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body)
    ? normalizeArrayResponse(body.messages).map(normalizeThreadMessage).filter(isPresent)
    : [];
}

export async function sendReviewerMessage(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  threadId: string,
  text: string,
): Promise<{ run: PlannerRun | null; message: ThreadMessage }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers/${threadId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to send reviewer message: ${res.status}`);
  const body = await res.json().catch(() => null);
  const message = isRecord(body) ? normalizeThreadMessage(body.message) : null;
  if (!message) throw new Error("Malformed reviewer message response");
  return {
    run: isRecord(body) ? normalizePlannerRun(body.run) : null,
    message,
  };
}

export async function createRepo(
  hubUrl: string,
  selection: GitHubRepositorySelection,
): Promise<RepoMeta> {
  const res = await fetch(`${hubUrl}/api/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      repositoryId: selection.repositoryId,
      installationId: selection.installationId,
      fullName: selection.fullName,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(readErrorMessage(body) || `Failed to create repo: ${res.status}`);
  }
  const repo = normalizeRepoMetaObject(await res.json().catch(() => null));
  if (!repo) {
    throw new Error("Malformed repo response");
  }
  return repo;
}

export interface GitHubRepositorySelection {
  repositoryId: number;
  installationId: number;
  fullName: string;
  repoUrl: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface GitHubRepositoryWarning {
  installationId?: number;
  code: string;
  message: string;
}

export interface GitHubRepositoriesResponse {
  repositories: GitHubRepositorySelection[];
  warnings: GitHubRepositoryWarning[];
  repositorySelection: "all" | "selected" | "unknown";
}

function normalizeGitHubRepositorySelection(payload: unknown): GitHubRepositorySelection | null {
  if (!isRecord(payload)) return null;
  const repositoryId = readIntegerOr(payload.repositoryId, 0);
  const installationId = readIntegerOr(payload.installationId, 0);
  const fullName = readString(payload.fullName);
  const repoUrl = readString(payload.repoUrl);
  if (repositoryId <= 0 || installationId <= 0 || !fullName || !repoUrl) return null;
  return {
    repositoryId,
    installationId,
    fullName,
    repoUrl,
    private: readBooleanOr(payload.private, false),
    defaultBranch: readNullableString(payload.defaultBranch),
  };
}

function normalizeGitHubRepositoryWarning(payload: unknown): GitHubRepositoryWarning | null {
  if (!isRecord(payload)) return null;
  const code = readString(payload.code);
  const message = readString(payload.message);
  if (!code || !message) return null;
  return {
    ...(typeof payload.installationId === "number" ? { installationId: payload.installationId } : {}),
    code,
    message,
  };
}

export async function fetchGitHubRepositories(hubUrl: string): Promise<GitHubRepositoriesResponse> {
  const res = await fetch(`${hubUrl}/api/github/repositories`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (isRecord(body)) {
      const error = buildApiActionError({
        error: readString(body.error) ?? undefined,
        code: readString(body.code) ?? undefined,
      }, `Failed to fetch GitHub repositories: ${res.status}`);
      throw error;
    }
    throw new Error(`Failed to fetch GitHub repositories: ${res.status}`);
  }
  if (!isRecord(body)) {
    throw new Error("Malformed GitHub repository response");
  }
  return {
    repositories: normalizeArrayResponse<unknown>(body.repositories)
      .map(normalizeGitHubRepositorySelection)
      .filter(isPresent),
    warnings: normalizeArrayResponse<unknown>(body.warnings)
      .map(normalizeGitHubRepositoryWarning)
      .filter(isPresent),
    repositorySelection: body.repositorySelection === "all" || body.repositorySelection === "selected"
      ? body.repositorySelection
      : "unknown",
  };
}

export async function fetchRepos(hubUrl: string): Promise<RepoMeta[]> {
  const res = await fetch(`${hubUrl}/api/repos`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
  return normalizeStrictArrayResponse(
    await res.json().catch(() => null),
    normalizeRepoMetaObject,
    "Malformed repo response",
  );
}

export async function fetchRepo(hubUrl: string, repoId: string): Promise<RepoMeta> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch repo: ${res.status}`);
  const repo = normalizeRepoMetaObject(await res.json().catch(() => null));
  if (!repo) {
    throw new Error("Malformed repo response");
  }
  return repo;
}

export interface RepoSessionEnvVar {
  name: string;
  updatedAt: string;
}

export interface RepoMcpServer {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
}

export interface RepoMcpServerInput {
  id?: string;
  label: string;
  url: string;
  enabled: boolean;
}

export type CloudflareMcpConnectionStatus = "not_connected" | "connected" | "reauth_required";

export interface RepoCloudflareMcpStatus {
  integrationId: string;
  serverId: string;
  label: string;
  mcpUrl: string;
  status: CloudflareMcpConnectionStatus;
  connected: boolean;
  enabled: boolean;
  scopes: string[];
  expiresAt: number | null;
  account: { id: string | null; name: string | null } | null;
  lastAuthError: string | null;
  lastAuthErrorAt: string | null;
}

function normalizeRepoSessionEnvVar(payload: unknown): RepoSessionEnvVar | null {
  if (!isRecord(payload)) return null;
  const name = readString(payload.name);
  const updatedAt = readString(payload.updatedAt);
  if (!name || !updatedAt) return null;
  return { name, updatedAt };
}

export async function fetchRepoSessionEnv(
  hubUrl: string,
  repoId: string,
): Promise<RepoSessionEnvVar[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/session-env`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to fetch session env: ${res.status}`);
  }
  if (!isRecord(body)) {
    throw new Error("Malformed session env response");
  }
  return normalizeArrayResponse<unknown>(body.vars)
    .map(normalizeRepoSessionEnvVar)
    .filter(isPresent);
}

export async function patchRepoSessionEnv(
  hubUrl: string,
  repoId: string,
  patch: { set?: Record<string, string>; delete?: string[] },
): Promise<RepoSessionEnvVar[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/session-env`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(patch),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to update session env: ${res.status}`);
  }
  if (!isRecord(body)) {
    throw new Error("Malformed session env response");
  }
  return normalizeArrayResponse<unknown>(body.vars)
    .map(normalizeRepoSessionEnvVar)
    .filter(isPresent);
}

function normalizeRepoMcpServer(payload: unknown): RepoMcpServer | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const label = readString(payload.label);
  const url = readString(payload.url);
  if (!id || !label || !url || typeof payload.enabled !== "boolean") return null;
  return {
    id,
    label,
    url,
    enabled: payload.enabled,
  };
}

export async function fetchRepoMcpServers(
  hubUrl: string,
  repoId: string,
): Promise<RepoMcpServer[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/mcp-servers`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to fetch MCP servers: ${res.status}`);
  }
  if (!isRecord(body)) {
    throw new Error("Malformed MCP servers response");
  }
  return normalizeArrayResponse<unknown>(body.servers)
    .map(normalizeRepoMcpServer)
    .filter(isPresent);
}

export async function putRepoMcpServers(
  hubUrl: string,
  repoId: string,
  servers: RepoMcpServerInput[],
): Promise<RepoMcpServer[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/mcp-servers`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify({ servers }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to update MCP servers: ${res.status}`);
  }
  if (!isRecord(body)) {
    throw new Error("Malformed MCP servers response");
  }
  return normalizeArrayResponse<unknown>(body.servers)
    .map(normalizeRepoMcpServer)
    .filter(isPresent);
}

function normalizeRepoCloudflareMcpStatus(payload: unknown): RepoCloudflareMcpStatus | null {
  if (!isRecord(payload)) return null;
  const integrationId = readString(payload.integrationId);
  const serverId = readString(payload.serverId);
  const label = readString(payload.label);
  const mcpUrl = readString(payload.mcpUrl);
  const status = payload.status === "not_connected" || payload.status === "connected" || payload.status === "reauth_required"
    ? payload.status
    : null;
  if (!integrationId || !serverId || !label || !mcpUrl || !status) return null;
  const account = isRecord(payload.account)
    ? {
      id: readNullableString(payload.account.id),
      name: readNullableString(payload.account.name),
    }
    : null;
  return {
    integrationId,
    serverId,
    label,
    mcpUrl,
    status,
    connected: readBooleanOr(payload.connected),
    enabled: readBooleanOr(payload.enabled),
    scopes: normalizeArrayResponse<unknown>(payload.scopes).filter((scope): scope is string => typeof scope === "string"),
    expiresAt: typeof payload.expiresAt === "number" && Number.isFinite(payload.expiresAt) ? payload.expiresAt : null,
    account,
    lastAuthError: readNullableString(payload.lastAuthError),
    lastAuthErrorAt: readNullableString(payload.lastAuthErrorAt),
  };
}

function readRepoCloudflareMcpStatusBody(body: unknown): RepoCloudflareMcpStatus {
  if (!isRecord(body)) {
    throw new Error("Malformed Cloudflare MCP response");
  }
  const integration = normalizeRepoCloudflareMcpStatus(body.integration);
  if (!integration) {
    throw new Error("Malformed Cloudflare MCP response");
  }
  return integration;
}

export async function fetchRepoCloudflareMcpStatus(
  hubUrl: string,
  repoId: string,
): Promise<RepoCloudflareMcpStatus> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/cloudflare-mcp`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to fetch Cloudflare MCP status: ${res.status}`);
  }
  return readRepoCloudflareMcpStatusBody(body);
}

export async function connectRepoCloudflareMcp(
  hubUrl: string,
  repoId: string,
): Promise<{ authorizeUrl: string; expiresAt: number }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/cloudflare-mcp/connect`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to start Cloudflare MCP connection: ${res.status}`);
  }
  if (!isRecord(body) || typeof body.authorizeUrl !== "string" || typeof body.expiresAt !== "number") {
    throw new Error("Malformed Cloudflare MCP connect response");
  }
  return { authorizeUrl: body.authorizeUrl, expiresAt: body.expiresAt };
}

export async function setRepoCloudflareMcpEnabled(
  hubUrl: string,
  repoId: string,
  enabled: boolean,
): Promise<RepoCloudflareMcpStatus> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/cloudflare-mcp/${enabled ? "enable" : "disable"}`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to update Cloudflare MCP: ${res.status}`);
  }
  return readRepoCloudflareMcpStatusBody(body);
}

export async function disconnectRepoCloudflareMcp(
  hubUrl: string,
  repoId: string,
): Promise<RepoCloudflareMcpStatus> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/cloudflare-mcp/disconnect`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to disconnect Cloudflare MCP: ${res.status}`);
  }
  return readRepoCloudflareMcpStatusBody(body);
}

// ── Setup / Settings helpers ─────────────────────────────────────

export interface SetupStatus {
  needsSetup: boolean;
  setupPhase: "github-app" | "complete";
  isLocalDev: boolean;
  installerManaged: boolean;
  installationRegion: PlacementRegion | null;
  workersDevHubUrl: string | null;
  modelAuthConfigured: boolean;
  claudeBillingMode: BillingMode | null;
  openaiBillingMode: BillingMode | null;
  workersAiConfigured: boolean;
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  chatgptAuthStatus: "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
  hasOpenAIKey: boolean;
  codexRouteStatus: "available" | "backend_offline" | "runtime_update_required" | "environment_not_connected" | "authentication_unavailable" | "direct_api" | "unavailable";
  openaiPlannerConfigured: boolean;
  openaiPlannerAvailable: boolean;
  openaiPlannerRoute: "api-key" | "subscription-app-server" | null;
  openaiPlannerReason: string | null;
  codexBackendReadiness: { cf: SetupStatus["codexRouteStatus"]; host: SetupStatus["codexRouteStatus"] };
  hostRegistered: boolean;
  enabledHarnesses: EnvHarness[];
  protectionMode: "public" | "cf-access";
  tokenExpiresAt: string | null;
  renewalRecommended: boolean;
  hostConnected: boolean;
  idleTimeoutMinutes: number;
  githubAppAvailable: boolean;
  githubAppConfigured: boolean;
  githubAppReady: boolean;
  githubAppSlug: string | null;
  githubAppInstallUrl: string | null;
  githubAppManageUrl: string;
  githubAppPublicHubDisabled: boolean;
  buildDiagnostics: UpdateBuildDiagnostics;
  selfUpdateRepo: HubUpdateRepoState;
  dashboardOnboarding: {
    dismissed: boolean;
    executionReady: boolean;
  };
}

export type AuthConnectProvider = "codex" | "claude";
export type AuthConnectProviderStatus = "pending" | "success" | "error";
export interface AuthConnectStatus {
  status: AuthConnectProviderStatus | "expired";
  providers: Partial<Record<AuthConnectProvider, AuthConnectProviderStatus>>;
  error: string | null;
}

function normalizeAuthConnectStatus(value: unknown): AuthConnectStatus {
  if (!isRecord(value) || !isRecord(value.providers)) {
    throw new Error("Malformed authentication connection status response");
  }
  const status = value.status;
  if (status !== "pending" && status !== "success" && status !== "error" && status !== "expired") {
    throw new Error("Malformed authentication connection status response");
  }
  const providers: Partial<Record<AuthConnectProvider, AuthConnectProviderStatus>> = {};
  for (const provider of ["codex", "claude"] as const) {
    const providerStatus = value.providers[provider];
    if (providerStatus === "pending" || providerStatus === "success" || providerStatus === "error") {
      providers[provider] = providerStatus;
    }
  }
  return {
    status,
    providers,
    error: typeof value.error === "string" ? value.error : null,
  };
}

export async function approveAuthConnect(
  hubUrl: string,
  input: {
    publicKeyJwk: Record<string, unknown>;
    state: string;
    providers: AuthConnectProvider[];
  },
): Promise<{ envelope: string; connectionId: string }> {
  const response = await fetch(`${hubUrl}/api/cli/auth-connect-package`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await parseApiError(response, "Connection approval failed.");
  const body = await response.json().catch(() => null);
  if (
    !isRecord(body)
    || typeof body.envelope !== "string"
    || !body.envelope
    || typeof body.connection_id !== "string"
    || !/^[A-Za-z0-9_-]{16,128}$/.test(body.connection_id)
  ) {
    throw new Error("Malformed authentication connection approval response");
  }
  return { envelope: body.envelope, connectionId: body.connection_id };
}

export async function fetchAuthConnectStatus(
  hubUrl: string,
  connectionId: string,
): Promise<AuthConnectStatus> {
  const response = await fetch(
    `${hubUrl}/api/cli/auth-connect-status?connection_id=${encodeURIComponent(connectionId)}`,
    { credentials: "include", cache: "no-store" },
  );
  if (!response.ok) throw await parseApiError(response, "Failed to check the connection status.");
  return normalizeAuthConnectStatus(await response.json().catch(() => null));
}

export type ExecutionSelection =
  | { target: "cf" }
  | { target: "host"; machineId: string };
export type HostIncompatibilityCode =
  | "runner_protocol"
  | "runtime_auth_protocol"
  | "runtime_image";
export type ExecutionHostStatus =
  | { state: "not_connected" }
  | {
      state: "incompatible";
      machineId: string;
      displayName: string;
      code: HostIncompatibilityCode;
    }
  | { state: "ready"; machineId: string; displayName: string };
export type SelectedHostStatus =
  | { state: "offline"; machineId: string; displayName: string }
  | Exclude<ExecutionHostStatus, { state: "not_connected" }>;
export interface ExecutionStatus {
  selected: ExecutionSelection;
  selectedHost: SelectedHostStatus | null;
  candidate: ExecutionHostStatus;
  executionReady: boolean;
}

function normalizeExecutionHostStatus(value: unknown): ExecutionHostStatus | null {
  if (!isRecord(value)) return null;
  if (value.state === "not_connected") return { state: "not_connected" };
  const machineId = typeof value.machineId === "string" ? value.machineId.trim() : "";
  const displayName = typeof value.displayName === "string" ? value.displayName.trim() : "";
  if (!machineId || !displayName) return null;
  if (value.state === "ready") return { state: "ready", machineId, displayName };
  if (
    value.state === "incompatible"
    && (
      value.code === "runner_protocol"
      || value.code === "runtime_auth_protocol"
      || value.code === "runtime_image"
    )
  ) {
    return { state: "incompatible", machineId, displayName, code: value.code };
  }
  return null;
}

function normalizeExecutionStatus(value: unknown): ExecutionStatus {
  if (!isRecord(value) || !isRecord(value.selected)) {
    throw new Error("Malformed execution status response");
  }
  const selected: ExecutionSelection | null = value.selected.target === "cf"
    ? { target: "cf" }
    : value.selected.target === "host" && typeof value.selected.machineId === "string"
      ? { target: "host", machineId: value.selected.machineId }
      : null;
  const candidate = normalizeExecutionHostStatus(value.candidate);
  let selectedHost: SelectedHostStatus | null = null;
  if (value.selectedHost !== null && value.selectedHost !== undefined) {
    if (
      isRecord(value.selectedHost)
      && value.selectedHost.state === "offline"
      && typeof value.selectedHost.machineId === "string"
      && typeof value.selectedHost.displayName === "string"
    ) {
      selectedHost = {
        state: "offline",
        machineId: value.selectedHost.machineId,
        displayName: value.selectedHost.displayName,
      };
    } else {
      const normalized = normalizeExecutionHostStatus(value.selectedHost);
      if (normalized?.state !== "not_connected") selectedHost = normalized;
    }
  }
  if (!selected || !candidate || typeof value.executionReady !== "boolean") {
    throw new Error("Malformed execution status response");
  }
  return { selected, selectedHost, candidate, executionReady: value.executionReady };
}

export async function fetchExecutionStatus(hubUrl: string): Promise<ExecutionStatus> {
  const response = await fetch(`${hubUrl}/api/execution/status`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw await parseApiError(response, "Failed to load execution status.");
  return normalizeExecutionStatus(await response.json().catch(() => null));
}

export async function setExecutionBackend(
  hubUrl: string,
  selection:
    | { target: "cf" }
    | { target: "host"; expectedMachineId: string },
): Promise<ExecutionStatus> {
  const response = await fetch(`${hubUrl}/api/settings/execution-backend`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    cache: "no-store",
    body: JSON.stringify(selection),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === "string"
      ? body.message
      : isRecord(body) && typeof body.error === "string"
        ? body.error
        : "Failed to change execution backend.";
    throw new Error(message);
  }
  return normalizeExecutionStatus(body);
}

async function throwIfBrowserAuthenticationRequired(response: Response): Promise<void> {
  if (response.type === "opaqueredirect" || response.status === 401) {
    throw new ApiAuthenticationError(
      "Your Cloudflare Access session has expired.",
      response.status || null,
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const responseUrl = response.url.toLowerCase();
  if (responseUrl.includes("/cdn-cgi/access/") || contentType.includes("text/html")) {
    const raw = await response.clone().text().catch(() => "");
    const looksLikeAccessLogin =
      responseUrl.includes("/cdn-cgi/access/")
      || /Cloudflare Access/i.test(raw)
      || /Sign in ・ Cloudflare Access/i.test(raw);
    if (looksLikeAccessLogin || contentType.includes("text/html")) {
      throw new ApiAuthenticationError(
        "Your Cloudflare Access session has expired.",
        response.status || null,
      );
    }
  }
}

export async function fetchSetupStatus(hubUrl: string): Promise<SetupStatus> {
  const res = await fetch(`${hubUrl}/api/setup/status`, {
    headers: { Accept: "application/json" },
    credentials: "include",
    cache: "no-store",
    redirect: "manual",
  });
  await throwIfBrowserAuthenticationRequired(res);
  if (!res.ok) throw new Error(`Failed to fetch setup status: ${res.status}`);
  return normalizeSetupStatus(await res.json().catch(() => null));
}

export async function dismissDashboardOnboarding(hubUrl: string): Promise<void> {
  const response = await fetch(`${hubUrl}/api/setup/onboarding/dismiss`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) throw await parseApiError(response, "Failed to dismiss dashboard onboarding.");
}

export interface VerifyModelAuthResult {
  key: string;
  mode: string;
  ok: boolean;
  error?: string;
  warning?: string;
  note?: string;
}

export async function verifyModelAuth(
  hubUrl: string,
): Promise<{ ok: boolean; error?: string; results: VerifyModelAuthResult[] }> {
  const res = await fetch(`${hubUrl}/api/setup/verify-model-auth`, {
    method: "POST",
    credentials: "include",
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(readErrorMessage(body) || `Credential verification failed: ${res.status}`);
  }
  return {
    ok: isRecord(body) && body.ok === true,
    ...(isRecord(body) && typeof body.error === "string" ? { error: body.error } : {}),
    results: isRecord(body)
      ? normalizeArrayResponse(body.results)
        .map((result) => normalizeVerifyModelAuthResult(result))
        .filter(isPresent)
      : [],
  };
}

export async function submitSetup(
  hubUrl: string,
  secrets: Record<string, string>,
): Promise<{ ok: boolean; saved?: string[]; error?: string }> {
  const res = await fetch(`${hubUrl}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ secrets }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(readErrorMessage(payload) || `Setup failed: ${res.status}`);
  const body = normalizeSetupMutationResult(payload);
  if (!body) throw new Error("Malformed setup response");
  return body;
}

export async function saveBillingMode(
  hubUrl: string,
  provider: "claude" | "openai",
  mode: BillingMode,
): Promise<{ ok: boolean; saved?: string[]; error?: string }> {
  const key = provider === "claude" ? "claudeBillingMode" : "openaiBillingMode";
  const res = await fetch(`${hubUrl}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ settings: { [key]: mode } }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(readErrorMessage(payload) || `Failed to save billing mode: ${res.status}`);
  const body = normalizeSetupMutationResult(payload);
  if (!body) throw new Error("Malformed billing mode response");
  return body;
}

export async function saveGitHubAppConfig(
  hubUrl: string,
  input: {
    appId: string;
    clientId: string;
    slug: string;
    privateKey: string;
  },
): Promise<SetupStatus> {
  const res = await fetch(`${hubUrl}/api/github/app-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `GitHub App setup failed: ${res.status}`);
  }
  if (isRecord(body) && isRecord(body.status)) {
    return normalizeSetupStatus(body.status);
  }
  return await fetchSetupStatus(hubUrl);
}

export type GitHubAccessTestStatus =
  | "ready"
  | "not_configured"
  | "missing_installation"
  | "repo_not_selected"
  | "missing_permissions"
  | "invalid_repo"
  | "invalid_config"
  | "github_error"
  | "public_hub_disabled";

export interface GitHubAccessTestResult {
  ok: boolean;
  status: GitHubAccessTestStatus;
  message: string;
  repo: string | null;
  installUrl: string | null;
  manageUrl: string | null;
}

export async function testGitHubAppAccess(hubUrl: string, selection: GitHubRepositorySelection): Promise<GitHubAccessTestResult> {
  const res = await fetch(`${hubUrl}/api/github/test-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      repositoryId: selection.repositoryId,
      installationId: selection.installationId,
      fullName: selection.fullName,
    }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `GitHub App access test failed: ${res.status}`);
  }
  if (!isRecord(body) || typeof body.status !== "string" || typeof body.ok !== "boolean") {
    throw new Error("Malformed GitHub App access test response");
  }
  return {
    ok: body.ok,
    status: (
      body.status === "ready"
      || body.status === "not_configured"
      || body.status === "missing_installation"
      || body.status === "repo_not_selected"
      || body.status === "missing_permissions"
      || body.status === "invalid_repo"
      || body.status === "invalid_config"
      || body.status === "github_error"
      || body.status === "public_hub_disabled"
    ) ? body.status : "github_error",
    message: readStringOr(body.message, "GitHub App access test failed."),
    repo: readNullableString(body.repo),
    installUrl: readNullableString(body.installUrl),
    manageUrl: readNullableString(body.manageUrl),
  };
}

export async function checkForUpdate(hubUrl: string): Promise<UpdateCheckResult> {
  const res = await fetch(`${hubUrl}/api/update/check`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to check for updates: ${res.status}`);
  const result = normalizeUpdateCheckResult(await res.json().catch(() => null));
  if (!result) {
    throw new Error("Malformed update check response");
  }
  return result;
}

export interface PredeployCleanSlateStatus {
  ok: boolean;
  blockers: Array<{ kind: string; resourceId: string }>;
}

export async function checkPredeployCleanSlate(
  hubUrl: string,
): Promise<PredeployCleanSlateStatus> {
  const res = await fetch(`${hubUrl}/api/settings/predeploy-clean-slate`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null) as unknown;
  if (res.status !== 200 && res.status !== 409) {
    throw new ApiActionError(
      isRecord(body) && typeof body.error === "string"
        ? { error: body.error }
        : {},
      `Failed to verify maintenance readiness: ${res.status}`,
    );
  }
  if (!isRecord(body) || typeof body.ok !== "boolean" || !Array.isArray(body.blockers)) {
    throw new Error("Malformed maintenance readiness response");
  }
  const blockers = body.blockers.map((blocker) => {
    if (
      !isRecord(blocker)
      || typeof blocker.kind !== "string"
      || typeof blocker.resourceId !== "string"
    ) {
      throw new Error("Malformed maintenance readiness blocker");
    }
    return { kind: blocker.kind, resourceId: blocker.resourceId };
  });
  if (body.ok !== (blockers.length === 0)) {
    throw new Error("Inconsistent maintenance readiness response");
  }
  if ((res.status === 200) !== body.ok) {
    throw new Error("Inconsistent maintenance readiness status");
  }
  return { ok: body.ok, blockers };
}

export async function applyUpdate(
  hubUrl: string,
): Promise<UpdateApplyResult> {
  const res = await fetch(`${hubUrl}/api/update/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(readErrorMessage(payload) || `Failed to apply update: ${res.status}`);
  const body = normalizeUpdateApplyResult(payload);
  if (!body) throw new Error("Malformed update response");
  return body;
}

export async function applyCloudflareRepairUpdate(
  hubUrl: string,
  apiToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${hubUrl}/api/update/repair/cloudflare-redeploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ apiToken }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) throw new Error(readErrorMessage(payload) || `Failed to apply repair update: ${res.status}`);
  if (!isRecord(payload) || typeof payload.ok !== "boolean") {
    throw new Error("Malformed repair update response");
  }
  return {
    ok: payload.ok,
    ...(readString(payload.error) ? { error: readString(payload.error) ?? undefined } : {}),
  };
}

export async function detectSelfUpdateRepo(hubUrl: string): Promise<HubUpdateRepoState> {
  const res = await fetch(`${hubUrl}/api/update/hub-repo/detect`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Self-update repo detection failed: ${res.status}`);
  return normalizeHubUpdateRepoState(body);
}

export async function selectSelfUpdateRepo(
  hubUrl: string,
  candidate: HubUpdateRepoCandidate,
): Promise<HubUpdateRepoState> {
  const res = await fetch(`${hubUrl}/api/update/hub-repo/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      repoId: candidate.repoId,
      installationId: candidate.installationId,
      fullName: candidate.fullName,
      branch: candidate.branch,
    }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Self-update repo selection failed: ${res.status}`);
  return normalizeHubUpdateRepoState(body);
}

// ── WebSocket helper ──────────────────────────────────────────────

const BACKOFF_STEPS = [1, 2, 5, 10, 30]; // seconds

/** Minimal message shape forwarded to the live callback and SessionView. */
export type LiveMessage = {
  id: string;
  sessionId: string;
  content: unknown;
  seq: number;
  localId?: string;
};

export interface WsHandlers {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onReconnectExhausted?: () => void;
  onCapabilities?: (capabilities: Extract<WsServerMessage, { type: "capabilities" }>) => void;
  onMachineUpdated?: (machine: StoredMachine) => void;
  onMessage?: (msg: Extract<WsServerMessage, { type: "message-received" }>) => void;
  onTerminalInputAck?: (msg: Extract<WsServerMessage, { type: "terminal-input-ack" }>) => void;
  onTerminalControlAck?: (msg: Extract<WsServerMessage, { type: "terminal-control-ack" }>) => void;
  onSessionUpdated?: (session: StoredSession) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onPermissionCreated?: (permission: StoredPermission) => void;
  onPermissionResolved?: (permission: StoredPermission) => void;
  onEnvUpsert?: (env: EnvMeta) => void;
  onEnvRemove?: (slug: string) => void;
  onRepoUpsert?: (repo: RepoMeta) => void;
  onRepoRemove?: (repoId: string) => void;
  onPlanArtifactUpdated?: (repoId: string, planArtifactId: string) => void;
  onPlanWriterState?: (repoId: string, planArtifactId: string) => void;
  onRepoMainChanged?: (
    repoId: string,
    repoUrl: string,
    previousMainCommit: string | null,
    currentMainCommit: string | null,
    sourceEnvSlug?: string | null,
  ) => void;
  onError?: (err: Error) => void;
}

export interface ReconnectingWebSocket {
  close(): void;
  send(data: unknown): boolean;
  reconnect(): void;
}

/**
 * Manages a WebSocket connection with exponential backoff reconnection.
 */
export function createReconnectingWebSocket(
  hubUrl: string,
  handlers: WsHandlers,
): ReconnectingWebSocket {
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  let currentSocket: { close: () => void; send: (data: unknown) => boolean } | null = null;
  let connectionGeneration = 0;

  function connect() {
    const generation = ++connectionGeneration;
    const wsUrl = hubUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new WebSocket(`${wsUrl}/parties/hub/hub`);
    let pingInterval: ReturnType<typeof setInterval> | null = null;
    const isCurrent = () => active && generation === connectionGeneration;

    ws.addEventListener("open", () => {
      if (!isCurrent()) {
        ws.close();
        return;
      }
      pingInterval = setInterval(() => {
        if (isCurrent() && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
      retryCount = 0;
      handlers.onConnected?.();
    });

    ws.addEventListener("message", (event) => {
      if (!isCurrent()) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const dispatchMessage = (msg: WsServerMessage) => {
        switch (msg.type) {
          case "capabilities":
            handlers.onCapabilities?.(msg);
            break;
          case "message-received":
            handlers.onMessage?.(msg);
            break;
          case "terminal-input-ack":
            handlers.onTerminalInputAck?.(msg);
            break;
          case "terminal-control-ack":
            handlers.onTerminalControlAck?.(msg);
            break;
          case "machine-updated":
            handlers.onMachineUpdated?.(msg.machine);
            break;
          case "session-updated":
            handlers.onSessionUpdated?.(msg.session);
            break;
          case "session-deleted":
            handlers.onSessionDeleted?.(msg.sessionId);
            break;
          case "permission-created":
            handlers.onPermissionCreated?.(msg.permission);
            break;
          case "permission-resolved":
            handlers.onPermissionResolved?.(msg.permission);
            break;
          case "env-upsert":
            handlers.onEnvUpsert?.(msg.env);
            break;
          case "env-remove":
            handlers.onEnvRemove?.(msg.slug);
            break;
          case "repo-upsert":
            handlers.onRepoUpsert?.(msg.repo);
            break;
          case "repo-remove":
            handlers.onRepoRemove?.(msg.repoId);
            break;
          case "plan-artifact-updated":
            handlers.onPlanArtifactUpdated?.(msg.repoId, msg.planArtifactId);
            break;
          case "plan-writer-state":
            handlers.onPlanWriterState?.(msg.repoId, msg.planArtifactId);
            break;
          case "repo-main-changed":
            handlers.onRepoMainChanged?.(
              msg.repoId,
              msg.repoUrl,
              msg.previousMainCommit,
              msg.currentMainCommit,
              msg.sourceEnvSlug,
            );
            break;
          case "error":
            handlers.onError?.(new Error(msg.message));
            break;
          case "replay":
            for (const replayed of msg.events) {
              dispatchMessage(replayed);
            }
            break;
          case "pong":
            break;
        }
      };

      const msg = normalizeWsServerMessage(parsed);
      if (!msg) return;
      dispatchMessage(msg);
    });

    ws.addEventListener("close", (event) => {
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = null;
      if (!isCurrent()) return;
      currentSocket = null;
      handlers.onDisconnected?.();
      // 4001 = server-side auth rejection; retrying with same credentials won't help
      if (event.code === 4001) {
        handlers.onReconnectExhausted?.();
        return;
      }
      if (retryCount >= 15) {
        handlers.onReconnectExhausted?.();
        return;
      }
      const step = BACKOFF_STEPS[Math.min(retryCount, BACKOFF_STEPS.length - 1)];
      const delay = step * (0.5 + Math.random() * 0.5) * 1000;
      retryCount++;
      retryTimeout = setTimeout(() => {
        retryTimeout = null;
        connect();
      }, delay);
    });

    currentSocket = {
      close: () => ws.close(),
      send: (data) => {
        if (ws.readyState !== WebSocket.OPEN) {
          return false;
        }
        ws.send(JSON.stringify(data));
        return true;
      },
    };
  }

  connect();

  return {
    close() {
      active = false;
      connectionGeneration += 1;
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = null;
      const previous = currentSocket;
      currentSocket = null;
      previous?.close();
    },
    send(data) {
      return currentSocket?.send(data) ?? false;
    },
    reconnect() {
      active = true;
      retryCount = 0;
      connectionGeneration += 1;
      if (retryTimeout) clearTimeout(retryTimeout);
      retryTimeout = null;
      const previous = currentSocket;
      currentSocket = null;
      previous?.close();
      connect();
    },
  };
}
