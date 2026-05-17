import { rpcError } from "../errors";
import type { GitHubRelease, UpdateRelease } from "./types";

const LATEST_RELEASE_URL = "https://api.github.com/repos/paperwing-dev/tiller-hub/releases/latest";

function normalizeVersionTag(tagName: string): string {
  return tagName.trim().replace(/^tiller-hub-v/i, "").replace(/^v/i, "");
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
