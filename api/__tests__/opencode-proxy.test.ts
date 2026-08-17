import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

import opencodeRoutes from "../opencode/routes";
import { OPENCODE_PROXY_TOKEN_KEY } from "../env/container-auth";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("authorization", { kind: "specialized" });
    return next();
  });
  app.route("/", opencodeRoutes);
  return app;
}

describe("OpenCode proxy routes", () => {
  it("rejects missing bearer tokens", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/opencode/v1/models",
      { method: "GET" },
      { [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123" } as any,
    );

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: "Unauthorized" });
  });

  it("returns a single pinned model in OpenAI list format", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/opencode/v1/models",
      {
        method: "GET",
        headers: {
          Authorization: "Bearer proxy-token-123",
        },
      },
      { [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123" } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      object: "list",
      data: [
        {
          id: "@cf/moonshotai/kimi-k2.7-code",
          object: "model",
          created: 0,
          owned_by: "cloudflare-workers-ai",
        },
      ],
    });
  });

  it("normalizes non-streaming Workers AI output into chat/completions JSON", async () => {
    const run = vi.fn().mockResolvedValue({
      id: "upstream-1",
      object: "chat.completion",
      created: 123,
      model: "@cf/moonshotai/kimi-k2.7-code",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello from kimi",
            refusal: null,
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
        prompt_tokens_details: {
          cached_tokens: 4,
        },
      },
    });
    const app = createApp();
    const res = await app.request(
      "/api/opencode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "ignored-model",
          messages: [{ role: "user", content: "hi" }],
        }),
      },
      {
        [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123",
        AI: { run },
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "upstream-1",
      object: "chat.completion",
      model: "@cf/moonshotai/kimi-k2.7-code",
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "hello from kimi",
          },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    });
    expect(run).toHaveBeenCalledWith(
      "@cf/moonshotai/kimi-k2.7-code",
      expect.objectContaining({
        model: "@cf/moonshotai/kimi-k2.7-code",
        messages: [{ role: "user", content: "hi" }],
      }),
    );
  });

  it("rewrites streaming SSE into OpenAI chunk format", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"response":"hello "}\n\n'));
        controller.enqueue(encoder.encode('data: {"response":"world","finish_reason":"stop","usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6,"prompt_tokens_details":{"cached_tokens":1}}}\n\n'));
        controller.close();
      },
    });
    const run = vi.fn().mockResolvedValue(stream);
    const app = createApp();
    const res = await app.request(
      "/api/opencode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: true,
          stream_options: { include_usage: true },
        }),
      },
      {
        [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123",
        AI: { run },
      } as any,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const body = await res.text();
    expect(body).toContain('"object":"chat.completion.chunk"');
    expect(body).toContain('"delta":{"content":"hello "}');
    expect(body).toContain('"delta":{"content":"world"}');
    expect(body).toContain('"finish_reason":"stop"');
    expect(body).toContain('"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}');
    expect(body).not.toContain("prompt_tokens_details");
    expect(body).toContain("data: [DONE]");
  });

  it("normalizes tool-call IDs for Workers AI binding compatibility", async () => {
    const run = vi.fn().mockResolvedValue({
      response: "tool result accepted",
      finish_reason: "stop",
    });
    const app = createApp();
    const res = await app.request(
      "/api/opencode/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-token-123",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messages: [
            { role: "user", content: "use a tool" },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "chatcmpl-tool-875d3ec6179676ae",
                  type: "function",
                  function: {
                    name: "edit_file",
                    arguments: "{\"path\":\"README.md\"}",
                  },
                },
              ],
            },
            {
              role: "tool",
              tool_call_id: "chatcmpl-tool-875d3ec6179676ae",
              content: "{\"ok\":true}",
            },
          ],
        }),
      },
      {
        [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123",
        AI: { run },
      } as any,
    );

    expect(res.status).toBe(200);
    expect(run).toHaveBeenCalledWith(
      "@cf/moonshotai/kimi-k2.7-code",
      expect.objectContaining({
        messages: [
          { role: "user", content: "use a tool" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              expect.objectContaining({
                id: "chatcmplt",
              }),
            ],
          },
          {
            role: "tool",
            tool_call_id: "chatcmplt",
            content: "{\"ok\":true}",
          },
        ],
      }),
    );
  });
});
