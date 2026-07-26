import type { FrozenOverviewPayload, ThreadMessage } from "../coordination";
import { getThreadStub } from "../helpers";
import type { Env } from "../types";
import { buildEnvReviewPrompt } from "./context";
import type { EnvReviewDO } from "./env-review-do";
import type { EnvReviewRun, ReviewSkillInvocation } from "./types";
import { resolveNewEnvReviewLaunchProvenance } from "./dispatch";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageRunId(body: unknown): string | null {
  return isRecord(body) && typeof body.runId === "string" && body.runId.trim() ? body.runId.trim() : null;
}

function assistantText(body: unknown): string | null {
  return isRecord(body) && body.role === "assistant" && typeof body.text === "string" && body.text.trim()
    ? body.text.trim()
    : null;
}

function terminal(run: EnvReviewRun): boolean {
  return run.status === "ready" || run.status === "failed" || run.status === "cancelled";
}

export async function finalizeSuccessfulReviewOutput(args: {
  env: Env;
  review: EnvReviewDO;
  run: EnvReviewRun;
  message: ThreadMessage;
  eventMessage?: string;
}): Promise<Awaited<ReturnType<EnvReviewDO["completeRunSuccessfully"]>>> {
  const text = assistantText(args.message.body);
  if (messageRunId(args.message.body) !== args.run.runId || !text) {
    throw new Error(`Stored assistant output does not match Review run ${args.run.runId}.`);
  }
  const result = await args.review.completeRunSuccessfully({
    runId: args.run.runId,
    messageId: args.message.id,
    text,
    eventMessage: args.eventMessage,
  });
  if (
    (result.status === "completed" || (result.status === "terminal" && result.run.status === "ready"))
    && result.run.skillInvocationId
    && result.run.skillRunRole === "child_initial"
  ) {
    try {
      await assignSkillOverview({
        env: args.env,
        review: args.review,
        invocationId: result.run.skillInvocationId,
        automatic: true,
      });
    } catch (error) {
      console.error(`[env-review] automatic Overview check failed for ${result.run.skillInvocationId}:`, error);
    }
  }
  return result;
}

export async function readIncludedSkillReports(
  env: Env,
  review: EnvReviewDO,
  invocation: ReviewSkillInvocation,
  messageIds = invocation.includedMessageIds,
): Promise<FrozenOverviewPayload["reports"]> {
  const runs = (await review.listSkillInvocationRuns(invocation.invocationId))
    .filter((run) => run.skillRunRole === "child_initial" || run.skillRunRole === "child_followup");
  const reports: FrozenOverviewPayload["reports"] = [];
  for (const messageId of [...new Set(messageIds)]) {
    let report: FrozenOverviewPayload["reports"][number] | null = null;
    for (const run of runs) {
      if (run.status !== "ready" || !run.skillAgentId) continue;
      const message = await getThreadStub(env, run.threadId).getMessage(messageId);
      if (!message || message.threadId !== run.threadId || messageRunId(message.body) !== run.runId) continue;
      const text = assistantText(message.body);
      if (!text) continue;
      const agent = invocation.definitionSnapshot.agents.find((candidate) => candidate.id === run.skillAgentId);
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
    if (!report) throw new Error(`Included message is not a successful child report: ${messageId}`);
    reports.push(report);
  }
  return reports;
}

function overviewPrompt(args: {
  contextRun: EnvReviewRun;
  payload: FrozenOverviewPayload;
}): string {
  const { contextRun, payload } = args;
  const base = buildEnvReviewPrompt({
    run: {
      ...contextRun,
      roleLabel: "Overview",
      taskKind: "custom",
      customTask: "Synthesize only the frozen child reports below into one concise parent review.",
    },
    preparation: contextRun.preparation!,
    changeContext: contextRun.changeContext!,
    planBasis: contextRun.planBasis,
    recipeInstructions: payload.overviewInstructions,
    priorMessages: [],
  });
  const reports = payload.reports.map((report) => [
    `### ${report.agentLabel}`,
    `Attribution: agent ${report.agentId}, run ${report.runId}, message ${report.messageId}`,
    report.text,
  ].join("\n")).join("\n\n");
  const failures = payload.failureNotices.map((notice) =>
    `- ${notice.agentLabel} (${notice.agentId}): ${notice.status}${notice.error ? ` — ${notice.error}` : ""}`
  ).join("\n");
  return [
    base,
    "",
    "Frozen overview input:",
    `- mode: ${payload.mode}`,
    `- frozen at: ${payload.frozenAt}`,
    "Do not use later child results or follow-up messages. The following payload is authoritative.",
    "",
    "Included reports:",
    reports || "None.",
    "",
    "Initial child failure notices:",
    failures || "None.",
    "",
    "User guidance:",
    payload.guidance ?? "None.",
  ].join("\n");
}

export async function assignSkillOverview(args: {
  env: Env;
  review: EnvReviewDO;
  invocationId: string;
  guidance?: string | null;
  automatic: boolean;
  retryCount?: number;
}): Promise<
  | { status: "created" | "existing"; invocation: ReviewSkillInvocation; run: EnvReviewRun | null }
  | { status: "waiting" | "not_active"; invocation: ReviewSkillInvocation }
> {
  const invocation = await args.review.getSkillInvocation(args.invocationId);
  if (!invocation) throw new Error("Skill invocation not found.");
  if (invocation.overviewRunId) {
    return { status: "existing", invocation, run: await args.review.getRun(invocation.overviewRunId) };
  }
  if (invocation.status !== "active") return { status: "not_active", invocation };
  if (args.automatic && invocation.overviewMode !== "auto") return { status: "waiting", invocation };
  if (!args.automatic && invocation.overviewMode !== "manual") {
    throw new Error("Switch Overview to Manual before sending it explicitly.");
  }
  const initialRuns = (await args.review.listSkillInvocationRuns(invocation.invocationId))
    .filter((run) => run.skillRunRole === "child_initial");
  if (args.automatic && initialRuns.some((run) => !terminal(run))) {
    return { status: "waiting", invocation };
  }
  const reports = await readIncludedSkillReports(args.env, args.review, invocation);
  if (!args.automatic && reports.length === 0) {
    throw new Error("Manual Overview requires at least one included successful report.");
  }
  const failureNotices = initialRuns
    .filter((run) => run.status === "failed" || run.status === "cancelled")
    .map((run) => {
      const agent = invocation.definitionSnapshot.agents.find((candidate) => candidate.id === run.skillAgentId);
      return {
        agentId: run.skillAgentId ?? "unknown",
        agentLabel: agent?.label ?? run.roleLabel,
        status: run.status,
        ...(run.error ? { error: run.error } : {}),
      };
    });
  if (args.automatic && reports.length === 0 && failureNotices.length === 0) {
    return { status: "waiting", invocation };
  }
  const contextRun = initialRuns.find((run) => run.preparation && run.changeContext) ?? null;
  if (!contextRun?.preparation || !contextRun.changeContext) {
    await args.review.failSkillInvocation(invocation.invocationId, "The immutable Review context was unavailable for Overview.");
    const failed = await args.review.getSkillInvocation(invocation.invocationId);
    return { status: "not_active", invocation: failed ?? invocation };
  }
  const parent = await args.review.getTab(invocation.parentThreadId);
  if (!parent || parent.removedAt || parent.mainSessionId !== invocation.mainSessionId) {
    await args.review.failSkillInvocation(invocation.invocationId, "The selected parent reviewer is unavailable.");
    const failed = await args.review.getSkillInvocation(invocation.invocationId);
    return { status: "not_active", invocation: failed ?? invocation };
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
  const launchProvenance = await resolveNewEnvReviewLaunchProvenance(
    args.env,
    parent.provider,
  );
  const assigned = await args.review.assignSkillOverview({
    invocationId: invocation.invocationId,
    overviewRunId: crypto.randomUUID(),
    expectedOverviewMode: invocation.overviewMode,
    expectedIncludedMessageIds: invocation.includedMessageIds,
    payload,
    provider: parent.provider,
    model: parent.model,
    effort: parent.effort,
    roleLabel: `${invocation.definitionSnapshot.label} Overview`,
    preparation: contextRun.preparation,
    changeContext: contextRun.changeContext,
    planBasis: contextRun.planBasis,
    prompt: overviewPrompt({ contextRun: { ...contextRun, provider: parent.provider, model: parent.model }, payload }),
    launchProvenance,
  });
  if (!assigned) throw new Error("Skill invocation not found.");
  if (assigned.status === "controls_changed") {
    if ((args.retryCount ?? 0) >= 2) return { status: "waiting", invocation: assigned.invocation };
    return assignSkillOverview({ ...args, retryCount: (args.retryCount ?? 0) + 1 });
  }
  if (assigned.status === "created" && assigned.run) {
    await args.review.appendRunEvent({
      runId: assigned.run.runId,
      type: "run_queued",
      message: "Frozen skill Overview queued.",
      data: { invocationId: invocation.invocationId, mode: payload.mode, reportCount: reports.length },
    });
    await args.review.scheduleOrchestration();
  }
  if (assigned.status === "not_active") {
    return { status: "not_active", invocation: assigned.invocation };
  }
  return { status: assigned.status, invocation: assigned.invocation, run: assigned.run };
}
