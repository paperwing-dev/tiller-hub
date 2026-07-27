import { isExecutionPlacement } from "../types";
import type {
  PlannerRunLaunchProvenance,
  PlannerRunRuntimeProvenance,
  PlanWriterRuntimeProvenance,
} from "./types";

function parseStoredProvenance(value: string | null, label: string): unknown | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Malformed ${label} execution placement.`);
  }
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

function isStoredCodexExecution(
  value: unknown,
  backend: "cf" | "host",
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    !hasExactKeys(record, ["backend", "kind", "surface"])
    || record.backend !== backend
  ) {
    return false;
  }
  if (record.kind === "subscription-app-server") {
    return record.surface === "implementor"
      || record.surface === "plan-writer"
      || record.surface === "plan-reviewer"
      || record.surface === "environment-reviewer";
  }
  if (record.kind === "api-key-direct-cli") {
    return record.surface === "implementor"
      || record.surface === "plan-reviewer"
      || record.surface === "environment-reviewer";
  }
  return record.kind === "api-key-app-server" && record.surface === "plan-writer";
}

export function isCurrentLaunchProvenance(
  value: unknown,
): value is PlannerRunLaunchProvenance {
  if (!isExecutionPlacement(value) || Array.isArray(value)) return false;
  const record = value as unknown as Record<string, unknown>;
  const optionalKeys = [
    ...(record.claudeAuthMode === undefined ? [] : ["claudeAuthMode"]),
    ...(record.codexExecution === undefined ? [] : ["codexExecution"]),
  ];
  if (record.schemaVersion !== 1) return false;
  return (
    hasExactKeys(record, [
      "backend",
      "machineId",
      "schemaVersion",
      ...optionalKeys,
    ])
    && (
      record.claudeAuthMode === undefined
      || record.claudeAuthMode === "subscription"
      || record.claudeAuthMode === "api"
    )
    && (
      record.codexExecution === undefined
      || isStoredCodexExecution(
        record.codexExecution,
        record.backend as "cf" | "host",
      )
    )
  );
}

export function parseStoredLaunchProvenance<
  T extends PlannerRunLaunchProvenance = PlannerRunLaunchProvenance,
>(
  value: string | null,
  label: string,
): T | null {
  const parsed = parseStoredProvenance(value, label);
  if (parsed === null) return null;
  if (!isCurrentLaunchProvenance(parsed)) {
    throw new Error(`Malformed ${label} execution placement.`);
  }
  return parsed as T;
}

export function isCurrentPlannerRuntimeProvenance(
  value: unknown,
): value is PlannerRunRuntimeProvenance {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && hasExactKeys(value, ["jobSlug"])
    && typeof (value as { jobSlug?: unknown }).jobSlug === "string"
    && (value as { jobSlug: string }).jobSlug.trim()
  );
}

export function isCurrentPlanWriterRuntimeProvenance(
  value: unknown,
): value is PlanWriterRuntimeProvenance {
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && hasExactKeys(value, ["generation", "jobSlug"])
    && typeof (value as { jobSlug?: unknown }).jobSlug === "string"
    && (value as { jobSlug: string }).jobSlug.trim()
    && Number.isInteger((value as { generation?: unknown }).generation)
    && ((value as { generation: number }).generation >= 1)
  );
}

export function parseStoredRuntimeProvenance<
  T extends PlannerRunRuntimeProvenance = PlannerRunRuntimeProvenance,
>(
  value: string | null,
  label: string,
): T | null {
  const parsed = parseStoredProvenance(value, label);
  if (parsed === null) return null;
  if (!isCurrentPlannerRuntimeProvenance(parsed)) {
    throw new Error(`Malformed ${label} execution placement.`);
  }
  return parsed as T;
}

export function parseStoredPlanWriterRuntimeProvenance(
  value: string | null,
  label: string,
): PlanWriterRuntimeProvenance | null {
  const parsed = parseStoredProvenance(value, label);
  if (parsed === null) return null;
  if (!isCurrentPlanWriterRuntimeProvenance(parsed)) {
    throw new Error(`Malformed ${label} execution placement.`);
  }
  return parsed;
}
