import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateAccessRequest, authMiddleware, dynamicEntrypointAuthResponse } from "../auth";
import { hasEnabledHarnessModelAuth, resolveModelAuthState, resolveProtectionState } from "../protection";
import voiceRoutes from "../voice/routes";
import type { Env, HonoEnv } from "../types";
import { clearWorkersDevAccessTrustCache } from "../workers-dev-access/records";
import type {
  WorkersDevAccessCredentialV1,
  WorkersDevAccessTrustV1,
} from "../workers-dev-access/types";

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

const canonicalTrust: WorkersDevAccessTrustV1 = {
  version: 1,
  ownerEmail: "owner@example.com",
  accountId: "account-1",
  workerName: "demo",
  workersDevHostname: "demo.preview.workers.dev",
  issuer: "https://team.cloudflareaccess.com",
  audience: "aud",
  serviceTokenId: "token-1",
  serviceClientId: "client-id.access",
  configuredAt: "2026-07-16T00:00:00.000Z",
};

const canonicalCredential: WorkersDevAccessCredentialV1 = {
  version: 1,
  currentSecret: "client-secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

function mockEnv(
  overrides: Record<string, unknown> = {},
  access: { trust?: WorkersDevAccessTrustV1 | null; credential?: WorkersDevAccessCredentialV1 | null } = {},
): Env {
  const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
  const trust = access.trust ?? null;
  const credential = access.credential ?? null;
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        getConfig: vi.fn(async () => undefined),
        getWorkersDevAccessTrust: vi.fn(async (hostname: string) => (
          trust?.workersDevHostname === hostname ? trust : null
        )),
        getWorkersDevAccessCredential: vi.fn(async () => credential),
        getWorkersDevAccessLifecycle: vi.fn(async () => ({
          configured: Boolean(trust && credential),
          workersDevHostname: trust?.workersDevHostname ?? null,
          tokenExpiresAt: credential?.tokenExpiresAt ?? null,
          renewalRecommended: false,
        })),
      })),
    },
    TILLER_VOICE: {
      idFromName: vi.fn(() => "voice-id"),
      get: vi.fn(() => ({ fetch: fetchSpy })),
    },
    ...overrides,
  } as unknown as Env;
}

beforeEach(() => clearWorkersDevAccessTrustCache());

describe("resolveModelAuthState", () => {
  beforeEach(() => {
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: false, status: "missing" });
  });

  it("treats either Claude subscription or Anthropic API auth as configured", async () => {
    await expect(resolveModelAuthState(mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }))).resolves.toMatchObject({
      configured: true,
      hasClaudeSubscription: true,
    });

    await expect(resolveModelAuthState(mockEnv({ ANTHROPIC_API_KEY: "api-key" }))).resolves.toMatchObject({
      configured: true,
      hasAnthropicKey: true,
    });
  });

  it("tracks OpenAI credentials separately", async () => {
    await expect(resolveModelAuthState(mockEnv({ OPENAI_API_KEY: "openai-key" }))).resolves.toMatchObject({
      configured: true,
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
    });
  });

  it("tracks ChatGPT auth separately", async () => {
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: true, status: "connected" });

    await expect(resolveModelAuthState(mockEnv())).resolves.toMatchObject({
      configured: true,
      hasChatGPTAuth: true,
    });
  });
});

describe("hasEnabledHarnessModelAuth", () => {
  it("requires a Claude credential when only claude-code is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: true,
        },
        ["claude-code"],
      ),
    ).toBe(false);
  });

  it("accepts an OpenAI key when codex is enabled", () => {
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: true,
        },
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

  it("requires a real OpenCode credential route when opencode is enabled", () => {
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
    ).toBe(false);
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: true,
        },
        ["opencode"],
      ),
    ).toBe(true);
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: false,
          workersAiConfigured: true,
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
      protectionMode: "public",
      serviceTokenConfigured: false,
      accessConfigured: false,
    });
  });

  it("supports Access-protected workers.dev routes", async () => {
    const env = mockEnv({}, { trust: canonicalTrust, credential: canonicalCredential });

    await expect(
      resolveProtectionState(env, "https://demo.preview.workers.dev/api/setup/status"),
    ).resolves.toMatchObject({
      protectionMode: "cf-access",
      serviceTokenConfigured: true,
      accessConfigured: true,
    });
  });

  it("does not trust legacy custom-domain Access configuration", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    await expect(
      resolveProtectionState(env, "https://tiller.example.com/api/setup/status"),
    ).resolves.toMatchObject({
      protectionMode: "public",
      serviceTokenConfigured: false,
      accessConfigured: false,
    });
  });
});

describe("authenticateAccessRequest", () => {
  it("rejects assertions on legacy custom domains", async () => {
    const env = mockEnv({
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    });
    const request = new Request("https://tiller.example.com/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(authenticateAccessRequest(request, env)).rejects.toThrow(
      "Canonical workers.dev Access trust is not configured",
    );
  });

  it("fails closed when canonical workers.dev trust is missing", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      CF_ACCESS_AUD: "aud",
    });
    const request = new Request("https://demo.preview.workers.dev/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(authenticateAccessRequest(request, env)).rejects.toThrow(
      "Canonical workers.dev Access trust is not configured",
    );
  });

  it("validates workers.dev Access JWTs when Access is configured", async () => {
    const env = mockEnv({}, { trust: canonicalTrust, credential: canonicalCredential });
    const request = new Request("https://demo.preview.workers.dev/api/sessions", {
      headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
    });

    await expect(authenticateAccessRequest(request, env)).rejects.toThrow("Malformed JWT");
  });
});

describe("authMiddleware protect-hub guard", () => {
  function createProtectedApp() {
    const app = new Hono<HonoEnv>();
    app.use("/api/*", authMiddleware);
    app.get("/api/setup/status", (c) => c.json({ ok: true }));
    app.post("/api/setup/workers-dev-access/oauth/start", (c) => c.json({ ok: true }));
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

  it("allows only setup status and workers.dev OAuth start during protect-hub", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    });

    await expect(
      app.request("https://demo.preview.workers.dev/api/setup/status", {}, env as any),
    ).resolves.toMatchObject({ status: 200 });
    await expect(
      app.request(
        "https://demo.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
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
      mockEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }) as any,
    );

    expect(res.status).toBe(200);
  });

  it("keeps localhost non-setup APIs relaxed even when Access config exists", async () => {
    const app = createProtectedApp();
    const res = await app.request(
      "http://localhost:5173/api/envs",
      { method: "GET" },
      mockEnv({
        LOCAL_DEV_ONLY_BACKEND: "1",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      }) as any,
    );

    expect(res.status).toBe(200);
  });

  it("fails closed for setup writes on unsupported custom domains", async () => {
    const app = createProtectedApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup",
      { method: "POST" },
      mockEnv({
        HUB_PUBLIC_URL: "https://tiller.example.com",
      }) as any,
    );

    expect(res.status).toBe(403);
  });

  it("blocks non-API dynamic entrypoints during protect-hub", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    });

    const agentsBlocked = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default"),
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
    const env = mockEnv({}, { trust: canonicalTrust, credential: canonicalCredential });

    const missing = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default"),
      env,
    );
    expect(missing?.status).toBe(401);

    const authed = await dynamicEntrypointAuthResponse(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default", {
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      }),
      env,
    );
    expect(authed?.status).toBe(401);
  });

  it("requires normal Access auth for setup writes after workers.dev Access is configured", async () => {
    const app = createProtectedApp();
    const env = mockEnv({}, { trust: canonicalTrust, credential: canonicalCredential });

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
    expect(authed.status).toBe(401);
  });

  it("requires normal Access auth for setup status after Access is configured", async () => {
    const app = createProtectedApp();
    const env = mockEnv({}, { trust: canonicalTrust, credential: canonicalCredential });

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
    expect(authed.status).toBe(401);
  });
});

describe("voice access auth", () => {
  let env: Env;
  let stubFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stubFetch = vi.fn(async () => new Response("ok", { status: 200 }));
    env = {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({
          getWorkersDevAccessTrust: vi.fn(async () => null),
          getWorkersDevAccessCredential: vi.fn(async () => null),
          getWorkersDevAccessLifecycle: vi.fn(async () => ({
            configured: false,
            workersDevHostname: null,
            tokenExpiresAt: null,
            renewalRecommended: false,
          })),
        })),
      },
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

  it("fails closed for workers.dev voice requests without Access config", async () => {
    const res = await voiceRoutes.request(
      "https://demo.preview.workers.dev/api/voice/session?sessionId=session-1",
      {
        headers: {
          upgrade: "websocket",
        },
      },
      env as unknown as Record<string, unknown>,
    );

    expect(res.status).toBe(401);
    expect(stubFetch).not.toHaveBeenCalled();
  });
});
