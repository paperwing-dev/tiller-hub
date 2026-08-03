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

export type ArtifactType = "plan" | "review" | "decision" | "checkpoint" | "completion";
export type PlanStatus = "draft" | "evaluating" | "todo" | "completed" | "archived";
export type PlannerRunRole = "reviewer";
export type PlannerRunStatus = "queued" | "running" | "saving" | "completed" | "failed" | "cancelled";
export type PlanContributionStatus = "pending" | "incorporated" | "dismissed";
export type PlanContributionSourceKind = "manual" | "reviewer_message" | "reviewer_run" | "skill_guidance";
export type PlanWriterProvider = "claude-code" | "codex";
export type PlanWriterLifecycle = "not_running" | "starting" | "running";
export type PlanWriterStopReason =
  | "user"
  | "idle"
  | "completed"
  | "archived"
  | "runtime_ended"
  | "mode_invalidated"
  | "watchdog";
export type PlanWriterSynchronizationState = "up_to_date" | "saving" | "sync_failed";
export type SkillSurface = "plan" | "review";
export type SkillAutomationMode = "auto" | "manual";
export type SkillOrigin = "builtin" | "custom";
export type SkillRunRole = "child_initial" | "child_followup" | "overview";
export type SkillInvocationStatus = "setting_up" | "active" | "completed" | "failed" | "cancelled";

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

export interface RepoPlanWriterSettings {
  repoId: string;
  routeKey: string;
  effort: PlannerEffort;
  fastMode: boolean;
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
  error: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
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
}

export interface ArtifactRef {
  repoId: string;
  name: string;
  artifactId: string;
  version: number;
  updatedAt: string;
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
  provider?: PlanWriterProvider;
  model?: string;
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
  idempotencyKey?: string;
  provider: string;
  model: string;
  skill?: string;
  text: string;
  createdAt?: string;
}

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
}

export interface PlannerRunRuntimeProvenance {
  jobSlug: string;
}

export type PlannerRunLaunchProvenance = ExecutionPlacement & {
  schemaVersion: 1;
  codexExecution?: CodexExecutionProfile;
  claudeAuthMode?: ResolvedClaudeAuthMode;
};

export type PlanWriterLaunchProvenance = PlannerRunLaunchProvenance;

export interface PlanWriterRuntimeProvenance extends PlannerRunRuntimeProvenance {
  generation: number;
}

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
  input?: PlannerRunInput;
  skillInvocationId?: string;
  skillAgentId?: string;
  skillRunRole?: SkillRunRole;
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

export interface SavePlanInput {
  repoId: string;
  id: string;
  markdown: string;
}

export interface DiscardPlanInput {
  repoId: string;
  id: string;
  expectedVersion?: number | null;
}

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
}

export interface PlanWriterState {
  lifecycle: PlanWriterLifecycle;
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
