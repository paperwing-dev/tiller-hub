import { Hono } from "hono";
import { loadRepoArtifacts } from "../coordination";
import type { PlanStatus } from "../coordination";
import type { HubDO } from "../hub";
import type { HonoEnv, Env, RepoMeta, EnvMeta, EnvDefinition } from "../types";
import {
  deleteRepoIndex,
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
  loadTrackedRepoForRequest,
  type RepoWorkspace,
} from "./access";
import { refreshGitHubDefaultBranchHead } from "./refresh";
import { getArtifactStoreStub, getEnvLifecycleStub, getEnvReviewStub } from "../helpers";
import { projectRepoSummary } from "../sync/projectors";
import { isGitHubAppAllowedForRequest } from "../github/app";
import {
  normalizeSessionEnvPatch,
  SessionEnvValidationError,
  type RepoSessionEnvMetadata,
} from "../session-env";
import type { RepoMcpServer } from "../mcp-servers";
import { getDurableObjectStub } from "../durable-object";
import { broadcastPlanArtifactUpdatedHint } from "../plan-artifact-hints";

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
  | "listRepoSessionEnv"
  | "patchRepoSessionEnv"
  | "deleteRepoSessionEnv"
  | "listRepoMcpServers"
  | "putRepoMcpServers"
  | "deleteRepoMcpServers"
>;

async function broadcastRepoSummary(
  env: Env,
  repo: RepoMeta,
): Promise<void> {
  const hub = getDurableObjectStub<Pick<HubDO, "broadcastRepoUpsert">>(env, env.HUB, "hub");
  await hub.broadcastRepoUpsert(projectRepoSummary(repo));
}

function shouldRefreshGitHubRepoSummary(repo: RepoMeta): boolean {
  return repo.scmModel === "github" && (repo.gitStatus !== "ready" || !repo.githubDefaultBranchHeadSha);
}

async function readValidatedRepoRouteContext(c: any): Promise<RepoRouteContext> {
  const loaded = await loadRepoForRequest(c.env, c.req.raw, c.req.param("repoId"));
  if (!loaded.ok) {
    return { ok: false, response: c.json(loaded.body, loaded.status as any) };
  }
  return { ok: true, repo: loaded.repo };
}

async function readTrackedRepoRouteContext(c: any): Promise<RepoRouteContext> {
  const loaded = await loadTrackedRepoForRequest(c.env, c.req.raw, c.req.param("repoId"));
  if (!loaded.ok) {
    return { ok: false, response: c.json(loaded.body, loaded.status as any) };
  }
  return { ok: true, repo: loaded.repo };
}

function isPlanStatus(value: unknown): value is PlanStatus {
  return value === "draft" || value === "evaluating" || value === "todo" || value === "completed" || value === "archived";
}

async function getRepoArtifactState(
  env: Env,
  repo: RepoWorkspaceHandle,
) {
  const artifactStore = getArtifactStoreStub(
    env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const { artifacts, refs, attention } = await artifactStore.getRepoArtifactState(
    repo.meta.repoId,
  );
  return {
    artifactStore,
    artifacts,
    refs,
    attention,
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
  const repo = loadedRepo.repo;
  if (shouldRefreshGitHubRepoSummary(repo)) {
    const refreshed = await refreshGitHubDefaultBranchHead(c.env, repo.repoId);
    if (refreshed.accessFailure) {
      return c.json(refreshed.accessFailure.body, refreshed.accessFailure.status as any);
    }
    if (refreshed.failureKind && refreshed.failureKind !== "not_ready") {
      return c.json({
        error: refreshed.error || "GitHub repository metadata refresh failed.",
        code: refreshed.code || "github_repo_refresh_failed",
      }, (refreshed.status ?? 502) as any);
    }
    if (refreshed.repo) {
      return c.json(projectRepoSummary(refreshed.repo.meta));
    }
  }
  return c.json(projectRepoSummary(repo));
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
    repositoryId: repositoryId as number,
    installationId: installationId as number,
    fullName,
  });
  if (!loaded.ok) {
    return c.json(loaded.body, loaded.status as any);
  }
  const repo = loaded.repo;
  await broadcastRepoSummary(c.env, repo.meta);
  return c.json(projectRepoSummary(repo.meta), repo.created ? 201 : 200);
});

repoRoutes.get("/api/repos/:repoId/artifacts", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const { artifacts, refs, attention } = await getRepoArtifactState(c.env, repo);
  return c.json({ artifacts, refs, attention });
});

repoRoutes.post("/api/repos/:repoId/plans/:planArtifactId/attention/acknowledge", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const body: {
    sourceKind?: unknown;
    sourceId?: unknown;
    token?: unknown;
  } = await c.req.json<{
    sourceKind?: unknown;
    sourceId?: unknown;
    token?: unknown;
  }>().catch((): { sourceKind?: unknown; sourceId?: unknown; token?: unknown } => ({}));
  const sourceKind = body.sourceKind;
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const token = typeof body.token === "string" ? body.token.trim() : "";
  if ((sourceKind !== "scribe" && sourceKind !== "reviewer") || !sourceId || !token) {
    return c.json({ error: "sourceKind, sourceId, and token are required" }, 400);
  }
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const result = await artifactStore.acknowledgePlanAttention({
    repoId: repo.meta.repoId,
    planArtifactId: c.req.param("planArtifactId"),
    sourceKind,
    sourceId,
    token,
  });
  if (result === "conflict") {
    return c.json({ error: "The attention source has a newer token." }, 409);
  }
  if (result === "acknowledged") {
    await broadcastPlanArtifactUpdatedHint(c.env, repo.meta.repoId, c.req.param("planArtifactId"));
  }
  return c.body(null, 204);
});

repoRoutes.get("/api/repos/:repoId/artifacts/:id", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const { artifacts, refs } = await loadRepoArtifacts(artifactStore);
  const artifact = artifacts.find((candidate) => candidate.id === c.req.param("id")) ?? null;
  if (!artifact) {
    return c.json({ error: "Artifact not found" }, 404);
  }
  return c.json({ artifact, refs });
});

repoRoutes.post("/api/repos/:repoId/plans", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const basisCommit = repo.meta.githubDefaultBranchHeadSha ?? null;
  if (repo.meta.gitStatus !== "ready" || repo.meta.gitError || !basisCommit) {
    return c.json({
      error: repo.meta.gitError || "GitHub default branch metadata is not ready yet for this repository.",
      code: "github_repo_default_branch_not_ready",
    }, 409);
  }
  const body = await c.req.json<{ title?: unknown }>().catch((): { title?: unknown } => ({}));
  const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const artifact = await artifactStore.createArtifact({
    repoId: repo.meta.repoId,
    type: "plan",
    basis: {
      repoId: repo.meta.repoId,
      mainCommit: basisCommit,
    },
    title,
    body: { markdown: "" },
    status: "draft",
    createdBy: "user",
  });
  return c.json({ ok: true, artifact }, 201);
});

repoRoutes.patch("/api/repos/:repoId/artifacts/:id/status", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const body: { status?: unknown; expectedVersion?: unknown } = await c.req.json<{
    status?: unknown;
    expectedVersion?: unknown;
  }>().catch(() => ({}));
  if (!isPlanStatus(body.status)) {
    return c.json({ error: "status must be one of draft, evaluating, todo, completed, or archived" }, 400);
  }
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  try {
    const transition = await artifactStore.updateArtifactStatus({
      repoId: repo.meta.repoId,
      id: c.req.param("id"),
      status: body.status,
      expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : null,
    });
    const artifact = transition.artifact;
    await broadcastPlanArtifactUpdatedHint(c.env, repo.meta.repoId, artifact.id);
    if (body.status === "completed" || body.status === "archived") {
      const cleanupPending = transition.cleanupTargets.length > 0;
      const cleanupWarning = transition.cleanupTargets.some((target) => (
        target.kind === "writer" &&
        (target.schemaVersion === 2
          ? target.placement
          : target.launchProvenance)?.backend === "host"
      ))
        ? "Plan moved. Scribe cleanup will finish when Your machine reconnects."
        : "Plan moved. Runtime cleanup will continue in the background.";
      return c.json({
        ok: true,
        artifact,
        ...(cleanupPending ? {
          cleanupPending,
          cleanupCode: "runtime_cleanup_deferred",
          cleanupWarning,
        } : {}),
      });
    }
    return c.json({ ok: true, artifact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update artifact status";
    return c.json({ error: message }, /version mismatch/i.test(message) ? 409 : 404);
  }
});

repoRoutes.delete("/api/repos/:repoId/plans/:artifactId", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const body: { expectedVersion?: unknown } = await c.req.json<{ expectedVersion?: unknown }>().catch(() => ({}));
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const discard = () => artifactStore.discardPlan({
    repoId: repo.meta.repoId,
    id: c.req.param("artifactId"),
    expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : null,
  });
  try {
    const discarded = await discard();
    const artifact = discarded.artifact;
    await broadcastPlanArtifactUpdatedHint(c.env, repo.meta.repoId, artifact.id);
    const cleanupPending = discarded.cleanupTargets.length > 0;
    return c.json({
      ok: true,
      artifact,
      ...(cleanupPending ? {
        cleanupPending,
        cleanupCode: "runtime_cleanup_deferred",
        cleanupWarning: discarded.cleanupTargets.some((target) => (
          target.kind === "writer" &&
          (target.schemaVersion === 2
            ? target.placement
            : target.launchProvenance)?.backend === "host"
        ))
          ? "Plan deleted. Scribe cleanup will finish when Your machine reconnects."
          : "Plan deleted. Runtime cleanup will continue in the background.",
      } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to discard plan";
    const status = /version mismatch|only draft/i.test(message)
      ? 409
      : 404;
    return c.json({ error: message }, status);
  }
});

repoRoutes.post("/api/repos/:repoId/artifacts", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
  if (!loadedRepo.ok) return loadedRepo.response;
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const body = await c.req.json<Record<string, unknown>>();
  if (body.type === "plan") {
    return c.json({ error: "Use the dedicated empty-plan creation endpoint." }, 400);
  }
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
  return getDurableObjectStub<RepoHub>(env, env.HUB, "hub");
}

function sessionEnvJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function sortSessionEnvMetadata(entries: RepoSessionEnvMetadata[]): RepoSessionEnvMetadata[] {
  return [...entries].sort((a, b) => a.name.localeCompare(b.name));
}

function sortMcpServers(servers: RepoMcpServer[]): RepoMcpServer[] {
  return [...servers].sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

async function sessionEnvAccessFailure(response: Response): Promise<Response> {
  const body = await response.clone().json().catch(() => ({ error: "Repository access failed" }));
  return sessionEnvJson(body, response.status);
}

repoRoutes.get("/api/repos/:repoId/session-env", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const entries = await getHub(c.env).listRepoSessionEnv(loadedRepo.repo.meta.repoId);
  return sessionEnvJson({ vars: sortSessionEnvMetadata(entries) });
});

repoRoutes.patch("/api/repos/:repoId/session-env", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const body = await c.req.json().catch(() => null);
  try {
    const patch = normalizeSessionEnvPatch(body);
    const entries = await getHub(c.env).patchRepoSessionEnv(loadedRepo.repo.meta.repoId, patch);
    return sessionEnvJson({ ok: true, vars: sortSessionEnvMetadata(entries) });
  } catch (error) {
    if (error instanceof SessionEnvValidationError) {
      return sessionEnvJson({ error: error.message }, 400);
    }
    throw error;
  }
});

repoRoutes.get("/api/repos/:repoId/mcp-servers", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const servers = await getHub(c.env).listRepoMcpServers(loadedRepo.repo.meta.repoId);
  return sessionEnvJson({ servers: sortMcpServers(servers) });
});

repoRoutes.put("/api/repos/:repoId/mcp-servers", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const body = await c.req.json().catch(() => null);
  const result = await getHub(c.env).putRepoMcpServers(loadedRepo.repo.meta.repoId, body);
  if (!result.ok) {
    return sessionEnvJson({ error: result.error }, 400);
  }
  return sessionEnvJson({ ok: true, servers: sortMcpServers(result.servers) });
});

repoRoutes.delete("/api/repos/:repoId", async (c) => {
  const repoId = c.req.param("repoId");
  const loaded = await loadTrackedRepoForRequest(c.env, c.req.raw, repoId);
  if (!loaded.ok) return c.json(loaded.body, loaded.status as any);
  const repo = loaded.repo;

  const envDefinitionSlugs = await listEnvDefinitionSlugs(c.env);
  const attachedEnvDefinitions: EnvDefinition[] = [];
  for (const slug of envDefinitionSlugs) {
    const definition = await readEnvDefinition(c.env, slug);
    if (definition?.repoId === repoId) {
      attachedEnvDefinitions.push(definition);
    }
  }
  const blockers: Array<{ kind: string; id: string; label: string }> = [];
  for (const definition of attachedEnvDefinitions) {
    blockers.push({ kind: "environment", id: definition.slug, label: definition.slug });
    const lifecycle = getEnvLifecycleStub(c.env, definition.slug);
    const [reviewRuns, publish] = await Promise.all([
      getEnvReviewStub(c.env, definition.slug).listActiveRuns(),
      lifecycle.getGitHubPublishOperation(),
    ]);
    blockers.push(...reviewRuns.map((run) => ({
      kind: "environment_review",
      id: run.runId,
      label: `${definition.slug} review`,
    })));
    if (publish) {
      blockers.push({ kind: "github_publish", id: publish.operationId, label: `${definition.slug} GitHub publish` });
    }
  }
  const artifactStore = getArtifactStoreStub(
    c.env,
    repoId,
    repo.meta.artifactStoreGeneration,
  );
  const [plannerRuns, planWriters, runtimeCleanupTargets] = await Promise.all([
    artifactStore.listPlannerWorkloadStateForPredeploy(repoId),
    artifactStore.listPlanWritersForRepo(repoId),
    artifactStore.listPlanRuntimeCleanupTargetsForRepo(repoId),
  ]);
  for (const run of plannerRuns) {
    if (
      run.status === "queued"
      || run.status === "running"
      || run.status === "saving"
      || run.hasRuntime
    ) {
      blockers.push({
        kind: run.hasRuntime ? "planner_run_runtime" : "planner_run",
        id: run.runId,
        label: run.hasRuntime
          ? `Planner runtime ${run.runId}`
          : `Planner run ${run.runId}`,
      });
    }
  }
  for (const writer of planWriters) {
    if (!writer.stoppedAt && !writer.removedAt) {
      blockers.push({ kind: "plan_writer", id: writer.threadId, label: `Plan Writer ${writer.planArtifactId}` });
    }
    if (writer.runtime || writer.jobSlug) {
      blockers.push({ kind: "plan_writer_runtime", id: writer.threadId, label: `Plan Writer runtime ${writer.threadId}` });
    }
    if (writer.cleanupError) {
      blockers.push({ kind: "plan_writer_cleanup", id: writer.threadId, label: `Plan Writer cleanup ${writer.threadId}` });
    }
  }
  for (const target of runtimeCleanupTargets) {
    blockers.push({
      kind: "plan_runtime_cleanup",
      id: target.cleanupId,
      label: `Pending ${target.kind} cleanup ${target.ownerId}`,
    });
  }
  if (blockers.length > 0) {
    return c.json({
      error: "Repository still owns environments or active work. Resolve every blocker before deleting it.",
      code: "repository_delete_blocked",
      blockers,
    }, 409);
  }

  const hub = getHub(c.env);
  await artifactStore.finalizeRepositoryDeletion(repoId);
  await repo.workspace.destroyWorkspace();
  await deleteRepoIndex(c.env, repoId);
  await hub.deleteRepoSessionEnv(repoId);
  if (typeof hub.deleteRepoMcpServers === "function") {
    await hub.deleteRepoMcpServers(repoId);
  }
  await hub.broadcastRepoRemove(repoId);

  return c.json({
    ok: true,
    repoId,
    deletedEnvSlugs: [],
  });
});

export default repoRoutes;
