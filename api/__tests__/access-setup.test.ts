import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

const {
  prepareManagedExactHostAccess,
  buildPersistedManagedAccessConfig,
  persistManagedAccessConfig,
  readManagedAccessConfigSnapshot,
  restoreManagedAccessConfigSnapshot,
  cleanupSupersededManagedHubAccess,
  provisionManagedServiceHosts,
} = vi.hoisted(() => ({
  prepareManagedExactHostAccess: vi.fn(),
  buildPersistedManagedAccessConfig: vi.fn(() => ({
    appId: "hub-app",
    appAud: "hub-aud",
    appDomain: "tiller.paperwing.dev",
    clientId: "client-id",
    clientSecret: "client-secret",
    browserPolicyId: "browser-policy",
    serviceTokenId: "service-token",
    serviceTokenPolicyId: "service-policy",
  })),
  persistManagedAccessConfig: vi.fn(),
  readManagedAccessConfigSnapshot: vi.fn(async () => ({
    CF_ACCESS_APP_ID: null,
    CF_ACCESS_AUD: null,
    CF_ACCESS_APP_DOMAIN: null,
    CF_ACCESS_APP_TYPE: null,
    CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN: null,
    CF_ACCESS_CLIENT_ID: null,
    CF_ACCESS_CLIENT_SECRET: null,
    CF_ACCESS_BROWSER_POLICY_ID: null,
    CF_ACCESS_SERVICE_TOKEN_ID: null,
    CF_ACCESS_SERVICE_TOKEN_POLICY_ID: null,
    TILLER_GATEWAY_HOSTNAME: null,
    CF_ACCESS_GATEWAY_APP_ID: null,
    CF_ACCESS_GATEWAY_APP_DOMAIN: null,
    CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: null,
  })),
  restoreManagedAccessConfigSnapshot: vi.fn(),
  cleanupSupersededManagedHubAccess: vi.fn(async () => undefined),
  provisionManagedServiceHosts: vi.fn(async () => ({
    gateway: {
      hostname: "tiller-gateway.paperwing.dev",
      app: { id: "gateway-app" },
      appDomain: "tiller-gateway.paperwing.dev",
      serviceTokenPolicy: { id: "gateway-policy" },
    },
  })),
}));

const { resolveSetupStatus } = vi.hoisted(() => ({
  resolveSetupStatus: vi.fn(async () => ({
    needsSetup: false,
    isLocalDev: false,
    currentOrigin: "https://tiller.paperwing.dev",
    hubUrl: "https://tiller.paperwing.dev",
    hostKind: "custom-domain",
    workerServiceName: null,
    modelAuthConfigured: true,
    modelAuthMode: "subscription",
    hasClaudeSubscription: true,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    hasOpenAIKey: false,
    planChatgptConfigured: false,
    planChatgptAvailable: false,
    planChatgptReason: null,
    hostRegistered: false,
    hostRegisteredMode: "none",
    hostGatewayAvailable: false,
    hostGatewayConfigured: false,
    hostGatewayMode: "none",
    enabledHarnesses: ["claude-code"],
    protectionMode: "cf-access",
    protectionCanAutomate: true,
    serviceTokenConfigured: true,
    gatewayHostname: "tiller-gateway.paperwing.dev",
    browserProtected: true,
    gatewayProvisioned: false,
    gatewaySupportAvailable: false,
    gatewaySupportReason: "The protected Tiller gateway hostname has not been provisioned yet.",
    workersDevCutoverPending: true,
    unsupportedProtectionConfig: false,
    workersDevAliasDisabled: false,
    protectionAppDomain: "tiller.paperwing.dev",
    hostConnected: false,
    hostConnectionMode: "none",
    idleTimeoutMinutes: 10,
    canonicalMainBootstrapDepth: 0,
  })),
}));

vi.mock("../protection", () => ({
  resolveProtectionState: vi.fn(async () => ({
    currentOrigin: "https://tiller.paperwing.dev",
    hubUrl: "https://tiller.paperwing.dev",
    hostKind: "custom-domain",
    protectionMode: "public",
    protectionCanAutomate: true,
    serviceTokenConfigured: true,
    unsupportedProtectionConfig: false,
    workersDevAliasDisabled: false,
    protectionAppDomain: null,
  })),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

vi.mock("../setup/status-resolver", () => ({
  resolveSetupStatus,
}));

vi.mock("../access/cloudflare-api", () => ({
  resolveAccountForHostname: vi.fn(async () => ({
    hostname: "tiller.paperwing.dev",
    accountId: "acc-123",
    zoneId: "zone-123",
    zoneName: "paperwing.dev",
  })),
}));

vi.mock("../access/manage", () => ({
  prepareManagedExactHostAccess,
  buildPersistedManagedAccessConfig,
  persistManagedAccessConfig,
  readManagedAccessConfigSnapshot,
  restoreManagedAccessConfigSnapshot,
  cleanupSupersededManagedHubAccess,
  provisionManagedServiceHosts,
}));

import accessRoutes from "../access/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", accessRoutes);
  return app;
}

describe("POST /api/access/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prepareManagedExactHostAccess.mockResolvedValue({
      accountId: "acc-123",
      hostname: "tiller.paperwing.dev",
      app: { id: "hub-app", aud: "hub-aud" },
      appDomain: "tiller.paperwing.dev",
      browserPolicy: { id: "browser-policy" },
      serviceToken: {
        id: "service-token",
        client_id: "client-id",
        client_secret: "client-secret",
      },
      serviceTokenPolicy: { id: "service-policy" },
      previousAppId: null,
      previousBrowserPolicyId: null,
      previousServiceTokenId: null,
      previousServiceTokenPolicyId: null,
      cleanupDraftResources: vi.fn(async () => undefined),
    });
  });

  it("repairs hub browser protection without provisioning the gateway host", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/access/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiToken: "cfat_test",
          emails: ["jamie@example.com"],
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      hostname: "tiller.paperwing.dev",
      status: {
        browserProtected: true,
        gatewayProvisioned: false,
      },
    });
    expect(prepareManagedExactHostAccess).toHaveBeenCalledOnce();
    expect(persistManagedAccessConfig).toHaveBeenCalledOnce();
    expect(cleanupSupersededManagedHubAccess).toHaveBeenCalledOnce();
    expect(provisionManagedServiceHosts).not.toHaveBeenCalled();
  });
});

describe("POST /api/access/provision-machine-hosts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("provisions the gateway Access app with the shared service token", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/access/provision-machine-hosts",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiToken: "cfat_test",
        }),
      },
      {
        CF_ACCESS_SERVICE_TOKEN_ID: "service-token",
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      hostname: "tiller.paperwing.dev",
      gatewayHostname: "tiller-gateway.paperwing.dev",
      status: {
        browserProtected: true,
      },
    });

    expect(provisionManagedServiceHosts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      gatewayHostname: "tiller-gateway.paperwing.dev",
      serviceTokenId: "service-token",
    }));
  });
});
