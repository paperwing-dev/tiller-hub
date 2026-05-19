import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

const {
  ensureWorkerCustomDomain,
  disableWorkerDevAlias,
  detachWorkerCustomDomain,
  resolveWorkerServiceName,
  verifyWorkerDomainAccess,
} = vi.hoisted(() => ({
  ensureWorkerCustomDomain: vi.fn(),
  disableWorkerDevAlias: vi.fn(),
  detachWorkerCustomDomain: vi.fn(),
  resolveWorkerServiceName: vi.fn(async () => "tiller"),
  verifyWorkerDomainAccess: vi.fn(),
}));

const {
  prepareManagedExactHostAccess,
  buildPersistedManagedAccessConfig,
  persistManagedAccessConfig,
  cleanupSupersededManagedHubAccess,
  provisionManagedServiceHosts,
  readManagedAccessConfigSnapshot,
  restoreManagedAccessConfigSnapshot,
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
  cleanupSupersededManagedHubAccess: vi.fn(async () => undefined),
  provisionManagedServiceHosts: vi.fn(),
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
}));

const { resolveSetupStatus } = vi.hoisted(() => ({
  resolveSetupStatus: vi.fn(),
}));

vi.mock("../setup/cloudflare", () => ({
  ensureWorkerCustomDomain,
  disableWorkerDevAlias,
  detachWorkerCustomDomain,
  resolveWorkerServiceName,
  verifyWorkerDomainAccess,
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
}));

vi.mock("../protection", async () => {
  const actual = await vi.importActual<typeof import("../protection")>("../protection");
  return {
    ...actual,
    resolveProtectionState: vi.fn(async (_env: unknown, requestUrl: string) => ({
      currentOrigin: new URL(requestUrl).origin,
      hubUrl: new URL(requestUrl).origin,
      hostKind: "workers-dev",
      protectionMode: "public",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
    })),
  };
});

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
  listAccessApps: vi.fn(async () => []),
  listServiceTokens: vi.fn(async () => []),
}));

vi.mock("../access/manage", () => ({
  assertNoUnsupportedWildcardCoverage: vi.fn(),
  buildPersistedManagedAccessConfig,
  cleanupSupersededManagedHubAccess,
  findExactAndWildcardApps: vi.fn(() => ({ exactApp: null, overlappingWildcardApp: null })),
  persistManagedAccessConfig,
  prepareManagedExactHostAccess,
  provisionManagedServiceHosts,
  readManagedAccessConfigSnapshot,
  restoreManagedAccessConfigSnapshot,
}));

import setupRoutes from "../setup/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", setupRoutes);
  return app;
}

function createEnv() {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        setConfig: vi.fn(async () => undefined),
      })),
    },
  } as any;
}

describe("POST /api/setup/publish-protect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ensureWorkerCustomDomain.mockResolvedValue({
      hostname: "tiller.paperwing.dev",
      hubUrl: "https://tiller.paperwing.dev",
      service: "tiller",
      zoneName: "paperwing.dev",
      accountId: "acc-123",
      zoneId: "zone-123",
      domainId: "domain-123",
      attachedNow: true,
    });
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
    resolveSetupStatus.mockResolvedValue({
      browserProtected: true,
      gatewayProvisioned: true,
      workersDevCutoverPending: false,
      workersDevAliasDisabled: true,
    });
    provisionManagedServiceHosts.mockResolvedValue({
      gateway: { hostname: "tiller-gateway.paperwing.dev" },
    });
    disableWorkerDevAlias.mockResolvedValue({
      workersDevEnabled: false,
      previewsEnabled: false,
    });
  });

  it("returns partial success and keeps workers.dev active when machine-host provisioning fails", async () => {
    provisionManagedServiceHosts.mockRejectedValueOnce(new Error("gateway host failed"));
    resolveSetupStatus.mockResolvedValue({
      browserProtected: true,
      gatewayProvisioned: false,
      workersDevCutoverPending: true,
      workersDevAliasDisabled: false,
    });

    const app = createApp();
    const res = await app.request(
      "/api/setup/publish-protect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "tiller.paperwing.dev",
          apiToken: "cfat_test",
          emails: ["jamie@example.com"],
        }),
      },
      createEnv(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      hostname: "tiller.paperwing.dev",
      status: {
        browserProtected: true,
        gatewayProvisioned: false,
        workersDevCutoverPending: true,
      },
    });
    expect(disableWorkerDevAlias).not.toHaveBeenCalled();
    expect(detachWorkerCustomDomain).not.toHaveBeenCalled();
  });

  it("disables workers.dev only after machine hosts are provisioned", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/setup/publish-protect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "tiller.paperwing.dev",
          apiToken: "cfat_test",
          emails: ["jamie@example.com"],
        }),
      },
      createEnv(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      status: {
        browserProtected: true,
        gatewayProvisioned: true,
      },
    });
    expect(provisionManagedServiceHosts).toHaveBeenCalledOnce();
    expect(disableWorkerDevAlias).toHaveBeenCalledOnce();
  });
});
