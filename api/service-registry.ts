import { getLocationHintOptions } from "./helpers";
import type {
  Env,
  HostServiceRegistration,
} from "./types";

type HubServiceRegistry = {
  getActiveService(kind: "host"): HostServiceRegistration | null | Promise<HostServiceRegistration | null>;
  getHostService?(machineId?: string | null): HostServiceRegistration | null | Promise<HostServiceRegistration | null>;
  getRoutableHostService?(preferredMachineId?: string | null): HostServiceRegistration | null | Promise<HostServiceRegistration | null>;
  isHostRoutable(preferredMachineId?: string | null): boolean | Promise<boolean>;
};

function getHub(env: Env): HubServiceRegistry | null {
  if (!env.HUB) return null;
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as HubServiceRegistry;
}

function normalizeServiceUrl(url: string | undefined): string | null {
  const normalized = url?.trim() ?? "";
  return normalized || null;
}

function normalizeHostService(service: HostServiceRegistration | null | undefined): HostServiceRegistration | null {
  if (!service) return null;

  const machineId = service.machineId?.trim?.() ?? "";
  const gatewayPort = Number.isFinite(service.gatewayPort) ? Number(service.gatewayPort) : 0;
  if (!machineId) return null;
  const gatewayUrl = normalizeServiceUrl(service.gatewayUrl);
  const gatewayServiceTokenHash = service.gatewayServiceTokenHash?.trim();
  const codexGatewayAuth = service.codexGatewayAuth === "session-token" ? service.codexGatewayAuth : undefined;

  return {
    ...(service as HostServiceRegistration),
    machineId,
    ...(gatewayPort > 0 ? { gatewayPort } : {}),
    ...(gatewayUrl ? { gatewayUrl } : {}),
    ...(gatewayServiceTokenHash ? { gatewayServiceTokenHash } : {}),
    ...(codexGatewayAuth ? { codexGatewayAuth } : {}),
  };
}

async function readRegisteredService(
  env: Env,
  kind: "host",
  machineId?: string | null,
): Promise<HostServiceRegistration | null> {
  const hub = getHub(env);
  if (!hub) return null;

  const preferredMachineId = machineId?.trim() || null;
  if (preferredMachineId && typeof hub.getHostService === "function") {
    return normalizeHostService(await hub.getHostService(preferredMachineId));
  }

  const service = await hub.getActiveService(kind as any);
  const normalized = normalizeHostService(service);
  if (preferredMachineId && normalized?.machineId !== preferredMachineId) {
    return null;
  }
  return normalized;
}

export async function readRegisteredHostService(
  env: Env,
  machineId?: string | null,
): Promise<HostServiceRegistration | null> {
  return readRegisteredService(env, "host", machineId ?? null);
}

export async function readRoutableHostService(
  env: Env,
  preferredMachineId?: string | null,
): Promise<HostServiceRegistration | null> {
  const hub = getHub(env);
  if (!hub) return null;

  if (typeof hub.getRoutableHostService === "function") {
    return normalizeHostService(await hub.getRoutableHostService(preferredMachineId ?? null));
  }

  const service = await readRegisteredHostService(env, preferredMachineId ?? null);
  if (!service) {
    return null;
  }
  return (await isHostRoutable(env, service.machineId)) ? service : null;
}

export async function isHostRoutable(env: Env, preferredMachineId?: string | null): Promise<boolean> {
  const hub = getHub(env);
  if (!hub) return false;
  return Boolean(await hub.isHostRoutable(preferredMachineId ?? null));
}

export function isQuickTunnelUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".trycloudflare.com");
  } catch {
    return false;
  }
}
