import { describe, expect, it } from "vitest";
import { getEnvAuthBadge, getEnvModelBadge, getHarnessBadgeClass } from "../env-harness";

describe("getEnvAuthBadge", () => {
  it("returns the recorded auth badge for Codex envs", () => {
    expect(
      getEnvAuthBadge({
        harness: "codex",
        codexAuthMode: "chatgpt",
      }),
    ).toMatchObject({
      label: "ChatGPT",
    });

    expect(
      getEnvAuthBadge({
        harness: "codex",
        codexAuthMode: "openai-api",
      }),
    ).toMatchObject({
      label: "OpenAI API key",
    });
  });

  it("returns Workers AI for OpenCode envs", () => {
    expect(
      getEnvAuthBadge({
        harness: "opencode",
        opencodeProvider: "cloudflare-workers-ai",
      }),
    ).toMatchObject({
      label: "Workers AI",
    });
  });
});

describe("getEnvModelBadge", () => {
  it("returns the Kimi model badge for OpenCode envs", () => {
    expect(
      getEnvModelBadge({
        harness: "opencode",
        opencodeModel: "@cf/moonshotai/kimi-k2.5",
      }),
    ).toMatchObject({
      label: "Kimi K2.5",
    });
  });
});

describe("getHarnessBadgeClass", () => {
  it("assigns the OpenCode teal badge class", () => {
    expect(getHarnessBadgeClass("opencode")).toContain("teal");
  });
});
