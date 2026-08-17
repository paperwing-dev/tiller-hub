import type {
  CodexAuthMode,
  CodexExecutionProfile,
  ExecutionPlacement,
  ResolvedClaudeAuthMode,
} from "../types";

export interface Basis {
  repoId: string;
  mainCommit: string | null;
  envSlug?: string;
}

// Session scope exists as a compatibility bridge while current session chat
// moves out of HubDO and onto ThreadDO.
export type ThreadScope =
  | { type: "session"; sessionId: string }
  | { type: "repo"; repoId: string }
  | { type: "env"; envSlug: string };

export type ThreadKind = "chat" | "status" | "questions";
export type ThreadMessageKind = "chat" | "status" | "question" | "ack";

export interface Thread {
  id: string;
  scope: ThreadScope;
  kind: ThreadKind;
  title?: string;
  createdAt: string;
  archivedAt?: string;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  seq: number;
  senderSessionId: string;
  kind: ThreadMessageKind;
  body: unknown;
  localId?: string;
  artifactIds?: string[];
  createdAt: string;
}

/** Chat body used by Plan and Environment Review threads. */
export interface ReviewThreadMessageBody {
  role: "user" | "assistant";
  text: string;
  /** Optional only so historical messages created before run correlation remain readable. */
  runId?: string;
  planVersion?: number;
}

export type ArtifactType = "plan" | "review" | "decision" | "checkpoint" | "completion";
export type PlanStatus = "draft" | "evaluating" | "todo" | "completed" | "archived";
export type PlannerRunRole = "reviewer";
export type PlannerRunStatus = "queued" | "running" | "saving" | "completed" | "failed" | "cancelled";
export type PlanContributionStatus = "pending" | "incorporated" | "dismissed";
export type PlanContributionSourceKind =
  | "manual"
  | "reviewer_message"
  | "reviewer_run"
  | "skill_guidance"
  | "skill_overview"
  | "curated_reviewer_handoff";
export type PlanWriterProvider = "claude-code" | "codex" | "opencode";
export type PlanWriterLifecycle = "not_running" | "starting" | "running";
export type PlanWriterStartupStage = "reserving" | "launching";
export type PlanWriterStopReason =
  | "user"
  | "idle"
  | "completed"
  | "archived"
  | "runtime_ended"
  | "mode_invalidated"
  | "watchdog";
export type PlanWriterSynchronizationState = "up_to_date" | "saving" | "sync_failed";
export type PlanAttentionSourceKind = "scribe" | "reviewer";
export type SkillSurface = "plan" | "review";
export type SkillAutomationMode = "auto" | "manual";
export type SkillOrigin = "builtin" | "custom";
export type SkillRunRole =
  | "root_initial"
  | "root_followup"
  | "report_initial"
  | "report_followup"
  | "overview";
export type SkillInvocationStatus = "setting_up" | "active" | "completed" | "failed" | "cancelled";
export type ReviewNodeKind = "generic" | "skill_root" | "report";
export type PlanRiskLevel = "low" | "medium" | "high";
export type PlanChangeSize = "small" | "medium" | "large";

export interface PlanHealthValues {
  risk: {
    level: PlanRiskLevel;
    summary: string;
  };
  changeSize: {
    size: PlanChangeSize;
    summary: string;
  };
}

export interface PlanHealthAssessment {
  schemaVersion: 1;
  assessments: PlanHealthValues;
  assessedAt: string;
  skillInvocationId: string;
  basisVersion: number;
  staleAt?: string;
}

export interface PlanHealthSkillResult {
  kind: "plan-health";
  schemaVersion: 1;
  assessments: PlanHealthValues;
  assessedAt: string;
  basisVersion: number;
  application: "applied" | "plan_changed";
}

export interface AgentRoute {
  key: string;
  label: string;
  harness: "codex" | "claude-code" | "opencode";
  provider: string;
  model: string;
  modelId: string;
  supportedEfforts: PlannerEffort[];
  defaultEffort: PlannerEffort;
  available: boolean;
  disabledReason?: string;
}

export interface AgentDefinition {
  id: string;
  label: string;
  routeKey: string;
  effort: PlannerEffort;
  instructions: string;
  reportMode: SkillAutomationMode;
}

export interface AgentSkillDefinition {
  id: string;
  surface: SkillSurface;
  command: string;
  label: string;
  description: string;
  sharedInstructions: string;
  overviewInstructions: string;
  overviewMode: SkillAutomationMode;
  agents: AgentDefinition[];
  origin: SkillOrigin;
  customized: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type SkillDefinitionSnapshot = AgentSkillDefinition;

export interface PlannerRunBasis {
  artifactId: string;
  title: string;
  markdown: string;
  normalizationVersion?: 1;
  version: number;
  gitBaseCommitSha: string | null;
}

export interface FrozenOverviewReport {
  messageId: string;
  runId: string;
  threadId: string;
  agentId: string;
  agentLabel: string;
  text: string;
}

export interface FrozenOverviewPayload {
  invocationId: string;
  skillId: string;
  skillLabel: string;
  mode: SkillAutomationMode;
  reports: FrozenOverviewReport[];
  failureNotices: Array<{ agentId: string; agentLabel: string; status: string; error?: string }>;
  guidance: string | null;
  overviewInstructions: string;
  frozenAt: string;
}

export interface FrozenReviewRoute {
  provider: string;
  model: string;
  effort: PlannerEffort;
}

export interface RepoPlanWriterSettings {
  repoId: string;
  routeKey: string;
  effort: PlannerEffort;
  planFormat: string;
  updatedAt: string | null;
}

export interface PlanSkillInvocation {
  invocationId: string;
  repoId: string;
  planArtifactId: string;
  parentThreadId: string;
  definitionSnapshot: SkillDefinitionSnapshot;
  basis: PlannerRunBasis;
  status: SkillInvocationStatus;
  overviewMode: SkillAutomationMode;
  includedMessageIds: string[];
  overviewRunId: string | null;
  overviewRoute: FrozenReviewRoute | null;
  error: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
  result: PlanHealthSkillResult | null;
}

export interface SkillInvocationSummary {
  invocationId: string;
  parentThreadId: string;
  skillId: string;
  command: string;
  label: string;
  status: SkillInvocationStatus;
  agentCount: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface PlannerProviderCapabilities {
  writer: boolean;
  reviewer: boolean;
  chatContinuation: boolean;
  cancellation: boolean;
  planDelta: boolean;
  checklist: boolean;
}

export interface PlannerProviderModel {
  id: string;
  displayName: string;
  available: boolean;
  authStatus: "available" | "missing" | "unavailable";
  disabledReason?: string;
  efforts?: PlannerProviderEffort[];
  defaultEffort?: PlannerEffort;
}

export type PlannerEffort = "low" | "medium" | "high" | "xhigh" | "ultra" | "max";

export interface PlannerProviderEffort {
  id: PlannerEffort;
  displayName: string;
}

export interface PlannerProviderMetadata {
  id: string;
  displayName: string;
  available: boolean;
  authStatus: "available" | "missing" | "unavailable";
  disabledReasons: string[];
  capabilities: PlannerProviderCapabilities;
  models: PlannerProviderModel[];
  efforts: PlannerProviderEffort[];
  defaultEffort: PlannerEffort;
}

export interface Artifact<TBody = unknown> {
  id: string;
  repoId: string;
  type: ArtifactType;
  basis: Basis;
  title: string;
  body: TBody;
  status?: PlanStatus;
  parentArtifactId?: string;
  supersedesArtifactId?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt?: string;
  version?: number;
  /** Present only for plan artifacts with a valid persisted Health snapshot. */
  planHealth?: PlanHealthAssessment;
}

export interface ArtifactRef {
  repoId: string;
  name: string;
  artifactId: string;
  version: number;
  updatedAt: string;
}

export interface PlanAttentionItem {
  planArtifactId: string;
  sourceKind: PlanAttentionSourceKind;
  sourceId: string;
  token: string;
}

export interface PlanArtifactBody {
  markdown: string;
}

export interface PlanReviewIssue {
  issue: string;
  evidenceQuote: string;
  recommendedChange: string;
}

export interface PlanReviewIssueStats {
  total: number;
  kept: number;
  dropped: number;
}

export interface PlanReviewMeta {
  toolCallCount: number;
  finishReason?: string;
  truncated?: boolean;
  warningCount?: number;
  repaired?: boolean;
  retriedForToolUse?: boolean;
}

export interface ReviewArtifactBody {
  summary: string;
  findings: string[];
  relevantFiles: string[];
  openQuestions: string[];
  proposedPlan: string;
  memoryRefs: string[];
  model?: string;
  reviewIssues?: PlanReviewIssue[];
  reviewIssueStats?: PlanReviewIssueStats;
  reviewMeta?: PlanReviewMeta;
}

export type PlanArtifact = Artifact<PlanArtifactBody> & { type: "plan" };
export type ReviewArtifact = Artifact<ReviewArtifactBody> & { type: "review" };

export interface CreateArtifactInput<TBody = unknown> {
  id?: string;
  repoId: string;
  type: ArtifactType;
  basis: Basis;
  title: string;
  body: TBody;
  status?: PlanStatus;
  parentArtifactId?: string;
  supersedesArtifactId?: string;
  createdBy?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number;
}

export interface ArtifactListFilter {
  type?: ArtifactType;
  status?: PlanStatus;
  parentArtifactId?: string | null;
  basisMainCommit?: string | null;
  limit?: number;
}

export interface PlanContribution {
  id: string;
  repoId: string;
  planArtifactId: string;
  sourceKind: PlanContributionSourceKind;
  sourceRunId?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
  sourcePlanVersion?: number;
  sourceRefs: PlanContributionSourceRef[];
  provider: string;
  model: string;
  skill?: string;
  text: string;
  status: PlanContributionStatus;
  createdAt: string;
  updatedAt: string;
  incorporatedAt?: string;
  dismissedAt?: string;
}

export interface PlanContributionSourceRef {
  threadId: string;
  messageId: string;
  runId: string;
}

export interface ReviewerRunAttribution {
  status: PlannerRunStatus;
  error?: string;
  provider: string;
  model: string;
  effort?: PlannerEffort;
  skillRunRole?: SkillRunRole;
  command?: string;
  agentLabel?: string;
}

export interface WriterPublicationCursor {
  sequence: number;
  providerEventId: string;
  bodyDigest: string;
  artifactVersion: number;
  result: "updated" | "unchanged";
}

export interface ObservedPlanPublication {
  repoId: string;
  planArtifactId: string;
  generation: number;
  providerConversationId: string;
  sequence: number;
  providerEventId: string;
  markdown: string;
  bodyDigest: string;
}

export type PublishObservedPlanResult =
  | {
      status: "updated" | "unchanged" | "replayed";
      changed: boolean;
      artifactVersion: number;
      cursor: WriterPublicationCursor;
      artifact: Artifact<PlanArtifactBody>;
    }
  | {
      status: "rejected";
      reason:
        | "writer_not_found"
        | "generation_mismatch"
        | "writer_not_running"
        | "plan_ineligible"
        | "conversation_mismatch"
        | "sequence_mismatch"
        | "cursor_payload_mismatch";
      expectedSequence?: number;
    };

export interface StartPlanWriterRequest {
  routeKey?: string;
  effort?: PlannerEffort;
}

export interface StopPlanWriterRequest {
  expectedGeneration: number;
}

export interface PlanWriterActivity {
  lastMeaningfulActivityAt: number;
  turnActive: boolean;
  publicationActive: boolean;
}

export interface CreatePlanContributionInput {
  id?: string;
  repoId: string;
  planArtifactId: string;
  sourceKind?: PlanContributionSourceKind;
  sourceRunId?: string;
  sourceThreadId?: string;
  sourceMessageId?: string;
  sourcePlanVersion?: number;
  sourceRefs?: PlanContributionSourceRef[];
  idempotencyKey?: string;
  provider: string;
  model: string;
  skill?: string;
  text: string;
  createdAt?: string;
}

export type CreateCuratedPlanContributionResult =
  | { status: "created"; contribution: PlanContribution }
  | { status: "existing"; contribution: PlanContribution }
  | { status: "conflict"; contribution: PlanContribution; reason: "request_payload_changed" }
  | { status: "source_used"; source: PlanContributionSourceRef };

export type CreateOrGetPlanContributionResult =
  | { status: "created"; contribution: PlanContribution }
  | { status: "existing"; contribution: PlanContribution }
  | { status: "conflict"; contribution: PlanContribution; expectedDigest: string; actualDigest: string };

export interface PlanContributionListFilter {
  status?: PlanContributionStatus;
}

export interface PlannerRunSkillSnapshot {
  id: string;
  command: string;
  label: string;
  instructions: string;
}

export interface PlannerRunInput {
  instruction?: string;
  sourcePlanVersion?: number;
  githubBaseCommitSha?: string | null;
  skillSnapshot?: PlannerRunSkillSnapshot;
  skillDefinitionSnapshot?: SkillDefinitionSnapshot;
  basis?: PlannerRunBasis;
  effort?: PlannerEffort;
  frozenOverview?: FrozenOverviewPayload;
}

/** Internal storage input. Never serialize this shape through planner APIs. */
export interface StoredPlannerRunInput extends PlannerRunInput {
  initialResultHandler?: "plan-health@1";
}

export interface PlannerRunRuntimeProvenance {
  jobSlug: string;
}

export type PlannerRunLaunchProvenance = ExecutionPlacement & {
  schemaVersion: 1;
  codexExecution?: CodexExecutionProfile;
  claudeAuthMode?: ResolvedClaudeAuthMode;
};

export interface PlanWriterSkillProjectionEnvelope {
  version: 1;
  repositoryId: string;
  planId: string;
  generation: number;
  skills: AgentSkillDefinition[];
}

export type PlanWriterLaunchProvenance = ExecutionPlacement & {
  schemaVersion: 2;
  codexExecution?: CodexExecutionProfile;
  claudeAuthMode?: ResolvedClaudeAuthMode;
  skillProjection: PlanWriterSkillProjectionEnvelope;
};

export interface PlanWriterRuntimeProvenance extends PlannerRunRuntimeProvenance {
  generation: number;
}

/**
 * Immutable, versioned ownership snapshot for backend work that must be
 * destroyed after the plan-facing mutation has committed.
 */
export type PlanRuntimeCleanupTargetV1 =
  | {
      schemaVersion: 1;
      cleanupId: string;
      kind: "writer";
      repoId: string;
      planArtifactId: string;
      ownerId: string;
      generation: number;
      runtime: PlanWriterRuntimeProvenance | null;
      launchProvenance:
        PlanWriterLaunchProvenance | PlannerRunLaunchProvenance | null;
    }
  | {
      schemaVersion: 1;
      cleanupId: string;
      kind: "reviewer";
      repoId: string;
      planArtifactId: string;
      ownerId: string;
      runtime: PlannerRunRuntimeProvenance;
      launchProvenance: PlannerRunLaunchProvenance;
    };

/**
 * Cleanup needs only an exact runtime identity and its execution placement.
 * Keeping this envelope independent from launch configuration lets cleanup
 * survive changes to skills, provider metadata, and other agent contracts.
 */
export type PlanRuntimeCleanupTargetV2 =
  | {
      schemaVersion: 2;
      cleanupId: string;
      kind: "writer";
      repoId: string;
      planArtifactId: string;
      ownerId: string;
      generation: number;
      runtime: PlanWriterRuntimeProvenance | null;
      placement: ExecutionPlacement | null;
    }
  | {
      schemaVersion: 2;
      cleanupId: string;
      kind: "reviewer";
      repoId: string;
      planArtifactId: string;
      ownerId: string;
      runtime: PlannerRunRuntimeProvenance;
      placement: ExecutionPlacement;
    };

export type PlanRuntimeCleanupTarget =
  PlanRuntimeCleanupTargetV1 | PlanRuntimeCleanupTargetV2;

export interface PlannerRun {
  runId: string;
  repoId: string;
  planArtifactId: string;
  role: PlannerRunRole;
  provider: string;
  model: string;
  skill?: string;
  status: PlannerRunStatus;
  startedAt: string;
  completedAt?: string;
  error?: string;
  threadId?: string;
  input?: PlannerRunInput;
  runtime?: PlannerRunRuntimeProvenance;
  launchProvenance?: PlannerRunLaunchProvenance;
  codexAuthMode?: CodexAuthMode;
  skillInvocationId?: string;
  skillAgentId?: string;
  skillRunRole?: SkillRunRole;
  // Updated on every runtime callback (incl. empty status polls): the proof a
  // container is actively serving this run, regardless of event-log bounds.
  lastContactAt?: string;
}

export interface CreatePlannerRunInput {
  runId?: string;
  repoId: string;
  planArtifactId: string;
  role: PlannerRunRole;
  provider: string;
  model: string;
  skill?: string;
  threadId?: string;
  startedAt?: string;
  input?: StoredPlannerRunInput;
  skillInvocationId?: string;
  skillAgentId?: string;
  skillRunRole?: SkillRunRole;
  expectedPlanVersion?: number;
  launchProvenance: PlannerRunLaunchProvenance;
}

export interface UpdatePlannerRunInput {
  runId: string;
  status: PlannerRunStatus;
  completedAt?: string | null;
  error?: string | null;
}

export interface PlannerRunEvent {
  runId: string;
  repoId: string;
  planArtifactId: string;
  seq: number;
  type: string;
  message?: string;
  data?: unknown;
  createdAt: string;
}

export interface AppendPlannerRunEventInput {
  runId: string;
  repoId: string;
  planArtifactId: string;
  type: string;
  message?: string;
  data?: unknown;
  createdAt?: string;
}

export interface UpdateArtifactStatusInput {
  repoId: string;
  id: string;
  status: PlanStatus;
  expectedVersion?: number | null;
}

export interface FinishActiveReviewerRunInput {
  runId: string;
  repoId: string;
  planArtifactId: string;
  status: "completed" | "failed";
  completedAt: string;
  error?: string | null;
  /**
   * Watchdog-only fence for abandoning a stale active run. The store rechecks
   * every persisted liveness signal against this cutoff in the same
   * transaction that finalizes the run.
   */
  staleActiveCutoff?: string;
  /**
   * Dispatch-only ownership fence. `null` means the caller may finalize only
   * while no runtime has been claimed; a value requires that exact runtime.
   * Omitted callers retain the existing completion/failure semantics.
   */
  expectedRuntime?: PlannerRunRuntimeProvenance | null;
  events: Array<{
    type: string;
    message?: string;
    data?: unknown;
  }>;
}

export interface FinishActiveReviewerRunResult {
  run: PlannerRun;
  finalized: boolean;
}

export type ReviewerTerminalOutput =
  | { status: "succeeded"; text: string }
  | { status: "failed"; error: string };

export type PlanHealthCompletionResult =
  | { handled: false }
  | {
      handled: true;
      run: PlannerRun;
      finalized: boolean;
      result?: PlanHealthSkillResult;
      error?: string;
    };

export interface SavePlanInput {
  repoId: string;
  id: string;
  markdown: string;
}

export interface SavePlanResult {
  artifact: Artifact<PlanArtifactBody>;
  changed: boolean;
}

export type RepoPlanMutationErrorCode =
  | "invalid_request"
  | "source_inactive"
  | "plan_not_found"
  | "self_target"
  | "plan_not_editable"
  | "target_writer_active"
  | "version_conflict"
  | "idempotency_conflict";

interface RepoPlanMutationSource {
  repoId: string;
  sourcePlanId: string;
  sourceGeneration: number;
}

export type RepoPlanMutationInput =
  | (RepoPlanMutationSource & {
      kind: "create";
      requestId: string;
      markdown: string;
    })
  | (RepoPlanMutationSource & {
      kind: "update";
      targetPlanId: string;
      expectedVersion: number;
      markdown: string;
    });

export type RepoPlanMutationResult =
  | {
      ok: true;
      outcome: "created" | "updated" | "unchanged" | "replayed";
      artifact: Artifact<PlanArtifactBody>;
    }
  | {
      ok: false;
      code: RepoPlanMutationErrorCode;
      currentVersion?: number;
    };

export interface DiscardPlanInput {
  repoId: string;
  id: string;
  expectedVersion?: number | null;
}

export interface ResetPlanAgentsInput {
  repoId: string;
  resetId: string;
  requestHash: string;
}

export interface PlanAgentResetReport {
  resetId: string;
  resetAt: string;
  plansPreserved: number;
  scribesRemoved: number;
  reviewersRemoved: number;
  runsRetired: number;
  cleanupQueued: number;
}

export interface UnsupportedPlanAgentCleanupOwner {
  kind: "writer" | "reviewer" | "cleanup";
  planArtifactId: string;
  ownerId: string;
  cleanupId?: string;
}

export type ResetPlanAgentsResult =
  | {
      status: "reset" | "replayed";
      report: PlanAgentResetReport;
    }
  | { status: "idempotency_conflict" }
  | {
      status: "unsupported_cleanup_ownership";
      blockerCount: number;
      blockers: UnsupportedPlanAgentCleanupOwner[];
    };

export interface ReviewerRegistryEntry {
  threadId: string;
  planArtifactId: string;
  repoId: string;
  provider: string;
  model: string;
  effort?: PlannerEffort;
  fastMode?: boolean;
  skill?: string;
  // Plan Writer rows and reviewer rows share this registry, but their runtime
  // contracts are independent: reviewers are one-shot, writers own a native TUI.
  role: "reviewer" | "writer";
  runId?: string;
  status?: PlannerRunStatus;
  error?: string;
  providerConversationId?: string;
  reviewerModel: string;
  removedAt?: string;
  createdAt: string;
  updatedAt: string;
  jobSlug?: string;
  runtime?: PlanWriterRuntimeProvenance;
  launchProvenance?: PlanWriterLaunchProvenance;
  codexAuthMode?: CodexAuthMode;
  generation?: number;
  stoppedAt?: string;
  stopReason?: PlanWriterStopReason;
  basisCommit?: string;
  startBodyDigest?: string;
  publicationCursor?: WriterPublicationCursor;
  synchronizationError?: string;
  startupError?: string;
  cleanupError?: string;
  skillInvocationId?: string;
  skillAgentId?: string;
  nodeKind: ReviewNodeKind;
  skillRootThreadId: string | null;
  displayLabel?: string;
}

export interface PlanWriterState {
  lifecycle: PlanWriterLifecycle;
  threadId?: string | null;
  generation: number | null;
  provider: PlanWriterProvider | null;
  model: string | null;
  effort: PlannerEffort | null;
  basisCommit: string | null;
  terminalId: string | null;
  codexAuthMode?: CodexAuthMode;
  stopReason?: PlanWriterStopReason;
  startupError?: string;
  cleanupError?: string;
  startup?: {
    stage: PlanWriterStartupStage;
    updatedAt: string;
  };
  synchronization: {
    state: PlanWriterSynchronizationState;
    error?: string;
  };
  editable: boolean;
}

export interface UpsertReviewerInput {
  repoId: string;
  planArtifactId: string;
  provider: string;
  model: string;
  effort?: PlannerEffort;
  skill?: string;
  reviewerModel?: string;
  threadId?: string;
  skillInvocationId?: string;
  skillAgentId?: string;
  nodeKind?: ReviewNodeKind;
  skillRootThreadId?: string | null;
}

export interface SetRefInput {
  repoId: string;
  name: string;
  artifactId: string;
  expectedVersion?: number | null;
}

export interface CreateThreadInput {
  id: string;
  scope: ThreadScope;
  kind: ThreadKind;
  title?: string;
  createdAt?: string;
  archivedAt?: string;
}

export interface AppendThreadMessageInput {
  id?: string;
  senderSessionId: string;
  seq: number;
  kind: ThreadMessageKind;
  body: unknown;
  localId?: string;
  artifactIds?: string[];
  createdAt?: string;
}

/**
 * Session messages use ThreadDO as their sequence authority. Unlike the
 * generic thread API, callers never supply a sequence number.
 */
export interface AppendSessionMessageInput {
  id: string;
  sessionId: string;
  senderSessionId: string;
  kind: ThreadMessageKind;
  body: unknown;
  localId?: string;
  createdAt?: string;
}

export interface AppendSessionMessageResult {
  message: ThreadMessage;
  newlyInserted: boolean;
}

export type ThreadSequenceAuthority = "external-v0" | "thread-v1";

export interface ThreadMessageListFilter {
  limit?: number;
  beforeSeq?: number;
  afterSeq?: number;
}
