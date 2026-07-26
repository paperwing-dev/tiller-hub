import type { GitHubRelease, SelfHostRuntimeMetadata, TillerUpdateMetadata } from "./types";
import {
  parseManagedSelfHostRuntime,
  parseManagedSelfHostSandboxImageSourceId as parseManagedSandboxImageSourceId,
} from "../../scripts/self-host-runtime-contract.mjs";

export const PUBLIC_HUB_REPO = "paperwing-dev/tiller-hub";
export const UPDATE_METADATA_PATH = "tiller-update.json";
export const UPDATE_CHECK_CACHE_KEY = "tiller:update-check:v4";
export const UPDATE_CACHE_TTL_SECONDS = 6 * 60 * 60;
export const UPDATE_SERVICE_URL = "https://updates.paperwing.dev/tiller-hub/latest";
export const UPDATE_SERVICE_TIMEOUT_MS = 1_500;

const LATEST_RELEASE_URL = `https://api.github.com/repos/${PUBLIC_HUB_REPO}/releases/latest`;

interface LatestReleaseUpdateMetadata {
  update: TillerUpdateMetadata;
  releaseNotesUrl: string;
}

export interface FetchLatestReleaseUpdateMetadataOptions {
  currentVersion?: string | null;
  channel?: "development" | "release";
  updateServiceDisabled?: string | null;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isSafeManagedPath(value: string): boolean {
  if (!value.trim()) return false;
  if (value.startsWith("/") || value.startsWith("\\")) return false;
  if (value.includes("\0")) return false;
  const parts = value.split(/[\\/]+/);
  if (parts.some((part) => !part || part === "." || part === ".." || part === ".git")) return false;
  return value === parts.join("/");
}

export function parseManagedSelfHostSandboxImageSourceId(image: string): string | null {
  return parseManagedSandboxImageSourceId(image);
}

export function parseSelfHostRuntimeMetadata(value: unknown): SelfHostRuntimeMetadata | null {
  return parseManagedSelfHostRuntime(value);
}

export function parseTillerUpdateMetadata(value: unknown): TillerUpdateMetadata | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== 1) return null;
  if (value.channel !== "deploy-button") return null;
  if (value.updateMode !== "full-source") return null;
  if (value.sourceRepo !== PUBLIC_HUB_REPO) return null;
  if (typeof value.sourceId !== "string" || !value.sourceId.trim()) return null;
  if (typeof value.version !== "string" || !value.version.trim()) return null;
  if (typeof value.label !== "string" || !value.label.trim()) return null;
  if (!Array.isArray(value.managedFiles) || value.managedFiles.length === 0) return null;

  const selfHostRuntime = value.selfHostRuntime === undefined
    ? undefined
    : parseSelfHostRuntimeMetadata(value.selfHostRuntime);
  if (value.selfHostRuntime !== undefined && !selfHostRuntime) return null;

  const managedFiles: string[] = [];
  const seen = new Set<string>();
  for (const item of value.managedFiles) {
    if (typeof item !== "string" || !isSafeManagedPath(item) || seen.has(item)) {
      return null;
    }
    seen.add(item);
    managedFiles.push(item);
  }

  return {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: PUBLIC_HUB_REPO,
    sourceId: value.sourceId.trim(),
    version: value.version.trim(),
    label: value.label.trim(),
    managedFiles,
    ...(selfHostRuntime ? { selfHostRuntime } : {}),
  };
}

export function getCurrentUpdateMetadata(): TillerUpdateMetadata {
  const embedded = typeof __TILLER_CURRENT_UPDATE__ === "undefined"
    ? (globalThis as typeof globalThis & { __TILLER_CURRENT_UPDATE__?: unknown }).__TILLER_CURRENT_UPDATE__
    : __TILLER_CURRENT_UPDATE__;
  const parsed = parseTillerUpdateMetadata(embedded);
  if (!parsed) {
    throw new Error("Embedded tiller-update.json is missing or invalid.");
  }
  return parsed;
}

export function getBuildChannel(): "development" | "release" {
  const channel = typeof __TILLER_BUILD_CHANNEL__ === "string" ? __TILLER_BUILD_CHANNEL__.trim() : "";
  return channel === "development" ? "development" : "release";
}

export function getBuildDiagnostics() {
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

function normalizeVersionTag(tagName: string): string {
  return tagName.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
}

function describeReleaseLookupFailure(status: number): string {
  if (status === 404) {
    return `Latest ${PUBLIC_HUB_REPO} release is not accessible. The repo may be private or may not have a published release yet.`;
  }
  if (status === 401 || status === 403) {
    return `Latest ${PUBLIC_HUB_REPO} release lookup is not authorized by GitHub (${status}).`;
  }
  return `GitHub release lookup failed: ${status}`;
}

function parseLatestReleaseUpdateMetadata(value: unknown): LatestReleaseUpdateMetadata | null {
  if (!isRecord(value)) return null;
  const update = parseTillerUpdateMetadata(value.update);
  if (!update) return null;
  if (typeof value.releaseNotesUrl !== "string" || !value.releaseNotesUrl.trim()) return null;
  return {
    update,
    releaseNotesUrl: value.releaseNotesUrl.trim(),
  };
}

async function fetchPublicUpdateMetadataAtRef(ref: string): Promise<TillerUpdateMetadata> {
  const response = await fetch(`https://raw.githubusercontent.com/${PUBLIC_HUB_REPO}/${encodeURIComponent(ref)}/${UPDATE_METADATA_PATH}`, {
    headers: {
      Accept: "application/json",
      "User-Agent": "tiller-hub",
    },
  });
  if (!response.ok) {
    throw new Error(`Latest deploy-button update metadata lookup failed: HTTP ${response.status}`);
  }
  const parsed = parseTillerUpdateMetadata(await response.json());
  if (!parsed) {
    throw new Error("Latest deploy-button update metadata is invalid.");
  }
  return parsed;
}

async function fetchLatestReleaseUpdateMetadataFromGitHub(): Promise<LatestReleaseUpdateMetadata> {
  const latestRelease = await fetchLatestPublicHubReleaseRef();
  const update = await fetchPublicUpdateMetadataAtRef(latestRelease.tagName);
  if (normalizeVersionTag(update.version) !== normalizeVersionTag(latestRelease.tagName)) {
    throw new Error(`${UPDATE_METADATA_PATH} version ${update.version} does not match release tag ${latestRelease.tagName}.`);
  }

  return {
    update,
    releaseNotesUrl: latestRelease.releaseNotesUrl,
  };
}

function isUpdateServiceDisabled(value: string | null | undefined): boolean {
  return value?.trim() === "1";
}

async function fetchLatestReleaseUpdateMetadataFromService(
  options: FetchLatestReleaseUpdateMetadataOptions,
): Promise<LatestReleaseUpdateMetadata> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? UPDATE_SERVICE_TIMEOUT_MS);
  try {
    const response = await fetch(UPDATE_SERVICE_URL, {
      signal: controller.signal,
      headers: {
        "X-Tiller-Version": options.currentVersion?.trim() || "unknown",
        "X-Tiller-Channel": options.channel === "development" ? "development" : "release",
      },
    });
    if (!response.ok) {
      throw new Error(`Update service lookup failed: HTTP ${response.status}`);
    }
    const parsed = parseLatestReleaseUpdateMetadata(await response.json());
    if (!parsed) {
      throw new Error("Update service returned invalid metadata.");
    }
    return parsed;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchLatestReleaseUpdateMetadata(
  options: FetchLatestReleaseUpdateMetadataOptions = {},
): Promise<LatestReleaseUpdateMetadata> {
  if (!isUpdateServiceDisabled(options.updateServiceDisabled)) {
    try {
      return await fetchLatestReleaseUpdateMetadataFromService(options);
    } catch {
      // The public update service is an optimization and analytics collection
      // point only. GitHub remains the authoritative fallback.
    }
  }

  return fetchLatestReleaseUpdateMetadataFromGitHub();
}

export async function fetchLatestPublicHubReleaseRef(): Promise<{
  tagName: string;
  releaseNotesUrl: string;
}> {
  const releaseResponse = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tiller-hub",
    },
  });
  if (!releaseResponse.ok) {
    throw new Error(describeReleaseLookupFailure(releaseResponse.status));
  }

  const release = await releaseResponse.json<GitHubRelease>();
  const tagName = release.tag_name?.trim() ?? "";
  if (!tagName) {
    throw new Error("GitHub latest release is missing a valid tag name.");
  }

  return {
    tagName,
    releaseNotesUrl: release.html_url || `https://github.com/${PUBLIC_HUB_REPO}/releases/tag/${encodeURIComponent(tagName)}`,
  };
}

export function findRemovedManagedFiles(current: TillerUpdateMetadata, latest: TillerUpdateMetadata): string[] {
  const latestFiles = new Set(latest.managedFiles);
  return current.managedFiles.filter((managedPath) => !latestFiles.has(managedPath));
}
