import { rpcError } from "../errors";
import type { Env } from "../types";
import type { GitHubRelease, UpdateCheckResult, UpdateRelease } from "./types";

const UPDATE_CHECK_CACHE_KEY = "tiller:update-check";
const UPDATE_CACHE_TTL_SECONDS = 86_400;
const LATEST_RELEASE_URL = "https://api.github.com/repos/paperwing-dev/tiller-hub/releases/latest";

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

function isRpcEncodedError(error: unknown): error is Error {
  return error instanceof Error && /^\[\d{3}\] /.test(error.message);
}

function describeReleaseLookupFailure(status: number): string {
  if (status === 404) {
    return "Latest tiller-hub release is not accessible. The paperwing-dev/tiller-hub repo may be private or may not have a published release yet.";
  }
  if (status === 401 || status === 403) {
    return `Latest tiller-hub release lookup is not authorized by GitHub (${status}).`;
  }
  return `GitHub release lookup failed: ${status}`;
}

export async function fetchLatestTillerRelease(): Promise<UpdateRelease> {
  const response = await fetch(LATEST_RELEASE_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tiller-hub",
    },
  });
  if (!response.ok) {
    throw rpcError("ServiceUnavailable", describeReleaseLookupFailure(response.status));
  }

  const release = await response.json<GitHubRelease>();
  const tagName = release.tag_name?.trim() ?? "";
  const version = normalizeVersionTag(tagName);
  if (!tagName || !version) {
    throw new Error("GitHub latest release is missing a valid tag name");
  }

  return {
    tagName,
    version,
    releaseNotesUrl: release.html_url,
    assets: Array.isArray(release.assets) ? release.assets : [],
  };
}

export async function checkForUpdate(env: Env): Promise<UpdateCheckResult> {
  try {
    const cached = await env.ENVS_KV.get(UPDATE_CHECK_CACHE_KEY, "json");
    if (cached && typeof cached === "object") {
      const result = cached as Partial<UpdateCheckResult>;
      if (
        typeof result.updateAvailable === "boolean" &&
        typeof result.currentVersion === "string" &&
        typeof result.latestVersion === "string" &&
        typeof result.releaseNotesUrl === "string" &&
        result.currentVersion === __TILLER_VERSION__
      ) {
        return result as UpdateCheckResult;
      }
    }

    const release = await fetchLatestTillerRelease();
    const result: UpdateCheckResult = {
      updateAvailable: compareVersions(__TILLER_VERSION__, release.version) < 0,
      currentVersion: __TILLER_VERSION__,
      latestVersion: release.version,
      releaseNotesUrl: release.releaseNotesUrl,
    };

    await env.ENVS_KV.put(
      UPDATE_CHECK_CACHE_KEY,
      JSON.stringify(result),
      { expirationTtl: UPDATE_CACHE_TTL_SECONDS },
    );

    return result;
  } catch (error) {
    if (isRpcEncodedError(error)) {
      throw error;
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    throw rpcError("ServiceUnavailable", `Self-update check failed: ${message}`);
  }
}

export async function clearUpdateCheckCache(env: Env): Promise<void> {
  await env.ENVS_KV.delete(UPDATE_CHECK_CACHE_KEY);
}
