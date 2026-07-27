import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateAccessRequest,
  authenticateCanonicalOwner,
  authMiddleware,
} from "../auth";
import {
  clearWorkersDevAccessTrustCache,
  readWorkersDevAccessTrust,
} from "../workers-dev-access/records";
import type { Env } from "../types";
import type { HonoEnv } from "../types";
import type {
  WorkersDevAccessCredentialV1,
  WorkersDevAccessTrustV1,
} from "../workers-dev-access/types";

const trust: WorkersDevAccessTrustV1 = {
  version: 1,
  ownerEmail: "owner@example.com",
  accountId: "account-1",
  workerName: "demo",
  workersDevHostname: "demo.preview.workers.dev",
  issuer: "https://team.cloudflareaccess.com",
  audience: "audience-1",
  serviceTokenId: "token-1",
  serviceClientId: "service-client.access",
  configuredAt: "2026-07-16T00:00:00.000Z",
};

const credential: WorkersDevAccessCredentialV1 = {
  version: 1,
  currentSecret: "secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

let privateKey: CryptoKey;
let unrelatedPrivateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

function envFor(canonical: WorkersDevAccessTrustV1 | null = trust): Env {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        getAllConfig: vi.fn(async () => ({})),
        getWorkersDevAccessTrust: vi.fn(async (hostname: string) => (
          canonical?.workersDevHostname === hostname ? canonical : null
        )),
        getWorkersDevAccessCredential: vi.fn(async () => credential),
        getWorkersDevAccessLifecycle: vi.fn(async () => ({
          configured: Boolean(canonical),
          workersDevHostname: canonical?.workersDevHostname ?? null,
          tokenExpiresAt: canonical ? credential.tokenExpiresAt : null,
          renewalRecommended: false,
        })),
      })),
    },
  } as unknown as Env;
}

interface TokenOptions {
  issuer?: string | null;
  audience?: string | null;
  issuedAt?: number | null;
  expiresAt?: number | null;
  notBefore?: number;
  signingKey?: CryptoKey;
}

async function token(
  claims: Record<string, unknown>,
  options: TokenOptions = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1_000);
  const issuer = options.issuer === undefined ? trust.issuer : options.issuer;
  const audience = options.audience === undefined ? trust.audience : options.audience;
  const issuedAt = options.issuedAt === undefined ? now : options.issuedAt;
  const expiresAt = options.expiresAt === undefined ? now + 300 : options.expiresAt;
  let jwt = new SignJWT({ type: "app", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" });
  if (issuer !== null) jwt = jwt.setIssuer(issuer);
  if (audience !== null) jwt = jwt.setAudience(audience);
  if (issuedAt !== null) jwt = jwt.setIssuedAt(issuedAt);
  if (expiresAt !== null) jwt = jwt.setExpirationTime(expiresAt);
  if (options.notBefore !== undefined) jwt = jwt.setNotBefore(options.notBefore);
  return jwt.sign(options.signingKey ?? privateKey);
}

function request(assertion: string): Request {
  return new Request("https://demo.preview.workers.dev/api/sessions", {
    headers: { "Cf-Access-Jwt-Assertion": assertion },
  });
}

async function ownerAssertion(): Promise<string> {
  return token({ email: trust.ownerEmail, sub: "user" });
}

function customDomainRequest(assertion: string, path = "/api/setup"): Request {
  return new Request(`https://tiller.example.com${path}`, {
    method: "POST",
    headers: { "Cf-Access-Jwt-Assertion": assertion },
  });
}

function customDomainEnv(canonical: WorkersDevAccessTrustV1 | null = trust): Env {
  return {
    ...envFor(canonical),
    HUB_PUBLIC_URL: "https://tiller.example.com",
    CF_ACCESS_AUD: trust.audience,
    CF_ACCESS_TEAM_DOMAIN: trust.issuer,
  } as Env;
}

function authPolicyApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.use("/api/*", authMiddleware);
  app.post("/api/setup", (c) => c.json({ ok: true }));
  app.get("/api/setup/status", (c) => c.json({ ok: true }));
  app.get("/api/execution/status", (c) => c.json({ ok: true }));
  app.put("/api/settings/execution-backend", (c) => c.json({ ok: true }));
  app.get("/api/settings/legacy-custom-domain-cleanup", (c) => c.json({ ok: true }));
  app.post("/api/envs/demo/boot-progress", (c) => c.json({ ok: true }));
  for (const path of [
    "/api/github/webhook",
    "/api/setup/workers-dev-access/broker/proof",
    "/api/setup/workers-dev-access/broker/complete",
  ]) {
    app.post(path, (c) => c.json({ ok: true }));
    app.post(`${path}/extra`, (c) => c.json({ ok: true }));
  }
  return app;
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  const unrelatedKeys = await generateKeyPair("RS256");
  privateKey = keys.privateKey;
  unrelatedPrivateKey = unrelatedKeys.privateKey;
  publicJwk = { ...await exportJWK(keys.publicKey), kid: "test-key", alg: "RS256", use: "sig" };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [publicJwk] })));
});

beforeEach(() => clearWorkersDevAccessTrustCache());

describe("canonical workers.dev signed principals", () => {
  it("classifies only the exact signed owner email", async () => {
    await expect(authenticateAccessRequest(
      request(await token({ email: "OWNER@example.com", identity_nonce: "nonce", sub: "user" })),
      envFor(),
    )).resolves.toEqual({ kind: "owner", email: "owner@example.com" });
    await expect(authenticateAccessRequest(
      request(await token({ email: "other@example.com", identity_nonce: "nonce", sub: "user" })),
      envFor(),
    )).rejects.toThrow(/not authorized/i);
  });

  it("classifies only the matching service-token common name", async () => {
    await expect(authenticateAccessRequest(
      request(await token({ common_name: trust.serviceClientId, sub: "" })),
      envFor(),
    )).resolves.toEqual({ kind: "service" });
    await expect(authenticateAccessRequest(
      request(await token({ common_name: "different.access", sub: "" })),
      envFor(),
    )).rejects.toThrow(/not authorized/i);
  });

  it("rejects ambiguous and incomplete signed identities", async () => {
    await expect(authenticateAccessRequest(
      request(await token({ email: trust.ownerEmail, common_name: trust.serviceClientId })),
      envFor(),
    )).rejects.toThrow(/not authorized/i);
    await expect(authenticateAccessRequest(request(await token({ sub: "" })), envFor()))
      .rejects.toThrow(/not authorized/i);
  });

  it.each([
    ["wrong issuer", { issuer: "https://other.cloudflareaccess.com" }],
    ["wrong audience", { audience: "other-audience" }],
    ["missing issued-at", { issuedAt: null }],
    ["missing expiration", { expiresAt: null }],
    ["expired", { expiresAt: Math.floor(Date.now() / 1_000) - 1 }],
    ["future issued-at", { issuedAt: Math.floor(Date.now() / 1_000) + 120 }],
    ["future not-before", { notBefore: Math.floor(Date.now() / 1_000) + 120 }],
  ] as const)("rejects an application JWT with %s", async (_label, options) => {
    const assertion = await token({ email: trust.ownerEmail, sub: "user" }, options);
    await expect(authenticateAccessRequest(request(assertion), envFor()))
      .rejects.toThrow(/invalid jwt/i);
  });

  it("rejects the wrong token type and an invalid signature", async () => {
    const [wrongType, invalidSignature] = await Promise.all([
      token({ type: "org", email: trust.ownerEmail, sub: "user" }),
      token(
        { email: trust.ownerEmail, sub: "user" },
        { signingKey: unrelatedPrivateKey },
      ),
    ]);

    await expect(authenticateAccessRequest(request(wrongType), envFor()))
      .rejects.toThrow(/invalid jwt/i);
    await expect(authenticateAccessRequest(request(invalidSignature), envFor()))
      .rejects.toThrow(/invalid jwt/i);
  });

  it("rejects canonical owner assertions presented on a custom domain", async () => {
    await expect(authenticateCanonicalOwner(
      customDomainRequest(await token({ email: "OWNER@example.com", sub: "user" })),
      customDomainEnv(),
    )).rejects.toThrow(/canonical workers\.dev access trust is not configured/i);

    await expect(authenticateCanonicalOwner(
      customDomainRequest(await token({ email: "other@example.com", sub: "user" })),
      customDomainEnv(),
    )).rejects.toThrow(/canonical workers\.dev access trust is not configured/i);
  });

  it("rejects custom-domain owner authentication without canonical trust", async () => {
    const signedBrowser = customDomainRequest(await token({ email: "owner@example.com", sub: "user" }));
    await expect(authenticateCanonicalOwner(
      signedBrowser,
      customDomainEnv(null),
    )).rejects.toThrow(/canonical workers\.dev access trust is not configured/i);
  });

  it("preserves explicit localhost owner behavior", async () => {
    await expect(authenticateCanonicalOwner(
      new Request("http://localhost:5173/api/setup", { method: "POST" }),
      { LOCAL_DEV_ONLY_BACKEND: "1" } as Env,
    )).resolves.toEqual({ kind: "local-dev" });
  });

  it("does not trust a loopback hostname without explicit local development mode", async () => {
    const request = new Request("http://127.0.0.1/api/setup", { method: "POST" });
    await expect(authenticateAccessRequest(request, {} as Env))
      .rejects.toThrow(/canonical workers\.dev access trust is not configured/i);
    await expect(authenticateCanonicalOwner(request, {} as Env))
      .rejects.toThrow(/canonical workers\.dev access trust is not configured/i);
  });

  it("does not classify an unprotected production request as local development", async () => {
    const env = {
      ...envFor(null),
      LOCAL_DEV_ONLY_BACKEND: "1",
      HUB_PUBLIC_URL: "https://tiller.example.com",
    } as Env;
    const productionRequest = new Request("https://tiller.example.com/api/sessions");

    await expect(authenticateAccessRequest(productionRequest, env))
      .rejects.toThrow(/canonical workers\.dev access trust is not configured/i);
    await expect(authenticateCanonicalOwner(productionRequest, env))
      .rejects.toThrow(/canonical workers\.dev access trust is not configured/i);
  });
});

describe("owner-only Settings policy", () => {
  it("keeps callback destination descendants closed at the Worker boundary", async () => {
    const app = authPolicyApp();
    const paths = [
      "/api/github/webhook",
      "/api/setup/workers-dev-access/broker/proof",
      "/api/setup/workers-dev-access/broker/complete",
    ];

    for (const path of paths) {
      const exact = await app.request(
        `https://demo.preview.workers.dev${path}`,
        { method: "POST" },
        envFor() as HonoEnv["Bindings"],
      );
      const descendant = await app.request(
        `https://demo.preview.workers.dev${path}/extra`,
        { method: "POST" },
        envFor() as HonoEnv["Bindings"],
      );

      expect(exact.status).toBe(200);
      expect(descendant.status).toBe(401);
    }
  });

  it("keeps owner-only setup routes closed on an unprotected custom domain", async () => {
    const response = await authPolicyApp().request(
      "https://tiller.example.com/api/setup",
      { method: "POST" },
      {
        ...envFor(null),
        HUB_PUBLIC_URL: "https://tiller.example.com",
      } as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(403);
  });

  it("allows the exact signed owner to mutate Settings", async () => {
    const response = await authPolicyApp().request(
      "https://demo.preview.workers.dev/api/setup",
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await token({ email: trust.ownerEmail, sub: "user" }) },
      },
      envFor() as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(200);
  });

  it("rejects a valid signed service principal from Settings mutations", async () => {
    const response = await authPolicyApp().request(
      "https://demo.preview.workers.dev/api/setup",
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await token({ common_name: trust.serviceClientId, sub: "" }),
        },
      },
      envFor() as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(401);
  });

  it.each([
    ["GET", "/api/execution/status"],
    ["PUT", "/api/settings/execution-backend"],
    ["GET", "/api/settings/legacy-custom-domain-cleanup"],
  ])("keeps execution Settings owner-only for %s %s", async (method, path) => {
    const app = authPolicyApp();
    const service = await app.request(
      `https://demo.preview.workers.dev${path}`,
      {
        method,
        headers: {
          "Cf-Access-Jwt-Assertion": await token({
            common_name: trust.serviceClientId,
            sub: "",
          }),
        },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(service.status).toBe(401);

    const owner = await app.request(
      `https://demo.preview.workers.dev${path}`,
      {
        method,
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(owner.status).toBe(200);
  });

  it("keeps redacted setup status and runtime callbacks available to the service principal", async () => {
    const assertion = await token({ common_name: trust.serviceClientId, sub: "" });
    const app = authPolicyApp();
    const [statusResponse, runtimeResponse] = await Promise.all([
      app.request(
        "https://demo.preview.workers.dev/api/setup/status",
        { headers: { "Cf-Access-Jwt-Assertion": assertion } },
        envFor() as HonoEnv["Bindings"],
      ),
      app.request(
        "https://demo.preview.workers.dev/api/envs/demo/boot-progress",
        { method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion } },
        envFor() as HonoEnv["Bindings"],
      ),
    ]);

    expect(statusResponse.status).toBe(200);
    expect(runtimeResponse.status).toBe(200);
  });
});

describe("canonical workers.dev trust cache", () => {
  it("does not negatively cache an unconfigured hostname", async () => {
    await expect(readWorkersDevAccessTrust(envFor(null), trust.workersDevHostname)).resolves.toBeNull();
    await expect(readWorkersDevAccessTrust(envFor(trust), trust.workersDevHostname)).resolves.toEqual(trust);
  });

  it("keys positive trust by the exact hostname", async () => {
    await expect(readWorkersDevAccessTrust(envFor(trust), trust.workersDevHostname)).resolves.toEqual(trust);
    await expect(readWorkersDevAccessTrust(envFor(trust), "other.preview.workers.dev")).resolves.toBeNull();
    await expect(readWorkersDevAccessTrust(envFor(trust), "tiller.example.com")).resolves.toBeNull();
  });
});
