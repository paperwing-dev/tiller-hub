import { describe, expect, it } from "vitest";
import { describeUpdateButtonState } from "../UpdateBadge";
import type {
  InstallerMaintenanceUpdateCheckResult,
  LegacyUpdateCheckResult,
  TillerUpdateMetadata,
} from "../api";

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

function updateStatus(overrides: Partial<LegacyUpdateCheckResult> = {}): LegacyUpdateCheckResult {
  const currentUpdate = updateMarker("current-source", "0.1.0");
  const latestUpdate = updateMarker("latest-source", "0.2.0");
  return {
    kind: "legacy",
    updateAvailable: true,
    currentUpdate,
    latestUpdate,
    buildDiagnostics: {
      channel: "release",
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

function installerUpdateStatus(
  overrides: Partial<InstallerMaintenanceUpdateCheckResult> = {},
): InstallerMaintenanceUpdateCheckResult {
  const currentUpdate = updateMarker("current-source", "0.1.0");
  return {
    kind: "installer-maintenance",
    updateAvailable: true,
    installedReleaseId: "a".repeat(40),
    stableRelease: {
      releaseId: "b".repeat(40),
      version: "0.2.0",
      releaseNotesUrl: "https://example.com/release",
    },
    currentUpdate,
    buildDiagnostics: {
      channel: "release",
      version: "0.1.0",
      workersCiCommitSha: null,
      workersCiBranch: null,
    },
    ...overrides,
  };
}

describe("describeUpdateButtonState", () => {
  it("disables the button when the self-update check fails", () => {
    expect(describeUpdateButtonState({
      status: null,
      issue: "Latest tiller-hub release is not accessible.",
      dismissed: false,
      isChecking: false,
    })).toEqual({
      title: "Update unavailable: Latest tiller-hub release is not accessible.",
      tooltip: "Update unavailable: Latest tiller-hub release is not accessible.",
      enabled: false,
      label: "Update",
    });
  });

  it("enables the button when a release update is available", () => {
    expect(describeUpdateButtonState({
      status: updateStatus(),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      title: "Update available: v0.1.0 -> v0.2.0",
      tooltip: "Update available",
      enabled: true,
      label: "Update",
    });
  });

  it("disables the button when no update is visible", () => {
    expect(describeUpdateButtonState({
      status: updateStatus({ updateAvailable: false }),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      title: "No update available",
      tooltip: "No update available",
      enabled: false,
      label: "Update",
    });

    expect(describeUpdateButtonState({
      status: updateStatus(),
      issue: null,
      dismissed: true,
      isChecking: false,
    })).toEqual({
      title: "Update dismissed",
      tooltip: "Update dismissed",
      enabled: false,
      label: "Update",
    });
  });

  it("disables the button while checking and for development builds", () => {
    expect(describeUpdateButtonState({
      status: updateStatus(),
      issue: null,
      dismissed: false,
      isChecking: true,
    })).toEqual({
      title: "Checking for updates",
      tooltip: "Checking for updates",
      enabled: false,
      label: "Update",
    });

    expect(describeUpdateButtonState({
      status: updateStatus({
        buildDiagnostics: {
          channel: "development",
          version: "0.1.0",
          workersCiCommitSha: null,
          workersCiBranch: null,
        },
      }),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      title: "Development build",
      tooltip: "Development build",
      enabled: false,
      label: "Update",
    });
  });

  it("uses installer maintenance labels for updates and renewal", () => {
    expect(describeUpdateButtonState({
      status: installerUpdateStatus(),
      issue: null,
      dismissed: false,
      isChecking: false,
      renewalRecommended: false,
    })).toEqual({
      title: "Update to v0.2.0",
      tooltip: "Update to v0.2.0",
      enabled: true,
      label: "Update to v0.2.0",
    });

    expect(describeUpdateButtonState({
      status: installerUpdateStatus({ updateAvailable: false }),
      issue: null,
      dismissed: true,
      isChecking: false,
      renewalRecommended: true,
    })).toEqual({
      title: "Renew Access",
      tooltip: "Renew Access",
      enabled: true,
      label: "Renew Access",
    });

    expect(describeUpdateButtonState({
      status: installerUpdateStatus(),
      issue: null,
      dismissed: false,
      isChecking: false,
      renewalRecommended: true,
    }).label).toBe("Renew and update to v0.2.0");
  });
});
