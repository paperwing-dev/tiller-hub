import { Hono } from "hono";
import type { HonoEnv, Env, EnvMeta } from "../types";
import { getArtifactStoreStub, getEnvReviewStub, getThreadStub } from "../helpers";
import type { HubDO } from "../hub";
import { loadEnvView } from "../env/view";
import { loadRepoForRequest, type RepoWorkspace } from "../repo/access";
import { appendThreadMessage } from "../planner/runtime";
import {
  findPlannerProviderEffort,
  findPlannerProviderModel,
  getPlannerProviderModelDefaultEffort,
  listPlannerProviders,
} from "../planner/providers";
import {
  readManagedEnvSlugFromStoredSession,
  readManagedRoleFromStoredSession,
} from "../session-attachment";
import {
  reviewSkillRerunMessageId,
  reviewSkillRerunRunId,
  type EnvReviewPreparationOperation,
  type EnvReviewRun,
  type EnvReviewSnapshotMode,
  type EnvReviewState,
  type EnvReviewTab,
  type EnvReviewTaskKind,
} from "./types";
import type { StoredSession } from "../types";
import type { PlannerEffort } from "../coordination";
import type { AgentSkillDefinition, SkillAutomationMode } from "../coordination";
import {
  cleanupEnvReviewRunRuntime,
  resolveNewEnvReviewLaunchProvenance,
} from "./dispatch";
import {
  computeReviewSnapshotHash,
  ENV_REVIEW_SNAPSHOT_CONTENT_TYPE,
  ENV_REVIEW_SNAPSHOT_FORMAT_VERSION,
  ENV_REVIEW_SNAPSHOT_MAX_BYTES,
  ENV_REVIEW_UPLOAD_TOKEN_HEADER,
  normalizeReviewSnapshotDeletedPaths,
  storeAndCompleteReviewSnapshot,
  validateReviewSnapshotTar,
} from "./snapshots";
import {
  mergeStoredAgentSkills,
  resolveSkillAgentRoutes,
} from "../planner/agent-skills";
import { assignSkillOverview, readIncludedSkillReports } from "./skill-orchestration";
import { buildEnvReviewPrompt, normalizeEnvReviewPlanBasis } from "./context";
import { REVIEW_SKILL_RERUN_INSTRUCTION } from "./active-instructions";
import { backendSelectionRemovedError } from "../execution";
import { getDurableObjectStub } from "../durable-object";
import { getHarnessModel, validateHarnessSettings } from "../../shared/harness-catalog";
import {
  buildThreadMessageHistory,
  composeReviewerInstructions,
  ENV_REVIEW_THREAD_CONTEXT_MESSAGE_LIMIT,
  listAllThreadMessages,
} from "../planner/context-window";

const PREPARATION_WAIT_MS = 130_000;
const MAX_UPLOAD_METADATA_BYTES = 200_000;

const envReviewRoutes = new Hono<HonoEnv>();

interface HubSessionLookup {
  getSession(id: string): Promise<StoredSession | null>;
}

function getHub(env: Env): HubSessionLookup {
  return getDurableObjectStub<HubDO & HubSessionLookup>(env, env.HUB, "hub");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readJsonBody(c: any): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

async function validateLeadSessionForEnv(
  env: Env,
  sessionId: string,
  envSlug: string,
): Promise<string | null> {
  const session = await getHub(env).getSession(sessionId).catch(() => null);
  if (!session) {
    return "Session not found";
  }
  if (readManagedEnvSlugFromStoredSession(session) !== envSlug) {
    return "Session does not belong to this environment";
  }
  if (readManagedRoleFromStoredSession(session) !== "lead") {
    return "Reviewers can only be attached to the lead harness session";
  }
  return null;
}

async function loadEnvReviewRequest(c: any): Promise<
  | { ok: true; meta: EnvMeta; repo: RepoWorkspace; sessionId: string }
  | { ok: false; response: Response }
> {
  const slug = c.req.param("slug");
  const meta = await loadEnvView(c.env, slug);
  if (!meta) return { ok: false, response: c.json({ error: "Environment not found" }, 404) };
  const loadedRepo = await loadRepoForRequest(c.env, c.req.raw, meta.repoId);
  if (!loadedRepo.ok) {
    return { ok: false, response: c.json(loadedRepo.body, loadedRepo.status as any) };
  }
  const bodySessionId = c.req.query("sessionId") ?? null;
  const sessionId = readString(bodySessionId) ?? readString((await readJsonBody(c)).sessionId);
  if (!sessionId) {
    return { ok: false, response: c.json({ error: "sessionId is required" }, 400) };
  }
  const sessionError = await validateLeadSessionForEnv(c.env, sessionId, meta.slug);
  if (sessionError) {
    return { ok: false, response: c.json({ error: sessionError }, 403) };
  }
  return { ok: true, meta, repo: loadedRepo.repo, sessionId };
}

async function loadEnvReviewRequestWithBody(
  c: any,
  options: { createsWorkload?: boolean } = {},
): Promise<
  | { ok: true; meta: EnvMeta; repo: RepoWorkspace; sessionId: string; body: Record<string, unknown> }
  | { ok: false; response: Response }
> {
  const body = await readJsonBody(c);
  const removedBackendSelection = options.createsWorkload
    ? backendSelectionRemovedError(body)
    : null;
  if (removedBackendSelection) {
    return { ok: false, response: c.json(removedBackendSelection, 400) };
  }
  const slug = c.req.param("slug");
  const meta = await loadEnvView(c.env, slug);
  if (!meta) return { ok: false, response: c.json({ error: "Environment not found" }, 404) };
  const loadedRepo = await loadRepoForRequest(c.env, c.req.raw, meta.repoId);
  if (!loadedRepo.ok) {
    return { ok: false, response: c.json(loadedRepo.body, loadedRepo.status as any) };
  }
  const sessionId = readString(body.sessionId);
  if (!sessionId) {
    return { ok: false, response: c.json({ error: "sessionId is required" }, 400) };
  }
  const sessionError = await validateLeadSessionForEnv(c.env, sessionId, meta.slug);
  if (sessionError) {
    return { ok: false, response: c.json({ error: sessionError }, 403) };
  }
  return { ok: true, meta, repo: loadedRepo.repo, sessionId, body };
}

async function requireReviewerSelection(
  env: Env,
  providerId: string,
  modelId: string,
  requestedEffort?: string | null,
  providerSnapshot?: Awaited<ReturnType<typeof listPlannerProviders>>["providers"],
) {
  const providers = providerSnapshot ?? (await listPlannerProviders(env)).providers;
  const match = findPlannerProviderModel(providers, providerId, modelId);
  if (!match) {
    throw new Error("Unknown reviewer provider/model.");
  }
  if (!match.provider.capabilities.reviewer) {
    throw new Error(`${match.provider.displayName} does not support reviewers.`);
  }
  if (!match.provider.available || !match.model.available) {
    throw new Error(match.model.disabledReason || match.provider.disabledReasons[0] || "Reviewer model is unavailable.");
  }
  const effort = requestedEffort ?? getPlannerProviderModelDefaultEffort(match.provider, match.model);
  const effortMetadata = findPlannerProviderEffort(match.provider, effort, match.model);
  if (!effortMetadata) {
    throw new Error(`Unsupported effort for ${match.provider.displayName}.`);
  }
  return { ...match, effort: effortMetadata.id };
}

async function createReviewerThread(env: Env, envSlug: string, title: string): Promise<string> {
  const threadId = `env-review:${envSlug}:${crypto.randomUUID()}`;
  await getThreadStub(env, threadId).createThread({
    id: threadId,
    scope: { type: "env", envSlug },
    kind: "chat",
    title,
  });
  return threadId;
}

async function ensurePrimaryReviewer(
  env: Env,
  review: ReturnType<typeof getEnvReviewStub>,
  input: {
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    harness: EnvMeta["harness"];
    harnessSettings: EnvMeta["harnessSettings"];
  },
): Promise<EnvReviewTab> {
  const selection = await resolveImplementorReviewer(env, input);
  const ensured = await review.ensurePrimaryReviewerTab({
    envSlug: input.envSlug,
    repoId: input.repoId,
    mainSessionId: input.mainSessionId,
    provider: selection.provider,
    model: selection.model,
    effort: selection.effort,
  });
  return ensured.tab;
}

async function resolveImplementorReviewer(
  env: Env,
  input: {
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    harness: EnvMeta["harness"];
    harnessSettings: EnvMeta["harnessSettings"];
  },
): Promise<{ provider: string; model: string; effort: PlannerEffort }> {
  const settings = validateHarnessSettings(input.harness, input.harnessSettings);
  const implementorModel = settings ? getHarnessModel(input.harness, settings.model) : null;
  if (!settings || !implementorModel) {
    throw new Error("The implementor model is unavailable. Add a reviewer explicitly or restart the environment.");
  }
  const providers = (await listPlannerProviders(env)).providers;
  const provider = input.harness;
  const model = implementorModel.binding.model;
  const selection = await requireReviewerSelection(env, provider, model, settings.effort, providers);
  return { provider, model, effort: selection.effort };
}

async function ensureReviewerThread(
  env: Env,
  tab: EnvReviewTab,
): Promise<ReturnType<typeof getThreadStub>> {
  const thread = getThreadStub(env, tab.threadId);
  await thread.createThread({
    id: tab.threadId,
    scope: { type: "env", envSlug: tab.envSlug },
    kind: "chat",
    title: tab.roleLabel,
  });
  return thread;
}

function normalizeTaskKind(value: unknown): EnvReviewTaskKind {
  return value === "tests" || value === "architecture" || value === "security" || value === "custom"
    ? value
    : "correctness";
}

function taskLabel(kind: EnvReviewTaskKind, customTask?: string | null): string {
  if (kind === "tests") return "Tests Reviewer";
  if (kind === "architecture") return "Architecture Reviewer";
  if (kind === "security") return "Security Reviewer";
  if (kind === "custom") return customTask?.trim() ? "Custom Reviewer" : "Reviewer";
  return "Correctness Reviewer";
}

function readOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function readSnapshotUploadForm(c: any): Promise<
  | { ok: true; metadata: Record<string, unknown>; workspace: Uint8Array }
  | { ok: false; status: number; error: string }
> {
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return { ok: false, status: 415, error: "multipart/form-data is required" };
  }
  const form = await c.req.raw.formData().catch(() => null);
  if (!form) {
    return { ok: false, status: 400, error: "Invalid multipart form body" };
  }
  const metadataPart = form.get("metadata");
  const workspacePart = form.get("workspace");
  if (typeof metadataPart !== "string") {
    return { ok: false, status: 400, error: "metadata JSON part is required" };
  }
  if (new TextEncoder().encode(metadataPart).byteLength > MAX_UPLOAD_METADATA_BYTES) {
    return { ok: false, status: 413, error: "metadata JSON part is too large" };
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(metadataPart) as unknown;
  } catch {
    return { ok: false, status: 400, error: "metadata part must be valid JSON" };
  }
  if (!isRecord(metadata)) {
    return { ok: false, status: 400, error: "metadata part must be a JSON object" };
  }
  if (!(workspacePart instanceof Blob)) {
    return { ok: false, status: 400, error: "workspace tar part is required" };
  }
  if (workspacePart.type.toLowerCase() !== ENV_REVIEW_SNAPSHOT_CONTENT_TYPE) {
    return { ok: false, status: 415, error: "workspace tar part must use application/x-tar" };
  }
  if (workspacePart.size > ENV_REVIEW_SNAPSHOT_MAX_BYTES) {
    return { ok: false, status: 413, error: "workspace tar is too large" };
  }
  return {
    ok: true,
    metadata,
    workspace: new Uint8Array(await workspacePart.arrayBuffer()),
  };
}

async function failAuthenticatedSnapshotUpload(
  c: any,
  review: ReturnType<typeof getEnvReviewStub>,
  op: EnvReviewPreparationOperation,
  status: number,
  message: string,
): Promise<Response> {
  const completedAt = new Date().toISOString();
  const failed = await review.failPreparationOperationIfPreparing({
    opId: op.opId,
    error: message,
    result: {
      formatVersion: ENV_REVIEW_SNAPSHOT_FORMAT_VERSION,
      status: "failed",
      opId: op.opId,
      snapshot: null,
      changedCount: 0,
      deletedCount: 0,
      uploadedBytes: 0,
      completedAt,
      error: message,
    },
  });
  if (failed.status === "failed") {
    for (const run of await review.listRunsForPreparationOperation(op.opId)) {
      if (run.status === "ready" || run.status === "failed" || run.status === "cancelled") continue;
      await review.appendRunEvent({ runId: run.runId, type: "snapshot_failed", message });
      await review.updateRun({
        runId: run.runId,
        status: "failed",
        completedAt,
        error: message,
      });
    }
    await review.scheduleOrchestration();
  }
  return c.json({ error: message }, status);
}

function normalizeUploadDeletedPaths(
  metadata: Record<string, unknown>,
  mode: EnvReviewSnapshotMode,
): string[] {
  if (mode !== "github-overlay") return [];
  if (!Array.isArray(metadata.githubDeletedPaths)) {
    throw new Error("githubDeletedPaths is required for GitHub overlay snapshots");
  }
  return normalizeReviewSnapshotDeletedPaths(metadata.githubDeletedPaths);
}

async function stateFor(c: any, meta: EnvMeta, sessionId: string): Promise<EnvReviewState> {
  return await getEnvReviewStub(c.env, meta.slug).getState({
    envSlug: meta.slug,
    repoId: meta.repoId,
    mainSessionId: sessionId,
  });
}

async function resolveReviewSkill(
  env: Env,
  repo: RepoWorkspace,
  skillId: string,
): Promise<AgentSkillDefinition | null> {
  const repoId = repo.meta.repoId;
  const store = getArtifactStoreStub(
    env,
    repoId,
    repo.meta.artifactStoreGeneration,
  );
  const stored = await store.listStoredAgentSkills(repoId, "review");
  return mergeStoredAgentSkills("review", stored).find((skill) => skill.id === skillId) ?? null;
}

async function resolveReviewSkillAgents(env: Env, skill: AgentSkillDefinition) {
  const providers = (await listPlannerProviders(env)).providers;
  const result = resolveSkillAgentRoutes(skill, providers, "reviewer");
  if (!result.ok) throw new Error(result.error);
  return result.resolved;
}

function invocationSummary(invocation: Awaited<ReturnType<ReturnType<typeof getEnvReviewStub>["getSkillInvocation"]>>) {
  if (!invocation) return null;
  return {
    invocationId: invocation.invocationId,
    parentThreadId: invocation.parentThreadId,
    skillId: invocation.definitionSnapshot.id,
    command: invocation.definitionSnapshot.command,
    label: invocation.definitionSnapshot.label,
    status: invocation.status,
    agentCount: invocation.definitionSnapshot.agents.length,
    overviewMode: invocation.overviewMode,
    overviewRunId: invocation.overviewRunId,
    createdAt: invocation.createdAt,
    updatedAt: invocation.updatedAt,
    error: invocation.error,
  };
}

async function failStaleReviewSkillInvocations(review: ReturnType<typeof getEnvReviewStub>, envSlug: string, sessionId: string) {
  await review.failStaleSkillInvocations(
    envSlug,
    sessionId,
    new Date(Date.now() - PREPARATION_WAIT_MS).toISOString(),
  );
}

envReviewRoutes.get("/api/envs/:slug/review", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const inherited = await review.inheritReviewerTabsFromLatestSession({
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
  });
  const state = await review.getState({
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
  });
  if (inherited.status === "inherited") {
    for (const tab of inherited.tabs) await ensureReviewerThread(c.env, tab);
  }
  return c.json(state);
});

envReviewRoutes.post("/api/envs/:slug/review/tabs", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const provider = readString(loaded.body.provider);
  const model = readString(loaded.body.model);
  if (!provider || !model) return c.json({ error: "provider and model are required" }, 400);
  let selection: Awaited<ReturnType<typeof requireReviewerSelection>>;
  try {
    selection = await requireReviewerSelection(c.env, provider, model, readString(loaded.body.effort));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const threadId = await createReviewerThread(c.env, loaded.meta.slug, "Env Reviewer");
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  await review.addReviewerTab({
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
    threadId,
    provider,
    model,
    effort: selection.effort,
    roleLabel: "Reviewer",
    taskKind: "correctness",
  });
  return c.json(await stateFor(c, loaded.meta, loaded.sessionId), 201);
});

envReviewRoutes.delete("/api/envs/:slug/review/tabs/:threadId", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const result = await review.removeReviewerTabIfUnlocked(c.req.param("threadId"), loaded.meta.slug, loaded.sessionId);
  if (result.status === "not_found") {
    return c.json({ error: "Reviewer tab not found" }, 404);
  }
  if (result.status === "skill_child") {
    return c.json({ error: "Skill child tabs are retained with invocation history. Cancel the invocation instead." }, 409);
  }
  if (result.status === "parent_locked") {
    return c.json({ error: "The reviewer is locked by an active skill invocation." }, 409);
  }
  return c.json(await stateFor(c, loaded.meta, loaded.sessionId));
});

envReviewRoutes.post("/api/envs/:slug/review/tabs/:threadId/runs", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const tab = await review.getTab(c.req.param("threadId"));
  if (!tab || tab.envSlug !== loaded.meta.slug || tab.mainSessionId !== loaded.sessionId || tab.removedAt) {
    return c.json({ error: "Reviewer tab not found" }, 404);
  }
  if (tab.skillInvocationId) {
    return c.json({
      error: "Skill child follow-ups must be sent through the child message endpoint so the invocation basis stays pinned.",
    }, 409);
  }
  const provider = readString(loaded.body.provider) ?? tab.provider;
  const model = readString(loaded.body.model) ?? tab.model;
  const requestedEffort = readString(loaded.body.effort)
    ?? (provider === tab.provider ? tab.effort : null);
  let selection: Awaited<ReturnType<typeof requireReviewerSelection>>;
  try {
    selection = await requireReviewerSelection(c.env, provider, model, requestedEffort);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  let launchProvenance: Awaited<ReturnType<typeof resolveNewEnvReviewLaunchProvenance>>;
  try {
    launchProvenance = await resolveNewEnvReviewLaunchProvenance(c.env, provider);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
  const taskKind = normalizeTaskKind(loaded.body.taskKind);
  const customTask = readString(loaded.body.customTask);
  const runId = crypto.randomUUID();
  const reserved = await review.reserveTopLevelRun({
    runId,
    threadId: tab.threadId,
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
    provider,
    model,
    effort: selection.effort,
    roleLabel: taskLabel(taskKind, customTask),
    taskKind,
    customTask,
    preparationOpId: crypto.randomUUID(),
    preparationTimeoutMs: PREPARATION_WAIT_MS,
    requestUrl: c.req.url,
    launchProvenance,
  });
  if (reserved.status === "not_found") return c.json({ error: "Reviewer tab not found" }, 404);
  if (reserved.status === "parent_locked") return c.json({ error: "The selected reviewer is not idle." }, 409);
  if (reserved.status !== "created") return c.json({ error: "Reviewer run id is already in use." }, 409);
  if (taskKind === "custom" && customTask) {
    try {
      await appendThreadMessage(
        getThreadStub(c.env, tab.threadId),
        "user",
        `Custom review task:\n\n${customTask}`,
        [],
        { id: `env-review-task:${runId}`, runId },
      );
    } catch (error) {
      await review.cancelRun(runId, "Reviewer setup failed before the task message was stored.");
      return c.json({ error: error instanceof Error ? error.message : String(error), retryable: true }, 502);
    }
  }
  await review.scheduleOrchestration();
  return c.json(await stateFor(c, loaded.meta, loaded.sessionId), 202);
});

async function setupReviewSkillInvocation(
  c: any,
  loaded: Extract<Awaited<ReturnType<typeof loadEnvReviewRequestWithBody>>, { ok: true }>,
  invocationId: string,
): Promise<Response | null> {
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const invocation = await review.getSkillInvocation(invocationId);
  if (!invocation) return c.json({ error: "Skill invocation not found" }, 404);
  if (invocation.status !== "setting_up") return null;
  try {
    const runs = await review.listSkillInvocationRuns(invocationId);
    const root = await review.getTab(invocation.parentThreadId);
    if (!root) throw new Error("Reserved skill root is missing.");
    await ensureReviewerThread(c.env, root);
    for (const tab of await review.listSkillInvocationTabs(invocationId)) {
      const agent = invocation.definitionSnapshot.agents.find((candidate) => candidate.id === tab.skillAgentId);
      if (!agent) throw new Error(`Reserved skill agent is missing: ${tab.skillAgentId ?? "unknown"}`);
      const run = runs.find((candidate) => candidate.skillAgentId === agent.id
        && (candidate.skillRunRole === "root_initial" || candidate.skillRunRole === "report_initial"));
      if (!run) throw new Error(`Reserved skill run is missing: ${agent.id}`);
      const thread = getThreadStub(c.env, tab.threadId);
      await thread.createThread({
        id: tab.threadId,
        scope: { type: "env", envSlug: loaded.meta.slug },
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
          text: `/${invocation.definitionSnapshot.command}\n\n${composeReviewerInstructions(
            invocation.definitionSnapshot.sharedInstructions,
            `Role: ${agent.instructions}`,
          )}`,
          runId: run.runId,
        },
      });
    }
    await review.activateSkillInvocation(invocationId);
    await review.scheduleOrchestration();
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await review.failSkillInvocation(invocationId, message);
    return c.json({
      error: message,
      code: "skill_invocation_terminal",
      retryable: true,
    }, 502);
  }
}

async function invokeReviewSkillRoute(c: any) {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  await failStaleReviewSkillInvocations(review, loaded.meta.slug, loaded.sessionId);
  const requestId = readString(loaded.body.requestId);
  if (!requestId) return c.json({ error: "requestId is required" }, 400);
  const skillId = c.req.param("skillId");
  const rootThreadId = `env-review-skill-root:${requestId}`;
  if (loaded.body.overviewMode !== undefined && loaded.body.overviewMode !== "auto" && loaded.body.overviewMode !== "manual") {
    return c.json({ error: "overviewMode must be auto or manual" }, 400);
  }
  const requestedOverviewMode = loaded.body.overviewMode === "auto" || loaded.body.overviewMode === "manual"
    ? loaded.body.overviewMode
    : null;
  let existingInvocation = await review.getSkillInvocation(requestId);
  if (existingInvocation) {
    if (
      existingInvocation.envSlug !== loaded.meta.slug
      || existingInvocation.repoId !== loaded.meta.repoId
      || existingInvocation.mainSessionId !== loaded.sessionId
      || existingInvocation.parentThreadId !== rootThreadId
      || existingInvocation.definitionSnapshot.id !== skillId
    ) {
      return c.json({ error: "requestId is already used by a different launch" }, 409);
    }
    if (existingInvocation.status === "setting_up") {
      const failed = await setupReviewSkillInvocation(c, loaded, requestId);
      if (failed) return failed;
      existingInvocation = await review.getSkillInvocation(requestId) ?? existingInvocation;
    }
    if (existingInvocation.status === "failed" || existingInvocation.status === "cancelled") {
      return c.json({
        error: existingInvocation.error ?? `Skill invocation is ${existingInvocation.status}.`,
        code: "skill_invocation_terminal",
        invocation: existingInvocation,
      }, 409);
    }
    const existingRuns = await review.listSkillInvocationRuns(requestId);
    if (existingInvocation.status === "active" && existingRuns.some((run) =>
      (run.skillRunRole === "root_initial" || run.skillRunRole === "report_initial")
      && (run.status === "preparing" || run.status === "queued" || run.status === "running")
    )) {
      await review.scheduleOrchestration();
    }
    return c.json({
      kind: "skill_root",
      invocation: existingInvocation,
      tabs: await review.listSkillInvocationTabs(requestId),
      runs: existingRuns,
    });
  }
  const skill = await resolveReviewSkill(c.env, loaded.repo, skillId);
  if (!skill) return c.json({ error: "Review skill not found" }, 404);
  let agents: Awaited<ReturnType<typeof resolveReviewSkillAgents>>;
  try {
    agents = await resolveReviewSkillAgents(c.env, skill);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
  const overviewMode: SkillAutomationMode = requestedOverviewMode ?? skill.overviewMode;
  let agentLaunchProvenance: Array<
    Awaited<ReturnType<typeof resolveNewEnvReviewLaunchProvenance>>
  >;
  try {
    agentLaunchProvenance = await Promise.all(
      agents.map(({ route }) =>
        resolveNewEnvReviewLaunchProvenance(c.env, route.provider)
      ),
    );
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }

  let overviewRoute: { provider: string; model: string; effort: PlannerEffort } | null = null;
  if (skill.agents.length > 1) {
    try {
      overviewRoute = await resolveImplementorReviewer(c.env, {
        envSlug: loaded.meta.slug,
        repoId: loaded.meta.repoId,
        mainSessionId: loaded.sessionId,
        harness: loaded.meta.harness,
        harnessSettings: loaded.meta.harnessSettings,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  const reserved = await review.reserveSkillInvocation({
    invocationId: requestId,
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
    parentThreadId: rootThreadId,
    definitionSnapshot: skill,
    overviewMode,
    overviewRoute,
    preparationOpId: crypto.randomUUID(),
    requestUrl: c.req.url,
    agents: agents.map(({ definition, route }, index) => ({
      id: definition.id,
      provider: route.provider,
      model: route.model,
      effort: definition.effort,
      launchProvenance: agentLaunchProvenance[index]!,
    })),
  });
  if (reserved.status === "conflict") return c.json({ error: "requestId is already used by a different launch" }, 409);
  if (reserved.status === "parent_locked") {
    return c.json({ error: "The selected reviewer is not idle.", ...(reserved.invocation ? { invocation: reserved.invocation } : {}) }, 409);
  }
  if (reserved.invocation.status === "setting_up") {
    const failed = await setupReviewSkillInvocation(c, loaded, requestId);
    if (failed) return failed;
  }
  const invocation = await review.getSkillInvocation(requestId);
  return c.json({
    kind: "skill_root",
    invocation,
    tabs: await review.listSkillInvocationTabs(requestId),
    runs: await review.listSkillInvocationRuns(requestId),
  }, reserved.status === "created" ? 202 : 200);
}

envReviewRoutes.post("/api/envs/:slug/review/skills/:skillId/invoke", invokeReviewSkillRoute);

async function setupReviewSkillRerun(
  c: any,
  loaded: Extract<Awaited<ReturnType<typeof loadEnvReviewRequestWithBody>>, { ok: true }>,
  invocation: NonNullable<Awaited<ReturnType<ReturnType<typeof getEnvReviewStub>["getSkillInvocation"]>>>,
  requestId: string,
  runs: EnvReviewRun[],
): Promise<Response | null> {
  if (
    (invocation.status !== "setting_up" && invocation.status !== "active")
    || runs.some((run) => run.preparationOpId !== invocation.preparationOpId)
  ) return null;
  try {
    for (const agent of invocation.definitionSnapshot.agents) {
      const run = runs.find((candidate) => candidate.runId === reviewSkillRerunRunId(requestId, agent.id));
      if (!run) throw new Error(`Re-review run is missing for ${agent.label}.`);
      const thread = getThreadStub(c.env, run.threadId);
      await thread.createThread({
        id: run.threadId,
        scope: { type: "env", envSlug: loaded.meta.slug },
        kind: "chat",
        title: agent.label,
      });
      await appendThreadMessage(
        thread,
        "user",
        [
          `/${invocation.definitionSnapshot.command} — Re-review changes`,
          "",
          REVIEW_SKILL_RERUN_INSTRUCTION,
        ].join("\n"),
        [],
        { id: reviewSkillRerunMessageId(requestId, agent.id), runId: run.runId },
      );
    }
    await getEnvReviewStub(c.env, loaded.meta.slug).activateSkillInvocation(invocation.invocationId);
    await getEnvReviewStub(c.env, loaded.meta.slug).scheduleOrchestration();
    return null;
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : String(error),
      code: "skill_setup_incomplete",
      retryable: true,
    }, 502);
  }
}

envReviewRoutes.post("/api/envs/:slug/review/skill-invocations/:invocationId/rerun", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const requestId = readString(loaded.body.requestId);
  if (!requestId) return c.json({ error: "requestId is required" }, 400);
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  await failStaleReviewSkillInvocations(review, loaded.meta.slug, loaded.sessionId);
  const invocationId = c.req.param("invocationId");
  const invocation = await review.getSkillInvocation(invocationId);
  if (
    !invocation
    || invocation.envSlug !== loaded.meta.slug
    || invocation.repoId !== loaded.meta.repoId
  ) {
    return c.json({ error: "Review skill invocation not found" }, 404);
  }
  const expectedRoundId = readString(loaded.body.expectedRoundId);
  if (expectedRoundId !== invocation.invocationId) {
    return c.json({ error: "The selected review round is stale." }, 409);
  }
  const tabs = await review.listSkillInvocationTabs(invocationId);
  const tabByAgentId = new Map(tabs.map((tab) => [tab.skillAgentId, tab]));
  if (invocation.definitionSnapshot.agents.some((agent) => !tabByAgentId.get(agent.id))) {
    return c.json({ error: "The existing reviewer conversations are incomplete." }, 409);
  }

  const firstAgent = invocation.definitionSnapshot.agents[0]!;
  const existingMarker = await review.getRun(reviewSkillRerunRunId(requestId, firstAgent.id));
  let agentLaunchProvenance = new Map<string, Awaited<ReturnType<typeof resolveNewEnvReviewLaunchProvenance>>>();
  if (!existingMarker) {
    try {
      for (const agent of invocation.definitionSnapshot.agents) {
        const tab = tabByAgentId.get(agent.id)!;
        await requireReviewerSelection(c.env, tab.provider, tab.model, tab.effort);
        agentLaunchProvenance.set(
          agent.id,
          await resolveNewEnvReviewLaunchProvenance(c.env, tab.provider),
        );
      }
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  let overviewRoute: { provider: string; model: string; effort: PlannerEffort } | null = null;
  if (invocation.definitionSnapshot.agents.length > 1) {
    try {
      overviewRoute = await resolveImplementorReviewer(c.env, {
        envSlug: loaded.meta.slug,
        repoId: loaded.meta.repoId,
        mainSessionId: loaded.sessionId,
        harness: loaded.meta.harness,
        harnessSettings: loaded.meta.harnessSettings,
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    }
  }

  const reserved = await review.restartSkillInvocation({
    invocationId,
    requestId,
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
    requestUrl: c.req.url,
    overviewRoute,
    agents: invocation.definitionSnapshot.agents.map((agent) => ({
      id: agent.id,
      ...(agentLaunchProvenance.get(agent.id)
        ? { launchProvenance: agentLaunchProvenance.get(agent.id)! }
        : {}),
    })),
  });
  if (reserved.status === "not_found") return c.json({ error: "Review skill invocation not found" }, 404);
  if (reserved.status === "conflict") return c.json({ error: "requestId is already used by a different re-review" }, 409);
  if (reserved.status === "parent_locked") {
    return c.json({ error: "The reviewer is already working.", ...(reserved.invocation ? { invocation: reserved.invocation } : {}) }, 409);
  }
  if (!reserved.invocation || !("runs" in reserved)) {
    return c.json({ error: "Re-review reservation failed." }, 409);
  }
  const failed = await setupReviewSkillRerun(c, loaded, reserved.invocation, requestId, reserved.runs);
  if (failed) return failed;
  const current = await review.getSkillInvocation(requestId) ?? reserved.invocation;
  return c.json({
    kind: "skill_root",
    invocation: current,
    tabs: await review.listSkillInvocationTabs(requestId),
    runs: await review.listSkillInvocationRuns(requestId),
  }, reserved.status === "created" ? 202 : 200);
});

envReviewRoutes.get("/api/envs/:slug/review/skill-invocations", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  await failStaleReviewSkillInvocations(review, loaded.meta.slug, loaded.sessionId);
  const limitValue = Number(c.req.query("limit") ?? 20);
  const limit = Number.isInteger(limitValue) ? Math.max(1, Math.min(limitValue, 50)) : 20;
  const rawCursor = c.req.query("cursor");
  const separator = rawCursor?.lastIndexOf("|") ?? -1;
  const cursor = rawCursor && separator > 0
    ? { createdAt: rawCursor.slice(0, separator), invocationId: rawCursor.slice(separator + 1) }
    : null;
  const rows = await review.listSkillInvocations({
    envSlug: loaded.meta.slug,
    mainSessionId: loaded.sessionId,
    limit: limit + 1,
    cursor,
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return c.json({
    invocations: page.map(invocationSummary),
    nextCursor: hasMore && last ? `${last.createdAt}|${last.invocationId}` : null,
  });
});

envReviewRoutes.get("/api/envs/:slug/review/skill-invocations/:invocationId", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  await failStaleReviewSkillInvocations(review, loaded.meta.slug, loaded.sessionId);
  let invocation = await review.getSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  if (invocation.definitionSnapshot.agents.length > 1 && invocation.status === "active" && invocation.overviewMode === "auto" && !invocation.overviewRunId) {
    await assignSkillOverview({ env: c.env, review, invocationId: invocation.invocationId, automatic: true }).catch(() => undefined);
    invocation = await review.getSkillInvocation(invocation.invocationId) ?? invocation;
  }
  return c.json({
    invocation,
    tabs: await review.listSkillInvocationTabs(invocation.invocationId),
    runs: await review.listSkillInvocationRuns(invocation.invocationId),
  });
});

envReviewRoutes.put("/api/envs/:slug/review/skill-invocations/:invocationId/controls", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const invocation = await review.getSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  if (readString(loaded.body.expectedRoundId) !== invocation.invocationId) {
    return c.json({ error: "The selected review round is stale." }, 409);
  }
  if (invocation.definitionSnapshot.agents.length === 1) {
    return c.json({ error: "One-agent Review invocations do not use Overview." }, 409);
  }
  if (invocation.overviewRunId || invocation.status !== "active") {
    return c.json({ error: "Overview controls are frozen." }, 409);
  }
  if (loaded.body.overviewMode !== "auto" && loaded.body.overviewMode !== "manual") {
    return c.json({ error: "overviewMode must be auto or manual" }, 400);
  }
  const mode: SkillAutomationMode = loaded.body.overviewMode;
  const includedMessageIds = Array.isArray(loaded.body.includedMessageIds)
    ? [...new Set(loaded.body.includedMessageIds.filter((id): id is string => typeof id === "string" && Boolean(id.trim())).map((id) => id.trim()))]
    : null;
  if (!includedMessageIds) return c.json({ error: "includedMessageIds must be an array" }, 400);
  try {
    await readIncludedSkillReports(c.env, review, invocation, includedMessageIds);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const updated = await review.updateSkillInvocationControls({
    invocationId: invocation.invocationId,
    overviewMode: mode,
    includedMessageIds,
  });
  if (mode === "auto" && updated) {
    await assignSkillOverview({ env: c.env, review, invocationId: updated.invocationId, automatic: true }).catch(() => undefined);
  }
  return c.json({ invocation: await review.getSkillInvocation(invocation.invocationId) });
});

envReviewRoutes.post("/api/envs/:slug/review/skill-invocations/:invocationId/overview", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const invocation = await review.getSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  if (readString(loaded.body.expectedRoundId) !== invocation.invocationId) {
    return c.json({ error: "The selected review round is stale." }, 409);
  }
  if (invocation.definitionSnapshot.agents.length === 1) {
    return c.json({ error: "One-agent Review invocations do not use Overview." }, 409);
  }
  try {
    const result = await assignSkillOverview({
      env: c.env,
      review,
      invocationId: invocation.invocationId,
      guidance: readString(loaded.body.guidance),
      automatic: false,
    });
    return c.json(result, result.status === "created" ? 202 : 200);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
});

envReviewRoutes.post("/api/envs/:slug/review/skill-invocations/:invocationId/cancel", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const invocation = await review.getSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Skill invocation not found" }, 404);
  }
  const runs = await review.listSkillInvocationRuns(invocation.invocationId);
  const cancelled = await review.cancelSkillInvocation(invocation.invocationId);
  for (const run of runs) {
    if (run.runtime && run.status !== "ready" && run.status !== "failed" && run.status !== "cancelled") {
      c.executionCtx.waitUntil(
        cleanupEnvReviewRunRuntime(c.env, review, run).catch(() => undefined),
      );
    }
  }
  return c.json({ ok: true, invocation: cancelled });
});

envReviewRoutes.delete("/api/envs/:slug/review/skill-invocations/:invocationId", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const invocation = await review.getSkillInvocation(c.req.param("invocationId"));
  if (!invocation || invocation.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Review skill invocation not found" }, 404);
  }

  await review.cancelSkillInvocation(invocation.invocationId);
  const stoppedRuns = await review.listSkillInvocationRuns(invocation.invocationId);
  for (const run of stoppedRuns) {
    if (!run.runtime) continue;
    try {
      await cleanupEnvReviewRunRuntime(c.env, review, run);
    } catch (error) {
      return c.json({
        error: `The review stopped, but a reviewer runtime could not be removed. Retry Remove. ${error instanceof Error ? error.message : String(error)}`,
        code: "review_round_cleanup_failed",
      }, 502);
    }
  }

  const removed = await review.removeSkillInvocation({
    invocationId: invocation.invocationId,
    envSlug: loaded.meta.slug,
    mainSessionId: loaded.sessionId,
  });
  if (removed.status === "not_found") {
    return c.json({ error: "Review skill invocation not found" }, 404);
  }
  if (removed.status === "active") {
    return c.json({ error: "The review is still stopping. Retry Remove." }, 409);
  }
  if (removed.status === "runtime_retained") {
    return c.json({ error: "A reviewer runtime is still being removed. Retry Remove round." }, 409);
  }
  return c.json({
    ok: true,
    parentThreadId: removed.parentThreadId,
    removedChildThreadIds: removed.childThreadIds,
    state: await stateFor(c, loaded.meta, loaded.sessionId),
  });
});

envReviewRoutes.post("/api/envs/:slug/review/recipes/code-review", async (c) => {
  return c.json({
    error: "The standalone Code Review recipe was replaced by the /code-review Review skill. Select an idle parent reviewer and invoke that skill.",
  }, 410);
});

envReviewRoutes.put("/api/envs/:slug/review/snapshots/:opId", async (c) => {
  const slug = c.req.param("slug");
  const opId = c.req.param("opId");
  const uploadToken = c.req.header(ENV_REVIEW_UPLOAD_TOKEN_HEADER)?.trim() ?? "";
  if (!uploadToken) {
    return c.json({ error: "Upload token is required" }, 401);
  }
  if (!(await loadEnvView(c.env, slug))) return c.json({ error: "Environment not found" }, 404);

  const review = getEnvReviewStub(c.env, slug);
  const op = await review.getPreparationOperation(opId);
  if (!op || op.envSlug !== slug) {
    return c.json({ error: "Review preparation operation not found" }, 404);
  }
  if (op.ackToken !== uploadToken) {
    return c.json({ error: "Upload token is invalid" }, 401);
  }
  if (op.status !== "preparing" && op.status !== "succeeded") {
    return c.json({ error: `Review preparation is already ${op.status}` }, 409);
  }
  const completedSnapshot = op.status === "succeeded" ? op.result?.snapshot ?? null : null;
  if (op.status === "succeeded" && !completedSnapshot) {
    return c.json({ error: "Review preparation is already succeeded" }, 409);
  }
  if (op.status === "preparing" && !op.snapshotRequest) {
    return await failAuthenticatedSnapshotUpload(
      c,
      review,
      op,
      409,
      "Review snapshot request metadata is unavailable. Retry review.",
    );
  }

  const form = await readSnapshotUploadForm(c);
  if (!form.ok) {
    return await failAuthenticatedSnapshotUpload(c, review, op, form.status, form.error);
  }

  let validated: Awaited<ReturnType<typeof validateReviewSnapshotTar>>;
  try {
    validated = await validateReviewSnapshotTar(form.workspace, {
      maxBytes: op.snapshotRequest?.maxBytes ?? ENV_REVIEW_SNAPSHOT_MAX_BYTES,
    });
  } catch (error) {
    return await failAuthenticatedSnapshotUpload(
      c,
      review,
      op,
      400,
      error instanceof Error ? error.message : String(error),
    );
  }

  const requestedMode = readOptionalString(form.metadata.snapshotMode);
  if (requestedMode && requestedMode !== "github-overlay" && requestedMode !== "full") {
    return await failAuthenticatedSnapshotUpload(c, review, op, 400, "snapshotMode is invalid");
  }
  const expectedMode = completedSnapshot?.mode
    ?? op.snapshotRequest!.snapshotMode;
  const mode = requestedMode ?? expectedMode;
  if (mode !== expectedMode) {
    return await failAuthenticatedSnapshotUpload(c, review, op, 409, "Snapshot mode does not match the prepared review snapshot request");
  }
  const baseCommitSha = readOptionalString(form.metadata.baseCommitSha);
  const expectedBaseCommitSha = completedSnapshot
    ? completedSnapshot.baseCommitSha
    : op.snapshotRequest!.baseCommitSha;
  if (mode === "github-overlay" && !baseCommitSha) {
    return await failAuthenticatedSnapshotUpload(c, review, op, 400, "baseCommitSha is required for GitHub overlay snapshots");
  }
  if (mode === "github-overlay" && baseCommitSha !== expectedBaseCommitSha) {
    return await failAuthenticatedSnapshotUpload(
      c,
      review,
      op,
      409,
      "baseCommitSha does not match the prepared review snapshot request",
    );
  }
  let githubDeletedPaths: string[];
  try {
    githubDeletedPaths = normalizeUploadDeletedPaths(form.metadata, mode);
  } catch (error) {
    return await failAuthenticatedSnapshotUpload(
      c,
      review,
      op,
      400,
      error instanceof Error ? error.message : String(error),
    );
  }

  const snapshotHash = await computeReviewSnapshotHash({
    manifest: validated.manifest,
    githubDeletedPaths,
    baseCommitSha: mode === "github-overlay" ? baseCommitSha : null,
  });
  if (completedSnapshot) {
    if (completedSnapshot.snapshotHash === snapshotHash) {
      return c.json({ ok: true, snapshot: completedSnapshot, idempotent: true });
    }
    return c.json({ error: "Snapshot upload conflicts with the completed review preparation" }, 409);
  }

  const completed = await storeAndCompleteReviewSnapshot({
    bucket: c.env.BUCKET,
    review,
    op,
    source: "live-harness",
    mode,
    stale: false,
    tarBytes: form.workspace,
    validated,
    githubDeletedPaths,
    baseCommitSha: mode === "github-overlay" ? baseCommitSha : null,
    uploadToken,
    snapshotHash,
  });
  if (completed.status === "completed") {
    await review.scheduleOrchestration();
    return c.json({ ok: true, snapshot: completed.snapshot }, 201);
  }

  if (completed.status === "already_completed") {
    if (completed.sameSnapshotHash && completed.operation.result?.snapshot) {
      return c.json({ ok: true, snapshot: completed.operation.result.snapshot, idempotent: true });
    }
    return c.json({ error: "Snapshot upload conflicts with the completed review preparation" }, 409);
  }
  return c.json({ error: completed.reason }, 409);
});

envReviewRoutes.get("/api/envs/:slug/review/tabs/:threadId/messages", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const tab = await getEnvReviewStub(c.env, loaded.meta.slug).getTab(c.req.param("threadId"));
  if (!tab || tab.envSlug !== loaded.meta.slug || tab.mainSessionId !== loaded.sessionId || tab.removedAt) {
    return c.json({ error: "Reviewer tab not found" }, 404);
  }
  const messages = await listAllThreadMessages(getThreadStub(c.env, tab.threadId));
  return c.json({ messages });
});

async function sendEnvReviewMessageRoute(c: any) {
  const loaded = await loadEnvReviewRequestWithBody(c, { createsWorkload: true });
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const requestedThreadId = readString(c.req.param("threadId"));
  const requestId = readString(loaded.body.requestId);
  if (!requestedThreadId && !requestId) {
    return c.json({ error: "requestId is required" }, 400);
  }
  const text = readString(loaded.body.text);
  if (!text) {
    return c.json({ error: "text is required" }, 400);
  }
  const existingRun = !requestedThreadId && requestId
    ? await review.getRun(requestId)
    : null;
  if (existingRun && (
    existingRun.envSlug !== loaded.meta.slug
    || existingRun.repoId !== loaded.meta.repoId
    || existingRun.mainSessionId !== loaded.sessionId
    || existingRun.skillDefinitionSnapshot
    || existingRun.skillInvocationId
    || existingRun.customTask !== text
  )) {
    return c.json({ error: "requestId is already used by a different launch" }, 409);
  }
  let tab: EnvReviewTab | null;
  try {
    tab = requestedThreadId
      ? await review.getTab(requestedThreadId)
      : existingRun
        ? await review.getTab(existingRun.threadId)
        : await ensurePrimaryReviewer(c.env, review, {
          envSlug: loaded.meta.slug,
          repoId: loaded.meta.repoId,
          mainSessionId: loaded.sessionId,
          harness: loaded.meta.harness,
          harnessSettings: loaded.meta.harnessSettings,
        });
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
  if (!tab || tab.envSlug !== loaded.meta.slug || tab.mainSessionId !== loaded.sessionId || tab.removedAt) {
    return c.json({ error: "Reviewer tab not found" }, 404);
  }
  if (!existingRun && (tab.status === "preparing" || tab.status === "queued" || tab.status === "running")) {
    return c.json({ error: "Reviewer is already running." }, 409);
  }
  try {
    await requireReviewerSelection(c.env, tab.provider, tab.model, tab.effort);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  let launchProvenance: Awaited<ReturnType<typeof resolveNewEnvReviewLaunchProvenance>>;
  try {
    launchProvenance = await resolveNewEnvReviewLaunchProvenance(c.env, tab.provider);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
  let thread: ReturnType<typeof getThreadStub>;
  try {
    thread = await ensureReviewerThread(c.env, tab);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : String(error),
      code: "message_setup_incomplete",
      retryable: true,
    }, 502);
  }
  if (tab.nodeKind !== "generic") {
    const rootThreadId = tab.skillRootThreadId ?? tab.threadId;
    const invocation = await review.getLatestSkillInvocationForRoot(rootThreadId);
    if (!invocation || invocation.envSlug !== loaded.meta.slug) {
      return c.json({ error: "Linked skill invocation not found" }, 409);
    }
    const expectedRoundId = readString(loaded.body.expectedRoundId);
    if (expectedRoundId !== invocation.invocationId) {
      return c.json({ error: "The selected review round is stale." }, 409);
    }
    const initial = (await review.listSkillInvocationRuns(invocation.invocationId)).find((candidate) =>
      (candidate.skillRunRole === "root_initial" || candidate.skillRunRole === "report_initial")
      && (tab.skillAgentId ? candidate.skillAgentId === tab.skillAgentId : true)
      && candidate.preparationOpId === invocation.preparationOpId
      && candidate.preparation
      && candidate.changeContext
    );
    if (!initial?.preparation || !initial.changeContext) {
      return c.json({ error: "The invocation's immutable Review context is not ready." }, 409);
    }
    const agent = tab.skillAgentId
      ? invocation.definitionSnapshot.agents.find((candidate) => candidate.id === tab.skillAgentId)
      : null;
    if (tab.skillAgentId && !agent) return c.json({ error: "Linked skill agent not found" }, 409);
    if (!agent && !invocation.overviewRunId) {
      return c.json({ error: "Create the Overview before following up with the skill root." }, 409);
    }
    const selectedRoute = agent
      ? { provider: tab.provider, model: tab.model, effort: tab.effort }
      : invocation.overviewRoute;
    if (!selectedRoute) {
      return c.json({ error: "The frozen Overview route is unavailable." }, 409);
    }
    if (
      selectedRoute.provider !== tab.provider
      || selectedRoute.model !== tab.model
      || selectedRoute.effort !== tab.effort
    ) {
      try {
        await requireReviewerSelection(
          c.env,
          selectedRoute.provider,
          selectedRoute.model,
          selectedRoute.effort,
        );
        launchProvenance = await resolveNewEnvReviewLaunchProvenance(
          c.env,
          selectedRoute.provider,
        );
      } catch (error) {
        return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
      }
    }
    const runId = crypto.randomUUID();
    const reserved = await review.createSkillFollowupIfNoActive({
      runId,
      threadId: tab.threadId,
      envSlug: loaded.meta.slug,
      repoId: loaded.meta.repoId,
      mainSessionId: loaded.sessionId,
      provider: selectedRoute.provider,
      model: selectedRoute.model,
      effort: selectedRoute.effort,
      roleLabel: tab.roleLabel,
      taskKind: "custom",
      customTask: text,
      recipeInstructions: composeReviewerInstructions(
        invocation.definitionSnapshot.sharedInstructions,
        agent?.instructions ?? invocation.definitionSnapshot.overviewInstructions,
      ),
      preparationOpId: initial.preparationOpId,
      skillInvocationId: invocation.invocationId,
      ...(agent ? { skillAgentId: agent.id } : {}),
      skillRunRole: tab.nodeKind === "report" ? "report_followup" : "root_followup",
      skillDefinitionSnapshot: invocation.definitionSnapshot,
      launchProvenance,
    });
    if (!reserved.ok) {
      return c.json({ error: "Another operation is active for this skill conversation." }, 409);
    }
    const created = reserved.run;
    try {
      await appendThreadMessage(thread, "user", text, [], { id: `env-review-message:${runId}`, runId });
    } catch (error) {
      await review.cancelRun(runId, "Reviewer setup failed before the user message was stored.");
      return c.json({ error: error instanceof Error ? error.message : String(error), retryable: true }, 502);
    }
    const chronological = await listAllThreadMessages(thread);
    const history = buildThreadMessageHistory(chronological, runId, {
      messageLimit: ENV_REVIEW_THREAD_CONTEXT_MESSAGE_LIMIT,
    });
    const prompt = buildEnvReviewPrompt({
      run: created,
      changeContext: initial.changeContext,
      planBasis: normalizeEnvReviewPlanBasis(initial.planBasis),
      recipeInstructions: created.recipeInstructions ?? undefined,
      currentInstruction: text,
      priorMessages: [
        ...(history.truncated
          ? [{ role: "system", text: "[Earlier eligible reviewer messages were omitted by the context window.]" }]
          : []),
        ...history.messages.map((message) => {
        const body = isRecord(message.body) ? message.body : {};
        return {
          role: typeof body.role === "string" ? body.role : message.senderSessionId,
          text: typeof body.text === "string" ? body.text : JSON.stringify(message.body),
        };
        }),
      ],
    });
    const run = await review.updateRun({
      runId: created.runId,
      status: "queued",
      preparation: initial.preparation,
      changeContext: initial.changeContext,
      planBasis: normalizeEnvReviewPlanBasis(initial.planBasis),
      prompt,
      queuedAt: new Date().toISOString(),
      error: null,
    });
    await review.appendRunEvent({
      runId: created.runId,
      type: "run_queued",
      message: "Child follow-up queued with the invocation's frozen Review context.",
      data: {
        invocationId: invocation.invocationId,
        ...(agent ? { agentId: agent.id } : { role: "overview" }),
      },
    });
    await review.scheduleOrchestration();
    const messages = await listAllThreadMessages(thread);
    return c.json({
      run,
      messages,
      state: await stateFor(c, loaded.meta, loaded.sessionId),
    }, 202);
  }
  const runId = requestId ?? crypto.randomUUID();
  const reserved = await review.reserveTopLevelRun({
    runId,
    threadId: tab.threadId,
    envSlug: loaded.meta.slug,
    repoId: loaded.meta.repoId,
    mainSessionId: loaded.sessionId,
    provider: tab.provider,
    model: tab.model,
    effort: tab.effort,
    roleLabel: tab.roleLabel,
    taskKind: "custom",
    customTask: text,
    preparationOpId: crypto.randomUUID(),
    preparationTimeoutMs: PREPARATION_WAIT_MS,
    requestUrl: c.req.url,
    launchProvenance,
  });
  if (reserved.status === "conflict") return c.json({ error: "requestId is already used by a different launch" }, 409);
  if (reserved.status === "not_found") return c.json({ error: "Reviewer tab not found" }, 404);
  if (reserved.status === "parent_locked") return c.json({ error: "The selected reviewer is not idle." }, 409);
  if (!reserved.run) return c.json({ error: "Reviewer run reservation failed." }, 409);
  if (reserved.run.customTask !== text) {
    return c.json({ error: "requestId is already used by a different message" }, 409);
  }
  try {
    await appendThreadMessage(thread, "user", text, [], { id: `env-review-message:${runId}`, runId });
  } catch (error) {
    if (reserved.status === "created") {
      await review.cancelRun(runId, "Reviewer setup failed before the user message was stored.");
    }
    return c.json({ error: error instanceof Error ? error.message : String(error), retryable: true }, 502);
  }
  await review.scheduleOrchestration();
  const messages = await listAllThreadMessages(thread);
  return c.json({
    run: reserved.run,
    messages,
    state: await stateFor(c, loaded.meta, loaded.sessionId),
  }, reserved.status === "created" ? 202 : 200);
}

envReviewRoutes.post("/api/envs/:slug/review/messages", sendEnvReviewMessageRoute);
envReviewRoutes.post("/api/envs/:slug/review/tabs/:threadId/messages", sendEnvReviewMessageRoute);

envReviewRoutes.get("/api/envs/:slug/review/runs/:runId", async (c) => {
  const loaded = await loadEnvReviewRequest(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const run = await review.getRun(c.req.param("runId"));
  if (!run || run.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Env review run not found" }, 404);
  }
  const afterSeqRaw = c.req.query("afterSeq");
  const afterSeq = afterSeqRaw && /^\d+$/.test(afterSeqRaw) ? Number(afterSeqRaw) : null;
  return c.json({
    run,
    events: await review.listRunEvents(run.runId, afterSeq),
  });
});

envReviewRoutes.post("/api/envs/:slug/review/runs/:runId/cancel", async (c) => {
  const loaded = await loadEnvReviewRequestWithBody(c);
  if (!loaded.ok) return loaded.response;
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const run = await review.getRun(c.req.param("runId"));
  if (!run || run.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Env review run not found" }, 404);
  }
  const cancelled = await review.cancelRun(run.runId);
  if (cancelled?.runtime) {
    c.executionCtx.waitUntil(cleanupEnvReviewRunRuntime(c.env, review, cancelled).catch((error: unknown) => {
      console.error(`[env-review] job cleanup failed for cancelled run ${cancelled.runId}:`, error);
    }));
  }
  if (
    cancelled?.skillInvocationId &&
    (cancelled.skillRunRole === "root_initial" ||
      cancelled.skillRunRole === "report_initial")
  ) {
    await assignSkillOverview({
      env: c.env,
      review,
      invocationId: cancelled.skillInvocationId,
      automatic: true,
    }).catch(() => undefined);
  }
  return c.json(await stateFor(c, loaded.meta, loaded.sessionId));
});

async function updateFeedback(c: any, status: "pending" | "sent" | "dismissed") {
  const loaded = await loadEnvReviewRequestWithBody(c);
  if (!loaded.ok) return loaded.response;
  const body = loaded.body;
  const deliveredText = readString(body.deliveredText);
  const review = getEnvReviewStub(c.env, loaded.meta.slug);
  const feedback = await review.getFeedback(c.req.param("feedbackId"));
  if (!feedback || feedback.envSlug !== loaded.meta.slug) {
    return c.json({ error: "Feedback not found" }, 404);
  }
  if (status === "pending") {
    if (!deliveredText) return c.json({ error: "deliveredText is required" }, 400);
    const claimed = await review.claimFeedbackPending({
      feedbackId: feedback.feedbackId,
      deliveredText,
    });
    if (claimed.status === "conflict") {
      return c.json({ error: "Feedback was already claimed.", feedback: claimed.feedback }, 409);
    }
    return c.json({ feedback: claimed.feedback });
  }
  if (status === "sent" && feedback.status !== "pending") {
    return c.json({ error: "Feedback must be pending before it can be marked sent." }, 409);
  }
  const updated = await review.updateFeedbackStatus({
    feedbackId: feedback.feedbackId,
    status,
    ...(deliveredText ? { deliveredText } : {}),
  });
  return c.json({ feedback: updated });
}

envReviewRoutes.post("/api/envs/:slug/review/feedback/:feedbackId/pending", (c) =>
  updateFeedback(c, "pending")
);
envReviewRoutes.post("/api/envs/:slug/review/feedback/:feedbackId/sent", (c) =>
  updateFeedback(c, "sent")
);
envReviewRoutes.post("/api/envs/:slug/review/feedback/:feedbackId/dismiss", (c) =>
  updateFeedback(c, "dismissed")
);

export default envReviewRoutes;
