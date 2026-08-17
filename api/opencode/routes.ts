import { Hono, type Context } from "hono";
import type { HonoEnv } from "../types";
import { specializedServiceAuthMiddleware } from "../auth";
import { getSecret } from "../setup/config";
import { OPENCODE_PROXY_TOKEN_KEY } from "../env/container-auth";
import { getHarnessModel, KIMI_K2_7_CODE } from "../../shared/harness-catalog";

const kimiCatalogModel = getHarnessModel("opencode", KIMI_K2_7_CODE.id);
if (kimiCatalogModel?.binding.kind !== "opencode" || kimiCatalogModel.binding.provider !== "cloudflare-workers-ai") {
  throw new Error("The OpenCode Workers AI proxy requires the catalog's Kimi model binding.");
}
const FIXED_MODEL = kimiCatalogModel.binding.model;
const NO_STORE = "no-store";

type JsonRecord = Record<string, unknown>;

async function runFixedModel(ai: Ai, input: unknown): Promise<unknown> {
  const run = ai.run as unknown as (model: string, request: unknown) => Promise<unknown>;
  return run.call(ai, FIXED_MODEL, input);
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function requireProxyAuth(c: Context<HonoEnv>): Promise<Response | null> {
  const expectedToken = (await getSecret(c.env, OPENCODE_PROXY_TOKEN_KEY, { fresh: true }))?.trim();
  if (!expectedToken) {
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "OpenCode proxy is not configured" }, 503);
  }

  const providedToken = extractBearerToken(c.req.header("Authorization"));
  if (!providedToken || providedToken !== expectedToken) {
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "Unauthorized" }, 401);
  }

  return null;
}

function pickDefined<T extends JsonRecord>(source: JsonRecord, keys: (keyof T & string)[]): Partial<T> {
  const result: Partial<T> = {};
  for (const key of keys) {
    if (source[key] !== undefined) {
      result[key] = source[key] as T[typeof key];
    }
  }
  return result;
}

function createUsage(value: unknown): CompletionUsage | undefined {
  if (!isRecord(value)) return undefined;
  const usage: JsonRecord = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    const tokenCount = value[key];
    if (typeof tokenCount === "number" && Number.isFinite(tokenCount)) {
      usage[key] = tokenCount;
    }
  }
  return Object.keys(usage).length > 0 ? usage as unknown as CompletionUsage : undefined;
}

function buildNormalizedMessage(choice: JsonRecord, fallbackContent = ""): ChatCompletionResponseMessage {
  const message = isRecord(choice.message) ? choice.message : null;
  if (message) {
    return {
      role: "assistant",
      content: typeof message.content === "string" || message.content === null
        ? message.content
        : fallbackContent || null,
      refusal: typeof message.refusal === "string" || message.refusal === null
        ? message.refusal
        : null,
      annotations: Array.isArray(message.annotations)
        ? (message.annotations as ChatCompletionResponseMessage["annotations"])
        : undefined,
      audio: isRecord(message.audio)
        ? (message.audio as ChatCompletionResponseMessage["audio"])
        : undefined,
      tool_calls: Array.isArray(message.tool_calls)
        ? (message.tool_calls as ChatCompletionResponseMessage["tool_calls"])
        : Array.isArray(choice.tool_calls)
          ? (choice.tool_calls as ChatCompletionResponseMessage["tool_calls"])
          : undefined,
      function_call: isRecord(message.function_call)
        ? (message.function_call as ChatCompletionResponseMessage["function_call"])
        : null,
    };
  }

  return {
    role: "assistant",
    content: fallbackContent || null,
    refusal: null,
    tool_calls: Array.isArray(choice.tool_calls)
      ? (choice.tool_calls as ChatCompletionResponseMessage["tool_calls"])
      : undefined,
    function_call: null,
  };
}

function normalizeChatCompletionResponse(output: unknown): ChatCompletionsOutput {
  const created = Math.floor(Date.now() / 1000);
  const payload = isRecord(output) ? output : {};
  const outputChoices = Array.isArray(payload.choices)
    ? payload.choices
    : [{
        index: 0,
        finish_reason: typeof payload.finish_reason === "string" ? payload.finish_reason : "stop",
        message: {
          role: "assistant",
          content: typeof payload.response === "string" ? payload.response : "",
          tool_calls: Array.isArray(payload.tool_calls) ? payload.tool_calls : undefined,
          refusal: null,
        },
        logprobs: null,
      }];

  return {
    id: typeof payload.id === "string" ? payload.id : `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`,
    object: "chat.completion",
    created: typeof payload.created === "number" ? payload.created : created,
    model: FIXED_MODEL,
    choices: outputChoices.map((choice, index) => {
      const record = isRecord(choice) ? choice : {};
      return {
        index: typeof record.index === "number" ? record.index : index,
        message: buildNormalizedMessage(
          record,
          typeof payload.response === "string" ? payload.response : "",
        ),
        finish_reason: typeof record.finish_reason === "string" ? record.finish_reason as ChatCompletionChoice["finish_reason"] : "stop",
        logprobs: isRecord(record.logprobs) || record.logprobs === null
          ? (record.logprobs as ChatCompletionChoice["logprobs"])
          : null,
      };
    }),
    usage: createUsage(payload.usage),
    system_fingerprint: typeof payload.system_fingerprint === "string" || payload.system_fingerprint === null
      ? payload.system_fingerprint as string | null
      : null,
    service_tier: typeof payload.service_tier === "string" || payload.service_tier === null
      ? payload.service_tier as ChatCompletionsOutput["service_tier"]
      : null,
  };
}

function normalizeStreamingToolCalls(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((item, index) => {
    const record = isRecord(item) ? item : {};
    const fn = isRecord(record.function) ? record.function : {};
    const functionPayload: Record<string, string> = {};

    const name = typeof fn.name === "string" ? fn.name : typeof record.name === "string" ? record.name : undefined;
    if (name) functionPayload.name = name;

    const args = typeof fn.arguments === "string"
      ? fn.arguments
      : typeof record.arguments === "string"
        ? record.arguments
        : undefined;
    if (args !== undefined) functionPayload.arguments = args;

    const normalized: Record<string, unknown> = {
      index: typeof record.index === "number" ? record.index : index,
      type: typeof record.type === "string" ? record.type : "function",
    };

    if (typeof record.id === "string") {
      normalized.id = record.id;
    }

    if (Object.keys(functionPayload).length > 0) {
      normalized.function = functionPayload;
    }

    return normalized;
  });
}

function sanitizeToolCallId(id: string): string {
  const alphanumeric = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumeric.slice(0, 9).padEnd(9, "0");
}

function normalizeBindingMessages(messages: unknown[]): ChatCompletionsMessagesInput["messages"] {
  return messages.map((message) => {
    if (!isRecord(message)) {
      return message as ChatCompletionsMessagesInput["messages"][number];
    }

    const normalized: JsonRecord = { ...message };
    if (normalized.content === null || normalized.content === undefined) {
      normalized.content = "";
    }

    if (Array.isArray(normalized.tool_calls)) {
      normalized.tool_calls = normalized.tool_calls.map((toolCall) => {
        if (!isRecord(toolCall)) {
          return toolCall;
        }

        return {
          ...toolCall,
          ...(typeof toolCall.id === "string"
            ? { id: sanitizeToolCallId(toolCall.id) }
            : {}),
        };
      });
    }

    if (typeof normalized.tool_call_id === "string") {
      normalized.tool_call_id = sanitizeToolCallId(normalized.tool_call_id);
    }

    return normalized as ChatCompletionsMessagesInput["messages"][number];
  });
}

function buildChunkBase(id: string, created: number) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model: FIXED_MODEL,
  };
}

function createOpenAiChatCompletionStream(source: ReadableStream, includeUsage: boolean): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const completionId = `chatcmpl_${crypto.randomUUID().replace(/-/g, "")}`;
  const created = Math.floor(Date.now() / 1000);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      let buffer = "";
      let latestUsage: CompletionUsage | undefined;
      let emittedFinish = false;

      const emit = (payload: Record<string, unknown>) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
      };

      const emitFinish = (finishReason: ChatCompletionChoice["finish_reason"]) => {
        emit({
          ...buildChunkBase(completionId, created),
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: finishReason,
            },
          ],
          ...(includeUsage && latestUsage ? { usage: latestUsage } : {}),
        });
        emittedFinish = true;
      };

      const processEvent = (data: string) => {
        const trimmed = data.trim();
        if (!trimmed || trimmed === "[DONE]") {
          return;
        }

        let payload: JsonRecord;
        try {
          const parsed = JSON.parse(trimmed);
          payload = isRecord(parsed) ? parsed : {};
        } catch {
          return;
        }

        const usage = createUsage(payload.usage);
        if (usage) {
          latestUsage = usage;
        }

        if (Array.isArray(payload.choices)) {
          const choices = payload.choices.map((choice, index) => {
            const record = isRecord(choice) ? choice : {};
            const delta = isRecord(record.delta)
              ? { ...record.delta }
              : isRecord(record.message)
                ? {
                    ...(typeof record.message.content === "string"
                      ? { content: record.message.content }
                      : {}),
                    ...(Array.isArray(record.message.tool_calls)
                      ? { tool_calls: record.message.tool_calls }
                      : {}),
                  }
                : {};
            return {
              index: typeof record.index === "number" ? record.index : index,
              delta,
              finish_reason: typeof record.finish_reason === "string"
                ? record.finish_reason
                : null,
            };
          });

          emit({
            ...buildChunkBase(completionId, created),
            choices,
            ...(includeUsage && usage ? { usage } : {}),
          });
          if (choices.some((choice) => choice.finish_reason !== null)) {
            emittedFinish = true;
          }
          return;
        }

        const textDelta = typeof payload.response === "string" ? payload.response : "";
        if (textDelta) {
          emit({
            ...buildChunkBase(completionId, created),
            choices: [
              {
                index: 0,
                delta: { content: textDelta },
                finish_reason: null,
              },
            ],
          });
        }

        const toolCalls = normalizeStreamingToolCalls(payload.tool_calls);
        if (toolCalls && toolCalls.length > 0) {
          emit({
            ...buildChunkBase(completionId, created),
            choices: [
              {
                index: 0,
                delta: { tool_calls: toolCalls },
                finish_reason: null,
              },
            ],
          });
        }

        const finishReason = typeof payload.finish_reason === "string"
          ? payload.finish_reason as ChatCompletionChoice["finish_reason"]
          : null;
        if (finishReason) {
          emitFinish(finishReason);
        }
      };

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            break;
          }

          const chunk = value instanceof Uint8Array
            ? value
            : typeof value === "string"
              ? encoder.encode(value)
              : new Uint8Array(value as ArrayBufferLike);
          buffer += decoder.decode(chunk, { stream: true });

          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            const dataLines = part
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart());
            if (dataLines.length > 0) {
              processEvent(dataLines.join("\n"));
            }
          }
        }

        if (buffer.trim()) {
          const dataLines = buffer
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart());
          if (dataLines.length > 0) {
            processEvent(dataLines.join("\n"));
          }
        }

        if (!emittedFinish) {
          emitFinish("stop");
        }

        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
}

const opencodeRoutes = new Hono<HonoEnv>();

opencodeRoutes.use("/api/opencode/*", specializedServiceAuthMiddleware);

opencodeRoutes.get("/api/opencode/v1/models", async (c) => {
  const authError = await requireProxyAuth(c);
  if (authError) return authError;

  c.header("Cache-Control", NO_STORE);
  return c.json({
    object: "list",
    data: [
      {
        id: FIXED_MODEL,
        object: "model",
        created: 0,
        owned_by: "cloudflare-workers-ai",
      },
    ],
  });
});

opencodeRoutes.post("/api/opencode/v1/chat/completions", async (c) => {
  const authError = await requireProxyAuth(c);
  if (authError) return authError;

  let body: JsonRecord;
  try {
    const parsed = await c.req.json();
    body = isRecord(parsed) ? parsed : {};
  } catch {
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const messages = Array.isArray(body.messages)
    ? body.messages
    : typeof body.prompt === "string"
      ? [{ role: "user", content: body.prompt }]
      : null;
  if (!messages) {
    c.header("Cache-Control", NO_STORE);
    return c.json({ error: "chat/completions requires a messages array" }, 400);
  }

  const input: ChatCompletionsInput = {
    messages: normalizeBindingMessages(messages),
    model: FIXED_MODEL,
    ...pickDefined<ChatCompletionsCommonOptions>(body, [
      "audio",
      "frequency_penalty",
      "function_call",
      "functions",
      "logit_bias",
      "logprobs",
      "max_completion_tokens",
      "max_tokens",
      "metadata",
      "modalities",
      "n",
      "parallel_tool_calls",
      "prediction",
      "presence_penalty",
      "reasoning_effort",
      "chat_template_kwargs",
      "response_format",
      "seed",
      "service_tier",
      "stop",
      "store",
      "stream",
      "stream_options",
      "temperature",
      "tool_choice",
      "tools",
      "top_logprobs",
      "top_p",
      "user",
      "web_search_options",
    ]),
  };

  c.header("Cache-Control", NO_STORE);

  if (body.stream === true) {
    const stream = await runFixedModel(c.env.AI, input);
    if (!(stream instanceof ReadableStream)) {
      return c.json(normalizeChatCompletionResponse(stream), 200);
    }

    return new Response(
      createOpenAiChatCompletionStream(
        stream,
        isRecord(body.stream_options) && body.stream_options.include_usage === true,
      ),
      {
        status: 200,
        headers: {
          "Cache-Control": NO_STORE,
          "Content-Type": "text/event-stream; charset=utf-8",
          Connection: "keep-alive",
        },
      },
    );
  }

  const output = await runFixedModel(c.env.AI, input);
  return c.json(normalizeChatCompletionResponse(output), 200);
});

export default opencodeRoutes;
