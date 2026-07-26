import type { EnvDefinition, EnvMeta, EnvMutableState, RepoMeta } from "../../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../../scm/model";

const CREATED_AT = "2026-04-01T00:00:00.000Z";
const UPDATED_AT = "2026-04-01T00:05:00.000Z";

export function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const repoId = overrides.repoId ?? "repo-1";
  const mainCommit = overrides.mainCommit === undefined ? "main-sha" : overrides.mainCommit;
  return {
    repoId,
    repoUrl: overrides.repoUrl ?? "https://github.com/example/repo",
    githubInstallationId: overrides.githubInstallationId ?? 123,
    githubFullName: overrides.githubFullName ?? "example/repo",
    ...createInitialRepoScmState(),
    githubDefaultBranch: overrides.githubDefaultBranch ?? "main",
    githubDefaultBranchHeadSha: overrides.githubDefaultBranchHeadSha ?? mainCommit,
    mainCommit,
    createdAt: overrides.createdAt ?? CREATED_AT,
    updatedAt: overrides.updatedAt ?? CREATED_AT,
    bootstrappedFromRef: overrides.bootstrappedFromRef ?? "main",
    lastCommittedFromEnvSlug: overrides.lastCommittedFromEnvSlug ?? null,
    lastCommittedAt: overrides.lastCommittedAt ?? null,
    ...overrides,
  };
}

export function makeEnvDefinition(overrides: Partial<EnvDefinition> = {}): EnvDefinition {
  return {
    slug: overrides.slug ?? "env-1",
    incarnationId: overrides.incarnationId ?? "incarnation-1",
    repoId: overrides.repoId ?? "repo-1",
    scmModel: overrides.scmModel ?? "github",
    executionPlacement: overrides.executionPlacement ?? { backend: "cf", machineId: null },
    harness: overrides.harness ?? "claude-code",
    startupPlanId: overrides.startupPlanId ?? null,
    branchName: overrides.branchName ?? "env/env-1",
    createdAt: overrides.createdAt ?? CREATED_AT,
    ...overrides,
  };
}

export function makeMutableState(overrides: Partial<EnvMutableState> = {}): EnvMutableState {
  return {
    status: overrides.status ?? "running",
    lifecyclePhase: overrides.lifecyclePhase ?? "running",
    lifecycleOpId: overrides.lifecycleOpId ?? "start-1",
    lifecycleOperation: overrides.lifecycleOperation ?? "start",
    lifecycleDesiredState: overrides.lifecycleDesiredState ?? "running",
    lifecycleLastRunnerState: overrides.lifecycleLastRunnerState ?? "running",
    lifecycleLastWorkspaceSyncedAckOpId: overrides.lifecycleLastWorkspaceSyncedAckOpId ?? null,
    lifecycleInfraState: overrides.lifecycleInfraState ?? "ready",
    lifecycleRuntimeReady: overrides.lifecycleRuntimeReady ?? true,
    lifecycleUpdatedAt: overrides.lifecycleUpdatedAt ?? UPDATED_AT,
    runnerId: overrides.runnerId ?? "runner-1",
    bootMessage: overrides.bootMessage ?? null,
    bootStepId: overrides.bootStepId ?? null,
    branchStatus: overrides.branchStatus ?? "up-to-date",
    workspaceDirty: overrides.workspaceDirty ?? false,
    workspaceNeedsAttention: overrides.workspaceNeedsAttention ?? false,
    workspaceLastSyncedAt: overrides.workspaceLastSyncedAt ?? UPDATED_AT,
    baseMainCommit: overrides.baseMainCommit ?? "main-sha",
    lastKnownMainCommit: overrides.lastKnownMainCommit ?? "main-sha",
    scmOperationType: overrides.scmOperationType ?? null,
    scmOperationId: overrides.scmOperationId ?? null,
    scmOperationPhase: overrides.scmOperationPhase ?? null,
    scmOperationStartedAt: overrides.scmOperationStartedAt ?? null,
    scmOperationUpdatedAt: overrides.scmOperationUpdatedAt ?? null,
    scmLastCompletedAt: overrides.scmLastCompletedAt ?? null,
    scmLastDurationMs: overrides.scmLastDurationMs ?? null,
    scmLastTimings: overrides.scmLastTimings ?? null,
    leadHarnessStatus: overrides.leadHarnessStatus ?? null,
    leadHarnessError: overrides.leadHarnessError ?? null,
    leadHarnessUpdatedAt: overrides.leadHarnessUpdatedAt ?? null,
    error: overrides.error ?? null,
    errorAt: overrides.errorAt ?? null,
    updatedAt: overrides.updatedAt ?? UPDATED_AT,
  };
}

export function makeSummaryCacheRow(overrides: Partial<EnvMeta> = {}): Omit<EnvMeta, "repoUrl"> {
  const backend = overrides.backend ?? "cf";
  const meta: EnvMeta = {
    slug: overrides.slug ?? "env-1",
    incarnationId: overrides.incarnationId ?? "incarnation-1",
    repoUrl: overrides.repoUrl ?? "https://github.com/example/repo",
    repoId: overrides.repoId ?? "repo-1",
    backend,
    executionPlacement: overrides.executionPlacement ?? (
      backend === "cf"
        ? { backend: "cf", machineId: null }
        : { backend: "host", machineId: "machine-1" }
    ),
    runnerId: overrides.runnerId ?? "runner-cache",
    harness: overrides.harness ?? "claude-code",
    createdAt: overrides.createdAt ?? CREATED_AT,
    updatedAt: overrides.updatedAt ?? UPDATED_AT,
    status: overrides.status ?? "failed",
    ...createInitialEnvScmState({
      slug: overrides.slug ?? "env-1",
      mainCommit: overrides.baseMainCommit ?? "main-sha",
    }),
    ...overrides,
  };
  const { repoUrl: _repoUrl, ...stored } = meta;
  return stored;
}
