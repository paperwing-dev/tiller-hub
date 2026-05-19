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
      reason: "Codex requires a running Tiller gateway or an OpenAI API key.",
    });
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reports unavailable when ChatGPT auth is not seeded", async () => {
    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: false,
      available: false,
      unavailableReason: "Connect ChatGPT in Tiller and keep a Tiller Host gateway online to use hosted ChatGPT planning.",
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
      unavailableReason: "Codex requires a running Tiller gateway or an OpenAI API key.",
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
      accessToken: "access-token",
      accountId: "acct_123",
    });

    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: true,
      available: true,
      unavailableReason: null,
      gatewayUrl: "https://gateway.example.com",
      route: "gateway-subscription",
      codexRoute: {
        kind: "gateway-subscription",
        gatewayUrl: "https://gateway.example.com",
        accessToken: "access-token",
        accountId: "acct_123",
      },
    });
  });

  it("does not expose hosted plan chatgpt availability through OPENAI_API_KEY fallback", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "api-fallback",
      openaiApiKey: "openai-key",
    });

    await expect(resolveChatGPTAvailability(mockEnv())).resolves.toEqual({
      configured: false,
      available: false,
      unavailableReason: "Connect ChatGPT in Tiller and keep a Tiller Host gateway online to use hosted ChatGPT planning.",
      gatewayUrl: null,
      route: null,
      codexRoute: null,
    });
  });
});
