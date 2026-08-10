import type { Env } from "../types";
import { readHubUpdateRepoState, resolveHubUpdateRepoState } from "./hub-repo";
import {
  fetchLatestReleaseUpdateMetadata,
  getBuildChannel,
  getBuildDiagnostics,
  getCurrentUpdateMetadata,
  UPDATE_CACHE_TTL_SECONDS,
  UPDATE_CHECK_CACHE_KEY,
} from "./metadata";
import type {
  HubUpdateRepoState,
  LegacyUpdateCheckResult,
  StableReleaseSummary,
  TillerUpdateMetadata,
  UpdateCheckResult,
  UpdateIssue,
} from "./types";

export const INSTALLER_STABLE_URL = "https://install.paperwing.dev/stable";
export const INSTALLER_STABLE_CACHE_KEY = "tiller:installer-stable:v1";
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
    const parsedUrl = new URL(releaseNotesUrl);
    if (parsedUrl.protocol !== "https:" || parsedUrl.href !== releaseNotesUrl) return null;
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
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Installer stable release lookup failed: HTTP ${response.status}`);
    }
    const summary = parseStableReleaseSummary(await response.json());
    if (!summary) throw new Error("Installer stable release summary is invalid.");
    return summary;
  } finally {
    clearTimeout(timeout);
  }
}

async function readInstallerStableRelease(
  env: Env,
  installedReleaseId: string,
): Promise<StableReleaseSummary> {
  const cacheKey = `${INSTALLER_STABLE_CACHE_KEY}:${installedReleaseId}`;
  let summary: StableReleaseSummary;
  try {
    summary = await fetchInstallerStableRelease();
  } catch (error) {
    const cached = parseStableReleaseSummary(
      await env.ENVS_KV.get(cacheKey, "json"),
    );
    if (cached) return cached;
    throw error;
  }

  await env.ENVS_KV.put(
    cacheKey,
    JSON.stringify(summary),
    { expirationTtl: UPDATE_CACHE_TTL_SECONDS },
  );
  return summary;
}

function normalizeVersionTag(tagName: string): string {
  return tagName.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
}

function parseVersion(version: string): ParsedVersion | null {
  const match = SEMVER_PATTERN.exec(normalizeVersionTag(version));
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    return null;
  }
  return {
    core: [match[1]!, match[2]!, match[3]!],
    prerelease,
  };
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left);
  const rightVersion = parseVersion(right);
  if (!leftVersion || !rightVersion) {
    throw new Error(`Cannot compare invalid release versions: ${left} and ${right}.`);
  }

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
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return compareNumericIdentifiers(leftPart, rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function isHubRepoConfigured(state: HubUpdateRepoState): boolean {
  return state.status === "detected";
}

function updateMethodForState(hubRepo: HubUpdateRepoState): LegacyUpdateCheckResult["updateMethod"] {
  if (isHubRepoConfigured(hubRepo)) return "github_repo";
  return "connect_hub_repo";
}

function issueForState(
  updateAvailable: boolean,
  hubRepo: HubUpdateRepoState,
): UpdateIssue | undefined {
  if (!updateAvailable || hubRepo.status === "detected") return undefined;
  if (hubRepo.status === "ambiguous") {
    return {
      code: "hub_repo_ambiguous",
      message: "Multiple selected GitHub repositories look like Tiller deploy-button hubs. Choose the self-update repo before updating.",
    };
  }
  return {
    code: "hub_repo_not_configured",
    message: "No GitHub self-update repository is connected. Use Cloudflare update with a temporary API token, or install the Tiller GitHub App on the generated deploy-button repo if one exists.",
  };
}

function buildUpdateCheckResult(
  currentUpdate: TillerUpdateMetadata,
  latestUpdate: TillerUpdateMetadata,
  hubRepo: HubUpdateRepoState,
  releaseNotesUrl: string,
): LegacyUpdateCheckResult {
  const updateAvailable = currentUpdate.sourceId !== latestUpdate.sourceId;
  return {
    kind: "legacy",
    updateAvailable,
    currentUpdate,
    latestUpdate,
    buildDiagnostics: getBuildDiagnostics(),
    hubRepo,
    updateMethod: updateMethodForState(hubRepo),
    ...(issueForState(updateAvailable, hubRepo) ? { issue: issueForState(updateAvailable, hubRepo) } : {}),
    releaseNotesUrl,
  };
}

function isCacheableUpdateResult(value: unknown, currentUpdate: TillerUpdateMetadata): value is LegacyUpdateCheckResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<LegacyUpdateCheckResult>;
  return result.kind === "legacy" &&
    typeof result.updateAvailable === "boolean" &&
    result.currentUpdate?.sourceId === currentUpdate.sourceId &&
    result.buildDiagnostics?.channel === getBuildChannel() &&
    typeof result.currentUpdate.version === "string" &&
    typeof result.latestUpdate?.sourceId === "string" &&
    typeof result.latestUpdate.version === "string" &&
    typeof result.releaseNotesUrl === "string";
}

export async function checkForUpdate(env: Env): Promise<UpdateCheckResult> {
  try {
    const currentUpdate = getCurrentUpdateMetadata();
    if (env.TILLER_INSTALLER_SCHEMA?.trim()) {
      const installedReleaseId = env.TILLER_RELEASE_ID?.trim() || currentUpdate.sourceId;
      const stableRelease = await readInstallerStableRelease(env, installedReleaseId);
      const versionDirection = compareVersions(currentUpdate.version, stableRelease.version);
      return {
        kind: "installer-maintenance",
        updateAvailable: versionDirection < 0 ||
          (versionDirection === 0 && installedReleaseId !== stableRelease.releaseId),
        installedReleaseId,
        stableRelease,
        currentUpdate,
        buildDiagnostics: getBuildDiagnostics(),
      };
    }

    if (getBuildChannel() === "development") {
      return {
        kind: "legacy",
        updateAvailable: false,
        currentUpdate,
        latestUpdate: currentUpdate,
        buildDiagnostics: getBuildDiagnostics(),
        hubRepo: { status: "not_checked", lastDetectedAt: null },
        updateMethod: "advanced_repair",
        releaseNotesUrl: `https://github.com/${currentUpdate.sourceRepo}`,
      };
    }

    const hubRepo = await resolveHubUpdateRepoState(env, { autoDetect: true });
    const cached = await env.ENVS_KV.get(UPDATE_CHECK_CACHE_KEY, "json");
    if (isCacheableUpdateResult(cached, currentUpdate)) {
      const updateAvailable = currentUpdate.sourceId !== cached.latestUpdate.sourceId;
      const currentIssue = issueForState(updateAvailable, hubRepo);
      const { issue: _cachedIssue, hubRepo: _cachedHubRepo, updateMethod: _cachedUpdateMethod, ...cachedResult } = cached;
      return {
        ...cachedResult,
        updateAvailable,
        currentUpdate,
        buildDiagnostics: getBuildDiagnostics(),
        hubRepo,
        updateMethod: updateMethodForState(hubRepo),
        ...(currentIssue ? { issue: currentIssue } : {}),
      };
    }

    const buildDiagnostics = getBuildDiagnostics();
    const latestRelease = await fetchLatestReleaseUpdateMetadata({
      currentVersion: buildDiagnostics.version || currentUpdate.version,
      channel: buildDiagnostics.channel,
      updateServiceDisabled: env.TILLER_UPDATE_SERVICE_DISABLED,
    });
    const result = buildUpdateCheckResult(
      currentUpdate,
      latestRelease.update,
      hubRepo,
      latestRelease.releaseNotesUrl,
    );

    await env.ENVS_KV.put(
      UPDATE_CHECK_CACHE_KEY,
      JSON.stringify(result),
      { expirationTtl: UPDATE_CACHE_TTL_SECONDS },
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const currentUpdate = getCurrentUpdateMetadata();
    const installerManaged = Boolean(env.TILLER_INSTALLER_SCHEMA?.trim());
    if (installerManaged) {
      return {
        kind: "installer-maintenance",
        updateAvailable: false,
        installedReleaseId: env.TILLER_RELEASE_ID?.trim() || currentUpdate.sourceId,
        stableRelease: null,
        currentUpdate,
        buildDiagnostics: getBuildDiagnostics(),
        issue: {
          code: "update_check_failed",
          message: `Self-update check failed: ${message}`,
        },
      };
    }
    const latestUpdate = currentUpdate;
    const hubRepo = await readHubUpdateRepoState(env).catch((): HubUpdateRepoState => ({
      status: "not_checked",
      lastDetectedAt: null,
    }));
    return {
      kind: "legacy",
      updateAvailable: false,
      currentUpdate,
      latestUpdate,
      buildDiagnostics: getBuildDiagnostics(),
      hubRepo,
      updateMethod: "advanced_repair",
      issue: {
        code: "update_check_failed",
        message: `Self-update check failed: ${message}`,
      },
      releaseNotesUrl: `https://github.com/${currentUpdate.sourceRepo}`,
    };
  }
}

export async function clearUpdateCheckCache(env: Env): Promise<void> {
  await env.ENVS_KV.delete(UPDATE_CHECK_CACHE_KEY);
}
