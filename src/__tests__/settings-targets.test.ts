/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from "vitest";
import {
  focusSettingsTarget,
  parseSettingsTargetHash,
  SETTINGS_TARGET_IDS,
  settingsTargetHref,
} from "../settings-targets";

describe("settings targets", () => {
  it("parses only known exact settings hashes", () => {
    expect(parseSettingsTargetHash("#openai-api-key")).toBe(
      SETTINGS_TARGET_IDS.openaiApiKey,
    );
    expect(parseSettingsTargetHash("#openai%2Dapi%2Dkey")).toBe(
      SETTINGS_TARGET_IDS.openaiApiKey,
    );
    expect(parseSettingsTargetHash("#unknown")).toBeNull();
    expect(parseSettingsTargetHash("#%zz")).toBeNull();
    expect(parseSettingsTargetHash("")).toBeNull();
  });

  it("builds a shareable exact settings URL", () => {
    expect(
      settingsTargetHref(
        "/projects/repo-1/global-settings",
        SETTINGS_TARGET_IDS.codexSubscription,
      ),
    ).toBe("/projects/repo-1/global-settings#codex-subscription");
  });

  it("scrolls and focuses the exact target", () => {
    const element = document.createElement("div");
    element.id = SETTINGS_TARGET_IDS.openaiBilling;
    element.tabIndex = -1;
    element.scrollIntoView = vi.fn();
    document.body.appendChild(element);

    expect(focusSettingsTarget(SETTINGS_TARGET_IDS.openaiBilling)).toBe(
      element,
    );
    expect(element.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(element);

    element.remove();
  });
});
