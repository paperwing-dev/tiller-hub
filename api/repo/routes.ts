import { Hono } from "hono";
import {
  getPlanArtifactById,
  getApprovedPlanArtifact,
  loadRepoArtifacts,
} from "../coordination";
import type { HubDO } from "../hub";
import type { HonoEnv, Env, RepoMeta, EnvMeta } from "../types";
import type { WorkspaceDO } from "../workspace/do";
import {
  deleteRepoIndex,
  deriveRepoId,
  ensureRepoWorkspaceFromRepoUrl,
  getRepoPlanStoreKey,
  getRepoWorkspaceForRepoId,
  listEnvMetas,
  listRepos,
  normalizeRepoUrl,
  persistRepoMeta,
  readRepoIndexEntry,
} from "../plan/store";
import { getArtifactStoreStub, getLocationHintOptions, getScmBootstrapStub, getWorkspaceStub } from "../helpers";
import { destroyEnv } from "../env/service";
import { resolveContainerHubUrl } from "../env/hub-url";
import { integratePlanReviews, runPlanReviewRound } from "../plan/review-service";
import { getCanonicalMainBootstrapDepth, getSecret } from "../setup/config";
import { resolveProtectionState } from "../protection";
import { isLocalOnlyRunnerBackendMode, resolveScmRunnerBackendKind } from "../env/runner-backend";
import { getRunnerBackend } from "../env/runner-backends";
import { getScmOperationStore } from "../scm/operation-store";
import {
  buildRepoGitArtifactKey,
  buildRepoGitArtifactsPrefix,
  buildRepoGitBootstrapSlug,
  createRepoGitArtifactId,
  deleteScmArtifact,
  getScmArtifact,
  putScmArtifact,
} from "../scm/artifacts";
import { SCM_ARTIFACT_CONTENT_TYPE } from "../scm/constants";
import { createInitialEnvScmState } from "../scm/model";
import { projectRepoSummary } from "../sync/projectors";

const repoRoutes = new Hono<HonoEnv>();
type RepoWorkspaceHandle = { workspace: WorkspaceDO; meta: RepoMeta };

function buildRepoGitArtifactUrl(baseUrl: string, repoId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repoId)}/git-artifact`;
}

function readRepoGitHeader(header: string | undefined | null): string | null {
  const value = header?.trim();
  return value ? value : null;
}

function readRepoGitDurationHeader(header: string | undefined | null): number | null {
  const value = readRepoGitHeader(header);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function computeElapsedMs(startedAt: string | null | undefined, finishedAt: string): number | null {
  if (!startedAt) return null;
  const start = Date.parse(startedAt);
  const finish = Date.parse(finishedAt);
  if (!Number.isFinite(start) || !Number.isFinite(finish) || finish < start) {
    return null;
  }
  return finish - start;
}

function buildScmJobMeta(args: {
  slug: string;
  repoUrl: string;
  repoId: string;
  backend: "cf" | "host";
  createdAt?: string;
}): EnvMeta {
  const createdAt = args.createdAt ?? new Date().toISOString();
  return {
    slug: args.slug,
    repoUrl: args.repoUrl,
    repoId: args.repoId,
    backend: args.backend,
    harness: "claude-code",
    createdAt,
    updatedAt: createdAt,
    status: "creating",
    ...createInitialEnvScmState({
      slug: args.slug,
    }),
  };
}

async function buildRepoGitBootstrapEnvVars(
  env: Env,
  requestUrl: string,
  repo: RepoMeta,
): Promise<Record<string, string>> {
  const backend = resolveScmRunnerBackendKind(env);
  const hubPublicUrl = await resolveContainerHubUrl(env, requestUrl, backend);
  const protection = await resolveProtectionState(env, requestUrl);
  const githubToken = await getSecret(env, "GITHUB_TOKEN");
  const bootstrapDepth = await getCanonicalMainBootstrapDepth(env);
  const cfClientId =
    protection.protectionMode === "cf-access"
      ? (await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim() ?? ""
      : "";
  const cfClientSecret =
    protection.protectionMode === "cf-access"
      ? (await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim() ?? ""
      : "";

  return {
    TILLER_BOOTSTRAP_MODE: "repo-git",
    TILLER_REPO_ID: repo.repoId,
    TILLER_REPO_GIT_ARTIFACT_URL: buildRepoGitArtifactUrl(hubPublicUrl, repo.repoId),
    TILLER_REPO_GIT_FAILURE_URL: `${hubPublicUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repo.repoId)}/git-artifact/bootstrap-failed`,
    TILLER_REPO_GIT_PROGRESS_URL: `${hubPublicUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repo.repoId)}/git-artifact/bootstrap-progress`,
    TILLER_REPO_GIT_BOOTSTRAP_REF: repo.bootstrappedFromRef ?? "HEAD",
    TILLER_REPO_GIT_BOOTSTRAP_DEPTH: String(bootstrapDepth),
    NODE_OPTIONS: "--dns-result-order=ipv4first --no-network-family-autoselection",
    REPO_URL: repo.repoUrl,
    ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
  };
}

async function persistRepoGitBootstrapState(
  env: Env,
  repo: RepoWorkspaceHandle,
  updates: Partial<Pick<
    RepoMeta,
    | "gitStatus"
    | "gitError"
    | "gitArtifactId"
    | "mainCommit"
    | "gitProgressPhase"
    | "gitProgressStartedAt"
    | "gitProgressUpdatedAt"
    | "gitLastBootstrapDurationMs"
    | "gitLastBootstrapTimings"
  >>,
): Promise<RepoMeta> {
  const nextMeta: RepoMeta = {
    ...repo.meta,
    ...updates,
    updatedAt: new Date().toISOString(),
  };
  await persistRepoMeta(env, repo.workspace, nextMeta);
  return nextMeta;
}

async function broadcastRepoSummary(
  env: Env,
  repo: RepoMeta,
): Promise<void> {
  const hubId = env.HUB.idFromName("hub");
  const hub = env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as Pick<HubDO, "broadcastRepoUpsert">;
  await hub.broadcastRepoUpsert(projectRepoSummary(repo));
}

async function markRepoGitBootstrapFailure(
  env: Env,
  repo: RepoWorkspaceHandle,
  error: string,
): Promise<RepoMeta> {
  return persistRepoGitBootstrapState(env, repo, {
    gitStatus: "repair-required",
    gitError: error,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
  });
}

async function startRepoGitBootstrapJob(
  env: Env,
  requestUrl: string,
  repo: RepoWorkspaceHandle,
): Promise<void> {
  if (repo.meta.gitStatus === "ready") {
    return;
  }

  const nextMeta = await persistRepoGitBootstrapState(env, repo, {
    gitStatus: "pending",
    gitError: null,
    gitProgressPhase: isLocalOnlyRunnerBackendMode(env) ? "Starting sandbox" : "Starting bootstrap container",
    gitProgressStartedAt: new Date().toISOString(),
    gitProgressUpdatedAt: new Date().toISOString(),
  });
  await broadcastRepoSummary(env, nextMeta);

  const slug = buildRepoGitBootstrapSlug(repo.meta.repoId);
  const envVars = await buildRepoGitBootstrapEnvVars(env, requestUrl, repo.meta);

  if (isLocalOnlyRunnerBackendMode(env)) {
    const backendKind = resolveScmRunnerBackendKind(env);
    const backend = await getRunnerBackend(env, backendKind);
    await backend.create(
      buildScmJobMeta({
        slug,
        repoUrl: repo.meta.repoUrl,
        repoId: repo.meta.repoId,
        backend: backendKind,
      }),
      envVars,
    );
    return;
  }

  const stub = getScmBootstrapStub(env, slug);
  await stub.startBootstrapJob(repo.meta.repoId, envVars);
}

function repoMatchesEnv(repo: RepoMeta, env: EnvMeta): boolean {
  if (env.repoId && repo.repoId) {
    return env.repoId === repo.repoId;
  }
  return normalizeRepoUrl(env.repoUrl) === normalizeRepoUrl(repo.repoUrl);
}

function ensureDraftIsCurrent(repo: RepoMeta, draft: { mainCommit?: string | null }): string | null {
  if (!draft.mainCommit) {
    return "Draft is missing its canonical main commit. Start a new draft on the current main.";
  }
  if (draft.mainCommit !== repo.mainCommit) {
    return `Draft is outdated for main (${draft.mainCommit} vs ${repo.mainCommit ?? "unknown"})`;
  }
  return null;
}

function ensureArtifactIsCurrent(repo: RepoMeta, artifact: { basis: { mainCommit: string | null } }): string | null {
  return ensureDraftIsCurrent(repo, { mainCommit: artifact.basis.mainCommit });
}

async function getRepoArtifactState(
  env: Env,
  repo: RepoWorkspaceHandle,
): Promise<{
  artifactStore: ReturnType<typeof getArtifactStoreStub>;
  artifacts: Awaited<ReturnType<typeof loadRepoArtifacts>>["artifacts"];
  refs: Awaited<ReturnType<typeof loadRepoArtifacts>>["refs"];
}> {
  const artifactStore = getArtifactStoreStub(env, repo.meta.repoId);
  const { artifacts, refs } = await loadRepoArtifacts(repo.meta, artifactStore);
  return {
    artifactStore,
    artifacts,
    refs,
  };
}

repoRoutes.get("/api/repos", async (c) => {
  return c.json((await listRepos(c.env)).map((repo) => projectRepoSummary(repo)));
});

repoRoutes.get("/api/repos/:repoId", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  return c.json(projectRepoSummary(repo.meta));
});

repoRoutes.post("/api/repos", async (c) => {
  const body = await c.req.json<{ repoUrl: string }>();
  if (!body.repoUrl?.trim()) {
    return c.json({ error: "repoUrl is required" }, 400);
  }
  try {
    const normalized = normalizeRepoUrl(body.repoUrl);
    const repoId = await deriveRepoId(normalized);
    const existing = await readRepoIndexEntry(c.env, repoId);
    if (existing) {
      const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, body.repoUrl);
      return c.json(projectRepoSummary(repo.meta), 200);
    }
    const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, body.repoUrl);
    await broadcastRepoSummary(c.env, repo.meta);
    c.executionCtx.waitUntil(
      startRepoGitBootstrapJob(c.env, c.req.url, repo).catch(async (error) => {
        console.error(`[repos] Failed to start git bootstrap job for ${repo.meta.repoId}:`, error);
        const nextMeta = await markRepoGitBootstrapFailure(
          c.env,
          repo,
          error instanceof Error ? error.message : "Failed to start canonical main bootstrap.",
        ).catch((persistError) => {
          console.error(`[repos] Failed to persist git bootstrap failure for ${repo.meta.repoId}:`, persistError);
          return null;
        });
        if (nextMeta) {
          await broadcastRepoSummary(c.env, nextMeta).catch((broadcastError) => {
            console.error(`[repos] Failed to broadcast repo summary for ${repo.meta.repoId}:`, broadcastError);
          });
        }
      }),
    );
    return c.json(projectRepoSummary(repo.meta), 201);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});

repoRoutes.get("/api/repos/:repoId/git-artifact", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const requestedArtifactId = c.req.query("artifactId")?.trim() || null;
  const artifactId = requestedArtifactId ?? repo.meta.gitArtifactId ?? null;
  if (!artifactId) {
    return c.json({ error: "No git artifact available" }, 404);
  }

  const key = buildRepoGitArtifactKey({
    repoId: repo.meta.repoId,
    generationId: artifactId,
  });
  const artifact = await getScmArtifact(c.env.BUCKET, key);
  if (!artifact?.body) {
    return c.json({ error: "Git artifact not found" }, 404);
  }
  const artifactGitHead = artifact.customMetadata?.gitHead || repo.meta.mainCommit || null;

  return new Response(artifact.body, {
    headers: {
      "Content-Type": artifact.httpMetadata?.contentType || SCM_ARTIFACT_CONTENT_TYPE,
      "X-Tiller-Git-Artifact-Id": artifactId,
      ...(artifactGitHead ? { "X-Tiller-Git-Head": artifactGitHead } : {}),
      ...(repo.meta.gitStatus ? { "X-Tiller-Git-Status": repo.meta.gitStatus } : {}),
    },
  });
});

repoRoutes.post("/api/repos/:repoId/git-artifact", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  if (!c.req.raw.body) {
    return c.json({ error: "Git artifact body is required" }, 400);
  }
  if (repo.meta.gitStatus === "ready" && repo.meta.gitArtifactId) {
    return c.json({ error: "Canonical git artifact is already initialized for this repo." }, 409);
  }

  const artifactId = createRepoGitArtifactId();
  const savedAt = new Date().toISOString();
  const gitHead = readRepoGitHeader(c.req.header("X-Tiller-Git-Head"));
  const bootstrapDurationMs =
    readRepoGitDurationHeader(c.req.header("X-Tiller-Git-Bootstrap-Duration-Ms")) ??
    computeElapsedMs(repo.meta.gitProgressStartedAt, savedAt);
  const bootstrapTimings = readRepoGitHeader(c.req.header("X-Tiller-Git-Bootstrap-Timings"));
  if (!gitHead) {
    return c.json({ error: "Git artifact upload is missing the canonical main commit." }, 400);
  }
  const key = buildRepoGitArtifactKey({
    repoId: repo.meta.repoId,
    generationId: artifactId,
  });

  await putScmArtifact(c.env.BUCKET, key, c.req.raw.body, {
    artifactId,
    repoId: repo.meta.repoId,
    repoUrl: repo.meta.repoUrl,
    gitHead,
    savedAt,
  });

  const previousMainCommit = repo.meta.mainCommit ?? null;
  const nextMeta: RepoMeta = {
    ...repo.meta,
    gitArtifactId: artifactId,
    mainCommit: gitHead,
    gitStatus: "ready",
    gitError: null,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: bootstrapDurationMs,
    gitLastBootstrapTimings: bootstrapTimings,
    updatedAt: savedAt,
  };
  await persistRepoMeta(c.env, repo.workspace, nextMeta);
  await broadcastRepoSummary(c.env, nextMeta);
  if (previousMainCommit !== nextMeta.mainCommit) {
    c.executionCtx.waitUntil((async () => {
      try {
        const hub = getHub(c.env);
        await hub.broadcastRepoMainChange(
          nextMeta.repoId,
          nextMeta.repoUrl,
          previousMainCommit,
          nextMeta.mainCommit,
          null,
        );
      } catch (error) {
        console.error(`[repos] Failed to broadcast canonical main bootstrap for ${nextMeta.repoId}:`, error);
      }
    })());
  }

  return c.json({
    ok: true,
    repoId: repo.meta.repoId,
    gitArtifactId: artifactId,
    mainCommit: nextMeta.mainCommit ?? null,
    gitStatus: nextMeta.gitStatus ?? null,
  });
});

repoRoutes.post("/api/repos/:repoId/git-artifact/bootstrap-failed", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  if (repo.meta.gitStatus === "ready" && repo.meta.gitArtifactId) {
    return c.json({
      ok: true,
      repoId: repo.meta.repoId,
      gitStatus: repo.meta.gitStatus,
    });
  }

  const message =
    readRepoGitHeader(c.req.header("X-Tiller-Git-Bootstrap-Error")) ??
    (await c.req.text().catch(() => "")).trim() ??
    "Canonical main bootstrap failed.";

  const nextMeta = await markRepoGitBootstrapFailure(c.env, repo, message || "Canonical main bootstrap failed.");
  await broadcastRepoSummary(c.env, nextMeta);
  return c.json({
    ok: true,
    repoId: nextMeta.repoId,
    gitStatus: nextMeta.gitStatus,
    gitError: nextMeta.gitError,
  });
});

repoRoutes.post("/api/repos/:repoId/git-artifact/bootstrap-progress", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  if (repo.meta.gitStatus === "ready" && repo.meta.gitArtifactId) {
    return c.json({ ok: true, repoId: repo.meta.repoId, gitStatus: repo.meta.gitStatus });
  }

  const body = await c.req.json<{ phase?: string; elapsedMs?: number | null }>().catch(() => ({}));
  const phase = body.phase?.trim();
  if (!phase) {
    return c.json({ error: "phase is required" }, 400);
  }

  const nextMeta = await persistRepoGitBootstrapState(c.env, repo, {
    gitStatus: "pending",
    gitError: null,
    gitProgressPhase: phase,
    gitProgressStartedAt: repo.meta.gitProgressStartedAt ?? new Date().toISOString(),
    gitProgressUpdatedAt: new Date().toISOString(),
  });
  await broadcastRepoSummary(c.env, nextMeta);

  return c.json({
    ok: true,
    repoId: nextMeta.repoId,
    gitStatus: nextMeta.gitStatus,
    gitProgressPhase: nextMeta.gitProgressPhase,
  });
});

repoRoutes.post("/api/repos/:repoId/scm-operations/:operationId/git-artifact", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  if (!c.req.raw.body) {
    return c.json({ error: "Git artifact body is required" }, 400);
  }

  const operationId = c.req.param("operationId");
  const store = getScmOperationStore(c.env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (!operation || operation.type !== "merge-into-main" || operation.status !== "pending") {
    return c.json({ error: "Active merge operation not found for staged git artifact upload." }, 404);
  }

  const artifactId = readRepoGitHeader(c.req.header("X-Tiller-Git-Artifact-Id")) ?? operationId;
  if (!operation.gitArtifactId || artifactId !== operation.gitArtifactId) {
    return c.json({ error: "Staged git artifact id did not match the reserved merge artifact id." }, 409);
  }
  const gitHead = readRepoGitHeader(c.req.header("X-Tiller-Git-Head"));
  const key = buildRepoGitArtifactKey({
    repoId: repo.meta.repoId,
    generationId: artifactId,
  });

  await putScmArtifact(c.env.BUCKET, key, c.req.raw.body, {
    artifactId,
    repoId: repo.meta.repoId,
    repoUrl: repo.meta.repoUrl,
    operationId,
    gitHead,
    staged: true,
  });

  return c.json({
    ok: true,
    repoId: repo.meta.repoId,
    operationId,
    gitArtifactId: artifactId,
    gitHead,
  });
});

repoRoutes.post("/api/repos/:repoId/git-artifact/bootstrap", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  if (repo.meta.gitStatus === "ready" && repo.meta.gitArtifactId) {
    return c.json({
      ok: true,
      repoId: repo.meta.repoId,
      gitStatus: repo.meta.gitStatus,
      gitArtifactId: repo.meta.gitArtifactId,
    });
  }

  try {
    await startRepoGitBootstrapJob(c.env, c.req.url, repo);
    return c.json(
      {
        ok: true,
        repoId: repo.meta.repoId,
        gitStatus: "pending",
      },
      202,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start git bootstrap";
    const failedMeta = await markRepoGitBootstrapFailure(c.env, repo, message).catch((persistError) => {
      console.error(`[repos] Failed to persist git bootstrap failure for ${repo.meta.repoId}:`, persistError);
      return null;
    });
    if (failedMeta) {
      await broadcastRepoSummary(c.env, failedMeta).catch((broadcastError) => {
        console.error(`[repos] Failed to broadcast repo summary for ${repo.meta.repoId}:`, broadcastError);
      });
    }
    return c.json({ error: message }, 502);
  }
});

repoRoutes.get("/api/repos/:repoId/artifacts", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const { artifacts, refs } = await getRepoArtifactState(c.env, repo);
  return c.json({ artifacts, refs });
});

repoRoutes.get("/api/repos/:repoId/artifacts/:id", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const { artifacts, refs } = await getRepoArtifactState(c.env, repo);
  const artifact = artifacts.find((candidate) => candidate.id === c.req.param("id")) ?? null;
  if (!artifact) {
    return c.json({ error: "Artifact not found" }, 404);
  }
  return c.json({ artifact, refs });
});

repoRoutes.post("/api/repos/:repoId/artifacts", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  const body = await c.req.json<Record<string, unknown>>();
  try {
    const artifact = artifactStore.createArtifact({
      ...(body as any),
      repoId: repo.meta.repoId,
    });
    return c.json({ ok: true, artifact }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create artifact" }, 400);
  }
});

repoRoutes.get("/api/repos/:repoId/refs", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const { artifactStore } = await getRepoArtifactState(c.env, repo);
  return c.json(artifactStore.listRefs());
});

repoRoutes.post("/api/repos/:repoId/refs/:name", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const { artifactStore, artifacts } = await getRepoArtifactState(c.env, repo);
  const body = await c.req.json<{ artifactId?: string; expectedVersion?: number | null }>().catch(() => ({}));
  const artifactId = body.artifactId?.trim();
  if (!artifactId) {
    return c.json({ error: "artifactId is required" }, 400);
  }
  const artifact = artifacts.find((candidate) => candidate.id === artifactId) ?? null;
  if (!artifact) {
    return c.json({ error: "Artifact not found" }, 404);
  }
  try {
    const ref = artifactStore.setRef({
      repoId: repo.meta.repoId,
      name: c.req.param("name"),
      artifactId,
      expectedVersion: body.expectedVersion,
    });
    return c.json({ ok: true, ref, artifact });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to update ref" }, 409);
  }
});

repoRoutes.post("/api/repos/:repoId/artifacts/:id/review-round", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const { artifactStore, artifacts } = await getRepoArtifactState(c.env, repo);
  const draft = getPlanArtifactById(artifacts, c.req.param("id"));
  if (!draft) {
    return c.json({ error: "Plan artifact not found" }, 404);
  }
  const revisionError = ensureArtifactIsCurrent(repo.meta, draft);
  if (revisionError) {
    return c.json({ error: revisionError }, 409);
  }
  try {
    return c.json(
      await runPlanReviewRound({
        env: c.env,
        repoPlan: {
          meta: repo.meta,
          planWorkspace: repo.workspace,
          artifactStore,
        },
        draft,
      }),
    );
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to run plan review round" },
      502,
    );
  }
});

repoRoutes.post("/api/repos/:repoId/artifacts/:id/integrate", async (c) => {
  const repo = await getRepoWorkspaceForRepoId(c.env, c.req.param("repoId"));
  if (!repo) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const { artifactStore, artifacts } = await getRepoArtifactState(c.env, repo);
  const draft = getPlanArtifactById(artifacts, c.req.param("id"));
  if (!draft) {
    return c.json({ error: "Plan artifact not found" }, 404);
  }
  const revisionError = ensureArtifactIsCurrent(repo.meta, draft);
  if (revisionError) {
    return c.json({ error: revisionError }, 409);
  }
  const body = await c.req.json<{ selectedModel?: unknown }>().catch(() => ({}));
  try {
    return c.json(
      await integratePlanReviews({
        env: c.env,
        repoPlan: {
          meta: repo.meta,
          planWorkspace: repo.workspace,
          artifactStore,
        },
        draft,
        selectedModel: body.selectedModel,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to integrate reviews";
    const status = message === "No review artifacts found for this draft" ? 400 : 502;
    return c.json({ error: message }, status);
  }
});

function getHub(
  env: Env,
): Pick<HubDO, "broadcastEnvRemove" | "broadcastRepoMainChange" | "broadcastRepoRemove"> {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as Pick<
    HubDO,
    "broadcastEnvRemove" | "broadcastRepoMainChange" | "broadcastRepoRemove"
  >;
}

repoRoutes.delete("/api/repos/:repoId", async (c) => {
  const repoId = c.req.param("repoId");
  const indexEntry = await readRepoIndexEntry(c.env, repoId);
  if (!indexEntry) {
    return c.json({ error: "Repo not found" }, 404);
  }
  const repo = await getRepoWorkspaceForRepoId(c.env, repoId);
  const gitArtifactId = repo?.meta.gitArtifactId ?? null;

  // Find all attached environments
  const allEnvs = await listEnvMetas(c.env);
  const attachedEnvs = allEnvs.filter((env) => repoMatchesEnv({ repoId, repoUrl: indexEntry.repoUrl } as RepoMeta, env));

  const hub = getHub(c.env);
  for (const env of attachedEnvs) {
    await c.env.ENVS_KV.delete(env.slug);
    await hub.broadcastEnvRemove(env.slug);
  }
  await deleteRepoIndex(c.env, repoId);
  await hub.broadcastRepoRemove(repoId);

  // Background cleanup: destroy envs then repo workspace
  c.executionCtx.waitUntil(
    (async () => {
      for (const env of attachedEnvs) {
        try {
          await destroyEnv(c.env, env, hub, { broadcast: false });
        } catch (err) {
          console.error(`[repos] Failed to destroy env ${env.slug} during repo deletion:`, err);
        }
      }
      try {
        const workspaceStub = getWorkspaceStub(c.env, getRepoPlanStoreKey(indexEntry.repoUrl));
        await workspaceStub.destroyWorkspace();
      } catch (err) {
        console.error(`[repos] Failed to destroy repo workspace for ${repoId}:`, err);
      }
      try {
        const listed = await c.env.BUCKET.list({
          prefix: buildRepoGitArtifactsPrefix(repoId),
        });
        await Promise.all(
          listed.objects.map((object) => deleteScmArtifact(c.env.BUCKET, object.key)),
        );
        if (gitArtifactId && !listed.objects.some((object) => object.key === buildRepoGitArtifactKey({ repoId, generationId: gitArtifactId }))) {
          await deleteScmArtifact(
            c.env.BUCKET,
            buildRepoGitArtifactKey({ repoId, generationId: gitArtifactId }),
          );
        }
      } catch (err) {
        console.error(`[repos] Failed to delete git artifacts for ${repoId}:`, err);
      }
    })(),
  );

  return c.json({
    ok: true,
    repoId,
    deletedEnvSlugs: attachedEnvs.map((e) => e.slug),
  });
});

export default repoRoutes;
