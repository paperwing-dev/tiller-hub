import { GITHUB_DELETED_PATHS_WORKSPACE_PATH } from "../github/draft-overlay";
import { bytesToArrayBuffer } from "../bytes";
import type {
  EnvReviewSnapshot,
  EnvReviewSnapshotMode,
  EnvReviewSnapshotSource,
  EnvReviewPreparationOperation,
  EnvReviewPreparationResult,
} from "./types";

export const ENV_REVIEW_SNAPSHOT_FORMAT_VERSION = 1;
export const ENV_REVIEW_SNAPSHOT_CONTENT_TYPE = "application/x-tar";
export const ENV_REVIEW_INSPECTION_CONTENT_TYPE = "application/x-tar";
export const ENV_REVIEW_UPLOAD_TOKEN_HEADER = "X-Tiller-Env-Review-Upload-Token";
export const ENV_REVIEW_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
export const ENV_REVIEW_SNAPSHOT_MAX_FILES = 20_000;
export const ENV_REVIEW_SNAPSHOT_MAX_FILE_BYTES = 25 * 1024 * 1024;
export const ENV_REVIEW_SNAPSHOT_MAX_DELETED_PATHS = 20_000;
export const ENV_REVIEW_SNAPSHOT_MAX_DELETED_PATHS_BYTES = 1_000_000;
export const ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES = [
  "/.tiller",
  "/.claude/settings.local.json",
] as const;

export interface ReviewSnapshotManifestEntry {
  path: string;
  size: number;
  sha256: string;
}

export interface ValidatedReviewSnapshotTar {
  entries: Map<string, Uint8Array>;
  manifest: ReviewSnapshotManifestEntry[];
  fileCount: number;
  totalFileBytes: number;
  tarBytes: number;
}

export interface ReviewSnapshotTarEntry {
  path: string;
  content: Uint8Array;
}

export interface ReviewSnapshotWorkspaceReader {
  globWorkspace(pattern: string): Promise<Array<{ path: string; type: string }>>;
  readWorkspaceFileBytes(path: string): Promise<Uint8Array | null>;
}

function sanitizeSnapshotIdPart(value: string): string {
  return value.toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "snapshot";
}

export function createReviewSnapshotId(opId: string, snapshotHash: string): string {
  return `rs-${sanitizeSnapshotIdPart(opId)}-${sanitizeSnapshotIdPart(snapshotHash).slice(0, 32)}`;
}

export function buildReviewSnapshotKey(envSlug: string, snapshotId: string): string {
  return `envs/${envSlug}/review-snapshots/${snapshotId}.tar`;
}

export function buildReviewInspectionKey(envSlug: string, snapshotId: string): string {
  return `envs/${envSlug}/review-snapshots/${snapshotId}.inspection.tar`;
}

export function buildReviewSnapshotsPrefix(envSlug: string): string {
  return `envs/${envSlug}/review-snapshots/`;
}

export function normalizeWorkspacePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

export function matchesReviewSnapshotExclude(path: string, prefixes: readonly string[] = ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES): boolean {
  const normalized = normalizeWorkspacePath(path);
  return prefixes.some((prefix) => {
    const normalizedPrefix = normalizeWorkspacePath(prefix).replace(/\/+$/, "");
    return normalized === normalizedPrefix || normalized.startsWith(`${normalizedPrefix}/`);
  });
}

function isSafeAbsoluteWorkspacePath(path: string): boolean {
  if (!path.startsWith("/") || path.includes("\\")) return false;
  if (path === "/") return false;
  return path.split("/").every((segment, index) =>
    index === 0 || (segment !== "" && segment !== "." && segment !== "..")
  );
}

function decodeTarString(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(bytes).replace(/\0.*$/, "");
}

function parseTarOctal(bytes: Uint8Array, label: string): number {
  const raw = decodeTarString(bytes).trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) {
    throw new Error(`Invalid tar archive: ${label} is not octal`);
  }
  const parsed = parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid tar archive: ${label} is out of range`);
  }
  return parsed;
}

function validateHeaderChecksum(header: Uint8Array): void {
  const expected = parseTarOctal(header.slice(148, 156), "checksum");
  let actual = 0;
  for (let index = 0; index < header.length; index += 1) {
    actual += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (actual !== expected) {
    throw new Error("Invalid tar archive: checksum mismatch");
  }
}

function normalizeTarPath(rawName: string, prefix: string): string {
  if (!rawName) {
    throw new Error("Invalid tar archive: empty entry path");
  }
  if (rawName.startsWith("/") || prefix.startsWith("/")) {
    throw new Error(`Invalid tar archive: absolute path ${rawName}`);
  }
  const fullName = prefix ? `${prefix}/${rawName}` : rawName;
  if (fullName.includes("\\")) {
    throw new Error(`Invalid tar archive: unsafe path ${fullName}`);
  }
  const normalized = normalizeWorkspacePath(fullName);
  if (!isSafeAbsoluteWorkspacePath(normalized)) {
    throw new Error(`Invalid tar archive: unsafe path ${fullName}`);
  }
  if (matchesReviewSnapshotExclude(normalized)) {
    throw new Error(`Invalid tar archive: excluded path ${normalized}`);
  }
  return normalized;
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytesToArrayBuffer(bytes));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function tarHeaderPath(path: string): { name: Uint8Array; prefix: Uint8Array } {
  const encoder = new TextEncoder();
  const relativePath = normalizeWorkspacePath(path).slice(1);
  const direct = encoder.encode(relativePath);
  if (direct.length <= 100) {
    return { name: direct, prefix: new Uint8Array() };
  }

  const parts = relativePath.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    const prefixBytes = encoder.encode(prefix);
    const nameBytes = encoder.encode(name);
    if (prefixBytes.length <= 155 && nameBytes.length <= 100) {
      return { name: nameBytes, prefix: prefixBytes };
    }
  }

  throw new Error(`Path is too long for ustar review snapshot: ${path}`);
}

export function buildReviewSnapshotTar(
  entries: Iterable<ReviewSnapshotTarEntry>,
  options: {
    maxBytes?: number;
    maxFiles?: number;
    maxFileBytes?: number;
    excludePrefixes?: readonly string[];
  } = {},
): Uint8Array {
  const maxBytes = options.maxBytes ?? ENV_REVIEW_SNAPSHOT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? ENV_REVIEW_SNAPSHOT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? ENV_REVIEW_SNAPSHOT_MAX_FILE_BYTES;
  const excludePrefixes = options.excludePrefixes ?? ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES;
  const encoder = new TextEncoder();
  const normalizedEntries = Array.from(entries, (entry) => {
    const path = normalizeWorkspacePath(entry.path);
    if (!isSafeAbsoluteWorkspacePath(path)) {
      throw new Error(`Invalid review snapshot path: ${entry.path}`);
    }
    if (matchesReviewSnapshotExclude(path, excludePrefixes)) {
      throw new Error(`Review snapshot path is excluded: ${path}`);
    }
    if (entry.content.byteLength > maxFileBytes) {
      throw new Error(`Snapshot entry ${path} exceeds ${maxFileBytes} bytes`);
    }
    return { path, content: entry.content };
  }).sort((left, right) => left.path.localeCompare(right.path));

  if (normalizedEntries.length > maxFiles) {
    throw new Error(`Snapshot tar exceeds ${maxFiles} file entries`);
  }

  const seenPaths = new Set<string>();
  const chunks: Uint8Array[] = [];
  let totalBytes = 1024;
  let totalFileBytes = 0;
  for (const entry of normalizedEntries) {
    if (seenPaths.has(entry.path)) {
      throw new Error(`Duplicate review snapshot entry ${entry.path}`);
    }
    seenPaths.add(entry.path);
    totalFileBytes += entry.content.byteLength;
    if (totalFileBytes > maxBytes) {
      throw new Error(`Snapshot file content exceeds ${maxBytes} bytes`);
    }

    const header = new Uint8Array(512);
    const pathParts = tarHeaderPath(entry.path);
    header.set(pathParts.name, 0);
    header.set(encoder.encode("0000644\0"), 100);
    header.set(encoder.encode("0000000\0"), 108);
    header.set(encoder.encode("0000000\0"), 116);
    header.set(encoder.encode(entry.content.byteLength.toString(8).padStart(11, "0") + "\0"), 124);
    header.set(encoder.encode("00000000000\0"), 136);
    header[156] = 48;
    header.set(encoder.encode("ustar\0"), 257);
    header.set(encoder.encode("00"), 263);
    if (pathParts.prefix.byteLength > 0) {
      header.set(pathParts.prefix, 345);
    }
    header.set(encoder.encode("        "), 148);
    let checksum = 0;
    for (let index = 0; index < 512; index += 1) checksum += header[index];
    header.set(encoder.encode(checksum.toString(8).padStart(6, "0") + "\0 "), 148);

    const padding = entry.content.byteLength % 512 === 0 ? 0 : 512 - (entry.content.byteLength % 512);
    totalBytes += 512 + entry.content.byteLength + padding;
    if (totalBytes > maxBytes) {
      throw new Error(`Snapshot tar exceeds ${maxBytes} bytes`);
    }
    chunks.push(header, entry.content);
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }

  chunks.push(new Uint8Array(1024));
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function buildReviewSnapshotTarFromWorkspace(
  workspace: ReviewSnapshotWorkspaceReader,
  options: {
    maxBytes?: number;
    maxFiles?: number;
    maxFileBytes?: number;
    excludePrefixes?: readonly string[];
  } = {},
): Promise<Uint8Array> {
  const excludePrefixes = options.excludePrefixes ?? ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES;
  const files = (await workspace.globWorkspace("**/*"))
    .filter((entry) => entry.type === "file")
    .map((entry) => normalizeWorkspacePath(entry.path))
    .filter((path) => !matchesReviewSnapshotExclude(path, excludePrefixes))
    .sort((left, right) => left.localeCompare(right));

  const entries: ReviewSnapshotTarEntry[] = [];
  for (const path of files) {
    const content = await workspace.readWorkspaceFileBytes(path);
    if (content === null) {
      throw new Error(`Saved workspace file disappeared while building review snapshot: ${path}`);
    }
    entries.push({ path, content });
  }
  return buildReviewSnapshotTar(entries, options);
}

export async function validateReviewSnapshotTar(
  tarBuffer: Uint8Array,
  options: {
    maxBytes?: number;
    maxFiles?: number;
    maxFileBytes?: number;
  } = {},
): Promise<ValidatedReviewSnapshotTar> {
  const maxBytes = options.maxBytes ?? ENV_REVIEW_SNAPSHOT_MAX_BYTES;
  const maxFiles = options.maxFiles ?? ENV_REVIEW_SNAPSHOT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? ENV_REVIEW_SNAPSHOT_MAX_FILE_BYTES;
  if (tarBuffer.byteLength > maxBytes) {
    throw new Error(`Snapshot tar exceeds ${maxBytes} bytes`);
  }
  if (tarBuffer.byteLength < 512) {
    throw new Error("Invalid tar archive: missing header");
  }

  let offset = 0;
  let sawEnd = false;
  let totalFileBytes = 0;
  const entries = new Map<string, Uint8Array>();

  while (offset + 512 <= tarBuffer.length) {
    const header = tarBuffer.slice(offset, offset + 512);
    offset += 512;

    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }

    validateHeaderChecksum(header);
    const rawName = decodeTarString(header.slice(0, 100));
    const size = parseTarOctal(header.slice(124, 136), "size");
    const typeFlag = decodeTarString(header.slice(156, 157)) || "0";
    const prefix = decodeTarString(header.slice(345, 500));
    const path = normalizeTarPath(rawName, prefix);
    const paddedSize = Math.ceil(size / 512) * 512;
    if (offset + paddedSize > tarBuffer.length) {
      throw new Error("Invalid tar archive: truncated entry payload");
    }

    if (typeFlag === "5") {
      if (size !== 0) {
        throw new Error(`Invalid tar archive: directory ${path} has a payload`);
      }
      offset += paddedSize;
      continue;
    }
    if (typeFlag !== "0") {
      throw new Error(`Invalid tar archive: unsupported entry type ${JSON.stringify(typeFlag)} for ${path}`);
    }
    if (entries.has(path)) {
      throw new Error(`Invalid tar archive: duplicate entry ${path}`);
    }
    if (size > maxFileBytes) {
      throw new Error(`Snapshot entry ${path} exceeds ${maxFileBytes} bytes`);
    }
    if (entries.size + 1 > maxFiles) {
      throw new Error(`Snapshot tar exceeds ${maxFiles} file entries`);
    }
    totalFileBytes += size;
    if (totalFileBytes > maxBytes) {
      throw new Error(`Snapshot file content exceeds ${maxBytes} bytes`);
    }

    entries.set(path, tarBuffer.slice(offset, offset + size));
    offset += paddedSize;
  }

  if (!sawEnd) {
    throw new Error("Invalid tar archive: missing end marker");
  }
  if (!tarBuffer.slice(offset).every((byte) => byte === 0)) {
    throw new Error("Invalid tar archive: trailing data after end marker");
  }

  const manifest: ReviewSnapshotManifestEntry[] = [];
  for (const [path, content] of entries) {
    manifest.push({ path, size: content.byteLength, sha256: await sha256HexBytes(content) });
  }
  manifest.sort((left, right) => left.path.localeCompare(right.path));

  return {
    entries,
    manifest,
    fileCount: manifest.length,
    totalFileBytes,
    tarBytes: tarBuffer.byteLength,
  };
}

export function normalizeReviewSnapshotDeletedPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) {
    throw new Error("githubDeletedPaths must be an array");
  }
  const normalized: string[] = [];
  for (const value of paths) {
    if (typeof value !== "string") {
      throw new Error("githubDeletedPaths must contain only strings");
    }
    const path = value.trim();
    if (!isSafeAbsoluteWorkspacePath(path)) {
      throw new Error(`Invalid GitHub deleted path: ${value}`);
    }
    if (path === GITHUB_DELETED_PATHS_WORKSPACE_PATH || matchesReviewSnapshotExclude(path)) {
      throw new Error(`GitHub deleted path is excluded: ${path}`);
    }
    normalized.push(path);
  }
  const deduped = Array.from(new Set(normalized)).sort((left, right) => left.localeCompare(right));
  if (deduped.length > ENV_REVIEW_SNAPSHOT_MAX_DELETED_PATHS) {
    throw new Error(`githubDeletedPaths exceeds ${ENV_REVIEW_SNAPSHOT_MAX_DELETED_PATHS} paths`);
  }
  if (new TextEncoder().encode(JSON.stringify(deduped)).byteLength > ENV_REVIEW_SNAPSHOT_MAX_DELETED_PATHS_BYTES) {
    throw new Error(`githubDeletedPaths exceeds ${ENV_REVIEW_SNAPSHOT_MAX_DELETED_PATHS_BYTES} bytes`);
  }
  return deduped;
}

export async function computeReviewSnapshotHash(input: {
  manifest: Iterable<ReviewSnapshotManifestEntry>;
  githubDeletedPaths?: readonly string[];
  baseCommitSha?: string | null;
}): Promise<string> {
  const encoder = new TextEncoder();
  const fileLines = Array.from(input.manifest)
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((entry) => `file\0${normalizeWorkspacePath(entry.path)}\0${entry.sha256}`);
  const deletionLines = Array.from(input.githubDeletedPaths ?? [])
    .sort((left, right) => left.localeCompare(right))
    .map((path) => `delete\0${path}`);
  const baseLine = `base\0${input.baseCommitSha?.trim() || ""}`;
  return sha256HexBytes(encoder.encode([baseLine, ...deletionLines, ...fileLines].join("\n")));
}

export function buildReviewSnapshotPreparationResult(input: {
  opId: string;
  snapshot: EnvReviewSnapshot;
  changedCount: number;
  uploadedBytes: number;
  completedAt: string;
}): EnvReviewPreparationResult {
  return {
    formatVersion: ENV_REVIEW_SNAPSHOT_FORMAT_VERSION,
    status: "succeeded",
    opId: input.opId,
    snapshot: input.snapshot,
    changedCount: input.changedCount,
    deletedCount: input.snapshot.githubDeletedPaths.length,
    uploadedBytes: input.uploadedBytes,
    completedAt: input.completedAt,
    error: null,
  };
}

type MaybePromise<T> = T | Promise<T>;

export type ReviewSnapshotCompletion =
  | { status: "completed"; operation: EnvReviewPreparationOperation }
  | { status: "already_completed"; operation: EnvReviewPreparationOperation; sameSnapshotHash: boolean }
  | { status: "rejected"; reason: string; operation: EnvReviewPreparationOperation | null };

export interface ReviewSnapshotCompleter {
  completeSnapshotPreparation(input: {
    envSlug: string;
    sessionId: string;
    opId: string;
    uploadToken: string;
    result: EnvReviewPreparationResult;
  }): MaybePromise<ReviewSnapshotCompletion>;
  completeSavedSnapshotPreparation(input: {
    envSlug: string;
    sessionId: string;
    opId: string;
    result: EnvReviewPreparationResult;
  }): MaybePromise<ReviewSnapshotCompletion>;
}

export async function storeAndCompleteReviewSnapshot(input: {
  bucket: R2Bucket;
  review: ReviewSnapshotCompleter;
  op: EnvReviewPreparationOperation;
  source: EnvReviewSnapshotSource;
  mode: EnvReviewSnapshotMode;
  stale: boolean;
  tarBytes: Uint8Array;
  validated: ValidatedReviewSnapshotTar;
  githubDeletedPaths: string[];
  baseCommitSha: string | null;
  uploadToken?: string | null;
  snapshotHash?: string;
  createdAt?: string;
}): Promise<ReviewSnapshotCompletion & { snapshot: EnvReviewSnapshot; result: EnvReviewPreparationResult }> {
  if (input.source === "live-harness" && !input.uploadToken) {
    throw new Error("Live review snapshot completion requires an upload token.");
  }
  const snapshotHash = input.snapshotHash ?? await computeReviewSnapshotHash({
    manifest: input.validated.manifest,
    githubDeletedPaths: input.githubDeletedPaths,
    baseCommitSha: input.baseCommitSha,
  });
  const snapshotId = createReviewSnapshotId(input.op.opId, snapshotHash);
  const r2Key = buildReviewSnapshotKey(input.op.envSlug, snapshotId);
  const createdAt = input.createdAt ?? new Date().toISOString();
  const snapshot: EnvReviewSnapshot = {
    snapshotId,
    source: input.source,
    mode: input.mode,
    stale: input.stale,
    createdAt,
    snapshotHash,
    baseCommitSha: input.baseCommitSha,
    githubDeletedPaths: input.githubDeletedPaths,
    r2Key,
  };
  await putReviewSnapshotArtifact(input.bucket, r2Key, input.tarBytes, {
    envSlug: input.op.envSlug,
    opId: input.op.opId,
    snapshotId,
    snapshotHash,
    source: input.source,
    mode: input.mode,
  });
  const result = buildReviewSnapshotPreparationResult({
    opId: input.op.opId,
    snapshot,
    changedCount: input.validated.fileCount,
    uploadedBytes: input.validated.tarBytes,
    completedAt: createdAt,
  });
  const completed = input.source === "live-harness"
    ? await input.review.completeSnapshotPreparation({
      envSlug: input.op.envSlug,
      sessionId: input.op.sessionId,
      opId: input.op.opId,
      uploadToken: input.uploadToken ?? "",
      result,
    })
    : await input.review.completeSavedSnapshotPreparation({
      envSlug: input.op.envSlug,
      sessionId: input.op.sessionId,
      opId: input.op.opId,
      result,
    });
  if (completed.status !== "completed") {
    const completedSnapshot = completed.operation?.result?.snapshot ?? null;
    const isSameCompletedObject = completed.status === "already_completed"
      && completed.sameSnapshotHash
      && completedSnapshot?.r2Key === r2Key;
    if (isSameCompletedObject) {
      return { ...completed, snapshot: completedSnapshot, result: completed.operation.result as EnvReviewPreparationResult };
    }
    await deleteReviewSnapshotArtifact(input.bucket, r2Key).catch(() => {});
  }
  return { ...completed, snapshot, result };
}

function normalizeMetadataValue(value: string | number | boolean | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export async function putReviewSnapshotArtifact(
  bucket: R2Bucket,
  key: string,
  body: Uint8Array | ArrayBuffer | ReadableStream | Blob,
  metadata: Record<string, string | number | boolean | null | undefined> = {},
): Promise<R2Object | null> {
  const customMetadata: Record<string, string> = {};
  for (const [keyName, value] of Object.entries(metadata)) {
    const normalized = normalizeMetadataValue(value);
    if (normalized !== undefined) customMetadata[keyName] = normalized;
  }
  return bucket.put(key, body, {
    httpMetadata: { contentType: ENV_REVIEW_SNAPSHOT_CONTENT_TYPE },
    customMetadata,
  });
}

export async function getReviewSnapshotArtifact(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

export async function deleteReviewSnapshotArtifact(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

export async function deleteReviewSnapshotArtifacts(bucket: R2Bucket, envSlug: string): Promise<void> {
  const prefix = buildReviewSnapshotsPrefix(envSlug);
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    await Promise.all(listed.objects.map((object) => bucket.delete(object.key).catch(() => {})));
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function r2ObjectToBytes(object: R2ObjectBody): Promise<Uint8Array> {
  return new Uint8Array(await object.arrayBuffer());
}

export class TarBackedEnvReviewWorkspaceSource {
  private parsed: Promise<ValidatedReviewSnapshotTar> | null = null;

  constructor(
    private readonly tarBytes: Uint8Array,
    private readonly githubDeletedPaths: readonly string[] = [],
  ) {}

  private parseOnce(): Promise<ValidatedReviewSnapshotTar> {
    if (!this.parsed) {
      this.parsed = validateReviewSnapshotTar(this.tarBytes);
    }
    return this.parsed;
  }

  async getHashedManifest(options?: { excludePrefixes?: string[] }): Promise<ReviewSnapshotManifestEntry[]> {
    const parsed = await this.parseOnce();
    return parsed.manifest.filter((entry) => !matchesReviewSnapshotExclude(entry.path, options?.excludePrefixes ?? []));
  }

  async statWorkspaceFile(path: string): Promise<{ path: string; size: number } | null> {
    const parsed = await this.parseOnce();
    const normalized = normalizeWorkspacePath(path);
    const content = parsed.entries.get(normalized);
    return content ? { path: normalized, size: content.byteLength } : null;
  }

  async readWorkspaceFileBytes(path: string): Promise<Uint8Array | null> {
    const parsed = await this.parseOnce();
    return parsed.entries.get(normalizeWorkspacePath(path)) ?? null;
  }

  async readGitHubDeletedWorkspacePaths(): Promise<string[]> {
    return [...this.githubDeletedPaths];
  }
}
