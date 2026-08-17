import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolvePlannerExecution: vi.fn(),
  buildProviderAuthEnvVars: vi.fn(),
  buildCfAccessEnvVars: vi.fn(),
  destroyPlannerJob: vi.fn(),
  resolveContainerHubUrl: vi.fn(),
  createGitHubBridgeRecord: vi.fn(),
  bridgeCredentialsToEnvVars: vi.fn(),
  mintEnvReviewRunToken: vi.fn(),
  requestLocalRunner: vi.fn(),
  startPlannerJob: vi.fn(),
}));

vi.mock("../../planner/dispatch", () => ({
  resolvePlannerExecution: mocks.resolvePlannerExecution,
  buildProviderAuthEnvVars: mocks.buildProviderAuthEnvVars,
  buildCfAccessEnvVars: mocks.buildCfAccessEnvVars,
  destroyPlannerJob: mocks.destroyPlannerJob,
  plannerLaunchProvenanceFromExecution: (execution: any) => ({
    schemaVersion: 1,
    backend: execution.backend,
    machineId: execution.backend === "host" ? execution.machineId : null,
    ...(execution.claudeAuthMode ? { claudeAuthMode: execution.claudeAuthMode } : {}),
    ...(execution.codexExecutionProfile ? { codexExecution: execution.codexExecutionProfile } : {}),
  }),
  plannerDispatchTargetFromLaunch: (launch: any) => ({
    backend: launch.backend,
    machineId: launch.backend === "host" ? launch.machineId : null,
    ...(launch.claudeAuthMode ? { claudeAuthMode: launch.claudeAuthMode } : {}),
    ...(launch.codexExecution ? { codexExecutionProfile: launch.codexExecution } : {}),
  }),
  runnerJobCommand: (jobSlug: string, desiredState: "running" | "absent") => {
    const commandGeneration = desiredState === "running" ? 1 : 2;
    return {
      commandGeneration,
      operationId: `runner-job:${jobSlug}:${commandGeneration}:${desiredState}`,
      desiredState,
    };
  },
}));

vi.mock("../../env/hub-url", () => ({
  resolveContainerHubUrl: mocks.resolveContainerHubUrl,
}));

vi.mock("../../github/bridge", () => ({
  createGitHubBridgeRecord: mocks.createGitHubBridgeRecord,
  bridgeCredentialsToEnvVars: mocks.bridgeCredentialsToEnvVars,
}));

vi.mock("../runtime-token", () => ({
  mintEnvReviewRunToken: mocks.mintEnvReviewRunToken,
}));

vi.mock("../../helpers", () => ({
  getPlannerRunStub: vi.fn(() => ({
    startPlannerJob: mocks.startPlannerJob,
  })),
}));

const {
  cleanupEnvReviewRunRuntime,
  dispatchEnvReviewRun,
  envReviewJobSlug,
  resolveEnvReviewDispatchTarget,
  resolveNewEnvReviewLaunchProvenance,
} = await import("../dispatch");

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    HUB: {
      idFromName: () => "hub-id",
      get: () => ({ requestLocalRunner: mocks.requestLocalRunner }),
    },
    ...overrides,
  };
}

function createRun(overrides: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    repoId: "repo-1",
    envSlug: "env-1",
    provider: "codex",
    model: "gpt-5.5",
    startedAt: "2026-06-29T00:00:00.000Z",
    launchProvenance: {
      schemaVersion: 1,
      backend: "host",
      machineId: "machine-1",
      codexExecution: {
        kind: "subscription-app-server",
        surface: "environment-reviewer",
        backend: "host",
      },
    },
    ...overrides,
  };
}

describe("env review dispatch", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolvePlannerExecution.mockResolvedValue({
      kind: "dispatched",
      backend: "host",
      machineId: "machine-1",
      codexExecutionProfile: {
        kind: "subscription-app-server",
        surface: "environment-reviewer",
        backend: "host",
      },
    });
    mocks.resolveContainerHubUrl.mockResolvedValue("http://hub.test");
    mocks.buildProviderAuthEnvVars.mockResolvedValue({ OPENAI_API_KEY: "test-openai-key" });
    mocks.buildCfAccessEnvVars.mockResolvedValue({});
    mocks.destroyPlannerJob.mockResolvedValue(undefined);
    mocks.createGitHubBridgeRecord.mockResolvedValue({
      id: "bridge-id",
      secret: "bridge-secret",
      allowedRepo: "test/repo",
      expiresAt: "2026-06-29T12:00:00.000Z",
    });
    mocks.bridgeCredentialsToEnvVars.mockReturnValue({
      TILLER_GITHUB_BRIDGE_ID: "bridge-id",
      TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
      TILLER_GITHUB_ALLOWED_REPO: "test/repo",
    });
    mocks.mintEnvReviewRunToken.mockResolvedValue("run-token");
    mocks.requestLocalRunner.mockResolvedValue({ machineId: "machine-1", result: {} });
    mocks.startPlannerJob.mockResolvedValue(undefined);
  });

  it("passes HUB_URL with GitHub bridge credentials for host review runs", async () => {
    const launchProvenance = await resolveNewEnvReviewLaunchProvenance(
      createEnv() as any,
      "codex",
    );
    const run = createRun({ launchProvenance });
    const target = await resolveEnvReviewDispatchTarget(createEnv() as any, run as any);

    const runtime = await dispatchEnvReviewRun({
      env: createEnv() as any,
      requestUrl: "http://hub.test/api/envs/env-1/review",
      run: run as any,
      repoUrl: "https://github.com/test/repo",
      githubFullName: "test/repo",
      githubBaseCommitSha: "main-1",
      target,
    });

    expect(runtime).toEqual({ jobSlug: envReviewJobSlug("run-1") });
    expect(target).toMatchObject({
      backend: "host",
      machineId: "machine-1",
      jobSlug: envReviewJobSlug("run-1"),
      codexExecutionProfile: expect.objectContaining({
        kind: "subscription-app-server",
        surface: "environment-reviewer",
      }),
    });
    expect(mocks.resolvePlannerExecution).toHaveBeenCalledWith(
      expect.anything(),
      "codex",
      { codexSurface: "environment-reviewer" },
    );
    expect(mocks.requestLocalRunner).toHaveBeenCalledTimes(1);
    const [machineId, action, slug, options] = mocks.requestLocalRunner.mock.calls[0];
    expect(machineId).toBe("machine-1");
    expect(action).toBe("create");
    expect(slug).toBe(envReviewJobSlug("run-1"));
    expect(options).toMatchObject({
      commandGeneration: 1,
      operationId: `runner-job:${slug}:1:running`,
      desiredState: "running",
    });
    expect(options.repoUrl).toBe("https://github.com/test/repo");
    expect(options.envVars).toMatchObject({
      TILLER_BOOTSTRAP_MODE: "env-review-run",
      TILLER_REVIEWER_ISOLATION_PROTOCOL: "1",
      TILLER_HARNESS: "codex",
      RUNNER_BACKEND: "host",
      HUB_URL: "http://hub.test",
      REPO_URL: "https://github.com/test/repo",
      TILLER_GITHUB_BASE_COMMIT_SHA: "main-1",
      TILLER_GITHUB_BRIDGE_ID: "bridge-id",
      TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
      TILLER_GITHUB_ALLOWED_REPO: "test/repo",
      OPENAI_API_KEY: "test-openai-key",
    });
    expect(options.envVars).not.toHaveProperty("TILLER_REVIEWER_ISOLATION_IMAGE");
    expect(options.envVars.TILLER_ENV_REVIEW_CALLBACK_BASE).toBe(
      "http://hub.test/api/env-review-runtime/envs/env-1/runs/run-1",
    );
    expect(options.envVars.TILLER_ENV_REVIEW_RUN_TOKEN).toBe("run-token");
  });

  it("redacts launch credentials from environment-review dispatch errors", async () => {
    mocks.requestLocalRunner.mockRejectedValueOnce(
      new Error("runner echoed test-openai-key, bridge-secret, and run-token"),
    );
    const run = createRun();
    const target = await resolveEnvReviewDispatchTarget(createEnv() as any, run as any);

    await expect(dispatchEnvReviewRun({
      env: createEnv() as any,
      requestUrl: "http://hub.test/api/envs/env-1/review",
      run: run as any,
      repoUrl: "https://github.com/test/repo",
      githubFullName: "test/repo",
      githubBaseCommitSha: "main-1",
      target,
    })).rejects.toThrow("runner echoed [redacted], [redacted], and [redacted]");

    expect(mocks.destroyPlannerJob).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a residual run has no stored launch provenance", async () => {
    await expect(resolveEnvReviewDispatchTarget(
      createEnv() as any,
      createRun({ launchProvenance: null }) as any,
    )).rejects.toThrow("has no stored execution provenance");
    expect(mocks.resolvePlannerExecution).not.toHaveBeenCalled();
  });

  it("clears provenance only after exact runner cleanup succeeds", async () => {
    const runtime = { jobSlug: envReviewJobSlug("run-1") };
    const run = createRun({ runtime });
    const clearRunRuntimeIfCurrent = vi.fn(async () => ({ ...run, runtime: null }));

    await cleanupEnvReviewRunRuntime(
      createEnv() as any,
      { clearRunRuntimeIfCurrent } as any,
      run as any,
    );

    expect(clearRunRuntimeIfCurrent).toHaveBeenCalledWith("run-1", runtime);
  });

  it("retains provenance when exact runner cleanup fails", async () => {
    const runtime = { jobSlug: envReviewJobSlug("run-1") };
    const run = createRun({ runtime });
    const clearRunRuntimeIfCurrent = vi.fn();
    mocks.destroyPlannerJob.mockRejectedValueOnce(new Error("assigned machine offline"));

    await expect(cleanupEnvReviewRunRuntime(
      createEnv() as any,
      { clearRunRuntimeIfCurrent } as any,
      run as any,
    )).rejects.toThrow("assigned machine offline");

    expect(clearRunRuntimeIfCurrent).not.toHaveBeenCalled();
  });
});
