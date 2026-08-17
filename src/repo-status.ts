import type { RepoMeta } from "./api";

export function isRepoMainReady(
  repo: Pick<RepoMeta, "scmModel" | "gitStatus" | "githubDefaultBranchHeadSha">,
): boolean {
  if (repo.scmModel === "github") {
    return repo.gitStatus === "ready" && !!repo.githubDefaultBranchHeadSha;
  }
  return false;
}

export function getRepoMainStatusLabel(
  repo: Pick<RepoMeta, "scmModel" | "gitStatus" | "githubDefaultBranchHeadSha">,
): string {
  if (isRepoMainReady(repo)) {
    return "Ready";
  }
  if (repo.gitStatus === "repair-required") {
    return repo.scmModel === "github" ? "GitHub access needs repair" : "Main needs repair";
  }
  return repo.scmModel === "github" ? "Pulling updates from GitHub" : "Preparing main";
}

export function getRepoMainStatusDetail(
  repo: Pick<
    RepoMeta,
    | "scmModel"
    | "gitStatus"
    | "githubDefaultBranch"
    | "githubDefaultBranchHeadSha"
    | "gitError"
    | "gitProgressPhase"
    | "gitLastBootstrapDurationMs"
  >,
): string | null {
  if (isRepoMainReady(repo)) {
    if (repo.scmModel === "github") {
      return repo.githubDefaultBranch
        ? `GitHub default branch ${repo.githubDefaultBranch} is available.`
        : "GitHub default branch is available.";
    }
    if (typeof repo.gitLastBootstrapDurationMs === "number") {
      return `Canonical main prepared in ${formatDurationMs(repo.gitLastBootstrapDurationMs)}.`;
    }
    return null;
  }
  if (repo.gitStatus === "repair-required") {
    if (repo.scmModel === "github") {
      return repo.gitError || "Tiller could not read the GitHub default branch for this repo.";
    }
    return repo.gitError || "Canonical main needs repair before plans or environments can use this repo.";
  }
  if (repo.scmModel === "github") {
    return repo.gitProgressPhase || "Reading the GitHub default branch before plans or environments can use this repo.";
  }
  if (repo.gitProgressPhase) {
    return `${repo.gitProgressPhase}. Plans and environments will unlock when it finishes.`;
  }
  return "Canonical main is still bootstrapping. Plans and environments will unlock when it finishes.";
}

function formatDurationMs(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    return "0s";
  }
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  const seconds = durationMs / 1000;
  if (seconds < 10) {
    return `${seconds.toFixed(1)}s`;
  }
  return `${Math.round(seconds)}s`;
}
