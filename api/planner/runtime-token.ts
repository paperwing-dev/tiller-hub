import { getOrCreateSecret } from "../setup/config";
import type { Env } from "../types";

const TOKEN_SECRET_KEY = "TILLER_PLANNER_RUNTIME_TOKEN_KEY";

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// getOrCreateSecret is a Hub DO round trip, and every mint/verify needs the
// same secret. Cache the secret and its imported HMAC key at module scope,
// but with a TTL: the secret normally never rotates, yet a warm isolate must
// converge after a hub-storage restore (otherwise it mints/verifies with the
// old secret indefinitely and every container callback 401s until eviction).
const SECRET_CACHE_TTL_MS = 5 * 60 * 1000;
let cached: { secret: string; key: CryptoKey; cachedAt: number } | null = null;

async function getHmacKey(env: Env): Promise<CryptoKey> {
  const existing = cached;
  if (existing && Date.now() - existing.cachedAt < SECRET_CACHE_TTL_MS) return existing.key;
  const secret = await getOrCreateSecret(env, TOKEN_SECRET_KEY, randomSecret);
  if (existing && existing.secret === secret) {
    existing.cachedAt = Date.now();
    return existing.key;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cached = { secret, key, cachedAt: Date.now() };
  return key;
}

async function hmacHex(env: Env, message: string): Promise<string> {
  const key = await getHmacKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let index = 0; index < a.length; index += 1) {
    mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function mintPlannerRunToken(env: Env, runId: string): Promise<string> {
  return hmacHex(env, `run:${runId}`);
}

export async function verifyPlannerRunToken(env: Env, runId: string, token: string | null | undefined): Promise<boolean> {
  if (!token || !token.trim()) return false;
  const expected = await mintPlannerRunToken(env, runId);
  return timingSafeEqualHex(expected, token.trim());
}

export async function mintPlanWriterRuntimeToken(
  env: Env,
  repoId: string,
  planArtifactId: string,
  generation: number,
): Promise<string> {
  return hmacHex(env, `plan-writer:${repoId}:${planArtifactId}:${generation}`);
}

export async function verifyPlanWriterRuntimeToken(
  env: Env,
  repoId: string,
  planArtifactId: string,
  generation: number,
  token: string | null | undefined,
): Promise<boolean> {
  if (!token || !token.trim()) return false;
  const expected = await mintPlanWriterRuntimeToken(env, repoId, planArtifactId, generation);
  return timingSafeEqualHex(expected, token.trim());
}
