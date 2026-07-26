import type { EnvMeta, RepoMeta } from "../api/types";

function encodePathSegments(value: string): string {
  return value.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

export function buildGitHubBranchUrl(githubFullName: string, branch: string): string {
  return `https://github.com/${encodePathSegments(githubFullName)}/tree/${encodePathSegments(branch)}`;
}

export function getGitHubEnvTargetUrl(env: EnvMeta, repo: RepoMeta): string | null {
  if (env.githubPrUrl) return env.githubPrUrl;
  if (env.githubHeadCommitSha && env.githubBranch && repo.githubFullName) {
    return buildGitHubBranchUrl(repo.githubFullName, env.githubBranch);
  }
  return null;
}
