import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

const {
  readRegisteredHostService,
  readRoutableHostService,
  isQuickTunnelUrl,
  githubAppMocks,
} = vi.hoisted(() => ({
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
  isQuickTunnelUrl: vi.fn((url: string) => url.includes("trycloudflare.com")),
  githubAppMocks: {
    getGitHubAppConfig: vi.fn(async () => null),
    getGitHubAppInstallUrl: vi.fn((slug: string) => `https://github.com/apps/${slug}/installations/new`),
    getGitHubAppManageUrl: vi.fn(() => "https://github.com/settings/installations"),
    isGitHubAppAllowedForRequest: vi.fn(async () => true),
    listGitHubAppRepositories: vi.fn(async () => ({ repositories: [], warnings: [] })),
  },
}));

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
  loadConfig: vi.fn(async () => ({})),
  getIdleTimeoutMinutes: vi.fn(async () => 10),
  getCanonicalMainBootstrapDepth: vi.fn(async () => 0),
  setDeploymentMode: vi.fn(),
  resolveDeploymentMode: vi.fn(async (_env: unknown, options: { hostRegistered?: boolean; hostGatewayConfigured?: boolean; gatewayProvisioned?: boolean }) =>
    options.hostRegistered || options.hostGatewayConfigured || options.gatewayProvisioned ? "self-host" : "hosted"),
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
    unavailableReason: "Configure OPENAI_API_KEY to use the OpenAI planner in Hosted Tiller.",
    codexRouteStatus: "unavailable",
    gatewayUrl: null,
    route: null,
  })),
}));

vi.mock("../service-registry", () => ({
  readRegisteredHostService,
  readRoutableHostService,
  isQuickTunnelUrl,
}));

vi.mock("../github/app", () => githubAppMocks);

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
      chatgptAuthStatus: "missing",
      hasOpenAIKey: false,
    })),
    resolveProtectionState: vi.fn(async (_env: unknown, requestUrl: string) => ({
      currentOrigin: new URL(requestUrl).origin,
      hubUrl: new URL(requestUrl).origin,
      routeKind: "custom-domain",
      hostKind: "custom-domain",
      protectionMode: "public",
      protectionCanAutomate: true,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
      accessConfigured: false,
      accessIssuer: null,
      accessJwksUrl: null,
    })),
  };
});

import setupRoutes from "../setup/routes";
import { resolveEnabledHarnesses } from "../env/harness";
import { hasEnabledHarnessModelAuth, resolveProtectionState } from "../protection";
import { SELF_HOST_STATE_KEY } from "../self-host/state";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", setupRoutes);
  return app;
}

function failedSelfHostState() {
  return {
    schemaVersion: 2,
    phase: "failed",
    attemptId: "attempt-1",
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
    progress: {
      step: "failed",
      message: "Self Host setup failed.",
      error: "Docker is not ready.",
      updatedAt: "2026-05-27T00:00:00.000Z",
    },
  };
}

function envWithSelfHostState(state: unknown): HonoEnv["Bindings"] {
  const config: Record<string, string> = {
    [SELF_HOST_STATE_KEY]: JSON.stringify(state),
  };
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        getConfig: vi.fn((key: string) => config[key]),
        getAllConfig: vi.fn(() => config),
      })),
    },
  } as unknown as HonoEnv["Bindings"];
}

describe("GET /api/setup/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubAppMocks.getGitHubAppConfig.mockResolvedValue(null);
    githubAppMocks.getGitHubAppInstallUrl.mockImplementation((slug: string) => `https://github.com/apps/${slug}/installations/new`);
    githubAppMocks.getGitHubAppManageUrl.mockReturnValue("https://github.com/settings/installations");
    githubAppMocks.isGitHubAppAllowedForRequest.mockResolvedValue(true);
    githubAppMocks.listGitHubAppRepositories.mockResolvedValue({ repositories: [], warnings: [] });
  });

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
      githubAppInstallUrl: null,
      githubAppManageUrl: "https://github.com/settings/installations",
      deploymentMode: "self-host",
      routeKind: "custom-domain",
      browserProtected: false,
      gatewayProvisioned: false,
      workersDevCutoverPending: true,
      openaiPlannerConfigured: false,
      openaiPlannerAvailable: false,
      openaiPlannerReason: "Configure OPENAI_API_KEY to use the OpenAI planner in Hosted Tiller.",
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

  it("requires protect-hub first on fresh hosted workers.dev deployments", async () => {
    vi.mocked(resolveProtectionState).mockResolvedValueOnce({
      currentOrigin: "https://demo.preview.workers.dev",
      hubUrl: "https://demo.preview.workers.dev",
      routeKind: "workers-dev",
      hostKind: "workers-dev",
      protectionMode: "public",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
      accessConfigured: false,
      accessIssuer: null,
      accessJwksUrl: null,
    });
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      needsSetup: true,
      setupPhase: "protect-hub",
      routeKind: "workers-dev",
      accessConfigured: false,
    });
  });

  it("treats the Workers AI binding as ready model access for OpenCode", async () => {
    vi.mocked(resolveEnabledHarnesses).mockReturnValueOnce(["opencode"]);
    vi.mocked(hasEnabledHarnessModelAuth).mockReturnValueOnce(false);
    githubAppMocks.getGitHubAppConfig.mockResolvedValueOnce({
      appId: "1",
      clientId: "client-id",
      slug: "tiller-test",
      privateKey: "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----",
    });
    githubAppMocks.listGitHubAppRepositories.mockResolvedValueOnce({
      repositories: [{
        installationId: 123,
        repositoryId: 456,
        fullName: "owner/repo",
        repoUrl: "https://github.com/owner/repo",
        private: true,
        defaultBranch: "main",
      }],
      warnings: [],
    });
    vi.mocked(resolveProtectionState).mockResolvedValueOnce({
      currentOrigin: "https://tiller.example.com",
      hubUrl: "https://tiller.example.com",
      routeKind: "custom-domain",
      hostKind: "custom-domain",
      protectionMode: "cf-access",
      protectionCanAutomate: true,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: "tiller.example.com",
      accessConfigured: true,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessJwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    });
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup/status",
      { method: "GET" },
      { AI: {} } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      needsSetup: false,
      setupPhase: "complete",
      workersAiConfigured: true,
      hostedModelReady: true,
      hostedModelBlockingReasons: [],
      githubAppReady: true,
    });
  });

  it("requires GitHub App setup after Access is ready", async () => {
    vi.mocked(resolveEnabledHarnesses).mockReturnValueOnce(["opencode"]);
    vi.mocked(hasEnabledHarnessModelAuth).mockReturnValueOnce(false);
    vi.mocked(resolveProtectionState).mockResolvedValueOnce({
      currentOrigin: "https://demo.preview.workers.dev",
      hubUrl: "https://demo.preview.workers.dev",
      routeKind: "workers-dev",
      hostKind: "workers-dev",
      protectionMode: "cf-access",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: "demo.preview.workers.dev",
      accessConfigured: true,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessJwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    });
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      { AI: {} } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      needsSetup: true,
      setupPhase: "github-app",
      accessConfigured: true,
      githubAppConfigured: false,
      githubAppReady: false,
    });
  });

  it("does not expose failed Self Host attempts as active setup status", async () => {
    vi.mocked(resolveProtectionState).mockResolvedValueOnce({
      currentOrigin: "https://demo.preview.workers.dev",
      hubUrl: "https://demo.preview.workers.dev",
      routeKind: "workers-dev",
      hostKind: "workers-dev",
      protectionMode: "cf-access",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: "demo.preview.workers.dev",
      accessConfigured: true,
      accessIssuer: "https://team.cloudflareaccess.com",
      accessJwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
    });
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      envWithSelfHostState(failedSelfHostState()),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      deploymentMode: "hosted",
      selfHostStatus: "not-enabled",
      selfHostSetupAttemptId: null,
      workersDevHubUrl: "https://demo.preview.workers.dev",
    });
  });

  it("uses the current request route for protect-hub even if HUB_PUBLIC_URL points at a custom domain", async () => {
    vi.mocked(resolveProtectionState).mockResolvedValueOnce({
      currentOrigin: "https://demo.preview.workers.dev",
      hubUrl: "https://tiller.example.com",
      routeKind: "custom-domain",
      hostKind: "custom-domain",
      protectionMode: "public",
      protectionCanAutomate: true,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
      accessConfigured: false,
      accessIssuer: null,
      accessJwksUrl: null,
    });
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      {} as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      needsSetup: true,
      setupPhase: "protect-hub",
      currentOrigin: "https://demo.preview.workers.dev",
      hubUrl: "https://tiller.example.com",
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
