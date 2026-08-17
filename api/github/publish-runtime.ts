import { getGitHubJobStub } from "../helpers";
import { getRunnerBackend } from "../env/runner-backends";
import type { Env, EnvMeta, ExecutionPlacement } from "../types";

export function buildGitHubPublishJobMeta(args: {
  slug: string;
  repoUrl: string;
  repoId: string;
  placement: ExecutionPlacement;
  createdAt?: string;
}): EnvMeta {
  const createdAt = args.createdAt ?? new Date().toISOString();
  return {
    slug: args.slug,
    incarnationId: args.slug,
    repoUrl: args.repoUrl,
    repoId: args.repoId,
    scmModel: "github",
    backend: args.placement.backend,
    executionPlacement: args.placement,
    harness: "claude-code",
    harnessSettings: null,
    createdAt,
    updatedAt: createdAt,
    status: "creating",
    startupPlanId: null,
    branchName: null,
    branchStatus: null,
    workspaceDirty: null,
    workspaceNeedsAttention: null,
    workspaceLastSyncedAt: null,
    implementorAttentionToken: null,
    baseMainCommit: null,
    lastKnownMainCommit: null,
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    githubBaseBranch: null,
    githubBaseCommitSha: null,
    githubBranch: null,
    githubHeadCommitSha: null,
    githubPrNumber: null,
    githubPrUrl: null,
    githubPrState: null,
    githubMergedAt: null,
    githubPublishStatus: "idle",
    githubPublishOperationId: null,
    githubPublishError: null,
    githubLastPublishedAt: null,
    githubLastPublishedWorkspaceHash: null,
    githubPendingPublish: null,
  };
}

export async function cleanupGitHubPublishRuntime(
  env: Env,
  operation: {
    operationId: string;
    jobSlug: string;
    repoId: string;
    repoUrl: string;
    startedAt: string;
    executionPlacement: ExecutionPlacement;
  },
): Promise<void> {
  if (operation.executionPlacement.backend === "cf") {
    await getGitHubJobStub(env, operation.jobSlug).destroyJob();
    return;
  }
  const backend = await getRunnerBackend(env, "host");
  await backend.destroy(buildGitHubPublishJobMeta({
    slug: operation.jobSlug,
    repoUrl: operation.repoUrl,
    repoId: operation.repoId,
    placement: operation.executionPlacement,
    createdAt: operation.startedAt,
  }), {
    runnerCommand: {
      commandGeneration: 2,
      operationId: `${operation.operationId}:cleanup`,
      desiredState: "absent",
    },
  });
}
