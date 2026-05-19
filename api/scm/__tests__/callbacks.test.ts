import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta } from "../../types";
import { createInitialEnvScmState } from "../model";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  ensureRepoWorkspaceFromRepoUrl: vi.fn(),
  commitRepoMainState: vi.fn(),
  persistRepoMeta: vi.fn(),
  getHub: vi.fn(),
  projectAndPersistEnvSummary: vi.fn(),
  getScmOperationStore: vi.fn(),
  headScmArtifact: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
}));

vi.mock("../../plan/store", () => ({
  ensureRepoWorkspaceFromRepoUrl: mocks.ensureRepoWorkspaceFromRepoUrl,
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

const {
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
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
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
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
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
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
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
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
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
