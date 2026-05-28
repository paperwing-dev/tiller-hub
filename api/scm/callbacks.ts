import { getEnvLifecycleStub, getWorkspaceStub } from "../helpers";
import {
  commitRepoMainState,
  persistRepoMeta,
} from "../plan/store";
import type { Env, EnvMeta, RepoMeta } from "../types";
import {
  loadRepo,
  shouldFailPendingOperationForRepoAccessCode,
  type RepoWorkspace,
} from "../repo/access";
import { buildEnvScmMetaPatch } from "../env-lifecycle";
import { TREE_HASH_EXCLUDES } from "../env/launch-config";
import { getHub, projectAndPersistEnvSummary } from "../env/service";
import {
  buildRepoGitArtifactKey,
  headScmArtifact,
} from "./artifacts";
import {
  ScmMergedRepoBroadcast,
  ScmServiceResult,
  type ScmCallbackOutcome,
} from "./contracts";
import { isActivePendingScmOperationForEnv } from "./env-state";
import { getScmOperationStore, type ScmOperationStore } from "./operation-store";
import type { RepoScmOperationResult } from "./repo-merge-lock-do";
import { revokeGitHubBridgesForScmOperation } from "../github/bridge";

export type ScmCallbackResult = ScmServiceResult<Record<string, unknown>, ScmCallbackOutcome> & {
  mergedRepoBroadcast?: ScmMergedRepoBroadcast;
};

type RepoForEnvMetaResult =
  | { ok: true; repo: RepoWorkspace }
  | {
      ok: false;
      status: number;
      body: Record<string, unknown>;
      failOperation: boolean;
      error: string;
    };

export type ScmFailureInput = {
  message: string;
  durationMs: number | null;
  timings: string | null;
};

export type ScmResultInput = {
  action: string | null;
  message: string | null;
  conflictCount: number | null;
  gitHead: string | null;
  durationMs: number | null;
  timings: string | null;
  mergedTar: Uint8Array;
  sourceEnvMatchesMain: boolean | null;
};

function skippedBody(operationId: string): Record<string, unknown> {
  return {
    ok: true,
    operationId,
    skipped: true,
  };
}

function skippedOutcome(
  operationId: string,
  kind: "progress" | "result" | "failed" | "heartbeat",
  reason: "stale" | "duplicate" | "not-found",
): ScmCallbackOutcome {
  return { outcome: "skipped", operationId, kind, reason };
}

async function readProjectedEnvMeta(env: Env, slug: string) {
  return await projectAndPersistEnvSummary(env, getHub(env), slug, {
    broadcast: false,
  });
}

async function clearProjectionAndPersist(
  env: Env,
  slug: string,
  options?: {
    completedAt?: string;
    durationMs?: number | null;
    timings?: string | null;
  },
) {
  await getEnvLifecycleStub(env, slug).clearScmProjection(options);
  await projectAndPersistEnvSummary(env, getHub(env), slug).catch(() => {});
}

type ScmProjectionCleanupOptions = {
  completedAt?: string;
  durationMs?: number | null;
  timings?: string | null;
};

async function failScmOperationAndCleanup(args: {
  env: Env;
  slug: string;
  store: ScmOperationStore;
  repoId: string;
  operationId: string;
  error: string;
  projection: ScmProjectionCleanupOptions;
  mergeLockToken?: string | null;
  result?: RepoScmOperationResult | null;
}): Promise<void> {
  await clearProjectionAndPersist(args.env, args.slug, args.projection);
  await args.store.failOperation({
    operationId: args.operationId,
    error: args.error,
    ...(args.result !== undefined ? { result: args.result } : {}),
  }).catch(() => {});
  await revokeGitHubBridgesForScmOperation(args.env, {
    repoId: args.repoId,
    operationId: args.operationId,
  }).catch(() => {});
  if (args.mergeLockToken) {
    await args.store.releaseMergeLock(args.mergeLockToken).catch(() => {});
  }
}

async function completeScmOperationAndCleanup(args: {
  env: Env;
  slug: string;
  store: ScmOperationStore;
  repoId: string;
  operationId: string;
  result: RepoScmOperationResult;
  projection: ScmProjectionCleanupOptions;
  mergeLockToken?: string | null;
}): Promise<void> {
  await clearProjectionAndPersist(args.env, args.slug, args.projection);
  await args.store.completeOperation({
    operationId: args.operationId,
    result: args.result,
  });
  await revokeGitHubBridgesForScmOperation(args.env, {
    repoId: args.repoId,
    operationId: args.operationId,
  }).catch(() => {});
  if (args.mergeLockToken) {
    await args.store.releaseMergeLock(args.mergeLockToken).catch(() => {});
  }
}

async function readRepoForEnvMeta(env: Env, meta: EnvMeta): Promise<RepoForEnvMetaResult> {
  const loadedRepo = await loadRepo(env, meta.repoId, "selected-write");
  if (loadedRepo.ok) {
    return loadedRepo;
  }
  const code = typeof loadedRepo.body.code === "string" ? loadedRepo.body.code : "";
  const message = typeof loadedRepo.body.error === "string" ? loadedRepo.body.error : "Repo is unavailable.";
  return {
    ...loadedRepo,
    failOperation: shouldFailPendingOperationForRepoAccessCode(code),
    error: message,
  };
}

async function failPendingOperationForUnavailableRepo(
  env: Env,
  slug: string,
  meta: EnvMeta,
  operationId: string,
  error: string,
): Promise<void> {
  if (!meta.repoId) return;
  const store = getScmOperationStore(env, meta.repoId);
  const operation = await store.getOperation(operationId).catch(() => null);
  if (!operation || operation.envSlug !== slug || operation.status !== "pending") return;
  await failScmOperationAndCleanup({
    env,
    slug,
    store,
    repoId: meta.repoId,
    operationId,
    error,
    projection: {
      completedAt: new Date().toISOString(),
    },
  });
}

async function repoUnavailableResult(
  env: Env,
  slug: string,
  meta: EnvMeta,
  operationId: string,
  kind: "progress" | "result" | "failed" | "heartbeat",
  unavailable: Extract<RepoForEnvMetaResult, { ok: false }>,
): Promise<ScmCallbackResult> {
  if (unavailable.failOperation) {
    await failPendingOperationForUnavailableRepo(env, slug, meta, operationId, unavailable.error);
  }
  return {
    status: unavailable.status,
    body: unavailable.body,
    outcome: unavailable.failOperation
      ? { outcome: "failed", operationId, error: unavailable.error }
      : skippedOutcome(operationId, kind, "not-found"),
  };
}

export async function handleScmProgressCallback(
  env: Env,
  slug: string,
  operationId: string,
  phase: string,
): Promise<ScmCallbackResult> {
  const meta = await readProjectedEnvMeta(env, slug);
  if (!meta) {
    return {
      status: 404,
      body: { error: "Not found" },
      outcome: skippedOutcome(operationId, "progress", "not-found"),
    };
  }

  const loadedRepo = await readRepoForEnvMeta(env, meta);
  if (!loadedRepo.ok) return await repoUnavailableResult(env, slug, meta, operationId, "progress", loadedRepo);
  const repo = loadedRepo.repo;
  const store = getScmOperationStore(env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (!operation || operation.envSlug !== slug) {
    return {
      status: 404,
      body: { error: "SCM operation not found" },
      outcome: skippedOutcome(operationId, "progress", "not-found"),
    };
  }

  const latestMeta = (await readProjectedEnvMeta(env, slug)) ?? meta;
  if (!isActivePendingScmOperationForEnv(latestMeta, operation)) {
    return {
      status: 200,
      body: {
        ok: true,
        slug,
        operationId,
        skipped: true,
      },
      outcome: skippedOutcome(operationId, "progress", "stale"),
    };
  }

  await getEnvLifecycleStub(env, slug).setScmProjection({
    type: operation.type,
    operationId,
    phase,
    startedAt: latestMeta.scmOperationStartedAt ?? operation.createdAt,
  });
  await projectAndPersistEnvSummary(env, getHub(env), slug);

  return {
    status: 200,
    body: { ok: true, slug, operationId, phase },
    outcome: { outcome: "progressed", operationId, phase },
  };
}

export async function handleScmFailedCallback(
  env: Env,
  slug: string,
  operationId: string,
  input: ScmFailureInput,
): Promise<ScmCallbackResult> {
  const meta = await readProjectedEnvMeta(env, slug);
  if (!meta) {
    return {
      status: 404,
      body: { error: "Not found" },
      outcome: skippedOutcome(operationId, "failed", "not-found"),
    };
  }

  const loadedRepo = await readRepoForEnvMeta(env, meta);
  if (!loadedRepo.ok) return await repoUnavailableResult(env, slug, meta, operationId, "failed", loadedRepo);
  const repo = loadedRepo.repo;
  const store = getScmOperationStore(env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (!operation || operation.envSlug !== slug) {
    return {
      status: 200,
      body: skippedBody(operationId),
      outcome: skippedOutcome(operationId, "failed", "not-found"),
    };
  }

  const latestMeta = (await readProjectedEnvMeta(env, slug)) ?? meta;
  if (!isActivePendingScmOperationForEnv(latestMeta, operation)) {
    return {
      status: 200,
      body: skippedBody(operationId),
      outcome: skippedOutcome(operationId, "failed", "stale"),
    };
  }

  const completedAt = new Date().toISOString();
  await failScmOperationAndCleanup({
    env,
    slug,
    store,
    repoId: repo.meta.repoId,
    operationId,
    error: input.message || "SCM operation failed before reporting a result.",
    projection: {
      completedAt,
      durationMs: input.durationMs,
      timings: input.timings,
    },
    mergeLockToken:
      operation.type === "merge-into-main" || operation.type === "update-from-main"
        ? operation.mergeLockToken
        : null,
  });

  const latestOperation = await store.getOperation(operationId);
  const error = latestOperation?.error ?? operation.error ?? input.message;
  return {
    status: 200,
    body: {
      ok: true,
      operationId,
      status: latestOperation?.status ?? operation.status,
      error,
    },
    outcome: { outcome: "failed", operationId, error },
  };
}

export async function handleScmResultCallback(
  env: Env,
  slug: string,
  operationId: string,
  input: ScmResultInput,
): Promise<ScmCallbackResult> {
  const meta = await readProjectedEnvMeta(env, slug);
  if (!meta) {
    return {
      status: 404,
      body: { error: "Not found" },
      outcome: skippedOutcome(operationId, "result", "not-found"),
    };
  }

  const loadedRepo = await readRepoForEnvMeta(env, meta);
  if (!loadedRepo.ok) return await repoUnavailableResult(env, slug, meta, operationId, "result", loadedRepo);
  const repo = loadedRepo.repo;
  const store = getScmOperationStore(env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (!operation || operation.envSlug !== slug) {
    return {
      status: 404,
      body: { error: "SCM operation not found" },
      outcome: skippedOutcome(operationId, "result", "not-found"),
    };
  }

  const latestMeta = (await readProjectedEnvMeta(env, slug)) ?? meta;
  if (!isActivePendingScmOperationForEnv(latestMeta, operation)) {
    return {
      status: 200,
      body: skippedBody(operationId),
      outcome: skippedOutcome(operationId, "result", "stale"),
    };
  }

  const completedAt = new Date().toISOString();
  const hub = getHub(env);

  const currentLock = await store.getMergeLock();
  if (!currentLock || currentLock.token !== operation.mergeLockToken || currentLock.operationId !== operationId) {
    await failScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      error: "SCM lock expired before the operation result could be committed.",
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
    });
    return {
      status: 409,
      body: { error: "SCM lock expired before commit" },
      outcome: { outcome: "failed", operationId, error: "SCM lock expired before commit" },
    };
  }

  if (operation.type === "update-from-main") {
    const currentMainCommit = input.gitHead ?? repo.meta.mainCommit ?? null;

    if (input.action === "updated-from-main") {
      const sourceEnvMatchesMain = input.sourceEnvMatchesMain === true;
      try {
        await getEnvLifecycleStub(env, slug).setScmProjection({
          type: "update-from-main",
          operationId,
          phase: "Saving updated environment",
          startedAt: latestMeta.scmOperationStartedAt ?? operation.createdAt,
        });
        await projectAndPersistEnvSummary(env, hub, slug);

        await getWorkspaceStub(env, slug).restoreFromTar(input.mergedTar, {
          clearFirst: true,
          preservePrefixes: TREE_HASH_EXCLUDES,
        });

        await getEnvLifecycleStub(env, slug).recordStopWorkspaceSynced(
          buildEnvScmMetaPatch(latestMeta, {
            workspaceDirty: !sourceEnvMatchesMain,
            workspaceNeedsAttention: false,
            baseMainCommit: currentMainCommit,
            lastKnownMainCommit: currentMainCommit,
            branchStatus: sourceEnvMatchesMain ? "up-to-date" : "ready-to-merge",
          }),
          { clearError: true },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to save updated environment.";
        await failScmOperationAndCleanup({
          env,
          slug,
          store,
          repoId: repo.meta.repoId,
          operationId,
          error: message,
          projection: {
            completedAt,
            durationMs: input.durationMs,
            timings: input.timings,
          },
          mergeLockToken: currentLock.token,
        });
        return {
          status: 502,
          body: { error: "Failed to save updated environment" },
          outcome: { outcome: "failed", operationId, error: message },
        };
      }
      await completeScmOperationAndCleanup({
        env,
        slug,
        store,
        repoId: repo.meta.repoId,
        operationId,
        result: {
          action: "updated-from-main",
          repoId: repo.meta.repoId,
          currentMainCommit,
        },
        projection: {
          completedAt,
          durationMs: input.durationMs,
          timings: input.timings,
        },
        mergeLockToken: currentLock.token,
      });
      return {
        status: 200,
        body: {
          ok: true,
          operationId,
          action: "updated-from-main",
          currentMainCommit,
          branchStatus: sourceEnvMatchesMain ? "up-to-date" : "ready-to-merge",
        },
        outcome: { outcome: "updated", operationId },
      };
    }

    if (input.action === "up-to-date") {
      await getEnvLifecycleStub(env, slug).recordStopWorkspaceSynced(
        buildEnvScmMetaPatch(latestMeta, {
          workspaceDirty: false,
          workspaceNeedsAttention: false,
          baseMainCommit: currentMainCommit,
          lastKnownMainCommit: currentMainCommit,
          branchStatus: "up-to-date",
        }),
        { clearError: true },
      );
      await completeScmOperationAndCleanup({
        env,
        slug,
        store,
        repoId: repo.meta.repoId,
        operationId,
        result: {
          action: "up-to-date",
          repoId: repo.meta.repoId,
          currentMainCommit,
        },
        projection: {
          completedAt,
          durationMs: input.durationMs,
          timings: input.timings,
        },
        mergeLockToken: currentLock.token,
      });
      return {
        status: 200,
        body: { ok: true, operationId, action: "up-to-date", currentMainCommit },
        outcome: { outcome: "updated", operationId },
      };
    }

    await getEnvLifecycleStub(env, slug).recordStopWorkspaceSynced(
      buildEnvScmMetaPatch(latestMeta, {
        workspaceDirty: true,
        workspaceNeedsAttention: true,
        lastKnownMainCommit: currentMainCommit,
        branchStatus: "needs-attention",
      }),
    );
    await completeScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      result: {
        action: input.action ?? "conflicted",
        message: input.message,
        conflictCount: input.conflictCount,
        currentMainCommit,
      },
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 200,
      body: {
        ok: true,
        operationId,
        action: input.action ?? "conflicted",
        currentMainCommit,
      },
      outcome: { outcome: "conflicted", operationId },
    };
  }

  if (input.action === "already-current") {
    const currentMainCommit = input.gitHead ?? repo.meta.mainCommit ?? null;
    const sourceEnvMatchesMain = input.sourceEnvMatchesMain === true;
    await getEnvLifecycleStub(env, slug).recordStopWorkspaceSynced(
      buildEnvScmMetaPatch(
        latestMeta,
        sourceEnvMatchesMain
          ? {
              workspaceDirty: false,
              workspaceNeedsAttention: false,
              baseMainCommit: currentMainCommit,
              lastKnownMainCommit: currentMainCommit,
              branchStatus: "up-to-date",
            }
          : {
              workspaceDirty: false,
              workspaceNeedsAttention: false,
              lastKnownMainCommit: currentMainCommit,
              branchStatus:
                latestMeta.baseMainCommit && currentMainCommit && latestMeta.baseMainCommit !== currentMainCommit
                  ? "behind-main"
                  : "up-to-date",
            },
      ),
      { clearError: true },
    );
    await completeScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      result: {
        action: "already-current",
        currentMainCommit,
      },
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 200,
      body: {
        ok: true,
        operationId,
        action: "already-current",
        currentMainCommit,
      },
      outcome: { outcome: "updated", operationId },
    };
  }

  if (input.action !== "merged") {
    await completeScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      result: {
        action: input.action ?? "conflicted",
        message: input.message,
        conflictCount: input.conflictCount,
      },
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 200,
      body: { ok: true, operationId, action: input.action ?? "conflicted" },
      outcome: { outcome: "conflicted", operationId },
    };
  }

  if (!operation.gitArtifactId || !input.gitHead) {
    await failScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      error: "Merge result is missing the staged git artifact or git head.",
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 400,
      body: { error: "Missing staged git artifact or git head" },
      outcome: { outcome: "failed", operationId, error: "Missing staged git artifact or git head" },
    };
  }

  const stagedArtifact = await headScmArtifact(
    env.BUCKET,
    buildRepoGitArtifactKey({
      repoId: repo.meta.repoId,
      generationId: operation.gitArtifactId,
    }),
  );
  if (!stagedArtifact) {
    await failScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      error: "Merge result is missing the staged canonical git artifact.",
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 409,
      body: { error: "Missing staged canonical git artifact" },
      outcome: { outcome: "failed", operationId, error: "Missing staged canonical git artifact" },
    };
  }
  if (stagedArtifact.customMetadata?.operationId !== operationId) {
    await failScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      error: "Staged canonical git artifact did not match the active merge operation.",
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 409,
      body: { error: "Staged canonical git artifact did not match the active merge operation" },
      outcome: {
        outcome: "failed",
        operationId,
        error: "Staged canonical git artifact did not match the active merge operation",
      },
    };
  }

  let previousRepoTar: Uint8Array | null = null;
  const previousMainCommit = repo.meta.mainCommit;
  let nextRepoMeta: RepoMeta;

  await getEnvLifecycleStub(env, slug).setScmProjection({
    type: "merge-into-main",
    operationId,
    phase: "Committing main",
    startedAt: latestMeta.scmOperationStartedAt ?? operation.createdAt,
  });
  await projectAndPersistEnvSummary(env, hub, slug);

  try {
    previousRepoTar = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
    await repo.workspace.restoreFromTar(input.mergedTar, {
      clearFirst: true,
      preservePrefixes: ["/.tiller"],
    });
    nextRepoMeta = await commitRepoMainState({
      env,
      workspace: repo.workspace,
      meta: repo.meta,
      mainCommit: input.gitHead,
      sourceEnvSlug: slug,
      metaOverrides: {
        gitArtifactId: operation.gitArtifactId,
        gitStatus: "ready",
      },
    });
  } catch (error) {
    console.error(`[envs] Failed to commit merged main for ${slug}:`, error);
    if (previousRepoTar) {
      try {
        await repo.workspace.restoreFromTar(previousRepoTar, {
          clearFirst: true,
          preservePrefixes: ["/.tiller"],
        });
        await persistRepoMeta(env, repo.workspace, repo.meta);
      } catch (rollbackError) {
        console.error(`[envs] Failed to roll back canonical repo state for ${slug}:`, rollbackError);
      }
    }
    const message = error instanceof Error ? error.message : "Failed to commit merged main state.";
    await failScmOperationAndCleanup({
      env,
      slug,
      store,
      repoId: repo.meta.repoId,
      operationId,
      error: message,
      projection: {
        completedAt,
        durationMs: input.durationMs,
        timings: input.timings,
      },
      mergeLockToken: currentLock.token,
    });
    return {
      status: 502,
      body: { error: "Failed to commit merged main state" },
      outcome: { outcome: "failed", operationId, error: message },
    };
  }

  const sourceEnvMatchesMain = input.sourceEnvMatchesMain === true;
  await getEnvLifecycleStub(env, slug).recordStopWorkspaceSynced(
    buildEnvScmMetaPatch(
      latestMeta,
      sourceEnvMatchesMain
        ? {
            workspaceDirty: false,
            workspaceNeedsAttention: false,
            baseMainCommit: nextRepoMeta.mainCommit,
            lastKnownMainCommit: nextRepoMeta.mainCommit,
            branchStatus: "up-to-date",
          }
        : {
            workspaceDirty: true,
            workspaceNeedsAttention: false,
            baseMainCommit: latestMeta.baseMainCommit ?? latestMeta.lastKnownMainCommit ?? previousMainCommit ?? null,
            lastKnownMainCommit: nextRepoMeta.mainCommit,
            branchStatus: "behind-main",
          },
    ),
    { clearError: true },
  );
  await completeScmOperationAndCleanup({
    env,
    slug,
    store,
    repoId: repo.meta.repoId,
    operationId,
    result: {
      action: "merged",
      repoId: nextRepoMeta.repoId,
      previousMainCommit,
      currentMainCommit: nextRepoMeta.mainCommit,
    },
    projection: {
      completedAt,
      durationMs: input.durationMs,
      timings: input.timings,
    },
    mergeLockToken: currentLock.token,
  });

  return {
    status: 200,
    body: { ok: true, operationId, action: "merged" },
    outcome: { outcome: "merged", operationId },
    mergedRepoBroadcast: {
      slug,
      previousMainCommit,
      nextRepoMeta,
    },
  };
}

export async function handleScmHeartbeatCallback(
  env: Env,
  slug: string,
  operationId: string,
  token: string | null,
): Promise<ScmCallbackResult> {
  const meta = await readProjectedEnvMeta(env, slug);
  if (!meta) {
    return {
      status: 404,
      body: { error: "Not found" },
      outcome: skippedOutcome(operationId, "heartbeat", "not-found"),
    };
  }

  const loadedRepo = await readRepoForEnvMeta(env, meta);
  if (!loadedRepo.ok) return await repoUnavailableResult(env, slug, meta, operationId, "heartbeat", loadedRepo);
  const repo = loadedRepo.repo;
  const store = getScmOperationStore(env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (!operation || operation.envSlug !== slug) {
    return {
      status: 404,
      body: { error: "SCM operation not found" },
      outcome: skippedOutcome(operationId, "heartbeat", "not-found"),
    };
  }
  if (
    (operation.type !== "merge-into-main" && operation.type !== "update-from-main") ||
    !operation.mergeLockToken
  ) {
    return {
      status: 409,
      body: { error: "Heartbeat is only available for locked SCM operations" },
      outcome: {
        outcome: "failed",
        operationId,
        error: "Heartbeat is only available for locked SCM operations",
      },
    };
  }
  if (!token || token !== operation.mergeLockToken) {
    return {
      status: 409,
      body: { error: "Invalid merge lock token" },
      outcome: { outcome: "failed", operationId, error: "Invalid merge lock token" },
    };
  }

  const result = await store.heartbeatMergeLock(token);
  if (!result.ok) {
    return {
      status: 409,
      body: { error: "Merge lock is no longer held" },
      outcome: { outcome: "failed", operationId, error: "Merge lock is no longer held" },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      operationId,
      expiresAt: result.lock.expiresAt,
      heartbeatAt: result.lock.heartbeatAt,
    },
    outcome: {
      outcome: "heartbeat",
      operationId,
      expiresAt: result.lock.expiresAt,
      heartbeatAt: result.lock.heartbeatAt,
    },
  };
}
