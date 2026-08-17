import {
  HARNESS_MODEL_CATALOG,
  KIMI_K2_7_CODE,
} from "../../shared/harness-catalog";
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
import { PLAN_HEALTH_RUBRIC, PLAN_HEALTH_RESULT_HANDLER } from "./plan-health";
import { composeReviewerInstructions } from "../reviewer-instructions";

export const BUILTIN_PLAN_REVIEW_SKILL_ID = "plan-review";
export const BUILTIN_PLAN_HEALTH_SKILL_ID = "plan-health";
export const BUILTIN_CODE_REVIEW_SKILL_ID = "code-review";
export const DEFAULT_PLAN_WRITER_ROUTE_KEY = "codex:gpt-5.5";

const EFFORTS = new Set<PlannerEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
]);

function routeProviderAndModel(entry: (typeof HARNESS_MODEL_CATALOG)[number]): {
  provider: string;
  model: string;
} {
  return { provider: entry.harness, model: entry.binding.model };
}

function defaultEffort(efforts: readonly string[]): PlannerEffort {
  if (efforts.includes("xhigh")) return "xhigh";
  if (efforts.includes("high")) return "high";
  return (efforts[efforts.length - 1] ?? "high") as PlannerEffort;
}

function projectRoute(
  entry: (typeof HARNESS_MODEL_CATALOG)[number],
  providers: PlannerProviderMetadata[],
  requireWriterCapability = false,
): AgentRoute {
  const binding = routeProviderAndModel(entry);
  const provider = providers.find(
    (candidate) => candidate.id === binding.provider,
  );
  const model = provider?.models.find(
    (candidate) => candidate.id === binding.model,
  );
  const available =
    providers.length === 0
      ? true
      : Boolean(
          provider?.available &&
          (!requireWriterCapability || provider.capabilities.writer) &&
          model?.available,
        );
  return {
    key: `${entry.harness}:${entry.id}`,
    label: entry.label,
    harness: entry.harness,
    provider: binding.provider,
    model: binding.model,
    modelId: entry.id,
    supportedEfforts: entry.efforts.filter((effort): effort is PlannerEffort =>
      EFFORTS.has(effort as PlannerEffort),
    ),
    defaultEffort: defaultEffort(entry.efforts),
    available,
    ...(!available
      ? {
          disabledReason:
            model?.disabledReason ||
            provider?.disabledReasons[0] ||
            "Agent route is unavailable.",
        }
      : {}),
  };
}

/**
 * The harness catalog can expose the same friendly model through multiple
 * harnesses. Skills deliberately project the first catalog route for each
 * friendly id, which makes the choice deterministic while keeping a stable,
 * hidden harness-qualified key in saved definitions. OpenCode intentionally
 * stays Kimi-only here so reviewer and Plan Skill menus remain unchanged.
 */
export function listCanonicalAgentRoutes(
  providers: PlannerProviderMetadata[] = [],
): AgentRoute[] {
  const seen = new Set<string>();
  const routes: AgentRoute[] = [];
  for (const entry of HARNESS_MODEL_CATALOG) {
    if (entry.harness === "opencode" && entry.id !== KIMI_K2_7_CODE.id)
      continue;
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    routes.push(projectRoute(entry, providers));
  }
  return routes;
}

function writerTupleKey(provider: string, model: string): string {
  return `${provider}\0${model}`;
}

/**
 * Writer settings preserve every harness-qualified catalog route. Unlike Plan
 * Skills, this projection never deduplicates friendly model ids.
 */
export function listWriterAgentRoutes(
  providers: PlannerProviderMetadata[] = [],
): AgentRoute[] {
  const routes = HARNESS_MODEL_CATALOG.map((entry) =>
    projectRoute(entry, providers, true),
  );
  assertUniqueWriterRouteTuples(routes);
  return routes;
}

/** Active writer rows persist this exact tuple, so every selectable route must remain identifiable. */
export function assertUniqueWriterRouteTuples(routes: AgentRoute[]): void {
  const seen = new Map<string, string>();
  for (const route of routes) {
    const tuple = writerTupleKey(route.provider, route.model);
    const existing = seen.get(tuple);
    if (existing && existing !== route.key) {
      throw new Error(
        `Writer routes ${existing} and ${route.key} collide for persisted tuple ${route.provider}/${route.model}.`,
      );
    }
    seen.set(tuple, route.key);
  }
}

export function resolveAgentRoute(
  routeKey: string,
  providers: PlannerProviderMetadata[] = [],
): AgentRoute | null {
  return (
    listCanonicalAgentRoutes(providers).find(
      (route) => route.key === routeKey,
    ) ?? null
  );
}

export function mergeStoredAgentSkills(
  surface: SkillSurface,
  stored: AgentSkillDefinition[],
): AgentSkillDefinition[] {
  return [
    ...builtInSkills(surface).map((builtin) => {
      const effective = applyBuiltInOverride(
        builtin,
        stored.find(
          (skill) => skill.id === builtin.id && skill.origin === "builtin",
        ) ?? null,
      );
      return builtin.id === BUILTIN_PLAN_HEALTH_SKILL_ID
        ? enforcePlanHealthDefinition(effective)
        : effective;
    }),
    ...stored.filter((skill) => skill.origin === "custom"),
  ];
}

export function resolveSkillAgentRoutes(
  skill: AgentSkillDefinition,
  providers: PlannerProviderMetadata[],
  capability: "writer" | "reviewer",
):
  | {
      ok: true;
      resolved: Array<{ definition: AgentDefinition; route: AgentRoute }>;
    }
  | { ok: false; status: 400 | 409; error: string } {
  const resolved: Array<{ definition: AgentDefinition; route: AgentRoute }> =
    [];
  for (const definition of skill.agents) {
    const route = resolveAgentRoute(definition.routeKey, providers);
    if (!route)
      return {
        ok: false,
        status: 400,
        error: `Unknown agent route: ${definition.routeKey}`,
      };
    if (!route.supportedEfforts.includes(definition.effort)) {
      return {
        ok: false,
        status: 400,
        error: `${route.label} does not support ${definition.effort} reasoning.`,
      };
    }
    if (!route.available) {
      return {
        ok: false,
        status: 409,
        error: route.disabledReason ?? `${route.label} is unavailable.`,
      };
    }
    const provider = providers.find(
      (candidate) => candidate.id === route.provider,
    );
    const model = provider?.models.find(
      (candidate) => candidate.id === route.model,
    );
    if (!provider || !model || !provider.capabilities[capability]) {
      return {
        ok: false,
        status: 400,
        error: `${route.label} cannot run as a ${capability}.`,
      };
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
  sharedInstructions: "",
  overviewInstructions: "",
  overviewMode: "manual",
  agents: [
    agent(
      "plan-architecture",
      "Architecture Reviewer",
      composeReviewerInstructions(
        "Read the current plan and repository contracts. Find gaps, risks, and simpler alternatives.",
        "Make sure this plan is not over engineered, and look for ways to simplify.",
      ),
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

export const DEFAULT_PLAN_HEALTH_SKILL: AgentSkillDefinition = {
  id: BUILTIN_PLAN_HEALTH_SKILL_ID,
  surface: "plan",
  command: "health",
  label: "Plan Health",
  description: "Assess the current plan's risk and change size, then update its hover details with both values.",
  sharedInstructions: "",
  overviewInstructions: "",
  overviewMode: "manual",
  agents: [
    agent(
      "plan-health-assessor",
      "Plan Health Assessor",
      composeReviewerInstructions(
        PLAN_HEALTH_RUBRIC,
        "Apply both rubrics independently to the complete current plan. Select its risk level and change size, then explain the deciding factors concisely.",
      ),
      DEFAULT_PLAN_WRITER_ROUTE_KEY,
      "high",
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
  description:
    "Run three focused reviews and bring their reports back together.",
  sharedInstructions:
    "Review the implementation against the pinned plan and repository contracts.",
  overviewInstructions:
    "Deduplicate findings, prefer high-confidence issues, reconcile disagreements, and recommend what is worth fixing.",
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

interface PrivateBuiltInSkillCatalogEntry {
  definition: AgentSkillDefinition;
  initialResultHandler?: typeof PLAN_HEALTH_RESULT_HANDLER;
  constraints?: { agentCount: 1 };
}

const BUILTIN_SKILL_CATALOG: Record<
  SkillSurface,
  readonly PrivateBuiltInSkillCatalogEntry[]
> = {
  plan: [
    { definition: DEFAULT_PLAN_REVIEW_SKILL },
    {
      definition: DEFAULT_PLAN_HEALTH_SKILL,
      initialResultHandler: PLAN_HEALTH_RESULT_HANDLER,
      constraints: { agentCount: 1 },
    },
  ],
  review: [{ definition: DEFAULT_CODE_REVIEW_SKILL }],
};

export function builtInSkills(surface: SkillSurface): AgentSkillDefinition[] {
  return BUILTIN_SKILL_CATALOG[surface].map((entry) =>
    cloneSkillDefinition(entry.definition),
  );
}

export function builtInSkill(
  surface: SkillSurface,
  skillId?: string,
): AgentSkillDefinition {
  const entry = skillId
    ? BUILTIN_SKILL_CATALOG[surface].find(
        (candidate) => candidate.definition.id === skillId,
      )
    : BUILTIN_SKILL_CATALOG[surface][0];
  if (!entry) throw new Error(`Built-in skill not found: ${skillId}`);
  return cloneSkillDefinition(entry.definition);
}

/** Resolve private structured behavior only when the effective definition and launched agents match the catalog contract. */
export function trustedBuiltInInitialResultHandler(
  definition: AgentSkillDefinition,
  agents: Array<{ id: string }>,
): typeof PLAN_HEALTH_RESULT_HANDLER | null {
  const entry = BUILTIN_SKILL_CATALOG[definition.surface].find(
    (candidate) => candidate.definition.id === definition.id,
  );
  if (!entry?.initialResultHandler) return null;
  const canonical = entry.definition;
  const expectedAgentCount =
    entry.constraints?.agentCount ?? canonical.agents.length;
  if (
    definition.id !== canonical.id ||
    definition.command !== canonical.command ||
    definition.surface !== canonical.surface ||
    definition.origin !== "builtin" ||
    definition.agents.length !== expectedAgentCount ||
    agents.length !== expectedAgentCount ||
    definition.agents.some(
      (agent, index) => agent.id !== canonical.agents[index]?.id,
    ) ||
    agents.some((agent, index) => agent.id !== canonical.agents[index]?.id)
  )
    return null;
  return entry.initialResultHandler;
}

export function isReservedBuiltInSkillIdentity(
  id: string,
  command: string,
): boolean {
  const normalizedCommand = normalizeSkillCommand(command);
  return BUILTIN_SKILL_CATALOG.plan
    .concat(BUILTIN_SKILL_CATALOG.review)
    .some(
      (entry) =>
        entry.definition.id === id ||
        entry.definition.command === normalizedCommand,
    );
}

export function cloneSkillDefinition(
  definition: AgentSkillDefinition,
): AgentSkillDefinition {
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

export function normalizeSkillDefinition(
  input: unknown,
  options: {
    id: string;
    surface: SkillSurface;
    origin: SkillOrigin;
    customized: boolean;
    createdAt: string | null;
    updatedAt: string | null;
    routes: AgentRoute[];
    fixedCommand?: string;
    requireSharedInstructions?: boolean;
  },
): AgentSkillDefinition {
  if (!input || typeof input !== "object")
    throw new Error("Skill definition is required.");
  const value = input as Record<string, unknown>;
  const command = options.fixedCommand ?? normalizeSkillCommand(value.command);
  if (!command)
    throw new Error(
      "command must contain only a-z, 0-9, and hyphen characters",
    );
  const required = (field: string): string => {
    const text = typeof value[field] === "string" ? value[field].trim() : "";
    if (!text) throw new Error(`${field} is required`);
    return text;
  };
  const optional = (field: string): string =>
    typeof value[field] === "string" ? value[field].trim() : "";
  const candidates = Array.isArray(value.agents) ? value.agents : [];
  if (candidates.length < 1 || candidates.length > 4)
    throw new Error("A skill must contain one to four agents.");
  const agentIds = new Set<string>();
  const agents = candidates.map((candidate, index): AgentDefinition => {
    if (!candidate || typeof candidate !== "object")
      throw new Error(`agents[${index}] is invalid`);
    const entry = candidate as Record<string, unknown>;
    const id =
      typeof entry.id === "string" && entry.id.trim()
        ? entry.id.trim()
        : crypto.randomUUID();
    if (agentIds.has(id))
      throw new Error("Agent ids must be unique within a skill.");
    agentIds.add(id);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const instructions =
      typeof entry.instructions === "string" ? entry.instructions.trim() : "";
    const routeKey =
      typeof entry.routeKey === "string" ? entry.routeKey.trim() : "";
    const route = options.routes.find((item) => item.key === routeKey);
    if (!label) throw new Error(`agents[${index}].label is required`);
    if (!instructions)
      throw new Error(`agents[${index}].instructions is required`);
    if (!route)
      throw new Error(`Unknown agent route: ${routeKey || "(missing)"}`);
    const effort =
      typeof entry.effort === "string"
        ? (entry.effort as PlannerEffort)
        : route.defaultEffort;
    if (!route.supportedEfforts.includes(effort))
      throw new Error(`${route.label} does not support ${effort} reasoning.`);
    return {
      id,
      label,
      instructions,
      routeKey,
      effort,
      reportMode: entry.reportMode === "manual" ? "manual" : "auto",
    };
  });
  const sharedInstructions = options.requireSharedInstructions && agents.length > 1
    ? required("sharedInstructions")
    : optional("sharedInstructions");
  const normalizedAgents = agents.length === 1 && sharedInstructions
    ? [{
        ...agents[0]!,
        instructions: composeReviewerInstructions(
          sharedInstructions,
          agents[0]!.instructions,
        ),
      }]
    : agents;
  return {
    id: options.id,
    surface: options.surface,
    command,
    label: required("label"),
    description: optional("description"),
    sharedInstructions: agents.length === 1 ? "" : sharedInstructions,
    overviewInstructions: optional("overviewInstructions"),
    overviewMode: value.overviewMode === "manual" ? "manual" : "auto",
    agents: normalizedAgents,
    origin: options.origin,
    customized: options.customized,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
}

export function applyBuiltInOverride(
  builtin: AgentSkillDefinition,
  stored: AgentSkillDefinition | null,
): AgentSkillDefinition {
  if (!stored) return cloneSkillDefinition(builtin);
  return {
    ...cloneSkillDefinition(stored),
    id: builtin.id,
    surface: builtin.surface,
    command: builtin.command,
    origin: "builtin",
    customized: true,
  };
}

export function assertPlanHealthOverrideInput(
  input: Record<string, unknown>,
): void {
  if (
    input.command !== undefined &&
    normalizeSkillCommand(input.command) !== DEFAULT_PLAN_HEALTH_SKILL.command
  ) {
    throw new Error("Plan Health command is fixed.");
  }
  if (input.surface !== undefined && input.surface !== "plan")
    throw new Error("Plan Health surface is fixed.");
  if (input.overviewMode !== undefined && input.overviewMode !== "manual") {
    throw new Error("Plan Health overview automation is fixed.");
  }
  if (
    input.overviewInstructions !== undefined &&
    input.overviewInstructions !== ""
  ) {
    throw new Error("Plan Health overview instructions are fixed.");
  }
  if (input.agents !== undefined) {
    if (
      !Array.isArray(input.agents) ||
      input.agents.length !== DEFAULT_PLAN_HEALTH_SKILL.agents.length
    ) {
      throw new Error("Plan Health must contain exactly one agent.");
    }
    const candidate = input.agents[0];
    if (!candidate || typeof candidate !== "object")
      throw new Error("Plan Health agent is invalid.");
    const record = candidate as Record<string, unknown>;
    if (record.id !== DEFAULT_PLAN_HEALTH_SKILL.agents[0]!.id)
      throw new Error("Plan Health agent ID is fixed.");
    if (record.reportMode !== undefined && record.reportMode !== "manual") {
      throw new Error("Plan Health report automation is fixed.");
    }
  }
}

export function enforcePlanHealthDefinition(
  definition: AgentSkillDefinition,
): AgentSkillDefinition {
  const canonical = DEFAULT_PLAN_HEALTH_SKILL;
  const requestedAgent = definition.agents[0]!;
  return {
    ...definition,
    id: canonical.id,
    surface: canonical.surface,
    command: canonical.command,
    overviewMode: canonical.overviewMode,
    overviewInstructions: canonical.overviewInstructions,
    agents: [
      {
        ...requestedAgent,
        id: canonical.agents[0]!.id,
        reportMode: canonical.agents[0]!.reportMode,
      },
    ],
  };
}
