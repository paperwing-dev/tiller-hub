import type { Env } from "./types";
import {
  OpenAIAuthBroker,
  type OpenAIImportBoundaryResult,
  type OpenAIAuthStatusResult,
  type OpenAIRuntimeAuthBoundaryResult,
  type OpenAIRuntimeAuthResult,
  type SeedOpenAIAuthInput,
  type StoredOpenAIAuth,
} from "./openai-auth-broker";

export type { SeedOpenAIAuthInput, StoredOpenAIAuth } from "./openai-auth-broker";

interface OpenAIAuthHub {
  importOpenAIAuth(input: SeedOpenAIAuthInput): Promise<OpenAIImportBoundaryResult>;
  exchangeOpenAIRuntimeAuth(rejectedAccessTokenSha256?: string): Promise<OpenAIRuntimeAuthBoundaryResult>;
  getOpenAIAuthStatus(refresh?: boolean): Promise<OpenAIAuthStatusResult>;
}

export interface OpenAIUsableAuth {
  access_token: string;
  account_id: string;
  expires_at: number;
}

type OpenAIRuntimeExchangeResult =
  | OpenAIRuntimeAuthBoundaryResult
  | OpenAIRuntimeAuthResult;

let fallbackBrokers = new WeakMap<object, OpenAIAuthBroker>();

function hasHub(env: Env): boolean {
  return Boolean((env as unknown as { HUB?: unknown }).HUB);
}

function hub(env: Env): OpenAIAuthHub {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id) as unknown as OpenAIAuthHub;
}

function fallbackBroker(env: Env): OpenAIAuthBroker {
  const key = env as unknown as object;
  let broker = fallbackBrokers.get(key);
  if (!broker) {
    broker = new OpenAIAuthBroker(env);
    fallbackBrokers.set(key, broker);
  }
  return broker;
}

export async function seedTokens(env: Env, input: SeedOpenAIAuthInput): Promise<StoredOpenAIAuth> {
  // Test and migration helper only. Production imports always cross HubDO.
  if (hasHub(env)) throw new Error("OpenAI credentials must be imported through HubDO");
  return await fallbackBroker(env).seedForTests(input);
}

export async function validateAndSeedTokens(
  env: Env,
  input: SeedOpenAIAuthInput,
): Promise<StoredOpenAIAuth | OpenAIUsableAuth> {
  const result = hasHub(env)
    ? await hub(env).importOpenAIAuth(input)
    : await fallbackBroker(env).import(input);
  if (!result.ok) throw new Error(result.message);
  if ("stored" in result) return result.stored;
  return {
    access_token: result.credential.accessToken,
    account_id: result.credential.accountId,
    expires_at: Date.parse(result.credential.expiresAt),
  };
}

export async function exchangeOpenAIRuntimeAuth(
  env: Env,
  rejectedAccessTokenSha256?: string,
): Promise<OpenAIRuntimeExchangeResult> {
  return hasHub(env)
    ? await hub(env).exchangeOpenAIRuntimeAuth(rejectedAccessTokenSha256)
    : await fallbackBroker(env).runtimeAuth(rejectedAccessTokenSha256);
}

export async function refreshAccessToken(
  env: Env,
  currentAuth?: StoredOpenAIAuth,
): Promise<StoredOpenAIAuth | OpenAIUsableAuth> {
  if (currentAuth && !hasHub(env)) await fallbackBroker(env).seedForTests({
    access_token: currentAuth.access_token,
    refresh_token: currentAuth.refresh_token,
    id_token: currentAuth.id_token,
    expires_in: Math.max(1, Math.floor((currentAuth.expires_at - Date.now()) / 1000)),
  });
  const result = await exchangeOpenAIRuntimeAuth(
    env,
    currentAuth ? await sha256Hex(currentAuth.access_token) : await rejectedCurrentTokenHash(env),
  );
  if (!result.ok) throw new Error(result.message);
  if ("stored" in result) return result.stored;
  return {
    access_token: result.credential.accessToken,
    account_id: result.credential.accountId,
    expires_at: Date.parse(result.credential.expiresAt),
  };
}

async function rejectedCurrentTokenHash(env: Env): Promise<string | undefined> {
  if (hasHub(env)) return undefined;
  const stored = await env.ENVS_KV.get<StoredOpenAIAuth>("openai:oauth:tokens", "json");
  return stored ? await sha256Hex(stored.access_token) : undefined;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getValidOpenAIAuth(env: Env): Promise<StoredOpenAIAuth | OpenAIUsableAuth> {
  const result = await exchangeOpenAIRuntimeAuth(env);
  if (!result.ok) throw new Error(result.message);
  if ("stored" in result) return result.stored;
  return {
    access_token: result.credential.accessToken,
    account_id: result.credential.accountId,
    expires_at: Date.parse(result.credential.expiresAt),
  };
}

export async function getStatus(env: Env): Promise<OpenAIAuthStatusResult> {
  return hasHub(env)
    ? await hub(env).getOpenAIAuthStatus(true)
    : await fallbackBroker(env).getStatus({ refresh: true });
}

export async function getReadOnlyStatus(env: Env): Promise<OpenAIAuthStatusResult> {
  return hasHub(env)
    ? await hub(env).getOpenAIAuthStatus(false)
    : await fallbackBroker(env).getReadOnlyStatus();
}

export function resetOpenAIAuthStateForTests(): void {
  fallbackBrokers = new WeakMap<object, OpenAIAuthBroker>();
}
