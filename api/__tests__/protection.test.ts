import { beforeEach, describe, expect, it, vi } from "vitest";
import { maybeVerifyCfAccessRequest } from "../auth";
import { hasEnabledHarnessModelAuth, resolveModelAuthState, resolveProtectionState } from "../protection";
import voiceRoutes from "../voice/routes";
import type { Env } from "../types";

const { getOpenAIAuthStatus } = vi.hoisted(() => ({
  getOpenAIAuthStatus: vi.fn(async () => ({ authenticated: false })),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

vi.mock("../openai-auth", () => ({
  getStatus: getOpenAIAuthStatus,
}));

function mockEnv(overrides: Record<string, unknown> = {}): Env {
  const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
  return {
    TILLER_VOICE: {
      idFromName: vi.fn(() => "voice-id"),
      get: vi.fn(() => ({ fetch: fetchSpy })),
    },
    ...overrides,
  } as unknown as Env;
}

describe("resolveModelAuthState", () => {
  beforeEach(() => {
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: false });
  });

  it("treats either Claude subscription or Anthropic API auth as configured", async () => {
    await expect(resolveModelAuthState(mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }))).resolves.toMatchObject({
      configured: true,
      mode: "subscription",
    });

    await expect(resolveModelAuthState(mockEnv({ ANTHROPIC_API_KEY: "api-key" }))).resolves.toMatchObject({
      configured: true,
      mode: "api",
    });
  });

  it("tracks OpenAI credentials separately", async () => {
    await expect(resolveModelAuthState(mockEnv({ OPENAI_API_KEY: "openai-key" }))).resolves.toMatchObject({
      configured: true,
      mode: "openai-api",
      hasOpenAIKey: true,
    });
  });

  it("ignores legacy Workers AI credentials for setup readiness", async () => {
    await expect(
      resolveModelAuthState(
        mockEnv({
          TILLER_WORKERS_AI_ACCOUNT_ID: "account-123",
          TILLER_WORKERS_AI_API_TOKEN: "token-123",
        }),
      ),
    ).resolves.toMatchObject({
      configured: false,
      mode: null,
    });
  });

  it("tracks ChatGPT auth separately", async () => {
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: true });

    await expect(resolveModelAuthState(mockEnv())).resolves.toMatchObject({
      configured: true,
      mode: "chatgpt",
      hasChatGPTAuth: true,
    });
  });
});

describe("hasEnabledHarnessModelAuth", () => {
  it("requires a Claude credential when only claude-code is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        { hasClaudeSubscription: false, hasAnthropicKey: false, hasChatGPTAuth: false, hasOpenAIKey: true },
        ["claude-code"],
      ),
    ).toBe(false);
  });

  it("accepts an OpenAI key when codex is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        { hasClaudeSubscription: false, hasAnthropicKey: false, hasChatGPTAuth: false, hasOpenAIKey: true },
        ["claude-code", "codex"],
      ),
    ).toBe(true);
  });

  it("accepts ChatGPT auth when codex is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: true,
          hasOpenAIKey: false,
        },
        ["codex"],
      ),
    ).toBe(true);
  });

  it("accepts local Codex auth when codex is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: false,
          hasLocalCodexAuth: true,
        },
        ["codex"],
      ),
    ).toBe(true);
  });

  it("accepts built-in OpenCode access when opencode is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: false,
        },
        ["opencode"],
      ),
    ).toBe(true);
  });
});

describe("resolveProtectionState", () => {
  it("treats workers.dev as public-only even with stale Access config", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    await expect(
      resolveProtectionState(env, "https://demo.preview.workers.dev/api/setup/status"),
    ).resolves.toMatchObject({
      hostKind: "workers-dev",
      protectionMode: "public",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: true,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
    });
  });

  it("treats custom domains with CF_ACCESS_AUD as protected", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
      WORKERS_DEV_ALIAS_DISABLED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    await expect(
      resolveProtectionState(env, "https://tiller.example.com/api/setup/status"),
    ).resolves.toMatchObject({
      hostKind: "custom-domain",
      protectionMode: "cf-access",
      protectionCanAutomate: true,
      serviceTokenConfigured: true,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: true,
      protectionAppDomain: null,
    });
  });
});

describe("maybeVerifyCfAccessRequest", () => {
  it("rejects malformed JWTs for protected custom domains", async () => {
    const env = mockEnv({ CF_ACCESS_AUD: "aud" });
    const request = new Request("https://tiller.example.com/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(maybeVerifyCfAccessRequest(request, env)).rejects.toThrow("Malformed JWT");
  });

  it("accepts matching service token headers for protected custom domains", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });
    const request = new Request("https://tiller.example.com/api/sessions", {
      headers: {
        "CF-Access-Client-Id": "client-id.access",
        "CF-Access-Client-Secret": "client-secret",
      },
    });

    await expect(maybeVerifyCfAccessRequest(request, env)).resolves.toBeUndefined();
  });

  it("rejects missing credentials for protected custom domains", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });
    const request = new Request("https://tiller.example.com/api/sessions");

    await expect(maybeVerifyCfAccessRequest(request, env)).rejects.toThrow(
      "Missing Cloudflare Access service token",
    );
  });

  it("skips stale Access config on workers.dev", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_AUD: "aud",
    });
    const request = new Request("https://demo.preview.workers.dev/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(maybeVerifyCfAccessRequest(request, env)).resolves.toBeUndefined();
  });
});

describe("voice access auth", () => {
  let env: Env;
  let stubFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stubFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    env = {
      TILLER_VOICE: {
        idFromName: vi.fn(() => "voice-id"),
        get: vi.fn(() => ({ fetch: stubFetch })),
      },
    } as unknown as Env;
  });

  it("returns 401 for invalid JWTs on protected custom domains", async () => {
    const res = await voiceRoutes.request(
      "https://tiller.example.com/api/voice/session?sessionId=session-1",
      {
        headers: {
          upgrade: "websocket",
          "Cf-Access-Jwt-Assertion": "not-a-jwt",
        },
      },
      { ...env, CF_ACCESS_AUD: "aud" } as unknown as Record<string, unknown>,
    );

    expect(res.status).toBe(401);
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("allows workers.dev requests through without Access config", async () => {
    const res = await voiceRoutes.request(
      "https://demo.preview.workers.dev/api/voice/session?sessionId=session-1",
      {
        headers: {
          upgrade: "websocket",
        },
      },
      env as unknown as Record<string, unknown>,
    );

    expect(res.status).toBe(200);
    expect(stubFetch).toHaveBeenCalledTimes(1);
  });
});
