import { describe, expect, it } from "vitest";
import { getHarnessRequirementSettingsLink } from "../HarnessSettingsFields";
import { SETTINGS_TARGET_IDS } from "../settings-targets";

describe("harness requirement settings links", () => {
  it("targets billing selectors before missing credentials", () => {
    expect(
      getHarnessRequirementSettingsLink("openai-api-key", {
        openaiBillingMode: "subscription",
      })?.target,
    ).toBe(SETTINGS_TARGET_IDS.openaiBilling);
    expect(
      getHarnessRequirementSettingsLink("anthropic-api-key", {
        claudeBillingMode: "subscription",
      })?.target,
    ).toBe(SETTINGS_TARGET_IDS.claudeBilling);
  });

  it("targets the exact active credential or subscription row", () => {
    expect(
      getHarnessRequirementSettingsLink("openai-api-key", {
        openaiBillingMode: "api",
      })?.target,
    ).toBe(SETTINGS_TARGET_IDS.openaiApiKey);
    expect(
      getHarnessRequirementSettingsLink("claude-auth", {
        claudeBillingMode: "subscription",
      })?.target,
    ).toBe(SETTINGS_TARGET_IDS.claudeSubscription);
    expect(
      getHarnessRequirementSettingsLink("codex-auth", {
        openaiBillingMode: "subscription",
        openaiSubscriptionReady: true,
      })?.target,
    ).toBe(SETTINGS_TARGET_IDS.codexSubscription);
  });

  it("targets execution settings when the selected subscription route is unavailable", () => {
    expect(
      getHarnessRequirementSettingsLink("codex-auth", {
        openaiBillingMode: "subscription",
        openaiSubscriptionReady: false,
      })?.target,
    ).toBe(SETTINGS_TARGET_IDS.executionBackend);
  });
});
