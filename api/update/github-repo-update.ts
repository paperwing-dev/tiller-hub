import type { Env } from "../types";
import { canonicalizeGitHubRepo } from "../github/repo";
import { mintGitHubInstallationToken } from "../github/app";
import { clearUpdateCheckCache } from "./check-release";
import { fetchRepoUpdateMetadata, readHubUpdateRepoState } from "./hub-repo";
import {
  fetchLatestPublicHubReleaseRef,
  findRemovedManagedFiles,
  getBuildChannel,
  getCurrentUpdateMetadata,
  parseTillerUpdateMetadata,
  PUBLIC_HUB_REPO,
  UPDATE_METADATA_PATH,
} from "./metadata";
import { mergeWranglerJsonc } from "./wrangler-merge";
import type { TillerUpdateMetadata, UpdateApplyResult } from "./types";

interface GitHubApiResponse<T> {
  status: number;
  body: T | null;
  text: string;
}

interface GitRefResponse {
  object?: {
    sha?: string;
    type?: string;
  };
}

interface GitTagResponse {
  object?: {
    sha?: string;
    type?: string;
  };
}

interface GitCommitResponse {
  sha?: string;
  tree?: {
    sha?: string;
  };
}

interface GitBlobResponse {
  sha?: string;
  content?: string;
  encoding?: string;
}

interface GitTreeItem {
  path?: string;
  mode?: string;
  type?: string;
  sha?: string;
}

interface GitTreeResponse {
  sha?: string;
  tree?: GitTreeItem[];
  truncated?: boolean;
}

const GITHUB_API_VERSION = "2022-11-28";
const [PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME] = PUBLIC_HUB_REPO.split("/") as [string, string];

function formatUpdateVersion(version: string): string {
  const normalized = version.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
  return `v${normalized}`;
}

async function githubApi<T>(
  token: string | null,
  path: string,
  options: {
    method?: string;
    body?: unknown;
  } = {},
): Promise<GitHubApiResponse<T>> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "User-Agent": "tiller-hub",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(`https://api.github.com${path}`, {
    method: options.method ?? "GET",
    headers,
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

function readGitHubMessage(body: unknown, fallback: string): string {
  return body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string"
    ? (body as Record<string, string>).message
    : fallback;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s+/g, ""));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

async function getGitRefCommit(
  token: string | null,
  owner: string,
  repo: string,
  namespace: "heads" | "tags",
  name: string,
): Promise<string> {
  const response = await githubApi<GitRefResponse>(
    token,
    `/repos/${owner}/${repo}/git/ref/${namespace}/${encodeURIComponent(name)}`,
  );
  if (response.status !== 200 || !response.body?.object?.sha || !response.body.object.type) {
    throw new Error(readGitHubMessage(response.body, `Failed to read ${namespace}/${name}: HTTP ${response.status}`));
  }

  let objectSha = response.body.object.sha;
  let objectType = response.body.object.type;
  for (let depth = 0; depth < 5; depth += 1) {
    if (objectType === "commit") return objectSha;
    if (objectType !== "tag") break;

    const tagResponse = await githubApi<GitTagResponse>(
      token,
      `/repos/${owner}/${repo}/git/tags/${objectSha}`,
    );
    if (tagResponse.status !== 200 || !tagResponse.body?.object?.sha || !tagResponse.body.object.type) {
      throw new Error(readGitHubMessage(tagResponse.body, `Failed to read tag object ${objectSha}: HTTP ${tagResponse.status}`));
    }
    objectSha = tagResponse.body.object.sha;
    objectType = tagResponse.body.object.type;
  }

  throw new Error(`GitHub ref ${namespace}/${name} does not resolve to a commit.`);
}

async function getBranchHead(token: string | null, owner: string, repo: string, branch: string): Promise<string> {
  return getGitRefCommit(token, owner, repo, "heads", branch);
}

async function getTagHead(token: string | null, owner: string, repo: string, tagName: string): Promise<string> {
  return getGitRefCommit(token, owner, repo, "tags", tagName);
}

async function getCommitTree(token: string | null, owner: string, repo: string, commitSha: string): Promise<string> {
  const response = await githubApi<GitCommitResponse>(
    token,
    `/repos/${owner}/${repo}/git/commits/${commitSha}`,
  );
  if (response.status !== 200 || !response.body?.tree?.sha) {
    throw new Error(readGitHubMessage(response.body, `Failed to read commit ${commitSha}: HTTP ${response.status}`));
  }
  return response.body.tree.sha;
}

async function getRecursiveTree(
  token: string | null,
  owner: string,
  repo: string,
  treeSha: string,
): Promise<Map<string, string>> {
  const response = await githubApi<GitTreeResponse>(
    token,
    `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
  );
  if (response.status !== 200 || !Array.isArray(response.body?.tree)) {
    throw new Error(readGitHubMessage(response.body, `Failed to read Git tree ${treeSha}: HTTP ${response.status}`));
  }
  if (response.body.truncated) {
    throw new Error(`Git tree ${treeSha} is too large to update safely.`);
  }

  const files = new Map<string, string>();
  for (const item of response.body.tree) {
    if (item.type === "blob" && typeof item.path === "string" && typeof item.sha === "string") {
      files.set(item.path, item.sha);
    }
  }
  return files;
}

async function fetchBlobBytes(
  token: string | null,
  owner: string,
  repo: string,
  blobSha: string,
): Promise<Uint8Array> {
  const response = await githubApi<GitBlobResponse>(
    token,
    `/repos/${owner}/${repo}/git/blobs/${blobSha}`,
  );
  if (response.status !== 200 || response.body?.encoding !== "base64" || typeof response.body.content !== "string") {
    throw new Error(readGitHubMessage(response.body, `Failed to read blob ${blobSha}: HTTP ${response.status}`));
  }
  return fromBase64(response.body.content);
}

async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: Uint8Array,
): Promise<string> {
  const response = await githubApi<GitBlobResponse>(
    token,
    `/repos/${owner}/${repo}/git/blobs`,
    {
      method: "POST",
      body: {
        content: toBase64(content),
        encoding: "base64",
      },
    },
  );
  if (response.status !== 201 || !response.body?.sha) {
    throw new Error(readGitHubMessage(response.body, `Failed to create GitHub blob: HTTP ${response.status}`));
  }
  return response.body.sha;
}

async function createTree(
  token: string,
  owner: string,
  repo: string,
  baseTreeSha: string,
  entries: Array<{ path: string; sha: string }>,
): Promise<string> {
  const response = await githubApi<GitTreeResponse>(
    token,
    `/repos/${owner}/${repo}/git/trees`,
    {
      method: "POST",
      body: {
        base_tree: baseTreeSha,
        tree: entries.map((entry) => ({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: entry.sha,
        })),
      },
    },
  );
  if (response.status !== 201 || !response.body?.sha) {
    throw new Error(readGitHubMessage(response.body, `Failed to create GitHub tree: HTTP ${response.status}`));
  }
  return response.body.sha;
}

async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string,
): Promise<string> {
  const response = await githubApi<GitCommitResponse>(
    token,
    `/repos/${owner}/${repo}/git/commits`,
    {
      method: "POST",
      body: {
        message,
        tree: treeSha,
        parents: [parentSha],
      },
    },
  );
  if (response.status !== 201 || !response.body?.sha) {
    throw new Error(readGitHubMessage(response.body, `Failed to create GitHub commit: HTTP ${response.status}`));
  }
  return response.body.sha;
}

function refUpdateRejectedResult(status: number, body: unknown): UpdateApplyResult {
  const message = readGitHubMessage(body, `GitHub rejected the branch update with HTTP ${status}.`);
  if (status === 409 || /fast-forward|not a fast forward|reference update failed|sha does not match/i.test(message)) {
    return {
      ok: false,
      status: "update_branch_moved",
      error: "The update branch changed while Tiller was preparing the commit. Retry the update.",
      retryable: true,
    };
  }
  return {
    ok: false,
    status: "direct_update_rejected",
    error: `${message} Use Cloudflare update if branch policy or permissions block direct commits.`,
  };
}

async function updateBranchRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  commitSha: string,
): Promise<UpdateApplyResult | null> {
  const response = await githubApi<GitRefResponse>(
    token,
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      body: {
        sha: commitSha,
        force: false,
      },
    },
  );
  if (response.status === 200) return null;
  return refUpdateRejectedResult(response.status, response.body);
}

interface PublicSourceSnapshot {
  commitSha: string;
  latestUpdate: TillerUpdateMetadata;
  files: Map<string, string>;
}

async function readPublicSourceSnapshot(): Promise<PublicSourceSnapshot> {
  const latestRelease = await fetchLatestPublicHubReleaseRef();
  const commitSha = await getTagHead(null, PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME, latestRelease.tagName);
  const treeSha = await getCommitTree(null, PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME, commitSha);
  const files = await getRecursiveTree(null, PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME, treeSha);
  const metadataSha = files.get(UPDATE_METADATA_PATH);
  if (!metadataSha) {
    throw new Error(`Public hub release ${latestRelease.tagName} is missing ${UPDATE_METADATA_PATH}.`);
  }

  const metadataText = new TextDecoder().decode(
    await fetchBlobBytes(null, PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME, metadataSha),
  );
  const latestUpdate = parseTillerUpdateMetadata(JSON.parse(metadataText) as unknown);
  if (!latestUpdate) {
    throw new Error(`Public hub release ${latestRelease.tagName} has invalid ${UPDATE_METADATA_PATH}.`);
  }
  if (formatUpdateVersion(latestUpdate.version) !== formatUpdateVersion(latestRelease.tagName)) {
    throw new Error(`${UPDATE_METADATA_PATH} version ${latestUpdate.version} does not match release tag ${latestRelease.tagName}.`);
  }
  for (const managedPath of latestUpdate.managedFiles) {
    if (!files.has(managedPath)) {
      throw new Error(`Public hub release ${latestRelease.tagName} is missing managed file ${managedPath}.`);
    }
  }

  return { commitSha, latestUpdate, files };
}

function requireBlobSha(files: Map<string, string>, path: string, label: string): string {
  const sha = files.get(path);
  if (!sha) {
    throw new Error(`${label} is missing ${path}.`);
  }
  return sha;
}

async function buildManagedTreeEntries(
  token: string,
  owner: string,
  repo: string,
  publicSource: PublicSourceSnapshot,
  targetFiles: Map<string, string>,
): Promise<Array<{ path: string; sha: string }>> {
  const entries: Array<{ path: string; sha: string }> = [];
  const textDecoder = new TextDecoder();
  const textEncoder = new TextEncoder();

  for (const managedPath of publicSource.latestUpdate.managedFiles) {
    const currentSha = targetFiles.get(managedPath) ?? null;
    const upstreamSha = requireBlobSha(
      publicSource.files,
      managedPath,
      `Public hub source ${publicSource.commitSha}`,
    );

    if (managedPath === "wrangler.jsonc") {
      if (!currentSha) {
        throw new Error("Configured hub repo is missing wrangler.jsonc.");
      }
      const [current, upstream] = await Promise.all([
        fetchBlobBytes(token, owner, repo, currentSha),
        fetchBlobBytes(null, PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME, upstreamSha),
      ]);
      const merged = textEncoder.encode(mergeWranglerJsonc(
        textDecoder.decode(current),
        textDecoder.decode(upstream),
      ));
      const mergedSha = await createBlob(token, owner, repo, merged);
      if (mergedSha !== currentSha) {
        entries.push({ path: managedPath, sha: mergedSha });
      }
      continue;
    }

    if (currentSha === upstreamSha) {
      continue;
    }

    const targetSha = await createBlob(
      token,
      owner,
      repo,
      await fetchBlobBytes(null, PUBLIC_HUB_OWNER, PUBLIC_HUB_NAME, upstreamSha),
    );
    if (targetSha !== currentSha) {
      entries.push({ path: managedPath, sha: targetSha });
    }
  }

  return entries;
}

function applyFailureResult(error: unknown): UpdateApplyResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    status: "advanced_repair_required",
    error: `Normal GitHub update failed: ${message}. Use Cloudflare update if retrying does not resolve it.`,
  };
}

async function applyGitHubRepoUpdateInternal(env: Env): Promise<UpdateApplyResult> {
  if (getBuildChannel() === "development") {
    return {
      ok: true,
      status: "noop",
      expectedSourceId: getCurrentUpdateMetadata().sourceId,
    };
  }

  const hubRepo = await readHubUpdateRepoState(env);
  if (hubRepo.status !== "detected") {
    return {
      ok: false,
      status: "hub_repo_not_configured",
      error: "No GitHub self-update repository is connected. Use Cloudflare update with a temporary API token.",
    };
  }

  const repo = canonicalizeGitHubRepo(hubRepo.fullName, { allowOwnerRepo: true });
  const installationToken = await mintGitHubInstallationToken(env, repo, { access: "write" });
  const currentMarker = await fetchRepoUpdateMetadata(
    installationToken.token,
    repo.owner,
    repo.repo,
    hubRepo.branch,
  );
  if (!currentMarker) {
    return {
      ok: false,
      status: "not_a_tiller_hub_repo",
      error: `${repo.fullName}@${hubRepo.branch} does not contain a valid Tiller deploy-button update marker.`,
    };
  }

  const publicSource = await readPublicSourceSnapshot();
  const latestUpdate = publicSource.latestUpdate;
  const removedManagedFiles = findRemovedManagedFiles(currentMarker, latestUpdate);
  if (removedManagedFiles.length > 0) {
    return {
      ok: false,
      status: "managed_files_removed",
      error: "This update removes managed files and requires Cloudflare update.",
      missingManagedFiles: removedManagedFiles,
    };
  }

  const headSha = await getBranchHead(installationToken.token, repo.owner, repo.repo, hubRepo.branch);
  const baseTreeSha = await getCommitTree(installationToken.token, repo.owner, repo.repo, headSha);
  const targetFiles = await getRecursiveTree(installationToken.token, repo.owner, repo.repo, baseTreeSha);
  const entries = await buildManagedTreeEntries(
    installationToken.token,
    repo.owner,
    repo.repo,
    publicSource,
    targetFiles,
  );

  const treeSha = entries.length > 0
    ? await createTree(installationToken.token, repo.owner, repo.repo, baseTreeSha, entries)
    : baseTreeSha;
  const runningUpdate = getCurrentUpdateMetadata();
  if (treeSha === baseTreeSha && runningUpdate.sourceId === latestUpdate.sourceId) {
    await clearUpdateCheckCache(env);
    return {
      ok: true,
      status: "noop",
      expectedSourceId: latestUpdate.sourceId,
    };
  }

  const commitSha = await createCommit(
    installationToken.token,
    repo.owner,
    repo.repo,
    treeSha === baseTreeSha
      ? `Retry Tiller Hub deploy for ${formatUpdateVersion(latestUpdate.version)}`
      : `Update Tiller Hub to ${formatUpdateVersion(latestUpdate.version)}`,
    treeSha,
    headSha,
  );
  const rejected = await updateBranchRef(
    installationToken.token,
    repo.owner,
    repo.repo,
    hubRepo.branch,
    commitSha,
  );
  if (rejected) return rejected;

  await clearUpdateCheckCache(env);
  return {
    ok: true,
    status: "queued",
    expectedSourceId: latestUpdate.sourceId,
    commitSha,
  };
}

export async function applyGitHubRepoUpdate(env: Env): Promise<UpdateApplyResult> {
  try {
    return await applyGitHubRepoUpdateInternal(env);
  } catch (error) {
    return applyFailureResult(error);
  }
}
