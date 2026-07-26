// Shared helpers used across env/routes.ts and workspace/routes.ts

import type { Env } from "./types";
import type { ArtifactStoreDO } from "./coordination";
import type { EnvReviewDO } from "./env-review/env-review-do";
import type { EnvLifecycleDO } from "./env-lifecycle-do";
import type { ScheduledRunCapacityDO } from "./scheduled-run-capacity-do";
import type { GitHubJobDO } from "./github-job-do";
import type { PlannerRunDO } from "./planner-run-do";
import type { SandboxDO } from "./sandbox-do";
import type { ThreadDO } from "./coordination";
import type { WorkspaceDO } from "./workspace/do";

// Applies the operator-chosen region (set at deploy time from TILLER_REGION) to
// DO placement. Only takes effect on first-create; existing DOs stay put.
export function getLocationHintOptions(
  env: Env,
): DurableObjectNamespaceGetDurableObjectOptions | undefined {
  const hint = env.DO_LOCATION_HINT as DurableObjectLocationHint | undefined;
  return hint ? { locationHint: hint } : undefined;
}

export function getSandboxStub(env: Env, slug: string): SandboxDO {
  const id = env.SANDBOX.idFromName(slug);
  return env.SANDBOX.get(id, getLocationHintOptions(env)) as unknown as SandboxDO;
}

export function getArtifactStoreStub(
  env: Env,
  repoId: string,
  generation: string | null,
): ArtifactStoreDO {
  const normalizedRepoId = repoId.trim();
  if (!normalizedRepoId) {
    throw new Error("Artifact store access requires a repository ID.");
  }
  const normalizedGeneration = generation?.trim() ?? null;
  if (generation !== null && !normalizedGeneration) {
    throw new Error("Artifact store lifecycle generation cannot be empty.");
  }
  const id = env.ARTIFACT_STORE.idFromName(normalizedGeneration === null
    ? normalizedRepoId
    : `${normalizedRepoId}:generation:${normalizedGeneration}`);
  return env.ARTIFACT_STORE.get(id, getLocationHintOptions(env)) as unknown as ArtifactStoreDO;
}

export function getEnvLifecycleStub(env: Env, slug: string): EnvLifecycleDO {
  const id = env.ENV_LIFECYCLE.idFromName(slug);
  return env.ENV_LIFECYCLE.get(id, getLocationHintOptions(env)) as unknown as EnvLifecycleDO;
}

export function getScheduledRunCapacityStub(env: Env): ScheduledRunCapacityDO {
  if (!env.SCHEDULED_RUN_CAPACITY) {
    throw new Error("Required SCHEDULED_RUN_CAPACITY Durable Object binding is unavailable.");
  }
  const id = env.SCHEDULED_RUN_CAPACITY.idFromName("scheduled-runs");
  return env.SCHEDULED_RUN_CAPACITY.get(
    id,
    getLocationHintOptions(env),
  ) as unknown as ScheduledRunCapacityDO;
}

export function getEnvReviewStub(env: Env, slug: string): EnvReviewDO {
  const id = env.ENV_REVIEW.idFromName(slug);
  return env.ENV_REVIEW.get(id, getLocationHintOptions(env)) as unknown as EnvReviewDO;
}

export function getGitHubJobStub(env: Env, slug: string): GitHubJobDO {
  const id = env.GITHUB_JOB.idFromName(slug);
  return env.GITHUB_JOB.get(id, getLocationHintOptions(env)) as unknown as GitHubJobDO;
}

export function getPlannerRunStub(env: Env, slug: string): PlannerRunDO {
  const id = env.PLANNER_RUN.idFromName(slug);
  return env.PLANNER_RUN.get(id, getLocationHintOptions(env)) as unknown as PlannerRunDO;
}

export function getWorkspaceStub(env: Env, slug: string): WorkspaceDO {
  const id = env.WORKSPACE.idFromName(slug);
  return env.WORKSPACE.get(id, getLocationHintOptions(env)) as unknown as WorkspaceDO;
}

export function getThreadStub(env: Env, threadId: string): ThreadDO {
  const id = env.THREAD.idFromName(threadId);
  return env.THREAD.get(id, getLocationHintOptions(env)) as unknown as ThreadDO;
}
