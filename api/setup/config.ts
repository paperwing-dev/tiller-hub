import { getLocationHintOptions } from "../helpers";
import type { Env } from "../types";

// ── Per-isolate cache ──────────────────────────────────────────────

let cached: { config: Record<string, string>; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

type HubConfigStore = {
  getAllConfig(): Promise<Record<string, string>> | Record<string, string>;
  getConfig(key: string): Promise<string | undefined> | string | undefined;
  getOrCreateConfig(key: string, value: string): Promise<string> | string;
};

export function invalidateConfigCache(): void {
  cached = null;
}

function getHubConfigStore(env: Env): HubConfigStore {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as HubConfigStore;
}

function getEnvSecretValue(env: Env, key: string): string | undefined {
  const envVal = (env as unknown as Record<string, unknown>)[key];
  return typeof envVal === "string" && envVal.length > 0 ? envVal : undefined;
}

/**
 * Load all config key/value pairs from HubDO.
 * Cached per-isolate with a 60-second TTL to avoid hitting the DO on every request.
 */
export async function loadConfig(env: Env): Promise<Record<string, string>> {
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.config;
  const hub = getHubConfigStore(env);
  const config = await hub.getAllConfig();
  cached = { config, ts: Date.now() };
  return config;
}

/**
 * Resolve a secret by checking wrangler env first, then falling back to DO config.
 * Wrangler secrets always take precedence.
 */
export async function getSecret(
  env: Env,
  key: string,
  options?: { fresh?: boolean },
): Promise<string | undefined> {
  const envVal = getEnvSecretValue(env, key);
  if (envVal) return envVal;
  if (options?.fresh) {
    const hub = getHubConfigStore(env);
    return (await hub.getConfig(key)) || undefined;
  }
  const config = await loadConfig(env);
  return config[key] || undefined;
}

export async function getOrCreateSecret(
  env: Env,
  key: string,
  createValue: () => string,
): Promise<string> {
  const envVal = getEnvSecretValue(env, key);
  if (envVal) {
    return envVal;
  }

  const hub = getHubConfigStore(env);
  const value = await hub.getOrCreateConfig(key, createValue());
  if (cached) {
    cached = {
      config: {
        ...cached.config,
        [key]: value,
      },
      ts: Date.now(),
    };
  }
  return value;
}

/**
 * Read the global idle timeout for CF containers (in minutes).
 * Returns 10 by default. Minimum 1 (sleepAfter=0 expires immediately).
 */
export async function getIdleTimeoutMinutes(env: Env): Promise<number> {
  const config = await loadConfig(env);
  const raw = config["IDLE_TIMEOUT_MINUTES"];
  if (!raw) return 10;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 10;
}

/**
 * Read the canonical main bootstrap depth for repo git initialization.
 * Returns 0 by default, meaning "full history" (no `--depth` flag).
 * Positive values configure a shallow clone and are clamped to 1..200.
 * Zero or negative values are normalized to 0 (full history).
 */
export async function getCanonicalMainBootstrapDepth(env: Env): Promise<number> {
  const config = await loadConfig(env);
  const raw = config["CANONICAL_MAIN_BOOTSTRAP_DEPTH"];
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(200, parsed);
}
