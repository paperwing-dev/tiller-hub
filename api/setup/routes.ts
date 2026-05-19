import { Hono } from "hono";
import type { HonoEnv, Env } from "../types";
import { getLocationHintOptions, getSandboxStub } from "../helpers";
import { listEnvMetas } from "../plan/store";
import { normalizeCloudflareUiError } from "../cloudflare-errors";
import { getIdleTimeoutMinutes, getSecret, invalidateConfigCache } from "./config";
import { deriveManagedMachineHostnames } from "../machine-hosts";
import {
  detachWorkerCustomDomain,
  disableWorkerDevAlias,
  ensureWorkerCustomDomain,
  resolveWorkerServiceName,
  verifyWorkerDomainAccess,
} from "./cloudflare";
import { resolveProtectionState } from "../protection";
import {
  assertNoUnsupportedWildcardCoverage,
  buildPersistedManagedAccessConfig,
  cleanupSupersededManagedHubAccess,
  findExactAndWildcardApps,
  persistManagedAccessConfig,
  prepareManagedExactHostAccess,
  provisionManagedServiceHosts,
  readManagedAccessConfigSnapshot,
  restoreManagedAccessConfigSnapshot,
} from "../access/manage";
import { listAccessApps, listServiceTokens, resolveAccountForHostname } from "../access/cloudflare-api";
import { resolveSetupStatus } from "./status-resolver";

// Keys that can be managed via the settings page.
const CONFIGURABLE_KEYS = new Set([
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "TILLER_WORKERS_AI_ACCOUNT_ID",
  "TILLER_WORKERS_AI_API_TOKEN",
  "IDLE_TIMEOUT_MINUTES",
  "CANONICAL_MAIN_BOOTSTRAP_DEPTH",
] as const);

type ConfigurableKey = typeof CONFIGURABLE_KEYS extends Set<infer T> ? T : never;

function getHub(env: Env) {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as {
    setConfig(key: string, value: string): void;
  };
}

function normalizeEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const email = item.trim().toLowerCase();
    if (!email) continue;
    deduped.add(email);
  }

  return [...deduped];
}

// ── Routes ─────────────────────────────────────────────────────────

const setupRoutes = new Hono<HonoEnv>();

setupRoutes.get("/api/setup/status", async (c) => {
  return c.json(await resolveSetupStatus(c.env, c.req.raw));
});

setupRoutes.post("/api/setup", async (c) => {
  const body = await c.req.json<{ secrets?: Record<string, string> }>();
  if (!body.secrets || typeof body.secrets !== "object") {
    return c.json({ error: "Request body must contain a `secrets` object" }, 400);
  }

  const entries = Object.entries(body.secrets).filter(
    ([, v]) => typeof v === "string" && v.length > 0,
  );
  const invalid = entries.filter(([k]) => !CONFIGURABLE_KEYS.has(k as ConfigurableKey));
  if (invalid.length > 0) {
    return c.json(
      { error: `Invalid keys: ${invalid.map(([k]) => k).join(", ")}` },
      400,
    );
  }

  if (entries.length === 0) {
    return c.json({ error: "No valid secrets provided" }, 400);
  }

  const hub = getHub(c.env);
  for (const [key, value] of entries) {
    await hub.setConfig(key, value);
  }

  invalidateConfigCache();

  // Propagate idle timeout changes to running CF sandboxes
  if (entries.some(([k]) => k === "IDLE_TIMEOUT_MINUTES")) {
    const minutes = await getIdleTimeoutMinutes(c.env);
    const allEnvs = await listEnvMetas(c.env);
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

  return c.json({ ok: true, saved: entries.map(([k]) => k) });
});

setupRoutes.post("/api/setup/custom-domain", async (c) => {
  return c.json(
    {
      error:
        "Custom domains are only supported through Publish & Protect. Use /api/setup/publish-protect so the hub is not left publicly reachable on the custom domain.",
    },
    400,
  );
});

setupRoutes.post("/api/setup/verify-model-auth", async (c) => {
  const anthropicKey = (await getSecret(c.env, "ANTHROPIC_API_KEY"))?.trim();
  const oauthToken = (await getSecret(c.env, "CLAUDE_CODE_OAUTH_TOKEN"))?.trim();
  const openaiKey = (await getSecret(c.env, "OPENAI_API_KEY"))?.trim();

  const results: Array<{
    key: string;
    mode: string;
    ok: boolean;
    error?: string;
    warning?: string;
    note?: string;
  }> = [];

  if (anthropicKey) {
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

  if (oauthToken) {
    results.push({ key: "CLAUDE_CODE_OAUTH_TOKEN", mode: "subscription", ok: true, note: "Token stored (cannot verify programmatically)" });
  }

  if (openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/models", {
        headers: { Authorization: `Bearer ${openaiKey}` },
      });
      if (res.ok) {
        results.push({ key: "OPENAI_API_KEY", mode: "openai-api", ok: true });
      } else if (res.status === 401) {
        results.push({ key: "OPENAI_API_KEY", mode: "openai-api", ok: false, error: "API key is invalid or expired" });
      } else {
        results.push({ key: "OPENAI_API_KEY", mode: "openai-api", ok: false, error: `Unexpected response (${res.status})` });
      }
    } catch (err) {
      results.push({ key: "OPENAI_API_KEY", mode: "openai-api", ok: false, error: `Network error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  if (results.length === 0) {
    return c.json({ ok: false, error: "No credentials configured", results: [] });
  }

  const allOk = results.every((r) => r.ok);
  return c.json({ ok: allOk, results });
});

setupRoutes.post("/api/setup/verify-cloudflare-token", async (c) => {
  const body = await c.req.json<{ hostname?: string; apiToken?: string }>();
  const hostname = body.hostname?.trim() ?? "";
  const apiToken = body.apiToken?.trim() ?? "";

  if (!hostname) {
    return c.json({ error: "Custom domain hostname is required" }, 400);
  }
  if (!apiToken) {
    return c.json({ error: "Cloudflare API token is required" }, 400);
  }

  try {
    const workerServiceName = await resolveWorkerServiceName(c.env, c.req.url);
    const resolved = await resolveAccountForHostname(apiToken, hostname);
    const managedHosts = deriveManagedMachineHostnames(`https://${resolved.hostname}`);
    await verifyWorkerDomainAccess(apiToken, resolved.accountId);
    const apps = await listAccessApps(apiToken, resolved.accountId);
    await listServiceTokens(apiToken, resolved.accountId);
    for (const candidate of [
      resolved.hostname,
      managedHosts.gatewayHostname,
    ].filter((value): value is string => Boolean(value))) {
      assertNoUnsupportedWildcardCoverage(candidate, findExactAndWildcardApps(candidate, apps));
    }

    return c.json({
      ok: true,
      hostname: resolved.hostname,
      zoneName: resolved.zoneName,
      workerServiceName,
      gatewayHostname: managedHosts.gatewayHostname,
    });
  } catch (error) {
    const normalized = normalizeCloudflareUiError(error, hostname);
    return c.json(normalized, normalized.status);
  }
});

setupRoutes.post("/api/setup/publish-protect", async (c) => {
  const body = await c.req.json<{ hostname?: string; apiToken?: string; emails?: unknown }>();
  const hostname = body.hostname?.trim() ?? "";
  const apiToken = body.apiToken?.trim() ?? "";
  const emails = normalizeEmails(body.emails);

  if (!hostname) {
    return c.json({ error: "Custom domain hostname is required" }, 400);
  }
  if (!apiToken) {
    return c.json({ error: "Cloudflare API token is required" }, 400);
  }
  if (emails.length === 0) {
    return c.json({ error: "At least one email address is required" }, 400);
  }

  const protection = await resolveProtectionState(c.env, c.req.url);
  if (protection.hostKind !== "workers-dev") {
    return c.json({ error: "Publish & Protect starts from the workers.dev deployment URL." }, 400);
  }

  let connected:
    | Awaited<ReturnType<typeof ensureWorkerCustomDomain>>
    | null = null;
  let hubProtectionApplied = false;

  try {
    connected = await ensureWorkerCustomDomain(c.env, c.req.url, apiToken, hostname);
    const { accountId, zoneId } = await resolveAccountForHostname(apiToken, hostname);
    const managedHosts = deriveManagedMachineHostnames(connected.hubUrl);
    const configSnapshot = await readManagedAccessConfigSnapshot(c.env);
    const prepared = await prepareManagedExactHostAccess(c.env, {
      apiToken,
      accountId,
      hostname: connected.hostname,
      emails,
    });

    try {
      const hub = getHub(c.env);
      await hub.setConfig("HUB_PUBLIC_URL", connected.hubUrl);
      await hub.setConfig("WORKER_SERVICE_NAME", connected.service);
      await hub.setConfig("WORKERS_DEV_ALIAS_DISABLED", "false");
      await persistManagedAccessConfig(c.env, buildPersistedManagedAccessConfig(prepared));
      await cleanupSupersededManagedHubAccess(apiToken, prepared).catch(() => {});
      hubProtectionApplied = true;
    } catch (error) {
      await prepared.cleanupDraftResources().catch(() => {});
      await restoreManagedAccessConfigSnapshot(c.env, configSnapshot).catch(() => {});
      throw error;
    }

    try {
      await provisionManagedServiceHosts(c.env, {
        apiToken,
        accountId,
        zoneId,
        gatewayHostname: managedHosts.gatewayHostname,
        serviceTokenId: prepared.serviceToken.id,
      });
    } catch {
      const status = await resolveSetupStatus(c.env, c.req.raw);
      return c.json({
        ok: true,
        hubUrl: connected.hubUrl,
        hostname: connected.hostname,
        appDomain: prepared.appDomain,
        clientId: prepared.serviceToken.client_id,
        clientSecret: prepared.serviceToken.client_secret,
        status,
      });
    }

    let workersDevAliasDisabled = false;
    try {
      const disabled = await disableWorkerDevAlias(apiToken, connected.accountId, connected.service);
      workersDevAliasDisabled = !disabled.workersDevEnabled && !disabled.previewsEnabled;
    } catch {
      workersDevAliasDisabled = false;
    }

    if (workersDevAliasDisabled) {
      try {
        const hub = getHub(c.env);
        await hub.setConfig("WORKERS_DEV_ALIAS_DISABLED", "true");
      } catch {
        workersDevAliasDisabled = false;
      }
    }

    const status = await resolveSetupStatus(c.env, c.req.raw);
    return c.json({
      ok: true,
      hubUrl: connected.hubUrl,
      hostname: connected.hostname,
      appDomain: prepared.appDomain,
      clientId: prepared.serviceToken.client_id,
      clientSecret: prepared.serviceToken.client_secret,
      status,
    });
  } catch (error) {
    if (connected && !hubProtectionApplied) {
      try {
        await detachWorkerCustomDomain(apiToken, connected.accountId, connected.domainId);
      } catch {
        // Best effort rollback only; surface the original failure below.
      }
    }

    const normalized = normalizeCloudflareUiError(error, hostname);
    return c.json(normalized, normalized.status);
  }
});

export default setupRoutes;
