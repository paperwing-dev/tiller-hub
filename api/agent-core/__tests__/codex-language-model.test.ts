import { streamText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexGatewaySessionId,
  createCodexResponsesProviderOptions,
  resolveCodexLanguageModel,
} from "../codex-language-model";
import type { Env } from "../../types";

const { mintCodexGatewaySessionToken, resolveCodexModelRoute } = vi.hoisted(() => ({
  mintCodexGatewaySessionToken: vi.fn(async () => ({ token: "session-token", expiresAt: Date.now() + 60_000 })),
  resolveCodexModelRoute: vi.fn(),
}));

vi.mock("../../gateway-session", () => ({
  mintCodexGatewaySessionToken,
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

function mockEnv(overrides: Record<string, unknown> = {}): Env {
  return overrides as unknown as Env;
}

function createResponsesSse(text: string): Response {
  const encoder = new TextEncoder();
  const events = [
    {
      type: "response.created",
      response: { id: "resp_1", created_at: 1_700_000_000, model: "gpt-5.5" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    },
    {
      type: "response.output_text.delta",
      item_id: "msg_1",
      delta: text,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1" },
    },
    {
      type: "response.completed",
      response: { usage: { input_tokens: 1, output_tokens: 1 } },
    },
  ];

  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  }), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resolveCodexModelRoute.mockReset();
  mintCodexGatewaySessionToken.mockClear();
});

describe("createCodexGatewaySessionId", () => {
  it("keeps short session ids unchanged", async () => {
    await expect(createCodexGatewaySessionId("session_1")).resolves.toBe("session_1");
  });

  it("hashes long session ids to the Codex prompt cache key limit", async () => {
    const longSessionId = "plan-writer:repo-1234567890:artifact-1234567890:branch-name-that-is-too-long-for-codex";

    const sessionId = await createCodexGatewaySessionId(longSessionId);
    const repeated = await createCodexGatewaySessionId(longSessionId);

    expect(sessionId).toBe(repeated);
    expect(sessionId).toMatch(/^tiller-[a-f0-9]+$/);
    expect(sessionId.length).toBeLessThanOrEqual(64);
    expect(sessionId).not.toBe(longSessionId);
  });
});

describe("resolveCodexLanguageModel", () => {
  it("creates an OpenAI Responses model for API fallback", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "api-fallback",
      openaiApiKey: "openai_api_key",
      codexRouteStatus: "api_fallback",
    });

    const resolution = await resolveCodexLanguageModel(mockEnv(), {
      chatSessionId: "session_1",
      model: "gpt-5.5",
    });

    expect(resolution.route.kind).toBe("api-fallback");
    expect(resolution.modelId).toBe("gpt-5.5");
    expect(resolution.providerBaseUrl).toBe("https://api.openai.com/v1");
    expect(resolution.model.provider).toBe("openai.responses");
    expect(resolution.promptCacheKey).toBe("session_1");
  });

  it("normalizes API fallback requests before fetch", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "api-fallback",
      openaiApiKey: "openai_api_key",
      codexRouteStatus: "api_fallback",
    });
    const requests: Request[] = [];
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      requestBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
      return createResponsesSse("hello");
    }) as typeof fetch;

    const { model } = await resolveCodexLanguageModel(mockEnv(), {
      chatSessionId: "session_api",
      model: "gpt-5.5",
      fetch: fetchMock,
    });
    const result = streamText({
      model,
      system: "You are concise.",
      prompt: "Say hello",
      providerOptions: {
        openai: {
          ...(createCodexResponsesProviderOptions().openai as Record<string, unknown>),
          promptCacheKey: "plan-chat:repo-123:artifact-456:branch-name-that-is-too-long-for-codex-gateway-cache-key",
          promptCacheRetention: "24h",
        },
      },
    });

    await expect(result.text).resolves.toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0].url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0].headers.get("Authorization")).toBe("Bearer openai_api_key");
    expect(requestBodies[0]).toMatchObject({
      model: "gpt-5.5",
      store: false,
      parallel_tool_calls: true,
      instructions: "You are concise.",
      include: ["reasoning.encrypted_content"],
    });
    expect(typeof requestBodies[0].prompt_cache_key).toBe("string");
    expect((requestBodies[0].prompt_cache_key as string).length).toBeLessThanOrEqual(64);
    expect(requestBodies[0].prompt_cache_retention).toBeUndefined();
  });

  it("creates a hosted gateway model with session-token headers", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "gateway-subscription",
      gatewayUrl: "https://gateway.example.com",
      machineId: "machine-123",
      providerBaseUrl: "https://gateway.example.com/v1",
      responsesUrl: "https://gateway.example.com/codex/responses",
      codexRouteStatus: "available",
    });

    const resolution = await resolveCodexLanguageModel(mockEnv(), {
      chatSessionId: "session_1",
      model: "gpt-5.5",
    });

    expect(resolution.route.kind).toBe("gateway-subscription");
    expect(resolution.providerBaseUrl).toBe("https://gateway.example.com/v1");
    expect(resolution.headers["X-Tiller-Gateway-Session-Token"]).toBe("session-token");
    expect(resolution.headers["X-Session-Id"]).toBe("session_1");
    expect(resolution.promptCacheKey).toBe("session_1");
    expect(resolution.headers["CF-Access-Client-Id"]).toBe("secret-client-id");
    expect(mintCodexGatewaySessionToken).toHaveBeenCalledWith(expect.anything(), {
      envSlug: "agent:session_1",
      routeKind: "gateway-subscription",
      machineId: "machine-123",
      gatewayUrl: "https://gateway.example.com",
    });
  });

  it("uses a bounded session id for gateway requests", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "host-gateway",
      machineId: "machine-123",
      providerBaseUrl: "http://host.docker.internal:8789/v1",
      responsesUrl: "http://host.docker.internal:8789/codex/responses",
      codexRouteStatus: "available",
    });
    const longSessionId = "plan-writer:repo-1234567890:artifact-1234567890:branch-name-that-is-too-long-for-codex";

    const resolution = await resolveCodexLanguageModel(mockEnv(), {
      chatSessionId: longSessionId,
      model: "gpt-5.5",
    });

    expect(resolution.headers["X-Session-Id"]).toMatch(/^tiller-[a-f0-9]+$/);
    expect(resolution.headers["X-Session-Id"].length).toBeLessThanOrEqual(64);
    expect(resolution.headers["X-Session-Id"]).not.toBe(longSessionId);
    expect(resolution.promptCacheKey).toBe(resolution.headers["X-Session-Id"]);
    expect(mintCodexGatewaySessionToken).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      envSlug: `agent:${longSessionId}`,
    }));
  });

  it("creates a host gateway model and strips synthetic Authorization before fetch", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "host-gateway",
      machineId: "machine-123",
      providerBaseUrl: "http://host.docker.internal:8789/v1",
      responsesUrl: "http://host.docker.internal:8789/codex/responses",
      codexRouteStatus: "available",
    });
    const requests: Request[] = [];
    const requestBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      requestBodies.push(JSON.parse(await request.text()) as Record<string, unknown>);
      return createResponsesSse("hello");
    }) as typeof fetch;

    const { model } = await resolveCodexLanguageModel(mockEnv(), {
      chatSessionId: "session_2",
      model: "gpt-5.5",
      fetch: fetchMock,
    });
    const result = streamText({
      model,
      system: "You are concise.",
      prompt: "Say hello",
      providerOptions: {
        openai: {
          ...(createCodexResponsesProviderOptions().openai as Record<string, unknown>),
          promptCacheKey: "plan-chat:repo-123:artifact-456:branch-name-that-is-too-long-for-codex-gateway-cache-key",
          promptCacheRetention: "24h",
        },
      },
    });

    await expect(result.text).resolves.toBe("hello");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requests[0].url).toBe("http://host.docker.internal:8789/v1/responses");
    expect(requests[0].headers.get("Authorization")).toBeNull();
    expect(requests[0].headers.get("X-Tiller-Gateway-Session-Token")).toBe("session-token");
    expect(requestBodies[0]).toMatchObject({
      model: "gpt-5.5",
      store: false,
      parallel_tool_calls: true,
      instructions: "You are concise.",
    });
    expect(typeof requestBodies[0].prompt_cache_key).toBe("string");
    expect((requestBodies[0].prompt_cache_key as string).length).toBeLessThanOrEqual(64);
    expect(requestBodies[0].prompt_cache_retention).toBeUndefined();
    expect(requestBodies[0].include).toEqual(["reasoning.encrypted_content"]);
    expect(requestBodies[0].input).toEqual([
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Say hello" }],
      },
    ]);
  });

  it("throws the unavailable route reason", async () => {
    resolveCodexModelRoute.mockResolvedValue({
      kind: "unavailable",
      reason: "Codex is unavailable.",
      codexRouteStatus: "unavailable",
    });

    await expect(
      resolveCodexLanguageModel(mockEnv(), {
        chatSessionId: "session_1",
      }),
    ).rejects.toThrow("Codex is unavailable.");
  });
});
