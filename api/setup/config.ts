import type { Env } from "../types";
import { getDurableObjectStub } from "../durable-object";
import { normalizeCloudflareIdleTimeoutMinutes } from "../../shared/cloudflare-timeout";
import {
  normalizeBillingSelections,
  type BillingSelections,
} from "../../shared/billing";

// ── Per-isolate cache ──────────────────────────────────────────────

let cached: { config: Record<string, string>; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

type HubConfigStore = {
  getAllConfig(): Promise<Record<string, string>> | Record<string, string>;
  getBillingSelections(): Promise<BillingSelections> | BillingSelections;
  getConfig(key: string): Promise<string | undefined> | string | undefined;
  setConfig(key: string, value: string): Promise<void> | void;
  getOrCreateConfig(key: string, value: string): Promise<string> | string;
};

export function invalidateConfigCache(): void {
  cached = null;
}

function getHubConfigStore(env: Env): HubConfigStore {
  if (!(env as Partial<Env>).HUB) {
    throw new Error("The HubDO binding is required to read Tiller settings.");
  }
  return getDurableObjectStub<HubConfigStore>(env, env.HUB, "hub");
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

/** Always bypasses the bulk config cache and exposes no credential material. */
export async function getBillingSelections(env: Env): Promise<BillingSelections> {
  const hub = getHubConfigStore(env);
  return normalizeBillingSelections(await hub.getBillingSelections());
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
 * Returns the shared default when the persisted value is missing or outside
 * the supported bounds (sleepAfter=0 expires immediately).
 */
export async function getIdleTimeoutMinutes(env: Env): Promise<number> {
  const config = await loadConfig(env);
  return normalizeCloudflareIdleTimeoutMinutes(config["IDLE_TIMEOUT_MINUTES"]);
}
