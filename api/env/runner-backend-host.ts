import type { RunnerBackend } from "./runner-backend";
import { getLocationHintOptions } from "../helpers";
import type { Env, EnvMeta, RunnerControlAction } from "../types";

interface HostRunnerStatus {
  runnerId?: string;
  status?: string;
  callbackExpected?: boolean;
}

interface HubRunnerControl {
  requestLocalRunner(
    machineId: string | null,
    action: RunnerControlAction,
    slug: string,
    options?: {
      repoUrl?: string;
      envVars?: Record<string, string>;
      startOpId?: string;
      stopOpId?: string;
    },
  ): Promise<{ machineId: string; result: unknown }>;
}

function getHub(env: Env): HubRunnerControl {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as HubRunnerControl;
}

function parseHostRunnerStatus(value: unknown): HostRunnerStatus {
  if (!value || typeof value !== "object") return {};
  const result = value as Record<string, unknown>;
  return {
    ...(typeof result.runnerId === "string" ? { runnerId: result.runnerId } : {}),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.callbackExpected === "boolean" ? { callbackExpected: result.callbackExpected } : {}),
  };
}

function resolveRunnerMachineId(meta: EnvMeta): string | null {
  const machineId = meta.runnerMachineId?.trim();
  return machineId || null;
}

async function requestHostRunner(
  env: Env,
  action: RunnerControlAction,
  meta: Pick<EnvMeta, "slug" | "repoUrl" | "runnerMachineId">,
  options?: {
    envVars?: Record<string, string>;
    startOpId?: string | null;
    stopOpId?: string | null;
  },
): Promise<{ machineId: string; result: unknown }> {
  return getHub(env).requestLocalRunner(resolveRunnerMachineId(meta), action, meta.slug, {
    ...(options?.envVars ? { envVars: options.envVars } : {}),
    ...(action === "create" || action === "start" ? { repoUrl: meta.repoUrl } : {}),
    ...(options?.startOpId?.trim() ? { startOpId: options.startOpId.trim() } : {}),
    ...(options?.stopOpId?.trim() ? { stopOpId: options.stopOpId.trim() } : {}),
  });
}

export async function createHostRunnerBackend(env: Env): Promise<RunnerBackend> {
  return {
    kind: "host",

    async create(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: { startOpId?: string | null },
    ): Promise<EnvMeta> {
      const response = await requestHostRunner(env, "create", meta, {
        envVars,
        startOpId: options?.startOpId ?? null,
      });
      const result = parseHostRunnerStatus(response.result);
      const runnerId = result.runnerId ?? meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "host",
        runnerId,
        runnerMachineId: response.machineId,
      };
    },

    async getStatus(meta: EnvMeta): Promise<string> {
      try {
        const response = await requestHostRunner(env, "status", meta);
        const result = parseHostRunnerStatus(response.result);
        return result.status ?? "unknown";
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/404/.test(message) || /not found/i.test(message)) {
          return "stopped";
        }
        throw new Error(`Tiller Host status failed: ${message}`);
      }
    },

    async start(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: { startOpId?: string | null },
    ): Promise<EnvMeta> {
      const response = await requestHostRunner(env, "start", meta, {
        envVars,
        startOpId: options?.startOpId ?? null,
      });
      const result = parseHostRunnerStatus(response.result);
      const runnerId = result.runnerId ?? meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "host",
        runnerId,
        runnerMachineId: response.machineId,
      };
    },

    async stop(meta: EnvMeta, options?: { stopOpId?: string | null }) {
      try {
        const response = await requestHostRunner(env, "stop", meta, {
          stopOpId: options?.stopOpId ?? null,
        });
        const result = parseHostRunnerStatus(response.result);
        return {
          callbackExpected: result.callbackExpected ?? true,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/404/.test(message) || /not found/i.test(message)) {
          return { callbackExpected: false };
        }
        throw new Error(`Tiller Host stop failed: ${message}`);
      }
    },

    async destroy(meta: EnvMeta): Promise<void> {
      try {
        await requestHostRunner(env, "destroy", meta);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/404/.test(message) || /not found/i.test(message)) {
          return;
        }
        throw new Error(`Tiller Host destroy failed: ${message}`);
      }
    },
  };
}
