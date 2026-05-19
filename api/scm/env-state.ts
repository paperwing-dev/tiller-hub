import { getEnvLifecycleStub } from "../helpers";
import { ensureRepoWorkspaceFromRepoUrl } from "../plan/store";
import type { Env, EnvMeta } from "../types";
import type { RepoScmOperationRecord, RepoScmOperationType } from "./repo-merge-lock-do";
import { matchesScmOperationProjection } from "./contracts";
import { getScmOperationStore } from "./operation-store";

export type PersistProjectedEnvMeta = (summaryMeta: EnvMeta) => Promise<EnvMeta | null>;

export function withScmOperationState(
  meta: EnvMeta,
  options: {
    type: RepoScmOperationType;
    operationId: string;
    phase: string;
    startedAt?: string;
  },
): EnvMeta {
  const startedAt = options.startedAt ?? meta.scmOperationStartedAt ?? new Date().toISOString();
  return {
    ...meta,
    scmOperationType: options.type,
    scmOperationId: options.operationId,
    scmOperationPhase: options.phase,
    scmOperationStartedAt: startedAt,
    scmOperationUpdatedAt: new Date().toISOString(),
  };
}

export function clearScmOperationState(
  meta: EnvMeta,
  options?: {
    completedAt?: string;
    durationMs?: number | null;
    timings?: string | null;
  },
): EnvMeta {
  return {
    ...meta,
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: options?.completedAt ?? meta.scmLastCompletedAt ?? null,
    scmLastDurationMs: options?.durationMs ?? meta.scmLastDurationMs ?? null,
    scmLastTimings: options?.timings ?? meta.scmLastTimings ?? null,
  };
}

export function matchesEnvScmOperation(
  meta: Pick<EnvMeta, "scmOperationId" | "scmOperationType">,
  operation: Pick<RepoScmOperationRecord, "operationId" | "type">,
): boolean {
  return meta.scmOperationId === operation.operationId && meta.scmOperationType === operation.type;
}

export function isActivePendingScmOperationForEnv(
  meta: Pick<EnvMeta, "slug" | "scmOperationId" | "scmOperationType">,
  operation: RepoScmOperationRecord | null,
): operation is RepoScmOperationRecord {
  return !!operation && operation.status === "pending" && matchesScmOperationProjection(meta, operation);
}

export async function reconcileEnvScmOperationState(
  env: Env,
  meta: EnvMeta,
  persistProjected: PersistProjectedEnvMeta,
): Promise<EnvMeta> {
  if (!meta.scmOperationType) {
    return meta;
  }

  const operationId = meta.scmOperationId?.trim();
  if (!operationId) {
    const completedAt = meta.scmOperationUpdatedAt ?? new Date().toISOString();
    await getEnvLifecycleStub(env, meta.slug).clearScmProjection({ completedAt }).catch(() => {});
    return (await persistProjected(meta)) ?? clearScmOperationState(meta, { completedAt });
  }

  try {
    const repoId = meta.repoId ?? (await ensureRepoWorkspaceFromRepoUrl(env, meta.repoUrl)).meta.repoId;
    const store = getScmOperationStore(env, repoId);
    const operation = await store.getOperation(operationId);
    if (isActivePendingScmOperationForEnv(meta, operation)) {
      return meta;
    }

    const completedAt = operation?.updatedAt ?? meta.scmOperationUpdatedAt ?? new Date().toISOString();
    await getEnvLifecycleStub(env, meta.slug).clearScmProjection({ completedAt }).catch(() => {});
    return (await persistProjected(meta)) ?? clearScmOperationState(meta, { completedAt });
  } catch {
    return meta;
  }
}
