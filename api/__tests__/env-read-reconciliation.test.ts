import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvLifecycleState, EnvMeta } from "../types";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getRunnerBackend: vi.fn(),
}));

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  };
});

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

import { projectEnvMetaForRead } from "../env/service";

function makeMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    incarnationId: "incarnation-demo-env",
    repoUrl: "https://github.com/example/repo",
    repoId: "repo-1",
    scmModel: "github",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "codex",
    harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:01:00.000Z",
    status: "running",
    startupPlanId: null,
    branchName: "env/demo-env",
    branchStatus: "up-to-date",
    workspaceDirty: true,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-08-12T00:00:30.000Z",
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    githubBaseBranch: "main",
    githubBaseCommitSha: "main-sha",
    githubBranch: "env/demo-env",
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
    lifecyclePhase: "running",
    lifecycleOpId: "start-op-1",
    lifecycleOperation: "start",
    lifecycleDesiredState: "running",
    lifecycleInfraState: "ready",
    lifecycleRuntimeReady: true,
    lifecycleUpdatedAt: "2026-08-12T00:01:00.000Z",
    ...overrides,
  };
}

function runningLifecycle(overrides: Partial<EnvLifecycleState> = {}): EnvLifecycleState {
  return {
    phase: "running",
    activeOpId: "start-op-1",
    activeOperation: "start",
    desiredState: "running",
    lastRunnerState: "running",
    lastWorkspaceSyncedAckOpId: null,
    infraState: "ready",
    runtimeReady: true,
    lastError: null,
    lastErrorAt: null,
    updatedAt: "2026-08-12T00:01:00.000Z",
    ...overrides,
  };
}

function makeEnv() {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({ broadcastEnvUpsert: vi.fn() })),
    },
  } as any;
}

describe("Cloudflare env read reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("turns a running lifecycle with an absent Cloudflare runner into a restartable failure", async () => {
    const meta = makeMeta();
    const failed = makeMeta({
      status: "failed",
      lifecyclePhase: "failed",
      lifecycleInfraState: "stopped",
      lifecycleRuntimeReady: false,
      error: "The environment runtime stopped unexpectedly. Reference ID: TLR-TEST1234",
    });
    const noteRunnerStopped = vi.fn().mockResolvedValue(runningLifecycle({
      phase: "failed",
      infraState: "stopped",
      runtimeReady: false,
    }));
    const persistOwnedProjection = vi.fn().mockResolvedValue(failed);
    mocks.getEnvLifecycleStub.mockReturnValue({
      getState: vi.fn().mockResolvedValue(runningLifecycle()),
      noteRunnerStopped,
      persistOwnedProjection,
    });
    mocks.getRunnerBackend.mockResolvedValue({
      kind: "cf",
      inspect: vi.fn().mockResolvedValue({ state: "absent", status: "stopped" }),
    });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(projectEnvMetaForRead(makeEnv(), meta)).resolves.toBe(failed);
    expect(noteRunnerStopped).toHaveBeenCalledWith(
      "start-op-1",
      expect.stringMatching(/^The environment runtime stopped unexpectedly\. Reference ID: TLR-/),
    );
    expect(persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
  });

  it("leaves a running Cloudflare lifecycle unchanged while its runner is live", async () => {
    const meta = makeMeta();
    const getState = vi.fn();
    mocks.getEnvLifecycleStub.mockReturnValue({ getState });
    mocks.getRunnerBackend.mockResolvedValue({
      kind: "cf",
      inspect: vi.fn().mockResolvedValue({ state: "live", status: "running" }),
    });

    await expect(projectEnvMetaForRead(makeEnv(), meta)).resolves.toBe(meta);
    expect(getState).not.toHaveBeenCalled();
  });

  it("treats a Cloudflare inspection error as unknown instead of failing the read", async () => {
    const meta = makeMeta();
    const getState = vi.fn();
    mocks.getEnvLifecycleStub.mockReturnValue({ getState });
    mocks.getRunnerBackend.mockResolvedValue({
      kind: "cf",
      inspect: vi.fn().mockRejectedValue(new Error("control plane unavailable")),
    });

    await expect(projectEnvMetaForRead(makeEnv(), meta)).resolves.toBe(meta);
    expect(getState).not.toHaveBeenCalled();
  });

  it("does not inspect host runners or Cloudflare runners that are still starting", async () => {
    const host = makeMeta({
      backend: "host",
      executionPlacement: { backend: "host", machineId: "machine-1" },
    });
    const starting = makeMeta({ status: "starting", lifecyclePhase: "starting" });

    await expect(projectEnvMetaForRead(makeEnv(), host)).resolves.toBe(host);
    await expect(projectEnvMetaForRead(makeEnv(), starting)).resolves.toBe(starting);
    expect(mocks.getRunnerBackend).not.toHaveBeenCalled();
  });

  it("does not apply an absent inspection after lifecycle ownership changes", async () => {
    const meta = makeMeta();
    const current = makeMeta({
      status: "starting",
      lifecyclePhase: "starting",
      lifecycleOpId: "start-op-2",
      updatedAt: "2026-08-12T00:02:00.000Z",
    });
    const noteRunnerStopped = vi.fn();
    const persistOwnedProjection = vi.fn().mockResolvedValue(current);
    mocks.getEnvLifecycleStub.mockReturnValue({
      getState: vi.fn().mockResolvedValue(runningLifecycle({
        phase: "starting",
        activeOpId: "start-op-2",
        runtimeReady: false,
      })),
      noteRunnerStopped,
      persistOwnedProjection,
    });
    mocks.getRunnerBackend.mockResolvedValue({
      kind: "cf",
      inspect: vi.fn().mockResolvedValue({ state: "absent", status: "stopped" }),
    });

    await expect(projectEnvMetaForRead(makeEnv(), meta)).resolves.toBe(current);
    expect(noteRunnerStopped).not.toHaveBeenCalled();
    expect(persistOwnedProjection).toHaveBeenCalledWith({ broadcast: false });
  });
});
