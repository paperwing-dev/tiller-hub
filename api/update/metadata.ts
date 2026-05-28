import type { TillerUpdateMetadata } from "./types";

export const PUBLIC_HUB_REPO = "paperwing-dev/tiller-hub";
export const UPDATE_METADATA_PATH = "tiller-update.json";
export const UPDATE_CHECK_CACHE_KEY = "tiller:update-check:v2";
export const UPDATE_CACHE_TTL_SECONDS = 300;

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

export function getBuildDiagnostics() {
  const version = typeof __TILLER_VERSION__ === "string" ? __TILLER_VERSION__ : "";
  const workersCiCommitSha = typeof __WORKERS_CI_COMMIT_SHA__ === "string" ? __WORKERS_CI_COMMIT_SHA__ : "";
  const workersCiBranch = typeof __WORKERS_CI_BRANCH__ === "string" ? __WORKERS_CI_BRANCH__ : "";
  return {
    version: version.trim(),
    workersCiCommitSha: workersCiCommitSha.trim() || null,
    workersCiBranch: workersCiBranch.trim() || null,
  };
}

export async function fetchPublicUpdateMetadata(): Promise<TillerUpdateMetadata> {
  const response = await fetch(`https://raw.githubusercontent.com/${PUBLIC_HUB_REPO}/main/${UPDATE_METADATA_PATH}`, {
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

export function findRemovedManagedFiles(current: TillerUpdateMetadata, latest: TillerUpdateMetadata): string[] {
  const latestFiles = new Set(latest.managedFiles);
  return current.managedFiles.filter((managedPath) => !latestFiles.has(managedPath));
}
