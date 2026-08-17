import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv, HostServiceRegistration } from "../types";
import {
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
} from "../../shared/cloudflare-timeout";
import { maintainerDevAccessBindings } from "./access-binding-fixture";

const mocks = vi.hoisted(() => ({
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
  getBillingSelections: vi.fn(async () => ({
    claudeBillingMode: null,
    openaiBillingMode: null,
  })),
  resolveEnabledHarnesses: vi.fn(() => ["claude-code"]),
  hasEnabledHarnessModelAuth: vi.fn(() => true),
  resolveModelAuthState: vi.fn(async () => ({
    configured: true,
    hasClaudeSubscription: true,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    chatgptAuthStatus: "missing",
    hasOpenAIKey: false,
  })),
  resolveProtectionState: vi.fn(async (_env: unknown, requestUrl: string) => ({
    currentOrigin: new URL(requestUrl).origin,
    hubUrl: new URL(requestUrl).origin,
    protectionMode: "cf-access",
    serviceTokenConfigured: true,
    accessConfigured: true,
  })),
  getGitHubAppConfig: vi.fn(async () => ({
    appId: "1",
    clientId: "client-id",
    slug: "tiller-test",
    privateKey: "test-key",
  })),
  isGitHubAppAllowedForRequest: vi.fn(async () => true),
  isGitHubAppInstallationReady: vi.fn(async () => true),
}));

vi.mock("../setup/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../setup/config")>();
  return {
    ...actual,
    getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
    invalidateConfigCache: vi.fn(),
    getIdleTimeoutMinutes: vi.fn(async () => 10),
    getBillingSelections: mocks.getBillingSelections,
  };
});

vi.mock("../env/harness", () => ({
  resolveEnabledHarnesses: mocks.resolveEnabledHarnesses,
}));

vi.mock("../service-registry", () => ({
  readRegisteredHostService: mocks.readRegisteredHostService,
  readRoutableHostService: mocks.readRoutableHostService,
}));

vi.mock("../github/app", () => ({
  getGitHubAppConfig: mocks.getGitHubAppConfig,
  getGitHubAppInstallUrl: (slug: string) => `https://github.com/apps/${slug}/installations/new`,
  getGitHubAppManageUrl: () => "https://github.com/settings/installations",
  isGitHubAppAllowedForRequest: mocks.isGitHubAppAllowedForRequest,
  isGitHubAppInstallationReady: mocks.isGitHubAppInstallationReady,
}));

vi.mock("../protection", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../protection")>();
  return {
    ...actual,
    hasEnabledHarnessModelAuth: mocks.hasEnabledHarnessModelAuth,
    resolveModelAuthState: mocks.resolveModelAuthState,
    resolveProtectionState: mocks.resolveProtectionState,
  };
});

import setupRoutes from "../setup/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", setupRoutes);
  return app;
}

function createHubStore(overrides: Record<string, unknown> = {}) {
  return {
    setConfig: vi.fn(),
    getConfig: vi.fn(async () => undefined),
    getAllConfig: vi.fn(async () => ({})),
    getExecutionStatus: vi.fn(async () => ({
      selected: { target: "cf" },
      selectedHost: null,
      candidate: { state: "not_connected" },
      executionReady: true,
    })),
    ...overrides,
  };
}

function createEnv(
  extra: Record<string, unknown> = {},
  storeOverrides: Record<string, unknown> = {},
): HonoEnv["Bindings"] {
  const store = createHubStore(storeOverrides);
  return {
    PLANNER_RUN: {},
    TILLER_INSTALLER_SCHEMA: "1",
    DO_LOCATION_HINT: "wnam",
    TILLER_RELEASE_ID: "a".repeat(40),
    TILLER_WORKERS_DEV_HOSTNAME: "tiller.demo.workers.dev",
    CF_ACCESS_ISSUER: "https://demo-tiller.cloudflareaccess.com",
    CF_ACCESS_AUDIENCE: "audience",
    CF_ACCESS_SERVICE_CLIENT_ID: "service-client-id",
    CF_ACCESS_TOKEN_EXPIRES_AT: "2027-07-17T00:00:00.000Z",
    TILLER_OWNER_EMAIL: "owner@example.com",
    CF_ACCESS_SERVICE_CLIENT_SECRET: "service-secret",
    ...extra,
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => store),
    },
  } as unknown as HonoEnv["Bindings"];
}

function readyMachine(overrides: Partial<HostServiceRegistration> = {}): HostServiceRegistration {
  return {
    machineId: "machine-1",
    displayName: "studio-mac",
    connectedAt: "2026-07-17T00:00:00.000Z",
    runnerCommandProtocol: 1,
    codexRuntimeAuthProtocol: 1,
    dockerAvailable: true,
    runnerAvailable: true,
    claudeSubscription: true,
    transport: "session",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readRegisteredHostService.mockResolvedValue(null);
  mocks.readRoutableHostService.mockResolvedValue(null);
  mocks.getBillingSelections.mockResolvedValue({
    claudeBillingMode: null,
    openaiBillingMode: null,
  });
  mocks.resolveEnabledHarnesses.mockReturnValue(["claude-code"]);
  mocks.hasEnabledHarnessModelAuth.mockReturnValue(true);
  mocks.resolveModelAuthState.mockResolvedValue({
    configured: true,
    hasClaudeSubscription: true,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    chatgptAuthStatus: "missing",
    hasOpenAIKey: false,
  });
  mocks.getGitHubAppConfig.mockResolvedValue({
    appId: "1",
    clientId: "client-id",
    slug: "tiller-test",
    privateKey: "test-key",
  });
  mocks.isGitHubAppAllowedForRequest.mockResolvedValue(true);
  mocks.isGitHubAppInstallationReady.mockResolvedValue(true);
});

describe("POST /api/setup", () => {
  it.each([
    CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES - 1,
    CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES + 1,
    1.5,
  ])("rejects out-of-range idle timeout %s", async (minutes) => {
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { IDLE_TIMEOUT_MINUTES: String(minutes) } }),
      },
      createEnv(),
    );

    expect(response.status).toBe(400);
  });

  it("persists billing selections separately from credentials", async () => {
    const setConfig = vi.fn();
    const env = createEnv({}, { setConfig });
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secrets: { ANTHROPIC_API_KEY: "secret" },
          settings: { claudeBillingMode: "api", openaiBillingMode: "subscription" },
        }),
      },
      env,
    );

    expect(response.status).toBe(200);
    expect(setConfig).toHaveBeenCalledWith("ANTHROPIC_API_KEY", "secret");
    expect(setConfig).toHaveBeenCalledWith("claudeBillingMode", "api");
    expect(setConfig).toHaveBeenCalledWith("openaiBillingMode", "subscription");
  });

  it("rejects the retired canonical main history-depth setting", async () => {
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secrets: { CANONICAL_MAIN_BOOTSTRAP_DEPTH: "25" } }),
      },
      createEnv(),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "Invalid keys: CANONICAL_MAIN_BOOTSTRAP_DEPTH",
    });
  });

  it("does not expose a custom-domain setup endpoint", async () => {
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/custom-domain",
      { method: "POST" },
      createEnv(),
    );
    expect(response.status).toBe(404);
  });

  it("persists only the optional onboarding dismissal", async () => {
    const setConfig = vi.fn();
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/onboarding/dismiss",
      { method: "POST" },
      createEnv({}, { setConfig }),
    );

    expect(response.status).toBe(200);
    expect(setConfig).toHaveBeenCalledWith("DASHBOARD_ONBOARDING_DISMISSED_V1", "1");
  });
});

describe("POST /api/setup/verify-model-auth", () => {
  it("tests only the requested Anthropic API key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [] }), { status: 200 }),
    );
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/verify-model-auth",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "ANTHROPIC_API_KEY" }),
      },
      createEnv({
        ANTHROPIC_API_KEY: "anthropic-test-key",
        OPENAI_API_KEY: "openai-test-key",
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      results: [{ key: "ANTHROPIC_API_KEY", mode: "api", ok: true }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-api-key": "anthropic-test-key" }),
      }),
    );
  });
});

describe("GET /api/setup/status", () => {
  it("keeps subscription execution available while a valid cached login refreshes", async () => {
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: null,
      openaiBillingMode: "subscription",
    });
    mocks.resolveEnabledHarnesses.mockReturnValue(["codex"]);
    mocks.resolveModelAuthState.mockResolvedValue({
      configured: true,
      hasClaudeSubscription: false,
      hasAnthropicKey: false,
      hasChatGPTAuth: true,
      chatgptAuthStatus: "refreshing",
      hasOpenAIKey: false,
    });

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      chatgptAuthStatus: "refreshing",
      codexRouteStatus: "available",
      openaiPlannerAvailable: true,
      openaiPlannerRoute: "subscription-app-server",
    });
  });

  it("returns the canonical workers.dev URL without retired deployment fields", async () => {
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv(),
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.workersDevHubUrl).toBe("https://tiller.demo.workers.dev");
    expect(body.installerManaged).toBe(true);
    expect(body.installationRegion).toBe("wnam");
    expect(body.tokenExpiresAt).toBe("2027-07-17T00:00:00.000Z");
    expect(body.renewalRecommended).toBe(false);
    expect(body).not.toHaveProperty("deploymentMode");
    expect(body).not.toHaveProperty("environmentBackendPolicy");
    expect(body).not.toHaveProperty("selfHostStatus");
    expect(body).not.toHaveProperty("routeKind");
    expect(body).not.toHaveProperty("workerServiceName");
  });

  it("reports only a validated live regional placement for hosted deployments", async () => {
    for (const [extra, expected] of [
      [{ DO_LOCATION_HINT: "wnam" }, "wnam"],
    ] as const) {
      const response = await createApp().request(
        "https://demo.preview.workers.dev/api/setup/status",
        { method: "GET" },
        createEnv(extra),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ installationRegion: expected });
    }

    const local = await createApp().request(
      "http://localhost:5173/api/setup/status",
      { method: "GET" },
      createEnv({ DO_LOCATION_HINT: "wnam", LOCAL_DEV_ONLY_BACKEND: "1" }),
    );
    await expect(local.json()).resolves.toMatchObject({ installationRegion: null });
  });

  it.each([
    [undefined],
    ["WNAM"],
    ["unknown"],
  ])("fails closed when installer-managed region configuration is %s", async (hint) => {
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv({ DO_LOCATION_HINT: hint }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "installation_region_configuration_error",
    });
  });

  it("exposes binding-based Access renewal readiness to installer-managed owners", async () => {
    const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv({ CF_ACCESS_TOKEN_EXPIRES_AT: tokenExpiresAt }),
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      installerManaged: true,
      tokenExpiresAt,
      renewalRecommended: true,
    });
  });

  it("does not route maintainer dev Access renewal through the customer installer", async () => {
    const tokenExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString();
    const response = await createApp().request(
      "https://tiller-dev.maintainer-preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv({
        TILLER_INSTALLER_SCHEMA: undefined,
        DO_LOCATION_HINT: "wnam",
        ...maintainerDevAccessBindings({ tokenExpiresAt }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      installerManaged: false,
      installationRegion: "wnam",
      tokenExpiresAt,
      renewalRecommended: false,
    });
  });

  it("marks localhost as contributor development", async () => {
    const response = await createApp().request(
      "http://localhost:5173/api/setup/status",
      { method: "GET" },
      createEnv({ LOCAL_DEV_ONLY_BACKEND: "1" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      isLocalDev: true,
      setupPhase: "complete",
    });
  });

  it("fails closed into Access repair with malformed installer bindings", async () => {
    const response = await createApp().request(
      "https://fresh.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv({ TILLER_INSTALLER_SCHEMA: "2" }),
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      code: "access_repair_required",
    });
  });

  it("reports current machine readiness without exposing retired runtime diagnostics", async () => {
    const machine = readyMachine();
    mocks.readRegisteredHostService.mockResolvedValue(machine);
    mocks.readRoutableHostService.mockResolvedValue(machine);

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv(),
    );

    expect(response.status).toBe(200);
    const body = await response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      hostRegistered: true,
      hostConnected: true,
    });
    expect(body).not.toHaveProperty("hostCodexRuntimeAuthProtocol");
    expect(body).not.toHaveProperty("hostRuntimeImage");
    expect(body).not.toHaveProperty("hostRegisteredMode");
    expect(body).not.toHaveProperty("hostConnectionMode");
  });

  it("uses the HubDO selection when deriving selected Codex readiness", async () => {
    const machine = readyMachine();
    mocks.readRegisteredHostService.mockResolvedValue(machine);
    mocks.readRoutableHostService.mockResolvedValue(machine);

    const response = await createApp().request(
      "https://demo.preview.workers.dev/api/setup/status",
      { method: "GET" },
      createEnv({}, {
        getExecutionStatus: vi.fn(async () => ({
          selected: { target: "host", machineId: "machine-1" },
          selectedHost: {
            state: "ready",
            machineId: "machine-1",
            displayName: "studio-mac",
          },
          candidate: {
            state: "ready",
            machineId: "machine-1",
            displayName: "studio-mac",
          },
          executionReady: true,
        })),
      }),
    );
    const body = await response.json<Record<string, unknown>>();

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty("selected");
    expect(body.hostConnected).toBe(true);
  });
});
