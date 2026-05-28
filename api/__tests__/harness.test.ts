import { describe, expect, it } from "vitest";
import { resolveEnabledHarnesses } from "../env/harness";
import { isEnvHarness } from "../types";

describe("isEnvHarness", () => {
  it("accepts only supported harness ids", () => {
    expect(isEnvHarness("claude-code")).toBe(true);
    expect(isEnvHarness("codex")).toBe(true);
    expect(isEnvHarness("opencode")).toBe(true);
    expect(isEnvHarness("unknown")).toBe(false);
    expect(isEnvHarness(undefined)).toBe(false);
  });
});

describe("resolveEnabledHarnesses", () => {
  it("defaults to the standard harness set when no explicit enablement is configured", () => {
    expect(resolveEnabledHarnesses({ ENABLED_ENV_HARNESSES: undefined })).toEqual([
      "claude-code",
      "codex",
      "opencode",
    ]);
  });

  it("filters invalid values and deduplicates", () => {
    expect(resolveEnabledHarnesses({ ENABLED_ENV_HARNESSES: "codex,claude-code,opencode,codex,unknown" })).toEqual([
      "codex",
      "claude-code",
      "opencode",
    ]);
  });
});
