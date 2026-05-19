import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { buildEnvBranchName } from "../scm/artifacts";
import { createInitialEnvScmState, createInitialRepoScmState } from "../scm/model";
import { TREE_HASH_EXCLUDES } from "../env/launch-config";

const mocks = vi.hoisted(() => ({
  getSandboxStub: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  getScmOperationStub: vi.fn(),
  getRepoMergeLockStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  ensureRepoWorkspaceFromRepoUrl: vi.fn(),
  listEnvMetas: vi.fn(),
  readEnvMeta: vi.fn(),
  commitRepoMainState: vi.fn(),
  persistRepoMeta: vi.fn(),
  getRunnerBackend: vi.fn(),
  getSecret: vi.fn(),
  resolveProtectionState: vi.fn(),
}));

vi.mock("../helpers", () => ({
  getSandboxStub: mocks.getSandboxStub,
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getWorkspaceStub: mocks.getWorkspaceStub,
  getScmOperationStub: mocks.getScmOperationStub,
  getRepoMergeLockStub: mocks.getRepoMergeLockStub,
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getLocationHintOptions: () => undefined,
}));

vi.mock("../plan/store", async () => {
  const actual = await vi.importActual<typeof import("../plan/store")>("../plan/store");
  return {
    ...actual,
    ensureRepoWorkspaceFromRepoUrl: mocks.ensureRepoWorkspaceFromRepoUrl,
    listEnvMetas: mocks.listEnvMetas,
    readEnvMeta: mocks.readEnvMeta,
    commitRepoMainState: mocks.commitRepoMainState,
    persistRepoMeta: mocks.persistRepoMeta,
  };
});

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

vi.mock("../setup/config", () => ({
  getSecret: mocks.getSecret,
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
            store.set(key, JSON.stringify({
              ...parsed,
              backend: parsed.backend === "host" ? "host" : "cf",
            }));
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
    list: vi.fn().mockImplementation(async (options?: { prefix?: string }) => ({
      keys: [...store.keys()]
        .filter((name) => !options?.prefix || name.startsWith(options.prefix))
        .map((name) => ({ name })),
      list_complete: true,
      cursor: undefined,
    })),
  };
}

function buildEnvDefinitionRecord(envMeta: Record<string, unknown>) {
  const backend = envMeta.backend === "host" ? "host" : "cf";
  if (
    envMeta.harness !== "claude-code"
    && envMeta.harness !== "codex"
    && envMeta.harness !== "opencode"
  ) {
    throw new Error("env-git-ops test fixture must provide a valid harness");
  }

  return {
    slug: String(envMeta.slug ?? "demo-env"),
    repoUrl: String(envMeta.repoUrl ?? "https://github.com/test/repo"),
    ...(typeof envMeta.repoId === "string" ? { repoId: envMeta.repoId } : {}),
    backend,
    harness: envMeta.harness,
    ...(typeof envMeta.authMode === "string" ? { authMode: envMeta.authMode } : {}),
    ...(typeof envMeta.resolvedAuthMode === "string" ? { resolvedAuthMode: envMeta.resolvedAuthMode } : {}),
    ...(typeof envMeta.codexAuthMode === "string" ? { codexAuthMode: envMeta.codexAuthMode } : {}),
    ...(typeof envMeta.opencodeProvider === "string" ? { opencodeProvider: envMeta.opencodeProvider } : {}),
    ...(typeof envMeta.opencodeModel === "string" ? { opencodeModel: envMeta.opencodeModel } : {}),
    ...(typeof envMeta.modelRoute === "string" ? { modelRoute: envMeta.modelRoute } : {}),
    startupPlanId: envMeta.startupPlanId ?? null,
    branchName:
      typeof envMeta.branchName === "string"
        ? envMeta.branchName
        : buildEnvBranchName(String(envMeta.slug ?? "demo-env")),
    createdAt:
      typeof envMeta.createdAt === "string"
        ? envMeta.createdAt
        : "2026-04-09T00:00:00.000Z",
  };
}

function createCreateEnvBinding(overrides: Record<string, unknown> = {}) {
  const kv = createKvStore({});
  return {
    ENV_LIFECYCLE: {} as any,
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
        isHostRoutable: vi.fn().mockResolvedValue(false),
      }),
    },
    BUCKET: {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    },
    ...overrides,
  };
}

function createEnvBinding(envMeta: Record<string, unknown>, put = vi.fn().mockResolvedValue(undefined)) {
  const slug = String(envMeta.slug ?? "demo-env");
  const createdAt =
    typeof envMeta.createdAt === "string"
      ? envMeta.createdAt
      : "2026-04-09T00:00:00.000Z";
  const branchName = typeof envMeta.branchName === "string" ? envMeta.branchName : undefined;
  const mainCommit =
    typeof envMeta.baseMainCommit === "string"
      ? envMeta.baseMainCommit
      : typeof envMeta.lastKnownMainCommit === "string"
        ? envMeta.lastKnownMainCommit
        : null;
  const normalizedEnvMeta = {
    slug,
    repoUrl: typeof envMeta.repoUrl === "string" ? envMeta.repoUrl : "https://github.com/test/repo",
    backend: envMeta.backend === "host" ? "host" : "cf",
    harness: "claude-code",
    createdAt,
    updatedAt: typeof envMeta.updatedAt === "string" ? envMeta.updatedAt : createdAt,
    status: typeof envMeta.status === "string" ? envMeta.status : "unknown",
    ...createInitialEnvScmState({
      slug,
      startupPlanId: envMeta.startupPlanId as string | null | undefined,
      branchName,
      mainCommit,
    }),
    ...envMeta,
  };
  const kv = createKvStore({
    [slug]: JSON.stringify(normalizedEnvMeta),
    [`envdef:${slug}`]: JSON.stringify(buildEnvDefinitionRecord(normalizedEnvMeta)),
  }, put);
  return {
    ENV_LIFECYCLE: {} as any,
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
        isHostRoutable: vi.fn().mockResolvedValue(false),
      }),
    },
    BUCKET: {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
    },
    __initialEnvMetaBySlug: {
      [slug]: normalizedEnvMeta,
    },
  };
}

function createRepoMeta(overrides: Record<string, unknown> = {}) {
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    ...createInitialRepoScmState(),
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
    ...overrides,
  };
}

function createLifecycleState(overrides: Record<string, unknown> = {}) {
  return {
    phase: "saving",
    activeOpId: "stop-op-1",
    activeOperation: "stop",
    desiredState: "stopped",
    lastRunnerState: "running",
    lastWorkspaceSyncedAckOpId: null,
    infraState: "ready",
    runtimeReady: false,
    lastError: null,
    lastErrorAt: null,
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createMutableState(meta: Record<string, unknown> = {}) {
  const status = typeof meta.status === "string" ? meta.status : "unknown";
  const lifecyclePhase =
    typeof meta.lifecyclePhase === "string"
      ? meta.lifecyclePhase
      : ["starting", "running", "saving", "stopping", "stopped", "failed"].includes(status)
        ? status
        : null;
  const updatedAt =
    typeof meta.updatedAt === "string"
      ? meta.updatedAt
      : typeof meta.createdAt === "string"
        ? meta.createdAt
        : "2026-04-10T00:00:00.000Z";
  return {
    status,
    lifecyclePhase,
    lifecycleOpId: typeof meta.lifecycleOpId === "string" ? meta.lifecycleOpId : null,
    lifecycleOperation: typeof meta.lifecycleOperation === "string" ? meta.lifecycleOperation : null,
    lifecycleDesiredState:
      typeof meta.lifecycleDesiredState === "string"
        ? meta.lifecycleDesiredState
        : lifecyclePhase === "starting" || lifecyclePhase === "running"
          ? "running"
          : lifecyclePhase
            ? "stopped"
            : null,
    lifecycleLastRunnerState:
      typeof meta.lifecycleLastRunnerState === "string"
        ? meta.lifecycleLastRunnerState
        : status === "running" || status === "saving" || status === "stopping"
          ? "running"
          : status === "stopped" || status === "failed"
            ? "stopped"
            : null,
    lifecycleLastWorkspaceSyncedAckOpId: typeof meta.lifecycleLastWorkspaceSyncedAckOpId === "string" ? meta.lifecycleLastWorkspaceSyncedAckOpId : null,
    lifecycleInfraState:
      typeof meta.lifecycleInfraState === "string"
        ? meta.lifecycleInfraState
        : status === "running" || status === "saving" || status === "stopping"
          ? "ready"
          : status === "stopped" || status === "failed"
            ? "stopped"
            : "unknown",
    lifecycleRuntimeReady:
      typeof meta.lifecycleRuntimeReady === "boolean"
        ? meta.lifecycleRuntimeReady
        : status === "running",
    lifecycleUpdatedAt: typeof meta.lifecycleUpdatedAt === "string" ? meta.lifecycleUpdatedAt : lifecyclePhase ? updatedAt : null,
    runnerId: typeof meta.runnerId === "string" ? meta.runnerId : null,
    runnerMachineId: typeof meta.runnerMachineId === "string" ? meta.runnerMachineId : null,
    bootMessage: typeof meta.bootMessage === "string" ? meta.bootMessage : null,
    authWarning: typeof meta.authWarning === "string" ? meta.authWarning : null,
    branchStatus: typeof meta.branchStatus === "string" ? meta.branchStatus : null,
    workspaceDirty: typeof meta.workspaceDirty === "boolean" ? meta.workspaceDirty : null,
    workspaceNeedsAttention: typeof meta.workspaceNeedsAttention === "boolean" ? meta.workspaceNeedsAttention : null,
    workspaceLastSyncedAt: typeof meta.workspaceLastSyncedAt === "string" ? meta.workspaceLastSyncedAt : null,
    baseMainCommit: typeof meta.baseMainCommit === "string" ? meta.baseMainCommit : null,
    lastKnownMainCommit: typeof meta.lastKnownMainCommit === "string" ? meta.lastKnownMainCommit : null,
    scmOperationType: typeof meta.scmOperationType === "string" ? meta.scmOperationType : null,
    scmOperationId: typeof meta.scmOperationId === "string" ? meta.scmOperationId : null,
    scmOperationPhase: typeof meta.scmOperationPhase === "string" ? meta.scmOperationPhase : null,
    scmOperationStartedAt: typeof meta.scmOperationStartedAt === "string" ? meta.scmOperationStartedAt : null,
    scmOperationUpdatedAt: typeof meta.scmOperationUpdatedAt === "string" ? meta.scmOperationUpdatedAt : null,
    scmLastCompletedAt: typeof meta.scmLastCompletedAt === "string" ? meta.scmLastCompletedAt : null,
    scmLastDurationMs: typeof meta.scmLastDurationMs === "number" ? meta.scmLastDurationMs : null,
    scmLastTimings: typeof meta.scmLastTimings === "string" ? meta.scmLastTimings : null,
    leadHarnessStatus: typeof meta.leadHarnessStatus === "string" ? meta.leadHarnessStatus : null,
    leadHarnessError: typeof meta.leadHarnessError === "string" ? meta.leadHarnessError : null,
    leadHarnessUpdatedAt: typeof meta.leadHarnessUpdatedAt === "string" ? meta.leadHarnessUpdatedAt : null,
    error: typeof meta.error === "string" ? meta.error : null,
    errorAt: typeof meta.errorAt === "string" ? meta.errorAt : null,
    updatedAt,
  };
}

function applyLifecycleResult(state: ReturnType<typeof createMutableState>, lifecycle: Record<string, unknown> | null | undefined) {
  if (!lifecycle) {
    return state;
  }
  return {
    ...state,
    status: typeof lifecycle.phase === "string" ? lifecycle.phase : state.status,
    lifecyclePhase: typeof lifecycle.phase === "string" ? lifecycle.phase : state.lifecyclePhase,
    lifecycleOpId: typeof lifecycle.activeOpId === "string" ? lifecycle.activeOpId : state.lifecycleOpId,
    lifecycleOperation: typeof lifecycle.activeOperation === "string" ? lifecycle.activeOperation : state.lifecycleOperation,
    lifecycleDesiredState: typeof lifecycle.desiredState === "string" ? lifecycle.desiredState : state.lifecycleDesiredState,
    lifecycleLastRunnerState: typeof lifecycle.lastRunnerState === "string" ? lifecycle.lastRunnerState : state.lifecycleLastRunnerState,
    lifecycleLastWorkspaceSyncedAckOpId:
      typeof lifecycle.lastWorkspaceSyncedAckOpId === "string" ? lifecycle.lastWorkspaceSyncedAckOpId : state.lifecycleLastWorkspaceSyncedAckOpId,
    lifecycleInfraState:
      typeof lifecycle.infraState === "string"
        ? lifecycle.infraState
        : state.lifecycleInfraState,
    lifecycleRuntimeReady:
      typeof lifecycle.runtimeReady === "boolean"
        ? lifecycle.runtimeReady
        : state.lifecycleRuntimeReady,
    lifecycleUpdatedAt: typeof lifecycle.updatedAt === "string" ? lifecycle.updatedAt : state.lifecycleUpdatedAt,
    error: typeof lifecycle.lastError === "string" ? lifecycle.lastError : null,
    errorAt: typeof lifecycle.lastErrorAt === "string" ? lifecycle.lastErrorAt : null,
    updatedAt: typeof lifecycle.updatedAt === "string" ? lifecycle.updatedAt : state.updatedAt,
  };
}

function configureLifecycleMock<T>(
  override: ReturnType<typeof vi.fn> | undefined,
  fallback: (...args: unknown[]) => T | Promise<T>,
  apply: (result: T) => void,
) {
  const mock = override ?? vi.fn();
  const originalImpl = override?.getMockImplementation?.();
  mock.mockImplementation(async (...args: unknown[]) => {
    const result = originalImpl ? await originalImpl(...args) : await fallback(...args);
    apply(result as T);
    return result;
  });
  return mock;
}

function createLifecycleStub(overrides: Partial<Record<
  | "clearMutableState"
  | "clearState"
  | "clearLeadHarnessState"
  | "beginStartupDiagnostics"
  | "getState"
  | "getMutableState"
  | "hydrateFromSummary"
  | "setAuthWarning"
  | "setBootProgress"
  | "setError"
  | "setLeadHarnessFailed"
  | "setRunnerBinding"
  | "setScmProjection"
  | "clearScmProjection"
  | "setStatus"
  | "reportStartupFailure"
  | "noteInfraReady"
  | "noteRunnerStarted"
  | "noteRunnerStartFailed"
  | "noteRunnerStopped"
  | "recordStopWorkspaceSynced"
  | "recordWorkspaceSyncFailed"
  | "noteStopWorkspaceSynced"
  | "noteWorkspaceSyncFailed"
  | "noteStopDispatchFailed"
  | "reconcile"
  | "requestStart"
  | "requestStop",
  ReturnType<typeof vi.fn>
>> = {}) {
  const state = { current: null as ReturnType<typeof createMutableState> | null };
  const ensure = () => state.current ?? createMutableState();

  const requestStart = configureLifecycleMock(
    overrides.requestStart,
    () => createLifecycleState({
      phase: "starting",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: null,
      infraState: "unknown",
      runtimeReady: false,
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const requestStop = configureLifecycleMock(
    overrides.requestStop,
    () => createLifecycleState(),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const noteRunnerStarted = configureLifecycleMock(
    overrides.noteRunnerStarted,
    () => createLifecycleState({
      phase: "running",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "running",
      infraState: "ready",
      runtimeReady: true,
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const noteInfraReady = configureLifecycleMock(
    overrides.noteInfraReady,
    () => createLifecycleState({
      phase: "starting",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "running",
      infraState: "ready",
      runtimeReady: false,
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const noteRunnerStartFailed = configureLifecycleMock(
    overrides.noteRunnerStartFailed,
    () => createLifecycleState({
      phase: "failed",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "stopped",
      infraState: "stopped",
      runtimeReady: false,
      lastError: "Start failed",
      lastErrorAt: "2026-04-10T00:00:05.000Z",
      updatedAt: "2026-04-10T00:00:05.000Z",
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const noteRunnerStopped = configureLifecycleMock(
    overrides.noteRunnerStopped,
    () => null,
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown> | null);
    },
  );

  const noteStopWorkspaceSynced = configureLifecycleMock(
    overrides.noteStopWorkspaceSynced,
    () => createLifecycleState({
      phase: "stopping",
      lastWorkspaceSyncedAckOpId: "stop-op-1",
      updatedAt: "2026-04-10T00:00:05.000Z",
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const noteWorkspaceSyncFailed = configureLifecycleMock(
    overrides.noteWorkspaceSyncFailed,
    () => createLifecycleState({
      phase: "failed",
      lastError: "Stop failed before workspace persistence completed; recent workspace changes were not saved.",
      lastErrorAt: "2026-04-10T00:00:05.000Z",
      updatedAt: "2026-04-10T00:00:05.000Z",
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const noteStopDispatchFailed = configureLifecycleMock(
    overrides.noteStopDispatchFailed,
    () => createLifecycleState({
      phase: "failed",
      lastError: "Failed to dispatch stop",
      lastErrorAt: "2026-04-10T00:00:05.000Z",
      updatedAt: "2026-04-10T00:00:05.000Z",
    }),
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown>);
    },
  );

  const reconcile = configureLifecycleMock(
    overrides.reconcile,
    () => null,
    (result) => {
      state.current = applyLifecycleResult(ensure(), result as Record<string, unknown> | null);
    },
  );

  return {
    clearMutableState: overrides.clearMutableState ?? vi.fn().mockImplementation(async () => {
      state.current = null;
      return null;
    }),
    clearState: overrides.clearState ?? vi.fn().mockImplementation(async () => {
      state.current = null;
      return null;
    }),
    clearLeadHarnessState: overrides.clearLeadHarnessState ?? vi.fn().mockImplementation(async () => {
      state.current = { ...ensure(), leadHarnessStatus: null, leadHarnessError: null, leadHarnessUpdatedAt: null };
      return state.current;
    }),
    beginStartupDiagnostics: overrides.beginStartupDiagnostics ?? vi.fn().mockResolvedValue(null),
    getStartupDiagnostics: overrides.getStartupDiagnostics ?? vi.fn().mockResolvedValue({ active: null, lastFailed: null }),
    getState: overrides.getState ?? vi.fn().mockImplementation(async () => (
      state.current?.lifecyclePhase
        ? {
            phase: state.current.lifecyclePhase,
            activeOpId: state.current.lifecycleOpId,
            activeOperation: state.current.lifecycleOperation,
            desiredState: state.current.lifecycleDesiredState,
            lastRunnerState: state.current.lifecycleLastRunnerState,
            lastWorkspaceSyncedAckOpId: state.current.lifecycleLastWorkspaceSyncedAckOpId,
            infraState: state.current.lifecycleInfraState,
            runtimeReady: state.current.lifecycleRuntimeReady,
            lastError: state.current.error,
            lastErrorAt: state.current.errorAt,
            updatedAt: state.current.lifecycleUpdatedAt ?? state.current.updatedAt,
          }
        : null
    )),
    getMutableState: overrides.getMutableState ?? vi.fn().mockImplementation(async () => state.current),
    hydrateFromSummary: overrides.hydrateFromSummary ?? vi.fn().mockImplementation(async (meta: Record<string, unknown>) => {
      state.current = createMutableState(meta);
      return state.current;
    }),
    setAuthWarning: overrides.setAuthWarning ?? vi.fn().mockImplementation(async (warning: string | null) => {
      state.current = { ...ensure(), authWarning: warning, updatedAt: "2026-04-10T00:00:00.000Z" };
      return state.current;
    }),
    setBootProgress: overrides.setBootProgress ?? vi.fn().mockImplementation(async (message: string | null) => {
      state.current = { ...ensure(), bootMessage: message, updatedAt: "2026-04-10T00:00:00.000Z" };
      return state.current;
    }),
    setError: overrides.setError ?? vi.fn().mockImplementation(async (message: string) => {
      state.current = { ...ensure(), error: message, errorAt: "2026-04-10T00:00:05.000Z", updatedAt: "2026-04-10T00:00:05.000Z" };
      return state.current;
    }),
    setLeadHarnessFailed: overrides.setLeadHarnessFailed ?? vi.fn().mockImplementation(async (message: string) => {
      state.current = {
        ...ensure(),
        leadHarnessStatus: "failed",
        leadHarnessError: message,
        leadHarnessUpdatedAt: "2026-04-10T00:00:05.000Z",
        updatedAt: "2026-04-10T00:00:05.000Z",
      };
      return state.current;
    }),
    setRunnerBinding: overrides.setRunnerBinding ?? vi.fn().mockImplementation(async (binding: Record<string, unknown>) => {
      state.current = {
        ...ensure(),
        runnerId: typeof binding.runnerId === "string" ? binding.runnerId : ensure().runnerId,
        runnerMachineId: typeof binding.runnerMachineId === "string" ? binding.runnerMachineId : ensure().runnerMachineId,
      };
      return state.current;
    }),
    reportStartupEvent: overrides.reportStartupEvent ?? vi.fn().mockResolvedValue(null),
    reportStartupFailure: overrides.reportStartupFailure ?? vi.fn().mockImplementation(async (options: Record<string, unknown>) => {
      const message = typeof options.message === "string" ? options.message : "Startup failed";
      state.current = {
        ...ensure(),
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleLastRunnerState: "stopped",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
        error: message,
        errorAt: "2026-04-10T00:00:05.000Z",
        updatedAt: "2026-04-10T00:00:05.000Z",
      };
      return state.current;
    }),
    setScmProjection: overrides.setScmProjection ?? vi.fn().mockImplementation(async (projection: Record<string, unknown>) => {
      state.current = {
        ...ensure(),
        scmOperationType: typeof projection.type === "string" ? projection.type : ensure().scmOperationType,
        scmOperationId: typeof projection.operationId === "string" ? projection.operationId : ensure().scmOperationId,
        scmOperationPhase: typeof projection.phase === "string" ? projection.phase : ensure().scmOperationPhase,
        scmOperationStartedAt: typeof projection.startedAt === "string" ? projection.startedAt : ensure().scmOperationStartedAt ?? "2026-04-10T00:00:00.000Z",
        scmOperationUpdatedAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
      };
      return state.current;
    }),
    clearScmProjection: overrides.clearScmProjection ?? vi.fn().mockImplementation(async (projection: Record<string, unknown> = {}) => {
      state.current = {
        ...ensure(),
        scmOperationType: null,
        scmOperationId: null,
        scmOperationPhase: null,
        scmOperationStartedAt: null,
        scmOperationUpdatedAt: null,
        scmLastCompletedAt: typeof projection.completedAt === "string" ? projection.completedAt : ensure().scmLastCompletedAt,
        scmLastDurationMs: typeof projection.durationMs === "number" ? projection.durationMs : ensure().scmLastDurationMs,
        scmLastTimings: typeof projection.timings === "string" ? projection.timings : ensure().scmLastTimings,
        updatedAt: "2026-04-10T00:00:05.000Z",
      };
      return state.current;
    }),
    setStatus: overrides.setStatus ?? vi.fn().mockImplementation(async (status: string) => {
      state.current = { ...ensure(), status, updatedAt: "2026-04-10T00:00:05.000Z" };
      return state.current;
    }),
    noteInfraReady,
    noteRunnerStarted,
    noteRunnerStartFailed,
    noteRunnerStopped,
    recordStopWorkspaceSynced: overrides.recordStopWorkspaceSynced ?? vi.fn().mockImplementation(async (patch: Record<string, unknown>) => {
      state.current = {
        ...ensure(),
        workspaceDirty: typeof patch.workspaceDirty === "boolean" ? patch.workspaceDirty : ensure().workspaceDirty,
        workspaceNeedsAttention:
          typeof patch.workspaceNeedsAttention === "boolean" ? patch.workspaceNeedsAttention : ensure().workspaceNeedsAttention,
        workspaceLastSyncedAt:
          typeof patch.workspaceLastSyncedAt === "string" ? patch.workspaceLastSyncedAt : ensure().workspaceLastSyncedAt,
        baseMainCommit: typeof patch.baseMainCommit === "string" ? patch.baseMainCommit : ensure().baseMainCommit,
        lastKnownMainCommit: typeof patch.lastKnownMainCommit === "string" ? patch.lastKnownMainCommit : ensure().lastKnownMainCommit,
        branchStatus: typeof patch.branchStatus === "string" ? patch.branchStatus : ensure().branchStatus,
      };
      return state.current;
    }),
    recordWorkspaceSyncFailed: overrides.recordWorkspaceSyncFailed ?? vi.fn().mockImplementation(async (_opId: string | null, message: string) => {
      state.current = {
        ...ensure(),
        status: "failed",
        lifecyclePhase: "failed",
        error: message,
        errorAt: "2026-04-10T00:00:05.000Z",
        updatedAt: "2026-04-10T00:00:05.000Z",
        lifecycleUpdatedAt: "2026-04-10T00:00:05.000Z",
      };
      return state.current;
    }),
    noteStopWorkspaceSynced,
    noteWorkspaceSyncFailed,
    noteStopDispatchFailed,
    reconcile,
    requestStart,
    requestStop,
    getStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(null),
    clearStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(undefined),
  };
}

describe("branch-backed git env operations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listEnvMetas.mockResolvedValue([]);
    mocks.getArtifactStoreStub.mockReturnValue({
      migrateLegacyHandoffs: vi.fn(),
      listArtifacts: vi.fn().mockReturnValue([]),
      listRefs: vi.fn().mockReturnValue([]),
    });
    const lifecycleStubs = new Map<string, ReturnType<typeof createLifecycleStub>>();
    mocks.getEnvLifecycleStub.mockImplementation((env: unknown, slug: string) => {
      const key = slug || "default";
      const existing = lifecycleStubs.get(key);
      if (existing) {
        return existing;
      }
      const stub = createLifecycleStub();
      const seed = (env as { __initialEnvMetaBySlug?: Record<string, Record<string, unknown>> } | undefined)
        ?.__initialEnvMetaBySlug?.[key];
      if (seed) {
        void stub.hydrateFromSummary(seed);
      }
      lifecycleStubs.set(key, stub);
      return stub;
    });
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) => {
      if (key === "OPENAI_API_KEY") return "openai-key";
      return undefined;
    });
    mocks.resolveProtectionState.mockResolvedValue({
      protectionMode: "public",
    });
  });

  it("passes the canonical repo git artifact to fresh env boots", async () => {
    const env = createCreateEnvBinding();
    const backendCreate = vi.fn().mockResolvedValue({});
    const envWorkspace = {
      destroyWorkspace: vi.fn().mockResolvedValue(undefined),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 2 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getWorkspaceStub.mockReturnValue(envWorkspace);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getRunnerBackend.mockResolvedValue({
      create: backendCreate,
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          slug: "demo-env",
          backend: "cf",
          harness: "codex",
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(201);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendCreate).toHaveBeenCalledTimes(1);
    expect(backendCreate.mock.calls[0][1]).toMatchObject({
      TILLER_REPO_GIT_ARTIFACT_URL: expect.stringContaining("/api/repos/repo-1/git-artifact?artifactId=g-current"),
      TILLER_BRANCH_NAME: "env/demo-env",
    });
  });

  it("does not revert a running lifecycle env back to starting during boot-progress", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const broadcastEnvUpsert = vi.fn();
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      runnerMachineId: "demo-env",
      backend: "cf",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
      status: "running",
    }, put);
    env.HUB.get = vi.fn().mockReturnValue({
      broadcastEnvUpsert,
      broadcastEnvRemove: vi.fn(),
      broadcastRepoUpsert: vi.fn(),
      broadcastRepoMainChange: vi.fn(),
      addMessage: vi.fn(),
      getActiveService: vi.fn().mockResolvedValue(null),
      isHostRoutable: vi.fn().mockResolvedValue(false),
    });
    const lifecycleStub = createLifecycleStub({
      getState: vi.fn().mockResolvedValue(
        createLifecycleState({
          phase: "running",
          activeOpId: "start-op-1",
          activeOperation: "start",
          desiredState: "running",
          lastRunnerState: "running",
        }),
      ),
    });
    void lifecycleStub.hydrateFromSummary({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      runnerMachineId: "demo-env",
      backend: "cf",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
      status: "running",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/boot-progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: "Workspace: 1 files" }),
      },
      env as any,
      createExecutionCtx() as any,
    );

    expect(res.status).toBe(200);
    const summaryWrites = put.mock.calls.filter(([key]) => key === "demo-env");
    expect(summaryWrites.length).toBeGreaterThanOrEqual(1);
    const persisted = JSON.parse(summaryWrites.at(-1)?.[1] ?? "{}");
    expect(persisted.status).toBe("running");
    expect(persisted.bootMessage).toBe("Workspace: 1 files");
    expect(broadcastEnvUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo-env",
        status: "running",
        bootMessage: "Workspace: 1 files",
      }),
    );
  });

  it("does not reconcile a controller-managed env on read without a trusted live status", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      runnerMachineId: "demo-env",
      backend: "cf",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
      status: "starting",
    });
    const lifecycleStub = createLifecycleStub({
      getState: vi.fn().mockResolvedValue(
        createLifecycleState({
          phase: "running",
          activeOpId: "start-op-1",
          activeOperation: "start",
          desiredState: "running",
          lastRunnerState: "running",
        }),
      ),
      reconcile: vi.fn().mockResolvedValue(
        createLifecycleState({
          phase: "failed",
          activeOpId: "start-op-1",
          activeOperation: "start",
          desiredState: "running",
          lastRunnerState: "stopped",
          lastError: "unexpected reconcile",
          lastErrorAt: "2026-04-10T00:00:05.000Z",
        }),
      ),
    });
    void lifecycleStub.hydrateFromSummary({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      runnerMachineId: "demo-env",
      backend: "cf",
      createdAt: "2026-04-09T00:00:00.000Z",
      updatedAt: "2026-04-09T00:00:00.000Z",
      status: "starting",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("unknown"),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env", { method: "GET" }, env as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      slug: "demo-env",
      status: "starting",
    });
    expect(lifecycleStub.getState).not.toHaveBeenCalled();
    expect(lifecycleStub.reconcile).not.toHaveBeenCalled();
  });

  it("clears stale scm state while reading an env", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        backend: "cf",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        scmOperationType: "merge-into-main",
        scmOperationId: "op-stale",
        scmOperationPhase: "Starting sandbox",
        scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
        scmOperationUpdatedAt: "2026-04-09T00:01:00.000Z",
      },
      put,
    );
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("unknown"),
    });
    mocks.getRepoMergeLockStub.mockReturnValue({
      getOperation: vi.fn().mockResolvedValue(null),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env", { method: "GET" }, env as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      slug: "demo-env",
      scmOperationType: null,
      scmOperationId: null,
    });
    expect(put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"scmOperationType\":null"),
    );
  });

  it("creates cf envs under lifecycle control and passes the start op id to the backend", async () => {
    const env = createCreateEnvBinding();
    const requestStart = vi.fn().mockResolvedValue(createLifecycleState({
      phase: "starting",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: null,
      updatedAt: "2026-04-10T00:00:00.000Z",
    }));
    const lifecycleStub = createLifecycleStub({
      requestStart,
      reconcile: vi.fn().mockResolvedValue(null),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const backendCreate = vi.fn().mockResolvedValue({});
    const envWorkspace = {
      destroyWorkspace: vi.fn().mockResolvedValue(undefined),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 2 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getWorkspaceStub.mockReturnValue(envWorkspace);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getRunnerBackend.mockResolvedValue({
      create: backendCreate,
      destroy: vi.fn().mockResolvedValue(undefined),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          slug: "demo-env",
          backend: "cf",
          harness: "codex",
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      slug: "demo-env",
      status: "starting",
    });
    expect(requestStart).toHaveBeenCalledTimes(1);
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"starting\""),
    );

    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo-env",
        status: "starting",
      }),
      expect.objectContaining({
        REPO_SLUG: "demo-env",
        TILLER_BRANCH_NAME: "env/demo-env",
      }),
      { startOpId: "start-op-1" },
    );
    expect(env.ENVS_KV.put.mock.lastCall?.[1]).toContain("\"status\":\"starting\"");
  });

  it("marks lifecycle-controlled start failures as failed after backend start errors", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const requestStart = vi.fn().mockResolvedValue(createLifecycleState({
      phase: "starting",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: null,
      updatedAt: "2026-04-10T00:00:00.000Z",
    }));
    const reportStartupFailure = vi.fn().mockResolvedValue(createLifecycleState({
      phase: "failed",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "stopped",
      lastError: "boot failed",
      lastErrorAt: "2026-04-10T00:00:05.000Z",
      updatedAt: "2026-04-10T00:00:05.000Z",
    }));
    const lifecycleStub = createLifecycleStub({
      requestStart,
      reportStartupFailure,
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        runnerId: "demo-env",
        backend: "cf",
        harness: "codex",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        baseMainCommit: "head123",
        lastKnownMainCommit: "head123",
      },
      put,
    );
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getWorkspaceStub.mockReturnValue({
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
    });
    const backendStart = vi.fn().mockRejectedValue(new Error("boot failed"));
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      start: backendStart,
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "demo-env",
      status: "starting",
    });
    expect(put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"starting\""),
    );

    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendStart).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo-env",
        status: "starting",
      }),
      expect.any(Object),
      { startOpId: "start-op-1" },
    );
    expect(reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "harness-launch",
      message: "boot failed",
    });
  });

  it("keeps host-backed starts in starting until readiness is observed", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const noteRunnerStarted = vi.fn().mockResolvedValue(null);
    const lifecycleStub = createLifecycleStub({ noteRunnerStarted });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "host-1",
        runnerId: "demo-env",
        backend: "host",
        harness: "codex",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        baseMainCommit: "head123",
        lastKnownMainCommit: "head123",
      },
      put,
    );
    env.HUB.get = vi.fn().mockReturnValue({
      broadcastEnvUpsert: vi.fn(),
      broadcastEnvRemove: vi.fn(),
      broadcastRepoUpsert: vi.fn(),
      broadcastRepoMainChange: vi.fn(),
      addMessage: vi.fn(),
      getActiveService: vi.fn().mockResolvedValue({
        machineId: "host-1",
        connectedAt: "2026-04-09T00:00:00.000Z",
        dockerAvailable: true,
        codexSubscription: true,
        claudeSubscription: false,
        transport: "session",
      }),
      isHostRoutable: vi.fn().mockResolvedValue(true),
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getWorkspaceStub.mockReturnValue({
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
    });
    const backendStart = vi.fn().mockResolvedValue({
      runnerId: "demo-env",
      runnerMachineId: "host-1",
      backend: "host",
    });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      start: backendStart,
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(noteRunnerStarted).not.toHaveBeenCalled();
    expect(put.mock.lastCall?.[1]).toContain("\"status\":\"starting\"");
  });

  it("allows start when the stored scm state is stale", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        runnerId: "demo-env",
        backend: "cf",
        harness: "codex",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        baseMainCommit: "head123",
        lastKnownMainCommit: "head123",
        scmOperationType: "merge-into-main",
        scmOperationId: "op-stale",
        scmOperationPhase: "Starting sandbox",
        scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
      },
      put,
    );
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getWorkspaceStub.mockReturnValue({
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
    });
    const backendStart = vi.fn().mockResolvedValue({});
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      start: backendStart,
    });
    mocks.getRepoMergeLockStub.mockReturnValue({
      getOperation: vi.fn().mockResolvedValue(null),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "demo-env",
      status: "starting",
    });
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendStart).toHaveBeenCalledTimes(1);
    expect(put.mock.calls.some((call) => String(call[1]).includes("\"scmOperationType\":null"))).toBe(true);
  });

  it("bootstraps an empty env workspace from canonical main before start", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        runnerId: "demo-env",
        backend: "cf",
        harness: "codex",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        branchName: "env/demo-env",
        workspaceDirty: true,
        workspaceNeedsAttention: true,
        workspaceLastSyncedAt: null,
        baseMainCommit: "old-base",
        lastKnownMainCommit: "old-main",
        branchStatus: "needs-attention",
      },
      put,
    );
    env.BUCKET.list = vi.fn().mockResolvedValue({
      objects: [{ key: "envs/demo-env/snapshots/s1.tar.zst" }],
      truncated: false,
      cursor: undefined,
    });
    env.BUCKET.delete = vi.fn().mockResolvedValue(undefined);

    const restoreFromTar = vi.fn().mockResolvedValue({ fileCount: 2 });
    mocks.getWorkspaceStub.mockReturnValue({
      getManifest: vi.fn().mockReturnValue([]),
      restoreFromTar,
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    const backendStart = vi.fn().mockResolvedValue({});
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      start: backendStart,
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    expect(restoreFromTar).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      {
        clearFirst: true,
        preservePrefixes: TREE_HASH_EXCLUDES,
      },
    );
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDirty: false,
        workspaceNeedsAttention: false,
        baseMainCommit: "head123",
        lastKnownMainCommit: "head123",
        branchStatus: "up-to-date",
      }),
      { clearError: true },
    );
    expect(env.BUCKET.list).toHaveBeenCalled();
    expect(env.BUCKET.delete).toHaveBeenCalledWith("envs/demo-env/snapshots/s1.tar.zst");

    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendStart).toHaveBeenCalledTimes(1);
  });

  it("bootstraps an env workspace when only env-local files exist", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        runnerId: "demo-env",
        backend: "cf",
        harness: "codex",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        branchName: "env/demo-env",
      },
    );
    const restoreFromTar = vi.fn().mockResolvedValue({ fileCount: 2 });
    mocks.getWorkspaceStub.mockReturnValue({
      getManifest: vi.fn().mockReturnValue([
        { path: "/.tiller/plan.md", size: 10, mtime: Date.now() },
      ]),
      restoreFromTar,
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      start: vi.fn().mockResolvedValue({}),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    expect(restoreFromTar).toHaveBeenCalledTimes(1);
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDirty: false,
        branchStatus: "up-to-date",
      }),
      { clearError: true },
    );
  });

  it("skips legacy workspace bootstrap when canonical files already exist", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        runnerId: "demo-env",
        backend: "cf",
        harness: "codex",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
        branchName: "env/demo-env",
      },
    );
    const restoreFromTar = vi.fn().mockResolvedValue({ fileCount: 2 });
    mocks.getWorkspaceStub.mockReturnValue({
      getManifest: vi.fn().mockReturnValue([
        { path: "/README.md", size: 10, mtime: Date.now() },
        { path: "/.tiller/plan.md", size: 10, mtime: Date.now() },
      ]),
      restoreFromTar,
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
      start: vi.fn().mockResolvedValue({}),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    expect(restoreFromTar).not.toHaveBeenCalled();
    expect(lifecycleStub.recordStopWorkspaceSynced).not.toHaveBeenCalled();
    expect(env.BUCKET.list).not.toHaveBeenCalled();
  });

  it("blocks creating envs before canonical repo git is ready", async () => {
    const env = createCreateEnvBinding();
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });

    const app = createTestApp();
    const res = await app.request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          slug: "demo-env",
          backend: "cf",
          harness: "codex",
        }),
      },
      env as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("Canonical main is not ready yet"),
    });
  });

  it("surfaces canonical main bootstrap failures when creating envs", async () => {
    const env = createCreateEnvBinding();
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "repair-required",
        gitError: "git clone failed",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });

    const app = createTestApp();
    const res = await app.request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          repoUrl: "https://github.com/test/repo",
          slug: "demo-env",
          backend: "cf",
          harness: "codex",
        }),
      },
      env as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("git clone failed"),
    });
  });

  it("starts a merge-into-main git job under the repo merge lock", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      baseMainCommit: "head123",
      status: "stopped",
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    const lockStub = {
      findPendingOperationForEnv: vi.fn().mockResolvedValue(null),
      acquire: vi.fn().mockResolvedValue({
        acquired: true,
        lock: { token: "lock-token", operationId: "op-merge" },
      }),
      createOperation: vi.fn().mockResolvedValue({}),
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        status: "succeeded",
        result: {
          action: "merged",
        },
      }),
      clearOperation: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);
    const scmOperationStub = {
      startOperationJob: vi.fn().mockResolvedValue(undefined),
    };
    mocks.getScmOperationStub.mockReturnValue(scmOperationStub);
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/merge-into-main", { method: "POST" }, env as any);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      slug: "demo-env",
      action: "merged",
    });
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"scmOperationType\":\"merge-into-main\""),
    );
    expect(
      env.ENVS_KV.put.mock.calls
        .filter(([key]) => key === "demo-env")
        .some(([, value]) => value.includes("\"scmOperationPhase\":\"Starting sandbox\"")),
    ).toBe(true);
    expect(lockStub.acquire).toHaveBeenCalledTimes(1);
    expect(lockStub.createOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "merge-into-main",
        envSlug: "demo-env",
        mergeLockToken: "lock-token",
        gitArtifactId: expect.stringMatching(/^g/),
      }),
    );
    expect(scmOperationStub.startOperationJob.mock.calls[0][0]).toMatchObject({
      TILLER_REPO_GIT_ARTIFACT_URL: expect.stringContaining("/api/repos/repo-1/git-artifact?artifactId=g-current"),
      TILLER_SCM_FAILURE_URL: expect.stringMatching(/\/api\/envs\/demo-env\/scm-operations\/op-[^/]+\/failed$/),
      TILLER_SCM_PROGRESS_URL: expect.stringMatching(/\/api\/envs\/demo-env\/scm-operations\/op-[^/]+\/progress$/),
      TILLER_SCM_HEARTBEAT_URL: expect.stringMatching(/\/api\/envs\/demo-env\/scm-operations\/op-[^/]+\/heartbeat$/),
      TILLER_SCM_MERGE_LOCK_TOKEN: "lock-token",
    });
    expect(mocks.getScmOperationStub).toHaveBeenCalledWith(
      env,
      expect.stringMatching(/^scm-op-demo-env-/),
    );
  });


  it("forces stopped-env SCM jobs onto Cloudflare containers even when the env backend is host", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      baseMainCommit: "base123",
      status: "stopped",
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });
    mocks.getScmOperationStub.mockReturnValue({
      startOperationJob: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getRepoMergeLockStub.mockReturnValue({
      findPendingOperationForEnv: vi.fn().mockResolvedValue(null),
      acquire: vi.fn().mockResolvedValue({
        acquired: true,
        lock: { token: "lock-token", operationId: "op-1" },
      }),
      createOperation: vi.fn().mockResolvedValue({}),
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-1",
        status: "succeeded",
        result: {
          action: "merged",
        },
      }),
      clearOperation: vi.fn().mockResolvedValue(undefined),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/merge-into-main", { method: "POST" }, env as any);

    expect(res.status).toBe(200);
    expect(mocks.getScmOperationStub).toHaveBeenCalledWith(
      env,
      expect.stringMatching(/^scm-op-demo-env-/),
    );
  });

  it("commits a clean merge callback to canonical repo state", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Sending merge result",
      scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
      status: "stopped",
    });
    const restoreFromTar = vi.fn().mockResolvedValue({ fileCount: 3 });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        restoreFromTar,
      },
      meta: createRepoMeta({
        mainCommit: "head-old",
        gitArtifactId: "g-old",
        gitStatus: "ready",
      }),
    });
    mocks.commitRepoMainState.mockResolvedValue(createRepoMeta({
      mainCommit: "head-new",
      gitArtifactId: "g-old",
      gitStatus: "ready",
      lastCommittedFromEnvSlug: "demo-env",
      lastCommittedAt: "2026-04-09T00:00:00.000Z",
    }));
    const lockStub = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        gitArtifactId: "g-new",
      }),
      getLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      release: vi.fn().mockResolvedValue({ released: true }),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);
    env.BUCKET.head.mockResolvedValue({
      customMetadata: {
        operationId: "op-merge",
      },
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-merge/result",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-tar",
          "X-Tiller-Scm-Action": "merged",
          "X-Tiller-Git-Head": "head-new",
          "X-Tiller-Source-Env-Matches-Main": "true",
        },
        body: "merged-tar",
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    expect(restoreFromTar).toHaveBeenCalledTimes(1);
    expect(mocks.commitRepoMainState).toHaveBeenCalledWith(
      expect.objectContaining({
        mainCommit: "head-new",
        sourceEnvSlug: "demo-env",
        metaOverrides: expect.objectContaining({
          gitArtifactId: "g-new",
          gitStatus: "ready",
        }),
      }),
    );
    expect(mocks.persistRepoMeta).not.toHaveBeenCalled();
    expect(lockStub.completeOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      result: expect.objectContaining({
        action: "merged",
        previousMainCommit: "head-old",
        currentMainCommit: "head-new",
      }),
    });
    expect(lockStub.release).toHaveBeenCalledWith("lock-token");
  });

  it("keeps the env scm state unchanged when a merge callback reports conflicts", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        branchStatus: "ready-to-merge",
        scmOperationType: "merge-into-main",
        scmOperationId: "op-merge",
        scmOperationPhase: "Merging branch into main",
        scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
      },
      put,
    );
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head-old",
        gitArtifactId: "g-old",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    const lockStub = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        gitArtifactId: "g-new",
      }),
      getLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      release: vi.fn().mockResolvedValue({ released: true }),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-merge/result",
      {
        method: "POST",
        headers: {
          "X-Tiller-Scm-Action": "conflicted",
          "X-Tiller-Conflict-Count": "3",
        },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(lockStub.completeOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      result: expect.objectContaining({
        action: "conflicted",
        conflictCount: 3,
      }),
    });
    expect(
      put.mock.calls
        .filter(([key]) => key === "demo-env")
        .every(([, value]) => !value.includes("\"branchStatus\":\"needs-attention\"")),
    ).toBe(true);
  });

  it("finalizes stopping envs only when the shutdown workspace sync is persisted", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "running",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    const backendStop = vi.fn().mockResolvedValue({ callbackExpected: true });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
      stop: backendStop,
    });
    mocks.readEnvMeta.mockResolvedValueOnce({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      status: "stopped",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-11T00:00:00.000Z",
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    expect(
      put.mock.calls
        .filter(([key]) => key === "demo-env")
        .some(([, value]) => value.includes("\"status\":\"saving\"")),
    ).toBe(true);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendStop).toHaveBeenCalledTimes(1);
  });

  it("allows stopping envs that are still marked starting when the runtime is live", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "starting",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    const backendStop = vi.fn().mockResolvedValue({ callbackExpected: true });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
      stop: backendStop,
    });
    mocks.readEnvMeta.mockResolvedValueOnce({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      status: "stopped",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-11T00:00:00.000Z",
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"saving\""),
    );
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendStop).toHaveBeenCalledTimes(1);
  });

  it("treats repeated stop requests as idempotent while the runner is still live", async () => {
    const lifecycleStub = createLifecycleStub({
      getState: vi.fn().mockResolvedValue(createLifecycleState()),
      reconcile: vi.fn().mockResolvedValue(createLifecycleState()),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      status: "saving",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    });
    const backendStop = vi.fn().mockResolvedValue({ callbackExpected: true });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
      stop: backendStop,
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "demo-env",
      status: "saving",
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("passes the lifecycle stop op id to the backend stop request", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const backendStop = vi.fn().mockResolvedValue({ callbackExpected: true });
    const lifecycleStub = createLifecycleStub({
      requestStop: vi.fn().mockResolvedValue(createLifecycleState({
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "running",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
      stop: backendStop,
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(backendStop).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo-env" }),
      { stopOpId: "stop-op-1" },
    );
  });

  it("finalizes stops inline when the backend reports no callback will arrive", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const backendStop = vi.fn().mockResolvedValue({ callbackExpected: false });
    const noteRunnerStopped = vi.fn().mockResolvedValue(
      createLifecycleState({
        phase: "stopped",
        activeOpId: "stop-op-1",
        activeOperation: "stop",
        desiredState: "stopped",
        lastRunnerState: "stopped",
      }),
    );
    const lifecycleStub = createLifecycleStub({
      requestStop: vi.fn().mockResolvedValue(createLifecycleState({
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      noteRunnerStopped,
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        backend: "host",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "running",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    env.HUB.get = vi.fn().mockReturnValue({
      broadcastEnvUpsert: vi.fn(),
      broadcastEnvRemove: vi.fn(),
      broadcastRepoUpsert: vi.fn(),
      broadcastRepoMainChange: vi.fn(),
      addMessage: vi.fn(),
      getActiveService: vi.fn().mockResolvedValue({
        machineId: "host-1",
        connectedAt: "2026-04-09T00:00:00.000Z",
        dockerAvailable: true,
        codexSubscription: true,
        claudeSubscription: false,
        transport: "session",
      }),
      isHostRoutable: vi.fn().mockResolvedValue(true),
    });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
      stop: backendStop,
    });
    mocks.readEnvMeta.mockResolvedValue({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      backend: "host",
      createdAt: "2026-04-09T00:00:00.000Z",
      status: "saving",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", "exit");
    expect(backendStop).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "demo-env" }),
      { stopOpId: "stop-op-1" },
    );
    const hubStub = env.HUB.get(env.HUB.idFromName("hub-id"));
    expect(hubStub.broadcastEnvUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ status: "stopped" }),
    );
  });

  it("does not finalize stops from the route while a backend callback is still expected", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const backendStop = vi.fn().mockResolvedValue({ callbackExpected: true });
    const noteRunnerStopped = vi.fn().mockResolvedValue(
      createLifecycleState({
        phase: "stopped",
        activeOpId: "stop-op-1",
        activeOperation: "stop",
        desiredState: "stopped",
        lastRunnerState: "stopped",
      }),
    );
    const lifecycleStub = createLifecycleStub({
      requestStop: vi.fn().mockResolvedValue(createLifecycleState({
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      noteRunnerStopped,
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        backend: "cf",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "running",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
      stop: backendStop,
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(noteRunnerStopped).not.toHaveBeenCalled();
    expect(put.mock.lastCall?.[1]).toContain("\"status\":\"saving\"");
  });

  it("does not repair a stale saving env to failed during a normal fetch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:02:00.000Z"));
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub({
      getState: vi.fn().mockResolvedValue(createLifecycleState()),
      reconcile: vi.fn().mockResolvedValue(createLifecycleState({
        phase: "failed",
        lastRunnerState: "stopped",
        lastError: "Stop did not confirm workspace persistence before timeout; recent workspace changes may not be saved.",
        lastErrorAt: "2026-04-10T00:02:00.000Z",
        updatedAt: "2026-04-10T00:02:00.000Z",
      })),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
        status: "saving",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env", { method: "GET" }, env as any);

    expect(res.status).toBe(200);
    expect(lifecycleStub.reconcile).not.toHaveBeenCalled();
    await expect(res.json()).resolves.toMatchObject({
      status: "saving",
    });
    vi.useRealTimers();
  });

  it("keeps a saving env in progress on fetch while the runner is still live", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:02:00.000Z"));
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub({
      getState: vi.fn().mockResolvedValue(createLifecycleState()),
      reconcile: vi.fn().mockResolvedValue(createLifecycleState({
        updatedAt: "2026-04-10T00:00:30.000Z",
      })),
    });
    void lifecycleStub.hydrateFromSummary({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-10T00:00:00.000Z",
      updatedAt: "2026-04-10T00:00:00.000Z",
      status: "saving",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-10T00:00:00.000Z",
        updatedAt: "2026-04-10T00:00:00.000Z",
        status: "saving",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("running"),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env", { method: "GET" }, env as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      status: "saving",
    });
    vi.useRealTimers();
  });

  it("marks stopping envs as failed when shutdown workspace persistence fails", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub();
    void lifecycleStub.hydrateFromSummary({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      status: "saving",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-09T00:00:00.000Z",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        branchName: "env/demo-env",
        status: "saving",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-09T00:00:00.000Z",
      },
      put,
    );

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/stop-failed",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Tiller-Lifecycle-Op-Id": "stop-op-1",
        },
        body: "Stop failed before workspace persistence completed; saving changes timed out.",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"failed\""),
    );
    expect(put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("saving changes timed out"),
    );
  });

  it("marks an env failed when stop throws after the runner has already exited", async () => {
    vi.useFakeTimers();
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub({
      requestStop: vi.fn().mockResolvedValue(createLifecycleState({
        updatedAt: "2026-04-10T00:00:00.000Z",
      })),
      noteStopDispatchFailed: vi.fn().mockResolvedValue(createLifecycleState({
        phase: "failed",
        lastError: "signal failed",
        lastErrorAt: "2026-04-10T00:00:01.000Z",
        updatedAt: "2026-04-10T00:00:01.000Z",
      })),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        status: "running",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      },
      put,
    );
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValueOnce("running").mockResolvedValue("stopped"),
      stop: vi.fn().mockRejectedValue(new Error("signal failed")),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request("/api/envs/demo-env/stop", { method: "POST" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(put).toHaveBeenLastCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"failed\""),
    );
    expect(put).toHaveBeenLastCalledWith(
      "demo-env",
      expect.stringContaining("signal failed"),
    );
    vi.useRealTimers();
  });

  it("blocks starting an env while shutdown workspace sync finalization is still pending", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      status: "saving",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/start", { method: "POST" }, env as any);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("still saving changes"),
    });
  });

  it("rolls back canonical repo state when merge metadata persistence fails", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Committing main",
      scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
      status: "stopped",
    });
    const previousTar = new Uint8Array([9, 9, 9]);
    const restoreFromTar = vi
      .fn()
      .mockResolvedValueOnce({ fileCount: 3 })
      .mockResolvedValueOnce({ fileCount: 3 });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {
        downloadTar: vi.fn().mockResolvedValue(previousTar),
        restoreFromTar,
      },
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head-old",
        gitArtifactId: "g-old",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.commitRepoMainState.mockRejectedValue(new Error("kv write failed"));
    const lockStub = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        mergeLockToken: "lock-token",
        gitArtifactId: "g-new",
      }),
      getLock: vi.fn().mockResolvedValue({
        token: "lock-token",
        operationId: "op-merge",
      }),
      completeOperation: vi.fn().mockResolvedValue({ status: "succeeded" }),
      failOperation: vi.fn().mockResolvedValue({ status: "failed" }),
      release: vi.fn().mockResolvedValue({ released: true }),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);
    env.BUCKET.head.mockResolvedValue({
      customMetadata: {
        operationId: "op-merge",
      },
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-merge/result",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-tar",
          "X-Tiller-Scm-Action": "merged",
          "X-Tiller-Git-Head": "head-new",
        },
        body: "merged-tar",
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(502);
    expect(restoreFromTar).toHaveBeenNthCalledWith(
      1,
      expect.any(Uint8Array),
      expect.objectContaining({
        clearFirst: true,
        preservePrefixes: ["/.tiller"],
      }),
    );
    expect(restoreFromTar).toHaveBeenNthCalledWith(
      2,
      previousTar,
      expect.objectContaining({
        clearFirst: true,
        preservePrefixes: ["/.tiller"],
      }),
    );
    expect(mocks.persistRepoMeta).toHaveBeenCalledWith(
      env,
      expect.anything(),
      expect.objectContaining({
        mainCommit: "head-old",
        gitArtifactId: "g-old",
      }),
    );
    expect(lockStub.failOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      error: "kv write failed",
    });
    expect(lockStub.release).toHaveBeenCalledWith("lock-token");
    expect(lockStub.completeOperation).not.toHaveBeenCalled();
  });

  it("skips late scm progress callbacks once the env has moved to a different operation", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        scmOperationType: "merge-into-main",
        scmOperationId: "op-current",
        scmOperationPhase: "Starting sandbox",
        scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
      },
      put,
    );
    mocks.getRepoMergeLockStub.mockReturnValue({
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-old",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
        createdAt: "2026-04-09T00:00:00.000Z",
      }),
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-old/progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ phase: "Uploading environment" }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      operationId: "op-old",
      skipped: true,
    });
  });

  it("skips late scm result callbacks once the env has cleared that operation", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        scmOperationType: null,
        scmOperationId: null,
        status: "stopped",
      },
      put,
    );
    const lockStub = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-old",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "succeeded",
        createdAt: "2026-04-09T00:00:00.000Z",
      }),
      completeOperation: vi.fn(),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-old/result",
      {
        method: "POST",
        headers: {
          "X-Tiller-Scm-Action": "merged",
        },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      operationId: "op-old",
      skipped: true,
    });
    expect(lockStub.completeOperation).not.toHaveBeenCalled();
  });

  it("fails a pending merge operation and releases the repo lock when the runner reports an unexpected failure", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        scmOperationType: "merge-into-main",
        scmOperationId: "op-merge",
        scmOperationPhase: "Uploading canonical main",
        scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
        status: "stopped",
      },
      put,
    );
    mocks.readEnvMeta.mockResolvedValue({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      scmOperationType: "merge-into-main",
      scmOperationId: "op-merge",
      scmOperationPhase: "Uploading canonical main",
      scmOperationStartedAt: "2026-04-09T00:00:00.000Z",
      status: "stopped",
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    const lockStub = {
      getOperation: vi.fn()
        .mockResolvedValueOnce({
          operationId: "op-merge",
          type: "merge-into-main",
          envSlug: "demo-env",
          status: "pending",
          mergeLockToken: "lock-token",
        })
        .mockResolvedValueOnce({
          operationId: "op-merge",
          type: "merge-into-main",
          envSlug: "demo-env",
          status: "failed",
          mergeLockToken: "lock-token",
          error: "Merge result upload failed with HTTP 409.",
        }),
      failOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        status: "failed",
        error: "Merge result upload failed with HTTP 409.",
      }),
      release: vi.fn().mockResolvedValue({ released: true }),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-merge/failed",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Tiller-Scm-Error": "Merge result upload failed with HTTP 409.",
          "X-Tiller-Scm-Duration-Ms": "4321",
          "X-Tiller-Scm-Timings": "upload_env=123,stage_main=456,result=789",
        },
        body: "Merge result upload failed with HTTP 409.",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      operationId: "op-merge",
      status: "failed",
      error: "Merge result upload failed with HTTP 409.",
    });
    expect(lockStub.failOperation).toHaveBeenCalledWith({
      operationId: "op-merge",
      error: "Merge result upload failed with HTTP 409.",
    });
    expect(lockStub.release).toHaveBeenCalledWith("lock-token");
    expect(put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"scmOperationType\":null"),
    );
  });

  it("skips late scm failure callbacks once the env has cleared that operation", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = createEnvBinding(
      {
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        runnerMachineId: "demo-env",
        createdAt: "2026-04-09T00:00:00.000Z",
        branchName: "env/demo-env",
        workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
        scmOperationType: null,
        scmOperationId: null,
        status: "stopped",
      },
      put,
    );
    const lockStub = {
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "failed",
        mergeLockToken: "lock-token",
        createdAt: "2026-04-09T00:00:00.000Z",
      }),
      failOperation: vi.fn(),
      release: vi.fn(),
    };
    mocks.getRepoMergeLockStub.mockReturnValue(lockStub);
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/demo-env/scm-operations/op-merge/failed",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "X-Tiller-Scm-Error": "late failure",
        },
        body: "late failure",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      operationId: "op-merge",
      skipped: true,
    });
    expect(lockStub.failOperation).not.toHaveBeenCalled();
    expect(lockStub.release).not.toHaveBeenCalled();
  });

  it("blocks starting a second scm operation for the same env while one is pending", async () => {
    const env = createEnvBinding({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerMachineId: "demo-env",
      createdAt: "2026-04-09T00:00:00.000Z",
      branchName: "env/demo-env",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
      baseMainCommit: "base123",
      status: "stopped",
    });
    mocks.ensureRepoWorkspaceFromRepoUrl.mockResolvedValue({
      workspace: {},
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        mainCommit: "head123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
    });
    mocks.getRunnerBackend.mockResolvedValue({
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });
    mocks.getRepoMergeLockStub.mockReturnValue({
      findPendingOperationForEnv: vi.fn().mockResolvedValue({
        operationId: "op-pending",
        type: "merge-into-main",
        envSlug: "demo-env",
        status: "pending",
      }),
    });

    const app = createTestApp();
    const res = await app.request("/api/envs/demo-env/merge-into-main", { method: "POST" }, env as any);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("already in progress"),
    });
  });
});
