import { describe, expect, it } from "vitest";
import {
  MAX_PLAN_HEALTH_SUMMARY_CODE_UNITS,
  PLAN_HEALTH_TRANSPORT_INSTRUCTION,
  parsePlanHealthOutput,
  renderPlanHealthResult,
} from "../plan-health";

function output(
  level: "low" | "medium" | "high" = "low",
  size: "small" | "medium" | "large" = "small",
) {
  return {
    risk: { level, summary: "Clear risk rationale." },
    changeSize: { size, summary: "Clear change-size rationale." },
  };
}

describe("Plan Health structured output", () => {
  it.each([
    ["low", "small"],
    ["medium", "medium"],
    ["high", "large"],
  ] as const)("accepts valid %s/%s output", (level, size) => {
    const expected = output(level, size);
    expect(parsePlanHealthOutput(`  ${JSON.stringify(expected)}\n`)).toEqual(
      expected,
    );
  });

  it.each([
    ["fenced", `\`\`\`json\n${JSON.stringify(output())}\n\`\`\``],
    ["surrounding text", `Result: ${JSON.stringify(output())}`],
    ["array", JSON.stringify([output()])],
    ["missing top-level field", JSON.stringify({ risk: output().risk })],
    ["extra top-level field", JSON.stringify({ ...output(), score: 1 })],
    [
      "missing risk field",
      JSON.stringify({ ...output(), risk: { level: "low" } }),
    ],
    [
      "extra risk field",
      JSON.stringify({ ...output(), risk: { ...output().risk, score: 1 } }),
    ],
    [
      "missing changeSize field",
      JSON.stringify({ ...output(), changeSize: { size: "small" } }),
    ],
    [
      "extra changeSize field",
      JSON.stringify({
        ...output(),
        changeSize: { ...output().changeSize, files: 2 },
      }),
    ],
    [
      "invalid risk summary type",
      JSON.stringify({ ...output(), risk: { level: "low", summary: 1 } }),
    ],
    [
      "invalid changeSize summary type",
      JSON.stringify({
        ...output(),
        changeSize: { size: "small", summary: 1 },
      }),
    ],
    [
      "incorrect risk casing",
      JSON.stringify({ ...output(), risk: { ...output().risk, level: "Low" } }),
    ],
    [
      "invalid risk level",
      JSON.stringify({
        ...output(),
        risk: { ...output().risk, level: "critical" },
      }),
    ],
    [
      "incorrect changeSize casing",
      JSON.stringify({
        ...output(),
        changeSize: { ...output().changeSize, size: "Small" },
      }),
    ],
    [
      "invalid changeSize size",
      JSON.stringify({
        ...output(),
        changeSize: { ...output().changeSize, size: "huge" },
      }),
    ],
    [
      "empty risk summary",
      JSON.stringify({ ...output(), risk: { level: "low", summary: "" } }),
    ],
    [
      "blank changeSize summary",
      JSON.stringify({
        ...output(),
        changeSize: { size: "small", summary: "   " },
      }),
    ],
    [
      "untrimmed risk summary",
      JSON.stringify({
        ...output(),
        risk: { level: "low", summary: " Padded." },
      }),
    ],
    [
      "untrimmed changeSize summary",
      JSON.stringify({
        ...output(),
        changeSize: { size: "small", summary: "Padded. " },
      }),
    ],
    ["malformed", '{"risk":'],
  ])("rejects %s output", (_case, text) => {
    expect(() => parsePlanHealthOutput(text)).toThrow();
  });

  it.each(["risk", "changeSize"] as const)(
    "rejects %s summaries over 1,000 UTF-16 code units",
    (concept) => {
      const value = output();
      value[concept].summary = "a".repeat(
        MAX_PLAN_HEALTH_SUMMARY_CODE_UNITS + 1,
      );
      expect(() => parsePlanHealthOutput(JSON.stringify(value))).toThrow(
        /1,000 UTF-16/,
      );
    },
  );

  it("keeps the transport rule server-owned and renders one immutable report", () => {
    expect(PLAN_HEALTH_TRANSPORT_INSTRUCTION).toContain(
      "exactly one bare JSON object",
    );
    expect(PLAN_HEALTH_TRANSPORT_INSTRUCTION).toContain("risk and changeSize");
    expect(
      renderPlanHealthResult({
        kind: "plan-health",
        schemaVersion: 1,
        assessments: {
          risk: {
            level: "high",
            summary: "Authentication changes expand the blast radius.",
          },
          changeSize: {
            size: "medium",
            summary: "The work coordinates two packages in one phase.",
          },
        },
        assessedAt: "2026-08-15T00:00:00.000Z",
        basisVersion: 3,
        application: "plan_changed",
      }),
    ).toBe(
      "Risk: High — Authentication changes expand the blast radius.\n\n" +
        "Change size: Medium — The work coordinates two packages in one phase.\n\n" +
        "Not applied because the plan changed during assessment.",
    );
  });
});
