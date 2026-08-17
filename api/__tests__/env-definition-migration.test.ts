import { beforeEach, describe, expect, it, vi } from "vitest";
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
  };
});

const { buildEnvDefinition, projectAndPersistEnvSummary } = await import("../env/service");
const { buildEnvMetaFromLayers, buildMutableStateFromMeta } = await import("../env/state");
const {
  getEnvDefinitionKey,
  persistEnvDefinition,
  readEnvDefinition,
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

beforeEach(() => {
  mocks.getEnvLifecycleStub.mockReset();
});

function baseEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "env-test",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/example/repo",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
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
    const definition = buildEnvDefinition(baseEnvMeta({
      displayName: "Implement settings page",
      startupPlanId: "plan-1",
      branchName: "env-test-branch",
      resolvedAuthMode: "subscription",
    }));

    expect(definition).toEqual({
      slug: "env-test",
      displayName: "Implement settings page",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github",
      executionPlacement: { backend: "cf", machineId: null },
      harness: "claude-code",
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
      displayName: "Scratch #1",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github",
      executionPlacement: { backend: "cf", machineId: null },
      harness: "claude-code",
      startupPlanId: null,
      branchName: "env/env-test",
      createdAt: "2026-04-01T00:00:00.000Z",
    });

    await expect(readEnvDefinition(env, "env-test")).resolves.toMatchObject({
      slug: "env-test",
      displayName: "Scratch #1",
      repoId: "repo-1",
      branchName: "env/env-test",
    });
    expect(kv.data.has("envdef:env-test")).toBe(true);
    expect(kv.data.get("envdef:env-test")).not.toContain("repoUrl");
  });

  it("accepts legacy definitions without display names", async () => {
    const kv = createMemoryKV();
    const legacyDefinition = buildEnvDefinition(baseEnvMeta());
    const env = { ENVS_KV: kv as any } as any;

    await persistEnvDefinition(env, legacyDefinition);

    await expect(readEnvDefinition(env, "env-test")).resolves.not.toHaveProperty("displayName");
    expect(buildEnvMetaFromLayers(
      legacyDefinition,
      buildMutableStateFromMeta(baseEnvMeta()),
      "https://github.com/example/repo",
    )).not.toHaveProperty("displayName");
  });

  it("projects immutable display names through the shared environment summary", () => {
    const meta = baseEnvMeta({ displayName: "Implement settings page" });
    const projected = buildEnvMetaFromLayers(
      buildEnvDefinition(meta),
      buildMutableStateFromMeta(meta),
      meta.repoUrl,
    );

    expect(projected.displayName).toBe("Implement settings page");
  });

  it("rejects non-canonical display names in definitions", async () => {
    const kv = createMemoryKV();
    kv.data.set("envdef:env-test", JSON.stringify({
      ...buildEnvDefinition(baseEnvMeta()),
      displayName: "unsafe\nname",
    }));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvDefinition(env, "env-test"))
      .rejects.toThrow("missing explicit environment schema fields");
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

  it("rejects pre-cutover definitions without an immutable incarnation", async () => {
    const kv = createMemoryKV();
    const { incarnationId: _incarnationId, ...legacyDefinition } = buildEnvDefinition(baseEnvMeta());
    kv.data.set("envdef:env-test", JSON.stringify(legacyDefinition));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvDefinition(env, "env-test"))
      .rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects pre-cutover definitions without an explicit SCM model", async () => {
    const kv = createMemoryKV();
    const { scmModel: _scmModel, ...legacyDefinition } = buildEnvDefinition(baseEnvMeta());
    kv.data.set("envdef:env-test", JSON.stringify(legacyDefinition));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvDefinition(env, "env-test"))
      .rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects pre-cutover definitions that still persist a derived backend", async () => {
    const kv = createMemoryKV();
    const legacyDefinition = {
      ...buildEnvDefinition(baseEnvMeta()),
      backend: "cf",
    };
    kv.data.set("envdef:env-test", JSON.stringify(legacyDefinition));
    const env = { ENVS_KV: kv as any } as any;

    await expect(readEnvDefinition(env, "env-test"))
      .rejects.toThrow("missing explicit environment schema fields");
  });
});

describe("env summary projection", () => {
  it("delegates projection ownership to the environment lifecycle", async () => {
    const kv = createMemoryKV();
    const persistOwnedProjection = vi.fn().mockResolvedValue(null);
    mocks.getEnvLifecycleStub.mockReturnValue({ persistOwnedProjection });

    const hub = { broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined) };
    const env = { ENVS_KV: kv as any } as any;

    await expect(projectAndPersistEnvSummary(env, hub as any, "env-test")).resolves.toBeNull();
    expect(persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    expect(hub.broadcastEnvUpsert).not.toHaveBeenCalled();
  });

  it("returns the lifecycle owner's reconstructed projection", async () => {
    const kv = createMemoryKV();
    const meta = baseEnvMeta();

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
      bootMessage: "Workspace: 42 files",
      bootStepId: null,
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

    const summary = { ...meta, ...mutableState } as EnvMeta;
    const persistOwnedProjection = vi.fn().mockResolvedValue(summary);
    mocks.getEnvLifecycleStub.mockReturnValue({
      persistOwnedProjection,
    });

    const hub = { broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined) };
    const env = { ENVS_KV: kv as any } as any;

    const projected = await projectAndPersistEnvSummary(env, hub as any, "env-test");

    expect(projected).toMatchObject({
      slug: "env-test",
      repoUrl: "https://github.com/example/repo",
      runnerId: "runner-1",
      workspaceLastSyncedAt: "2026-04-01T00:00:10.000Z",
      lifecyclePhase: "running",
      status: "running",
    });
    expect(persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    expect(hub.broadcastEnvUpsert).not.toHaveBeenCalled();
  });

  it("preserves dirty delivery when projection is persisted without broadcasting", async () => {
    const kv = createMemoryKV();
    const meta = baseEnvMeta();
    const persistOwnedProjection = vi.fn().mockResolvedValue(meta);
    mocks.getEnvLifecycleStub.mockReturnValue({ persistOwnedProjection });

    const hub = { broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined) };
    const env = { ENVS_KV: kv as any } as any;

    await expect(projectAndPersistEnvSummary(
      env,
      hub as any,
      "env-test",
      { broadcast: false },
    )).resolves.toBe(meta);
    expect(persistOwnedProjection).toHaveBeenCalledWith({ broadcast: false });
    expect(hub.broadcastEnvUpsert).not.toHaveBeenCalled();
  });
});
