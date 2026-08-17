// Characterization tests: mutations on one concern MUST NOT erase other concerns.
// These regression tests lock the behavior that the DO-owned mutable state
// isolates workspace-sync data from lifecycle/boot/harness/SCM updates.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta, EnvMutableState } from "../types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { EnvLifecycleDO } from "../env-lifecycle-do";

type MemoryStorage = {
  get: <T>(key: string) => Promise<T | null>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  transaction: <T>(callback: (txn: MemoryStorage) => Promise<T>) => Promise<T>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (time: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, unknown>();
  let alarmAt: number | null = null;
  const storage: MemoryStorage = {
    async get<T>(key: string) {
      return (data.get(key) as T | undefined) ?? null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string) {
      data.delete(key);
    },
    async transaction<T>(callback: (txn: MemoryStorage) => Promise<T>) {
      return callback(storage);
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
  return storage;
}

function createSubject() {
  const instance = Object.create(EnvLifecycleDO.prototype) as EnvLifecycleDO & {
    ctx: { storage: MemoryStorage };
  };
  instance.ctx = { storage: createMemoryStorage() } as any;
  return instance;
}

async function readMutableState(subject: EnvLifecycleDO): Promise<EnvMutableState> {
  const state = await subject.getMutableState();
  if (!state) throw new Error("mutable state missing");
  return state;
}

function metaWithWorkspace(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "env-test",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/example/repo",
    repoId: "repo-1",
    scmModel: "github",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    status: "running",
    startupPlanId: null,
    branchName: "env/env-test",
    workspaceDirty: true,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-04-01T00:10:00.000Z",
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
    branchStatus: "ready-to-merge",
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    ...overrides,
  };
}

describe("Mutable state isolation (regression)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("workspace-sync state survives a later boot-progress update", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace());

    await subject.setBootProgress("Reconnecting harness...");
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.branchStatus).toBe("ready-to-merge");
    expect(state.bootMessage).toBe("Reconnecting harness...");
  });

  it("workspace-sync state survives a later harness-failed update", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace());

    await subject.setLeadHarnessFailed("harness crashed");
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.leadHarnessStatus).toBe("failed");
    expect(state.leadHarnessError).toBe("harness crashed");
  });

  it("idle auto-stop (requestStop + clearError) cannot erase fresh workspace metadata", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace());

    await subject.clearError();
    await subject.requestStop();
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.baseMainCommit).toBe("main-sha");
  });

  it("workspace-sync failure cannot erase previously saved workspace metadata", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace());
    const stopLifecycle = await subject.requestStop();

    await subject.recordWorkspaceSyncFailed(stopLifecycle.activeOpId, "persistence error");
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.branchStatus).toBe("ready-to-merge");
    expect(state.error).toBeNull();
    expect(state.status).toBe("saving");
    expect(state.bootMessage).toBe("Retrying workspace save…");
  });

  it("setRunnerBinding updates only binding fields, leaves workspace alone", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace());

    await subject.setRunnerBinding({
      runnerId: "new-runner",
    });
    const state = await readMutableState(subject);

    expect(state.runnerId).toBe("new-runner");
    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
  });

  it("recordStopWorkspaceSynced overwrites workspace fields but preserves unrelated state", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace({ bootMessage: "booting" }));
    await subject.setLeadHarnessFailed("crashed");

    await subject.recordStopWorkspaceSynced({
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: "2026-04-01T00:30:00.000Z",
      baseMainCommit: "main-sha",
      lastKnownMainCommit: "main-sha",
      branchStatus: "up-to-date",
    });
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(false);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:30:00.000Z");
    expect(state.branchStatus).toBe("up-to-date");
    expect(state.bootMessage).toBe("booting");
    expect(state.leadHarnessStatus).toBe("failed");
    expect(state.leadHarnessError).toBe("crashed");
  });

  it("clearError leaves workspace fields untouched", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(metaWithWorkspace());
    await subject.setError("transient failure");

    await subject.clearError();
    const state = await readMutableState(subject);

    expect(state.error).toBeNull();
    expect(state.errorAt).toBeNull();
    expect(state.workspaceDirty).toBe(true);
  });
});
