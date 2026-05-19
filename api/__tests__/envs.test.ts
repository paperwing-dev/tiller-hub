import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { createInitialEnvScmState } from "../scm/model";
import { projectEnvSummary } from "../sync/projectors";
import { applyLifecycleProjectionToMeta } from "../env-lifecycle";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => {
    return env[key] || undefined;
  },
}));

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  return {
    ...actual,
    getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  };
});

import envRoutes from "../env/routes";
import { resolveContainerHubUrl, resolveHubPublicUrl, rewriteLoopbackHubUrlForDocker } from "../env/hub-url";

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (_c, next) => {
    await next();
  });
  app.route("/", envRoutes);
  return app;
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

const ENV_META = JSON.stringify(buildStoredEnvRecord({
  slug: "my-env",
  repoUrl: "https://github.com/test/repo",
  backend: "cf",
  harness: "claude-code",
  createdAt: "2024-01-01",
  updatedAt: "2024-01-01",
  status: "starting",
}));

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
      if (!key.startsWith("envdef:")) {
        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          if (typeof parsed.slug === "string" && typeof parsed.repoUrl === "string" && typeof parsed.createdAt === "string") {
            const explicit = buildStoredEnvRecord(parsed);
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
        } catch {
          // ignore non-env rows
        }
      }
    }
  }

  return {
    get: vi.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
    list: vi.fn().mockImplementation(async (options?: { prefix?: string; cursor?: string }) => ({
      keys: Array.from(store.keys())
        .filter((key) => key.startsWith(options?.prefix ?? ""))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })),
    put: vi.fn().mockImplementation(async (key: string, value: string) => {
      store.set(key, value);
      await putSpy(key, value);
    }),
    delete: vi.fn().mockImplementation(async (key: string) => {
      store.delete(key);
    }),
  };
}

function createHubBinding(
  optionsOrBroadcastEnvUpsert:
    | ReturnType<typeof vi.fn>
    | {
      activeHostService?: Record<string, unknown> | null;
      hostServicesByMachineId?: Record<string, Record<string, unknown>>;
      isHostRoutable?: boolean | ((preferredMachineId?: string | null) => boolean);
      broadcastEnvUpsert?: ReturnType<typeof vi.fn>;
    } = vi.fn().mockResolvedValue(undefined),
) {
  const options = typeof optionsOrBroadcastEnvUpsert === "function"
    ? { broadcastEnvUpsert: optionsOrBroadcastEnvUpsert }
    : optionsOrBroadcastEnvUpsert;

  return {
    idFromName: vi.fn().mockReturnValue("hub-id"),
    get: vi.fn().mockReturnValue({
      broadcastEnvUpsert: options.broadcastEnvUpsert ?? vi.fn().mockResolvedValue(undefined),
      broadcastEnvRemove: vi.fn(),
      broadcastRepoUpsert: vi.fn(),
      broadcastRepoMainChange: vi.fn(),
      addMessage: vi.fn(),
      getActiveService: vi.fn().mockResolvedValue(options.activeHostService ?? null),
      getHostService: vi.fn().mockImplementation(async (machineId?: string | null) => {
        const normalizedMachineId = machineId?.trim() || null;
        if (!normalizedMachineId) {
          return options.activeHostService ?? null;
        }
        return options.hostServicesByMachineId?.[normalizedMachineId] ?? null;
      }),
      isHostRoutable: vi.fn().mockImplementation(async (preferredMachineId?: string | null) => {
        if (typeof options.isHostRoutable === "function") {
          return options.isHostRoutable(preferredMachineId ?? null);
        }
        return options.isHostRoutable ?? false;
      }),
    }),
  };
}

function createLifecycleStub() {
  let hydrated = false;
  let current = {
    status: "starting",
    lifecyclePhase: "starting",
    lifecycleOpId: null,
    lifecycleOperation: null,
    lifecycleDesiredState: "running",
    lifecycleLastRunnerState: null,
    lifecycleLastWorkspaceSyncedAckOpId: null,
    lifecycleInfraState: "unknown" as const,
    lifecycleRuntimeReady: false,
    lifecycleUpdatedAt: "2024-01-01",
    runnerId: null,
    runnerMachineId: null,
    bootMessage: null as string | null,
    bootStepId: null as string | null,
    authWarning: null as string | null,
    branchStatus: null as string | null,
    workspaceDirty: null as boolean | null,
    workspaceNeedsAttention: null as boolean | null,
    workspaceLastSyncedAt: null as string | null,
    baseMainCommit: null as string | null,
    lastKnownMainCommit: null as string | null,
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
    updatedAt: "2024-01-01",
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
              : current.lifecycleDesiredState,
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
        bootStepId: typeof meta.bootStepId === "string" ? meta.bootStepId : current.bootStepId,
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
        error: typeof meta.error === "string" ? meta.error : current.error,
        errorAt: typeof meta.errorAt === "string" ? meta.errorAt : current.errorAt,
        updatedAt,
        lifecycleUpdatedAt: typeof meta.lifecycleUpdatedAt === "string" ? meta.lifecycleUpdatedAt : updatedAt,
      };
      hydrated = true;
      return current;
    }),
    requestStart: vi.fn().mockResolvedValue(null),
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
    setBootProgress: vi.fn().mockImplementation(async (message: string | null, stepId?: string | null) => {
      hydrated = true;
      current = {
        ...current,
        bootMessage: message,
        ...(stepId !== undefined ? { bootStepId: stepId } : {}),
      };
      return current;
    }),
    setLeadHarnessFailed: vi.fn().mockResolvedValue(current),
    setRunnerBinding: vi.fn().mockResolvedValue(current),
    reportStartupEvent: vi.fn().mockResolvedValue(null),
    reportStartupFailure: vi.fn().mockResolvedValue(current),
    recordStopWorkspaceSynced: vi.fn().mockResolvedValue(current),
    recordWorkspaceSyncFailed: vi.fn().mockResolvedValue(current),
    setScmProjection: vi.fn().mockResolvedValue(current),
    clearScmProjection: vi.fn().mockResolvedValue(current),
    setStatus: vi.fn().mockImplementation(async (status: string) => {
      current = { ...current, status };
      return current;
    }),
    setError: vi.fn().mockResolvedValue(current),
    noteInfraReady: vi.fn().mockResolvedValue(null),
    noteRunnerStarted: vi.fn().mockResolvedValue(null),
    noteRunnerStartFailed: vi.fn().mockResolvedValue(null),
    noteRunnerStopped: vi.fn().mockResolvedValue(null),
    noteStopWorkspaceSynced: vi.fn().mockResolvedValue(null),
    noteWorkspaceSyncFailed: vi.fn().mockResolvedValue(null),
    noteStopDispatchFailed: vi.fn().mockResolvedValue(null),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getEnvLifecycleStub.mockReturnValue(createLifecycleStub());
});

describe("POST /api/envs/:slug/boot-progress", () => {
  it("returns 404 for unknown slug", async () => {
    const env = {
      ENVS_KV: createKvStore({}),
      HUB: createHubBinding(),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/unknown/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "test" }),
      },
      env as any,
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when message is missing", async () => {
    const kv = createKvStore({ "my-env": ENV_META });
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
      env as any,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid step id", async () => {
    const kv = createKvStore({ "my-env": ENV_META });
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Saving workspace...", stepId: "nope" }),
      },
      env as any,
    );
    expect(res.status).toBe(400);
  });

  it("broadcasts boot message and returns 200", async () => {
    const mockBroadcast = vi.fn().mockResolvedValue(undefined);
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({ "my-env": ENV_META }, mockPut);
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(mockBroadcast),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Syncing workspace..." }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mockPut.mock.calls.filter(([key]) => key === "my-env")).toHaveLength(2);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "my-env",
        status: "starting",
        bootMessage: "Syncing workspace...",
      }),
    );
  });

  it("broadcasts the optional step id when provided", async () => {
    const mockBroadcast = vi.fn().mockResolvedValue(undefined);
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({ "my-env": ENV_META }, mockPut);
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(mockBroadcast),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Uploading 1 file (48 B)...", stepId: "workspace-sync" }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mockBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "my-env",
        bootMessage: "Uploading 1 file (48 B)...",
        bootStepId: "workspace-sync",
      }),
    );
  });

  it("awaits broadcastEnvUpsert before responding", async () => {
    // If the await is removed, broadcastCompleted will be false when the response arrives
    let broadcastCompleted = false;
    const mockBroadcast = vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            broadcastCompleted = true;
            resolve();
          }, 50);
        }),
    );
    const mockPut = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({ "my-env": ENV_META }, mockPut);
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(mockBroadcast),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/boot-progress",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "Starting services..." }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mockPut.mock.calls.filter(([key]) => key === "my-env")).toHaveLength(2);
    expect(broadcastCompleted).toBe(true);
  });
});

describe("startup diagnostics routes", () => {
  it("returns the stored startup diagnostics snapshot", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.getStartupDiagnostics.mockResolvedValue({
      active: {
        opId: "start-op-1",
        backend: "cf",
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:05.000Z",
        currentStepId: "hub-connect",
        currentStepMessage: "Connecting WebSocket...",
        events: [],
        failure: null,
        logTails: {
          harness: null,
          stopControl: null,
          bootstrap: null,
        },
      },
      lastFailed: null,
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const env = {
      ENVS_KV: createKvStore({ "my-env": ENV_META }),
      HUB: createHubBinding(),
    };
    const app = createTestApp();
    const res = await app.request("/api/envs/my-env/startup-diagnostics", {}, env as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      active: {
        opId: "start-op-1",
        currentStepId: "hub-connect",
      },
      lastFailed: null,
    });
  });

  it("accepts structured startup events", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const env = {
      ENVS_KV: createKvStore({ "my-env": ENV_META }),
      HUB: createHubBinding(),
    };
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/startup-diagnostics",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Lifecycle-Op-Id": "start-op-1",
        },
        body: JSON.stringify({
          type: "event",
          stepId: "hub-connect",
          severity: "info",
          message: "Connecting WebSocket...",
        }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(lifecycleStub.reportStartupEvent).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "hub-connect",
      severity: "info",
      message: "Connecting WebSocket...",
      detail: null,
      at: null,
      logTails: null,
    });
  });

  it("does not expose the deleted terminal route", async () => {
    const env = {
      ENVS_KV: createKvStore({ "my-env": ENV_META }),
      HUB: createHubBinding(),
    };
    const app = createTestApp();
    const res = await app.request("/api/envs/my-env/terminal", {}, env as any);

    expect(res.status).toBe(404);
  });
});

describe("runner lifecycle callbacks", () => {
  it("marks a starting env infra-ready without completing startup", async () => {
    const lifecycleStub = createLifecycleStub();
    const noteInfraReady = vi.fn().mockImplementation(async () => {
      await lifecycleStub.hydrateFromSummary({
        status: "starting",
        lifecyclePhase: "starting",
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: false,
        updatedAt: "2026-04-12T00:00:00.000Z",
        lifecycleUpdatedAt: "2026-04-12T00:00:00.000Z",
      });
      return {
        phase: "starting",
        activeOpId: "start-op-1",
        activeOperation: "start",
        desiredState: "running",
        lastRunnerState: "running",
        lastWorkspaceSyncedAckOpId: null,
        infraState: "ready",
        runtimeReady: false,
        lastError: null,
        lastErrorAt: null,
        updatedAt: "2026-04-12T00:00:00.000Z",
      };
    });
    lifecycleStub.noteInfraReady = noteInfraReady;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          runnerMachineId: "my-env",
          backend: "host",
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          status: "starting",
          lifecyclePhase: "starting",
          lifecycleDesiredState: "running",
        }),
      }, put),
      HUB: createHubBinding(),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/infra-ready",
      {
        method: "POST",
        headers: { "X-Tiller-Lifecycle-Op-Id": "start-op-1" },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "starting",
    });
    expect(noteInfraReady).toHaveBeenCalledWith("start-op-1");
    expect(put.mock.lastCall?.[1]).toContain("\"status\":\"starting\"");
    expect(put.mock.lastCall?.[1]).toContain("\"lifecycleInfraState\":\"ready\"");
  });

  it("marks a starting env as running when runner-ready arrives", async () => {
    const lifecycleStub = createLifecycleStub();
    const noteRunnerStarted = vi.fn().mockImplementation(async () => {
      await lifecycleStub.hydrateFromSummary({
        status: "running",
        lifecyclePhase: "running",
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        updatedAt: "2026-04-12T00:00:00.000Z",
        lifecycleUpdatedAt: "2026-04-12T00:00:00.000Z",
      });
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
        updatedAt: "2026-04-12T00:00:00.000Z",
      };
    });
    lifecycleStub.noteRunnerStarted = noteRunnerStarted;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          runnerMachineId: "my-env",
          backend: "host",
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          status: "starting",
          lifecyclePhase: "starting",
          lifecycleDesiredState: "running",
        }),
      }, put),
      HUB: createHubBinding(),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/runner-ready",
      {
        method: "POST",
        headers: { "X-Tiller-Lifecycle-Op-Id": "start-op-1" },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "running",
    });
    expect(noteRunnerStarted).toHaveBeenCalledWith("start-op-1");
    expect(put.mock.lastCall?.[1]).toContain("\"status\":\"running\"");
  });

  it("fails a starting env immediately when runner-stopped arrives", async () => {
    const lifecycleStub = createLifecycleStub();
    const noteRunnerStopped = vi.fn().mockImplementation(async () => {
      await lifecycleStub.hydrateFromSummary({
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleDesiredState: "running",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
        error: "Container exited before the environment finished starting (container exited with code 1).",
        errorAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
        lifecycleUpdatedAt: "2026-04-12T00:00:00.000Z",
      });
      return {
        phase: "failed",
        activeOpId: "start-op-1",
        activeOperation: "start",
        desiredState: "running",
        lastRunnerState: "stopped",
        lastWorkspaceSyncedAckOpId: null,
        infraState: "stopped",
        runtimeReady: false,
        lastError: "Container exited before the environment finished starting (container exited with code 1).",
        lastErrorAt: "2026-04-12T00:00:00.000Z",
        updatedAt: "2026-04-12T00:00:00.000Z",
      };
    });
    lifecycleStub.noteRunnerStopped = noteRunnerStopped;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          runnerMachineId: "my-env",
          backend: "host",
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          status: "starting",
          lifecyclePhase: "starting",
          lifecycleDesiredState: "running",
        }),
      }, put),
      HUB: createHubBinding(),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/runner-stopped",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Tiller-Lifecycle-Op-Id": "start-op-1",
        },
        body: "container exited with code 1",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "failed",
    });
    expect(noteRunnerStopped).toHaveBeenCalledWith("start-op-1", "container exited with code 1");
    expect(put.mock.lastCall?.[1]).toContain("\"status\":\"failed\"");
    expect(put.mock.lastCall?.[1]).toContain("container exited with code 1");
  });
});

describe("resolveHubPublicUrl", () => {
  it("uses HUB_PUBLIC_URL when configured", async () => {
    expect(
      await resolveHubPublicUrl(
        { HUB_PUBLIC_URL: "https://tiller.example.com/" } as any,
        "https://ignored.example.net/api/envs",
      ),
    ).toBe("https://tiller.example.com");
  });

  it("falls back to the request origin", async () => {
    expect(
      await resolveHubPublicUrl(
        { HUB_PUBLIC_URL: undefined } as any,
        "https://tiller-preview.example.net/api/envs/demo/start",
      ),
    ).toBe("https://tiller-preview.example.net");
  });
});

describe("env summary projection", () => {
  it("GET /api/envs backfills definition-backed envs when the summary cache row is missing", async () => {
    mocks.getEnvLifecycleStub.mockReturnValue({
      getMutableState: vi.fn().mockResolvedValue({
        status: "running",
        lifecyclePhase: "running",
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
        runnerId: "runner-1",
        runnerMachineId: null,
        bootMessage: null,
        bootStepId: null,
        authWarning: null,
        branchStatus: null,
        workspaceDirty: null,
        workspaceNeedsAttention: null,
        workspaceLastSyncedAt: null,
        baseMainCommit: null,
        lastKnownMainCommit: null,
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
        updatedAt: "2024-01-01T00:00:01.000Z",
      }),
      hydrateFromSummary: vi.fn(),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      { method: "GET" },
      {
        ENVS_KV: createKvStore({
          "envdef:ghost-env": JSON.stringify({
            slug: "ghost-env",
            repoUrl: "https://github.com/test/repo",
            backend: "cf",
            harness: "claude-code",
            startupPlanId: null,
            branchName: "env/ghost-env",
            createdAt: "2024-01-01T00:00:00.000Z",
          }),
        }),
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({
        slug: "ghost-env",
        repoUrl: "https://github.com/test/repo",
        status: "running",
        lifecyclePhase: "running",
        branchName: "env/ghost-env",
      }),
    ]);
  });

  it("GET /api/envs recovers definition-backed envs even when a stale summary cache row is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getEnvLifecycleStub.mockReturnValue({
      getMutableState: vi.fn().mockResolvedValue({
        status: "running",
        lifecyclePhase: "running",
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
        runnerId: "runner-1",
        runnerMachineId: null,
        bootMessage: null,
        bootStepId: null,
        authWarning: null,
        branchStatus: null,
        workspaceDirty: null,
        workspaceNeedsAttention: null,
        workspaceLastSyncedAt: null,
        baseMainCommit: null,
        lastKnownMainCommit: null,
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
        updatedAt: "2024-01-01T00:00:01.000Z",
      }),
      hydrateFromSummary: vi.fn(),
    });

    const kvData = new Map<string, string>([
      ["ghost-env", JSON.stringify({
        slug: "ghost-env",
        repoUrl: "https://github.com/test/repo",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "running",
      })],
      ["envdef:ghost-env", JSON.stringify({
        slug: "ghost-env",
        repoUrl: "https://github.com/test/repo",
        backend: "cf",
        harness: "claude-code",
        startupPlanId: null,
        branchName: "env/ghost-env",
        createdAt: "2024-01-01T00:00:00.000Z",
      })],
    ]);

    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      { method: "GET" },
      {
        ENVS_KV: {
          get: vi.fn().mockImplementation(async (key: string) => kvData.get(key) ?? null),
          list: vi.fn().mockResolvedValue({
            keys: [{ name: "ghost-env" }, { name: "envdef:ghost-env" }],
            list_complete: true,
            cursor: undefined,
          }),
          put: vi.fn().mockImplementation(async (key: string, value: string) => {
            kvData.set(key, value);
          }),
          delete: vi.fn().mockImplementation(async (key: string) => {
            kvData.delete(key);
          }),
        },
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual([
      expect.objectContaining({
        slug: "ghost-env",
        repoUrl: "https://github.com/test/repo",
        status: "running",
        lifecyclePhase: "running",
        branchName: "env/ghost-env",
      }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[repo-store] Skipping invalid env summary cache row ghost-env:",
      expect.stringContaining("missing explicit environment schema fields"),
    );
  });

  it("GET /api/envs returns healthy envs even when another env's definition is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getEnvLifecycleStub.mockReturnValue({
      getMutableState: vi.fn().mockResolvedValue({
        status: "running",
        lifecyclePhase: "running",
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
        runnerId: "runner-1",
        runnerMachineId: null,
        bootMessage: null,
        bootStepId: null,
        authWarning: null,
        branchStatus: null,
        workspaceDirty: null,
        workspaceNeedsAttention: null,
        workspaceLastSyncedAt: null,
        baseMainCommit: null,
        lastKnownMainCommit: null,
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
        updatedAt: "2024-01-01T00:00:01.000Z",
      }),
      hydrateFromSummary: vi.fn(),
    });

    const kvData = new Map<string, string>([
      ["envdef:good-env", JSON.stringify({
        slug: "good-env",
        repoUrl: "https://github.com/test/repo",
        backend: "cf",
        harness: "claude-code",
        startupPlanId: null,
        branchName: "env/good-env",
        createdAt: "2024-01-01T00:00:00.000Z",
      })],
      // Orphan envdef with missing explicit environment schema fields — readEnvDefinition will throw.
      ["envdef:bad-env", JSON.stringify({
        slug: "bad-env",
        repoUrl: "https://github.com/test/dead-repo",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
      })],
    ]);

    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      { method: "GET" },
      {
        ENVS_KV: {
          get: vi.fn().mockImplementation(async (key: string) => kvData.get(key) ?? null),
          list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string }) => ({
            keys: Array.from(kvData.keys())
              .filter((key) => key.startsWith(prefix ?? ""))
              .sort()
              .map((name) => ({ name })),
            list_complete: true,
            cursor: undefined,
          })),
          put: vi.fn().mockImplementation(async (key: string, value: string) => {
            kvData.set(key, value);
          }),
          delete: vi.fn().mockImplementation(async (key: string) => {
            kvData.delete(key);
          }),
        },
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ slug: string }>;
    expect(body.map((entry) => entry.slug)).toEqual(["good-env"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[envs] Skipping env bad-env during backfill:"),
      expect.stringContaining("missing explicit environment schema fields"),
    );
  });

  it("GET /api/envs/:slug returns the same shape used for websocket env upserts", async () => {
    const storedMeta = {
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      backend: "cf",
      harness: "claude-code",
      runnerMachineId: "m-123",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
    };
    const env = {
      LOCAL_DEV_ONLY_BACKEND: undefined,
      ENVS_KV: createKvStore({ "my-env": JSON.stringify(storedMeta) }),
      HUB: createHubBinding(),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env",
      { method: "GET" },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      slug: "my-env",
      status: "running",
      lifecyclePhase: "running",
      lifecycleDesiredState: "running",
      lifecycleOpId: null,
      lifecycleOperation: null,
      startupPlanId: null,
      leadHarnessStatus: null,
      leadHarnessError: null,
      leadHarnessUpdatedAt: null,
    });
  });

  it("does not reconcile lifecycle state during env reads", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      LOCAL_DEV_ONLY_BACKEND: undefined,
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          harness: "claude-code",
          runnerMachineId: "host-123",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "starting",
          lifecyclePhase: "starting",
          lifecycleDesiredState: "running",
        }),
      }),
      HUB: createHubBinding({
        activeHostService: {
          machineId: "host-123",
          connectedAt: "2026-04-11T18:00:00.000Z",
          dockerAvailable: true,
          codexSubscription: true,
          claudeSubscription: true,
          transport: "session",
        },
        isHostRoutable: true,
      }),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env",
      { method: "GET" },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(lifecycleStub.reconcile).not.toHaveBeenCalled();
  });
});

describe("host development helpers", () => {
  it("rewrites loopback hub URLs for Docker containers", () => {
    expect(rewriteLoopbackHubUrlForDocker("http://localhost:5173")).toBe("http://host.docker.internal:5173");
    expect(rewriteLoopbackHubUrlForDocker("http://127.0.0.1:8788")).toBe("http://host.docker.internal:8788");
    expect(rewriteLoopbackHubUrlForDocker("https://tiller.example.com")).toBe("https://tiller.example.com");
  });

  it("uses the Docker-reachable hub URL for host backend containers", async () => {
    await expect(
      resolveContainerHubUrl(
        { HUB_PUBLIC_URL: undefined } as any,
        "http://localhost:5173/api/envs/demo/start",
        "host",
      ),
    ).resolves.toBe("http://host.docker.internal:5173");
  });

  it("rejects Cloudflare Containers on localhost", async () => {
    const app = createTestApp();
    const res = await app.request(
      "http://localhost:5173/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          backend: "cf",
          harness: "claude-code",
        }),
      },
      { LOCAL_DEV_ONLY_BACKEND: "true" } as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Cloudflare Containers are not available in local development"),
    });
  });

});

describe("host backend offline handling", () => {
  it("rejects env creation requests that omit backend", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "backend is required and must be 'cf' or 'host'",
    });
  });

  it("rejects env creation requests that omit harness", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          backend: "cf",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "harness is required and must be 'claude-code', 'codex', or 'opencode'",
    });
  });

  it("rejects creating a host env when no host session is connected", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          harness: "claude-code",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tiller Host is offline"),
    });
  });

  it("rejects creating a host env when a host is registered but not live-routable", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          harness: "claude-code",
        }),
      },
      {
        HUB: createHubBinding({
          activeHostService: {
            machineId: "raspberrypi",
            connectedAt: "2026-04-11T18:00:00.000Z",
            dockerAvailable: true,
            codexSubscription: true,
            claudeSubscription: true,
            transport: "session",
          },
          isHostRoutable: false,
        }),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tiller Host is offline"),
    });
  });

  it("rejects starting a host env when the host session is disconnected", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/start",
      { method: "POST" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            runnerMachineId: "my-env",
            backend: "host",
            harness: "claude-code",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "stopped",
          }),
        }),
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tiller Host is offline"),
    });
  });

  it("rejects starting a host env when its assigned host is offline, even if another host is registered", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/start",
      { method: "POST" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            runnerMachineId: "host-1",
            backend: "host",
            harness: "claude-code",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "stopped",
          }),
        }),
        HUB: createHubBinding({
          activeHostService: {
            machineId: "host-2",
            connectedAt: "2026-04-11T18:00:00.000Z",
            dockerAvailable: true,
            codexSubscription: true,
            claudeSubscription: true,
            gatewayPort: 8788,
            transport: "session",
          },
          hostServicesByMachineId: {
            "host-1": {
              machineId: "host-1",
              connectedAt: "2026-04-10T18:00:00.000Z",
              dockerAvailable: true,
              codexSubscription: true,
              claudeSubscription: true,
              gatewayPort: 8788,
              transport: "session",
            },
            "host-2": {
              machineId: "host-2",
              connectedAt: "2026-04-11T18:00:00.000Z",
              dockerAvailable: true,
              codexSubscription: true,
              claudeSubscription: true,
              gatewayPort: 8788,
              transport: "session",
            },
          },
          isHostRoutable: (preferredMachineId) => preferredMachineId == null ? true : preferredMachineId === "host-2",
        }),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tiller Host is offline"),
    });
  });

  it("rejects stopping a host env when the host session is disconnected", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/stop",
      { method: "POST" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            runnerMachineId: "my-env",
            backend: "host",
            harness: "claude-code",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "running",
          }),
        }),
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tiller Host is offline"),
    });
  });

  it("rejects deleting a host env when the host session is disconnected", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env",
      { method: "DELETE" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            runnerMachineId: "my-env",
            backend: "host",
            harness: "claude-code",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "running",
          }),
        }),
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Tiller Host is offline"),
    });
  });
});

describe("POST /api/envs/:slug/harness-failed", () => {
  it("fails a start in progress when the lead harness crashes", async () => {
    const lifecycleStub = createLifecycleStub();
    const noteRunnerStartFailed = vi.fn().mockResolvedValue({
      phase: "failed",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "stopped",
      lastWorkspaceSyncedAckOpId: null,
      lastError: "tiller-harness exited with code 1",
      lastErrorAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
    });
    lifecycleStub.noteRunnerStartFailed = noteRunnerStartFailed;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({
      "my-env": JSON.stringify({
        slug: "my-env",
        repoUrl: "https://github.com/test/repo",
        runnerMachineId: "my-env",
        backend: "host",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "starting",
      }),
    }, put);
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/harness-failed",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Tiller-Lifecycle-Op-Id": "start-op-1",
        },
        body: "tiller-harness exited with code 1",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      leadHarnessStatus: "failed",
    });
    expect(lifecycleStub.setLeadHarnessFailed).toHaveBeenCalledWith("tiller-harness exited with code 1");
    expect(noteRunnerStartFailed).toHaveBeenCalledWith("start-op-1", "tiller-harness exited with code 1");
  });

  it("replaces the generic startup-exit error when the harness failure arrives late", async () => {
    const lifecycleStub = createLifecycleStub();
    const setError = vi.fn().mockResolvedValue({
      ...lifecycleStub.getMutableState(),
      error: "tiller-harness exited with code 1",
    });
    lifecycleStub.setError = setError;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const kv = createKvStore({
      "my-env": JSON.stringify({
        slug: "my-env",
        repoUrl: "https://github.com/test/repo",
        runnerMachineId: "my-env",
        backend: "host",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleDesiredState: "running",
        error: "Container exited before the environment finished starting.",
      }),
    });
    const env = {
      ENVS_KV: kv,
      HUB: createHubBinding(),
    };

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/harness-failed",
      {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: "tiller-harness exited with code 1",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "failed",
      leadHarnessStatus: "failed",
    });
    expect(lifecycleStub.setLeadHarnessFailed).toHaveBeenCalledWith("tiller-harness exited with code 1");
    expect(lifecycleStub.noteRunnerStartFailed).not.toHaveBeenCalled();
    expect(setError).toHaveBeenCalledWith("tiller-harness exited with code 1");
  });
});
