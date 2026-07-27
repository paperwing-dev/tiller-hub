import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import { clearWorkersDevAccessTrustCache } from "../workers-dev-access/records";
import type {
  WorkersDevAccessCredentialV1,
  WorkersDevAccessTrustV1,
} from "../workers-dev-access/types";

const { partyMiddleware, partyserverMiddleware, routeAgentRequest } = vi.hoisted(() => ({
  partyMiddleware: vi.fn(async () => new Response("party ok")),
  partyserverMiddleware: vi.fn(() => vi.fn(async () => new Response("party ok"))),
  routeAgentRequest: vi.fn(async () => new Response("agent ok")),
}));

vi.mock("agents", () => ({
  Agent: class {},
  routeAgentRequest,
}));

vi.mock("@cloudflare/voice", () => ({
  withVoice: (Base: new (...args: never[]) => unknown) => Base,
  WorkersAIFluxSTT: class {},
  WorkersAITTS: class {},
}));

vi.mock("hono-party", () => ({
  partyserverMiddleware,
}));

vi.mock("partyserver", () => ({
  Server: class {},
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  WorkerEntrypoint: class {},
}));

vi.mock("../env-lifecycle-do", () => ({
  EnvLifecycleDO: class {},
}));

vi.mock("../coordination", () => ({
  ArtifactStoreDO: class {},
  loadRepoArtifacts: vi.fn(),
  renderArtifactBodyMarkdown: vi.fn(),
}));

vi.mock("../agents/reviewer-chat-agent", () => ({
  ReviewerChatAgent: class {},
}));

vi.mock("../voice/agent", () => ({
  TillerVoice: class {},
}));

import worker from "../index";

const canonicalTrust: WorkersDevAccessTrustV1 = {
  version: 1,
  ownerEmail: "owner@example.com",
  accountId: "account-1",
  workerName: "demo",
  workersDevHostname: "demo.preview.workers.dev",
  issuer: "https://entrypoint.cloudflareaccess.com",
  audience: "entrypoint-audience",
  serviceTokenId: "service-token-1",
  serviceClientId: "service-client.access",
  configuredAt: "2026-07-16T00:00:00.000Z",
};

const canonicalCredential: WorkersDevAccessCredentialV1 = {
  version: 1,
  currentSecret: "service-secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
};

let accessPrivateKey: CryptoKey;
let accessPublicJwk: Record<string, unknown>;

async function serviceAssertion(): Promise<string> {
  return new SignJWT({
    type: "app",
    common_name: canonicalTrust.serviceClientId,
    sub: "",
  })
    .setProtectedHeader({ alg: "RS256", kid: "entrypoint-test-key" })
    .setIssuer(canonicalTrust.issuer)
    .setAudience(canonicalTrust.audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(accessPrivateKey);
}

function mockEnv(
  config: Record<string, string> = {},
  trust: WorkersDevAccessTrustV1 | null = null,
  hubOverrides: Record<string, unknown> = {},
): Env {
  return {
    ...config,
    HUB: {
      idFromName: vi.fn(() => "hub"),
      get: vi.fn(() => ({
        getAllConfig: vi.fn(() => config),
        getConfig: vi.fn((key: string) => config[key] || undefined),
        getWorkersDevAccessTrust: vi.fn(async (hostname: string) => (
          trust?.workersDevHostname === hostname ? trust : null
        )),
        getWorkersDevAccessCredential: vi.fn(async () => (
          trust ? canonicalCredential : null
        )),
        getWorkersDevAccessLifecycle: vi.fn(async () => ({
          configured: Boolean(trust),
          workersDevHostname: trust?.workersDevHostname ?? null,
          tokenExpiresAt: trust ? canonicalCredential.tokenExpiresAt : null,
          renewalRecommended: false,
        })),
        ...hubOverrides,
      })),
    },
  } as unknown as Env;
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  accessPrivateKey = keys.privateKey;
  accessPublicJwk = {
    ...await exportJWK(keys.publicKey),
    kid: "entrypoint-test-key",
    alg: "RS256",
    use: "sig",
  };
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ keys: [accessPublicJwk] })));
});

describe("Worker dynamic entrypoints", () => {
  beforeEach(() => {
    clearWorkersDevAccessTrustCache();
    partyMiddleware.mockClear();
    partyserverMiddleware.mockClear();
    partyserverMiddleware.mockReturnValue(partyMiddleware);
    routeAgentRequest.mockClear();
  });

  it("does not expose the retired gateway session exchange route", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/auth/openai/gateway-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionToken: "retired-token" }),
      }),
      mockEnv({ LOCAL_DEV_ONLY_BACKEND: "true" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(404);
  });

  it("returns not found for every removed setup and backend-control route", async () => {
    const removed = [
      ["POST", "/api/setup/custom-domain"],
      ["GET", "/api/host/status"],
      ["POST", "/api/setup/self-host/prepare"],
      ["POST", "/api/setup/self-host/promote"],
      ["POST", "/api/setup/self-host/progress"],
      ["GET", "/api/setup/self-host/lifecycle"],
      ["POST", "/api/setup/self-host/enable"],
      ["POST", "/api/setup/self-host/return-to-hosted"],
      ["PUT", "/api/settings/deployment-mode"],
      ["POST", "/api/settings/deployment-mode/rollback"],
    ] as const;

    for (const [method, path] of removed) {
      const response = await worker.fetch(
        new Request(`http://localhost${path}`, { method }),
        mockEnv({ LOCAL_DEV_ONLY_BACKEND: "true" }),
        {} as ExecutionContext,
      );
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });

  it("fails closed on /agents before canonical trust exists", async () => {
    const response = await worker.fetch(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default"),
      mockEnv({ HUB_PUBLIC_URL: "https://demo.preview.workers.dev" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Canonical workers.dev Access trust is not configured.",
    });
    expect(routeAgentRequest).not.toHaveBeenCalled();
  });

  it("requires Access auth on /agents after workers.dev Access is configured", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    }, canonicalTrust);

    const missing = await worker.fetch(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default"),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(401);
    expect(routeAgentRequest).not.toHaveBeenCalled();

    const authed = await worker.fetch(
      new Request("https://demo.preview.workers.dev/agents/reviewer-chat/default", {
        headers: {
          "CF-Access-Client-Id": canonicalTrust.serviceClientId,
          "CF-Access-Client-Secret": canonicalCredential.currentSecret,
          "Cf-Access-Jwt-Assertion": await serviceAssertion(),
        },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authed.status).toBe(200);
    await expect(authed.text()).resolves.toBe("agent ok");
    expect(routeAgentRequest).toHaveBeenCalledTimes(1);
  });

  it("lets the installation service verify its exact live machine advertisement", async () => {
    const getMachineExecutionStatus = vi.fn(() => ({
      state: "ready",
      machineId: "machine-1",
      displayName: "Build Mac",
    }));
    const env = mockEnv(
      { HUB_PUBLIC_URL: "https://demo.preview.workers.dev" },
      canonicalTrust,
      { getMachineExecutionStatus },
    );

    const response = await worker.fetch(
      new Request(
        "https://demo.preview.workers.dev/api/machines/machine-1/execution-status",
        {
          headers: {
            "CF-Access-Client-Id": canonicalTrust.serviceClientId,
            "CF-Access-Client-Secret": canonicalCredential.currentSecret,
            "Cf-Access-Jwt-Assertion": await serviceAssertion(),
          },
        },
      ),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      state: "ready",
      machineId: "machine-1",
      displayName: "Build Mac",
    });
    expect(getMachineExecutionStatus).toHaveBeenCalledWith("machine-1");
  });

  it("fails closed on /parties before canonical trust exists", async () => {
    const response = await worker.fetch(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      mockEnv({ HUB_PUBLIC_URL: "https://demo.preview.workers.dev" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Canonical workers.dev Access trust is not configured.",
    });
    expect(partyserverMiddleware).not.toHaveBeenCalled();
    expect(partyMiddleware).not.toHaveBeenCalled();
  });

  it("requires Access auth on /parties after workers.dev Access is configured", async () => {
    const env = mockEnv({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
    }, canonicalTrust);

    const missing = await worker.fetch(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(401);
    expect(partyserverMiddleware).not.toHaveBeenCalled();
    expect(partyMiddleware).not.toHaveBeenCalled();

    const authed = await worker.fetch(
      new Request("https://demo.preview.workers.dev/parties/hub/hub", {
        headers: {
          "CF-Access-Client-Id": canonicalTrust.serviceClientId,
          "CF-Access-Client-Secret": canonicalCredential.currentSecret,
          "Cf-Access-Jwt-Assertion": await serviceAssertion(),
          Upgrade: "websocket",
        },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authed.status).toBe(200);
    await expect(authed.text()).resolves.toBe("party ok");
    expect(partyserverMiddleware).toHaveBeenCalledTimes(1);
    expect(partyMiddleware).toHaveBeenCalledTimes(1);
  });
});
