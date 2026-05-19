import { getEnvLifecycleStub, getScmOperationStub } from "../helpers";
import { ensureRepoWorkspaceFromRepoUrl } from "../plan/store";
import type { Env, EnvMeta } from "../types";
import { isLocalOnlyRunnerBackendMode, resolveScmRunnerBackendKind } from "../env/runner-backend";
import type { RunnerBackendKind } from "../env/runner-backend";
import { getRunnerBackend } from "../env/runner-backends";
import {
  buildGitOperationEnvVars,
} from "../env/launch-config";
import {
  getHub,
  projectAndPersistEnvSummary,
  projectEnvMetaForAction,
  reconcileEnvScmOperationState,
} from "../env/service";
import { isLifecycleStopInProgress } from "../env-lifecycle";
import { createRepoGitArtifactId } from "./artifacts";
import { ScmServiceResult, type ScmStartOutcome } from "./contracts";
import { createInitialEnvScmState, withDerivedBranchBackedEnvStatus } from "./model";
import { getScmOperationStore } from "./operation-store";
import {
  buildScmOperationResponse,
  createScmOperationId,
  ensureNoPendingRepoScmOperationForEnv,
  waitForRepoScmOperation,
} from "../env/scm-operations";

type WorkflowFailureOutcome =
  | { outcome: "not-found" }
  | { outcome: "conflict"; error: string }
  | { outcome: "failed"; error: string };

export type ScmWorkflowResult = ScmServiceResult<
  Record<string, unknown>,
  ScmStartOutcome | WorkflowFailureOutcome
>;

function getStopFinalizationInProgressError(action: string): string {
  return `Environment is still saving changes from the previous stop. Wait for it to finish before ${action}.`;
}

function buildScmJobMeta(args: {
  slug: string;
  repoUrl: string;
  repoId: string | undefined;
  backend: RunnerBackendKind;
  harness: EnvMeta["harness"];
  createdAt?: string;
}): EnvMeta {
  const createdAt = args.createdAt ?? new Date().toISOString();
  return {
    slug: args.slug,
    repoUrl: args.repoUrl,
    ...(args.repoId ? { repoId: args.repoId } : {}),
    backend: args.backend,
    harness: args.harness,
    createdAt,
    updatedAt: createdAt,
    status: "creating",
    ...createInitialEnvScmState({
      slug: args.slug,
    }),
  };
}

async function readProjectedEnvMeta(env: Env, slug: string): Promise<EnvMeta | null> {
  return await projectAndPersistEnvSummary(env, getHub(env), slug, {
    broadcast: false,
  });
}

async function loadScmStartContext(
  env: Env,
  slug: string,
  action: "promoting to main",
): Promise<
  | { ok: false; result: ScmWorkflowResult }
  | {
    ok: true;
    meta: EnvMeta;
    repo: Awaited<ReturnType<typeof ensureRepoWorkspaceFromRepoUrl>>;
    syncedMeta: EnvMeta;
  }
> {
  const storedMeta = await readProjectedEnvMeta(env, slug);
  if (!storedMeta) {
    return {
      ok: false,
      result: {
        status: 404,
        body: { error: "Not found" },
        outcome: { outcome: "not-found" },
      },
    };
  }

  const projectedMeta = await reconcileEnvScmOperationState(env, storedMeta);
  if (isLifecycleStopInProgress(projectedMeta)) {
    return {
      ok: false,
      result: {
        status: 409,
        body: { error: getStopFinalizationInProgressError(action) },
        outcome: {
          outcome: "conflict",
          error: getStopFinalizationInProgressError(action),
        },
      },
    };
  }

  const envBackend = await getRunnerBackend(env, storedMeta.backend);
  const { meta } = await projectEnvMetaForAction(env, projectedMeta, envBackend);
  if (meta.status !== "stopped") {
    return {
      ok: false,
      result: {
        status: 409,
        body: { error: `Environment must be stopped before ${action}` },
        outcome: {
          outcome: "conflict",
          error: `Environment must be stopped before ${action}`,
        },
      },
    };
  }

  const repo = await ensureRepoWorkspaceFromRepoUrl(env, meta.repoUrl);
  if (!repo.meta.gitArtifactId || repo.meta.gitStatus !== "ready") {
    return {
      ok: false,
      result: {
        status: 409,
        body: { error: "Canonical repo git state is not ready yet. Try again after bootstrap finishes." },
        outcome: {
          outcome: "conflict",
          error: "Canonical repo git state is not ready yet. Try again after bootstrap finishes.",
        },
      },
    };
  }

  return {
    ok: true,
    meta,
    repo,
    syncedMeta: withDerivedBranchBackedEnvStatus(meta, repo.meta),
  };
}

export async function startMergeIntoMainWorkflow(
  env: Env,
  requestUrl: string,
  slug: string,
): Promise<ScmWorkflowResult> {
  const loaded = await loadScmStartContext(env, slug, "promoting to main");
  if (!loaded.ok) {
    return loaded.result;
  }

  const { meta, repo, syncedMeta } = loaded;
  if (syncedMeta.branchStatus === "needs-attention") {
    return {
      status: 409,
      body: {
        error: "Resolve branch conflicts before promoting to main.",
        code: "promote_conflict_pending",
        hint: "Reset the environment to main before trying again.",
      },
      outcome: { outcome: "conflict", error: "Resolve branch conflicts before promoting to main." },
    };
  }
  const pendingOperation = await ensureNoPendingRepoScmOperationForEnv(env, repo.meta.repoId, slug);
  if (pendingOperation) {
    const error = `Another promote operation is already in progress for this environment (${pendingOperation.type}).`;
    return {
      status: 409,
      body: {
        error,
        code: "promote_env_busy",
        hint: "Wait for the current promote operation to finish, then try again.",
      },
      outcome: { outcome: "conflict", error },
    };
  }

  const operationId = createScmOperationId();
  const gitArtifactId = createRepoGitArtifactId();
  const store = getScmOperationStore(env, repo.meta.repoId);
  const hub = getHub(env);
  let mergeLockToken: string | null = null;
  let operationCreated = false;
  let projectionSet = false;

  try {
    const acquired = await store.acquireMergeLock({
      ownerId: slug,
      operationId,
      leaseMs: 5 * 60_000,
    });
    if (!acquired.acquired) {
      return {
        status: 409,
        body: {
          error: "Another promote to main operation is already in progress for this repo.",
          code: "promote_repo_locked",
          hint: "Wait for the current promote to finish, then try again.",
        },
        outcome: {
          outcome: "conflict",
          error: "Another promote to main operation is already in progress for this repo.",
        },
      };
    }
    mergeLockToken = acquired.lock.token;

    await store.createOperation({
      operationId,
      type: "merge-into-main",
      envSlug: slug,
      ownerId: slug,
      mergeLockToken,
      gitArtifactId,
    });
    operationCreated = true;

    await getEnvLifecycleStub(env, slug).setScmProjection({
      type: "merge-into-main",
      operationId,
      phase: "Starting sandbox",
    });
    projectionSet = true;
    await projectAndPersistEnvSummary(env, hub, slug);

    const backendKind = resolveScmRunnerBackendKind(env);
    const jobSlug = `scm-op-${slug}-${operationId.slice(-8)}`;
    const envVars = await buildGitOperationEnvVars(env, requestUrl, repo, syncedMeta, {
      operationId,
      operationType: "merge-into-main",
      sourceGitArtifactId: repo.meta.gitArtifactId,
      stagedGitArtifactId: gitArtifactId,
      mergeLockToken,
    });

    if (isLocalOnlyRunnerBackendMode(env)) {
      const backend = await getRunnerBackend(env, backendKind);
      await backend.create(
        buildScmJobMeta({
          slug: jobSlug,
          repoUrl: meta.repoUrl,
          repoId: meta.repoId,
          backend: backendKind,
          harness: meta.harness,
        }),
        envVars,
      );
    } else {
      const scmOperation = getScmOperationStub(env, jobSlug);
      await scmOperation.startOperationJob(envVars);
    }

    const record = await waitForRepoScmOperation(env, repo.meta.repoId, operationId);
    if (!record || record.status === "pending") {
      return {
        status: 202,
        body: { ok: true, slug, operationId, pending: true },
        outcome: { outcome: "started", operationId, pending: true },
      };
    }

    await store.clearOperation(operationId);
    const body = {
      slug,
      repoId: repo.meta.repoId,
      ...buildScmOperationResponse(record),
    };
    return {
      status: 200,
      body,
      outcome: { outcome: "completed", operationId, result: body },
    };
  } catch (error) {
    const rawMessage = error instanceof Error ? error.message : "Failed to start promote operation";
    const message = projectionSet || operationCreated || mergeLockToken
      ? rawMessage
      : `Failed to prepare promote operation: ${rawMessage}`;
    if (projectionSet) {
      await getEnvLifecycleStub(env, slug).clearScmProjection().catch(() => {});
      await projectAndPersistEnvSummary(env, hub, slug).catch(() => {});
    }
    if (operationCreated) {
      await store.failOperation({
        operationId,
        error: message,
      }).catch(() => {});
      await store.clearOperation(operationId).catch(() => {});
    }
    if (mergeLockToken) {
      await store.releaseMergeLock(mergeLockToken).catch(() => {});
    } else {
      const currentLock = await store.getMergeLock().catch(() => null);
      if (currentLock?.operationId === operationId) {
        await store.releaseMergeLock(currentLock.token).catch(() => {});
      }
    }
    return {
      status: 502,
      body: {
        error: message,
        code: "promote_setup_failed",
        hint: "The hub could not prepare the promote operation. Retry once. If it keeps failing, check the hub logs.",
      },
      outcome: { outcome: "failed", error: message },
    };
  }
}
