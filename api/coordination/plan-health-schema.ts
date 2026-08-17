import type {
  PlanHealthAssessment,
  PlanHealthSkillResult,
  PlanHealthValues,
} from "./types";

export const MAX_PLAN_HEALTH_SUMMARY_CODE_UNITS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

function isSummary(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    Boolean(value) &&
    value.length <= MAX_PLAN_HEALTH_SUMMARY_CODE_UNITS
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function decodePlanHealthValues(
  value: unknown,
): PlanHealthValues | null {
  if (!isRecord(value) || !hasExactKeys(value, ["changeSize", "risk"])) {
    return null;
  }
  const { risk, changeSize } = value;
  if (
    !isRecord(risk) ||
    !hasExactKeys(risk, ["level", "summary"]) ||
    (risk.level !== "low" &&
      risk.level !== "medium" &&
      risk.level !== "high") ||
    !isSummary(risk.summary) ||
    !isRecord(changeSize) ||
    !hasExactKeys(changeSize, ["size", "summary"]) ||
    (changeSize.size !== "small" &&
      changeSize.size !== "medium" &&
      changeSize.size !== "large") ||
    !isSummary(changeSize.summary)
  ) {
    return null;
  }
  return {
    risk: { level: risk.level, summary: risk.summary },
    changeSize: { size: changeSize.size, summary: changeSize.summary },
  };
}

export function decodePlanHealthAssessment(
  value: unknown,
): PlanHealthAssessment | null {
  if (!isRecord(value)) return null;
  const hasStaleAt = Object.prototype.hasOwnProperty.call(value, "staleAt");
  const assessments = decodePlanHealthValues(value.assessments);
  if (
    !hasExactKeys(value, [
      "assessedAt",
      "assessments",
      "basisVersion",
      "schemaVersion",
      "skillInvocationId",
      ...(hasStaleAt ? ["staleAt"] : []),
    ]) ||
    value.schemaVersion !== 1 ||
    !assessments ||
    !isIsoDate(value.assessedAt) ||
    typeof value.skillInvocationId !== "string" ||
    value.skillInvocationId !== value.skillInvocationId.trim() ||
    !value.skillInvocationId ||
    !Number.isInteger(value.basisVersion) ||
    (value.basisVersion as number) < 1 ||
    (hasStaleAt && !isIsoDate(value.staleAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    assessments,
    assessedAt: value.assessedAt,
    skillInvocationId: value.skillInvocationId,
    basisVersion: value.basisVersion as number,
    ...(hasStaleAt ? { staleAt: value.staleAt as string } : {}),
  };
}

export function decodePlanHealthSkillResult(
  value: unknown,
): PlanHealthSkillResult | null {
  if (!isRecord(value)) return null;
  const assessments = decodePlanHealthValues(value.assessments);
  if (
    !hasExactKeys(value, [
      "application",
      "assessedAt",
      "assessments",
      "basisVersion",
      "kind",
      "schemaVersion",
    ]) ||
    value.kind !== "plan-health" ||
    value.schemaVersion !== 1 ||
    !assessments ||
    !isIsoDate(value.assessedAt) ||
    !Number.isInteger(value.basisVersion) ||
    (value.basisVersion as number) < 1 ||
    (value.application !== "applied" && value.application !== "plan_changed")
  ) {
    return null;
  }
  return {
    kind: "plan-health",
    schemaVersion: 1,
    assessments,
    assessedAt: value.assessedAt,
    basisVersion: value.basisVersion as number,
    application: value.application,
  };
}
