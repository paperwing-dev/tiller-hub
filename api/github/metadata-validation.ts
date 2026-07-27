import type { GitHubApiClient, GitHubTreeEntry, GitHubTreeSnapshot } from "./git-api";
import { readCommitTree } from "./git-api";
import type { Env, RepoMeta } from "../types";
import workspacePolicy from "../env/workspace-policy.json";
import { mintGitHubInstallationToken } from "./app";
import { canonicalizeGitHubRepo } from "./repo";

export class UnsupportedGitHubRepoMetadataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedGitHubRepoMetadataError";
  }
}

function normalizeManagedPrefix(prefix: string): string {
  return prefix.replace(/^\/+/, "").replace(/\/+$/, "");
}

function isExcluded(path: string, excludePrefixes: readonly string[]): boolean {
  return excludePrefixes.some((rawPrefix) => {
    const prefix = normalizeManagedPrefix(rawPrefix);
    if (!prefix) return false;
    return path === prefix || path.startsWith(`${prefix}/`);
  });
}

function unsupportedReason(entry: GitHubTreeEntry): string | null {
  if (entry.mode === "120000") return "symlinks are not supported";
  if (entry.mode === "160000" || entry.type === "commit") return "submodules are not supported";
  if (entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755")) return null;
  if (entry.type !== "blob") {
    return `unsupported git metadata mode=${entry.mode} type=${entry.type}`;
  }
  return `unsupported git file mode=${entry.mode}`;
}

function assertSupportedEntries(
  tree: GitHubTreeSnapshot,
  excludePrefixes: readonly string[],
): void {
  for (const entry of tree.entries.values()) {
    if (isExcluded(entry.path, excludePrefixes)) continue;
    const reason = unsupportedReason(entry);
    if (!reason) continue;
    throw new UnsupportedGitHubRepoMetadataError(
      `Repository contains unsupported metadata at ${entry.path}: ${reason}. Tiller GitHub environments currently support regular files only in managed paths.`,
    );
  }
}

export async function validateGitHubManagedTree(args: {
  client: GitHubApiClient;
  commitSha: string;
  excludePrefixes?: readonly string[];
}): Promise<void> {
  const tree = await readCommitTree(args.client, args.commitSha);
  assertSupportedEntries(tree, args.excludePrefixes ?? []);
}

export async function assertSupportedGitHubBaseMetadata(args: {
  env: Env;
  repo: RepoMeta;
  baseCommitSha: string;
}): Promise<{ tree: GitHubTreeSnapshot; installationToken: string }> {
  const githubRepo = canonicalizeGitHubRepo(args.repo.githubFullName, { allowOwnerRepo: true });
  const token = await mintGitHubInstallationToken(args.env, githubRepo, { access: "write" });
  const tree = await readCommitTree({ token: token.token, repo: githubRepo }, args.baseCommitSha);
  assertSupportedEntries(tree, workspacePolicy.envOnlyCanonicalExcludes);
  return { tree, installationToken: token.token };
}
