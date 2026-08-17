import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSecret,
  isLocalDevRequest,
  resolveProtectionState,
  resolveCodexContainerAuth,
} = vi.hoisted(() => ({
  getSecret: vi.fn(async () => undefined),
  isLocalDevRequest: vi.fn(() => false),
  resolveProtectionState: vi.fn(async () => ({ protectionMode: "public" })),
  resolveCodexContainerAuth: vi.fn(async () => ({
    resolvedAuthMode: "api-key",
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

vi.mock("../api/env/hub-url", () => ({
  resolveContainerHubUrl: vi.fn(async () => "https://hub.example.com"),
  buildEnvWorkspaceApiBaseUrl: vi.fn((_hubUrl: string, slug: string) => `https://hub.example.com/api/workspace/${slug}`),
}));

vi.mock("../api/env/container-auth", () => ({
  resolveContainerAuth: vi.fn(async () => ({
    resolvedAuthMode: "api",
    envVars: {
      ANTHROPIC_API_KEY: "anthropic-key",
    },
  })),
  resolveCodexContainerAuth,
  resolveOpenCodeContainerAuth: vi.fn(),
}));

const {
  SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE,
  STARTUP_PLAN_IMPLEMENTATION_PREAMBLE,
  buildContainerLaunchConfig,
  buildStartupPlanDocument,
  materializeStartupPlan,
  withStartCausePreamble,
} = await import("../api/env/launch-config");

function createLaunchEnv(repoSessionEnvVars: Record<string, string> = {}) {
  return {
    HUB: {
      idFromName: vi.fn().mockReturnValue("hub-id"),
      get: vi.fn().mockReturnValue({
        resolveRepoSessionEnvVars: vi.fn().mockResolvedValue(repoSessionEnvVars),
      }),
    },
  } as any;
}

describe("buildContainerLaunchConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSecret.mockResolvedValue(undefined);
    isLocalDevRequest.mockReturnValue(false);
    resolveProtectionState.mockResolvedValue({ protectionMode: "public" });
  });

  it("emits REPO_SLUG as the only runtime slug env var", async () => {
    const launchConfig = await buildContainerLaunchConfig(
      createLaunchEnv(),
      "https://hub.example.com/api/envs",
      "demo-env",
      "https://github.com/example/repo",
      {
        repoId: "repo-1",
      },
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
        createdAt: "2026-04-13T00:00:00.000Z",
      },
      { startAuthClaim: { claudeAuthMode: "api", codexAuthPreference: null } },
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
    expect(launchConfig.envVars.TILLER_MANAGED_ENV_NAMES).toContain("REPO_SLUG");
    expect(launchConfig.envVars.TILLER_SESSION_ENV_NAMES).toBe("");
  });

  it("injects repo session env first so Tiller launch vars win collisions", async () => {
    const launchConfig = await buildContainerLaunchConfig(
      createLaunchEnv({
        USER_FLAG: "enabled",
        REPO_URL: "https://github.com/attacker/repo",
        ANTHROPIC_API_KEY: "repo-key",
      }),
      "https://hub.example.com/api/envs",
      "demo-env",
      "https://github.com/example/repo",
      {
        repoId: "repo-1",
      },
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        repoId: "repo-1",
        backend: "cf",
        harness: "claude-code",
        harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
        createdAt: "2026-04-13T00:00:00.000Z",
      },
      { startAuthClaim: { claudeAuthMode: "api", codexAuthPreference: null } },
    );

    expect(launchConfig.envVars.USER_FLAG).toBe("enabled");
    expect(launchConfig.envVars.REPO_URL).toBe("https://github.com/example/repo");
    expect(launchConfig.envVars.ANTHROPIC_API_KEY).toBe("anthropic-key");
    expect(launchConfig.envVars.TILLER_MANAGED_ENV_NAMES).toContain("USER_FLAG");
    expect(launchConfig.envVars.TILLER_SESSION_ENV_NAMES).toBe("USER_FLAG");
  });

  it("does not resolve subscription routes for explicit Codex API key preference", async () => {
    const launchConfig = await buildContainerLaunchConfig(
      { OPENAI_API_KEY: "openai-key" } as any,
      "https://hub.example.com/api/envs",
      "demo-env",
      "https://github.com/example/repo",
      null,
      {
        slug: "demo-env",
        repoUrl: "https://github.com/example/repo",
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
        createdAt: "2026-04-13T00:00:00.000Z",
      },
      { startAuthClaim: { claudeAuthMode: null, codexAuthPreference: "api-key" } },
    );

    expect(resolveCodexContainerAuth).toHaveBeenCalledWith(expect.anything(), {
      authPreference: "api-key",
    });
    expect(launchConfig.envVars).toMatchObject({
      TILLER_CODEX_AUTH_MODE: "api-key",
      OPENAI_API_KEY: "openai-key",
    });
  });

});

describe("startup plan materialization", () => {
  it("uses the concise canonical preamble for ordinary and scheduled runs", () => {
    const plan = "## Steps\n\n- Update the launch config.";
    const document = buildStartupPlanDocument(plan);

    expect(withStartCausePreamble(document, "ordinary")).toBe(document);
    const scheduledDocument = [
      STARTUP_PLAN_IMPLEMENTATION_PREAMBLE,
      SCHEDULED_RUN_IMPLEMENTATION_PREAMBLE,
      plan,
    ].join("\n\n");
    expect(withStartCausePreamble(document, "scheduled")).toBe(scheduledDocument);
    expect(withStartCausePreamble(scheduledDocument, "scheduled")).toBe(scheduledDocument);
  });

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
