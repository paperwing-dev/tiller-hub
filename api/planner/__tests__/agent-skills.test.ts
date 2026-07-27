import { describe, expect, it } from "vitest";
import { KIMI_K2_7_CODE } from "../../../shared/harness-catalog";
import {
  DEFAULT_CODE_REVIEW_SKILL,
  DEFAULT_PLAN_REVIEW_SKILL,
  listCanonicalAgentRoutes,
  normalizeSkillCommand,
  normalizeSkillDefinition,
} from "../agent-skills";

describe("agent skill definitions", () => {
  it("normalizes slash commands and rejects invalid commands", () => {
    expect(normalizeSkillCommand("  ///Risk-Review ")).toBe("risk-review");
    expect(normalizeSkillCommand("risk review")).toBeNull();
  });

  it("projects one deterministic route per friendly model id", () => {
    const routes = listCanonicalAgentRoutes();
    expect(routes.filter((route) => route.modelId === "gpt-5.5")).toEqual([
      expect.objectContaining({ key: "codex:gpt-5.5", harness: "codex" }),
    ]);
    expect(routes).toContainEqual(expect.objectContaining({
      key: `opencode:${KIMI_K2_7_CODE.id}`,
      label: KIMI_K2_7_CODE.label,
      model: KIMI_K2_7_CODE.providerModel,
    }));
  });

  it("ships editable Plan Review and three-child Kimi High Code Review built-ins", () => {
    expect(DEFAULT_PLAN_REVIEW_SKILL).toMatchObject({
      id: "plan-review",
      surface: "plan",
      agents: [{ reportMode: "manual" }],
    });
    expect(DEFAULT_CODE_REVIEW_SKILL).toMatchObject({
      id: "code-review",
      surface: "review",
      overviewMode: "auto",
    });
    expect(DEFAULT_CODE_REVIEW_SKILL.agents).toHaveLength(3);
    expect(DEFAULT_CODE_REVIEW_SKILL.agents.every((agent) =>
      agent.routeKey === `opencode:${KIMI_K2_7_CODE.id}` && agent.effort === "high"
    )).toBe(true);
  });

  it("derives preset or fanout from the one-to-four agent count", () => {
    const routes = listCanonicalAgentRoutes();
    const base = {
      surface: "review",
      command: "/focused-review",
      label: "Focused Review",
      description: "",
      sharedInstructions: "Review the frozen workspace.",
      overviewInstructions: "Synthesize.",
      overviewMode: "auto",
      agents: [{
        id: "one",
        label: "Reviewer",
        instructions: "Find bugs.",
        routeKey: routes[0]!.key,
        effort: routes[0]!.defaultEffort,
        reportMode: "auto",
      }],
    };
    const preset = normalizeSkillDefinition(base, {
      id: "focused-review",
      surface: "review",
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
      routes,
    });
    expect(preset.command).toBe("focused-review");
    expect(preset.agents).toHaveLength(1);
    expect(() => normalizeSkillDefinition({ ...base, agents: [] }, {
      id: "bad",
      surface: "review",
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
      routes,
    })).toThrow("one to four");
    expect(() => normalizeSkillDefinition({ ...base, agents: Array.from({ length: 5 }, (_, index) => ({
      ...base.agents[0],
      id: String(index),
    })) }, {
      id: "bad",
      surface: "review",
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
      routes,
    })).toThrow("one to four");
  });
});
