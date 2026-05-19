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
    repoUrl: "https://github.com/example/repo",
    backend: "cf",
    harness: "claude-code",
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
    await subject.hydrateFromSummary(metaWithWorkspace());

    await subject.setBootProgress("Reconnecting harness...");
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.branchStatus).toBe("ready-to-merge");
    expect(state.bootMessage).toBe("Reconnecting harness...");
  });

  it("workspace-sync state survives a later harness-failed update", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());

    await subject.setLeadHarnessFailed("harness crashed");
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.leadHarnessStatus).toBe("failed");
    expect(state.leadHarnessError).toBe("harness crashed");
  });

  it("workspace-sync state survives a later SCM projection change", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());

    await subject.setScmProjection({
      type: "merge-into-main",
      operationId: "op-42",
      phase: "Downloading artifacts",
    });
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.branchStatus).toBe("ready-to-merge");
    expect(state.scmOperationType).toBe("merge-into-main");
    expect(state.scmOperationId).toBe("op-42");
  });

  it("SCM clear preserves lifecycle and workspace-sync fields", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());
    await subject.setScmProjection({
      type: "merge-into-main",
      operationId: "op-42",
      phase: "Downloading artifacts",
    });

    await subject.clearScmProjection({ completedAt: "2026-04-01T00:20:00.000Z" });
    const state = await readMutableState(subject);

    expect(state.scmOperationType).toBeNull();
    expect(state.scmOperationId).toBeNull();
    expect(state.scmLastCompletedAt).toBe("2026-04-01T00:20:00.000Z");
    expect(state.workspaceDirty).toBe(true);
    expect(state.branchStatus).toBe("ready-to-merge");
  });

  it("idle auto-stop (requestStop + clearError) cannot erase fresh workspace metadata", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());

    await subject.clearError();
    await subject.requestStop();
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.baseMainCommit).toBe("main-sha");
  });

  it("workspace-sync failure cannot erase previously saved workspace metadata", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());
    const stopLifecycle = await subject.requestStop();

    await subject.recordWorkspaceSyncFailed(stopLifecycle.activeOpId, "persistence error");
    const state = await readMutableState(subject);

    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
    expect(state.branchStatus).toBe("ready-to-merge");
    expect(state.error).toBe("persistence error");
  });

  it("stale SCM clear cannot erase unrelated lifecycle or workspace fields", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());
    await subject.setScmProjection({
      type: "merge-into-main",
      operationId: "op-merge-1",
      phase: "Staging",
    });

    await subject.clearScmProjection();
    const state = await readMutableState(subject);

    expect(state.scmOperationType).toBeNull();
    expect(state.scmOperationId).toBeNull();
    expect(state.workspaceDirty).toBe(true);
    expect(state.branchStatus).toBe("ready-to-merge");
  });

  it("setRunnerBinding updates only binding fields, leaves workspace alone", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());

    await subject.setRunnerBinding({
      runnerId: "new-runner",
    });
    const state = await readMutableState(subject);

    expect(state.runnerId).toBe("new-runner");
    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
  });

  it("setAuthWarning leaves workspace untouched", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());

    await subject.setAuthWarning("token near expiry");
    const state = await readMutableState(subject);

    expect(state.authWarning).toBe("token near expiry");
    expect(state.workspaceDirty).toBe(true);
    expect(state.workspaceLastSyncedAt).toBe("2026-04-01T00:10:00.000Z");
  });

  it("clearing auth warning leaves workspace untouched", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());
    await subject.setAuthWarning("token near expiry");

    await subject.setAuthWarning(null);
    const state = await readMutableState(subject);

    expect(state.authWarning).toBeNull();
    expect(state.workspaceDirty).toBe(true);
  });

  it("recordStopWorkspaceSynced overwrites workspace fields but preserves unrelated state", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace({ bootMessage: "booting" }));
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

  it("clearError leaves workspace and SCM fields untouched", async () => {
    const subject = createSubject();
    await subject.hydrateFromSummary(metaWithWorkspace());
    await subject.setError("transient failure");
    await subject.setScmProjection({
      type: "merge-into-main",
      operationId: "op-3",
      phase: "starting",
    });

    await subject.clearError();
    const state = await readMutableState(subject);

    expect(state.error).toBeNull();
    expect(state.errorAt).toBeNull();
    expect(state.workspaceDirty).toBe(true);
    expect(state.scmOperationType).toBe("merge-into-main");
    expect(state.scmOperationId).toBe("op-3");
  });
});
