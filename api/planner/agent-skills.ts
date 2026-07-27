import { HARNESS_MODEL_CATALOG, KIMI_K2_7_CODE } from "../../shared/harness-catalog";
import type {
  AgentDefinition,
  AgentRoute,
  AgentSkillDefinition,
  PlannerEffort,
  PlannerProviderMetadata,
  SkillAutomationMode,
  SkillOrigin,
  SkillSurface,
} from "../coordination";

export const BUILTIN_PLAN_REVIEW_SKILL_ID = "plan-review";
export const BUILTIN_CODE_REVIEW_SKILL_ID = "code-review";
export const DEFAULT_PLAN_WRITER_ROUTE_KEY = "codex:gpt-5.5";

const EFFORTS = new Set<PlannerEffort>(["low", "medium", "high", "xhigh", "ultra", "max"]);

function routeProviderAndModel(entry: (typeof HARNESS_MODEL_CATALOG)[number]): { provider: string; model: string } {
  return { provider: entry.harness, model: entry.binding.model };
}

function defaultEffort(efforts: readonly string[]): PlannerEffort {
  if (efforts.includes("xhigh")) return "xhigh";
  if (efforts.includes("high")) return "high";
  return (efforts[efforts.length - 1] ?? "high") as PlannerEffort;
}

/**
 * The harness catalog can expose the same friendly model through multiple
 * harnesses. Skills deliberately project the first catalog route for each
 * friendly id, which makes the choice deterministic while keeping a stable,
 * hidden harness-qualified key in saved definitions.
 */
export function listCanonicalAgentRoutes(providers: PlannerProviderMetadata[] = []): AgentRoute[] {
  const seen = new Set<string>();
  const routes: AgentRoute[] = [];
  for (const entry of HARNESS_MODEL_CATALOG) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const binding = routeProviderAndModel(entry);
    const provider = providers.find((candidate) => candidate.id === binding.provider);
    const model = provider?.models.find((candidate) => candidate.id === binding.model);
    const available = providers.length === 0
      ? true
      : Boolean(provider?.available && model?.available);
    routes.push({
      key: `${entry.harness}:${entry.id}`,
      label: entry.label,
      harness: entry.harness,
      provider: binding.provider,
      model: binding.model,
      modelId: entry.id,
      supportedEfforts: entry.efforts.filter((effort): effort is PlannerEffort => EFFORTS.has(effort as PlannerEffort)),
      defaultEffort: defaultEffort(entry.efforts),
      available,
      ...(!available
        ? { disabledReason: model?.disabledReason || provider?.disabledReasons[0] || "Agent route is unavailable." }
        : {}),
    });
  }
  return routes;
}

export function resolveAgentRoute(routeKey: string, providers: PlannerProviderMetadata[] = []): AgentRoute | null {
  return listCanonicalAgentRoutes(providers).find((route) => route.key === routeKey) ?? null;
}

export function mergeStoredAgentSkills(
  surface: SkillSurface,
  stored: AgentSkillDefinition[],
): AgentSkillDefinition[] {
  const builtin = builtInSkill(surface);
  const override = stored.find((skill) => skill.id === builtin.id && skill.origin === "builtin") ?? null;
  return [
    applyBuiltInOverride(surface, override),
    ...stored.filter((skill) => skill.origin === "custom"),
  ];
}

export function resolveSkillAgentRoutes(
  skill: AgentSkillDefinition,
  providers: PlannerProviderMetadata[],
  capability: "writer" | "reviewer",
):
  | { ok: true; resolved: Array<{ definition: AgentDefinition; route: AgentRoute }> }
  | { ok: false; status: 400 | 409; error: string } {
  const resolved: Array<{ definition: AgentDefinition; route: AgentRoute }> = [];
  for (const definition of skill.agents) {
    const route = resolveAgentRoute(definition.routeKey, providers);
    if (!route) return { ok: false, status: 400, error: `Unknown agent route: ${definition.routeKey}` };
    if (!route.supportedEfforts.includes(definition.effort)) {
      return { ok: false, status: 400, error: `${route.label} does not support ${definition.effort} reasoning.` };
    }
    if (!route.available) {
      return { ok: false, status: 409, error: route.disabledReason ?? `${route.label} is unavailable.` };
    }
    const provider = providers.find((candidate) => candidate.id === route.provider);
    const model = provider?.models.find((candidate) => candidate.id === route.model);
    if (!provider || !model || !provider.capabilities[capability]) {
      return { ok: false, status: 400, error: `${route.label} cannot run as a ${capability}.` };
    }
    resolved.push({ definition, route });
  }
  return { ok: true, resolved };
}

function agent(
  id: string,
  label: string,
  instructions: string,
  routeKey: string,
  effort: PlannerEffort,
  reportMode: SkillAutomationMode,
): AgentDefinition {
  return { id, label, instructions, routeKey, effort, reportMode };
}

export const DEFAULT_PLAN_REVIEW_SKILL: AgentSkillDefinition = {
  id: BUILTIN_PLAN_REVIEW_SKILL_ID,
  surface: "plan",
  command: "plan-review",
  label: "Plan Review",
  description: "Challenge the plan before implementation starts.",
  sharedInstructions: "Read the current plan and repository contracts. Find gaps, risks, and simpler alternatives.",
  overviewInstructions: "",
  overviewMode: "manual",
  agents: [
    agent(
      "plan-architecture",
      "Architecture Reviewer",
      "Check architecture fit, coupling, missing contracts, risky edge cases, and opportunities to simplify the plan.",
      DEFAULT_PLAN_WRITER_ROUTE_KEY,
      "xhigh",
      "manual",
    ),
  ],
  origin: "builtin",
  customized: false,
  createdAt: null,
  updatedAt: null,
};

const KIMI_ROUTE_KEY = `opencode:${KIMI_K2_7_CODE.id}`;

export const DEFAULT_CODE_REVIEW_SKILL: AgentSkillDefinition = {
  id: BUILTIN_CODE_REVIEW_SKILL_ID,
  surface: "review",
  command: "code-review",
  label: "Code Review",
  description: "Run three focused reviews and bring their reports back together.",
  sharedInstructions: "Review the immutable workspace snapshot against the startup plan and repository contracts.",
  overviewInstructions: "Deduplicate findings, prefer high-confidence issues, reconcile disagreements, and recommend what is worth fixing.",
  overviewMode: "auto",
  agents: [
    agent(
      "review-bugs",
      "Bug Reviewer",
      "Find correctness issues, behavioral regressions, edge cases, races, and missing error handling.",
      KIMI_ROUTE_KEY,
      "high",
      "auto",
    ),
    agent(
      "review-simplification",
      "Simplification Reviewer",
      "Find unnecessary abstraction, over-engineering, duplication, and a simpler implementation path.",
      KIMI_ROUTE_KEY,
      "high",
      "auto",
    ),
    agent(
      "review-plan-compliance",
      "Plan Compliance",
      "Compare the implementation with the pinned plan and call out meaningful drift.",
      KIMI_ROUTE_KEY,
      "high",
      "auto",
    ),
  ],
  origin: "builtin",
  customized: false,
  createdAt: null,
  updatedAt: null,
};

export function builtInSkill(surface: SkillSurface): AgentSkillDefinition {
  return surface === "plan" ? DEFAULT_PLAN_REVIEW_SKILL : DEFAULT_CODE_REVIEW_SKILL;
}

export function cloneSkillDefinition(definition: AgentSkillDefinition): AgentSkillDefinition {
  return {
    ...definition,
    agents: definition.agents.map((entry) => ({ ...entry })),
  };
}

export function normalizeSkillCommand(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const command = value.trim().replace(/^\/+/, "").trim().toLowerCase();
  return command && /^[a-z0-9-]+$/.test(command) ? command : null;
}

export function normalizeSkillDefinition(input: unknown, options: {
  id: string;
  surface: SkillSurface;
  origin: SkillOrigin;
  customized: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  routes: AgentRoute[];
  fixedCommand?: string;
}): AgentSkillDefinition {
  if (!input || typeof input !== "object") throw new Error("Skill definition is required.");
  const value = input as Record<string, unknown>;
  const command = options.fixedCommand ?? normalizeSkillCommand(value.command);
  if (!command) throw new Error("command must contain only a-z, 0-9, and hyphen characters");
  const required = (field: string): string => {
    const text = typeof value[field] === "string" ? value[field].trim() : "";
    if (!text) throw new Error(`${field} is required`);
    return text;
  };
  const optional = (field: string): string => typeof value[field] === "string" ? value[field].trim() : "";
  const candidates = Array.isArray(value.agents) ? value.agents : [];
  if (candidates.length < 1 || candidates.length > 4) throw new Error("A skill must contain one to four agents.");
  const agentIds = new Set<string>();
  const agents = candidates.map((candidate, index): AgentDefinition => {
    if (!candidate || typeof candidate !== "object") throw new Error(`agents[${index}] is invalid`);
    const entry = candidate as Record<string, unknown>;
    const id = typeof entry.id === "string" && entry.id.trim() ? entry.id.trim() : crypto.randomUUID();
    if (agentIds.has(id)) throw new Error("Agent ids must be unique within a skill.");
    agentIds.add(id);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const instructions = typeof entry.instructions === "string" ? entry.instructions.trim() : "";
    const routeKey = typeof entry.routeKey === "string" ? entry.routeKey.trim() : "";
    const route = options.routes.find((item) => item.key === routeKey);
    if (!label) throw new Error(`agents[${index}].label is required`);
    if (!instructions) throw new Error(`agents[${index}].instructions is required`);
    if (!route) throw new Error(`Unknown agent route: ${routeKey || "(missing)"}`);
    const effort = typeof entry.effort === "string" ? entry.effort as PlannerEffort : route.defaultEffort;
    if (!route.supportedEfforts.includes(effort)) throw new Error(`${route.label} does not support ${effort} reasoning.`);
    return {
      id,
      label,
      instructions,
      routeKey,
      effort,
      reportMode: entry.reportMode === "manual" ? "manual" : "auto",
    };
  });
  return {
    id: options.id,
    surface: options.surface,
    command,
    label: required("label"),
    description: optional("description"),
    sharedInstructions: required("sharedInstructions"),
    overviewInstructions: optional("overviewInstructions"),
    overviewMode: value.overviewMode === "manual" ? "manual" : "auto",
    agents,
    origin: options.origin,
    customized: options.customized,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
}

export function applyBuiltInOverride(
  surface: SkillSurface,
  stored: AgentSkillDefinition | null,
): AgentSkillDefinition {
  if (!stored) return cloneSkillDefinition(builtInSkill(surface));
  return { ...cloneSkillDefinition(stored), origin: "builtin", customized: true };
}
