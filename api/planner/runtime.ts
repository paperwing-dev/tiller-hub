import {
  renderArtifactBodyMarkdown,
  type ArtifactStoreDO,
  type PlanArtifact,
  type PlannerRun,
  type PlannerRunRuntimeProvenance,
  type ThreadDO,
  type FinishActiveReviewerRunResult,
  type PlanHealthSkillResult,
  type ReviewerTerminalOutput,
} from "../coordination";
import { REVIEWER_RUNTIME_STARTUP_MESSAGE } from "../reviewer-runtime-events";
import { PLAN_HEALTH_TRANSPORT_INSTRUCTION } from "./plan-health";

// Statuses that hold the one-active-run slot for a one-shot reviewer run.
export function isActiveRun(run: PlannerRun): boolean {
  return (
    run.status === "queued" ||
    run.status === "running" ||
    run.status === "saving"
  );
}

export interface ExecuteReviewerRunOptions {
  artifactStore: ArtifactStoreDO;
  thread: ThreadDO;
  run: PlannerRun;
}

interface PlannerProviderAdapter {
  runReviewer(options: {
    plan: PlanArtifact;
    skill: string;
    skillInstructions: string;
    instruction?: string | null;
  }): Promise<string> | string;
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensurePlan(value: unknown): PlanArtifact {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { type?: string }).type !== "plan"
  ) {
    throw new Error("Plan artifact not found");
  }
  return value as PlanArtifact;
}

function planAtRunBasis(plan: PlanArtifact, run: PlannerRun): PlanArtifact {
  const basis = run.input?.basis;
  if (!basis) return plan;
  return {
    ...plan,
    title: basis.title,
    body: { markdown: basis.markdown },
    version: basis.version,
    basis: { ...plan.basis, mainCommit: basis.gitBaseCommitSha },
  };
}

const PROVIDER_ADAPTERS: Record<string, PlannerProviderAdapter> = {
  fake: {
    runReviewer: ({ plan, skill, skillInstructions, instruction }) =>
      skillInstructions.includes(PLAN_HEALTH_TRANSPORT_INSTRUCTION)
        ? JSON.stringify({
            risk: {
              level: "medium",
              summary:
                "The plan coordinates multiple components and requires careful rollout, but it retains a feasible rollback path.",
            },
            changeSize: {
              size: "medium",
              summary:
                "The work spans several coordinated components but remains one coherent phase.",
            },
          })
        : buildFakeReviewText(plan, skill, skillInstructions, instruction),
  },
};

function getProviderAdapter(provider: string): PlannerProviderAdapter {
  const adapter = PROVIDER_ADAPTERS[provider];
  if (!adapter) {
    throw new Error(
      `One-shot reviewer provider is not executable in-process: ${provider}`,
    );
  }
  return adapter;
}

async function appendRunEvent(
  artifactStore: ArtifactStoreDO,
  run: PlannerRun,
  type: string,
  message?: string,
  data?: unknown,
) {
  return await artifactStore.appendPlannerRunEvent({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    type,
    ...(message ? { message } : {}),
    ...(data === undefined ? {} : { data }),
  });
}

export async function executeReviewerRun(
  options: ExecuteReviewerRunOptions,
): Promise<PlannerRun> {
  const { artifactStore, thread, run } = options;
  let plan: PlanArtifact;
  let text: string;
  if (run.role !== "reviewer") {
    throw new Error("Only reviewer runs may use one-shot execution.");
  }
  const claimed = await artifactStore.claimQueuedPlannerRunForInProcess(
    run.runId,
  );
  if (!claimed) {
    return (await artifactStore.getPlannerRun(run.runId)) ?? run;
  }
  try {
    await appendRunEvent(
      artifactStore,
      claimed,
      "runtime_startup",
      REVIEWER_RUNTIME_STARTUP_MESSAGE,
    );
    const adapter = getProviderAdapter(claimed.provider);
    plan = planAtRunBasis(
      ensurePlan(await artifactStore.getArtifact(claimed.planArtifactId)),
      claimed,
    );
    text = await adapter.runReviewer({
      plan,
      skill: claimed.skill ?? "plan-review",
      skillInstructions: claimed.input?.skillSnapshot?.instructions ?? "",
      instruction: claimed.input?.instruction ?? null,
    });
  } catch (error) {
    const message = summarizeError(error);
    const finished = await completeReviewerOutput({
      artifactStore,
      thread,
      run: claimed,
      output: { status: "failed", error: message },
    });
    return finished.run;
  }
  // From saving onward, completion is a resumable commit protocol. A failure
  // here must never be reclassified as a provider failure.
  const finished = await completeReviewerOutput({
    artifactStore,
    thread,
    run: claimed,
    output: { status: "succeeded", text },
  });
  return finished.run;
}

function buildFakeReviewText(
  plan: PlanArtifact,
  skill: string,
  skillInstructions: string,
  instruction?: string | null,
): string {
  const markdown = renderArtifactBodyMarkdown(plan.body).trim();
  return [
    `Fake ${skill} feedback`,
    "",
    ...(instruction?.trim()
      ? ["Reviewer instruction:", instruction.trim(), ""]
      : []),
    skillInstructions,
    "",
    markdown
      ? "The plan is readable. Verify the implementation order, storage migrations, API compatibility, UI polling, and regression tests before execution."
      : "The plan body is empty. Ask the writer to create a concrete implementation plan before starting execution.",
  ].join("\n");
}

export async function appendThreadMessage(
  thread: ThreadDO,
  role: "user" | "assistant",
  text: string,
  artifactIds: string[] = [],
  options: { id?: string; runId?: string; planVersion?: number } = {},
) {
  const latest = (await thread.listMessages({ limit: 1 }))[0];
  return await thread.appendMessage({
    ...(options.id ? { id: options.id } : {}),
    senderSessionId: role,
    seq: (latest?.seq ?? 0) + 1,
    kind: "chat",
    body: {
      role,
      text,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(typeof options.planVersion === "number"
        ? { planVersion: options.planVersion }
        : {}),
    },
    ...(artifactIds.length > 0 ? { artifactIds } : {}),
  });
}

export async function completeActiveReviewerRun(options: {
  artifactStore: ArtifactStoreDO;
  thread: ThreadDO;
  run: PlannerRun;
  text: string;
}): Promise<FinishActiveReviewerRunResult> {
  const { artifactStore, thread, run, text } = options;
  const saving = await artifactStore.claimPlannerRunSaving(run.runId);
  if (!saving) {
    return {
      run: (await artifactStore.getPlannerRun(run.runId)) ?? run,
      finalized: false,
    };
  }
  await appendThreadMessage(thread, "assistant", text, [run.planArtifactId], {
    id: `reviewer-result:${run.runId}`,
    runId: run.runId,
    planVersion: run.input?.sourcePlanVersion,
  });
  return await artifactStore.finishActiveReviewerRun({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    status: "completed",
    completedAt: new Date().toISOString(),
    error: null,
    events: [
      {
        type: "contribution_candidate",
        message: "Reviewer feedback is ready to send to the writer.",
        data: { text },
      },
      { type: "run_completed", message: "Reviewer run completed." },
    ],
  });
}

export interface CompleteReviewerOutputResult extends FinishActiveReviewerRunResult {
  structured: boolean;
  result?: PlanHealthSkillResult;
  error?: string;
}

export async function completeReviewerOutput(options: {
  artifactStore: ArtifactStoreDO;
  thread?: ThreadDO | null;
  run: PlannerRun;
  output: ReviewerTerminalOutput;
  expectedRuntime?: PlannerRunRuntimeProvenance | null;
  staleActiveCutoff?: string;
}): Promise<CompleteReviewerOutputResult> {
  const structured =
    await options.artifactStore.completePlanHealthReviewerOutput(
      options.run.runId,
      options.output,
      {
        expectedRuntime: options.expectedRuntime,
        staleActiveCutoff: options.staleActiveCutoff,
      },
    );
  if (structured.handled) {
    return {
      run: structured.run,
      finalized: structured.finalized,
      structured: true,
      ...(structured.result ? { result: structured.result } : {}),
      ...(structured.error ? { error: structured.error } : {}),
    };
  }
  if (options.output.status === "failed") {
    const failed = options.staleActiveCutoff
      ? await finalizeStaleReviewerRunFailure(
          options.artifactStore,
          options.run,
          options.output.error,
          options.staleActiveCutoff,
        )
      : await finalizeReviewerRunFailure(
          options.artifactStore,
          options.run,
          options.output.error,
          { expectedRuntime: options.expectedRuntime },
        );
    return { ...failed, structured: false };
  }
  const text = options.output.text.trim();
  if (!text || !options.thread) {
    const failed = await finalizeReviewerRunFailure(
      options.artifactStore,
      options.run,
      !text
        ? "Reviewer returned no feedback text."
        : "Reviewer run has no thread.",
    );
    return { ...failed, structured: false };
  }
  const completed = await completeActiveReviewerRun({
    artifactStore: options.artifactStore,
    thread: options.thread,
    run: options.run,
    text,
  });
  return { ...completed, structured: false };
}

export async function finalizeReviewerRunFailure(
  artifactStore: ArtifactStoreDO,
  run: PlannerRun,
  error: string,
  options: { expectedRuntime?: PlannerRunRuntimeProvenance | null } = {},
): Promise<FinishActiveReviewerRunResult> {
  return await artifactStore.finishActiveReviewerRun({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    status: "failed",
    completedAt: new Date().toISOString(),
    error,
    ...(options.expectedRuntime === undefined
      ? {}
      : { expectedRuntime: options.expectedRuntime }),
    events: [{ type: "run_failed", message: error }],
  });
}

export async function finalizeStaleReviewerRunFailure(
  artifactStore: ArtifactStoreDO,
  run: PlannerRun,
  error: string,
  staleActiveCutoff: string,
): Promise<FinishActiveReviewerRunResult> {
  return await artifactStore.finishActiveReviewerRun({
    runId: run.runId,
    repoId: run.repoId,
    planArtifactId: run.planArtifactId,
    status: "failed",
    completedAt: new Date().toISOString(),
    error,
    staleActiveCutoff,
    events: [{ type: "run_failed", message: error }],
  });
}
