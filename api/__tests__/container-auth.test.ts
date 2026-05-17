import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_PROXY_TOKEN_KEY,
  resolveClaudeAuthMode,
  resolveCodexContainerAuth,
  resolveContainerAuth,
  resolveOpenCodeContainerAuth,
} from "../env/container-auth";
import type { Env } from "../types";

const { getOrCreateSecret, getValidOpenAIAuth } = vi.hoisted(() => ({
  getOrCreateSecret: vi.fn(async (env: Record<string, unknown>, key: string, createValue: () => string) => {
    return env[key] || createValue();
  }),
  getValidOpenAIAuth: vi.fn(),
}));

// Mock the config module so getSecret falls through to env values
// (no DO available in unit tests)
vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => {
    return env[key] || undefined;
  },
  getOrCreateSecret,
}));

vi.mock("../openai-auth", () => ({
  getValidOpenAIAuth,
}));

function mockEnv(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  getValidOpenAIAuth.mockResolvedValue({
    access_token: "chatgpt-access",
    account_id: "acct-123",
    expires_at: Date.now() + 3600_000,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("resolveClaudeAuthMode", () => {
  it("defaults to auto", () => {
    expect(resolveClaudeAuthMode()).toBe("auto");
  });

  it("prefers explicit request", () => {
    expect(resolveClaudeAuthMode({ requested: "subscription", stored: "api" })).toBe("subscription");
  });

  it("falls back to stored mode", () => {
    expect(resolveClaudeAuthMode({ stored: "api" })).toBe("api");
  });
});

describe("resolveContainerAuth", () => {
  it("uses subscription token in auto mode when available", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("subscription");
    expect(result.envVars).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
    expect(result.authWarning).toBeUndefined();
  });

  it("adds Claude subscription display env vars from the OAuth profile", async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      JSON.stringify({
        organization: {
          organization_type: "claude_max",
          rate_limit_tier: "default_claude_max_5x",
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    ));

    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
      { requested: "subscription" },
    );

    expect(result.envVars).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-token",
      CLAUDE_CODE_SUBSCRIPTION_TYPE: "max",
      CLAUDE_CODE_RATE_LIMIT_TIER: "default_claude_max_5x",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/api/oauth/profile",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer oauth-token",
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("keeps subscription token usable when OAuth profile lookup fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
      { requested: "subscription" },
    );

    expect(result.envVars).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
  });

  it("uses api key in auto mode without adding an auth warning", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
    expect(result.authWarning).toBeUndefined();
  });

  it("falls back to the API key for host-backed Claude Code envs when no subscription token is available", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
      { backend: "host" },
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
  });

  it("allows explicit API auth for host-backed Claude Code envs", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
      { backend: "host", requested: "api" },
    );

    expect(result.authMode).toBe("api");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
  });

  it("prefers subscription auth for host-backed Claude Code auto mode", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
      { backend: "host" },
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("subscription");
    expect(result.envVars).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" });
  });

  it("requires oauth token in subscription mode", async () => {
    await expect(
      resolveContainerAuth(
        mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
        { requested: "subscription" },
      ),
    ).rejects.toThrow("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("requires api key in api mode", async () => {
    await expect(
      resolveContainerAuth(
        mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
        { requested: "api" },
      ),
    ).rejects.toThrow("ANTHROPIC_API_KEY");
  });

  it("uses only api key in explicit api mode", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
      { requested: "api" },
    );

    expect(result.authMode).toBe("api");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
  });

  it("never leaks oauth token in api mode", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
      { requested: "api" },
    );

    expect(result.envVars).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("never leaks api key in subscription mode", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
      { requested: "subscription" },
    );

    expect(result.envVars).not.toHaveProperty("ANTHROPIC_API_KEY");
  });

  // The entrypoint.sh uses TILLER_CLAUDE_AUTH_RESOLVED_MODE to decide between
  // --bare (api key) and --skip-permissions (subscription). These tests verify
  // the resolvedAuthMode contract that the entrypoint depends on.
  it("resolvedAuthMode is 'api' when only ANTHROPIC_API_KEY is available", async () => {
    const result = await resolveContainerAuth(mockEnv({ ANTHROPIC_API_KEY: "api-key" }));
    expect(result.resolvedAuthMode).toBe("api");
  });

  it("resolvedAuthMode is 'subscription' when only CLAUDE_CODE_OAUTH_TOKEN is available", async () => {
    const result = await resolveContainerAuth(mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }));
    expect(result.resolvedAuthMode).toBe("subscription");
  });

  it("resolvedAuthMode is 'subscription' when both credentials are available in auto mode", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "api-key" }),
    );
    expect(result.resolvedAuthMode).toBe("subscription");
  });

  it("throws when no credentials are available", async () => {
    await expect(resolveContainerAuth(mockEnv({}))).rejects.toThrow(
      "No auth configured",
    );
  });

  it("tells host-backed Claude Code users they need subscription auth or an API key", async () => {
    await expect(resolveContainerAuth(mockEnv({}), { backend: "host" })).rejects.toThrow(
      "requires either CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    );
  });
});

describe("resolveCodexContainerAuth", () => {
  it("returns gateway subscription env vars when a gateway route is available", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({}), {
        gatewayRoute: {
          kind: "gateway-subscription",
          gatewayUrl: "https://tiller-gateway.example.com",
          machineId: "machine-123",
          providerBaseUrl: "https://tiller-gateway.example.com/v1",
          responsesUrl: "https://tiller-gateway.example.com/codex/responses",
          codexRouteStatus: "available",
        },
        gatewaySessionToken: "session-token",
      }),
    ).resolves.toEqual({
      authPreference: "auto",
      resolvedAuthMode: "subscription",
      modelRoute: "gateway-subscription",
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: "https://tiller-gateway.example.com/v1",
        TILLER_CODEX_GATEWAY_SESSION_TOKEN: "session-token",
      },
    });
  });

  it("requires OPENAI_API_KEY for Cloudflare containers", async () => {
    await expect(resolveCodexContainerAuth(mockEnv({}), { backend: "cf" })).rejects.toThrow("OPENAI_API_KEY");
  });

  it("returns host gateway env vars when a host route is available", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({}), {
        backend: "host",
        gatewayRoute: {
          kind: "host-gateway",
          machineId: "machine-123",
          providerBaseUrl: "http://host.docker.internal:8788/v1",
          responsesUrl: "http://host.docker.internal:8788/codex/responses",
          codexRouteStatus: "available",
        },
        gatewaySessionToken: "session-token",
      }),
    ).resolves.toEqual({
      authPreference: "auto",
      resolvedAuthMode: "subscription",
      modelRoute: "host-gateway",
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: "http://host.docker.internal:8788/v1",
        TILLER_CODEX_GATEWAY_SESSION_TOKEN: "session-token",
      },
    });
  });

  it("rejects host Codex auth when neither gateway nor OPENAI_API_KEY is available", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({}), {
        backend: "host",
      }),
    ).rejects.toThrow("requires a connected Subscription Gateway or OPENAI_API_KEY");
  });

  it("allows explicit API key auth for host-backed Codex envs", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({ OPENAI_API_KEY: "openai-key" }), {
        backend: "host",
        authPreference: "api-key",
      }),
    ).resolves.toEqual({
      authPreference: "api-key",
      resolvedAuthMode: "api-key",
      modelRoute: "api-fallback",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
  });

  it("returns OPENAI_API_KEY when configured", async () => {
    await expect(resolveCodexContainerAuth(mockEnv({ OPENAI_API_KEY: "openai-key" }))).resolves.toEqual({
      authPreference: "auto",
      resolvedAuthMode: "api-key",
      modelRoute: "api-fallback",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
  });

  it("prefers the host gateway route over OPENAI_API_KEY for host backends", async () => {
    await expect(
      resolveCodexContainerAuth(
        mockEnv({ OPENAI_API_KEY: "openai-key" }),
        {
          backend: "host",
          gatewayRoute: {
            kind: "host-gateway",
            machineId: "machine-123",
            providerBaseUrl: "http://host.docker.internal:8788/v1",
            responsesUrl: "http://host.docker.internal:8788/codex/responses",
            codexRouteStatus: "available",
          },
          gatewaySessionToken: "session-token",
        },
      ),
    ).resolves.toEqual({
      authPreference: "auto",
      resolvedAuthMode: "subscription",
      modelRoute: "host-gateway",
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: "http://host.docker.internal:8788/v1",
        TILLER_CODEX_GATEWAY_SESSION_TOKEN: "session-token",
      },
    });
  });

  it("falls back to OPENAI_API_KEY in auto mode when the imported Codex login needs re-import", async () => {
    getValidOpenAIAuth.mockRejectedValueOnce(new Error("refresh failed"));

    await expect(
      resolveCodexContainerAuth(
        mockEnv({ OPENAI_API_KEY: "openai-key" }),
        {
          gatewayRoute: {
            kind: "gateway-subscription",
            gatewayUrl: "https://tiller-gateway.example.com",
            machineId: "machine-123",
            providerBaseUrl: "https://tiller-gateway.example.com/v1",
            responsesUrl: "https://tiller-gateway.example.com/codex/responses",
            codexRouteStatus: "available",
          },
          gatewaySessionToken: "session-token",
        },
      ),
    ).resolves.toEqual({
      authPreference: "auto",
      resolvedAuthMode: "api-key",
      modelRoute: "api-fallback",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
  });

  it("fails subscription preference instead of falling back to OPENAI_API_KEY", async () => {
    await expect(
      resolveCodexContainerAuth(
        mockEnv({ OPENAI_API_KEY: "openai-key" }),
        {
          authPreference: "subscription",
          gatewayRoute: {
            kind: "unavailable",
            reason: "gateway offline",
            codexRouteStatus: "gateway_offline",
          },
        },
      ),
    ).rejects.toThrow("Codex subscription auth requested");
  });

  it("uses only OPENAI_API_KEY in explicit api-key preference", async () => {
    await expect(
      resolveCodexContainerAuth(
        mockEnv({ OPENAI_API_KEY: "openai-key" }),
        {
          authPreference: "api-key",
          gatewayRoute: {
            kind: "host-gateway",
            machineId: "machine-123",
            providerBaseUrl: "http://host.docker.internal:8788/v1",
            responsesUrl: "http://host.docker.internal:8788/codex/responses",
            codexRouteStatus: "available",
          },
          gatewaySessionToken: "session-token",
        },
      ),
    ).resolves.toEqual({
      authPreference: "api-key",
      resolvedAuthMode: "api-key",
      modelRoute: "api-fallback",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
  });
});

describe("resolveOpenCodeContainerAuth", () => {
  it("returns a hub-managed proxy token when configured", async () => {
    await expect(
      resolveOpenCodeContainerAuth(
        mockEnv({
          [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123",
        }),
      ),
    ).resolves.toEqual({
      provider: "cloudflare-workers-ai",
      model: "@cf/moonshotai/kimi-k2.5",
      proxyToken: "proxy-token-123",
    });
  });

  it("creates a proxy token when one is missing", async () => {
    getOrCreateSecret.mockResolvedValueOnce("generated-proxy-token");
    await expect(resolveOpenCodeContainerAuth(mockEnv({}))).resolves.toEqual({
      provider: "cloudflare-workers-ai",
      model: "@cf/moonshotai/kimi-k2.5",
      proxyToken: "generated-proxy-token",
    });
  });
});
