/**
 * @vitest-environment jsdom
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta } from "../../api/types";

const apiMocks = vi.hoisted(() => ({
  fetchEnv: vi.fn(),
  fetchEnvs: vi.fn(),
  fetchRepo: vi.fn(),
  fetchRepos: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchEnv: apiMocks.fetchEnv,
  fetchEnvs: apiMocks.fetchEnvs,
  fetchRepo: apiMocks.fetchRepo,
  fetchRepos: apiMocks.fetchRepos,
}));

import { useLiveSyncStore } from "../useLiveSyncStore";

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const env: EnvMeta = {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    scmModel: "github",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "codex",
    harnessSettings: null,
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    status: "stopped",
    startupPlanId: null,
    branchName: "tiller/demo-env",
    branchStatus: "ready-to-merge",
    workspaceDirty: true,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: null,
    baseMainCommit: "main-a",
    lastKnownMainCommit: "main-a",
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    githubBaseBranch: "main",
    githubBaseCommitSha: "main-a",
    githubBranch: "tiller/env/demo-env",
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
  return Object.assign(env, overrides);
}

describe("useLiveSyncStore publish watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    apiMocks.fetchEnvs.mockResolvedValue([]);
    apiMocks.fetchRepos.mockResolvedValue([]);
    apiMocks.fetchRepo.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  it("performs a targeted refresh while GitHub publishing is active", async () => {
    apiMocks.fetchEnv.mockResolvedValue(makeEnv({
      updatedAt: "2026-07-16T00:00:10.000Z",
      githubPublishStatus: "published",
      githubLastPublishedAt: "2026-07-16T00:00:10.000Z",
    }));
    const { result, unmount } = renderHook(() => useLiveSyncStore({
      hubUrl: "https://hub.test",
      setStartDialogSlug: vi.fn(),
      setNewEnvTarget: vi.fn(),
    }));

    act(() => {
      result.current.upsertEnv(makeEnv({
        githubPublishStatus: "publishing",
        githubPublishOperationId: "operation-1",
      }));
    });

    expect(apiMocks.fetchEnv).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });

    expect(apiMocks.fetchEnv).toHaveBeenCalledTimes(1);
    expect(apiMocks.fetchEnv).toHaveBeenCalledWith("https://hub.test", "demo-env");
    expect(result.current.envs[0]?.githubPublishStatus).toBe("published");
    unmount();
  });
});
