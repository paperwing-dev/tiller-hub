import { beforeEach, describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { isExecutionPlacement, type HonoEnv } from "../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../scm/model";
import { projectEnvSummary } from "../sync/projectors";
import { applyLifecycleProjectionToMeta } from "../env-lifecycle";
import { makeEnvDefinition } from "./fixtures/env";
import { installedAccessBindings, TEST_WORKERS_DEV_HOSTNAME } from "./access-binding-fixture";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getEnvReviewStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  getScheduledRunCapacityStub: vi.fn(),
  destroyEnv: vi.fn(),
  revokeGitHubBridgesForInteractiveEnv: vi.fn(),
  revokeGitHubBridgesForEnvironmentStart: vi.fn(),
  refreshGitHubDefaultBranchHeadForRequest: vi.fn(),
  exchangeCodexRuntimeAuth: vi.fn(),
  cleanupEnvReviewRunRuntime: vi.fn(),
}));

vi.mock("../setup/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/config")>();
  return {
    ...actual,
    getSecret: async (env: Record<string, unknown>, key: string) => {
      return env[key] || undefined;
    },
  };
});

vi.mock("../helpers", async () => {
  const actual = await vi.importActual<typeof import("../helpers")>("../helpers");
  return {
    ...actual,
    getEnvLifecycleStub: mocks.getEnvLifecycleStub,
    getEnvReviewStub: mocks.getEnvReviewStub,
    getWorkspaceStub: mocks.getWorkspaceStub,
    getScheduledRunCapacityStub: mocks.getScheduledRunCapacityStub,
  };
});

vi.mock("../env/service", async () => {
  const actual = await vi.importActual<typeof import("../env/service")>("../env/service");
  return {
    ...actual,
    destroyEnv: mocks.destroyEnv,
  };
});

vi.mock("../github/bridge", () => ({
  revokeGitHubBridgesForInteractiveEnv: mocks.revokeGitHubBridgesForInteractiveEnv,
  revokeGitHubBridgesForEnvironmentStart: mocks.revokeGitHubBridgesForEnvironmentStart,
}));

vi.mock("../repo/refresh", () => ({
  refreshGitHubDefaultBranchHeadForRequest: mocks.refreshGitHubDefaultBranchHeadForRequest,
}));

vi.mock("../codex-runtime-auth", async () => {
  const actual = await vi.importActual<typeof import("../codex-runtime-auth")>("../codex-runtime-auth");
  return {
    ...actual,
    exchangeCodexRuntimeAuth: mocks.exchangeCodexRuntimeAuth,
  };
});

vi.mock("../env-review/dispatch", async () => {
  const actual = await vi.importActual<typeof import("../env-review/dispatch")>("../env-review/dispatch");
  return {
    ...actual,
    cleanupEnvReviewRunRuntime: mocks.cleanupEnvReviewRunRuntime,
  };
});

import envRoutes from "../env/routes";
import {
  cleanupLaunchCredentialsBestEffort,
  createEnvAction,
  storedStartupPlanSelection,
  startEnvAction,
  stopEnvAction,
} from "../env/lifecycle-actions";
import { resolveContainerHubUrl, resolveHubPublicUrl, rewriteLoopbackHubUrlForDocker } from "../env/hub-url";

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    if (c.req.path.endsWith("/codex/runtime-auth")) {
      c.set("authorization", {
        kind: "environment",
        envSlug: "my-env",
        incarnationId: "incarnation-1",
        startOperationId: "start-op-1",
      });
    } else {
      c.set("authorization", { kind: "global", source: "local-dev" });
    }
    await next();
  });
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
        : "main-sha";

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

function buildStoredRepoRecord(repoId = "repo-1") {
  return {
    repoId,
    githubInstallationId: 98765,
    githubFullName: "test/repo",
    ...createInitialRepoScmState(),
    mainCommit: "main-sha",
    gitArtifactId: "artifact-1",
    gitStatus: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
  };
}

function addRepoIndex(store: Map<string, string>, repoId = "repo-1") {
  store.set(`repo:${repoId}`, JSON.stringify({
    repoId,
    updatedAt: "2024-01-01T00:00:00.000Z",
  }));
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

function buildOwnedEnvView(
  slug = "my-env",
  overrides: Record<string, unknown> = {},
) {
  return {
    ...buildStoredEnvRecord({
      slug,
      status: "running",
      updatedAt: "2024-01-01T00:00:01.000Z",
    }),
    lifecyclePhase: "running",
    lifecycleOpId: null,
    lifecycleOperation: null,
    lifecycleDesiredState: "running",
    lifecycleLastRunnerState: "running",
    lifecycleLastWorkspaceSyncedAckOpId: null,
    lifecycleInfraState: "ready",
    lifecycleRuntimeReady: true,
    lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
    runnerId: "runner-1",
    bootMessage: null,
    bootStepId: null,
    leadHarnessStatus: null,
    leadHarnessError: null,
    leadHarnessUpdatedAt: null,
    error: null,
    errorAt: null,
    ...overrides,
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
            addRepoIndex(store, explicit.repoId);
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
      if (key.startsWith("envdef:")) {
        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          if (typeof parsed.repoId === "string") {
            addRepoIndex(store, parsed.repoId);
          }
        } catch {
          // ignore non-env rows
        }
      }
      if (!key.startsWith("envdef:")) {
        try {
          const parsed = JSON.parse(value) as Record<string, unknown>;
          if (typeof parsed.slug === "string" && typeof parsed.repoUrl === "string" && typeof parsed.createdAt === "string") {
            const explicit = buildStoredEnvRecord(parsed);
            addRepoIndex(store, explicit.repoId);
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
      executionPlacement?: { backend: "cf"; machineId: null } | { backend: "host"; machineId: string };
      executionAvailable?: boolean;
      broadcastEnvUpsert?: ReturnType<typeof vi.fn>;
      requestLocalRunner?: ReturnType<typeof vi.fn>;
    } = vi.fn().mockResolvedValue(undefined),
) {
  const options = typeof optionsOrBroadcastEnvUpsert === "function"
    ? { broadcastEnvUpsert: optionsOrBroadcastEnvUpsert }
    : optionsOrBroadcastEnvUpsert;
  const placement = options.executionPlacement ?? { backend: "cf" as const, machineId: null };

  return {
    idFromName: vi.fn().mockReturnValue("hub-id"),
    get: vi.fn().mockReturnValue({
      broadcastEnvUpsert: options.broadcastEnvUpsert ?? vi.fn().mockResolvedValue(undefined),
      broadcastEnvRemove: vi.fn(),
      broadcastRepoUpsert: vi.fn(),
      broadcastRepoMainChange: vi.fn(),
      addMessage: vi.fn(),
      getOpenAIAuthStatus: vi.fn().mockResolvedValue({
        status: "connected",
        authenticated: true,
        account_id: "acct-test",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        error: null,
      }),
      getBillingSelections: vi.fn().mockResolvedValue({
        claudeBillingMode: "api",
        openaiBillingMode: "api",
      }),
      resolveNewExecutionPlacement: options.executionAvailable === false
        ? vi.fn().mockRejectedValue(new Error("selected backend unavailable"))
        : vi.fn().mockResolvedValue(placement),
      getExecutionStatus: vi.fn().mockResolvedValue({
        selected: placement.backend === "cf"
          ? { target: "cf" }
          : { target: "host", machineId: placement.machineId },
        selectedHost: placement.backend === "host"
          ? options.activeHostService
            ? {
                state: "ready",
                machineId: placement.machineId,
                displayName: String(options.activeHostService.displayName ?? placement.machineId),
              }
            : {
                state: "offline",
                machineId: placement.machineId,
                displayName: placement.machineId,
              }
          : null,
        candidate: options.activeHostService
          ? {
              state: "ready",
              machineId: String(options.activeHostService.machineId),
              displayName: String(options.activeHostService.displayName ?? options.activeHostService.machineId),
            }
          : { state: "not_connected" },
        executionReady: placement.backend === "cf" || Boolean(options.activeHostService),
      }),
      getHostService: vi.fn().mockImplementation(async (machineId?: string | null) => {
        const normalizedMachineId = machineId?.trim() || null;
        if (!normalizedMachineId) {
          return options.activeHostService ?? null;
        }
        return options.hostServicesByMachineId?.[normalizedMachineId] ?? null;
      }),
      getRoutableHostService: vi.fn().mockImplementation(async (machineId?: string | null) => {
        const normalizedMachineId = machineId?.trim() || null;
        const service = normalizedMachineId
          ? options.hostServicesByMachineId?.[normalizedMachineId] ?? null
          : options.activeHostService ?? null;
        const routable = typeof options.isHostRoutable === "function"
          ? options.isHostRoutable(normalizedMachineId)
          : options.isHostRoutable ?? false;
        return routable ? service : null;
      }),
      isHostRoutable: vi.fn().mockImplementation(async (preferredMachineId?: string | null) => {
        if (typeof options.isHostRoutable === "function") {
          return options.isHostRoutable(preferredMachineId ?? null);
        }
        return options.isHostRoutable ?? false;
      }),
      requestLocalRunner: options.requestLocalRunner ?? vi.fn(),
    }),
  };
}

function createLifecycleStub() {
  let hydrated = false;
  let current: any = {
    slug: "my-env",
    incarnationId: "incarnation-my-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf" as const,
    executionPlacement: { backend: "cf" as const, machineId: null },
    harness: "claude-code" as const,
    createdAt: "2024-01-01",
    ...createInitialEnvScmState({ slug: "my-env" }),
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
    bootMessage: null as string | null,
    bootStepId: null as string | null,
    branchStatus: null as string | null,
    workspaceDirty: null as boolean | null,
    workspaceNeedsAttention: null as boolean | null,
    workspaceLastSyncedAt: null as string | null,
    implementorAttentionToken: null as string | null,
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
      updatedAt: new Date().toISOString(),
    };
    hydrated = true;
    return {
      lifecycle: {
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
        updatedAt: current.updatedAt,
      },
      dispatchGranted: true,
      harnessSettings: settings,
    };
  };
  return {
    isInitialCreationPending: vi.fn().mockResolvedValue(false),
    preparePublicStart: vi.fn().mockResolvedValue({ action: "ordinary" }),
    getScheduledRun: vi.fn().mockResolvedValue(null),
    getImmutablePlan: vi.fn().mockResolvedValue(null),
    cancelScheduledRun: vi.fn().mockResolvedValue({ cancelled: true }),
    requestScheduledRunOutcome: vi.fn().mockResolvedValue({ status: "accepted", outcome: "completed" }),
    persistOwnedProjection: vi.fn().mockImplementation(async () => current),
    getOwnedEnvView: vi.fn().mockImplementation(async () => current),
    reportImplementorCompletion: vi.fn().mockResolvedValue({ accepted: true, changed: true }),
    acknowledgeImplementorAttention: vi.fn().mockResolvedValue("acknowledged"),
    recordScheduledRunCredentialsCleaned: vi.fn().mockResolvedValue(false),
    recordScheduledRunCredentialCleanupPending: vi.fn().mockResolvedValue(false),
    recordScheduledRunnerUncertainty: vi.fn().mockResolvedValue(false),
    recordScheduledRunPostClaimFailure: vi.fn().mockResolvedValue(false),
    beginScheduledRunPreparation: vi.fn().mockResolvedValue(1_234),
    renewScheduledRunPreparation: vi.fn().mockResolvedValue(true),
    beginScheduledRunPreparationEffect: vi.fn().mockResolvedValue(true),
    finishScheduledRunPreparationEffect: vi.fn().mockResolvedValue(true),
    finishScheduledRunPreparation: vi.fn().mockResolvedValue(true),
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
    beginDelete: vi.fn().mockImplementation(async () => {
      hydrated = true;
      current = { ...current, status: "deleting", error: null, errorAt: null };
      return {
        allowed: true,
        mutableState: current,
        runnerCommand: { commandGeneration: 1, operationId: "destroy-op-1", desiredState: "absent" },
      };
    }),
    abortDelete: vi.fn().mockImplementation(async (message: string) => {
      current = { ...current, status: "failed", error: message };
      return current;
    }),
    clearMutableState: vi.fn().mockResolvedValue(null),
    getGitHubPublishOperation: vi.fn().mockResolvedValue(null),
    clearState: vi.fn().mockResolvedValue(null),
    getState: vi.fn().mockResolvedValue(null),
    getEnvironmentRuntimeSubject: vi.fn().mockResolvedValue(null),
    getMutableState: vi.fn().mockImplementation(async () => current),
    peekMutableState: vi.fn().mockImplementation(async () => current),
    peekVisibleMutableState: vi.fn().mockImplementation(async (incarnationId: string) => (
      incarnationId === current.incarnationId ? current : null
    )),
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
        ...meta,
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
    initializeAndBeginStart: vi.fn().mockImplementation(async (
      _definition: Record<string, unknown>,
      initial: Record<string, unknown>,
      settings: Record<string, unknown>,
    ) => claimStart(settings, initial)),
    initializeStoppedEnvironment: vi.fn().mockImplementation(async (
      definition: Record<string, unknown>,
      initial: Record<string, unknown>,
    ) => {
      if (hydrated) return { created: false, claimId: null, mutableState: current };
      current = { ...current, ...initial };
      hydrated = true;
      return {
        created: true,
        claimId: typeof definition.incarnationId === "string"
          ? definition.incarnationId
          : "untagged-test-incarnation",
        mutableState: current,
      };
    }),
    publishStoppedInitialization: vi.fn().mockResolvedValue(true),
    commitStoppedInitialization: vi.fn().mockResolvedValue(true),
    rollbackStoppedInitialization: vi.fn().mockImplementation(async () => {
      hydrated = false;
      return true;
    }),
    beginStart: vi.fn().mockImplementation(async (settings: Record<string, unknown>) => claimStart(settings)),
    requestStop: vi.fn().mockResolvedValue(null),
    ensureStopDispatchScheduled: vi.fn().mockResolvedValue(true),
    resumeStopRetry: vi.fn().mockResolvedValue(null),
    reconcile: vi.fn().mockResolvedValue(null),
    clearLeadHarnessState: vi.fn().mockResolvedValue(current),
    beginStartupDiagnostics: vi.fn().mockResolvedValue(current),
    getStartupDiagnostics: vi.fn().mockResolvedValue({ active: null, lastFailed: null }),
    setBootProgress: vi.fn().mockImplementation(async (message: string | null, stepId?: string | null) => {
      hydrated = true;
      current = {
        ...current,
        bootMessage: message,
        ...(stepId !== undefined ? { bootStepId: stepId } : {}),
      };
      return current;
    }),
    setLeadHarnessFailed: vi.fn().mockImplementation(async (message: string) => {
      hydrated = true;
      current = {
        ...current,
        leadHarnessStatus: "failed",
        leadHarnessError: message,
        leadHarnessUpdatedAt: new Date().toISOString(),
      };
      return current;
    }),
    setRunnerBinding: vi.fn().mockResolvedValue(current),
    reportStartupEvent: vi.fn().mockResolvedValue(null),
    reportStartupFailure: vi.fn().mockResolvedValue(current),
    recordStopWorkspaceSynced: vi.fn().mockResolvedValue(current),
    recordWorkspaceSyncFailed: vi.fn().mockResolvedValue(current),
    setStatus: vi.fn().mockImplementation(async (status: string) => {
      hydrated = true;
      current = { ...current, status };
      return current;
    }),
    clearError: vi.fn().mockImplementation(async () => {
      hydrated = true;
      current = { ...current, error: null, errorAt: null };
      return current;
    }),
    setError: vi.fn().mockImplementation(async (message: string) => {
      hydrated = true;
      current = {
        ...current,
        error: message,
        errorAt: new Date().toISOString(),
      };
      return current;
    }),
    noteInfraReady: vi.fn().mockResolvedValue(null),
    noteRunnerStarted: vi.fn().mockResolvedValue(null),
    noteRunnerStartFailed: vi.fn().mockImplementation(async (_opId: string | null, message: string) => {
      hydrated = true;
      current = {
        ...current,
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleDesiredState: "running",
        error: message,
        errorAt: new Date().toISOString(),
      };
      return current;
    }),
    noteRunnerStopped: vi.fn().mockResolvedValue(null),
    noteFencedRunnerAbsentBeforeScheduledStart: vi.fn().mockResolvedValue(false),
    noteFencedScheduledStartRejectedBeforeMutation: vi.fn().mockResolvedValue(false),
    noteStopWorkspaceSynced: vi.fn().mockResolvedValue(null),
    acceptStopWorkspaceSynced: vi.fn().mockResolvedValue({
      accepted: true,
      opId: "callback-op-1",
      state: null,
    }),
    noteWorkspaceSyncFailed: vi.fn().mockResolvedValue(null),
    noteStopDispatchFailed: vi.fn().mockResolvedValue(null),
    clearStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(undefined),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getScheduledRunCapacityStub.mockReturnValue({
    acquire: vi.fn().mockResolvedValue({
      acquired: true,
      idempotent: false,
      lease: { slot: 1, slug: "my-env", attemptId: "attempt-1" },
    }),
    release: vi.fn().mockResolvedValue({ released: true, idempotent: false }),
  });
  mocks.destroyEnv.mockResolvedValue(undefined);
  mocks.revokeGitHubBridgesForInteractiveEnv.mockResolvedValue(undefined);
  mocks.revokeGitHubBridgesForEnvironmentStart.mockResolvedValue(undefined);
  mocks.exchangeCodexRuntimeAuth.mockResolvedValue({
    ok: true,
    access_token: "runtime-access-token",
    account_id: "chatgpt-account",
    expires_at: "2026-07-13T20:00:00.000Z",
  });
  mocks.cleanupEnvReviewRunRuntime.mockResolvedValue(null);
  mocks.refreshGitHubDefaultBranchHeadForRequest.mockImplementation(async (env: unknown, _request: Request, repoId?: string | null) => {
    const resolvedRepoId = repoId?.trim() || "repo-1";
    return {
      repo: {
        workspace: mocks.getWorkspaceStub(env, `plan-store:${resolvedRepoId}`),
        meta: {
          ...buildStoredRepoRecord(resolvedRepoId),
          repoUrl: "https://github.com/test/repo",
          scmModel: "github",
          githubDefaultBranch: "main",
          githubDefaultBranchHeadSha: "main-sha",
          gitStatus: "ready",
          gitError: null,
        },
      },
      changed: false,
      mainChanged: false,
      failureKind: null,
      error: null,
      code: null,
      status: null,
    };
  });
  const defaultLifecycle = createLifecycleStub();
  mocks.getEnvLifecycleStub.mockImplementation((env: any, slug: string) => ({
    ...defaultLifecycle,
    getOwnedEnvView: vi.fn(async () => {
      const raw = await env?.ENVS_KV?.get?.(slug);
      if (typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          if (parsed.slug === slug && typeof parsed.repoUrl === "string") {
            return buildStoredEnvRecord(parsed);
          }
        } catch {
          // Fall through to the lifecycle-owned state.
        }
      }
      return await defaultLifecycle.getOwnedEnvView();
    }),
  }));
  mocks.getEnvReviewStub.mockReturnValue({
    listWorkloadStateForPredeploy: vi.fn().mockResolvedValue([]),
  });
  mocks.getWorkspaceStub.mockImplementation((_env: unknown, name: string) => ({
    readWorkspaceFile: vi.fn(async (path: string) => {
      if (name !== "plan-store:repo-1" || path !== "/.tiller/repo/meta.json") {
        return null;
      }
      return JSON.stringify(buildStoredRepoRecord("repo-1"));
    }),
    getManifest: vi.fn().mockResolvedValue([]),
    getHashedManifest: vi.fn().mockResolvedValue([]),
    readGitHubDeletedWorkspacePaths: vi.fn().mockResolvedValue([]),
    deleteWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
    deleteWorkspaceFile: vi.fn().mockResolvedValue(true),
  }));
});

describe("Cloudflare Stop durability", () => {
  function createCloudflareStopFixture() {
    const stopOpId = "stop-op-cf";
    const runningMeta = buildStoredEnvRecord({
      slug: "my-env",
      backend: "cf",
      executionPlacement: { backend: "cf", machineId: null },
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
    });
    const savingMeta = buildStoredEnvRecord({
      ...runningMeta,
      status: "saving",
      lifecyclePhase: "saving",
      lifecycleOpId: stopOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleRuntimeReady: false,
    });
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.requestStop.mockResolvedValue({
      phase: "saving",
      activeOpId: stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    lifecycleStub.persistOwnedProjection.mockResolvedValue(savingMeta);
    const stopScope = {
      envSlug: "my-env",
      incarnationId: runningMeta.incarnationId,
      startOperationId: "start-op-1",
      stopOperationId: stopOpId,
    };
    lifecycleStub.getEnvironmentRuntimeSubject = vi.fn().mockResolvedValue({
      envSlug: stopScope.envSlug,
      incarnationId: stopScope.incarnationId,
      startOperationId: stopScope.startOperationId,
      lifecycle: {
        phase: "saving",
        activeOpId: stopOpId,
        activeOperation: "stop",
        desiredState: "stopped",
        lastRunnerState: "running",
        lastWorkspaceSyncedAckOpId: null,
        infraState: "ready",
        runtimeReady: false,
        lastError: null,
        lastErrorAt: null,
        updatedAt: "2026-08-13T00:00:00.000Z",
      },
      failedStopFinalizationAuthorized: false,
    });
    lifecycleStub.getState.mockResolvedValue({
      phase: "saving",
      activeOpId: stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-08-13T00:00:00.000Z",
    });
    lifecycleStub.acceptStopWorkspaceSynced.mockResolvedValue({
      accepted: true,
      opId: stopOpId,
      state: null,
    });
    const sandbox = {
      getStatus: vi.fn().mockResolvedValue("running"),
      prepareWorkspaceStop: vi.fn().mockResolvedValue({
        status: "prepared",
        receipt: {
          ...stopScope,
          workspaceLastSyncedAt: "2026-08-13T00:00:05.000Z",
        },
      }),
      schedulePreparedTermination: vi.fn().mockResolvedValue({ status: "scheduled" }),
    };
    const env = {
      ENVS_KV: {
        get: vi.fn(async (key: string) => key === "repo:repo-1"
          ? JSON.stringify({ repoId: "repo-1", updatedAt: "2026-08-13T00:00:00.000Z" })
          : null),
      },
      SANDBOX: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => sandbox),
      },
      HUB: createHubBinding(),
    } as any;
    return { env, lifecycleStub, runningMeta, sandbox, stopOpId, stopScope };
  }

  it("queues interactive Stop in the lifecycle alarm instead of post-response waitUntil", async () => {
    const fixture = createCloudflareStopFixture();
    const executionCtx = createExecutionCtx();

    const result = await stopEnvAction({
      env: fixture.env,
      executionCtx: executionCtx as any,
      slug: "my-env",
      lifecycleStub: fixture.lifecycleStub as any,
      cachedMeta: fixture.runningMeta as any,
    });

    expect(result).toMatchObject({ status: 200, operationId: fixture.stopOpId });
    expect(fixture.lifecycleStub.ensureStopDispatchScheduled).toHaveBeenCalledWith(fixture.stopOpId);
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
    expect(fixture.sandbox.prepareWorkspaceStop).not.toHaveBeenCalled();
  });

  it("awaits the full Cloudflare Stop handshake in an alarm-owned dispatch", async () => {
    const fixture = createCloudflareStopFixture();
    const executionCtx = createExecutionCtx();
    let resolveStop!: () => void;
    fixture.sandbox.prepareWorkspaceStop.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStop = () => resolve({
        status: "prepared",
        receipt: {
          ...fixture.stopScope,
          workspaceLastSyncedAt: "2026-08-13T00:00:05.000Z",
        },
      });
    }));
    let settled = false;

    const resultPromise = stopEnvAction({
      env: fixture.env,
      executionCtx: executionCtx as any,
      slug: "my-env",
      lifecycleStub: fixture.lifecycleStub as any,
      cachedMeta: fixture.runningMeta as any,
      awaitRunnerDispatch: true,
    }).then((result) => {
      settled = true;
      return result;
    });

    await vi.waitFor(() => expect(fixture.sandbox.prepareWorkspaceStop).toHaveBeenCalledWith(
      fixture.stopScope,
      null,
    ));
    expect(settled).toBe(false);
    resolveStop();
    const result = await resultPromise;

    expect(result).toMatchObject({ status: 200, operationId: fixture.stopOpId });
    expect(fixture.lifecycleStub.ensureStopDispatchScheduled).not.toHaveBeenCalled();
    expect(fixture.lifecycleStub.acceptStopWorkspaceSynced).toHaveBeenCalledWith(
      fixture.stopOpId,
      expect.objectContaining({
        workspaceLastSyncedAt: "2026-08-13T00:00:05.000Z",
      }),
    );
    expect(fixture.sandbox.schedulePreparedTermination).toHaveBeenCalledWith(fixture.stopScope);
    expect(
      fixture.lifecycleStub.acceptStopWorkspaceSynced.mock.invocationCallOrder[0],
    ).toBeLessThan(
      fixture.sandbox.schedulePreparedTermination.mock.invocationCallOrder[0]!,
    );
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("resumes an acknowledged Cloudflare Stop by scheduling only the termination phase", async () => {
    const fixture = createCloudflareStopFixture();
    const acknowledgedLifecycle = {
      phase: "stopping",
      activeOpId: fixture.stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: fixture.stopOpId,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-08-13T00:00:05.000Z",
    };
    fixture.lifecycleStub.getState.mockResolvedValue(acknowledgedLifecycle);
    fixture.lifecycleStub.resumeStopRetry.mockResolvedValue(acknowledgedLifecycle);

    const result = await stopEnvAction({
      env: fixture.env,
      executionCtx: createExecutionCtx() as any,
      slug: "my-env",
      lifecycleStub: fixture.lifecycleStub as any,
      cachedMeta: fixture.runningMeta as any,
      expectedStopOpId: fixture.stopOpId,
      awaitRunnerDispatch: true,
    });

    expect(result).toMatchObject({ status: 200, operationId: fixture.stopOpId });
    expect(fixture.sandbox.prepareWorkspaceStop).not.toHaveBeenCalled();
    expect(fixture.lifecycleStub.acceptStopWorkspaceSynced).not.toHaveBeenCalled();
    expect(fixture.sandbox.schedulePreparedTermination).toHaveBeenCalledWith(fixture.stopScope);
  });

  it("does not schedule termination when LifecycleDO rejects the workspace receipt", async () => {
    const fixture = createCloudflareStopFixture();
    fixture.lifecycleStub.acceptStopWorkspaceSynced.mockResolvedValue({
      accepted: false,
      opId: fixture.stopOpId,
      state: null,
    });

    const result = await stopEnvAction({
      env: fixture.env,
      executionCtx: createExecutionCtx() as any,
      slug: "my-env",
      lifecycleStub: fixture.lifecycleStub as any,
      cachedMeta: fixture.runningMeta as any,
      awaitRunnerDispatch: true,
    });

    expect(result).toMatchObject({ status: 200, operationId: fixture.stopOpId });
    expect(fixture.sandbox.prepareWorkspaceStop).toHaveBeenCalledTimes(1);
    expect(fixture.sandbox.schedulePreparedTermination).not.toHaveBeenCalled();
    expect(fixture.lifecycleStub.noteStopDispatchFailed).toHaveBeenCalledTimes(1);
  });

  it("does not turn a post-schedule projection failure into a Stop failure", async () => {
    const fixture = createCloudflareStopFixture();
    fixture.lifecycleStub.persistOwnedProjection
      .mockResolvedValueOnce(fixture.runningMeta)
      .mockRejectedValueOnce(new Error("projection unavailable"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const result = await stopEnvAction({
        env: fixture.env,
        executionCtx: createExecutionCtx() as any,
        slug: "my-env",
        lifecycleStub: fixture.lifecycleStub as any,
        cachedMeta: fixture.runningMeta as any,
        awaitRunnerDispatch: true,
      });

      expect(result).toMatchObject({ status: 200, operationId: fixture.stopOpId });
      expect(fixture.sandbox.schedulePreparedTermination).toHaveBeenCalledTimes(1);
      expect(fixture.lifecycleStub.noteStopDispatchFailed).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("POST /api/envs/:slug/codex/runtime-auth", () => {
  const subscriptionProfile = {
    kind: "subscription-app-server" as const,
    surface: "implementor" as const,
    backend: "cf" as const,
  };
  const subject = {
    envSlug: "my-env",
    incarnationId: "incarnation-1",
    startOpId: "start-op-1",
    profile: subscriptionProfile,
  };

  it("exchanges credentials for the exact active start capability", async () => {
    const acceptImplementorCodexRuntimeAuth = vi.fn(async () => "accepted" as const);
    mocks.getEnvLifecycleStub.mockReturnValue({
      getActiveImplementorCodexRuntimeSubject: vi.fn(async () => subject),
      acceptImplementorCodexRuntimeAuth,
    });

    const response = await createTestApp().request(
      "/api/envs/my-env/codex/runtime-auth",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Capability": "start-capability",
        },
        body: JSON.stringify({ rejected_access_token_sha256: "d".repeat(64) }),
      },
      {} as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "runtime-access-token",
      account_id: "chatgpt-account",
      expires_at: "2026-07-13T20:00:00.000Z",
    });
    expect(mocks.exchangeCodexRuntimeAuth).toHaveBeenCalledWith(
      expect.anything(),
      "d".repeat(64),
    );
    expect(acceptImplementorCodexRuntimeAuth).toHaveBeenCalledWith(
      subject.startOpId,
      "chatgpt-account",
    );
  });

  it("rejects a runtime cancelled during exchange and an account change", async () => {
    const acceptImplementorCodexRuntimeAuth = vi.fn(async (): Promise<
      "accepted" | "inactive" | "account_changed"
    > => "inactive");
    mocks.getEnvLifecycleStub.mockReturnValue({
      getActiveImplementorCodexRuntimeSubject: vi.fn(async () => subject),
      acceptImplementorCodexRuntimeAuth,
    });

    const cancelled = await createTestApp().request(
      "/api/envs/my-env/codex/runtime-auth",
      { method: "POST", headers: { "X-Tiller-Capability": "capability" } },
      {} as any,
      createExecutionCtx() as any,
    );
    expect(cancelled.status).toBe(409);
    expect(await cancelled.json()).toMatchObject({ code: "runtime_inactive" });

    acceptImplementorCodexRuntimeAuth.mockResolvedValue("account_changed");
    const changed = await createTestApp().request(
      "/api/envs/my-env/codex/runtime-auth",
      { method: "POST", headers: { "X-Tiller-Capability": "capability" } },
      {} as any,
      createExecutionCtx() as any,
    );
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({ code: "needs_reconnect" });
  });

  it("rejects invalid, inactive, and API-key starts before broker access", async () => {
    const getActiveImplementorCodexRuntimeSubject = vi.fn(async () => subject as any);
    mocks.getEnvLifecycleStub.mockReturnValue({ getActiveImplementorCodexRuntimeSubject });
    getActiveImplementorCodexRuntimeSubject.mockResolvedValue(null);
    const inactive = await createTestApp().request(
      "/api/envs/my-env/codex/runtime-auth",
      { method: "POST" },
      {} as any,
      createExecutionCtx() as any,
    );
    expect(inactive.status).toBe(409);
    expect(await inactive.json()).toMatchObject({ code: "runtime_inactive" });

    getActiveImplementorCodexRuntimeSubject.mockResolvedValue({
      ...subject,
      profile: {
        kind: "api-key-direct-cli",
        surface: "implementor",
        backend: "cf",
      },
    } as any);
    const apiKey = await createTestApp().request(
      "/api/envs/my-env/codex/runtime-auth",
      { method: "POST", headers: { "X-Tiller-Capability": "capability" } },
      {} as any,
      createExecutionCtx() as any,
    );
    expect(apiKey.status).toBe(409);

    expect(mocks.exchangeCodexRuntimeAuth).not.toHaveBeenCalled();
  });
});

describe("create env startup plan selection", () => {
  it("rejects the removed planId request field", async () => {
    const response = await createTestApp().request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoId: "repo-1", harness: "codex", planId: "plan-1" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "plan_id_removed" });
  });

  it("rejects client-supplied environment display names", async () => {
    const response = await createTestApp().request("/api/envs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repoId: "repo-1",
        harness: "codex",
        displayName: "Client name",
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "display_name_server_generated",
    });
  });
});

describe("Scheduled Run credential cleanup", () => {
  it("revokes only the exact incarnation and Start operation", async () => {
    const env = { HUB: createHubBinding() } as any;
    const scope = { incarnationId: "incarnation-a", startOpId: "start-a" };

    await expect(cleanupLaunchCredentialsBestEffort(env, "my-env", {
      scope,
      ids: {
        githubBridgeId: "bridge-a",
      },
    })).resolves.toEqual({ complete: true });

    const exact = { envSlug: "my-env", ...scope };
    expect(mocks.revokeGitHubBridgesForEnvironmentStart).toHaveBeenCalledWith(env, exact);
    expect(mocks.revokeGitHubBridgesForInteractiveEnv).not.toHaveBeenCalled();
  });
});

describe("Scheduled Run lifecycle callbacks", () => {
  it("requires the exact lifecycle operation header", async () => {
    const app = createTestApp();
    for (const path of [
      "/api/envs/my-env/scheduled-run/idle",
      "/api/envs/my-env/plan-execution/complete",
    ]) {
      const response = await app.request(path, { method: "POST" }, {} as any);
      expect(response.status).toBe(400);
    }
  });

  it("idempotently accepts a lost completion response after finalization", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.getScheduledRun.mockResolvedValue({
      kind: "finished",
      incarnationId: "incarnation-1",
      startOpId: "start-op-1",
      requestedOutcome: "completed",
      outcome: "completed",
    });
    lifecycleStub.requestScheduledRunOutcome.mockResolvedValue({
      status: "idempotent",
      outcome: "completed",
    });

    const result = await stopEnvAction({
      env: {} as any,
      executionCtx: createExecutionCtx() as any,
      slug: "my-env",
      intent: "scheduled",
      requestedOutcome: "completed",
      expectedStartOpId: "start-op-1",
      expectedIncarnationId: "incarnation-1",
      lifecycleStub: lifecycleStub as any,
      cachedMeta: buildStoredEnvRecord({ slug: "my-env", status: "stopped" }) as any,
    });

    expect(result).toEqual({
      status: 200,
      body: { ok: true, slug: "my-env", status: "stopped" },
      scheduledRunTransitionApplied: true,
    });
    expect(lifecycleStub.requestScheduledRunOutcome).toHaveBeenCalledWith({
      opId: "start-op-1",
      outcome: "completed",
    });
    expect(lifecycleStub.requestStop).not.toHaveBeenCalled();
    expect(mocks.getEnvReviewStub).not.toHaveBeenCalled();
  });

});

describe("start env startup plan selection", () => {
  it("uses only the stored startup plan", () => {
    expect(storedStartupPlanSelection(null)).toEqual({ mode: "none" });
    expect(storedStartupPlanSelection("plan-1")).toEqual({
      mode: "specific",
      artifactId: "plan-1",
    });
  });

  it("rejects removed startup plan fields before reading workload state", async () => {
    const app = createTestApp();
    const res = await app.request(
      "https://hub.example.com/api/envs/my-env/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planSelection: { mode: "specific", artifactId: "plan-1" } }),
      },
      {} as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "startup_plan_selection_removed",
    });
  });

  it("allows Retry Start for an exact host failure proven to precede harness launch", async () => {
    const runtimeSourceId = "d".repeat(40);
    (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__ = {
      schemaVersion: 1,
      channel: "development",
      hubVersion: "0.4.1",
    };
    (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__ = {
      imageSourceId: runtimeSourceId,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSourceId}`,
    };
    try {
      const failedStartOpId = "start-op-failed";
      const lifecycleStub = createLifecycleStub();
      const failedMeta = buildStoredEnvRecord({
        slug: "my-env",
        incarnationId: "incarnation-1",
        repoId: "repo-1",
        backend: "host",
        executionPlacement: { backend: "host", machineId: "machine-1" },
        harness: "codex",
        harnessSettings: { model: "gpt-5.5", effort: "high" },
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleOpId: failedStartOpId,
        lifecycleOperation: "start",
        lifecycleDesiredState: "running",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
      });
      await lifecycleStub.initializeMutableStateFromMeta(failedMeta);
      lifecycleStub.getState.mockResolvedValue({
        phase: "failed",
        activeOpId: failedStartOpId,
        activeOperation: "start",
        desiredState: "running",
        lastRunnerState: "stopped",
        lastWorkspaceSyncedAckOpId: null,
        infraState: "stopped",
        runtimeReady: false,
        lastError: "projected startup failure",
        lastErrorAt: "2026-08-08T00:00:00.000Z",
        updatedAt: "2026-08-08T00:00:00.000Z",
      });
      lifecycleStub.getRunnerCommandClaim.mockResolvedValue({
        commandGeneration: 7,
        operationId: failedStartOpId,
        desiredState: "running",
      });
      lifecycleStub.beginStartupDiagnostics.mockRejectedValue(new Error("diagnostic checkpoint"));
      mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
      const hostService = {
        machineId: "machine-1",
        displayName: "Build machine",
        connectedAt: "2026-08-08T00:00:00.000Z",
        runnerCommandProtocol: 1,
        codexRuntimeAuthProtocol: 1,
        dockerAvailable: true,
        runnerAvailable: true,
        claudeSubscription: false,
        localRunnerImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSourceId}`,
        localRunnerImageSourceId: runtimeSourceId,
        transport: "session",
      } as const;
      const requestLocalRunner = vi.fn().mockResolvedValue({
        machineId: "machine-1",
        result: {
          status: "stopped",
          failedStartBeforeHarness: true,
          commandGeneration: 7,
          operationId: failedStartOpId,
        },
      });
      const env = {
        OPENAI_API_KEY: "test-openai-key",
        HUB: createHubBinding({
          activeHostService: hostService,
          hostServicesByMachineId: { "machine-1": hostService },
          isHostRoutable: true,
          requestLocalRunner,
        }),
      } as any;
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

      let result;
      try {
        result = await startEnvAction({
          env,
          executionCtx: createExecutionCtx() as any,
          request: new Request("https://demo.preview.workers.dev/api/envs/my-env/start"),
          requestUrl: "https://demo.preview.workers.dev/api/envs/my-env/start",
          slug: "my-env",
          lifecycleStub: lifecycleStub as any,
          cachedMeta: failedMeta as any,
        });
      } finally {
        consoleError.mockRestore();
      }

      expect(result).toMatchObject({
        status: 502,
        body: {
          code: "workspace_hydration_failed",
          error: expect.stringMatching(/^Tiller couldn’t restore the workspace\. Retry Start\. Reference ID: TLR-/),
        },
      });
      expect(lifecycleStub.beginStart).toHaveBeenCalledTimes(1);
      expect(lifecycleStub.beginStartupDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
        implementationMode: "fresh",
      }));
      expect(lifecycleStub.noteRunnerStopped).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__;
      delete (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__;
    }
  });
});

describe("scheduled start execution placement", () => {
  it.each([
    {
      label: "Cloudflare",
      storedBackend: "cf" as const,
      storedMachineId: undefined,
      currentSelection: { backend: "host" as const, machineId: "other-machine" },
      expectedHostMachineId: null,
    },
    {
      label: "Your machine",
      storedBackend: "host" as const,
      storedMachineId: "machine-1",
      currentSelection: { backend: "cf" as const, machineId: null },
      expectedHostMachineId: "machine-1",
    },
  ])("claims a $label schedule from stored provenance after Settings changes", async ({
    storedBackend,
    storedMachineId,
    currentSelection,
    expectedHostMachineId,
  }) => {
    const runtimeSourceId = "c".repeat(40);
    (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__ = {
      schemaVersion: 1,
      channel: "development",
      hubVersion: "0.2.54",
    };
    (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__ = {
      imageSourceId: runtimeSourceId,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSourceId}`,
    };
    try {
      const lifecycleStub = createLifecycleStub();
      await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
        slug: "my-env",
        incarnationId: "incarnation-1",
        repoId: "repo-1",
        backend: storedBackend,
        executionPlacement: storedBackend === "cf"
          ? { backend: "cf", machineId: null }
          : { backend: "host", machineId: storedMachineId! },
        harness: "codex",
        harnessSettings: { model: "gpt-5.5", effort: "high" },
        startupPlanId: "plan-1",
        status: "stopped",
      }));
      lifecycleStub.getState.mockResolvedValue({
        phase: "stopped",
        activeOpId: "prior-stop-op",
        activeOperation: "stop",
        desiredState: "stopped",
        lastRunnerState: "stopped",
        lastWorkspaceSyncedAckOpId: "prior-stop-op",
        infraState: "stopped",
        runtimeReady: false,
        lastError: null,
        lastErrorAt: null,
        updatedAt: "2026-07-17T00:00:00.000Z",
      });
      const scheduledLifecycle = lifecycleStub as any;
      scheduledLifecycle.beginScheduledRunAttempt = vi.fn().mockResolvedValue({
        attemptId: "attempt-1",
        schedule: {
          incarnationId: "incarnation-1",
          deadlineAtMs: Date.now() + 60_000,
        },
        plan: {
          artifactId: "plan-1",
          version: 1,
          renderedPlanDocument: "# Plan",
        },
      });
      scheduledLifecycle.markScheduledCapacityAcquireUncertain = vi.fn().mockResolvedValue(true);
      scheduledLifecycle.recordScheduledCapacityAcquired = vi.fn().mockResolvedValue(true);
      scheduledLifecycle.recordScheduledPreStartFailure = vi.fn().mockResolvedValue(true);
      scheduledLifecycle.claimScheduledRunStart = vi.fn().mockImplementation(async (input: {
        harnessSettings: Record<string, unknown>;
        hostMachineId: string | null;
        authClaim: { claudeAuthMode: string | null; codexAuthPreference: string | null };
      }) => {
        const claim = await lifecycleStub.beginStart(input.harnessSettings);
        return {
          ...claim,
          claudeAuthMode: input.authClaim.claudeAuthMode,
          codexAuthPreference: input.authClaim.codexAuthPreference,
        };
      });
      lifecycleStub.beginStartupDiagnostics.mockRejectedValue(
        new Error("diagnostic checkpoint"),
      );
      mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

      const hostService = storedMachineId
        ? {
            machineId: storedMachineId,
            displayName: "Build machine",
            connectedAt: "2026-07-17T00:00:00.000Z",
            runnerCommandProtocol: 1,
            codexRuntimeAuthProtocol: 1,
            dockerAvailable: true,
            runnerAvailable: true,
            claudeSubscription: false,
            localRunnerImage: `docker.io/jamieatlason/tiller-sandbox:${runtimeSourceId}`,
            localRunnerImageSourceId: runtimeSourceId,
            transport: "session",
          }
        : null;
      const env = {
        OPENAI_API_KEY: "test-openai-key",
        SANDBOX: {
          idFromName: vi.fn().mockReturnValue("sandbox-id"),
          get: vi.fn().mockReturnValue({ getStatus: vi.fn().mockResolvedValue("stopped") }),
        },
        HUB: createHubBinding({
          executionPlacement: currentSelection,
          ...(hostService
            ? {
                activeHostService: hostService,
                hostServicesByMachineId: { [storedMachineId!]: hostService },
                isHostRoutable: true,
              }
            : {}),
          requestLocalRunner: vi.fn().mockRejectedValue(Object.assign(
            new Error("Runner not found"),
            { code: "runner_not_found" },
          )),
        }),
      } as any;
      const result = await startEnvAction({
        env,
        executionCtx: createExecutionCtx() as any,
        request: new Request("https://demo.preview.workers.dev/api/envs/my-env/start"),
        requestUrl: "https://demo.preview.workers.dev/api/envs/my-env/start",
        slug: "my-env",
        intent: "scheduled",
        expectedIncarnationId: "incarnation-1",
        lifecycleStub: lifecycleStub as any,
        cachedMeta: buildStoredEnvRecord({
          slug: "my-env",
          incarnationId: "incarnation-1",
          repoId: "repo-1",
          backend: storedBackend,
          executionPlacement: storedBackend === "cf"
            ? { backend: "cf", machineId: null }
            : { backend: "host", machineId: storedMachineId! },
          harness: "codex",
          harnessSettings: { model: "gpt-5.5", effort: "high" },
          startupPlanId: "plan-1",
          status: "stopped",
        }) as any,
      });

      expect(result).toMatchObject({
        status: 502,
        body: {
          error: expect.stringMatching(/^Tiller couldn’t restore the workspace\. Retry Start\. Reference ID: TLR-/),
          code: "workspace_hydration_failed",
          referenceId: expect.stringMatching(/^TLR-/),
        },
        scheduledRunTransitionApplied: true,
      });
      expect(scheduledLifecycle.claimScheduledRunStart).toHaveBeenCalledWith({
        attemptId: "attempt-1",
        harnessSettings: { model: "gpt-5.5", effort: "high" },
        hostMachineId: expectedHostMachineId,
        authClaim: {
          claudeAuthMode: null,
          codexAuthPreference: "api-key",
        },
      });
      expect(lifecycleStub.beginStartupDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
        implementationMode: "plan",
      }));
    } finally {
      delete (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__;
      delete (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__;
    }
  });
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

  it("projects a boot message and returns 200", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
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
        body: JSON.stringify({ message: "Syncing workspace..." }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      slug: "my-env",
      status: "starting",
      bootMessage: "Syncing workspace...",
    });
  });

  it("projects the optional step id when provided", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
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
        body: JSON.stringify({ message: "Uploading 1 file (48 B)...", stepId: "workspace-sync" }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      slug: "my-env",
      bootMessage: "Uploading 1 file (48 B)...",
      bootStepId: "workspace-sync",
    });
  });

  it("awaits owned projection delivery before responding", async () => {
    let projectionCompleted = false;
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.persistOwnedProjection.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          projectionCompleted = true;
          resolve();
        }, 50);
      });
      return lifecycleStub.getOwnedEnvView();
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
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
        body: JSON.stringify({ message: "Starting services..." }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    expect(projectionCompleted).toBe(true);
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

  it("projects stored runtime failures without exposing raw diagnostics", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.getStartupDiagnostics.mockResolvedValue({
      active: {
        opId: "start-op-raw",
        backend: "host",
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:05.000Z",
        currentStepId: "harness-launch",
        currentStepMessage: "secret runtime output",
        events: [
          {
            at: "2024-01-01T00:00:05.000Z",
            opId: "start-op-raw",
            stepId: "harness-launch",
            severity: "error",
            message: "secret runtime output",
            detail: "private detail",
          },
          {
            at: "2024-01-01T00:00:04.000Z",
            opId: "start-op-raw",
            stepId: "hub-connect",
            severity: "warn",
            message: "tiller-harness last output: private warning output",
            detail: null,
          },
        ],
        failure: {
          message: "secret runtime output",
          exitCode: 17,
          signal: "SIGTERM",
          lastStepId: "harness-launch",
        },
        logTails: {
          harness: "private harness log",
          stopControl: "private stop log",
          bootstrap: "private bootstrap log",
        },
      },
      lastFailed: null,
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({ "my-env": ENV_META }),
      HUB: createHubBinding(),
    };

    const res = await createTestApp().request(
      "/api/envs/my-env/startup-diagnostics",
      {},
      env as any,
    );
    const body = await res.json() as any;
    const serialized = JSON.stringify(body);

    expect(res.status).toBe(200);
    expect(body.active.failure).toMatchObject({
      message: expect.stringMatching(/^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/),
      exitCode: null,
      signal: null,
    });
    expect(body.active.events[0]).toMatchObject({
      message: body.active.failure.message,
      detail: null,
    });
    expect(body.active.logTails).toEqual({
      harness: null,
      stopControl: null,
      bootstrap: null,
    });
    expect(serialized).not.toContain("secret runtime output");
    expect(serialized).not.toContain("private detail");
    expect(serialized).not.toContain("private harness log");
    expect(serialized).not.toContain("private warning output");
  });

  it("accepts structured startup events", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const env = {
      // Exact lifecycle callbacks must not depend on the eventually-consistent
      // projection being discoverable.
      ENVS_KV: createKvStore({}),
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

  it("records startup diagnostic failures and re-projects the env", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "cf",
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "starting",
      lifecyclePhase: "starting",
      lifecycleDesiredState: "running",
    }));
    lifecycleStub.reportStartupFailure.mockImplementation(async (failure: { message: string }) => {
      await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
        slug: "my-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:05.000Z",
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleDesiredState: "running",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
        error: failure.message,
        errorAt: "2024-01-01T00:00:05.000Z",
      }));
      return null;
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: createKvStore({ "my-env": ENV_META }, put),
      HUB: createHubBinding(broadcast),
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
          type: "failure",
          stepId: "harness-launch",
          message: "Harness exited before connecting",
          detail: "exit code 1",
          exitCode: 1,
          signal: "SIGTERM",
          logTails: { harness: "last lines" },
        }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "failed",
      error: expect.stringMatching(/^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/),
      code: "runtime_start_failed",
      referenceId: expect.stringMatching(/^TLR-/),
    });
    expect(lifecycleStub.reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      stepId: "harness-launch",
      message: expect.stringMatching(/^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/),
      detail: "exit code 1",
      at: null,
      exitCode: 1,
      signal: "SIGTERM",
      logTails: { harness: "last lines" },
    });
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      slug: "my-env",
      status: "failed",
      error: expect.stringMatching(/^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/),
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
  it("accepts or idempotently replays fenced implementor completion reports", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.reportImplementorCompletion
      .mockResolvedValueOnce({ accepted: true, changed: true })
      .mockResolvedValueOnce({ accepted: true, changed: false });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = { ENVS_KV: createKvStore({}), HUB: createHubBinding() };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const res = await createTestApp().request(
        "/api/envs/my-env/implementor-attention/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tiller-Lifecycle-Op-Id": "start-op-1",
          },
          body: JSON.stringify({ sequence: 4 }),
        },
        env as any,
      );
      expect(res.status).toBe(204);
    }

    expect(lifecycleStub.reportImplementorCompletion).toHaveBeenNthCalledWith(
      1,
      "start-op-1",
      4,
    );
    expect(lifecycleStub.reportImplementorCompletion).toHaveBeenNthCalledWith(
      2,
      "start-op-1",
      4,
    );
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledTimes(2);
  });

  it("rejects completions from an older Start without publishing", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.reportImplementorCompletion.mockResolvedValue({
      accepted: false,
      changed: false,
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const res = await createTestApp().request(
      "/api/envs/my-env/implementor-attention/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Lifecycle-Op-Id": "old-start",
        },
        body: JSON.stringify({ sequence: 1 }),
      },
      { ENVS_KV: createKvStore({}), HUB: createHubBinding() } as any,
    );

    expect(res.status).toBe(409);
    expect(lifecycleStub.persistOwnedProjection).not.toHaveBeenCalled();
  });

  it("acknowledges the exact implementor token and reports newer-token conflicts", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.acknowledgeImplementorAttention
      .mockResolvedValueOnce("acknowledged")
      .mockResolvedValueOnce("conflict");
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = { ENVS_KV: createKvStore({}), HUB: createHubBinding() };

    const acknowledge = () => createTestApp().request(
      "/api/envs/my-env/implementor-attention/acknowledge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: "attention-token" }),
      },
      env as any,
    );
    expect((await acknowledge()).status).toBe(204);
    expect((await acknowledge()).status).toBe(409);
    expect(lifecycleStub.acknowledgeImplementorAttention).toHaveBeenCalledTimes(2);
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["infra-ready", "noteInfraReady", "", ["callback-op-1"]],
    ["runner-ready", "noteRunnerStarted", "", ["callback-op-1"]],
    ["runner-stopped", "noteRunnerStopped", "container exited", ["callback-op-1", null]],
    ["workspace-synced", "acceptStopWorkspaceSynced", "", ["callback-op-1", {}]],
    ["stop-failed", "recordWorkspaceSyncFailed", "workspace upload failed", [
      "callback-op-1",
      expect.stringMatching(/^Tiller couldn’t confirm the workspace save yet\. Saving will retry automatically\. Reference ID: TLR-/),
    ]],
  ] as const)(
    "persists %s in the lifecycle owner when the KV projection is missing",
    async (path, method, body, expectedArgs) => {
      const lifecycleStub = createLifecycleStub();
      mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
      const env = {
        ENVS_KV: createKvStore({}),
        HUB: createHubBinding(),
      };

      const res = await createTestApp().request(
        `/api/envs/my-env/${path}`,
        {
          method: "POST",
          headers: { "X-Tiller-Lifecycle-Op-Id": "callback-op-1" },
          ...(body ? { body } : {}),
        },
        env as any,
      );

      expect(res.status).toBe(200);
      expect((lifecycleStub as any)[method]).toHaveBeenCalledWith(...expectedArgs);
    },
  );

  it("returns the exact accepted Stop operation and rejects stale workspace acknowledgements", async () => {
    const lifecycleStub = createLifecycleStub();
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({}),
      HUB: createHubBinding(),
    };
    const app = createTestApp();

    const accepted = await app.request(
      "/api/envs/my-env/workspace-synced",
      {
        method: "POST",
        headers: { "X-Tiller-Lifecycle-Op-Id": "callback-op-1" },
      },
      env as any,
    );
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({ accepted: true, opId: "callback-op-1" });

    lifecycleStub.acceptStopWorkspaceSynced.mockResolvedValueOnce({
      accepted: false,
      opId: null,
      state: null,
    });
    const stale = await app.request(
      "/api/envs/my-env/workspace-synced",
      {
        method: "POST",
        headers: { "X-Tiller-Lifecycle-Op-Id": "stale-stop-op" },
      },
      env as any,
    );
    expect(stale.status).toBe(409);
  });

  it("marks a starting env infra-ready without completing startup", async () => {
    const lifecycleStub = createLifecycleStub();
    const noteInfraReady = vi.fn().mockImplementation(async () => {
      await lifecycleStub.initializeMutableStateFromMeta({
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
          backend: "host",
          executionPlacement: { backend: "host", machineId: "my-env" },
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
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      status: "starting",
      lifecycleInfraState: "ready",
    });
  });

  it("marks a starting env as running when runner-ready arrives", async () => {
    const lifecycleStub = createLifecycleStub();
    const noteRunnerStarted = vi.fn().mockImplementation(async () => {
      await lifecycleStub.initializeMutableStateFromMeta({
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
          backend: "host",
          executionPlacement: { backend: "host", machineId: "my-env" },
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
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({ status: "running" });
  });

  it("keeps stale runner-ready entirely within the lifecycle owner", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.noteRunnerStarted = vi.fn().mockResolvedValue({
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
      updatedAt: "2026-04-12T00:00:00.000Z",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          executionPlacement: { backend: "host", machineId: "my-env" },
          harness: "codex",
          createdAt: "2024-01-01T00:00:00.000Z",
          status: "starting",
          lifecyclePhase: "starting",
          lifecycleDesiredState: "running",
        }),
      }),
      HUB: createHubBinding(),
    };

    const res = await createTestApp().request(
      "/api/envs/my-env/runner-ready",
      {
        method: "POST",
        headers: { "X-Tiller-Lifecycle-Op-Id": "stale-start-op" },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mocks.getScheduledRunCapacityStub).not.toHaveBeenCalled();
  });

  it("fails a starting env immediately when runner-stopped arrives", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "my-env" },
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "starting",
      lifecyclePhase: "starting",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
    }));
    lifecycleStub.getState.mockResolvedValue({
      phase: "starting",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: null,
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2024-01-01T00:00:00.000Z",
    });
    const noteRunnerStopped = vi.fn().mockImplementation(async (
      _opId: string,
      failureMessage: string,
    ) => {
      await lifecycleStub.initializeMutableStateFromMeta({
        status: "failed",
        lifecyclePhase: "failed",
        lifecycleDesiredState: "running",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
        error: failureMessage,
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
        lastError: failureMessage,
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
          backend: "host",
          executionPlacement: { backend: "host", machineId: "my-env" },
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
    expect(noteRunnerStopped).toHaveBeenCalledWith(
      "start-op-1",
      expect.stringMatching(/^The environment runtime stopped unexpectedly\. Reference ID: TLR-/),
    );
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      status: "failed",
      error: expect.stringMatching(/^The environment runtime stopped unexpectedly\. Reference ID: TLR-/),
    });
  });

  it("finalizes stopped runners by revoking interactive credentials and clearing stop sync metadata", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "cf",
      harness: "codex",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "stopping",
      lifecyclePhase: "stopping",
      lifecycleOpId: "stop-op-1",
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: false,
      workspaceDirty: true,
      workspaceLastSyncedAt: "2024-01-01T00:00:03.000Z",
    }));
    const noteRunnerStopped = vi.fn().mockImplementation(async () => {
      await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
        slug: "my-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "codex",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:05.000Z",
        status: "stopped",
        lifecyclePhase: "stopped",
        lifecycleOpId: "stop-op-1",
        lifecycleOperation: "stop",
        lifecycleDesiredState: "stopped",
        lifecycleInfraState: "stopped",
        lifecycleRuntimeReady: false,
        workspaceDirty: true,
        workspaceLastSyncedAt: "2024-01-01T00:00:03.000Z",
      }));
      return {
        phase: "stopped",
        activeOpId: "stop-op-1",
        activeOperation: "stop",
        desiredState: "stopped",
        lastRunnerState: "stopped",
        lastWorkspaceSyncedAckOpId: "stop-op-1",
        infraState: "stopped",
        runtimeReady: false,
        lastError: null,
        lastErrorAt: null,
        updatedAt: "2024-01-01T00:00:05.000Z",
      };
    });
    lifecycleStub.noteRunnerStopped = noteRunnerStopped;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          backend: "cf",
          harness: "codex",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "stopping",
          lifecyclePhase: "stopping",
          lifecycleOpId: "stop-op-1",
          lifecycleOperation: "stop",
          lifecycleDesiredState: "stopped",
        })),
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
          "X-Tiller-Lifecycle-Op-Id": "stop-op-1",
        },
        body: "exit",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "stopped",
      error: null,
    });
    expect(noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", null);
    expect(mocks.revokeGitHubBridgesForInteractiveEnv).toHaveBeenCalledWith(env, "my-env");
    expect(lifecycleStub.clearStopWorkspaceSyncedMeta).toHaveBeenCalledTimes(1);
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({ status: "stopped" });
  });
});

describe("resolveHubPublicUrl", () => {
  it("uses the canonical workers.dev origin even when a competing URL is configured", async () => {
    expect(
      await resolveHubPublicUrl(
        {
          ...installedAccessBindings(),
          HUB_PUBLIC_URL: "https://tiller.example.com/",
          HUB: createHubBinding(),
        } as any,
        "https://ignored.example.net/api/envs",
      ),
    ).toBe(`https://${TEST_WORKERS_DEV_HOSTNAME}`);
  });

  it("fails closed instead of trusting a deployed request origin", async () => {
    await expect(resolveHubPublicUrl(
      {} as any,
      "https://tiller-preview.example.net/api/envs/demo/start",
    )).rejects.toThrow("Canonical workers.dev Access trust is not configured");
  });
});

describe("env authoritative reads", () => {
  it("GET /api/envs reads definition-backed envs when the summary cache row is missing", async () => {
    mocks.getEnvLifecycleStub.mockReturnValue({
      getOwnedEnvView: vi.fn().mockResolvedValue({
        ...buildOwnedEnvView("ghost-env"),
        status: "running",
        lifecyclePhase: "running",
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
        runnerId: "runner-1",
        bootMessage: null,
        bootStepId: null,
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
      initializeMutableStateFromMeta: vi.fn(),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      { method: "GET" },
      {
        ENVS_KV: createKvStore({
          "envdef:ghost-env": JSON.stringify({
            slug: "ghost-env",
            incarnationId: "incarnation-ghost-env",
            repoId: "repo-1",
            scmModel: "github",
            executionPlacement: { backend: "cf", machineId: null },
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

  it("GET /api/envs ignores malformed summary cache rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getEnvLifecycleStub.mockReturnValue({
      getOwnedEnvView: vi.fn().mockResolvedValue({
        ...buildOwnedEnvView("ghost-env"),
        status: "running",
        lifecyclePhase: "running",
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
        runnerId: "runner-1",
        bootMessage: null,
        bootStepId: null,
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
      initializeMutableStateFromMeta: vi.fn(),
    });

    const kvData = new Map<string, string>([
      ["ghost-env", JSON.stringify({
        slug: "ghost-env",
        repoUrl: "https://github.com/test/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "running",
      })],
      ["envdef:ghost-env", JSON.stringify({
        slug: "ghost-env",
        incarnationId: "incarnation-ghost-env",
        repoId: "repo-1",
        scmModel: "github",
        executionPlacement: { backend: "cf", machineId: null },
        harness: "claude-code",
        startupPlanId: null,
        branchName: "env/ghost-env",
        createdAt: "2024-01-01T00:00:00.000Z",
      })],
      ["repo:repo-1", JSON.stringify({
        repoId: "repo-1",
        updatedAt: "2024-01-01T00:00:00.000Z",
      })],
    ]);
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      { method: "GET" },
      {
        ENVS_KV: {
          get: vi.fn().mockImplementation(async (key: string) => kvData.get(key) ?? null),
          list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string } = {}) => ({
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
        ARTIFACT_STORE: {
          idFromName: vi.fn().mockReturnValue("artifact-store-id"),
          get: vi.fn().mockReturnValue({
            reconcileEnvironmentSidebarSlots: vi.fn().mockReturnValue([
              { slug: "ghost-env", slot: 1 },
            ]),
          }),
        },
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
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("GET /api/envs returns healthy envs even when another env's definition is malformed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.getEnvLifecycleStub.mockReturnValue({
      getOwnedEnvView: vi.fn().mockResolvedValue({
        ...buildOwnedEnvView("good-env"),
        status: "running",
        lifecyclePhase: "running",
        lifecycleOpId: null,
        lifecycleOperation: null,
        lifecycleDesiredState: "running",
        lifecycleInfraState: "ready",
        lifecycleRuntimeReady: true,
        lifecycleUpdatedAt: "2024-01-01T00:00:01.000Z",
        runnerId: "runner-1",
        bootMessage: null,
        bootStepId: null,
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
      initializeMutableStateFromMeta: vi.fn(),
    });

    const kvData = new Map<string, string>([
      ["envdef:good-env", JSON.stringify({
        slug: "good-env",
        incarnationId: "incarnation-good-env",
        repoId: "repo-1",
        scmModel: "github",
        executionPlacement: { backend: "cf", machineId: null },
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
      ["repo:repo-1", JSON.stringify({
        repoId: "repo-1",
        updatedAt: "2024-01-01T00:00:00.000Z",
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
      "[envs] Skipping invalid env bad-env:",
      expect.stringContaining("missing explicit environment schema fields"),
    );
    warn.mockRestore();
  });

  it("GET /api/envs/:slug returns the same shape used for websocket env upserts", async () => {
    const storedMeta = {
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      backend: "cf",
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
    };
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord(storedMeta));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
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
          executionPlacement: { backend: "host", machineId: "host-123" },
          harness: "claude-code",
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

  it("rejects retired per-workload backend selection on localhost", async () => {
    const app = createTestApp();
    const res = await app.request(
      "http://localhost:5173/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          backend: "cf",
          harness: "claude-code",
        }),
      },
      { LOCAL_DEV_ONLY_BACKEND: "true" } as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      code: "backend_selection_removed",
    });
  });

});

describe("DELETE /api/envs/:slug", () => {
  it("does not delete an unstarted machine-backed schedule while its assigned machine is offline", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.getScheduledRun.mockResolvedValue({
      kind: "schedule",
      incarnationId: "incarnation-1",
      attemptId: null,
    });
    lifecycleStub.cancelScheduledRun.mockResolvedValue({ cancelled: true });
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/test/repo",
      backend: "host",
      harness: "codex",
      status: "stopped",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const executionCtx = createExecutionCtx();
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({
          slug: "my-env",
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          harness: "codex",
          status: "stopped",
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        })),
      }),
      HUB: createHubBinding(),
      BUCKET: { delete: vi.fn(), list: vi.fn() },
    } as any;

    const response = await createTestApp().request(
      "/api/envs/my-env",
      { method: "DELETE" },
      env,
      executionCtx as any,
    );

    const body = await response.json();
    expect({ status: response.status, body }).toEqual({
      status: 409,
      body: {
        error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
      },
    });
    expect(lifecycleStub.cancelScheduledRun).toHaveBeenCalledTimes(1);
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.destroyEnv).not.toHaveBeenCalled();
  });

  it("does not finish machine-backed deletion offline after an uncertain pre-Start cancellation settles", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.getScheduledRun.mockResolvedValue(null);
    lifecycleStub.getImmutablePlan.mockResolvedValue({
      incarnationId: "incarnation-1",
      artifactId: "plan-1",
      version: 1,
      renderedPlanDocument: "# Plan",
      createdAt: "2026-07-10T00:00:00.000Z",
    });
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/test/repo",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "my-env" },
      harness: "codex",
      status: "stopped",
      runnerId: null,
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const executionCtx = createExecutionCtx();
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({
          slug: "my-env",
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          executionPlacement: { backend: "host", machineId: "my-env" },
          harness: "codex",
          status: "stopped",
          runnerId: null,
          createdAt: "2026-07-10T00:00:00.000Z",
          updatedAt: "2026-07-10T00:00:00.000Z",
        })),
      }),
      HUB: createHubBinding(),
      BUCKET: { delete: vi.fn(), list: vi.fn() },
    } as any;

    const response = await createTestApp().request(
      "/api/envs/my-env",
      { method: "DELETE" },
      env,
      executionCtx as any,
    );

    const body = await response.json();
    expect({ status: response.status, body }).toEqual({
      status: 409,
      body: {
        error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
      },
    });
    expect(lifecycleStub.cancelScheduledRun).not.toHaveBeenCalled();
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
    expect(mocks.destroyEnv).not.toHaveBeenCalled();
  });

  it("marks the env deleting, revokes interactive credentials, and schedules destroy", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "cf",
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
      error: "old failure",
      errorAt: "2024-01-01T00:00:00.000Z",
    }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          backend: "cf",
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "running",
          error: "old failure",
          errorAt: "2024-01-01T00:00:00.000Z",
        })),
      }, put),
      HUB: createHubBinding(),
      ARTIFACT_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          releaseEnvironmentSidebarSlot: vi.fn().mockResolvedValue(undefined),
        })),
      },
    };
    const app = createTestApp();
    const executionCtx = createExecutionCtx();

    const res = await app.request(
      "/api/envs/my-env",
      { method: "DELETE" },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      slug: "my-env",
      status: "deleting",
      message: "Environment deletion started",
    });
    expect(mocks.revokeGitHubBridgesForInteractiveEnv).toHaveBeenCalledWith(env, "my-env");
    expect(lifecycleStub.beginDelete).toHaveBeenCalledTimes(1);
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      status: "deleting",
      error: null,
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(mocks.destroyEnv).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ slug: "my-env" }),
      expect.objectContaining({
        broadcastEnvRemove: expect.any(Function),
      }),
      expect.objectContaining({
        runnerCommand: expect.objectContaining({ desiredState: "absent" }),
      }),
    );
    expect(lifecycleStub.persistOwnedProjection.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.destroyEnv.mock.invocationCallOrder[0]);
  });

  it("marks lifecycle failed and re-projects when background destroy fails", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "cf",
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
    }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.destroyEnv.mockRejectedValueOnce(new Error("destroy failed"));
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          backend: "cf",
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "running",
        })),
      }, put),
      HUB: createHubBinding(),
      ARTIFACT_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          releaseEnvironmentSidebarSlot: vi.fn().mockResolvedValue(undefined),
        })),
      },
    };
    const app = createTestApp();
    const executionCtx = createExecutionCtx();

    const res = await app.request(
      "/api/envs/my-env",
      { method: "DELETE" },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(lifecycleStub.abortDelete).toHaveBeenCalledWith("destroy failed");
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalledWith({ broadcast: true });
    await expect(lifecycleStub.getOwnedEnvView()).resolves.toMatchObject({
      status: "failed",
      error: "destroy failed",
    });
  });

  it("cancels and cleans an active environment review before deletion", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({ slug: "my-env", status: "stopped" }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const runtime = { jobSlug: "env-review-review-1" };
    const running = {
      runId: "review-1",
      envSlug: "my-env",
      status: "running",
      runtime,
      skillInvocationId: "review-round-1",
    };
    const cancelled = { ...running, status: "cancelled" };
    const listWorkloads = vi.fn()
      .mockResolvedValueOnce([{
        runId: running.runId,
        status: running.status,
        hasRuntime: true,
      }])
      .mockResolvedValueOnce([]);
    const review = {
      listWorkloadStateForPredeploy: listWorkloads,
      getRun: vi.fn()
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(cancelled),
      cancelSkillInvocation: vi.fn().mockResolvedValue({
        invocationId: running.skillInvocationId,
        status: "cancelled",
      }),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({ slug: "my-env", status: "stopped" })),
      }),
      HUB: createHubBinding(),
      ARTIFACT_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          releaseEnvironmentSidebarSlot: vi.fn().mockResolvedValue(undefined),
        })),
      },
    };
    const executionCtx = createExecutionCtx();
    const res = await createTestApp().request("/api/envs/my-env", { method: "DELETE" }, env as any, executionCtx as any);
    expect(res.status).toBe(200);
    expect(review.cancelSkillInvocation).toHaveBeenCalledWith(running.skillInvocationId);
    expect(mocks.cleanupEnvReviewRunRuntime).toHaveBeenCalledWith(env, review, cancelled);
    expect(listWorkloads).toHaveBeenCalledTimes(2);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("cleans retained terminal review runtimes before deletion", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({ slug: "my-env", status: "stopped" }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const run = {
      runId: "review-1",
      envSlug: "my-env",
      status: "ready",
      runtime: { jobSlug: "env-review-review-1" },
    };
    const listWorkloads = vi.fn()
      .mockResolvedValueOnce([{ runId: run.runId, status: run.status, hasRuntime: true }])
      .mockResolvedValueOnce([{ runId: run.runId, status: run.status, hasRuntime: false }]);
    const review = {
      listWorkloadStateForPredeploy: listWorkloads,
      getRun: vi.fn().mockResolvedValue(run),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({ slug: "my-env", status: "stopped" })),
      }),
      HUB: createHubBinding(),
      ARTIFACT_STORE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          releaseEnvironmentSidebarSlot: vi.fn().mockResolvedValue(undefined),
        })),
      },
    };
    const executionCtx = createExecutionCtx();

    const res = await createTestApp().request("/api/envs/my-env", { method: "DELETE" }, env as any, executionCtx as any);

    expect(res.status).toBe(200);
    expect(mocks.cleanupEnvReviewRunRuntime).toHaveBeenCalledWith(env, review, run);
    expect(listWorkloads).toHaveBeenCalledTimes(2);
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it("keeps deletion blocked when retained terminal review cleanup fails", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({ slug: "my-env", status: "stopped" }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const run = {
      runId: "review-1",
      envSlug: "my-env",
      status: "ready",
      runtime: { jobSlug: "env-review-review-1" },
    };
    mocks.getEnvReviewStub.mockReturnValue({
      listWorkloadStateForPredeploy: vi.fn().mockResolvedValue([{
        runId: run.runId,
        status: run.status,
        hasRuntime: true,
      }]),
      getRun: vi.fn().mockResolvedValue(run),
    });
    mocks.cleanupEnvReviewRunRuntime.mockRejectedValueOnce(new Error("runner unavailable"));
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({ slug: "my-env", status: "stopped" })),
      }),
      HUB: createHubBinding(),
    };
    const executionCtx = createExecutionCtx();

    const res = await createTestApp().request("/api/envs/my-env", { method: "DELETE" }, env as any, executionCtx as any);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "environment_delete_blocked" });
    expect(mocks.destroyEnv).not.toHaveBeenCalled();
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("refuses deletion before mutation while GitHub publish work is active", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({ slug: "my-env", status: "stopped" }));
    lifecycleStub.getGitHubPublishOperation.mockResolvedValue({ operationId: "publish-1", envSlug: "my-env" });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify(buildStoredEnvRecord({ slug: "my-env", status: "stopped" })),
      }),
      HUB: createHubBinding(),
    };
    const executionCtx = createExecutionCtx();
    const res = await createTestApp().request("/api/envs/my-env", { method: "DELETE" }, env as any, executionCtx as any);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: "environment_delete_blocked" });
    expect(mocks.getScheduledRunCapacityStub).not.toHaveBeenCalled();
    expect(mocks.destroyEnv).not.toHaveBeenCalled();
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });
});

describe("POST /api/envs/:slug/reset-to-repo", () => {
  it("resets GitHub envs to the refreshed default head and clears draft publication state", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "cf",
      harness: "codex",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "stopped",
      githubBaseBranch: "main",
      githubBaseCommitSha: "main-old",
      githubBranch: "tiller/env/my-env",
      githubHeadCommitSha: "draft-head",
      githubPrNumber: 12,
      githubPrUrl: "https://github.com/test/repo/pull/12",
      githubPrState: "open",
      githubPublishStatus: "published",
      githubPublishOperationId: "publish-1",
      githubLastPublishedAt: "2024-01-01T00:00:00.000Z",
      githubLastPublishedWorkspaceHash: "hash-old",
    }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.refreshGitHubDefaultBranchHeadForRequest.mockResolvedValue({
      repo: {
        workspace: {},
        meta: {
          ...buildStoredRepoRecord("repo-1"),
          repoUrl: "https://github.com/test/repo",
          scmModel: "github",
          githubDefaultBranch: "trunk",
          githubDefaultBranchHeadSha: "main-new",
          gitStatus: "ready",
          gitError: null,
        },
      },
      changed: true,
      mainChanged: true,
      failureKind: null,
      error: null,
      code: null,
      status: null,
    });
    const envWorkspace = {
      getManifest: vi.fn().mockResolvedValue([
        { path: "/src/app.ts", size: 1, mtime: 1 },
        { path: "/.tiller/keep", size: 1, mtime: 1 },
      ]),
      deleteWorkspaceFiles: vi.fn().mockResolvedValue(undefined),
      deleteWorkspaceFile: vi.fn().mockResolvedValue(true),
    };
    mocks.getWorkspaceStub.mockImplementation((_env: unknown, name: string) => {
      if (name === "my-env") return envWorkspace;
      return {
        readWorkspaceFile: vi.fn(async (path: string) => {
          if (name !== "plan-store:repo-1" || path !== "/.tiller/repo/meta.json") return null;
          return JSON.stringify(buildStoredRepoRecord("repo-1"));
        }),
      };
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/reset-to-repo",
      { method: "POST" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify(buildStoredEnvRecord({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            repoId: "repo-1",
            backend: "cf",
            harness: "codex",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "stopped",
            githubBaseCommitSha: "main-old",
            githubBranch: "tiller/env/my-env",
            githubHeadCommitSha: "draft-head",
            githubPublishStatus: "published",
          })),
        }),
        HUB: createHubBinding(),
        BUCKET: {
          delete: vi.fn().mockResolvedValue(undefined),
          list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        },
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      currentMainCommit: "main-new",
    });
    expect(envWorkspace.deleteWorkspaceFiles).toHaveBeenCalledWith(["/src/app.ts"]);
    expect(envWorkspace.deleteWorkspaceFile).toHaveBeenCalledWith("/.tiller/github-deleted-paths.json");
    expect(lifecycleStub.recordStopWorkspaceSynced).toHaveBeenCalledWith(
      expect.objectContaining({
        githubBaseBranch: "trunk",
        githubBaseCommitSha: "main-new",
        githubHeadCommitSha: null,
        githubPrNumber: null,
        githubPublishStatus: "idle",
        githubLastPublishedAt: null,
        githubLastPublishedWorkspaceHash: null,
      }),
      { clearError: true },
    );
  });
});

describe("Your machine Stop ambiguity", () => {
  it("cancels and cleans active reviewers before stopping the implementor", async () => {
    const stopOpId = "stop-op-1";
    const runningMeta = buildStoredEnvRecord({
      slug: "my-env",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "host-1" },
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
    });
    const savingMeta = buildStoredEnvRecord({
      ...runningMeta,
      status: "saving",
      lifecyclePhase: "saving",
      lifecycleOpId: stopOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleRuntimeReady: false,
    });
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(runningMeta);
    lifecycleStub.requestStop.mockResolvedValue({
      phase: "saving",
      activeOpId: stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-08-12T00:00:00.000Z",
    });
    lifecycleStub.persistOwnedProjection.mockResolvedValue(savingMeta);
    const runningReview = {
      runId: "review-1",
      envSlug: "my-env",
      status: "running",
      runtime: { jobSlug: "env-review-review-1" },
    };
    const cancelledReview = { ...runningReview, status: "cancelled" };
    const review = {
      listWorkloadStateForPredeploy: vi.fn()
        .mockResolvedValueOnce([{
          runId: runningReview.runId,
          status: runningReview.status,
          hasRuntime: true,
        }])
        .mockResolvedValueOnce([]),
      getRun: vi.fn()
        .mockResolvedValueOnce(runningReview)
        .mockResolvedValueOnce(cancelledReview),
      cancelRun: vi.fn().mockResolvedValue(cancelledReview),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    const requestLocalRunner = vi.fn().mockImplementation(async (
      _machineId: string | null,
      action: string,
      _slug: string,
      options?: Record<string, unknown>,
    ) => ({
      machineId: "host-1",
      result: action === "status"
        ? { status: "running" }
        : {
            status: "stopping",
            callbackExpected: true,
            commandGeneration: options?.commandGeneration,
            operationId: options?.operationId,
            desiredState: options?.desiredState,
          },
    }));
    const hostService = {
      machineId: "host-1",
      displayName: "host-1",
      connectedAt: "2026-08-12T00:00:00.000Z",
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      dockerAvailable: true,
      runnerAvailable: true,
      claudeSubscription: true,
      transport: "session",
    };
    const env = {
      HUB: createHubBinding({
        activeHostService: hostService,
        hostServicesByMachineId: { "host-1": hostService },
        isHostRoutable: true,
        executionPlacement: { backend: "host", machineId: "host-1" },
        requestLocalRunner,
      }),
    } as any;

    const result = await stopEnvAction({
      env,
      executionCtx: createExecutionCtx() as any,
      slug: "my-env",
      lifecycleStub: lifecycleStub as any,
      cachedMeta: runningMeta as any,
    });

    expect(result).toMatchObject({ status: 200, operationId: stopOpId });
    expect(review.cancelRun).toHaveBeenCalledWith(
      runningReview.runId,
      "Reviewer run cancelled because the environment was stopped.",
    );
    expect(mocks.cleanupEnvReviewRunRuntime).toHaveBeenCalledWith(
      env,
      review,
      cancelledReview,
    );
    expect(lifecycleStub.requestStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "ordinary", intent: undefined },
    { label: "Scheduled Run", intent: "scheduled" as const },
  ])("rebases a rejected $label Stop once and retries only runner dispatch", async ({ intent }) => {
    const stopOpId = "stop-op-rebase";
    let stopAttempts = 0;
    const requestLocalRunner = vi.fn().mockImplementation(async (
      _machineId: string | null,
      action: string,
      _slug: string,
      options?: Record<string, unknown>,
    ) => {
      if (action === "status") {
        return { machineId: "host-1", result: { status: "running" } };
      }
      if (action === "stop") {
        stopAttempts += 1;
        if (stopAttempts === 1) {
          throw Object.assign(
            new Error("Runner command generation 1 was superseded by 60."),
            {
              code: "runner_command_superseded_before_mutation",
              currentCommandGeneration: 60,
            },
          );
        }
        return {
          machineId: "host-1",
          result: {
            status: "stopping",
            callbackExpected: true,
            commandGeneration: options?.commandGeneration,
            operationId: options?.operationId,
            desiredState: options?.desiredState,
          },
        };
      }
      throw new Error(`Unexpected runner action: ${action}`);
    });
    const lifecycleStub = createLifecycleStub();
    const runningMeta = buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "host-1" },
      harness: "codex",
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
    });
    const savingMeta = buildStoredEnvRecord({
      ...runningMeta,
      status: "saving",
      lifecyclePhase: "saving",
      lifecycleOpId: stopOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleRuntimeReady: false,
    });
    await lifecycleStub.initializeMutableStateFromMeta(runningMeta);
    const savingLifecycle = {
      phase: "saving",
      activeOpId: stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-08-03T00:00:00.000Z",
    } as const;
    lifecycleStub.requestStop.mockResolvedValue(savingLifecycle);
    if (intent === "scheduled") {
      lifecycleStub.getScheduledRun.mockResolvedValue({
        kind: "active",
        incarnationId: "incarnation-my-env",
        startOpId: "start-op-1",
        requestedOutcome: null,
      });
      lifecycleStub.requestScheduledRunOutcome.mockResolvedValue({
        status: "accepted",
        outcome: "interrupted",
        lifecycle: savingLifecycle,
        preparationInFlight: false,
      });
    }
    lifecycleStub.persistOwnedProjection.mockResolvedValue(savingMeta);
    const executionCtx = createExecutionCtx();

    await stopEnvAction({
      env: {
        HUB: createHubBinding({ isHostRoutable: true, requestLocalRunner }),
      } as any,
      executionCtx: executionCtx as any,
      slug: "my-env",
      ...(intent ? { intent } : {}),
      lifecycleStub: lifecycleStub as any,
      cachedMeta: runningMeta as any,
    });
    await executionCtx.waitUntil.mock.calls[0][0];

    expect(lifecycleStub.rebaseRejectedRunnerCommand).toHaveBeenCalledWith({
      rejectedCommand: {
        commandGeneration: 1,
        operationId: stopOpId,
        desiredState: "stopped",
      },
      currentCommandGeneration: 60,
    });
    expect(requestLocalRunner.mock.calls.filter((call) => call[1] === "stop"))
      .toEqual([
        ["host-1", "stop", "my-env", {
          commandGeneration: 1,
          operationId: stopOpId,
          desiredState: "stopped",
        }],
        ["host-1", "stop", "my-env", {
          commandGeneration: 61,
          operationId: stopOpId,
          desiredState: "stopped",
        }],
      ]);
    expect(lifecycleStub.noteStopDispatchFailed).not.toHaveBeenCalled();
  });

  it("waits for exact Scheduled Run preparation before cleanup or Stop dispatch", async () => {
    const lifecycleStub = createLifecycleStub();
    const scheduledLifecycle = {
      phase: "saving",
      activeOpId: "stop-op-1",
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "unknown",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    lifecycleStub.getScheduledRun.mockResolvedValue({
      kind: "active",
      incarnationId: "incarnation-1",
      startOpId: "start-op-1",
    });
    lifecycleStub.requestScheduledRunOutcome.mockResolvedValue({
      status: "accepted",
      outcome: "interrupted",
      lifecycle: scheduledLifecycle,
      preparationInFlight: true,
    });
    const startingMeta = buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "host-1" },
      harness: "codex",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "starting",
      lifecyclePhase: "starting",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
    });

    const result = await stopEnvAction({
      env: { HUB: createHubBinding() } as any,
      executionCtx: createExecutionCtx() as any,
      slug: "my-env",
      intent: "scheduled",
      expectedStartOpId: "start-op-1",
      lifecycleStub: lifecycleStub as any,
      cachedMeta: startingMeta as any,
    });

    expect(result).toMatchObject({
      status: 200,
      body: { ok: true, slug: "my-env", status: "stopping" },
      scheduledRunTransitionApplied: true,
    });
    expect(lifecycleStub.requestScheduledRunOutcome).toHaveBeenCalledWith({
      opId: "start-op-1",
      outcome: "interrupted",
    });
    expect(lifecycleStub.requestStop).not.toHaveBeenCalled();
    expect(lifecycleStub.persistOwnedProjection).toHaveBeenCalled();
    expect(lifecycleStub.recordScheduledRunCredentialsCleaned).not.toHaveBeenCalled();
  });

  it("makes ordinary Stop join an already requested Completed finalization", async () => {
    const lifecycleStub = createLifecycleStub();
    const lifecycle = {
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
      updatedAt: "2026-07-10T00:00:00.000Z",
    };
    lifecycleStub.getScheduledRun.mockResolvedValue({
      kind: "active",
      incarnationId: "incarnation-1",
      startOpId: "start-op-1",
      requestedOutcome: "completed",
    });
    lifecycleStub.requestScheduledRunOutcome.mockResolvedValue({
      status: "idempotent",
      outcome: "completed",
      lifecycle,
      preparationInFlight: true,
    });

    const result = await stopEnvAction({
      env: {} as any,
      executionCtx: createExecutionCtx() as any,
      slug: "my-env",
      lifecycleStub: lifecycleStub as any,
      cachedMeta: buildStoredEnvRecord({ slug: "my-env", status: "saving" }) as any,
    });

    expect(result.status).toBe(200);
    expect(lifecycleStub.requestScheduledRunOutcome).toHaveBeenCalledWith({
      outcome: "completed",
    });
  });

  it("keeps the exact Stop operation active when the host response times out", async () => {
    const stopOpId = "stop-op-ambiguous";
    const requestLocalRunner = vi.fn().mockImplementation(async (
      _machineId: string | null,
      action: string,
    ) => {
      if (action === "status") {
        return { machineId: "host-1", result: { status: "running" } };
      }
      if (action === "stop") {
        throw new Error("Timed out waiting for the execution machine.");
      }
      throw new Error(`Unexpected runner action: ${action}`);
    });
    const lifecycleStub = createLifecycleStub();
    const runningMeta = buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "host-1" },
      harness: "codex",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
    });
    const savingMeta = buildStoredEnvRecord({
      ...runningMeta,
      status: "saving",
      lifecyclePhase: "saving",
      lifecycleOpId: stopOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleRuntimeReady: false,
    });
    await lifecycleStub.initializeMutableStateFromMeta(runningMeta);
    lifecycleStub.requestStop.mockResolvedValue({
      phase: "saving",
      activeOpId: stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2024-01-01T00:00:01.000Z",
    });
    lifecycleStub.persistOwnedProjection.mockResolvedValue(savingMeta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      HUB: createHubBinding({
        isHostRoutable: true,
        requestLocalRunner,
      }),
    } as any;
    const executionCtx = createExecutionCtx();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await stopEnvAction({
        env,
        executionCtx: executionCtx as any,
        slug: "my-env",
        lifecycleStub: lifecycleStub as any,
        cachedMeta: runningMeta as any,
      });

      expect(result).toMatchObject({
        status: 200,
        operationId: stopOpId,
        body: { ok: true, slug: "my-env", status: "saving" },
      });
      expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
      await executionCtx.waitUntil.mock.calls[0][0];
      expect(lifecycleStub.requestStop).toHaveBeenCalledTimes(1);
      expect(lifecycleStub.claimRunnerCommand).toHaveBeenCalledWith(stopOpId, "stopped");
      expect(requestLocalRunner).toHaveBeenCalledWith(
        "host-1",
        "stop",
        "my-env",
        {
          commandGeneration: 1,
          operationId: stopOpId,
          desiredState: "stopped",
        },
      );
      expect(lifecycleStub.noteStopDispatchFailed).toHaveBeenCalledWith(
        stopOpId,
        expect.stringMatching(/^Tiller couldn’t complete the runtime operation\. Reference ID: TLR-/),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("replays an already-saving exact Stop when Your machine reports the runner stopped", async () => {
    const stopOpId = "stop-op-replay";
    const requestLocalRunner = vi.fn().mockImplementation(async (
      _machineId: string | null,
      action: string,
    ) => {
      if (action === "status") {
        return { machineId: "host-1", result: { status: "stopped" } };
      }
      if (action === "stop") {
        return {
          machineId: "host-1",
          result: {
            status: "stopped",
            callbackExpected: false,
            commandGeneration: 1,
            operationId: stopOpId,
            desiredState: "stopped",
          },
        };
      }
      throw new Error(`Unexpected runner action: ${action}`);
    });
    const lifecycleStub = createLifecycleStub();
    const savingMeta = buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "host-1" },
      harness: "codex",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:01.000Z",
      status: "saving",
      lifecyclePhase: "saving",
      lifecycleOpId: stopOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleInfraState: "stopped",
      lifecycleRuntimeReady: false,
    });
    const savingLifecycle = {
      phase: "saving",
      activeOpId: stopOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "stopped",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "stopped",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2024-01-01T00:00:01.000Z",
    } as const;
    await lifecycleStub.initializeMutableStateFromMeta(savingMeta);
    lifecycleStub.requestStop.mockResolvedValue(savingLifecycle);
    lifecycleStub.getState.mockResolvedValue(savingLifecycle);
    lifecycleStub.getOwnedEnvView.mockResolvedValue(savingMeta);
    lifecycleStub.persistOwnedProjection.mockResolvedValue(savingMeta);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const executionCtx = createExecutionCtx();

    const result = await stopEnvAction({
      env: {
        HUB: createHubBinding({ isHostRoutable: true, requestLocalRunner }),
      } as any,
      executionCtx: executionCtx as any,
      slug: "my-env",
      lifecycleStub: lifecycleStub as any,
      cachedMeta: savingMeta as any,
    });

    expect(result).toMatchObject({ status: 200, operationId: stopOpId });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0][0];
    expect(lifecycleStub.requestStop).not.toHaveBeenCalled();
    expect(lifecycleStub.claimRunnerCommand).toHaveBeenCalledWith(stopOpId, "stopped");
    expect(requestLocalRunner).toHaveBeenCalledWith(
      "host-1",
      "stop",
      "my-env",
      { commandGeneration: 1, operationId: stopOpId, desiredState: "stopped" },
    );
    expect(lifecycleStub.noteFencedRunnerAbsentBeforeScheduledStart)
      .toHaveBeenCalledWith(stopOpId, false);
    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith(stopOpId, "exit");
  });
});

describe("host backend offline handling", () => {
  it("blocks Start, Stop, and Delete while initial creation ownership is pending", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.isInitialCreationPending.mockResolvedValue(true);
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          backend: "cf",
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "stopped",
        }),
      }),
      HUB: createHubBinding(),
    } as any;
    const app = createTestApp();

    const responses = await Promise.all([
      app.request("/api/envs/my-env/start", { method: "POST" }, env),
      app.request("/api/envs/my-env/stop", { method: "POST" }, env),
      app.request("/api/envs/my-env", { method: "DELETE" }, env),
      app.request("/api/envs/my-env/scheduled-run/cancel", { method: "POST" }, env),
    ]);

    expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 404]);
    for (const response of responses.slice(0, 3)) {
      await expect(response.json()).resolves.toMatchObject({ code: "environment_creation_in_progress" });
    }
    await expect(responses[3]!.json()).resolves.toMatchObject({ error: "Not found" });
    expect(lifecycleStub.beginStart).not.toHaveBeenCalled();
    expect(lifecycleStub.requestStop).not.toHaveBeenCalled();
    expect(lifecycleStub.setStatus).not.toHaveBeenCalled();

  });

  it.each([
    ["behind", `docker.io/jamieatlason/tiller-sandbox:${"a".repeat(40)}`, "a".repeat(40)],
    ["unknown", undefined, undefined],
    ["custom", "registry.example.com/custom/tiller-sandbox:latest", undefined],
  ])("rejects %s runtimes before lifecycle mutation on Create and Start", async (_runtimeStatus, runtimeImage, runtimeSource) => {
    const expectedSource = "b".repeat(40);
    (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__ = {
      schemaVersion: 1,
      channel: "development",
      hubVersion: "0.2.54",
    };
    (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__ = {
      imageSourceId: expectedSource,
      sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${expectedSource}`,
    };
    try {
      const lifecycleStub = createLifecycleStub();
      await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
        slug: "my-env",
        incarnationId: "incarnation-1",
        repoUrl: "https://github.com/test/repo",
        scmModel: "github",
        backend: "host",
        executionPlacement: { backend: "host", machineId: "host-1" },
        harness: "claude-code",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        status: "stopped",
      }));
      mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
      const hostService = {
        machineId: "host-1",
        displayName: "host-1",
        connectedAt: "2026-04-11T18:00:00.000Z",
        runnerCommandProtocol: 1,
        codexRuntimeAuthProtocol: 1,
        dockerAvailable: true,
        runnerAvailable: true,
        claudeSubscription: true,
        localRunnerImage: runtimeImage,
        localRunnerImageSourceId: runtimeSource,
        transport: "session",
      };
      const kv = createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          incarnationId: "incarnation-1",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          scmModel: "github",
          backend: "host",
          executionPlacement: { backend: "host", machineId: "host-1" },
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "stopped",
        }),
      });
      const env = {
        ENVS_KV: kv,
        HUB: createHubBinding({
          activeHostService: hostService,
          hostServicesByMachineId: { "host-1": hostService },
          isHostRoutable: true,
          executionPlacement: { backend: "host", machineId: "host-1" },
          executionAvailable: false,
        }),
      } as any;
      const app = createTestApp();

      const createResponse = await app.request("http://localhost/api/envs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoId: "repo-1", harness: "claude-code" }),
      }, env);
      const startResponse = await app.request(
        "http://localhost/api/envs/my-env/start",
        { method: "POST" },
        env,
      );

      expect(createResponse.status).toBe(409);
      await expect(createResponse.json()).resolves.toMatchObject({
        error: "The selected execution backend is unavailable. Choose another backend in Settings.",
      });
      expect(startResponse.status).toBe(409);
      await expect(startResponse.json()).resolves.toMatchObject({
        error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
      });
      expect(lifecycleStub.initializeAndBeginStart).not.toHaveBeenCalled();
      expect(lifecycleStub.beginStart).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__;
      delete (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__;
    }
  });

  it("rejects env creation requests that omit harness", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "harness is required and must be 'claude-code', 'codex', or 'opencode'",
    });
  });

  it("rejects removed environment authentication preferences", async () => {
    const app = createTestApp();
    const res = await app.request(
      "https://hub.example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          harness: "codex",
          codexAuthPreference: "subscription",
        }),
      },
      {
        ENVS_KV: createKvStore({}),
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("auth preferences are no longer accepted"),
    });
  });

  it("rejects creating a workload when the selected machine is disconnected", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          harness: "claude-code",
        }),
      },
      {
        HUB: createHubBinding({
          executionPlacement: { backend: "host", machineId: "host-1" },
        }),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "The selected execution backend is unavailable. Choose another backend in Settings.",
    });
    expect(mocks.getScheduledRunCapacityStub).not.toHaveBeenCalled();
  });

  it("rejects creation when the selected machine is registered but not live-routable", async () => {
    const app = createTestApp();
    const res = await app.request(
      "/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          harness: "claude-code",
        }),
      },
      {
        HUB: createHubBinding({
          activeHostService: {
            machineId: "raspberrypi",
            displayName: "raspberrypi",
            connectedAt: "2026-04-11T18:00:00.000Z",
            runnerCommandProtocol: 1,
            codexRuntimeAuthProtocol: 1,
            dockerAvailable: true,
            runnerAvailable: true,
            claudeSubscription: true,
            transport: "session",
          },
          isHostRoutable: false,
          executionPlacement: { backend: "host", machineId: "raspberrypi" },
        }),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "The selected execution backend is unavailable. Choose another backend in Settings.",
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
            backend: "host",
            executionPlacement: { backend: "host", machineId: "my-env" },
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
      error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    });
  });

  it("rejects starting a host env when its assigned host is offline, even if another host is registered", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta(buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "host-1" },
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "stopped",
    }));
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/start",
      { method: "POST" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            backend: "host",
            executionPlacement: { backend: "host", machineId: "host-1" },
            harness: "claude-code",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "stopped",
          }),
        }),
        HUB: createHubBinding({
          activeHostService: {
            machineId: "host-2",
            displayName: "host-2",
            connectedAt: "2026-04-11T18:00:00.000Z",
            runnerCommandProtocol: 1,
            codexRuntimeAuthProtocol: 1,
            dockerAvailable: true,
            runnerAvailable: true,
            claudeSubscription: true,
            transport: "session",
          },
          hostServicesByMachineId: {
            "host-1": {
              machineId: "host-1",
              displayName: "host-1",
              connectedAt: "2026-04-10T18:00:00.000Z",
              runnerCommandProtocol: 1,
              codexRuntimeAuthProtocol: 1,
              dockerAvailable: true,
              runnerAvailable: true,
              claudeSubscription: true,
              transport: "session",
            },
            "host-2": {
              machineId: "host-2",
              displayName: "host-2",
              connectedAt: "2026-04-11T18:00:00.000Z",
              runnerCommandProtocol: 1,
              codexRuntimeAuthProtocol: 1,
              dockerAvailable: true,
              runnerAvailable: true,
              claudeSubscription: true,
              transport: "session",
            },
          },
          isHostRoutable: (preferredMachineId) => preferredMachineId == null ? true : preferredMachineId === "host-2",
        }),
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    });
  });

  it("keeps an exact retrying Stop when the assigned host session is disconnected", async () => {
    const lifecycleStub = createLifecycleStub();
    const runningMeta = buildStoredEnvRecord({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "my-env" },
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "running",
    });
    await lifecycleStub.initializeMutableStateFromMeta(runningMeta);
    lifecycleStub.requestStop.mockResolvedValue({
      phase: "saving",
      activeOpId: "stop-op-offline",
      activeOperation: "stop",
      desiredState: "stopped",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      infraState: "ready",
      runtimeReady: false,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2024-01-01T00:00:01.000Z",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const app = createTestApp();
    const res = await app.request(
      "/api/envs/my-env/stop",
      { method: "POST" },
      {
        ENVS_KV: createKvStore({
          "my-env": JSON.stringify({
            slug: "my-env",
            repoUrl: "https://github.com/test/repo",
            backend: "host",
            executionPlacement: { backend: "host", machineId: "my-env" },
            harness: "claude-code",
            createdAt: "2024-01-01T00:00:00.000Z",
            updatedAt: "2024-01-01T00:00:00.000Z",
            status: "running",
          }),
        }),
        HUB: createHubBinding(),
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      slug: "my-env",
      status: "saving",
    });
    expect(lifecycleStub.requestStop).toHaveBeenCalledTimes(1);
    expect(lifecycleStub.noteStopDispatchFailed).toHaveBeenCalledWith(
      "stop-op-offline",
      expect.stringMatching(/^Tiller couldn’t complete the runtime operation\. Reference ID: TLR-/),
    );
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
            backend: "host",
            executionPlacement: { backend: "host", machineId: "my-env" },
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
      error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    });
    expect(mocks.getScheduledRunCapacityStub).not.toHaveBeenCalled();
  });
});

describe("POST /api/envs/:slug/harness-failed", () => {
  it("fails a start in progress when the lead harness crashes", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "my-env" },
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "starting",
      lifecyclePhase: "starting",
      lifecycleDesiredState: "running",
      ...createInitialEnvScmState({ slug: "my-env" }),
    });
    const reportStartupFailure = vi.fn().mockResolvedValue({
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
    lifecycleStub.reportStartupFailure = reportStartupFailure;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const put = vi.fn().mockResolvedValue(undefined);
    const kv = createKvStore({}, put);
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
    expect(reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      message: expect.stringMatching(/^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/),
      runnerMayExist: true,
      leadHarnessFailure: true,
    });
  });

  it("replaces the generic startup-exit error when the harness failure arrives late", async () => {
    const lifecycleStub = createLifecycleStub();
    await lifecycleStub.initializeMutableStateFromMeta({
      slug: "my-env",
      repoUrl: "https://github.com/test/repo",
      repoId: "repo-1",
      backend: "host",
      executionPlacement: { backend: "host", machineId: "my-env" },
      harness: "claude-code",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "failed",
      lifecyclePhase: "failed",
      lifecycleDesiredState: "running",
      error: "Container exited before the environment finished starting.",
      ...createInitialEnvScmState({ slug: "my-env" }),
    });
    const reportStartupFailure = vi.fn().mockResolvedValue({
      phase: "failed",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "unknown",
      lastWorkspaceSyncedAckOpId: null,
      lastError: "tiller-harness exited with code 1",
      lastErrorAt: "2026-04-12T00:00:00.000Z",
      updatedAt: "2026-04-12T00:00:00.000Z",
    });
    lifecycleStub.reportStartupFailure = reportStartupFailure;
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);

    const kv = createKvStore({
      "my-env": JSON.stringify({
        slug: "my-env",
        repoUrl: "https://github.com/test/repo",
        backend: "host",
        executionPlacement: { backend: "host", machineId: "my-env" },
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
      status: "failed",
      leadHarnessStatus: "failed",
    });
    expect(reportStartupFailure).toHaveBeenCalledWith({
      opId: "start-op-1",
      message: expect.stringMatching(/^Tiller couldn’t start the environment runtime\. Retry Start\. Reference ID: TLR-/),
      runnerMayExist: true,
      leadHarnessFailure: true,
    });
  });

  it("rejects missing and stale harness-failure operation ids", async () => {
    const lifecycleStub = createLifecycleStub();
    lifecycleStub.reportStartupFailure = vi.fn().mockResolvedValue({
      phase: "running",
      activeOpId: "new-start-op",
      activeOperation: "start",
      desiredState: "running",
      lastRunnerState: "running",
      lastWorkspaceSyncedAckOpId: null,
      lastError: null,
      lastErrorAt: null,
      updatedAt: "2026-04-12T00:00:00.000Z",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const env = {
      ENVS_KV: createKvStore({
        "my-env": JSON.stringify({
          slug: "my-env",
          repoUrl: "https://github.com/test/repo",
          backend: "host",
          executionPlacement: { backend: "host", machineId: "my-env" },
          harness: "claude-code",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          status: "running",
        }),
      }),
      HUB: createHubBinding(),
    };
    const app = createTestApp();

    const missing = await app.request("/api/envs/my-env/harness-failed", {
      method: "POST",
      body: "old crash",
    }, env as any);
    expect(missing.status).toBe(400);
    expect(lifecycleStub.reportStartupFailure).not.toHaveBeenCalled();

    const stale = await app.request("/api/envs/my-env/harness-failed", {
      method: "POST",
      headers: { "X-Tiller-Lifecycle-Op-Id": "old-start-op" },
      body: "old crash",
    }, env as any);
    expect(stale.status).toBe(409);
  });
});
