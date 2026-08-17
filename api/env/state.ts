import type {
  EnvDefinition,
  EnvHarnessPresentation,
  EnvInfraState,
  EnvLifecycleDesiredState,
  EnvLifecyclePhase,
  EnvMeta,
  EnvMutableState,
  EnvStatus,
} from "../types";
import {
  getHarnessModel,
  validateHarnessSettings,
} from "../../shared/harness-catalog";
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

function normalizeImplementorAttentionState(
  value: EnvMutableState["implementorAttentionState"] | undefined,
): EnvMutableState["implementorAttentionState"] {
  const runtimeStartOpId = typeof value?.runtimeStartOpId === "string"
    ? value.runtimeStartOpId.trim()
    : "";
  const unreadToken = typeof value?.unreadToken === "string"
    ? value.unreadToken.trim()
    : "";
  const lastReviewerCompletionRunId = typeof value?.lastReviewerCompletionRunId === "string"
    ? value.lastReviewerCompletionRunId.trim()
    : "";
  return {
    runtimeStartOpId: runtimeStartOpId || null,
    lastCompletionSequence: typeof value?.lastCompletionSequence === "number"
      && Number.isSafeInteger(value.lastCompletionSequence)
      && value.lastCompletionSequence >= 0
      ? value.lastCompletionSequence
      : 0,
    ...(lastReviewerCompletionRunId ? { lastReviewerCompletionRunId } : {}),
    unreadToken: unreadToken || null,
  };
}

export function createEmptyMutableState(overrides: Partial<EnvMutableState> = {}): EnvMutableState {
  const updatedAt = overrides.updatedAt ?? new Date().toISOString();
  return {
    status: overrides.status ?? "unknown",
    scmModel: overrides.scmModel ?? "github",
    harnessSettings: overrides.harnessSettings ?? null,
    startClaudeAuthMode: overrides.startClaudeAuthMode === "subscription" || overrides.startClaudeAuthMode === "api"
      ? overrides.startClaudeAuthMode
      : null,
    startCodexAuthPreference: overrides.startCodexAuthPreference === "subscription"
      || overrides.startCodexAuthPreference === "api-key"
      ? overrides.startCodexAuthPreference
      : null,
    ...(overrides.scheduledRun ? { scheduledRun: overrides.scheduledRun } : {}),
    lifecyclePhase: overrides.lifecyclePhase ?? null,
    lifecycleOpId: overrides.lifecycleOpId ?? null,
    lifecycleOperation: overrides.lifecycleOperation ?? null,
    lifecycleDesiredState: overrides.lifecycleDesiredState ?? null,
    lifecycleLastRunnerState: overrides.lifecycleLastRunnerState ?? null,
    lifecycleLastWorkspaceSyncedAckOpId: overrides.lifecycleLastWorkspaceSyncedAckOpId ?? null,
    lifecycleInfraState: overrides.lifecycleInfraState ?? "unknown",
    lifecycleRuntimeReady: overrides.lifecycleRuntimeReady ?? false,
    lifecycleUpdatedAt: overrides.lifecycleUpdatedAt ?? null,
    implementorAttentionState: normalizeImplementorAttentionState(
      overrides.implementorAttentionState,
    ),
    runnerId: overrides.runnerId ?? null,
    bootMessage: overrides.bootMessage ?? null,
    bootStepId: overrides.bootStepId ?? null,
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
    githubBaseBranch: overrides.githubBaseBranch ?? null,
    githubBaseCommitSha: overrides.githubBaseCommitSha ?? null,
    githubBranch: overrides.githubBranch ?? null,
    githubHeadCommitSha: overrides.githubHeadCommitSha ?? null,
    githubPrNumber: overrides.githubPrNumber ?? null,
    githubPrUrl: overrides.githubPrUrl ?? null,
    githubPrState: overrides.githubPrState ?? null,
    githubMergedAt: overrides.githubMergedAt ?? null,
    githubPublishStatus: overrides.githubPublishStatus ?? "idle",
    githubPublishOperationId: overrides.githubPublishOperationId ?? null,
    githubPublishError: overrides.githubPublishError ?? null,
    githubLastPublishedAt: overrides.githubLastPublishedAt ?? null,
    githubLastPublishedWorkspaceHash: overrides.githubLastPublishedWorkspaceHash ?? null,
    githubPendingPublish: overrides.githubPendingPublish ?? null,
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
    scmModel: meta.scmModel,
    harnessSettings: meta.harnessSettings ?? null,
    ...(meta.scheduledRun ? { scheduledRun: meta.scheduledRun } : {}),
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
    implementorAttentionState: {
      runtimeStartOpId: meta.lifecycleOperation === "start"
        ? meta.lifecycleOpId ?? null
        : null,
      lastCompletionSequence: 0,
      unreadToken: meta.implementorAttentionToken ?? null,
    },
    runnerId: meta.runnerId ?? null,
    bootMessage: meta.bootMessage ?? null,
    bootStepId: meta.bootStepId ?? null,
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
    githubBaseBranch: meta.githubBaseBranch ?? null,
    githubBaseCommitSha: meta.githubBaseCommitSha ?? null,
    githubBranch: meta.githubBranch ?? null,
    githubHeadCommitSha: meta.githubHeadCommitSha ?? null,
    githubPrNumber: meta.githubPrNumber ?? null,
    githubPrUrl: meta.githubPrUrl ?? null,
    githubPrState: meta.githubPrState ?? null,
    githubMergedAt: meta.githubMergedAt ?? null,
    githubPublishStatus: meta.githubPublishStatus ?? "idle",
    githubPublishOperationId: meta.githubPublishOperationId ?? null,
    githubPublishError: meta.githubPublishError ?? null,
    githubLastPublishedAt: meta.githubLastPublishedAt ?? null,
    githubLastPublishedWorkspaceHash: meta.githubLastPublishedWorkspaceHash ?? null,
    githubPendingPublish: meta.githubPendingPublish ?? null,
    leadHarnessStatus: meta.leadHarnessStatus ?? null,
    leadHarnessError: meta.leadHarnessError ?? null,
    leadHarnessUpdatedAt: meta.leadHarnessUpdatedAt ?? null,
    error: meta.error ?? null,
    errorAt: meta.errorAt ?? null,
    updatedAt: meta.updatedAt,
  });
}

function buildHarnessPresentation(
  definition: EnvDefinition,
  mutableState: EnvMutableState,
): EnvHarnessPresentation | undefined {
  const settings = validateHarnessSettings(definition.harness, mutableState.harnessSettings);
  if (!settings) return undefined;

  const model = getHarnessModel(definition.harness, settings.model);
  if (!model) return undefined;
  const providerKind = model.binding.kind === "opencode"
    ? model.binding.provider
    : model.binding.kind;

  return {
    modelLabel: model.label,
    credentialRequirement: model.credential,
    providerKind,
    providerLabel: model.binding.providerLabel,
  };
}

export function buildEnvMetaFromLayers(
  definition: EnvDefinition,
  mutableState: EnvMutableState,
  repoUrl: string,
): EnvMeta {
  const harnessPresentation = buildHarnessPresentation(definition, mutableState);
  const next: EnvMeta = {
    slug: definition.slug,
    ...(definition.displayName ? { displayName: definition.displayName } : {}),
    incarnationId: definition.incarnationId,
    ...(definition.sidebarSlot ? { sidebarSlot: definition.sidebarSlot } : {}),
    repoUrl,
    repoId: definition.repoId,
    scmModel: definition.scmModel,
    backend: definition.executionPlacement.backend,
    executionPlacement: definition.executionPlacement,
    ...(mutableState.runnerId ? { runnerId: mutableState.runnerId } : {}),
    harness: definition.harness,
    harnessSettings: mutableState.harnessSettings,
    ...(harnessPresentation ? { harnessPresentation } : {}),
    ...(mutableState.scheduledRun ? { scheduledRun: mutableState.scheduledRun } : {}),
    ...(definition.resolvedAuthMode ? { resolvedAuthMode: definition.resolvedAuthMode } : {}),
    ...(definition.codexAuthMode ? { codexAuthMode: definition.codexAuthMode } : {}),
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
    githubBaseBranch: mutableState.githubBaseBranch,
    githubBaseCommitSha: mutableState.githubBaseCommitSha,
    githubBranch: mutableState.githubBranch,
    githubHeadCommitSha: mutableState.githubHeadCommitSha,
    githubPrNumber: mutableState.githubPrNumber,
    githubPrUrl: mutableState.githubPrUrl,
    githubPrState: mutableState.githubPrState,
    githubMergedAt: mutableState.githubMergedAt,
    githubPublishStatus: mutableState.githubPublishStatus,
    githubPublishOperationId: mutableState.githubPublishOperationId,
    githubPublishError: mutableState.githubPublishError,
    githubLastPublishedAt: mutableState.githubLastPublishedAt,
    githubLastPublishedWorkspaceHash: mutableState.githubLastPublishedWorkspaceHash,
    githubPendingPublish: mutableState.githubPendingPublish,
    lifecyclePhase: mutableState.lifecyclePhase,
    lifecycleOpId: mutableState.lifecycleOpId,
    lifecycleOperation: mutableState.lifecycleOperation,
    lifecycleDesiredState: mutableState.lifecycleDesiredState,
    lifecycleInfraState: mutableState.lifecycleInfraState,
    lifecycleRuntimeReady: mutableState.lifecycleRuntimeReady,
    lifecycleUpdatedAt: mutableState.lifecycleUpdatedAt,
    implementorAttentionToken: mutableState.implementorAttentionState.unreadToken,
    leadHarnessStatus: mutableState.leadHarnessStatus,
    leadHarnessError: mutableState.leadHarnessError,
    leadHarnessUpdatedAt: mutableState.leadHarnessUpdatedAt,
    ...(mutableState.error ? { error: mutableState.error } : {}),
    ...(mutableState.errorAt ? { errorAt: mutableState.errorAt } : {}),
  };

  return projectEnvSummary(next);
}
