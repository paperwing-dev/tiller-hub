import {
  renderArtifactBodyMarkdown,
  type ArtifactStoreDO,
  type PlanArtifact,
  type PlannerRun,
  type ThreadDO,
} from "../coordination";
import { REVIEWER_RUNTIME_STARTUP_MESSAGE } from "../reviewer-runtime-events";

// Statuses that hold the one-active-run slot for a one-shot reviewer run.
export function isActiveRun(run: PlannerRun): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "saving";
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
  if (!value || typeof value !== "object" || (value as { type?: string }).type !== "plan") {
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
      buildFakeReviewText(plan, skill, skillInstructions, instruction),
  },
};

function getProviderAdapter(provider: string): PlannerProviderAdapter {
  const adapter = PROVIDER_ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`One-shot reviewer provider is not executable in-process: ${provider}`);
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

export async function executeReviewerRun(options: ExecuteReviewerRunOptions): Promise<PlannerRun> {
  const { artifactStore, thread, run } = options;
  try {
    if (run.role !== "reviewer") {
      throw new Error("Only reviewer runs may use one-shot execution.");
    }
    const runningRun = await artifactStore.updateActivePlannerRun({ runId: run.runId, status: "running" });
    if (runningRun.status === "cancelled") return runningRun;
    await appendRunEvent(artifactStore, run, "runtime_startup", REVIEWER_RUNTIME_STARTUP_MESSAGE);
    const adapter = getProviderAdapter(run.provider);
    const plan = planAtRunBasis(ensurePlan(await artifactStore.getArtifact(run.planArtifactId)), run);
    const text = await adapter.runReviewer({
      plan,
      skill: run.skill ?? "plan-review",
      skillInstructions: run.input?.skillSnapshot?.instructions ?? "",
      instruction: run.input?.instruction ?? null,
    });
    await appendThreadMessage(thread, "assistant", text, [plan.id], {
      runId: run.runId,
      planVersion: run.input?.sourcePlanVersion,
    });
    await appendRunEvent(artifactStore, run, "contribution_candidate", "Reviewer feedback is ready to send to the writer.", {
      text,
    });
    await appendRunEvent(artifactStore, run, "run_completed", "Reviewer run completed.");
    return await artifactStore.updateActivePlannerRun({
      runId: run.runId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = summarizeError(error);
    await appendRunEvent(artifactStore, run, "run_failed", message).catch(() => undefined);
    return await artifactStore.updateActivePlannerRun({
      runId: run.runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: message,
    });
  }
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
    ...(instruction?.trim() ? ["Reviewer instruction:", instruction.trim(), ""] : []),
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
      ...(typeof options.planVersion === "number" ? { planVersion: options.planVersion } : {}),
    },
    ...(artifactIds.length > 0 ? { artifactIds } : {}),
  });
}
