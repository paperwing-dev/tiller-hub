import type { EnvMeta, RepoMeta } from "../types";
import type { GitHubDefaultBranchRefreshFailureKind } from "../repo/refresh";

export type GitHubStartBaseAdvanceDecision =
  | { action: "advance"; baseBranch: string | null; baseCommitSha: string }
  | { action: "stored"; reason: string }
  | {
      action: "block";
      failureKind: Exclude<GitHubDefaultBranchRefreshFailureKind, "transient_error">;
      error: string;
      code: string;
      status: number;
    };

export async function isGitHubDraftOverlayEmpty(
  workspace: {
    getHashedManifest(options?: { excludePrefixes?: string[] }): Promise<unknown[]>;
    readGitHubDeletedWorkspacePaths(): Promise<string[]>;
  },
  options?: { excludePrefixes?: string[] },
): Promise<boolean> {
  const [draftManifest, deletedPaths] = await Promise.all([
    workspace.getHashedManifest({ excludePrefixes: options?.excludePrefixes }),
    workspace.readGitHubDeletedWorkspacePaths(),
  ]);
  return draftManifest.length === 0 && deletedPaths.length === 0;
}

export function hasGitHubPublicationState(
  meta: Pick<
    EnvMeta,
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
  >,
): boolean {
  return Boolean(
    meta.githubHeadCommitSha ||
    meta.githubPrNumber ||
    meta.githubPrUrl ||
    meta.githubPrState ||
    meta.githubMergedAt ||
    meta.githubPublishOperationId ||
    meta.githubPublishError ||
    meta.githubPendingPublish ||
    meta.githubLastPublishedAt ||
    meta.githubLastPublishedWorkspaceHash ||
    meta.githubPublishStatus !== "idle",
  );
}

function hasActiveOperation(
  meta: Pick<
    EnvMeta,
    "lifecycleOpId" | "lifecycleOperation" | "scmOperationType" | "scmOperationId"
  >,
): boolean {
  return Boolean(meta.lifecycleOpId || meta.lifecycleOperation || meta.scmOperationType || meta.scmOperationId);
}

function isCleanAutoAdvanceCandidate(args: {
  meta: EnvMeta;
  startable: boolean;
  overlayEmpty: boolean;
}): boolean {
  return (
    args.meta.scmModel === "github" &&
    args.startable &&
    !hasActiveOperation(args.meta) &&
    !args.meta.startupPlanId &&
    args.overlayEmpty &&
    !hasGitHubPublicationState(args.meta)
  );
}

export function getGitHubStartBaseAdvanceDecision(args: {
  meta: EnvMeta;
  repo: RepoMeta;
  startable: boolean;
  overlayEmpty: boolean;
  refreshFailureKind: GitHubDefaultBranchRefreshFailureKind | null;
  refreshError?: string | null;
  refreshCode?: string | null;
  refreshStatus?: number | null;
}): GitHubStartBaseAdvanceDecision {
  if (!isCleanAutoAdvanceCandidate(args)) {
    return { action: "stored", reason: "not_clean_auto_advance_candidate" };
  }

  if (args.refreshFailureKind === "transient_error") {
    return { action: "stored", reason: "refresh_transient_error" };
  }
  if (args.refreshFailureKind === "access_error" || args.refreshFailureKind === "not_ready") {
    return {
      action: "block",
      failureKind: args.refreshFailureKind,
      error: args.refreshError || "GitHub default branch metadata is unavailable for this repository.",
      code: args.refreshCode || "github_default_branch_refresh_failed",
      status: args.refreshStatus ?? (args.refreshFailureKind === "access_error" ? 403 : 409),
    };
  }

  if (args.repo.gitStatus !== "ready" || args.repo.gitError || !args.repo.githubDefaultBranchHeadSha) {
    return {
      action: "block",
      failureKind: "not_ready",
      error: args.repo.gitError || "GitHub default branch metadata is unavailable for this repository.",
      code: "github_default_branch_not_ready",
      status: 409,
    };
  }

  if (args.meta.githubBaseCommitSha !== args.repo.githubDefaultBranchHeadSha) {
    return {
      action: "advance",
      baseBranch: args.repo.githubDefaultBranch ?? null,
      baseCommitSha: args.repo.githubDefaultBranchHeadSha,
    };
  }

  return { action: "stored", reason: "already_current" };
}
