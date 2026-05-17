import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta } from "../../types";
import { createInitialEnvScmState } from "../model";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  getRepoWorkspaceForRepoId: vi.fn(),
  commitRepoMainState: vi.fn(),
  persistRepoMeta: vi.fn(),
  getHub: vi.fn(),
  projectAndPersistEnvSummary: vi.fn(),
  getScmOperationStore: vi.fn(),
  headScmArtifact: vi.fn(),
  revokeGitHubBridgesForScmOperation: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getWorkspaceStub: mocks.getWorkspaceStub,
}));

vi.mock("../../plan/store", () => ({
  getSelectedRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
  commitRepoMainState: mocks.commitRepoMainState,
  persistRepoMeta: mocks.persistRepoMeta,
}));

vi.mock("../../env/service", () => ({
  getHub: mocks.getHub,
  projectAndPersistEnvSummary: mocks.projectAndPersistEnvSummary,
}));

vi.mock("../operation-store", () => ({
  getScmOperationStore: mocks.getScmOperationStore,
}));

vi.mock("../artifacts", async () => {
  const actual = await vi.importActual<typeof import("../artifacts")>("../artifacts");
  return {
    ...actual,
    headScmArtifact: mocks.headScmArtifact,
  };
});

vi.mock("../../github/bridge", () => ({
  revokeGitHubBridgesForScmOperation: mocks.revokeGitHubBridgesForScmOperation,
}));

const {
  handleScmFailedCallback,
  handleScmProgressCallback,
  handleScmResultCallback,
} = await import("../callbacks");

function makeMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    backend: "cf",
    harness: "claude-code",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    status: "stopped",
    ...createInitialEnvScmState({
      slug: "demo-env",
      mainCommit: "main-a",
    }),
    ...overrides,
  };
}

describe("scm/callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockImplementation(async () => makeMeta());
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-a",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });
    mocks.getEnvLifecycleStub.mockReturnValue({
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getWorkspaceStub.mockReturnValue({
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 1 }),
    });
    mocks.revokeGitHubBridgesForScmOperation.mockResolvedValue(undefined);
  });

  it("skips stale progress callbacks when the env projection points at a different promote operation", async () => {
    const meta = makeMeta({
      scmOperationType: "merge-into-main",
      scmOperationId: "op-current",
      scmOperationPhase: "Starting sandbox",
    });
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getScmOperationStore.mockReturnValue({
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-old",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
    });

    const result = await handleScmProgressCallback({} as any, "demo-env", "op-old", "Uploading environment");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-old",
      skipped: true,
    });
    expect(result.outcome).toMatchObject({
      outcome: "skipped",
      kind: "progress",
    });
  });

  it("keeps env scm state unchanged when a promote callback reports conflicts", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const meta = makeMeta({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-13T00:00:00.000Z",
      branchStatus: "ready-to-merge",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Merging branch into main",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmResultCallback({} as any, "demo-env", "op-merge", {
      action: "conflicted",
      message: null,
      conflictCount: 3,
      gitHead: null,
      durationMs: null,
      timings: null,
      mergedTar: new Uint8Array(),
      sourceEnvMatchesMain: null,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-merge",
      action: "conflicted",
    });
    expect(lifecycleStub.recordStopWorkspaceSynced).not.toHaveBeenCalled();
    expect(store.completeOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      result: expect.objectContaining({
        action: "conflicted",
        conflictCount: 3,
      }),
    });
    expect(store.releaseMergeLock).toHaveBeenCalledWith("lock-token");
    expect(result.outcome).toMatchObject({
      outcome: "conflicted",
      operationId: "op-merge",
    });
  });

  it("fails active operations with projection cleanup, bridge revocation, and lock release", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const operation = {
      operationId: "op-merge",
      type: "merge-into-main",
      envSlug: "demo-env",
      status: "pending",
      mergeLockToken: "lock-token",
      createdAt: "2026-04-13T00:00:00.000Z",
    };
    const meta = makeMeta({
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Merging branch into main",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn()
        .mockResolvedValueOnce(operation)
        .mockResolvedValueOnce({
          ...operation,
          status: "failed",
          error: "merge failed",
        }),
      failOperation: vi.fn().mockResolvedValue({ status: "failed" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmFailedCallback({} as any, "demo-env", "op-merge", {
      message: "merge failed",
      durationMs: 123,
      timings: "timings-json",
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-merge",
      status: "failed",
      error: "merge failed",
    });
    expect(lifecycleStub.clearScmProjection).toHaveBeenCalledWith({
      completedAt: expect.any(String),
      durationMs: 123,
      timings: "timings-json",
    });
    expect(store.failOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      error: "merge failed",
    });
    expect(mocks.revokeGitHubBridgesForScmOperation).toHaveBeenCalledWith(
      {},
      {
        repoId: "repo-1",
        operationId: "op-merge",
      },
    );
    expect(store.releaseMergeLock).toHaveBeenCalledWith("lock-token");
    expect(result.outcome).toMatchObject({
      outcome: "failed",
      operationId: "op-merge",
      error: "merge failed",
    });
  });

  it("keeps the env stale but clears workspaceDirty when promote is already contained in main", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const meta = makeMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Reporting result",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-b",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmResultCallback({} as any, "demo-env", "op-merge", {
      action: "already-current",
      message: null,
      conflictCount: null,
      gitHead: "main-b",
      durationMs: null,
      timings: null,
      mergedTar: new Uint8Array(),
      sourceEnvMatchesMain: false,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-merge",
      action: "already-current",
      currentMainCommit: "main-b",
    });
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith({
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: null,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-b",
      branchStatus: "behind-main",
    }, { clearError: true });
    expect(store.completeOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      result: {
        action: "already-current",
        currentMainCommit: "main-b",
      },
    });
    expect(store.releaseMergeLock).toHaveBeenCalledWith("lock-token");
  });

  it("restores the env workspace and marks it ready after update-from-main", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const restoreFromTar = vi.fn().mockResolvedValue({ fileCount: 3 });
    const meta = makeMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
      scmOperationType: "update-from-main",
      scmOperationId: "op-update",
      scmOperationPhase: "Merging main into environment",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-update",
        type: "update-from-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-update",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
      failOperation: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-b",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getWorkspaceStub.mockReturnValue({ restoreFromTar });
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmResultCallback({} as any, "demo-env", "op-update", {
      action: "updated-from-main",
      message: null,
      conflictCount: 0,
      gitHead: "main-b",
      durationMs: 123,
      timings: "timings",
      mergedTar: new Uint8Array([1, 2, 3]),
      sourceEnvMatchesMain: false,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-update",
      action: "updated-from-main",
      currentMainCommit: "main-b",
      branchStatus: "ready-to-merge",
    });
    expect(lifecycleStub.setScmProjection).toHaveBeenCalledWith(expect.objectContaining({
      type: "update-from-main",
      operationId: "op-update",
      phase: "Saving updated environment",
    }));
    expect(restoreFromTar).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]), {
      clearFirst: true,
      preservePrefixes: expect.arrayContaining(["/.tiller"]),
    });
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDirty: true,
        workspaceNeedsAttention: false,
        baseMainCommit: "main-b",
        lastKnownMainCommit: "main-b",
        branchStatus: "ready-to-merge",
      }),
      { clearError: true },
    );
    expect(store.completeOperation).toHaveBeenCalledWith({
      operationId: "op-update",
      result: {
        action: "updated-from-main",
        repoId: "repo-1",
        currentMainCommit: "main-b",
      },
    });
    expect(store.releaseMergeLock).toHaveBeenCalledWith("lock-token");
  });

  it("marks the env up to date when update-from-main reports no remaining env changes", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const meta = makeMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
      scmOperationType: "update-from-main",
      scmOperationId: "op-update",
      scmOperationPhase: "Reporting result",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-update",
        type: "update-from-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-update",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-b",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmResultCallback({} as any, "demo-env", "op-update", {
      action: "up-to-date",
      message: null,
      conflictCount: null,
      gitHead: "main-b",
      durationMs: null,
      timings: null,
      mergedTar: new Uint8Array(),
      sourceEnvMatchesMain: true,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-update",
      action: "up-to-date",
      currentMainCommit: "main-b",
    });
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDirty: false,
        workspaceNeedsAttention: false,
        baseMainCommit: "main-b",
        lastKnownMainCommit: "main-b",
        branchStatus: "up-to-date",
      }),
      { clearError: true },
    );
    expect(store.completeOperation).toHaveBeenCalledWith({
      operationId: "op-update",
      result: {
        action: "up-to-date",
        repoId: "repo-1",
        currentMainCommit: "main-b",
      },
    });
  });

  it("marks update-from-main conflicts as needing attention", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const meta = makeMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
      scmOperationType: "update-from-main",
      scmOperationId: "op-update",
      scmOperationPhase: "Resolving conflicts",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-update",
        type: "update-from-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-update",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-b",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmResultCallback({} as any, "demo-env", "op-update", {
      action: "conflicted",
      message: "2 conflicts",
      conflictCount: 2,
      gitHead: "main-b",
      durationMs: null,
      timings: null,
      mergedTar: new Uint8Array(),
      sourceEnvMatchesMain: null,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-update",
      action: "conflicted",
      currentMainCommit: "main-b",
    });
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(expect.objectContaining({
      workspaceDirty: true,
      workspaceNeedsAttention: true,
      lastKnownMainCommit: "main-b",
      branchStatus: "needs-attention",
    }));
    expect(store.completeOperation).toHaveBeenCalledWith({
      operationId: "op-update",
      result: {
        action: "conflicted",
        message: "2 conflicts",
        conflictCount: 2,
        currentMainCommit: "main-b",
      },
    });
  });

  it("marks the env up to date when promote is already-current and the env matches main", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const meta = makeMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Reporting result",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-b",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await handleScmResultCallback({} as any, "demo-env", "op-merge", {
      action: "already-current",
      message: null,
      conflictCount: null,
      gitHead: "main-b",
      durationMs: null,
      timings: null,
      mergedTar: new Uint8Array(),
      sourceEnvMatchesMain: true,
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      operationId: "op-merge",
      action: "already-current",
      currentMainCommit: "main-b",
    });
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith({
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: null,
      baseMainCommit: "main-b",
      lastKnownMainCommit: "main-b",
      branchStatus: "up-to-date",
    }, { clearError: true });
    expect(store.completeOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      result: {
        action: "already-current",
        currentMainCommit: "main-b",
      },
    });
    expect(store.releaseMergeLock).toHaveBeenCalledWith("lock-token");
  });

  it("marks the source env stale when promote succeeds with a merged main tree that differs from the env", async () => {
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
      clearScmProjection: vi.fn().mockResolvedValue(undefined),
      recordStopWorkspaceSynced: vi.fn().mockResolvedValue(undefined),
    };
    const meta = makeMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Merging branch into main",
      scmOperationStartedAt: "2026-04-13T00:00:00.000Z",
    });
    const store = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        gitArtifactId: "g-main",
        createdAt: "2026-04-13T00:00:00.000Z",
      }),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);
    mocks.headScmArtifact.mockResolvedValue({
      customMetadata: {
        operationId: "op-merge",
      },
    });
    mocks.commitRepoMainState.mockResolvedValue({
      repoId: "repo-1",
      repoUrl: "https://github.com/test/repo",
      mainCommit: "main-b",
      gitArtifactId: "g-main",
      gitStatus: "ready",
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        restoreFromTar: vi.fn().mockResolvedValue(undefined),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "main-a",
        gitArtifactId: "g-main",
        gitStatus: "ready",
      },
    });

    const result = await handleScmResultCallback({ AI: {} } as any, "demo-env", "op-merge", {
      action: "merged",
      message: null,
      conflictCount: 0,
      gitHead: "main-b",
      durationMs: null,
      timings: null,
      mergedTar: new Uint8Array([4, 5, 6]),
      sourceEnvMatchesMain: false,
    });

    expect(result.status).toBe(200);
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(
      expect.objectContaining({
        branchStatus: "behind-main",
        workspaceDirty: true,
        baseMainCommit: "main-a",
        lastKnownMainCommit: "main-b",
      }),
      { clearError: true },
    );
  });
});
