import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  getIdleTimeoutMinutes: vi.fn(async () => 10),
  invalidateConfigCache: vi.fn(),
}));

vi.mock("../setup/cloudflare", () => ({
  detachWorkerCustomDomain: vi.fn(),
  disableWorkerDevAlias: vi.fn(),
  ensureWorkerCustomDomain: vi.fn(),
  resolveWorkerServiceName: vi.fn(async () => "tiller-hub"),
  verifyWorkerDomainAccess: vi.fn(),
}));

vi.mock("../access/cloudflare-api", () => ({
  resolveAccountForHostname: vi.fn(),
  listAccessApps: vi.fn(async () => []),
  listServiceTokens: vi.fn(async () => []),
}));

vi.mock("../access/manage", () => ({
  assertNoUnsupportedWildcardCoverage: vi.fn(),
  buildPersistedManagedAccessConfig: vi.fn(),
  cleanupSupersededManagedHubAccess: vi.fn(),
  findExactAndWildcardApps: vi.fn(() => ({ exact: null, wildcard: null })),
  persistManagedAccessConfig: vi.fn(),
  prepareManagedExactHostAccess: vi.fn(),
  readManagedAccessConfigSnapshot: vi.fn(),
  restoreManagedAccessConfigSnapshot: vi.fn(),
}));

const { resolveSetupStatus } = vi.hoisted(() => ({
  resolveSetupStatus: vi.fn(async () => ({
    needsSetup: true,
    setupPhase: "model-access",
    isLocalDev: false,
    currentOrigin: "https://demo.preview.workers.dev",
    hubUrl: "https://demo.preview.workers.dev",
    deploymentMode: "hosted",
    routeKind: "workers-dev",
    hostKind: "workers-dev",
    accessConfigured: true,
  })),
}));

vi.mock("../setup/status-resolver", () => ({
  resolveSetupStatus,
}));

import setupRoutes from "../setup/routes";
import { authMiddleware } from "../auth";
import { ACCESS_CONFIG_CLAIM_KEYS } from "../access/config-keys";

const originalFetch = globalThis.fetch;

function createApp(options: { auth?: boolean } = {}) {
  const app = new Hono<HonoEnv>();
  if (options.auth) {
    app.use("/api/*", authMiddleware);
  }
  app.route("/", setupRoutes);
  app.get("/api/protected", (c) => c.json({ ok: true }));
  return app;
}

function createEnv(config: Record<string, string> = {}) {
  const stored = { ...config };
  const claimWorkersDevAccessConfig = vi.fn((input: { audience: string; teamDomain: string }) => {
    if (ACCESS_CONFIG_CLAIM_KEYS.some((key) => stored[key]?.trim())) {
      return {
        claimed: false,
        audience: stored.CF_ACCESS_AUD || null,
        teamDomain: stored.CF_ACCESS_TEAM_DOMAIN || null,
      };
    }

    stored.CF_ACCESS_CONFIGURED = "true";
    stored.CF_ACCESS_AUD = input.audience;
    stored.CF_ACCESS_TEAM_DOMAIN = input.teamDomain;
    stored.CF_ACCESS_JWKS_URL = "";
    return {
      claimed: true,
      audience: input.audience,
      teamDomain: input.teamDomain,
    };
  });

  return {
    stored,
    env: {
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      ...config,
      HUB: {
        idFromName: vi.fn(() => "hub"),
        get: vi.fn(() => ({
          getConfig: vi.fn((key: string) => stored[key] || undefined),
          setConfig: vi.fn((key: string, value: string) => {
            stored[key] = value;
          }),
          claimWorkersDevAccessConfig,
        })),
      },
    },
    claimWorkersDevAccessConfig,
  };
}

async function createAccessJwt(options: {
  issuer?: string;
  audience?: string | string[];
  payload?: JWTPayload & Record<string, unknown>;
} = {}): Promise<string> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = `kid-${crypto.randomUUID()}`;
  jwk.alg = "RS256";
  jwk.use = "sig";

  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [jwk] }), {
    headers: { "Content-Type": "application/json" },
  })) as typeof fetch;

  const issuer = options.issuer ?? `https://team-${crypto.randomUUID()}.cloudflareaccess.com`;
  const audience = options.audience ?? "aud-123";
  const builder = new SignJWT({
    type: "app",
    ...(options.payload ?? {}),
  })
    .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime("2h");

  if (Array.isArray(audience) || audience) {
    builder.setAudience(audience);
  }

  return await builder.sign(privateKey);
}

describe("POST /api/setup/workers-dev-access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("auto-claims an Access-authenticated workers.dev request before blocking normal APIs", async () => {
    const issuer = `https://paperwing-auto-${crypto.randomUUID()}.cloudflareaccess.com`;
    const token = await createAccessJwt({
      issuer,
      audience: "aud-123",
    });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv();
    const res = await createApp({ auth: true }).request(
      "https://demo.preview.workers.dev/api/protected",
      {
        headers: { "Cf-Access-Jwt-Assertion": token },
      },
      env as any,
    );

    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(claimWorkersDevAccessConfig).toHaveBeenCalledWith({
      audience: "aud-123",
      teamDomain: issuer,
    });
    expect(stored).toMatchObject({
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud-123",
      CF_ACCESS_TEAM_DOMAIN: issuer,
    });
  });

  it("claims an empty workers.dev hub from the current Cloudflare Access JWT", async () => {
    const token = await createAccessJwt({
      issuer: "https://paperwing.cloudflareaccess.com",
      audience: "aud-123",
    });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv();
    const res = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
      },
      env as any,
    );

    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(claimWorkersDevAccessConfig).toHaveBeenCalledWith({
      audience: "aud-123",
      teamDomain: "https://paperwing.cloudflareaccess.com",
    });
    expect(stored).toMatchObject({
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud-123",
      CF_ACCESS_TEAM_DOMAIN: "https://paperwing.cloudflareaccess.com",
    });
    expect(body).toMatchObject({
      ok: true,
      status: { setupPhase: "model-access" },
    });
  });

  it("claims the current workers.dev route even when HUB_PUBLIC_URL points elsewhere", async () => {
    const issuer = `https://paperwing-${crypto.randomUUID()}.cloudflareaccess.com`;
    const token = await createAccessJwt({
      issuer,
      audience: "aud-123",
    });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv({
      HUB_PUBLIC_URL: "https://tiller.example.com",
    });
    const res = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
      },
      env as any,
    );

    const body = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(claimWorkersDevAccessConfig).toHaveBeenCalledWith({
      audience: "aud-123",
      teamDomain: issuer,
    });
    expect(stored).toMatchObject({
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud-123",
      CF_ACCESS_TEAM_DOMAIN: issuer,
    });
    expect(body).toMatchObject({ ok: true });
  });

  it("rejects missing, malformed, non-Access, missing-AUD, and multiple-AUD JWTs", async () => {
    const app = createApp();

    const missing = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      { method: "POST" },
      createEnv().env as any,
    );
    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ code: "missing_access_jwt" });

    const malformed = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" } },
      createEnv().env as any,
    );
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({ code: "invalid_access_jwt" });

    const nonAccess = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await createAccessJwt({
            issuer: "https://issuer.example.com",
            audience: "aud-123",
          }),
        },
      },
      createEnv().env as any,
    );
    expect(nonAccess.status).toBe(400);

    const wrongType = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await createAccessJwt({
            audience: "aud-123",
            payload: { type: "org" },
          }),
        },
      },
      createEnv().env as any,
    );
    expect(wrongType.status).toBe(400);

    const missingAud = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await createAccessJwt({ audience: "" }),
        },
      },
      createEnv().env as any,
    );
    expect(missingAud.status).toBe(400);

    const multipleAud = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await createAccessJwt({ audience: ["aud-1", "aud-2"] }),
        },
      },
      createEnv().env as any,
    );
    expect(multipleAud.status).toBe(400);
  });

  it("does not accept manual Access metadata in the claim body", async () => {
    const token = await createAccessJwt();
    const res = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": token,
        },
        body: JSON.stringify({ aud: "manual-aud" }),
      },
      createEnv().env as any,
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "body_not_supported" });
  });

  it("does not overwrite partial existing Access config during claim", async () => {
    const token = await createAccessJwt({
      issuer: "https://paperwing.cloudflareaccess.com",
      audience: "aud-123",
    });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv({
      CF_ACCESS_AUD: "existing-aud",
    });
    const res = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
      },
      env as any,
    );

    expect(res.status).toBe(409);
    expect(claimWorkersDevAccessConfig).not.toHaveBeenCalled();
    expect(stored.CF_ACCESS_AUD).toBe("existing-aud");
    expect(stored.CF_ACCESS_TEAM_DOMAIN).toBeUndefined();
  });

  it("does not claim over partial managed Access metadata", async () => {
    const token = await createAccessJwt({
      issuer: "https://paperwing.cloudflareaccess.com",
      audience: "aud-123",
    });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv({
      CF_ACCESS_APP_ID: "existing-app",
    });
    const res = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
      },
      env as any,
    );

    expect(res.status).toBe(409);
    expect(claimWorkersDevAccessConfig).not.toHaveBeenCalled();
    expect(stored.CF_ACCESS_APP_ID).toBe("existing-app");
    expect(stored.CF_ACCESS_AUD).toBeUndefined();
  });

  it("does not treat unrelated gateway metadata as hub Access config", async () => {
    const token = await createAccessJwt({
      issuer: "https://paperwing-gateway-test.cloudflareaccess.com",
      audience: "aud-123",
    });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv({
      TILLER_GATEWAY_TUNNEL_ID: "leftover-tunnel",
    });
    const res = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": token },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(claimWorkersDevAccessConfig).toHaveBeenCalledOnce();
    expect(stored).toMatchObject({
      TILLER_GATEWAY_TUNNEL_ID: "leftover-tunnel",
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "aud-123",
      CF_ACCESS_TEAM_DOMAIN: "https://paperwing-gateway-test.cloudflareaccess.com",
    });
  });

  it("is idempotent after Access config exists and does not overwrite issuer or audience", async () => {
    const app = createApp({ auth: true });
    const { env, stored, claimWorkersDevAccessConfig } = createEnv({
      CF_ACCESS_CONFIGURED: "true",
      CF_ACCESS_AUD: "existing-aud",
      CF_ACCESS_TEAM_DOMAIN: "https://existing.cloudflareaccess.com",
      CF_ACCESS_CLIENT_ID: "client-id.access",
      CF_ACCESS_CLIENT_SECRET: "client-secret",
    });

    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/workers-dev-access",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(claimWorkersDevAccessConfig).not.toHaveBeenCalled();
    expect(stored.CF_ACCESS_AUD).toBe("existing-aud");
    expect(stored.CF_ACCESS_TEAM_DOMAIN).toBe("https://existing.cloudflareaccess.com");
  });
});
