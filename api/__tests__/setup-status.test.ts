import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

const {
  readRegisteredHostService,
  readRoutableHostService,
  isQuickTunnelUrl,
} = vi.hoisted(() => ({
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
  isQuickTunnelUrl: vi.fn((url: string) => url.includes("trycloudflare.com")),
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
  loadConfig: vi.fn(async () => ({})),
  getIdleTimeoutMinutes: vi.fn(async () => 10),
  getCanonicalMainBootstrapDepth: vi.fn(async () => 0),
}));

vi.mock("../setup/cloudflare", () => ({
  detachWorkerCustomDomain: vi.fn(),
  disableWorkerDevAlias: vi.fn(),
  ensureWorkerCustomDomain: vi.fn(),
  resolveWorkerServiceName: vi.fn(async () => null),
  verifyWorkerDomainAccess: vi.fn(),
}));

vi.mock("../env/harness", () => ({
  resolveEnabledHarnesses: vi.fn(() => ["claude-code"]),
}));

vi.mock("../chatgpt-availability", () => ({
  resolveChatGPTAvailability: vi.fn(async () => ({
    configured: false,
    available: false,
    unavailableReason: "Connect ChatGPT in Tiller and keep a Tiller Host gateway online to use hosted ChatGPT planning.",
    gatewayUrl: null,
    route: null,
  })),
}));

vi.mock("../service-registry", () => ({
  readRegisteredHostService,
  readRoutableHostService,
  isQuickTunnelUrl,
}));

vi.mock("../protection", async () => {
  const actual = await vi.importActual<typeof import("../protection")>("../protection");
  return {
    ...actual,
    hasEnabledHarnessModelAuth: vi.fn(() => true),
    resolveModelAuthState: vi.fn(async () => ({
      configured: true,
      mode: "subscription",
      hasClaudeSubscription: true,
      hasAnthropicKey: false,
      hasChatGPTAuth: false,
      hasOpenAIKey: false,
    })),
    resolveProtectionState: vi.fn(async (_env: unknown, requestUrl: string) => ({
      currentOrigin: new URL(requestUrl).origin,
      hubUrl: new URL(requestUrl).origin,
      hostKind: "custom-domain",
      protectionMode: "public",
      protectionCanAutomate: true,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
    })),
  };
});

import setupRoutes from "../setup/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", setupRoutes);
  return app;
}

describe("GET /api/setup/status", () => {
  it("marks localhost requests as local development", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-123",
      connectedAt: "2026-04-07T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue({
      machineId: "host-123",
      connectedAt: "2026-04-07T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      transport: "session",
    });
    const app = createApp();
    const res = await app.request(
      "http://localhost:5173/api/setup/status",
      { method: "GET" },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      isLocalDev: true,
      hostRegistered: true,
      hostRegisteredMode: "session",
      hostConnected: true,
      hostConnectionMode: "session",
      hostGatewayAvailable: false,
      hostGatewayConfigured: false,
      hostGatewayMode: "none",
      canonicalMainBootstrapDepth: 0,
      browserProtected: false,
      gatewayProvisioned: false,
      workersDevCutoverPending: true,
      planChatgptConfigured: false,
      planChatgptAvailable: false,
      planChatgptReason: "Connect ChatGPT in Tiller and keep a Tiller Host gateway online to use hosted ChatGPT planning.",
    });
  });

  it("does not mark deployed origins as local development", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-123",
      connectedAt: "2026-04-07T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: false,
      gatewayPort: 8788,
      gatewayUrl: "https://tiller-gateway.example.com",
      gatewayTunnelType: "named",
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue({
      machineId: "host-123",
      connectedAt: "2026-04-07T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: false,
      gatewayPort: 8788,
      gatewayUrl: "https://tiller-gateway.example.com",
      gatewayTunnelType: "named",
      transport: "session",
    });
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup/status",
      { method: "GET" },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      isLocalDev: false,
      canonicalMainBootstrapDepth: 0,
      gatewayHostname: "tiller-gateway.example.com",
      hostRegistered: true,
      hostRegisteredMode: "session",
      hostConnected: true,
      hostConnectionMode: "session",
      browserProtected: false,
      gatewayProvisioned: false,
      workersDevCutoverPending: true,
      hostGatewayAvailable: true,
      hostGatewayConfigured: true,
      hostGatewayMode: "named",
    });
  });

  it("treats local-only backend mode as local development even on a LAN URL", async () => {
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);
    const app = createApp();
    const res = await app.request(
      "http://192.168.1.50:5173/api/setup/status",
      { method: "GET" },
      { LOCAL_DEV_ONLY_BACKEND: "true" } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      isLocalDev: true,
      canonicalMainBootstrapDepth: 0,
    });
  });

  it("reports registered-but-not-routable host state separately", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-123",
      connectedAt: "2026-04-07T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      gatewayUrl: "https://tiller-gateway.example.com",
      gatewayTunnelType: "named",
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup/status",
      { method: "GET" },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      hostRegistered: true,
      hostRegisteredMode: "session",
      hostConnected: false,
      hostConnectionMode: "none",
      hostGatewayConfigured: true,
      hostGatewayAvailable: false,
      hostGatewayMode: "named",
    });
  });
});
