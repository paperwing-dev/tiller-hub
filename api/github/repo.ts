export interface CanonicalGitHubRepo {
  owner: string;
  repo: string;
  fullName: string;
  htmlUrl: string;
}

export class GitHubRepoParseError extends Error {
  constructor(message = "Only GitHub repository URLs are supported.") {
    super(message);
    this.name = "GitHubRepoParseError";
  }
}

const OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i;
const REPO_PATTERN = /^[a-z0-9._-]+$/i;

function reject(message?: string): never {
  throw new GitHubRepoParseError(message);
}

function stripGitSuffix(value: string): string {
  return value.endsWith(".git") ? value.slice(0, -4) : value;
}

function rawPathContainsTraversal(value: string): boolean {
  const match = value.match(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?/i);
  const rawPath = match?.[1] ?? "";
  for (const segment of rawPath.split("/")) {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return true;
    }
    if (decoded === "." || decoded === "..") {
      return true;
    }
  }
  return false;
}

function normalizeParts(ownerRaw: string, repoRaw: string): CanonicalGitHubRepo {
  let owner = ownerRaw.trim();
  let repo = stripGitSuffix(repoRaw.trim());

  try {
    owner = decodeURIComponent(owner);
    repo = decodeURIComponent(repo);
  } catch {
    reject("Repository URL contains malformed path encoding.");
  }

  if (!owner || !repo) reject();
  if (owner === "." || owner === ".." || repo === "." || repo === "..") {
    reject("Repository URL cannot contain path traversal.");
  }
  if (owner.includes("/") || repo.includes("/")) {
    reject("Repository URL cannot contain encoded path separators.");
  }
  if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo)) {
    reject("Repository URL contains an invalid owner or repository name.");
  }

  owner = owner.toLowerCase();
  repo = repo.toLowerCase();
  return {
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    htmlUrl: `https://github.com/${owner}/${repo}`,
  };
}

function canonicalizeOwnerRepo(value: string): CanonicalGitHubRepo {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (trimmed.includes("?") || trimmed.includes("#") || trimmed.includes("@")) {
    reject("Repository must be owner/repo without credentials, query, or fragment.");
  }
  const parts = trimmed.split("/");
  if (parts.length !== 2) {
    reject("Repository must be owner/repo.");
  }
  return normalizeParts(parts[0] ?? "", parts[1] ?? "");
}

export function canonicalizeGitHubRepo(
  value: string,
  options?: { allowOwnerRepo?: boolean },
): CanonicalGitHubRepo {
  const trimmed = value.trim();
  if (!trimmed) reject();

  if (options?.allowOwnerRepo && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return canonicalizeOwnerRepo(trimmed);
  }
  if (rawPathContainsTraversal(trimmed)) {
    reject("Repository URL cannot contain path traversal.");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    reject();
  }

  if (url.protocol !== "https:") {
    reject("Repository URL must use https://github.com.");
  }
  if (url.hostname.toLowerCase() !== "github.com") {
    reject("Repository URL must use github.com.");
  }
  if (url.username || url.password) {
    reject("Repository URL cannot contain credentials.");
  }
  if (url.search || url.hash || url.port) {
    reject("Repository URL cannot contain query, fragment, or port.");
  }

  const path = url.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length !== 2) {
    reject("Repository URL must point to exactly github.com/owner/repo.");
  }
  if (parts.some((part) => part === "." || part === "..")) {
    reject("Repository URL cannot contain path traversal.");
  }

  return normalizeParts(parts[0] ?? "", parts[1] ?? "");
}

export function normalizeGitHubRepoUrl(value: string): string {
  return canonicalizeGitHubRepo(value).htmlUrl;
}

export function githubRepoUrlFromFullName(fullName: string): string {
  return canonicalizeGitHubRepo(fullName, { allowOwnerRepo: true }).htmlUrl;
}

export function buildGitHubTarballRequest(
  repo: CanonicalGitHubRepo,
  ref = "HEAD",
  token?: string | null,
): { tarballUrl: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "tiller-hub",
  };
  if (token?.trim()) {
    headers.Authorization = `Bearer ${token.trim()}`;
  }
  return {
    tarballUrl: `https://api.github.com/repos/${repo.owner}/${repo.repo}/tarball/${encodeURIComponent(ref)}`,
    headers,
  };
}
