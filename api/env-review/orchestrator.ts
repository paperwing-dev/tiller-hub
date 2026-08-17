import { loadEnvView } from "../env/view";
import { getThreadStub, getWorkspaceStub } from "../helpers";
import type { HubDO } from "../hub";
import { appendThreadMessage } from "../planner/runtime";
import type { PlannerRunRuntimeProvenance } from "../coordination";
import { REVIEWER_RUNTIME_STARTUP_MESSAGE } from "../reviewer-runtime-events";
import { loadRepo } from "../repo/access";
import type { Env } from "../types";
import {
  buildEnvReviewChangeContext,
  buildEnvReviewInspectionBundle,
  buildEnvReviewPrompt,
  normalizeEnvReviewPlanBasis,
  readEnvReviewPlanBasis,
} from "./context";
import {
  cleanupEnvReviewRunRuntime,
  destroyEnvReviewRuntimeJob,
  dispatchEnvReviewRun,
  resolveEnvReviewDispatchTarget,
} from "./dispatch";
import type { EnvReviewDO } from "./env-review-do";
import {
  ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES,
  ENV_REVIEW_SNAPSHOT_FORMAT_VERSION,
  ENV_REVIEW_INSPECTION_CONTENT_TYPE,
  ENV_REVIEW_SNAPSHOT_MAX_BYTES,
  buildReviewInspectionKey,
  buildReviewSnapshotTarFromWorkspace,
  normalizeReviewSnapshotDeletedPaths,
  r2ObjectToBytes,
  storeAndCompleteReviewSnapshot,
  TarBackedEnvReviewWorkspaceSource,
  validateReviewSnapshotTar,
} from "./snapshots";
import type {
  EnvReviewChangeContext,
  EnvReviewPlanBasis,
  EnvReviewPreparationOperation,
  EnvReviewPreparationResult,
  EnvReviewRun,
  EnvReviewSnapshotMode,
} from "./types";
import { assignSkillOverview, finalizeSuccessfulReviewOutput } from "./skill-orchestration";
import { getDurableObjectStub } from "../durable-object";
import {
  buildThreadMessageHistory,
  ENV_REVIEW_THREAD_CONTEXT_MESSAGE_LIMIT,
  listAllThreadMessages,
} from "../planner/context-window";

const ACTIVE_SYNC_TIMEOUT_MS = 130_000;

interface HubEnvReviewSnapshotSender {
  sendEnvReviewSnapshotRequest(
    sessionId: string,
    opId: string,
    envSlug: string,
    uploadToken: string,
    payload: {
      uploadUrl: string;
      snapshotMode: EnvReviewSnapshotMode;
      maxBytes: number;
      excludePrefixes: string[];
    },
  ): Promise<{ sent: boolean; error?: string }>;
}

function getHub(env: Env): HubEnvReviewSnapshotSender {
  return getDurableObjectStub<HubDO & HubEnvReviewSnapshotSender>(env, env.HUB, "hub");
}

function nowIso(): string {
  return new Date().toISOString();
}

function timeMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function preparationDeadlineMs(op: EnvReviewPreparationOperation): number {
  return timeMs(op.timeoutAt) ?? ((timeMs(op.startedAt) ?? Date.now()) + ACTIVE_SYNC_TIMEOUT_MS);
}

function nonTerminalRun(run: EnvReviewRun): boolean {
  return run.status !== "ready" && run.status !== "failed" && run.status !== "cancelled";
}

async function failRunsForPreparation(
  review: EnvReviewDO,
  opId: string,
  type: string,
  message: string,
): Promise<void> {
  const runs = await review.listRunsForPreparationOperation(opId);
  const invocationIds = new Set<string>();
  for (const run of runs) {
    if (run.skillInvocationId) invocationIds.add(run.skillInvocationId);
    if (!nonTerminalRun(run)) continue;
    await review.appendRunEvent({ runId: run.runId, type, message });
    await review.updateRun({
      runId: run.runId,
      status: "failed",
      completedAt: nowIso(),
      error: message,
    });
  }
  for (const invocationId of invocationIds) {
    await review.failSkillInvocation(invocationId, message);
  }
}

async function failPreparationOperation(
  review: EnvReviewDO,
  op: EnvReviewPreparationOperation,
  status: EnvReviewPreparationOperation["status"],
  type: string,
  message: string,
): Promise<void> {
  const result: EnvReviewPreparationResult = {
    formatVersion: ENV_REVIEW_SNAPSHOT_FORMAT_VERSION,
    status: "failed",
    opId: op.opId,
    changedCount: 0,
    deletedCount: 0,
    uploadedBytes: 0,
    completedAt: nowIso(),
    error: message,
  };
  await review.completePreparationOperation({
    opId: op.opId,
    result,
    status,
    error: message,
  });
  await failRunsForPreparation(review, op.opId, type, message);
}

function snapshotModeForMeta(meta: { scmModel?: string | null; githubBaseCommitSha?: string | null }): EnvReviewSnapshotMode {
  return meta.scmModel === "github" && meta.githubBaseCommitSha?.trim() ? "github-overlay" : "full";
}

function uploadUrlForOperation(requestUrl: string | null, op: EnvReviewPreparationOperation): string | null {
  if (!requestUrl) return null;
  const url = new URL(requestUrl);
  url.pathname = `/api/envs/${encodeURIComponent(op.envSlug)}/review/snapshots/${encodeURIComponent(op.opId)}`;
  url.search = "";
  return url.toString();
}

function savedSnapshotBlocked(meta: {
  status?: string | null;
  lifecyclePhase?: string | null;
  scmOperationType?: string | null;
  githubPublishStatus?: string | null;
}): string | null {
  const phase = meta.lifecyclePhase ?? meta.status ?? null;
  if (phase === "saving" || phase === "stopping") {
    return "Workspace persistence is active. Retry review after the environment finishes saving.";
  }
  if (meta.scmOperationType) {
    return `SCM operation ${meta.scmOperationType} is active. Retry review after it finishes.`;
  }
  if (meta.githubPublishStatus === "publishing") {
    return "GitHub publish is active. Retry review after it finishes.";
  }
  return null;
}

async function createSavedWorkspaceSnapshot(
  review: EnvReviewDO,
  env: Env,
  op: EnvReviewPreparationOperation,
  reason: string,
): Promise<void> {
  const meta = await loadEnvView(env, op.envSlug);
  if (!meta) {
    await failPreparationOperation(review, op, "failed", "preparation_failed", "Environment not found for saved review snapshot.");
    return;
  }
  const blocked = savedSnapshotBlocked(meta);
  if (blocked) {
    await failPreparationOperation(review, op, "failed", "preparation_failed", blocked);
    return;
  }

  try {
    const workspace = getWorkspaceStub(env, op.envSlug) as unknown as {
      globWorkspace(pattern: string): Promise<Array<{ path: string; type: string }>>;
      readWorkspaceFileBytes(path: string): Promise<Uint8Array | null>;
      readGitHubDeletedWorkspacePaths?(): Promise<string[]>;
    };
    const mode = snapshotModeForMeta(meta);
    const baseCommitSha = mode === "github-overlay" ? meta.githubBaseCommitSha?.trim() || null : null;
    const readDeletedPaths = workspace.readGitHubDeletedWorkspacePaths?.bind(workspace);
    if (mode === "github-overlay" && !readDeletedPaths) {
      throw new Error("GitHub deletion metadata is unavailable for saved review snapshot.");
    }
    const githubDeletedPaths = normalizeReviewSnapshotDeletedPaths(
      mode === "github-overlay"
        ? await readDeletedPaths!()
        : [],
    );
    const tarBytes = await buildReviewSnapshotTarFromWorkspace(workspace, {
      excludePrefixes: ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES,
      maxBytes: ENV_REVIEW_SNAPSHOT_MAX_BYTES,
    });
    const validated = await validateReviewSnapshotTar(tarBytes);
    const completed = await storeAndCompleteReviewSnapshot({
      bucket: env.BUCKET,
      review,
      op,
      source: "saved-workspace",
      mode,
      stale: true,
      tarBytes,
      validated,
      githubDeletedPaths,
      baseCommitSha,
    });
    if (completed.status !== "completed") {
      return;
    }
    for (const run of await review.listRunsForPreparationOperation(op.opId)) {
      if (run.status !== "preparing") continue;
      await review.appendRunEvent({
        runId: run.runId,
        type: "snapshot_saved",
        message: reason,
        data: { snapshotId: completed.snapshot.snapshotId, source: completed.snapshot.source, stale: true },
      });
    }
  } catch (error) {
    await failPreparationOperation(
      review,
      op,
      "failed",
      "snapshot_failed",
      `Saved workspace snapshot unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  await review.scheduleOrchestration();
}

async function processActivePreparation(
  review: EnvReviewDO,
  env: Env,
  op: EnvReviewPreparationOperation,
): Promise<number | null> {
  const now = Date.now();
  const deadline = preparationDeadlineMs(op);
  if (now >= deadline) {
    const message = "Live snapshot failed. Retry review.";
    await failPreparationOperation(review, op, "timed_out", "snapshot_failed", message);
    return null;
  }

  if (op.snapshotRequestedAt) {
    return deadline;
  }

  const meta = await loadEnvView(env, op.envSlug);
  if (!meta) {
    await failPreparationOperation(review, op, "failed", "preparation_failed", "Environment not found for review snapshot.");
    return null;
  }
  const uploadUrl = uploadUrlForOperation(op.requestUrl, op);
  if (!uploadUrl) {
    await failPreparationOperation(review, op, "failed", "preparation_failed", "Review snapshot upload URL is unavailable.");
    return null;
  }
  const uploadToken = op.ackToken ?? crypto.randomUUID();
  const requestedAt = nowIso();
  const snapshotMode = snapshotModeForMeta(meta);
  const snapshotRequest = {
    snapshotMode,
    baseCommitSha: snapshotMode === "github-overlay" ? meta.githubBaseCommitSha?.trim() || null : null,
    maxBytes: ENV_REVIEW_SNAPSHOT_MAX_BYTES,
    excludePrefixes: [...ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES],
  };
  await review.markPreparationRequestAttempt({
    opId: op.opId,
    ackToken: uploadToken,
    requestedAt,
    snapshotRequest,
  });
  const sent = await getHub(env).sendEnvReviewSnapshotRequest(op.sessionId, op.opId, op.envSlug, uploadToken, {
    uploadUrl,
    snapshotMode: snapshotRequest.snapshotMode,
    maxBytes: snapshotRequest.maxBytes,
    excludePrefixes: snapshotRequest.excludePrefixes,
  })
    .catch((error: unknown) => ({
      sent: false,
      error: error instanceof Error ? error.message : String(error),
    }));

  if (sent.sent) {
    for (const run of await review.listRunsForPreparationOperation(op.opId)) {
      if (run.status !== "preparing") continue;
      await review.appendRunEvent({
        runId: run.runId,
        type: "snapshot_requested",
        message: "Review snapshot requested from the live harness.",
        data: { attempt: op.snapshotAttempts + 1 },
      });
    }
  }

  if (!sent.sent) {
    await createSavedWorkspaceSnapshot(
      review,
      env,
      op,
      "Live harness disconnected. Reviewing latest saved workspace.",
    );
    return null;
  }

  return deadline;
}

async function loadSnapshotWorkspaceSource(env: Env, preparation: EnvReviewPreparationResult): Promise<TarBackedEnvReviewWorkspaceSource> {
  if (!preparation.snapshot) {
    throw new Error("Reviewer needs a fresh snapshot. Start a fresh reviewer run.");
  }
  const object = await env.BUCKET.get(preparation.snapshot.r2Key);
  if (!object) {
    throw new Error("Reviewer snapshot is unavailable. Start a fresh reviewer run.");
  }
  const source = new TarBackedEnvReviewWorkspaceSource(
    await r2ObjectToBytes(object),
    preparation.snapshot.githubDeletedPaths,
  );
  await source.getHashedManifest();
  return source;
}

function priorMessagesFromThread(messages: Array<{ senderSessionId: string; body: unknown }>, truncated: boolean) {
  const prior = messages
    .map((message) => {
      const body = message.body as { role?: unknown; text?: unknown } | undefined;
      return {
        role: typeof body?.role === "string" ? body.role : message.senderSessionId,
        text: typeof body?.text === "string" ? body.text : JSON.stringify(message.body),
      };
    });
  if (truncated) {
    prior.unshift({ role: "system", text: "[Earlier eligible reviewer messages were omitted by the context window.]" });
  }
  return prior;
}

function currentInstructionForRun(run: EnvReviewRun): string | undefined {
  const instruction = run.customTask?.trim();
  if (!instruction || !run.skillInvocationId) return undefined;
  const configuredInstruction = run.skillDefinitionSnapshot?.agents
    .find((agent) => agent.id === run.skillAgentId)
    ?.instructions.trim();
  return instruction === configuredInstruction ? undefined : instruction;
}

async function queueRunIfNeeded(args: {
  review: EnvReviewDO;
  env: Env;
  run: EnvReviewRun;
  preparation: EnvReviewPreparationResult;
  changeContext: EnvReviewChangeContext;
  planBasis: Awaited<ReturnType<typeof readEnvReviewPlanBasis>> | null;
}): Promise<EnvReviewRun | null> {
  if (args.run.status === "queued" && args.run.prompt) return args.run;
  if (args.run.status !== "preparing" && args.run.status !== "queued") return null;

  const threadMessages = await listAllThreadMessages(getThreadStub(args.env, args.run.threadId));
  const history = buildThreadMessageHistory(threadMessages, args.run.runId, {
    messageLimit: ENV_REVIEW_THREAD_CONTEXT_MESSAGE_LIMIT,
  });
  const prompt = buildEnvReviewPrompt({
    run: args.run,
    changeContext: args.changeContext,
    planBasis: normalizeEnvReviewPlanBasis(args.planBasis),
    recipeInstructions: args.run.recipeInstructions ?? undefined,
    currentInstruction: currentInstructionForRun(args.run),
    priorMessages: priorMessagesFromThread(history.messages, history.truncated),
  });
  const queued = await args.review.updateRun({
    runId: args.run.runId,
    status: "queued",
    preparation: args.preparation,
    changeContext: args.changeContext,
    planBasis: normalizeEnvReviewPlanBasis(args.planBasis),
    prompt,
    queuedAt: args.run.queuedAt ?? nowIso(),
    error: null,
  });
  await args.review.appendRunEvent({
    runId: args.run.runId,
    type: "run_queued",
    message: "Reviewer run queued with frozen workspace snapshot.",
    data: {
      preparationCompletedAt: args.preparation.completedAt,
      changedFiles: args.changeContext.summary.total,
      snapshotId: args.preparation.snapshot?.snapshotId,
      snapshotSource: args.preparation.snapshot?.source,
    },
  });
  return queued;
}

async function executeFakeEnvReviewRun(env: Env, review: EnvReviewDO, run: EnvReviewRun): Promise<void> {
  await review.updateRun({ runId: run.runId, status: "running" });
  await review.appendRunEvent({ runId: run.runId, type: "runtime_startup", message: REVIEWER_RUNTIME_STARTUP_MESSAGE });
  const text = [
    `## ${run.roleLabel}`,
    "",
    "Fake env-review feedback.",
    "",
    `Workspace snapshot prepared at ${run.preparation?.completedAt ?? "unknown"}.`,
    `Changed files in prompt: ${run.changeContext?.summary.total ?? 0}.`,
    "",
    "No real provider executed for this development reviewer.",
  ].join("\n");
  const message = await appendThreadMessage(getThreadStub(env, run.threadId), "assistant", text, [], {
    id: `env-review-result:${run.runId}`,
    runId: run.runId,
  });
  await finalizeSuccessfulReviewOutput({
    env,
    review,
    run,
    message,
    eventMessage: "Fake reviewer feedback is ready.",
  });
}

async function processDispatchablePreparation(
  review: EnvReviewDO,
  env: Env,
  op: EnvReviewPreparationOperation,
): Promise<void> {
  const preparation = op.result;
  if (!preparation || op.status !== "succeeded" || preparation.status !== "succeeded") {
    await failRunsForPreparation(review, op.opId, "preparation_failed", op.error || preparation?.error || "Review preparation failed.");
    return;
  }
  if (!preparation.snapshot) {
    await failRunsForPreparation(review, op.opId, "context_failed", "Reviewer needs a fresh snapshot. Start a fresh reviewer run.");
    return;
  }

  const meta = await loadEnvView(env, op.envSlug);
  if (!meta) {
    await failRunsForPreparation(review, op.opId, "context_failed", "Environment not found for reviewer context.");
    return;
  }
  const loadedRepo = await loadRepo(env, meta.repoId);
  if (!loadedRepo.ok) {
    await failRunsForPreparation(review, op.opId, "context_failed", loadedRepo.body.error);
    return;
  }

  const operationRuns = await review.listRunsForPreparationOperation(op.opId);
  const pinnedInitialContext = new Map<string, {
    preparation: EnvReviewPreparationResult;
    changeContext: EnvReviewChangeContext;
    planBasis: EnvReviewPlanBasis | null;
  }>();
  for (const run of operationRuns) {
    if (
      run.skillInvocationId
      && (run.skillRunRole === "root_initial" || run.skillRunRole === "report_initial")
      && run.preparation
      && run.changeContext
      && !pinnedInitialContext.has(run.skillInvocationId)
    ) {
      pinnedInitialContext.set(run.skillInvocationId, {
        preparation: run.preparation,
        changeContext: run.changeContext,
        planBasis: run.planBasis,
      });
    }
  }
  const requiresFreshContext = operationRuns.some((run) =>
    (run.status === "preparing" || run.status === "queued")
      && !run.prompt
      && !(run.skillInvocationId
        && (run.skillRunRole === "root_initial" || run.skillRunRole === "report_initial")
        && pinnedInitialContext.has(run.skillInvocationId))
  );
  let changeContext: EnvReviewChangeContext | null = null;
  let planBasis: Awaited<ReturnType<typeof readEnvReviewPlanBasis>> | null = null;
  if (requiresFreshContext) {
    try {
      const snapshotWorkspace = await loadSnapshotWorkspaceSource(env, preparation);
      const changeContextPromise = buildEnvReviewChangeContext({
        env,
        repo: loadedRepo.repo,
        meta,
        envWorkspace: snapshotWorkspace,
        githubBaseCommitSha: preparation.snapshot.baseCommitSha,
        allowGitHubBaseFallback: false,
      });
      const inspectionBundlePromise = changeContextPromise.then((nextChangeContext) => (
        buildEnvReviewInspectionBundle({
          env,
          repo: loadedRepo.repo,
          meta,
          envWorkspace: snapshotWorkspace,
          githubBaseCommitSha: preparation.snapshot.baseCommitSha,
          allowGitHubBaseFallback: false,
          changeContext: nextChangeContext,
        })
      ));
      const [nextChangeContext, nextPlanBasis, inspectionBundle] = await Promise.all([
        changeContextPromise,
        readEnvReviewPlanBasis({
          env,
          repo: loadedRepo.repo,
          planArtifactId: meta.startupPlanId,
        }),
        inspectionBundlePromise,
      ]);
      changeContext = nextChangeContext;
      planBasis = nextPlanBasis;
      await env.BUCKET.put(
        buildReviewInspectionKey(meta.slug, preparation.snapshot.snapshotId),
        inspectionBundle.tarBytes,
        {
          httpMetadata: { contentType: ENV_REVIEW_INSPECTION_CONTENT_TYPE },
          customMetadata: {
            envSlug: meta.slug,
            snapshotId: preparation.snapshot.snapshotId,
            snapshotHash: preparation.snapshot.snapshotHash,
            formatVersion: String(inspectionBundle.manifest.formatVersion),
          },
        },
      );
    } catch (error) {
      await failRunsForPreparation(
        review,
        op.opId,
        "context_failed",
        `Failed to build reviewer context: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }

    await review.recordChangeSummary({
      envSlug: meta.slug,
      mainSessionId: op.sessionId,
      opId: preparation.opId,
      summary: changeContext.summary,
    });
    await review.updatePreparationResult({ opId: op.opId, result: preparation, changeSummary: changeContext.summary });
  }

  for (const run of operationRuns) {
    if (run.status === "ready" || run.status === "failed" || run.status === "cancelled" || run.runtime) {
      continue;
    }
    let queued: EnvReviewRun | null;
    try {
      if (run.status === "queued" && run.prompt) {
        // Linked follow-ups and Overview turns arrive with their immutable
        // context and prompt already pinned. Ordinary queued runs can also be
        // retried here without rebuilding a prompt.
        queued = run;
      } else {
        const siblingContext = run.skillInvocationId
          && (run.skillRunRole === "root_initial" || run.skillRunRole === "report_initial")
          ? pinnedInitialContext.get(run.skillInvocationId) ?? null
          : null;
        const frozenChangeContext = run.changeContext ?? siblingContext?.changeContext ?? changeContext;
        const linkedFrozenTurn = run.skillRunRole === "root_followup"
          || run.skillRunRole === "report_followup"
          || run.skillRunRole === "overview";
        const frozenPlanBasis = linkedFrozenTurn
          ? run.planBasis
          : siblingContext
            ? siblingContext.planBasis
            : (run.planBasis ?? planBasis);
        if (!frozenChangeContext) {
          throw new Error("Frozen reviewer context is unavailable.");
        }
        queued = await queueRunIfNeeded({
          review,
          env,
          run,
          preparation: run.preparation ?? siblingContext?.preparation ?? preparation,
          changeContext: frozenChangeContext,
          planBasis: frozenPlanBasis,
        });
      }
    } catch (error) {
      const message = `Failed to prepare reviewer prompt: ${error instanceof Error ? error.message : String(error)}`;
      await review.appendRunEvent({ runId: run.runId, type: "context_failed", message });
      await review.updateRun({ runId: run.runId, status: "failed", completedAt: nowIso(), error: message });
      continue;
    }
    if (!queued) continue;

    if (queued.provider === "fake") {
      await executeFakeEnvReviewRun(env, review, queued);
      continue;
    }

    if (!op.requestUrl) {
      const message = "Review run cannot be dispatched because the preparation operation has no request URL.";
      await review.appendRunEvent({ runId: queued.runId, type: "run_failed", message });
      await review.updateRun({ runId: queued.runId, status: "failed", completedAt: nowIso(), error: message });
      continue;
    }

    try {
      const target = await resolveEnvReviewDispatchTarget(env, queued);
      const targetRuntime: PlannerRunRuntimeProvenance = {
        jobSlug: target.jobSlug,
      };
      const preparedRun = await review.updateRun({ runId: queued.runId, runtime: targetRuntime });
      if (!preparedRun || preparedRun.status === "ready" || preparedRun.status === "failed" || preparedRun.status === "cancelled") {
        continue;
      }
      const runtime = await dispatchEnvReviewRun({
        env,
        requestUrl: op.requestUrl,
        run: queued,
        repoUrl: loadedRepo.repo.meta.repoUrl,
        githubFullName: loadedRepo.repo.meta.githubFullName,
        githubBaseCommitSha: preparation.snapshot.baseCommitSha,
        target,
      });
      const currentRun = await review.getRun(queued.runId);
      if (!currentRun || currentRun.status === "ready" || currentRun.status === "failed" || currentRun.status === "cancelled") {
        const cleanup = currentRun?.runtime
          ? cleanupEnvReviewRunRuntime(env, review, currentRun)
          : destroyEnvReviewRuntimeJob(env, runtime, target);
        await cleanup.catch((cleanupError) => {
          console.error(`[env-review] job cleanup failed for cancelled run ${queued.runId}:`, cleanupError);
        });
        continue;
      }
      if (runtime.jobSlug !== targetRuntime.jobSlug) {
        await review.updateRun({ runId: queued.runId, runtime });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await review.appendRunEvent({ runId: queued.runId, type: "run_failed", message });
      const failed = await review.updateRun({
        runId: queued.runId,
        status: "failed",
        completedAt: nowIso(),
        error: message,
      });
      if (failed?.runtime) {
        await cleanupEnvReviewRunRuntime(env, review, failed).catch((cleanupError) => {
          console.error(`[env-review] job cleanup failed for run ${queued.runId}:`, cleanupError);
        });
      }
    }
  }
  const invocationIds = new Set(operationRuns
    .filter((run) => run.skillInvocationId
      && (run.skillRunRole === "root_initial" || run.skillRunRole === "report_initial"))
    .map((run) => run.skillInvocationId!));
  for (const invocationId of invocationIds) {
    const invocation = await review.getSkillInvocation(invocationId);
    if (invocation?.definitionSnapshot.agents.length === 1) continue;
    await assignSkillOverview({ env, review, invocationId, automatic: true }).catch((error) => {
      console.error(`[env-review] automatic Overview check failed for ${invocationId}:`, error);
    });
  }
}

export async function processEnvReviewOrchestration(review: EnvReviewDO, env: Env): Promise<void> {
  let nextAlarmAt: number | null = null;
  for (const op of await review.listActivePreparationOperations()) {
    const next = await processActivePreparation(review, env, op);
    if (next != null) nextAlarmAt = nextAlarmAt == null ? next : Math.min(nextAlarmAt, next);
  }

  for (const op of await review.listDispatchablePreparationOperations()) {
    await processDispatchablePreparation(review, env, op);
  }

  if (nextAlarmAt != null) {
    await review.scheduleOrchestration(Math.max(0, nextAlarmAt - Date.now()));
  }
}
