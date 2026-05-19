import { describe, expect, it } from "vitest";
import { describeUpdateBadgeState } from "../UpdateBadge";

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
      status: {
        updateAvailable: true,
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        releaseNotesUrl: "https://example.com/release",
      },
      issue: null,
      dismissed: false,
    })).toEqual({
      title: "Update available: 0.1.0 -> 0.2.0",
      accentClassName: "text-[#57606a] hover:text-[#24292f]",
      icon: "↑",
    });
  });

  it("returns null when there is no issue and no visible update", () => {
    expect(describeUpdateBadgeState({
      status: {
        updateAvailable: false,
        currentVersion: "0.2.0",
        latestVersion: "0.2.0",
        releaseNotesUrl: "https://example.com/release",
      },
      issue: null,
      dismissed: false,
    })).toBeNull();

    expect(describeUpdateBadgeState({
      status: {
        updateAvailable: true,
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        releaseNotesUrl: "https://example.com/release",
      },
      issue: null,
      dismissed: true,
    })).toBeNull();
  });
});
