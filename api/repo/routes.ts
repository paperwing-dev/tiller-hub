import { Hono } from "hono";
import { loadRepoArtifacts } from "../coordination";
import type { PlanStatus } from "../coordination";
import type { HubDO } from "../hub";
import type { HonoEnv, Env, RepoMeta, EnvMeta, EnvDefinition } from "../types";
import {
  deleteRepoIndex,
  getEnvDefinitionKey,
  listEnvDefinitionSlugs,
  listRepos,
  persistRepoMeta,
  readEnvDefinition,
} from "../plan/store";
import {
  createOrRefreshRepoFromSelectionClaimForRequest,
  githubAppPublicHubDisabledBody,
  loadRepoForRequest,
  loadRepoProjection,
  loadStoredRepoForDeletion,
  type RepoWorkspace,
} from "./access";
import { getArtifactStoreStub, getEnvLifecycleStub, getLocationHintOptions, getScmBootstrapStub } from "../helpers";
import { destroyEnv } from "../env/service";
import { buildEnvMetaFromLayers, createFallbackMutableState } from "../env/state";
import { resolveContainerHubUrl } from "../env/hub-url";
import { PLAN_REVIEW_MODELS } from "../plan/workflow";
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
import { isGitHubAppAllowedForRequest } from "../github/app";
import {
  bridgeCredentialsToEnvVars,
  createGitHubBridgeRecord,
  revokeGitHubBridgesForRepoBootstrap,
} from "../github/bridge";

const repoRoutes = new Hono<HonoEnv>();
type RepoWorkspaceHandle = RepoWorkspace;
type RepoRouteContext =
  | { ok: true; repo: RepoWorkspaceHandle }
  | { ok: false; response: Response };
type RepoHub = Pick<
  HubDO,
  | "broadcastEnvRemove"
  | "broadcastRepoMainChange"
  | "broadcastRepoRemove"
  | "getAllSessions"
  | "deleteSession"
>;

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
  const githubBridge = await isGitHubAppAllowedForRequest(env, new Request(requestUrl))
    ? await createGitHubBridgeRecord(env, {
        subject: {
          type: "repo-bootstrap",
          bootstrapSlug: buildRepoGitBootstrapSlug(repo.repoId),
          repoId: repo.repoId,
        },
        githubFullName: repo.githubFullName,
      })
    : null;
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
    HUB_URL: hubPublicUrl,
    TILLER_REPO_GIT_ARTIFACT_URL: buildRepoGitArtifactUrl(hubPublicUrl, repo.repoId),
    TILLER_REPO_GIT_FAILURE_URL: `${hubPublicUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repo.repoId)}/git-artifact/bootstrap-failed`,
    TILLER_REPO_GIT_PROGRESS_URL: `${hubPublicUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repo.repoId)}/git-artifact/bootstrap-progress`,
    TILLER_REPO_GIT_BOOTSTRAP_REF: repo.bootstrappedFromRef ?? "HEAD",
    TILLER_REPO_GIT_BOOTSTRAP_DEPTH: String(bootstrapDepth),
    NODE_OPTIONS: "--dns-result-order=ipv4first",
    REPO_URL: repo.repoUrl,
    ...(githubBridge ? bridgeCredentialsToEnvVars(githubBridge) : {}),
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

async function readValidatedRepoRouteContext(c: any): Promise<RepoRouteContext> {
  const loaded = await loadRepoForRequest(c.env, c.req.raw, c.req.param("repoId"), "selected-write");
  if (!loaded.ok) {
    return { ok: false, response: c.json(loaded.body, loaded.status as any) };
  }
  return { ok: true, repo: loaded.repo };
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "draft" || value === "todo" || value === "completed" || value === "archived";
}

function isReviewerModel(value: unknown): value is (typeof PLAN_REVIEW_MODELS)[number] {
  return typeof value === "string" && (PLAN_REVIEW_MODELS as readonly string[]).includes(value);
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
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json(githubAppPublicHubDisabledBody(), 403);
  }
  return c.json((await listRepos(c.env)).map((repo) => projectRepoSummary(repo)));
});

repoRoutes.get("/api/repos/:repoId", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json(githubAppPublicHubDisabledBody(), 403);
  }
  const loadedRepo = await loadRepoProjection(c.env, c.req.param("repoId"));
  if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
  return c.json(projectRepoSummary(loadedRepo.repo));
});

repoRoutes.post("/api/repos", async (c) => {
  const body: {
    repositoryId?: unknown;
    installationId?: unknown;
    fullName?: unknown;
  } = await c.req.json<{
    repositoryId?: unknown;
    installationId?: unknown;
    fullName?: unknown;
  }>().catch(() => ({}));
  const repositoryId = body.repositoryId;
  const installationId = body.installationId;
  const fullName = body.fullName;
  if (!Number.isInteger(repositoryId) || !Number.isInteger(installationId) || typeof fullName !== "string" || !fullName.trim()) {
    return c.json({ error: "repositoryId, installationId, and fullName are required" }, 400);
  }
  const loaded = await createOrRefreshRepoFromSelectionClaimForRequest(c.env, c.req.raw, {
    repositoryId,
    installationId,
    fullName,
  });
  if (!loaded.ok) {
    return c.json(loaded.body, loaded.status as any);
  }
  const repo = loaded.repo;
  if (repo.created) {
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
  }
  return c.json(projectRepoSummary(repo.meta), repo.created ? 201 : 200);
});

repoRoutes.get("/api/repos/:repoId/git-artifact", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
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
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
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
  await revokeGitHubBridgesForRepoBootstrap(c.env, repo.meta.repoId).catch((error) => {
    console.warn(`[repos] Failed to revoke bootstrap GitHub bridge for ${repo.meta.repoId}:`, error);
  });
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
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
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
  await revokeGitHubBridgesForRepoBootstrap(c.env, repo.meta.repoId).catch((error) => {
    console.warn(`[repos] Failed to revoke bootstrap GitHub bridge for ${repo.meta.repoId}:`, error);
  });
  await broadcastRepoSummary(c.env, nextMeta);
  return c.json({
    ok: true,
    repoId: nextMeta.repoId,
    gitStatus: nextMeta.gitStatus,
    gitError: nextMeta.gitError,
  });
});

repoRoutes.post("/api/repos/:repoId/git-artifact/bootstrap-progress", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  if (repo.meta.gitStatus === "ready" && repo.meta.gitArtifactId) {
    return c.json({ ok: true, repoId: repo.meta.repoId, gitStatus: repo.meta.gitStatus });
  }

  const body = await c.req.json<{ phase?: string; elapsedMs?: number | null }>()
    .catch((): { phase?: string; elapsedMs?: number | null } => ({}));
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
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
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
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
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
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const { artifacts, refs } = await getRepoArtifactState(c.env, repo);
  return c.json({ artifacts, refs });
});

repoRoutes.get("/api/repos/:repoId/artifacts/:id", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const { artifacts, refs } = await getRepoArtifactState(c.env, repo);
  const artifact = artifacts.find((candidate) => candidate.id === c.req.param("id")) ?? null;
  if (!artifact) {
    return c.json({ error: "Artifact not found" }, 404);
  }
  return c.json({ artifact, refs });
});

repoRoutes.post("/api/repos/:repoId/plans", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  if (!repo.meta.mainCommit) {
    return c.json({ error: "Canonical main commit is not ready yet for this repository." }, 409);
  }
  const body = await c.req.json<{ title?: unknown }>().catch((): { title?: unknown } => ({}));
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  const artifact = await artifactStore.createArtifact({
    repoId: repo.meta.repoId,
    type: "plan",
    basis: {
      repoId: repo.meta.repoId,
      mainCommit: repo.meta.mainCommit,
    },
    title,
    body: { markdown: "" },
    status: "draft",
    createdBy: "user",
  });
  return c.json({ ok: true, artifact }, 201);
});

repoRoutes.patch("/api/repos/:repoId/artifacts/:id/status", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const body = await c.req.json<{ status?: unknown; expectedVersion?: unknown }>().catch(() => ({}));
  if (!isPlanStatus(body.status)) {
    return c.json({ error: "status must be one of draft, todo, completed, or archived" }, 400);
  }
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  try {
    const artifact = await artifactStore.updateArtifactStatus({
      repoId: repo.meta.repoId,
      id: c.req.param("id"),
      status: body.status,
      expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : null,
    });
    return c.json({ ok: true, artifact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update artifact status";
    return c.json({ error: message }, /version mismatch/i.test(message) ? 409 : 404);
  }
});

repoRoutes.delete("/api/repos/:repoId/plans/:artifactId", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const body = await c.req.json<{ expectedVersion?: unknown }>().catch(() => ({}));
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  try {
    const artifact = await artifactStore.discardPlan({
      repoId: repo.meta.repoId,
      id: c.req.param("artifactId"),
      expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : null,
    });
    return c.json({ ok: true, artifact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to discard plan";
    return c.json({ error: message }, /version mismatch|only draft/i.test(message) ? 409 : 404);
  }
});

repoRoutes.get("/api/repos/:repoId/plans/:artifactId/reviewers", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  const plan = await artifactStore.getArtifact(c.req.param("artifactId"));
  if (!plan || plan.repoId !== repo.meta.repoId || plan.type !== "plan") {
    return c.json({ error: "Plan artifact not found" }, 404);
  }
  return c.json({ reviewers: await artifactStore.listReviewers(repo.meta.repoId, plan.id) });
});

repoRoutes.post("/api/repos/:repoId/plans/:artifactId/reviewers", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const body = await c.req.json<{ reviewerModel?: unknown }>().catch(() => ({}));
  if (!isReviewerModel(body.reviewerModel)) {
    return c.json({ error: "Unsupported reviewer model" }, 400);
  }
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  const plan = await artifactStore.getArtifact(c.req.param("artifactId"));
  if (!plan || plan.repoId !== repo.meta.repoId || plan.type !== "plan") {
    return c.json({ error: "Plan artifact not found" }, 404);
  }
  const reviewer = await artifactStore.upsertReviewer({
    repoId: repo.meta.repoId,
    planArtifactId: plan.id,
    reviewerModel: body.reviewerModel,
  });
  return c.json({ ok: true, reviewer }, 201);
});

repoRoutes.delete("/api/repos/:repoId/plans/:artifactId/reviewers/:threadId", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  try {
    const reviewer = await artifactStore.removeReviewer(
      repo.meta.repoId,
      c.req.param("artifactId"),
      c.req.param("threadId"),
    );
    return c.json({ ok: true, reviewer });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Reviewer not found" }, 404);
  }
});

repoRoutes.post("/api/repos/:repoId/artifacts", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  const body = await c.req.json<Record<string, unknown>>();
  try {
    const artifact = await artifactStore.createArtifact({
      ...(body as any),
      repoId: repo.meta.repoId,
    });
    return c.json({ ok: true, artifact }, 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Failed to create artifact" }, 400);
  }
});

function getHub(env: Env): RepoHub {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as RepoHub;
}

repoRoutes.delete("/api/repos/:repoId", async (c) => {
  const repoId = c.req.param("repoId");
  const loaded = await loadStoredRepoForDeletion(c.env, c.req.raw, repoId);
  if (!loaded.ok) return c.json(loaded.body, loaded.status as any);
  const repo = loaded.repo;
  const gitArtifactId = repo.meta.gitArtifactId ?? null;

  const envDefinitionSlugs = await listEnvDefinitionSlugs(c.env);
  const attachedEnvDefinitions: EnvDefinition[] = [];
  for (const slug of envDefinitionSlugs) {
    const definition = await readEnvDefinition(c.env, slug).catch((error) => {
      console.warn(
        `[repos] Skipping invalid env definition ${slug} during repo deletion:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    });
    if (definition?.repoId === repoId) {
      attachedEnvDefinitions.push(definition);
    }
  }
  const attachedEnvSlugs = attachedEnvDefinitions.map((definition) => definition.slug);
  const attachedEnvs = await Promise.all(attachedEnvDefinitions.map(async (definition) => {
    const mutableState = await getEnvLifecycleStub(c.env, definition.slug).peekMutableState().catch((error) => {
      console.warn(
        `[repos] Falling back to definition-only env metadata for ${definition.slug} during repo deletion cleanup:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    });
    return buildEnvMetaFromLayers(
      definition,
      mutableState ?? createFallbackMutableState(definition),
      repo.meta.repoUrl,
    );
  }));

  const hub = getHub(c.env);
  for (const slug of attachedEnvSlugs) {
    await c.env.ENVS_KV.delete(slug);
    await c.env.ENVS_KV.delete(getEnvDefinitionKey(slug));
    await hub.broadcastEnvRemove(slug);
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
        await repo.workspace.destroyWorkspace();
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
    deletedEnvSlugs: attachedEnvSlugs,
  });
});

export default repoRoutes;
