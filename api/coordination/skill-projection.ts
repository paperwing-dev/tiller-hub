import type { AgentSkillDefinition, PlannerEffort } from "./types";

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

const PROJECTED_SKILL_EFFORTS = new Set<PlannerEffort>([
  "low",
  "medium",
  "high",
  "xhigh",
  "ultra",
  "max",
]);

/** Strict parser predicate for definitions frozen into writer provenance. */
export function isProjectedPlanSkillDefinition(
  value: unknown,
): value is AgentSkillDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const agents = Array.isArray(record.agents) ? record.agents : [];
  const agentIds = new Set<string>();
  return (
    hasExactKeys(record, [
      "id",
      "surface",
      "command",
      "label",
      "description",
      "sharedInstructions",
      "overviewInstructions",
      "overviewMode",
      "agents",
      "origin",
      "customized",
      "createdAt",
      "updatedAt",
    ]) &&
    typeof record.id === "string" &&
    Boolean(record.id.trim()) &&
    record.surface === "plan" &&
    typeof record.command === "string" &&
    /^[a-z0-9-]+$/u.test(record.command) &&
    typeof record.label === "string" &&
    typeof record.description === "string" &&
    typeof record.sharedInstructions === "string" &&
    typeof record.overviewInstructions === "string" &&
    (record.overviewMode === "auto" || record.overviewMode === "manual") &&
    (record.origin === "builtin" || record.origin === "custom") &&
    typeof record.customized === "boolean" &&
    (record.createdAt === null || typeof record.createdAt === "string") &&
    (record.updatedAt === null || typeof record.updatedAt === "string") &&
    agents.length >= 1 &&
    agents.length <= 4 &&
    agents.every((agent) => {
      if (!agent || typeof agent !== "object" || Array.isArray(agent))
        return false;
      const candidate = agent as Record<string, unknown>;
      if (
        !hasExactKeys(candidate, [
          "id",
          "label",
          "routeKey",
          "effort",
          "instructions",
          "reportMode",
        ]) ||
        typeof candidate.id !== "string" ||
        !candidate.id.trim() ||
        agentIds.has(candidate.id) ||
        typeof candidate.label !== "string" ||
        typeof candidate.routeKey !== "string" ||
        !candidate.routeKey.trim() ||
        !PROJECTED_SKILL_EFFORTS.has(candidate.effort as PlannerEffort) ||
        typeof candidate.instructions !== "string" ||
        (candidate.reportMode !== "auto" && candidate.reportMode !== "manual")
      )
        return false;
      agentIds.add(candidate.id);
      return true;
    })
  );
}
