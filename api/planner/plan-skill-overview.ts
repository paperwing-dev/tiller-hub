import type {
  ArtifactStoreDO,
  FrozenOverviewPayload,
  PlannerRun,
  PlanSkillInvocation,
  ThreadMessage,
} from "../coordination";
import { getThreadStub } from "../helpers";
import { buildSkillOverviewPrompt } from "../review-overview";
import type { Env } from "../types";
import {
  dispatchPlannerRun,
  plannerLaunchProvenanceFromExecution,
  resolvePlannerExecution,
  type PlannerRepoRuntimeSource,
} from "./dispatch";
import { appendThreadMessage, executeReviewerRun } from "./runtime";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageRunId(message: ThreadMessage): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string"
    ? message.body.runId
    : null;
}

function assistantText(message: ThreadMessage): string | null {
  return isRecord(message.body) &&
    message.body.role === "assistant" &&
    typeof message.body.text === "string" &&
    message.body.text.trim()
    ? message.body.text.trim()
    : null;
}

function terminal(run: PlannerRun): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

export async function readIncludedPlanReports(
  env: Env,
  artifactStore: ArtifactStoreDO,
  invocation: PlanSkillInvocation,
  messageIds = invocation.includedMessageIds,
): Promise<FrozenOverviewPayload["reports"]> {
  const runs = (
    await artifactStore.listPlanSkillInvocationRuns(invocation.invocationId)
  ).filter(
    (run) =>
      run.skillRunRole === "report_initial" ||
      run.skillRunRole === "report_followup",
  );
  const reports: FrozenOverviewPayload["reports"] = [];
  for (const messageId of [...new Set(messageIds)]) {
    let report: FrozenOverviewPayload["reports"][number] | null = null;
    for (const run of runs) {
      if (run.status !== "completed" || !run.skillAgentId || !run.threadId)
        continue;
      const message = await getThreadStub(env, run.threadId).getMessage(messageId);
      if (
        !message ||
        message.threadId !== run.threadId ||
        messageRunId(message) !== run.runId
      )
        continue;
      const text = assistantText(message);
      if (!text) continue;
      const agent = invocation.definitionSnapshot.agents.find(
        (candidate) => candidate.id === run.skillAgentId,
      );
      if (!agent) continue;
      report = {
        messageId,
        runId: run.runId,
        threadId: run.threadId,
        agentId: agent.id,
        agentLabel: agent.label,
        text,
      };
      break;
    }
    if (!report)
      throw new Error(
        `Included message is not a successful Report from this round: ${messageId}`,
      );
    reports.push(report);
  }
  return reports;
}

export async function assignPlanSkillOverview(args: {
  env: Env;
  requestUrl: string;
  artifactStore: ArtifactStoreDO;
  invocationId: string;
  repo: PlannerRepoRuntimeSource;
  guidance?: string | null;
  automatic: boolean;
  schedule(task: Promise<unknown>, run: PlannerRun): void;
  retryCount?: number;
}): Promise<
  | {
      status: "created" | "existing";
      invocation: PlanSkillInvocation;
      run: PlannerRun | null;
    }
  | { status: "waiting" | "not_active"; invocation: PlanSkillInvocation }
> {
  const invocation = await args.artifactStore.getPlanSkillInvocation(
    args.invocationId,
  );
  if (!invocation) throw new Error("Plan Skill round not found.");
  if (invocation.definitionSnapshot.agents.length < 2) {
    return { status: "not_active", invocation };
  }
  if (invocation.overviewRunId) {
    return {
      status: "existing",
      invocation,
      run: await args.artifactStore.getPlannerRun(invocation.overviewRunId),
    };
  }
  if (invocation.status !== "active")
    return { status: "not_active", invocation };
  if (args.automatic && invocation.overviewMode !== "auto")
    return { status: "waiting", invocation };
  if (!args.automatic && invocation.overviewMode !== "manual") {
    throw new Error("Switch Overview to Manual before creating it explicitly.");
  }
  const initialRuns = (
    await args.artifactStore.listPlanSkillInvocationRuns(invocation.invocationId)
  ).filter((run) => run.skillRunRole === "report_initial");
  if (args.automatic && initialRuns.some((run) => !terminal(run))) {
    return { status: "waiting", invocation };
  }
  const reports = await readIncludedPlanReports(
    args.env,
    args.artifactStore,
    invocation,
  );
  if (!args.automatic && reports.length === 0) {
    throw new Error("Manual Overview requires at least one included Report.");
  }
  const failureNotices = initialRuns
    .filter(
      (run) => run.status === "failed" || run.status === "cancelled",
    )
    .map((run) => {
      const agent = invocation.definitionSnapshot.agents.find(
        (candidate) => candidate.id === run.skillAgentId,
      );
      return {
        agentId: run.skillAgentId ?? "unknown",
        agentLabel: agent?.label ?? "Report",
        status: run.status,
        ...(run.error ? { error: run.error } : {}),
      };
    });
  if (
    args.automatic &&
    reports.length === 0
  ) {
    await args.artifactStore.failPlanSkillInvocation(
      invocation.invocationId,
      initialRuns.some((run) => run.status === "completed")
        ? "No successful Report was configured for automatic Overview inclusion."
        : "No Report succeeded, so an Overview could not be created.",
    );
    return {
      status: "not_active",
      invocation:
        (await args.artifactStore.getPlanSkillInvocation(
          invocation.invocationId,
        )) ?? invocation,
    };
  }
  const payload: FrozenOverviewPayload = {
    invocationId: invocation.invocationId,
    skillId: invocation.definitionSnapshot.id,
    skillLabel: invocation.definitionSnapshot.label,
    mode: invocation.overviewMode,
    reports,
    failureNotices,
    guidance: args.guidance?.trim() || null,
    overviewInstructions: invocation.definitionSnapshot.overviewInstructions,
    frozenAt: new Date().toISOString(),
  };
  if (!invocation.overviewRoute) {
    await args.artifactStore.failPlanSkillInvocation(
      invocation.invocationId,
      "The frozen Scribe route is unavailable for Overview.",
    );
    return { status: "not_active", invocation };
  }
  const execution = await resolvePlannerExecution(
    args.env,
    invocation.overviewRoute.provider,
  );
  if (execution.kind === "unavailable") {
    await args.artifactStore.failPlanSkillInvocation(
      invocation.invocationId,
      execution.reason,
    );
    return {
      status: "not_active",
      invocation:
        (await args.artifactStore.getPlanSkillInvocation(
          invocation.invocationId,
        )) ?? invocation,
    };
  }
  const prompt = buildSkillOverviewPrompt(payload);
  const assigned = await args.artifactStore.assignPlanSkillOverview({
    invocationId: invocation.invocationId,
    overviewRunId: crypto.randomUUID(),
    expectedOverviewMode: invocation.overviewMode,
    expectedIncludedMessageIds: invocation.includedMessageIds,
    payload,
    prompt,
    launchProvenance:
      execution.kind === "dispatched"
        ? plannerLaunchProvenanceFromExecution(execution)
        : { schemaVersion: 1, backend: "cf", machineId: null },
  });
  if (!assigned) throw new Error("Plan Skill round not found.");
  if (assigned.status === "controls_changed") {
    if ((args.retryCount ?? 0) >= 2)
      return { status: "waiting", invocation: assigned.invocation };
    return assignPlanSkillOverview({
      ...args,
      retryCount: (args.retryCount ?? 0) + 1,
    });
  }
  if (assigned.status === "not_active") {
    return { status: "not_active", invocation: assigned.invocation };
  }
  if (assigned.status === "created" && assigned.run) {
    const rootThread = getThreadStub(args.env, invocation.parentThreadId);
    await rootThread.createThread({
      id: invocation.parentThreadId,
      scope: { type: "repo", repoId: invocation.repoId },
      kind: "chat",
      title: invocation.definitionSnapshot.label,
    });
    await appendThreadMessage(
      rootThread,
      "user",
      prompt,
      [invocation.planArtifactId],
      {
        id: `skill-overview-input:${assigned.run.runId}`,
        runId: assigned.run.runId,
        planVersion: invocation.basis.version,
      },
    );
    await args.artifactStore.ensurePlannerRunQueuedEvent({
      runId: assigned.run.runId,
      repoId: assigned.run.repoId,
      planArtifactId: assigned.run.planArtifactId,
      type: "run_queued",
      message: "Frozen Plan Skill Overview queued.",
      data: {
        invocationId: invocation.invocationId,
        mode: payload.mode,
        reportCount: payload.reports.length,
      },
    });
    const task =
      execution.kind === "dispatched"
        ? dispatchPlannerRun({
            env: args.env,
            requestUrl: args.requestUrl,
            artifactStore: args.artifactStore,
            run: assigned.run,
            repo: args.repo,
          })
        : executeReviewerRun({
            artifactStore: args.artifactStore,
            thread: rootThread,
            run: assigned.run,
          }).then(async (finished) => {
            const completedInvocation = await args.artifactStore.getPlanSkillInvocation(
              invocation.invocationId,
            );
            if (
              finished.status === "completed"
              && completedInvocation?.status === "completed"
              && completedInvocation.overviewMode === "auto"
            ) {
              await createPlanOverviewContribution({
                env: args.env,
                artifactStore: args.artifactStore,
                invocation: completedInvocation,
              });
            }
            return finished;
          });
    args.schedule(task, assigned.run);
  }
  return {
    status: assigned.status,
    invocation: assigned.invocation,
    run: assigned.run,
  };
}

export async function createPlanOverviewContribution(args: {
  env: Env;
  artifactStore: ArtifactStoreDO;
  invocation: PlanSkillInvocation;
}): Promise<void> {
  const { invocation } = args;
  if (!invocation.overviewRunId) {
    throw new Error("Create the Overview before sharing it with the Scribe.");
  }
  const run = await args.artifactStore.getPlannerRun(invocation.overviewRunId);
  if (!run || run.status !== "completed" || !run.threadId) {
    throw new Error("The Overview is not ready to share with the Scribe.");
  }
  const messageId = `reviewer-result:${run.runId}`;
  const message = await getThreadStub(args.env, run.threadId).getMessage(messageId);
  const text = message ? assistantText(message) : null;
  if (!message || messageRunId(message) !== run.runId || !text) {
    throw new Error("The completed Overview response is unavailable.");
  }
  const payload = run.input?.frozenOverview;
  const result = await args.artifactStore.createOrGetPlanContribution({
    repoId: invocation.repoId,
    planArtifactId: invocation.planArtifactId,
    sourceKind: "skill_overview",
    sourceRunId: run.runId,
    sourceThreadId: run.threadId,
    sourceMessageId: message.id,
    sourcePlanVersion: invocation.basis.version,
    sourceRefs:
      payload?.reports.map((report) => ({
        threadId: report.threadId,
        messageId: report.messageId,
        runId: report.runId,
      })) ?? [],
    idempotencyKey: `skill-overview:${invocation.invocationId}`,
    provider: run.provider,
    model: run.model,
    skill: invocation.definitionSnapshot.command,
    text,
  });
  if (result.status === "conflict") {
    throw new Error("The frozen Overview contribution conflicts with its saved delivery.");
  }
}
