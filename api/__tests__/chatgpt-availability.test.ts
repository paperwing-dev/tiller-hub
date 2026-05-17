import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatGPTAvailability } from "../chatgpt-availability";
import type { Env } from "../types";

const {
  getOpenAIAuthStatus,
  resolveCodexModelRoute,
} = vi.hoisted(() => ({
  getOpenAIAuthStatus: vi.fn(),
  resolveCodexModelRoute: vi.fn(),
}));
const originalFetch = global.fetch;

vi.mock("../openai-auth", () => ({
  getStatus: getOpenAIAuthStatus,
}));

vi.mock("../model-route", () => ({
  resolveCodexModelRoute,
}));

function mockEnv(overrides: Record<string, unknown> = {}): Env {
  return overrides as unknown as Env;
}

describe("resolveChatGPTAvailability", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: false });
    resolveCodexModelRoute.mockResolvedValue({
      kind: "unavailable",
      reason: "Codex requires a running Subscription Gateway or an API key.",
      codexRouteStatus: "gateway_offline",
    });
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reports unavailable when a Codex subscription login is not imported", async () => {
    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: false,
      available: false,
      unavailableReason: "Import a Codex subscription login in Tiller Self Host and keep the Subscription Gateway online to use the subscription-backed OpenAI planner.",
      codexRouteStatus: "gateway_offline",
      gatewayUrl: null,
      route: null,
      codexRoute: null,
    });
  });

  it("reports unavailable when no active gateway or API fallback is available", async () => {
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: true });

    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: true,
      available: false,
      unavailableReason: "Codex requires a running Subscription Gateway or an API key.",
      codexRouteStatus: "gateway_offline",
      gatewayUrl: null,
      route: null,
      codexRoute: null,
    });
  });

  it("reports available when the active gateway subscription route is healthy", async () => {
    getOpenAIAuthStatus.mockResolvedValue({ authenticated: true });
    resolveCodexModelRoute.mockResolvedValue({
      kind: "gateway-subscription",
      gatewayUrl: "https://gateway.example.com",
      machineId: "machine-123",
      providerBaseUrl: "https://gateway.example.com/v1",
      responsesUrl: "https://gateway.example.com/codex/responses",
      codexRouteStatus: "available",
    });

    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: true,
      available: true,
      unavailableReason: null,
      codexRouteStatus: "available",
      gatewayUrl: "https://gateway.example.com",
      route: "gateway-subscription",
      codexRoute: {
        kind: "gateway-subscription",
        gatewayUrl: "https://gateway.example.com",
        machineId: "machine-123",
        providerBaseUrl: "https://gateway.example.com/v1",
        responsesUrl: "https://gateway.example.com/codex/responses",
        codexRouteStatus: "available",
      },
    });
  });

  it("reports available through OPENAI_API_KEY fallback", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "api-fallback",
      openaiApiKey: "openai-key",
      codexRouteStatus: "api_fallback",
    });

    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: true,
      available: true,
      unavailableReason: null,
      codexRouteStatus: "api_fallback",
      gatewayUrl: null,
      route: "api-fallback",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai-key",
        codexRouteStatus: "api_fallback",
      },
    });
  });
});
