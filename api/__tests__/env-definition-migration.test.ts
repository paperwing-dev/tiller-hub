import { describe, expect, it, vi } from "vitest";
import type { EnvMeta, EnvMutableState } from "../types";
import { createInitialEnvScmState } from "../scm/model";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
}));

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    getEnvLifecycleStub: mocks.getEnvLifecycleStub,
    getRepoMergeLockStub: vi.fn(),
    getWorkspaceStub: vi.fn(),
  };
});

const { buildEnvDefinition, projectAndPersistEnvSummary } = await import("../env/service");
const {
  getEnvDefinitionKey,
  persistEnvDefinition,
  readEnvDefinition,
  readEnvSummary,
} = await import("../plan/store");

function createMemoryKV() {
  const data = new Map<string, string>();
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    list: vi.fn(async () => ({ keys: Array.from(data.keys()).map((name) => ({ name })) })),
  };
}

function baseLegacyMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "env-test",
    repoUrl: "https://github.com/example/repo",
    repoId: "repo-1",
    backend: "cf",
    harness: "claude-code",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "env-test",
      mainCommit: "main-sha",
    }),
    bootMessage: "Workspace: 42 files",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
    branchStatus: "up-to-date",
    leadHarnessStatus: null,
    leadHarnessError: null,
    leadHarnessUpdatedAt: null,
    ...overrides,
  };
}

describe("env definition storage", () => {
  it("prefixes slugs with envdef:", () => {
    expect(getEnvDefinitionKey("my-env")).toBe("envdef:my-env");
  });

  it("builds definitions from stable env fields only", () => {
    const definition = buildEnvDefinition(baseLegacyMeta({
      startupPlanId: "plan-1",
      branchName: "env-test-branch",
      authMode: "subscription",
      resolvedAuthMode: "subscription",
    }));

    expect(definition).toEqual({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      repoId: "repo-1",
      backend: "cf",
      harness: "claude-code",
      authMode: "subscription",
      resolvedAuthMode: "subscription",
      startupPlanId: "plan-1",
      branchName: "env-test-branch",
      createdAt: "2026-04-01T00:00:00.000Z",
    });
    expect(definition).not.toHaveProperty("flyMachineId");
    expect(definition).not.toHaveProperty("status");
    expect(definition).not.toHaveProperty("workspaceDirty");
    expect(definition).not.toHaveProperty("bootMessage");
  });

  it("persists and reads definitions with explicit branch names", async () => {
    const kv = createMemoryKV();
    const env = { ENVS_KV: kv as any } as any;

    await persistEnvDefinition(env, {
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      backend: "cf",
      harness: "claude-code",
      startupPlanId: null,
      branchName: "env/env-test",
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    await expect(readEnvDefinition(env, "env-test")).resolves.toMatchObject({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      branchName: "env/env-test",
    });
    expect(kv.data.has("envdef:env-test")).toBe(true);
  });

  it("reads summary rows from the slug key", async () => {
    const kv = createMemoryKV();
    const meta = baseLegacyMeta();
    kv.data.set("env-test", JSON.stringify(meta));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvSummary(env, "env-test")).resolves.toMatchObject({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
    });
  });

  it("rejects definitions that omit explicit environment schema fields", async () => {
    const kv = createMemoryKV();
    kv.data.set("envdef:env-test", JSON.stringify({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      backend: "cf",
      createdAt: "2026-04-01T00:00:00.000Z",
    }));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvDefinition(env, "env-test")).rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects summaries that omit explicit environment schema fields", async () => {
    const kv = createMemoryKV();
    kv.data.set("env-test", JSON.stringify({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      backend: "cf",
      createdAt: "2026-04-01T00:00:00.000Z",
      status: "running",
    }));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvSummary(env, "env-test")).rejects.toThrow("missing explicit environment schema fields");
  });
});

describe("env summary projection", () => {
  it("does not project envs without a persisted definition", async () => {
    const kv = createMemoryKV();
    const meta = baseLegacyMeta();
    kv.data.set("env-test", JSON.stringify(meta));

    const hub = { broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined) };
    const env = { ENVS_KV: kv as any } as any;

    await expect(projectAndPersistEnvSummary(env, hub as any, "env-test")).resolves.toBeNull();
    expect(hub.broadcastEnvUpsert).not.toHaveBeenCalled();
  });

  it("hydrates mutable state from the cached summary when the definition exists", async () => {
    const kv = createMemoryKV();
    const meta = baseLegacyMeta();
    kv.data.set("env-test", JSON.stringify(meta));
    await persistEnvDefinition({ ENVS_KV: kv as any } as any, buildEnvDefinition(baseLegacyMeta()));

    const mutableState: EnvMutableState = {
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleLastRunnerState: "running",
      lifecycleLastWorkspaceSyncedAckOpId: null,
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
      lifecycleUpdatedAt: "2026-04-01T00:10:00.000Z",
      runnerId: "runner-1",
      runnerMachineId: null,
      bootMessage: "Workspace: 42 files",
      bootStepId: null,
      authWarning: null,
      branchStatus: "up-to-date",
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
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
      leadHarnessStatus: null,
      leadHarnessError: null,
      leadHarnessUpdatedAt: null,
      error: null,
      errorAt: null,
      updatedAt: "2026-04-01T00:10:00.000Z",
    };

    const hydrateFromSummary = vi.fn(async () => mutableState);
    mocks.getEnvLifecycleStub.mockReturnValue({
      getMutableState: vi.fn(async () => null),
      hydrateFromSummary,
    });

    const hub = { broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined) };
    const env = { ENVS_KV: kv as any } as any;

    const summary = await projectAndPersistEnvSummary(env, hub as any, "env-test");

    expect(summary).toMatchObject({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      runnerId: "runner-1",
      workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
      lifecyclePhase: "running",
      status: "running",
    });
    expect(hydrateFromSummary).toHaveBeenCalledWith(expect.objectContaining({
      slug: "env-test",
      workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
    }));
    expect(kv.data.has("env-test")).toBe(true);
    expect(hub.broadcastEnvUpsert).toHaveBeenCalledTimes(1);
  });

  it("returns null when neither a definition nor a legacy summary exists", async () => {
    const kv = createMemoryKV();
    mocks.getEnvLifecycleStub.mockReturnValue({});

    const hub = { broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined) };
    const env = { ENVS_KV: kv as any } as any;

    await expect(projectAndPersistEnvSummary(env, hub as any, "missing-env")).resolves.toBeNull();
    expect(hub.broadcastEnvUpsert).not.toHaveBeenCalled();
  });
});
