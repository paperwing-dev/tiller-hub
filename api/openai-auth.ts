import { rpcError } from "./errors";
import type { Env } from "./types";

const OPENAI_TOKENS_KEY = "openai:oauth:tokens";
const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const REFRESH_BUFFER_MS = 60_000;

interface OpenAITokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id?: string }>;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

interface OpenAITokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

export interface StoredOpenAIAuth {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  account_id?: string;
  expires_at: number;
}

export interface SeedOpenAIAuthInput {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

let refreshPromise: Promise<StoredOpenAIAuth> | null = null;

function decodeBase64UrlJson<T>(value: string): T | undefined {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);

  try {
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  } catch {
    return undefined;
  }
}

function parseJwtClaims(token: string): OpenAITokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  return decodeBase64UrlJson<OpenAITokenClaims>(parts[1]);
}

function extractAccountIdFromClaims(claims: OpenAITokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

function extractAccountIdFromTokens(tokens: {
  access_token: string;
  id_token?: string;
}): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }

  const accessClaims = parseJwtClaims(tokens.access_token);
  return accessClaims ? extractAccountIdFromClaims(accessClaims) : undefined;
}

async function readStoredTokens(env: Env): Promise<StoredOpenAIAuth | null> {
  return (await env.ENVS_KV.get<StoredOpenAIAuth>(OPENAI_TOKENS_KEY, "json")) ?? null;
}

async function writeStoredTokens(env: Env, auth: StoredOpenAIAuth): Promise<void> {
  await env.ENVS_KV.put(OPENAI_TOKENS_KEY, JSON.stringify(auth));
}

function buildStoredTokens(
  tokens: {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    expires_in?: number;
  },
  previous?: StoredOpenAIAuth,
): StoredOpenAIAuth {
  const accountId =
    extractAccountIdFromTokens({
      access_token: tokens.access_token,
      id_token: tokens.id_token ?? previous?.id_token,
    }) ?? previous?.account_id;

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    id_token: tokens.id_token ?? previous?.id_token,
    account_id: accountId,
    expires_at: Date.now() + (tokens.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS) * 1000,
  };
}

export async function seedTokens(env: Env, input: SeedOpenAIAuthInput): Promise<StoredOpenAIAuth> {
  const stored = buildStoredTokens(input);
  await writeStoredTokens(env, stored);
  return stored;
}

export async function refreshAccessToken(
  env: Env,
  currentAuth?: StoredOpenAIAuth,
): Promise<StoredOpenAIAuth> {
  const existing = currentAuth ?? await readStoredTokens(env);
  if (!existing) {
    throw rpcError("ServiceUnavailable", "OpenAI auth not seeded");
  }

  const response = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: existing.refresh_token,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }).toString(),
  });

  if (!response.ok) {
    throw rpcError("ServiceUnavailable", `OpenAI token refresh failed: ${response.status}`);
  }

  const payload = await response.json<OpenAITokenResponse>();
  if (!payload.access_token) {
    throw rpcError("ServiceUnavailable", "OpenAI token refresh returned no access token");
  }

  const refreshed = buildStoredTokens(
    {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token ?? existing.refresh_token,
      id_token: payload.id_token,
      expires_in: payload.expires_in,
    },
    existing,
  );

  await writeStoredTokens(env, refreshed);
  return refreshed;
}

export async function getValidOpenAIAuth(env: Env): Promise<StoredOpenAIAuth> {
  const stored = await readStoredTokens(env);
  if (!stored) {
    throw rpcError("ServiceUnavailable", "OpenAI auth not seeded");
  }

  if (stored.expires_at > Date.now() + REFRESH_BUFFER_MS) {
    return stored;
  }

  if (!refreshPromise) {
    refreshPromise = refreshAccessToken(env, stored).finally(() => {
      refreshPromise = null;
    });
  }

  return refreshPromise;
}

export async function getStatus(
  env: Env,
): Promise<{ authenticated: boolean; expires_at?: number; account_id?: string }> {
  const stored = await readStoredTokens(env);
  if (!stored) return { authenticated: false };

  return {
    authenticated: true,
    expires_at: stored.expires_at,
    account_id: stored.account_id,
  };
}

export function resetOpenAIAuthStateForTests(): void {
  refreshPromise = null;
}
