import { bytesToArrayBuffer } from "../bytes";

export const GITHUB_DELETED_PATHS_WORKSPACE_PATH = "/.tiller/github-deleted-paths.json";

export interface GitHubDraftManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

function normalizeWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function normalizeGitHubDeletedPaths(paths: readonly string[]): string[] {
  return Array.from(new Set(
    paths
      .map((path) => normalizeWorkspacePath(path.trim()))
      .filter((path) => path !== "/" && path !== GITHUB_DELETED_PATHS_WORKSPACE_PATH),
  )).sort((left, right) => left.localeCompare(right));
}

export function parseGitHubDeletedPathsJson(text: string | null): string[] {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return [];
    return normalizeGitHubDeletedPaths(parsed.filter((value): value is string => typeof value === "string"));
  } catch {
    return [];
  }
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function overlayGitHubDraftManifest(args: {
  baseManifest: Iterable<GitHubDraftManifestEntry>;
  draftManifest: Iterable<GitHubDraftManifestEntry>;
  deletedPaths?: readonly string[];
}): GitHubDraftManifestEntry[] {
  const byPath = new Map<string, GitHubDraftManifestEntry>();
  for (const entry of args.baseManifest) {
    byPath.set(normalizeWorkspacePath(entry.path), {
      ...entry,
      path: normalizeWorkspacePath(entry.path),
    });
  }
  for (const path of normalizeGitHubDeletedPaths(args.deletedPaths ?? [])) {
    byPath.delete(path);
  }
  for (const entry of args.draftManifest) {
    byPath.set(normalizeWorkspacePath(entry.path), {
      ...entry,
      path: normalizeWorkspacePath(entry.path),
    });
  }
  return Array.from(byPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}

export async function computeGitHubDraftManifestHash(entries: Iterable<GitHubDraftManifestEntry>): Promise<string> {
  const encoder = new TextEncoder();
  const lines = Array.from(entries)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${normalizeWorkspacePath(entry.path)}\0${entry.sha256}`);
  return sha256HexBytes(encoder.encode(lines.join("\n")));
}

export async function computeGitHubDraftChangeSetHash(args: {
  draftManifest: Iterable<GitHubDraftManifestEntry>;
  deletedPaths?: readonly string[];
}): Promise<string> {
  const encoder = new TextEncoder();
  const draftLines = Array.from(args.draftManifest)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `file\0${normalizeWorkspacePath(entry.path)}\0${entry.sha256}`);
  const deletionLines = normalizeGitHubDeletedPaths(args.deletedPaths ?? [])
    .map((path) => `delete\0${path}`);
  return sha256HexBytes(encoder.encode([...draftLines, ...deletionLines].join("\n")));
}
