import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta, RepoMeta } from "../../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../model";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getScmOperationStub: vi.fn(),
  getRepoWorkspaceForRepoId: vi.fn(),
  projectAndPersistEnvSummary: vi.fn(),
  projectEnvMetaForAction: vi.fn(),
  reconcileEnvScmOperationState: vi.fn(),
  getHub: vi.fn(),
  getRunnerBackend: vi.fn(),
  resolveScmRunnerBackendKind: vi.fn(),
  isLocalOnlyRunnerBackendMode: vi.fn(),
  buildGitOperationEnvVars: vi.fn(),
  getScmOperationStore: vi.fn(),
  createScmOperationId: vi.fn(),
  waitForRepoScmOperation: vi.fn(),
  buildScmOperationResponse: vi.fn(),
  ensureNoPendingRepoScmOperationForEnv: vi.fn(),
  getRepoGitNotReadyError: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getScmOperationStub: mocks.getScmOperationStub,
}));

vi.mock("../../plan/store", () => ({
  getSelectedRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
  readEnvSummary: vi.fn(),
}));

vi.mock("../../env/service", () => ({
  getHub: mocks.getHub,
  projectAndPersistEnvSummary: mocks.projectAndPersistEnvSummary,
  projectEnvMetaForAction: mocks.projectEnvMetaForAction,
  reconcileEnvScmOperationState: mocks.reconcileEnvScmOperationState,
}));

vi.mock("../../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

vi.mock("../../env/runner-backend", () => ({
  resolveScmRunnerBackendKind: mocks.resolveScmRunnerBackendKind,
  isLocalOnlyRunnerBackendMode: mocks.isLocalOnlyRunnerBackendMode,
}));

vi.mock("../../env/launch-config", () => ({
  buildGitOperationEnvVars: mocks.buildGitOperationEnvVars,
}));

vi.mock("../operation-store", () => ({
  getScmOperationStore: mocks.getScmOperationStore,
}));

vi.mock("../../env/scm-operations", () => ({
  createScmOperationId: mocks.createScmOperationId,
  waitForRepoScmOperation: mocks.waitForRepoScmOperation,
  buildScmOperationResponse: mocks.buildScmOperationResponse,
  ensureNoPendingRepoScmOperationForEnv: mocks.ensureNoPendingRepoScmOperationForEnv,
  getRepoGitNotReadyError: mocks.getRepoGitNotReadyError,
}));

const {
  startMergeIntoMainWorkflow,
  startUpdateFromMainWorkflow,
} = await import("../workflows");

function makeEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
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

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    githubInstallationId: 98765,
    githubFullName: "test/repo",
    createdAt: "2026-04-13T00:00:00.000Z",
    updatedAt: "2026-04-13T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
    ...createInitialRepoScmState(),
    mainCommit: "main-a",
    gitArtifactId: "g-main",
    gitStatus: "ready",
    ...overrides,
  };
}

describe("scm/workflows", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getHub.mockReturnValue({});
    mocks.reconcileEnvScmOperationState.mockImplementation(async (_env: unknown, meta: EnvMeta) => meta);
    mocks.projectAndPersistEnvSummary.mockImplementation(async (_env: unknown, _hub: unknown, _slug: string) => makeEnvMeta());
    mocks.projectEnvMetaForAction.mockImplementation(async (_env: unknown, meta: EnvMeta) => ({ meta, liveStatus: "stopped" }));
    mocks.ensureNoPendingRepoScmOperationForEnv.mockResolvedValue(null);
    mocks.getRepoGitNotReadyError.mockReturnValue(null);
    mocks.buildGitOperationEnvVars.mockResolvedValue({
      TILLER_SCM_OPERATION: "merge-into-main",
      TILLER_SCM_CONFLICT_RESOLUTION_URL: "https://hub.test/api/envs/demo-env/scm-operations/op-merge/resolve-conflicts",
    });
    mocks.resolveScmRunnerBackendKind.mockReturnValue("cf");
    mocks.isLocalOnlyRunnerBackendMode.mockReturnValue(false);
    mocks.getEnvLifecycleStub.mockReturnValue({
      setScmProjection: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getScmOperationStub.mockReturnValue({
      startOperationJob: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("starts merge workflows through the operation store and scm backend", async () => {
    const meta = makeEnvMeta({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-13T00:00:00.000Z",
      workspaceNeedsAttention: false,
      branchStatus: "ready-to-merge",
    });
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
    };
    const scmOperationStub = {
      startOperationJob: vi.fn().mockResolvedValue(undefined),
    };
    const store = {
      acquireMergeLock: vi.fn().mockResolvedValue({
        acquired: true,
        lock: { token: "lock-token", operationId: "op-merge" },
      }),
      createOperation: vi.fn().mockResolvedValue({}),
      clearOperation: vi.fn().mockResolvedValue(undefined),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
      failOperation: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.projectEnvMetaForAction.mockResolvedValue({ meta, liveStatus: "stopped" });
    mocks.getScmOperationStub.mockReturnValue(scmOperationStub);
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({ mainCommit: "main-a" }),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);
    mocks.createScmOperationId.mockReturnValue("op-merge");
    mocks.waitForRepoScmOperation.mockResolvedValue({
      operationId: "op-merge",
      status: "succeeded",
      result: { action: "merged" },
    });
    mocks.buildScmOperationResponse.mockReturnValue({ ok: true, action: "merged" });

    const result = await startMergeIntoMainWorkflow({} as any, "https://hub.test/api/envs/demo-env/merge-into-main", "demo-env");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      slug: "demo-env",
      repoId: "repo-1",
      ok: true,
      action: "merged",
    });
    expect(store.acquireMergeLock).toHaveBeenCalledWith({
      ownerId: "demo-env",
      operationId: "op-merge",
      leaseMs: 300000,
    });
    expect(store.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-merge",
        type: "merge-into-main",
        mergeLockToken: "lock-token",
      }),
    );
    expect(scmOperationStub.startOperationJob).toHaveBeenCalledTimes(1);
    expect(scmOperationStub.startOperationJob.mock.calls[0][0]).toMatchObject({
      TILLER_SCM_CONFLICT_RESOLUTION_URL: expect.stringMatching(/\/api\/envs\/demo-env\/scm-operations\/op-merge\/resolve-conflicts$/),
    });
    expect(store.clearOperation).toHaveBeenCalledWith("op-merge");
  });

  it("requires update from main before promoting a behind-main env", async () => {
    const meta = makeEnvMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
    });
    const store = {
      acquireMergeLock: vi.fn(),
      createOperation: vi.fn(),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.projectEnvMetaForAction.mockResolvedValue({ meta, liveStatus: "stopped" });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({ mainCommit: "main-b" }),
    });
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await startMergeIntoMainWorkflow({} as any, "https://hub.test/api/envs/demo-env/merge-into-main", "demo-env");

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: "promote_requires_update_from_main",
      hint: expect.stringContaining("Update from Main"),
    });
    expect(store.acquireMergeLock).not.toHaveBeenCalled();
    expect(store.createOperation).not.toHaveBeenCalled();
  });

  it("rejects promote when the env base commit is missing", async () => {
    const meta = makeEnvMeta({
      workspaceDirty: true,
      baseMainCommit: null,
      lastKnownMainCommit: null,
      branchStatus: "ready-to-merge",
    });
    const store = {
      acquireMergeLock: vi.fn(),
      createOperation: vi.fn(),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.projectEnvMetaForAction.mockResolvedValue({ meta, liveStatus: "stopped" });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({ mainCommit: "main-a" }),
    });
    mocks.getScmOperationStore.mockReturnValue(store);

    const result = await startMergeIntoMainWorkflow({} as any, "https://hub.test/api/envs/demo-env/merge-into-main", "demo-env");

    expect(result.status).toBe(409);
    expect(result.body).toMatchObject({
      code: "promote_base_not_current",
      hint: expect.stringContaining("base commit is missing"),
    });
    expect(store.acquireMergeLock).not.toHaveBeenCalled();
    expect(store.createOperation).not.toHaveBeenCalled();
  });

  it("starts update-from-main workflows through the operation store and scm backend", async () => {
    const meta = makeEnvMeta({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
      branchStatus: "behind-main",
    });
    const lifecycleStub = {
      setScmProjection: vi.fn().mockResolvedValue(undefined),
    };
    const scmOperationStub = {
      startOperationJob: vi.fn().mockResolvedValue(undefined),
    };
    const store = {
      acquireMergeLock: vi.fn().mockResolvedValue({
        acquired: true,
        lock: { token: "lock-token", operationId: "op-update" },
      }),
      createOperation: vi.fn().mockResolvedValue({}),
      clearOperation: vi.fn().mockResolvedValue(undefined),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
      failOperation: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.projectEnvMetaForAction.mockResolvedValue({ meta, liveStatus: "stopped" });
    mocks.getScmOperationStub.mockReturnValue(scmOperationStub);
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({ mainCommit: "main-b" }),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getScmOperationStore.mockReturnValue(store);
    mocks.createScmOperationId.mockReturnValue("op-update");
    mocks.buildGitOperationEnvVars.mockResolvedValue({
      TILLER_SCM_OPERATION: "update-from-main",
      TILLER_SCM_CONFLICT_RESOLUTION_URL: "https://hub.test/api/envs/demo-env/scm-operations/op-update/resolve-conflicts",
    });
    mocks.waitForRepoScmOperation.mockResolvedValue({
      operationId: "op-update",
      status: "succeeded",
      result: { action: "updated-from-main" },
    });
    mocks.buildScmOperationResponse.mockReturnValue({
      ok: true,
      action: "updated-from-main",
      branchStatus: "ready-to-merge",
    });

    const result = await startUpdateFromMainWorkflow({} as any, "https://hub.test/api/envs/demo-env/update-from-main", "demo-env");

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      slug: "demo-env",
      repoId: "repo-1",
      ok: true,
      action: "updated-from-main",
      branchStatus: "ready-to-merge",
    });
    expect(store.acquireMergeLock).toHaveBeenCalledWith({
      ownerId: "demo-env",
      operationId: "op-update",
      leaseMs: 300000,
    });
    expect(store.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: "op-update",
        type: "update-from-main",
        mergeLockToken: "lock-token",
      }),
    );
    expect(scmOperationStub.startOperationJob).toHaveBeenCalledTimes(1);
    expect(mocks.buildGitOperationEnvVars).toHaveBeenCalledWith(
      expect.anything(),
      "https://hub.test/api/envs/demo-env/update-from-main",
      expect.anything(),
      expect.objectContaining({
        branchStatus: "behind-main",
      }),
      expect.objectContaining({
        operationId: "op-update",
        operationType: "update-from-main",
        sourceGitArtifactId: "g-main",
        mergeLockToken: "lock-token",
      }),
    );
    expect(store.clearOperation).toHaveBeenCalledWith("op-update");
  });

  it("returns a useful error and releases any partially-acquired lock when promote setup throws", async () => {
    const meta = makeEnvMeta({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-13T00:00:00.000Z",
      branchStatus: "ready-to-merge",
    });
    const store = {
      acquireMergeLock: vi.fn().mockRejectedValue(new TypeError("Your Durable Object class must have an alarm() handler in order to call setAlarm()")),
      getMergeLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      releaseMergeLock: vi.fn().mockResolvedValue(undefined),
      createOperation: vi.fn(),
      clearOperation: vi.fn().mockResolvedValue(undefined),
      failOperation: vi.fn().mockResolvedValue(undefined),
    };
    mocks.projectAndPersistEnvSummary.mockResolvedValue(meta);
    mocks.projectEnvMetaForAction.mockResolvedValue({ meta, liveStatus: "stopped" });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({ mainCommit: "main-a" }),
    });
    mocks.getScmOperationStore.mockReturnValue(store);
    mocks.createScmOperationId.mockReturnValue("op-merge");

    const result = await startMergeIntoMainWorkflow({} as any, "https://hub.test/api/envs/demo-env/merge-into-main", "demo-env");

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({
      error: expect.stringContaining("alarm() handler"),
      code: "promote_setup_failed",
      hint: expect.stringContaining("Retry once"),
    });
    expect(store.createOperation).not.toHaveBeenCalled();
    expect(store.releaseMergeLock).toHaveBeenCalledWith("lock-token");
  });
});
