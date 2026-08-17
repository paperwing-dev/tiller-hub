import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UpdateCheckResult } from "../api";
import UpdateButton, { describeUpdateButtonState } from "../UpdateBadge";

const releaseId = "a".repeat(40);
const stableId = "b".repeat(40);

function status(overrides: Partial<UpdateCheckResult> = {}): UpdateCheckResult {
  return {
    kind: "installer-managed",
    currentRelease: {
      schemaVersion: 1,
      channel: "release",
      hubVersion: "0.2.54",
      releaseId,
    },
    stableRelease: {
      releaseId: stableId,
      version: "0.2.55",
      releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v0.2.55",
    },
    updateAvailable: true,
    buildDiagnostics: { channel: "release", version: "0.2.54", workersCiCommitSha: null, workersCiBranch: null },
    errors: [],
    ...overrides,
  };
}

describe("update button state", () => {
  it("opens installer maintenance for managed updates", () => {
    expect(describeUpdateButtonState({ status: status(), issue: null, dismissed: false, isChecking: false }))
      .toEqual({ description: "Update to v0.2.55", enabled: true, highlighted: true });
  });

  it("opens clean-reinstall guidance for unmanaged installations", () => {
    const unmanaged = status({ kind: "unmanaged", updateAvailable: false });
    expect(describeUpdateButtonState({ status: unmanaged, issue: null, dismissed: false, isChecking: false }))
      .toEqual({ description: "Unmanaged installation\nCurrent version: v0.2.54", enabled: true, highlighted: true });
  });

  it("keeps current and development releases quiet but openable", () => {
    expect(describeUpdateButtonState({
      status: status({ updateAvailable: false }), issue: null, dismissed: false, isChecking: false,
    })).toEqual({
      description: "No update available\nCurrent version: v0.2.54",
      enabled: true,
      highlighted: false,
    });
    expect(describeUpdateButtonState({
      status: status({ currentRelease: { ...status().currentRelease, channel: "development" } }),
      issue: null,
      dismissed: false,
      isChecking: false,
    })).toEqual({ description: "Development build", enabled: true, highlighted: false });
  });

  it("exposes the highlighted update state to theme-aware styling", () => {
    const highlighted = renderToStaticMarkup(createElement(UpdateButton, {
      status: status(),
      issue: null,
      dismissed: false,
      isChecking: false,
      onOpen: () => undefined,
    }));
    const quiet = renderToStaticMarkup(createElement(UpdateButton, {
      status: status({ updateAvailable: false }),
      issue: null,
      dismissed: false,
      isChecking: false,
      onOpen: () => undefined,
    }));

    expect(highlighted).toContain('class="tiller-update-button');
    expect(highlighted).toContain('data-highlighted="true"');
    expect(quiet).toContain('data-highlighted="false"');
  });
});
