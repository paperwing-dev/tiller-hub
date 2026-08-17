import { getOrCreateSecret } from "../setup/config";
import type { Env } from "../types";

const CAPABILITY_SECRET_KEY = "TILLER_RUNTIME_CAPABILITY_KEY";
const SECRET_CACHE_TTL_MS = 5 * 60_000;
export const TILLER_CAPABILITY_HEADER = "X-Tiller-Capability";

let cached: { secret: string; key: CryptoKey; at: number } | null = null;

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  if (cached && Date.now() - cached.at < SECRET_CACHE_TTL_MS) return cached.key;
  const secret = await getOrCreateSecret(env, CAPABILITY_SECRET_KEY, randomSecret);
  if (cached?.secret === secret) {
    cached.at = Date.now();
    return cached.key;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  cached = { secret, key, at: Date.now() };
  return key;
}

export interface EnvironmentRuntimeSubject {
  envSlug: string;
  incarnationId: string;
  startOperationId: string;
}

export function environmentRuntimeCapabilitySubject(input: EnvironmentRuntimeSubject): string {
  return [
    "v1",
    "environment-runtime",
    input.envSlug,
    input.incarnationId,
    input.startOperationId,
  ].join(" | ");
}

async function signHex(env: Env, subject: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    new TextEncoder().encode(subject),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mintEnvironmentRuntimeCapability(
  env: Env,
  input: EnvironmentRuntimeSubject,
): Promise<string> {
  return signHex(env, environmentRuntimeCapabilitySubject(input));
}

export function constantTimeEqual(left: string, right: string): boolean {
  let mismatch = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

export async function verifyEnvironmentRuntimeCapability(
  env: Env,
  input: EnvironmentRuntimeSubject,
  capability: string | null | undefined,
): Promise<boolean> {
  const supplied = capability?.trim() ?? "";
  if (!supplied) return false;
  const expected = await mintEnvironmentRuntimeCapability(env, input);
  return constantTimeEqual(expected, supplied);
}

export function resetRuntimeCapabilityForTests(): void {
  cached = null;
}
