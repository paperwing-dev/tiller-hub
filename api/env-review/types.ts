import type {
  FrozenOverviewPayload,
  PlannerEffort,
  PlannerRunRuntimeProvenance,
  PlannerRunLaunchProvenance,
  SkillDefinitionSnapshot,
  SkillInvocationStatus,
  FrozenReviewRoute,
  ReviewNodeKind,
  SkillRunRole,
  SkillAutomationMode,
} from "../coordination";

export type EnvReviewTabStatus = "idle" | "preparing" | "queued" | "running" | "ready" | "failed";
export type EnvReviewRunStatus = "preparing" | "queued" | "running" | "ready" | "failed" | "cancelled";
export type EnvReviewTaskKind = "correctness" | "tests" | "architecture" | "security" | "custom" | "recipe-role";
export type EnvReviewFeedbackStatus = "ready" | "pending" | "sent" | "dismissed";
export type EnvReviewPreparationStatus = "preparing" | "succeeded" | "failed" | "timed_out";

export function reviewSkillRerunRunId(requestId: string, agentId: string): string {
  return `env-review-skill-rerun:${requestId}:${agentId}`;
}

export function reviewSkillRerunMessageId(requestId: string, agentId: string): string {
  return `env-review-skill-rerun-message:${requestId}:${agentId}`;
}

export type EnvReviewSnapshotSource = "live-harness" | "saved-workspace";
export type EnvReviewSnapshotMode = "github-overlay" | "full";

export interface EnvReviewSnapshot {
  snapshotId: string;
  source: EnvReviewSnapshotSource;
  mode: EnvReviewSnapshotMode;
  stale: boolean;
  createdAt: string;
  snapshotHash: string;
  baseCommitSha: string | null;
  githubDeletedPaths: string[];
  r2Key: string;
}

export interface EnvReviewSnapshotRequestContract {
  snapshotMode: EnvReviewSnapshotMode;
  baseCommitSha: string | null;
  maxBytes: number;
  excludePrefixes: string[];
}

interface EnvReviewBasePreparationResult {
  opId: string;
  changedCount: number;
  deletedCount: number;
  uploadedBytes: number;
  completedAt: string;
  error?: string | null;
}

export interface EnvReviewSucceededPreparationResult extends EnvReviewBasePreparationResult {
  formatVersion: number;
  status: "succeeded";
  snapshot: EnvReviewSnapshot;
  error?: null;
}

export interface EnvReviewFailedPreparationResult extends EnvReviewBasePreparationResult {
  formatVersion?: number;
  status: "failed";
  snapshot?: null;
}

export type EnvReviewPreparationResult =
  | EnvReviewSucceededPreparationResult
  | EnvReviewFailedPreparationResult;

export interface EnvReviewPreparationOperation {
  opId: string;
  envSlug: string;
  sessionId: string;
  status: EnvReviewPreparationStatus;
  result: EnvReviewPreparationResult | null;
  requestUrl: string | null;
  ackToken: string | null;
  snapshotRequestedAt: string | null;
  snapshotAttempts: number;
  snapshotRequest: EnvReviewSnapshotRequestContract | null;
  timeoutAt: string | null;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface EnvReviewChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  oldSize: number | null;
  newSize: number | null;
  diff?: string;
  omittedReason?: "binary" | "too-large" | "budget-exhausted" | "unavailable";
  truncated?: boolean;
}

export interface EnvReviewChangeContext {
  generatedAt: string;
  summary: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
    omitted: number;
    truncated: number;
    files: Array<{
      path: string;
      status: EnvReviewChangedFile["status"];
      oldSize: number | null;
      newSize: number | null;
      omittedReason?: EnvReviewChangedFile["omittedReason"];
      truncated?: boolean;
    }>;
  };
  files: EnvReviewChangedFile[];
  limits: {
    maxFiles: number;
    maxDiffBytesPerFile: number;
    maxTotalDiffBytes: number;
    maxFileBytesForDiff: number;
  };
}

export interface EnvReviewPlanBasis {
  source: "startup-plan" | "none";
  artifactId: string | null;
  version: number | null;
  title: string | null;
  markdown: string | null;
}

export interface EnvReviewSession {
  envSlug: string;
  repoId: string;
  mainSessionId: string;
  latestPreparationOpId: string | null;
  latestPreparation: EnvReviewPreparationResult | null;
  latestChangeSummary: EnvReviewChangeContext["summary"] | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvReviewTab {
  threadId: string;
  envSlug: string;
  repoId: string;
  mainSessionId: string;
  provider: string;
  model: string;
  effort: PlannerEffort;
  roleLabel: string;
  taskKind: EnvReviewTaskKind;
  customTask: string | null;
  status: EnvReviewTabStatus;
  latestRunId: string | null;
  removedAt: string | null;
  createdAt: string;
  updatedAt: string;
  skillInvocationId: string | null;
  skillAgentId: string | null;
  nodeKind: ReviewNodeKind;
  skillRootThreadId: string | null;
}

export interface EnvReviewRunEvent {
  runId: string;
  seq: number;
  type: string;
  message?: string;
  data?: unknown;
  createdAt: string;
}

export interface EnvReviewRun {
  runId: string;
  threadId: string;
  envSlug: string;
  repoId: string;
  mainSessionId: string;
  provider: string;
  model: string;
  effort: PlannerEffort;
  roleLabel: string;
  taskKind: EnvReviewTaskKind;
  customTask: string | null;
  recipeInstructions: string | null;
  status: EnvReviewRunStatus;
  preparationOpId: string;
  preparation: EnvReviewPreparationResult | null;
  changeContext: EnvReviewChangeContext | null;
  planBasis: EnvReviewPlanBasis | null;
  prompt: string | null;
  runtime: PlannerRunRuntimeProvenance | null;
  launchProvenance?: PlannerRunLaunchProvenance | null;
  startedAt: string;
  queuedAt: string | null;
  completedAt: string | null;
  error: string | null;
  lastContactAt: string | null;
  skillInvocationId: string | null;
  skillAgentId: string | null;
  skillRunRole: SkillRunRole | null;
  skillDefinitionSnapshot: SkillDefinitionSnapshot | null;
  frozenOverview: FrozenOverviewPayload | null;
}

export interface ReviewSkillInvocation {
  invocationId: string;
  envSlug: string;
  repoId: string;
  mainSessionId: string;
  parentThreadId: string;
  definitionSnapshot: SkillDefinitionSnapshot;
  preparationOpId: string;
  status: SkillInvocationStatus;
  overviewMode: SkillAutomationMode;
  includedMessageIds: string[];
  overviewRunId: string | null;
  overviewRoute: FrozenReviewRoute | null;
  error: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvReviewFanoutHandoff {
  schemaVersion: 1;
  kind: "fanout_overview";
  skillLabel: string;
  reviewerCount: number;
  models: Array<{
    provider: string;
    model: string;
  }>;
}

export interface EnvReviewFeedback {
  feedbackId: string;
  envSlug: string;
  repoId: string;
  mainSessionId: string;
  threadId: string;
  runId: string;
  messageId: string;
  provider: string;
  model: string;
  roleLabel: string;
  preparationCompletedAt: string | null;
  text: string;
  status: EnvReviewFeedbackStatus;
  deliveredText: string | null;
  metadata: Record<string, unknown> & { reviewHandoff?: EnvReviewFanoutHandoff };
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
  dismissedAt: string | null;
}

export interface EnvReviewState {
  session: EnvReviewSession;
  tabs: EnvReviewTab[];
  runs: EnvReviewRun[];
  feedback: EnvReviewFeedback[];
}
