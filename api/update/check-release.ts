import type { Env } from "../types";
import { readHubUpdateRepoState, resolveHubUpdateRepoState } from "./hub-repo";
import {
  fetchPublicUpdateMetadata,
  getBuildDiagnostics,
  getCurrentUpdateMetadata,
  UPDATE_CACHE_TTL_SECONDS,
  UPDATE_CHECK_CACHE_KEY,
} from "./metadata";
import type { HubUpdateRepoState, TillerUpdateMetadata, UpdateCheckResult } from "./types";

function normalizeVersionTag(tagName: string): string {
  return tagName.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
}

function toNumericParts(version: string): number[] {
  const normalized = normalizeVersionTag(version).split("-")[0] ?? "";
  return normalized.split(".").map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
}

export function compareVersions(left: string, right: string): number {
  const leftParts = toNumericParts(left);
  const rightParts = toNumericParts(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue !== rightValue) {
      return leftValue < rightValue ? -1 : 1;
    }
  }

  return 0;
}

function isHubRepoConfigured(state: HubUpdateRepoState): boolean {
  return state.status === "detected";
}

function updateMethodForState(hubRepo: HubUpdateRepoState): UpdateCheckResult["updateMethod"] {
  if (isHubRepoConfigured(hubRepo)) return "github_repo";
  return "connect_hub_repo";
}

function issueForState(
  updateAvailable: boolean,
  hubRepo: HubUpdateRepoState,
): UpdateCheckResult["issue"] {
  if (!updateAvailable || hubRepo.status === "detected") return undefined;
  if (hubRepo.status === "ambiguous") {
    return {
      code: "hub_repo_ambiguous",
      message: "Multiple selected GitHub repositories look like Tiller deploy-button hubs. Choose the self-update repo before updating.",
    };
  }
  return {
    code: "hub_repo_not_configured",
    message: "Connect the generated deploy-button GitHub repository before updating normally.",
  };
}

function buildUpdateCheckResult(
  currentUpdate: TillerUpdateMetadata,
  latestUpdate: TillerUpdateMetadata,
  hubRepo: HubUpdateRepoState,
): UpdateCheckResult {
  const updateAvailable = currentUpdate.sourceId !== latestUpdate.sourceId;
  return {
    updateAvailable,
    currentUpdate,
    latestUpdate,
    buildDiagnostics: getBuildDiagnostics(),
    hubRepo,
    updateMethod: updateMethodForState(hubRepo),
    ...(issueForState(updateAvailable, hubRepo) ? { issue: issueForState(updateAvailable, hubRepo) } : {}),
    releaseNotesUrl: `https://github.com/${latestUpdate.sourceRepo}`,
  };
}

function isCacheableUpdateResult(value: unknown, currentUpdate: TillerUpdateMetadata): value is UpdateCheckResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<UpdateCheckResult>;
  return typeof result.updateAvailable === "boolean" &&
    result.currentUpdate?.sourceId === currentUpdate.sourceId &&
    typeof result.currentUpdate.version === "string" &&
    typeof result.latestUpdate?.sourceId === "string" &&
    typeof result.latestUpdate.version === "string" &&
    typeof result.releaseNotesUrl === "string";
}

export async function checkForUpdate(env: Env): Promise<UpdateCheckResult> {
  try {
    const currentUpdate = getCurrentUpdateMetadata();
    const hubRepo = await resolveHubUpdateRepoState(env, { autoDetect: true });
    const cached = await env.ENVS_KV.get(UPDATE_CHECK_CACHE_KEY, "json");
    if (isCacheableUpdateResult(cached, currentUpdate)) {
      const currentIssue = issueForState(cached.updateAvailable, hubRepo);
      const { issue: _cachedIssue, hubRepo: _cachedHubRepo, updateMethod: _cachedUpdateMethod, ...cachedResult } = cached;
      return {
        ...cachedResult,
        hubRepo,
        updateMethod: updateMethodForState(hubRepo),
        ...(currentIssue ? { issue: currentIssue } : {}),
      };
    }

    const latestUpdate = await fetchPublicUpdateMetadata();
    const result = buildUpdateCheckResult(currentUpdate, latestUpdate, hubRepo);

    await env.ENVS_KV.put(
      UPDATE_CHECK_CACHE_KEY,
      JSON.stringify(result),
      { expirationTtl: UPDATE_CACHE_TTL_SECONDS },
    );

    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    const currentUpdate = getCurrentUpdateMetadata();
    const latestUpdate = currentUpdate;
    const hubRepo = await readHubUpdateRepoState(env).catch((): HubUpdateRepoState => ({
      status: "not_checked",
      lastDetectedAt: null,
    }));
    return {
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
