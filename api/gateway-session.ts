import { getValidOpenAIAuth } from "./openai-auth";
import { readRoutableHostService } from "./service-registry";
import type { Env, ModelRoute } from "./types";

const GATEWAY_SESSION_PREFIX = "codex-gateway-session:";
const GATEWAY_SESSION_ENV_INDEX_PREFIX = "codex-gateway-session-by-env:";
const DEFAULT_GATEWAY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type CodexGatewayRouteKind = Extract<ModelRoute, "gateway-subscription" | "host-gateway">;

export interface CodexGatewaySessionRecord {
  tokenHash: string;
  envSlug: string;
  routeKind: CodexGatewayRouteKind;
  machineId: string | null;
  gatewayUrl: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  use: "codex-gateway";
}

export interface MintCodexGatewaySessionTokenInput {
  envSlug: string;
  routeKind: CodexGatewayRouteKind;
  machineId?: string | null;
  gatewayUrl?: string | null;
  ttlMs?: number;
}

export interface ExchangedCodexGatewaySession {
  accessToken: string;
  accountId: string | null;
  expiresAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function createToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function recordKey(tokenHash: string): string {
  return `${GATEWAY_SESSION_PREFIX}${tokenHash}`;
}

function envIndexPrefix(envSlug: string): string {
  return `${GATEWAY_SESSION_ENV_INDEX_PREFIX}${encodeURIComponent(envSlug)}:`;
}

function envIndexKey(envSlug: string, tokenHash: string): string {
  return `${envIndexPrefix(envSlug)}${tokenHash}`;
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

function isUsableRecord(record: CodexGatewaySessionRecord, now = Date.now()): boolean {
  return record.use === "codex-gateway" && !record.revokedAt && record.expiresAt > now;
}

async function listSessionRecordsForEnv(
  env: Pick<Env, "ENVS_KV">,
  envSlug: string,
): Promise<CodexGatewaySessionRecord[]> {
  const records: CodexGatewaySessionRecord[] = [];
  let cursor: string | undefined;
  const prefix = envIndexPrefix(envSlug);

  do {
    const listed = await env.ENVS_KV.list({ prefix, cursor });
    const batch = await Promise.all(
      listed.keys.map(async (key) => {
        const tokenHash = key.name.slice(prefix.length);
        return await env.ENVS_KV.get<CodexGatewaySessionRecord>(recordKey(tokenHash), "json").catch(() => null);
      }),
    );
    for (const record of batch) {
      if (record?.use === "codex-gateway" && record.tokenHash) {
        records.push(record);
      }
    }
    cursor = listed.list_complete === false ? listed.cursor : undefined;
  } while (cursor);

  return records;
}

export async function mintCodexGatewaySessionToken(
  env: Pick<Env, "ENVS_KV">,
  input: MintCodexGatewaySessionTokenInput,
): Promise<{ token: string; expiresAt: number }> {
  const envSlug = input.envSlug.trim();
  if (!envSlug) {
    throw new Error("envSlug is required to mint a Codex gateway session token");
  }

  const token = createToken();
  const tokenHash = await sha256Hex(token);
  const now = Date.now();
  const expiresAt = now + (input.ttlMs ?? DEFAULT_GATEWAY_SESSION_TTL_MS);
  const record: CodexGatewaySessionRecord = {
    tokenHash,
    envSlug,
    routeKind: input.routeKind,
    machineId: normalizeOptionalString(input.machineId),
    gatewayUrl: normalizeOptionalString(input.gatewayUrl),
    createdAt: now,
    expiresAt,
    revokedAt: null,
    use: "codex-gateway",
  };

  const expirationTtl = Math.max(60, Math.ceil((expiresAt - now) / 1000));
  await env.ENVS_KV.put(recordKey(tokenHash), JSON.stringify(record), {
    expirationTtl,
  });
  await env.ENVS_KV.put(envIndexKey(envSlug, tokenHash), "1", {
    expirationTtl,
  });

  return { token, expiresAt };
}

export async function revokeCodexGatewaySessionsForEnv(
  env: Pick<Env, "ENVS_KV">,
  envSlug: string,
): Promise<number> {
  const normalizedEnvSlug = envSlug.trim();
  if (!normalizedEnvSlug) return 0;

  const now = Date.now();
  let revoked = 0;
  for (const record of await listSessionRecordsForEnv(env, normalizedEnvSlug)) {
    if (record.envSlug !== normalizedEnvSlug || record.revokedAt) {
      continue;
    }

    await env.ENVS_KV.put(recordKey(record.tokenHash), JSON.stringify({
      ...record,
      revokedAt: now,
    } satisfies CodexGatewaySessionRecord), {
      expirationTtl: 60,
    });
    await env.ENVS_KV.delete(envIndexKey(record.envSlug, record.tokenHash)).catch(() => {});
    revoked += 1;
  }

  return revoked;
}

export async function exchangeCodexGatewaySessionToken(
  env: Env,
  input: {
    token: string;
    gatewayMachineId?: string | null;
    gatewayServiceToken?: string | null;
  },
): Promise<ExchangedCodexGatewaySession> {
  const token = input.token.trim();
  if (!token) {
    throw new Error("Missing gateway session token");
  }

  const tokenHash = await sha256Hex(token);
  const record = await env.ENVS_KV.get<CodexGatewaySessionRecord>(recordKey(tokenHash), "json");
  if (!record || !isUsableRecord(record)) {
    throw new Error("Gateway session token is invalid or expired");
  }

  const gatewayMachineId = normalizeOptionalString(input.gatewayMachineId);
  if (!gatewayMachineId) {
    throw new Error("Gateway machine id is required");
  }
  if (record.machineId && record.machineId !== gatewayMachineId) {
    throw new Error("Gateway session token is not scoped to this gateway");
  }

  const host = await readRoutableHostService(env, record.machineId ?? gatewayMachineId);
  if (!host) {
    throw new Error("Subscription Gateway is offline");
  }

  if (host.machineId !== gatewayMachineId || (record.machineId && host.machineId !== record.machineId)) {
    throw new Error("Gateway session token host is no longer active");
  }

  const gatewayServiceToken = normalizeOptionalString(input.gatewayServiceToken);
  const gatewayServiceTokenHash = normalizeOptionalString(host.gatewayServiceTokenHash);
  if (!gatewayServiceToken || !gatewayServiceTokenHash) {
    throw new Error("Gateway service credential is required");
  }
  if (await sha256Hex(gatewayServiceToken) !== gatewayServiceTokenHash) {
    throw new Error("Gateway service credential is invalid");
  }

  if (record.routeKind === "gateway-subscription") {
    if (!host.gatewayUrl || (record.gatewayUrl && host.gatewayUrl !== record.gatewayUrl)) {
      throw new Error("Published gateway route is no longer active");
    }
  } else if (!host.gatewayPort) {
    throw new Error("Host gateway route is no longer active");
  }

  const auth = await getValidOpenAIAuth(env);
  return {
    accessToken: auth.access_token,
    accountId: auth.account_id ?? null,
    expiresAt: auth.expires_at,
  };
}
