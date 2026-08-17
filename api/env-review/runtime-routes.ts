import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { specializedServiceAuthMiddleware } from "../auth";
import { getEnvReviewStub, getThreadStub } from "../helpers";
import { appendThreadMessage } from "../planner/runtime";
import { verifyEnvReviewRunToken } from "./runtime-token";
import { cleanupEnvReviewRunRuntime, envReviewJobSlug } from "./dispatch";
import type { EnvReviewRun } from "./types";
import {
  buildReviewInspectionKey,
  ENV_REVIEW_INSPECTION_CONTENT_TYPE,
  ENV_REVIEW_SNAPSHOT_CONTENT_TYPE,
} from "./snapshots";
import { assignSkillOverview, finalizeSuccessfulReviewOutput } from "./skill-orchestration";
import {
  codexRuntimeAuthAccountChangedResponse,
  codexRuntimeAuthExchangeErrorResponse,
  codexRuntimeAuthInactiveResponse,
  codexRuntimeAuthSuccessResponse,
  exchangeCodexRuntimeAuth,
  parseCodexRuntimeAuthRequest,
} from "../codex-runtime-auth";
import { parseReviewerRuntimeEventBatch } from "../reviewer-runtime-events";
import {
  isCurrentLaunchProvenance,
  isCurrentPlannerRuntimeProvenance,
} from "../coordination/execution-provenance";

const RUN_TOKEN_HEADER = "X-Tiller-Env-Review-Run-Token";
const MAX_EVENT_MESSAGE_CHARS = 2_000;

const envReviewRuntimeRoutes = new Hono<HonoEnv>();

envReviewRuntimeRoutes.use(
  "/api/env-review-runtime/*",
  specializedServiceAuthMiddleware,
);

function truncate(value: string, maxChars: number): string {
  return value.length > maxChars ? `${value.slice(0, maxChars)}...` : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function readJsonBody(c: any): Promise<Record<string, unknown>> {
  const body = await c.req.json().catch(() => ({}));
  return isRecord(body) ? body : {};
}

function isActiveRun(run: EnvReviewRun): boolean {
  return run.status === "preparing" || run.status === "queued" || run.status === "running";
}

function isActiveSubscriptionRun(run: EnvReviewRun): boolean {
  const profile = run.launchProvenance?.codexExecution;
  return run.provider === "codex"
    && isActiveRun(run)
    && Boolean(run.runtime)
    && profile?.kind === "subscription-app-server"
    && profile.surface === "environment-reviewer";
}

async function loadAuthorizedRun(
  c: any,
  runtimeAuth = false,
): Promise<{ ok: true; run: EnvReviewRun } | { ok: false; response: Response }> {
  const envSlug = c.req.param("slug");
  const runId = c.req.param("runId");
  if (!(await verifyEnvReviewRunToken(c.env, envSlug, runId, c.req.header(RUN_TOKEN_HEADER)))) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }
  const review = getEnvReviewStub(c.env, envSlug);
  const run = await review.getRun(runId);
  if (
    !run
    || run.envSlug !== envSlug
    || !isCurrentLaunchProvenance(run.launchProvenance)
    || !isCurrentPlannerRuntimeProvenance(run.runtime)
    || run.runtime.jobSlug !== envReviewJobSlug(runId)
  ) {
    if (runtimeAuth) {
      return {
        ok: false,
        response: c.json({ error: "Codex runtime is no longer active.", code: "runtime_inactive" }, 409),
      };
    }
    return { ok: false, response: c.json({ error: "Env review run not found" }, 404) };
  }
  return { ok: true, run };
}

function scheduleJobCleanup(
  c: any,
  review: ReturnType<typeof getEnvReviewStub>,
  run: EnvReviewRun,
): void {
  if (!run.runtime) return;
  const task = cleanupEnvReviewRunRuntime(c.env, review, run).catch((error: unknown) => {
    console.error(`[env-review] job cleanup failed for run ${run.runId}:`, error);
  });
  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(task);
    return;
  }
  void task;
}

envReviewRuntimeRoutes.post("/api/env-review-runtime/envs/:slug/runs/:runId/runtime-auth", async (c) => {
  const loaded = await loadAuthorizedRun(c, true);
  if (!loaded.ok) return loaded.response;
  if (!isActiveSubscriptionRun(loaded.run)) {
    return codexRuntimeAuthInactiveResponse();
  }
  const request = await parseCodexRuntimeAuthRequest(c.req.raw);
  if (!request.ok) return request.response;
  const result = await exchangeCodexRuntimeAuth(c.env, request.rejectedAccessTokenSha256);
  if (!result.ok) return codexRuntimeAuthExchangeErrorResponse(result);
  const review = getEnvReviewStub(c.env, loaded.run.envSlug);
  const acceptance = await review.acceptCodexRuntimeAuth(loaded.run.runId, result.account_id);
  if (acceptance === "inactive") return codexRuntimeAuthInactiveResponse();
  if (acceptance === "account_changed") return codexRuntimeAuthAccountChangedResponse();
  return codexRuntimeAuthSuccessResponse(result);
});

async function maybeAssignAutomaticOverview(c: any, run: EnvReviewRun): Promise<void> {
  if (
    !run.skillInvocationId
    || (run.skillRunRole !== "report_initial" && run.skillRunRole !== "report_followup")
  ) return;
  const review = getEnvReviewStub(c.env, run.envSlug);
  try {
    await assignSkillOverview({
      env: c.env,
      review,
      invocationId: run.skillInvocationId,
      automatic: true,
    });
  } catch (error) {
    console.error(`[env-review] automatic Overview check failed for ${run.skillInvocationId}:`, error);
  }
}

envReviewRuntimeRoutes.get("/api/env-review-runtime/envs/:slug/runs/:runId/context", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const { run } = loaded;
  if (!run.prompt) {
    return c.json({ error: "Env review prompt is not ready" }, 409);
  }
  const preparation = run.preparation;
  if (!preparation?.snapshot) {
    return c.json({ error: "Reviewer needs a fresh snapshot. Start a fresh reviewer run." }, 409);
  }
  return c.json({
    run: {
      runId: run.runId,
      envSlug: run.envSlug,
      repoId: run.repoId,
      threadId: run.threadId,
      provider: run.provider,
      model: run.model,
      effort: run.effort,
      roleLabel: run.roleLabel,
      status: run.status,
      // Overview is a synthesis pass over frozen child reports. Its prompt
      // explicitly forbids re-reviewing the workspace, unlike every leaf run.
      requiresRepositoryInspection: run.skillRunRole !== "overview",
    },
    prompt: run.prompt,
    preparation,
    changeContext: run.changeContext,
    planBasis: run.planBasis,
    workspace: {
      githubDeletedPaths: preparation.snapshot.githubDeletedPaths,
      snapshot: preparation.snapshot,
    },
  });
});

envReviewRuntimeRoutes.get("/api/env-review-runtime/envs/:slug/runs/:runId/workspace.tar", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const snapshot = loaded.run.preparation?.snapshot ?? null;
  if (!snapshot) {
    return c.json({ error: "Reviewer needs a fresh snapshot. Start a fresh reviewer run." }, 409);
  }
  const object = await c.env.BUCKET.get(snapshot.r2Key);
  if (!object?.body) {
    return c.json({ error: "Reviewer snapshot is unavailable. Start a fresh reviewer run." }, 409);
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": ENV_REVIEW_SNAPSHOT_CONTENT_TYPE,
      "Cache-Control": "no-store",
    },
  });
});

envReviewRuntimeRoutes.get("/api/env-review-runtime/envs/:slug/runs/:runId/inspection.tar", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const snapshot = loaded.run.preparation?.snapshot ?? null;
  if (!snapshot) {
    return c.json({ error: "Reviewer needs a fresh snapshot. Start a fresh reviewer run." }, 409);
  }
  const object = await c.env.BUCKET.get(buildReviewInspectionKey(loaded.run.envSlug, snapshot.snapshotId));
  if (!object?.body) {
    return c.json({ error: "Complete review change material is unavailable. Start a fresh reviewer run." }, 409);
  }
  return new Response(object.body, {
    headers: {
      "Content-Type": ENV_REVIEW_INSPECTION_CONTENT_TYPE,
      "Cache-Control": "no-store",
    },
  });
});

envReviewRuntimeRoutes.post("/api/env-review-runtime/envs/:slug/runs/:runId/events", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const { run } = loaded;
  const review = getEnvReviewStub(c.env, run.envSlug);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = parseReviewerRuntimeEventBatch(body);
  if (!parsed.ok) return c.json({ error: parsed.error }, 400);
  const { events } = parsed;
  if (!isActiveRun(run)) {
    return c.json({ ok: true, ignored: true, runStatus: run.status });
  }
  // Only valid current-runtime payloads refresh the no-contact watchdog.
  await review.recordRunContact(run.runId);
  let current = run;
  for (const event of events) {
    if (event.type === "runtime_startup") {
      if (current.status === "queued") {
        current = await review.updateRun({ runId: run.runId, status: "running" }) ?? current;
      }
      await review.appendRunEvent({
        runId: run.runId,
        type: "runtime_startup",
        message: event.message,
      });
      continue;
    }
    await review.appendRunEvent({
      runId: run.runId,
      type: event.type,
      message: event.message,
    });
  }
  return c.json({ ok: true, runStatus: current.status });
});

envReviewRuntimeRoutes.post("/api/env-review-runtime/envs/:slug/runs/:runId/result", async (c) => {
  const loaded = await loadAuthorizedRun(c);
  if (!loaded.ok) return loaded.response;
  const { run } = loaded;
  const review = getEnvReviewStub(c.env, run.envSlug);
  if (!isActiveRun(run)) {
    if (run.status === "ready" && run.skillInvocationId && run.skillRunRole === "report_initial") {
      await maybeAssignAutomaticOverview(c, run);
    }
    return c.json({ ok: true, ignored: true, runStatus: run.status });
  }
  const body = await readJsonBody(c);
  if (body.status !== "succeeded") {
    const error = typeof body.error === "string" && body.error.trim()
      ? truncate(body.error.trim(), MAX_EVENT_MESSAGE_CHARS)
      : "Env review runtime reported a failure.";
    await review.appendRunEvent({ runId: run.runId, type: "run_failed", message: error });
    const failed = await review.updateRun({
      runId: run.runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error,
    });
    await maybeAssignAutomaticOverview(c, failed ?? run);
    scheduleJobCleanup(c, review, failed ?? run);
    return c.json({ ok: true, runStatus: failed?.status ?? "failed" });
  }

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    const error = "Reviewer returned no feedback text.";
    await review.appendRunEvent({ runId: run.runId, type: "run_failed", message: error });
    const failed = await review.updateRun({
      runId: run.runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error,
    });
    await maybeAssignAutomaticOverview(c, failed ?? run);
    scheduleJobCleanup(c, review, failed ?? run);
    return c.json({ ok: true, runStatus: failed?.status ?? "failed" });
  }

  const thread = getThreadStub(c.env, run.threadId);
  const message = await appendThreadMessage(thread, "assistant", text, [], {
    id: `env-review-result:${run.runId}`,
    runId: run.runId,
  });
  const finalized = await finalizeSuccessfulReviewOutput({
    env: c.env,
    review,
    run,
    message,
  });
  const finalRun = finalized.run ?? run;
  scheduleJobCleanup(c, review, finalRun);
  return c.json({ ok: true, runStatus: finalRun.status, ignored: finalized.status === "terminal" });
});

export default envReviewRuntimeRoutes;
