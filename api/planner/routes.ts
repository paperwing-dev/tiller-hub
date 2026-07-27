import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getArtifactStoreStub, getLocationHintOptions, getThreadStub } from "../helpers";
import { loadTrackedRepoForRequest } from "../repo/access";
import {
  listPlannerProviders,
  findPlannerProviderEffort,
  findPlannerProviderModel,
  getPlannerProviderModelDefaultEffort,
  isKnownPlannerProviderModel,
} from "./providers";
import { appendThreadMessage, executeReviewerRun, isActiveRun } from "./runtime";
import {
  cleanupPlannerRunRuntime,
  cleanupPlanWriterRuntime,
  dispatchPlannerRun,
  ensurePlanWriterRuntime,
  inspectPlanWriterRuntime,
  resolvePlannerExecution,
  type PlannerExecution,
} from "./dispatch";
import {
  renderArtifactBodyMarkdown,
  type AgentSkillDefinition,
  type PlannerRun,
  type PlannerRunBasis,
  type PlannerRunEvent,
  type PlannerRunSkillSnapshot,
  type PlannerEffort,
  type ReviewerRegistryEntry,
  type PlanWriterProvider,
  type PlanWriterStopReason,
  type SkillSurface,
} from "../coordination";
import { MAX_PLAN_MARKDOWN_BYTES } from "../coordination/planning";
import {
  DEFAULT_PLAN_WRITING_INSTRUCTIONS,
  effectivePlanWritingInstructions,
  normalizeCustomPlanWritingInstructions,
} from "./writer-instructions";
import {
  DEFAULT_PLAN_WRITER_ROUTE_KEY,
  builtInSkill,
  listCanonicalAgentRoutes,
  mergeStoredAgentSkills,
  normalizeSkillDefinition,
  resolveAgentRoute,
  resolveSkillAgentRoutes,
} from "./agent-skills";
import {
  derivePlanWriterState,
  isPlanWriterProvider,
  normalizeCanonicalPlanForDigest,
  planWriterTerminalId,
  sha256Hex,
} from "./plan-writer-contract";
import { verifyPlanWriterRuntimeToken } from "./runtime-token";
import {
  claudePlanSkillProjectionRevision,
  validateClaudePlanSkillProjection,
} from "./claude-plan-skill-projection";
import { backendSelectionRemovedError } from "../execution";
import {
  isCurrentLaunchProvenance,
  isCurrentPlanWriterRuntimeProvenance,
} from "../coordination/execution-provenance";

const STALE_ACTIVE_RUN_MS = 15 * 60 * 1000;
const STALE_RUN_ERROR = "Reviewer run timed out without reporting a result.";
const plannerRoutes = new Hono<HonoEnv>();

function isEditablePlanStatus(status: unknown): boolean {
  return status !== "completed" && status !== "archived";
}

async function broadcastWriterStateHint(c: any, repoId: string, planArtifactId: string): Promise<void> {
  try {
    const hubId = c.env.HUB.idFromName("hub");
    const hub = c.env.HUB.get(hubId, getLocationHintOptions(c.env)) as unknown as {
      broadcastPlanWriterState(repoId: string, planArtifactId: string): void | Promise<void>;
    };
    await hub.broadcastPlanWriterState(repoId, planArtifactId);
  } catch {
    // Hints are lossy; clients reconcile authoritative state on reconnect.
  }
}

async function broadcastPlanArtifactHint(c: any, repoId: string, planArtifactId: string): Promise<void> {
  try {
    const hubId = c.env.HUB.idFromName("hub");
    const hub = c.env.HUB.get(hubId, getLocationHintOptions(c.env)) as unknown as {
      broadcastPlanArtifactUpdated(repoId: string, planArtifactId: string): void | Promise<void>;
    };
    await hub.broadcastPlanArtifactUpdated(repoId, planArtifactId);
  } catch {
    // Hints are lossy; clients reconcile authoritative state on reconnect.
  }
}

type LoadedPlanContext =
  | {
      ok: true;
      repoId: string;
      repoUrl: string;
      githubFullName: string;
      githubBaseCommitSha: string | null;
      gitStatus: string | null;
      gitError: string | null;
      mainCommit: string | null;
      artifactStore: ReturnType<typeof getArtifactStoreStub>;
      plan: { id: string; repoId: string; type: string };
    }
  | { ok: false; response: Response };

type LoadedPlanSuccess = Extract<LoadedPlanContext, { ok: true }>;

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(c: any): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function readThreadMessageRole(message: { senderSessionId: string; body: unknown }): "user" | "assistant" {
  if (isRecord(message.body) && message.body.role === "assistant") return "assistant";
  if (isRecord(message.body) && message.body.role === "user") return "user";
  return message.senderSessionId === "assistant" ? "assistant" : "user";
}

function readThreadMessageText(message: { body: unknown }): string {
  if (isRecord(message.body) && typeof message.body.text === "string") return message.body.text;
  return typeof message.body === "string" ? message.body : "";
}

function readThreadMessageRunId(message: { body: unknown }): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string" && message.body.runId.trim()
    ? message.body.runId.trim()
    : null;
}

function readThreadMessagePlanVersion(message: { body: unknown }): number | null {
  return isRecord(message.body) && typeof message.body.planVersion === "number" && Number.isInteger(message.body.planVersion)
    ? message.body.planVersion
    : null;
}

async function failActivePlannerRun(
  artifactStore: LoadedPlanSuccess["artifactStore"],
  run: PlannerRun,
  message: string,
  env?: HonoEnv["Bindings"],
): Promise<PlannerRun | null> {
  const failed = await artifactStore.updateActivePlannerRun({
    runId: run.runId,
    status: "failed",
    completedAt: new Date().toISOString(),
    error: message,
  });
  if (failed.status === "failed") {
    await artifactStore.appendPlannerRunEvent({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      type: "run_failed",
      message,
    });
  }
  if (env && failed.status === "failed" && failed.runtime) {
    void cleanupPlannerRunRuntime(env, artifactStore, failed).catch(() => undefined);
  }
  if (run.threadId && failed.status === "failed") {
    try {
      await artifactStore.updateReviewerRunStateIfCurrent({
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        threadId: run.threadId,
        runId: run.runId,
        status: "failed",
        error: message,
      });
    } catch {
      // The run is failed even if the reviewer tab was removed.
    }
  }
  return failed;
}

// Lazy watchdog: an active run that stopped reporting must not survive forever,
// because the one-active-run rule would block every future run for this plan.
async function failStaleActivePlannerRun(
  artifactStore: LoadedPlanSuccess["artifactStore"],
  run: PlannerRun | null,
  env?: HonoEnv["Bindings"],
): Promise<PlannerRun | null> {
  if (!run || !isActiveRun(run)) return run;
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) return run;

  // A long run whose container is still in contact is not stale: staleness is
  // measured from the most recent signal — start time, last persisted event,
  // or last runtime callback. Empty status polls update callback contact even
  // though they do not create model-progress events.
  const lastEventAt = await artifactStore.getLastPlannerRunEventAt(run.runId);
  const signals = [startedAtMs, Date.parse(lastEventAt ?? ""), Date.parse(run.lastContactAt ?? "")]
    .filter((value) => Number.isFinite(value));
  if (Date.now() - Math.max(...signals) < STALE_ACTIVE_RUN_MS) return run;
  return failActivePlannerRun(artifactStore, run, STALE_RUN_ERROR, env);
}

function runInBackground(c: any, task: Promise<unknown>): void {
  const guarded = task.catch((error) => {
    console.error("[planner] Background reviewer run failed:", error);
  });
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(guarded);
    return;
  }
  void guarded;
}

async function ignoreAsyncFailure<T>(task: T | Promise<T>): Promise<void> {
  await Promise.resolve(task).then(() => undefined).catch(() => undefined);
}

async function loadPlanContext(c: any): Promise<LoadedPlanContext> {
  const loadedRepo = await loadTrackedRepoForRequest(c.env, c.req.raw, c.req.param("repoId"));
  if (!loadedRepo.ok) {
    return { ok: false, response: c.json(loadedRepo.body, loadedRepo.status as any) };
  }
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const plan = await artifactStore.getArtifact(c.req.param("planArtifactId") || c.req.param("artifactId"));
  if (!plan || plan.repoId !== repo.meta.repoId || plan.type !== "plan") {
    return { ok: false, response: c.json({ error: "Plan artifact not found" }, 404) };
  }
  return {
    ok: true,
    repoId: repo.meta.repoId,
    repoUrl: repo.meta.repoUrl,
    githubFullName: repo.meta.githubFullName,
    githubBaseCommitSha: repo.meta.githubDefaultBranchHeadSha ?? repo.meta.mainCommit ?? null,
    gitStatus: repo.meta.gitStatus ?? null,
    gitError: repo.meta.gitError ?? null,
    mainCommit: repo.meta.githubDefaultBranchHeadSha ?? repo.meta.mainCommit ?? null,
    artifactStore,
    plan,
  };
}

function hasPlannerGitSource(loaded: LoadedPlanSuccess): boolean {
  return Boolean(loaded.githubBaseCommitSha) && loaded.gitStatus === "ready" && !loaded.gitError;
}

function plannerRepoRuntimeSource(loaded: LoadedPlanSuccess): {
  repoId: string;
  repoUrl: string;
  githubFullName: string;
  githubBaseCommitSha: string | null;
} {
  return {
    repoId: loaded.repoId,
    repoUrl: loaded.repoUrl,
    githubFullName: loaded.githubFullName,
    githubBaseCommitSha: loaded.githubBaseCommitSha,
  };
}

function plannerRunBasis(loaded: LoadedPlanSuccess): PlannerRunBasis {
  const plan = loaded.plan as unknown as {
    id: string;
    title: string;
    body: unknown;
    version?: number;
  };
  return {
    artifactId: plan.id,
    title: plan.title,
    markdown: renderArtifactBodyMarkdown(plan.body),
    version: plan.version ?? 1,
    gitBaseCommitSha: loaded.githubBaseCommitSha,
  };
}

function plannerGitUnavailableResponse(c: any): Response {
  return c.json({ error: "Repository GitHub metadata is not ready yet." }, 409);
}

async function loadRepoPlanningContext(c: any): Promise<
  | { ok: true; repoId: string; artifactStore: ReturnType<typeof getArtifactStoreStub> }
  | { ok: false; response: Response }
> {
  const loadedRepo = await loadTrackedRepoForRequest(c.env, c.req.raw, c.req.param("repoId"));
  if (!loadedRepo.ok) {
    return { ok: false, response: c.json(loadedRepo.body, loadedRepo.status as any) };
  }
  const repoId = loadedRepo.repo.meta.repoId;
  return {
    ok: true,
    repoId,
    artifactStore: getArtifactStoreStub(
      c.env,
      repoId,
      loadedRepo.repo.meta.artifactStoreGeneration,
    ),
  };
}

function isSkillSurface(value: unknown): value is SkillSurface {
  return value === "plan" || value === "review";
}

async function listAgentSkills(
  artifactStore: ReturnType<typeof getArtifactStoreStub>,
  repoId: string,
  surface: SkillSurface,
): Promise<AgentSkillDefinition[]> {
  const stored = await artifactStore.listStoredAgentSkills(repoId, surface);
  return mergeStoredAgentSkills(surface, stored);
}

async function resolveAgentSkill(
  artifactStore: ReturnType<typeof getArtifactStoreStub>,
  repoId: string,
  surface: SkillSurface,
  skillId: string,
): Promise<AgentSkillDefinition | null> {
  return (await listAgentSkills(artifactStore, repoId, surface)).find((skill) => skill.id === skillId) ?? null;
}

function duplicateAgentSkillCommand(
  skills: AgentSkillDefinition[],
  command: string,
  excludeSkillId?: string,
): boolean {
  return skills.some((skill) => skill.id !== excludeSkillId && skill.command.toLowerCase() === command.toLowerCase());
}

function skillStorageConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique/i.test(message) && message.includes("planning_skills");
}

async function writeAgentSkill(
  c: any,
  artifactStore: ReturnType<typeof getArtifactStoreStub>,
  repoId: string,
  definition: AgentSkillDefinition,
  status: 200 | 201,
): Promise<Response> {
  try {
    const skill = await artifactStore.upsertStoredAgentSkill({ repoId, definition });
    return c.json({ ok: true, skill }, status);
  } catch (error) {
    if (skillStorageConflict(error)) return c.json({ error: `/${definition.command} already exists` }, 409);
    throw error;
  }
}

function isActiveReviewerForPlan(
  reviewer: ReviewerRegistryEntry | null,
  loaded: LoadedPlanSuccess,
): reviewer is ReviewerRegistryEntry {
  return Boolean(
    reviewer
      && reviewer.role === "reviewer"
      && reviewer.repoId === loaded.repoId
      && reviewer.planArtifactId === loaded.plan.id
      && !reviewer.removedAt,
  );
}

type LoadedRunPollContext =
  | {
      ok: true;
      repoId: string;
      planArtifactId: string;
      artifactStore: ReturnType<typeof getArtifactStoreStub>;
    }
  | { ok: false; response: Response };

// Lighter loader for the high-frequency run polls. Tracked request access stays
// as the authorization layer, but the plan artifact body is not fetched
// every tick: callers validate that the fetched run row's repoId and
// planArtifactId match the URL params instead, which preserves the 404 for a
// runId under a nonexistent plan.
async function loadRunPollContext(c: any): Promise<LoadedRunPollContext> {
  const loadedRepo = await loadTrackedRepoForRequest(c.env, c.req.raw, c.req.param("repoId"));
  if (!loadedRepo.ok) {
    return { ok: false, response: c.json(loadedRepo.body, loadedRepo.status as any) };
  }
  const repoId = loadedRepo.repo.meta.repoId;
  return {
    ok: true,
    repoId,
    planArtifactId: c.req.param("planArtifactId"),
    artifactStore: getArtifactStoreStub(
      c.env,
      repoId,
      loadedRepo.repo.meta.artifactStoreGeneration,
    ),
  };
}

// afterSeq lets pollers fetch only event deltas; absent means all events.
function readAfterSeq(c: any): { ok: true; afterSeq: number | null } | { ok: false; response: Response } {
  const raw = c.req.query("afterSeq");
  if (raw === undefined) return { ok: true, afterSeq: null };
  const afterSeq = Number(raw);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    return { ok: false, response: c.json({ error: "afterSeq must be a non-negative integer" }, 400) };
  }
  return { ok: true, afterSeq };
}

async function requireAvailableProvider(c: any, providerId: string, modelId: string, role: "writer" | "reviewer") {
  if (!isKnownPlannerProviderModel(providerId, modelId)) {
    return { ok: false as const, response: c.json({ error: "Planner provider or model not found" }, 400) };
  }
  const catalog = await listPlannerProviders(c.env, { onlyProviderId: providerId });
  const { providers } = catalog;
  const match = findPlannerProviderModel(providers, providerId, modelId);
  if (!match) {
    return { ok: false as const, response: c.json({ error: "Planner provider or model not found" }, 400) };
  }
  const supportsRole = role === "writer" ? match.provider.capabilities.writer : match.provider.capabilities.reviewer;
  if (!supportsRole) {
    return { ok: false as const, response: c.json({ error: `Planner provider does not support ${role} runs` }, 400) };
  }
  if (!match.provider.available || !match.model.available) {
    return {
      ok: false as const,
      response: c.json({
        error: match.model.disabledReason || match.provider.disabledReasons[0] || "Planner provider is unavailable",
        provider: match.provider,
      }, 409),
    };
  }
  return { ok: true as const, provider: match.provider, model: match.model };
}

async function startReviewerRunForThread(options: {
  c: any;
  loaded: LoadedPlanSuccess;
  threadId: string;
  provider: string;
  model: string;
  skill?: string;
  userText?: string;
  instruction?: string;
  skillSnapshot?: PlannerRunSkillSnapshot;
  skillDefinitionSnapshot?: AgentSkillDefinition;
  basis?: PlannerRunBasis;
  skillInvocationId?: string;
  skillAgentId?: string;
  skillRunRole?: "child_followup";
  effort?: PlannerEffort;
}) {
  const { c, loaded, threadId, provider, model, skill, userText, instruction, skillSnapshot } = options;
  await failStaleActivePlannerRun(
    loaded.artifactStore,
    await loaded.artifactStore.getActiveRunForThread(loaded.repoId, loaded.plan.id, "reviewer", threadId),
    c.env,
  );
  const execution = await resolvePlannerExecution(c.env, provider, {
    codexSurface: "plan-reviewer",
  });
  if (execution.kind === "unavailable") {
    return { ok: false as const, response: c.json({ error: execution.reason }, 409) };
  }
  if (execution.kind === "dispatched" && !hasPlannerGitSource(loaded)) {
    return {
      ok: false as const,
      response: plannerGitUnavailableResponse(c),
    };
  }
  const created = await loaded.artifactStore.createPlannerRunIfNoActive({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    role: "reviewer",
    provider,
    model,
    ...(skill ? { skill } : {}),
    threadId,
    ...(options.skillInvocationId ? { skillInvocationId: options.skillInvocationId } : {}),
    ...(options.skillAgentId ? { skillAgentId: options.skillAgentId } : {}),
    ...(options.skillRunRole ? { skillRunRole: options.skillRunRole } : {}),
    input: {
      ...(instruction || userText ? { instruction: instruction ?? userText } : {}),
      sourcePlanVersion: options.basis?.version ?? (loaded.plan as { version?: number }).version ?? 1,
      githubBaseCommitSha: options.basis?.gitBaseCommitSha ?? loaded.githubBaseCommitSha,
      ...(skillSnapshot ? { skillSnapshot } : {}),
      ...(options.skillDefinitionSnapshot ? { skillDefinitionSnapshot: options.skillDefinitionSnapshot } : {}),
      ...(options.basis ? { basis: options.basis } : { basis: plannerRunBasis(loaded) }),
      ...(options.effort ? { effort: options.effort } : {}),
    },
    launchProvenance: execution.kind === "dispatched"
      ? {
        schemaVersion: 1,
        backend: execution.backend,
        machineId: execution.machineId,
        ...(execution.claudeAuthMode ? { claudeAuthMode: execution.claudeAuthMode } : {}),
        ...(execution.codexExecutionProfile
          ? { codexExecution: execution.codexExecutionProfile }
          : {}),
      }
      : { schemaVersion: 1, backend: "cf", machineId: null },
  });
  if (!created.ok) {
    return {
      ok: false as const,
      response: c.json({ error: "A reviewer run is already active for this tab.", run: created.active }, 409),
    };
  }
  const run = created.run;
  const thread = getThreadStub(c.env, threadId);
  const userMessage = userText
    ? await appendThreadMessage(thread, "user", userText, [loaded.plan.id])
    : null;
  await loaded.artifactStore.updateReviewerRunState({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    threadId,
    runId: run.runId,
    status: "queued",
    error: null,
  });
  await loaded.artifactStore.appendPlannerRunEvent({
    runId: run.runId,
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    type: "run_queued",
    message: "Reviewer run queued.",
    data: { provider, model, ...(skill ? { skill } : {}) },
  });
  if (execution.kind === "dispatched") {
    runInBackground(c, dispatchPlannerRun({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      run,
      repo: plannerRepoRuntimeSource(loaded),
    }));
    return { ok: true as const, run, userMessage };
  }
  runInBackground(c, executeReviewerRun({
    artifactStore: loaded.artifactStore,
    thread,
    run,
  }).then((finished) => loaded.artifactStore.updateReviewerRunStateIfCurrent({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    threadId,
    runId: finished.runId,
    status: finished.status,
    error: finished.error ?? null,
  })));
  return { ok: true as const, run, userMessage };
}

plannerRoutes.get("/api/repos/:repoId/planner-providers", async (c) => {
  const loadedRepo = await loadTrackedRepoForRequest(c.env, c.req.raw, c.req.param("repoId"));
  if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
  const catalog = await listPlannerProviders(c.env);
  return c.json({ providers: catalog.providers, skillRoutes: listCanonicalAgentRoutes(catalog.providers) });
});

plannerRoutes.get("/api/repos/:repoId/skills", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const surface = c.req.query("surface");
  if (!isSkillSurface(surface)) return c.json({ error: "surface must be plan or review" }, 400);
  return c.json({ skills: await listAgentSkills(loaded.artifactStore, loaded.repoId, surface) });
});

plannerRoutes.post("/api/repos/:repoId/skills", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  if (!isSkillSurface(body.surface)) return c.json({ error: "surface must be plan or review" }, 400);
  let definition: AgentSkillDefinition;
  try {
    definition = normalizeSkillDefinition(body, {
      id: crypto.randomUUID(),
      surface: body.surface,
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
      routes: listCanonicalAgentRoutes(),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const skills = await listAgentSkills(loaded.artifactStore, loaded.repoId, definition.surface);
  if (duplicateAgentSkillCommand(skills, definition.command)) {
    return c.json({ error: `/${definition.command} already exists` }, 409);
  }
  return writeAgentSkill(c, loaded.artifactStore, loaded.repoId, definition, 201);
});

plannerRoutes.put("/api/repos/:repoId/skills/:surface/:skillId", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const surface = c.req.param("surface");
  if (!isSkillSurface(surface)) return c.json({ error: "surface must be plan or review" }, 400);
  const existing = await resolveAgentSkill(loaded.artifactStore, loaded.repoId, surface, c.req.param("skillId"));
  if (!existing) return c.json({ error: "Skill not found" }, 404);
  const body = await readJsonBody(c);
  let definition: AgentSkillDefinition;
  try {
    definition = normalizeSkillDefinition({ ...existing, ...body, surface }, {
      id: existing.id,
      surface,
      origin: existing.origin,
      customized: true,
      createdAt: existing.createdAt,
      updatedAt: existing.updatedAt,
      routes: listCanonicalAgentRoutes(),
      ...(existing.origin === "builtin" ? { fixedCommand: builtInSkill(surface).command } : {}),
    });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const skills = await listAgentSkills(loaded.artifactStore, loaded.repoId, surface);
  if (duplicateAgentSkillCommand(skills, definition.command, definition.id)) {
    return c.json({ error: `/${definition.command} already exists` }, 409);
  }
  return writeAgentSkill(c, loaded.artifactStore, loaded.repoId, definition, 200);
});

plannerRoutes.delete("/api/repos/:repoId/skills/:surface/:skillId", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const surface = c.req.param("surface");
  if (!isSkillSurface(surface)) return c.json({ error: "surface must be plan or review" }, 400);
  const existing = await resolveAgentSkill(loaded.artifactStore, loaded.repoId, surface, c.req.param("skillId"));
  if (!existing) return c.json({ error: "Skill not found" }, 404);
  await loaded.artifactStore.deleteStoredAgentSkill(loaded.repoId, surface, existing.id);
  return c.json({ ok: true, ...(existing.origin === "builtin" ? { skill: builtInSkill(surface) } : {}) });
});

plannerRoutes.get("/api/repos/:repoId/plan-writer-settings", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const defaultRoute = resolveAgentRoute(DEFAULT_PLAN_WRITER_ROUTE_KEY);
  const settings = await loaded.artifactStore.getRepoPlanWriterSettings(loaded.repoId, {
    routeKey: DEFAULT_PLAN_WRITER_ROUTE_KEY,
    effort: defaultRoute?.defaultEffort ?? "high",
    planFormat: DEFAULT_PLAN_WRITING_INSTRUCTIONS,
  });
  return c.json({ settings });
});

plannerRoutes.put("/api/repos/:repoId/plan-writer-settings", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  const routeKey = readString(body.routeKey);
  const planFormat = readString(body.planFormat);
  const route = routeKey ? resolveAgentRoute(routeKey) : null;
  if (!route || !isPlanWriterProvider(route.provider)) return c.json({ error: "Unknown Plan Writer route" }, 400);
  const requestedEffort = readString(body.effort) ?? route.defaultEffort;
  if (!route.supportedEfforts.includes(requestedEffort as PlannerEffort)) {
    return c.json({ error: `${route.label} does not support ${requestedEffort} reasoning.` }, 400);
  }
  if (body.fastMode !== undefined && typeof body.fastMode !== "boolean") {
    return c.json({ error: "fastMode must be a boolean" }, 400);
  }
  const fastMode = body.fastMode === true;
  if (fastMode && route.provider !== "codex") {
    return c.json({ error: "Fast mode requires a Codex Plan Writer route." }, 400);
  }
  if (!planFormat) return c.json({ error: "planFormat is required" }, 400);
  const settings = await loaded.artifactStore.setRepoPlanWriterSettings({
    repoId: loaded.repoId,
    routeKey: route.key,
    effort: requestedEffort as PlannerEffort,
    fastMode,
    planFormat,
  });
  return c.json({ ok: true, settings });
});

async function resolvePlanWriterSelection(
  c: any,
  loaded: LoadedPlanSuccess,
  requestedProvider: unknown,
  requestedModel: unknown,
  requestedEffort: unknown,
): Promise<
  | { ok: true; provider: PlanWriterProvider; model: string; effort: PlannerEffort; fastMode: boolean }
  | { ok: false; response: Response }
> {
  const providerInput = readString(requestedProvider);
  const modelInput = readString(requestedModel);
  const effortInput = readString(requestedEffort);
  if (providerInput && !isPlanWriterProvider(providerInput)) {
    return { ok: false, response: c.json({ error: "provider must be claude-code or codex" }, 400) };
  }
  const { providers } = await listPlannerProviders(c.env);
  const configuredDefaultRoute = resolveAgentRoute(DEFAULT_PLAN_WRITER_ROUTE_KEY, providers);
  const settings = await loaded.artifactStore.getRepoPlanWriterSettings(loaded.repoId, {
    routeKey: DEFAULT_PLAN_WRITER_ROUTE_KEY,
    effort: configuredDefaultRoute?.defaultEffort ?? "high",
    planFormat: DEFAULT_PLAN_WRITING_INSTRUCTIONS,
  });
  const defaultRoute = resolveAgentRoute(settings.routeKey, providers);
  const provider: PlanWriterProvider | null = isPlanWriterProvider(providerInput)
    ? providerInput
    : isPlanWriterProvider(defaultRoute?.provider)
      ? defaultRoute.provider
      : null;
  if (!provider) {
    return { ok: false, response: c.json({ error: "Choose an available Claude Code or Codex writer." }, 409) };
  }
  const providerMetadata = providers.find((candidate) => candidate.id === provider);
  const model = modelInput
    ?? (defaultRoute?.provider === provider ? defaultRoute.model : null)
    ?? providerMetadata?.models.find((candidate) => candidate.available)?.id
    ?? null;
  if (!model) {
    return { ok: false, response: c.json({ error: `Choose an available ${provider} model.` }, 409) };
  }
  const available = await requireAvailableProvider(c, provider, model, "writer");
  if (!available.ok) return available;
  const effort = effortInput
    ?? (defaultRoute?.provider === provider && defaultRoute.model === model
      ? settings.effort
      : getPlannerProviderModelDefaultEffort(available.provider, available.model));
  const effortMetadata = findPlannerProviderEffort(available.provider, effort, available.model);
  if (!effortMetadata) {
    return { ok: false, response: c.json({ error: `Unsupported effort for ${available.provider.displayName}.` }, 400) };
  }
  return {
    ok: true,
    provider,
    model,
    effort: effortMetadata.id,
    fastMode: provider === "codex" && settings.fastMode,
  };
}

async function readLiveWriterState(loaded: LoadedPlanSuccess) {
  const writer = await loaded.artifactStore.getPlanWriter(loaded.repoId, loaded.plan.id);
  return derivePlanWriterState(
    writer,
    isEditablePlanStatus((loaded.plan as { status?: unknown }).status),
  );
}

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/live-writer", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  return c.json({ writer: await readLiveWriterState(loaded) });
});

plannerRoutes.put("/api/repos/:repoId/plans/:planArtifactId", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  if (typeof body.markdown !== "string") {
    return c.json({ error: "markdown is required" }, 400);
  }
  if (new TextEncoder().encode(body.markdown).byteLength > MAX_PLAN_MARKDOWN_BYTES) {
    return c.json({ error: `Plan Markdown exceeds ${MAX_PLAN_MARKDOWN_BYTES} UTF-8 bytes` }, 413);
  }
  if (!isEditablePlanStatus((loaded.plan as { status?: unknown }).status)) {
    return c.json({ error: "Only draft, evaluating, or todo plans can be edited." }, 409);
  }

  try {
    const artifact = await loaded.artifactStore.savePlan({
      repoId: loaded.repoId,
      id: loaded.plan.id,
      markdown: body.markdown,
    });
    await broadcastPlanArtifactHint(c, loaded.repoId, loaded.plan.id);
    return c.json({ ok: true, artifact });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save plan";
    const status = /exceeds .*utf-8 bytes/i.test(message)
      ? 413
      : /only draft, evaluating, or todo/i.test(message)
        ? 409
        : /not found/i.test(message)
          ? 404
          : 500;
    return c.json({ error: message }, status);
  }
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/live-writer/start", async (c) => {
  const body = await readJsonBody(c);
  const removedBackendSelection = backendSelectionRemovedError(body);
  if (removedBackendSelection) return c.json(removedBackendSelection, 400);
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  if (!isEditablePlanStatus((loaded.plan as { status?: unknown }).status)) {
    return c.json({ error: "Completed or archived plans cannot start a writer.", writer: await readLiveWriterState(loaded) }, 409);
  }

  let existing = await loaded.artifactStore.getPlanWriter(loaded.repoId, loaded.plan.id);
  const activeReservation = existing && !existing.stoppedAt && !existing.startupError && !existing.cleanupError
    ? existing
    : null;
  if (activeReservation?.runtime) {
    if (
      !isCurrentLaunchProvenance(activeReservation.launchProvenance)
      || !isCurrentPlanWriterRuntimeProvenance(activeReservation.runtime)
    ) {
      return c.json({
        error: "This Plan Writer was created by an unsupported version.",
        writer: await readLiveWriterState(loaded),
      }, 409);
    }
    let live: boolean;
    try {
      live = await inspectPlanWriterRuntime(
        c.env,
        activeReservation.runtime,
        activeReservation.launchProvenance,
      );
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : "Plan Writer runtime inspection failed",
        writer: await readLiveWriterState(loaded),
      }, 502);
    }
    if (live) return c.json({ writer: await readLiveWriterState(loaded) });
    const fenced = await loaded.artifactStore.fencePlanWriterStop({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      expectedGeneration: activeReservation.generation!,
      reason: "runtime_ended",
    });
    existing = fenced.writer ?? activeReservation;
  }
  const reservationStillActive = existing && !existing.stoppedAt && !existing.startupError && !existing.cleanupError
    ? existing
    : null;
  if (!reservationStillActive && (existing?.runtime || existing?.jobSlug)) {
    try {
      existing = await cleanupPlanWriterRuntime(c.env, loaded.artifactStore, existing) ?? existing;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await loaded.artifactStore.setPlanWriterError({
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        generation: existing.generation ?? 0,
        kind: "cleanup",
        error: message,
      });
      await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
      return c.json({ error: message, writer: await readLiveWriterState(loaded) }, 502);
    }
  }

  let writer: ReviewerRegistryEntry;
  if (reservationStillActive) {
    // A request may have been lost after reserving a generation but before
    // launching it. Retried/concurrent Start calls finish that same exact
    // reservation and ignore newly requested provider changes.
    writer = reservationStillActive;
  } else {
    const selection = await resolvePlanWriterSelection(c, loaded, body.provider, body.model, body.effort);
    if (!selection.ok) return selection.response;
    const execution = await resolvePlannerExecution(c.env, selection.provider, { codexSurface: "plan-writer" });
    if (execution.kind !== "dispatched") {
      return c.json({
        error: execution.kind === "unavailable"
          ? execution.reason
          : "Plan Writer requires a container runner backend.",
      }, 409);
    }
    const basisCommit = (loaded.plan as { basis?: { mainCommit?: string | null } }).basis?.mainCommit?.trim() ?? "";
    if (!basisCommit) {
      return c.json({ error: "This plan has no frozen basis commit and cannot start a writer." }, 409);
    }
    const markdown = renderArtifactBodyMarkdown((loaded.plan as { body?: unknown }).body);
    const startBodyDigest = await sha256Hex(normalizeCanonicalPlanForDigest(markdown));
    try {
      writer = await loaded.artifactStore.startPlanWriter({
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        provider: selection.provider,
        model: selection.model,
        effort: selection.effort,
        fastMode: selection.fastMode,
        basisCommit,
        startBodyDigest,
        launchProvenance: {
          schemaVersion: 1,
          backend: execution.backend,
          machineId: execution.machineId,
          ...(execution.claudeAuthMode ? { claudeAuthMode: execution.claudeAuthMode } : {}),
          ...(execution.codexExecutionProfile
            ? { codexExecution: execution.codexExecutionProfile }
            : {}),
        },
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Failed to reserve writer generation" }, 409);
    }
  }

  try {
    writer = await ensurePlanWriterRuntime({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      writer,
      repo: plannerRepoRuntimeSource(loaded),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const current = await loaded.artifactStore.getPlanWriter(loaded.repoId, loaded.plan.id);
    if (current && current.generation === writer.generation && current.stoppedAt) {
      await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
      return c.json({ writer: await readLiveWriterState(loaded) });
    }
    await loaded.artifactStore.setPlanWriterError({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      generation: writer.generation ?? 0,
      kind: "startup",
      error: message,
    });
    await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
    return c.json({ error: message, writer: await readLiveWriterState(loaded) }, 502);
  }
  await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
  return c.json({ writer: await readLiveWriterState(loaded) }, 202);
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/live-writer/stop", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  const expectedGeneration = body.expectedGeneration;
  if (!Number.isInteger(expectedGeneration) || (expectedGeneration as number) < 1) {
    return c.json({ error: "expectedGeneration must be a positive integer" }, 400);
  }
  const fenced = await loaded.artifactStore.fencePlanWriterStop({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    expectedGeneration: expectedGeneration as number,
    reason: "user" satisfies PlanWriterStopReason,
  });
  if (fenced.status === "not_found") {
    return c.json({ error: "Plan writer not found", writer: await readLiveWriterState(loaded) }, 404);
  }
  if (fenced.status === "stale") {
    return c.json({ error: "The writer generation changed; the replacement was not stopped.", writer: await readLiveWriterState(loaded) }, 409);
  }
  const writer = fenced.writer!;
  try {
    const hubId = c.env.HUB.idFromName("hub");
    const hub = c.env.HUB.get(hubId, getLocationHintOptions(c.env)) as unknown as {
      revokePlanWriterTerminal(sessionId: string, repoId: string, planArtifactId: string, generation: number): void | Promise<void>;
    };
    await hub.revokePlanWriterTerminal(
      planWriterTerminalId(loaded.repoId, loaded.plan.id, expectedGeneration as number),
      loaded.repoId,
      loaded.plan.id,
      expectedGeneration as number,
    );
  } catch {
    // A terminal row may not exist yet when Starting is cancelled.
  }
  if (writer.runtime || writer.jobSlug) {
    try {
      await cleanupPlanWriterRuntime(c.env, loaded.artifactStore, writer);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await loaded.artifactStore.setPlanWriterError({
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        generation: expectedGeneration as number,
        kind: "cleanup",
        error: message,
      });
      await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
      return c.json({ error: message, writer: await readLiveWriterState(loaded) }, 502);
    }
  }
  await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
  return c.json({ writer: await readLiveWriterState(loaded) });
});

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/contributions", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const status = c.req.query("status");
  const contributions = await loaded.artifactStore.listPlanContributions(
    loaded.repoId,
    loaded.plan.id,
    status === "pending" || status === "incorporated" || status === "dismissed" ? { status } : {},
  );
  return c.json({ contributions });
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/contributions", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  const text = readString(body.text);
  const provider = readString(body.provider) ?? "manual";
  const model = readString(body.model) ?? "manual";
  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }
  const contribution = await loaded.artifactStore.createPlanContribution({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    sourceRunId: readString(body.sourceRunId) ?? undefined,
    sourceThreadId: readString(body.sourceThreadId) ?? undefined,
    provider,
    model,
    skill: readString(body.skill) ?? undefined,
    text,
  });
  return c.json({ ok: true, contribution }, 201);
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/contributions/:contributionId/dismiss", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  try {
    const contribution = await loaded.artifactStore.dismissPlanContribution(
      loaded.repoId,
      loaded.plan.id,
      c.req.param("contributionId"),
    );
    return c.json({ ok: true, contribution });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Plan contribution not found" }, 404);
  }
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/contributions/:contributionId/incorporate", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  try {
    const [contribution] = await loaded.artifactStore.incorporatePlanContributions(
      loaded.repoId,
      loaded.plan.id,
      [c.req.param("contributionId")],
    );
    return c.json({ ok: true, contribution });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Plan contribution not found" }, 404);
  }
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId/messages/:messageId/send-to-writer", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const threadId = c.req.param("threadId");
  const messageId = c.req.param("messageId");
  const reviewer = await loaded.artifactStore.getReviewer(threadId);
  if (!isActiveReviewerForPlan(reviewer, loaded)) {
    return c.json({ error: "Reviewer not found" }, 404);
  }
  const thread = getThreadStub(c.env, reviewer.threadId);
  const message = typeof (thread as { getMessage?: unknown }).getMessage === "function"
    ? await (thread as any).getMessage(messageId)
    : (await thread.listMessages({ limit: 200 })).find((candidate: any) => candidate.id === messageId) ?? null;
  if (!message || message.threadId !== reviewer.threadId) {
    return c.json({ error: "Reviewer message not found" }, 404);
  }
  if (Array.isArray(message.artifactIds) && message.artifactIds.length > 0 && !message.artifactIds.includes(loaded.plan.id)) {
    return c.json({ error: "Reviewer message does not belong to this plan" }, 404);
  }
  if (readThreadMessageRole(message) !== "assistant") {
    return c.json({ error: "Only reviewer assistant messages can be sent to the writer" }, 400);
  }
  const text = readThreadMessageText(message).trim();
  if (!text) {
    return c.json({ error: "Reviewer message has no text to send" }, 400);
  }
  const messageRunId = readThreadMessageRunId(message);
  const messageRun = messageRunId ? await loaded.artifactStore.getPlannerRun(messageRunId) : null;
  const sourceRun = messageRun
    && messageRun.repoId === loaded.repoId
    && messageRun.planArtifactId === loaded.plan.id
    && messageRun.role === "reviewer"
    && messageRun.threadId === reviewer.threadId
    ? messageRun
    : null;
  const result = await loaded.artifactStore.createOrGetPlanContribution({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    sourceKind: "reviewer_message",
    ...(sourceRun ? { sourceRunId: sourceRun.runId } : {}),
    sourceThreadId: reviewer.threadId,
    sourceMessageId: message.id,
    sourcePlanVersion: readThreadMessagePlanVersion(message)
      ?? sourceRun?.input?.sourcePlanVersion
      ?? (loaded.plan as { version?: number }).version
      ?? 1,
    idempotencyKey: `reviewer-message:${reviewer.threadId}:${message.id}`,
    provider: sourceRun?.provider ?? reviewer.provider,
    model: sourceRun?.model ?? reviewer.model,
    ...(sourceRun?.skill ? { skill: sourceRun.skill } : {}),
    text,
  });
  if (result.status === "conflict") {
    return c.json({
      error: "Forwarded reviewer message changed for an existing idempotency key.",
      contribution: result.contribution,
      expectedDigest: result.expectedDigest,
      actualDigest: result.actualDigest,
    }, 409);
  }
  return c.json({
    ok: true,
    contribution: result.contribution,
    created: result.status === "created",
  }, result.status === "created" ? 201 : 200);
});

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/runs/latest", async (c) => {
  const loaded = await loadRunPollContext(c);
  if (!loaded.ok) return loaded.response;
  const afterSeq = readAfterSeq(c);
  if (!afterSeq.ok) return afterSeq.response;
  const role = c.req.query("role");
  if (role !== "reviewer") return c.json({ error: "role=reviewer is required" }, 400);
  const threadId = readString(c.req.query("threadId") ?? null);
  const latest = await loaded.artifactStore.getLatestPlannerRun(loaded.repoId, loaded.planArtifactId, role, threadId ?? null);
  if (!latest) {
    return c.json({ run: null, events: [] });
  }
  const run = await failStaleActivePlannerRun(loaded.artifactStore, latest, c.env) ?? latest;
  const events = await loaded.artifactStore.listPlannerRunEvents(run.runId, { afterSeq: afterSeq.afterSeq });
  return c.json({ run, events });
});

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/runs/:runId", async (c) => {
  const loaded = await loadRunPollContext(c);
  if (!loaded.ok) return loaded.response;
  const afterSeq = readAfterSeq(c);
  if (!afterSeq.ok) return afterSeq.response;
  const fetched = await loaded.artifactStore.getPlannerRun(c.req.param("runId"));
  if (!fetched || fetched.role !== "reviewer" || fetched.repoId !== loaded.repoId || fetched.planArtifactId !== loaded.planArtifactId) {
    return c.json({ error: "Reviewer run not found" }, 404);
  }
  const run = await failStaleActivePlannerRun(loaded.artifactStore, fetched, c.env) ?? fetched;
  const events = await loaded.artifactStore.listPlannerRunEvents(run.runId, { afterSeq: afterSeq.afterSeq });
  return c.json({ run, events });
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/runs/:runId/cancel", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const run = await loaded.artifactStore.getPlannerRun(c.req.param("runId"));
  if (!run || run.role !== "reviewer" || run.repoId !== loaded.repoId || run.planArtifactId !== loaded.plan.id) {
    return c.json({ error: "Reviewer run not found" }, 404);
  }
  if (!isActiveRun(run)) {
    if (run.runtime) {
      runInBackground(c, cleanupPlannerRunRuntime(c.env, loaded.artifactStore, run));
    }
    return c.json({ ok: true, run });
  }
  const cancelled = await loaded.artifactStore.cancelActivePlannerRun(run.runId, {
    allowSaving: false,
    completedAt: new Date().toISOString(),
  });
  if (cancelled.status !== "cancelled") {
    return c.json({ ok: true, ignored: true, run: cancelled });
  }
  await loaded.artifactStore.appendPlannerRunEvent({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    type: "run_cancelled",
    message: "Reviewer run cancelled.",
  });
  // Kill the container too; the in-band status poll is only the backstop.
  if (cancelled.runtime) {
    runInBackground(c, cleanupPlannerRunRuntime(c.env, loaded.artifactStore, cancelled));
  }
  if (run.threadId) {
    try {
      await loaded.artifactStore.updateReviewerRunStateIfCurrent({
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        threadId: run.threadId,
        runId: run.runId,
        status: "cancelled",
        error: null,
      });
    } catch {
      // The run remains cancelled even if the reviewer tab was removed.
    }
  }
  return c.json({ ok: true, run: cancelled });
});

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/reviewers", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  return c.json({ reviewers: await loaded.artifactStore.listReviewers(loaded.repoId, loaded.plan.id) });
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/reviewers", async (c) => {
  const body = await readJsonBody(c);
  const removedBackendSelection = backendSelectionRemovedError(body);
  if (removedBackendSelection) return c.json(removedBackendSelection, 400);
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const provider = readString(body.provider);
  const model = readString(body.model);
  const requestedEffort = readString(body.effort);
  if (!provider || !model) {
    return c.json({ error: "provider and model are required" }, 400);
  }
  const providerState = await requireAvailableProvider(c, provider, model, "reviewer");
  if (!providerState.ok) return providerState.response;
  const effort = requestedEffort
    ?? getPlannerProviderModelDefaultEffort(providerState.provider, providerState.model);
  const effortMetadata = findPlannerProviderEffort(providerState.provider, effort, providerState.model);
  if (!effortMetadata) return c.json({ error: `Unsupported effort for ${providerState.provider.displayName}.` }, 400);
  const reviewer = await loaded.artifactStore.upsertReviewer({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    provider,
    model,
    effort: effortMetadata.id,
  });
  const thread = getThreadStub(c.env, reviewer.threadId);
  await thread.createThread({
    id: reviewer.threadId,
    scope: { type: "repo", repoId: loaded.repoId },
    kind: "chat",
    title: `${providerState.provider.displayName} ${providerState.model.displayName}`,
  });
  return c.json({ ok: true, reviewer }, 201);
});

plannerRoutes.delete("/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const existing = await loaded.artifactStore.getReviewer(c.req.param("threadId"));
  if (!existing || existing.role !== "reviewer" || existing.repoId !== loaded.repoId || existing.planArtifactId !== loaded.plan.id) {
    return c.json({ error: "Reviewer not found" }, 404);
  }
  if (existing.skillInvocationId) {
    return c.json({ error: "Skill child tabs are retained with invocation history. Cancel the invocation instead." }, 409);
  }
  try {
    const reviewer = await loaded.artifactStore.removeReviewer(
      loaded.repoId,
      loaded.plan.id,
      c.req.param("threadId"),
    );
    return c.json({ ok: true, reviewer });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Reviewer not found";
    return c.json({ error: message }, /not found/i.test(message) ? 404 : 502);
  }
});

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId/messages", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const reviewer = await loaded.artifactStore.getReviewer(c.req.param("threadId"));
  if (!isActiveReviewerForPlan(reviewer, loaded)) {
    return c.json({ error: "Reviewer not found" }, 404);
  }
  const thread = getThreadStub(c.env, reviewer.threadId);
  return c.json({ messages: (await thread.listMessages({ limit: 200 })).slice().reverse() });
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId/messages", async (c) => {
  const body = await readJsonBody(c);
  const removedBackendSelection = backendSelectionRemovedError(body);
  if (removedBackendSelection) return c.json(removedBackendSelection, 400);
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const reviewer = await loaded.artifactStore.getReviewer(c.req.param("threadId"));
  if (!isActiveReviewerForPlan(reviewer, loaded)) {
    return c.json({ error: "Reviewer not found" }, 404);
  }
  const providerState = await requireAvailableProvider(c, reviewer.provider, reviewer.model, "reviewer");
  if (!providerState.ok) return providerState.response;
  const text = readString(body.text);
  if (!text) return c.json({ error: "text is required" }, 400);
  const linkedInvocation = reviewer.skillInvocationId
    ? await loaded.artifactStore.getPlanSkillInvocation(reviewer.skillInvocationId)
    : null;
  if (reviewer.skillInvocationId && (!linkedInvocation || linkedInvocation.repoId !== loaded.repoId || linkedInvocation.planArtifactId !== loaded.plan.id)) {
    return c.json({ error: "Linked skill invocation not found" }, 409);
  }
  const linkedAgent = linkedInvocation?.definitionSnapshot.agents.find((agent) => agent.id === reviewer.skillAgentId) ?? null;
  const started = await startReviewerRunForThread({
    c,
    loaded,
    threadId: reviewer.threadId,
    provider: reviewer.provider,
    model: reviewer.model,
    ...(linkedInvocation ? {
      skill: linkedInvocation.definitionSnapshot.command,
      skillSnapshot: {
        id: linkedInvocation.definitionSnapshot.id,
        command: linkedInvocation.definitionSnapshot.command,
        label: linkedInvocation.definitionSnapshot.label,
        instructions: [linkedInvocation.definitionSnapshot.sharedInstructions, linkedAgent?.instructions ?? ""].filter(Boolean).join("\n\n"),
      },
      skillDefinitionSnapshot: linkedInvocation.definitionSnapshot,
      basis: linkedInvocation.basis,
      skillInvocationId: linkedInvocation.invocationId,
      skillAgentId: reviewer.skillAgentId,
      skillRunRole: "child_followup" as const,
    } : {}),
    effort: linkedAgent?.effort ?? reviewer.effort ?? providerState.provider.defaultEffort,
    userText: text,
  });
  if (!started.ok) return started.response;
  return c.json({
    ok: true,
    run: started.run,
    message: started.userMessage,
  });
});

const SKILL_SETUP_TIMEOUT_MS = 130_000;

async function failStalePlanInvocations(loaded: LoadedPlanSuccess): Promise<void> {
  await loaded.artifactStore.failStalePlanSkillInvocations(
    loaded.repoId,
    loaded.plan.id,
    new Date(Date.now() - SKILL_SETUP_TIMEOUT_MS).toISOString(),
  );
}

function planInvocationResponse(invocation: Awaited<ReturnType<LoadedPlanSuccess["artifactStore"]["getPlanSkillInvocation"]>>, reviewers: ReviewerRegistryEntry[], runs: PlannerRun[]) {
  return { invocation, reviewers, runs };
}

async function validateSkillRoutesForInvocation(c: any, skill: AgentSkillDefinition, role: "writer" | "reviewer") {
  for (const definition of skill.agents) {
    const route = resolveAgentRoute(definition.routeKey);
    if (!route) {
      return { ok: false as const, response: c.json({ error: `Unknown agent route: ${definition.routeKey}` }, 400) };
    }
    if (!route.supportedEfforts.includes(definition.effort)) {
      return {
        ok: false as const,
        response: c.json({ error: `${route.label} does not support ${definition.effort} reasoning.` }, 400),
      };
    }
  }
  const catalog = await listPlannerProviders(c.env);
  const result = resolveSkillAgentRoutes(skill, catalog.providers, role);
  return result.ok
    ? { ok: true as const, resolved: result.resolved }
    : { ok: false as const, response: c.json({ error: result.error }, result.status) };
}

async function setupAndDispatchPlanInvocation(
  c: any,
  loaded: LoadedPlanSuccess,
  invocationId: string,
): Promise<{ ok: true; invocation: NonNullable<Awaited<ReturnType<LoadedPlanSuccess["artifactStore"]["getPlanSkillInvocation"]>>> } | { ok: false; response: Response }> {
  const invocation = await loaded.artifactStore.getPlanSkillInvocation(invocationId);
  if (!invocation) return { ok: false, response: c.json({ error: "Skill invocation not found" }, 404) };
  if (invocation.status !== "setting_up") return { ok: true, invocation };
  const reviewers = await loaded.artifactStore.listPlanSkillInvocationReviewers(invocationId);
  const runs = await loaded.artifactStore.listPlanSkillInvocationRuns(invocationId);
  try {
    for (const reviewer of reviewers) {
      const agent = invocation.definitionSnapshot.agents.find((candidate) => candidate.id === reviewer.skillAgentId);
      if (!agent) throw new Error(`Reserved skill agent is missing: ${reviewer.skillAgentId ?? "unknown"}`);
      const thread = getThreadStub(c.env, reviewer.threadId);
      await thread.createThread({
        id: reviewer.threadId,
        scope: { type: "repo", repoId: loaded.repoId },
        kind: "chat",
        title: agent.label,
      });
      await thread.appendMessage({
        id: `skill-setup:${invocationId}:${agent.id}`,
        senderSessionId: "user",
        seq: 1,
        kind: "chat",
        body: {
          role: "user",
          text: `/${invocation.definitionSnapshot.command}\n\n${invocation.definitionSnapshot.sharedInstructions}\n\nRole: ${agent.instructions}`,
        },
        artifactIds: [loaded.plan.id],
      });
    }
    const preparedRuns = [];
    for (const reservedRun of runs) {
      const run = reservedRun;
      let execution: PlannerExecution;
      if (!isCurrentLaunchProvenance(run.launchProvenance)) {
        throw new Error("Planner run launch provenance is not from the current workload schema.");
      }
      if (run.provider === "fake" || run.provider === "codex-api") {
        execution = { kind: "in-process" };
      } else {
        execution = {
          kind: "dispatched",
          backend: run.launchProvenance.backend,
          machineId: run.launchProvenance.machineId,
          ...(run.launchProvenance.claudeAuthMode
            ? { claudeAuthMode: run.launchProvenance.claudeAuthMode }
            : {}),
          ...(run.launchProvenance.codexExecution
            ? { codexExecutionProfile: run.launchProvenance.codexExecution }
            : {}),
        };
      }
      preparedRuns.push({ run, execution });
      await loaded.artifactStore.appendPlannerRunEvent({
        runId: run.runId,
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        type: "run_queued",
        message: "Skill child run queued.",
        data: { invocationId, agentId: run.skillAgentId, provider: run.provider, model: run.model },
      });
    }
    const active = await loaded.artifactStore.activatePlanSkillInvocation(invocationId);
    if (!active) throw new Error("Failed to activate skill invocation.");
    for (const { run, execution } of preparedRuns) {
      if (execution.kind === "dispatched") {
        runInBackground(c, dispatchPlannerRun({
          env: c.env,
          requestUrl: c.req.url,
          artifactStore: loaded.artifactStore,
          run,
          repo: plannerRepoRuntimeSource(loaded),
        }));
      } else {
        const thread = getThreadStub(c.env, run.threadId!);
        runInBackground(c, executeReviewerRun({ artifactStore: loaded.artifactStore, thread, run }).then((finished) =>
          loaded.artifactStore.updateReviewerRunStateIfCurrent({
            repoId: run.repoId,
            planArtifactId: run.planArtifactId,
            threadId: run.threadId!,
            runId: finished.runId,
            status: finished.status,
            error: finished.error ?? null,
          })));
      }
    }
    return { ok: true, invocation: active };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await loaded.artifactStore.failPlanSkillInvocation(invocationId, message);
    return {
      ok: false,
      response: c.json({ error: message, code: "skill_invocation_terminal", retryable: true }, 502),
    };
  }
}

function planSkillHistoryThreadId(planArtifactId: string): string {
  return `plan-skills-${planArtifactId}`;
}

async function invokePlanSkillCore(
  c: any,
  loaded: LoadedPlanSuccess,
  skillId: string,
  requestId: string,
  options: { definition?: AgentSkillDefinition } = {},
): Promise<Response> {
  await failStalePlanInvocations(loaded);
  let existingInvocation = await loaded.artifactStore.getPlanSkillInvocation(requestId);
  if (existingInvocation) {
    if (
      existingInvocation.repoId !== loaded.repoId
      || existingInvocation.planArtifactId !== loaded.plan.id
      || existingInvocation.parentThreadId !== planSkillHistoryThreadId(loaded.plan.id)
      || existingInvocation.definitionSnapshot.id !== skillId
    ) {
      return c.json({ error: "requestId is already used by a different launch" }, 409);
    }
    if (existingInvocation.status === "setting_up") {
      const setup = await setupAndDispatchPlanInvocation(c, loaded, requestId);
      if (!setup.ok) return setup.response;
      existingInvocation = await loaded.artifactStore.getPlanSkillInvocation(requestId) ?? existingInvocation;
    }
    if (existingInvocation.status === "failed" || existingInvocation.status === "cancelled") {
      return c.json({
        error: existingInvocation.error ?? `Skill invocation is ${existingInvocation.status}.`,
        code: "skill_invocation_terminal",
        invocation: existingInvocation,
      }, 409);
    }
    return c.json({
      kind: "fanout",
      ...planInvocationResponse(
        existingInvocation,
        await loaded.artifactStore.listPlanSkillInvocationReviewers(requestId),
        await loaded.artifactStore.listPlanSkillInvocationRuns(requestId),
      ),
    });
  }
  const skill = options.definition ?? await resolveAgentSkill(loaded.artifactStore, loaded.repoId, "plan", skillId);
  if (!skill) return c.json({ error: "Plan skill not found" }, 404);
  const basis = plannerRunBasis(loaded);

  const routeValidation = await validateSkillRoutesForInvocation(c, skill, "reviewer");
  if (!routeValidation.ok) return routeValidation.response;
  const executionTargets = await Promise.all(routeValidation.resolved.map(({ route }) =>
    resolvePlannerExecution(c.env, route.provider)
  ));
  const unavailableTarget = executionTargets.find((execution) => execution.kind === "unavailable");
  if (unavailableTarget?.kind === "unavailable") {
    return c.json({ error: unavailableTarget.reason }, 409);
  }
  if (executionTargets.some((execution) => execution.kind === "dispatched") && !hasPlannerGitSource(loaded)) {
    return plannerGitUnavailableResponse(c);
  }

  const reserved = await loaded.artifactStore.reservePlanSkillInvocation({
    invocationId: requestId,
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    parentThreadId: planSkillHistoryThreadId(loaded.plan.id),
    definitionSnapshot: skill,
    basis,
    agents: routeValidation.resolved.map(({ definition, route }, index) => ({
      id: definition.id,
      provider: route.provider,
      model: route.model,
      launchProvenance: executionTargets[index]?.kind === "dispatched"
        ? {
              schemaVersion: 1,
              backend: executionTargets[index].backend,
              machineId: executionTargets[index].machineId,
              ...(executionTargets[index].claudeAuthMode
                ? { claudeAuthMode: executionTargets[index].claudeAuthMode }
                : {}),
              ...(executionTargets[index].codexExecutionProfile
                ? { codexExecution: executionTargets[index].codexExecutionProfile }
                : {}),
          }
        : { schemaVersion: 1, backend: "cf", machineId: null },
    })),
  });
  if (reserved.status === "conflict") return c.json({ error: "requestId is already used by a different launch" }, 409);
  if (reserved.invocation.status === "setting_up") {
    const setup = await setupAndDispatchPlanInvocation(c, loaded, requestId);
    if (!setup.ok) return setup.response;
  }
  const invocation = await loaded.artifactStore.getPlanSkillInvocation(requestId);
  const reviewers = await loaded.artifactStore.listPlanSkillInvocationReviewers(requestId);
  const runs = await loaded.artifactStore.listPlanSkillInvocationRuns(requestId);
  return c.json({ kind: "fanout", ...planInvocationResponse(invocation, reviewers, runs) }, reserved.status === "created" ? 201 : 200);
}

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/skills/:skillId/invoke", async (c) => {
  const body = await readJsonBody(c);
  const removedBackendSelection = backendSelectionRemovedError(body);
  if (removedBackendSelection) return c.json(removedBackendSelection, 400);
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const requestId = readString(body.requestId);
  if (!requestId) return c.json({ error: "requestId is required" }, 400);
  return invokePlanSkillCore(c, loaded, c.req.param("skillId"), requestId);
});

plannerRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/skills/:skillId/invoke",
  async (c) => {
    const generation = Number(c.req.param("generation"));
    if (!Number.isInteger(generation) || generation < 1) return c.json({ error: "Invalid writer generation" }, 400);
    if (!(await verifyPlanWriterRuntimeToken(
      c.env,
      c.req.param("repoId"),
      c.req.param("planArtifactId"),
      generation,
      c.req.header("X-Tiller-Plan-Writer-Token"),
    ))) return c.json({ error: "Unauthorized" }, 401);
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const writer = await loaded.artifactStore.getPlanWriter(loaded.repoId, loaded.plan.id);
    if (
      !writer
      || writer.generation !== generation
      || writer.stoppedAt
      || writer.provider !== "claude-code"
      || !writer.providerConversationId
      || !isCurrentLaunchProvenance(writer.launchProvenance)
      || !isCurrentPlanWriterRuntimeProvenance(writer.runtime)
      || writer.runtime.generation !== generation
      || writer.runtime.jobSlug !== planWriterTerminalId(
        loaded.repoId,
        loaded.plan.id,
        generation,
      )
    ) return c.json({ error: "This Claude writer generation is not active" }, 409);
    const body = await readJsonBody(c);
    const removedBackendSelection = backendSelectionRemovedError(body);
    if (removedBackendSelection) return c.json(removedBackendSelection, 400);
    const requestId = readString(body.requestId);
    const revision = readString(body.revision);
    if (!requestId || requestId.length > 256 || !revision) {
      return c.json({ error: "requestId and frozen skill revision are required" }, 400);
    }
    if (!Array.isArray(body.skills)) return c.json({ error: "Frozen Plan Skill snapshot is required" }, 400);
    const skills = body.skills as AgentSkillDefinition[];
    try {
      validateClaudePlanSkillProjection(skills);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
    if (await claudePlanSkillProjectionRevision(skills) !== revision) {
      return c.json({ error: "Frozen Plan Skill revision does not match its snapshot" }, 409);
    }
    const skillId = c.req.param("skillId");
    const skill = skills.find((candidate) => candidate?.id === skillId && candidate.surface === "plan");
    if (!skill || !Array.isArray(skill.agents) || skill.agents.length < 1 || skill.agents.length > 4) {
      return c.json({ error: "Projected Plan Skill not found" }, 404);
    }
    return invokePlanSkillCore(c, loaded, skillId, requestId, { definition: skill });
  },
);

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/skill-invocations", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  await failStalePlanInvocations(loaded);
  const limitValue = Number(c.req.query("limit") ?? 20);
  const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(limitValue, 50)) : 20;
  const rawCursor = c.req.query("cursor");
  const separator = rawCursor?.lastIndexOf("|") ?? -1;
  const cursor = rawCursor && separator > 0
    ? { createdAt: rawCursor.slice(0, separator), invocationId: rawCursor.slice(separator + 1) }
    : null;
  const invocations = await loaded.artifactStore.listPlanSkillInvocations({
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    limit: limit + 1,
    cursor,
  });
  const hasMore = invocations.length > limit;
  const page = invocations.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    invocations: page.map((invocation) => ({
      invocationId: invocation.invocationId,
      parentThreadId: invocation.parentThreadId,
      skillId: invocation.definitionSnapshot.id,
      command: invocation.definitionSnapshot.command,
      label: invocation.definitionSnapshot.label,
      status: invocation.status,
      agentCount: invocation.definitionSnapshot.agents.length,
      createdAt: invocation.createdAt,
      updatedAt: invocation.updatedAt,
      error: invocation.error,
    })),
    nextCursor: hasMore && last ? `${last.createdAt}|${last.invocationId}` : null,
  });
});

plannerRoutes.get("/api/repos/:repoId/plans/:planArtifactId/skill-invocations/:invocationId", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  await failStalePlanInvocations(loaded);
  const invocation = await loaded.artifactStore.getPlanSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.repoId !== loaded.repoId || invocation.planArtifactId !== loaded.plan.id) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  return c.json(planInvocationResponse(
    invocation,
    await loaded.artifactStore.listPlanSkillInvocationReviewers(invocation.invocationId),
    await loaded.artifactStore.listPlanSkillInvocationRuns(invocation.invocationId),
  ));
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/skill-invocations/:invocationId/cancel", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const invocation = await loaded.artifactStore.getPlanSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.repoId !== loaded.repoId || invocation.planArtifactId !== loaded.plan.id) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  const runs = await loaded.artifactStore.listPlanSkillInvocationRuns(invocation.invocationId);
  const cancelled = await loaded.artifactStore.cancelPlanSkillInvocation(invocation.invocationId);
  for (const run of runs) {
    if (run.runtime && isActiveRun(run)) {
      runInBackground(c, cleanupPlannerRunRuntime(c.env, loaded.artifactStore, run));
    }
  }
  return c.json({ ok: true, invocation: cancelled });
});

plannerRoutes.post("/api/repos/:repoId/plans/:planArtifactId/skill-invocations/:invocationId/forward", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const invocation = await loaded.artifactStore.getPlanSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.repoId !== loaded.repoId || invocation.planArtifactId !== loaded.plan.id) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  const body = await readJsonBody(c);
  const requestId = readString(body.requestId);
  if (!requestId) return c.json({ error: "requestId is required" }, 400);
  const messageIds = [...new Set(readStringArray(body.messageIds))];
  const guidance = readString(body.guidance);
  if (messageIds.length === 0 && !guidance) return c.json({ error: "Select a report or add guidance to forward." }, 400);
  const runs = await loaded.artifactStore.listPlanSkillInvocationRuns(invocation.invocationId);
  const reviewers = await loaded.artifactStore.listPlanSkillInvocationReviewers(invocation.invocationId);
  const contributions = [];
  for (const messageId of messageIds) {
    let matched: { reviewer: ReviewerRegistryEntry; run: PlannerRun; message: any } | null = null;
    for (const reviewer of reviewers) {
      const message = await getThreadStub(c.env, reviewer.threadId).getMessage(messageId);
      if (!message) continue;
      const runId = readThreadMessageRunId(message);
      const run = runs.find((candidate) => candidate.runId === runId);
      if (
        run
        && run.status === "completed"
        && run.repoId === loaded.repoId
        && run.planArtifactId === loaded.plan.id
        && run.threadId === reviewer.threadId
        && run.skillInvocationId === invocation.invocationId
        && readThreadMessageRole(message) === "assistant"
        && (!message.artifactIds?.length || message.artifactIds.includes(loaded.plan.id))
      ) {
        matched = { reviewer, run, message };
        break;
      }
    }
    if (!matched) return c.json({ error: `Report message is not eligible: ${messageId}` }, 400);
    const text = readThreadMessageText(matched.message).trim();
    if (!text) return c.json({ error: `Report message has no text: ${messageId}` }, 400);
    const result = await loaded.artifactStore.createOrGetPlanContribution({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      sourceKind: "reviewer_message",
      sourceRunId: matched.run.runId,
      sourceThreadId: matched.reviewer.threadId,
      sourceMessageId: messageId,
      sourcePlanVersion: invocation.basis.version,
      idempotencyKey: `skill-message:${invocation.invocationId}:${messageId}`,
      provider: matched.run.provider,
      model: matched.run.model,
      skill: invocation.definitionSnapshot.command,
      text,
    });
    if (result.status === "conflict") return c.json({ error: "A forwarded report changed for its idempotency key." }, 409);
    contributions.push(result.contribution);
  }
  if (guidance) {
    const result = await loaded.artifactStore.createOrGetPlanContribution({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      sourceKind: "skill_guidance",
      sourceThreadId: invocation.parentThreadId,
      sourcePlanVersion: invocation.basis.version,
      idempotencyKey: `skill-guidance:${invocation.invocationId}:${requestId}`,
      provider: "manual",
      model: "manual",
      skill: invocation.definitionSnapshot.command,
      text: guidance,
    });
    if (result.status === "conflict") return c.json({ error: "Guidance changed for an existing forwarding action." }, 409);
    contributions.push(result.contribution);
  }
  return c.json({
    ok: true,
    contributions,
  });
});

export default plannerRoutes;
