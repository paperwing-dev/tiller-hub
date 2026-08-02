import { describe, expect, it } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import UpdateButton, { describeUpdateButtonState } from "../UpdateBadge";
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
  it("keeps one fixed button label and does not add a native tooltip", () => {
    const html = renderToStaticMarkup(React.createElement(UpdateButton, {
      status: installerUpdateStatus(),
      issue: null,
      dismissed: false,
      isChecking: false,
      onOpen: () => undefined,
    }));

    expect(html).toContain(">Update</button>");
    expect(html).toContain('aria-label="Update to v0.2.0"');
    expect(html).not.toContain("title=");
  });

  it("disables the button when the self-update check fails", () => {
    expect(describeUpdateButtonState({
      status: null,
      issue: "Latest tiller-hub release is not accessible.",
      dismissed: false,
      isChecking: false,
    })).toEqual({
      description: "Update unavailable: Latest tiller-hub release is not accessible.",
      enabled: false,
    });
  });

  it("enables the button when a release update is available", () => {
    expect(describeUpdateButtonState({
      status: updateStatus(),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      description: "Update available: v0.1.0 -> v0.2.0",
      enabled: true,
    });
  });

  it("disables the button when no update is visible", () => {
    expect(describeUpdateButtonState({
      status: updateStatus({ updateAvailable: false }),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      description: "No update available\nCurrent version: v0.1.0",
      enabled: false,
    });

    expect(describeUpdateButtonState({
      status: updateStatus(),
      issue: null,
      dismissed: true,
      isChecking: false,
    })).toEqual({
      description: "Update dismissed",
      enabled: false,
    });
  });

  it("disables the button while checking and for development builds", () => {
    expect(describeUpdateButtonState({
      status: updateStatus(),
      issue: null,
      dismissed: false,
      isChecking: true,
    })).toEqual({
      description: "Checking for updates",
      enabled: false,
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
      description: "Development build",
      enabled: false,
    });
  });

  it("keeps installer maintenance state version-only", () => {
    expect(describeUpdateButtonState({
      status: installerUpdateStatus(),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      description: "Update to v0.2.0",
      enabled: true,
    });

    expect(describeUpdateButtonState({
      status: installerUpdateStatus({ updateAvailable: false }),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({
      description: "No update available\nCurrent version: v0.1.0",
      enabled: false,
    });

    expect(describeUpdateButtonState({
      status: installerUpdateStatus(),
      issue: null,
      dismissed: true,
      isChecking: false,
    })).toEqual({
      description: "Update dismissed",
      enabled: false,
    });
  });
});
