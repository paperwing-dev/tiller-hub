import { getOrCreateSecret } from "../setup/config";
import type { Env } from "../types";

const CAPABILITY_SECRET_KEY = "TILLER_CODEX_RUNTIME_CAPABILITY_KEY";
const SECRET_CACHE_TTL_MS = 5 * 60_000;
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

export function implementorCodexRuntimeCapabilitySubject(input: {
  envSlug: string;
  incarnationId: string;
  startOpId: string;
}): string {
  return ["v1", "codex-app-server", input.envSlug, input.incarnationId, input.startOpId].join(" | ");
}

async function signHex(env: Env, subject: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(env),
    new TextEncoder().encode(subject),
  );
  return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function mintImplementorCodexRuntimeCapability(
  env: Env,
  input: { envSlug: string; incarnationId: string; startOpId: string },
): Promise<string> {
  return signHex(env, implementorCodexRuntimeCapabilitySubject(input));
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function verifyImplementorCodexRuntimeCapability(
  env: Env,
  input: { envSlug: string; incarnationId: string; startOpId: string },
  capability: string | null | undefined,
): Promise<boolean> {
  const supplied = capability?.trim() ?? "";
  if (!supplied) return false;
  const expected = await mintImplementorCodexRuntimeCapability(env, input);
  return constantTimeEqual(expected, supplied);
}

export function resetCodexRuntimeCapabilityForTests(): void {
  cached = null;
}
