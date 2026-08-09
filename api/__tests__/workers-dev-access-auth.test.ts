import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Hono } from "hono";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  authenticateAccessRequest,
  authenticateCanonicalOwner,
  authMiddleware,
} from "../auth";
import {
  readWorkersDevAccessCredential,
  readWorkersDevAccessLifecycle,
  readWorkersDevAccessTrust,
} from "../workers-dev-access/records";
import type { Env } from "../types";
import type { HonoEnv } from "../types";
import type {
  WorkersDevAccessRuntimeCredential,
  WorkersDevAccessRuntimeTrust,
} from "../workers-dev-access/types";
import {
  installedAccessBindings,
  maintainerDevAccessBindings,
  TEST_MAINTAINER_DEV_HOSTNAME,
  TEST_WORKERS_DEV_HOSTNAME,
} from "./access-binding-fixture";

const trust: WorkersDevAccessRuntimeTrust = {
  ownerEmail: "owner@example.com",
  workersDevHostname: TEST_WORKERS_DEV_HOSTNAME,
  issuer: "https://team.cloudflareaccess.com",
  audience: "audience-1",
  serviceClientId: "service-client.access",
};

const credential: WorkersDevAccessRuntimeCredential = {
  currentSecret: "secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
};

const bindingTrust = {
  ownerEmail: trust.ownerEmail,
  workersDevHostname: trust.workersDevHostname,
  issuer: trust.issuer,
  audience: trust.audience,
  serviceClientId: trust.serviceClientId,
};

let privateKey: CryptoKey;
let unrelatedPrivateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

function envFor(canonical: WorkersDevAccessRuntimeTrust | null = trust): Env {
  return {
    ...(canonical ? installedAccessBindings({
      hostname: canonical.workersDevHostname,
      issuer: canonical.issuer,
      audience: canonical.audience,
      serviceClientId: canonical.serviceClientId,
      serviceClientSecret: credential.currentSecret,
      ownerEmail: canonical.ownerEmail,
      tokenExpiresAt: credential.tokenExpiresAt,
    }) : {}),
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        getAllConfig: vi.fn(async () => ({})),
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
  return new Request(`https://${TEST_WORKERS_DEV_HOSTNAME}/api/sessions`, {
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

function customDomainEnv(canonical: WorkersDevAccessRuntimeTrust | null = trust): Env {
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
  app.get("/api/auth/openai/status", (c) => c.json({ ok: true }));
  app.post("/api/cli/auth-connect-package", (c) => c.json({ ok: true }));
  app.post("/api/auth/subscriptions/codex/connect", (c) => c.json({ ok: true }));
  app.post("/api/auth/subscriptions/claude/connect", (c) => c.json({ ok: true }));
  app.post("/api/update/hub-repo/detect", (c) => c.json({ ok: true }));
  app.post("/api/update/hub-repo/select", (c) => c.json({ ok: true }));
  app.post("/api/update/apply", (c) => c.json({ ok: true }));
  app.post("/api/update/repair/cloudflare-redeploy", (c) => c.json({ ok: true }));
  app.put("/api/settings/execution-backend", (c) => c.json({ ok: true }));
  app.get("/api/settings/legacy-custom-domain-cleanup", (c) => c.json({ ok: true }));
  app.post("/api/envs/demo/boot-progress", (c) => c.json({ ok: true }));
  app.post("/api/sessions/:id/permissions/:permId", (c) => c.json({ ok: true }));
  app.get("/api/github/status", (c) => c.json({ ok: true }));
  app.post("/api/github/test-access", (c) => c.json({ ok: true }));
  app.get("/api/github/repositories", (c) => c.json({ ok: true }));
  app.get("/api/github/token", (c) => c.json({ ok: true }));
  app.get("/api/repos", (c) => c.json({ ok: true }));
  app.post("/api/repos", (c) => c.json({ ok: true }));
  app.get("/api/repos/:repoId", (c) => c.json({ ok: true }));
  app.delete("/api/repos/:repoId", (c) => c.json({ ok: true }));
  app.get("/api/repos/:repoId/artifacts", (c) => c.json({ ok: true }));
  app.get("/api/repos/:repoId/planner-providers", (c) => c.json({ ok: true }));
  app.get("/api/repos/:repoId/session-env", (c) => c.json({ ok: true }));
  app.patch("/api/repos/:repoId/session-env", (c) => c.json({ ok: true }));
  app.get("/api/repos/:repoId/mcp-servers", (c) => c.json({ ok: true }));
  app.put("/api/repos/:repoId/mcp-servers", (c) => c.json({ ok: true }));
  app.post("/api/repos/:repoId/cloudflare-mcp/connect", (c) => c.json({ ok: true }));
  app.post("/api/repos/:repoId/skills", (c) => c.json({ ok: true }));
  app.put("/api/repos/:repoId/plan-writer-settings", (c) => c.json({ ok: true }));
  for (const path of ["/api/github/webhook"]) {
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
    const paths = ["/api/github/webhook"];

    for (const path of paths) {
      const exact = await app.request(
        `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
        { method: "POST" },
        envFor() as HonoEnv["Bindings"],
      );
      const descendant = await app.request(
        `https://${TEST_WORKERS_DEV_HOSTNAME}${path}/extra`,
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
      `https://${TEST_WORKERS_DEV_HOSTNAME}/api/setup`,
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
      `https://${TEST_WORKERS_DEV_HOSTNAME}/api/setup`,
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
    ["GET", "/api/auth/openai/status"],
    ["POST", "/api/cli/auth-connect-package"],
    ["PUT", "/api/settings/execution-backend"],
    ["GET", "/api/settings/legacy-custom-domain-cleanup"],
    ["POST", "/api/update/hub-repo/detect"],
    ["POST", "/api/update/hub-repo/select"],
    ["POST", "/api/update/apply"],
    ["POST", "/api/update/repair/cloudflare-redeploy"],
  ])("keeps credential and execution Settings owner-only for %s %s", async (method, path) => {
    const app = authPolicyApp();
    const service = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
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
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      {
        method,
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(owner.status).toBe(200);
  });

  it.each([
    "/api/auth/subscriptions/codex/connect",
    "/api/auth/subscriptions/claude/connect",
  ])("allows the service principal to reach grant-protected subscription upload %s", async (path) => {
    const response = await authPolicyApp().request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await token({ common_name: trust.serviceClientId, sub: "" }),
        },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(response.status).toBe(200);
  });

  it("allows service-authenticated setup status and runtime callbacks", async () => {
    const assertion = await token({ common_name: trust.serviceClientId, sub: "" });
    const app = authPolicyApp();
    const [statusResponse, runtimeResponse] = await Promise.all([
      app.request(
        `https://${TEST_WORKERS_DEV_HOSTNAME}/api/setup/status`,
        { headers: { "Cf-Access-Jwt-Assertion": assertion } },
        envFor() as HonoEnv["Bindings"],
      ),
      app.request(
        `https://${TEST_WORKERS_DEV_HOSTNAME}/api/envs/demo/boot-progress`,
        { method: "POST", headers: { "Cf-Access-Jwt-Assertion": assertion } },
        envFor() as HonoEnv["Bindings"],
      ),
    ]);

    expect(statusResponse.status).toBe(200);
    expect(runtimeResponse.status).toBe(200);
  });

  it("keeps permission decisions owner-only while runtimes use the service principal", async () => {
    const app = authPolicyApp();
    const path = "/api/sessions/session-1/permissions/permission-1";
    const service = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      {
        method: "POST",
        headers: {
          "Cf-Access-Jwt-Assertion": await token({ common_name: trust.serviceClientId, sub: "" }),
        },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(service.status).toBe(401);

    const owner = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(owner.status).toBe(200);
  });

  it.each([
    "/api/setup/workers-dev-access/oauth/start",
    "/api/settings/workers-dev-access/oauth/start",
    "/api/setup/workers-dev-access/broker/proof",
    "/api/setup/workers-dev-access/broker/complete",
  ])("authenticates removed Access routes before falling through to not found at %s", async (path) => {
    const app = authPolicyApp();
    const unauthenticated = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      { method: "POST" },
      envFor() as HonoEnv["Bindings"],
    );
    expect(unauthenticated.status).toBe(401);

    const authenticated = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      {
        method: "POST",
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(authenticated.status).toBe(404);
  });

  it("keeps GitHub administration owner-only while preserving capability-gated runtime token access", async () => {
    const app = authPolicyApp();
    const serviceAssertion = await token({ common_name: trust.serviceClientId, sub: "" });
    const owner = await ownerAssertion();

    for (const [method, path] of [
      ["GET", "/api/github/status"],
      ["POST", "/api/github/test-access"],
      ["GET", "/api/github/repositories"],
    ] as const) {
      const service = await app.request(
        `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
        { method, headers: { "Cf-Access-Jwt-Assertion": serviceAssertion } },
        envFor() as HonoEnv["Bindings"],
      );
      expect(service.status).toBe(401);

      const ownerResponse = await app.request(
        `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
        { method, headers: { "Cf-Access-Jwt-Assertion": owner } },
        envFor() as HonoEnv["Bindings"],
      );
      expect(ownerResponse.status).toBe(200);
    }

    const tokenResponse = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}/api/github/token`,
      { headers: { "Cf-Access-Jwt-Assertion": serviceAssertion } },
      envFor() as HonoEnv["Bindings"],
    );
    expect(tokenResponse.status).toBe(200);
  });

  it.each([
    ["POST", "/api/repos"],
    ["DELETE", "/api/repos/repo-1"],
    ["GET", "/api/repos/repo-1/session-env"],
    ["PATCH", "/api/repos/repo-1/session-env"],
    ["GET", "/api/repos/repo-1/mcp-servers"],
    ["PUT", "/api/repos/repo-1/mcp-servers"],
    ["POST", "/api/repos/repo-1/cloudflare-mcp/connect"],
    ["POST", "/api/repos/repo-1/skills"],
    ["PUT", "/api/repos/repo-1/plan-writer-settings"],
  ])("keeps repository administration owner-only for %s %s", async (method, path) => {
    const app = authPolicyApp();
    const service = await app.request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
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
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
      {
        method,
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      },
      envFor() as HonoEnv["Bindings"],
    );
    expect(owner.status).toBe(200);
  });

  it.each([
    ["GET", "/api/repos"],
    ["GET", "/api/repos/repo-1"],
    ["GET", "/api/repos/repo-1/artifacts"],
    ["GET", "/api/repos/repo-1/planner-providers"],
  ])("preserves explicit repository runtime access for %s %s", async (method, path) => {
    const response = await authPolicyApp().request(
      `https://${TEST_WORKERS_DEV_HOSTNAME}${path}`,
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
    expect(response.status).toBe(200);
  });
});

describe("installer binding-backed workers.dev trust", () => {
  it("reads a newly configured binding after an unconfigured environment", async () => {
    await expect(readWorkersDevAccessTrust(envFor(null), trust.workersDevHostname)).resolves.toBeNull();
    await expect(readWorkersDevAccessTrust(envFor(trust), trust.workersDevHostname)).resolves.toEqual(bindingTrust);
  });

  it("matches trust by the exact hostname", async () => {
    await expect(readWorkersDevAccessTrust(envFor(trust), trust.workersDevHostname)).resolves.toEqual(bindingTrust);
    await expect(readWorkersDevAccessTrust(envFor(trust), "other.preview.workers.dev")).resolves.toBeNull();
    await expect(readWorkersDevAccessTrust(envFor(trust), "tiller.example.com")).resolves.toBeNull();
  });

  it("returns unconfigured without reading Hub storage when installer bindings are absent", async () => {
    const get = vi.fn(() => {
      throw new Error("legacy storage must not be read");
    });
    const unconfiguredEnv = {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get,
      },
    } as unknown as Env;

    await expect(readWorkersDevAccessTrust(
      unconfiguredEnv,
      trust.workersDevHostname,
    )).resolves.toBeNull();
    await expect(readWorkersDevAccessCredential(unconfiguredEnv)).resolves.toBeNull();
    await expect(readWorkersDevAccessLifecycle(unconfiguredEnv)).resolves.toEqual({
      configured: false,
      workersDevHostname: null,
      tokenExpiresAt: null,
      renewalRecommended: false,
    });
    expect(get).not.toHaveBeenCalled();
  });

  it("fails closed without reading Hub storage when installer bindings are malformed", async () => {
    const getWorkersDevAccessTrust = vi.fn(async () => trust);
    const env = {
      ...installedAccessBindings(),
      TILLER_RELEASE_ID: "invalid",
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({ getWorkersDevAccessTrust })),
      },
    } as unknown as Env;

    await expect(readWorkersDevAccessTrust(env, trust.workersDevHostname)).resolves.toBeNull();
    expect(getWorkersDevAccessTrust).not.toHaveBeenCalled();
  });

  it("accepts the separate fixed maintainer dev schema", async () => {
    const env = maintainerDevAccessBindings() as unknown as Env;
    await expect(readWorkersDevAccessTrust(env, TEST_MAINTAINER_DEV_HOSTNAME)).resolves.toEqual({
      ownerEmail: "owner@example.com",
      workersDevHostname: TEST_MAINTAINER_DEV_HOSTNAME,
      issuer: "https://team.cloudflareaccess.com",
      audience: "audience-1",
      serviceClientId: "service-client.access",
    });
    await expect(readWorkersDevAccessCredential(env)).resolves.toEqual({
      currentSecret: "service-secret",
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });
  });

  it("fails closed for mixed schemas or a non-dev Worker hostname", async () => {
    const mixed = {
      ...maintainerDevAccessBindings(),
      TILLER_INSTALLER_SCHEMA: "1",
    } as unknown as Env;
    const otherHostname = maintainerDevAccessBindings({
      hostname: "tiller.other-account.workers.dev",
    }) as unknown as Env;
    await expect(readWorkersDevAccessTrust(mixed, TEST_MAINTAINER_DEV_HOSTNAME)).resolves.toBeNull();
    await expect(readWorkersDevAccessTrust(
      otherHostname,
      "tiller.other-account.workers.dev",
    )).resolves.toBeNull();
  });

});
