export function getPlanChatName(repoId: string): string {
  return `plan:${repoId}`;
}

export function getRepoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "").replace(/\.git$/, "");
}
