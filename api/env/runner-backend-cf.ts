import { getSandboxStub } from "../helpers";
import { getIdleTimeoutMinutes } from "../setup/config";
import type {
  EnvironmentRuntimeScope,
  RunnerBackend,
  RunnerStartOptions,
  RunnerStopOptions,
} from "./runner-backend";
import type { Env, EnvMeta } from "../types";

export function createCloudflareRunnerBackend(env: Env): RunnerBackend {
  const runtimeScope = (
    meta: EnvMeta,
    options?: RunnerStartOptions,
  ): EnvironmentRuntimeScope => {
    const startOperationId = options?.startOpId?.trim() ?? "";
    if (!startOperationId || !meta.incarnationId?.trim()) {
      throw new Error("Cloudflare runner start requires an exact runtime scope.");
    }
    return {
      envSlug: meta.slug,
      incarnationId: meta.incarnationId,
      startOperationId,
    };
  };
  const inspect = async (meta: EnvMeta) => {
    try {
      const stub = getSandboxStub(env, meta.slug);
      const status = await stub.getStatus();
      // Cloudflare's sandbox owner has no stopped Docker layer to preserve:
      // a non-running container is rehydrated from WorkspaceDO on Start.
      return status === "stopped" || status === "exited" || status === "dead"
        ? { state: "absent" as const, status }
        : status === "running" || status === "healthy" || status === "paused"
          ? { state: "live" as const, status }
          : { state: "unknown" as const, status: status || "unknown" };
    } catch {
      return { state: "unknown" as const, status: "unknown" };
    }
  };

  return {
    kind: "cf",

    async create(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: RunnerStartOptions,
    ): Promise<EnvMeta> {
      const stub = getSandboxStub(env, meta.slug);
      const timeout = await getIdleTimeoutMinutes(env);
      const scope = runtimeScope(meta, options);
      await stub.startSandbox(
        meta.slug,
        {
          ...envVars,
          TILLER_LIFECYCLE_START_OP_ID: scope.startOperationId,
        },
        timeout,
        scope,
      );
      const runnerId = meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "cf",
        runnerId,
      };
    },

    inspect,

    async getStatus(meta: EnvMeta): Promise<string> {
      return (await inspect(meta)).status;
    },

    async start(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: RunnerStartOptions,
    ): Promise<EnvMeta> {
      const stub = getSandboxStub(env, meta.slug);
      const timeout = await getIdleTimeoutMinutes(env);
      const scope = runtimeScope(meta, options);
      await stub.startSandbox(
        meta.slug,
        {
          ...envVars,
          TILLER_LIFECYCLE_START_OP_ID: scope.startOperationId,
        },
        timeout,
        scope,
      );
      const runnerId = meta.runnerId ?? meta.slug;
      return {
        ...meta,
        backend: "cf",
        runnerId,
      };
    },

    async stop(meta: EnvMeta, options?: RunnerStopOptions) {
      const scope = options?.stopScope;
      const stopOpId = options?.stopOpId?.trim() ?? "";
      if (!scope || !stopOpId || scope.stopOperationId !== stopOpId) {
        throw new Error("Cloudflare runner stop requires an exact Stop scope.");
      }
      const stub = getSandboxStub(env, meta.slug);
      const prepared = await stub.prepareWorkspaceStop(
        scope,
        options?.idleClaimId ?? null,
      );
      if (prepared.status === "absent-unprepared") {
        return {
          callbackExpected: false,
          workspacePreparationUnavailable: true,
        };
      }
      return {
        callbackExpected: true,
        workspaceStopReceipt: prepared.receipt,
      };
    },

    async schedulePreparedStop(meta, scope) {
      return await getSandboxStub(env, meta.slug).schedulePreparedTermination(scope);
    },

    async destroy(meta: EnvMeta): Promise<void> {
      const stub = getSandboxStub(env, meta.slug);
      await stub.destroySandbox();
    },
  };
}
