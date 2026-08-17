import type { Env } from "../types";
import { getThreadStub } from "../helpers";
import {
  renderArtifactBodyMarkdown,
  type AgentSkillDefinition,
  type ArtifactStoreDO,
  type PlannerRun,
  type PlannerRunBasis,
  type PlannerEffort,
  type PlanSkillInvocation,
} from "../coordination";
import {
  normalizePlanMarkdown,
  PLAN_MARKDOWN_NORMALIZATION_VERSION,
} from "../coordination/planning";
import { isCurrentLaunchProvenance } from "../coordination/execution-provenance";
import { broadcastPlanArtifactUpdatedHint } from "../plan-artifact-hints";
import {
  dispatchPlannerRun,
  plannerLaunchProvenanceFromExecution,
  plannerExecutionFromLaunch,
  resolvePlannerExecution,
  type PlannerExecution,
  type PlannerRepoRuntimeSource,
} from "./dispatch";
import { appendThreadMessage, executeReviewerRun } from "./runtime";
import { composeReviewerInstructions } from "./context-window";
import { resolveSkillAgentRoutes } from "./agent-skills";
import { listPlannerProviders } from "./providers";
import { assignPlanSkillOverview } from "./plan-skill-overview";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (isRecord(message.body) && typeof message.body.text === "string") {
    return message.body.text;
  }
  return typeof message.body === "string" ? message.body : "";
}

function readThreadMessageRunId(message: { body: unknown }): string | null {
  return isRecord(message.body) &&
    typeof message.body.runId === "string" &&
    message.body.runId.trim()
    ? message.body.runId.trim()
    : null;
}

export function planSkillInvocationBasis(
  plan: { id: string; title: string; body: unknown; version?: number },
  gitBaseCommitSha: string | null,
): PlannerRunBasis {
  return {
    artifactId: plan.id,
    title: plan.title,
    markdown: normalizePlanMarkdown(renderArtifactBodyMarkdown(plan.body)),
    normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
    version: plan.version ?? 1,
    gitBaseCommitSha,
  };
}

function newestInitialRuns(
  invocation: PlanSkillInvocation,
  runs: PlannerRun[],
): PlannerRun[] {
  const newestByAgent = new Map<string, PlannerRun>();
  for (const run of runs) {
    if (
      (run.skillRunRole !== "root_initial" &&
        run.skillRunRole !== "report_initial") ||
      !run.skillAgentId
    )
      continue;
    const current = newestByAgent.get(run.skillAgentId);
    if (!current || run.startedAt >= current.startedAt) {
      newestByAgent.set(run.skillAgentId, run);
    }
  }
  return invocation.definitionSnapshot.agents
    .map((agent) => newestByAgent.get(agent.id))
    .filter((run): run is PlannerRun => Boolean(run));
}

export interface SetupAndDispatchPlanSkillInvocationOptions {
  env: Env;
  requestUrl: string;
  artifactStore: ArtifactStoreDO;
  repoId: string;
  planArtifactId: string;
  invocationId: string;
  repo: PlannerRepoRuntimeSource;
  schedule(task: Promise<unknown>, run: PlannerRun): void;
}

interface PlanSkillInvocationLaunchScope extends SetupAndDispatchPlanSkillInvocationOptions {
  parentThreadId: string;
  skillId: string;
}

export type PlanSkillInvocationLaunchResult =
  | {
      ok: true;
      reservationStatus: "created" | "existing";
      invocation: PlanSkillInvocation;
      reviewers: Awaited<
        ReturnType<ArtifactStoreDO["listPlanSkillInvocationReviewers"]>
      >;
      runs: PlannerRun[];
    }
  | {
      ok: false;
      status: 400 | 409 | 502;
      error: string;
      code?: "skill_setup_incomplete";
    };

export async function resumePlanSkillInvocation(
  options: PlanSkillInvocationLaunchScope,
): Promise<PlanSkillInvocationLaunchResult | null> {
  const existing = await options.artifactStore.getPlanSkillInvocation(
    options.invocationId,
  );
  if (!existing) return null;
  if (
    existing.repoId !== options.repoId ||
    existing.planArtifactId !== options.planArtifactId ||
    existing.parentThreadId !== options.parentThreadId ||
    existing.definitionSnapshot.id !== options.skillId
  ) {
    return {
      ok: false,
      status: 409,
      error: "requestId is already used by a different launch",
    };
  }
  let invocation = existing;
  if (invocation.status === "setting_up" || invocation.status === "active") {
    try {
      invocation = await setupAndDispatchPlanSkillInvocation(options);
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : String(error),
        code: "skill_setup_incomplete",
      };
    }
  }
  return {
    ok: true,
    reservationStatus: "existing",
    invocation,
    reviewers: await options.artifactStore.listPlanSkillInvocationReviewers(
      invocation.invocationId,
    ),
    runs: await options.artifactStore.listPlanSkillInvocationRuns(
      invocation.invocationId,
    ),
  };
}

/**
 * Replays a deterministic rerun request before provider resolution. The
 * Artifact Store remains the transactional authority when a rerun is first
 * reserved; this helper owns the application-level lookup and response shape.
 */
export async function resumePlanSkillInvocationRerun(
  options: SetupAndDispatchPlanSkillInvocationOptions & {
    invocation: PlanSkillInvocation;
    requestId: string;
  },
): Promise<PlanSkillInvocationLaunchResult | null> {
  const replay = await options.artifactStore.inspectPlanSkillInvocationRerun({
    invocationId: options.invocation.invocationId,
    requestId: options.requestId,
    repoId: options.repoId,
    planArtifactId: options.planArtifactId,
  });
  if (replay.status === "missing") return null;
  if (replay.status === "conflict" || !replay.invocation) {
    return {
      ok: false,
      status: 409,
      error: "requestId is already used by a different rerun",
    };
  }

  let invocation = replay.invocation;
  if (invocation.status === "setting_up" || invocation.status === "active") {
    try {
      invocation = await setupAndDispatchPlanSkillInvocation({
        ...options,
        invocationId: invocation.invocationId,
      });
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : String(error),
        code: "skill_setup_incomplete",
      };
    }
  }
  return {
    ok: true,
    reservationStatus: "existing",
    invocation,
    reviewers:
      await options.artifactStore.listPlanSkillInvocationReviewers(
        invocation.invocationId,
      ),
    runs: await options.artifactStore.listPlanSkillInvocationRuns(
      invocation.invocationId,
    ),
  };
}

export async function reserveAndDispatchPlanSkillInvocation(
  options: PlanSkillInvocationLaunchScope & {
    plan: { id: string; title: string; body: unknown; version?: number };
    definitionSnapshot: AgentSkillDefinition;
    overviewMode?: "auto" | "manual";
    overviewRoute?: {
      provider: string;
      model: string;
      effort: PlannerEffort;
    } | null;
    gitSourceAvailable: boolean;
  },
): Promise<PlanSkillInvocationLaunchResult> {
  const replay = await resumePlanSkillInvocation(options);
  if (replay) return replay;

  const providers = await listPlannerProviders(options.env);
  const resolved = resolveSkillAgentRoutes(
    options.definitionSnapshot,
    providers.providers,
    "reviewer",
  );
  if (!resolved.ok) {
    return { ok: false, status: resolved.status, error: resolved.error };
  }
  const executions = await Promise.all(
    resolved.resolved.map(({ route }) =>
      resolvePlannerExecution(options.env, route.provider),
    ),
  );
  const unavailable = executions.find(
    (execution) => execution.kind === "unavailable",
  );
  if (unavailable?.kind === "unavailable") {
    return { ok: false, status: 409, error: unavailable.reason };
  }
  if (
    executions.some((execution) => execution.kind === "dispatched") &&
    !options.gitSourceAvailable
  ) {
    return {
      ok: false,
      status: 409,
      error: "Repository GitHub metadata is not ready yet.",
    };
  }

  const basis = planSkillInvocationBasis(
    options.plan,
    options.repo.githubBaseCommitSha,
  );
  let reserved: Awaited<
    ReturnType<ArtifactStoreDO["reservePlanSkillInvocation"]>
  >;
  try {
    reserved = await options.artifactStore.reservePlanSkillInvocation({
      invocationId: options.invocationId,
      repoId: options.repoId,
      planArtifactId: options.planArtifactId,
      expectedPlanVersion: options.plan.version ?? 1,
      parentThreadId: options.parentThreadId,
      definitionSnapshot: options.definitionSnapshot,
      basis,
      ...(options.overviewMode ? { overviewMode: options.overviewMode } : {}),
      ...(options.overviewRoute !== undefined
        ? { overviewRoute: options.overviewRoute }
        : {}),
      agents: resolved.resolved.map(({ definition, route }, index) => ({
        id: definition.id,
        provider: route.provider,
        model: route.model,
        launchProvenance:
          executions[index]?.kind === "dispatched"
            ? plannerLaunchProvenanceFromExecution(executions[index])
            : {
                schemaVersion: 1 as const,
                backend: "cf" as const,
                machineId: null,
              },
      })),
    });
  } catch (error) {
    return {
      ok: false,
      status: 409,
      error:
        error instanceof Error
          ? error.message
          : "The Plan Skill could not be reserved.",
    };
  }
  if (reserved.status === "conflict") {
    return {
      ok: false,
      status: 409,
      error: "requestId is already used by a different launch",
    };
  }
  let invocation = reserved.invocation;
  if (invocation.status === "setting_up" || invocation.status === "active") {
    try {
      invocation = await setupAndDispatchPlanSkillInvocation(options);
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: error instanceof Error ? error.message : String(error),
        code: "skill_setup_incomplete",
      };
    }
  }
  return {
    ok: true,
    reservationStatus: reserved.status,
    invocation,
    reviewers: await options.artifactStore.listPlanSkillInvocationReviewers(
      invocation.invocationId,
    ),
    runs: await options.artifactStore.listPlanSkillInvocationRuns(
      invocation.invocationId,
    ),
  };
}

/**
 * Completes the resumable setup phase for a reserved Plan Skill invocation and
 * starts each still-queued initial child run. Reservation and terminal state
 * remain owned by Artifact Store; callers may safely replay this operation.
 */
export async function setupAndDispatchPlanSkillInvocation(
  options: SetupAndDispatchPlanSkillInvocationOptions,
): Promise<PlanSkillInvocation> {
  const {
    env,
    requestUrl,
    artifactStore,
    repoId,
    planArtifactId,
    invocationId,
    repo,
    schedule,
  } = options;
  const invocation = await artifactStore.getPlanSkillInvocation(invocationId);
  if (!invocation) throw new Error("Skill invocation not found");
  if (invocation.status !== "setting_up" && invocation.status !== "active") {
    return invocation;
  }

  if (invocation.definitionSnapshot.agents.length > 1) {
    await getThreadStub(env, invocation.parentThreadId).createThread({
      id: invocation.parentThreadId,
      scope: { type: "repo", repoId },
      kind: "chat",
      title: invocation.definitionSnapshot.label,
    });
  }

  const reviewers =
    await artifactStore.listPlanSkillInvocationReviewers(invocationId);
  const runs = newestInitialRuns(
    invocation,
    await artifactStore.listPlanSkillInvocationRuns(invocationId),
  );
  if (
    reviewers.length !== invocation.definitionSnapshot.agents.length ||
    runs.length !== invocation.definitionSnapshot.agents.length
  ) {
    throw new Error("The reserved Plan Skill round is incomplete.");
  }

  for (const agent of invocation.definitionSnapshot.agents) {
    const reviewer = reviewers.find(
      (candidate) => candidate.skillAgentId === agent.id,
    );
    if (!reviewer)
      throw new Error(`Reserved skill reviewer is missing: ${agent.id}`);
    const run = runs.find(
      (candidate) =>
        candidate.skillAgentId === agent.id &&
        candidate.threadId === reviewer.threadId,
    );
    if (!run) throw new Error(`Reserved skill run is missing: ${agent.id}`);

    const thread = getThreadStub(env, reviewer.threadId);
    await thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId },
      kind: "chat",
      title: agent.label,
    });
    const setupMessageId = `skill-setup:${run.runId}`;
    const setupText = `/${invocation.definitionSnapshot.command}\n\n${composeReviewerInstructions(
      invocation.definitionSnapshot.sharedInstructions,
      `Role: ${agent.instructions}`,
    )}`;
    const existing = await thread.getMessage(setupMessageId);
    if (existing) {
      if (
        existing.threadId !== reviewer.threadId ||
        readThreadMessageRole(existing) !== "user" ||
        readThreadMessageText(existing) !== setupText ||
        readThreadMessageRunId(existing) !== run.runId
      ) {
        throw new Error(
          `Skill setup message conflicts with the frozen run: ${agent.id}`,
        );
      }
    } else {
      await appendThreadMessage(thread, "user", setupText, [planArtifactId], {
        id: setupMessageId,
        runId: run.runId,
        planVersion: run.input?.sourcePlanVersion,
      });
    }
  }

  const preparedRuns: Array<{ run: PlannerRun; execution: PlannerExecution }> =
    [];
  for (const run of runs) {
    if (!isCurrentLaunchProvenance(run.launchProvenance)) {
      throw new Error(
        "Planner run launch provenance is not from the current workload schema.",
      );
    }
    const execution: PlannerExecution =
      run.provider === "fake" || run.provider === "codex-api"
        ? { kind: "in-process" }
        : plannerExecutionFromLaunch(run.launchProvenance);
    preparedRuns.push({ run, execution });
    await artifactStore.ensurePlannerRunQueuedEvent({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      type: "run_queued",
      message: "Plan Skill child run queued.",
      data: {
        invocationId,
        agentId: run.skillAgentId,
        provider: run.provider,
        model: run.model,
      },
    });
  }

  const currentInvocation =
    invocation.status === "setting_up"
      ? await artifactStore.activatePlanSkillInvocation(invocationId)
      : await artifactStore.getPlanSkillInvocation(invocationId);
  if (!currentInvocation)
    throw new Error("Failed to activate skill invocation.");
  if (currentInvocation.status !== "active") return currentInvocation;

  for (const prepared of preparedRuns) {
    const run = await artifactStore.getPlannerRun(prepared.run.runId);
    if (!run || run.status !== "queued") continue;
    if (prepared.execution.kind === "dispatched") {
      schedule(
        dispatchPlannerRun({ env, requestUrl, artifactStore, run, repo }),
        run,
      );
      continue;
    }
    const thread = getThreadStub(env, run.threadId!);
    schedule(
      executeReviewerRun({ artifactStore, thread, run }).then(
        async (finished) => {
          const latestInvocation = await artifactStore.getPlanSkillInvocation(
            invocationId,
          );
          if (
            latestInvocation?.definitionSnapshot.agents.length
            && latestInvocation.definitionSnapshot.agents.length > 1
            && latestInvocation.overviewMode === "auto"
          ) {
            await assignPlanSkillOverview({
              env,
              requestUrl,
              artifactStore,
              invocationId,
              repo,
              automatic: true,
              schedule,
            });
          }
          if (finished.status === "completed" || finished.status === "failed") {
            await broadcastPlanArtifactUpdatedHint(
              env,
              run.repoId,
              run.planArtifactId,
            );
          }
        },
      ),
      run,
    );
  }
  return currentInvocation;
}
