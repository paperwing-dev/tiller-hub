import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { createInitialEnvScmState } from "../scm/model";

const mocks = vi.hoisted(() => ({
  getArtifactStoreStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  ensureRepoWorkspaceFromRepoUrl: vi.fn(),
  listEnvMetas: vi.fn(),
  getRunnerBackend: vi.fn(),
  getSecret: vi.fn(),
  getOrCreateSecret: vi.fn(),
  resolveProtectionState: vi.fn(),
}));

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  return {
    ...actual,
    getArtifactStoreStub: mocks.getArtifactStoreStub,
    getWorkspaceStub: mocks.getWorkspaceStub,
    getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  };
});

vi.mock("../plan/store", async () => {
  const actual = await vi.importActual<typeof import("../plan/store")>("../plan/store");
  return {
    ...actual,
    ensureRepoWorkspaceFromRepoUrl: mocks.ensureRepoWorkspaceFromRepoUrl,
    listEnvMetas: mocks.listEnvMetas,
  };
});

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

vi.mock("../setup/config", () => ({
  getSecret: mocks.getSecret,
  getOrCreateSecret: mocks.getOrCreateSecret,
}));

vi.mock("../protection", async () => {
  const actual = await vi.importActual<typeof import("../protection")>("../protection");
  return {
    ...actual,
    resolveProtectionState: mocks.resolveProtectionState,
  };
});

const { default: envRoutes } = await import("../env/routes");

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", envRoutes);
  return app;
}

function createExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
}

function buildStoredEnvRecord(record: Record<string, unknown>) {
  const slug = typeof record.slug === "string" ? record.slug : "my-env";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "2024-01-01";
  const branchName = typeof record.branchName === "string" ? record.branchName : undefined;
  const mainCommit =
    typeof record.baseMainCommit === "string"
      ? record.baseMainCommit
      : typeof record.lastKnownMainCommit === "string"
        ? record.lastKnownMainCommit
        : null;

  return {
    ...createInitialEnvScmState({
      slug,
      startupPlanId: record.startupPlanId as string | null | undefined,
      branchName,
      mainCommit,
    }),
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
    status: typeof record.status === "string" ? record.status : "unknown",
    harness:
      record.harness === "claude-code" || record.harness === "codex" || record.harness === "opencode"
        ? record.harness
        : "claude-code",
    ...record,
    backend: record.backend === "host" ? "host" : "cf",
  };
}

function createKvStore(
  initialEntries: Record<string, string | null>,
  putSpy = vi.fn().mockResolvedValue(undefined),
) {
  const store = new Map<string, string>();
  for (const [key, value] of Object.entries(initialEntries)) {
    if (value !== null) {
      if (!key.startsWith("envdef:")) {
        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          if (
            typeof parsed.slug === "string"
            && typeof parsed.repoUrl === "string"
            && typeof parsed.createdAt === "string"
          ) {
            const explicit = buildStoredEnvRecord(parsed);
            store.set(key, JSON.stringify(explicit));
            if (typeof parsed.slug === "string") {
              store.set(`envdef:${parsed.slug}`, JSON.stringify({
                slug: explicit.slug,
                repoUrl: explicit.repoUrl,
                ...(typeof explicit.repoId === "string" ? { repoId: explicit.repoId } : {}),
                backend: explicit.backend,
                ...(typeof explicit.harness === "string" ? { harness: explicit.harness } : {}),
                startupPlanId: explicit.startupPlanId,
                branchName: explicit.branchName,
                createdAt: explicit.createdAt,
              }));
            }
            continue;
          }
        } catch {
          // fall through to raw value storage
        }
      }
      store.set(key, value);
    }
  }

  return {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      await putSpy(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createLifecycleState(overrides: Record<string, unknown> = {}) {
  return {
    phase: "starting",
    activeOpId: "start-op-1",
    activeOperation: "start",
    desiredState: "running",
    lastRunnerState: null,
    lastWorkspaceSyncedAckOpId: null,
    infraState: "unknown",
    runtimeReady: false,
    lastError: null,
    lastErrorAt: null,
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createLifecycleStub() {
  let hydrated = false;
  let current = {
    status: "starting",
    lifecyclePhase: "starting",
    lifecycleOpId: "start-op-1",
    lifecycleOperation: "start",
    lifecycleDesiredState: "running",
    lifecycleLastRunnerState: null as string | null,
    lifecycleLastWorkspaceSyncedAckOpId: null as string | null,
    lifecycleInfraState: "unknown" as const,
    lifecycleRuntimeReady: false,
    lifecycleUpdatedAt: "2026-04-10T00:00:00.000Z",
    runnerId: null as string | null,
    runnerMachineId: null as string | null,
    bootMessage: null as string | null,
    authWarning: null as string | null,
    branchStatus: "up-to-date",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: null as string | null,
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
    scmOperationType: null as string | null,
    scmOperationId: null as string | null,
    scmOperationPhase: null as string | null,
    scmOperationStartedAt: null as string | null,
    scmOperationUpdatedAt: null as string | null,
    scmLastCompletedAt: null as string | null,
    scmLastDurationMs: null as number | null,
    scmLastTimings: null as string | null,
    leadHarnessStatus: null as string | null,
    leadHarnessError: null as string | null,
    leadHarnessUpdatedAt: null as string | null,
    error: null as string | null,
    errorAt: null as string | null,
    updatedAt: "2026-04-10T00:00:00.000Z",
  };
  return {
    clearMutableState: vi.fn().mockResolvedValue(null),
    clearState: vi.fn().mockResolvedValue(null),
    getState: vi.fn().mockResolvedValue(null),
    getMutableState: vi.fn().mockImplementation(async () => (hydrated ? current : null)),
    hydrateFromSummary: vi.fn().mockImplementation(async (meta: Record<string, unknown>) => {
      const status = typeof meta.status === "string" ? meta.status : current.status;
      const updatedAt =
        typeof meta.updatedAt === "string"
          ? meta.updatedAt
          : typeof meta.createdAt === "string"
            ? meta.createdAt
            : current.updatedAt;
      current = {
        ...current,
        status,
        lifecyclePhase: typeof meta.lifecyclePhase === "string" ? meta.lifecyclePhase : status,
        lifecycleDesiredState:
          typeof meta.lifecycleDesiredState === "string"
            ? meta.lifecycleDesiredState
            : status === "running" || status === "starting"
              ? "running"
              : "stopped",
        lifecycleInfraState:
          typeof meta.lifecycleInfraState === "string"
            ? meta.lifecycleInfraState as "unknown" | "ready" | "stopped"
            : current.lifecycleInfraState,
        lifecycleRuntimeReady:
          typeof meta.lifecycleRuntimeReady === "boolean"
            ? meta.lifecycleRuntimeReady
            : current.lifecycleRuntimeReady,
        runnerId: typeof meta.runnerId === "string" ? meta.runnerId : current.runnerId,
        runnerMachineId: typeof meta.runnerMachineId === "string" ? meta.runnerMachineId : current.runnerMachineId,
        bootMessage: typeof meta.bootMessage === "string" ? meta.bootMessage : current.bootMessage,
        branchStatus: typeof meta.branchStatus === "string" ? meta.branchStatus : current.branchStatus,
        workspaceDirty: typeof meta.workspaceDirty === "boolean" ? meta.workspaceDirty : current.workspaceDirty,
        workspaceNeedsAttention:
          typeof meta.workspaceNeedsAttention === "boolean"
            ? meta.workspaceNeedsAttention
            : current.workspaceNeedsAttention,
        workspaceLastSyncedAt:
          typeof meta.workspaceLastSyncedAt === "string"
            ? meta.workspaceLastSyncedAt
            : current.workspaceLastSyncedAt,
        baseMainCommit: typeof meta.baseMainCommit === "string" ? meta.baseMainCommit : current.baseMainCommit,
        lastKnownMainCommit:
          typeof meta.lastKnownMainCommit === "string" ? meta.lastKnownMainCommit : current.lastKnownMainCommit,
        updatedAt,
        lifecycleUpdatedAt: typeof meta.lifecycleUpdatedAt === "string" ? meta.lifecycleUpdatedAt : updatedAt,
      };
      hydrated = true;
      return current;
    }),
    requestStart: vi.fn().mockImplementation(async () => {
      const lifecycle = createLifecycleState();
      current = {
        ...current,
        status: "starting",
        lifecyclePhase: "starting",
        lifecycleOpId: String(lifecycle.activeOpId),
        lifecycleOperation: String(lifecycle.activeOperation),
        lifecycleDesiredState: String(lifecycle.desiredState),
        lifecycleLastRunnerState: null,
        lifecycleInfraState: "unknown",
        lifecycleRuntimeReady: false,
        lifecycleUpdatedAt: String(lifecycle.updatedAt),
        updatedAt: String(lifecycle.updatedAt),
      };
      hydrated = true;
      return lifecycle;
    }),
    requestStop: vi.fn().mockResolvedValue(null),
    reconcile: vi.fn().mockResolvedValue(null),
    clearLeadHarnessState: vi.fn().mockResolvedValue(current),
    beginStartupDiagnostics: vi.fn().mockResolvedValue(current),
    getStartupDiagnostics: vi.fn().mockResolvedValue({ active: null, lastFailed: null }),
    setAuthWarning: vi.fn().mockImplementation(async (warning: string | null) => {
      hydrated = true;
      current = { ...current, authWarning: warning };
      return current;
    }),
    setBootProgress: vi.fn().mockImplementation(async (message: string | null) => {
      hydrated = true;
      current = { ...current, bootMessage: message };
      return current;
    }),
    setLeadHarnessFailed: vi.fn().mockResolvedValue(current),
    setRunnerBinding: vi.fn().mockImplementation(async (binding: Record<string, unknown>) => {
      current = {
        ...current,
        runnerId: typeof binding.runnerId === "string" ? binding.runnerId : current.runnerId,
        runnerMachineId: typeof binding.runnerMachineId === "string" ? binding.runnerMachineId : current.runnerMachineId,
      };
      return current;
    }),
    reportStartupFailure: vi.fn().mockResolvedValue(current),
    reportStartupEvent: vi.fn().mockResolvedValue(null),
    recordStopWorkspaceSynced: vi.fn().mockResolvedValue(current),
    recordWorkspaceSyncFailed: vi.fn().mockResolvedValue(current),
    setScmProjection: vi.fn().mockResolvedValue(current),
    clearScmProjection: vi.fn().mockResolvedValue(current),
    setStatus: vi.fn().mockResolvedValue(current),
    setError: vi.fn().mockResolvedValue(current),
    noteInfraReady: vi.fn().mockResolvedValue(null),
    noteRunnerStarted: vi.fn().mockImplementation(async () => {
      const lifecycle = createLifecycleState({
        phase: "running",
        lastRunnerState: "running",
        infraState: "ready",
        runtimeReady: true,
      });
      current = {
        ...current,
        status: "running",
        lifecyclePhase: "running",
        lifecycleLastRunnerState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: String(lifecycle.updatedAt),
        updatedAt: String(lifecycle.updatedAt),
      };
      return lifecycle;
    }),
    noteRunnerStartFailed: vi.fn().mockResolvedValue(null),
    noteRunnerStopped: vi.fn().mockResolvedValue(null),
    noteStopWorkspaceSynced: vi.fn().mockResolvedValue(null),
    noteWorkspaceSyncFailed: vi.fn().mockResolvedValue(null),
    noteStopDispatchFailed: vi.fn().mockResolvedValue(null),
  };
}

describe("OpenCode environment routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getArtifactStoreStub.mockReturnValue({
      migrateLegacyHandoffs: vi.fn(),
      listArtifacts: vi.fn().mockReturnValue([]),
      listRefs: vi.fn().mockReturnValue([]),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(createLifecycleStub());
    mocks.listEnvMetas.mockResolvedValue([]);
    mocks.getSecret.mockImplementation(async (env: Record<string, unknown>, key: string) => env[key] ?? undefined);
    mocks.getOrCreateSecret.mockImplementation(async (env: Record<string, unknown>, key: string, createValue: () => string) => env[key] ?? createValue());
    mocks.resolveProtectionState.mockResolvedValue({ protectionMode: "public" });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        gitArtifactId: "artifact-1",
        gitStatus: "ready",
        mainCommit: "main-sha",
      },
      workspace: {
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array()),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
    });
    mocks.getWorkspaceStub.mockReturnValue({
      destroyWorkspace: vi.fn().mockResolvedValue(undefined),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 7 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    });
  });

  it("rejects OpenCode env creation unless the harness is explicitly enabled", async () => {
    const app = createTestApp();
    const res = await app.request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          slug: "opencode-env",
          backend: "cf",
          harness: "opencode",
        }),
      },
      {
        ENVS_KV: {
          get: vi.fn().mockResolvedValue(null),
          put: vi.fn().mockResolvedValue(undefined),
        },
        HUB: {
          idFromName: vi.fn().mockReturnValue("hub-id"),
          get: vi.fn().mockReturnValue({
            broadcastEnvUpsert: vi.fn(),
            broadcastEnvRemove: vi.fn(),
            broadcastRepoUpsert: vi.fn(),
            broadcastRepoMainChange: vi.fn(),
            addMessage: vi.fn(),
            getActiveService: vi.fn().mockResolvedValue(null),
          }),
        },
        BUCKET: {
          put: vi.fn().mockResolvedValue(undefined),
          delete: vi.fn().mockResolvedValue(undefined),
          head: vi.fn().mockResolvedValue(null),
        },
      } as any,
      createExecutionCtx() as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "Harness not enabled: opencode",
    });
  });

  it("creates an OpenCode env on the explicit remote backend and injects the hub proxy auth", async () => {
    const create = vi.fn().mockResolvedValue({
      runnerMachineId: "machine-1",
      runnerId: "machine-1",
      backend: "cf",
    });
    mocks.getRunnerBackend.mockResolvedValue({
      create,
      destroy: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue("running"),
    });

    const kvPut = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({}, kvPut);
    const env = {
      ENABLED_ENV_HARNESSES: "claude-code,codex,opencode",
      TILLER_OPENCODE_PROXY_TOKEN: "proxy-token-123",
      ENVS_KV: kv,
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({
          broadcastEnvUpsert: vi.fn(),
          broadcastEnvRemove: vi.fn(),
          broadcastRepoUpsert: vi.fn(),
          broadcastRepoMainChange: vi.fn(),
          addMessage: vi.fn(),
          getActiveService: vi.fn().mockResolvedValue(null),
        }),
      },
      BUCKET: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(null),
      },
    };
    const executionCtx = createExecutionCtx();
    const app = createTestApp();

    const res = await app.request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          slug: "opencode-env",
          backend: "cf",
          harness: "opencode",
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      slug: "opencode-env",
      backend: "cf",
      harness: "opencode",
      status: "starting",
    });

    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0][0];

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "opencode-env",
        backend: "cf",
        harness: "opencode",
      }),
      expect.objectContaining({
        TILLER_HARNESS: "opencode",
        TILLER_OPENCODE_BASE_URL: "https://example.com/api/opencode/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "proxy-token-123",
        TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.5",
      }),
      expect.objectContaining({
        startOpId: "start-op-1",
      }),
    );

    expect(kvPut).toHaveBeenLastCalledWith(
      "opencode-env",
      expect.stringContaining("\"harness\":\"opencode\""),
    );
    expect(kvPut.mock.lastCall?.[1]).toContain("\"opencodeProvider\":\"cloudflare-workers-ai\"");
    expect(kvPut.mock.lastCall?.[1]).toContain("\"opencodeModel\":\"@cf/moonshotai/kimi-k2.5\"");
    const summaryWrites = kvPut.mock.calls.filter(([key]) => key === "opencode-env");
    expect(summaryWrites[0]?.[1]).toContain("\"status\":\"starting\"");
  });

  it("starts an existing OpenCode env and keeps the Workers AI metadata", async () => {
    const start = vi.fn().mockResolvedValue({
      runnerMachineId: "machine-1",
      runnerId: "machine-1",
      backend: "cf",
    });
    const broadcastEnvUpsert = vi.fn().mockResolvedValue(undefined);
    mocks.getRunnerBackend.mockResolvedValue({
      start,
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });

    const kvPut = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({
      "opencode-env": JSON.stringify({
        slug: "opencode-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "machine-1",
        runnerId: "machine-1",
        backend: "cf",
        harness: "opencode",
        opencodeProvider: "cloudflare-workers-ai",
        opencodeModel: "@cf/moonshotai/kimi-k2.5",
        createdAt: "2024-01-01T00:00:00.000Z",
        status: "stopped",
        startupPlanId: null,
        baseMainCommit: "main-sha",
        lastKnownMainCommit: "main-sha",
      }),
    }, kvPut);
    const env = {
      ENABLED_ENV_HARNESSES: "claude-code,codex,opencode",
      TILLER_OPENCODE_PROXY_TOKEN: "proxy-token-123",
      ENVS_KV: kv,
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({
          broadcastEnvUpsert,
          broadcastEnvRemove: vi.fn(),
          broadcastRepoUpsert: vi.fn(),
          broadcastRepoMainChange: vi.fn(),
          addMessage: vi.fn(),
          getActiveService: vi.fn().mockResolvedValue(null),
        }),
      },
      BUCKET: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
        head: vi.fn().mockResolvedValue(null),
      },
    };
    const executionCtx = createExecutionCtx();
    const app = createTestApp();

    const res = await app.request(
      "/api/envs/opencode-env/start",
      { method: "POST" },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "opencode-env",
      status: "starting",
    });

    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0][0];

    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "opencode-env",
        harness: "opencode",
      }),
      expect.objectContaining({
        TILLER_HARNESS: "opencode",
        TILLER_OPENCODE_BASE_URL: "http://localhost/api/opencode/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "proxy-token-123",
        TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.5",
      }),
      expect.objectContaining({
        startOpId: "start-op-1",
      }),
    );

    expect(broadcastEnvUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "opencode-env", status: "starting" }),
    );
    expect(kvPut).toHaveBeenLastCalledWith(
      "opencode-env",
      expect.stringContaining("\"harness\":\"opencode\""),
    );
    expect(kvPut.mock.lastCall?.[1]).toContain("\"opencodeProvider\":\"cloudflare-workers-ai\"");
    expect(kvPut.mock.lastCall?.[1]).toContain("\"opencodeModel\":\"@cf/moonshotai/kimi-k2.5\"");
    expect(kvPut.mock.lastCall?.[1]).toContain("\"status\":\"starting\"");
  });
});
