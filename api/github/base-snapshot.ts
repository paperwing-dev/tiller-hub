import type { Env } from "../types";
import { readTarEntries } from "../workspace/tar";
import { mintGitHubInstallationToken } from "./app";
import { buildGitHubTarballRequest, canonicalizeGitHubRepo } from "./repo";

export interface GitHubBaseSnapshotEntry {
  path: string;
  size: number;
  sha256: string;
  content: Uint8Array;
}

export interface GitHubBaseSnapshot {
  commitSha: string;
  entries: Map<string, GitHubBaseSnapshotEntry>;
}

function matchesAnyPrefix(path: string, prefixes: readonly string[] = []): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripGitHubTarRoot(path: string): string | null {
  const segments = path.replace(/^\/+/, "").split("/").filter(Boolean);
  if (segments.length <= 1) return null;
  return `/${segments.slice(1).join("/")}`;
}

export async function loadGitHubBaseSnapshot(args: {
  env: Env;
  githubFullName: string;
  commitSha: string;
  excludePrefixes?: readonly string[];
}): Promise<GitHubBaseSnapshot> {
  const repo = canonicalizeGitHubRepo(args.githubFullName, { allowOwnerRepo: true });
  const token = (await mintGitHubInstallationToken(args.env, repo, { access: "read" })).token;
  const tarball = buildGitHubTarballRequest(repo, args.commitSha, token);
  const response = await fetch(tarball.tarballUrl, {
    headers: tarball.headers,
    redirect: "follow",
  });
  if (!response.ok || !response.body) {
    throw new Error(`Failed to fetch GitHub base snapshot ${args.commitSha}: HTTP ${response.status}`);
  }

  const decompressed = response.body.pipeThrough(new DecompressionStream("gzip"));
  const tarBuffer = new Uint8Array(await new Response(decompressed).arrayBuffer());
  const tarEntries = readTarEntries(tarBuffer);
  const entries = new Map<string, GitHubBaseSnapshotEntry>();
  for (const [tarPath, content] of tarEntries) {
    const path = stripGitHubTarRoot(tarPath);
    if (!path || matchesAnyPrefix(path, args.excludePrefixes)) continue;
    entries.set(path, {
      path,
      size: content.byteLength,
      sha256: await sha256HexBytes(content),
      content,
    });
  }

  return {
    commitSha: args.commitSha,
    entries,
  };
}

export async function computeSnapshotTreeHash(snapshot: GitHubBaseSnapshot): Promise<string> {
  const encoder = new TextEncoder();
  const entries = Array.from(snapshot.entries.values())
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `${entry.path}\0${entry.sha256}`);
  return await sha256HexBytes(encoder.encode(entries.join("\n")));
}
