import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getArtifactStoreStub, getThreadStub } from "../helpers";
import { loadTrackedRepoForRequest } from "../repo/access";
import {
  listPlannerProviders,
  findPlannerProviderEffort,
  findPlannerProviderModel,
  getPlannerProviderModelDefaultEffort,
  isKnownPlannerProviderModel,
} from "./providers";
import {
  appendThreadMessage,
  completeActiveReviewerRun,
  completeReviewerOutput,
  executeReviewerRun,
  finalizeReviewerRunFailure,
  isActiveRun,
} from "./runtime";
import {
  cleanupPlannerRunRuntime,
  dispatchPlannerRun,
  ensurePlanWriterRuntime,
  inspectPlanWriterRuntime,
  plannerExecutionFromLaunch,
  plannerLaunchProvenanceFromExecution,
  resolvePlannerExecution,
  type PlannerExecution,
} from "./dispatch";
import {
  renderArtifactBodyMarkdown,
  type AgentRoute,
  type AgentSkillDefinition,
  type PlannerRun,
  type PlannerRunBasis,
  type PlannerRunLaunchProvenance,
  type PlannerRunEvent,
  type PlannerRunSkillSnapshot,
  type PlannerEffort,
  type ReviewerRegistryEntry,
  type PlanWriterProvider,
  type PlanWriterStopReason,
  type SkillSurface,
} from "../coordination";
import {
  MAX_PLAN_MARKDOWN_BYTES,
  normalizePlanMarkdown,
} from "../coordination/planning";
import {
  DEFAULT_PLAN_WRITING_INSTRUCTIONS,
  effectivePlanWritingInstructions,
  normalizeCustomPlanWritingInstructions,
} from "./writer-instructions";
import {
  assertPlanHealthOverrideInput,
  BUILTIN_PLAN_HEALTH_SKILL_ID,
  DEFAULT_PLAN_WRITER_ROUTE_KEY,
  builtInSkill,
  enforcePlanHealthDefinition,
  isReservedBuiltInSkillIdentity,
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
import { backendSelectionRemovedError } from "../execution";
import {
  isCurrentLaunchProvenance,
  isCurrentPlanWriterLaunchProvenance,
  isCurrentPlanWriterRuntimeProvenance,
} from "../coordination/execution-provenance";
import { getDurableObjectStub } from "../durable-object";
import { broadcastPlanArtifactUpdatedHint } from "../plan-artifact-hints";
import { scheduleWorkerTask } from "../worker-task";
import {
  composeReviewerInstructions,
  listAllThreadMessages,
} from "./context-window";
import { insertPlanHealthVirtualMessage } from "./plan-health";
import {
  planSkillInvocationBasis,
  reserveAndDispatchPlanSkillInvocation,
  resumePlanSkillInvocation,
  resumePlanSkillInvocationRerun,
  setupAndDispatchPlanSkillInvocation,
} from "./plan-skill-dispatch";
import {
  assignPlanSkillOverview,
  createPlanOverviewContribution,
  readIncludedPlanReports,
} from "./plan-skill-overview";

const STALE_ACTIVE_RUN_MS = 15 * 60 * 1000;
const STALE_RUN_ERROR = "Reviewer run timed out without reporting a result.";
const PLAN_AGENT_RESET_CONFIRMATION = "RESET_ALL_PLAN_AGENTS";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const plannerRoutes = new Hono<HonoEnv>();

function isEditablePlanStatus(status: unknown): boolean {
  return status !== "completed" && status !== "archived";
}

async function broadcastWriterStateHint(
  c: any,
  repoId: string,
  planArtifactId: string,
): Promise<void> {
  try {
    const hub = getDurableObjectStub<{
      broadcastPlanWriterState(
        repoId: string,
        planArtifactId: string,
      ): void | Promise<void>;
    }>(c.env, c.env.HUB, "hub");
    await hub.broadcastPlanWriterState(repoId, planArtifactId);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(c: any): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function readThreadMessageRole(message: {
  senderSessionId: string;
  body: unknown;
}): "user" | "assistant" {
  if (isRecord(message.body) && message.body.role === "assistant")
    return "assistant";
  if (isRecord(message.body) && message.body.role === "user") return "user";
  return message.senderSessionId === "assistant" ? "assistant" : "user";
}

function readThreadMessageText(message: { body: unknown }): string {
  if (isRecord(message.body) && typeof message.body.text === "string")
    return message.body.text;
  return typeof message.body === "string" ? message.body : "";
}

function readThreadMessageRunId(message: { body: unknown }): string | null {
  return isRecord(message.body) &&
    typeof message.body.runId === "string" &&
    message.body.runId.trim()
    ? message.body.runId.trim()
    : null;
}

// Lazy watchdog: an active run that stopped reporting must not survive forever,
// because the one-active-run rule would block every future run for this plan.
async function failStaleActivePlannerRun(
  c: any,
  artifactStore: LoadedPlanSuccess["artifactStore"],
  run: PlannerRun | null,
): Promise<PlannerRun | null> {
  if (!run) return run;
  if (!isActiveRun(run)) {
    // Terminal result handling normally schedules this cleanup immediately.
    // Polling is the convergence backstop for an ambiguous commit/response
    // where dispatch could not safely decide whether the run was still active.
    if (run.runtime) {
      runInBackground(c, cleanupPlannerRunRuntime(c.env, artifactStore, run));
    }
    return run;
  }
  const startedAtMs = Date.parse(run.startedAt);
  if (!Number.isFinite(startedAtMs)) return run;

  // A long run whose container is still in contact is not stale: staleness is
  // measured from the most recent signal — start time, last persisted event,
  // or last runtime callback. Empty status polls update callback contact even
  // though they do not create model-progress events.
  const lastEventAt = await artifactStore.getLastPlannerRunEventAt(run.runId);
  const signals = [
    startedAtMs,
    Date.parse(lastEventAt ?? ""),
    Date.parse(run.lastContactAt ?? ""),
  ].filter((value) => Number.isFinite(value));
  const staleActiveCutoffMs = Date.now() - STALE_ACTIVE_RUN_MS;
  if (Math.max(...signals) > staleActiveCutoffMs) return run;

  if (run.status === "saving") {
    if (run.threadId) {
      let message: Awaited<
        ReturnType<ReturnType<typeof getThreadStub>["getMessage"]>
      >;
      try {
        message = await getThreadStub(c.env, run.threadId).getMessage(
          `reviewer-result:${run.runId}`,
        );
      } catch {
        // A transient ThreadDO read must not turn a durable saved result into a
        // failure. A later poll can retry this recovery.
        return run;
      }
      if (
        message &&
        message.threadId === run.threadId &&
        readThreadMessageRole(message) === "assistant" &&
        readThreadMessageRunId(message) === run.runId &&
        (!message.artifactIds?.length ||
          message.artifactIds.includes(run.planArtifactId))
      ) {
        const text = readThreadMessageText(message).trim();
        if (text) {
          const finished = await completeActiveReviewerRun({
            artifactStore,
            thread: getThreadStub(c.env, run.threadId),
            run,
            text,
          });
          const recovered = finished.run;
          if (!isActiveRun(recovered)) {
            if (recovered.runtime) {
              runInBackground(
                c,
                cleanupPlannerRunRuntime(c.env, artifactStore, recovered),
              );
            }
            await broadcastPlanArtifactUpdatedHint(
              c.env,
              run.repoId,
              run.planArtifactId,
            );
          }
          return recovered;
        }
      }
    }
  }

  // Recheck all liveness signals transactionally for every active status. A
  // result callback may have refreshed contact after the snapshot above.
  const finished = await completeReviewerOutput({
    artifactStore,
    run,
    output: { status: "failed", error: STALE_RUN_ERROR },
    staleActiveCutoff: new Date(staleActiveCutoffMs).toISOString(),
  });
  const failed = finished.run;
  if (!isActiveRun(failed)) {
    if (failed.runtime) {
      runInBackground(
        c,
        cleanupPlannerRunRuntime(c.env, artifactStore, failed),
      );
    }
    await broadcastPlanArtifactUpdatedHint(
      c.env,
      run.repoId,
      run.planArtifactId,
    );
  }
  return failed;
}

function runInBackground(c: any, task: Promise<unknown>): void {
  scheduleWorkerTask(c, task, (error) => {
    console.error("[planner] Background reviewer run failed:", error);
  });
}

async function loadPlanContext(c: any): Promise<LoadedPlanContext> {
  const loadedRepo = await loadTrackedRepoForRequest(
    c.env,
    c.req.raw,
    c.req.param("repoId"),
  );
  if (!loadedRepo.ok) {
    return {
      ok: false,
      response: c.json(loadedRepo.body, loadedRepo.status as any),
    };
  }
  const repo = loadedRepo.repo;
  const artifactStore = getArtifactStoreStub(
    c.env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const plan = await artifactStore.getArtifact(
    c.req.param("planArtifactId") || c.req.param("artifactId"),
  );
  if (!plan || plan.repoId !== repo.meta.repoId || plan.type !== "plan") {
    return {
      ok: false,
      response: c.json({ error: "Plan artifact not found" }, 404),
    };
  }
  return {
    ok: true,
    repoId: repo.meta.repoId,
    repoUrl: repo.meta.repoUrl,
    githubFullName: repo.meta.githubFullName,
    githubBaseCommitSha:
      repo.meta.githubDefaultBranchHeadSha ?? repo.meta.mainCommit ?? null,
    gitStatus: repo.meta.gitStatus ?? null,
    gitError: repo.meta.gitError ?? null,
    mainCommit:
      repo.meta.githubDefaultBranchHeadSha ?? repo.meta.mainCommit ?? null,
    artifactStore,
    plan,
  };
}

function hasPlannerGitSource(loaded: LoadedPlanSuccess): boolean {
  return (
    Boolean(loaded.githubBaseCommitSha) &&
    loaded.gitStatus === "ready" &&
    !loaded.gitError
  );
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
  return planSkillInvocationBasis(plan, loaded.githubBaseCommitSha);
}

function plannerGitUnavailableResponse(c: any): Response {
  return c.json({ error: "Repository GitHub metadata is not ready yet." }, 409);
}

async function loadRepoPlanningContext(c: any): Promise<
  | {
      ok: true;
      repoId: string;
      artifactStore: ReturnType<typeof getArtifactStoreStub>;
    }
  | { ok: false; response: Response }
> {
  const loadedRepo = await loadTrackedRepoForRequest(
    c.env,
    c.req.raw,
    c.req.param("repoId"),
  );
  if (!loadedRepo.ok) {
    return {
      ok: false,
      response: c.json(loadedRepo.body, loadedRepo.status as any),
    };
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
  return (
    (await listAgentSkills(artifactStore, repoId, surface)).find(
      (skill) => skill.id === skillId,
    ) ?? null
  );
}

function duplicateAgentSkillCommand(
  skills: AgentSkillDefinition[],
  command: string,
  excludeSkillId?: string,
): boolean {
  return skills.some(
    (skill) =>
      skill.id !== excludeSkillId &&
      skill.command.toLowerCase() === command.toLowerCase(),
  );
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
    const skill = await artifactStore.upsertStoredAgentSkill({
      repoId,
      definition,
    });
    return c.json({ ok: true, skill }, status);
  } catch (error) {
    if (skillStorageConflict(error))
      return c.json({ error: `/${definition.command} already exists` }, 409);
    throw error;
  }
}

function isActiveReviewerForPlan(
  reviewer: ReviewerRegistryEntry | null,
  loaded: LoadedPlanSuccess,
): reviewer is ReviewerRegistryEntry {
  return Boolean(
    reviewer &&
    reviewer.role === "reviewer" &&
    reviewer.repoId === loaded.repoId &&
    reviewer.planArtifactId === loaded.plan.id &&
    !reviewer.removedAt,
  );
}

function isPlanSkillHistoryParentForPlan(
  parent: ReviewerRegistryEntry | null,
  loaded: LoadedPlanSuccess,
): parent is ReviewerRegistryEntry {
  return Boolean(
    parent &&
    parent.repoId === loaded.repoId &&
    parent.planArtifactId === loaded.plan.id &&
    parent.role === "reviewer" &&
    parent.nodeKind === "skill_root",
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
  const loadedRepo = await loadTrackedRepoForRequest(
    c.env,
    c.req.raw,
    c.req.param("repoId"),
  );
  if (!loadedRepo.ok) {
    return {
      ok: false,
      response: c.json(loadedRepo.body, loadedRepo.status as any),
    };
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
function readAfterSeq(
  c: any,
): { ok: true; afterSeq: number | null } | { ok: false; response: Response } {
  const raw = c.req.query("afterSeq");
  if (raw === undefined) return { ok: true, afterSeq: null };
  const afterSeq = Number(raw);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    return {
      ok: false,
      response: c.json(
        { error: "afterSeq must be a non-negative integer" },
        400,
      ),
    };
  }
  return { ok: true, afterSeq };
}

async function requireAvailableProvider(
  c: any,
  providerId: string,
  modelId: string,
  role: "writer" | "reviewer",
) {
  if (!isKnownPlannerProviderModel(providerId, modelId)) {
    return {
      ok: false as const,
      response: c.json({ error: "Planner provider or model not found" }, 400),
    };
  }
  const catalog = await listPlannerProviders(c.env, {
    onlyProviderId: providerId,
  });
  const { providers } = catalog;
  const match = findPlannerProviderModel(providers, providerId, modelId);
  if (!match) {
    return {
      ok: false as const,
      response: c.json({ error: "Planner provider or model not found" }, 400),
    };
  }
  const supportsRole =
    role === "writer"
      ? match.provider.capabilities.writer
      : match.provider.capabilities.reviewer;
  if (!supportsRole) {
    return {
      ok: false as const,
      response: c.json(
        { error: `Planner provider does not support ${role} runs` },
        400,
      ),
    };
  }
  if (!match.provider.available || !match.model.available) {
    return {
      ok: false as const,
      response: c.json(
        {
          error:
            match.model.disabledReason ||
            match.provider.disabledReasons[0] ||
            "Planner provider is unavailable",
          provider: match.provider,
        },
        409,
      ),
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
  skillRunRole?: "root_followup" | "report_followup";
  effort?: PlannerEffort;
}) {
  const {
    c,
    loaded,
    threadId,
    provider,
    model,
    skill,
    userText,
    instruction,
    skillSnapshot,
  } = options;
  await failStaleActivePlannerRun(
    c,
    loaded.artifactStore,
    await loaded.artifactStore.getActiveRunForThread(
      loaded.repoId,
      loaded.plan.id,
      "reviewer",
      threadId,
    ),
  );
  const execution = await resolvePlannerExecution(c.env, provider, {
    codexSurface: "plan-reviewer",
  });
  if (execution.kind === "unavailable") {
    return {
      ok: false as const,
      response: c.json({ error: execution.reason }, 409),
    };
  }
  if (execution.kind === "dispatched" && !hasPlannerGitSource(loaded)) {
    return {
      ok: false as const,
      response: plannerGitUnavailableResponse(c),
    };
  }
  let created: Awaited<
    ReturnType<typeof loaded.artifactStore.createPlannerRunIfNoActive>
  >;
  try {
    created = await loaded.artifactStore.createPlannerRunIfNoActive({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      role: "reviewer",
      provider,
      model,
      ...(skill ? { skill } : {}),
      threadId,
      expectedPlanVersion: (loaded.plan as { version?: number }).version ?? 1,
      ...(options.skillInvocationId
        ? { skillInvocationId: options.skillInvocationId }
        : {}),
      ...(options.skillAgentId ? { skillAgentId: options.skillAgentId } : {}),
      ...(options.skillRunRole ? { skillRunRole: options.skillRunRole } : {}),
      input: {
        ...(instruction || userText
          ? { instruction: instruction ?? userText }
          : {}),
        sourcePlanVersion:
          options.basis?.version ??
          (loaded.plan as { version?: number }).version ??
          1,
        githubBaseCommitSha:
          options.basis?.gitBaseCommitSha ?? loaded.githubBaseCommitSha,
        ...(skillSnapshot ? { skillSnapshot } : {}),
        ...(options.skillDefinitionSnapshot
          ? { skillDefinitionSnapshot: options.skillDefinitionSnapshot }
          : {}),
        ...(options.basis
          ? { basis: options.basis }
          : { basis: plannerRunBasis(loaded) }),
        ...(options.effort ? { effort: options.effort } : {}),
      },
      launchProvenance:
        execution.kind === "dispatched"
          ? plannerLaunchProvenanceFromExecution(execution)
          : { schemaVersion: 1, backend: "cf", machineId: null },
    });
  } catch (error) {
    return {
      ok: false as const,
      response: c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The plan changed before reviewer work started.",
        },
        409,
      ),
    };
  }
  if (!created.ok) {
    return {
      ok: false as const,
      response: c.json(
        {
          error: "A reviewer run is already active for this tab.",
          run: created.active,
        },
        409,
      ),
    };
  }
  const run = created.run;
  const thread = getThreadStub(c.env, threadId);
  const userMessage = userText
    ? await appendThreadMessage(thread, "user", userText, [loaded.plan.id], {
        runId: run.runId,
      })
    : null;
  const currentRun = await loaded.artifactStore.getPlannerRun(run.runId);
  if (!currentRun || !isActiveRun(currentRun)) {
    return {
      ok: false as const,
      response: c.json(
        { error: "The plan changed before reviewer work started." },
        409,
      ),
    };
  }
  await loaded.artifactStore.ensurePlannerRunQueuedEvent({
    runId: run.runId,
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    type: "run_queued",
    message: "Reviewer run queued.",
    data: { provider, model, ...(skill ? { skill } : {}) },
  });
  runInBackground(
    c,
    broadcastPlanArtifactUpdatedHint(
      c.env,
      loaded.repoId,
      loaded.plan.id,
    ).catch((error) => {
      console.warn("[planner] Failed to broadcast reviewer start hint:", error);
    }),
  );
  if (execution.kind === "dispatched") {
    runInBackground(
      c,
      dispatchPlannerRun({
        env: c.env,
        requestUrl: c.req.url,
        artifactStore: loaded.artifactStore,
        run,
        repo: plannerRepoRuntimeSource(loaded),
      }),
    );
    return { ok: true as const, run, userMessage };
  }
  runInBackground(
    c,
    executeReviewerRun({
      artifactStore: loaded.artifactStore,
      thread,
      run,
    }).then(async (finished) => {
      if (finished.status === "completed" || finished.status === "failed") {
        await broadcastPlanArtifactUpdatedHint(
          c.env,
          loaded.repoId,
          loaded.plan.id,
        );
      }
    }),
  );
  return { ok: true as const, run, userMessage };
}

plannerRoutes.get("/api/repos/:repoId/planner-providers", async (c) => {
  const loadedRepo = await loadTrackedRepoForRequest(
    c.env,
    c.req.raw,
    c.req.param("repoId"),
  );
  if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
  const catalog = await listPlannerProviders(c.env);
  return c.json({
    providers: catalog.providers,
    writerRoutes: catalog.writerRoutes,
    skillRoutes: listCanonicalAgentRoutes(catalog.providers),
  });
});

plannerRoutes.post("/api/repos/:repoId/plan-agents/reset", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const resetId = c.req.header("Idempotency-Key")?.trim().toLowerCase() ?? "";
  if (!UUID_PATTERN.test(resetId)) {
    return c.json(
      {
        error: "Idempotency-Key must be a UUID.",
        code: "invalid_request",
      },
      400,
    );
  }
  const body = await readJsonBody(c);
  if (
    Object.keys(body).length !== 1 ||
    body.confirmation !== PLAN_AGENT_RESET_CONFIRMATION
  ) {
    return c.json(
      {
        error: `Request body must contain only confirmation: ${PLAN_AGENT_RESET_CONFIRMATION}.`,
        code: "invalid_request",
      },
      400,
    );
  }
  const requestHash = await sha256Hex(
    JSON.stringify({ version: 1, confirmation: PLAN_AGENT_RESET_CONFIRMATION }),
  );
  try {
    const result = await loaded.artifactStore.resetPlanAgents({
      repoId: loaded.repoId,
      resetId,
      requestHash,
    });
    if (result.status === "idempotency_conflict") {
      return c.json(
        {
          error: "Idempotency-Key was already used for a different request.",
          code: "idempotency_conflict",
        },
        409,
      );
    }
    if (result.status === "unsupported_cleanup_ownership") {
      return c.json(
        {
          error:
            "Plan agents could not be reset because runtime cleanup ownership is unsupported.",
          code: "unsupported_cleanup_ownership",
          blockerCount: result.blockerCount,
          blockers: result.blockers,
        },
        409,
      );
    }
    return c.json({
      ok: true,
      ...result.report,
      replayed: result.status === "replayed",
    });
  } catch (error) {
    console.error(
      "[planner] plan-agent reset failed:",
      error instanceof Error ? error.message : String(error),
    );
    return c.json(
      { error: "Failed to reset plan agents.", code: "reset_failed" },
      500,
    );
  }
});

plannerRoutes.get("/api/repos/:repoId/skills", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const surface = c.req.query("surface");
  if (!isSkillSurface(surface))
    return c.json({ error: "surface must be plan or review" }, 400);
  return c.json({
    skills: await listAgentSkills(loaded.artifactStore, loaded.repoId, surface),
  });
});

plannerRoutes.post("/api/repos/:repoId/skills", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  if (!isSkillSurface(body.surface))
    return c.json({ error: "surface must be plan or review" }, 400);
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
      requireSharedInstructions: true,
    });
    if (isReservedBuiltInSkillIdentity(definition.id, definition.command)) {
      return c.json(
        { error: "That skill identity or command is reserved." },
        409,
      );
    }
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
  const skills = await listAgentSkills(
    loaded.artifactStore,
    loaded.repoId,
    definition.surface,
  );
  if (duplicateAgentSkillCommand(skills, definition.command)) {
    return c.json({ error: `/${definition.command} already exists` }, 409);
  }
  return writeAgentSkill(
    c,
    loaded.artifactStore,
    loaded.repoId,
    definition,
    201,
  );
});

plannerRoutes.put("/api/repos/:repoId/skills/:surface/:skillId", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const surface = c.req.param("surface");
  if (!isSkillSurface(surface))
    return c.json({ error: "surface must be plan or review" }, 400);
  const existing = await resolveAgentSkill(
    loaded.artifactStore,
    loaded.repoId,
    surface,
    c.req.param("skillId"),
  );
  if (!existing) return c.json({ error: "Skill not found" }, 404);
  const body = await readJsonBody(c);
  let definition: AgentSkillDefinition;
  try {
    if (existing.id === BUILTIN_PLAN_HEALTH_SKILL_ID)
      assertPlanHealthOverrideInput(body);
    definition = normalizeSkillDefinition(
      { ...existing, ...body, surface },
      {
        id: existing.id,
        surface,
        origin: existing.origin,
        customized: true,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        routes: listCanonicalAgentRoutes(),
        requireSharedInstructions: true,
        ...(existing.origin === "builtin"
          ? { fixedCommand: builtInSkill(surface, existing.id).command }
          : {}),
      },
    );
    if (existing.id === BUILTIN_PLAN_HEALTH_SKILL_ID) {
      definition = enforcePlanHealthDefinition(definition);
    }
    if (
      existing.origin === "custom" &&
      isReservedBuiltInSkillIdentity(definition.id, definition.command)
    ) {
      return c.json(
        { error: "That skill identity or command is reserved." },
        409,
      );
    }
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : String(error) },
      400,
    );
  }
  const skills = await listAgentSkills(
    loaded.artifactStore,
    loaded.repoId,
    surface,
  );
  if (duplicateAgentSkillCommand(skills, definition.command, definition.id)) {
    return c.json({ error: `/${definition.command} already exists` }, 409);
  }
  return writeAgentSkill(
    c,
    loaded.artifactStore,
    loaded.repoId,
    definition,
    200,
  );
});

plannerRoutes.delete(
  "/api/repos/:repoId/skills/:surface/:skillId",
  async (c) => {
    const loaded = await loadRepoPlanningContext(c);
    if (!loaded.ok) return loaded.response;
    const surface = c.req.param("surface");
    if (!isSkillSurface(surface))
      return c.json({ error: "surface must be plan or review" }, 400);
    const existing = await resolveAgentSkill(
      loaded.artifactStore,
      loaded.repoId,
      surface,
      c.req.param("skillId"),
    );
    if (!existing) return c.json({ error: "Skill not found" }, 404);
    await loaded.artifactStore.deleteStoredAgentSkill(
      loaded.repoId,
      surface,
      existing.id,
    );
    return c.json({
      ok: true,
      ...(existing.origin === "builtin"
        ? { skill: builtInSkill(surface, existing.id) }
        : {}),
    });
  },
);

plannerRoutes.get("/api/repos/:repoId/plan-writer-settings", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const defaultRoute = resolveAgentRoute(DEFAULT_PLAN_WRITER_ROUTE_KEY);
  const settings = await loaded.artifactStore.getRepoPlanWriterSettings(
    loaded.repoId,
    {
      routeKey: DEFAULT_PLAN_WRITER_ROUTE_KEY,
      effort: defaultRoute?.defaultEffort ?? "high",
      planFormat: DEFAULT_PLAN_WRITING_INSTRUCTIONS,
    },
  );
  return c.json({ settings });
});

function validatePlanWriterRoute(
  c: any,
  providers: Awaited<ReturnType<typeof listPlannerProviders>>["providers"],
  writerRoutes: AgentRoute[],
  routeKey: string | null,
  effortInput: string | null,
):
  | {
      ok: true;
      route: AgentRoute & { provider: PlanWriterProvider };
      effort: PlannerEffort;
    }
  | { ok: false; response: Response } {
  const route = routeKey
    ? writerRoutes.find((candidate) => candidate.key === routeKey)
    : null;
  if (
    !route ||
    !isPlanWriterProvider(route.provider) ||
    route.harness !== route.provider
  ) {
    return {
      ok: false,
      response: c.json({ error: "Unknown Plan Writer route" }, 400),
    };
  }
  const provider = providers.find(
    (candidate) => candidate.id === route.provider,
  );
  if (!provider?.capabilities.writer) {
    return {
      ok: false,
      response: c.json(
        { error: `${route.label} cannot run as a writer.` },
        400,
      ),
    };
  }
  const effort = (effortInput ?? route.defaultEffort) as PlannerEffort;
  if (!route.supportedEfforts.includes(effort)) {
    return {
      ok: false,
      response: c.json(
        { error: `${route.label} does not support ${effortInput} reasoning.` },
        400,
      ),
    };
  }
  if (!route.available) {
    return {
      ok: false,
      response: c.json(
        { error: route.disabledReason ?? `${route.label} is unavailable.` },
        409,
      ),
    };
  }
  return {
    ok: true,
    route: route as AgentRoute & { provider: PlanWriterProvider },
    effort,
  };
}

plannerRoutes.put("/api/repos/:repoId/plan-writer-settings", async (c) => {
  const loaded = await loadRepoPlanningContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  const routeKey = readString(body.routeKey);
  const planFormat = readString(body.planFormat);
  const catalog = await listPlannerProviders(c.env);
  const routeSelection = validatePlanWriterRoute(
    c,
    catalog.providers,
    catalog.writerRoutes,
    routeKey,
    readString(body.effort),
  );
  if (!routeSelection.ok) return routeSelection.response;
  const { route, effort: requestedEffort } = routeSelection;
  if (!planFormat) return c.json({ error: "planFormat is required" }, 400);
  const settings = await loaded.artifactStore.setRepoPlanWriterSettings({
    repoId: loaded.repoId,
    routeKey: route.key,
    effort: requestedEffort,
    planFormat,
  });
  return c.json({ ok: true, settings });
});

async function resolvePlanWriterSelection(
  c: any,
  loaded: LoadedPlanSuccess,
  requestedRouteKey: unknown,
  requestedEffort: unknown,
): Promise<
  | {
      ok: true;
      provider: PlanWriterProvider;
      model: string;
      effort: PlannerEffort;
    }
  | { ok: false; response: Response }
> {
  const routeKeyInput = readString(requestedRouteKey);
  const effortInput = readString(requestedEffort);
  const { providers, writerRoutes } = await listPlannerProviders(c.env);
  const configuredDefaultRoute = writerRoutes.find(
    (route) => route.key === DEFAULT_PLAN_WRITER_ROUTE_KEY,
  );
  const settings = await loaded.artifactStore.getRepoPlanWriterSettings(
    loaded.repoId,
    {
      routeKey: DEFAULT_PLAN_WRITER_ROUTE_KEY,
      effort: configuredDefaultRoute?.defaultEffort ?? "high",
      planFormat: DEFAULT_PLAN_WRITING_INSTRUCTIONS,
    },
  );
  const routeSelection = validatePlanWriterRoute(
    c,
    providers,
    writerRoutes,
    routeKeyInput ?? settings.routeKey,
    effortInput ??
      (routeKeyInput && routeKeyInput !== settings.routeKey
        ? null
        : settings.effort),
  );
  if (!routeSelection.ok) return routeSelection;
  return {
    ok: true,
    provider: routeSelection.route.provider,
    model: routeSelection.route.model,
    effort: routeSelection.effort,
  };
}

async function readLiveWriterState(loaded: LoadedPlanSuccess) {
  const writer = await loaded.artifactStore.getPlanWriter(
    loaded.repoId,
    loaded.plan.id,
  );
  return derivePlanWriterState(
    writer,
    isEditablePlanStatus((loaded.plan as { status?: unknown }).status),
  );
}

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/live-writer",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    return c.json({ writer: await readLiveWriterState(loaded) });
  },
);

plannerRoutes.put("/api/repos/:repoId/plans/:planArtifactId", async (c) => {
  const loaded = await loadPlanContext(c);
  if (!loaded.ok) return loaded.response;
  const body = await readJsonBody(c);
  if (typeof body.markdown !== "string") {
    return c.json({ error: "markdown is required" }, 400);
  }
  const markdown = normalizePlanMarkdown(body.markdown);
  if (new TextEncoder().encode(markdown).byteLength > MAX_PLAN_MARKDOWN_BYTES) {
    return c.json(
      { error: `Plan Markdown exceeds ${MAX_PLAN_MARKDOWN_BYTES} UTF-8 bytes` },
      413,
    );
  }
  if (!isEditablePlanStatus((loaded.plan as { status?: unknown }).status)) {
    return c.json(
      { error: "Only draft, evaluating, or todo plans can be edited." },
      409,
    );
  }

  try {
    const saved = await loaded.artifactStore.savePlan({
      repoId: loaded.repoId,
      id: loaded.plan.id,
      markdown,
    });
    if (saved.changed) {
      await broadcastPlanArtifactUpdatedHint(
        c.env,
        loaded.repoId,
        loaded.plan.id,
      );
    }
    return c.json({
      ok: true,
      artifact: saved.artifact,
      changed: saved.changed,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to save plan";
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

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/live-writer/start",
  async (c) => {
    const body = await readJsonBody(c);
    const removedBackendSelection = backendSelectionRemovedError(body);
    if (removedBackendSelection) return c.json(removedBackendSelection, 400);
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    if (!isEditablePlanStatus((loaded.plan as { status?: unknown }).status)) {
      return c.json(
        {
          error: "Completed or archived plans cannot start a writer.",
          writer: await readLiveWriterState(loaded),
        },
        409,
      );
    }

    let existing = await loaded.artifactStore.getPlanWriter(
      loaded.repoId,
      loaded.plan.id,
    );
    const activeReservation =
      existing &&
      !existing.stoppedAt &&
      !existing.startupError &&
      !existing.cleanupError
        ? existing
        : null;
    if (activeReservation?.runtime) {
      if (
        !isCurrentPlanWriterLaunchProvenance(
          activeReservation.launchProvenance,
        ) ||
        !isCurrentPlanWriterRuntimeProvenance(activeReservation.runtime)
      ) {
        return c.json(
          {
            error: "This Plan Writer was created by an unsupported version.",
            writer: await readLiveWriterState(loaded),
          },
          409,
        );
      }
      let live: boolean;
      try {
        live = await inspectPlanWriterRuntime(
          c.env,
          activeReservation.runtime,
          activeReservation.launchProvenance,
        );
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Plan Writer runtime inspection failed",
            writer: await readLiveWriterState(loaded),
          },
          502,
        );
      }
      if (live) return c.json({ writer: await readLiveWriterState(loaded) });
      const abandoned = await loaded.artifactStore.abandonPlanWriter({
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        expectedGeneration: activeReservation.generation!,
        reason: "runtime_ended",
      });
      if (abandoned.status !== "abandoned") {
        return c.json(
          {
            error:
              abandoned.status === "stale"
                ? "The Scribe generation changed while its runtime was inspected."
                : "The inspected Scribe no longer exists.",
            writer: await readLiveWriterState(loaded),
          },
          409,
        );
      }
      existing = abandoned.writer ?? activeReservation;
    }
    const reservationStillActive =
      existing &&
      !existing.stoppedAt &&
      !existing.startupError &&
      !existing.cleanupError
        ? existing
        : null;
    if (!reservationStillActive && (existing?.runtime || existing?.jobSlug)) {
      const generation = existing.generation;
      if (!generation) {
        return c.json(
          { error: "The previous Scribe is missing its generation." },
          409,
        );
      }
      const abandoned = await loaded.artifactStore.abandonPlanWriter({
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        expectedGeneration: generation,
        reason: "runtime_ended",
      });
      if (abandoned.status !== "abandoned") {
        return c.json(
          {
            error:
              "The previous Scribe generation changed before it could be replaced.",
            writer: await readLiveWriterState(loaded),
          },
          409,
        );
      }
      existing = abandoned.writer ?? existing;
    }

    let writer: ReviewerRegistryEntry;
    if (reservationStillActive) {
      // A request may have been lost after reserving a generation but before
      // launching it. Retried/concurrent Start calls finish that same exact
      // reservation and ignore newly requested provider changes.
      writer = reservationStillActive;
    } else {
      const selection = await resolvePlanWriterSelection(
        c,
        loaded,
        body.routeKey,
        body.effort,
      );
      if (!selection.ok) return selection.response;
      const execution = await resolvePlannerExecution(
        c.env,
        selection.provider,
        { codexSurface: "plan-writer" },
      );
      if (execution.kind !== "dispatched") {
        return c.json(
          {
            error:
              execution.kind === "unavailable"
                ? execution.reason
                : "Plan Writer requires a container runner backend.",
          },
          409,
        );
      }
      const basisCommit =
        (
          loaded.plan as { basis?: { mainCommit?: string | null } }
        ).basis?.mainCommit?.trim() ?? "";
      if (!basisCommit) {
        return c.json(
          {
            error:
              "This plan has no frozen basis commit and cannot start a writer.",
          },
          409,
        );
      }
      const markdown = renderArtifactBodyMarkdown(
        (loaded.plan as { body?: unknown }).body,
      );
      const startBodyDigest = await sha256Hex(
        normalizeCanonicalPlanForDigest(markdown),
      );
      try {
        const projectedSkills =
          selection.provider === "claude-code"
            ? await listAgentSkills(loaded.artifactStore, loaded.repoId, "plan")
            : [];
        writer = await loaded.artifactStore.startPlanWriter({
          repoId: loaded.repoId,
          planArtifactId: loaded.plan.id,
          expectedPlanVersion:
            (loaded.plan as { version?: number }).version ?? 1,
          provider: selection.provider,
          model: selection.model,
          effort: selection.effort,
          basisCommit,
          startBodyDigest,
          launchProvenance: launchProvenanceForExecution(execution),
          skills: projectedSkills,
        });
      } catch (error) {
        return c.json(
          {
            error:
              error instanceof Error
                ? error.message
                : "Failed to reserve writer generation",
          },
          409,
        );
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
      const current = await loaded.artifactStore.getPlanWriter(
        loaded.repoId,
        loaded.plan.id,
      );
      if (
        current &&
        current.generation === writer.generation &&
        current.stoppedAt
      ) {
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
      return c.json(
        { error: message, writer: await readLiveWriterState(loaded) },
        502,
      );
    }
    await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
    return c.json({ writer: await readLiveWriterState(loaded) }, 202);
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/live-writer/stop",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const expectedGeneration = body.expectedGeneration;
    if (
      !Number.isInteger(expectedGeneration) ||
      (expectedGeneration as number) < 1
    ) {
      return c.json(
        { error: "expectedGeneration must be a positive integer" },
        400,
      );
    }
    const abandoned = await loaded.artifactStore.abandonPlanWriter({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      expectedGeneration: expectedGeneration as number,
      reason: "user" satisfies PlanWriterStopReason,
    });
    if (abandoned.status === "not_found") {
      return c.json(
        {
          error: "Plan writer not found",
          writer: await readLiveWriterState(loaded),
        },
        404,
      );
    }
    if (abandoned.status === "stale") {
      return c.json(
        {
          error:
            "The writer generation changed; the replacement was not stopped.",
          writer: await readLiveWriterState(loaded),
        },
        409,
      );
    }
    await broadcastWriterStateHint(c, loaded.repoId, loaded.plan.id);
    const cleanupPending = abandoned.cleanupTargets.length > 0;
    return c.json({
      writer: await readLiveWriterState(loaded),
      ...(cleanupPending
        ? {
            cleanupPending: true,
            cleanupCode: "runtime_cleanup_deferred",
            cleanupWarning:
              "Scribe stopped. Runtime cleanup will finish when the execution backend is available; you can restart it now.",
          }
        : {}),
    });
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/contributions",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const status = c.req.query("status");
    const contributions = await loaded.artifactStore.listPlanContributions(
      loaded.repoId,
      loaded.plan.id,
      status === "pending" ||
        status === "incorporated" ||
        status === "dismissed"
        ? { status }
        : {},
    );
    return c.json({ contributions });
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/contributions/:contributionId/dismiss",
  async (c) => {
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
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Plan contribution not found",
        },
        404,
      );
    }
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/contributions/:contributionId/incorporate",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    try {
      const [contribution] =
        await loaded.artifactStore.incorporatePlanContributions(
          loaded.repoId,
          loaded.plan.id,
          [c.req.param("contributionId")],
        );
      return c.json({ ok: true, contribution });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Plan contribution not found",
        },
        404,
      );
    }
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/scribe-handoffs",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const requestId = readString(body.requestId);
    if (!requestId || requestId.length > 256)
      return c.json({ error: "requestId is required" }, 400);
    if (typeof body.content !== "string" || !body.content.trim()) {
      return c.json({ error: "content must not be empty" }, 400);
    }
    if (!Array.isArray(body.sources) || body.sources.length === 0) {
      return c.json({ error: "At least one source is required" }, 400);
    }
    const requestedSources: Array<{ threadId: string; messageId: string }> = [];
    const seen = new Set<string>();
    for (const raw of body.sources) {
      if (!isRecord(raw))
        return c.json(
          { error: "Every source must include threadId and messageId" },
          400,
        );
      const threadId = readString(raw.threadId);
      const messageId = readString(raw.messageId);
      if (!threadId || !messageId)
        return c.json(
          { error: "Every source must include threadId and messageId" },
          400,
        );
      const key = JSON.stringify([threadId, messageId]);
      if (seen.has(key))
        return c.json({ error: "Sources must not contain duplicates" }, 400);
      seen.add(key);
      requestedSources.push({ threadId, messageId });
    }

    const resolved: Array<{
      source: { threadId: string; messageId: string; runId: string };
      run: PlannerRun;
    }> = [];
    for (const source of requestedSources) {
      const reviewer = await loaded.artifactStore.getReviewer(source.threadId);
      if (
        !reviewer ||
        reviewer.role !== "reviewer" ||
        reviewer.repoId !== loaded.repoId ||
        reviewer.planArtifactId !== loaded.plan.id
      )
        return c.json(
          { error: "A source reviewer does not belong to this plan" },
          400,
        );
      const message = await getThreadStub(c.env, source.threadId).getMessage(
        source.messageId,
      );
      if (
        !message ||
        message.threadId !== source.threadId ||
        readThreadMessageRole(message) !== "assistant" ||
        !message.artifactIds?.includes(loaded.plan.id)
      )
        return c.json(
          { error: "A source is not an assistant message for this plan" },
          400,
        );
      const runId = readThreadMessageRunId(message);
      const run = runId
        ? await loaded.artifactStore.getPlannerRun(runId)
        : null;
      if (
        !run ||
        run.status !== "completed" ||
        run.role !== "reviewer" ||
        run.repoId !== loaded.repoId ||
        run.planArtifactId !== loaded.plan.id ||
        run.threadId !== source.threadId
      )
        return c.json(
          { error: "A source does not reference a completed reviewer run" },
          400,
        );
      if (run.skillRunRole === "overview") {
        return c.json(
          {
            error:
              "Overview responses must use their canonical Share with Scribe delivery.",
          },
          409,
        );
      }
      resolved.push({ source: { ...source, runId: run.runId }, run });
    }
    const first = resolved[0]!;
    const result =
      await loaded.artifactStore.createOrGetCuratedPlanContribution({
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        sourceKind: "curated_reviewer_handoff",
        sourceRunId: first.run.runId,
        sourceThreadId: first.source.threadId,
        sourceMessageId: first.source.messageId,
        sourcePlanVersion:
          first.run.input?.sourcePlanVersion ??
          (loaded.plan as { version?: number }).version ??
          1,
        sourceRefs: resolved.map((entry) => entry.source),
        idempotencyKey: `scribe-handoff:${requestId}`,
        provider: first.run.provider,
        model: first.run.model,
        ...(first.run.skill ? { skill: first.run.skill } : {}),
        text: body.content,
      });
    if (result.status === "conflict") {
      return c.json(
        {
          error:
            "requestId is already used with different content or source ordering",
        },
        409,
      );
    }
    if (result.status === "source_used")
      return c.json(
        {
          error:
            "A selected reviewer message was already shared with the Scribe",
        },
        409,
      );
    return c.json(
      {
        ok: true,
        contribution: result.contribution,
        created: result.status === "created",
      },
      result.status === "created" ? 201 : 200,
    );
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/runs/latest",
  async (c) => {
    const loaded = await loadRunPollContext(c);
    if (!loaded.ok) return loaded.response;
    const afterSeq = readAfterSeq(c);
    if (!afterSeq.ok) return afterSeq.response;
    const role = c.req.query("role");
    if (role !== "reviewer")
      return c.json({ error: "role=reviewer is required" }, 400);
    const threadId = readString(c.req.query("threadId") ?? null);
    const latest = await loaded.artifactStore.getLatestPlannerRun(
      loaded.repoId,
      loaded.planArtifactId,
      role,
      threadId ?? null,
    );
    if (!latest) {
      return c.json({ run: null, events: [] });
    }
    const run =
      (await failStaleActivePlannerRun(c, loaded.artifactStore, latest)) ??
      latest;
    const events = await loaded.artifactStore.listPlannerRunEvents(run.runId, {
      afterSeq: afterSeq.afterSeq,
    });
    return c.json({ run, events });
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/runs/:runId",
  async (c) => {
    const loaded = await loadRunPollContext(c);
    if (!loaded.ok) return loaded.response;
    const afterSeq = readAfterSeq(c);
    if (!afterSeq.ok) return afterSeq.response;
    const fetched = await loaded.artifactStore.getPlannerRun(
      c.req.param("runId"),
    );
    if (
      !fetched ||
      fetched.role !== "reviewer" ||
      fetched.repoId !== loaded.repoId ||
      fetched.planArtifactId !== loaded.planArtifactId
    ) {
      return c.json({ error: "Reviewer run not found" }, 404);
    }
    const run =
      (await failStaleActivePlannerRun(c, loaded.artifactStore, fetched)) ??
      fetched;
    const events = await loaded.artifactStore.listPlannerRunEvents(run.runId, {
      afterSeq: afterSeq.afterSeq,
    });
    return c.json({ run, events });
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/runs/:runId/cancel",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const run = await loaded.artifactStore.getPlannerRun(c.req.param("runId"));
    if (
      !run ||
      run.role !== "reviewer" ||
      run.repoId !== loaded.repoId ||
      run.planArtifactId !== loaded.plan.id
    ) {
      return c.json({ error: "Reviewer run not found" }, 404);
    }
    if (!isActiveRun(run)) {
      if (run.runtime) {
        runInBackground(
          c,
          cleanupPlannerRunRuntime(c.env, loaded.artifactStore, run),
        );
      }
      return c.json({ ok: true, run });
    }
    if (
      run.skillInvocationId &&
      (run.skillRunRole === "root_initial" ||
        run.skillRunRole === "report_initial")
    ) {
      const invocation = await loaded.artifactStore.getPlanSkillInvocation(
        run.skillInvocationId,
      );
      if (invocation?.definitionSnapshot.id === BUILTIN_PLAN_HEALTH_SKILL_ID) {
        const linkedRuns =
          await loaded.artifactStore.listPlanSkillInvocationRuns(
            invocation.invocationId,
          );
        await loaded.artifactStore.cancelPlanSkillInvocation(
          invocation.invocationId,
        );
        for (const linkedRun of linkedRuns) {
          if (linkedRun.runtime && isActiveRun(linkedRun)) {
            runInBackground(
              c,
              cleanupPlannerRunRuntime(c.env, loaded.artifactStore, linkedRun),
            );
          }
        }
        await broadcastPlanArtifactUpdatedHint(
          c.env,
          loaded.repoId,
          loaded.plan.id,
        );
        return c.json({
          ok: true,
          run: (await loaded.artifactStore.getPlannerRun(run.runId)) ?? run,
        });
      }
    }
    const cancelled = await loaded.artifactStore.cancelActivePlannerRun(
      run.runId,
      {
        allowSaving: false,
        completedAt: new Date().toISOString(),
      },
    );
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
      runInBackground(
        c,
        cleanupPlannerRunRuntime(c.env, loaded.artifactStore, cancelled),
      );
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
    if (
      cancelled.skillInvocationId
      && (cancelled.skillRunRole === "report_initial" || cancelled.skillRunRole === "report_followup")
    ) {
      await assignPlanSkillOverview({
        env: c.env,
        requestUrl: c.req.url,
        artifactStore: loaded.artifactStore,
        invocationId: cancelled.skillInvocationId,
        repo: plannerRepoRuntimeSource(loaded),
        automatic: true,
        schedule: (task) => runInBackground(c, task),
      }).catch((error) => {
        console.error(
          `[planner] automatic Overview check failed for ${cancelled.skillInvocationId}:`,
          error,
        );
      });
    }
    return c.json({ ok: true, run: cancelled });
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    return c.json({
      reviewers: await loaded.artifactStore.listReviewers(
        loaded.repoId,
        loaded.plan.id,
      ),
    });
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers",
  async (c) => {
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
    const providerState = await requireAvailableProvider(
      c,
      provider,
      model,
      "reviewer",
    );
    if (!providerState.ok) return providerState.response;
    const effort =
      requestedEffort ??
      getPlannerProviderModelDefaultEffort(
        providerState.provider,
        providerState.model,
      );
    const effortMetadata = findPlannerProviderEffort(
      providerState.provider,
      effort,
      providerState.model,
    );
    if (!effortMetadata)
      return c.json(
        {
          error: `Unsupported effort for ${providerState.provider.displayName}.`,
        },
        400,
      );
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
  },
);

plannerRoutes.delete(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const existing = await loaded.artifactStore.getReviewer(
      c.req.param("threadId"),
    );
    if (
      !existing ||
      existing.role !== "reviewer" ||
      existing.repoId !== loaded.repoId ||
      existing.planArtifactId !== loaded.plan.id
    ) {
      return c.json({ error: "Reviewer not found" }, 404);
    }
    if (existing.nodeKind === "report") {
      return c.json(
        {
          error:
            "Report conversations are archived with their skill root.",
        },
        409,
      );
    }
    try {
      if (existing.nodeKind === "skill_root") {
        const latestInvocation =
          await loaded.artifactStore.getLatestPlanSkillInvocationForParent(
            loaded.repoId,
            loaded.plan.id,
            existing.threadId,
          );
        const activeInvocation =
          latestInvocation?.status === "setting_up" ||
          latestInvocation?.status === "active"
            ? latestInvocation
            : null;
        if (activeInvocation) {
          const runs = await loaded.artifactStore.listPlanSkillInvocationRuns(
            activeInvocation.invocationId,
          );
          await loaded.artifactStore.cancelPlanSkillInvocation(
            activeInvocation.invocationId,
          );
          for (const run of runs) {
            if (run.runtime) {
              runInBackground(
                c,
                cleanupPlannerRunRuntime(c.env, loaded.artifactStore, run),
              );
            }
          }
        }
      } else {
        const activeRun = await loaded.artifactStore.getActiveRunForThread(
          loaded.repoId,
          loaded.plan.id,
          "reviewer",
          existing.threadId,
        );
        if (activeRun) {
          const cancelled = await loaded.artifactStore.cancelActivePlannerRun(
            activeRun.runId,
            { allowSaving: true },
          );
          if (cancelled.runtime) {
            runInBackground(
              c,
              cleanupPlannerRunRuntime(
                c.env,
                loaded.artifactStore,
                cancelled,
              ),
            );
          }
        }
      }
      const reviewer = await loaded.artifactStore.removeReviewer(
        loaded.repoId,
        loaded.plan.id,
        c.req.param("threadId"),
      );
      await broadcastPlanArtifactUpdatedHint(
        c.env,
        loaded.repoId,
        loaded.plan.id,
      );
      return c.json({ ok: true, reviewer });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Reviewer not found";
      return c.json(
        { error: message },
        /not found/i.test(message)
          ? 404
          : /active work/i.test(message)
            ? 409
            : 502,
      );
    }
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId/messages",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const reviewer = await loaded.artifactStore.getReviewer(
      c.req.param("threadId"),
    );
    if (!isActiveReviewerForPlan(reviewer, loaded)) {
      return c.json({ error: "Reviewer not found" }, 404);
    }
    const thread = getThreadStub(c.env, reviewer.threadId);
    const messages = insertPlanHealthVirtualMessage(
      await listAllThreadMessages(thread),
      await loaded.artifactStore.getPlanHealthVirtualMessage(reviewer.threadId),
    );
    const runAttributions: Record<
      string,
      {
        status: PlannerRun["status"];
        error?: string;
        provider: string;
        model: string;
        effort?: PlannerEffort;
        skillRunRole?: PlannerRun["skillRunRole"];
        command?: string;
        agentLabel?: string;
      }
    > = {};
    for (const runId of new Set(
      messages
        .map(readThreadMessageRunId)
        .filter((value): value is string => Boolean(value)),
    )) {
      const run = await loaded.artifactStore.getPlannerRun(runId);
      if (
        !run ||
        run.repoId !== loaded.repoId ||
        run.planArtifactId !== loaded.plan.id ||
        run.threadId !== reviewer.threadId
      )
        continue;
      const definition = run.input?.skillDefinitionSnapshot;
      const agent =
        definition?.agents.find(
          (candidate) => candidate.id === run.skillAgentId,
        ) ??
        (definition?.agents.length === 1 ? definition.agents[0] : undefined);
      runAttributions[run.runId] = {
        status: run.status,
        ...(run.error ? { error: run.error } : {}),
        provider: run.provider,
        model: run.model,
        ...(run.input?.effort ? { effort: run.input.effort } : {}),
        ...(run.skillRunRole ? { skillRunRole: run.skillRunRole } : {}),
        ...(definition?.command ? { command: definition.command } : {}),
        ...(agent?.label ? { agentLabel: agent.label } : {}),
      };
    }
    return c.json({ messages, runAttributions });
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:threadId/messages",
  async (c) => {
    const body = await readJsonBody(c);
    const removedBackendSelection = backendSelectionRemovedError(body);
    if (removedBackendSelection) return c.json(removedBackendSelection, 400);
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const reviewer = await loaded.artifactStore.getReviewer(
      c.req.param("threadId"),
    );
    if (!isActiveReviewerForPlan(reviewer, loaded)) {
      return c.json({ error: "Reviewer not found" }, 404);
    }
    const providerState = await requireAvailableProvider(
      c,
      reviewer.provider,
      reviewer.model,
      "reviewer",
    );
    if (!providerState.ok) return providerState.response;
    const text = readString(body.text);
    if (!text) return c.json({ error: "text is required" }, 400);
    const rootThreadId = reviewer.skillRootThreadId ?? reviewer.threadId;
    const linkedInvocation = reviewer.nodeKind !== "generic"
      ? await loaded.artifactStore.getLatestPlanSkillInvocationForParent(
          loaded.repoId,
          loaded.plan.id,
          rootThreadId,
        )
      : null;
    if (
      reviewer.nodeKind !== "generic" &&
      (!linkedInvocation ||
        linkedInvocation.repoId !== loaded.repoId ||
        linkedInvocation.planArtifactId !== loaded.plan.id)
    ) {
      return c.json({ error: "Linked skill invocation not found" }, 409);
    }
    if (
      linkedInvocation &&
      readString(body.expectedRoundId) !== linkedInvocation.invocationId
    ) {
      return c.json({ error: "The selected review round is stale." }, 409);
    }
    const linkedAgent =
      linkedInvocation?.definitionSnapshot.agents.find(
        (agent) => agent.id === reviewer.skillAgentId,
      ) ?? null;
    if (
      linkedInvocation &&
      reviewer.nodeKind === "skill_root" &&
      linkedInvocation.definitionSnapshot.agents.length > 1 &&
      !linkedInvocation.overviewRunId
    ) {
      return c.json(
        { error: "Create the Overview before following up with the skill root." },
        409,
      );
    }
    const started = await startReviewerRunForThread({
      c,
      loaded,
      threadId: reviewer.threadId,
      provider: reviewer.provider,
      model: reviewer.model,
      ...(linkedInvocation
        ? {
            skill: linkedInvocation.definitionSnapshot.command,
            skillSnapshot: {
              id: linkedInvocation.definitionSnapshot.id,
              command: linkedInvocation.definitionSnapshot.command,
              label: linkedInvocation.definitionSnapshot.label,
              instructions: composeReviewerInstructions(
                linkedInvocation.definitionSnapshot.sharedInstructions,
                linkedAgent?.instructions ??
                  linkedInvocation.definitionSnapshot.overviewInstructions,
              ),
            },
            skillDefinitionSnapshot: linkedInvocation.definitionSnapshot,
            basis: linkedInvocation.basis,
            skillInvocationId: linkedInvocation.invocationId,
            ...(reviewer.skillAgentId
              ? { skillAgentId: reviewer.skillAgentId }
              : {}),
            skillRunRole:
              reviewer.nodeKind === "report"
                ? ("report_followup" as const)
                : ("root_followup" as const),
          }
        : {}),
      effort:
        linkedAgent?.effort ??
        reviewer.effort ??
        providerState.provider.defaultEffort,
      userText: text,
    });
    if (!started.ok) return started.response;
    return c.json({
      ok: true,
      run: started.run,
      message: started.userMessage,
    });
  },
);

const SKILL_SETUP_TIMEOUT_MS = 130_000;

async function failStalePlanInvocations(
  c: any,
  loaded: LoadedPlanSuccess,
): Promise<void> {
  const failed = await loaded.artifactStore.failStalePlanSkillInvocations(
    loaded.repoId,
    loaded.plan.id,
    new Date(Date.now() - SKILL_SETUP_TIMEOUT_MS).toISOString(),
  );
  for (const invocation of failed) {
    const linkedRuns =
      await loaded.artifactStore.listPlanSkillInvocationRuns(
        invocation.invocationId,
      );
    for (const run of linkedRuns) {
      if (run.runtime) {
        runInBackground(
          c,
          cleanupPlannerRunRuntime(c.env, loaded.artifactStore, run),
        );
      }
    }
  }
  if (failed.length > 0) {
    await broadcastPlanArtifactUpdatedHint(
      c.env,
      loaded.repoId,
      loaded.plan.id,
    );
  }
}

function planInvocationResponse(
  invocation: Awaited<
    ReturnType<LoadedPlanSuccess["artifactStore"]["getPlanSkillInvocation"]>
  >,
  reviewers: ReviewerRegistryEntry[],
  runs: PlannerRun[],
) {
  if (!invocation) return { invocation, reviewers, runs };
  const order = new Map(
    invocation.definitionSnapshot.agents.map((agent, index) => [
      agent.id,
      index,
    ]),
  );
  return {
    invocation,
    reviewers: reviewers
      .slice()
      .sort(
        (left, right) =>
          (order.get(left.skillAgentId ?? "") ?? Number.MAX_SAFE_INTEGER) -
          (order.get(right.skillAgentId ?? "") ?? Number.MAX_SAFE_INTEGER),
      ),
    runs,
  };
}

async function validateSkillRoutesForInvocation(
  c: any,
  skill: AgentSkillDefinition,
  role: "writer" | "reviewer",
) {
  for (const definition of skill.agents) {
    const route = resolveAgentRoute(definition.routeKey);
    if (!route) {
      return {
        ok: false as const,
        response: c.json(
          { error: `Unknown agent route: ${definition.routeKey}` },
          400,
        ),
      };
    }
    if (!route.supportedEfforts.includes(definition.effort)) {
      return {
        ok: false as const,
        response: c.json(
          {
            error: `${route.label} does not support ${definition.effort} reasoning.`,
          },
          400,
        ),
      };
    }
  }
  const catalog = await listPlannerProviders(c.env);
  const result = resolveSkillAgentRoutes(skill, catalog.providers, role);
  return result.ok
    ? { ok: true as const, resolved: result.resolved }
    : {
        ok: false as const,
        response: c.json({ error: result.error }, result.status),
      };
}

async function setupAndDispatchPlanInvocation(
  c: any,
  loaded: LoadedPlanSuccess,
  invocationId: string,
): Promise<
  | {
      ok: true;
      invocation: NonNullable<
        Awaited<
          ReturnType<
            LoadedPlanSuccess["artifactStore"]["getPlanSkillInvocation"]
          >
        >
      >;
    }
  | { ok: false; response: Response }
> {
  try {
    const currentInvocation = await setupAndDispatchPlanSkillInvocation({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      invocationId,
      repo: plannerRepoRuntimeSource(loaded),
      schedule: (task) => runInBackground(c, task),
    });
    return { ok: true, invocation: currentInvocation };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      response: c.json(
        { error: message, code: "skill_setup_incomplete", retryable: true },
        502,
      ),
    };
  }
}

function launchProvenanceForExecution(
  execution: PlannerExecution,
): PlannerRunLaunchProvenance {
  if (execution.kind !== "dispatched")
    return { schemaVersion: 1, backend: "cf", machineId: null };
  const details = {
    schemaVersion: 1 as const,
    ...(execution.claudeAuthMode
      ? { claudeAuthMode: execution.claudeAuthMode }
      : {}),
    ...(execution.codexExecutionProfile
      ? { codexExecution: execution.codexExecutionProfile }
      : {}),
  };
  return execution.backend === "cf"
    ? { ...details, backend: "cf", machineId: null }
    : { ...details, backend: "host", machineId: execution.machineId };
}

async function invokePlanSkillRoot(
  c: any,
  loaded: LoadedPlanSuccess,
  skill: AgentSkillDefinition,
  requestId: string,
): Promise<Response> {
  const rootThreadId = `plan-skill-root:${requestId}`;
  let overviewRoute: {
    provider: string;
    model: string;
    effort: PlannerEffort;
  } | null = null;
  if (skill.agents.length > 1) {
    const owner = await resolvePlanWriterSelection(c, loaded, null, null);
    if (!owner.ok) return owner.response;
    const catalog = await listPlannerProviders(c.env);
    const provider = catalog.providers.find(
      (candidate) => candidate.id === owner.provider,
    );
    if (!provider?.capabilities.reviewer) {
      return c.json(
        { error: "The configured Scribe route cannot run a Plan Overview." },
        409,
      );
    }
    overviewRoute = owner;
  }
  const launched = await reserveAndDispatchPlanSkillInvocation({
    env: c.env,
    requestUrl: c.req.url,
    artifactStore: loaded.artifactStore,
    repoId: loaded.repoId,
    planArtifactId: loaded.plan.id,
    invocationId: requestId,
    parentThreadId: rootThreadId,
    skillId: skill.id,
    definitionSnapshot: skill,
    plan: loaded.plan as unknown as {
      id: string;
      title: string;
      body: unknown;
      version?: number;
    },
    repo: plannerRepoRuntimeSource(loaded),
    gitSourceAvailable: hasPlannerGitSource(loaded),
    overviewMode: skill.overviewMode,
    overviewRoute,
    schedule: (task) => runInBackground(c, task),
  });
  if (!launched.ok) {
    return c.json(
      {
        error: launched.error,
        ...(launched.code ? { code: launched.code, retryable: true } : {}),
      },
      launched.status,
    );
  }
  return c.json(
    {
      kind: "skill_root",
      ...planInvocationResponse(
        launched.invocation,
        launched.reviewers,
        launched.runs,
      ),
    },
    launched.reservationStatus === "created" ? 201 : 200,
  );
}

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/skills/:skillId/invoke",
  async (c) => {
    const body = await readJsonBody(c);
    const removedBackendSelection = backendSelectionRemovedError(body);
    if (removedBackendSelection) return c.json(removedBackendSelection, 400);
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const requestId = readString(body.requestId);
    if (!requestId || requestId.length > 256)
      return c.json({ error: "requestId is required" }, 400);
    const skillId = c.req.param("skillId");

    const resumed = await resumePlanSkillInvocation({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      invocationId: requestId,
      parentThreadId: `plan-skill-root:${requestId}`,
      skillId,
      repo: plannerRepoRuntimeSource(loaded),
      schedule: (task) => runInBackground(c, task),
    });
    if (resumed) {
      if (!resumed.ok) {
        return c.json(
          {
            error: resumed.error,
            ...(resumed.code ? { code: resumed.code, retryable: true } : {}),
          },
          resumed.status,
        );
      }
      return c.json({
        kind: "skill_root",
        ...planInvocationResponse(
          resumed.invocation,
          resumed.reviewers,
          resumed.runs,
        ),
      });
    }

    const skill = await resolveAgentSkill(
      loaded.artifactStore,
      loaded.repoId,
      "plan",
      skillId,
    );
    if (!skill) return c.json({ error: "Plan Skill not found" }, 404);
    return invokePlanSkillRoot(c, loaded, skill, requestId);
  },
);

async function loadScopedPlanInvocation(c: any, loaded: LoadedPlanSuccess) {
  const parentThreadId = c.req.param("parentThreadId");
  const invocation = await loaded.artifactStore.getPlanSkillInvocation(
    c.req.param("invocationId"),
  );
  const parent = await loaded.artifactStore.getReviewer(parentThreadId);
  if (
    !invocation ||
    !isPlanSkillHistoryParentForPlan(parent, loaded) ||
    invocation.repoId !== loaded.repoId ||
    invocation.planArtifactId !== loaded.plan.id ||
    invocation.parentThreadId !== parentThreadId
  )
    return null;
  return invocation;
}

async function reconcilePlanSkillInvocation(
  c: any,
  loaded: LoadedPlanSuccess,
  initial: NonNullable<
    Awaited<
      ReturnType<LoadedPlanSuccess["artifactStore"]["getPlanSkillInvocation"]>
    >
  >,
) {
  let invocation = initial;
  let linkedRuns = await loaded.artifactStore.listPlanSkillInvocationRuns(
    invocation.invocationId,
  );
  for (const run of linkedRuns) {
    if (isActiveRun(run) || run.runtime) {
      await failStaleActivePlannerRun(c, loaded.artifactStore, run);
    }
  }
  invocation =
    (await loaded.artifactStore.getPlanSkillInvocation(
      invocation.invocationId,
    )) ?? invocation;
  if (invocation.status === "setting_up" || invocation.status === "active") {
    const setup = await setupAndDispatchPlanInvocation(
      c,
      loaded,
      invocation.invocationId,
    );
    if (!setup.ok) return setup;
    invocation = setup.invocation;
  }
  linkedRuns = await loaded.artifactStore.listPlanSkillInvocationRuns(
    invocation.invocationId,
  );
  if (
    invocation.definitionSnapshot.agents.length > 1 &&
    invocation.status === "active" &&
    invocation.overviewMode === "auto" &&
    !invocation.overviewRunId
  ) {
    await assignPlanSkillOverview({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      invocationId: invocation.invocationId,
      repo: plannerRepoRuntimeSource(loaded),
      automatic: true,
      schedule: (task) => runInBackground(c, task),
    });
    invocation =
      (await loaded.artifactStore.getPlanSkillInvocation(
        invocation.invocationId,
      )) ?? invocation;
    linkedRuns = await loaded.artifactStore.listPlanSkillInvocationRuns(
      invocation.invocationId,
    );
  }
  if (invocation.status === "completed" && invocation.overviewMode === "auto") {
    await createPlanOverviewContribution({
      env: c.env,
      artifactStore: loaded.artifactStore,
      invocation,
    });
  }
  invocation =
    (await loaded.artifactStore.getPlanSkillInvocation(
      invocation.invocationId,
    )) ?? invocation;
  return {
    ok: true as const,
    invocation,
    reviewers: await loaded.artifactStore.listPlanSkillInvocationReviewers(
      invocation.invocationId,
    ),
    runs: linkedRuns,
  };
}

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    await failStalePlanInvocations(c, loaded);
    const parent = await loaded.artifactStore.getReviewer(
      c.req.param("parentThreadId"),
    );
    if (!isPlanSkillHistoryParentForPlan(parent, loaded)) {
      return c.json({ error: "Reviewer not found" }, 404);
    }
    const limitValue = Number(c.req.query("limit") ?? 20);
    const limit = Number.isInteger(limitValue)
      ? Math.max(1, Math.min(limitValue, 50))
      : 20;
    const rawCursor = c.req.query("cursor");
    const separator = rawCursor?.lastIndexOf("|") ?? -1;
    if (rawCursor && separator <= 0) {
      return c.json({ error: "Invalid invocation history cursor" }, 400);
    }
    const cursor = rawCursor
      ? {
          createdAt: rawCursor.slice(0, separator),
          invocationId: rawCursor.slice(separator + 1),
        }
      : null;
    if (
      cursor &&
      (!cursor.invocationId || Number.isNaN(Date.parse(cursor.createdAt)))
    ) {
      return c.json({ error: "Invalid invocation history cursor" }, 400);
    }
    const rows = await loaded.artifactStore.listPlanSkillInvocations({
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      parentThreadId: parent.threadId,
      limit: limit + 1,
      cursor,
    });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
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
      nextCursor:
        hasMore && last ? `${last.createdAt}|${last.invocationId}` : null,
    });
  },
);

plannerRoutes.put(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/:invocationId/controls",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const invocation = await loadScopedPlanInvocation(c, loaded);
    if (!invocation)
      return c.json({ error: "Skill round not found" }, 404);
    if (invocation.definitionSnapshot.agents.length < 2)
      return c.json({ error: "Single-agent skills do not have Overview controls." }, 409);
    const latest = await loaded.artifactStore.getLatestPlanSkillInvocationForParent(
      loaded.repoId,
      loaded.plan.id,
      invocation.parentThreadId,
    );
    const body = await readJsonBody(c);
    if (
      readString(body.expectedRoundId) !== invocation.invocationId ||
      latest?.invocationId !== invocation.invocationId
    ) {
      return c.json({ error: "The selected review round is stale." }, 409);
    }
    const overviewMode = body.overviewMode;
    if (overviewMode !== "auto" && overviewMode !== "manual")
      return c.json({ error: "overviewMode must be auto or manual" }, 400);
    const includedMessageIds = Array.isArray(body.includedMessageIds)
      ? [
          ...new Set(
            body.includedMessageIds
              .filter(
                (value): value is string =>
                  typeof value === "string" && Boolean(value.trim()),
              )
              .map((value) => value.trim()),
          ),
        ]
      : null;
    if (!includedMessageIds)
      return c.json({ error: "includedMessageIds must be an array" }, 400);
    try {
      await readIncludedPlanReports(
        c.env,
        loaded.artifactStore,
        invocation,
        includedMessageIds,
      );
      const updated = await loaded.artifactStore.updatePlanSkillInvocationControls({
        invocationId: invocation.invocationId,
        overviewMode,
        includedMessageIds,
      });
      if (!updated || updated.overviewRunId)
        return c.json({ error: "Overview inputs are already frozen." }, 409);
      if (overviewMode === "auto") {
        await assignPlanSkillOverview({
          env: c.env,
          requestUrl: c.req.url,
          artifactStore: loaded.artifactStore,
          invocationId: updated.invocationId,
          repo: plannerRepoRuntimeSource(loaded),
          automatic: true,
          schedule: (task) => runInBackground(c, task),
        });
      }
      return c.json(
        planInvocationResponse(
          await loaded.artifactStore.getPlanSkillInvocation(updated.invocationId),
          await loaded.artifactStore.listPlanSkillInvocationReviewers(updated.invocationId),
          await loaded.artifactStore.listPlanSkillInvocationRuns(updated.invocationId),
        ),
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/:invocationId/overview",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const invocation = await loadScopedPlanInvocation(c, loaded);
    if (!invocation)
      return c.json({ error: "Skill round not found" }, 404);
    const body = await readJsonBody(c);
    if (readString(body.expectedRoundId) !== invocation.invocationId)
      return c.json({ error: "The selected review round is stale." }, 409);
    try {
      await assignPlanSkillOverview({
        env: c.env,
        requestUrl: c.req.url,
        artifactStore: loaded.artifactStore,
        invocationId: invocation.invocationId,
        repo: plannerRepoRuntimeSource(loaded),
        guidance: readString(body.guidance),
        automatic: false,
        schedule: (task) => runInBackground(c, task),
      });
      return c.json(
        planInvocationResponse(
          await loaded.artifactStore.getPlanSkillInvocation(invocation.invocationId),
          await loaded.artifactStore.listPlanSkillInvocationReviewers(invocation.invocationId),
          await loaded.artifactStore.listPlanSkillInvocationRuns(invocation.invocationId),
        ),
      );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/:invocationId/share",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const invocation = await loadScopedPlanInvocation(c, loaded);
    if (!invocation)
      return c.json({ error: "Skill round not found" }, 404);
    const body = await readJsonBody(c);
    if (readString(body.expectedRoundId) !== invocation.invocationId)
      return c.json({ error: "The selected review round is stale." }, 409);
    try {
      await createPlanOverviewContribution({
        env: c.env,
        artifactStore: loaded.artifactStore,
        invocation,
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/latest",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    await failStalePlanInvocations(c, loaded);
    const parent = await loaded.artifactStore.getReviewer(
      c.req.param("parentThreadId"),
    );
    if (!isPlanSkillHistoryParentForPlan(parent, loaded)) {
      return c.json({ error: "Reviewer not found" }, 404);
    }
    const invocation = await loaded.artifactStore.getLatestPlanSkillInvocationForParent(
      loaded.repoId,
      loaded.plan.id,
      parent.threadId,
    );
    if (!invocation)
      return c.json({ invocation: null, reviewers: [], runs: [] });
    const reconciled = await reconcilePlanSkillInvocation(
      c,
      loaded,
      invocation,
    );
    if (!reconciled.ok) return reconciled.response;
    return c.json(
      planInvocationResponse(
        reconciled.invocation,
        reconciled.reviewers,
        reconciled.runs,
      ),
    );
  },
);

plannerRoutes.get(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/:invocationId",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    await failStalePlanInvocations(c, loaded);
    const invocation = await loadScopedPlanInvocation(c, loaded);
    if (!invocation) {
      return c.json({ error: "Skill invocation not found" }, 404);
    }
    const reconciled = await reconcilePlanSkillInvocation(
      c,
      loaded,
      invocation,
    );
    if (!reconciled.ok) return reconciled.response;
    return c.json(
      planInvocationResponse(
        reconciled.invocation,
        reconciled.reviewers,
        reconciled.runs,
      ),
    );
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/:invocationId/rerun",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const invocation = await loadScopedPlanInvocation(c, loaded);
    if (!invocation)
      return c.json({ error: "Skill invocation not found" }, 404);
    if (invocation.definitionSnapshot.id === BUILTIN_PLAN_HEALTH_SKILL_ID) {
      return c.json(
        {
          error:
            "Start a new /health assessment instead of rerunning an immutable result.",
        },
        409,
      );
    }
    const body = await readJsonBody(c);
    const requestId = readString(body.requestId);
    if (!requestId || requestId.length > 256)
      return c.json({ error: "requestId is required" }, 400);
    const expectedRoundId = readString(body.expectedRoundId);
    if (expectedRoundId !== invocation.invocationId) {
      return c.json({ error: "The selected review round is stale." }, 409);
    }
    const replay = await resumePlanSkillInvocationRerun({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      repoId: loaded.repoId,
      planArtifactId: loaded.plan.id,
      invocationId: invocation.invocationId,
      invocation,
      requestId,
      repo: plannerRepoRuntimeSource(loaded),
      schedule: (task) => runInBackground(c, task),
    });
    if (replay) {
      if (!replay.ok) {
        return c.json(
          {
            error: replay.error,
            ...(replay.code ? { code: replay.code, retryable: true } : {}),
          },
          replay.status,
        );
      }
      return c.json(
        planInvocationResponse(
          replay.invocation,
          replay.reviewers,
          replay.runs,
        ),
      );
    }
    const latest =
      await loaded.artifactStore.getLatestPlanSkillInvocationForParent(
        loaded.repoId,
        loaded.plan.id,
        invocation.parentThreadId,
      );
    if (latest?.invocationId !== invocation.invocationId)
      return c.json(
        { error: "Only the latest round can be re-reviewed." },
        409,
      );
    const routeValidation = await validateSkillRoutesForInvocation(
      c,
      invocation.definitionSnapshot,
      "reviewer",
    );
    if (!routeValidation.ok) return routeValidation.response;
    const executionTargets = await Promise.all(
      routeValidation.resolved.map(({ route }) =>
        resolvePlannerExecution(c.env, route.provider),
      ),
    );
    const unavailable = executionTargets.find(
      (execution) => execution.kind === "unavailable",
    );
    if (unavailable?.kind === "unavailable")
      return c.json({ error: unavailable.reason }, 409);
    if (
      executionTargets.some((execution) => execution.kind === "dispatched") &&
      !hasPlannerGitSource(loaded)
    ) {
      return plannerGitUnavailableResponse(c);
    }
    let overviewRoute: {
      provider: string;
      model: string;
      effort: PlannerEffort;
    } | null = null;
    if (invocation.definitionSnapshot.agents.length > 1) {
      const owner = await resolvePlanWriterSelection(c, loaded, null, null);
      if (!owner.ok) return owner.response;
      const catalog = await listPlannerProviders(c.env);
      const provider = catalog.providers.find(
        (candidate) => candidate.id === owner.provider,
      );
      if (!provider?.capabilities.reviewer) {
        return c.json(
          { error: "The configured Scribe route cannot run a Plan Overview." },
          409,
        );
      }
      overviewRoute = owner;
    }
    try {
      await loaded.artifactStore.reservePlanSkillInvocationRerun({
        invocationId: invocation.invocationId,
        requestId,
        repoId: loaded.repoId,
        planArtifactId: loaded.plan.id,
        expectedPlanVersion: (loaded.plan as { version?: number }).version ?? 1,
        basis: plannerRunBasis(loaded),
        overviewRoute,
        agents: routeValidation.resolved.map(
          ({ definition, route }, index) => ({
            id: definition.id,
            provider: route.provider,
            model: route.model,
            launchProvenance: launchProvenanceForExecution(
              executionTargets[index]!,
            ),
          }),
        ),
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "The Plan Skill rerun could not be reserved.",
        },
        409,
      );
    }
    const current = await loaded.artifactStore.getPlanSkillInvocation(requestId);
    if (current?.status === "setting_up" || current?.status === "active") {
      const setup = await setupAndDispatchPlanInvocation(
        c,
        loaded,
        requestId,
      );
      if (!setup.ok) return setup.response;
    }
    return c.json(
      planInvocationResponse(
        await loaded.artifactStore.getPlanSkillInvocation(
          requestId,
        ),
        await loaded.artifactStore.listPlanSkillInvocationReviewers(
          requestId,
        ),
        await loaded.artifactStore.listPlanSkillInvocationRuns(
          requestId,
        ),
      ),
    );
  },
);

plannerRoutes.post(
  "/api/repos/:repoId/plans/:planArtifactId/reviewers/:parentThreadId/skill-invocations/:invocationId/cancel",
  async (c) => {
    const loaded = await loadPlanContext(c);
    if (!loaded.ok) return loaded.response;
    const invocation = await loadScopedPlanInvocation(c, loaded);
    if (!invocation)
      return c.json({ error: "Skill invocation not found" }, 404);
    const runs = await loaded.artifactStore.listPlanSkillInvocationRuns(
      invocation.invocationId,
    );
    const cancelled = await loaded.artifactStore.cancelPlanSkillInvocation(
      invocation.invocationId,
    );
    for (const run of runs) {
      if (run.runtime && isActiveRun(run))
        runInBackground(
          c,
          cleanupPlannerRunRuntime(c.env, loaded.artifactStore, run),
        );
    }
    await broadcastPlanArtifactUpdatedHint(
      c.env,
      loaded.repoId,
      loaded.plan.id,
    );
    return c.json({ ok: true, invocation: cancelled });
  },
);

export default plannerRoutes;
