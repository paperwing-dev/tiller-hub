import { describe, expect, it } from "vitest";
import {
  KIMI_K2_7_CODE,
  listHarnessModels,
} from "../../../shared/harness-catalog";
import {
  assertUniqueWriterRouteTuples,
  DEFAULT_CODE_REVIEW_SKILL,
  DEFAULT_PLAN_REVIEW_SKILL,
  DEFAULT_PLAN_HEALTH_SKILL,
  assertPlanHealthOverrideInput,
  isReservedBuiltInSkillIdentity,
  listCanonicalAgentRoutes,
  listWriterAgentRoutes,
  mergeStoredAgentSkills,
  normalizeSkillCommand,
  normalizeSkillDefinition,
  trustedBuiltInInitialResultHandler,
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
    expect(routes).toContainEqual(
      expect.objectContaining({
        key: `opencode:${KIMI_K2_7_CODE.id}`,
        label: KIMI_K2_7_CODE.label,
        model: KIMI_K2_7_CODE.providerModel,
      }),
    );
    expect(routes.map((route) => route.key)).not.toContain(
      "opencode:claude-opus-5",
    );
    expect(routes.map((route) => route.key)).not.toContain(
      "opencode:claude-fable-5",
    );
  });

  it("preserves every harness-qualified OpenCode writer route without changing skill routes", () => {
    const skillRoutes = listCanonicalAgentRoutes();
    const writerRoutes = listWriterAgentRoutes();
    const openCodeRoutes = writerRoutes.filter(
      (route) => route.harness === "opencode",
    );
    expect(openCodeRoutes.map((route) => route.modelId)).toEqual(
      listHarnessModels("opencode").map((entry) => entry.id),
    );
    expect(
      openCodeRoutes.every((route) => route.supportedEfforts.length > 0),
    ).toBe(true);
    expect(listCanonicalAgentRoutes()).toEqual(skillRoutes);
  });

  it("rejects writer routes that collide in the persisted active-row tuple", () => {
    const route = listWriterAgentRoutes()[0]!;
    expect(() =>
      assertUniqueWriterRouteTuples([
        route,
        { ...route, key: `${route.key}:duplicate` },
      ]),
    ).toThrow(/collide for persisted tuple/);
  });

  it("ships editable Plan Review and three-child Kimi High Code Review built-ins", () => {
    expect(DEFAULT_PLAN_REVIEW_SKILL).toMatchObject({
      id: "plan-review",
      surface: "plan",
      sharedInstructions: "",
      agents: [{ reportMode: "manual" }],
    });
    expect(DEFAULT_PLAN_REVIEW_SKILL.agents[0]?.instructions)
      .toContain("Read the current plan and repository contracts");
    expect(DEFAULT_PLAN_REVIEW_SKILL.agents[0]?.instructions)
      .toContain("Make sure this plan is not over engineered, and look for ways to simplify.");
    expect(DEFAULT_CODE_REVIEW_SKILL).toMatchObject({
      id: "code-review",
      surface: "review",
      overviewMode: "auto",
    });
    expect(DEFAULT_CODE_REVIEW_SKILL.agents).toHaveLength(3);
    expect(
      DEFAULT_CODE_REVIEW_SKILL.agents.every(
        (agent) =>
          agent.routeKey === `opencode:${KIMI_K2_7_CODE.id}` &&
          agent.effort === "high",
      ),
    ).toBe(true);
  });

  it("orders Plan Health after Plan Review and keeps its invocation shape private and fixed", () => {
    const skills = mergeStoredAgentSkills("plan", []);
    expect(skills.map((skill) => skill.id)).toEqual(["plan-review", "plan-health"]);
    expect(DEFAULT_PLAN_HEALTH_SKILL).toMatchObject({
      id: "plan-health",
      command: "health",
      surface: "plan",
      overviewMode: "manual",
      overviewInstructions: "",
      agents: [{
        id: "plan-health-assessor",
        label: "Plan Health Assessor",
        routeKey: "codex:gpt-5.5",
        effort: "high",
        reportMode: "manual",
      }],
    });
    expect(DEFAULT_PLAN_HEALTH_SKILL.sharedInstructions).toBe("");
    expect(DEFAULT_PLAN_HEALTH_SKILL.description)
      .toBe("Assess the current plan's risk and change size, then update its hover details with both values.");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("Low: localized");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("Medium: multi-component work");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("High: destructive");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("Small: localized");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("Medium: coordinated work");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("Large: broader multi-package");
    expect(DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.instructions).toContain("not danger or elapsed time");
    expect(isReservedBuiltInSkillIdentity("plan-health", "anything")).toBe(true);
    expect(isReservedBuiltInSkillIdentity("anything", "/health")).toBe(true);
    expect(isReservedBuiltInSkillIdentity("plan-risk", "anything")).toBe(false);
    expect(isReservedBuiltInSkillIdentity("anything", "/risk")).toBe(false);
    expect(isReservedBuiltInSkillIdentity("custom-id", "/plan-risk")).toBe(false);
    expect(() => assertPlanHealthOverrideInput({ command: "risk" })).toThrow(/command is fixed/);
    expect(() => assertPlanHealthOverrideInput({ agents: [] })).toThrow(/exactly one/);
    expect(() => assertPlanHealthOverrideInput({
      agents: [{ ...DEFAULT_PLAN_HEALTH_SKILL.agents[0], id: "replacement" }],
    })).toThrow(/agent ID is fixed/);
    const repaired = mergeStoredAgentSkills("plan", [{
      ...DEFAULT_PLAN_HEALTH_SKILL,
      overviewMode: "auto",
      overviewInstructions: "not allowed",
      agents: [
        { ...DEFAULT_PLAN_HEALTH_SKILL.agents[0]!, reportMode: "auto" },
        { ...DEFAULT_PLAN_HEALTH_SKILL.agents[0]!, id: "extra" },
      ],
      customized: true,
    }])[1]!;
    expect(repaired).toMatchObject({
      overviewMode: "manual",
      overviewInstructions: "",
      agents: [{ id: "plan-health-assessor", reportMode: "manual" }],
    });
    expect(repaired.agents).toHaveLength(1);
    expect(mergeStoredAgentSkills("plan", [{
      ...DEFAULT_PLAN_HEALTH_SKILL,
      id: "plan-risk",
      command: "risk",
    }])).toHaveLength(2);
  });

  it("resolves the private Health marker only for the canonical built-in identity", () => {
    const agents = [{ id: "plan-health-assessor" }];
    expect(
      trustedBuiltInInitialResultHandler(DEFAULT_PLAN_HEALTH_SKILL, agents),
    ).toBe("plan-health@1");
    for (const definition of [
      { ...DEFAULT_PLAN_HEALTH_SKILL, origin: "custom" as const },
      { ...DEFAULT_PLAN_HEALTH_SKILL, command: "risk" },
      {
        ...DEFAULT_PLAN_HEALTH_SKILL,
        agents: [
          { ...DEFAULT_PLAN_HEALTH_SKILL.agents[0]!, id: "replacement" },
        ],
      },
    ]) {
      expect(trustedBuiltInInitialResultHandler(definition, agents)).toBeNull();
    }
    expect(
      trustedBuiltInInitialResultHandler(DEFAULT_PLAN_HEALTH_SKILL, [
        { id: "replacement" },
      ]),
    ).toBeNull();
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
      agents: [
        {
          id: "one",
          label: "Reviewer",
          instructions: "Find bugs.",
          routeKey: routes[0]!.key,
          effort: routes[0]!.defaultEffort,
          reportMode: "auto",
        },
      ],
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
    expect(preset.sharedInstructions).toBe("");
    expect(preset.agents[0]!.instructions).toBe("Review the frozen workspace.\n\nFind bugs.");
    expect(normalizeSkillDefinition({ ...base, sharedInstructions: "" }, {
      id: "focused-empty-common",
      surface: "review",
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
      routes,
    }).sharedInstructions).toBe("");
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
