import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMutableState, EnvMeta } from "../types";

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

function baseEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
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
    bootMessage: "Workspace: 42 files",
    startupPlanId: null,
    branchName: "env/env-test",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
    branchStatus: "up-to-date",
    scmOperationType: null,
    scmOperationId: null,
    scmOperationPhase: null,
    scmOperationStartedAt: null,
    scmOperationUpdatedAt: null,
    scmLastCompletedAt: null,
    scmLastDurationMs: null,
    scmLastTimings: null,
    leadHarnessStatus: null,
    leadHarnessError: null,
    leadHarnessUpdatedAt: null,
    ...overrides,
  };
}

describe("EnvLifecycleDO mutable state", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("hydrates mutable state from summary metadata", async () => {
    const subject = createSubject();

    await subject.initializeMutableStateFromMeta(baseEnvMeta());
    const state = await readMutableState(subject);

    expect(state).toMatchObject({
      bootMessage: "Workspace: 42 files",
      workspaceDirty: false,
      workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
      baseMainCommit: "main-sha",
      branchStatus: "up-to-date",
    } satisfies Partial<EnvMutableState>);
  });

  it("boot-progress update preserves workspace fields", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.setBootProgress("next step");
    const state = await readMutableState(subject);

    expect(state.bootMessage).toBe("next step");
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:00:10.000Z");
    expect(state.branchStatus).toBe("up-to-date");
  });

  it("lead harness failure preserves workspace fields", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.setLeadHarnessFailed("runtime crash");
    const state = await readMutableState(subject);

    expect(state.leadHarnessStatus).toBe("failed");
    expect(state.leadHarnessError).toBe("runtime crash");
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:00:10.000Z");
    expect(state.branchStatus).toBe("up-to-date");
  });

  it("recordStopWorkspaceSynced updates workspace fields", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.recordStopWorkspaceSynced({
      workspaceDirty: true,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: "2026-04-02T00:00:00.000Z",
      baseMainCommit: "main-sha",
      lastKnownMainCommit: "main-sha",
      branchStatus: "ready-to-merge",
    });
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-02T00:00:00.000Z");
    expect(state.branchStatus).toBe("ready-to-merge");
  });

  it("interleaving boot-progress and workspace-sync updates preserves last write of each", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.setBootProgress("starting harness");
    await subject.recordStopWorkspaceSynced({
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: "2026-04-02T00:00:00.000Z",
      baseMainCommit: "main-sha",
      lastKnownMainCommit: "main-sha",
      branchStatus: "up-to-date",
    });
    await subject.setBootProgress("ready");

    const state = await readMutableState(subject);

    expect(state.bootMessage).toBe("ready");
    expect(state.workspaceLastSyncedAt).toBe("2026-04-02T00:00:00.000Z");
    expect(state.branchStatus).toBe("up-to-date");
  });

  it("setRunnerBinding updates the runtime id without touching other fields", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.setRunnerBinding({
      runnerId: "runner-42",
    });
    const state = await readMutableState(subject);

    expect(state.runnerId).toBe("runner-42");
    expect(state.bootMessage).toBe("Workspace: 42 files");
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:00:10.000Z");
  });

  it("setError sets error and errorAt", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.setError("something broke");
    const state = await readMutableState(subject);

    expect(state.error).toBe("something broke");
    expect(state.errorAt).toBeDefined();
  });

  it("clearError removes error state only", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());
    await subject.setError("something broke");

    await subject.clearError();
    const state = await readMutableState(subject);

    expect(state.error).toBeNull();
    expect(state.errorAt).toBeNull();
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:00:10.000Z");
  });

  it("clearMutableState removes the mutable row entirely", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.clearMutableState();
    await expect(subject.getMutableState()).resolves.toBeNull();
  });

  it("setStatus updates status without erasing workspace fields", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(baseEnvMeta());

    await subject.setStatus("failed");
    const state = await readMutableState(subject);

    expect(state.status).toBe("failed");
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:00:10.000Z");
  });
});
