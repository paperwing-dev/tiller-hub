import type { Env } from "../types";
import { readRegisteredHostService, readRoutableHostService } from "../service-registry";

export interface HostStatusMachine {
  machineId: string;
  connectedAt: string;
  gatewayUrl?: string;
  gatewayTunnelType?: "quick" | "named";
  codexSubscription: boolean;
  claudeSubscription: boolean;
}

export type HostStatusState =
  | "not-registered"
  | "registered-offline"
  | "connected-no-gateway"
  | "gateway-unavailable"
  | "gateway-available";

export interface HostStatusPayload {
  registered: boolean;
  connected: boolean;
  gatewayConfigured: boolean;
  gatewayAvailable: boolean;
  state: HostStatusState;
  machine: HostStatusMachine | null;
}

function resolveHostStatusState(
  registered: boolean,
  connected: boolean,
  gatewayConfigured: boolean,
  gatewayAvailable: boolean,
): HostStatusState {
  if (!registered) {
    return "not-registered";
  }
  if (!connected) {
    return "registered-offline";
  }
  if (!gatewayConfigured) {
    return "connected-no-gateway";
  }
  if (!gatewayAvailable) {
    return "gateway-unavailable";
  }
  return "gateway-available";
}

export async function resolveHostStatus(env: Env): Promise<HostStatusPayload> {
  const registeredHost = await readRegisteredHostService(env);
  if (!registeredHost) {
    return {
      registered: false,
      connected: false,
      gatewayConfigured: false,
      gatewayAvailable: false,
      state: "not-registered",
      machine: null,
    };
  }

  const routableHost = await readRoutableHostService(env, registeredHost.machineId);
  const connected = Boolean(routableHost);
  const gatewayConfigured = Boolean(registeredHost.gatewayUrl?.trim());
  const gatewayAvailable = Boolean(routableHost?.gatewayUrl?.trim());

  return {
    registered: true,
    connected,
    gatewayConfigured,
    gatewayAvailable,
    state: resolveHostStatusState(true, connected, gatewayConfigured, gatewayAvailable),
    machine: {
      machineId: registeredHost.machineId,
      connectedAt: registeredHost.connectedAt,
      ...(registeredHost.gatewayUrl ? { gatewayUrl: registeredHost.gatewayUrl } : {}),
      ...(registeredHost.gatewayTunnelType ? { gatewayTunnelType: registeredHost.gatewayTunnelType } : {}),
      codexSubscription: Boolean(registeredHost.codexSubscription),
      claudeSubscription: Boolean(registeredHost.claudeSubscription),
    },
  };
}
