import type { Env } from "../types";
import type { ToolParameters } from "./types";
import {
  getGatewayAccessHeaders,
  resolveCodexModelRoute,
  type AvailableCodexModelRoute,
} from "../model-route";

export interface ResponseToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: ToolParameters;
}

export interface ResponseTextContent {
  type: "output_text";
  text: string;
}

export interface ResponseMessageItem {
  type: "message";
  role: "user" | "assistant";
  content: Array<
    | { type: "input_text"; text: string }
    | ResponseTextContent
    | { type: string; [key: string]: unknown }
  >;
}

export interface ResponseFunctionCallItem {
  type: "function_call";
  name: string;
  call_id: string;
  arguments: string;
}

export interface ResponseFunctionCallOutputItem {
  type: "function_call_output";
  call_id: string;
  output: string;
}

export type ResponseOutputItem =
  | ResponseMessageItem
  | ResponseFunctionCallItem
  | { type: string; [key: string]: unknown };

export type ResponseInputItem =
  | ResponseMessageItem
  | ResponseOutputItem
  | ResponseFunctionCallOutputItem;

interface CodexRequestConfig {
  url: string;
  headers: Headers;
  body: string;
}

export const DEFAULT_OPENAI_MODEL = "gpt-5.4";
export const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
export const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isFunctionCallItem(item: ResponseOutputItem): item is ResponseFunctionCallItem {
  return item.type === "function_call" && typeof item.call_id === "string" && typeof item.name === "string";
}

export function extractSseOutputItem(payload: unknown): ResponseOutputItem | null {
  if (!isRecord(payload) || !isRecord(payload.item) || typeof payload.item.type !== "string") {
    return null;
  }

  return payload.item as ResponseOutputItem;
}

export function extractSseOutputIndex(payload: unknown): number | null {
  if (!isRecord(payload) || typeof payload.output_index !== "number") {
    return null;
  }

  return Number.isInteger(payload.output_index) && payload.output_index >= 0
    ? payload.output_index
    : null;
}

export function parseToolInput(rawArguments: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawArguments);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseSseBlock(block: string): { event: string; data: string } | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

export async function* readSseEvents(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      if (buffer.trim()) {
        const parsed = parseSseBlock(buffer);
        if (parsed) yield parsed;
      }
      return;
    }

    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const parsed = parseSseBlock(part);
      if (parsed) yield parsed;
    }
  }
}

export function parseCompletedOutput(payload: unknown): ResponseOutputItem[] | null {
  if (!isRecord(payload) || !isRecord(payload.response) || !Array.isArray(payload.response.output)) {
    return null;
  }

  return payload.response.output as ResponseOutputItem[];
}

export function extractOutputText(output: ResponseOutputItem[]): string {
  let text = "";

  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) {
      continue;
    }

    for (const part of item.content) {
      if (isRecord(part) && part.type === "output_text" && typeof part.text === "string") {
        text += part.text;
      } else if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        text += part.text;
      }
    }
  }

  return text;
}

export function summarizeOutputTypes(output: ResponseOutputItem[]): string {
  if (output.length === 0) return "none";

  return output
    .map((item) => {
      if (item.type !== "message" || !Array.isArray(item.content)) {
        return item.type;
      }

      const contentTypes = item.content
        .map((part) => isRecord(part) && typeof part.type === "string" ? part.type : "unknown")
        .join(",");

      return `message(${contentTypes || "no-content"})`;
    })
    .join(", ");
}

export function parseErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;

  if (typeof payload.message === "string") return payload.message;
  if (isRecord(payload.error) && typeof payload.error.message === "string") return payload.error.message;

  const response = isRecord(payload.response) ? payload.response : null;
  if (response && isRecord(response.error) && typeof response.error.message === "string") {
    return response.error.message;
  }

  return fallback;
}

export function buildCodexRequestBody(
  model: string,
  input: ResponseInputItem[],
  systemPrompt: string,
  tools: ResponseToolDefinition[],
): string {
  return JSON.stringify({
    model,
    store: false,
    stream: true,
    parallel_tool_calls: false,
    instructions: systemPrompt,
    input,
    tools,
  });
}

export async function buildCodexRequestConfig(
  env: Env,
  accessToken: string,
  accountId: string | null,
  chatSessionId: string,
  body: string,
  routeOverride?: AvailableCodexModelRoute | null,
): Promise<CodexRequestConfig> {
  const route = routeOverride ?? await resolveCodexModelRoute(env);

  if (route.kind === "gateway-subscription" || route.kind === "host-gateway") {
    const headers = new Headers({
      "Content-Type": "application/json",
      "X-OpenAI-Access-Token": route.accessToken || accessToken,
      "X-Originator": "opencode",
      "X-User-Agent": "opencode/tiller-hub",
      "X-Session-Id": chatSessionId,
    });

    const gatewayAccessHeaders = await getGatewayAccessHeaders(env);
    for (const [name, value] of Object.entries(gatewayAccessHeaders)) {
      if (value) {
        headers.set(name, value);
      }
    }

    if (route.accountId || accountId) {
      headers.set("X-ChatGPT-Account-Id", route.accountId ?? accountId!);
    }

    return {
      url: route.responsesUrl,
      headers,
      body,
    };
  }

  if (route.kind === "api-fallback") {
    const headers = new Headers({
      Authorization: `Bearer ${route.openaiApiKey}`,
      "Content-Type": "application/json",
    });

    return {
      url: OPENAI_RESPONSES_URL,
      headers,
      body,
    };
  }

  throw new Error(route.reason);
}
