import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { authenticateAccessRequest } from "../auth";
import {
  readWorkersDevAccessCredential,
  readWorkersDevAccessLifecycle,
  readWorkersDevAccessTrust,
} from "../workers-dev-access/records";
import type { Env } from "../types";
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

  it("preserves explicit localhost owner behavior", async () => {
    await expect(authenticateAccessRequest(
      new Request("http://localhost:5173/api/setup", { method: "POST" }),
      { LOCAL_DEV_ONLY_BACKEND: "1" } as Env,
    )).resolves.toEqual({ kind: "local-dev" });
  });

  it("does not trust a loopback hostname without explicit local development mode", async () => {
    const request = new Request("http://127.0.0.1/api/setup", { method: "POST" });
    await expect(authenticateAccessRequest(request, {} as Env))
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
