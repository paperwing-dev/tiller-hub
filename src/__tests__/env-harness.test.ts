import { describe, expect, it } from "vitest";
import { getEnvAuthBadge, getEnvModelBadge, getEnvModelLabel, getHarnessBadgeClass, getHarnessBadgeLabel, getLeadHarnessBadge } from "../env-harness";

describe("getEnvAuthBadge", () => {
  it("keeps Codex auth neutral until the current mode is known", () => {
    expect(
      getEnvAuthBadge({
        harness: "codex",
      }),
    ).toBeNull();
  });

  it("returns the recorded auth badge for Codex envs", () => {
    expect(
      getEnvAuthBadge({
        harness: "codex",
        codexAuthMode: "subscription",
      }),
    ).toMatchObject({
      label: "Subscription",
    });

    expect(
      getEnvAuthBadge({
        harness: "codex",
        codexAuthMode: "api-key",
      }),
    ).toMatchObject({
      label: "API key",
    });
  });

  it("does not add an extra auth badge for OpenCode envs", () => {
    expect(
      getEnvAuthBadge({
        harness: "opencode",
      }),
    ).toBeNull();
  });

  it("uses generic API key wording for Claude API auth", () => {
    expect(
      getEnvAuthBadge({
        harness: "claude-code",
        resolvedAuthMode: "api",
      }),
    ).toMatchObject({
      label: "API key",
    });
  });
});

describe("getEnvModelBadge", () => {
  it("uses committed harness settings for the current model badge", () => {
    expect(
      getEnvModelBadge({
        harness: "opencode",
        harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
      }),
    ).toMatchObject({ label: "Kimi K2.7 Code" });
  });

  it("does not infer current model state from legacy metadata", () => {
    expect(getEnvModelBadge({ harness: "opencode", harnessSettings: null })).toBeNull();
  });

  it("shares the committed model label projection with non-badge displays", () => {
    expect(getEnvModelLabel({
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    })).toBe("GPT-5.6 Sol");
  });
});

describe("getLeadHarnessBadge", () => {
  it("does not add harness failure badges", () => {
    expect(getLeadHarnessBadge({ leadHarnessStatus: "failed" })).toBeNull();
  });
});

describe("getHarnessBadgeLabel", () => {
  it("uses the allowed harness badge labels", () => {
    expect(getHarnessBadgeLabel("codex")).toBe("Codex");
    expect(getHarnessBadgeLabel("claude-code")).toBe("Claude Code");
    expect(getHarnessBadgeLabel("opencode")).toBe("Open Code");
  });
});

describe("getHarnessBadgeClass", () => {
  it("assigns the OpenCode teal badge class", () => {
    expect(getHarnessBadgeClass("opencode")).toContain("teal");
  });
});
