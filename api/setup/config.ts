import { getLocationHintOptions } from "../helpers";
import type { Env } from "../types";

// ── Per-isolate cache ──────────────────────────────────────────────

let cached: { config: Record<string, string>; ts: number } | null = null;
const CACHE_TTL_MS = 60_000;

type HubConfigStore = {
  getAllConfig(): Promise<Record<string, string>> | Record<string, string>;
  getConfig(key: string): Promise<string | undefined> | string | undefined;
  setConfig(key: string, value: string): Promise<void> | void;
  getOrCreateConfig(key: string, value: string): Promise<string> | string;
};

export type DeploymentMode = "hosted" | "self-host";
export type RouteKind = "workers-dev" | "custom-domain";

const DEPLOYMENT_MODE_KEY = "TILLER_DEPLOYMENT_MODE";

export function invalidateConfigCache(): void {
  cached = null;
}

function getHubConfigStore(env: Env): HubConfigStore {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as HubConfigStore;
}

function hasHubConfigStore(env: Env): boolean {
  return Boolean((env as unknown as { HUB?: unknown }).HUB);
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

function normalizeDeploymentMode(value: string | undefined): DeploymentMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "hosted" || normalized === "self-host" ? normalized : null;
}

function updateCachedConfig(key: string, value: string): void {
  if (!cached) return;
  cached = {
    config: {
      ...cached.config,
      [key]: value,
    },
    ts: Date.now(),
  };
}

export function routeKindFromUrl(url: string | undefined): RouteKind {
  if (!url?.trim()) return "workers-dev";
  try {
    return new URL(url).hostname.endsWith(".workers.dev") ? "workers-dev" : "custom-domain";
  } catch {
    return "workers-dev";
  }
}

export async function setDeploymentMode(env: Env, mode: DeploymentMode): Promise<void> {
  if (!hasHubConfigStore(env)) return;
  const hub = getHubConfigStore(env);
  await hub.setConfig(DEPLOYMENT_MODE_KEY, mode);
  updateCachedConfig(DEPLOYMENT_MODE_KEY, mode);
}

export async function resolveDeploymentMode(
  env: Env,
  _options: {
    routeKind: RouteKind;
    hostRegistered: boolean;
    hostGatewayConfigured: boolean;
    gatewayProvisioned: boolean;
  },
): Promise<DeploymentMode> {
  if (!hasHubConfigStore(env)) {
    return normalizeDeploymentMode(getEnvSecretValue(env, DEPLOYMENT_MODE_KEY)) ?? "hosted";
  }
  const configured = normalizeDeploymentMode(await getSecret(env, DEPLOYMENT_MODE_KEY, { fresh: true }));
  return configured ?? "hosted";
}

export async function resolveDeploymentModeForRuntime(
  env: Env,
  options: {
    hubUrl?: string | null;
    hostRegistered?: boolean;
    hostGatewayConfigured?: boolean;
    gatewayProvisioned?: boolean;
  } = {},
): Promise<DeploymentMode> {
  const hubUrl = options.hubUrl ?? await getSecret(env, "HUB_PUBLIC_URL");
  return resolveDeploymentMode(env, {
    routeKind: routeKindFromUrl(hubUrl ?? undefined),
    hostRegistered: options.hostRegistered ?? false,
    hostGatewayConfigured: options.hostGatewayConfigured ?? false,
    gatewayProvisioned: options.gatewayProvisioned ?? false,
  });
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
