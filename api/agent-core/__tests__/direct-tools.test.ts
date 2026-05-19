import { afterEach, describe, expect, it, vi } from "vitest";
import { runDirectToolsRuntime } from "../runtimes/direct-tools";
import type { AgentSpec, HostedTool } from "../types";

const WORKERS_AI_SPEC: AgentSpec = {
  name: "research",
  runtime: "direct-tools",
  modelTarget: {
    provider: "workers-ai",
    defaultModel: "@cf/nvidia/nemotron-3-120b-a12b",
  },
  toolNames: [],
  baseInstructions: "test",
  maxSteps: 1,
};

const EXTERNAL_CODEX_SPEC: AgentSpec = {
  name: "plan",
  runtime: "direct-tools",
  modelTarget: {
    provider: "external-codex",
    defaultModel: "gpt-5.4",
  },
  toolNames: [],
  baseInstructions: "test",
  maxSteps: 1,
};

function createSseResponse(events: Array<{ event: string; data: unknown }>): Response {
  const encoder = new TextEncoder();

  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(
          encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`),
        );
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
});

describe("runDirectToolsRuntime", () => {
  it("rejects workers-ai specs so they do not silently route through Codex", async () => {
    await expect(
      runDirectToolsRuntime({
        env: {} as any,
        spec: WORKERS_AI_SPEC,
        accessToken: "",
        accountId: null,
        model: "@cf/nvidia/nemotron-3-120b-a12b",
        systemPrompt: "test",
        responseTools: [],
        toolRegistry: new Map(),
        initialInput: [],
      }),
    ).rejects.toThrow("only supports external-codex models");
  });

  it("falls back to the completed output text when the stream has no text deltas", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        {
          event: "response.completed",
          data: {
            response: {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Draft saved." }],
              }],
            },
          },
        },
      ]),
    );

    let text = "";

    await runDirectToolsRuntime({
      env: {} as any,
      spec: EXTERNAL_CODEX_SPEC,
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry: new Map(),
      initialInput: [],
      hooks: {
        onTextDelta: (delta) => {
          text += delta;
        },
      },
    });

    expect(text).toBe("Draft saved.");
  });

  it("does not duplicate text that was already streamed before completion", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        {
          event: "response.output_item.added",
          data: {
            item: {
              type: "message",
              role: "assistant",
              content: [],
            },
          },
        },
        {
          event: "response.output_text.delta",
          data: { delta: "Draft saved." },
        },
        {
          event: "response.completed",
          data: {
            response: {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Draft saved." }],
              }],
            },
          },
        },
      ]),
    );

    let text = "";

    await runDirectToolsRuntime({
      env: {} as any,
      spec: EXTERNAL_CODEX_SPEC,
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry: new Map(),
      initialInput: [],
      hooks: {
        onTextDelta: (delta) => {
          text += delta;
        },
      },
    });

    expect(text).toBe("Draft saved.");
  });

  it("appends any missing completed text suffix after partial streamed deltas", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        {
          event: "response.output_item.added",
          data: {
            item: {
              type: "message",
              role: "assistant",
              content: [],
            },
          },
        },
        {
          event: "response.output_text.delta",
          data: { delta: "Draft" },
        },
        {
          event: "response.completed",
          data: {
            response: {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "Draft saved." }],
              }],
            },
          },
        },
      ]),
    );

    let text = "";

    await runDirectToolsRuntime({
      env: {} as any,
      spec: EXTERNAL_CODEX_SPEC,
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry: new Map(),
      initialInput: [],
      hooks: {
        onTextDelta: (delta) => {
          text += delta;
        },
      },
    });

    expect(text).toBe("Draft saved.");
  });

  it("falls back to completed text parts that use the generic text shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        {
          event: "response.completed",
          data: {
            response: {
              output: [{
                type: "message",
                role: "assistant",
                content: [{ type: "text", text: "Draft saved." }],
              }],
            },
          },
        },
      ]),
    );

    let text = "";

    await runDirectToolsRuntime({
      env: {} as any,
      spec: EXTERNAL_CODEX_SPEC,
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry: new Map(),
      initialInput: [],
      hooks: {
        onTextDelta: (delta) => {
          text += delta;
        },
      },
    });

    expect(text).toBe("Draft saved.");
  });

  it("falls back to done output items when the completed response output is empty", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        {
          event: "response.output_item.done",
          data: {
            output_index: 0,
            item: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "Draft saved." }],
            },
          },
        },
        {
          event: "response.completed",
          data: {
            response: {
              output: [],
            },
          },
        },
      ]),
    );

    let text = "";

    const result = await runDirectToolsRuntime({
      env: {} as any,
      spec: EXTERNAL_CODEX_SPEC,
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry: new Map(),
      initialInput: [],
      hooks: {
        onTextDelta: (delta) => {
          text += delta;
        },
      },
    });

    expect(text).toBe("Draft saved.");
    expect(result).toContainEqual({
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Draft saved." }],
    });
  });

  it("executes tool calls from done output items when the completed response output is empty", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createSseResponse([
          {
            event: "response.output_item.done",
            data: {
              output_index: 0,
              item: {
                type: "function_call",
                name: "read_file",
                call_id: "call_1",
                arguments: JSON.stringify({ path: "/README.md" }),
              },
            },
          },
          {
            event: "response.completed",
            data: {
              response: {
                output: [],
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          {
            event: "response.completed",
            data: {
              response: {
                output: [{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "I read the file." }],
                }],
              },
            },
          },
        ]),
      );

    const toolRegistry = new Map<string, HostedTool>([
      [
        "read_file",
        {
          definition: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          execute: async () => ({
            ok: true,
            output: "file contents",
          }),
        },
      ],
    ]) as any;

    const toolInputs: Record<string, unknown>[] = [];
    let text = "";

    await runDirectToolsRuntime({
      env: {} as any,
      spec: {
        ...EXTERNAL_CODEX_SPEC,
        maxSteps: 2,
      },
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry,
      initialInput: [],
      hooks: {
        onToolExecuting: (_call, input) => {
          toolInputs.push(input);
        },
        onTextDelta: (delta) => {
          text += delta;
        },
      },
    });

    expect(toolInputs).toEqual([{ path: "/README.md" }]);
    expect(text).toBe("I read the file.");
  });

  it("fails loudly when Codex completes without text or tool calls", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      createSseResponse([
        {
          event: "response.output_item.added",
          data: {
            item: {
              type: "message",
              role: "assistant",
              content: [],
            },
          },
        },
        {
          event: "response.completed",
          data: {
            response: {
              output: [{
                type: "message",
                role: "assistant",
                content: [],
              }],
            },
          },
        },
      ]),
    );

    let textStarted = false;

    await expect(
      runDirectToolsRuntime({
        env: {} as any,
        spec: EXTERNAL_CODEX_SPEC,
        accessToken: "",
        accountId: null,
        model: "gpt-5.4",
        systemPrompt: "test",
        codexRoute: {
          kind: "api-fallback",
          openaiApiKey: "openai_api_key",
        },
        responseTools: [],
        toolRegistry: new Map(),
        initialInput: [],
        hooks: {
          onTextStart: () => {
            textStarted = true;
          },
        },
      }),
    ).rejects.toThrow("Codex completed without renderable text or tool calls");

    expect(textStarted).toBe(false);
  });

  it("converts hosted tool failures into inline tool errors and continues the run", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        createSseResponse([
          {
            event: "response.completed",
            data: {
              response: {
                output: [{
                  type: "function_call",
                  name: "read_file",
                  call_id: "call_1",
                  arguments: JSON.stringify({ path: "/missing.txt" }),
                }],
              },
            },
          },
        ]),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          {
            event: "response.completed",
            data: {
              response: {
                output: [{
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: "I could not read that file." }],
                }],
              },
            },
          },
        ]),
      );

    const toolRegistry = new Map<string, HostedTool>([
      [
        "read_file",
        {
          definition: {
            name: "read_file",
            description: "Read a file",
            parameters: {
              type: "object",
              properties: {
                path: { type: "string", description: "File path" },
              },
              required: ["path"],
              additionalProperties: false,
            },
          },
          execute: async () => ({
            ok: false,
            error: {
              code: "not_found",
              message: "File not found at /missing.txt",
            },
          }),
        },
      ],
    ]) as any;

    const toolErrors: string[] = [];

    const result = await runDirectToolsRuntime({
      env: {} as any,
      spec: {
        ...EXTERNAL_CODEX_SPEC,
        maxSteps: 2,
      },
      accessToken: "",
      accountId: null,
      model: "gpt-5.4",
      systemPrompt: "test",
      codexRoute: {
        kind: "api-fallback",
        openaiApiKey: "openai_api_key",
      },
      responseTools: [],
      toolRegistry,
      initialInput: [],
      hooks: {
        onToolError: (_call, _input, errorText) => {
          toolErrors.push(errorText);
        },
      },
    });

    expect(toolErrors).toEqual(["File not found at /missing.txt"]);
    expect(result).toContainEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: "File not found at /missing.txt",
    });
  });
});
