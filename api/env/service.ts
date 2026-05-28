import { getEnvLifecycleStub, getLocationHintOptions, getWorkspaceStub } from "../helpers";
import type { HubDO } from "../hub";
import type { EnvDefinition, EnvLifecycleState, Env, EnvMeta } from "../types";
import {
  getEnvDefinitionKey,
  persistEnvSummary,
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
import {
  reconcileEnvScmOperationState as reconcileEnvScmOperationStateInternal,
  reconcileEnvScmOperationStateForRead,
} from "../scm/env-state";
import { revokeCodexGatewaySessionsForEnv } from "../gateway-session";
import { revokeGitHubBridgesForInteractiveEnv } from "../github/bridge";
import { envExists, loadEnvView } from "./view";

export { buildEnvMetaFromLayers } from "./state";
export { envExists, listEnvViews, loadEnvView } from "./view";

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
    repoId: meta.repoId,
    backend: meta.backend,
    harness: meta.harness,
    ...(meta.authMode ? { authMode: meta.authMode } : {}),
    ...(meta.resolvedAuthMode ? { resolvedAuthMode: meta.resolvedAuthMode } : {}),
    ...(meta.codexAuthPreference ? { codexAuthPreference: meta.codexAuthPreference } : {}),
    ...(meta.codexAuthMode ? { codexAuthMode: meta.codexAuthMode } : {}),
    ...(meta.opencodeProvider ? { opencodeProvider: meta.opencodeProvider } : {}),
    ...(meta.opencodeModel ? { opencodeModel: meta.opencodeModel } : {}),
    ...(meta.modelRoute ? { modelRoute: meta.modelRoute } : {}),
    startupPlanId: meta.startupPlanId,
    branchName: meta.branchName,
    createdAt: meta.createdAt,
  };
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
  const stub = getEnvLifecycleStub(env, meta.slug);
  return await stub.getState();
}

export async function projectAndPersistEnvSummary(
  env: Env,
  hub: Pick<HubDO, "broadcastEnvUpsert">,
  slug: string,
  options?: {
    broadcast?: boolean;
  },
): Promise<EnvMeta | null> {
  if (!(await envExists(env, slug))) {
    return null;
  }
  const meta = await loadEnvView(env, slug);
  if (!meta) {
    return null;
  }

  await persistEnvSummary(env, meta);
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
    })
  ) ?? meta;
}

export async function reconcileEnvScmOperationState(
  env: Env,
  meta: EnvMeta,
  _options?: { persist?: boolean },
): Promise<EnvMeta> {
  return await reconcileEnvScmOperationStateInternal(env, meta, async (projectedMeta) => {
    return await projectAndPersistEnvSummary(env, getHub(env), projectedMeta.slug, {
      broadcast: false,
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
  return await reconcileEnvScmOperationStateForRead(env, meta);
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
  await revokeCodexGatewaySessionsForEnv(env, meta.slug).catch((err) => {
    console.error(`[envs] Failed to revoke Codex gateway sessions for ${meta.slug}:`, err instanceof Error ? err.message : String(err));
  });
  await revokeGitHubBridgesForInteractiveEnv(env, meta.slug).catch((err) => {
    console.error(`[envs] Failed to revoke GitHub bridge records for ${meta.slug}:`, err instanceof Error ? err.message : String(err));
  });
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
