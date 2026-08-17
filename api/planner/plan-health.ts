import type {
  PlanHealthAssessment,
  PlanHealthSkillResult,
  PlanHealthValues,
  ThreadMessage,
} from "../coordination/types";
import {
  decodePlanHealthAssessment,
  decodePlanHealthSkillResult,
  decodePlanHealthValues,
} from "../coordination/plan-health-schema";

export {
  MAX_PLAN_HEALTH_SUMMARY_CODE_UNITS,
} from "../coordination/plan-health-schema";

export const PLAN_HEALTH_RESULT_HANDLER = "plan-health@1" as const;

export const PLAN_HEALTH_TRANSPORT_INSTRUCTION = [
  "Return exactly one bare JSON object containing only the keys risk and changeSize.",
  'risk must contain exactly level and summary; level must be exactly one of "low", "medium", or "high" in lowercase.',
  'changeSize must contain exactly size and summary; size must be exactly one of "small", "medium", or "large" in lowercase.',
  "Each summary must be a non-empty, trimmed one- or two-sentence string no longer than 1,000 UTF-16 code units.",
  "Do not use Markdown fences or include any surrounding text.",
].join(" ");

export const PLAN_HEALTH_RUBRIC = [
  "Assess the current plan for Risk and Change Size independently.",
  "",
  "Risk — select the highest applicable level:",
  "Low: localized, conventional, reversible work without durable-data, security-boundary, public-contract, or infrastructure changes.",
  "Medium: multi-component work, contained contract or migration changes, moderate uncertainty, or coordinated rollout with a feasible rollback.",
  "High: destructive or irreversible migration, authentication/security/privacy impact, breaking public contracts, core infrastructure or cross-system blast radius, uncertain rollback, or material unresolved unknowns.",
  "",
  "Change Size measures breadth and coordination, not danger or elapsed time.",
  "Select the applicable size:",
  "Small: localized to one component, a few files, and one validation surface.",
  "Medium: coordinated work across several components or at most one boundary/two packages, still deliverable as one coherent phase.",
  "Large: broader multi-package or system-boundary work, significant migration/infrastructure/public-contract work, or multiple coordinated phases.",
  "",
  "Provide a separate one- or two-sentence rationale for each assessment.",
].join("\n");

export type ParsedPlanHealthOutput = PlanHealthValues;

export function parsePlanHealthAssessment(
  value: string | null,
): PlanHealthAssessment | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return decodePlanHealthAssessment(parsed) ?? undefined;
  } catch {
    // Malformed Health JSON is equivalent to unavailable Health.
  }
  return undefined;
}

export function parsePlanHealthSkillResult(
  value: string | null,
): PlanHealthSkillResult | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return decodePlanHealthSkillResult(parsed);
  } catch {
    // Malformed result JSON must not break invocation history.
  }
  return null;
}

export function parsePlanHealthOutput(text: string): ParsedPlanHealthOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch {
    throw new Error("Plan Health output must be exactly one bare JSON object.");
  }
  const decoded = decodePlanHealthValues(parsed);
  if (!decoded) {
    throw new Error(
      "Plan Health output must contain exactly the required risk and changeSize fields with lowercase enum values and non-empty, trimmed summaries no longer than 1,000 UTF-16 code units.",
    );
  }
  return decoded;
}

function titleCase(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

export function renderPlanHealthResult(result: PlanHealthSkillResult): string {
  const application =
    result.application === "applied"
      ? "Applied to the current plan."
      : "Not applied because the plan changed during assessment.";
  return [
    `Risk: ${titleCase(result.assessments.risk.level)} — ${result.assessments.risk.summary}`,
    `Change size: ${titleCase(result.assessments.changeSize.size)} — ${result.assessments.changeSize.summary}`,
    application,
  ].join("\n\n");
}

export function insertPlanHealthVirtualMessage(
  messages: ThreadMessage[],
  virtual: ThreadMessage | null,
): ThreadMessage[] {
  if (!virtual || messages.some((message) => message.id === virtual.id)) {
    return messages;
  }
  const setupIndex = messages.findIndex((message) =>
    message.id.startsWith("skill-setup:"),
  );
  const insertionIndex = setupIndex < 0 ? 0 : setupIndex + 1;
  return [
    ...messages.slice(0, insertionIndex),
    virtual,
    ...messages.slice(insertionIndex),
  ];
}
