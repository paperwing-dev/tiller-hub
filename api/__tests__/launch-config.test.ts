import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildContainerLaunchConfig,
} from "../env/launch-config";
import { HARNESS_MODEL_CATALOG } from "../../shared/harness-catalog";
import { installedAccessBindings } from "./access-binding-fixture";

const mocks = vi.hoisted(() => ({
  isGitHubAppAllowedForRequest: vi.fn(),
  createGitHubBridgeRecord: vi.fn(),
  resolveCodexContainerAuth: vi.fn(),
  resolveContainerAuth: vi.fn(),
  resolveOpenCodeContainerAuth: vi.fn(),
}));

vi.mock("../github/app", () => ({
  isGitHubAppAllowedForRequest: mocks.isGitHubAppAllowedForRequest,
}));

vi.mock("../github/bridge", () => ({
  createGitHubBridgeRecord: mocks.createGitHubBridgeRecord,
  bridgeCredentialsToEnvVars: (credentials: { id: string; secret: string; allowedRepo: string }) => ({
    TILLER_GITHUB_BRIDGE_ID: credentials.id,
    TILLER_GITHUB_BRIDGE_SECRET: credentials.secret,
    TILLER_GITHUB_ALLOWED_REPO: credentials.allowedRepo,
  }),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => (
    typeof env[key] === "string" ? env[key] : undefined
  ),
  getOrCreateSecret: vi.fn(async () => "environment-runtime-capability-secret"),
}));

vi.mock("../protection", () => ({
  resolveProtectionState: vi.fn(async () => ({ protectionMode: "none" })),
}));

vi.mock("../openai-auth", () => ({
  getReadOnlyStatus: vi.fn(async () => ({ authenticated: true, status: "connected" })),
}));

vi.mock("../env/container-auth", () => ({
  resolveOpenCodeContainerAuth: mocks.resolveOpenCodeContainerAuth,
  resolveContainerAuth: mocks.resolveContainerAuth,
  resolveCodexContainerAuth: mocks.resolveCodexContainerAuth,
}));

function createEnv(mcpServers: Array<{ id: string; label: string; url: string; enabled: boolean }> = []) {
  const hub = {
    resolveRepoSessionEnvVars: vi.fn(async () => ({})),
    listEnabledRepoMcpServers: vi.fn(async () => mcpServers.filter((server) => server.enabled)),
    getOpenAIAuthStatus: vi.fn(async () => ({ authenticated: true, status: "connected" })),
  };
  return {
    ...installedAccessBindings({
      audience: "audience-1",
      serviceClientId: "client.access",
    }),
    OPENAI_API_KEY: "openai-key",
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => hub),
    },
    ENV_LIFECYCLE: {
      getByName: vi.fn(() => ({
        getCodexExecutionProfile: vi.fn(async () => null),
        claimCodexExecutionProfile: vi.fn(async (_startOpId: string, profile: unknown) => profile),
      })),
    },
  } as any;
}

function createMeta() {
  return {
    backend: "host",
    harness: "opencode",
    harnessSettings: { model: "kimi-k2.7-code", effort: "high" },
    runnerId: "demo-env",
    githubBaseBranch: "main",
    githubBaseCommitSha: "base-sha",
    githubBranch: "tiller/env/demo-env",
  } as any;
}

const repoMeta = {
  repoId: "repo-1",
  githubFullName: "test/repo",
  githubDefaultBranch: "main",
};

function claimedAuth(harness: "claude-code" | "codex" | "opencode", mode: "subscription" | "api") {
  return {
    claudeAuthMode: harness === "claude-code" ? mode : null,
    codexAuthPreference: harness === "codex"
      ? mode === "subscription" ? "subscription" as const : "api-key" as const
      : null,
  };
}

describe("container launch config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createGitHubBridgeRecord.mockResolvedValue({
      id: "bridge-id",
      secret: "bridge-secret",
      allowedRepo: "test/repo",
    });
    mocks.resolveCodexContainerAuth.mockResolvedValue({
      resolvedAuthMode: "api-key",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
    mocks.resolveContainerAuth.mockResolvedValue({
      authMode: "api",
      resolvedAuthMode: "api",
      envVars: { ANTHROPIC_API_KEY: "anthropic-key" },
    });
    mocks.resolveOpenCodeContainerAuth.mockImplementation(async (_env, entry) => ({
      model: entry.binding.model,
      baseUrl: entry.binding.baseUrl,
      token: entry.binding.provider === "openai"
        ? "openai-token"
        : entry.binding.provider === "anthropic" ? "anthropic-token" : "workers-token",
    }));
  });

  it.each([
    ["claude-code", { model: "claude-opus-4.8", effort: "high" }, "subscription"],
    ["codex", { model: "gpt-5.6-sol", effort: "high" }, "api"],
    ["opencode", { model: "kimi-k2.7-code", effort: "high" }, "api"],
  ] as const)("emits only the generic environment capability for %s", async (harness, harnessSettings, mode) => {
    const env = {
      ...createEnv(),
      TILLER_CONTROL_SECRET: "must-not-cross-container-boundary",
    };
    const config = await buildContainerLaunchConfig(
      env,
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        incarnationId: "incarnation-1",
        harness,
        harnessSettings,
      },
      {
        startOpId: "start-op-1",
        startAuthClaim: claimedAuth(harness, mode),
      },
    );

    expect(config.envVars.TILLER_RUNTIME_CAPABILITY).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(config)).not.toContain("must-not-cross-container-boundary");
  });

  it("refuses to re-default an incomplete committed settings handoff", async () => {
    await expect(buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      { ...createMeta(), harnessSettings: null },
    )).rejects.toThrow(/complete committed model and effort pair/);

    await expect(buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        harnessSettings: { model: "claude-opus-4.8", effort: "high" },
      },
    )).rejects.toThrow(/complete committed model and effort pair/);

    expect(mocks.resolveOpenCodeContainerAuth).not.toHaveBeenCalled();
    expect(mocks.resolveCodexContainerAuth).not.toHaveBeenCalled();
    expect(mocks.resolveContainerAuth).not.toHaveBeenCalled();
  });

  it("does not enable GitHub base checkout without bridge credentials", async () => {
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(false);

    const config = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      createMeta(),
    );

    expect(mocks.createGitHubBridgeRecord).not.toHaveBeenCalled();
    expect(config.envVars.TILLER_GITHUB_BASE_COMMIT_SHA).toBeUndefined();
    expect(config.envVars.TILLER_GITHUB_BRIDGE_ID).toBeUndefined();
    expect(config.envVars.TILLER_GITHUB_ALLOWED_REPO).toBeUndefined();
  });

  it("launches only enabled public MCP servers without proxy credentials", async () => {
    const config = await buildContainerLaunchConfig(
      createEnv([
        {
          id: "tiller_docs",
          label: "Documentation",
          url: "https://docs.example.com/mcp",
          enabled: true,
        },
        {
          id: "tiller_disabled",
          label: "Disabled",
          url: "https://disabled.example.com/mcp",
          enabled: false,
        },
      ]),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      createMeta(),
      {
        startCause: "scheduled",
        credentialScope: { incarnationId: "incarnation-1", startOpId: "start-1" },
      },
    );

    expect(JSON.parse(config.envVars.TILLER_MCP_SERVERS_JSON)).toEqual([
      { id: "tiller_docs", url: "https://docs.example.com/mcp" },
    ]);
    expect(config.credentials).toEqual({});
    const serialized = JSON.stringify(config);
    expect(serialized).not.toContain("/api/mcp/cloudflare");
    expect(serialized).not.toContain("TILLER_CLOUDFLARE_MCP_PROXY_TOKEN");
    expect(serialized).not.toContain("envHttpHeaders");
    expect(serialized).not.toContain("cloudflareMcpProxyTokenId");
  });

  it("enables GitHub base checkout with matching bridge credentials", async () => {
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(true);

    const config = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      createMeta(),
    );

    expect(config.envVars).toMatchObject({
      TILLER_GITHUB_FULL_NAME: "test/repo",
      TILLER_GITHUB_BASE_BRANCH: "main",
      TILLER_GITHUB_BASE_COMMIT_SHA: "base-sha",
      TILLER_GITHUB_BRANCH: "tiller/env/demo-env",
      TILLER_GITHUB_BRIDGE_ID: "bridge-id",
      TILLER_GITHUB_BRIDGE_SECRET: "bridge-secret",
      TILLER_GITHUB_ALLOWED_REPO: "test/repo",
    });
  });

  it("keeps Cloudflare Codex environments on their claimed API-key auth", async () => {
    const config = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      },
      { startAuthClaim: claimedAuth("codex", "api") },
    );

    expect(mocks.resolveCodexContainerAuth).toHaveBeenCalledWith(
      expect.anything(),
      { authPreference: "api-key" },
    );
    expect(config.envVars.OPENAI_API_KEY).toBe("openai-key");
    expect(config.envVars).toMatchObject({
      TILLER_CODEX_MODEL: "gpt-5.6-sol",
      TILLER_CODEX_REASONING_EFFORT: "xhigh",
    });
  });

  it("claims and launches the frozen subscription profile for an implementor Start", async () => {
    const lifecycle = {
      getCodexExecutionProfile: vi.fn(async () => null),
      claimCodexExecutionProfile: vi.fn(async (_startOpId: string, profile: unknown) => profile),
    };
    const env = {
      ...createEnv(),
      ENV_LIFECYCLE: {
        idFromName: vi.fn(() => "lifecycle-id"),
        get: vi.fn(() => lifecycle),
      },
    } as any;
    const config = await buildContainerLaunchConfig(
      env,
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        incarnationId: "incarnation-1",
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      },
      {
        startOpId: "start-op-1",
        startAuthClaim: claimedAuth("codex", "subscription"),
      },
    );

    expect(lifecycle.claimCodexExecutionProfile).toHaveBeenCalledWith(
      "start-op-1",
      expect.objectContaining({
        kind: "subscription-app-server",
        surface: "implementor",
        backend: "cf",
      }),
    );
    expect(config.envVars).toMatchObject({
      TILLER_CODEX_AUTH_MODE: "subscription",
      TILLER_CODEX_RUNTIME_MODE: "app-server",
      TILLER_CODEX_RUNTIME_AUTH_URL: "https://tiller.preview.workers.dev/api/envs/demo-env/codex/runtime-auth",
      TILLER_CODEX_MODEL: "gpt-5.6-sol",
      TILLER_CODEX_REASONING_EFFORT: "xhigh",
    });
    expect(config.envVars.TILLER_RUNTIME_CAPABILITY).toMatch(/^[a-f0-9]{64}$/u);
    expect(config.envVars.OPENAI_API_KEY).toBeUndefined();
    expect(config.meta).toMatchObject({ codexAuthMode: "subscription" });
  });

  it("claims an explicit API-key profile without consulting subscription state", async () => {
    const lifecycle = {
      getCodexExecutionProfile: vi.fn(async () => null),
      claimCodexExecutionProfile: vi.fn(async (_startOpId: string, profile: unknown) => profile),
    };
    const env = {
      ...createEnv(),
      OPENAI_API_KEY: "openai-key",
      ENV_LIFECYCLE: {
        idFromName: vi.fn(() => "lifecycle-id"),
        get: vi.fn(() => lifecycle),
      },
    } as any;
    const config = await buildContainerLaunchConfig(
      env,
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        incarnationId: "incarnation-1",
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      },
      {
        startOpId: "start-op-api",
        startAuthClaim: claimedAuth("codex", "api"),
      },
    );

    expect(lifecycle.claimCodexExecutionProfile).toHaveBeenCalledWith(
      "start-op-api",
      expect.objectContaining({
        kind: "api-key-app-server",
        backend: "cf",
      }),
    );
    expect(config.envVars).toMatchObject({
      TILLER_CODEX_AUTH_MODE: "api-key",
      TILLER_CODEX_RUNTIME_MODE: "app-server",
      OPENAI_API_KEY: "openai-key",
    });
    expect(config.envVars.TILLER_RUNTIME_CAPABILITY).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("reuses a claimed profile without rereading global billing", async () => {
    const claimedProfile = {
      kind: "api-key-direct-cli" as const,
      surface: "implementor" as const,
      backend: "cf" as const,
    };
    const lifecycle = {
      getCodexExecutionProfile: vi.fn(async () => claimedProfile),
      claimCodexExecutionProfile: vi.fn(),
    };
    const env = {
      ...createEnv(),
      OPENAI_API_KEY: "openai-key",
      ENV_LIFECYCLE: {
        idFromName: vi.fn(() => "lifecycle-id"),
        get: vi.fn(() => lifecycle),
      },
    } as any;
    const config = await buildContainerLaunchConfig(
      env,
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        incarnationId: "incarnation-1",
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      },
      {
        startOpId: "claimed-start-op",
        startAuthClaim: claimedAuth("codex", "api"),
      },
    );

    expect(lifecycle.claimCodexExecutionProfile).not.toHaveBeenCalled();
    expect(config.meta).toMatchObject({ codexAuthMode: "api-key" });
    expect(config.envVars.OPENAI_API_KEY).toBe("openai-key");
  });

  it("passes the selected Codex model and effort", async () => {
    const config = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.5", effort: "low" },
      },
      { startAuthClaim: claimedAuth("codex", "api") },
    );
    expect(config.envVars).toMatchObject({
      TILLER_CODEX_MODEL: "gpt-5.5",
      TILLER_CODEX_REASONING_EFFORT: "low",
    });
  });

  it("passes Fast mode to supported implementors that opt in", async () => {
    const fast = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.5", effort: "high", fastMode: true },
      },
      { startAuthClaim: claimedAuth("codex", "api") },
    );
    expect(fast.envVars.TILLER_CODEX_FAST_MODE).toBe("1");

    const standard = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        backend: "cf",
        harness: "codex",
        harnessSettings: { model: "gpt-5.5", effort: "high" },
      },
      { startAuthClaim: claimedAuth("codex", "api") },
    );
    expect(standard.envVars.TILLER_CODEX_FAST_MODE).toBeUndefined();

    const claudeFast = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        harness: "claude-code",
        harnessSettings: { model: "claude-opus-4.8", effort: "high", fastMode: true },
      },
      { startAuthClaim: claimedAuth("claude-code", "subscription") },
    );
    expect(claudeFast.envVars.TILLER_CLAUDE_FAST_MODE).toBe("1");
    expect(claudeFast.envVars.TILLER_CODEX_FAST_MODE).toBeUndefined();

    const claudeStandard = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        harness: "claude-code",
        harnessSettings: { model: "claude-opus-4.8", effort: "high" },
      },
      { startAuthClaim: claimedAuth("claude-code", "subscription") },
    );
    expect(claudeStandard.envVars.TILLER_CLAUDE_FAST_MODE).toBeUndefined();
  });

  it("forces Fable through Anthropic API mode and passes model effort", async () => {
    const config = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        harness: "claude-code",
        harnessSettings: { model: "claude-fable-5", effort: "max" },
      },
      { startAuthClaim: claimedAuth("claude-code", "api") },
    );
    expect(mocks.resolveContainerAuth).toHaveBeenCalledWith(expect.anything(), {
      backend: "host",
      requested: "api",
    });
    expect(config.envVars).toMatchObject({
      TILLER_CLAUDE_MODEL: "claude-fable-5",
      TILLER_CLAUDE_EFFORT: "max",
      ANTHROPIC_API_KEY: "anthropic-key",
    });
    expect(config.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(config.meta)).not.toContain("anthropic-key");
  });

  it("emits one selected OpenCode provider/model and reasoning effort", async () => {
    mocks.resolveOpenCodeContainerAuth.mockResolvedValueOnce({
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
      token: "openai-token",
    });
    const config = await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      {
        ...createMeta(),
        harnessSettings: { model: "gpt-5.6-sol", effort: "max" },
      },
      { startAuthClaim: claimedAuth("opencode", "api") },
    );
    expect(config.envVars).toMatchObject({
      TILLER_OPENCODE_BASE_URL: "https://api.openai.com/v1",
      TILLER_OPENCODE_AUTH_TOKEN: "openai-token",
      TILLER_OPENCODE_MODEL_ID: "gpt-5.6-sol",
      TILLER_OPENCODE_MODEL_ALIAS: "gpt-5-6-sol",
      TILLER_OPENCODE_PROVIDER_KIND: "openai",
      TILLER_OPENCODE_PROVIDER_ALIAS: "tiller-openai",
      TILLER_OPENCODE_REASONING_EFFORT: "max",
    });
  });

  it("lets Workers AI launch without provider credentials", async () => {
    await buildContainerLaunchConfig(
      createEnv(),
      "https://hub.example.com/api/envs/demo-env/start",
      "demo-env",
      "https://github.com/test/repo.git",
      repoMeta,
      createMeta(),
    );

    expect(mocks.resolveOpenCodeContainerAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ credential: "workers-ai" }),
    );
  });

  it("emits the exact model binding and effort for every supported catalog pair", async () => {
    for (const entry of HARNESS_MODEL_CATALOG) {
      for (const effort of entry.efforts) {
        const config = await buildContainerLaunchConfig(
          createEnv(),
          "https://hub.example.com/api/envs/demo-env/start",
          "demo-env",
          "https://github.com/test/repo.git",
          repoMeta,
          {
            ...createMeta(),
            harness: entry.harness,
            harnessSettings: { model: entry.id, effort },
          },
          { startAuthClaim: claimedAuth(entry.harness, "api") },
        );

        if (entry.binding.kind === "codex") {
          expect(config.envVars, `${entry.harness}/${entry.id}/${effort}`).toMatchObject({
            TILLER_CODEX_MODEL: entry.binding.model,
            TILLER_CODEX_REASONING_EFFORT: effort,
            OPENAI_API_KEY: "openai-key",
          });
          expect(config.envVars.ANTHROPIC_API_KEY).toBeUndefined();
          expect(config.envVars.TILLER_OPENCODE_AUTH_TOKEN).toBeUndefined();
        } else if (entry.binding.kind === "claude") {
          expect(config.envVars, `${entry.harness}/${entry.id}/${effort}`).toMatchObject({
            TILLER_CLAUDE_MODEL: entry.binding.model,
            TILLER_CLAUDE_EFFORT: effort,
            ANTHROPIC_API_KEY: "anthropic-key",
          });
          expect(config.envVars.OPENAI_API_KEY).toBeUndefined();
          expect(config.envVars.TILLER_OPENCODE_AUTH_TOKEN).toBeUndefined();
        } else {
          expect(config.envVars, `${entry.harness}/${entry.id}/${effort}`).toMatchObject({
            TILLER_OPENCODE_BASE_URL: entry.binding.baseUrl ?? "https://tiller.preview.workers.dev/api/opencode/v1",
            TILLER_OPENCODE_AUTH_TOKEN: entry.binding.provider === "openai"
              ? "openai-token"
              : entry.binding.provider === "anthropic" ? "anthropic-token" : "workers-token",
            TILLER_OPENCODE_MODEL_ID: entry.binding.model,
            TILLER_OPENCODE_MODEL_ALIAS: entry.binding.modelAlias,
            TILLER_OPENCODE_MODEL_CONTEXT_LIMIT: String(entry.limits.context),
            ...(entry.limits.input
              ? { TILLER_OPENCODE_MODEL_INPUT_LIMIT: String(entry.limits.input) }
              : {}),
            TILLER_OPENCODE_MODEL_OUTPUT_LIMIT: String(entry.limits.output),
            TILLER_OPENCODE_PROVIDER_KIND: entry.binding.provider,
            TILLER_OPENCODE_PROVIDER_ALIAS: entry.binding.providerAlias,
            TILLER_OPENCODE_REASONING_EFFORT: effort,
          });
          expect(config.envVars.OPENAI_API_KEY).toBeUndefined();
          expect(config.envVars.ANTHROPIC_API_KEY).toBeUndefined();
          expect(config.meta).toEqual({ harness: "opencode" });
        }
      }
    }
  });
});
