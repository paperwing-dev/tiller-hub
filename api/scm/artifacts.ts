import {
  ENV_SNAPSHOTS_PREFIX,
  SCM_ARTIFACT_CONTENT_TYPE,
  SCM_ARTIFACT_SUFFIX,
} from "./constants";

export interface EnvSnapshotRef {
  envSlug: string;
  snapshotId: string;
}

function createArtifactId(prefix: string): string {
  return `${prefix}${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export function buildEnvSnapshotKey(ref: EnvSnapshotRef): string {
  return `${ENV_SNAPSHOTS_PREFIX}/${ref.envSlug}/snapshots/${ref.snapshotId}${SCM_ARTIFACT_SUFFIX}`;
}

export function buildEnvSnapshotsPrefix(envSlug: string): string {
  return `${ENV_SNAPSHOTS_PREFIX}/${envSlug}/snapshots/`;
}

export function parseEnvSnapshotIdFromKey(key: string, envSlug: string): string | null {
  const prefix = buildEnvSnapshotsPrefix(envSlug);
  if (!key.startsWith(prefix) || !key.endsWith(SCM_ARTIFACT_SUFFIX)) {
    return null;
  }

  const snapshotId = key.slice(prefix.length, key.length - SCM_ARTIFACT_SUFFIX.length);
  return snapshotId || null;
}

export function createEnvSnapshotId(): string {
  return createArtifactId("s");
}

export function buildEnvBranchName(slug: string): string {
  return `env/${slug}`;
}

function normalizeMetadataValue(
  value: string | number | boolean | null | undefined,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

export function normalizeScmArtifactMetadata(
  metadata: Record<string, string | number | boolean | null | undefined>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(metadata)) {
    const next = normalizeMetadataValue(value);
    if (next !== undefined) {
      normalized[key] = next;
    }
  }
  return normalized;
}

export async function putScmArtifact(
  bucket: R2Bucket,
  key: string,
  body: ReadableStream | Uint8Array | ArrayBuffer | ArrayBufferView | Blob | string,
  metadata: Record<string, string | number | boolean | null | undefined> = {},
): Promise<R2Object | null> {
  return bucket.put(key, body, {
    httpMetadata: {
      contentType: SCM_ARTIFACT_CONTENT_TYPE,
    },
    customMetadata: normalizeScmArtifactMetadata(metadata),
  });
}

export async function getScmArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

export async function headScmArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<R2Object | null> {
  return bucket.head(key);
}

export async function deleteScmArtifact(
  bucket: R2Bucket,
  key: string,
): Promise<void> {
  await bucket.delete(key);
}
