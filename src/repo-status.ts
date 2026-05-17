import type { RepoMeta } from "./api";

export function isRepoMainReady(
  repo: Pick<RepoMeta, "gitStatus" | "gitArtifactId" | "mainCommit">,
): boolean {
  return repo.gitStatus === "ready" && !!repo.gitArtifactId && !!repo.mainCommit;
}

export function getRepoMainStatusLabel(
  repo: Pick<RepoMeta, "gitStatus" | "gitArtifactId" | "mainCommit">,
): string {
  if (isRepoMainReady(repo)) {
    return "Main ready";
  }
  if (repo.gitStatus === "repair-required") {
    return "Main needs repair";
  }
  return "Preparing main";
}

export function getRepoMainStatusDetail(
  repo: Pick<
    RepoMeta,
    "gitStatus" | "gitArtifactId" | "mainCommit" | "gitError" | "gitProgressPhase" | "gitLastBootstrapDurationMs"
  >,
): string | null {
  if (isRepoMainReady(repo)) {
    if (typeof repo.gitLastBootstrapDurationMs === "number") {
      return `Canonical main prepared in ${formatDurationMs(repo.gitLastBootstrapDurationMs)}.`;
    }
    return null;
  }
  if (repo.gitStatus === "repair-required") {
    return repo.gitError || "Canonical main needs repair before plans or environments can use this repo.";
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
