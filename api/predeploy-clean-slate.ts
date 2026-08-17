import {
  getArtifactStoreStub,
  getEnvLifecycleStub,
  getEnvReviewStub,
} from "./helpers";
import {
  listEnvDefinitionSlugs,
  listRepoIndexRepoIdsStrict,
  readEnvDefinition,
} from "./plan/store";
import { loadTrackedRepo } from "./repo/access";
import type { Env, StoredSession } from "./types";

export type PredeployBlockerKind =
  | "environment_definition"
  | "pending_environment_cleanup"
  | "environment_review_record"
  | "active_environment_review"
  | "retained_environment_review_runtime"
  | "active_github_publish"
  | "planner_run_record"
  | "active_planner_run"
  | "retained_planner_runtime"
  | "plan_writer_record"
  | "active_plan_writer"
  | "retained_plan_writer_runtime"
  | "pending_plan_writer_cleanup"
  | "pending_plan_runtime_cleanup"
  | "hub_session_record"
  | "active_hub_session"
  | "routable_hub_session";

export interface PredeployBlocker {
  kind: PredeployBlockerKind;
  resourceId: string;
}

export interface PredeployCleanSlateStatus {
  ok: boolean;
  blockers: PredeployBlocker[];
}

export interface PredeployHubSessionState {
  sessions: StoredSession[];
  routableSessionIds: string[];
}

const ACTIVE_RUN_STATES = new Set(["syncing", "preparing", "queued", "running", "saving"]);

/**
 * Strict read-only release gate. It never stops, deletes, repairs, or migrates
 * a workload; callers must use the normal lifecycle while its stored backend
 * is still available, then retry.
 */
export async function inspectPredeployCleanSlate(
  env: Env,
  hubState: PredeployHubSessionState,
): Promise<PredeployCleanSlateStatus> {
  const [envSlugs, repoIds] = await Promise.all([
    listEnvDefinitionSlugs(env),
    listRepoIndexRepoIdsStrict(env),
  ]);
  const blockers: PredeployBlocker[] = [];
  for (const session of hubState.sessions) {
    if (!session?.id) throw new Error("Hub session state is malformed.");
    blockers.push({ kind: "hub_session_record", resourceId: session.id });
    if (session.active === 1 && session.ended_at === null) {
      blockers.push({ kind: "active_hub_session", resourceId: session.id });
    }
  }
  for (const sessionId of hubState.routableSessionIds) {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("Routable Hub session state is malformed.");
    }
    blockers.push({ kind: "routable_hub_session", resourceId: sessionId });
  }

  for (const slug of [...envSlugs].sort()) {
    const definition = await readEnvDefinition(env, slug);
    if (!definition) {
      throw new Error(`Environment definition ${slug} disappeared during predeploy inspection.`);
    }
    blockers.push({ kind: "environment_definition", resourceId: slug });

    const lifecycle = getEnvLifecycleStub(env, slug);
    const [mutable, reviews, publish] = await Promise.all([
      lifecycle.peekMutableState(),
      getEnvReviewStub(env, slug).listWorkloadStateForPredeploy(),
      lifecycle.getGitHubPublishOperation(),
    ]);
    if (!mutable || typeof mutable.status !== "string") {
      throw new Error(`Environment ${slug} has unreadable lifecycle state.`);
    }
    if (mutable.scheduledRun?.cleanupRequired === true) {
      blockers.push({ kind: "pending_environment_cleanup", resourceId: slug });
    }
    for (const review of reviews) {
      if (!review?.runId || typeof review.status !== "string" || typeof review.hasRuntime !== "boolean") {
        throw new Error(`Environment ${slug} has malformed review workload state.`);
      }
      blockers.push({ kind: "environment_review_record", resourceId: review.runId });
      if (ACTIVE_RUN_STATES.has(review.status)) {
        blockers.push({ kind: "active_environment_review", resourceId: review.runId });
      }
      if (review.hasRuntime) {
        blockers.push({
          kind: "retained_environment_review_runtime",
          resourceId: review.runId,
        });
      }
    }
    if (publish?.operationId) {
      blockers.push({
        kind: "active_github_publish",
        resourceId: publish.operationId,
      });
    }
  }

  for (const repoId of [...repoIds].sort()) {
    const loaded = await loadTrackedRepo(env, repoId);
    if (!loaded.ok || loaded.repo.meta.repoId !== repoId) {
      throw new Error(`Repository ${repoId} has unreadable indexed state.`);
    }
    const artifactStore = getArtifactStoreStub(
      env,
      repoId,
      loaded.repo.meta.artifactStoreGeneration,
    );
    const [runs, writers, runtimeCleanupTargets] = await Promise.all([
      artifactStore.listPlannerWorkloadStateForPredeploy(repoId),
      artifactStore.listPlanWritersForRepo(repoId),
      artifactStore.listPlanRuntimeCleanupTargetsForRepo(repoId),
    ]);
    for (const run of runs) {
      if (!run?.runId || typeof run.status !== "string" || typeof run.hasRuntime !== "boolean") {
        throw new Error(`Repository ${repoId} has malformed planner workload state.`);
      }
      blockers.push({ kind: "planner_run_record", resourceId: run.runId });
      if (ACTIVE_RUN_STATES.has(run.status)) {
        blockers.push({ kind: "active_planner_run", resourceId: run.runId });
      }
      if (run.hasRuntime) {
        blockers.push({ kind: "retained_planner_runtime", resourceId: run.runId });
      }
    }
    for (const writer of writers) {
      if (!writer?.threadId) {
        throw new Error(`Repository ${repoId} has malformed Plan Writer state.`);
      }
      blockers.push({ kind: "plan_writer_record", resourceId: writer.threadId });
      if (!writer.stoppedAt && !writer.removedAt) {
        blockers.push({ kind: "active_plan_writer", resourceId: writer.threadId });
      }
      if (writer.runtime || writer.jobSlug) {
        blockers.push({
          kind: "retained_plan_writer_runtime",
          resourceId: writer.threadId,
        });
      }
      if (writer.cleanupError) {
        blockers.push({
          kind: "pending_plan_writer_cleanup",
          resourceId: writer.threadId,
        });
      }
    }
    for (const target of runtimeCleanupTargets) {
      if (!target?.cleanupId || target.repoId !== repoId) {
        throw new Error(`Repository ${repoId} has malformed plan runtime cleanup state.`);
      }
      blockers.push({
        kind: "pending_plan_runtime_cleanup",
        resourceId: target.cleanupId,
      });
    }
  }

  return { ok: blockers.length === 0, blockers };
}
