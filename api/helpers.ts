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
import { getDurableObjectStub } from "./durable-object";

export function getSandboxStub(env: Env, slug: string): SandboxDO {
  return getDurableObjectStub<SandboxDO>(env, env.SANDBOX, slug);
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
  const name = normalizedGeneration === null
    ? normalizedRepoId
    : `${normalizedRepoId}:generation:${normalizedGeneration}`;
  return getDurableObjectStub<ArtifactStoreDO>(env, env.ARTIFACT_STORE, name);
}

export function getEnvLifecycleStub(env: Env, slug: string): EnvLifecycleDO {
  return getDurableObjectStub<EnvLifecycleDO>(env, env.ENV_LIFECYCLE, slug);
}

export function getScheduledRunCapacityStub(env: Env): ScheduledRunCapacityDO {
  if (!env.SCHEDULED_RUN_CAPACITY) {
    throw new Error("Required SCHEDULED_RUN_CAPACITY Durable Object binding is unavailable.");
  }
  return getDurableObjectStub<ScheduledRunCapacityDO>(
    env,
    env.SCHEDULED_RUN_CAPACITY,
    "scheduled-runs",
  );
}

export function getEnvReviewStub(env: Env, slug: string): EnvReviewDO {
  return getDurableObjectStub<EnvReviewDO>(env, env.ENV_REVIEW, slug);
}

export function getGitHubJobStub(env: Env, slug: string): GitHubJobDO {
  return getDurableObjectStub<GitHubJobDO>(env, env.GITHUB_JOB, slug);
}

export function getPlannerRunStub(env: Env, slug: string): PlannerRunDO {
  return getDurableObjectStub<PlannerRunDO>(env, env.PLANNER_RUN, slug);
}

export function getWorkspaceStub(env: Env, slug: string): WorkspaceDO {
  return getDurableObjectStub<WorkspaceDO>(env, env.WORKSPACE, slug);
}

export function getThreadStub(env: Env, threadId: string): ThreadDO {
  return getDurableObjectStub<ThreadDO>(env, env.THREAD, threadId);
}
