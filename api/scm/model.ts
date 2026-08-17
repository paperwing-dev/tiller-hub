import type { EnvBranchStatus, EnvMeta, GitHubEnvPendingPublishProjection, RepoMeta } from "../types";
import { buildEnvBranchName } from "./artifacts";
import { SCM_FORMAT_VERSION } from "./constants";

const TRUE_CONFIG_VALUES = new Set(["1", "true", "yes", "on"]);

export function parseScmBooleanFlag(value?: string | null): boolean {
  if (!value) return false;
  return TRUE_CONFIG_VALUES.has(value.trim().toLowerCase());
}

export function createInitialRepoScmState(): Pick<
  RepoMeta,
  | "scmModel"
  | "githubDefaultBranch"
  | "githubDefaultBranchHeadSha"
  | "githubWebhookConfigured"
  | "githubWebhookError"
  | "mainCommit"
  | "gitArtifactId"
  | "gitStatus"
  | "gitError"
  | "gitFormatVersion"
  | "gitProgressPhase"
  | "gitProgressStartedAt"
  | "gitProgressUpdatedAt"
  | "gitLastBootstrapDurationMs"
  | "gitLastBootstrapTimings"
> {
  return {
    scmModel: "github",
    githubDefaultBranch: null,
    githubDefaultBranchHeadSha: null,
    githubWebhookConfigured: false,
    githubWebhookError: null,
    mainCommit: null,
    gitArtifactId: null,
    gitStatus: "pending",
    gitError: null,
    gitFormatVersion: SCM_FORMAT_VERSION,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
  };
}

export function createInitialEnvScmState(args: {
  slug: string;
  incarnationId?: string | null;
  startupPlanId?: string | null;
  branchName?: string | null;
  mainCommit?: string | null;
  githubBaseBranch?: string | null;
  githubBaseCommitSha?: string | null;
}): Pick<
  EnvMeta,
  | "scmModel"
  | "startupPlanId"
  | "branchName"
  | "branchStatus"
  | "workspaceDirty"
  | "workspaceNeedsAttention"
  | "workspaceLastSyncedAt"
  | "baseMainCommit"
  | "lastKnownMainCommit"
  | "scmOperationType"
  | "scmOperationId"
  | "scmOperationPhase"
  | "scmOperationStartedAt"
  | "scmOperationUpdatedAt"
  | "scmLastCompletedAt"
  | "scmLastDurationMs"
  | "scmLastTimings"
  | "githubBaseBranch"
  | "githubBaseCommitSha"
  | "githubBranch"
  | "githubHeadCommitSha"
  | "githubPrNumber"
  | "githubPrUrl"
  | "githubPrState"
  | "githubMergedAt"
  | "githubPublishStatus"
  | "githubPublishOperationId"
  | "githubPublishError"
  | "githubLastPublishedAt"
  | "githubLastPublishedWorkspaceHash"
  | "githubPendingPublish"
> {
  return {
    scmModel: "github",
    startupPlanId: args.startupPlanId ?? null,
    branchName: args.branchName ?? buildEnvBranchName(args.slug),
    branchStatus: "up-to-date",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: null,
    baseMainCommit: args.mainCommit ?? null,
    lastKnownMainCommit: args.mainCommit ?? null,
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    githubBaseBranch: args.githubBaseBranch ?? null,
    githubBaseCommitSha: args.githubBaseCommitSha ?? null,
    githubBranch: buildGitHubEnvBranchName(args.slug, args.incarnationId),
    githubHeadCommitSha: null,
    githubPrNumber: null,
    githubPrUrl: null,
    githubPrState: null,
    githubMergedAt: null,
    githubPublishStatus: "idle",
    githubPublishOperationId: null,
    githubPublishError: null,
    githubLastPublishedAt: null,
    githubLastPublishedWorkspaceHash: null,
    githubPendingPublish: null,
  };
}

export function buildGitHubEnvBranchName(slug: string, incarnationId?: string | null): string {
  const normalizedSlug = slug.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "env";
  const incarnationSuffix = incarnationId
    ?.trim()
    .replace(/^env-/i, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 12);
  return `tiller/env/${normalizedSlug}${incarnationSuffix ? `-${incarnationSuffix}` : ""}`;
}

export function createGitHubPendingPublishProjection(args: {
  operationId: string;
  branch: string;
  baseCommitSha: string;
  workspaceHash: string;
  expectedPriorHead: string | null;
  pushedCommitSha?: string | null;
  status?: GitHubEnvPendingPublishProjection["status"];
  error?: string | null;
  startedAt?: string;
  updatedAt?: string;
}): GitHubEnvPendingPublishProjection {
  const startedAt = args.startedAt ?? new Date().toISOString();
  return {
    operationId: args.operationId,
    status: args.status ?? "starting",
    branch: args.branch,
    baseCommitSha: args.baseCommitSha,
    workspaceHash: args.workspaceHash,
    expectedPriorHead: args.expectedPriorHead,
    pushedCommitSha: args.pushedCommitSha ?? null,
    startedAt,
    updatedAt: args.updatedAt ?? startedAt,
    error: args.error ?? null,
  };
}

export function buildScmContainerEnvVars(
  meta?: Pick<EnvMeta, "branchName"> | null,
): Record<string, string> {
  return {
    ...(meta?.branchName ? { TILLER_BRANCH_NAME: meta.branchName } : {}),
  };
}

export type StartupPlanSelection =
  | { mode: "todo" }
  | { mode: "specific"; artifactId: string }
  | { mode: "none" };

export function parseStartupPlanSelection(value: unknown): StartupPlanSelection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.mode === "todo") return { mode: "todo" };
  if (record.mode === "none") return { mode: "none" };
  if (record.mode === "specific" && typeof record.artifactId === "string" && record.artifactId.trim()) {
    return { mode: "specific", artifactId: record.artifactId.trim() };
  }
  return null;
}

export function deriveBranchBackedEnvStatus(
  meta: Pick<
    EnvMeta,
    | "scmModel"
    | "branchStatus"
    | "workspaceDirty"
    | "workspaceNeedsAttention"
    | "baseMainCommit"
    | "lastKnownMainCommit"
    | "githubBaseCommitSha"
    | "githubPublishStatus"
    | "githubPrState"
    | "githubMergedAt"
  >,
  repo: Pick<RepoMeta, "mainCommit" | "githubDefaultBranchHeadSha">,
): EnvBranchStatus {
  if (meta.scmModel === "github") {
    return deriveGitHubEnvBranchStatus(meta, repo);
  }

  if (meta.branchStatus === "needs-attention" || meta.workspaceNeedsAttention) {
    return "needs-attention";
  }

  const baseMainCommit = meta.baseMainCommit ?? meta.lastKnownMainCommit ?? null;
  if (baseMainCommit && repo.mainCommit && baseMainCommit !== repo.mainCommit) {
    return "behind-main";
  }

  if (meta.workspaceDirty) {
    return "ready-to-merge";
  }

  if (!baseMainCommit && !repo.mainCommit && meta.branchStatus === "ready-to-merge") {
    return meta.branchStatus;
  }

  return "up-to-date";
}

export function withDerivedBranchBackedEnvStatus(
  meta: EnvMeta,
  repo: Pick<RepoMeta, "mainCommit" | "githubDefaultBranchHeadSha">,
): EnvMeta {
  return {
    ...meta,
    branchStatus: deriveBranchBackedEnvStatus(meta, repo),
  };
}

export function getEffectiveEnvBranchStatus(
  meta: Pick<
    EnvMeta,
    | "scmModel"
    | "branchStatus"
    | "workspaceDirty"
    | "workspaceNeedsAttention"
    | "baseMainCommit"
    | "lastKnownMainCommit"
    | "githubBaseCommitSha"
    | "githubPublishStatus"
    | "githubPrState"
    | "githubMergedAt"
  >,
  repo: Pick<RepoMeta, "mainCommit" | "githubDefaultBranchHeadSha"> | null | undefined,
): EnvBranchStatus {
  return deriveBranchBackedEnvStatus(meta, {
    mainCommit: repo?.mainCommit ?? null,
    githubDefaultBranchHeadSha: repo?.githubDefaultBranchHeadSha ?? null,
  });
}

export function deriveGitHubEnvBranchStatus(
  meta: Pick<EnvMeta, "githubBaseCommitSha" | "githubPublishStatus" | "githubPrState" | "githubMergedAt" | "workspaceDirty" | "workspaceNeedsAttention">
    & Partial<Pick<EnvMeta, "githubPublishError">>,
  repo: Pick<RepoMeta, "githubDefaultBranchHeadSha"> | null | undefined,
): EnvBranchStatus {
  if (
    (meta.workspaceNeedsAttention && !isRecoverableGitHubPublishFailure(meta))
    || meta.githubPublishStatus === "attention"
  ) {
    return "needs-attention";
  }
  if (meta.githubMergedAt || meta.githubPrState === "merged") {
    return "up-to-date";
  }
  if (meta.githubBaseCommitSha && repo?.githubDefaultBranchHeadSha && meta.githubBaseCommitSha !== repo.githubDefaultBranchHeadSha) {
    return "behind-main";
  }
  return meta.workspaceDirty ? "ready-to-merge" : "up-to-date";
}

export function isRecoverableGitHubPublishFailure(
  meta: Pick<EnvMeta, "githubPublishStatus"> & Partial<Pick<EnvMeta, "githubPublishError">>,
): boolean {
  return meta.githubPublishStatus === "failed"
    && /(?:without [`'"]?workflows[`'"]? permission|workflows(?::write|: read and write)?(?: to publish| permission)|remote:\s*repository not found|repository ['"]?https?:\/\/github\.com\/[^\s'"]+['"]? not found)/i.test(meta.githubPublishError ?? "");
}

export function hasCurrentMainBase(
  meta: Pick<EnvMeta, "baseMainCommit">,
  repo: Pick<RepoMeta, "mainCommit">,
): boolean {
  return !!meta.baseMainCommit && !!repo.mainCommit && meta.baseMainCommit === repo.mainCommit;
}

export function isEnvTransitioning(
  meta: Pick<EnvMeta, "status" | "scmOperationType">
    & Partial<Pick<EnvMeta, "githubPublishStatus" | "githubPublishOperationId">>,
): boolean {
  return (
    meta.status === "creating" ||
    meta.status === "starting" ||
    meta.status === "saving" ||
    meta.status === "stopping" ||
    meta.status === "deleting" ||
    !!meta.scmOperationType ||
    meta.githubPublishStatus === "publishing" ||
    !!meta.githubPublishOperationId
  );
}

export function isRepoTransitioning(
  meta: Pick<RepoMeta, "gitStatus">,
): boolean {
  return meta.gitStatus === "pending";
}
