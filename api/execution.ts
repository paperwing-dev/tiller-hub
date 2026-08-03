import type {
  Env,
  ExecutionPlacement,
  ExecutionSelection,
  ExecutionStatus,
  HostIncompatibilityCode,
  HostServiceRegistration,
  HostStatus,
  SelectedHostStatus,
  SetExecutionBackendRequest,
  SetExecutionBackendResult,
} from "./types";
import { classifyHostRuntimeCompatibility } from "./setup/runtime-compatibility";
import { getDurableObjectStub } from "./durable-object";

export const EXECUTION_SELECTION_KEY = "__private:execution_selection:v1";
export const EXECUTION_MIGRATION_KEY = "__private:execution_configuration_migration:v1";
export const LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY =
  "__private:legacy_custom_domain_cleanup:v1";

export const NEW_EXECUTION_UNAVAILABLE_MESSAGE =
  "The selected execution backend is unavailable. Choose another backend in Settings.";
export const EXISTING_EXECUTION_UNAVAILABLE_MESSAGE =
  "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.";
export const BACKEND_SELECTION_REMOVED_ERROR = {
  error: "Execution backend selection moved to Settings. Refresh or update this client.",
  code: "backend_selection_removed",
} as const;

export function backendSelectionRemovedError(
  value: unknown,
): typeof BACKEND_SELECTION_REMOVED_ERROR | null {
  return value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, "backend")
    ? BACKEND_SELECTION_REMOVED_ERROR
    : null;
}

export interface LegacyCustomDomainCleanupManifestV1 {
  version: 1;
  capturedAt: string;
  customHostname: string;
  workerService: string;
  accountId: string;
  zoneId: string;
  customDomainId: string;
  accessApplicationId: string;
  accessPolicyIds: string[];
}

export function parseLegacyCustomDomainCleanupManifest(
  value: unknown,
): LegacyCustomDomainCleanupManifestV1 | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const expectedKeys = [
    "accessApplicationId",
    "accessPolicyIds",
    "accountId",
    "capturedAt",
    "customDomainId",
    "customHostname",
    "version",
    "workerService",
    "zoneId",
  ];
  if (Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",")) return null;
  const requiredString = (key: string): string | null => {
    const candidate = record[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : null;
  };
  const capturedAt = requiredString("capturedAt");
  const customHostname = requiredString("customHostname");
  const workerService = requiredString("workerService");
  const accountId = requiredString("accountId");
  const zoneId = requiredString("zoneId");
  const customDomainId = requiredString("customDomainId");
  const accessApplicationId = requiredString("accessApplicationId");
  const accessPolicyIds = Array.isArray(record.accessPolicyIds)
    ? record.accessPolicyIds
        .map((candidate) => typeof candidate === "string" ? candidate.trim() : "")
        .filter(Boolean)
    : [];
  if (
    record.version !== 1
    || !capturedAt
    || !Number.isFinite(Date.parse(capturedAt))
    || !customHostname
    || !workerService
    || !accountId
    || !zoneId
    || !customDomainId
    || !accessApplicationId
    || accessPolicyIds.length === 0
    || accessPolicyIds.length !== (record.accessPolicyIds as unknown[]).length
    || new Set(accessPolicyIds).size !== accessPolicyIds.length
  ) {
    return null;
  }
  return {
    version: 1,
    capturedAt,
    customHostname,
    workerService,
    accountId,
    zoneId,
    customDomainId,
    accessApplicationId,
    accessPolicyIds,
  };
}

export function parseExecutionSelection(value: unknown): ExecutionSelection | null {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.target === "cf" && keys.join(",") === "target") {
    return { target: "cf" };
  }
  const machineId = typeof record.machineId === "string" ? record.machineId.trim() : "";
  if (
    record.target === "host"
    && machineId
    && keys.join(",") === "machineId,target"
  ) {
    return { target: "host", machineId };
  }
  return null;
}

export function selectionToPlacement(selection: ExecutionSelection): ExecutionPlacement {
  return selection.target === "cf"
    ? { backend: "cf", machineId: null }
    : { backend: "host", machineId: selection.machineId };
}

export function hostIncompatibilityCode(
  service: HostServiceRegistration,
): HostIncompatibilityCode | null {
  if (service.runnerCommandProtocol !== 1) return "runner_protocol";
  if (service.codexRuntimeAuthProtocol !== 1) return "runtime_auth_protocol";
  if (!classifyHostRuntimeCompatibility(service).compatible) return "runtime_image";
  return null;
}

export function hostStatusFromService(
  service: HostServiceRegistration | null,
): HostStatus {
  if (!service) return { state: "not_connected" };
  const code = hostIncompatibilityCode(service);
  return code
    ? {
        state: "incompatible",
        machineId: service.machineId,
        displayName: service.displayName,
        code,
      }
    : {
        state: "ready",
        machineId: service.machineId,
        displayName: service.displayName,
      };
}

export function deriveExecutionStatus(input: {
  selected: ExecutionSelection;
  candidate: HostStatus;
  selectedDisplayName?: string | null;
}): ExecutionStatus {
  let selectedHost: SelectedHostStatus | null = null;
  if (input.selected.target === "host") {
    selectedHost = input.candidate.state !== "not_connected"
      && input.candidate.machineId === input.selected.machineId
      ? input.candidate
      : {
          state: "offline",
          machineId: input.selected.machineId,
          displayName: input.selectedDisplayName?.trim() || input.selected.machineId,
        };
  }
  return {
    selected: input.selected,
    selectedHost,
    candidate: input.candidate,
    executionReady: input.selected.target === "cf"
      || selectedHost?.state === "ready",
  };
}

export function parseSetExecutionBackendRequest(
  value: unknown,
): SetExecutionBackendRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (record.target === "cf" && keys.join(",") === "target") {
    return { target: "cf" };
  }
  const expectedMachineId = typeof record.expectedMachineId === "string"
    ? record.expectedMachineId.trim()
    : "";
  if (
    record.target === "host"
    && expectedMachineId
    && keys.join(",") === "expectedMachineId,target"
  ) {
    return { target: "host", expectedMachineId };
  }
  return null;
}

export function executionSelectionConflict(
  status: ExecutionStatus,
): SetExecutionBackendResult {
  return {
    ok: false,
    code: "execution_candidate_changed",
    message: "The available machine changed or disconnected. Refresh Settings and try again.",
    status,
  };
}

interface ExecutionPlacementStore {
  getExecutionStatus(): Promise<ExecutionStatus>;
  resolveNewExecutionPlacement(): Promise<ExecutionPlacement>;
}

export function readExecutionStatus(env: Env): Promise<ExecutionStatus> {
  return getExecutionPlacementStore(env).getExecutionStatus();
}

function getExecutionPlacementStore(env: Env): ExecutionPlacementStore {
  return getDurableObjectStub<ExecutionPlacementStore>(env, env.HUB, "hub");
}

/** Linearizable choice point for a brand-new durable workload only. */
export function resolveNewExecutionPlacement(
  env: Env,
): Promise<ExecutionPlacement> {
  return getExecutionPlacementStore(env).resolveNewExecutionPlacement();
}
