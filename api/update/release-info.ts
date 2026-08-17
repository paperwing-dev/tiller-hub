import type { ReleaseInfo, UpdateBuildDiagnostics } from "./types";

const SHA40 = /^[0-9a-f]{40}$/;
const DIGEST_PINNED_SANDBOX = /^docker\.io\/jamieatlason\/tiller-sandbox@sha256:[0-9a-f]{64}$/;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReleaseInfo(value: unknown): ReleaseInfo | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (Object.keys(value).some((key) => ![
    "schemaVersion", "channel", "hubVersion", "releaseId", "selfHostRuntimeImage",
  ].includes(key))) return null;
  if (value.channel !== "development" && value.channel !== "release") return null;
  const hubVersion = typeof value.hubVersion === "string" ? value.hubVersion.trim() : "";
  if (!STABLE_VERSION.test(hubVersion)) return null;
  const releaseId = value.releaseId === undefined
    ? undefined
    : typeof value.releaseId === "string" && SHA40.test(value.releaseId.trim()) && !/^0{40}$/.test(value.releaseId.trim())
      ? value.releaseId.trim()
      : null;
  if (releaseId === null) return null;
  const selfHostRuntimeImage = value.selfHostRuntimeImage === undefined
    ? undefined
    : typeof value.selfHostRuntimeImage === "string" && DIGEST_PINNED_SANDBOX.test(value.selfHostRuntimeImage.trim())
      ? value.selfHostRuntimeImage.trim() as ReleaseInfo["selfHostRuntimeImage"]
      : null;
  if (selfHostRuntimeImage === null) return null;
  return {
    schemaVersion: 1,
    channel: value.channel,
    hubVersion,
    ...(releaseId ? { releaseId } : {}),
    ...(selfHostRuntimeImage ? { selfHostRuntimeImage } : {}),
  };
}

export function getCurrentReleaseInfo(): ReleaseInfo {
  const embedded = typeof __TILLER_RELEASE_INFO__ === "undefined"
    ? (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__
    : __TILLER_RELEASE_INFO__;
  const parsed = parseReleaseInfo(embedded);
  if (!parsed) throw new Error("Embedded Tiller release info is missing or invalid.");
  return parsed;
}

export function getBuildChannel(): ReleaseInfo["channel"] {
  const channel = typeof __TILLER_BUILD_CHANNEL__ === "string" ? __TILLER_BUILD_CHANNEL__.trim() : "";
  return channel === "development" ? "development" : "release";
}

export function getBuildDiagnostics(): UpdateBuildDiagnostics {
  const version = typeof __TILLER_VERSION__ === "string" ? __TILLER_VERSION__ : "";
  const workersCiCommitSha = typeof __WORKERS_CI_COMMIT_SHA__ === "string" ? __WORKERS_CI_COMMIT_SHA__ : "";
  const workersCiBranch = typeof __WORKERS_CI_BRANCH__ === "string" ? __WORKERS_CI_BRANCH__ : "";
  return {
    channel: getBuildChannel(),
    version: version.trim(),
    workersCiCommitSha: workersCiCommitSha.trim() || null,
    workersCiBranch: workersCiBranch.trim() || null,
  };
}

export function currentReleaseInfoForEnvironment(release: ReleaseInfo, installedReleaseId?: string): ReleaseInfo {
  const releaseId = installedReleaseId?.trim() ?? "";
  if (!SHA40.test(releaseId) || /^0{40}$/.test(releaseId)) return release;
  return { ...release, releaseId };
}
