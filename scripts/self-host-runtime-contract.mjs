const SOURCE_ID_RE = /^[0-9a-f]{40}$/;
const MANAGED_SANDBOX_IMAGE_RE = /^docker\.io\/jamieatlason\/tiller-sandbox:([0-9a-f]{40})$/;
const MANAGED_SCM_IMAGE_RE = /^docker\.io\/jamieatlason\/tiller-scm:([0-9a-f]{40})$/;

function readTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseManagedSelfHostSandboxImageSourceId(image) {
  return readTrimmedString(image).match(MANAGED_SANDBOX_IMAGE_RE)?.[1] ?? null;
}

export function parseManagedSelfHostScmImageSourceId(image) {
  return readTrimmedString(image).match(MANAGED_SCM_IMAGE_RE)?.[1] ?? null;
}

/**
 * @returns {{ imageSourceId: string; sandboxImage: string }}
 */
export function validateManagedSelfHostRuntime(value, label = "selfHostRuntime") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const imageSourceId = readTrimmedString(value.imageSourceId);
  const sandboxImage = readTrimmedString(value.sandboxImage);
  const taggedSourceId = parseManagedSelfHostSandboxImageSourceId(sandboxImage);
  if (!SOURCE_ID_RE.test(imageSourceId)) {
    throw new Error(`${label}.imageSourceId must be a 40-character lowercase hex SHA`);
  }
  if (!taggedSourceId) {
    throw new Error(
      `${label}.sandboxImage must be docker.io/jamieatlason/tiller-sandbox:<40-character lowercase hex SHA>`,
    );
  }
  if (taggedSourceId !== imageSourceId) {
    throw new Error(`${label}.sandboxImage tag must match ${label}.imageSourceId`);
  }

  return { imageSourceId, sandboxImage };
}

/**
 * @returns {{ imageSourceId: string; sandboxImage: string } | null}
 */
export function parseManagedSelfHostRuntime(value) {
  try {
    return validateManagedSelfHostRuntime(value);
  } catch {
    return null;
  }
}

/**
 * @returns {{
 *   schemaVersion: 2;
 *   hubCommitSha: string;
 *   imageCommitSha: string;
 *   sandboxImage: string;
 *   scmImage: string;
 *   reviewerIsolationProtocol?: 1;
 *   recordedAt: string;
 * }}
 */
export function normalizeSelfHostDeployRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new Error("deploy record must be a JSON object.");
  }

  const legacyCommitSha = readTrimmedString(record.commitSha);
  const hubCommitSha = readTrimmedString(record.hubCommitSha || legacyCommitSha);
  const imageCommitSha = readTrimmedString(record.imageCommitSha || legacyCommitSha);
  if (!SOURCE_ID_RE.test(hubCommitSha)) {
    throw new Error("deploy record does not contain an immutable hubCommitSha.");
  }
  if (!SOURCE_ID_RE.test(imageCommitSha)) {
    throw new Error("deploy record does not contain an immutable imageCommitSha.");
  }

  const runtime = validateManagedSelfHostRuntime({
    imageSourceId: imageCommitSha,
    sandboxImage: record.sandboxImage,
  }, "deploy record");
  const scmImage = readTrimmedString(record.scmImage);
  const scmSourceId = parseManagedSelfHostScmImageSourceId(scmImage);
  if (!scmSourceId) {
    throw new Error("deploy record does not contain an immutable scmImage ref.");
  }
  if (scmSourceId !== imageCommitSha) {
    throw new Error("deploy record scmImage tag must match imageCommitSha.");
  }
  const reviewerIsolationProtocol = record.reviewerIsolationProtocol;
  if (reviewerIsolationProtocol !== undefined && reviewerIsolationProtocol !== 1) {
    throw new Error("deploy record reviewerIsolationProtocol must be 1 when present.");
  }

  return {
    schemaVersion: 2,
    hubCommitSha,
    imageCommitSha,
    sandboxImage: runtime.sandboxImage,
    scmImage,
    ...(reviewerIsolationProtocol === 1 ? { reviewerIsolationProtocol: 1 } : {}),
    recordedAt: readTrimmedString(record.recordedAt),
  };
}
