import { Hono, type Context } from "hono";
import { partyserverMiddleware } from "./partyserver-middleware";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HonoEnv, Env, StoredSession } from "./types";
import type { HubDO } from "./hub";
import { parseRpcError } from "./errors";
import { getArtifactStoreStub } from "./helpers";
import {
  authMiddleware,
  hubAuthGuardResponse,
  specializedServiceAuthMiddleware,
} from "./auth";
import {
  DEFAULT_OPENAI_MODEL,
  getStatus as getOpenAIStatus,
} from "./openai-auth";
import setupRoutes from "./setup/routes";
import cliRoutes from "./cli/routes";
import authConnectRoutes from "./cli/auth-connect-routes";
import executionRoutes from "./execution/routes";
import opencodeRoutes from "./opencode/routes";
import voiceRoutes from "./voice/routes";
import envRoutes from "./env/routes";
import envReviewRoutes from "./env-review/routes";
import envReviewRuntimeRoutes from "./env-review/runtime-routes";
import repoRoutes from "./repo/routes";
import plannerRoutes from "./planner/routes";
import plannerRuntimeRoutes from "./planner/runtime-routes";
import githubRoutes from "./github/routes";
import workspaceRoutes from "./workspace/routes";
import updateRoutes from "./update/routes";
import { envExists, loadEnvView } from "./env/view";
import {
  filterRoutableActiveManagedSessions,
  partitionManagedSessionsByLookup,
  readManagedEnvSlugFromMetadata,
  readManagedEnvSlugFromStoredSession,
  readManagedRoleFromStoredSession,
  readManagedRoleFromMetadata,
  readTerminalScopeFromMetadata,
  readTerminalScopeFromStoredSession,
} from "./session-attachment";
import {
  deriveRuntimeSessionAuthority,
  parseRuntimeSessionCreateRequest,
} from "./runtime-session";
import { planWriterTerminalId } from "./planner/plan-writer-contract";
import { verifyPlanWriterRuntimeToken } from "./planner/runtime-token";
import { canonicalIngressResponse } from "./canonical-origin";
import { loadTrackedRepo } from "./repo/access";
import { getDurableObjectStub } from "./durable-object";
import {
  createApiTimingMiddleware,
  recordApiTimingPhase,
} from "./request-timing";
export { TillerVoice } from "./voice/agent";
export { EnvLifecycleDO } from "./env-lifecycle-do";
export { ScheduledRunCapacityDO } from "./scheduled-run-capacity-do";
export { EnvReviewDO } from "./env-review/env-review-do";
export { ArtifactStoreDO } from "./coordination";
export { CodexAuthDO } from "./codex-auth-do";

// ── DO stub helper ──────────────────────────────────────────────────

type HubStub = Pick<
  HubDO,
  | "createSession"
  | "ensurePlanWriterTerminal"
  | "getSession"
  | "getSessions"
  | "getAllSessions"
  | "getRoutableSessionIds"
  | "updateSessionMetadata"
  | "updateSessionAgentState"
  | "updateSessionTodos"
  | "deleteSession"
  | "setSessionActive"
  | "getOrCreateMachine"
  | "getMachines"
  | "getMachineExecutionStatus"
  | "requestLocalRunner"
  | "addMessage"
  | "getMessages"
  | "createPermission"
  | "getPermission"
  | "getPendingPermissions"
  | "resolvePermission"
  | "waitForPermission"
  | "addSessionAllowedTool"
  | "getAllConfig"
  | "getBillingSelections"
  | "setConfig"
>;

function getHub(env: Env): HubStub {
  return getDurableObjectStub<HubStub>(env, env.HUB, "hub");
}

// ── Hono app ────────────────────────────────────────────────────────

const app = new Hono<HonoEnv>();

const RETIRED_HOSTED_AGENT_BODY = {
  error:
    "Hosted agent routes have been retired. Use planner reviewer threads instead.",
} as const;

// Error handler
app.onError((err, c) => {
  const { status, message } = parseRpcError(err);
  return c.json({ error: message }, status as ContentfulStatusCode);
});

app.use("/api/*", createApiTimingMiddleware());

// These subrouters verify their existing run-scoped token at each handler.
// Mount their service-identity middleware before the default-global API guard.
app.route("/", opencodeRoutes);
app.route("/", plannerRuntimeRoutes);
app.route("/", envReviewRuntimeRoutes);
app.get("/api/github/token", specializedServiceAuthMiddleware);
app.post("/api/sessions", specializedServiceAuthMiddleware);
app.put(
  "/api/envs/:slug/review/snapshots/:opId",
  specializedServiceAuthMiddleware,
);

// Auth middleware (classifies public, owner-only, service-capable, and WebSocket routes)
app.use("/api/*", authMiddleware);

// Setup routes remain owner-only even while protection is incomplete — see auth.ts.
app.route("/", setupRoutes);
app.route("/", cliRoutes);
app.route("/", authConnectRoutes);
app.route("/", executionRoutes);
app.route("/", githubRoutes);
app.route("/", updateRoutes);

// ── Health ──────────────────────────────────────────────────────────

app.get("/health", (c) => c.json({ ok: true }));

app.get("/api/installer/probe", (c) => {
  const releaseId = c.env.TILLER_RELEASE_ID?.trim() ?? "";
  if (!/^[0-9a-f]{40}$/.test(releaseId))
    return c.json({ error: "Release marker unavailable" }, 503);
  return c.json({ ok: true, releaseId });
});

// ── Sessions ────────────────────────────────────────────────────────

async function managedEnvExists(env: Env, slug: string): Promise<boolean> {
  return await envExists(env, slug);
}

async function pruneOrphanSession(
  hub: HubStub,
  sessionId: string,
): Promise<void> {
  try {
    await hub.deleteSession(sessionId);
  } catch {
    // Ignore sessions already cleaned up elsewhere.
  }
}

async function requireManagedSession(
  c: {
    env: Env;
    json: (body: unknown, status?: ContentfulStatusCode) => Response;
  },
  hub: HubStub,
  sessionId: string,
): Promise<{ session: StoredSession; envSlug: string } | Response> {
  const session = await hub.getSession(sessionId);
  if (!session) {
    return c.json({ error: "Session not found" }, 404);
  }

  // Plan-writer terminals live outside environment lifecycle routes. Never
  // mistake them for environment orphans and prune their retained history.
  if (readTerminalScopeFromStoredSession(session)?.kind === "plan-writer") {
    return c.json({ error: "Session not found" }, 404);
  }

  const envSlug = readManagedEnvSlugFromStoredSession(session);
  const role = readManagedRoleFromStoredSession(session);
  if (!envSlug || !role || !(await managedEnvExists(c.env, envSlug))) {
    await pruneOrphanSession(hub, sessionId);
    return c.json({ error: "Session not found" }, 404);
  }

  return { session, envSlug };
}

async function requireEnvironmentManagedSession(
  c: Context<HonoEnv>,
  hub: HubStub,
  envSlug: string,
  sessionId: string,
): Promise<{ session: StoredSession } | Response> {
  const authorization = c.get("authorization");
  if (
    authorization.kind !== "global" &&
    (authorization.kind !== "environment" || authorization.envSlug !== envSlug)
  ) {
    return c.json({ error: "Environment authority required" }, 403);
  }
  const managed = await requireManagedSession(c, hub, sessionId);
  if (managed instanceof Response) return managed;
  if (managed.envSlug !== envSlug) {
    return c.json({ error: "Session not found" }, 404);
  }
  return { session: managed.session };
}

async function requireTerminalHistorySession(
  c: {
    env: Env;
    json: (body: unknown, status?: ContentfulStatusCode) => Response;
  },
  hub: HubStub,
  sessionId: string,
): Promise<{ session: StoredSession } | Response> {
  const session = await hub.getSession(sessionId);
  if (!session) return c.json({ error: "Session not found" }, 404);
  const scope = readTerminalScopeFromStoredSession(session);
  if (scope?.kind !== "plan-writer") {
    const managed = await requireManagedSession(c, hub, sessionId);
    return managed instanceof Response ? managed : { session: managed.session };
  }
  if (
    planWriterTerminalId(
      scope.repoId,
      scope.planArtifactId,
      scope.generation,
    ) !== sessionId
  ) {
    return c.json({ error: "Session not found" }, 404);
  }
  const loadedRepo = await loadTrackedRepo(c.env, scope.repoId);
  if (!loadedRepo.ok) {
    return c.json({ error: "Session not found" }, 404);
  }
  const writer = await getArtifactStoreStub(
    c.env,
    scope.repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  ).getPlanWriter(scope.repoId, scope.planArtifactId);
  if (!writer || (writer.generation ?? 0) < scope.generation) {
    return c.json({ error: "Session not found" }, 404);
  }
  return { session };
}

app.get("/api/sessions", async (c) => {
  const hub = getHub(c.env);
  let phaseStartedAt = performance.now();
  const sessions = await hub.getAllSessions();
  recordApiTimingPhase(c, "sessions_load", phaseStartedAt);

  phaseStartedAt = performance.now();
  const { managedSessions, orphanSessionIds } =
    await partitionManagedSessionsByLookup(
      sessions,
      async (envSlug) => await managedEnvExists(c.env, envSlug),
    );
  if (orphanSessionIds.length > 0) {
    await Promise.all(
      orphanSessionIds.map(async (sessionId) =>
        pruneOrphanSession(hub, sessionId),
      ),
    );
  }
  const response = filterRoutableActiveManagedSessions(
    managedSessions,
    await hub.getRoutableSessionIds(),
  );
  recordApiTimingPhase(c, "sessions_validate", phaseStartedAt);
  return c.json(response);
});

app.post("/api/sessions", async (c) => {
  const hub = getHub(c.env);
  const body = await c.req.json<{
    id?: string;
    tag: string;
    machine_id?: string;
    metadata?: unknown;
  }>();
  const terminalScope = readTerminalScopeFromMetadata(body.metadata ?? null);
  if (
    c.get("authorization").kind === "specialized" &&
    terminalScope?.kind !== "plan-writer"
  ) {
    return c.json({ error: "Plan writer authority required" }, 403);
  }
  if (terminalScope?.kind === "plan-writer") {
    if (
      !(await verifyPlanWriterRuntimeToken(
        c.env,
        terminalScope.repoId,
        terminalScope.planArtifactId,
        terminalScope.generation,
        c.req.header("X-Tiller-Plan-Writer-Token"),
      ))
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const id = body.id ?? "";
    if (
      id !==
      planWriterTerminalId(
        terminalScope.repoId,
        terminalScope.planArtifactId,
        terminalScope.generation,
      )
    ) {
      return c.json(
        {
          error:
            "Plan writer terminal ID does not match its deterministic scope.",
        },
        400,
      );
    }
    const loadedRepo = await loadTrackedRepo(c.env, terminalScope.repoId);
    if (!loadedRepo.ok) {
      return c.json(
        { error: "Plan writer generation is no longer active." },
        409,
      );
    }
    const writer = await getArtifactStoreStub(
      c.env,
      terminalScope.repoId,
      loadedRepo.repo.meta.artifactStoreGeneration,
    ).getPlanWriter(terminalScope.repoId, terminalScope.planArtifactId);
    if (
      !writer ||
      writer.stoppedAt ||
      writer.generation !== terminalScope.generation ||
      !writer.runtime
    ) {
      return c.json(
        { error: "Plan writer generation is no longer active." },
        409,
      );
    }
    const ensured = await hub.ensurePlanWriterTerminal(
      id,
      body.tag || "Plan Writer",
      body.machine_id ?? null,
      body.metadata ?? {},
      terminalScope.repoId,
      terminalScope.planArtifactId,
      terminalScope.generation,
    );
    if (ensured.status === "unavailable") {
      return c.json(
        { error: "Plan writer terminal identity is already unavailable." },
        409,
      );
    }
    return c.json(ensured.session, ensured.created ? 201 : 200);
  }
  const envSlug = readManagedEnvSlugFromMetadata(body.metadata ?? null);
  if (!envSlug) {
    return c.json({ error: "sessions must include metadata.envSlug" }, 400);
  }
  const role = readManagedRoleFromMetadata(body.metadata ?? null);
  if (!role) {
    return c.json({ error: "sessions must include metadata.role" }, 400);
  }
  if (!(await envExists(c.env, envSlug))) {
    return c.json(
      { error: `Environment not found for session envSlug: ${envSlug}` },
      404,
    );
  }

  const id = body.id ?? crypto.randomUUID();
  const session = await hub.createSession(
    id,
    body.tag,
    body.machine_id ?? null,
    body.metadata ?? {},
  );
  return c.json(session, 201);
});

app.post("/api/envs/:slug/sessions", async (c) => {
  const authorization = c.get("authorization");
  const slug = c.req.param("slug");
  if (authorization.kind !== "environment" || authorization.envSlug !== slug) {
    return c.json({ error: "Environment authority required" }, 403);
  }
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ error: "Invalid session request" }, 400);
  const parsed = parseRuntimeSessionCreateRequest(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const meta = await loadEnvView(c.env, slug);
  if (!meta || meta.incarnationId !== authorization.incarnationId) {
    return c.json({ error: "Environment runtime is no longer active" }, 409);
  }
  const authority = deriveRuntimeSessionAuthority(slug, meta, parsed.request);
  const session = await getHub(c.env).createSession(
    parsed.request.id || crypto.randomUUID(),
    parsed.request.tag,
    authority.machineId,
    authority.metadata,
  );
  return c.json(session, 201);
});

app.get("/api/envs/:slug/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  const managed = await requireEnvironmentManagedSession(
    c,
    hub,
    c.req.param("slug"),
    c.req.param("id"),
  );
  if (managed instanceof Response) return managed;
  return c.json(managed.session);
});

app.get("/api/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  const managedSession = await requireManagedSession(c, hub, c.req.param("id"));
  if (managedSession instanceof Response) return managedSession;
  return c.json(managedSession.session);
});

app.patch("/api/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  const id = c.req.param("id");
  const managedSession = await requireManagedSession(c, hub, id);
  if (managedSession instanceof Response) return managedSession;
  const body = await c.req.json<{
    metadata?: unknown;
    agent_state?: unknown;
    todos?: unknown;
    metadata_version?: number;
    agent_state_version?: number;
    todos_version?: number;
  }>();

  const results: Record<string, unknown> = {};

  if (body.metadata !== undefined && body.metadata_version !== undefined) {
    results.metadata = await hub.updateSessionMetadata(
      id,
      body.metadata,
      body.metadata_version,
    );
  }
  if (
    body.agent_state !== undefined &&
    body.agent_state_version !== undefined
  ) {
    results.agent_state = await hub.updateSessionAgentState(
      id,
      body.agent_state,
      body.agent_state_version,
    );
  }
  if (body.todos !== undefined && body.todos_version !== undefined) {
    results.todos = await hub.updateSessionTodos(
      id,
      body.todos,
      body.todos_version,
    );
  }

  return c.json(results);
});

app.delete("/api/sessions/:id", async (c) => {
  const hub = getHub(c.env);
  const managedSession = await requireManagedSession(c, hub, c.req.param("id"));
  if (managedSession instanceof Response) return managedSession;
  await hub.deleteSession(c.req.param("id"));
  return c.json({ ok: true });
});

// Session lifecycle actions
app.post("/api/sessions/:id/resume", async (c) => {
  const hub = getHub(c.env);
  const managedSession = await requireManagedSession(c, hub, c.req.param("id"));
  if (managedSession instanceof Response) return managedSession;
  await hub.setSessionActive(c.req.param("id"), true);
  const session = await hub.getSession(c.req.param("id"));
  return c.json(session);
});

app.post("/api/sessions/:id/abort", async (c) => {
  const hub = getHub(c.env);
  const managedSession = await requireManagedSession(c, hub, c.req.param("id"));
  if (managedSession instanceof Response) return managedSession;
  await hub.setSessionActive(c.req.param("id"), false);
  const session = await hub.getSession(c.req.param("id"));
  return c.json(session);
});

app.post("/api/sessions/:id/archive", async (c) => {
  const hub = getHub(c.env);
  const managedSession = await requireManagedSession(c, hub, c.req.param("id"));
  if (managedSession instanceof Response) return managedSession;
  await hub.deleteSession(c.req.param("id"));
  return c.json({ ok: true });
});

// ── Messages ────────────────────────────────────────────────────────

app.get("/api/sessions/:id/messages", async (c) => {
  const hub = getHub(c.env);
  const terminalSession = await requireTerminalHistorySession(
    c,
    hub,
    c.req.param("id"),
  );
  if (terminalSession instanceof Response) return terminalSession;
  const limitRaw = c.req.query("limit");
  const beforeSeqRaw = c.req.query("before_seq");
  const afterSeqRaw = c.req.query("after_seq");

  let limit = 50;
  if (limitRaw !== undefined) {
    const parsedLimit = Number(limitRaw);
    if (
      !Number.isInteger(parsedLimit) ||
      parsedLimit < 1 ||
      parsedLimit > 1000
    ) {
      return c.json(
        { error: "Invalid limit: must be an integer between 1 and 1000" },
        400,
      );
    }
    limit = parsedLimit;
  }

  if (beforeSeqRaw !== undefined && afterSeqRaw !== undefined) {
    return c.json(
      { error: "Invalid query: provide only one of before_seq or after_seq" },
      400,
    );
  }

  let beforeSeq: number | undefined;
  if (beforeSeqRaw !== undefined) {
    const parsedBeforeSeq = Number(beforeSeqRaw);
    if (!Number.isInteger(parsedBeforeSeq) || parsedBeforeSeq < 0) {
      return c.json(
        { error: "Invalid before_seq: must be a non-negative integer" },
        400,
      );
    }
    beforeSeq = parsedBeforeSeq;
  }

  let afterSeq: number | undefined;
  if (afterSeqRaw !== undefined) {
    const parsedAfterSeq = Number(afterSeqRaw);
    if (!Number.isInteger(parsedAfterSeq) || parsedAfterSeq < 0) {
      return c.json(
        { error: "Invalid after_seq: must be a non-negative integer" },
        400,
      );
    }
    afterSeq = parsedAfterSeq;
  }

  const messages = await hub.getMessages(c.req.param("id"), {
    limit,
    beforeSeq,
    afterSeq,
  });
  return c.json(messages);
});

app.post("/api/sessions/:id/messages", async (c) => {
  const hub = getHub(c.env);
  const managedSession = await requireManagedSession(c, hub, c.req.param("id"));
  if (managedSession instanceof Response) return managedSession;
  const body = await c.req.json<{
    id?: string;
    content: unknown;
    local_id?: string;
  }>();

  const id = body.id ?? crypto.randomUUID();
  const result = await hub.addMessage(
    id,
    c.req.param("id"),
    body.content,
    body.local_id ?? null,
  );

  return c.json(result, 201);
});

// ── Permissions ─────────────────────────────────────────────────────

async function createPermissionForSession(
  c: Context<HonoEnv>,
  hub: HubStub,
  sessionId: string,
): Promise<Response> {
  const body = await c.req.json<{
    id?: string;
    tool_name: string;
    tool_input?: unknown;
  }>();
  const permission = await hub.createPermission(
    body.id ?? crypto.randomUUID(),
    sessionId,
    body.tool_name,
    body.tool_input ?? {},
  );
  return c.json(permission, 201);
}

async function getPermissionForSession(
  c: Context<HonoEnv>,
  hub: HubStub,
  sessionId: string,
  permId: string,
): Promise<Response> {
  const wait = c.req.query("wait") === "true";
  const permission = await hub.getPermission(permId);
  if (!permission || permission.session_id !== sessionId) {
    return c.json({ error: "Permission not found" }, 404);
  }
  if (!wait) return c.json(permission);
  if (permission.status !== "pending") {
    return c.json({
      status: permission.status,
      decision_reason: permission.decision_reason ?? undefined,
    });
  }
  return c.json(await hub.waitForPermission(permId));
}

app.post("/api/envs/:slug/sessions/:id/permissions", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const managed = await requireEnvironmentManagedSession(
    c,
    hub,
    c.req.param("slug"),
    sessionId,
  );
  if (managed instanceof Response) return managed;
  return createPermissionForSession(c, hub, sessionId);
});

app.get("/api/envs/:slug/sessions/:id/permissions/:permId", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const managed = await requireEnvironmentManagedSession(
    c,
    hub,
    c.req.param("slug"),
    sessionId,
  );
  if (managed instanceof Response) return managed;
  return getPermissionForSession(c, hub, sessionId, c.req.param("permId"));
});

app.post("/api/sessions/:id/permissions", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const managedSession = await requireManagedSession(c, hub, sessionId);
  if (managedSession instanceof Response) return managedSession;
  return createPermissionForSession(c, hub, sessionId);
});

app.get("/api/sessions/:id/permissions", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const managedSession = await requireManagedSession(c, hub, sessionId);
  if (managedSession instanceof Response) return managedSession;
  const permissions = await hub.getPendingPermissions(sessionId);
  return c.json(permissions);
});

app.get("/api/sessions/:id/permissions/:permId", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const managedSession = await requireManagedSession(c, hub, sessionId);
  if (managedSession instanceof Response) return managedSession;
  return getPermissionForSession(c, hub, sessionId, c.req.param("permId"));
});

app.post("/api/sessions/:id/permissions/:permId", async (c) => {
  const hub = getHub(c.env);
  const sessionId = c.req.param("id");
  const managedSession = await requireManagedSession(c, hub, sessionId);
  if (managedSession instanceof Response) return managedSession;
  const permId = c.req.param("permId");
  const body = await c.req.json<{
    status: "allowed" | "denied";
    decision_reason?: string;
    allow_for_session?: boolean;
  }>();
  const permission = await hub.getPermission(permId);
  if (!permission || permission.session_id !== sessionId) {
    return c.json({ error: "Permission not found" }, 404);
  }

  const resolvedPermission = await hub.resolvePermission(
    permId,
    body.status,
    body.decision_reason,
    body.allow_for_session,
  );
  if (!resolvedPermission)
    return c.json({ error: "Permission not found or already resolved" }, 404);
  return c.json(resolvedPermission);
});

// ── Machines ────────────────────────────────────────────────────────

app.get("/api/machines", async (c) => {
  const hub = getHub(c.env);
  return c.json(await hub.getMachines());
});

app.get("/api/machines/:machineId/execution-status", async (c) => {
  c.header("Cache-Control", "no-store");
  const machineId = c.req.param("machineId")?.trim() ?? "";
  if (!machineId) return c.json({ error: "machineId is required" }, 400);
  const hub = getHub(c.env);
  return c.json(await hub.getMachineExecutionStatus(machineId));
});

app.post("/api/machines", async (c) => {
  const hub = getHub(c.env);
  const body = await c.req.json<{
    id: string;
    metadata?: unknown;
  }>();

  const machine = await hub.getOrCreateMachine(body.id, body.metadata ?? {});
  return c.json(machine, 201);
});

// ── Environments (sandbox) ────────────────────────────────────────────

app.get("/api/auth/openai/status", async (c) => {
  const status = await getOpenAIStatus(c.env);
  return c.json({
    ...status,
    model: c.env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL,
  });
});

app.all("/api/agents", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(RETIRED_HOSTED_AGENT_BODY, 410);
});

app.route("/", envRoutes);
app.route("/", envReviewRoutes);
app.route("/", plannerRoutes);
app.route("/", repoRoutes);

// ── Workspace files ──────────────────────────────────────────────────

app.route("/", workspaceRoutes);

// ── Voice session WebSocket ──────────────────────────────────────────

app.route("/", voiceRoutes);

// Unknown and removed API endpoints must never fall through to the SPA.
app.all("/api/*", (c) => c.json({ error: "Not found" }, 404));

// ── WebSocket upgrade via partyserver ───────────────────────────────

app.use("/parties/*", (c, next) => {
  const [prefix, namespace] = new URL(c.req.url).pathname
    .split("/")
    .filter(Boolean);
  if (prefix === "parties" && namespace === "reviewer-chat") {
    return hubAuthGuardResponse(c.req.raw, c.env).then((blocked) => {
      if (blocked) return blocked;
      c.header("Cache-Control", "no-store");
      return c.json(RETIRED_HOSTED_AGENT_BODY, 410);
    });
  }
  const middleware = partyserverMiddleware();
  return middleware(c as never, next as never);
});

// ── SPA fallback ────────────────────────────────────────────────────

app.get("*", (c) => c.env.ASSETS.fetch(c.req.raw));

// ── Worker export ───────────────────────────────────────────────────

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const ingress = await canonicalIngressResponse(req, env);
    if (ingress) return ingress;
    const url = new URL(req.url);
    if (url.pathname.startsWith("/agents/")) {
      const blocked = await hubAuthGuardResponse(req, env);
      if (blocked) return blocked;
      return Response.json(RETIRED_HOSTED_AGENT_BODY, {
        status: 410,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const isPartyWs =
      req.headers.get("Upgrade")?.toLowerCase() === "websocket" &&
      url.pathname.startsWith("/parties/");
    if (isPartyWs) {
      const t = Date.now();
      const resp = await app.fetch(req, env, ctx);
      console.log(
        `[Worker] party WS ${url.pathname} → ${resp.status} in ${Date.now() - t}ms`,
      );
      return resp;
    }
    return app.fetch(req, env, ctx);
  },
};

// Export Durable Object classes for wrangler
export { HubDO } from "./hub";
export { ReviewerChatAgent } from "./agents/reviewer-chat-agent";
export {
  ArtifactStoreDO as RepoArtifactStoreDO,
  ThreadDO,
} from "./coordination";
export { GitHubJobDO } from "./github-job-do";
export { SandboxDO } from "./sandbox-do";
export { PlannerRunDO } from "./planner-run-do";
export { WorkspaceDO } from "./workspace/do";
