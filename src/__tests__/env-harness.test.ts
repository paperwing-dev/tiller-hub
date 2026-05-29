import { describe, expect, it } from "vitest";
import { getEnvAuthBadge, getEnvModelBadge, getHarnessBadgeClass, getHarnessBadgeLabel, getLeadHarnessBadge } from "../env-harness";

describe("getEnvAuthBadge", () => {
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
        opencodeProvider: "cloudflare-workers-ai",
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
  it("does not add model-specific badges", () => {
    expect(
      getEnvModelBadge({
        harness: "opencode",
        opencodeModel: "@cf/moonshotai/kimi-k2.5",
      }),
    ).toBeNull();
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
