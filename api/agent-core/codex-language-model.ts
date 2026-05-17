import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { mintCodexGatewaySessionToken } from "../gateway-session";
import {
  getGatewayAccessHeaders,
  resolveCodexModelRoute,
  type AvailableCodexModelRoute,
} from "../model-route";
import { getValidOpenAIAuth } from "../openai-auth";
import { getSecret } from "../setup/config";
import type { Env } from "../types";
import { DEFAULT_OPENAI_MODEL } from "./models";

export interface CodexLanguageModelResolution {
  model: LanguageModel;
  modelId: string;
  route: AvailableCodexModelRoute;
  providerBaseUrl: string;
  headers: Record<string, string>;
  promptCacheKey: string;
}

export interface CodexResponsesProviderOptions {
  openai: {
    parallelToolCalls: true;
    store: false;
    promptCacheKey?: string;
  };
}

const CODEX_GATEWAY_SESSION_ID_MAX_LENGTH = 64;
const CODEX_GATEWAY_SESSION_ID_HASH_PREFIX = "tiller-";

interface ResolveCodexLanguageModelOptions {
  chatSessionId: string;
  model?: string;
  routeOverride?: AvailableCodexModelRoute | null;
  fetch?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function elapsedMs(startMs: number): number {
  return Math.round(performance.now() - startMs);
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readOptionalSecret(env: Env, key: string): Promise<string | undefined> {
  const envValue = (env as unknown as Record<string, unknown>)[key];
  if (typeof envValue === "string" && envValue.trim()) {
    return Promise.resolve(envValue);
  }
  if (!(env as unknown as { HUB?: unknown }).HUB) {
    return Promise.resolve(undefined);
  }
  return getSecret(env, key);
}

function isCodexBenchmarkDebugEnabled(env: Pick<Env, "PLAN_CHAT_DEBUG">): boolean {
  return env.PLAN_CHAT_DEBUG === "1";
}

function logCodexBenchmark(debug: boolean, event: string, payload: Record<string, unknown>): void {
  if (!debug) return;
  console.info("[codex-language-model-benchmark]", JSON.stringify({
    event,
    at: new Date().toISOString(),
    ...payload,
  }));
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createCodexGatewaySessionId(chatSessionId: string): Promise<string> {
  const trimmed = chatSessionId.trim();
  if (trimmed && trimmed.length <= CODEX_GATEWAY_SESSION_ID_MAX_LENGTH) {
    return trimmed;
  }

  const hash = await sha256Hex(trimmed || crypto.randomUUID());
  return `${CODEX_GATEWAY_SESSION_ID_HASH_PREFIX}${hash.slice(
    0,
    CODEX_GATEWAY_SESSION_ID_MAX_LENGTH - CODEX_GATEWAY_SESSION_ID_HASH_PREFIX.length,
  )}`;
}

function createFallbackPromptCacheKey(value: string): string {
  const trimmed = value.trim();
  if (trimmed && trimmed.length <= CODEX_GATEWAY_SESSION_ID_MAX_LENGTH) {
    return trimmed;
  }

  let hash = 0x811c9dc5;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash ^= trimmed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(16).padStart(8, "0");
  const headLength =
    CODEX_GATEWAY_SESSION_ID_MAX_LENGTH -
    CODEX_GATEWAY_SESSION_ID_HASH_PREFIX.length -
    suffix.length -
    1;
  const head = (trimmed || "session").slice(0, Math.max(0, headLength));
  return `${CODEX_GATEWAY_SESSION_ID_HASH_PREFIX}${head}-${suffix}`.slice(
    0,
    CODEX_GATEWAY_SESSION_ID_MAX_LENGTH,
  );
}

function readTextContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const text = content
    .map((part) => {
      if (!isRecord(part)) return "";
      if (typeof part.text === "string") return part.text;
      return "";
    })
    .join("");

  return text || null;
}

function normalizeResponsesInputItem(item: unknown): unknown {
  if (!isRecord(item)) return item;
  if (typeof item.type === "string") return item;
  if (item.role !== "user" && item.role !== "assistant") return item;

  return {
    type: "message",
    ...item,
  };
}

function normalizeCodexGatewayRequestBody(bodyText: string): string {
  if (!bodyText.trim()) return bodyText;

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return bodyText;
  }
  if (!isRecord(payload)) return bodyText;

  const next: Record<string, unknown> = { ...payload };
  if (Array.isArray(next.input)) {
    const input: unknown[] = [];
    for (const item of next.input) {
      if (
        isRecord(item) &&
        (item.role === "developer" || item.role === "system")
      ) {
        const instructions = readTextContent(item.content);
        if (instructions && typeof next.instructions !== "string") {
          next.instructions = instructions;
        }
        continue;
      }

      input.push(normalizeResponsesInputItem(item));
    }
    next.input = input;
  }

  next.store = false;
  next.parallel_tool_calls = true;
  if (typeof next.prompt_cache_key === "string") {
    next.prompt_cache_key = createFallbackPromptCacheKey(next.prompt_cache_key);
  }
  delete next.prompt_cache_retention;

  return JSON.stringify(next);
}

function summarizeCodexRequestBody(bodyText: string | undefined): Record<string, unknown> {
  if (!bodyText) return { bodyChars: 0 };

  let payload: unknown;
  try {
    payload = JSON.parse(bodyText);
  } catch {
    return { bodyChars: bodyText.length, parseable: false };
  }

  if (!isRecord(payload)) {
    return { bodyChars: bodyText.length, parseable: false };
  }

  return {
    bodyChars: bodyText.length,
    parseable: true,
    model: typeof payload.model === "string" ? payload.model : null,
    stream: payload.stream === true,
    inputItems: Array.isArray(payload.input) ? payload.input.length : null,
    tools: Array.isArray(payload.tools) ? payload.tools.length : null,
    instructionsChars: typeof payload.instructions === "string" ? payload.instructions.length : 0,
    hasPromptCacheKey: typeof payload.prompt_cache_key === "string",
    hasEncryptedReasoningInclude: Array.isArray(payload.include)
      && payload.include.includes("reasoning.encrypted_content"),
  };
}

function createCodexCompatibleFetch(
  fetchFn: typeof fetch,
  options: { stripAuthorization?: boolean; debug?: boolean } = {},
): typeof fetch {
  return async (input, init) => {
    const debug = options.debug === true;
    const startedAt = performance.now();
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    if (options.stripAuthorization) {
      headers.delete("authorization");
    }
    headers.delete("content-length");
    const bodyText = await request.text();
    const normalizedBody = bodyText
      ? normalizeCodexGatewayRequestBody(bodyText)
      : undefined;
    const sessionId = headers.get("x-session-id");
    if (debug) {
      logCodexBenchmark(debug, "request_start", {
        url: request.url,
        method: request.method,
        route: options.stripAuthorization ? "gateway" : "api-fallback",
        sessionId,
        requestPrepMs: elapsedMs(startedAt),
        originalBodyChars: bodyText.length,
        ...summarizeCodexRequestBody(normalizedBody),
      });
    }

    try {
      const response = await fetchFn(new Request(request.url, {
        method: request.method,
        headers,
        body: normalizedBody,
        redirect: request.redirect,
        signal: request.signal,
      }));
      logCodexBenchmark(debug, "response_headers", {
        url: request.url,
        route: options.stripAuthorization ? "gateway" : "api-fallback",
        sessionId,
        status: response.status,
        ok: response.ok,
        durationMs: elapsedMs(startedAt),
        contentType: response.headers.get("content-type"),
      });
      return response;
    } catch (error) {
      logCodexBenchmark(debug, "request_error", {
        url: request.url,
        route: options.stripAuthorization ? "gateway" : "api-fallback",
        sessionId,
        durationMs: elapsedMs(startedAt),
        error: summarizeError(error),
      });
      throw error;
    }
  };
}

export function createCodexResponsesProviderOptions(promptCacheKey?: string): CodexResponsesProviderOptions {
  return {
    openai: {
      parallelToolCalls: true,
      store: false,
      ...(promptCacheKey
        ? {
          promptCacheKey,
        }
        : {}),
    },
  };
}

async function buildGatewayProviderHeaders(
  env: Env,
  chatSessionId: string,
  route: Extract<AvailableCodexModelRoute, { kind: "gateway-subscription" | "host-gateway" }>,
  codexSessionId: string,
): Promise<Record<string, string>> {
  const gatewaySession = await mintCodexGatewaySessionToken(env, {
    envSlug: `agent:${chatSessionId}`,
    routeKind: route.kind,
    machineId: route.machineId,
    gatewayUrl: route.kind === "gateway-subscription" ? route.gatewayUrl : null,
  });
  const headers: Record<string, string> = {
    "X-Tiller-Gateway-Session-Token": gatewaySession.token,
    "X-Originator": "opencode",
    "X-User-Agent": "opencode/tiller-hub",
    "X-Session-Id": codexSessionId,
  };

  const gatewayAccessHeaders = await getGatewayAccessHeaders(env);
  for (const [name, value] of Object.entries(gatewayAccessHeaders)) {
    if (value) {
      headers[name] = value;
    }
  }

  return headers;
}

async function fallbackToOpenAiApiKeyWhenSubscriptionAuthIsUnavailable(
  env: Env,
  route: AvailableCodexModelRoute,
): Promise<AvailableCodexModelRoute> {
  if (route.kind !== "gateway-subscription" && route.kind !== "host-gateway") {
    return route;
  }

  try {
    await getValidOpenAIAuth(env);
    return route;
  } catch {
    const openaiApiKey = (await readOptionalSecret(env, "OPENAI_API_KEY"))?.trim();
    if (!openaiApiKey) return route;
    return {
      kind: "api-fallback",
      openaiApiKey,
      codexRouteStatus: "api_fallback",
    };
  }
}

export async function resolveCodexLanguageModel(
  env: Env,
  options: ResolveCodexLanguageModelOptions,
): Promise<CodexLanguageModelResolution> {
  const resolvedRoute = options.routeOverride ?? await resolveCodexModelRoute(env);
  if (resolvedRoute.kind === "unavailable") {
    throw new Error(resolvedRoute.reason);
  }

  const route = await fallbackToOpenAiApiKeyWhenSubscriptionAuthIsUnavailable(env, resolvedRoute);
  const modelId = options.model ?? env.OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
  const promptCacheKey = await createCodexGatewaySessionId(options.chatSessionId);
  const debug = isCodexBenchmarkDebugEnabled(env);
  if (route.kind === "api-fallback") {
    const provider = createOpenAI({
      apiKey: route.openaiApiKey,
      fetch: createCodexCompatibleFetch(options.fetch ?? fetch, { debug }),
    });
    return {
      model: provider.responses(modelId),
      modelId,
      route,
      providerBaseUrl: "https://api.openai.com/v1",
      headers: {},
      promptCacheKey,
    };
  }

  const headers = await buildGatewayProviderHeaders(env, options.chatSessionId, route, promptCacheKey);
  const provider = createOpenAI({
    apiKey: "tiller-gateway-session",
    baseURL: route.providerBaseUrl,
    headers,
    fetch: createCodexCompatibleFetch(options.fetch ?? fetch, { stripAuthorization: true, debug }),
  });

  return {
    model: provider.responses(modelId),
    modelId,
    route,
    providerBaseUrl: route.providerBaseUrl,
    headers,
    promptCacheKey,
  };
}
