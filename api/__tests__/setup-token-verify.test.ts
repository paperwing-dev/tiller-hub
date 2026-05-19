import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { CloudflareApiError } from "../cloudflare-errors";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
}));

vi.mock("../setup/cloudflare", () => ({
  detachWorkerCustomDomain: vi.fn(),
  disableWorkerDevAlias: vi.fn(),
  ensureWorkerCustomDomain: vi.fn(),
  resolveWorkerServiceName: vi.fn(async () => "tiller-hub"),
  verifyWorkerDomainAccess: vi.fn(async () => undefined),
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

vi.mock("../protection", () => ({
  resolveModelAuthState: vi.fn(async () => ({
    configured: true,
    hasClaudeSubscription: true,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    hasOpenAIKey: false,
    mode: "subscription",
  })),
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
}));

import setupRoutes from "../setup/routes";
import { listAccessApps, listServiceTokens } from "../access/cloudflare-api";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", setupRoutes);
  return app;
}

describe("POST /api/setup/verify-cloudflare-token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns zone and worker details when the token can reach all required APIs", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/setup/verify-cloudflare-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "tiller.paperwing.dev",
          apiToken: "cfat_test",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      hostname: "tiller.paperwing.dev",
      zoneName: "paperwing.dev",
      workerServiceName: "tiller-hub",
      gatewayHostname: "tiller-gateway.paperwing.dev",
    });
  });

  it("returns a structured service-token permission error", async () => {
    vi.mocked(listServiceTokens).mockRejectedValueOnce(
      new CloudflareApiError({
        message: "Forbidden",
        status: 403,
        path: "/accounts/acc-123/access/service_tokens?page=1&per_page=50",
        method: "GET",
      }),
    );

    const app = createApp();
    const res = await app.request(
      "/api/setup/verify-cloudflare-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "tiller.paperwing.dev",
          apiToken: "cfat_test",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      code: "access_service_tokens_permission_missing",
      missingPermissions: ["Account -> Access: Service Tokens -> Edit"],
    });
    expect(vi.mocked(listAccessApps)).toHaveBeenCalledOnce();
  });

  it("rejects wildcard-covered hostnames as unsupported", async () => {
    vi.mocked(listAccessApps).mockResolvedValueOnce([
      { id: "wild", domain: "*.paperwing.dev" } as any,
    ]);

    const app = createApp();
    const res = await app.request(
      "/api/setup/verify-cloudflare-token",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "tiller.paperwing.dev",
          apiToken: "cfat_test",
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "wildcard_access_unsupported",
    });
  });
});
