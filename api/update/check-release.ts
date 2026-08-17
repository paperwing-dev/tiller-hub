import type { Env } from "../types";
import {
  currentReleaseInfoForEnvironment,
  getBuildDiagnostics,
  getCurrentReleaseInfo,
} from "./release-info";
import type {
  ReleaseInfo,
  StableReleaseSummary,
  UpdateCheckError,
  UpdateCheckResult,
} from "./types";

export const INSTALLER_STABLE_URL = "https://install.paperwing.dev/stable";
export const INSTALLER_STABLE_CACHE_KEY = "tiller:installer-stable:v2";
export const UPDATE_CACHE_TTL_SECONDS = 6 * 60 * 60;
const INSTALLER_STABLE_TIMEOUT_MS = 1_500;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

interface ParsedVersion {
  core: [string, string, string];
  prerelease: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseStableReleaseSummary(value: unknown): StableReleaseSummary | null {
  if (!isRecord(value)) return null;
  const releaseId = typeof value.releaseId === "string" ? value.releaseId.trim() : "";
  const version = typeof value.version === "string" ? value.version.trim() : "";
  const releaseNotesUrl = typeof value.releaseNotesUrl === "string" ? value.releaseNotesUrl.trim() : "";
  if (!/^[0-9a-f]{40}$/.test(releaseId) || /^0{40}$/.test(releaseId) || !parseVersion(version)) return null;
  try {
    const parsed = new URL(releaseNotesUrl);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  } catch {
    return null;
  }
  return { releaseId, version, releaseNotesUrl };
}

async function fetchInstallerStableRelease(): Promise<StableReleaseSummary> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), INSTALLER_STABLE_TIMEOUT_MS);
  try {
    const response = await fetch(INSTALLER_STABLE_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json", "Cache-Control": "no-cache" },
    });
    if (!response.ok) throw new Error(`Installer stable release lookup failed: HTTP ${response.status}`);
    const summary = parseStableReleaseSummary(await response.json());
    if (!summary) throw new Error("Installer stable release summary is invalid.");
    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

async function readInstallerStableRelease(
  env: Env,
  forceRefresh: boolean,
): Promise<StableReleaseSummary> {
  const cached = parseStableReleaseSummary(
    await env.ENVS_KV.get(INSTALLER_STABLE_CACHE_KEY, "json"),
  );
  if (cached && !forceRefresh) return cached;

  try {
    const summary = await fetchInstallerStableRelease();
    await env.ENVS_KV.put(INSTALLER_STABLE_CACHE_KEY, JSON.stringify(summary), {
      expirationTtl: UPDATE_CACHE_TTL_SECONDS,
    });
    return summary;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
}

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(version.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, ""));
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return { core: [match[1]!, match[2]!, match[3]!], prerelease };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) throw new Error(`Cannot compare invalid release versions: ${left} and ${right}.`);
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const result = compareNumericIdentifiers(leftVersion.core[index]!, rightVersion.core[index]!);
    if (result !== 0) return result;
  }
  if (leftVersion.prerelease.length === 0 || rightVersion.prerelease.length === 0) {
    if (leftVersion.prerelease.length === rightVersion.prerelease.length) return 0;
    return leftVersion.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index];
    const rightPart = rightVersion.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) return leftPart === undefined ? -1 : 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

export function isUpdateAvailable(current: ReleaseInfo, stable: StableReleaseSummary): boolean {
  if (current.channel === "development") return false;
  const direction = compareVersions(current.hubVersion, stable.version);
  return direction < 0 || (direction === 0 && current.releaseId !== stable.releaseId);
}

function errorResult(kind: UpdateCheckResult["kind"], currentRelease: ReleaseInfo, error: unknown): UpdateCheckResult {
  const message = error instanceof Error ? error.message : "Unknown stable release lookup error";
  const errors: UpdateCheckError[] = [{
    code: "stable_release_unavailable",
    message,
    retryable: true,
  }];
  return {
    kind,
    currentRelease,
    stableRelease: null,
    updateAvailable: false,
    buildDiagnostics: getBuildDiagnostics(),
    errors,
  };
}

export async function checkForUpdate(
  env: Env,
  options: { forceRefresh?: boolean } = {},
): Promise<UpdateCheckResult> {
  const kind: UpdateCheckResult["kind"] = env.TILLER_INSTALLER_SCHEMA?.trim()
    ? "installer-managed"
    : "unmanaged";
  let currentRelease: ReleaseInfo;
  try {
    currentRelease = currentReleaseInfoForEnvironment(getCurrentReleaseInfo(), env.TILLER_RELEASE_ID);
  } catch (error) {
    const diagnostics = getBuildDiagnostics();
    currentRelease = {
      schemaVersion: 1,
      channel: diagnostics.channel,
      hubVersion: diagnostics.version,
    };
    return {
      kind,
      currentRelease,
      stableRelease: null,
      updateAvailable: false,
      buildDiagnostics: diagnostics,
      errors: [{
        code: "release_info_invalid",
        message: error instanceof Error ? error.message : "Current release info is invalid.",
        retryable: false,
      }],
    };
  }
  try {
    const stableRelease = await readInstallerStableRelease(env, options.forceRefresh === true);
    return {
      kind,
      currentRelease,
      stableRelease,
      updateAvailable: isUpdateAvailable(currentRelease, stableRelease),
      buildDiagnostics: getBuildDiagnostics(),
      errors: [],
    };
  } catch (error) {
    return errorResult(kind, currentRelease, error);
  }
}

export async function clearUpdateCheckCache(env: Env): Promise<void> {
  await env.ENVS_KV.delete(INSTALLER_STABLE_CACHE_KEY);
}
