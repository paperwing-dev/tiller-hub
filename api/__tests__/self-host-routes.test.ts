import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import {
  LEGACY_GATEWAY_TUNNEL_TOKEN_KEY,
  SELF_HOST_SETUP_SESSION_KEY,
  SELF_HOST_STATE_KEY,
  parseSelfHostState,
  type SelfHostMutationInput,
  type SelfHostProgressMutationInput,
  type SelfHostState,
} from "../self-host/state";

const {
  verifyCfAccessJwt,
  verifyCfAccessServiceToken,
  verifyCloudflareAccessToken,
  verifyWorkersDevRollbackAccess,
} = vi.hoisted(() => ({
  verifyCfAccessJwt: vi.fn(async () => undefined),
  verifyCfAccessServiceToken: vi.fn(async () => undefined),
  verifyCloudflareAccessToken: vi.fn(async () => ({ email: "jamie@example.com" })),
  verifyWorkersDevRollbackAccess: vi.fn(async () => undefined),
}));

const { resolveSetupStatus } = vi.hoisted(() => ({
  resolveSetupStatus: vi.fn(async () => ({ setupPhase: "complete" })),
}));

const { prepareSelfHostResources } = vi.hoisted(() => ({
  prepareSelfHostResources: vi.fn(),
}));

const { revokeSelfHostSetupCredentials } = vi.hoisted(() => ({
  revokeSelfHostSetupCredentials: vi.fn(async () => undefined),
}));

vi.mock("../auth", async () => {
  const actual = await vi.importActual<typeof import("../auth")>("../auth");
  return {
    ...actual,
    verifyCfAccessJwt,
    verifyCfAccessServiceToken,
    verifyCloudflareAccessToken,
    verifyWorkersDevRollbackAccess,
  };
});

vi.mock("../access/manage", async () => {
  const actual = await vi.importActual<typeof import("../access/manage")>("../access/manage");
  return {
    ...actual,
    revokeSelfHostSetupCredentials,
  };
});

vi.mock("../protection", async () => {
  const actual = await vi.importActual<typeof import("../protection")>("../protection");
  return {
    ...actual,
    resolveProtectionState: vi.fn(async (_env: unknown, requestUrl: string) => ({
      currentOrigin: new URL(requestUrl).origin,
      hubUrl: "https://tiller.example.com",
      routeKind: "custom-domain",
      hostKind: "custom-domain",
      protectionMode: "cf-access",
      protectionCanAutomate: true,
      serviceTokenConfigured: true,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: "tiller.example.com",
      accessConfigured: true,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessJwksUrl: null,
    })),
  };
});

vi.mock("../setup/status-resolver", () => ({
  resolveSetupStatus,
}));

vi.mock("../self-host/provisioner", () => ({
  prepareSelfHostResources,
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
}));

import selfHostRoutes from "../self-host/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", selfHostRoutes);
  return app;
}

function baseState(phase: SelfHostState["phase"] = "pending"): SelfHostState {
  const state = {
    schemaVersion: 2,
    phase: "pending",
    attemptId: "attempt-1",
    nonce: "nonce-1",
    expiresAt: "2999-01-01T00:00:00.000Z",
    rollback: {
      workersDevHubUrl: "https://demo.preview.workers.dev",
      workerServiceName: "tiller",
      workersDevAliasDisabled: "false",
      cfAccessConfigured: "true",
      browserAccess: {
        appId: "workers-app",
        aud: "workers-aud",
        issuer: "https://workers.cloudflareaccess.com",
        jwksUrl: "https://workers.cloudflareaccess.com/cdn-cgi/access/certs",
        appDomain: "demo.preview.workers.dev",
        appType: null,
        overlappingWildcardAppDomain: null,
        browserPolicyId: "workers-browser-policy",
      },
    },
    resources: {
      workerCustomDomain: {
        hostname: "tiller.example.com",
        hubUrl: "https://tiller.example.com",
        service: "tiller",
        zoneName: "example.com",
        accountId: "acc-1",
        zoneId: "zone-1",
        domainId: "domain-1",
      },
      hubAccess: {
        appId: "hub-app",
        aud: "hub-aud",
        appDomain: "tiller.example.com",
        issuer: "https://team.cloudflareaccess.com",
        jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
        accessTeamDomain: "team.cloudflareaccess.com",
        browserPolicyId: "browser-policy",
        serviceTokenId: "service-token",
        serviceTokenPolicyId: "service-policy",
        clientId: "client-id.access",
      },
      gateway: {
        hostname: "tiller-gateway.example.com",
        appId: "gateway-app",
        appDomain: "tiller-gateway.example.com",
        serviceTokenPolicyId: "gateway-policy",
        tunnelId: "tunnel-1",
        tunnelName: "tiller-gateway-abcd1234",
        tunnelTargetPort: 8788,
      },
    },
    secretMaterial: {
      clientSecret: "client-secret",
      tunnelToken: "tunnel-token",
      enableToken: "enable-token",
    },
  } satisfies SelfHostState;

  if (phase === "pending") return state;
  if (phase === "promoted") {
    return {
      schemaVersion: 2,
      phase: "promoted",
      attemptId: state.attemptId,
      expiresAt: state.expiresAt,
      rollback: state.rollback,
      resources: state.resources,
      secretMaterial: { enableToken: state.secretMaterial.enableToken },
    };
  }
  return {
    schemaVersion: 2,
    phase: "enabled",
    attemptId: state.attemptId,
    rollback: state.rollback,
    resources: state.resources,
  };
}

function createEnv(initialState: SelfHostState | null, configEntries: Record<string, string> = {}) {
  const config: Record<string, string> = {
    [SELF_HOST_STATE_KEY]: initialState ? JSON.stringify(initialState) : "",
    [SELF_HOST_SETUP_SESSION_KEY]: "legacy-session",
    [LEGACY_GATEWAY_TUNNEL_TOKEN_KEY]: "legacy-token",
    ...configEntries,
  };
  const store = {
    config,
    getConfig: vi.fn((key: string) => config[key]),
    setConfig: vi.fn((key: string, value: string) => {
      config[key] = value;
    }),
    commitSelfHostMutation: vi.fn((input: SelfHostMutationInput) => {
      const current = parseSelfHostState(config[SELF_HOST_STATE_KEY]);
      if ("state" in input.expected) {
        if (current) return false;
      } else if (!current || current.attemptId !== input.expected.attemptId || current.phase !== input.expected.phase) {
        return false;
      }
      config[SELF_HOST_STATE_KEY] = input.nextState ? JSON.stringify(input.nextState) : "";
      config[SELF_HOST_SETUP_SESSION_KEY] = "";
      config[LEGACY_GATEWAY_TUNNEL_TOKEN_KEY] = "";
      for (const [key, value] of Object.entries(input.configEntries ?? {})) {
        config[key] = value ?? "";
      }
      return true;
    }),
    commitSelfHostProgress: vi.fn((input: SelfHostProgressMutationInput) => {
      const current = parseSelfHostState(config[SELF_HOST_STATE_KEY]);
      if (
        !current
        || current.phase !== "promoted"
        || current.attemptId !== input.expected.attemptId
      ) {
        return false;
      }
      config[SELF_HOST_STATE_KEY] = JSON.stringify({
        ...current,
        progress: input.progress,
      });
      return true;
    }),
  };
  return {
    env: {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => store),
      },
    } as unknown as HonoEnv["Bindings"],
    store,
  };
}

const workersDevRollbackConfig = {
  HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
  WORKER_SERVICE_NAME: "tiller",
  WORKERS_DEV_ALIAS_DISABLED: "false",
  CF_ACCESS_CONFIGURED: "true",
  CF_ACCESS_APP_ID: "workers-app",
  CF_ACCESS_AUD: "workers-aud",
  CF_ACCESS_TEAM_DOMAIN: "https://workers.cloudflareaccess.com",
  CF_ACCESS_JWKS_URL: "https://workers.cloudflareaccess.com/cdn-cgi/access/certs",
  CF_ACCESS_APP_DOMAIN: "demo.preview.workers.dev",
  CF_ACCESS_BROWSER_POLICY_ID: "workers-browser-policy",
};

const prepareRequest = {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Cf-Access-Jwt-Assertion": "workers-jwt",
  },
  body: JSON.stringify({
    hostname: "tiller.example.com",
    apiToken: "cfat_test",
    emails: ["jamie@example.com"],
  }),
};

describe("Self Host lifecycle routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const preparedState = baseState("pending");
    prepareSelfHostResources.mockResolvedValue({
      customHubUrl: "https://tiller.example.com",
      gatewayHostname: "tiller-gateway.example.com",
      resources: preparedState.resources,
      clientSecret: "new-client-secret",
      tunnelToken: "new-tunnel-token",
      cleanupDraftResources: vi.fn(async () => undefined),
    });
  });

  it("promotes pending state atomically and strips the one-time gateway token", async () => {
    const app = createApp();
    const pendingState = baseState("pending");
    const { env, store } = createEnv(pendingState);

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/promote",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cf-Access-Jwt-Assertion": "jwt",
        },
        body: JSON.stringify({ attemptId: "attempt-1", nonce: "nonce-1" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      kind: "self-host-setup",
      hubUrl: "https://tiller.example.com",
      workersDevHubUrl: "https://demo.preview.workers.dev",
      clientSecret: "client-secret",
      gatewayTunnelToken: "tunnel-token",
      enableToken: "enable-token",
    });
    const storedState = parseSelfHostState(store.config[SELF_HOST_STATE_KEY]);
    expect(storedState?.phase).toBe("promoted");
    expect(storedState?.progress).toMatchObject({
      step: "credentials-issued",
    });
    expect(JSON.stringify(storedState)).not.toContain("client-secret");
    expect(JSON.stringify(storedState)).not.toContain("tunnel-token");
    expect(store.config.CF_ACCESS_CLIENT_SECRET).toBe("client-secret");
    expect(store.config.TILLER_GATEWAY_TUNNEL_ID).toBe("tunnel-1");
    expect(store.config[LEGACY_GATEWAY_TUNNEL_TOKEN_KEY]).toBe("");
    expect(store.config[SELF_HOST_SETUP_SESSION_KEY]).toBe("");
  });

  it("cleans up newly prepared resources when a prepare commit conflicts", async () => {
    const app = createApp();
    const cleanupDraftResources = vi.fn(async () => undefined);
    const preparedState = baseState("pending");
    prepareSelfHostResources.mockResolvedValueOnce({
      customHubUrl: "https://tiller.example.com",
      gatewayHostname: "tiller-gateway.example.com",
      resources: preparedState.resources,
      clientSecret: "new-client-secret",
      tunnelToken: "new-tunnel-token",
      cleanupDraftResources,
    });
    const { env, store } = createEnv(null, workersDevRollbackConfig);
    store.commitSelfHostMutation.mockReturnValueOnce(false);

    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/self-host/prepare",
      prepareRequest,
      env,
    );

    expect(res.status).toBe(409);
    expect(cleanupDraftResources).toHaveBeenCalledOnce();
    expect(store.config[SELF_HOST_STATE_KEY]).toBe("");
  });

  it("keeps the existing Self Host deployment when replacement preparation fails", async () => {
    const app = createApp();
    const existing = baseState("enabled");
    const { env, store } = createEnv(existing);
    prepareSelfHostResources.mockRejectedValueOnce(new Error("Cloudflare rejected the replacement"));

    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/self-host/prepare",
      prepareRequest,
      env,
    );

    expect(res.status).toBe(500);
    expect(store.commitSelfHostMutation).not.toHaveBeenCalled();
    expect(parseSelfHostState(store.config[SELF_HOST_STATE_KEY])?.phase).toBe("enabled");
    expect(revokeSelfHostSetupCredentials).not.toHaveBeenCalled();
  });

  it("replaces an existing Self Host state only after replacement resources are prepared", async () => {
    const app = createApp();
    const existing = baseState("enabled");
    const { env, store } = createEnv(existing);

    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/self-host/prepare",
      prepareRequest,
      env,
    );

    expect(res.status).toBe(200);
    expect(prepareSelfHostResources.mock.invocationCallOrder[0]).toBeLessThan(
      store.commitSelfHostMutation.mock.invocationCallOrder[0],
    );
    expect(store.commitSelfHostMutation).toHaveBeenCalledWith(expect.objectContaining({
      expected: { attemptId: existing.attemptId, phase: "enabled" },
      configEntries: expect.objectContaining({
        HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
        TILLER_DEPLOYMENT_MODE: "hosted",
      }),
    }));
    const storedState = parseSelfHostState(store.config[SELF_HOST_STATE_KEY]);
    expect(storedState?.phase).toBe("pending");
    expect(JSON.stringify(storedState)).toContain("new-tunnel-token");
    expect(store.config[LEGACY_GATEWAY_TUNNEL_TOKEN_KEY]).toBe("");
    expect(revokeSelfHostSetupCredentials).toHaveBeenCalledOnce();
  });

  it("updates promoted setup progress through the constrained progress helper", async () => {
    const app = createApp();
    const { env, store } = createEnv(baseState("promoted"));

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
        body: JSON.stringify({
          setupAttemptId: "attempt-1",
          setupToken: "enable-token",
          step: "docker",
          message: "Checking Docker...",
          phase: "enabled",
          resources: { leaked: true },
          TILLER_DEPLOYMENT_MODE: "self-host",
        }),
      },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      phase: "promoted",
      progress: { step: "docker", message: "Checking Docker..." },
    });
    expect(store.commitSelfHostProgress).toHaveBeenCalledOnce();
    expect(store.commitSelfHostMutation).not.toHaveBeenCalled();
    const storedState = parseSelfHostState(store.config[SELF_HOST_STATE_KEY]);
    expect(storedState?.phase).toBe("promoted");
    expect(storedState?.progress).toMatchObject({ step: "docker", message: "Checking Docker..." });
    expect(store.config.TILLER_DEPLOYMENT_MODE).toBeUndefined();
    expect(JSON.stringify(storedState)).toContain("enable-token");
    expect(JSON.stringify(storedState)).not.toContain("leaked");
  });

  it("rejects setup progress with the wrong setup token", async () => {
    const app = createApp();
    const { env, store } = createEnv(baseState("promoted"));

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
        body: JSON.stringify({
          setupAttemptId: "attempt-1",
          setupToken: "wrong-token",
          step: "docker",
          message: "Checking Docker...",
        }),
      },
      env,
    );

    expect(res.status).toBe(401);
    expect(store.commitSelfHostProgress).not.toHaveBeenCalled();
  });

  it("requires canonical setup progress token field names", async () => {
    const app = createApp();
    const { env, store } = createEnv(baseState("promoted"));

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
        body: JSON.stringify({
          attemptId: "attempt-1",
          enableToken: "enable-token",
          step: "docker",
          message: "Checking Docker...",
        }),
      },
      env,
    );

    expect(res.status).toBe(400);
    expect(store.commitSelfHostProgress).not.toHaveBeenCalled();
  });

  it("rejects expired setup progress without rolling back or mutating state", async () => {
    const app = createApp();
    const expired = {
      ...baseState("promoted"),
      expiresAt: "2000-01-01T00:00:00.000Z",
    } satisfies SelfHostState;
    const { env, store } = createEnv(expired, {
      TILLER_DEPLOYMENT_MODE: "self-host",
    });
    const storedBefore = store.config[SELF_HOST_STATE_KEY];

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
        body: JSON.stringify({
          setupAttemptId: "attempt-1",
          setupToken: "enable-token",
          step: "docker",
          message: "Checking Docker...",
        }),
      },
      env,
    );

    expect(res.status).toBe(409);
    expect(store.commitSelfHostMutation).not.toHaveBeenCalled();
    expect(store.commitSelfHostProgress).not.toHaveBeenCalled();
    expect(store.config[SELF_HOST_STATE_KEY]).toBe(storedBefore);
    expect(store.config.TILLER_DEPLOYMENT_MODE).toBe("self-host");
  });

  it("enables promoted state without carrying setup secrets forward", async () => {
    const app = createApp();
    const { env, store } = createEnv(baseState("promoted"), {
      TILLER_GATEWAY_HOSTNAME: "tiller-gateway.example.com",
      CF_ACCESS_GATEWAY_APP_ID: "gateway-app",
      CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: "gateway-policy",
      TILLER_GATEWAY_TUNNEL_ID: "tunnel-1",
    });

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/enable",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
        body: JSON.stringify({ setupAttemptId: "attempt-1", enableToken: "enable-token" }),
      },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.clone().json()).resolves.toMatchObject({
      ok: true,
      progress: { step: "complete" },
    });
    const storedState = parseSelfHostState(store.config[SELF_HOST_STATE_KEY]);
    expect(storedState?.phase).toBe("enabled");
    expect(storedState?.progress).toMatchObject({ step: "complete" });
    expect(JSON.stringify(storedState)).not.toContain("enable-token");
    expect(store.config.TILLER_DEPLOYMENT_MODE).toBe("self-host");
    expect(store.config[LEGACY_GATEWAY_TUNNEL_TOKEN_KEY]).toBe("");
  });

  it("returns setup lifecycle without secret material or resource internals", async () => {
    const app = createApp();
    const promoted = {
      ...baseState("promoted"),
      progress: {
        step: "image",
        message: "Preparing the local sandbox image...",
        updatedAt: "2026-05-27T00:00:00.000Z",
      },
    } satisfies SelfHostState;
    const { env } = createEnv(promoted);

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/lifecycle?attemptId=attempt-1",
      { method: "GET", headers: { "Cf-Access-Jwt-Assertion": "jwt" } },
      env,
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      attemptId: "attempt-1",
      phase: "promoted",
      progress: {
        step: "image",
        message: "Preparing the local sandbox image...",
        updatedAt: "2026-05-27T00:00:00.000Z",
      },
    });
    expect(JSON.stringify(body)).not.toContain("enable-token");
    expect(JSON.stringify(body)).not.toContain("client-secret");
    expect(JSON.stringify(body)).not.toContain("tiller-gateway.example.com");
  });

  it("rejects expired setup lifecycle polling without rolling back or mutating state", async () => {
    const app = createApp();
    const expired = {
      ...baseState("promoted"),
      expiresAt: "2000-01-01T00:00:00.000Z",
    } satisfies SelfHostState;
    const { env, store } = createEnv(expired, {
      TILLER_DEPLOYMENT_MODE: "self-host",
    });
    const storedBefore = store.config[SELF_HOST_STATE_KEY];

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/lifecycle?attemptId=attempt-1",
      { method: "GET", headers: { "Cf-Access-Jwt-Assertion": "jwt" } },
      env,
    );

    expect(res.status).toBe(410);
    expect(store.commitSelfHostMutation).not.toHaveBeenCalled();
    expect(store.commitSelfHostProgress).not.toHaveBeenCalled();
    expect(store.config[SELF_HOST_STATE_KEY]).toBe(storedBefore);
    expect(store.config.TILLER_DEPLOYMENT_MODE).toBe("self-host");
  });

  it("returns to Hosted Tiller through the destructive endpoint", async () => {
    const app = createApp();
    const { env, store } = createEnv(baseState("enabled"));

    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/return-to-hosted",
      { method: "POST", headers: { "Cf-Access-Jwt-Assertion": "jwt" } },
      env,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      redirectUrl: "https://demo.preview.workers.dev",
    });
    expect(store.config[SELF_HOST_STATE_KEY]).toBe("");
    expect(store.config.TILLER_DEPLOYMENT_MODE).toBe("hosted");
  });
});
