import { describe, expect, it } from "vitest";
import { describeUpdateBadgeState } from "../UpdateBadge";
import type { TillerUpdateMetadata, UpdateCheckResult } from "../api";

function updateMarker(sourceId: string, version: string): TillerUpdateMetadata {
  return {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId,
    version,
    label: `Source ${sourceId}`,
    managedFiles: ["package.json"],
  };
}

function updateStatus(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  const currentUpdate = updateMarker("current-source", "0.1.0");
  const latestUpdate = updateMarker("latest-source", "0.2.0");
  return {
    updateAvailable: true,
    currentUpdate,
    latestUpdate,
    buildDiagnostics: {
      version: "0.1.0",
      workersCiCommitSha: null,
      workersCiBranch: null,
    },
    hubRepo: { status: "not_checked", lastDetectedAt: null },
    updateMethod: "github_repo",
    releaseNotesUrl: "https://example.com/release",
    ...overrides,
  };
}

describe("describeUpdateBadgeState", () => {
  it("returns an issue badge when the self-update check fails", () => {
    expect(describeUpdateBadgeState({
      status: null,
      issue: "Latest tiller-hub release is not accessible.",
      dismissed: false,
    })).toEqual({
      title: "Self-update check unavailable: Latest tiller-hub release is not accessible.",
      accentClassName: "text-[#cf222e] hover:text-[#a40e26]",
      icon: "!",
    });
  });

  it("returns an update badge when a release is available", () => {
    expect(describeUpdateBadgeState({
      status: updateStatus(),
      issue: null,
      dismissed: false,
    })).toEqual({
      title: "Update available: v0.1.0 -> v0.2.0",
      accentClassName: "text-[#57606a] hover:text-[#24292f]",
      icon: "↑",
    });
  });

  it("returns null when there is no issue and no visible update", () => {
    expect(describeUpdateBadgeState({
      status: updateStatus({ updateAvailable: false }),
      issue: null,
      dismissed: false,
    })).toBeNull();

    expect(describeUpdateBadgeState({
      status: updateStatus(),
      issue: null,
      dismissed: true,
    })).toBeNull();
  });
});
