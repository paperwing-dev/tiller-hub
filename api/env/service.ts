import { getEnvLifecycleStub, getLocationHintOptions, getWorkspaceStub } from "../helpers";
import type { HubDO } from "../hub";
import type { EnvDefinition, EnvLifecycleState, Env, EnvMeta, EnvMutableState } from "../types";
import {
  getEnvDefinitionKey,
  persistEnvDefinition,
  readEnvDefinition,
  readEnvSummary,
} from "../plan/store";
import { getRunnerBackend } from "./runner-backends";
import { normalizeRunnerStatus } from "./status";
import {
  buildEnvSnapshotsPrefix,
  deleteScmArtifact,
  parseEnvSnapshotIdFromKey,
} from "../scm/artifacts";
import {
  requireExplicitStoredEnvMeta,
  projectEnvSummary,
} from "../sync/projectors";
import { listManagedSessionIdsForEnv } from "../session-attachment";
import { reconcileEnvScmOperationState as reconcileEnvScmOperationStateInternal } from "../scm/env-state";

export function getHub(
  env: Env,
): Pick<
  HubDO,
  | "broadcastEnvUpsert"
  | "broadcastEnvRemove"
  | "broadcastRepoUpsert"
  | "broadcastRepoMainChange"
  | "addMessage"
  | "getAllSessions"
  | "deleteSession"
> {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as Pick<
    HubDO,
    | "broadcastEnvUpsert"
    | "broadcastEnvRemove"
    | "broadcastRepoUpsert"
    | "broadcastRepoMainChange"
    | "addMessage"
    | "getAllSessions"
    | "deleteSession"
  >;
}

export function clearEnvError(meta: EnvMeta): EnvMeta {
  const next = { ...meta };
  delete next.error;
  delete next.errorAt;
  return next;
}

export function clearAuthWarning(meta: EnvMeta): EnvMeta {
  const next = { ...meta };
  delete next.authWarning;
  return next;
}

export function parseEnvMeta(raw: string): EnvMeta {
  return requireExplicitStoredEnvMeta(JSON.parse(raw) as EnvMeta);
}

export function buildEnvDefinition(meta: EnvMeta): EnvDefinition {
  return {
    slug: meta.slug,
    repoUrl: meta.repoUrl,
    ...(meta.repoId ? { repoId: meta.repoId } : {}),
    backend: meta.backend,
    harness: meta.harness,
    ...(meta.authMode ? { authMode: meta.authMode } : {}),
    ...(meta.resolvedAuthMode ? { resolvedAuthMode: meta.resolvedAuthMode } : {}),
    ...(meta.codexAuthMode ? { codexAuthMode: meta.codexAuthMode } : {}),
    ...(meta.opencodeProvider ? { opencodeProvider: meta.opencodeProvider } : {}),
    ...(meta.opencodeModel ? { opencodeModel: meta.opencodeModel } : {}),
    ...(meta.modelRoute ? { modelRoute: meta.modelRoute } : {}),
    startupPlanId: meta.startupPlanId,
    branchName: meta.branchName,
    createdAt: meta.createdAt,
  };
}

function createFallbackMutableState(definition: EnvDefinition): EnvMutableState {
  return {
    status: "unknown",
    lifecyclePhase: null,
    lifecycleOpId: null,
    lifecycleOperation: null,
    lifecycleDesiredState: null,
    lifecycleLastRunnerState: null,
    lifecycleLastWorkspaceSyncedAckOpId: null,
    lifecycleInfraState: "unknown",
    lifecycleRuntimeReady: false,
    lifecycleUpdatedAt: null,
    runnerId: null,
    runnerMachineId: null,
    bootMessage: null,
    bootStepId: null,
    authWarning: null,
    branchStatus: null,
    workspaceDirty: null,
    workspaceNeedsAttention: null,
    workspaceLastSyncedAt: null,
    baseMainCommit: null,
    lastKnownMainCommit: null,
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    leadHarnessStatus: null,
    leadHarnessError: null,
    leadHarnessUpdatedAt: null,
    error: null,
    errorAt: null,
    updatedAt: definition.createdAt,
  };
}

function buildEnvMetaFromLayers(
  definition: EnvDefinition,
  mutableState: EnvMutableState,
): EnvMeta {
  const next: EnvMeta = {
    slug: definition.slug,
    repoUrl: definition.repoUrl,
    ...(definition.repoId ? { repoId: definition.repoId } : {}),
    backend: definition.backend,
    ...(mutableState.runnerId ? { runnerId: mutableState.runnerId } : {}),
    ...(mutableState.runnerMachineId ? { runnerMachineId: mutableState.runnerMachineId } : {}),
    harness: definition.harness,
    ...(definition.authMode ? { authMode: definition.authMode } : {}),
    ...(definition.resolvedAuthMode ? { resolvedAuthMode: definition.resolvedAuthMode } : {}),
    ...(definition.codexAuthMode ? { codexAuthMode: definition.codexAuthMode } : {}),
    ...(definition.opencodeProvider ? { opencodeProvider: definition.opencodeProvider } : {}),
    ...(definition.opencodeModel ? { opencodeModel: definition.opencodeModel } : {}),
    ...(definition.modelRoute ? { modelRoute: definition.modelRoute } : {}),
    ...(mutableState.authWarning ? { authWarning: mutableState.authWarning } : {}),
    createdAt: definition.createdAt,
    updatedAt: mutableState.updatedAt,
    status: mutableState.status,
    ...(mutableState.bootMessage ? { bootMessage: mutableState.bootMessage } : {}),
    bootStepId: mutableState.bootStepId,
    startupPlanId: definition.startupPlanId,
    branchName: definition.branchName,
    branchStatus: mutableState.branchStatus,
    workspaceDirty: mutableState.workspaceDirty,
    workspaceNeedsAttention: mutableState.workspaceNeedsAttention,
    workspaceLastSyncedAt: mutableState.workspaceLastSyncedAt,
    baseMainCommit: mutableState.baseMainCommit,
    lastKnownMainCommit: mutableState.lastKnownMainCommit,
    scmOperationType: mutableState.scmOperationType,
    scmOperationId: mutableState.scmOperationId,
    scmOperationPhase: mutableState.scmOperationPhase,
    scmOperationStartedAt: mutableState.scmOperationStartedAt,
    scmOperationUpdatedAt: mutableState.scmOperationUpdatedAt,
    scmLastCompletedAt: mutableState.scmLastCompletedAt,
    scmLastDurationMs: mutableState.scmLastDurationMs,
    scmLastTimings: mutableState.scmLastTimings,
    lifecyclePhase: mutableState.lifecyclePhase,
    lifecycleOpId: mutableState.lifecycleOpId,
    lifecycleOperation: mutableState.lifecycleOperation,
    lifecycleDesiredState: mutableState.lifecycleDesiredState,
    lifecycleInfraState: mutableState.lifecycleInfraState,
    lifecycleRuntimeReady: mutableState.lifecycleRuntimeReady,
    lifecycleUpdatedAt: mutableState.lifecycleUpdatedAt,
    leadHarnessStatus: mutableState.leadHarnessStatus,
    leadHarnessError: mutableState.leadHarnessError,
    leadHarnessUpdatedAt: mutableState.leadHarnessUpdatedAt,
    ...(mutableState.error ? { error: mutableState.error } : {}),
    ...(mutableState.errorAt ? { errorAt: mutableState.errorAt } : {}),
  };

  return projectEnvSummary(next);
}

async function ensureEnvAuthority(
  env: Env,
  slug: string,
  options?: { summaryMeta?: EnvMeta | null },
): Promise<{ definition: EnvDefinition; mutableState: EnvMutableState } | null> {
  const lifecycleStub = getEnvLifecycleStub(env, slug);
  const definition = await readEnvDefinition(env, slug);
  if (!definition) {
    return null;
  }

  const existingMutableState = await lifecycleStub.getMutableState();
  if (existingMutableState) {
    return { definition, mutableState: existingMutableState };
  }

  const summaryMeta = options?.summaryMeta ?? await readEnvSummary(env, slug);
  const mutableState = summaryMeta
    ? await lifecycleStub.hydrateFromSummary(summaryMeta)
    : createFallbackMutableState(definition);
  return { definition, mutableState };
}

async function composeCurrentEnvMeta(
  env: Env,
  slug: string,
  options?: { summaryMeta?: EnvMeta | null },
): Promise<EnvMeta | null> {
  const authority = await ensureEnvAuthority(env, slug, options);
  if (!authority) {
    return null;
  }

  return buildEnvMetaFromLayers(authority.definition, authority.mutableState);
}

export async function deleteEnvSnapshotArtifacts(
  bucket: R2Bucket,
  envSlug: string,
  keepSnapshotIds: Iterable<string> = [],
): Promise<void> {
  const keep = new Set<string>();
  for (const snapshotId of keepSnapshotIds) {
    if (snapshotId) {
      keep.add(snapshotId);
    }
  }

  const prefix = buildEnvSnapshotsPrefix(envSlug);
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ prefix, cursor });
    await Promise.all(
      listed.objects.map((object) => {
        const snapshotId = parseEnvSnapshotIdFromKey(object.key, envSlug);
        if (snapshotId && keep.has(snapshotId)) {
          return Promise.resolve();
        }
        return deleteScmArtifact(bucket, object.key).catch(() => {});
      }),
    );
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
}

export async function readLifecycleState(
  env: Env,
  meta: EnvMeta,
): Promise<EnvLifecycleState | null> {
  await ensureEnvAuthority(env, meta.slug, { summaryMeta: meta });
  const stub = getEnvLifecycleStub(env, meta.slug);
  return await stub.getState();
}

export async function projectAndPersistEnvSummary(
  env: Env,
  hub: Pick<HubDO, "broadcastEnvUpsert">,
  slug: string,
  options?: {
    broadcast?: boolean;
    summaryMeta?: EnvMeta | null;
  },
): Promise<EnvMeta | null> {
  const meta = await composeCurrentEnvMeta(env, slug, {
    summaryMeta: options?.summaryMeta ?? null,
  });
  if (!meta) {
    return null;
  }

  await env.ENVS_KV.put(meta.slug, JSON.stringify(meta));
  if (options?.broadcast !== false) {
    await hub.broadcastEnvUpsert(projectEnvSummary(meta));
  }
  return meta;
}

export async function projectEnvMetaWithLifecycle(
  env: Env,
  meta: EnvMeta,
): Promise<EnvMeta> {
  return (
    await projectAndPersistEnvSummary(env, getHub(env), meta.slug, {
      broadcast: false,
      summaryMeta: meta,
    })
  ) ?? meta;
}

export async function reconcileEnvScmOperationState(
  env: Env,
  meta: EnvMeta,
  _options?: { persist?: boolean },
): Promise<EnvMeta> {
  return await reconcileEnvScmOperationStateInternal(env, meta, async (summaryMeta) => {
    return await projectAndPersistEnvSummary(env, getHub(env), summaryMeta.slug, {
      broadcast: false,
      summaryMeta,
    });
  });
}

export async function projectEnvMetaForAction(
  env: Env,
  meta: EnvMeta,
  backend: Awaited<ReturnType<typeof getRunnerBackend>>,
): Promise<{ meta: EnvMeta; liveStatus: string }> {
  const liveStatus = normalizeRunnerStatus(await backend.getStatus(meta).catch(() => "unknown"));
  const projectedMeta = await projectEnvMetaWithLifecycle(env, meta);
  const reconciledMeta = await reconcileEnvScmOperationState(env, projectedMeta);

  return {
    meta: reconciledMeta,
    liveStatus,
  };
}

export async function projectEnvMetaForRead(
  env: Env,
  meta: EnvMeta,
): Promise<EnvMeta> {
  return await reconcileEnvScmOperationState(
    env,
    await projectEnvMetaWithLifecycle(env, meta),
  );
}

/**
 * Destroy a single environment: workspace DO, runner backend, KV entry, then broadcast "deleted".
 * Caller is responsible for marking the env as "deleting" beforehand.
 */
export async function destroyEnv(
  env: Env,
  meta: EnvMeta,
  hub: Pick<HubDO, "broadcastEnvRemove" | "getAllSessions" | "deleteSession">,
  options?: { broadcast?: boolean },
): Promise<void> {
  const workspaceStub = getWorkspaceStub(env, meta.slug);
  await workspaceStub.destroyWorkspace();
  try {
    const backend = await getRunnerBackend(env, meta.backend);
    await backend.destroy(meta);
  } catch (err) {
    // Host may be unavailable. Still clean up the KV entry so the env does not become a zombie.
    console.error(`[envs] Backend destroy failed for ${meta.slug}, cleaning up anyway:`, err instanceof Error ? err.message : String(err));
  }
  const attachedSessionIds = listManagedSessionIdsForEnv(await hub.getAllSessions(), meta.slug);
  if (attachedSessionIds.length > 0) {
    await Promise.all(attachedSessionIds.map(async (sessionId) => {
      try {
        await hub.deleteSession(sessionId);
      } catch {
        // Ignore sessions already cleaned up elsewhere.
      }
    }));
  }
  await deleteEnvSnapshotArtifacts(env.BUCKET, meta.slug);
  await env.ENVS_KV.delete(meta.slug);
  await env.ENVS_KV.delete(getEnvDefinitionKey(meta.slug));
  await getEnvLifecycleStub(env, meta.slug).clearMutableState().catch(() => {});
  if (options?.broadcast !== false) {
    await hub.broadcastEnvRemove(meta.slug);
  }
}
