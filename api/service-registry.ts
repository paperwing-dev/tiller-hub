import type {
  Env,
  HostServiceRegistration,
} from "./types";
import { getDurableObjectStub } from "./durable-object";

type HubServiceRegistry = {
  getHostService(machineId?: string | null): HostServiceRegistration | null | Promise<HostServiceRegistration | null>;
  getRoutableHostService(preferredMachineId?: string | null): HostServiceRegistration | null | Promise<HostServiceRegistration | null>;
  isHostRoutable(preferredMachineId?: string | null): boolean | Promise<boolean>;
};

function getHub(env: Env): HubServiceRegistry | null {
  if (!env.HUB) return null;
  return getDurableObjectStub<HubServiceRegistry>(env, env.HUB, "hub");
}

function normalizeHostService(service: HostServiceRegistration | null | undefined): HostServiceRegistration | null {
  if (!service) return null;

  const machineId = service.machineId?.trim?.() ?? "";
  if (!machineId) return null;
  const displayName = service.displayName?.trim?.() || machineId;
  const localRunnerImage = service.localRunnerImage?.trim();
  const localRunnerImageSourceId = service.localRunnerImageSourceId?.trim();

  return {
    ...(service as HostServiceRegistration),
    machineId,
    displayName,
    ...(localRunnerImage ? { localRunnerImage } : {}),
    ...(localRunnerImageSourceId ? { localRunnerImageSourceId } : {}),
  };
}

export async function readRegisteredHostService(
  env: Env,
  machineId?: string | null,
): Promise<HostServiceRegistration | null> {
  const hub = getHub(env);
  if (!hub) return null;

  const preferredMachineId = machineId?.trim() || null;
  return normalizeHostService(await hub.getHostService(preferredMachineId));
}

export async function readRoutableHostService(
  env: Env,
  preferredMachineId?: string | null,
): Promise<HostServiceRegistration | null> {
  const hub = getHub(env);
  if (!hub) return null;

  return normalizeHostService(await hub.getRoutableHostService(preferredMachineId ?? null));
}

export async function isHostRoutable(env: Env, preferredMachineId?: string | null): Promise<boolean> {
  const hub = getHub(env);
  if (!hub) return false;
  return Boolean(await hub.isHostRoutable(preferredMachineId ?? null));
}
