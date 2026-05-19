import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_PROXY_TOKEN_KEY,
  resolveClaudeAuthMode,
  resolveCodexContainerAuth,
  resolveContainerAuth,
  resolveOpenCodeContainerAuth,
} from "../env/container-auth";
import type { Env } from "../types";

const { getOrCreateSecret } = vi.hoisted(() => ({
  getOrCreateSecret: vi.fn(async (env: Record<string, unknown>, key: string, createValue: () => string) => {
    return env[key] || createValue();
  }),
}));

// Mock the config module so getSecret falls through to env values
// (no DO available in unit tests)
vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => {
    return env[key] || undefined;
  },
  getOrCreateSecret,
}));

function mockEnv(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
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

  it("uses api key in auto mode with a clear warning", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
    );

    expect(result.authMode).toBe("auto");
    expect(result.resolvedAuthMode).toBe("api");
    expect(result.envVars).toEqual({ ANTHROPIC_API_KEY: "api-key" });
    expect(result.authWarning).toContain("Anthropic API key");
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
});

describe("resolveCodexContainerAuth", () => {
  it("returns gateway subscription env vars when a gateway route is available", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({}), {
        gatewayRoute: {
          kind: "gateway-subscription",
          gatewayUrl: "https://tiller-gateway.example.com",
          providerBaseUrl: "https://tiller-gateway.example.com/v1",
          responsesUrl: "https://tiller-gateway.example.com/codex/responses",
          accessToken: "gateway-token",
          accountId: "acct-123",
        },
      }),
    ).resolves.toEqual({
      resolvedAuthMode: "chatgpt",
      modelRoute: "gateway-subscription",
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: "https://tiller-gateway.example.com/v1",
        TILLER_CODEX_GATEWAY_ACCESS_TOKEN: "gateway-token",
        TILLER_CODEX_GATEWAY_ACCOUNT_ID: "acct-123",
      },
    });
  });

  it("requires OPENAI_API_KEY for Cloudflare containers", async () => {
    await expect(resolveCodexContainerAuth(mockEnv({}))).rejects.toThrow("OpenAI API key");
  });

  it("returns host gateway env vars when a host route is available", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({}), {
        backend: "host",
        gatewayRoute: {
          kind: "host-gateway",
          providerBaseUrl: "http://host.docker.internal:8788/v1",
          responsesUrl: "http://host.docker.internal:8788/codex/responses",
          accessToken: "gateway-token",
          accountId: "acct-123",
        },
      }),
    ).resolves.toEqual({
      resolvedAuthMode: "chatgpt",
      modelRoute: "host-gateway",
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: "http://host.docker.internal:8788/v1",
        TILLER_CODEX_GATEWAY_ACCESS_TOKEN: "gateway-token",
        TILLER_CODEX_GATEWAY_ACCOUNT_ID: "acct-123",
      },
    });
  });

  it("rejects host Codex auth when neither gateway nor OPENAI_API_KEY is available", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({}), {
        backend: "host",
      }),
    ).rejects.toThrow("connected Tiller Host gateway");
  });

  it("returns OPENAI_API_KEY when configured", async () => {
    await expect(resolveCodexContainerAuth(mockEnv({ OPENAI_API_KEY: "openai-key" }))).resolves.toEqual({
      resolvedAuthMode: "openai-api",
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
            providerBaseUrl: "http://host.docker.internal:8788/v1",
            responsesUrl: "http://host.docker.internal:8788/codex/responses",
            accessToken: "gateway-token",
            accountId: "acct-123",
          },
        },
      ),
    ).resolves.toEqual({
      resolvedAuthMode: "chatgpt",
      modelRoute: "host-gateway",
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: "http://host.docker.internal:8788/v1",
        TILLER_CODEX_GATEWAY_ACCESS_TOKEN: "gateway-token",
        TILLER_CODEX_GATEWAY_ACCOUNT_ID: "acct-123",
      },
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
