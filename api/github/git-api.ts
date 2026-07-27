import type { CanonicalGitHubRepo } from "./repo";

const GITHUB_API_VERSION = "2022-11-28";

interface GitHubApiResponse<T> {
  status: number;
  body: T | null;
  text: string;
}

interface GitHubRepositoryResponse {
  default_branch?: string | null;
}

interface GitRefResponse {
  object?: {
    sha?: string;
    type?: string;
  };
}

interface GitCommitResponse {
  tree?: {
    sha?: string;
  };
}

interface GitTreeItem {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string | null;
  size?: number;
}

interface GitTreeResponse {
  sha?: string;
  tree?: GitTreeItem[];
  truncated?: boolean;
}

interface GitBlobResponse {
  content?: string;
  encoding?: string;
}

interface GitHubPullRequestResponse {
  number?: number;
  html_url?: string;
  body?: string | null;
}

export interface GitHubApiClient {
  token: string;
  repo: CanonicalGitHubRepo;
  fetchImpl?: typeof fetch;
}

export interface GitHubTreeSnapshot {
  treeSha: string;
  entries: Map<string, GitHubTreeEntry>;
}

export interface GitHubTreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number | null;
}

export interface GitHubPullRequest {
  number: number;
  htmlUrl: string;
  body: string | null;
}

export class GitHubApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubApiError";
  }
}

function readGitHubMessage(body: unknown, fallback: string): string {
  return body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string"
    ? (body as Record<string, string>).message
    : fallback;
}

function apiUrl(path: string): string {
  return `https://api.github.com${path}`;
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

async function githubApi<T>(
  client: GitHubApiClient,
  path: string,
  options: {
    method?: string;
    body?: unknown;
  } = {},
): Promise<GitHubApiResponse<T>> {
  const response = await (client.fetchImpl ?? fetch)(apiUrl(path), {
    method: options.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "tiller-hub",
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
      Authorization: `Bearer ${client.token}`,
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text().catch(() => "");
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, text };
}

function fallbackModeForType(type: string): string | null {
  if (type === "blob") return "100644";
  if (type === "commit") return "160000";
  return null;
}

function normalizeTreeLeafEntry(item: GitTreeItem): GitHubTreeEntry | null {
  if (
    typeof item.path !== "string" ||
    typeof item.type !== "string" ||
    typeof item.sha !== "string" ||
    item.type === "tree"
  ) {
    return null;
  }
  const mode = typeof item.mode === "string" ? item.mode : fallbackModeForType(item.type);
  if (!mode) return null;
  return {
    path: item.path,
    mode,
    type: item.type,
    sha: item.sha,
    size: typeof item.size === "number" ? item.size : null,
  };
}

export async function readRepositoryDefaultBranch(
  client: GitHubApiClient,
): Promise<string> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitHubRepositoryResponse>(client, `/repos/${owner}/${repo}`);
  if (response.status !== 200 || !response.body?.default_branch?.trim()) {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to read GitHub repository default branch: HTTP ${response.status}`,
    ));
  }
  return response.body.default_branch.trim();
}

export async function readCommitRef(
  client: GitHubApiClient,
  namespace: "heads" | "tags",
  name: string,
): Promise<string | null> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitRefResponse>(
    client,
    `/repos/${owner}/${repo}/git/ref/${namespace}/${encodeURIComponent(name)}`,
  );
  if (response.status === 404) return null;
  if (response.status !== 200 || !response.body?.object?.sha || response.body.object.type !== "commit") {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to read GitHub ref ${namespace}/${name}: HTTP ${response.status}`,
    ));
  }
  return response.body.object.sha;
}

export async function readCommitTreeSha(
  client: GitHubApiClient,
  commitSha: string,
): Promise<string> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitCommitResponse>(
    client,
    `/repos/${owner}/${repo}/git/commits/${commitSha}`,
  );
  if (response.status !== 200 || !response.body?.tree?.sha) {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to read GitHub commit ${commitSha}: HTTP ${response.status}`,
    ));
  }
  return response.body.tree.sha;
}

export async function readRecursiveTree(
  client: GitHubApiClient,
  treeSha: string,
): Promise<GitHubTreeSnapshot> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitTreeResponse>(
    client,
    `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
  );
  if (response.status !== 200 || !response.body?.sha || !Array.isArray(response.body.tree)) {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to read GitHub tree ${treeSha}: HTTP ${response.status}`,
    ));
  }
  if (response.body.truncated) {
    throw new GitHubApiError(`GitHub tree ${treeSha} is too large to materialize safely.`);
  }

  const entries = new Map<string, GitHubTreeEntry>();
  for (const item of response.body.tree) {
    const entry = normalizeTreeLeafEntry(item);
    if (entry) entries.set(entry.path, entry);
  }
  return { treeSha: response.body.sha, entries };
}

export async function readCommitTree(
  client: GitHubApiClient,
  commitSha: string,
): Promise<GitHubTreeSnapshot> {
  return readRecursiveTree(client, await readCommitTreeSha(client, commitSha));
}

export async function readBlobBytes(
  client: GitHubApiClient,
  blobSha: string,
): Promise<Uint8Array> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitBlobResponse>(
    client,
    `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
  );
  if (response.status !== 200 || response.body?.encoding !== "base64" || typeof response.body.content !== "string") {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to read GitHub blob ${blobSha}: HTTP ${response.status}`,
    ));
  }
  return base64ToBytes(response.body.content);
}

export async function findOpenPullRequest(
  client: GitHubApiClient,
  branch: string,
): Promise<GitHubPullRequest | null> {
  const { owner, repo } = client.repo;
  const head = encodeURIComponent(`${owner}:${branch}`);
  const response = await githubApi<GitHubPullRequestResponse[]>(
    client,
    `/repos/${owner}/${repo}/pulls?state=open&head=${head}`,
  );
  if (response.status !== 200 || !Array.isArray(response.body)) {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to find GitHub pull request for ${branch}: HTTP ${response.status}`,
    ));
  }
  const first = response.body[0];
  if (!first?.number || !first.html_url) return null;
  return {
    number: first.number,
    htmlUrl: first.html_url,
    body: first.body ?? null,
  };
}

export async function createPullRequest(
  client: GitHubApiClient,
  input: {
    title: string;
    body: string;
    head: string;
    base: string;
    draft?: boolean;
  },
): Promise<GitHubPullRequest> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitHubPullRequestResponse>(
    client,
    `/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      body: input,
    },
  );
  if (response.status !== 201 || !response.body?.number || !response.body.html_url) {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to create GitHub pull request: HTTP ${response.status}`,
    ));
  }
  return {
    number: response.body.number,
    htmlUrl: response.body.html_url,
    body: response.body.body ?? null,
  };
}

export async function updatePullRequest(
  client: GitHubApiClient,
  prNumber: number,
  input: {
    title: string;
    body: string;
    base: string;
  },
): Promise<GitHubPullRequest> {
  const { owner, repo } = client.repo;
  const response = await githubApi<GitHubPullRequestResponse>(
    client,
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      method: "PATCH",
      body: input,
    },
  );
  if (response.status !== 200 || !response.body?.number || !response.body.html_url) {
    throw new GitHubApiError(readGitHubMessage(
      response.body,
      `Failed to update GitHub pull request #${prNumber}: HTTP ${response.status}`,
    ));
  }
  return {
    number: response.body.number,
    htmlUrl: response.body.html_url,
    body: response.body.body ?? null,
  };
}
