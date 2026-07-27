import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getArtifactStoreStub, getLocationHintOptions, getThreadStub } from "../helpers";
import { renderArtifactBodyMarkdown, type PlannerRun } from "../coordination";
import {
  isCurrentLaunchProvenance,
  isCurrentPlannerRuntimeProvenance,
  isCurrentPlanWriterRuntimeProvenance,
} from "../coordination/execution-provenance";
import { appendThreadMessage, isActiveRun } from "./runtime";
import {
  verifyPlanWriterRuntimeToken,
  verifyPlannerRunToken,
} from "./runtime-token";
import { windowThreadMessages } from "./context-window";
import {
  cleanupPlannerRunRuntime,
  cleanupPlanWriterRuntime,
  plannerJobSlug,
} from "./dispatch";
import { effectivePlanWritingInstructions } from "./writer-instructions";
import {
  normalizeCanonicalPlanForDigest,
  normalizeObservedPlanPublication,
  normalizePlanWriterIdentifier,
  planWriterTerminalId,
  sha256Hex,
} from "./plan-writer-contract";
import { mergeStoredAgentSkills, resolveAgentRoute } from "./agent-skills";
import {
  claudePlanSkillProjectionRevision,
  validateClaudePlanSkillProjection,
} from "./claude-plan-skill-projection";
import {
  codexRuntimeAuthAccountChangedResponse,
  codexRuntimeAuthExchangeErrorResponse,
  codexRuntimeAuthInactiveResponse,
  codexRuntimeAuthSuccessResponse,
  exchangeCodexRuntimeAuth,
  parseCodexRuntimeAuthRequest,
} from "../codex-runtime-auth";
import { parseReviewerRuntimeEventBatch } from "../reviewer-runtime-events";
import { loadTrackedRepo } from "../repo/access";

// Callback surface for one-shot reviewer containers and Plan Writer supervisors. Every route requires the
// run-scoped HMAC token: edge auth (CF Access service token or browser JWT)
// is never sufficient on its own — /context returns plan and thread content,
// and /result mutates durable state.
const RUN_TOKEN_HEADER = "X-Tiller-Planner-Run-Token";
const PLAN_WRITER_TOKEN_HEADER = "X-Tiller-Plan-Writer-Token";

const MAX_EVENT_MESSAGE_CHARS = 2_000;

const plannerRuntimeRoutes = new Hono<HonoEnv>();

type LoadedRun = {
  artifactStore: ReturnType<typeof getArtifactStoreStub>;
  run: PlannerRun;
};

async function loadAuthorizedPlanWriter(c: any, runtimeAuth = false) {
  const repoId = c.req.param("repoId");
  const planArtifactId = c.req.param("planArtifactId");
  const generation = Number(c.req.param("generation"));
  if (!Number.isInteger(generation) || generation < 1) {
    return { ok: false as const, response: c.json({ error: "Invalid writer generation" }, 400) };
  }
  if (!(await verifyPlanWriterRuntimeToken(
    c.env,
    repoId,
    planArtifactId,
    generation,
    c.req.header(PLAN_WRITER_TOKEN_HEADER),
  ))) {
    return { ok: false as const, response: c.json({ error: "Unauthorized" }, 401) };
  }
  const loadedRepo = await loadTrackedRepo(c.env, repoId);
  if (!loadedRepo.ok) {
    if (runtimeAuth) {
      return {
        ok: false as const,
        response: c.json({ error: "Codex runtime is no longer active.", code: "runtime_inactive" }, 409),
      };
    }
    return { ok: false as const, response: c.json({ error: "Writer generation not found" }, 404) };
  }
  const artifactStore = getArtifactStoreStub(
    c.env,
    repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  );
  const writer = await artifactStore.getPlanWriter(repoId, planArtifactId);
  const terminalId = planWriterTerminalId(repoId, planArtifactId, generation);
  if (
    !writer
    || writer.generation !== generation
    || !isCurrentLaunchProvenance(writer.launchProvenance)
    || !isCurrentPlanWriterRuntimeProvenance(writer.runtime)
    || writer.runtime.generation !== generation
    || writer.runtime.jobSlug !== terminalId
  ) {
    if (runtimeAuth) {
      return {
        ok: false as const,
        response: c.json({ error: "Codex runtime is no longer active.", code: "runtime_inactive" }, 409),
      };
    }
    return { ok: false as const, response: c.json({ error: "Writer generation not found" }, 404) };
  }
  return { ok: true as const, repoId, planArtifactId, generation, artifactStore, writer };
}

async function broadcastPlanWriterHints(c: any, repoId: string, planArtifactId: string, artifactUpdated: boolean) {
  try {
    const hubId = c.env.HUB.idFromName("hub");
    const hub = c.env.HUB.get(hubId, getLocationHintOptions(c.env)) as unknown as {
      broadcastPlanWriterState(repoId: string, planArtifactId: string): void | Promise<void>;
      broadcastPlanArtifactUpdated(repoId: string, planArtifactId: string): void | Promise<void>;
    };
    await hub.broadcastPlanWriterState(repoId, planArtifactId);
    if (artifactUpdated) await hub.broadcastPlanArtifactUpdated(repoId, planArtifactId);
  } catch {
    // WebSocket notifications are convergence hints, never transaction inputs.
  }
}

// Containers are destroyed after terminal results — including success. The
// machine runner has no --rm, so skipping this accumulates exited
// containers. Asynchronous: the result is acknowledged first.
function scheduleJobCleanup(
  c: any,
  artifactStore: LoadedRun["artifactStore"],
  run: PlannerRun,
): void {
  if (!run.runtime) return;
  const cleanup = cleanupPlannerRunRuntime(c.env, artifactStore, run).catch((error: unknown) => {
    console.error(`[planner] job cleanup failed for run ${run.runId}:`, error);
  });
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(cleanup);
    return;
  }
  void cleanup;
}

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}…` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(c: any): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

async function loadAuthorizedRun(
  c: any,
  runtimeAuth = false,
): Promise<{ ok: true } & LoadedRun | { ok: false; response: Response }> {
  const repoId = c.req.param("repoId");
  const runId = c.req.param("runId");
  if (!(await verifyPlannerRunToken(c.env, runId, c.req.header(RUN_TOKEN_HEADER)))) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }
  const loadedRepo = await loadTrackedRepo(c.env, repoId);
  if (!loadedRepo.ok) {
    if (runtimeAuth) {
      return {
        ok: false,
        response: c.json({ error: "Codex runtime is no longer active.", code: "runtime_inactive" }, 409),
      };
    }
    return { ok: false, response: c.json({ error: "Reviewer run not found" }, 404) };
  }
  const artifactStore = getArtifactStoreStub(
    c.env,
    repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  );
  const run = await artifactStore.getPlannerRun(runId);
  if (
    !run
    || run.repoId !== repoId
    || run.role !== "reviewer"
    || !isCurrentLaunchProvenance(run.launchProvenance)
    || !isCurrentPlannerRuntimeProvenance(run.runtime)
    || run.runtime.jobSlug !== plannerJobSlug(runId)
  ) {
    if (runtimeAuth) {
      return {
        ok: false,
        response: c.json({ error: "Codex runtime is no longer active.", code: "runtime_inactive" }, 409),
      };
    }
    return { ok: false, response: c.json({ error: "Reviewer run not found" }, 404) };
  }
  return { ok: true, artifactStore, run };
}

async function syncReviewerState(
  artifactStore: LoadedRun["artifactStore"],
  run: PlannerRun,
  status: PlannerRun["status"],
  error: string | null,
): Promise<void> {
  if (!run.threadId) return;
  try {
    await artifactStore.updateReviewerRunStateIfCurrent({
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
        threadId: run.threadId,
        runId: run.runId,
        status,
        error,
      });
  } catch {
    // The run outcome stands even if the reviewer tab was removed.
  }
}

function isActiveSubscriptionWriter(loaded: Extract<Awaited<ReturnType<typeof loadAuthorizedPlanWriter>>, { ok: true }>): boolean {
  const profile = loaded.writer.launchProvenance?.codexExecution;
  return loaded.writer.provider === "codex"
    && !loaded.writer.stoppedAt
    && Boolean(loaded.writer.runtime)
    && profile?.kind === "subscription-app-server"
    && profile.surface === "plan-writer";
}

function isActiveSubscriptionReviewer(loaded: Extract<Awaited<ReturnType<typeof loadAuthorizedRun>>, { ok: true }>): boolean {
  const profile = loaded.run.launchProvenance?.codexExecution;
  return loaded.run.provider === "codex"
    && isActiveRun(loaded.run)
    && Boolean(loaded.run.runtime)
    && profile?.kind === "subscription-app-server"
    && profile.surface === "plan-reviewer";
}

async function runtimeAuthResponse(
  c: any,
  rejectedAccessTokenSha256: string | undefined,
  acceptAccount: (accountId: string) => Promise<"accepted" | "inactive" | "account_changed">,
): Promise<Response> {
  const result = await exchangeCodexRuntimeAuth(c.env, rejectedAccessTokenSha256);
  if (!result.ok) return codexRuntimeAuthExchangeErrorResponse(result);
  const acceptance = await acceptAccount(result.account_id);
  if (acceptance === "inactive") return codexRuntimeAuthInactiveResponse();
  if (acceptance === "account_changed") return codexRuntimeAuthAccountChangedResponse();
  return codexRuntimeAuthSuccessResponse(result);
}

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/runtime-auth",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c, true);
    if (!loaded.ok) return loaded.response;
    if (!isActiveSubscriptionWriter(loaded)) return codexRuntimeAuthInactiveResponse();
    const request = await parseCodexRuntimeAuthRequest(c.req.raw);
    if (!request.ok) return request.response;
    return runtimeAuthResponse(c, request.rejectedAccessTokenSha256, async (accountId) =>
      loaded.artifactStore.acceptPlanWriterCodexRuntimeAuth({
        repoId: loaded.repoId,
        planArtifactId: loaded.planArtifactId,
        generation: loaded.generation,
        accountId,
      }));
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/runs/:runId/runtime-auth",
  async (c) => {
    const loaded = await loadAuthorizedRun(c, true);
    if (!loaded.ok) return loaded.response;
    if (!isActiveSubscriptionReviewer(loaded)) return codexRuntimeAuthInactiveResponse();
    const request = await parseCodexRuntimeAuthRequest(c.req.raw);
    if (!request.ok) return request.response;
    return runtimeAuthResponse(c, request.rejectedAccessTokenSha256, async (accountId) =>
      loaded.artifactStore.acceptPlannerRunCodexRuntimeAuth(loaded.run.runId, accountId));
  },
);

plannerRuntimeRoutes.get(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/context",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    const plan = await loaded.artifactStore.getArtifact(loaded.planArtifactId);
    if (!plan || plan.repoId !== loaded.repoId || plan.type !== "plan") {
      return c.json({ error: "Plan artifact not found" }, 404);
    }
    const markdown = normalizeCanonicalPlanForDigest(renderArtifactBodyMarkdown(plan.body));
    const digest = await sha256Hex(markdown);
    const defaultRoute = resolveAgentRoute("codex:gpt-5.5");
    const settings = await loaded.artifactStore.getRepoPlanWriterSettings(loaded.repoId, {
      routeKey: "codex:gpt-5.5",
      effort: defaultRoute?.defaultEffort ?? "high",
      planFormat: effectivePlanWritingInstructions(null),
    });
    const skills = loaded.writer.provider === "claude-code"
      ? validateClaudePlanSkillProjection(mergeStoredAgentSkills(
        "plan",
        await loaded.artifactStore.listStoredAgentSkills(loaded.repoId, "plan"),
      ))
      : [];
    return c.json({
      writer: {
        repoId: loaded.repoId,
        planArtifactId: loaded.planArtifactId,
        generation: loaded.generation,
        provider: loaded.writer.provider,
        model: loaded.writer.model,
        effort: loaded.writer.effort,
        fastMode: loaded.writer.fastMode === true,
        basisCommit: loaded.writer.basisCommit,
        terminalId: planWriterTerminalId(loaded.repoId, loaded.planArtifactId, loaded.generation),
        publicationCursor: loaded.writer.publicationCursor ?? null,
      },
      plan: {
        title: plan.title,
        status: plan.status ?? "draft",
        markdown,
        digest,
      },
      planFormat: settings.planFormat,
      skills,
      skillRevision: await claudePlanSkillProjectionRevision(skills),
      instructions: [
        "You are the planning-only writer for this Tiller plan.",
        "Discussion, questions, and incomplete output do not revise the canonical artifact.",
        "Whenever the user creates, revises, or iterates on the plan, emit the complete replacement plan; every completed plan revision is published to the canonical artifact.",
        "Treat requests to write or update the plan as artifact revisions, never as requests to modify files in the read-only checkout.",
        "Do not leave the provider's managed Plan Mode or replace this owned conversation.",
      ],
    });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/register",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    let providerConversationId: string;
    try {
      providerConversationId = normalizePlanWriterIdentifier(
        typeof body.providerConversationId === "string" ? body.providerConversationId : "",
        "providerConversationId",
      );
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid providerConversationId" }, 400);
    }
    if (loaded.writer.stoppedAt || !loaded.writer.runtime) {
      return c.json({ error: "Writer generation is no longer active" }, 409);
    }
    const registered = await loaded.artifactStore.registerPlanWriterRuntime({
      repoId: loaded.repoId,
      planArtifactId: loaded.planArtifactId,
      generation: loaded.generation,
      runtime: loaded.writer.runtime,
      providerConversationId,
    });
    if (!registered) return c.json({ error: "Writer generation changed during registration" }, 409);
    await broadcastPlanWriterHints(c, loaded.repoId, loaded.planArtifactId, false);
    return c.json({
      ok: true,
      terminalId: planWriterTerminalId(loaded.repoId, loaded.planArtifactId, loaded.generation),
    });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/publications",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    let publication;
    try {
      publication = await normalizeObservedPlanPublication({
        repoId: loaded.repoId,
        planArtifactId: loaded.planArtifactId,
        generation: loaded.generation,
        providerConversationId: typeof body.providerConversationId === "string" ? body.providerConversationId : "",
        sequence: typeof body.sequence === "number" ? body.sequence : Number.NaN,
        providerEventId: typeof body.providerEventId === "string" ? body.providerEventId : "",
        markdown: typeof body.markdown === "string" ? body.markdown : "",
        bodyDigest: typeof body.bodyDigest === "string" ? body.bodyDigest : "",
      });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : "Invalid plan publication" }, 400);
    }
    const result = await loaded.artifactStore.publishObservedPlan(publication);
    if (result.status === "rejected") {
      return c.json({ error: result.reason, ...result }, 409);
    }
    await broadcastPlanWriterHints(
      c,
      loaded.repoId,
      loaded.planArtifactId,
      result.cursor.result === "updated",
    );
    return c.json({ ok: true, ...result });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/synchronization",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const error = typeof body.error === "string" && body.error.trim() ? truncate(body.error.trim(), MAX_EVENT_MESSAGE_CHARS) : null;
    await loaded.artifactStore.setPlanWriterError({
      repoId: loaded.repoId,
      planArtifactId: loaded.planArtifactId,
      generation: loaded.generation,
      kind: "synchronization",
      error,
    });
    await broadcastPlanWriterHints(c, loaded.repoId, loaded.planArtifactId, false);
    return c.json({ ok: true });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/stop",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const reason = body.reason;
    if (reason !== "idle" && reason !== "runtime_ended" && reason !== "mode_invalidated" && reason !== "watchdog") {
      return c.json({ error: "Unsupported runtime stop reason" }, 400);
    }
    const startupError = reason === "runtime_ended" && typeof body.startupError === "string" && body.startupError.trim()
      ? truncate(body.startupError.trim(), MAX_EVENT_MESSAGE_CHARS)
      : null;
    const fenced = await loaded.artifactStore.fencePlanWriterStop({
      repoId: loaded.repoId,
      planArtifactId: loaded.planArtifactId,
      expectedGeneration: loaded.generation,
      reason,
    });
    if (fenced.status === "stale") return c.json({ error: "Writer generation changed" }, 409);
    if (startupError) {
      await loaded.artifactStore.setPlanWriterError({
        repoId: loaded.repoId,
        planArtifactId: loaded.planArtifactId,
        generation: loaded.generation,
        kind: "startup",
        error: startupError,
      });
    }
    const terminalId = planWriterTerminalId(loaded.repoId, loaded.planArtifactId, loaded.generation);
    try {
      const hubId = c.env.HUB.idFromName("hub");
      const hub = c.env.HUB.get(hubId, getLocationHintOptions(c.env)) as unknown as {
        revokePlanWriterTerminal(id: string, repoId: string, planArtifactId: string, generation: number): void | Promise<void>;
      };
      await hub.revokePlanWriterTerminal(terminalId, loaded.repoId, loaded.planArtifactId, loaded.generation);
    } catch {
      // The PTY may not have registered before a startup cancellation.
    }
    const cleanup = async () => {
      if (!fenced.writer?.runtime && !fenced.writer?.jobSlug) return;
      try {
        await cleanupPlanWriterRuntime(c.env, loaded.artifactStore, fenced.writer);
      } catch (error) {
        await loaded.artifactStore.setPlanWriterError({
          repoId: loaded.repoId,
          planArtifactId: loaded.planArtifactId,
          generation: loaded.generation,
          kind: "cleanup",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    if (c.executionCtx?.waitUntil) c.executionCtx.waitUntil(cleanup());
    else void cleanup();
    await broadcastPlanWriterHints(c, loaded.repoId, loaded.planArtifactId, false);
    return c.json({ ok: true });
  },
);

plannerRuntimeRoutes.get("/api/planner-runtime/repos/:repoId/runs/:runId/context", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const { artifactStore, run } = loaded;
  const plan = await artifactStore.getArtifact(run.planArtifactId);
  if (!plan || plan.type !== "plan") {
    return c.json({ error: "Plan artifact not found" }, 404);
  }
  const skillInstructions = run.input?.skillSnapshot?.instructions ?? "";
  const basis = run.input?.basis;
  let threadMessages: unknown[] = [];
  let threadMessagesTruncated = false;
  if (run.threadId) {
    const thread = getThreadStub(c.env, run.threadId);
    const chronological = (await thread.listMessages({ limit: 200 })).slice().reverse();
    const windowed = windowThreadMessages(chronological);
    threadMessages = windowed.messages;
    threadMessagesTruncated = windowed.truncated;
  }
  return c.json({
    run: {
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      role: run.role,
      provider: run.provider,
      model: run.model,
      ...(run.skill ? { skill: run.skill } : {}),
      status: run.status,
    },
    input: run.input ?? {},
    plan: {
      id: plan.id,
      title: basis?.title ?? plan.title,
      version: basis?.version ?? plan.version ?? 1,
      markdown: basis?.markdown ?? renderArtifactBodyMarkdown(plan.body),
    },
    skillInstructions,
    threadMessages,
    threadMessagesTruncated,
  });
});

plannerRuntimeRoutes.post("/api/planner-runtime/repos/:repoId/runs/:runId/events", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const { artifactStore, run } = loaded;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseReviewerRuntimeEventBatch(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { events } = parsed;
  // An empty batch is a pure status poll — the harness uses it to notice
  // cancellation while the CLI child is still running.
  if (!isActiveRun(run)) {
    return c.json({ ok: true, ignored: true, runStatus: run.status });
  }
  // Valid event calls — including the empty 15s status poll — prove the
  // current container is alive; rejected payloads do not refresh liveness.
  await artifactStore.recordPlannerRunContact(run.runId);
  let current = run;
  for (const event of events) {
    if (event.type === "runtime_startup") {
      if (current.status === "queued") {
        current = await artifactStore.updateActivePlannerRun({ runId: run.runId, status: "running" });
        await syncReviewerState(artifactStore, current, "running", null);
      }
      await artifactStore.appendPlannerRunEvent({
        runId: run.runId,
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        type: "runtime_startup",
        message: event.message,
      });
      continue;
    }
    await artifactStore.appendPlannerRunEvent({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      type: "model_activity",
      message: event.message,
    });
  }
  return c.json({ ok: true, runStatus: current.status });
});

plannerRuntimeRoutes.post("/api/planner-runtime/repos/:repoId/runs/:runId/result", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const { artifactStore, run } = loaded;
  // Idempotency: duplicate, late, or post-cancellation results are harmless.
  if (!isActiveRun(run)) {
    scheduleJobCleanup(c, artifactStore, run);
    return c.json({ ok: true, ignored: true, runStatus: run.status });
  }
  const body = await readJsonBody(c);

  if (body.status !== "succeeded") {
    const error = typeof body.error === "string" && body.error.trim()
      ? truncate(body.error.trim(), MAX_EVENT_MESSAGE_CHARS)
      : "Planner runtime reported a failure.";
    await artifactStore.appendPlannerRunEvent({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      type: "run_failed",
      message: error,
    });
    const failed = await artifactStore.updateActivePlannerRun({
      runId: run.runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error,
    });
    if (failed.status === "failed") {
      await syncReviewerState(artifactStore, failed, "failed", error);
    }
    scheduleJobCleanup(c, artifactStore, failed);
    return c.json({ ok: true, runStatus: failed.status });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text || !run.threadId) {
    const error = !text ? "Reviewer returned no feedback text." : "Reviewer run has no thread.";
    await artifactStore.appendPlannerRunEvent({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      type: "run_failed",
      message: error,
    });
    const failed = await artifactStore.updateActivePlannerRun({
      runId: run.runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error,
    });
    if (failed.status === "failed") {
      await syncReviewerState(artifactStore, failed, "failed", error);
    }
    scheduleJobCleanup(c, artifactStore, failed);
    return c.json({ ok: true, runStatus: failed.status });
  }
  const saving = await artifactStore.claimPlannerRunSaving(run.runId);
  if (!saving) {
    const latest = await artifactStore.getPlannerRun(run.runId);
    if (latest) scheduleJobCleanup(c, artifactStore, latest);
    return c.json({ ok: true, ignored: true, runStatus: latest?.status ?? run.status });
  }
  const thread = getThreadStub(c.env, run.threadId);
  await appendThreadMessage(thread, "assistant", text, [run.planArtifactId], {
    id: `reviewer-result:${run.runId}`,
    runId: run.runId,
    planVersion: run.input?.sourcePlanVersion,
  });
  await artifactStore.appendPlannerRunEvent({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    type: "contribution_candidate",
    message: "Reviewer feedback is ready to send to the writer.",
    data: { text },
  });
  await artifactStore.appendPlannerRunEvent({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    type: "run_completed",
    message: "Reviewer run completed.",
  });
  const completed = await artifactStore.updateActivePlannerRun({
    runId: run.runId,
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  if (completed.status === "completed") {
    await syncReviewerState(artifactStore, completed, "completed", null);
  }
  scheduleJobCleanup(c, artifactStore, completed);
  return c.json({ ok: true, runStatus: completed.status });
});

export default plannerRuntimeRoutes;
