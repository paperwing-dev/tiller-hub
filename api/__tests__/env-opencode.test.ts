import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isExecutionPlacement, type HonoEnv } from "../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../scm/model";

const mocks = vi.hoisted(() => ({
  getArtifactStoreStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  getRepoWorkspaceForRepoId: vi.fn(),
  getRunnerBackend: vi.fn(),
  getSecret: vi.fn(),
  getOrCreateSecret: vi.fn(),
  getBillingSelections: vi.fn(),
  resolveProtectionState: vi.fn(),
  refreshGitHubDefaultBranchHeadForRequest: vi.fn(),
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
    getRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
    getSelectedRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
  };
});

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

vi.mock("../setup/config", () => ({
  getSecret: mocks.getSecret,
  getOrCreateSecret: mocks.getOrCreateSecret,
  getBillingSelections: mocks.getBillingSelections,
}));

vi.mock("../protection", async () => {
  const actual = await vi.importActual<typeof import("../protection")>("../protection");
  return {
    ...actual,
    resolveProtectionState: mocks.resolveProtectionState,
  };
});

vi.mock("../repo/refresh", () => ({
  refreshGitHubDefaultBranchHeadForRequest: mocks.refreshGitHubDefaultBranchHeadForRequest,
}));

vi.mock("../canonical-origin", async () => {
  const actual = await vi.importActual<typeof import("../canonical-origin")>("../canonical-origin");
  return {
    ...actual,
    resolveCanonicalHubOrigin: vi.fn(async () => "https://demo.preview.workers.dev"),
    resolveCanonicalRequestOrigin: vi.fn(async (_env: unknown, request: Request) => new URL(request.url).origin),
  };
});

const { default: envRoutes } = await import("../env/routes");
const { startEnvAction } = await import("../env/lifecycle-actions");

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
  const requestedPlacement = record.executionPlacement;
  const executionPlacement = isExecutionPlacement(requestedPlacement)
    ? requestedPlacement
    : record.backend === "host"
      ? { backend: "host" as const, machineId: slug }
      : { backend: "cf" as const, machineId: null };
  const backend = executionPlacement.backend;
  const createdAt = typeof record.createdAt === "string" ? record.createdAt : "2024-01-01";
  const branchName = typeof record.branchName === "string" ? record.branchName : undefined;
  const mainCommit =
    typeof record.baseMainCommit === "string"
      ? record.baseMainCommit
      : typeof record.lastKnownMainCommit === "string"
        ? record.lastKnownMainCommit
        : null;

  const {
    executionPlacement: _inputExecutionPlacement,
    backend: _inputBackend,
    ...currentRecord
  } = record;
  return {
    ...createInitialEnvScmState({
      slug,
      startupPlanId: record.startupPlanId as string | null | undefined,
      branchName,
      mainCommit,
    }),
    slug,
    incarnationId: typeof record.incarnationId === "string"
      ? record.incarnationId
      : `incarnation-${slug}`,
    repoUrl: typeof record.repoUrl === "string" ? record.repoUrl : "https://github.com/test/repo",
    repoId: typeof record.repoId === "string" ? record.repoId : "repo-1",
    scmModel: "github" as const,
    createdAt,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : createdAt,
    status: typeof record.status === "string" ? record.status : "unknown",
    harness:
      record.harness === "claude-code" || record.harness === "codex" || record.harness === "opencode"
        ? record.harness
        : "claude-code",
    ...currentRecord,
    backend,
    executionPlacement,
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
                incarnationId: explicit.incarnationId,
                repoId: explicit.repoId,
                scmModel: "github",
                executionPlacement: explicit.executionPlacement,
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
    list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
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
  let current: any = {
    slug: "opencode-env",
    incarnationId: "incarnation-opencode-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf" as const,
    executionPlacement: { backend: "cf" as const, machineId: null },
    harness: "opencode" as const,
    createdAt: "2026-04-10T00:00:00.000Z",
    startupPlanId: null,
    branchName: "tiller/env/opencode-env",
    status: "starting",
    scmModel: "github",
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
    bootMessage: null as string | null,
    branchStatus: "up-to-date",
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: null as string | null,
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
    githubBaseBranch: "main",
    githubBaseCommitSha: "main-sha",
    githubBranch: "tiller/env/opencode-env",
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
  const claimStart = async (settings: Record<string, unknown>, initial?: Record<string, unknown>) => {
    if (initial) current = { ...current, ...initial };
    current = {
      ...current,
      status: "starting",
      harnessSettings: settings,
      lifecyclePhase: "starting",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
    };
    hydrated = true;
    return {
      lifecycle: createLifecycleState(),
      dispatchGranted: true,
      harnessSettings: settings,
    };
  };
  return {
    isInitialCreationPending: vi.fn().mockResolvedValue(false),
    persistOwnedProjection: vi.fn().mockImplementation(async () => (hydrated ? current : null)),
    getOwnedEnvView: vi.fn().mockImplementation(async () => (hydrated ? current : null)),
    preparePublicStart: vi.fn().mockResolvedValue({ action: "ordinary" }),
    getImmutablePlan: vi.fn().mockResolvedValue(null),
    prepareManualStop: vi.fn().mockResolvedValue({
      schedulerControlled: true,
      cleanupRequired: false,
      preparationInFlight: false,
    }),
    claimRunnerCommand: vi.fn().mockImplementation(async (operationId: string, desiredState: string) => ({
      commandGeneration: 1,
      operationId,
      desiredState,
    })),
    getRunnerCommandClaim: vi.fn().mockResolvedValue(null),
    rebaseRejectedRunnerCommand: vi.fn().mockImplementation(async ({
      rejectedCommand,
      currentCommandGeneration,
    }: {
      rejectedCommand: { operationId: string; desiredState: string };
      currentCommandGeneration: number;
    }) => ({
      commandGeneration: currentCommandGeneration + 1,
      operationId: rejectedCommand.operationId,
      desiredState: rejectedCommand.desiredState,
    })),
    clearMutableState: vi.fn().mockResolvedValue(null),
    clearState: vi.fn().mockResolvedValue(null),
    getState: vi.fn().mockResolvedValue(null),
    getMutableState: vi.fn().mockImplementation(async () => (hydrated ? current : null)),
    peekMutableState: vi.fn().mockImplementation(async () => (hydrated ? current : null)),
    peekVisibleMutableState: vi.fn().mockImplementation(async () => (hydrated ? current : null)),
    initializeMutableStateFromMeta: vi.fn().mockImplementation(async (meta: Record<string, unknown>) => {
      const status = typeof meta.status === "string" ? meta.status : current.status;
      const updatedAt =
        typeof meta.updatedAt === "string"
          ? meta.updatedAt
          : typeof meta.createdAt === "string"
            ? meta.createdAt
            : current.updatedAt;
      current = {
        ...current,
        ...(meta.backend === "host" || meta.backend === "cf" ? { backend: meta.backend } : {}),
        ...(meta.executionPlacement && typeof meta.executionPlacement === "object"
          ? { executionPlacement: meta.executionPlacement }
          : {}),
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
        startupPlanId: typeof meta.startupPlanId === "string" ? meta.startupPlanId : null,
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
        githubBaseBranch: typeof meta.githubBaseBranch === "string" ? meta.githubBaseBranch : current.githubBaseBranch,
        githubBaseCommitSha:
          typeof meta.githubBaseCommitSha === "string"
            ? meta.githubBaseCommitSha
            : typeof meta.baseMainCommit === "string"
              ? meta.baseMainCommit
              : current.githubBaseCommitSha,
        githubBranch: typeof meta.githubBranch === "string" ? meta.githubBranch : current.githubBranch,
        updatedAt,
        lifecycleUpdatedAt: typeof meta.lifecycleUpdatedAt === "string" ? meta.lifecycleUpdatedAt : updatedAt,
      };
      hydrated = true;
      return current;
    }),
    initializeAndBeginStart: vi.fn().mockImplementation(async (
      definition: Record<string, unknown>,
      initial: Record<string, unknown>,
      settings: Record<string, unknown>,
      authClaim: Record<string, unknown> = {},
    ) => {
      const placement = definition.executionPlacement as { backend?: unknown } | undefined;
      current = {
        ...current,
        ...definition,
        ...(placement?.backend === "cf" || placement?.backend === "host"
          ? { backend: placement.backend }
          : {}),
      };
      return { ...await claimStart(settings, initial), ...authClaim };
    }),
    initializeStoppedEnvironment: vi.fn().mockImplementation(async (
      definition: Record<string, unknown>,
      initial: Record<string, unknown>,
    ) => {
      if (hydrated) return { created: false, claimId: null, mutableState: current };
      const placement = definition.executionPlacement as { backend?: unknown } | undefined;
      current = {
        ...current,
        ...definition,
        ...initial,
        ...(placement?.backend === "cf" || placement?.backend === "host"
          ? { backend: placement.backend }
          : {}),
      };
      hydrated = true;
      return {
        created: true,
        claimId: definition.incarnationId,
        mutableState: current,
      };
    }),
    publishStoppedInitialization: vi.fn().mockResolvedValue(true),
    commitStoppedInitialization: vi.fn().mockResolvedValue(true),
    rollbackStoppedInitialization: vi.fn().mockResolvedValue(true),
    beginStart: vi.fn().mockImplementation(async (
      settings: Record<string, unknown>,
      authClaim: Record<string, unknown> = {},
    ) => ({ ...await claimStart(settings), ...authClaim })),
    requestStop: vi.fn().mockImplementation(async () => {
      current = {
        ...current,
        status: "saving",
        lifecyclePhase: "saving",
        lifecycleOpId: "stop-op-1",
        lifecycleOperation: "stop",
        lifecycleDesiredState: "stopped",
        lifecycleUpdatedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return createLifecycleState({
        phase: "saving",
        activeOpId: "stop-op-1",
        activeOperation: "stop",
        desiredState: "stopped",
      });
    }),
    resumeStopRetry: vi.fn().mockResolvedValue(null),
    reconcile: vi.fn().mockResolvedValue(null),
    clearLeadHarnessState: vi.fn().mockResolvedValue(current),
    beginStartupDiagnostics: vi.fn().mockResolvedValue(current),
    getStartupDiagnostics: vi.fn().mockResolvedValue({ active: null, lastFailed: null }),
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
      };
      return current;
    }),
    reportStartupFailure: vi.fn().mockImplementation(async (failure: { opId?: string; message?: string }) => {
      const lifecycle = createLifecycleState({
        phase: "failed",
        activeOpId: failure.opId ?? "start-op-1",
        lastError: failure.message ?? "startup failed",
      });
      current = {
        ...current,
        status: "failed",
        lifecyclePhase: "failed",
        error: lifecycle.lastError,
        errorAt: lifecycle.updatedAt,
      };
      return lifecycle;
    }),
    reportStartupEvent: vi.fn().mockResolvedValue(null),
    recordStopWorkspaceSynced: vi.fn().mockResolvedValue(current),
    recordWorkspaceSyncFailed: vi.fn().mockResolvedValue(current),
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
    noteFencedRunnerAbsentBeforeScheduledStart: vi.fn().mockResolvedValue(false),
    noteFencedScheduledStartRejectedBeforeMutation: vi.fn().mockResolvedValue(false),
    noteStopWorkspaceSynced: vi.fn().mockResolvedValue(null),
    noteWorkspaceSyncFailed: vi.fn().mockResolvedValue(null),
    noteStopDispatchFailed: vi.fn().mockResolvedValue(null),
  };
}

async function createOpenCodeStartFixture(options: {
  start?: ReturnType<typeof vi.fn>;
  committedSettings?: { model: string; effort: string };
  startupPlanId?: string | null;
  backend?: "cf" | "host";
} = {}) {
  const backend = options.backend ?? "cf";
  const executionPlacement = backend === "host"
    ? { backend: "host" as const, machineId: "machine-1" }
    : { backend: "cf" as const, machineId: null };
  const start = options.start ?? vi.fn().mockResolvedValue({
    runnerId: "machine-1",
    backend,
  });
  mocks.getRunnerBackend.mockResolvedValue({
    start,
    getStatus: vi.fn().mockResolvedValue("stopped"),
  });
  const storedEnv = {
    slug: "opencode-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    runnerId: "machine-1",
    backend,
    executionPlacement,
    harness: "opencode",
    harnessSettings: options.committedSettings ?? { model: "kimi-k2.7-code", effort: "high" },
    createdAt: "2024-01-01T00:00:00.000Z",
    status: "stopped",
    startupPlanId: options.startupPlanId ?? null,
    baseMainCommit: "main-sha",
    lastKnownMainCommit: "main-sha",
  };
  const kv = createKvStore({ "opencode-env": JSON.stringify(storedEnv) });
  const lifecycleStub = createLifecycleStub();
  await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord(storedEnv));
  mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
  const runtimeSourceId = "c".repeat(40);
  const hostService = {
    machineId: "machine-1",
    displayName: "Build machine",
    connectedAt: "2026-08-03T00:00:00.000Z",
    runnerCommandProtocol: 1 as const,
    codexRuntimeAuthProtocol: 1 as const,
    dockerAvailable: true,
    runnerAvailable: true,
    claudeSubscription: false,
    localRunnerImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSourceId}`,
    localRunnerImageSourceId: runtimeSourceId,
    transport: "session" as const,
  };
  const env = {
    ENABLED_ENV_HARNESSES: "claude-code,codex,opencode",
    OPENAI_API_KEY: "selected-openai-key",
    TILLER_OPENCODE_PROXY_TOKEN: "workers-token",
    ENVS_KV: kv,
    HUB: {
      idFromName: vi.fn().mockReturnValue("hub-id"),
      get: vi.fn().mockReturnValue({
        broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined),
        broadcastEnvRemove: vi.fn(),
        broadcastRepoUpsert: vi.fn(),
        broadcastRepoMainChange: vi.fn(),
        addMessage: vi.fn(),
        resolveRepoSessionEnvVars: vi.fn().mockResolvedValue({}),
        getHostService: vi.fn().mockResolvedValue(backend === "host" ? hostService : null),
        getRoutableHostService: vi.fn().mockResolvedValue(backend === "host" ? hostService : null),
        isHostRoutable: vi.fn().mockResolvedValue(backend === "host"),
      }),
    },
    BUCKET: {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
    },
  };
  return { app: createTestApp(), env, lifecycleStub, start, runtimeSourceId };
}

function createOpenCodeCreateEnv(overrides: Record<string, unknown> = {}) {
  return {
    ENABLED_ENV_HARNESSES: "claude-code,codex,opencode",
    TILLER_OPENCODE_PROXY_TOKEN: "proxy-token-123",
    ENVS_KV: createKvStore({}),
    HUB: {
      idFromName: vi.fn().mockReturnValue("hub-id"),
      get: vi.fn().mockReturnValue({
        broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined),
        broadcastEnvRemove: vi.fn(),
        broadcastRepoUpsert: vi.fn(),
        broadcastRepoMainChange: vi.fn(),
        addMessage: vi.fn(),
        resolveNewExecutionPlacement: vi.fn().mockResolvedValue({ backend: "cf", machineId: null }),
        resolveRepoSessionEnvVars: vi.fn().mockResolvedValue({}),
      }),
    },
    BUCKET: {
      put: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      head: vi.fn().mockResolvedValue(null),
    },
    ...overrides,
  };
}

describe("OpenCode environment routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getArtifactStoreStub.mockReturnValue({
      migrateLegacyHandoffs: vi.fn(),
      getArtifact: vi.fn().mockReturnValue(null),
      listArtifacts: vi.fn().mockReturnValue([]),
      listLatestTodoPlansForMain: vi.fn().mockReturnValue([]),
      listRefs: vi.fn().mockReturnValue([]),
      reconcileEnvironmentSidebarSlots: vi.fn().mockReturnValue([]),
      claimEnvironmentSidebarSlot: vi.fn().mockReturnValue({ status: "claimed", slot: 1 }),
      commitEnvironmentSidebarSlot: vi.fn().mockReturnValue(true),
      releaseEnvironmentSidebarSlotClaim: vi.fn().mockReturnValue(true),
      releaseEnvironmentSidebarSlot: vi.fn().mockReturnValue(true),
    });
    mocks.getEnvLifecycleStub.mockReturnValue(createLifecycleStub());
    mocks.getSecret.mockImplementation(async (env: Record<string, unknown>, key: string) => env[key] ?? undefined);
    mocks.getOrCreateSecret.mockImplementation(async (env: Record<string, unknown>, key: string, createValue: () => string) => env[key] ?? createValue());
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: "api",
      openaiBillingMode: "api",
    });
    mocks.resolveProtectionState.mockResolvedValue({ protectionMode: "cf-access" });
    const repoWorkspace = {
      meta: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        githubInstallationId: 98765,
        githubFullName: "test/repo",
        ...createInitialRepoScmState(),
        githubDefaultBranch: "main",
        githubDefaultBranchHeadSha: "main-sha",
        gitArtifactId: "artifact-1",
        gitStatus: "ready",
        mainCommit: "main-sha",
        createdAt: "2026-04-09T00:00:00.000Z",
        updatedAt: "2026-04-09T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
      workspace: {
        listWorkspaceHandoffs: vi.fn().mockResolvedValue([]),
        downloadTar: vi.fn().mockResolvedValue(new Uint8Array()),
        readWorkspaceHandoff: vi.fn().mockResolvedValue(null),
      },
    };
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue(repoWorkspace);
    mocks.refreshGitHubDefaultBranchHeadForRequest.mockResolvedValue({
      repo: repoWorkspace,
      changed: false,
      mainChanged: false,
      failureKind: null,
      error: null,
      code: null,
      status: null,
    });
    mocks.getWorkspaceStub.mockReturnValue({
      destroyWorkspace: vi.fn().mockResolvedValue(undefined),
      restoreFromTar: vi.fn().mockResolvedValue({ fileCount: 7 }),
      clearWorkspacePlanFile: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      getManifest: vi.fn().mockResolvedValue([]),
      getHashedManifest: vi.fn().mockResolvedValue([]),
      readGitHubDeletedWorkspacePaths: vi.fn().mockResolvedValue([]),
      deleteWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(true),
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
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
        }),
      },
      {
        ENABLED_ENV_HARNESSES: "claude-code,codex",
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
            resolveNewExecutionPlacement: vi.fn().mockResolvedValue({ backend: "cf", machineId: null }),
            resolveRepoSessionEnvVars: vi.fn().mockResolvedValue({}),
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

  it.each([
    [{ model: "gpt-5.5" }],
    [{ model: "claude-opus-4.8", effort: "max" }],
  ])("rejects incomplete or cross-harness creation settings before claiming", async (harnessSettings) => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
          harnessSettings,
        }),
      },
      createOpenCodeCreateEnv() as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(400);
    expect(lifecycleStub.initializeAndBeginStart).not.toHaveBeenCalled();
  });

  it("leaves an existing runner and workspace untouched before Create claims state", async () => {
    const lifecycleStub = createLifecycleStub();
    const destroyWorkspace = vi.fn();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getWorkspaceStub.mockReturnValue({ destroyWorkspace });
    mocks.getRunnerBackend.mockResolvedValue({
      kind: "cf",
      inspect: vi.fn().mockResolvedValue({ state: "live", status: "running" }),
    });

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
        }),
      },
      createOpenCodeCreateEnv() as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "runtime_already_exists" });
    expect(lifecycleStub.initializeAndBeginStart).not.toHaveBeenCalled();
    expect(destroyWorkspace).not.toHaveBeenCalled();
  });

  it("creates an OpenCode env on the selected Cloudflare backend and injects the hub proxy auth", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const create = vi.fn().mockResolvedValue({
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
          resolveNewExecutionPlacement: vi.fn().mockResolvedValue({ backend: "cf", machineId: null }),
          resolveRepoSessionEnvVars: vi.fn().mockResolvedValue({}),
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
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      slug: "opencode-env",
      displayName: "Scratch #1",
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
        TILLER_OPENCODE_BASE_URL: "https://demo.preview.workers.dev/api/opencode/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "proxy-token-123",
        TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
      }),
      expect.objectContaining({
        startOpId: "start-op-1",
      }),
    );

    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      slug: "opencode-env",
      harness: "opencode",
      status: "starting",
    });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.not.toHaveProperty("opencodeProvider");
    await expect(lifecycleStub.getOwnedEnvView()).resolves.not.toHaveProperty("opencodeModel");
    expect(lifecycleStub.initializeAndBeginStart).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { model: "kimi-k2.7-code", effort: "high" },
      { claudeAuthMode: null, codexAuthPreference: null },
    );
  });

  it("uses one selected-plan snapshot for an ordinary creation name, identity, and document", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const create = vi.fn().mockResolvedValue({ runnerId: "machine-1", backend: "cf" });
    mocks.getRunnerBackend.mockResolvedValue({
      inspect: vi.fn().mockResolvedValue({ state: "absent" }),
      create,
      getStatus: vi.fn().mockResolvedValue("running"),
    });
    const firstPlan = {
      id: "plan-1",
      repoId: "repo-1",
      type: "plan",
      title: "  Implement\nsettings  ",
      body: { markdown: "# First snapshot\n\nUse version seven." },
      basis: { repoId: "repo-1", mainCommit: "main-sha" },
      status: "todo",
      version: 7,
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    const laterPlan = {
      ...firstPlan,
      title: "Changed afterward",
      body: { markdown: "# Second snapshot" },
      version: 8,
    };
    const getArtifact = vi.fn()
      .mockResolvedValueOnce(firstPlan)
      .mockResolvedValue(laterPlan);
    mocks.getArtifactStoreStub.mockReturnValue({
      getArtifact,
      listLatestTodoPlansForMain: vi.fn().mockResolvedValue([]),
      reconcileEnvironmentSidebarSlots: vi.fn().mockResolvedValue([]),
      claimEnvironmentSidebarSlot: vi.fn().mockResolvedValue({ status: "claimed", slot: 6 }),
      commitEnvironmentSidebarSlot: vi.fn().mockResolvedValue(true),
      releaseEnvironmentSidebarSlotClaim: vi.fn().mockResolvedValue(true),
    });
    const executionCtx = createExecutionCtx();

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
          planSelection: { mode: "specific", artifactId: "plan-1" },
        }),
      },
      createOpenCodeCreateEnv() as any,
      executionCtx as any,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      displayName: "Implement settings",
      sidebarSlot: 6,
      startupPlanId: "plan-1",
    });
    await executionCtx.waitUntil.mock.calls[0][0];

    expect(getArtifact).toHaveBeenCalledTimes(1);
    expect(lifecycleStub.initializeAndBeginStart.mock.calls[0]?.[0]).toMatchObject({
      displayName: "Implement settings",
      sidebarSlot: 6,
      startupPlanId: "plan-1",
    });
    expect(create.mock.calls[0]?.[1]?.TILLER_STARTUP_PLAN_DOCUMENT_B64).toBeUndefined();
    const workspaceStub = mocks.getWorkspaceStub.mock.results[0]?.value;
    const document = workspaceStub.writeWorkspaceFile.mock.calls.find(
      ([path]: [string]) => path === "/.tiller/plan.md",
    )?.[1];
    expect(document).toContain("# First snapshot");
    expect(document).not.toContain("# Second snapshot");
  });

  it("stores one selected-plan snapshot for scheduled creation", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getRunnerBackend.mockResolvedValue({
      inspect: vi.fn().mockResolvedValue({ state: "absent" }),
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });
    const firstPlan = {
      id: "plan-1",
      repoId: "repo-1",
      type: "plan",
      title: "Scheduled implementation",
      body: { markdown: "# Scheduled snapshot\n\nUse version eleven." },
      basis: { repoId: "repo-1", mainCommit: "main-sha" },
      status: "todo",
      version: 11,
      createdAt: "2026-08-13T00:00:00.000Z",
    };
    const getArtifact = vi.fn()
      .mockResolvedValueOnce(firstPlan)
      .mockResolvedValue({
        ...firstPlan,
        title: "Changed afterward",
        body: { markdown: "# Changed scheduled snapshot" },
        version: 12,
      });
    mocks.getArtifactStoreStub.mockReturnValue({
      getArtifact,
      listLatestTodoPlansForMain: vi.fn().mockResolvedValue([]),
      reconcileEnvironmentSidebarSlots: vi.fn().mockResolvedValue([]),
      claimEnvironmentSidebarSlot: vi.fn().mockResolvedValue({ status: "claimed", slot: 3 }),
      commitEnvironmentSidebarSlot: vi.fn().mockResolvedValue(true),
      releaseEnvironmentSidebarSlotClaim: vi.fn().mockResolvedValue(true),
    });
    const runAtMs = Date.now() + 3_600_000;

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "scheduled-env",
          harness: "codex",
          planSelection: { mode: "specific", artifactId: "plan-1" },
          schedule: { runAtMs, timeZone: "UTC" },
        }),
      },
      createOpenCodeCreateEnv({ OPENAI_API_KEY: "selected-openai-key" }) as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      displayName: "Scheduled implementation",
      sidebarSlot: 3,
      startupPlanId: "plan-1",
    });
    expect(getArtifact).toHaveBeenCalledTimes(1);
    expect(lifecycleStub.initializeStoppedEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: "Scheduled implementation",
        sidebarSlot: 3,
        startupPlanId: "plan-1",
      }),
      expect.anything(),
      expect.objectContaining({
        plan: {
          artifactId: "plan-1",
          version: 11,
          renderedPlanDocument: expect.stringContaining("# Scheduled snapshot"),
        },
      }),
    );
  });

  it("rebases an initial host Create once without repeating preparation", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const rejection = Object.assign(
      new Error("Runner command generation 1 was superseded by 60."),
      {
        code: "runner_command_superseded_before_mutation",
        currentCommandGeneration: 60,
      },
    );
    const create = vi.fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ runnerId: "machine-1", backend: "host" });
    mocks.getRunnerBackend.mockResolvedValue({
      create,
      destroy: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockResolvedValue("running"),
    });
    const hostService = {
      machineId: "machine-1",
      displayName: "Build machine",
      connectedAt: "2026-08-03T00:00:00.000Z",
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      dockerAvailable: true,
      runnerAvailable: true,
      claudeSubscription: false,
      transport: "session",
    };
    const env = createOpenCodeCreateEnv();
    env.HUB = {
      idFromName: vi.fn().mockReturnValue("hub-id"),
      get: vi.fn().mockReturnValue({
        broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined),
        broadcastEnvRemove: vi.fn(),
        broadcastRepoUpsert: vi.fn(),
        broadcastRepoMainChange: vi.fn(),
        addMessage: vi.fn(),
        resolveNewExecutionPlacement: vi.fn().mockResolvedValue({ backend: "host", machineId: "machine-1" }),
        resolveRepoSessionEnvVars: vi.fn().mockResolvedValue({}),
        getRoutableHostService: vi.fn().mockResolvedValue(hostService),
      }),
    };
    const executionCtx = createExecutionCtx();

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
        }),
      },
      env as any,
      executionCtx as any,
    );

    expect(response.status).toBe(201);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(lifecycleStub.rebaseRejectedRunnerCommand).toHaveBeenCalledWith({
      rejectedCommand: {
        commandGeneration: 1,
        operationId: "start-op-1",
        desiredState: "running",
      },
      currentCommandGeneration: 60,
    });
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls.map((call) => call[2].runnerCommand.commandGeneration))
      .toEqual([1, 61]);
    expect(mocks.refreshGitHubDefaultBranchHeadForRequest).toHaveBeenCalledTimes(1);
  });

  it("reports creation workspace failures against the winning claim without dispatching", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const create = vi.fn();
    mocks.getRunnerBackend.mockResolvedValue({ create, getStatus: vi.fn() });
    mocks.getWorkspaceStub.mockReturnValue({
      destroyWorkspace: vi.fn().mockRejectedValue(new Error("workspace cleanup failed")),
    });

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
        }),
      },
      createOpenCodeCreateEnv() as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(502);
    const body = await response.json() as { error: string; code: string; referenceId: string };
    expect(body).toMatchObject({
      error: expect.stringMatching(/^Tiller couldn’t restore the workspace\. Retry Start\. Reference ID: TLR-/),
      code: "workspace_hydration_failed",
      referenceId: expect.stringMatching(/^TLR-/),
    });
    expect(JSON.stringify(body)).not.toContain("workspace cleanup failed");
    expect(lifecycleStub.reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "workspace-sync",
      message: body.error,
    });
    expect((await lifecycleStub.getMutableState()).harnessSettings).toEqual({
      model: "kimi-k2.7-code",
      effort: "high",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("reports creation credential failures against the winning claim without dispatching", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const create = vi.fn();
    mocks.getRunnerBackend.mockResolvedValue({ create, getStatus: vi.fn() });
    mocks.getSecret.mockImplementation(async (source: Record<string, unknown>, key: string) => {
      if (key === "OPENAI_API_KEY") throw new Error("creation credential lookup failed");
      return source[key] ?? undefined;
    });

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
          harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
        }),
      },
      createOpenCodeCreateEnv({ OPENAI_API_KEY: "present" }) as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "creation credential lookup failed" });
    expect(lifecycleStub.reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "harness-launch",
      message: "creation credential lookup failed",
    });
    expect((await lifecycleStub.getMutableState()).harnessSettings).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("launches creation from the claim-returned settings and reports dispatch failure", async () => {
    const lifecycleStub = createLifecycleStub();
    const initialize = lifecycleStub.initializeAndBeginStart.getMockImplementation();
    lifecycleStub.initializeAndBeginStart.mockImplementation(async (...args: any[]) => {
      const result = await initialize!(...args);
      return {
        ...result,
        harnessSettings: { model: "gpt-5.5", effort: "low" },
      };
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const create = vi.fn().mockRejectedValue(new Error("creation dispatch failed"));
    mocks.getRunnerBackend.mockResolvedValue({ create, getStatus: vi.fn() });
    const executionCtx = createExecutionCtx();

    const response = await createTestApp().request(
      "https://example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          slug: "opencode-env",
          harness: "opencode",
        }),
      },
      createOpenCodeCreateEnv({ OPENAI_API_KEY: "selected-openai-key" }) as any,
      executionCtx as any,
    );

    expect(response.status).toBe(201);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ harnessSettings: { model: "gpt-5.5", effort: "low" } }),
      expect.objectContaining({
        TILLER_OPENCODE_MODEL_ID: "gpt-5.5",
        TILLER_OPENCODE_REASONING_EFFORT: "low",
      }),
      expect.objectContaining({ startOpId: "start-op-1" }),
    );
    expect(lifecycleStub.reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "harness-launch",
      message: expect.stringMatching(/^Tiller couldn’t complete the runtime operation\. Reference ID: TLR-/),
      runnerMayExist: true,
    });
  });

  it("starts an existing OpenCode env from committed harness settings", async () => {
    const start = vi.fn().mockResolvedValue({
      runnerId: "machine-1",
      backend: "cf",
    });
    const broadcastEnvUpsert = vi.fn().mockResolvedValue(undefined);
    mocks.getRunnerBackend.mockResolvedValue({
      start,
      getStatus: vi.fn().mockResolvedValue("stopped"),
    });

    const kvPut = vi.fn().mockResolvedValue(undefined);
    const storedEnv = {
      slug: "opencode-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      runnerId: "machine-1",
      backend: "cf",
      harness: "opencode",
      createdAt: "2024-01-01T00:00:00.000Z",
      status: "stopped",
      startupPlanId: null,
      baseMainCommit: "main-sha",
      lastKnownMainCommit: "main-sha",
    };
    const kv = createKvStore({
      "opencode-env": JSON.stringify(storedEnv),
    }, kvPut);
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord(storedEnv));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
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
          resolveRepoSessionEnvVars: vi.fn().mockResolvedValue({}),
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
      "https://hub.example.com/api/envs/opencode-env/start",
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
        TILLER_OPENCODE_BASE_URL: "https://demo.preview.workers.dev/api/opencode/v1",
        TILLER_OPENCODE_AUTH_TOKEN: "proxy-token-123",
        TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
      }),
      expect.objectContaining({
        startOpId: "start-op-1",
      }),
    );

    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      slug: "opencode-env",
      harness: "opencode",
      status: "starting",
    });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.not.toHaveProperty("opencodeProvider");
    await expect(lifecycleStub.getOwnedEnvView()).resolves.not.toHaveProperty("opencodeModel");
    expect(lifecycleStub.beginStart).toHaveBeenCalledWith(
      { model: "kimi-k2.7-code", effort: "high" },
      { claudeAuthMode: null, codexAuthPreference: null },
    );
  });

  it("rebases an existing host Start once without repeating preparation", async () => {
    const rejection = Object.assign(
      new Error("Runner command generation 1 was superseded by 60."),
      {
        code: "runner_command_superseded_before_mutation",
        currentCommandGeneration: 60,
      },
    );
    const start = vi.fn()
      .mockRejectedValueOnce(rejection)
      .mockResolvedValueOnce({ runnerId: "machine-1", backend: "host" });
    const fixture = await createOpenCodeStartFixture({ start, backend: "host" });
    (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__ = {
      schemaVersion: 1,
      channel: "development",
      hubVersion: "0.2.54",
    };
    (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__ = {
      imageSourceId: fixture.runtimeSourceId,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${fixture.runtimeSourceId}`,
    };
    const executionCtx = createExecutionCtx();

    try {
      const response = await fixture.app.request(
        "https://hub.example.com/api/envs/opencode-env/start",
        { method: "POST" },
        fixture.env as any,
        executionCtx as any,
      );

      expect(response.status).toBe(200);
      await executionCtx.waitUntil.mock.calls[0][0];
      expect(fixture.lifecycleStub.claimRunnerCommand).toHaveBeenCalledWith("start-op-1", "running");
      expect(start.mock.calls[0]?.[2]).toMatchObject({
        runnerCommand: { commandGeneration: 1, operationId: "start-op-1", desiredState: "running" },
      });
      expect(fixture.lifecycleStub.rebaseRejectedRunnerCommand).toHaveBeenCalledWith({
        rejectedCommand: {
          commandGeneration: 1,
          operationId: "start-op-1",
          desiredState: "running",
        },
        currentCommandGeneration: 60,
      });
      expect(start).toHaveBeenCalledTimes(2);
      expect(start.mock.calls.map((call) => call[2].runnerCommand.commandGeneration))
        .toEqual([1, 61]);
      expect(mocks.refreshGitHubDefaultBranchHeadForRequest).toHaveBeenCalledTimes(1);
    } finally {
      delete (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__;
      delete (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__;
    }
  });

  it("uses the immutable plan snapshot for a later ordinary Start after the source artifact is gone", async () => {
    const fixture = await createOpenCodeStartFixture({ startupPlanId: "plan-1" });
    const capturedPlan = "# Captured plan\n\nImplement the immutable version.";
    fixture.lifecycleStub.getImmutablePlan.mockResolvedValue({
      incarnationId: "incarnation-1",
      artifactId: "plan-1",
      version: 7,
      renderedPlanDocument: capturedPlan,
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    const artifactStore = mocks.getArtifactStoreStub(
      {} as any,
      "repo-1",
      "generation-1",
    ) as any;
    artifactStore.getArtifact.mockResolvedValue(null);
    const executionCtx = createExecutionCtx();

    const response = await fixture.app.request(
      "https://hub.example.com/api/envs/opencode-env/start",
      { method: "POST" },
      fixture.env as any,
      executionCtx as any,
    );

    expect(response.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(fixture.start.mock.calls[0]?.[1]?.TILLER_STARTUP_PLAN_DOCUMENT_B64).toBeUndefined();
    const workspaceStub = mocks.getWorkspaceStub.mock.results[0]?.value;
    expect(workspaceStub.writeWorkspaceFile).toHaveBeenCalledWith(
      "/.tiller/plan.md",
      capturedPlan,
    );
    expect(artifactStore.getArtifact).not.toHaveBeenCalled();
  });

  it("keeps the saved plan association while starting fresh without an implementation prompt", async () => {
    const fixture = await createOpenCodeStartFixture({ startupPlanId: "plan-1" });
    const executionCtx = createExecutionCtx();

    const response = await fixture.app.request(
      "https://hub.example.com/api/envs/opencode-env/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ implementationMode: "fresh" }),
      },
      fixture.env as any,
      executionCtx as any,
    );

    expect(response.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(fixture.start.mock.calls[0]?.[1]?.TILLER_STARTUP_PLAN_DOCUMENT_B64).toBeUndefined();
    const workspaceStub = mocks.getWorkspaceStub.mock.results[0]?.value;
    expect(workspaceStub.clearWorkspacePlanFile).toHaveBeenCalledTimes(1);
    const definition = JSON.parse(await fixture.env.ENVS_KV.get("envdef:opencode-env"));
    expect(definition.startupPlanId).toBe("plan-1");
  });

  it("rejects incomplete restart settings before claiming", async () => {
    const { app, env, lifecycleStub, start } = await createOpenCodeStartFixture();
    const response = await app.request(
      "https://hub.example.com/api/envs/opencode-env/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harnessSettings: { model: "gpt-5.5" } }),
      },
      env as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(400);
    expect(lifecycleStub.beginStart).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
  });

  it("preserves a Sol dispatch failure and never retries with GPT-5.5", async () => {
    const start = vi.fn().mockRejectedValue(new Error("Sol capacity unavailable for this account"));
    const fixture = await createOpenCodeStartFixture({ start });
    const executionCtx = createExecutionCtx();
    const response = await fixture.app.request(
      "https://hub.example.com/api/envs/opencode-env/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" } }),
      },
      fixture.env as any,
      executionCtx as any,
    );

    expect(response.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(fixture.lifecycleStub.beginStart).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(start.mock.calls[0][1]).toMatchObject({
      TILLER_OPENCODE_MODEL_ID: "gpt-5.6-sol",
      TILLER_OPENCODE_REASONING_EFFORT: "xhigh",
    });
    expect(JSON.stringify(start.mock.calls)).not.toContain("gpt-5.5");
    expect(fixture.lifecycleStub.reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "harness-launch",
      message: expect.stringMatching(/^Tiller couldn’t complete the runtime operation\. Reference ID: TLR-/),
      runnerMayExist: true,
    });
    expect((await fixture.lifecycleStub.getMutableState()).harnessSettings).toEqual({
      model: "gpt-5.6-sol",
      effort: "xhigh",
    });
  });

  it("makes a Cloudflare allocation timeout actionable without exposing provider detail", async () => {
    const providerDetail = "there is no container instance that can be provided to this durable object";
    const start = vi.fn().mockRejectedValue(new Error(providerDetail));
    const fixture = await createOpenCodeStartFixture({ start });
    const executionCtx = createExecutionCtx();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await fixture.app.request(
        "https://hub.example.com/api/envs/opencode-env/start",
        { method: "POST" },
        fixture.env as any,
        executionCtx as any,
      );

      expect(response.status).toBe(200);
      await executionCtx.waitUntil.mock.calls[0][0];
      expect(fixture.lifecycleStub.reportStartupFailure).toHaveBeenCalledWith({
        opId: "start-op-1",
        stepId: "harness-launch",
        message: expect.stringMatching(
          /^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/,
        ),
        runnerMayExist: true,
      });
      expect(JSON.stringify(fixture.lifecycleStub.reportStartupFailure.mock.calls))
        .not.toContain(providerDetail);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("retries an exact startup-failure acknowledgement when the first response is lost", async () => {
    const start = vi.fn().mockRejectedValue(new Error("runner dispatch failed"));
    const fixture = await createOpenCodeStartFixture({ start });
    fixture.lifecycleStub.reportStartupFailure.mockRejectedValueOnce(new Error("acknowledgement lost"));
    const executionCtx = createExecutionCtx();

    const response = await fixture.app.request(
      "https://hub.example.com/api/envs/opencode-env/start",
      { method: "POST" },
      fixture.env as any,
      executionCtx as any,
    );

    expect(response.status).toBe(200);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(fixture.lifecycleStub.reportStartupFailure).toHaveBeenCalledTimes(2);
    expect(fixture.lifecycleStub.reportStartupFailure).toHaveBeenLastCalledWith({
      opId: "start-op-1",
      stepId: "harness-launch",
      message: expect.stringMatching(/^Tiller couldn’t complete the runtime operation\. Reference ID: TLR-/),
      runnerMayExist: true,
    });
  });
});
