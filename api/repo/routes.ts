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
import { getArtifactStoreStub, getEnvLifecycleStub, getEnvReviewStub, getLocationHintOptions } from "../helpers";
import { cleanupPlanWriterRuntime } from "../planner/dispatch";
import { planWriterTerminalId } from "../planner/plan-writer-contract";
import { projectRepoSummary } from "../sync/projectors";
import { isGitHubAppAllowedForRequest } from "../github/app";
import {
  normalizeSessionEnvPatch,
  SessionEnvValidationError,
  type RepoSessionEnvMetadata,
} from "../session-env";
import type { RepoMcpServer } from "../mcp-servers";
import {
  CloudflareMcpUserError,
  buildCloudflareMcpRedirectUri,
  getCloudflareMcpRequestIdentity,
  type CloudflareMcpStatus,
} from "../cloudflare-mcp";
import { resolveCanonicalRequestOrigin } from "../canonical-origin";

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
  | "getRepoCloudflareMcpStatus"
  | "startRepoCloudflareMcpOAuth"
  | "completeRepoCloudflareMcpOAuth"
  | "enableRepoCloudflareMcp"
  | "disableRepoCloudflareMcp"
  | "disconnectRepoCloudflareMcp"
  | "deleteRepoCloudflareMcpIntegration"
  | "revokeCloudflareMcpProxyTokensForEnv"
>;

async function broadcastRepoSummary(
  env: Env,
  repo: RepoMeta,
): Promise<void> {
  const hubId = env.HUB.idFromName("hub");
  const hub = env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as Pick<HubDO, "broadcastRepoUpsert">;
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
): Promise<{
  artifactStore: ReturnType<typeof getArtifactStoreStub>;
  artifacts: Awaited<ReturnType<typeof loadRepoArtifacts>>["artifacts"];
  refs: Awaited<ReturnType<typeof loadRepoArtifacts>>["refs"];
}> {
  const artifactStore = getArtifactStoreStub(
    env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
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
  const { artifacts, refs } = await getRepoArtifactState(c.env, repo);
  return c.json({ artifacts, refs });
});

repoRoutes.get("/api/repos/:repoId/artifacts/:id", async (c) => {
  const loadedRepo = await readTrackedRepoRouteContext(c);
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
    const artifact = await artifactStore.updateArtifactStatus({
      repoId: repo.meta.repoId,
      id: c.req.param("id"),
      status: body.status,
      expectedVersion: typeof body.expectedVersion === "number" ? body.expectedVersion : null,
    });
    if (body.status === "completed" || body.status === "archived") {
      const writer = await artifactStore.getPlanWriter(repo.meta.repoId, artifact.id);
      if (writer?.generation) {
        const fenced = await artifactStore.fencePlanWriterStop({
          repoId: repo.meta.repoId,
          planArtifactId: artifact.id,
          expectedGeneration: writer.generation,
          reason: body.status,
        });
        const stopped = fenced.writer;
        if (stopped) {
          const terminalId = planWriterTerminalId(repo.meta.repoId, artifact.id, writer.generation);
          const hub = getHub(c.env) as unknown as RepoHub & {
            revokePlanWriterTerminal(
              sessionId: string,
              repoId: string,
              planArtifactId: string,
              generation: number,
            ): void | Promise<void>;
            broadcastPlanWriterState(repoId: string, planArtifactId: string): void | Promise<void>;
          };
          await Promise.resolve(
            hub.revokePlanWriterTerminal(terminalId, repo.meta.repoId, artifact.id, writer.generation),
          ).catch(() => undefined);
          if (stopped.runtime || stopped.jobSlug) {
            try {
              await cleanupPlanWriterRuntime(c.env, artifactStore, stopped);
            } catch (cleanupError) {
              const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
              await artifactStore.setPlanWriterError({
                repoId: repo.meta.repoId,
                planArtifactId: artifact.id,
                generation: writer.generation,
                kind: "cleanup",
                error: message,
              });
              await Promise.resolve(hub.broadcastPlanWriterState(repo.meta.repoId, artifact.id)).catch(() => undefined);
              return c.json({ error: `Plan status changed, but the writer cleanup failed: ${message}`, artifact }, 502);
            }
          }
          await Promise.resolve(hub.broadcastPlanWriterState(repo.meta.repoId, artifact.id)).catch(() => undefined);
        }
      }
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
    const artifact = await discard();
    return c.json({ ok: true, artifact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to discard plan";
    const status = /version mismatch|only draft|active planner run|runtime provenance|stop the plan writer/i.test(message)
      ? 409
      : 404;
    const publicMessage = /runtime provenance/i.test(message)
      ? "This plan still retains a Plan Writer runtime. Stop the Plan Writer and retry cleanup before deleting the plan."
      : message;
    return c.json({ error: publicMessage }, status);
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
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as RepoHub;
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

function cloudflareMcpJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function cloudflareMcpFinishPage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #24292f; background: #f6f8fa; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #d0d7de; border-radius: 12px; background: #fff; padding: 24px; box-shadow: 0 16px 40px rgba(31, 35, 40, 0.08); }
    h1 { margin: 0; font-size: 20px; line-height: 1.3; }
    p { margin: 10px 0 0; color: #57606a; font-size: 14px; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p>${message}</p>
  </main>
</body>
</html>`;
}

function cloudflareMcpErrorResponse(error: unknown): Response {
  if (error instanceof CloudflareMcpUserError) {
    return cloudflareMcpJson({ error: error.message, code: error.code }, error.status);
  }
  throw error;
}

function repoCloudflareMcpStatusBody(status: CloudflareMcpStatus): { integration: CloudflareMcpStatus } {
  return { integration: status };
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

repoRoutes.get("/api/repos/:repoId/cloudflare-mcp", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const status = await getHub(c.env).getRepoCloudflareMcpStatus(loadedRepo.repo.meta.repoId);
  return cloudflareMcpJson(repoCloudflareMcpStatusBody(status));
});

repoRoutes.post("/api/repos/:repoId/cloudflare-mcp/connect", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  try {
    const hubOrigin = await resolveCanonicalRequestOrigin(c.env, c.req.raw);
    const redirectUri = buildCloudflareMcpRedirectUri(hubOrigin, loadedRepo.repo.meta.repoId);
    const started = await getHub(c.env).startRepoCloudflareMcpOAuth(loadedRepo.repo.meta.repoId, {
      redirectUri,
      hubOrigin,
      requestIdentity: getCloudflareMcpRequestIdentity(c.req.raw),
    });
    return cloudflareMcpJson({ ok: true, ...started });
  } catch (error) {
    return cloudflareMcpErrorResponse(error);
  }
});

repoRoutes.get("/api/repos/:repoId/cloudflare-mcp/callback", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const code = c.req.query("code")?.trim() ?? "";
  const state = c.req.query("state")?.trim() ?? "";
  if (!code || !state) {
    return cloudflareMcpJson({
      error: "Cloudflare MCP OAuth callback is missing code or state.",
      code: "cloudflare_oauth_callback_invalid",
    }, 400);
  }
  try {
    const hubOrigin = await resolveCanonicalRequestOrigin(c.env, c.req.raw);
    const redirectUri = buildCloudflareMcpRedirectUri(hubOrigin, loadedRepo.repo.meta.repoId);
    const status = await getHub(c.env).completeRepoCloudflareMcpOAuth(loadedRepo.repo.meta.repoId, {
      state,
      code,
      redirectUri,
      requestIdentity: getCloudflareMcpRequestIdentity(c.req.raw),
    });
    if (c.req.header("Accept")?.includes("application/json")) {
      return cloudflareMcpJson({ ok: true, ...repoCloudflareMcpStatusBody(status) });
    }
    return c.html(cloudflareMcpFinishPage("Cloudflare API connected", "Return to Tiller to enable Cloudflare API MCP for this repository."));
  } catch (error) {
    if (c.req.header("Accept")?.includes("application/json")) {
      return cloudflareMcpErrorResponse(error);
    }
    if (error instanceof CloudflareMcpUserError) {
      return c.html(cloudflareMcpFinishPage("Cloudflare API connection failed", error.message), error.status as any);
    }
    throw error;
  }
});

repoRoutes.post("/api/repos/:repoId/cloudflare-mcp/enable", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  try {
    const status = await getHub(c.env).enableRepoCloudflareMcp(loadedRepo.repo.meta.repoId);
    return cloudflareMcpJson({ ok: true, ...repoCloudflareMcpStatusBody(status) });
  } catch (error) {
    return cloudflareMcpErrorResponse(error);
  }
});

repoRoutes.post("/api/repos/:repoId/cloudflare-mcp/disable", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const status = await getHub(c.env).disableRepoCloudflareMcp(loadedRepo.repo.meta.repoId);
  return cloudflareMcpJson({ ok: true, ...repoCloudflareMcpStatusBody(status) });
});

repoRoutes.post("/api/repos/:repoId/cloudflare-mcp/disconnect", async (c) => {
  const loadedRepo = await readValidatedRepoRouteContext(c);
  if (!loadedRepo.ok) return sessionEnvAccessFailure(loadedRepo.response);
  const status = await getHub(c.env).disconnectRepoCloudflareMcp(loadedRepo.repo.meta.repoId);
  return cloudflareMcpJson({ ok: true, ...repoCloudflareMcpStatusBody(status) });
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
  const [plannerRuns, planWriters] = await Promise.all([
    artifactStore.listPlannerWorkloadStateForPredeploy(repoId),
    artifactStore.listPlanWritersForRepo(repoId),
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
  if (typeof hub.deleteRepoCloudflareMcpIntegration === "function") {
    await hub.deleteRepoCloudflareMcpIntegration(repoId);
  }
  await hub.broadcastRepoRemove(repoId);

  return c.json({
    ok: true,
    repoId,
    deletedEnvSlugs: [],
  });
});

export default repoRoutes;
