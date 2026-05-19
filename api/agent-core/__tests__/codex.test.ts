import { describe, expect, it, vi } from "vitest";
import {
  buildCodexRequestConfig,
  OPENAI_RESPONSES_URL,
} from "../codex";
import type { Env } from "../../types";

const { resolveCodexModelRoute } = vi.hoisted(() => ({
  resolveCodexModelRoute: vi.fn(),
}));

vi.mock("../../model-route", async () => {
  const actual = await vi.importActual<typeof import("../../model-route")>("../../model-route");
  return {
    ...actual,
    getGatewayAccessHeaders: vi.fn(async () => ({
      "CF-Access-Client-Id": "secret-client-id",
      "CF-Access-Client-Secret": "secret-client-secret",
    })),
    resolveCodexModelRoute,
  };
});

function mockEnv(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

describe("buildCodexRequestConfig", () => {
  it("builds a gateway-backed Codex request when a subscription route is available", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "gateway-subscription",
      gatewayUrl: "https://gateway.example.com",
      providerBaseUrl: "https://gateway.example.com/v1",
      responsesUrl: "https://gateway.example.com/codex/responses",
      accessToken: "gateway_access_token",
      accountId: "acct_gateway",
    });

    const request = await buildCodexRequestConfig(
      mockEnv({}),
      "access_token",
      "acct_123",
      "session_1",
      JSON.stringify({ hello: "world" }),
    );

    expect(request.url).toBe("https://gateway.example.com/codex/responses");
    expect(request.headers.get("X-OpenAI-Access-Token")).toBe("gateway_access_token");
    expect(request.headers.get("X-ChatGPT-Account-Id")).toBe("acct_gateway");
    expect(request.headers.get("X-Session-Id")).toBe("session_1");
    expect(request.headers.get("CF-Access-Client-Id")).toBe("secret-client-id");
    expect(request.headers.get("CF-Access-Client-Secret")).toBe("secret-client-secret");
  });

  it("prefers the request account id when the gateway route does not provide one", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "gateway-subscription",
      gatewayUrl: "https://gateway.example.com",
      providerBaseUrl: "https://gateway.example.com/v1",
      responsesUrl: "https://gateway.example.com/codex/responses",
      accessToken: "gateway_access_token",
      accountId: null,
    });

    const request = await buildCodexRequestConfig(
      mockEnv({}),
      "access_token",
      "acct_123",
      "session_1",
      JSON.stringify({ hello: "world" }),
    );

    expect(request.headers.get("X-OpenAI-Access-Token")).toBe("gateway_access_token");
    expect(request.headers.get("X-ChatGPT-Account-Id")).toBe("acct_123");
  });

  it("builds an OpenAI API fallback request when no gateway subscription route is available", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "api-fallback",
      openaiApiKey: "openai_api_key",
    });

    const request = await buildCodexRequestConfig(
      mockEnv({}),
      "access_token",
      null,
      "session_1",
      JSON.stringify({ hello: "world" }),
    );

    expect(request.url).toBe(OPENAI_RESPONSES_URL);
    expect(request.headers.get("Authorization")).toBe("Bearer openai_api_key");
    expect(request.headers.get("Content-Type")).toBe("application/json");
  });
});
