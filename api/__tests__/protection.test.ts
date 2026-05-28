import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authMiddleware, dynamicEntrypointAuthResponse, maybeVerifyCfAccessRequest } from "../auth";
import { hasEnabledHarnessModelAuth, resolveModelAuthState, resolveProtectionState } from "../protection";
import voiceRoutes from "../voice/routes";
import type { Env, HonoEnv } from "../types";

const { getOpenAIAuthStatus } = vi.hoisted(() => ({
  getOpenAIAuthStatus: vi.fn(async () => ({ authenticated: false, status: "missing" })),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
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
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: false, status: "missing" });
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
      mode: "api-key",
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
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: true, status: "connected" });

    await expect(resolveModelAuthState(mockEnv())).resolves.toMatchObject({
      configured: true,
      mode: "subscription",
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

  it("does not accept local Codex auth when codex is enabled", () => {
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
    ).toBe(false);
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
  it("keeps workers.dev public until Access is explicitly configured", async () => {
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
      routeKind: "workers-dev",
      protectionMode: "public",
      protectionCanAutomate: false,
      serviceTokenConfigured: true,
      unsupportedProtectionConfig: true,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
    });
  });

  it("supports Access-protected workers.dev routes", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    });

    await expect(
      resolveProtectionState(env, "https://demo.preview.workers.dev/api/setup/status"),
    ).resolves.toMatchObject({
      routeKind: "workers-dev",
      hostKind: "workers-dev",
      protectionMode: "cf-access",
      protectionCanAutomate: false,
      accessConfigured: true,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessJwksUrl: null,
    });
  });

  it("treats custom domains with CF_ACCESS_AUD as protected", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
      WORKERS_DEV_ALIAS_DISABLED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    await expect(
      resolveProtectionState(env, "https://tiller.example.com/api/setup/status"),
    ).resolves.toMatchObject({
      hostKind: "custom-domain",
      routeKind: "custom-domain",
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
    const env = mockEnv({
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    });
    const request = new Request("https://tiller.example.com/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(maybeVerifyCfAccessRequest(request, env)).rejects.toThrow("Malformed JWT");
  });

  it("accepts matching service token headers for protected custom domains", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
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
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });
    const request = new Request("https://tiller.example.com/api/sessions");

    await expect(maybeVerifyCfAccessRequest(request, env)).rejects.toThrow(
      "Missing Cloudflare Access service token",
    );
  });

  it("skips incomplete Access config on workers.dev", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_AUD: "aud",
    });
    const request = new Request("https://demo.preview.workers.dev/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(maybeVerifyCfAccessRequest(request, env)).resolves.toBeUndefined();
  });

  it("validates workers.dev Access JWTs when Access is configured", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    });
    const request = new Request("https://demo.preview.workers.dev/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(maybeVerifyCfAccessRequest(request, env)).rejects.toThrow("Malformed JWT");
  });
});

describe("authMiddleware protect-hub guard", () => {
  function createProtectedApp() {
    const app = new Hono<HonoEnv>();
    app.use("/api/*", authMiddleware);
    app.get("/api/setup/status", (c) => c.json({ ok: true }));
    app.post("/api/setup/workers-dev-access", (c) => c.json({ ok: true }));
    app.post("/api/setup/verify-cloudflare-token", (c) => c.json({ ok: true }));
    app.post("/api/setup", (c) => c.json({ ok: true }));
    app.get("/api/envs", (c) => c.json([]));
    return app;
  }

  it("blocks non-allowlisted APIs on fresh deployed workers.dev hubs", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    });

    const blocked = await app.request("https://demo.preview.workers.dev/api/envs", {}, env as any);
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    });

    const setupWrite = await app.request(
      "https://demo.preview.workers.dev/api/setup",
      { method: "POST" },
      env as any,
    );
    expect(setupWrite.status).toBe(403);
  });

  it("blocks current workers.dev aliases even when the configured hub URL is elsewhere", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
    });

    const blocked = await app.request(
      "https://demo.preview.workers.dev/api/envs",
      {},
      env as any,
    );
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    });
  });

  it("allows only setup status and workers.dev Access claim during protect-hub", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    });

    await expect(
      app.request("https://demo.preview.workers.dev/api/setup/status", {}, env as any),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request(
        "https://demo.preview.workers.dev/api/setup/workers-dev-access",
        { method: "POST" },
        env as any,
      ),
    ).resolves.toMatchObject({ status: 200 });
  });

  it("keeps localhost setup writes relaxed", async () => {
    const app = createProtectedApp();
    const res = await app.request(
      "http://localhost:5173/api/setup",
      { method: "POST" },
      mockEnv() as any,
    );

    expect(res.status).toBe(200);
  });

  it("keeps localhost non-setup APIs relaxed even when Access config exists", async () => {
    const app = createProtectedApp();
    const res = await app.request(
      "http://localhost:5173/api/envs",
      { method: "GET" },
      mockEnv({
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      }) as any,
    );

    expect(res.status).toBe(200);
  });

  it("blocks deployed public setup writes on custom domains", async () => {
    const app = createProtectedApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup",
      { method: "POST" },
      mockEnv({
        HUB_PUBLIC_URL: "https://tiller.example.com",
      }) as any,
    );

    expect(res.status).toBe(401);
  });

  it("allows public custom-domain Cloudflare token verification bootstrap", async () => {
    const app = createProtectedApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup/verify-cloudflare-token",
      { method: "POST" },
      mockEnv({
        HUB_PUBLIC_URL: "https://tiller.example.com",
      }) as any,
    );

    expect(res.status).toBe(200);
  });

  it("blocks non-API dynamic entrypoints during protect-hub", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    });

    const agentsBlocked = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/agents/plan-chat/default"),
      env,
    );
    expect(agentsBlocked?.status).toBe(403);

    const partiesBlocked = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(partiesBlocked?.status).toBe(403);
  });

  it("requires normal Access auth for non-API dynamic entrypoints after Access is configured", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    const missing = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/agents/plan-chat/default"),
      env,
    );
    expect(missing?.status).toBe(401);

    const authed = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/agents/plan-chat/default", {
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      }),
      env,
    );
    expect(authed).toBeNull();
  });

  it("requires normal Access auth for setup writes after workers.dev Access is configured", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    const missing = await app.request(
      "https://demo.preview.workers.dev/api/setup",
      { method: "POST" },
      env as any,
    );
    expect(missing.status).toBe(401);

    const authed = await app.request(
      "https://demo.preview.workers.dev/api/setup",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      env as any,
    );
    expect(authed.status).toBe(200);
  });

  it("requires normal Access auth for setup status after Access is configured", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    const missing = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      env as any,
    );
    expect(missing.status).toBe(401);

    const authed = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      {
        method: "GET",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      env as any,
    );
    expect(authed.status).toBe(200);
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
      {
        ...env,
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      } as unknown as Record<string, unknown>,
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
