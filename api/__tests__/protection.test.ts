import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateAccessRequest,
  authMiddleware,
  hubAuthGuardResponse,
} from "../auth";
import {
  hasEnabledHarnessModelAuth,
  resolveModelAuthState,
  resolveProtectionState,
} from "../protection";
import voiceRoutes from "../voice/routes";
import type { Env, HonoEnv } from "../types";
import type {
  WorkersDevAccessRuntimeCredential,
  WorkersDevAccessRuntimeTrust,
} from "../workers-dev-access/types";
import {
  installedAccessBindings,
  TEST_WORKERS_DEV_HOSTNAME,
} from "./access-binding-fixture";

const { getOpenAIAuthStatus } = vi.hoisted(() => ({
  getOpenAIAuthStatus: vi.fn(async () => ({
    authenticated: false,
    status: "missing",
  })),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) =>
    env[key] || undefined,
  invalidateConfigCache: vi.fn(),
}));

vi.mock("../openai-auth", () => ({
  getStatus: getOpenAIAuthStatus,
}));

const canonicalTrust: WorkersDevAccessRuntimeTrust = {
  ownerEmail: "owner@example.com",
  workersDevHostname: TEST_WORKERS_DEV_HOSTNAME,
  issuer: "https://team.cloudflareaccess.com",
  audience: "aud",
  serviceClientId: "client-id.access",
};

const canonicalCredential: WorkersDevAccessRuntimeCredential = {
  currentSecret: "client-secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
};

function mockEnv(
  overrides: Record<string, unknown> = {},
  access: {
    trust?: WorkersDevAccessRuntimeTrust | null;
    credential?: WorkersDevAccessRuntimeCredential | null;
  } = {},
): Env {
  const fetchSpy = vi.fn(async () => new Response("ok", { status: 200 }));
  const trust = access.trust ?? null;
  const credential = access.credential ?? null;
  return {
    ...(trust && credential
      ? installedAccessBindings({
          hostname: trust.workersDevHostname,
          issuer: trust.issuer,
          audience: trust.audience,
          serviceClientId: trust.serviceClientId,
          serviceClientSecret: credential.currentSecret,
          ownerEmail: trust.ownerEmail,
          tokenExpiresAt: credential.tokenExpiresAt,
        })
      : {}),
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        getConfig: vi.fn(async () => undefined),
      })),
    },
    TILLER_VOICE: {
      idFromName: vi.fn(() => "voice-id"),
      get: vi.fn(() => ({ fetch: fetchSpy })),
    },
    ...overrides,
  } as unknown as Env;
}

describe("resolveModelAuthState", () => {
  beforeEach(() => {
    getOpenAIAuthStatus.mockResolvedValue({
      authenticated: false,
      status: "missing",
    });
  });

  it("treats either Claude subscription or Anthropic API auth as configured", async () => {
    await expect(
      resolveModelAuthState(
        mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
      ),
    ).resolves.toMatchObject({
      configured: true,
      hasClaudeSubscription: true,
    });

    await expect(
      resolveModelAuthState(mockEnv({ ANTHROPIC_API_KEY: "api-key" })),
    ).resolves.toMatchObject({
      configured: true,
      hasAnthropicKey: true,
    });
  });

  it("tracks OpenAI credentials separately", async () => {
    await expect(
      resolveModelAuthState(mockEnv({ OPENAI_API_KEY: "openai-key" })),
    ).resolves.toMatchObject({
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
    getOpenAIAuthStatus.mockResolvedValue({
      authenticated: true,
      status: "connected",
    });

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

  it("accepts connected subscriptions for Cloudflare Container workloads", () => {
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: false,
          hasAnthropicKey: false,
          hasChatGPTAuth: true,
          hasOpenAIKey: false,
        },
        ["codex"],
        "cf",
      ),
    ).toBe(true);
    expect(
      hasEnabledHarnessModelAuth(
        {
          hasClaudeSubscription: true,
          hasAnthropicKey: false,
          hasChatGPTAuth: false,
          hasOpenAIKey: false,
        },
        ["claude-code"],
        "cf",
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
      HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
      CF_ACCESS_AUD: "aud",
      CF_ACCESS_CLIENT_ID: "client-id",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    await expect(
      resolveProtectionState(
        env,
        "https://tiller.preview.workers.dev/api/setup/status",
      ),
    ).resolves.toMatchObject({
      protectionMode: "public",
      serviceTokenConfigured: false,
      accessConfigured: false,
    });
  });

  it("supports Access-protected workers.dev routes", async () => {
    const env = mockEnv(
      {},
      { trust: canonicalTrust, credential: canonicalCredential },
    );

    await expect(
      resolveProtectionState(
        env,
        "https://tiller.preview.workers.dev/api/setup/status",
      ),
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
      resolveProtectionState(
        env,
        "https://tiller.example.com/api/setup/status",
      ),
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
      HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
      CF_ACCESS_AUD: "aud",
    });
    const request = new Request(
      "https://tiller.preview.workers.dev/api/sessions",
      {
        headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
      },
    );

    await expect(authenticateAccessRequest(request, env)).rejects.toThrow(
      "Canonical workers.dev Access trust is not configured",
    );
  });

  it("validates workers.dev Access JWTs when Access is configured", async () => {
    const env = mockEnv(
      {},
      { trust: canonicalTrust, credential: canonicalCredential },
    );
    const request = new Request(
      "https://tiller.preview.workers.dev/api/sessions",
      {
        headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" },
      },
    );

    await expect(authenticateAccessRequest(request, env)).rejects.toThrow(
      "Malformed JWT",
    );
  });
});

describe("authMiddleware protect-hub guard", () => {
  function createProtectedApp() {
    const app = new Hono<HonoEnv>();
    app.use("/api/*", authMiddleware);
    app.get("/api/setup/status", (c) => c.json({ ok: true }));
    app.post("/api/setup/workers-dev-access/oauth/start", (c) =>
      c.json({ ok: true }),
    );
    app.post("/api/setup", (c) => c.json({ ok: true }));
    app.get("/api/envs", (c) => c.json([]));
    return app;
  }

  it("blocks non-allowlisted APIs on fresh deployed workers.dev hubs", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
    });

    const blocked = await app.request(
      "https://tiller.preview.workers.dev/api/envs",
      {},
      env as any,
    );
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    });

    const setupWrite = await app.request(
      "https://tiller.preview.workers.dev/api/setup",
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
      "https://tiller.preview.workers.dev/api/envs",
      {},
      env as any,
    );
    expect(blocked.status).toBe(403);
    await expect(blocked.json()).resolves.toMatchObject({
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    });
  });

  it("does not expose the retired in-Hub Access bootstrap before installer trust exists", async () => {
    const app = createProtectedApp();
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
    });

    await expect(
      app.request(
        "https://tiller.preview.workers.dev/api/setup/status",
        {},
        env as any,
      ),
    ).resolves.toMatchObject({ status: 403 });
    await expect(
      app.request(
        "https://tiller.preview.workers.dev/api/setup/workers-dev-access/oauth/start",
        { method: "POST" },
        env as any,
      ),
    ).resolves.toMatchObject({ status: 403 });
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
      HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
    });

    const agentsBlocked = await hubAuthGuardResponse(
      new Request(
        "https://tiller.preview.workers.dev/agents/reviewer-chat/default",
      ),
      env,
    );
    expect(agentsBlocked?.status).toBe(403);

    const partiesBlocked = await hubAuthGuardResponse(
      new Request("https://tiller.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      env,
    );
    expect(partiesBlocked?.status).toBe(403);
  });

  it("requires normal Access auth for non-API dynamic entrypoints after Access is configured", async () => {
    const env = mockEnv(
      {},
      { trust: canonicalTrust, credential: canonicalCredential },
    );

    const missing = await hubAuthGuardResponse(
      new Request(
        "https://tiller.preview.workers.dev/agents/reviewer-chat/default",
      ),
      env,
    );
    expect(missing?.status).toBe(401);

    const authed = await hubAuthGuardResponse(
      new Request(
        "https://tiller.preview.workers.dev/agents/reviewer-chat/default",
        {
          headers: {
            "CF-Access-Client-Id": "client-id.access",
            "CF-Access-Client-Secret": "client-secret",
          },
        },
      ),
      env,
    );
    expect(authed?.status).toBe(401);
  });

  it("requires normal Access auth for setup writes after workers.dev Access is configured", async () => {
    const app = createProtectedApp();
    const env = mockEnv(
      {},
      { trust: canonicalTrust, credential: canonicalCredential },
    );

    const missing = await app.request(
      "https://tiller.preview.workers.dev/api/setup",
      { method: "POST" },
      env as any,
    );
    expect(missing.status).toBe(401);

    const authed = await app.request(
      "https://tiller.preview.workers.dev/api/setup",
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
    const env = mockEnv(
      {},
      { trust: canonicalTrust, credential: canonicalCredential },
    );

    const missing = await app.request(
      "https://tiller.preview.workers.dev/api/setup/status",
      { method: "GET" },
      env as any,
    );
    expect(missing.status).toBe(401);

    const authed = await app.request(
      "https://tiller.preview.workers.dev/api/setup/status",
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
      TILLER_VOICE: {
        idFromName: vi.fn(() => "voice-id"),
        get: vi.fn(() => ({ fetch: stubFetch })),
      },
    } as unknown as Env;
  });

  function appWithAuthorization(
    authorization: HonoEnv["Variables"]["authorization"],
  ) {
    const app = new Hono<HonoEnv>();
    app.use("/*", async (c, next) => {
      c.set("authorization", authorization);
      await next();
    });
    app.route("/", voiceRoutes);
    return app;
  }

  it("rejects environment authority before selecting a voice session", async () => {
    const res = await appWithAuthorization({
      kind: "environment",
      envSlug: "env-1",
      incarnationId: "incarnation-1",
      startOperationId: "start-1",
    }).request(
      "https://tiller.example.com/api/voice/session?sessionId=session-1",
      { headers: { upgrade: "websocket" } },
      env,
    );

    expect(res.status).toBe(403);
    expect(stubFetch).not.toHaveBeenCalled();
  });

  it("forwards only globally authorized voice sessions", async () => {
    const res = await appWithAuthorization({
      kind: "global",
      source: "owner",
      ownerEmail: "owner@example.com",
    }).request(
      "https://tiller.preview.workers.dev/api/voice/session?sessionId=session-1",
      { headers: { upgrade: "websocket" } },
      env,
    );

    expect(res.status).toBe(200);
    expect(stubFetch).toHaveBeenCalledOnce();
  });
});
