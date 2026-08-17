import {
  getEnvLifecycleStub,
  getEnvReviewStub,
  getWorkspaceStub,
} from "../helpers";
import type { HubDO } from "../hub";
import type { EnvDefinition, EnvLifecycleState, Env, EnvMeta, RunnerCommandClaim } from "../types";
import { getEnvDefinitionKey } from "../plan/store";
import { getRunnerBackend } from "./runner-backends";
import {
  inspectRunnerBackend,
  runRunnerMutationWithGenerationReconciliation,
  type RebaseRejectedRunnerCommand,
} from "./runner-backend";
import { normalizeRunnerStatus } from "./status";
import {
  buildEnvSnapshotsPrefix,
  deleteScmArtifact,
  parseEnvSnapshotIdFromKey,
} from "../scm/artifacts";
import { deleteReviewSnapshotArtifacts } from "../env-review/snapshots";
import { requireExplicitStoredEnvMeta } from "../sync/projectors";
import { listManagedSessionIdsForEnv } from "../session-attachment";
import { revokeGitHubBridgesForInteractiveEnv } from "../github/bridge";
import { getDurableObjectStub } from "../durable-object";
import { projectRuntimeFailure } from "./runtime-failure";

export { buildEnvMetaFromLayers } from "./state";
export { envExists, envSlugReserved, listEnvViews, loadEnvView } from "./view";

export function getHub(
  env: Env,
): Pick<
  HubDO,
  | "broadcastEnvUpsert"
  | "broadcastEnvRemove"
  | "broadcastRepoUpsert"
  | "broadcastRepoMainChange"
  | "broadcastPlanArtifactUpdated"
  | "addMessage"
  | "getAllSessions"
  | "getRoutableSessionIds"
  | "deleteSession"
> {
  return getDurableObjectStub<Pick<
    HubDO,
    | "broadcastEnvUpsert"
    | "broadcastEnvRemove"
    | "broadcastRepoUpsert"
    | "broadcastRepoMainChange"
    | "broadcastPlanArtifactUpdated"
    | "addMessage"
    | "getAllSessions"
    | "getRoutableSessionIds"
    | "deleteSession"
  >>(env, env.HUB, "hub");
}

export function clearEnvError(meta: EnvMeta): EnvMeta {
  const next = { ...meta };
  delete next.error;
  delete next.errorAt;
  return next;
}

export function parseEnvMeta(raw: string): EnvMeta {
  return requireExplicitStoredEnvMeta(JSON.parse(raw) as EnvMeta);
}

export function buildEnvDefinition(meta: EnvMeta): EnvDefinition {
  if (
    !meta.incarnationId?.trim()
    || meta.scmModel !== "github"
    || !meta.executionPlacement
  ) {
    throw new Error(
      `Environment ${meta.slug} is missing immutable workload identity or execution placement.`,
    );
  }
  return {
    slug: meta.slug,
    ...(meta.displayName ? { displayName: meta.displayName } : {}),
    incarnationId: meta.incarnationId,
    ...(meta.sidebarSlot ? { sidebarSlot: meta.sidebarSlot } : {}),
    repoId: meta.repoId,
    scmModel: meta.scmModel,
    executionPlacement: meta.executionPlacement,
    harness: meta.harness,
    ...(meta.resolvedAuthMode ? { resolvedAuthMode: meta.resolvedAuthMode } : {}),
    ...(meta.codexAuthMode ? { codexAuthMode: meta.codexAuthMode } : {}),
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
  await deleteReviewSnapshotArtifacts(bucket, envSlug);
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
  _hub: Pick<HubDO, "broadcastEnvUpsert">,
  slug: string,
  options?: {
    broadcast?: boolean;
  },
): Promise<EnvMeta | null> {
  return getEnvLifecycleStub(env, slug).persistOwnedProjection({
    broadcast: options?.broadcast !== false,
  });
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

export async function projectEnvMetaForAction(
  env: Env,
  meta: EnvMeta,
  backend: Awaited<ReturnType<typeof getRunnerBackend>>,
): Promise<{ meta: EnvMeta; liveStatus: string }> {
  const inspection = await inspectRunnerBackend(backend, meta);
  const liveStatus = normalizeRunnerStatus(inspection.status);
  const projectedMeta = await projectEnvMetaWithLifecycle(env, meta);

  return {
    meta: projectedMeta,
    liveStatus,
  };
}

export async function projectEnvMetaForRead(
  env: Env,
  meta: EnvMeta,
): Promise<EnvMeta> {
  // Host runners can retain an unacknowledged writable layer after their
  // process stops, so ordinary reads must never infer that they are safe to
  // replace. Cloudflare sandboxes have no such layer: WorkspaceDO is their
  // durable state, and a non-running container is rehydrated on the next
  // Start. Reconcile only an already-ready runtime so a concurrent initial
  // Start cannot be failed while the container is still being dispatched.
  if (
    meta.backend !== "cf"
    || meta.status !== "running"
    || meta.lifecyclePhase !== "running"
    || !meta.lifecycleOpId
  ) {
    return meta;
  }

  const inspection = await (async () => {
    try {
      const backend = await getRunnerBackend(env, "cf");
      return await inspectRunnerBackend(backend, meta);
    } catch {
      // A transient control-plane failure is not proof that the container is
      // gone. Leave the lifecycle untouched and try again on a later read.
      return null;
    }
  })();
  if (!inspection || inspection.state !== "absent") {
    return meta;
  }

  const lifecycleStub = getEnvLifecycleStub(env, meta.slug);
  const lifecycle = await lifecycleStub.getState();
  if (
    lifecycle?.phase !== "running"
    || lifecycle.activeOpId !== meta.lifecycleOpId
  ) {
    return (await projectAndPersistEnvSummary(env, getHub(env), meta.slug, {
      broadcast: false,
    })) ?? meta;
  }

  const failure = projectRuntimeFailure(
    "runtime_stopped_unexpectedly",
    { runnerState: inspection.state, runnerStatus: inspection.status },
    {
      slug: meta.slug,
      opId: lifecycle.activeOpId,
      source: "cloudflare-runner-read-reconciliation",
    },
  );
  await lifecycleStub.noteRunnerStopped(lifecycle.activeOpId, failure.message);
  return (await projectAndPersistEnvSummary(env, getHub(env), meta.slug)) ?? meta;
}

/**
 * Destroy a single environment. The assigned host runner is confirmed absent
 * before any workspace, snapshot, session, or definition data is removed.
 * Caller is responsible for marking the env as "deleting" beforehand.
 */
export async function destroyEnv(
  env: Env,
  meta: EnvMeta,
  hub: Pick<HubDO, "broadcastEnvRemove" | "getAllSessions" | "deleteSession">,
  options?: {
    broadcast?: boolean;
    runnerCommand?: RunnerCommandClaim;
    rebaseRunnerCommand?: RebaseRejectedRunnerCommand;
    skipRunnerDestroy?: boolean;
  },
): Promise<void> {
  await revokeGitHubBridgesForInteractiveEnv(env, meta.slug).catch((err) => {
    console.error(`[envs] Failed to revoke GitHub bridge records for ${meta.slug}:`, err instanceof Error ? err.message : String(err));
  });
  if (!options?.skipRunnerDestroy) {
    const backend = await getRunnerBackend(env, meta.backend);
    if (meta.backend === "host") {
      if (options?.runnerCommand && options.rebaseRunnerCommand) {
        await runRunnerMutationWithGenerationReconciliation(
          options.runnerCommand,
          options.rebaseRunnerCommand,
          (runnerCommand) => backend.destroy(meta, { runnerCommand }),
        );
      } else {
        await backend.destroy(meta, options?.runnerCommand ? { runnerCommand: options.runnerCommand } : undefined);
      }
    } else {
      try {
        await backend.destroy(meta);
      } catch (err) {
        console.error(`[envs] Cloudflare runner destroy failed for ${meta.slug}, continuing durable cleanup:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
  // Review history is removed only after every one-shot runtime has confirmed
  // absence. This keeps an offline assigned machine from being hidden by
  // deleting the environment's discoverable definition.
  const attachedSessionIds = listManagedSessionIdsForEnv(
    await hub.getAllSessions(),
    meta.slug,
  );
  await getEnvReviewStub(env, meta.slug).finalizeEnvironmentDeletion(attachedSessionIds);
  const workspaceStub = getWorkspaceStub(env, meta.slug);
  await workspaceStub.destroyWorkspace();
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
  // Lifecycle finalization is the durable success boundary for a fenced
  // Delete. Propagate failure so the caller can abort the deletion and restore
  // visibility for an idempotent retry; swallowing it can leave mutable state
  // reserving an otherwise invisible slug forever.
  await getEnvLifecycleStub(env, meta.slug).finalizeDeletion();
  // The definition is the discoverable ownership record and is removed last.
  await env.ENVS_KV.delete(getEnvDefinitionKey(meta.slug));
  if (options?.broadcast !== false) {
    await hub.broadcastEnvRemove(meta.slug);
  }
}
