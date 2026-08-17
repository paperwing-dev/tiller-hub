import { Hono } from "hono";
import type { HonoEnv, Env } from "../types";
import { getSandboxStub } from "../helpers";
import { listEnvViews } from "../env/view";
import { getIdleTimeoutMinutes, getSecret, invalidateConfigCache } from "./config";
import {
  DASHBOARD_ONBOARDING_DISMISSED_KEY,
  resolveSetupStatus,
} from "./status-resolver";
import { isLocalDevRequest } from "../protection";
import { readWorkersDevAccessLifecycle } from "../workers-dev-access/records";
import {
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
  isCloudflareIdleTimeoutMinutes,
} from "../../shared/cloudflare-timeout";
import { normalizeBillingMode, type BillingMode } from "../../shared/billing";
import { getDurableObjectStub } from "../durable-object";
import { isPlacementRegion } from "../../shared/placement";

// Keys that can be managed via the settings page.
const CONFIGURABLE_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "TILLER_WORKERS_AI_ACCOUNT_ID",
  "TILLER_WORKERS_AI_API_TOKEN",
  "IDLE_TIMEOUT_MINUTES",
] as const);

type ConfigurableKey = typeof CONFIGURABLE_KEYS extends Set<infer T> ? T : never;

function getHub(env: Env) {
  return getDurableObjectStub<{
    setConfig(key: string, value: string): void;
  }>(env, env.HUB, "hub");
}

// ── Routes ─────────────────────────────────────────────────────────

const setupRoutes = new Hono<HonoEnv>();

setupRoutes.get("/api/setup/status", async (c) => {
  c.header("Cache-Control", "no-store");
  const isLocalDev = isLocalDevRequest(c.env, c.req.raw);
  if (!isLocalDev
    && c.env.TILLER_INSTALLER_SCHEMA?.trim()
    && !isPlacementRegion(c.env.DO_LOCATION_HINT)) {
    return c.json({
      error: "Installer-managed installation region binding is missing or invalid.",
      code: "installation_region_configuration_error",
    }, 503);
  }
  if (!isLocalDev) {
    const lifecycle = await readWorkersDevAccessLifecycle(c.env);
    if (!lifecycle.configured) {
      return c.json({
        error: "Installer-managed Cloudflare Access bindings are missing or invalid.",
        code: "access_repair_required",
      }, 503);
    }
  }
  return c.json(await resolveSetupStatus(c.env, c.req.raw));
});

setupRoutes.post("/api/setup", async (c) => {
  const body = await c.req.json<{
    secrets?: Record<string, string>;
    settings?: { claudeBillingMode?: BillingMode | null; openaiBillingMode?: BillingMode | null };
  } | null>();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Request body must be an object" }, 400);
  }
  const secrets = body.secrets && typeof body.secrets === "object" ? body.secrets : {};

  const entries = Object.entries(secrets).filter(
    ([, v]) => typeof v === "string" && v.length > 0,
  );
  const invalid = entries.filter(([k]) => !CONFIGURABLE_KEYS.has(k as ConfigurableKey));
  if (invalid.length > 0) {
    return c.json(
      { error: `Invalid keys: ${invalid.map(([k]) => k).join(", ")}` },
      400,
    );
  }

  const rawSettings = body.settings;
  if (rawSettings !== undefined && (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings))) {
    return c.json({ error: "settings must be an object" }, 400);
  }
  const unknownSettingKeys = rawSettings
    ? Object.keys(rawSettings).filter((key) => key !== "claudeBillingMode" && key !== "openaiBillingMode")
    : [];
  if (unknownSettingKeys.length > 0) {
    return c.json({ error: `Invalid settings: ${unknownSettingKeys.join(", ")}` }, 400);
  }
  const settingEntries = rawSettings
    ? Object.entries(rawSettings).filter(([, value]) => value !== undefined)
    : [];
  for (const [key, value] of settingEntries) {
    if (value === null) {
      return c.json({ error: `${key} cannot be reset to null after activation` }, 400);
    }
    if (!normalizeBillingMode(value)) {
      return c.json({ error: `${key} must be 'subscription' or 'api'` }, 400);
    }
  }

  if (entries.length === 0 && settingEntries.length === 0) {
    return c.json({ error: "No valid secrets or settings provided" }, 400);
  }

  const idleTimeout = entries.find(([key]) => key === "IDLE_TIMEOUT_MINUTES");
  if (idleTimeout && !isCloudflareIdleTimeoutMinutes(Number(idleTimeout[1]))) {
    return c.json({
      error: `IDLE_TIMEOUT_MINUTES must be an integer between ${CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES} and ${CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES}`,
    }, 400);
  }

  const hub = getHub(c.env);
  for (const [key, value] of entries) {
    await hub.setConfig(key, value);
  }
  for (const [key, value] of settingEntries) {
    await hub.setConfig(key, value as BillingMode);
  }

  invalidateConfigCache();

  // Propagate idle timeout changes to running CF sandboxes
  if (entries.some(([k]) => k === "IDLE_TIMEOUT_MINUTES")) {
    const minutes = await getIdleTimeoutMinutes(c.env);
    const allEnvs = await listEnvViews(c.env);
    const cfStarted = allEnvs.filter((m) => m.status === "running" && m.backend === "cf");
    for (const meta of cfStarted) {
      try {
        const stub = getSandboxStub(c.env, meta.slug);
        await stub.setSleepTimeout(minutes);
      } catch (err) {
        console.warn(`[setup] Failed to update sleep timeout for ${meta.slug}:`, err);
      }
    }
  }

  return c.json({ ok: true, saved: [...entries, ...settingEntries].map(([k]) => k) });
});

setupRoutes.post("/api/setup/onboarding/dismiss", async (c) => {
  await getHub(c.env).setConfig(DASHBOARD_ONBOARDING_DISMISSED_KEY, "1");
  invalidateConfigCache();
  return c.json({ ok: true });
});

setupRoutes.post("/api/setup/verify-model-auth", async (c) => {
  const body = await c.req.json<{ key?: unknown } | null>().catch(() => null);
  const requestedKey = typeof body?.key === "string" ? body.key : null;
  if (requestedKey && requestedKey !== "ANTHROPIC_API_KEY" && requestedKey !== "OPENAI_API_KEY") {
    return c.json({ error: "Unsupported credential", results: [] }, 400);
  }

  const anthropicKey = (await getSecret(c.env, "ANTHROPIC_API_KEY", { fresh: true }))?.trim();
  const oauthToken = (await getSecret(c.env, "CLAUDE_CODE_OAUTH_TOKEN", { fresh: true }))?.trim();
  const openaiKey = (await getSecret(c.env, "OPENAI_API_KEY", { fresh: true }))?.trim();

  const results: Array<{
    key: string;
    mode: string;
    ok: boolean;
    error?: string;
    warning?: string;
    note?: string;
  }> = [];

  if (anthropicKey && (!requestedKey || requestedKey === "ANTHROPIC_API_KEY")) {
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      if (res.ok) {
        results.push({ key: "ANTHROPIC_API_KEY", mode: "api", ok: true });
      } else if (res.status === 401) {
        results.push({ key: "ANTHROPIC_API_KEY", mode: "api", ok: false, error: "API key is invalid or expired" });
      } else if (res.status === 429) {
        results.push({ key: "ANTHROPIC_API_KEY", mode: "api", ok: true, warning: "Key is valid but currently rate-limited" });
      } else {
        const body = await res.text().catch(() => "");
        results.push({ key: "ANTHROPIC_API_KEY", mode: "api", ok: false, error: `Unexpected response (${res.status}): ${body.slice(0, 200)}` });
      }
    } catch (err) {
      results.push({ key: "ANTHROPIC_API_KEY", mode: "api", ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (oauthToken && !requestedKey) {
    results.push({ key: "CLAUDE_CODE_OAUTH_TOKEN", mode: "subscription", ok: true, note: "Token stored (cannot verify programmatically)" });
  }

  if (openaiKey && (!requestedKey || requestedKey === "OPENAI_API_KEY")) {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${openaiKey}` },
      });
      if (res.ok) {
        results.push({ key: "OPENAI_API_KEY", mode: "api-key", ok: true });
      } else if (res.status === 401) {
        results.push({ key: "OPENAI_API_KEY", mode: "api-key", ok: false, error: "API key is invalid or expired" });
      } else {
        results.push({ key: "OPENAI_API_KEY", mode: "api-key", ok: false, error: `Unexpected response (${res.status})` });
      }
    } catch (err) {
      results.push({ key: "OPENAI_API_KEY", mode: "api-key", ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (results.length === 0) {
    return c.json({
      ok: false,
      error: requestedKey ? "Credential is not configured" : "No credentials configured",
      results: [],
    });
  }

  const allOk = results.every((r) => r.ok);
  return c.json({ ok: allOk, results });
});

export default setupRoutes;
