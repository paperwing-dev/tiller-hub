export function getPlanChatName(repoId: string, planArtifactId: string): string {
  return `plan-writer:${repoId}:${planArtifactId}`;
}

export function getReviewerChatName(repoId: string, threadId: string): string {
  return `reviewer-chat:${repoId}:${threadId}`;
}

export function getRepoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
}
