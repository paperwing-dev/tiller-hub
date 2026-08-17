import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { specializedServiceAuthMiddleware } from "../auth";
import { getArtifactStoreStub, getThreadStub } from "../helpers";
import {
  renderArtifactBodyMarkdown,
  type Artifact,
  type PlannerRun,
  type RepoPlanMutationResult,
} from "../coordination";
import { PLAN_MARKDOWN_NORMALIZATION_VERSION } from "../coordination/planning";
import {
  isCurrentLaunchProvenance,
  isCurrentPlanWriterLaunchProvenance,
  isCurrentPlannerRuntimeProvenance,
  isCurrentPlanWriterRuntimeProvenance,
} from "../coordination/execution-provenance";
import { completeReviewerOutput, isActiveRun } from "./runtime";
import {
  verifyPlanWriterRuntimeToken,
  verifyPlannerRunToken,
} from "./runtime-token";
import {
  buildThreadMessageHistory,
  listAllThreadMessages,
  PLANNER_THREAD_CONTEXT_BUDGET_CHARS,
  PLANNER_THREAD_CONTEXT_MESSAGE_LIMIT,
} from "./context-window";
import { cleanupPlannerRunRuntime, plannerJobSlug } from "./dispatch";
import { effectivePlanWritingInstructions } from "./writer-instructions";
import {
  normalizeCanonicalPlanForDigest,
  normalizeObservedPlanMarkdown,
  normalizeObservedPlanPublication,
  normalizePlanWriterIdentifier,
  PLAN_WRITER_PROTOCOL_VERSION,
  planWriterTerminalId,
  sha256Hex,
} from "./plan-writer-contract";
import { resolveAgentRoute } from "./agent-skills";
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
import { getDurableObjectStub } from "../durable-object";
import { broadcastPlanArtifactUpdatedHint } from "../plan-artifact-hints";
import { scheduleWorkerTask } from "../worker-task";
import { insertPlanHealthVirtualMessage } from "./plan-health";
import { reserveAndDispatchPlanSkillInvocation } from "./plan-skill-dispatch";
import {
  assignPlanSkillOverview,
  createPlanOverviewContribution,
} from "./plan-skill-overview";

// Callback surface for one-shot reviewer containers and Plan Writer supervisors. Every route requires the
// run-scoped HMAC token: edge auth (CF Access service token or browser JWT)
// is never sufficient on its own — /context returns plan and thread content,
// and /result mutates durable state.
const RUN_TOKEN_HEADER = "X-Tiller-Planner-Run-Token";
const PLAN_WRITER_TOKEN_HEADER = "X-Tiller-Plan-Writer-Token";

const MAX_EVENT_MESSAGE_CHARS = 2_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const plannerRuntimeRoutes = new Hono<HonoEnv>();

plannerRuntimeRoutes.use(
  "/api/planner-runtime/*",
  specializedServiceAuthMiddleware,
);

type LoadedRun = {
  artifactStore: ReturnType<typeof getArtifactStoreStub>;
  run: PlannerRun;
};

async function loadAuthorizedPlanWriter(c: any, runtimeAuth = false) {
  const repoId = c.req.param("repoId");
  const planArtifactId = c.req.param("planArtifactId");
  const generation = Number(c.req.param("generation"));
  if (!Number.isInteger(generation) || generation < 1) {
    return {
      ok: false as const,
      response: c.json({ error: "Invalid writer generation" }, 400),
    };
  }
  if (
    !(await verifyPlanWriterRuntimeToken(
      c.env,
      repoId,
      planArtifactId,
      generation,
      c.req.header(PLAN_WRITER_TOKEN_HEADER),
    ))
  ) {
    return {
      ok: false as const,
      response: c.json({ error: "Unauthorized" }, 401),
    };
  }
  const loadedRepo = await loadTrackedRepo(c.env, repoId);
  if (!loadedRepo.ok) {
    if (runtimeAuth) {
      return {
        ok: false as const,
        response: c.json(
          {
            error: "Codex runtime is no longer active.",
            code: "runtime_inactive",
          },
          409,
        ),
      };
    }
    return {
      ok: false as const,
      response: c.json({ error: "Writer generation not found" }, 404),
    };
  }
  const artifactStore = getArtifactStoreStub(
    c.env,
    repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  );
  const writer = await artifactStore.getPlanWriter(repoId, planArtifactId);
  const terminalId = planWriterTerminalId(repoId, planArtifactId, generation);
  if (
    !writer ||
    writer.generation !== generation ||
    !isCurrentPlanWriterLaunchProvenance(writer.launchProvenance) ||
    writer.launchProvenance.skillProjection.repositoryId !== repoId ||
    writer.launchProvenance.skillProjection.planId !== planArtifactId ||
    writer.launchProvenance.skillProjection.generation !== generation ||
    !isCurrentPlanWriterRuntimeProvenance(writer.runtime) ||
    writer.runtime.generation !== generation ||
    writer.runtime.jobSlug !== terminalId
  ) {
    if (runtimeAuth) {
      return {
        ok: false as const,
        response: c.json(
          {
            error: "Codex runtime is no longer active.",
            code: "runtime_inactive",
          },
          409,
        ),
      };
    }
    return {
      ok: false as const,
      response: c.json({ error: "Writer generation not found" }, 404),
    };
  }
  return {
    ok: true as const,
    repoId,
    planArtifactId,
    generation,
    artifactStore,
    writer,
    repo: loadedRepo.repo,
  };
}

async function broadcastPlanWriterHints(
  c: any,
  repoId: string,
  planArtifactId: string,
  artifactUpdated: boolean,
) {
  try {
    const hub = getDurableObjectStub<{
      broadcastPlanWriterState(
        repoId: string,
        planArtifactId: string,
      ): void | Promise<void>;
      broadcastPlanArtifactUpdated(
        repoId: string,
        planArtifactId: string,
      ): void | Promise<void>;
    }>(c.env, c.env.HUB, "hub");
    await hub.broadcastPlanWriterState(repoId, planArtifactId);
    if (artifactUpdated)
      await hub.broadcastPlanArtifactUpdated(repoId, planArtifactId);
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
  scheduleWorkerTask(
    c,
    cleanupPlannerRunRuntime(c.env, artifactStore, run),
    (error) => {
      console.error(
        `[planner] job cleanup failed for run ${run.runId}:`,
        error,
      );
    },
  );
}

async function advanceAutomaticPlanSkill(
  c: any,
  artifactStore: LoadedRun["artifactStore"],
  run: PlannerRun,
): Promise<void> {
  if (
    !run.skillInvocationId
    || (
      run.skillRunRole !== "report_initial"
      && run.skillRunRole !== "report_followup"
      && run.skillRunRole !== "overview"
    )
  ) return;
  let invocation = await artifactStore.getPlanSkillInvocation(run.skillInvocationId);
  if (
    !invocation
    || invocation.definitionSnapshot.agents.length < 2
    || invocation.overviewMode !== "auto"
  ) return;
  if (
    (run.skillRunRole === "report_initial" || run.skillRunRole === "report_followup")
    && invocation.status === "active"
    && !invocation.overviewRunId
  ) {
    const loadedRepo = await loadTrackedRepo(c.env, run.repoId);
    if (!loadedRepo.ok) {
      throw new Error("Repository metadata is unavailable for automatic Overview.");
    }
    const meta = loadedRepo.repo.meta;
    await assignPlanSkillOverview({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore,
      invocationId: invocation.invocationId,
      repo: {
        repoId: meta.repoId,
        repoUrl: meta.repoUrl,
        githubFullName: meta.githubFullName,
        githubBaseCommitSha:
          meta.githubDefaultBranchHeadSha ?? meta.mainCommit ?? null,
      },
      automatic: true,
      schedule: (task, overviewRun) => {
        scheduleWorkerTask(c, task, (error) => {
          console.error(
            `[planner] automatic Overview failed for ${overviewRun.runId}:`,
            error,
          );
        });
      },
    });
    invocation = await artifactStore.getPlanSkillInvocation(invocation.invocationId) ?? invocation;
  }
  if (invocation.status === "completed") {
    await createPlanOverviewContribution({ env: c.env, artifactStore, invocation });
  }
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

interface RepoPlanSummary {
  id: string;
  title: string;
  status: "draft" | "evaluating" | "todo" | "completed" | "archived";
  version: number;
  updatedAt: string;
  basisCommit: string;
}

interface RepoPlanDocument extends RepoPlanSummary {
  markdown: string;
}

type RepoPlanCommand =
  | { operation: "list" }
  | { operation: "read"; planId: string }
  | { operation: "create"; requestId: string; markdown: string }
  | {
      operation: "update";
      planId: string;
      expectedVersion: number;
      markdown: string;
    };

function repoPlanError(
  c: any,
  status: 400 | 401 | 404 | 409 | 413,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Response {
  return c.json({ error: message, code, ...details }, status);
}

async function loadAuthorizedRepoPlanSource(c: any) {
  const loaded = await loadAuthorizedPlanWriter(c);
  if (!loaded.ok) {
    if (loaded.response.status === 400 || loaded.response.status === 401) {
      return { ok: false as const, response: loaded.response };
    }
    return {
      ok: false as const,
      response: repoPlanError(
        c,
        409,
        "source_inactive",
        "The source Scribe is no longer active.",
      ),
    };
  }
  if (loaded.writer.stoppedAt || !loaded.writer.runtime) {
    return {
      ok: false as const,
      response: repoPlanError(
        c,
        409,
        "source_inactive",
        "The source Scribe is no longer active.",
      ),
    };
  }
  return loaded;
}

function summarizeRepoPlan(artifact: Artifact): RepoPlanSummary | null {
  if (artifact.type !== "plan" || !artifact.basis.mainCommit?.trim()) {
    return null;
  }
  return {
    id: artifact.id,
    title: artifact.title,
    status: artifact.status ?? "draft",
    version: artifact.version ?? 1,
    updatedAt: artifact.updatedAt ?? artifact.createdAt,
    basisCommit: artifact.basis.mainCommit,
  };
}

function documentRepoPlan(artifact: Artifact): RepoPlanDocument | null {
  const summary = summarizeRepoPlan(artifact);
  if (!summary) return null;
  return {
    ...summary,
    markdown: normalizeCanonicalPlanForDigest(
      renderArtifactBodyMarkdown(artifact.body),
    ),
  };
}

function exactKeys(
  body: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(body).sort();
  return (
    keys.length === expected.length &&
    [...expected].sort().every((key, index) => keys[index] === key)
  );
}

function normalizeRepoPlanMarkdown(c: any, value: unknown): string | Response {
  if (typeof value !== "string") {
    return repoPlanError(
      c,
      400,
      "invalid_request",
      "markdown must be a string.",
    );
  }
  try {
    return normalizeObservedPlanMarkdown(value);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Invalid plan Markdown.";
    return repoPlanError(
      c,
      /exceeds .*utf-8 bytes/iu.test(message) ? 413 : 400,
      "invalid_request",
      message,
    );
  }
}

function parseRepoPlanCommand(
  c: any,
  body: Record<string, unknown>,
): { ok: true; command: RepoPlanCommand } | { ok: false; response: Response } {
  const invalid = (message: string) => ({
    ok: false as const,
    response: repoPlanError(c, 400, "invalid_request", message),
  });
  const planId = (): string | Response => {
    try {
      return normalizePlanWriterIdentifier(
        typeof body.planId === "string" ? body.planId : "",
        "planId",
      );
    } catch (error) {
      return repoPlanError(
        c,
        400,
        "invalid_request",
        error instanceof Error ? error.message : "Invalid planId.",
      );
    }
  };

  switch (body.operation) {
    case "list":
      return exactKeys(body, ["operation"])
        ? { ok: true, command: { operation: "list" } }
        : invalid("Invalid list command.");
    case "read": {
      if (!exactKeys(body, ["operation", "planId"])) {
        return invalid("Invalid read command.");
      }
      const value = planId();
      return value instanceof Response
        ? { ok: false, response: value }
        : { ok: true, command: { operation: "read", planId: value } };
    }
    case "create": {
      if (!exactKeys(body, ["operation", "requestId", "markdown"])) {
        return invalid("Invalid create command.");
      }
      const requestId =
        typeof body.requestId === "string" ? body.requestId.trim() : "";
      if (!UUID_PATTERN.test(requestId)) {
        return invalid("requestId must be a UUID.");
      }
      const markdown = normalizeRepoPlanMarkdown(c, body.markdown);
      return markdown instanceof Response
        ? { ok: false, response: markdown }
        : {
            ok: true,
            command: { operation: "create", requestId, markdown },
          };
    }
    case "update": {
      if (
        !exactKeys(body, ["operation", "planId", "expectedVersion", "markdown"])
      ) {
        return invalid("Invalid update command.");
      }
      const value = planId();
      if (value instanceof Response) return { ok: false, response: value };
      if (
        !Number.isInteger(body.expectedVersion) ||
        (body.expectedVersion as number) < 1
      ) {
        return invalid("expectedVersion must be a positive integer.");
      }
      const markdown = normalizeRepoPlanMarkdown(c, body.markdown);
      return markdown instanceof Response
        ? { ok: false, response: markdown }
        : {
            ok: true,
            command: {
              operation: "update",
              planId: value,
              expectedVersion: body.expectedVersion as number,
              markdown,
            },
          };
    }
    default:
      return invalid("Unknown repository-plan operation.");
  }
}

function repoPlanMutationError(
  c: any,
  result: Extract<RepoPlanMutationResult, { ok: false }>,
): Response {
  switch (result.code) {
    case "invalid_request":
      return repoPlanError(
        c,
        400,
        "invalid_request",
        "Plan Markdown must contain a usable derived title.",
      );
    case "source_inactive":
      return repoPlanError(
        c,
        409,
        "source_inactive",
        "The source Scribe or repository is no longer active.",
      );
    case "plan_not_found":
      return repoPlanError(c, 404, "plan_not_found", "Plan not found.");
    case "plan_not_editable":
      return repoPlanError(
        c,
        409,
        "plan_not_editable",
        "Completed or archived plans cannot be updated.",
      );
    case "version_conflict":
      return repoPlanError(
        c,
        409,
        "version_conflict",
        "The target plan version does not match expectedVersion.",
        { currentVersion: result.currentVersion },
      );
    case "self_target":
      return repoPlanError(
        c,
        409,
        "conflict",
        "A Scribe cannot modify its owned plan through repository plan tools.",
      );
    case "target_writer_active":
      return repoPlanError(
        c,
        409,
        "conflict",
        "The target plan has an active Scribe.",
      );
    case "idempotency_conflict":
      return repoPlanError(
        c,
        409,
        "conflict",
        "The create request conflicts with an existing artifact.",
      );
  }
}

async function loadAuthorizedRun(
  c: any,
  runtimeAuth = false,
  recordContact = false,
  allowTerminalWithoutRuntime = false,
): Promise<({ ok: true } & LoadedRun) | { ok: false; response: Response }> {
  const repoId = c.req.param("repoId");
  const runId = c.req.param("runId");
  if (
    !(await verifyPlannerRunToken(c.env, runId, c.req.header(RUN_TOKEN_HEADER)))
  ) {
    return { ok: false, response: c.json({ error: "Unauthorized" }, 401) };
  }
  const loadedRepo = await loadTrackedRepo(c.env, repoId);
  if (!loadedRepo.ok) {
    if (runtimeAuth) {
      return {
        ok: false,
        response: c.json(
          {
            error: "Codex runtime is no longer active.",
            code: "runtime_inactive",
          },
          409,
        ),
      };
    }
    return {
      ok: false,
      response: c.json({ error: "Reviewer run not found" }, 404),
    };
  }
  const artifactStore = getArtifactStoreStub(
    c.env,
    repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  );
  const run = recordContact
    ? await artifactStore.getPlannerRunAndRecordContact(runId)
    : await artifactStore.getPlannerRun(runId);
  const currentRuntime = run?.runtime;
  const terminalReplayWithoutRuntime = Boolean(
    allowTerminalWithoutRuntime &&
    run &&
    !isActiveRun(run) &&
    currentRuntime === undefined,
  );
  if (
    !run ||
    run.repoId !== repoId ||
    run.role !== "reviewer" ||
    !isCurrentLaunchProvenance(run.launchProvenance) ||
    (!terminalReplayWithoutRuntime &&
      (!isCurrentPlannerRuntimeProvenance(currentRuntime) ||
        currentRuntime.jobSlug !== plannerJobSlug(runId)))
  ) {
    if (runtimeAuth) {
      return {
        ok: false,
        response: c.json(
          {
            error: "Codex runtime is no longer active.",
            code: "runtime_inactive",
          },
          409,
        ),
      };
    }
    return {
      ok: false,
      response: c.json({ error: "Reviewer run not found" }, 404),
    };
  }
  return { ok: true, artifactStore, run };
}

function isActiveSubscriptionWriter(
  loaded: Extract<
    Awaited<ReturnType<typeof loadAuthorizedPlanWriter>>,
    { ok: true }
  >,
): boolean {
  const profile = loaded.writer.launchProvenance?.codexExecution;
  return (
    loaded.writer.provider === "codex" &&
    !loaded.writer.stoppedAt &&
    Boolean(loaded.writer.runtime) &&
    profile?.kind === "subscription-app-server" &&
    profile.surface === "plan-writer"
  );
}

function isActiveSubscriptionReviewer(
  loaded: Extract<Awaited<ReturnType<typeof loadAuthorizedRun>>, { ok: true }>,
): boolean {
  const profile = loaded.run.launchProvenance?.codexExecution;
  return (
    loaded.run.provider === "codex" &&
    isActiveRun(loaded.run) &&
    Boolean(loaded.run.runtime) &&
    profile?.kind === "subscription-app-server" &&
    profile.surface === "plan-reviewer"
  );
}

async function runtimeAuthResponse(
  c: any,
  rejectedAccessTokenSha256: string | undefined,
  acceptAccount: (
    accountId: string,
  ) => Promise<"accepted" | "inactive" | "account_changed">,
): Promise<Response> {
  const result = await exchangeCodexRuntimeAuth(
    c.env,
    rejectedAccessTokenSha256,
  );
  if (!result.ok) return codexRuntimeAuthExchangeErrorResponse(result);
  const acceptance = await acceptAccount(result.account_id);
  if (acceptance === "inactive") return codexRuntimeAuthInactiveResponse();
  if (acceptance === "account_changed")
    return codexRuntimeAuthAccountChangedResponse();
  return codexRuntimeAuthSuccessResponse(result);
}

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/runtime-auth",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c, true);
    if (!loaded.ok) return loaded.response;
    if (!isActiveSubscriptionWriter(loaded))
      return codexRuntimeAuthInactiveResponse();
    const request = await parseCodexRuntimeAuthRequest(c.req.raw);
    if (!request.ok) return request.response;
    return runtimeAuthResponse(
      c,
      request.rejectedAccessTokenSha256,
      async (accountId) =>
        loaded.artifactStore.acceptPlanWriterCodexRuntimeAuth({
          repoId: loaded.repoId,
          planArtifactId: loaded.planArtifactId,
          generation: loaded.generation,
          accountId,
        }),
    );
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/runs/:runId/runtime-auth",
  async (c) => {
    const loaded = await loadAuthorizedRun(c, true);
    if (!loaded.ok) return loaded.response;
    if (!isActiveSubscriptionReviewer(loaded))
      return codexRuntimeAuthInactiveResponse();
    const request = await parseCodexRuntimeAuthRequest(c.req.raw);
    if (!request.ok) return request.response;
    return runtimeAuthResponse(
      c,
      request.rejectedAccessTokenSha256,
      async (accountId) =>
        loaded.artifactStore.acceptPlannerRunCodexRuntimeAuth(
          loaded.run.runId,
          accountId,
        ),
    );
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
    const markdown = normalizeCanonicalPlanForDigest(
      renderArtifactBodyMarkdown(plan.body),
    );
    const digest = await sha256Hex(markdown);
    const defaultRoute = resolveAgentRoute("codex:gpt-5.5");
    const settings = await loaded.artifactStore.getRepoPlanWriterSettings(
      loaded.repoId,
      {
        routeKey: "codex:gpt-5.5",
        effort: defaultRoute?.defaultEffort ?? "high",
        planFormat: effectivePlanWritingInstructions(null),
      },
    );
    return c.json({
      writer: {
        protocolVersion: PLAN_WRITER_PROTOCOL_VERSION,
        repoId: loaded.repoId,
        planArtifactId: loaded.planArtifactId,
        generation: loaded.generation,
        provider: loaded.writer.provider,
        model: loaded.writer.model,
        effort: loaded.writer.effort,
        fastMode: loaded.writer.fastMode === true,
        basisCommit: loaded.writer.basisCommit,
        terminalId: planWriterTerminalId(
          loaded.repoId,
          loaded.planArtifactId,
          loaded.generation,
        ),
        publicationCursor: loaded.writer.publicationCursor ?? null,
      },
      plan: {
        normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
        title: plan.title,
        status: plan.status ?? "draft",
        markdown,
        digest,
      },
      planFormat: settings.planFormat,
      instructions: [
        "You are the planning-only writer for this Tiller plan.",
        "Discussion, questions, and incomplete output do not revise the canonical artifact.",
        "Whenever the user creates, revises, or iterates on the plan, emit the complete replacement plan; every completed plan revision is published to the canonical artifact.",
        "Treat requests to write or update the plan as artifact revisions, never as requests to modify files in the read-only checkout.",
        "Do not leave the provider's managed Plan Mode or replace this owned conversation.",
      ],
      skills: loaded.writer.launchProvenance!.skillProjection.skills,
      capabilities: { repoPlansV1: true },
    });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/repo-plans",
  async (c) => {
    const loaded = await loadAuthorizedRepoPlanSource(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const parsed = parseRepoPlanCommand(c, body);
    if (!parsed.ok) return parsed.response;
    const command = parsed.command;

    switch (command.operation) {
      case "list": {
        const artifacts = await loaded.artifactStore.listArtifacts({
          type: "plan",
          limit: 500,
        });
        const plans = artifacts
          .filter(
            (artifact) =>
              artifact.repoId === loaded.repoId &&
              artifact.basis.repoId === loaded.repoId,
          )
          .map(summarizeRepoPlan)
          .filter((plan): plan is RepoPlanSummary => plan !== null)
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        return c.json({ plans });
      }
      case "read": {
        const artifact = await loaded.artifactStore.getArtifact(command.planId);
        const plan =
          artifact &&
          artifact.repoId === loaded.repoId &&
          artifact.basis.repoId === loaded.repoId
            ? documentRepoPlan(artifact)
            : null;
        return plan
          ? c.json(plan)
          : repoPlanError(c, 404, "plan_not_found", "Plan not found.");
      }
      case "create": {
        const result = await loaded.artifactStore.mutateRepoPlan({
          kind: "create",
          repoId: loaded.repoId,
          sourcePlanId: loaded.planArtifactId,
          sourceGeneration: loaded.generation,
          requestId: command.requestId,
          markdown: command.markdown,
        });
        if (!result.ok) return repoPlanMutationError(c, result);
        await broadcastPlanArtifactUpdatedHint(
          c.env,
          loaded.repoId,
          result.artifact.id,
        );
        return c.json(summarizeRepoPlan(result.artifact));
      }
      case "update": {
        const result = await loaded.artifactStore.mutateRepoPlan({
          kind: "update",
          repoId: loaded.repoId,
          sourcePlanId: loaded.planArtifactId,
          sourceGeneration: loaded.generation,
          targetPlanId: command.planId,
          expectedVersion: command.expectedVersion,
          markdown: command.markdown,
        });
        if (!result.ok) return repoPlanMutationError(c, result);
        await broadcastPlanArtifactUpdatedHint(
          c.env,
          loaded.repoId,
          result.artifact.id,
        );
        return c.json(summarizeRepoPlan(result.artifact));
      }
    }
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/skills/:skillPath/invoke",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    if (loaded.writer.provider !== "claude-code") {
      return c.json(
        { error: "Projected Plan Skills require an active Claude Scribe." },
        409,
      );
    }
    const body = await readJsonBody(c);
    if (Object.keys(body).some((key) => key !== "requestId")) {
      return c.json(
        { error: "Writer skill invocations accept requestId only." },
        400,
      );
    }
    const requestId =
      typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId || requestId.length > 256) {
      return c.json({ error: "requestId is required" }, 400);
    }
    const skillPath = c.req
      .param("skillPath")
      .replace(/^\/+/, "")
      .trim()
      .toLowerCase();
    const skills = loaded.writer.launchProvenance!.skillProjection.skills;
    const skill = skills.find(
      (candidate) =>
        candidate.surface === "plan" &&
        (candidate.id === skillPath || candidate.command === skillPath),
    );
    if (!skill) return c.json({ error: "Projected Plan Skill not found" }, 404);

    const plan = await loaded.artifactStore.getArtifact(loaded.planArtifactId);
    if (!plan || plan.repoId !== loaded.repoId || plan.type !== "plan") {
      return c.json({ error: "Plan artifact not found" }, 404);
    }
    if (plan.status === "completed" || plan.status === "archived") {
      return c.json(
        { error: "Completed or archived plans cannot start Plan Skill work." },
        409,
      );
    }

    const repoMeta = loaded.repo.meta;
    const githubBaseCommitSha =
      repoMeta.githubDefaultBranchHeadSha ?? repoMeta.mainCommit ?? null;
    const launched = await reserveAndDispatchPlanSkillInvocation({
      env: c.env,
      requestUrl: c.req.url,
      artifactStore: loaded.artifactStore,
      repoId: loaded.repoId,
      planArtifactId: plan.id,
      invocationId: requestId,
      parentThreadId: `plan-skill-root:${requestId}`,
      skillId: skill.id,
      definitionSnapshot: skill,
      overviewMode: skill.overviewMode,
      overviewRoute: skill.agents.length > 1
        ? {
            provider: loaded.writer.provider,
            model: loaded.writer.model,
            effort: loaded.writer.effort ?? "high",
          }
        : null,
      plan,
      repo: {
        repoId: loaded.repoId,
        repoUrl: repoMeta.repoUrl,
        githubFullName: repoMeta.githubFullName,
        githubBaseCommitSha,
      },
      gitSourceAvailable: Boolean(
        githubBaseCommitSha &&
        repoMeta.gitStatus === "ready" &&
        !repoMeta.gitError,
      ),
      schedule: (task, run) => {
        scheduleWorkerTask(c, task, (error) => {
          console.error(
            `[planner] Writer-invoked skill failed for ${run.runId}:`,
            error,
          );
        });
      },
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
    await broadcastPlanArtifactUpdatedHint(
      c.env,
      loaded.repoId,
      loaded.planArtifactId,
    );
    return c.json(
      { ok: true, invocation: launched.invocation },
      launched.reservationStatus === "created" ? 201 : 200,
    );
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
        typeof body.providerConversationId === "string"
          ? body.providerConversationId
          : "",
        "providerConversationId",
      );
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Invalid providerConversationId",
        },
        400,
      );
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
    if (!registered)
      return c.json(
        { error: "Writer generation changed during registration" },
        409,
      );
    await broadcastPlanWriterHints(
      c,
      loaded.repoId,
      loaded.planArtifactId,
      false,
    );
    return c.json({
      ok: true,
      terminalId: planWriterTerminalId(
        loaded.repoId,
        loaded.planArtifactId,
        loaded.generation,
      ),
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
        providerConversationId:
          typeof body.providerConversationId === "string"
            ? body.providerConversationId
            : "",
        sequence:
          typeof body.sequence === "number" ? body.sequence : Number.NaN,
        providerEventId:
          typeof body.providerEventId === "string" ? body.providerEventId : "",
        markdown: typeof body.markdown === "string" ? body.markdown : "",
        bodyDigest: typeof body.bodyDigest === "string" ? body.bodyDigest : "",
      });
    } catch (error) {
      return c.json(
        {
          error:
            error instanceof Error ? error.message : "Invalid plan publication",
        },
        400,
      );
    }
    const result = await loaded.artifactStore.publishObservedPlan(publication);
    if (result.status === "rejected") {
      return c.json({ error: result.reason, ...result }, 409);
    }
    await broadcastPlanWriterHints(
      c,
      loaded.repoId,
      loaded.planArtifactId,
      result.changed,
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
    const error =
      typeof body.error === "string" && body.error.trim()
        ? truncate(body.error.trim(), MAX_EVENT_MESSAGE_CHARS)
        : null;
    await loaded.artifactStore.setPlanWriterError({
      repoId: loaded.repoId,
      planArtifactId: loaded.planArtifactId,
      generation: loaded.generation,
      kind: "synchronization",
      error,
    });
    await broadcastPlanWriterHints(
      c,
      loaded.repoId,
      loaded.planArtifactId,
      false,
    );
    return c.json({ ok: true });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/completions",
  async (c) => {
    const repoId = c.req.param("repoId");
    const planArtifactId = c.req.param("planArtifactId");
    const generation = Number(c.req.param("generation"));
    if (!Number.isInteger(generation) || generation < 1) {
      return c.json({ error: "Invalid writer generation" }, 400);
    }
    if (
      !(await verifyPlanWriterRuntimeToken(
        c.env,
        repoId,
        planArtifactId,
        generation,
        c.req.header(PLAN_WRITER_TOKEN_HEADER),
      ))
    ) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const body = await readJsonBody(c);
    const sequence = body.sequence;
    if (!Number.isInteger(sequence) || (sequence as number) < 1) {
      return c.json({ error: "sequence must be a positive integer" }, 400);
    }
    const loadedRepo = await loadTrackedRepo(c.env, repoId);
    if (!loadedRepo.ok) {
      return c.json({ error: "Writer generation is stale" }, 409);
    }
    const artifactStore = getArtifactStoreStub(
      c.env,
      repoId,
      loadedRepo.repo.meta.artifactStoreGeneration,
    );
    const result = await artifactStore.recordPlanWriterCompletion({
      repoId,
      planArtifactId,
      generation,
      sequence: sequence as number,
    });
    if (result.status === "stale") {
      return c.json(
        { error: "Writer completion is stale", reason: result.reason },
        409,
      );
    }
    if (result.status === "recorded") {
      await broadcastPlanArtifactUpdatedHint(c.env, repoId, planArtifactId);
    }
    return c.body(null, 204);
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/plans/:planArtifactId/writers/:generation/stop",
  async (c) => {
    const loaded = await loadAuthorizedPlanWriter(c);
    if (!loaded.ok) return loaded.response;
    const body = await readJsonBody(c);
    const reason = body.reason;
    if (
      reason !== "idle" &&
      reason !== "runtime_ended" &&
      reason !== "mode_invalidated" &&
      reason !== "watchdog"
    ) {
      return c.json({ error: "Unsupported runtime stop reason" }, 400);
    }
    const startupError =
      reason === "runtime_ended" &&
      typeof body.startupError === "string" &&
      body.startupError.trim()
        ? truncate(body.startupError.trim(), MAX_EVENT_MESSAGE_CHARS)
        : null;
    const abandoned = await loaded.artifactStore.abandonPlanWriter({
      repoId: loaded.repoId,
      planArtifactId: loaded.planArtifactId,
      expectedGeneration: loaded.generation,
      reason,
    });
    if (abandoned.status !== "abandoned") {
      return c.json(
        {
          error:
            abandoned.status === "stale"
              ? "Writer generation changed"
              : "Writer no longer exists",
        },
        409,
      );
    }
    if (startupError) {
      await loaded.artifactStore.setPlanWriterError({
        repoId: loaded.repoId,
        planArtifactId: loaded.planArtifactId,
        generation: loaded.generation,
        kind: "startup",
        error: startupError,
      });
    }
    await broadcastPlanWriterHints(
      c,
      loaded.repoId,
      loaded.planArtifactId,
      false,
    );
    return c.json({ ok: true });
  },
);

plannerRuntimeRoutes.get(
  "/api/planner-runtime/repos/:repoId/runs/:runId/context",
  async (c) => {
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
      const chronological = insertPlanHealthVirtualMessage(
        await listAllThreadMessages(thread),
        await artifactStore.getPlanHealthVirtualMessage(run.threadId),
      );
      const windowed = buildThreadMessageHistory(chronological, run.runId, {
        messageLimit: PLANNER_THREAD_CONTEXT_MESSAGE_LIMIT,
        budgetChars: PLANNER_THREAD_CONTEXT_BUDGET_CHARS,
      });
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
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/runs/:runId/events",
  async (c) => {
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
    // Valid event calls — including the empty 15s cancellation poll — update
    // liveness, run state, reviewer projection, and events in one store
    // transaction. Invalid payloads return above without refreshing liveness.
    const accepted = await artifactStore.acceptReviewerRuntimeEventBatch(
      run.runId,
      events,
    );
    const active = Boolean(accepted && isActiveRun(accepted));
    return c.json({
      ok: true,
      ...(!active ? { ignored: true } : {}),
      runStatus: accepted?.status ?? run.status,
    });
  },
);

plannerRuntimeRoutes.post(
  "/api/planner-runtime/repos/:repoId/runs/:runId/result",
  async (c) => {
    // Loading and recording contact are one ArtifactStore operation so the lazy
    // watchdog cannot abandon a valid result request between those two actions.
    const loaded = await loadAuthorizedRun(c, false, true, true);
    if (!loaded.ok) return loaded.response;
    const { artifactStore, run } = loaded;
    const body = await readJsonBody(c);
    if (body.status !== "succeeded" && body.status !== "failed") {
      return c.json({ error: "status must be succeeded or failed" }, 400);
    }
    const callbackKeys = Object.keys(body).sort();
    if (body.status === "succeeded") {
      if (
        callbackKeys.length !== 2 ||
        callbackKeys[0] !== "status" ||
        callbackKeys[1] !== "text" ||
        typeof body.text !== "string"
      ) {
        return c.json(
          { error: "A succeeded result must contain only status and text." },
          400,
        );
      }
    } else if (
      callbackKeys.length !== 2 ||
      callbackKeys[0] !== "error" ||
      callbackKeys[1] !== "status" ||
      typeof body.error !== "string" ||
      !body.error.trim()
    ) {
      return c.json(
        {
          error:
            "A failed result must contain only status and a non-empty error.",
        },
        400,
      );
    }
    const output =
      body.status === "succeeded"
        ? { status: "succeeded" as const, text: body.text as string }
        : {
            status: "failed" as const,
            error: truncate(
              (body.error as string).trim(),
              MAX_EVENT_MESSAGE_CHARS,
            ),
          };
    const thread = run.threadId ? getThreadStub(c.env, run.threadId) : null;
    const finished = await completeReviewerOutput({
      artifactStore,
      thread,
      run,
      output,
    });
    await advanceAutomaticPlanSkill(c, artifactStore, finished.run).catch((error) => {
      console.error(
        `[planner] automatic Plan Skill advancement failed for ${finished.run.runId}:`,
        error,
      );
    });
    // Idempotency: duplicate, late, or post-cancellation results are harmless.
    if (!isActiveRun(run)) {
      scheduleJobCleanup(c, artifactStore, run);
      if (finished.structured) {
        return c.json({
          ok: true,
          ignored: true,
          runStatus: finished.run.status,
          ...(finished.result ? { result: finished.result } : {}),
          ...(finished.error ? { error: finished.error } : {}),
        });
      }
      if (!run.runtime) return c.json({ error: "Reviewer run not found" }, 404);
      return c.json({ ok: true, ignored: true, runStatus: run.status });
    }
    const completed = finished.run;
    if (isActiveRun(completed)) {
      return c.json({ error: "Reviewer result is still being saved." }, 503);
    }
    if (finished.finalized) {
      await broadcastPlanArtifactUpdatedHint(
        c.env,
        run.repoId,
        run.planArtifactId,
      );
    }
    scheduleJobCleanup(c, artifactStore, completed);
    return c.json({
      ok: true,
      ...(!finished.finalized ? { ignored: true } : {}),
      runStatus: completed.status,
      ...(finished.result ? { result: finished.result } : {}),
      ...(finished.error ? { error: finished.error } : {}),
    });
  },
);

export default plannerRuntimeRoutes;
