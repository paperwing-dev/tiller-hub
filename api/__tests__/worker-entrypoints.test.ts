import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../types";
import type {
  WorkersDevAccessRuntimeCredential,
  WorkersDevAccessRuntimeTrust,
} from "../workers-dev-access/types";
import {
  installedAccessBindings,
  TEST_WORKERS_DEV_HOSTNAME,
} from "./access-binding-fixture";

const { partyMiddleware, partyserverMiddleware } = vi.hoisted(() => ({
  partyMiddleware: vi.fn(async () => new Response("party ok")),
  partyserverMiddleware: vi.fn(() =>
    vi.fn(async () => new Response("party ok")),
  ),
}));

vi.mock("agents", () => ({
  Agent: class {},
}));

vi.mock("@cloudflare/voice", () => ({
  withVoice: (Base: new (...args: never[]) => unknown) => Base,
  WorkersAIFluxSTT: class {},
  WorkersAITTS: class {},
}));

vi.mock("../partyserver-middleware", () => ({
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

const canonicalTrust: WorkersDevAccessRuntimeTrust = {
  ownerEmail: "owner@example.com",
  workersDevHostname: TEST_WORKERS_DEV_HOSTNAME,
  issuer: "https://entrypoint.cloudflareaccess.com",
  audience: "entrypoint-audience",
  serviceClientId: "service-client.access",
};

const canonicalCredential: WorkersDevAccessRuntimeCredential = {
  currentSecret: "service-secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
};
const CONTROL_SECRET = "entrypoint-control-secret";

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

async function ownerAssertion(): Promise<string> {
  return new SignJWT({
    type: "app",
    email: canonicalTrust.ownerEmail,
    sub: "owner",
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
  trust: WorkersDevAccessRuntimeTrust | null = null,
  hubOverrides: Record<string, unknown> = {},
): Env {
  return {
    ...config,
    ...(trust
      ? installedAccessBindings({
          hostname: trust.workersDevHostname,
          issuer: trust.issuer,
          audience: trust.audience,
          serviceClientId: trust.serviceClientId,
          serviceClientSecret: canonicalCredential.currentSecret,
          ownerEmail: trust.ownerEmail,
          tokenExpiresAt: canonicalCredential.tokenExpiresAt,
        })
      : {}),
    HUB: {
      idFromName: vi.fn(() => "hub"),
      get: vi.fn(() => ({
        getAllConfig: vi.fn(() => config),
        getConfig: vi.fn((key: string) => config[key] || undefined),
        ...hubOverrides,
      })),
    },
  } as unknown as Env;
}

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  accessPrivateKey = keys.privateKey;
  accessPublicJwk = {
    ...(await exportJWK(keys.publicKey)),
    kid: "entrypoint-test-key",
    alg: "RS256",
    use: "sig",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [accessPublicJwk] })),
  );
});

describe("Worker dynamic entrypoints", () => {
  beforeEach(() => {
    partyMiddleware.mockClear();
    partyserverMiddleware.mockClear();
    partyserverMiddleware.mockReturnValue(partyMiddleware);
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
      ["POST", "/api/auth/openai/seed"],
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

  it.each([
    ["POST", "/api/setup/workers-dev-access/oauth/start"],
    ["POST", "/api/settings/workers-dev-access/oauth/start"],
    ["POST", "/api/setup/workers-dev-access/broker/proof"],
    ["POST", "/api/setup/workers-dev-access/broker/complete"],
  ] as const)(
    "authenticates retired Access routes before returning 404 for %s %s",
    async (method, path) => {
      const env = mockEnv({}, canonicalTrust);
      const unauthenticated = await worker.fetch(
        new Request(`https://${TEST_WORKERS_DEV_HOSTNAME}${path}`, { method }),
        env,
        {} as ExecutionContext,
      );
      expect(unauthenticated.status).toBe(401);

      const authenticated = await worker.fetch(
        new Request(`https://${TEST_WORKERS_DEV_HOSTNAME}${path}`, {
          method,
          headers: {
            "Cf-Access-Jwt-Assertion": await ownerAssertion(),
            Origin: `https://${TEST_WORKERS_DEV_HOSTNAME}`,
          },
        }),
        env,
        {} as ExecutionContext,
      );
      expect(authenticated.status).toBe(404);
    },
  );

  it("fails closed on /agents before canonical trust exists", async () => {
    const response = await worker.fetch(
      new Request(
        "https://tiller.preview.workers.dev/agents/reviewer-chat/default",
      ),
      mockEnv({ HUB_PUBLIC_URL: "https://tiller.preview.workers.dev" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Canonical workers.dev Access trust is not configured.",
    });
  });

  it("authenticates retired /agents routes before returning gone", async () => {
    const env = mockEnv(
      {
        HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
        TILLER_CONTROL_SECRET: CONTROL_SECRET,
      },
      canonicalTrust,
    );

    const missing = await worker.fetch(
      new Request(
        "https://tiller.preview.workers.dev/agents/reviewer-chat/default",
      ),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(401);

    const authed = await worker.fetch(
      new Request(
        "https://tiller.preview.workers.dev/agents/reviewer-chat/default",
        {
          headers: {
            "CF-Access-Client-Id": canonicalTrust.serviceClientId,
            "CF-Access-Client-Secret": canonicalCredential.currentSecret,
            "Cf-Access-Jwt-Assertion": await serviceAssertion(),
            "X-Tiller-Capability": CONTROL_SECRET,
          },
        },
      ),
      env,
      {} as ExecutionContext,
    );
    expect(authed.status).toBe(410);
    expect(authed.headers.get("Cache-Control")).toBe("no-store");
    await expect(authed.json()).resolves.toEqual({
      error:
        "Hosted agent routes have been retired. Use planner reviewer threads instead.",
    });
  });

  it("authenticates retired hosted-agent metadata before returning gone", async () => {
    const env = mockEnv(
      {
        HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
      },
      canonicalTrust,
    );
    const missing = await worker.fetch(
      new Request("https://tiller.preview.workers.dev/api/agents"),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(401);

    const response = await worker.fetch(
      new Request("https://tiller.preview.workers.dev/api/agents", {
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(410);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      error:
        "Hosted agent routes have been retired. Use planner reviewer threads instead.",
    });
  });

  it("exposes the installer probe to global owners and the exact bootstrap service principal", async () => {
    const env = mockEnv({}, canonicalTrust);
    const url = `https://${TEST_WORKERS_DEV_HOSTNAME}/api/installer/probe`;

    const unauthenticated = await worker.fetch(
      new Request(url),
      env,
      {} as ExecutionContext,
    );
    expect(unauthenticated.status).toBe(401);

    const owner = await worker.fetch(
      new Request(url, {
        headers: { "Cf-Access-Jwt-Assertion": await ownerAssertion() },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(owner.status).toBe(200);

    const service = await worker.fetch(
      new Request(url, {
        headers: { "Cf-Access-Jwt-Assertion": await serviceAssertion() },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(service.status).toBe(200);
    await expect(service.json()).resolves.toEqual({
      ok: true,
      releaseId: "b".repeat(40),
    });
  });

  it("allows local development through global authority while preserving probe availability checks", async () => {
    const response = await worker.fetch(
      new Request("http://localhost/api/installer/probe"),
      mockEnv({ LOCAL_DEV_ONLY_BACKEND: "true" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Release marker unavailable",
    });
  });

  it.each(["GET", "POST", "DELETE"])(
    "returns 404 for the removed Cloudflare MCP proxy on %s",
    async (method) => {
      const response = await worker.fetch(
        new Request("http://localhost/api/mcp/cloudflare", { method }),
        mockEnv({ LOCAL_DEV_ONLY_BACKEND: "true" }),
        {} as ExecutionContext,
      );

      expect(response.status).toBe(404);
    },
  );

  it("requires installation control authority to verify a live machine advertisement", async () => {
    const getMachineExecutionStatus = vi.fn(() => ({
      state: "ready",
      machineId: "machine-1",
      displayName: "Build Mac",
    }));
    const env = mockEnv(
      {
        HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
        TILLER_CONTROL_SECRET: CONTROL_SECRET,
      },
      canonicalTrust,
      { getMachineExecutionStatus },
    );

    const response = await worker.fetch(
      new Request(
        "https://tiller.preview.workers.dev/api/machines/machine-1/execution-status",
        {
          headers: {
            "CF-Access-Client-Id": canonicalTrust.serviceClientId,
            "CF-Access-Client-Secret": canonicalCredential.currentSecret,
            "Cf-Access-Jwt-Assertion": await serviceAssertion(),
            "X-Tiller-Capability": CONTROL_SECRET,
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

  it.each([
    ["POST", "/api/repos"],
    ["DELETE", "/api/repos/repo-1"],
    ["PATCH", "/api/repos/repo-1/session-env"],
    ["PUT", "/api/repos/repo-1/mcp-servers"],
    ["PUT", "/api/repos/repo-1/plan-writer-settings"],
  ])(
    "rejects the service principal from repository administration for %s %s",
    async (method, path) => {
      const response = await worker.fetch(
        new Request(`https://${TEST_WORKERS_DEV_HOSTNAME}${path}`, {
          method,
          headers: { "Cf-Access-Jwt-Assertion": await serviceAssertion() },
        }),
        mockEnv({}, canonicalTrust),
        {} as ExecutionContext,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "A control or environment capability is required",
      });
    },
  );

  it("does not let a forged specialized header reopen broad runtime session creation", async () => {
    const response = await worker.fetch(
      new Request(`https://${TEST_WORKERS_DEV_HOSTNAME}/api/sessions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": await serviceAssertion(),
          "X-Tiller-Plan-Writer-Token": "forged",
        },
        body: JSON.stringify({
          tag: "forged",
          metadata: { envSlug: "other-env", role: "lead" },
        }),
      }),
      mockEnv({}, canonicalTrust),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Plan writer authority required",
    });
  });

  it("fails closed on /parties before canonical trust exists", async () => {
    const response = await worker.fetch(
      new Request("https://tiller.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      mockEnv({ HUB_PUBLIC_URL: "https://tiller.preview.workers.dev" }),
      {} as ExecutionContext,
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "Canonical workers.dev Access trust is not configured.",
    });
    expect(partyserverMiddleware).not.toHaveBeenCalled();
    expect(partyMiddleware).not.toHaveBeenCalled();
  });

  it("delegates Hub WebSocket authorization to HubDO", async () => {
    const env = mockEnv(
      {
        HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
        TILLER_CONTROL_SECRET: CONTROL_SECRET,
      },
      canonicalTrust,
    );

    const missing = await worker.fetch(
      new Request("https://tiller.preview.workers.dev/parties/hub/hub", {
        headers: { Upgrade: "websocket" },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(missing.status).toBe(200);
    expect(partyserverMiddleware).toHaveBeenCalledTimes(1);
    expect(partyMiddleware).toHaveBeenCalledTimes(1);

    const authed = await worker.fetch(
      new Request("https://tiller.preview.workers.dev/parties/hub/hub", {
        headers: {
          "CF-Access-Client-Id": canonicalTrust.serviceClientId,
          "CF-Access-Client-Secret": canonicalCredential.currentSecret,
          "Cf-Access-Jwt-Assertion": await serviceAssertion(),
          "X-Tiller-Capability": CONTROL_SECRET,
          Upgrade: "websocket",
        },
      }),
      env,
      {} as ExecutionContext,
    );
    expect(authed.status).toBe(200);
    await expect(authed.text()).resolves.toBe("party ok");
    expect(partyserverMiddleware).toHaveBeenCalledTimes(2);
    expect(partyMiddleware).toHaveBeenCalledTimes(2);
  });

  it.each([
    "/parties/reviewer-chat/default",
    "/parties//reviewer-chat/default",
  ])(
    "authenticates the retired reviewer PartyServer namespace before returning gone for %s",
    async (path) => {
      const env = mockEnv(
        {
          HUB_PUBLIC_URL: "https://tiller.preview.workers.dev",
          TILLER_CONTROL_SECRET: CONTROL_SECRET,
        },
        canonicalTrust,
      );
      const url = `https://tiller.preview.workers.dev${path}`;

      const missing = await worker.fetch(
        new Request(url, { headers: { Upgrade: "websocket" } }),
        env,
        {} as ExecutionContext,
      );
      expect(missing.status).toBe(401);

      const authed = await worker.fetch(
        new Request(url, {
          headers: {
            "CF-Access-Client-Id": canonicalTrust.serviceClientId,
            "CF-Access-Client-Secret": canonicalCredential.currentSecret,
            "Cf-Access-Jwt-Assertion": await serviceAssertion(),
            "X-Tiller-Capability": CONTROL_SECRET,
            Upgrade: "websocket",
          },
        }),
        env,
        {} as ExecutionContext,
      );
      expect(authed.status).toBe(410);
      expect(authed.headers.get("Cache-Control")).toBe("no-store");
      await expect(authed.json()).resolves.toEqual({
        error:
          "Hosted agent routes have been retired. Use planner reviewer threads instead.",
      });
      expect(partyserverMiddleware).not.toHaveBeenCalled();
      expect(partyMiddleware).not.toHaveBeenCalled();
    },
  );
});
