import type { PlanReviewIssue, PlanReviewIssueStats, PlanReviewMeta } from "../agent-core/types";

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
export type PlanStatus = "draft" | "todo" | "completed" | "archived";

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

export interface SavePlanInput {
  repoId: string;
  id: string;
  expectedVersion: number;
  markdown: string;
  title?: string;
  currentMainCommit: string | null;
}

export type SavePlanResult =
  | { status: "ok"; version: number; artifact: Artifact<PlanArtifactBody> }
  | { status: "conflict"; currentVersion: number; currentTitle?: string; currentMarkdownDigest?: string };

export interface UpdateArtifactStatusInput {
  repoId: string;
  id: string;
  status: PlanStatus;
  expectedVersion?: number | null;
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
  reviewerModel: string;
  removedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertReviewerInput {
  repoId: string;
  planArtifactId: string;
  reviewerModel: string;
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

export interface ThreadMessageListFilter {
  limit?: number;
  beforeSeq?: number;
  afterSeq?: number;
}
