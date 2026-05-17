import type { MachineServiceKey, MachineServiceState } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseHostServiceState(value: Record<string, unknown>): MachineServiceState["host"] {
  const gatewayPort = typeof value.gatewayPort === "number" && Number.isFinite(value.gatewayPort)
    ? value.gatewayPort
    : undefined;
  const gatewayUrl = typeof value.gatewayUrl === "string" && value.gatewayUrl.trim()
    ? value.gatewayUrl
    : undefined;
  const gatewayTunnelType = value.gatewayTunnelType === "quick" || value.gatewayTunnelType === "named"
    ? value.gatewayTunnelType
    : undefined;
  const gatewayServiceTokenHash = typeof value.gatewayServiceTokenHash === "string" && value.gatewayServiceTokenHash.trim()
    ? value.gatewayServiceTokenHash.trim()
    : undefined;
  const codexGatewayAuth = value.codexGatewayAuth === "session-token" ? value.codexGatewayAuth : undefined;

  return {
    machineId: typeof value.machineId === "string" ? value.machineId : "",
    connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : "",
    dockerAvailable: value.dockerAvailable === true,
    codexSubscription: value.codexSubscription === true,
    ...(codexGatewayAuth ? { codexGatewayAuth } : {}),
    claudeSubscription: value.claudeSubscription === true,
    ...(gatewayPort !== undefined ? { gatewayPort } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(gatewayServiceTokenHash ? { gatewayServiceTokenHash } : {}),
    ...(gatewayTunnelType ? { gatewayTunnelType } : {}),
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

export function clearMachineServiceKeys(
  current: MachineServiceState,
  keys: Iterable<MachineServiceKey>,
): MachineServiceState {
  const next: MachineServiceState = { ...current };
  for (const key of keys) {
    delete next[key];
  }
  return next;
}
