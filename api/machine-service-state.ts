import type { MachineServiceKey, MachineServiceState } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isMachineUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value.trim());
}

function parseHostServiceState(value: Record<string, unknown>): MachineServiceState["host"] {
  const machineId = typeof value.machineId === "string" ? value.machineId.trim() : "";
  const displayName = typeof value.displayName === "string" && value.displayName.trim()
    ? value.displayName.trim()
    : machineId;
  const localRunnerImage = typeof value.localRunnerImage === "string" && value.localRunnerImage.trim()
    ? value.localRunnerImage.trim()
    : undefined;
  const localRunnerImageSourceId = typeof value.localRunnerImageSourceId === "string" && value.localRunnerImageSourceId.trim()
    ? value.localRunnerImageSourceId.trim()
    : undefined;

  return {
    machineId,
    displayName,
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : "",
    ...(value.runnerCommandProtocol === 1 ? { runnerCommandProtocol: 1 as const } : {}),
    ...(value.codexRuntimeAuthProtocol === 1 ? { codexRuntimeAuthProtocol: 1 as const } : {}),
    ...(value.reviewerIsolationProtocol === 1 ? { reviewerIsolationProtocol: 1 as const } : {}),
    dockerAvailable: value.dockerAvailable === true,
    runnerAvailable: value.runnerAvailable === true,
    claudeSubscription: value.claudeSubscription === true,
    ...(localRunnerImage ? { localRunnerImage } : {}),
    ...(localRunnerImageSourceId ? { localRunnerImageSourceId } : {}),
    transport: "session",
  };
}

export function parseMachineServiceState(raw: unknown): MachineServiceState {
  let value = raw;

  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return {};
    }
  }

  if (!isRecord(value)) {
    return {};
  }

  const state: MachineServiceState = {};
  if (isRecord(value.host)) {
    state.host = parseHostServiceState(value.host);
  }

  return state;
}

export function mergeMachineServiceState(
  current: MachineServiceState,
  patch: unknown,
): MachineServiceState {
  return {
    ...current,
    ...parseMachineServiceState(patch),
  };
}

export function getMachineServiceKeys(raw: unknown): MachineServiceKey[] {
  const state = parseMachineServiceState(raw);
  return (["host"] as const).filter((key) => Boolean(state[key]));
}
