import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSecret,
  isLocalDevRequest,
  resolveProtectionState,
  resolveCodexModelRoute,
  resolveCodexContainerAuth,
} = vi.hoisted(() => ({
  getSecret: vi.fn(async () => undefined),
  isLocalDevRequest: vi.fn(() => false),
  resolveProtectionState: vi.fn(async () => ({ protectionMode: "public" })),
  resolveCodexModelRoute: vi.fn(async () => ({
    kind: "unavailable",
    reason: "gateway offline",
    codexRouteStatus: "gateway_offline",
  })),
  resolveCodexContainerAuth: vi.fn(async () => ({
    authPreference: "api-key",
    resolvedAuthMode: "api-key",
    modelRoute: "api-fallback",
    envVars: {
      OPENAI_API_KEY: "openai-key",
    },
  })),
}));

vi.mock("../api/setup/config", () => ({
  getSecret,
}));

vi.mock("../api/protection", () => ({
  isLocalDevRequest,
  resolveProtectionState,
}));

vi.mock("../api/model-route", () => ({
  resolveCodexModelRoute,
}));

vi.mock("../api/env/hub-url", () => ({
  resolveContainerHubUrl: vi.fn(async () => "https://hub.example.com"),
  buildEnvWorkspaceApiBaseUrl: vi.fn((_hubUrl: string, slug: string) => `https://hub.example.com/api/workspace/${slug}`),
  buildRepoGitArtifactUrl: vi.fn((_hubUrl: string, repoId: string, artifactId: string) =>
    `https://hub.example.com/api/repos/${repoId}/git-artifacts/${artifactId}`),
  buildEnvScmOperationResultUrl: vi.fn(),
  buildEnvScmOperationHeartbeatUrl: vi.fn(),
  buildEnvScmOperationFailedUrl: vi.fn(),
  buildEnvScmConflictResolutionUrl: vi.fn(),
  buildRepoGitArtifactStagingUrl: vi.fn(),
}));

vi.mock("../api/env/container-auth", () => ({
  resolveContainerAuth: vi.fn(async () => ({
    authMode: "auto",
    resolvedAuthMode: "api",
    envVars: {
      ANTHROPIC_API_KEY: "anthropic-key",
    },
  })),
  resolveCodexContainerAuth,
  resolveOpenCodeContainerAuth: vi.fn(),
}));

const {
  STARTUP_PLAN_IMPLEMENTATION_PREAMBLE,
  buildContainerLaunchConfig,
  buildGitOperationEnvVars,
  buildStartupPlanDocument,
  materializeStartupPlan,
} = await import("../api/env/launch-config");

describe("buildContainerLaunchConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSecret.mockResolvedValue(undefined);
    isLocalDevRequest.mockReturnValue(false);
    resolveProtectionState.mockResolvedValue({ protectionMode: "public" });
  });

  it("emits REPO_SLUG as the only runtime slug env var", async () => {
    const launchConfig = await buildContainerLaunchConfig(
      {} as any,
      "https://hub.example.com/api/envs",
      "demo-env",
      "https://github.com/example/repo",
      {
        repoId: "repo-1",
        gitArtifactId: "artifact-1",
      },
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        createdAt: "2026-04-13T00:00:00.000Z",
      },
    );

    expect(launchConfig.envVars).toMatchObject({
      REPO_SLUG: "demo-env",
      RUNNER_BACKEND: "cf",
      TILLER_HARNESS: "claude-code",
      NODE_OPTIONS: "--dns-result-order=ipv4first",
    });
    expect(launchConfig.envVars.NODE_OPTIONS).not.toContain("no-network-family-autoselection");
    expect(Object.keys(launchConfig.envVars)).not.toContain("ENV_SLUG");
    expect(Object.keys(launchConfig.envVars)).not.toContain("TILLER_HARNESS_VERSION");
  });

  it("does not resolve subscription routes for explicit Codex API key preference", async () => {
    const launchConfig = await buildContainerLaunchConfig(
      {} as any,
      "https://hub.example.com/api/envs",
      "demo-env",
      "https://github.com/example/repo",
      null,
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        backend: "cf",
        harness: "codex",
        codexAuthPreference: "api-key",
        createdAt: "2026-04-13T00:00:00.000Z",
      },
    );

    expect(resolveCodexModelRoute).not.toHaveBeenCalled();
    expect(resolveCodexContainerAuth).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      authPreference: "api-key",
      gatewayRoute: undefined,
      gatewaySessionToken: null,
    }));
    expect(launchConfig.envVars).toMatchObject({
      TILLER_CODEX_AUTH_PREFERENCE: "api-key",
      TILLER_CODEX_AUTH_MODE: "api-key",
      TILLER_CODEX_MODEL_ROUTE: "api-fallback",
      OPENAI_API_KEY: "openai-key",
    });
  });

  it("passes HUB_URL with GitHub bridge vars to SCM jobs", async () => {
    resolveProtectionState.mockResolvedValue({ protectionMode: "cf-access" });
    const put = vi.fn().mockResolvedValue(undefined);
    const envVars = await buildGitOperationEnvVars(
      {
        ENVS_KV: { put },
      } as any,
      "https://hub.example.com/api/envs/demo-env/scm",
      {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/Example/Repo.git",
          githubInstallationId: 98765,
          githubFullName: "example/repo",
          gitArtifactId: "artifact-1",
        },
      } as any,
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        branchName: "demo-env",
        createdAt: "2026-04-13T00:00:00.000Z",
        status: "running",
      } as any,
      {
        operationId: "operation-12345678",
        operationType: "update-from-main",
      },
    );

    expect(envVars).toMatchObject({
      TILLER_BOOTSTRAP_MODE: "scm-operation",
      HUB_URL: "https://hub.example.com",
      TILLER_GITHUB_BRIDGE_ID: expect.any(String),
      TILLER_GITHUB_BRIDGE_SECRET: expect.any(String),
      TILLER_GITHUB_ALLOWED_REPO: "example/repo",
    });
    expect(put).toHaveBeenCalledWith(
      expect.stringMatching(/^github-bridge:/),
      expect.stringContaining("\"type\":\"scm-operation\""),
      expect.objectContaining({ expirationTtl: expect.any(Number) }),
    );
  });
});

describe("startup plan materialization", () => {
  it("writes selected plans with the implementation preamble before the plan body", async () => {
    const planBody = "## Steps\n\n- Update the launch config.";
    const writeWorkspaceFile = vi.fn();
    const clearWorkspacePlanFile = vi.fn();
    const selectedPlan = {
      id: "plan-1",
      repoId: "repo-1",
      type: "plan",
      title: "Update launch config",
      body: { markdown: planBody },
      basis: {
        repoId: "repo-1",
        mainCommit: "main-1",
      },
      createdAt: "2026-05-27T00:00:00.000Z",
    };

    const result = await materializeStartupPlan(
      { meta: { repoId: "repo-1", mainCommit: "main-1" } },
      {
        getArtifact: vi.fn(async () => selectedPlan),
        listLatestTodoPlansForMain: vi.fn(),
      } as any,
      {
        writeWorkspaceFile,
        clearWorkspacePlanFile,
      } as any,
      {} as any,
      "main-1",
      { mode: "specific", artifactId: "plan-1" },
    );

    expect(result).toBe("plan-1");
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "/.tiller/plan.md",
      buildStartupPlanDocument(planBody),
    );
    expect(writeWorkspaceFile.mock.calls[0][1]).toContain(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE);
    expect(
      writeWorkspaceFile.mock.calls[0][1].indexOf(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE),
    ).toBeLessThan(writeWorkspaceFile.mock.calls[0][1].indexOf(planBody));
    expect(clearWorkspacePlanFile).not.toHaveBeenCalled();
  });
});
