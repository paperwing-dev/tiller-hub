import { describe, expect, it } from "vitest";
import { REVIEWER_AGENT_SPEC } from "../specs";

describe("REVIEWER_AGENT_SPEC", () => {
  it("retains the reviewer prompt limits", () => {
    expect(REVIEWER_AGENT_SPEC.baseInstructions).toContain("read-only access");
    expect(REVIEWER_AGENT_SPEC.maxSteps).toBe(8);
    expect(REVIEWER_AGENT_SPEC.maxContextChars).toBe(16_000);
  });
});
