import { getSandboxStub } from "../helpers";
import { getIdleTimeoutMinutes } from "../setup/config";
import type { RunnerBackend } from "./runner-backend";
import type { Env, EnvMeta } from "../types";

export function createCloudflareRunnerBackend(env: Env): RunnerBackend {
  return {
    kind: "cf",

    async create(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: { startOpId?: string | null },
    ): Promise<EnvMeta> {
      const stub = getSandboxStub(env, meta.slug);
      const timeout = await getIdleTimeoutMinutes(env);
      const startOpId = options?.startOpId?.trim() || null;
      await stub.startSandbox(
        meta.slug,
        {
          ...envVars,
          ...(startOpId ? { TILLER_LIFECYCLE_START_OP_ID: startOpId } : {}),
        },
        timeout,
        startOpId,
      );
      const runnerId = meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "cf",
        runnerId,
      };
    },

    async getStatus(meta: EnvMeta): Promise<string> {
      if (meta.error) return "failed";
      try {
        const stub = getSandboxStub(env, meta.slug);
        return await stub.getStatus();
      } catch {
        return "unknown";
      }
    },

    async start(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: { startOpId?: string | null },
    ): Promise<EnvMeta> {
      const stub = getSandboxStub(env, meta.slug);
      const timeout = await getIdleTimeoutMinutes(env);
      const startOpId = options?.startOpId?.trim() || null;
      await stub.startSandbox(
        meta.slug,
        {
          ...envVars,
          ...(startOpId ? { TILLER_LIFECYCLE_START_OP_ID: startOpId } : {}),
        },
        timeout,
        startOpId,
      );
      const runnerId = meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "cf",
        runnerId,
      };
    },

    async stop(meta: EnvMeta, options?: { stopOpId?: string | null }) {
      const stub = getSandboxStub(env, meta.slug);
      await stub.stopSandbox(options?.stopOpId ?? null);
      return { callbackExpected: true };
    },

    async destroy(meta: EnvMeta): Promise<void> {
      const stub = getSandboxStub(env, meta.slug);
      await stub.destroySandbox();
    },
  };
}
