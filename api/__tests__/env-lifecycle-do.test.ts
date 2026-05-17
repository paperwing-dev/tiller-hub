import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvLifecycleState, EnvMeta } from "../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../scm/model";
import { ENV_LIFECYCLE_SAVE_TIMEOUT_MS, ENV_LIFECYCLE_STOP_TIMEOUT_MS } from "../env-lifecycle";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { EnvLifecycleDO } from "../env-lifecycle-do";

type MemoryStorage = {
  get: <T>(key: string) => Promise<T | null>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (time: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, unknown>();
  let alarmAt: number | null = null;

  return {
    async get<T>(key: string) {
      return (data.get(key) as T | undefined) ?? null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(time: number) {
      alarmAt = time;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
  };
}

function createSubject(envOverrides: Record<string, unknown> = {}) {
  const instance = Object.create(EnvLifecycleDO.prototype) as EnvLifecycleDO & {
    ctx: { storage: MemoryStorage };
  };
  instance.ctx = {
    storage: createMemoryStorage(),
  } as any;
  (instance as any).env = envOverrides;
  return instance;
}

function createEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    repoUrl: "https://github.com/test/repo",
    backend: "cf",
    harness: "claude-code",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "demo-env",
      mainCommit: "main-old",
    }),
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

describe("EnvLifecycleDO", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("creates a saving stop operation", async () => {
    const subject = createSubject();

    const state = await subject.requestStop();

    expect(state.phase).toBe("saving");
    expect(state.activeOperation).toBe("stop");
    expect(state.desiredState).toBe("stopped");
    expect(state.activeOpId).toMatch(/^stop-/);
  });

  it("creates a starting start operation", async () => {
    const subject = createSubject();

    const state = await subject.requestStart();

    expect(state.phase).toBe("starting");
    expect(state.activeOperation).toBe("start");
    expect(state.desiredState).toBe("running");
    expect(state.activeOpId).toMatch(/^start-/);
  });

  it("advances starting to running on matching runner-ready event", async () => {
    const subject = createSubject();
    const initial = await subject.requestStart();

    const next = await subject.noteRunnerStarted(initial.activeOpId);

    expect(next).toMatchObject({
      phase: "running",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "running",
      infraState: "ready",
      runtimeReady: true,
    });
  });

  it("marks a starting env infra-ready without completing startup", async () => {
    const subject = createSubject();
    const initial = await subject.requestStart();

    const next = await subject.noteInfraReady(initial.activeOpId);

    expect(next).toMatchObject({
      phase: "starting",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "running",
      infraState: "ready",
      runtimeReady: false,
    });
  });

  it("fails a matching starting operation when runner startup fails", async () => {
    const subject = createSubject();
    const initial = await subject.requestStart();

    const next = await subject.noteRunnerStartFailed(initial.activeOpId, "boot failed");

    expect(next).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "stopped",
    });
    expect(next?.lastError).toContain("boot failed");
  });

  it("ignores stale runner-ready callbacks after a retried start", async () => {
    const subject = createSubject();
    const initial = await subject.requestStart();
    await subject.noteRunnerStartFailed(initial.activeOpId, "boot failed");
    const retried = await subject.requestStart();

    const next = await subject.noteRunnerStarted(initial.activeOpId);

    expect(retried.activeOpId).not.toBe(initial.activeOpId);
    expect(next).toMatchObject({
      phase: "starting",
      activeOpId: retried.activeOpId,
      desiredState: "running",
    });
  });

  it("advances saving to stopping on matching workspace-synced ack", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    const next = await subject.noteStopWorkspaceSynced(initial.activeOpId);

    expect(next).toMatchObject({
      phase: "stopping",
      activeOpId: initial.activeOpId,
      lastWorkspaceSyncedAckOpId: initial.activeOpId,
    });
  });

  it("ignores stale workspace-synced acks", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    const next = await subject.noteStopWorkspaceSynced("stop-stale");

    expect(next).toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
    });
  });

  it("fails if the runner exits before workspace persistence", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(next).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
    });
    expect(next?.lastError).toContain("workspace persistence completed");
  });

  it("transitions stopping to stopped when the runner exits after persistence", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.noteStopWorkspaceSynced(initial.activeOpId);

    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(next).toMatchObject({
      phase: "stopped",
      activeOpId: initial.activeOpId,
      lastRunnerState: "stopped",
    });
  });

  it("clears stop progress after the runner fully stops", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.setBootProgress("Confirming workspace saved...", "workspace-sync");
    await subject.noteStopWorkspaceSynced(initial.activeOpId);

    await subject.noteRunnerStopped(initial.activeOpId, "exit");

    const mutable = await subject.getMutableState();
    expect(mutable).toMatchObject({
      status: "stopped",
      bootMessage: null,
      bootStepId: null,
    });
  });

  it("recovers a timed-out stopping env when the matching runner-stop callback arrives late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.noteStopWorkspaceSynced(initial.activeOpId);

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_STOP_TIMEOUT_MS + 1_000));
    const timedOut = await subject.getState();
    const recovered = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(timedOut).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      desiredState: "stopped",
      lastWorkspaceSyncedAckOpId: initial.activeOpId,
    });
    expect(recovered).toMatchObject({
      phase: "stopped",
      activeOpId: initial.activeOpId,
      desiredState: "stopped",
      lastRunnerState: "stopped",
    });
    expect(recovered?.lastError).toBeNull();
    vi.useRealTimers();
  });

  it("ignores stale runner-stop callbacks after a retried stop", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.noteWorkspaceSyncFailed(initial.activeOpId, "save failed");
    const retried = await subject.requestStop();

    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(retried.activeOpId).not.toBe(initial.activeOpId);
    expect(next).toMatchObject({
      phase: "saving",
      activeOpId: retried.activeOpId,
      desiredState: "stopped",
    });
  });

  it("applies a partial workspace patch from the stop-finalize ack", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({ baseMainCommit: "main-old" }));
    const initial = await subject.requestStop();

    await subject.noteStopWorkspaceSynced(initial.activeOpId, {
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-21T12:00:00.000Z",
    });

    const mutable = await subject.getMutableState();
    expect(mutable).toMatchObject({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-21T12:00:00.000Z",
      baseMainCommit: "main-old",
    });
  });

  it("treats a stop-finalize workspace sync from a running env as a graceful self-stop", async () => {
    const subject = createSubject();
    const initial = await subject.requestStart();
    await subject.noteRunnerStarted(initial.activeOpId);

    const stopping = await subject.noteStopWorkspaceSynced();
    const stopped = await subject.noteRunnerStopped(initial.activeOpId, "exit");
    const mutable = await subject.getMutableState();

    expect(stopping).toMatchObject({
      phase: "stopping",
      desiredState: "stopped",
      activeOperation: "stop",
    });
    expect(stopped).toMatchObject({
      phase: "stopped",
      desiredState: "stopped",
      lastRunnerState: "stopped",
    });
    expect(mutable).toMatchObject({
      workspaceDirty: null,
      workspaceNeedsAttention: null,
      workspaceLastSyncedAt: null,
      baseMainCommit: null,
      lastKnownMainCommit: null,
      branchStatus: null,
    });
  });

  it("fails a running env when the runner exits unexpectedly", async () => {
    const subject = createSubject();
    const initial = await subject.requestStart();
    await subject.noteRunnerStarted(initial.activeOpId);

    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(next).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "stopped",
    });
    expect(next?.lastError).toContain("environment was running");
  });

  it("times out saving operations into failed state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    await subject.requestStop();

    vi.setSystemTime(new Date("2026-04-10T00:01:20.000Z"));
    const next = await subject.getState();

    expect(next).toMatchObject({
      phase: "failed",
    } satisfies Partial<EnvLifecycleState>);
    expect(next?.lastError).toContain("before timeout");
    vi.useRealTimers();
  });

  it("peeks mutable state without resolving lifecycle timeouts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    await subject.requestStop();

    vi.setSystemTime(new Date("2026-04-10T00:01:20.000Z"));
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      status: "saving",
      lifecyclePhase: "saving",
    });
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "failed",
    });
    vi.useRealTimers();
  });

  it("persists and broadcasts a timed-out stop from the alarm path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const kvWrites = new Map<string, string>();
    const broadcastEnvUpsert = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: {
        get: vi.fn(async (key: string) => {
          if (key === "envdef:demo-env") {
            return JSON.stringify({
              slug: "demo-env",
              repoUrl: "https://github.com/test/repo",
              repoId: "repo-1",
              backend: "cf",
              harness: "claude-code",
              startupPlanId: null,
              branchName: "env/demo-env",
              createdAt: "2026-04-10T00:00:00.000Z",
            });
          }
          if (key === "repo:repo-1") {
            return JSON.stringify({
              repoId: "repo-1",
              updatedAt: "2026-04-10T00:00:00.000Z",
            });
          }
          return kvWrites.get(key) ?? null;
        }),
        put: vi.fn(async (key: string, value: string) => {
          kvWrites.set(key, value);
        }),
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({
          broadcastEnvUpsert,
        }),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn().mockReturnValue({
          readWorkspaceFile: vi.fn(async (path: string) => {
            if (path !== "/.tiller/repo/meta.json") {
              return null;
            }
            return JSON.stringify({
              repoId: "repo-1",
              githubInstallationId: 98765,
              githubFullName: "test/repo",
              ...createInitialRepoScmState(),
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
              bootstrappedFromRef: "HEAD",
            });
          }),
        }),
      },
    };
    const subject = createSubject(env);
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    await subject.requestStop();

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 5_000));
    await subject.alarm();

    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"failed\""),
    );
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("workspace persistence before timeout"),
    );
    expect(broadcastEnvUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo-env",
        status: "failed",
        error: expect.stringContaining("workspace persistence before timeout"),
      }),
    );
    vi.useRealTimers();
  });

  it("times out starting operations into failed state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    await subject.requestStart();

    vi.setSystemTime(new Date("2026-04-10T00:01:40.000Z"));
    const next = await subject.getState();

    expect(next).toMatchObject({
      phase: "failed",
      desiredState: "running",
    } satisfies Partial<EnvLifecycleState>);
    expect(next?.lastError).toContain("runner readiness");
    vi.useRealTimers();
  });

  it("preserves workspace sync state across boot, harness, and scm updates", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta());

    await subject.recordStopWorkspaceSynced({
      workspaceDirty: true,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
      baseMainCommit: "main-old",
      lastKnownMainCommit: "main-old",
      branchStatus: "ready-to-merge",
    }, { clearError: false });
    await subject.setBootProgress("Booting...");
    await subject.setLeadHarnessFailed("Harness exited");
    await subject.setScmProjection({
      type: "merge-into-main",
      operationId: "op-1",
      phase: "Starting sandbox",
    });

    await expect(subject.getMutableState()).resolves.toMatchObject({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
      branchStatus: "ready-to-merge",
      bootMessage: "Booting...",
      leadHarnessStatus: "failed",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-1",
    });
  });

  it("rejects hydrated summaries that omit status", async () => {
    const subject = createSubject();

    await expect(
      subject.initializeMutableStateFromMeta(createEnvMeta({ status: undefined })),
    ).rejects.toThrow("Env summary is missing explicit core fields");
  });

  it("rejects hydrated summaries that omit updatedAt", async () => {
    const subject = createSubject();

    await expect(
      subject.initializeMutableStateFromMeta(createEnvMeta({ updatedAt: undefined })),
    ).rejects.toThrow("Env summary is missing explicit core fields");
  });

  it("clears stale scm projection without erasing workspace or lifecycle state", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      status: "stopped",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    }));
    await subject.requestStart();
    await subject.setScmProjection({
      type: "merge-into-main",
      operationId: "op-2",
      phase: "Starting sandbox",
    });

    await subject.clearScmProjection({
      completedAt: "2026-04-10T00:00:07.000Z",
      durationMs: 1234,
    });

    await expect(subject.getMutableState()).resolves.toMatchObject({
      status: "starting",
      lifecyclePhase: "starting",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      scmOperationType: null,
      scmLastCompletedAt: "2026-04-10T00:00:07.000Z",
      scmLastDurationMs: 1234,
    });
  });
});
