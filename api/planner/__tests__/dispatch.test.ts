import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";
import {
  ArtifactStoreDO,
  asAsyncStub,
  createExecutionCtx,
  createStore,
  createThread,
} from "./test-harness";

const mocks = vi.hoisted(() => ({
  loadTrackedRepoForRequest: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getThreadStub: vi.fn(),
  getOpenAIStatus: vi.fn(),
  getSecret: vi.fn(),
  getOrCreateSecret: vi.fn(),
  getIdleTimeoutMinutes: vi.fn(),
  getBillingSelections: vi.fn(),
  resolveContainerHubUrl: vi.fn(),
  resolveCodexContainerAuth: vi.fn(),
  resolveContainerAuth: vi.fn(),
  resolveOpenCodeContainerAuth: vi.fn(),
  classifyHostRuntimeCompatibility: vi.fn(),
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
  resolveProtectionState: vi.fn(),
  requestLocalRunner: vi.fn(),
  getPlannerRunStub: vi.fn(),
  startPlannerJob: vi.fn(),
  destroyPlannerJob: vi.fn(),
  destroyPlanWriterRuntime: vi.fn(),
  revokePlanWriterTerminal: vi.fn(),
  broadcastPlanWriterState: vi.fn(),
  ensurePlanWriterRuntime: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../../repo/access", () => ({
  loadTrackedRepoForRequest: mocks.loadTrackedRepoForRequest,
}));

vi.mock("../../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getThreadStub: mocks.getThreadStub,
  getPlannerRunStub: mocks.getPlannerRunStub,
}));

vi.mock("../../openai-auth", () => ({
  getStatus: mocks.getOpenAIStatus,
  getReadOnlyStatus: mocks.getOpenAIStatus,
}));

vi.mock("../../setup/config", () => ({
  getSecret: mocks.getSecret,
  getOrCreateSecret: mocks.getOrCreateSecret,
  getIdleTimeoutMinutes: mocks.getIdleTimeoutMinutes,
  getBillingSelections: mocks.getBillingSelections,
}));

vi.mock("../../env/hub-url", () => ({
  resolveContainerHubUrl: mocks.resolveContainerHubUrl,
}));

vi.mock("../../env/container-auth", () => ({
  resolveCodexContainerAuth: mocks.resolveCodexContainerAuth,
  resolveContainerAuth: mocks.resolveContainerAuth,
  resolveOpenCodeContainerAuth: mocks.resolveOpenCodeContainerAuth,
}));

vi.mock("../../setup/runtime-compatibility", () => ({
  classifyHostRuntimeCompatibility: mocks.classifyHostRuntimeCompatibility,
}));

vi.mock("../../service-registry", () => ({
  readRegisteredHostService: mocks.readRegisteredHostService,
  readRoutableHostService: mocks.readRoutableHostService,
}));

vi.mock("../../protection", () => ({
  resolveProtectionState: mocks.resolveProtectionState,
}));

const [
  { default: plannerRoutes },
  {
    buildProviderAuthEnvVars,
    cleanupPlanRuntimeTarget,
    cleanupPlannerRunRuntime,
    dispatchPlannerRun,
    ensurePlanWriterRuntime,
    plannerJobSlug,
    resolvePlannerExecution,
    runnerJobCommand,
  },
] = await Promise.all([
  import("../routes"),
  import("../dispatch"),
]);
const { listPlannerProviders } = await import("../providers");
const { planWriterTerminalId } = await import("../runtime-identity");

function createEnv(
  overrides: Record<string, unknown> = {},
  placement:
    | { backend: "cf"; machineId: null }
    | { backend: "host"; machineId: string }
    | undefined = undefined,
) {
  const resolvedPlacement = placement ?? (
    overrides.LOCAL_DEV_ONLY_BACKEND === "1"
      ? { backend: "host" as const, machineId: "machine-1" }
      : { backend: "cf" as const, machineId: null }
  );
  return {
    TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "1",
    OPENAI_API_KEY: "test-openai-key",
    CLAUDE_CODE_OAUTH_TOKEN: "test-claude-token",
    ENVS_KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
    },
    HUB: {
      idFromName: () => "hub-id",
      get: () => ({
        requestLocalRunner: mocks.requestLocalRunner,
        revokePlanWriterTerminal: mocks.revokePlanWriterTerminal,
        broadcastPlanWriterState: mocks.broadcastPlanWriterState,
        resolveNewExecutionPlacement: vi.fn().mockResolvedValue(resolvedPlacement),
        getExecutionStatus: vi.fn().mockResolvedValue(
          resolvedPlacement.backend === "cf"
            ? {
                selected: { target: "cf" },
                selectedHost: null,
                candidate: { state: "not_connected" },
                executionReady: true,
              }
            : {
                selected: { target: "host", machineId: resolvedPlacement.machineId },
                selectedHost: {
                  state: "ready",
                  machineId: resolvedPlacement.machineId,
                  displayName: "Test machine",
                },
                candidate: {
                  state: "ready",
                  machineId: resolvedPlacement.machineId,
                  displayName: "Test machine",
                },
                executionReady: true,
              },
        ),
      }),
    },
    ...overrides,
  };
}

describe("planner dispatch", () => {
  let artifactStore: InstanceType<typeof ArtifactStoreDO>;

  beforeEach(() => {
    artifactStore = createStore();
    vi.resetAllMocks();
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: true, status: "missing" });
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.getOrCreateSecret.mockResolvedValue("test-runtime-secret");
    mocks.getIdleTimeoutMinutes.mockResolvedValue(15);
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: "subscription",
      openaiBillingMode: "api",
    });
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getThreadStub.mockImplementation(() => asAsyncStub(createThread()));
    mocks.resolveContainerHubUrl.mockResolvedValue("http://hub.test");
    mocks.classifyHostRuntimeCompatibility.mockReturnValue({ compatible: true });
    mocks.resolveCodexContainerAuth.mockResolvedValue({
      resolvedAuthMode: "api-key",
      envVars: { OPENAI_API_KEY: "test-openai-key" },
    });
    mocks.resolveContainerAuth.mockResolvedValue({
      authMode: "subscription",
      resolvedAuthMode: "subscription",
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: "test-claude-token" },
    });
    mocks.resolveOpenCodeContainerAuth.mockResolvedValue({
      model: "@cf/moonshotai/kimi-k2.7-code",
      baseUrl: null,
      token: "test-opencode-token",
    });
    mocks.resolveProtectionState.mockResolvedValue({ protectionMode: "none" });
    mocks.readRegisteredHostService.mockResolvedValue(null);
    mocks.readRoutableHostService.mockResolvedValue(null);
    mocks.requestLocalRunner.mockImplementation(async (machineId, _action, _slug, options) => ({
      machineId: machineId ?? "machine-1",
      result: options ?? {},
    }));
    mocks.startPlannerJob.mockResolvedValue(undefined);
    mocks.destroyPlannerJob.mockResolvedValue(undefined);
    mocks.destroyPlanWriterRuntime.mockResolvedValue(undefined);
    mocks.ensurePlanWriterRuntime.mockResolvedValue({ jobSlug: "writer", created: true });
    mocks.getPlannerRunStub.mockReturnValue({
      startPlannerJob: mocks.startPlannerJob,
      destroyPlannerJob: mocks.destroyPlannerJob,
      destroyPlanWriterRuntime: mocks.destroyPlanWriterRuntime,
      ensurePlanWriterRuntime: mocks.ensurePlanWriterRuntime,
    });
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          githubFullName: "test/repo",
          githubDefaultBranchHeadSha: "main-1",
          mainCommit: "main-1",
          gitArtifactId: null,
          gitStatus: "ready",
          gitError: null,
        },
        workspace: {},
      },
    });
  });

  it("routes Cloudflare Review without a duplicate compiled image capability", async () => {
    await expect(resolvePlannerExecution(createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: "key",
    }) as any, "codex")).resolves.toMatchObject({
      kind: "dispatched",
      backend: "cf",
      machineId: null,
    });
  });

  function createPlan() {
    return artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Plan" },
      status: "draft",
      createdBy: "test",
    });
  }

  function claudeLaunch(backend: "cf" | "host", mode: "subscription" | "api") {
    return {
      schemaVersion: 1,
      backend,
      machineId: backend === "host" ? "machine-1" : null,
      claudeAuthMode: mode,
    } as const;
  }

  function codexApiLaunch(backend: "cf" | "host") {
    return {
      schemaVersion: 1,
      backend,
      machineId: backend === "host" ? "machine-1" : null,
      codexExecution: {
        kind: "api-key-direct-cli",
        surface: "plan-reviewer",
        backend,
      },
    } as const;
  }

  function codexWriterApiLaunch(backend: "cf" | "host") {
    return {
      schemaVersion: 1,
      backend,
      machineId: backend === "host" ? "machine-1" : null,
      codexExecution: {
        kind: "api-key-app-server",
        surface: "plan-writer",
        backend,
      },
    } as const;
  }

  it("uses the full sanitized run id for job slugs", () => {
    expect(plannerJobSlug("AbC-123_xyz")).toBe("planner-abc-123-xyz");
    const a = plannerJobSlug("11111111-2222-3333-4444-555555555555");
    const b = plannerJobSlug("99999999-8888-7777-6666-555555555555");
    expect(a).not.toBe(b);
  });

  it("connects Plan Writer terminals to the canonical Hub namespace", async () => {
    const plan = createPlan();
    const writer = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "sonnet",
      basisCommit: "main-1",
      startBodyDigest: "a".repeat(64),
      launchProvenance: claudeLaunch("host", "subscription"),
    });

    await ensurePlanWriterRuntime({
      env: createEnv({
        LOCAL_DEV_ONLY_BACKEND: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "test-token",
      }) as any,
      requestUrl: "https://hub.example.com",
      artifactStore: asAsyncStub(artifactStore) as any,
      writer,
      repo: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        githubFullName: "test/repo",
        githubBaseCommitSha: "main-1",
      },
    });

    expect(mocks.requestLocalRunner).toHaveBeenCalledWith(
      "machine-1",
      "create",
      expect.stringMatching(/^plan-writer-/),
      expect.objectContaining({
        envVars: expect.objectContaining({
          HUB_URL: "http://hub.test",
          NAMESPACE: "hub",
          TILLER_PLAN_WRITER_IDLE_MS: "0",
        }),
      }),
    );
    expect(mocks.getIdleTimeoutMinutes).not.toHaveBeenCalled();
  });

  it("uses the configured Cloudflare timeout for new Plan Writers", async () => {
    mocks.getIdleTimeoutMinutes.mockResolvedValueOnce(42);
    const plan = createPlan();
    const writer = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "sonnet",
      basisCommit: "main-1",
      startBodyDigest: "a".repeat(64),
      launchProvenance: claudeLaunch("cf", "api"),
    });

    await ensurePlanWriterRuntime({
      env: createEnv({
        PLANNER_RUN: {},
        ANTHROPIC_API_KEY: "test-key",
      }) as any,
      requestUrl: "https://hub.example.com",
      artifactStore: asAsyncStub(artifactStore) as any,
      writer,
      repo: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        githubFullName: "test/repo",
        githubBaseCommitSha: "main-1",
      },
    });

    expect(mocks.getIdleTimeoutMinutes).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledWith(
      expect.stringMatching(/^plan-writer-/),
      expect.objectContaining({ TILLER_PLAN_WRITER_IDLE_MS: String(42 * 60_000) }),
    );
  });

  it("retains exact Plan Writer provenance when launch cleanup fails", async () => {
    const plan = createPlan();
    const writer = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "sonnet",
      basisCommit: "main-1",
      startBodyDigest: "a".repeat(64),
      launchProvenance: claudeLaunch("host", "subscription"),
    });
    mocks.requestLocalRunner.mockImplementation(async (_machineId, action) => {
      if (action === "create") throw new Error("create failed with test-claude-token");
      if (action === "destroy") throw new Error("docker unavailable");
      return { machineId: "machine-1", result: {} };
    });

    await expect(ensurePlanWriterRuntime({
      env: createEnv({
        LOCAL_DEV_ONLY_BACKEND: "1",
        CLAUDE_CODE_OAUTH_TOKEN: "test-token",
      }) as any,
      requestUrl: "https://hub.example.com",
      artifactStore: asAsyncStub(artifactStore) as any,
      writer,
      repo: {
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        githubFullName: "test/repo",
        githubBaseCommitSha: "main-1",
      },
    })).rejects.toThrow(/create failed with \[redacted\].*cleanup failed.*docker unavailable/i);

    expect(artifactStore.getPlanWriter("repo-1", plan.id)).toMatchObject({
      runtime: expect.objectContaining({ jobSlug: expect.stringMatching(/^plan-writer-/), generation: 1 }),
      cleanupError: "docker unavailable",
    });
  });

  it("routes every new CLI workload only to the selected compatible placement", async () => {
    const hostPlacement = { backend: "host" as const, machineId: "pi-1" };

    expect(await resolvePlannerExecution(
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }, hostPlacement) as any,
      "codex",
    )).toMatchObject({ kind: "dispatched", backend: "host", machineId: "pi-1" });

    // Cloudflare selection without the container binding is unavailable.
    expect(await resolvePlannerExecution(createEnv() as any, "codex"))
      .toMatchObject({ kind: "unavailable" });

    mocks.readRoutableHostService.mockResolvedValue({
      machineId: "pi-1",
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      reviewerIsolationProtocol: 1,
    });
    expect(await resolvePlannerExecution(createEnv({}, hostPlacement) as any, "codex"))
      .toMatchObject({ kind: "dispatched", backend: "host", machineId: "pi-1" });

    expect(await resolvePlannerExecution(createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "key" }) as any, "codex"))
      .toMatchObject({
        kind: "dispatched",
        backend: "cf",
        machineId: null,
        codexExecutionProfile: {
          kind: "api-key-direct-cli",
        },
      });

    // A selected machine that is unavailable never falls back to Cloudflare.
    mocks.readRoutableHostService.mockResolvedValue(null);
    expect(await resolvePlannerExecution(
      createEnv({ PLANNER_RUN: {} }, hostPlacement) as any,
      "codex",
    )).toMatchObject({
      kind: "unavailable",
      reason: "The selected execution backend is unavailable. Choose another backend in Settings.",
    });

    // The fake provider is always in-process.
    expect(await resolvePlannerExecution(createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any, "fake"))
      .toEqual({ kind: "in-process" });
  });

  it("resolves production providers only to credential-compatible permitted targets", async () => {
    expect(await resolvePlannerExecution(createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: undefined,
    }) as any, "codex")).toMatchObject({
      kind: "unavailable",
      reason: expect.stringContaining("OPENAI_API_KEY"),
    });

    expect(await resolvePlannerExecution(createEnv({
      PLANNER_RUN: {},
      CLAUDE_CODE_OAUTH_TOKEN: "subscription-only",
    }) as any, "claude-code")).toMatchObject({
      kind: "dispatched",
      backend: "cf",
    });

    mocks.readRoutableHostService.mockResolvedValue({
      machineId: "pi-1",
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      reviewerIsolationProtocol: 1,
    });
    const hostPlacement = { backend: "host" as const, machineId: "pi-1" };
    expect(await resolvePlannerExecution(createEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      PLANNER_RUN: {},
    }, hostPlacement) as any, "claude-code"))
      .toMatchObject({ kind: "dispatched", backend: "host", machineId: "pi-1" });

    mocks.readRoutableHostService.mockResolvedValue(null);
    expect(await resolvePlannerExecution(createEnv({
      CLAUDE_CODE_OAUTH_TOKEN: "subscription",
      PLANNER_RUN: {},
    }, hostPlacement) as any, "claude-code")).toMatchObject({
      kind: "unavailable",
      reason: "The selected execution backend is unavailable. Choose another backend in Settings.",
    });
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: "api",
      openaiBillingMode: "api",
    });
    expect(await resolvePlannerExecution(createEnv({
      ANTHROPIC_API_KEY: "api-key",
      PLANNER_RUN: {},
    }) as any, "claude-code")).toMatchObject({ kind: "dispatched", backend: "cf" });

    expect(await resolvePlannerExecution(createEnv({ PLANNER_RUN: {}, AI: {} }) as any, "opencode"))
      .toMatchObject({ kind: "dispatched", backend: "cf" });
  });

  it("keeps Codex placement and the selected authentication route consistent", async () => {
    const cloudflare = await resolvePlannerExecution(createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: "api-key",
    }) as any, "codex");
    expect(cloudflare).toMatchObject({
      kind: "dispatched",
      backend: "cf",
      codexExecutionProfile: {
        kind: "api-key-direct-cli",
      },
    });

    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: false });
    mocks.readRoutableHostService.mockResolvedValue({
      machineId: "pi-1",
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
      reviewerIsolationProtocol: 1,
    });
    const host = await resolvePlannerExecution(createEnv({
      OPENAI_API_KEY: "api-key",
      PLANNER_RUN: {},
    }, { backend: "host", machineId: "pi-1" }) as any, "codex");
    expect(host).toMatchObject({
      kind: "dispatched",
      backend: "host",
      machineId: "pi-1",
      codexExecutionProfile: {
        kind: "api-key-direct-cli",
        backend: "host",
      },
    });
  });

  it("rejects an incompatible host before reserving reviewer work", async () => {
    mocks.readRoutableHostService.mockResolvedValue({
      machineId: "pi-1",
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
    });

    await expect(resolvePlannerExecution(createEnv({
      PLANNER_RUN: {},
    }, { backend: "host", machineId: "pi-1" }) as any, "codex")).resolves.toMatchObject({
      kind: "unavailable",
      reason: expect.stringMatching(/tiller host update.*recreate or restart/i),
    });
  });

  it("uses only the frozen API-key profile while building Cloudflare Codex auth", async () => {
    await buildProviderAuthEnvVars(
      createEnv({ OPENAI_API_KEY: "api-key" }) as any,
      {
        provider: "codex",
        model: "gpt-5.5",
      },
      {
        backend: "cf",
        machineId: null,
        codexExecutionProfile: {
          kind: "api-key-direct-cli",
          surface: "plan-reviewer",
          backend: "cf",
        },
      },
      "https://hub.example.com",
    );

    expect(mocks.resolveCodexContainerAuth).toHaveBeenCalledWith(
      expect.anything(),
      { authPreference: "api-key" },
    );
  });

  it("builds planner OpenCode auth from the catalog Kimi K2.7 selection", async () => {
    const envVars = await buildProviderAuthEnvVars(
      createEnv() as any,
      {
        provider: "opencode",
        model: "@cf/moonshotai/kimi-k2.7-code",
      },
      { backend: "cf", machineId: null },
      "https://hub.example.com",
    );

    expect(mocks.resolveOpenCodeContainerAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "kimi-k2.7-code", harness: "opencode" }),
    );
    expect(envVars).toEqual({
      TILLER_OPENCODE_BASE_URL: "https://hub.example.com/api/opencode/v1",
      TILLER_OPENCODE_AUTH_TOKEN: "test-opencode-token",
      TILLER_OPENCODE_MODEL_ID: "@cf/moonshotai/kimi-k2.7-code",
      TILLER_OPENCODE_MODEL_ALIAS: "tiller-kimi-k2-7-code",
      TILLER_OPENCODE_MODEL_LABEL: "Kimi K2.7 Code",
      TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "262144",
      TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "262144",
      TILLER_OPENCODE_PROVIDER_KIND: "cloudflare-workers-ai",
      TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-hub",
      TILLER_OPENCODE_PROVIDER_LABEL: "Tiller Hub",
    });
  });

  it("reads global billing when evaluating OpenCode API writer routes", async () => {
    mocks.getBillingSelections.mockClear();

    const catalog = await listPlannerProviders(
      createEnv({ PLANNER_RUN: {} }) as any,
      { onlyProviderId: "opencode" },
    );

    expect(catalog.providers.map((provider) => provider.id)).toEqual(["opencode"]);
    expect(mocks.getBillingSelections).toHaveBeenCalledOnce();
  });

  it("inspects provider availability without resolving a new workload placement", async () => {
    const env = createEnv({ PLANNER_RUN: {}, AI: {} }) as any;
    const resolveNewExecutionPlacement = vi.fn().mockResolvedValue({
      backend: "cf",
      machineId: null,
    });
    const getExecutionStatus = vi.fn().mockResolvedValue({
      selected: { target: "cf" },
      selectedHost: null,
      candidate: { state: "not_connected" },
      executionReady: true,
    });
    env.HUB.get = () => ({
      requestLocalRunner: mocks.requestLocalRunner,
      resolveNewExecutionPlacement,
      getExecutionStatus,
    });

    await listPlannerProviders(env, { onlyProviderId: "opencode" });

    expect(getExecutionStatus).toHaveBeenCalledOnce();
    expect(resolveNewExecutionPlacement).not.toHaveBeenCalled();

    await resolvePlannerExecution(env, "opencode");
    expect(resolveNewExecutionPlacement).toHaveBeenCalledOnce();
  });

  it("requires pinned planner billing provenance and preserves incompatibility reasons", async () => {
    mocks.getBillingSelections.mockClear();
    await expect(buildProviderAuthEnvVars(
      createEnv() as any,
      { provider: "claude-code", model: "sonnet" },
      { backend: "cf", machineId: null },
      "https://hub.example.com",
    )).rejects.toThrow("Planner launch billing provenance is missing");
    expect(mocks.getBillingSelections).not.toHaveBeenCalled();

    await expect(buildProviderAuthEnvVars(
      createEnv() as any,
      { provider: "claude-code", model: "claude-fable-5" },
      { backend: "cf", machineId: null, claudeAuthMode: "subscription" },
      "https://hub.example.com",
    )).rejects.toMatchObject({
      name: "BillingResolutionError",
      reason: "incompatible-billing-mode",
    });
  });

  it("resolves every catalog-owned OpenCode writer model", async () => {
    const env = await buildProviderAuthEnvVars(
      createEnv() as any,
      {
        provider: "opencode",
        model: "gpt-5.5",
      },
      { backend: "cf", machineId: null },
      "https://hub.example.com",
    );
    expect(mocks.resolveOpenCodeContainerAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "gpt-5.5", harness: "opencode" }),
    );
    expect(env).toMatchObject({
      TILLER_OPENCODE_MODEL_LABEL: "GPT-5.5",
      TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: "1050000",
      TILLER_OPENCODE_MODEL_INPUT_LIMIT: "922000",
      TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: "128000",
      TILLER_OPENCODE_PROVIDER_KIND: "openai",
    });
  });

  it("dispatches and destroys hosted runs through the PlannerRunDO container", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      input: { githubBaseCommitSha: "main-1" },
      launchProvenance: codexApiLaunch("cf"),
    });

    await dispatchPlannerRun({
      env: createEnv({ PLANNER_RUN: {} }) as any,
      requestUrl: "http://hub.test/x",
      artifactStore: asAsyncStub(artifactStore) as any,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });

    expect(mocks.requestLocalRunner).not.toHaveBeenCalled();
    expect(mocks.startPlannerJob).toHaveBeenCalledTimes(1);
    expect(mocks.startPlannerJob.mock.calls[0][0]).toMatchObject({
      TILLER_BOOTSTRAP_MODE: "planner-run",
      TILLER_REVIEWER_ISOLATION_PROTOCOL: "1",
      TILLER_HARNESS: "codex",
      RUNNER_BACKEND: "cf",
    });
    expect(mocks.startPlannerJob.mock.calls[0][0]).not.toHaveProperty("TILLER_REVIEWER_ISOLATION_IMAGE");
    const updated = artifactStore.getPlannerRun(run.runId);
    expect(updated?.runtime).toEqual({ jobSlug: plannerJobSlug(run.runId) });

    await cleanupPlannerRunRuntime(
      createEnv({ PLANNER_RUN: {} }) as any,
      asAsyncStub(artifactStore) as any,
      updated!,
    );
    expect(mocks.destroyPlannerJob).toHaveBeenCalledTimes(1);
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toBeUndefined();
  });

  it("retains terminal writer cleanup intent and retries the exact detached runtime", async () => {
    const plan = createPlan();
    const writer = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "a".repeat(64),
      launchProvenance: codexWriterApiLaunch("cf"),
    });
    artifactStore.setPlanWriterRuntimeIfCurrent(writer.threadId, {
      jobSlug: planWriterTerminalId("repo-1", plan.id, writer.generation!),
      generation: writer.generation!,
    });
    const completed = artifactStore.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "completed",
    });
    const target = completed.cleanupTargets.find((candidate) => candidate.kind === "writer");
    expect(target).toBeTruthy();
    mocks.destroyPlanWriterRuntime
      .mockRejectedValueOnce(new Error("temporary cleanup failure"))
      .mockResolvedValueOnce(undefined);

    await expect(cleanupPlanRuntimeTarget(
      createEnv({ PLANNER_RUN: {} }) as any,
      artifactStore as any,
      target!,
    )).rejects.toThrow("temporary cleanup failure");
    expect(artifactStore.getPlanWriter("repo-1", plan.id)).toMatchObject({
      stoppedAt: expect.any(String),
    });
    expect(artifactStore.getPlanWriter("repo-1", plan.id)?.runtime).toBeUndefined();
    expect(artifactStore.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual([target]);
    expect(mocks.broadcastPlanWriterState).toHaveBeenCalledWith("repo-1", plan.id);

    await cleanupPlanRuntimeTarget(
      createEnv({ PLANNER_RUN: {} }) as any,
      artifactStore as any,
      target!,
    );
    expect(artifactStore.getPlanWriter("repo-1", plan.id)?.runtime).toBeUndefined();
    expect(artifactStore.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual([]);
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(2);
  });

  it("executes and acknowledges an immutable writer cleanup target after plan deletion", async () => {
    const plan = createPlan();
    const writer = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "a".repeat(64),
      launchProvenance: codexWriterApiLaunch("cf"),
    });
    artifactStore.setPlanWriterRuntimeIfCurrent(writer.threadId, {
      jobSlug: planWriterTerminalId("repo-1", plan.id, writer.generation!),
      generation: writer.generation!,
    });
    const discarded = artifactStore.discardPlan({
      repoId: "repo-1",
      id: plan.id,
      expectedVersion: plan.version,
    });
    const target = discarded.cleanupTargets.find((candidate) => candidate.kind === "writer");
    expect(target).toBeTruthy();
    mocks.destroyPlanWriterRuntime
      .mockRejectedValueOnce(new Error("backend offline"))
      .mockResolvedValueOnce(undefined);

    await expect(cleanupPlanRuntimeTarget(
      createEnv({ PLANNER_RUN: {} }) as any,
      asAsyncStub(artifactStore) as any,
      target!,
    )).rejects.toThrow("backend offline");
    expect(artifactStore.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual([target]);

    await cleanupPlanRuntimeTarget(
      createEnv({ PLANNER_RUN: {} }) as any,
      asAsyncStub(artifactStore) as any,
      target!,
    );

    expect(mocks.revokePlanWriterTerminal).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^plan-writer-.+-${writer.generation}$`)),
      "repo-1",
      plan.id,
      writer.generation,
    );
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenLastCalledWith(
      planWriterTerminalId("repo-1", plan.id, writer.generation!),
    );
    expect(artifactStore.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual([]);
  });

  it("dispatches a queued run with the pinned GitHub base and planner env contract", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      input: { githubBaseCommitSha: "main-1" },
      launchProvenance: codexApiLaunch("host"),
    });

    await dispatchPlannerRun({
      env: createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      requestUrl: "http://hub.test/api/repos/repo-1/plans/x/reviewers/thread/messages",
      artifactStore: asAsyncStub(artifactStore) as any,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });

    expect(mocks.requestLocalRunner).toHaveBeenCalledTimes(1);
    const [machineId, action, slug, options] = mocks.requestLocalRunner.mock.calls[0];
    expect(machineId).toBe("machine-1");
    expect(action).toBe("create");
    expect(slug).toBe(plannerJobSlug(run.runId));
    expect(options).toMatchObject(runnerJobCommand(slug, "running"));
    expect(options.repoUrl).toBe("https://github.com/test/repo");
    expect(options.envVars).toMatchObject({
      TILLER_BOOTSTRAP_MODE: "planner-run",
      TILLER_HARNESS: "codex",
      RUNNER_BACKEND: "host",
      OPENAI_API_KEY: "test-openai-key",
    });
    expect(options.envVars.TILLER_PLANNER_CALLBACK_BASE).toBe(
      `http://hub.test/api/planner-runtime/repos/repo-1/runs/${run.runId}`,
    );
    expect(options.envVars.TILLER_GITHUB_BASE_COMMIT_SHA).toBe("main-1");
    expect(options.envVars.TILLER_GITHUB_BRIDGE_ID).toBeTruthy();
    expect(options.envVars.TILLER_GITHUB_BRIDGE_SECRET).toBeTruthy();
    expect(options.envVars.TILLER_PLANNER_RUN_TOKEN).toBeTruthy();

    const updated = artifactStore.getPlannerRun(run.runId);
    expect(updated?.status).toBe("queued");
    expect(updated?.runtime).toEqual({ jobSlug: plannerJobSlug(run.runId) });
  });

  it("does not create a runner when cancellation wins during dispatch preparation", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: codexApiLaunch("host"),
    });
    let releaseAuth!: (value: {
      resolvedAuthMode: "api-key";
      envVars: { OPENAI_API_KEY: string };
    }) => void;
    mocks.resolveCodexContainerAuth.mockReturnValueOnce(new Promise((resolve) => {
      releaseAuth = resolve;
    }));

    const dispatch = dispatchPlannerRun({
      env: createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      requestUrl: "http://hub.test/x",
      artifactStore: asAsyncStub(artifactStore) as any,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });
    await vi.waitFor(() => expect(mocks.resolveCodexContainerAuth).toHaveBeenCalled());
    artifactStore.updatePlannerRun({
      runId: run.runId,
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    releaseAuth({
      resolvedAuthMode: "api-key",
      envVars: { OPENAI_API_KEY: "test-openai-key" },
    });
    await dispatch;

    expect(mocks.requestLocalRunner.mock.calls.map((call) => call[1])).toEqual(["destroy"]);
    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({ status: "cancelled" });
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toBeUndefined();
  });

  it("destroys a hosted runner again when cancellation lands during start", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      input: { githubBaseCommitSha: "main-1" },
      launchProvenance: codexApiLaunch("cf"),
    });
    let releaseStart!: () => void;
    mocks.startPlannerJob.mockReturnValueOnce(new Promise<void>((resolve) => {
      releaseStart = resolve;
    }));
    const env = createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "key" }) as any;

    const dispatch = dispatchPlannerRun({
      env,
      requestUrl: "http://hub.test/x",
      artifactStore: asAsyncStub(artifactStore) as any,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });
    await vi.waitFor(() => expect(mocks.startPlannerJob).toHaveBeenCalledTimes(1));
    const cancelled = artifactStore.cancelActivePlannerRun(run.runId);
    await cleanupPlannerRunRuntime(env, asAsyncStub(artifactStore) as any, cancelled);
    expect(mocks.destroyPlannerJob).toHaveBeenCalledTimes(1);

    releaseStart();
    await dispatch;
    expect(mocks.destroyPlannerJob).toHaveBeenCalledTimes(2);
    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({ status: "cancelled" });
  });

  it("cleans up fully when dispatch fails — the run is never left queued", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: codexApiLaunch("host"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requestLocalRunner
      .mockRejectedValueOnce(new Error("runner echoed test-openai-key"))
      .mockResolvedValue({ machineId: "machine-1", result: {} });

    await dispatchPlannerRun({
      env: createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      requestUrl: "http://hub.test/x",
      artifactStore: asAsyncStub(artifactStore) as any,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });

    const failed = artifactStore.getPlannerRun(run.runId);
    expect(failed).toMatchObject({ status: "failed", error: "runner echoed [redacted]" });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("test-openai-key");
    consoleError.mockRestore();
    const types = artifactStore.listPlannerRunEvents(run.runId).map((event) => event.type);
    expect(types).toContain("run_failed");
    // Partial-job destroy was attempted.
    const actions = mocks.requestLocalRunner.mock.calls.map((call) => call[1]);
    expect(actions).toContain("destroy");
    expect(mocks.requestLocalRunner.mock.calls[0][3]).toMatchObject(
      runnerJobCommand(plannerJobSlug(run.runId), "running"),
    );
    expect(mocks.requestLocalRunner.mock.calls[1][3]).toMatchObject(
      runnerJobCommand(plannerJobSlug(run.runId), "absent"),
    );
    expect(mocks.startPlannerJob).not.toHaveBeenCalled();
  });

  it("preserves a runtime when dispatch failure races with a result claimed for saving", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: codexApiLaunch("host"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requestLocalRunner.mockRejectedValueOnce(new Error("ambiguous runner response"));
    const asyncStore = asAsyncStub(artifactStore) as any;
    const racingStore = new Proxy(asyncStore, {
      get(target, property, receiver) {
        if (property === "finishActiveReviewerRun") {
          return async (input: Parameters<typeof artifactStore.finishActiveReviewerRun>[0]) => {
            expect(artifactStore.claimPlannerRunSaving(run.runId)).toMatchObject({ status: "saving" });
            return artifactStore.finishActiveReviewerRun(input);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await dispatchPlannerRun({
      env: createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      requestUrl: "http://hub.test/x",
      artifactStore: racingStore,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });

    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({
      status: "saving",
      runtime: { jobSlug: plannerJobSlug(run.runId) },
    });
    expect(mocks.requestLocalRunner.mock.calls.map((call) => call[1])).toEqual(["create"]);
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([]);
    consoleError.mockRestore();
  });

  it("preserves a runtime when dispatch failure cannot read concurrent saving state", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: codexApiLaunch("host"),
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.requestLocalRunner.mockRejectedValueOnce(new Error("ambiguous runner response"));
    const asyncStore = asAsyncStub(artifactStore) as any;
    const racingStore = new Proxy(asyncStore, {
      get(target, property, receiver) {
        if (property === "finishActiveReviewerRun") {
          return async () => {
            expect(artifactStore.claimPlannerRunSaving(run.runId)).toMatchObject({ status: "saving" });
            throw new Error("ArtifactStore response unavailable");
          };
        }
        if (property === "getPlannerRun") {
          return async () => {
            throw new Error("ArtifactStore read unavailable");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    await dispatchPlannerRun({
      env: createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      requestUrl: "http://hub.test/x",
      artifactStore: racingStore,
      run,
      repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
    });

    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({
      status: "saving",
      runtime: { jobSlug: plannerJobSlug(run.runId) },
    });
    expect(mocks.requestLocalRunner.mock.calls.map((call) => call[1])).toEqual(["create"]);
    consoleError.mockRestore();
  });

  it.each(["queued", "running"] as const)(
    "preserves an active %s runtime after ambiguous failure finalization",
    async (status) => {
      const plan = createPlan();
      const run = artifactStore.createPlannerRun({
        repoId: "repo-1",
        planArtifactId: plan.id,
        role: "reviewer",
        provider: "codex",
        model: "gpt-5.5",
        launchProvenance: codexApiLaunch("host"),
      });
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.requestLocalRunner.mockRejectedValueOnce(new Error("ambiguous runner response"));
      const asyncStore = asAsyncStub(artifactStore) as any;
      const racingStore = new Proxy(asyncStore, {
        get(target, property, receiver) {
          if (property === "finishActiveReviewerRun") {
            return async () => {
              if (status === "running") {
                artifactStore.updateActivePlannerRun({ runId: run.runId, status: "running" });
              }
              throw new Error("ArtifactStore response unavailable");
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });

      await dispatchPlannerRun({
        env: createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
        requestUrl: "http://hub.test/x",
        artifactStore: racingStore,
        run,
        repo: { repoId: "repo-1", repoUrl: "https://github.com/test/repo", githubFullName: "test/repo", githubBaseCommitSha: "main-1" },
      });

      expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({
        status,
        runtime: { jobSlug: plannerJobSlug(run.runId) },
      });
      expect(mocks.requestLocalRunner.mock.calls.map((call) => call[1])).toEqual(["create"]);
      consoleError.mockRestore();
    },
  );

  it("destroys the runner job for terminal runs", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: claudeLaunch("host", "subscription"),
    });
    const withRuntime = artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });

    await cleanupPlannerRunRuntime(
      createEnv() as any,
      asAsyncStub(artifactStore) as any,
      withRuntime,
    );
    expect(mocks.requestLocalRunner).toHaveBeenCalledWith(
      "machine-1",
      "destroy",
      plannerJobSlug(run.runId),
      runnerJobCommand(plannerJobSlug(run.runId), "absent"),
    );
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toBeUndefined();
  });

  it("retains exact runtime provenance when runner cleanup fails", async () => {
    const plan = createPlan();
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: claudeLaunch("cf", "subscription"),
    });
    const withRuntime = artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });
    mocks.destroyPlannerJob.mockRejectedValueOnce(new Error("cleanup unavailable"));

    await expect(cleanupPlannerRunRuntime(
      createEnv({ PLANNER_RUN: {} }) as any,
      asAsyncStub(artifactStore) as any,
      withRuntime,
    )).rejects.toThrow("cleanup unavailable");

    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toEqual(withRuntime.runtime);
  });

  it("refuses to dispatch when the repository has no GitHub base commit", async () => {
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          githubFullName: "test/repo",
          githubDefaultBranchHeadSha: null,
          mainCommit: null,
          gitArtifactId: null,
          gitStatus: "ready",
          gitError: null,
        },
        workspace: {},
      },
    });
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    const app = new Hono<HonoEnv>();
    app.route("/", plannerRoutes);

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${reviewer.threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Review this plan." }),
      },
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      createExecutionCtx() as any,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toMatch(/GitHub metadata/);
    expect(mocks.requestLocalRunner).not.toHaveBeenCalled();
  });

  it("refuses to dispatch when GitHub repo metadata validation failed", async () => {
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          githubFullName: "test/repo",
          githubDefaultBranchHeadSha: "main-1",
          mainCommit: null,
          gitArtifactId: null,
          gitStatus: "repair-required",
          gitError: "Repository contains unsupported metadata at linked: symlinks are not supported",
        },
        workspace: {},
      },
    });
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    const app = new Hono<HonoEnv>();
    app.route("/", plannerRoutes);

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${reviewer.threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Review this plan." }),
      },
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
      createExecutionCtx() as any,
    );
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.error).toMatch(/GitHub metadata/);
    expect(mocks.requestLocalRunner).not.toHaveBeenCalled();
  });

  it("flips codex capabilities to CLI only when a runtime backend is reachable", async () => {
    const app = new Hono<HonoEnv>();
    app.route("/", plannerRoutes);

    const hosted = await app.request("/api/repos/repo-1/planner-providers", {}, createEnv() as any);
    const hostedBody = await hosted.json() as any;
    const hostedCodex = hostedBody.providers.find((p: { id: string }) => p.id === "codex");
    expect(hostedCodex.capabilities).toMatchObject({ reviewer: true, cancellation: true });
    expect(hostedCodex.efforts.map((effort: { id: string }) => effort.id)).toEqual([
      "low", "medium", "high", "xhigh", "max", "ultra",
    ]);
    expect(hostedCodex.defaultEffort).toBe("xhigh");
    expect(hostedCodex.models.find((model: { id: string }) => model.id === "gpt-5.6-sol").efforts
      .map((effort: { id: string }) => effort.id)).toEqual([
        "low", "medium", "high", "xhigh", "max", "ultra",
      ]);
    expect(hostedCodex.models.find((model: { id: string }) => model.id === "gpt-5.5").efforts
      .map((effort: { id: string }) => effort.id)).toEqual(["low", "medium", "high", "xhigh"]);
    expect(hostedBody.skillRoutes.find((route: { modelId: string }) => route.modelId === "gpt-5.6-sol")
      .supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(hostedBody.providers.find((p: { id: string }) => p.id === "claude-code").efforts
      .map((effort: { id: string }) => effort.id)).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(hostedBody.providers.find((p: { id: string }) => p.id === "opencode").efforts
      .map((effort: { id: string }) => effort.id)).toEqual(["low", "medium", "high"]);

    const selfHost = await app.request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
    );
    const selfHostBody = await selfHost.json() as any;
    const selfHostCodex = selfHostBody.providers.find((p: { id: string }) => p.id === "codex");
    expect(selfHostCodex.capabilities).toMatchObject({ reviewer: true, cancellation: true, chatContinuation: true });
  });

  it("adding a reviewer creates a plain durable tab and waits — no run until the user speaks", async () => {
    const plan = createPlan();
    const app = new Hono<HonoEnv>();
    app.route("/", plannerRoutes);
    const executionCtx = createExecutionCtx();

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude-code", model: "sonnet" }),
      },
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" }) as any,
      executionCtx as any,
    );
    expect(res.status).toBe(201);
    const body = await res.json() as any;
    expect(body.reviewer.threadId).toBeTruthy();
    expect(body.run).toBeUndefined();

    // Adding a reviewer persists only the Tiller tab; each future reviewer
    // turn is a one-shot run.
    expect(mocks.requestLocalRunner).not.toHaveBeenCalled();
    expect(artifactStore.getLatestPlannerRun("repo-1", plan.id, "reviewer", body.reviewer.threadId)).toBeNull();
  });

  it("lists claude-code availability per backend auth", async () => {
    const app = new Hono<HonoEnv>();
    app.route("/", plannerRoutes);

    // Self-host runtime + subscription token → available.
    const selfHost = await app.request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1", CLAUDE_CODE_OAUTH_TOKEN: "tok" }) as any,
    );
    const selfHostClaude = ((await selfHost.json()) as any).providers.find((p: { id: string }) => p.id === "claude-code");
    expect(selfHostClaude.available).toBe(true);
    expect(selfHostClaude.models.map((m: { id: string }) => m.id)).toEqual([
      "sonnet",
      "opus",
      "claude-opus-4-8",
      "claude-fable-5",
    ]);

    // Hosted Claude Subscription is available, while Fable is model-disabled.
    const hostedNoKey = await app.request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({ PLANNER_RUN: {}, CLAUDE_CODE_OAUTH_TOKEN: "tok" }) as any,
    );
    const hostedClaude = ((await hostedNoKey.json()) as any).providers.find((p: { id: string }) => p.id === "claude-code");
    expect(hostedClaude.available).toBe(true);
    const hostedFable = hostedClaude.models.find((model: { id: string }) => model.id === "claude-fable-5");
    expect(hostedFable.available).toBe(false);
    expect(hostedFable.disabledReason).toMatch(/Claude API mode/);

    // Switching the global selection makes the Hosted API route available.
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: "api",
      openaiBillingMode: "api",
    });
    const hostedWithKey = await app.request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({ PLANNER_RUN: {}, ANTHROPIC_API_KEY: "key" }) as any,
    );
    const hostedKeyClaude = ((await hostedWithKey.json()) as any).providers.find((p: { id: string }) => p.id === "claude-code");
    expect(hostedKeyClaude.available).toBe(true);
  });

});
