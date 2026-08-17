import { DurableObject } from "cloudflare:workers";
import { Workspace, type FileInfo } from "@cloudflare/shell";
import type { Env, RepoGitStatus, RepoMeta } from "../types";
import {
  GITHUB_DELETED_PATHS_WORKSPACE_PATH,
  normalizeGitHubDeletedPaths,
  parseGitHubDeletedPathsJson,
} from "../github/draft-overlay";
import { githubRepoUrlFromFullName } from "../github/repo";
import { bytesToArrayBuffer } from "../bytes";

export interface ManifestEntry {
  path: string;
  size: number;
  mtime: number;
}

export interface HashedManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface WorkspaceFileStat {
  path: string;
  size: number;
}

export interface RepoDefaultHeadIdentity {
  githubFullName: string;
  repoUrl: string;
  githubDefaultBranch: string | null;
  githubDefaultBranchHeadSha: string | null;
  gitStatus: RepoGitStatus;
  gitError: string | null;
}

export interface RepoDefaultHeadPatchInput {
  expected: RepoDefaultHeadIdentity;
  next: RepoDefaultHeadIdentity & {
    githubInstallationId?: number;
    githubWebhookConfigured?: boolean;
    githubWebhookError?: string | null;
  };
}

export interface RepoDefaultHeadPatchResult {
  repo: RepoMeta | null;
  changed: boolean;
  mainChanged: boolean;
  conflict: boolean;
}

const REPO_META_PATH = "/.tiller/repo/meta.json";

function matchesAnyPrefix(path: string, prefixes: string[] = []): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isRepoGitStatus(value: unknown): value is RepoGitStatus {
  return value === "pending" || value === "ready" || value === "repair-required";
}

function readStoredRepoIdentity(meta: Record<string, unknown>): RepoDefaultHeadIdentity | null {
  const githubDefaultBranch = meta.githubDefaultBranch ?? null;
  const githubDefaultBranchHeadSha = meta.githubDefaultBranchHeadSha ?? null;
  if (
    typeof meta.githubFullName !== "string" ||
    !isNullableString(githubDefaultBranch) ||
    !isNullableString(githubDefaultBranchHeadSha) ||
    !isRepoGitStatus(meta.gitStatus) ||
    !isNullableString(meta.gitError)
  ) {
    return null;
  }
  return {
    githubFullName: meta.githubFullName,
    repoUrl: githubRepoUrlFromFullName(meta.githubFullName),
    githubDefaultBranch,
    githubDefaultBranchHeadSha,
    gitStatus: meta.gitStatus,
    gitError: meta.gitError,
  };
}

function identitiesEqual(left: RepoDefaultHeadIdentity, right: RepoDefaultHeadIdentity): boolean {
  return (
    left.githubFullName === right.githubFullName &&
    left.repoUrl === right.repoUrl &&
    left.githubDefaultBranch === right.githubDefaultBranch &&
    left.githubDefaultBranchHeadSha === right.githubDefaultBranchHeadSha &&
    left.gitStatus === right.gitStatus &&
    left.gitError === right.gitError
  );
}

function repoMetaFromStored(meta: Record<string, unknown>): RepoMeta | null {
  const githubDefaultBranch = meta.githubDefaultBranch ?? null;
  const githubDefaultBranchHeadSha = meta.githubDefaultBranchHeadSha ?? null;
  const artifactStoreGeneration = meta.artifactStoreGeneration ?? null;
  const bootstrappedFromRef = meta.bootstrappedFromRef;
  if (
    typeof meta.repoId !== "string" ||
    !(
      artifactStoreGeneration === null ||
      (
        typeof artifactStoreGeneration === "string" &&
        Boolean(artifactStoreGeneration.trim())
      )
    ) ||
    typeof meta.githubInstallationId !== "number" ||
    typeof meta.githubFullName !== "string" ||
    !isNullableString(githubDefaultBranch) ||
    !isNullableString(githubDefaultBranchHeadSha) ||
    typeof meta.createdAt !== "string" ||
    typeof meta.updatedAt !== "string" ||
    !isNullableString(bootstrappedFromRef)
  ) {
    return null;
  }

  return {
    repoId: meta.repoId,
    artifactStoreGeneration: typeof artifactStoreGeneration === "string"
      ? artifactStoreGeneration.trim()
      : null,
    repoUrl: githubRepoUrlFromFullName(meta.githubFullName),
    scmModel: "github",
    githubInstallationId: meta.githubInstallationId,
    githubFullName: meta.githubFullName,
    githubDefaultBranch,
    githubDefaultBranchHeadSha,
    githubWebhookConfigured: meta.githubWebhookConfigured === true,
    githubWebhookError: typeof meta.githubWebhookError === "string" ? meta.githubWebhookError : null,
    mainCommit: typeof meta.mainCommit === "string" ? meta.mainCommit : null,
    gitArtifactId: typeof meta.gitArtifactId === "string" ? meta.gitArtifactId : null,
    gitStatus: isRepoGitStatus(meta.gitStatus) ? meta.gitStatus : "repair-required",
    gitError: typeof meta.gitError === "string" ? meta.gitError : null,
    gitFormatVersion: typeof meta.gitFormatVersion === "number" ? meta.gitFormatVersion : null,
    gitProgressPhase: typeof meta.gitProgressPhase === "string" ? meta.gitProgressPhase : null,
    gitProgressStartedAt: typeof meta.gitProgressStartedAt === "string" ? meta.gitProgressStartedAt : null,
    gitProgressUpdatedAt: typeof meta.gitProgressUpdatedAt === "string" ? meta.gitProgressUpdatedAt : null,
    gitLastBootstrapDurationMs: typeof meta.gitLastBootstrapDurationMs === "number" ? meta.gitLastBootstrapDurationMs : null,
    gitLastBootstrapTimings: typeof meta.gitLastBootstrapTimings === "string" ? meta.gitLastBootstrapTimings : null,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    bootstrappedFromRef,
    lastCommittedFromEnvSlug: typeof meta.lastCommittedFromEnvSlug === "string" ? meta.lastCommittedFromEnvSlug : null,
    lastCommittedAt: typeof meta.lastCommittedAt === "string" ? meta.lastCommittedAt : null,
    githubPublish: typeof meta.githubPublish === "object" && meta.githubPublish !== null
      ? meta.githubPublish as RepoMeta["githubPublish"]
      : null,
  };
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class WorkspaceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private _workspace: Workspace | null = null;

  private get workspace(): Workspace {
    if (!this._workspace) {
      this._workspace = new Workspace({
        sql: this.ctx.storage.sql,
        r2: this.env.BUCKET,
        r2Prefix: this.ctx.id.toString(),
        inlineThreshold: 1_000_000,
      });
    }
    return this._workspace;
  }

  async getManifest(): Promise<ManifestEntry[]> {
    console.log("[workspace-do] getManifest called");
    const files = (await this.workspace.glob("**/*")).filter((f) => f.type === "file");
    console.log(`[workspace-do] getManifest -> ${files.length} files`);
    return files.map((f) => ({ path: f.path, size: f.size, mtime: f.updatedAt }));
  }

  async getHashedManifest(options?: { excludePrefixes?: string[] }): Promise<HashedManifestEntry[]> {
    const files = (await this.workspace.glob("**/*"))
      .filter((entry) => entry.type === "file" && !matchesAnyPrefix(entry.path, options?.excludePrefixes))
      .sort((left, right) => left.path.localeCompare(right.path));

    const entries: HashedManifestEntry[] = [];
    for (const file of files) {
      const body = await this.workspace.readFileBytes(file.path);
      if (body === null) continue;
      entries.push({
        path: file.path,
        size: file.size,
        sha256: await sha256HexBytes(body),
      });
    }
    return entries;
  }

  async statWorkspaceFile(path: string): Promise<WorkspaceFileStat | null> {
    const stat = await this.workspace.stat(path);
    if (!stat || stat.type !== "file") return null;
    return { path: stat.path, size: stat.size };
  }

  async readWorkspaceFile(path: string): Promise<string | null> {
    return this.workspace.readFile(path);
  }

  async writeWorkspaceFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(path, content);
    await this.removeGitHubDeletedWorkspacePaths([path]);
  }

  async patchRepoGitHubPublishMetaIfCurrent(input: {
    expectedMainCommit: string;
    operationId: string;
    githubPublish: unknown;
    final?: boolean;
  }): Promise<boolean> {
    const raw = await this.workspace.readFile(REPO_META_PATH);
    if (!raw) return false;

    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) return false;
      meta = parsed as Record<string, unknown>;
    } catch {
      return false;
    }

    if (meta.mainCommit !== input.expectedMainCommit) return false;
    const currentPublish = typeof meta.githubPublish === "object" && meta.githubPublish !== null
      ? meta.githubPublish as Record<string, unknown>
      : null;
    const recordedOperationId = typeof currentPublish?.operationId === "string"
      ? currentPublish.operationId
      : null;
    if (input.final && recordedOperationId && recordedOperationId !== input.operationId) {
      return false;
    }
    if (
      typeof input.githubPublish !== "object" ||
      input.githubPublish === null ||
      typeof (input.githubPublish as Record<string, unknown>).updatedAt !== "string"
    ) {
      return false;
    }

    await this.workspace.writeFile(REPO_META_PATH, JSON.stringify({
      ...meta,
      githubPublish: input.githubPublish,
      updatedAt: (input.githubPublish as Record<string, unknown>).updatedAt,
    }, null, 2));
    return true;
  }

  async patchRepoDefaultHeadIfCurrent(input: RepoDefaultHeadPatchInput): Promise<RepoDefaultHeadPatchResult> {
    const raw = await this.workspace.readFile(REPO_META_PATH);
    if (!raw) {
      return { repo: null, changed: false, mainChanged: false, conflict: true };
    }

    let meta: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed !== "object" || parsed === null) {
        return { repo: null, changed: false, mainChanged: false, conflict: true };
      }
      meta = parsed as Record<string, unknown>;
    } catch {
      return { repo: null, changed: false, mainChanged: false, conflict: true };
    }

    const currentIdentity = readStoredRepoIdentity(meta);
    if (!currentIdentity || !identitiesEqual(currentIdentity, input.expected)) {
      return {
        repo: repoMetaFromStored(meta),
        changed: false,
        mainChanged: false,
        conflict: true,
      };
    }

    const currentWebhookConfigured = meta.githubWebhookConfigured === true;
    const currentWebhookError = typeof meta.githubWebhookError === "string" ? meta.githubWebhookError : null;
    const currentInstallationId = typeof meta.githubInstallationId === "number" ? meta.githubInstallationId : null;
    if (currentInstallationId === null) {
      return {
        repo: repoMetaFromStored(meta),
        changed: false,
        mainChanged: false,
        conflict: true,
      };
    }
    const nextInstallationId = typeof input.next.githubInstallationId === "number"
      ? input.next.githubInstallationId
      : currentInstallationId;
    const nextWebhookConfigured = input.next.githubWebhookConfigured ?? currentWebhookConfigured;
    const nextWebhookError = Object.prototype.hasOwnProperty.call(input.next, "githubWebhookError")
      ? input.next.githubWebhookError ?? null
      : currentWebhookError;
    const semanticChanged =
      !identitiesEqual(currentIdentity, input.next) ||
      currentInstallationId !== nextInstallationId ||
      currentWebhookConfigured !== nextWebhookConfigured ||
      currentWebhookError !== nextWebhookError;

    if (!semanticChanged) {
      return {
        repo: repoMetaFromStored(meta),
        changed: false,
        mainChanged: false,
        conflict: false,
      };
    }

    const updatedAt = new Date().toISOString();
    const nextStored = {
      ...meta,
      scmModel: "github",
      githubInstallationId: nextInstallationId,
      githubFullName: input.next.githubFullName,
      githubDefaultBranch: input.next.githubDefaultBranch,
      githubDefaultBranchHeadSha: input.next.githubDefaultBranchHeadSha,
      githubWebhookConfigured: nextWebhookConfigured,
      githubWebhookError: nextWebhookError,
      mainCommit: null,
      gitArtifactId: null,
      gitStatus: input.next.gitStatus,
      gitError: input.next.gitError,
      updatedAt,
    };
    await this.workspace.writeFile(REPO_META_PATH, JSON.stringify(nextStored, null, 2));
    return {
      repo: repoMetaFromStored(nextStored),
      changed: true,
      mainChanged: currentIdentity.githubDefaultBranchHeadSha !== input.next.githubDefaultBranchHeadSha,
      conflict: false,
    };
  }

  async readWorkspaceFileBytes(path: string): Promise<Uint8Array | null> {
    return this.workspace.readFileBytes(path);
  }

  async writeWorkspaceFileBytes(path: string, content: Uint8Array): Promise<void> {
    await this.workspace.writeFileBytes(path, content);
    await this.removeGitHubDeletedWorkspacePaths([path]);
  }

  async writeWorkspaceFiles(files: { path: string; content: string }[]): Promise<void> {
    for (const file of files) {
      await this.workspace.writeFile(file.path, file.content);
    }
    await this.removeGitHubDeletedWorkspacePaths(files.map((file) => file.path));
  }

  async deleteWorkspaceFile(path: string): Promise<boolean> {
    return this.workspace.deleteFile(path);
  }

  async deleteWorkspaceFiles(paths: string[], options?: { trackGitHubDeletions?: boolean }): Promise<void> {
    for (const path of paths) {
      await this.workspace.deleteFile(path);
    }
    if (options?.trackGitHubDeletions) {
      await this.addGitHubDeletedWorkspacePaths(paths);
    }
  }

  async readGitHubDeletedWorkspacePaths(): Promise<string[]> {
    return parseGitHubDeletedPathsJson(await this.workspace.readFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH));
  }

  async addGitHubDeletedWorkspacePaths(paths: string[]): Promise<void> {
    const next = normalizeGitHubDeletedPaths([
      ...await this.readGitHubDeletedWorkspacePaths(),
      ...paths,
    ]);
    if (next.length === 0) {
      await this.workspace.deleteFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH);
      return;
    }
    await this.workspace.writeFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH, JSON.stringify(next));
  }

  async replaceGitHubDeletedWorkspacePaths(paths: string[]): Promise<void> {
    const next = normalizeGitHubDeletedPaths(paths);
    if (next.length === 0) {
      await this.workspace.deleteFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH);
      return;
    }
    await this.workspace.writeFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH, JSON.stringify(next));
  }

  async removeGitHubDeletedWorkspacePaths(paths: string[]): Promise<void> {
    const remove = new Set(normalizeGitHubDeletedPaths(paths));
    if (remove.size === 0) return;
    const next = (await this.readGitHubDeletedWorkspacePaths()).filter((path) => !remove.has(path));
    if (next.length === 0) {
      await this.workspace.deleteFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH);
      return;
    }
    await this.workspace.writeFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH, JSON.stringify(next));
  }

  readWorkspaceDir(dir?: string): Promise<FileInfo[]> {
    return this.workspace.readDir(dir);
  }

  globWorkspace(pattern: string): Promise<FileInfo[]> {
    return this.workspace.glob(pattern);
  }

  getWorkspaceInfo(): Promise<{ fileCount: number; directoryCount: number; totalBytes: number; r2FileCount: number }> {
    return this.workspace.getWorkspaceInfo();
  }

  async batchReadWorkspaceFiles(paths: string[]): Promise<{ path: string; content: string | null }[]> {
    const results: { path: string; content: string | null }[] = [];
    for (const path of paths) {
      results.push({
        path,
        content: await this.workspace.readFile(path),
      });
    }
    return results;
  }

  async clearWorkspacePlanFile(): Promise<void> {
    await this.workspace.deleteFile("/.tiller/plan.md");
  }

  async computeWorkspaceTreeHash(options?: { excludePrefixes?: string[] }): Promise<string> {
    const encoder = new TextEncoder();
    const files = (await this.workspace
      .glob("**/*"))
      .filter((entry) => entry.type === "file" && !matchesAnyPrefix(entry.path, options?.excludePrefixes))
      .sort((left, right) => left.path.localeCompare(right.path));

    const entries: string[] = [];
    for (const file of files) {
      const body = await this.workspace.readFileBytes(file.path);
      if (body === null) continue;
      entries.push(`${file.path}\0${await sha256HexBytes(body)}`);
    }

    return sha256HexBytes(encoder.encode(entries.join("\n")));
  }

  async downloadTar(options?: { excludePrefixes?: string[] }): Promise<Uint8Array> {
    console.log("[workspace-do] downloadTar called");
    const files = (await this.workspace
      .glob("**/*"))
      .filter((f) => f.type === "file" && !matchesAnyPrefix(f.path, options?.excludePrefixes));
    console.log(`[workspace-do] downloadTar: ${files.length} files to pack`);
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];

    for (const file of files) {
      const body = await this.workspace.readFileBytes(file.path);
      if (body === null) {
        console.warn(`[tar] skipping file not found in workspace: ${file.path}`);
        continue;
      }

      const header = new Uint8Array(512);
      const name = file.path.startsWith("/") ? file.path.slice(1) : file.path;
      const nameBytes = encoder.encode(name);
      header.set(nameBytes.slice(0, 100), 0);
      header.set(encoder.encode("0000644\0"), 100);
      header.set(encoder.encode("0000000\0"), 108);
      header.set(encoder.encode("0000000\0"), 116);
      const sizeStr = body.length.toString(8).padStart(11, "0") + "\0";
      header.set(encoder.encode(sizeStr), 124);
      const mtime = Math.floor((file.updatedAt || Date.now()) / 1000);
      header.set(encoder.encode(mtime.toString(8).padStart(11, "0") + "\0"), 136);
      header[156] = 48;
      header.set(encoder.encode("ustar\0"), 257);
      header.set(encoder.encode("00"), 263);

      header.set(encoder.encode("        "), 148);
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += header[i];
      header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);

      chunks.push(header);
      chunks.push(body);
      const remainder = body.length % 512;
      if (remainder > 0) chunks.push(new Uint8Array(512 - remainder));
    }

    chunks.push(new Uint8Array(1024));

    const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    console.log(`[workspace-do] downloadTar -> ${result.byteLength} bytes`);
    return result;
  }

  private async restoreFromTarBuffer(
    tarBuffer: Uint8Array,
    options?: { preservePrefixes?: string[]; clearFirst?: boolean; stripFirstSegment?: boolean },
  ): Promise<{ fileCount: number }> {
    if (options?.clearFirst) {
      const files = (await this.workspace.glob("**/*")).filter((entry) =>
        entry.type === "file" && !matchesAnyPrefix(entry.path, options.preservePrefixes),
      );
      for (const file of files) {
        await this.workspace.deleteFile(file.path);
      }
    }

    let fileCount = 0;
    let buffer = tarBuffer;
    const decoder = new TextDecoder();

    while (buffer.length >= 512) {
      const header = buffer.slice(0, 512);
      if (header.every((byte) => byte === 0)) break;

      const rawName = decoder.decode(header.slice(0, 100)).replace(/\0.*$/, "");
      const sizeOctal = decoder.decode(header.slice(124, 136)).replace(/\0.*$/, "").trim();
      const typeFlag = decoder.decode(header.slice(156, 157));
      const prefix = decoder.decode(header.slice(345, 500)).replace(/\0.*$/, "");

      const fullName = prefix ? `${prefix}/${rawName}` : rawName;
      const size = sizeOctal ? parseInt(sizeOctal, 8) : 0;
      const paddedSize = Math.ceil(size / 512) * 512;
      buffer = buffer.slice(512);

      if (buffer.length < paddedSize) {
        throw new Error("Invalid tar archive: truncated entry payload");
      }

      const content = buffer.slice(0, size);
      buffer = buffer.slice(paddedSize);

      if (typeFlag === "5" || typeFlag === "g" || typeFlag === "x") continue;
      if (size === 0 && rawName.endsWith("/")) continue;

      const normalizedFullName = fullName.startsWith("/") ? fullName.slice(1) : fullName;
      const pathSegments = normalizedFullName.split("/").filter(Boolean);
      const relativePath = options?.stripFirstSegment ? pathSegments.slice(1).join("/") : normalizedFullName;
      if (!relativePath) continue;
      const workspacePath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
      if (
        workspacePath.includes("/node_modules/") ||
        workspacePath.includes("/__pycache__/") ||
        workspacePath.includes("/.git/objects/") ||
        workspacePath.includes("/.terraform/") ||
        workspacePath.includes("/vendor/") ||
        workspacePath.includes("/dist/") ||
        workspacePath.includes("/.next/") ||
        workspacePath.includes("/build/")
      ) continue;

      await this.workspace.writeFileBytes(workspacePath, content);
      fileCount++;
    }

    return { fileCount };
  }

  async restoreFromTar(
    tarBuffer: Uint8Array,
    options?: { preservePrefixes?: string[]; clearFirst?: boolean },
  ): Promise<{ fileCount: number }> {
    return this.restoreFromTarBuffer(tarBuffer, options);
  }

  async initFromTarball(tarballUrl: string, headers?: Record<string, string>): Promise<{ fileCount: number }> {
    const resp = await fetch(tarballUrl, {
      headers: headers ?? {},
      redirect: "follow",
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`Failed to fetch tarball: ${resp.status} ${resp.statusText}`);
    }

    const decompressed = resp.body.pipeThrough(new DecompressionStream("gzip"));
    const tarBuffer = new Uint8Array(await new Response(decompressed).arrayBuffer());
    return this.restoreFromTarBuffer(tarBuffer, { stripFirstSegment: true });
  }

  async destroyWorkspaceR2(): Promise<void> {
    const prefix = this.ctx.id.toString() + "/";
    let cursor: string | undefined;
    do {
      const listed = await this.env.BUCKET.list({ prefix, cursor });
      if (listed.objects.length > 0) {
        await Promise.all(listed.objects.map((obj) => this.env.BUCKET.delete(obj.key)));
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  }

  async destroyWorkspace(): Promise<void> {
    const files = (await this.workspace.glob("**/*")).filter((entry) => entry.type === "file");
    for (const file of files) {
      await this.workspace.deleteFile(file.path);
    }
    await this.destroyWorkspaceR2();
  }
}
