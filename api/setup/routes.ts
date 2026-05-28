import { Hono } from "hono";
import type { HonoEnv, Env } from "../types";
import { getLocationHintOptions, getSandboxStub } from "../helpers";
import { listEnvViews } from "../env/view";
import { normalizeCloudflareUiError } from "../cloudflare-errors";
import { getIdleTimeoutMinutes, getSecret, invalidateConfigCache } from "./config";
import {
  inferCloudflareAccessJwtConfig,
  verifyCfAccessJwt,
  verifyInferredCloudflareAccessToken,
} from "../auth";
import { deriveManagedMachineHostnames } from "../machine-hosts";
import {
  resolveWorkerServiceName,
  verifyWorkerDomainAccess,
} from "./cloudflare";
import { getRouteKind, resolveProtectionState } from "../protection";
import {
  assertNoUnsupportedWildcardCoverage,
  findExactAndWildcardApps,
} from "../access/manage";
import { ACCESS_CONFIG_CLAIM_KEYS } from "../access/config-keys";
import {
  listAccessApps,
  listServiceTokens,
  resolveAccountForHostname,
} from "../access/cloudflare-api";
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
    claimWorkersDevAccessConfig(input: {
      audience: string;
      teamDomain: string;
    }): {
      claimed: boolean;
      audience: string | null;
      teamDomain: string | null;
    };
  };
}

async function hasAnyAccessConfigValue(env: Env): Promise<boolean> {
  for (const key of ACCESS_CONFIG_CLAIM_KEYS) {
    if ((await getSecret(env, key, { fresh: true }))?.trim()) {
      return true;
    }
  }
  return false;
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

  return c.json({ ok: true, saved: entries.map(([k]) => k) });
});

setupRoutes.post("/api/setup/workers-dev-access", async (c) => {
  const protection = await resolveProtectionState(c.env, c.req.url);
  if (getRouteKind(c.req.url) !== "workers-dev") {
    return c.json({ error: "workers.dev Access setup only applies to workers.dev routes." }, 400);
  }

  if (protection.accessConfigured) {
    return c.json({
      ok: true,
      status: await resolveSetupStatus(c.env, c.req.raw),
    });
  }
  if (await hasAnyAccessConfigValue(c.env)) {
    return c.json({
      error: "workers.dev Access claim can only run before Access config exists.",
      code: "access_config_not_empty",
    }, 409);
  }

  const rawBody = await c.req.text().catch(() => "");
  const trimmedBody = rawBody.trim();
  if (trimmedBody && trimmedBody !== "{}") {
    return c.json({
      error: "workers.dev Access claim does not accept request body fields.",
      code: "body_not_supported",
    }, 400);
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) {
    return c.json({
      error: "Cloudflare Access did not send a JWT. If you just enabled Access, wait a bit, reload Tiller through Access, then verify again.",
      code: "missing_access_jwt",
      hint: "Cloudflare Access can take about 30 seconds to start sending the JWT after you turn it on. Reload this page after the wait, sign in if prompted, then verify again.",
    }, 400);
  }

  let inferred: { audience: string; issuer: string };
  try {
    inferred = inferCloudflareAccessJwtConfig(token);
    await verifyInferredCloudflareAccessToken(token, inferred);
  } catch (error) {
    return c.json({
      error: error instanceof Error ? error.message : "Invalid Cloudflare Access JWT",
      code: "invalid_access_jwt",
    }, 400);
  }

  const hub = getHub(c.env);
  const claim = await hub.claimWorkersDevAccessConfig({
    audience: inferred.audience,
    teamDomain: inferred.issuer,
  });
  invalidateConfigCache();

  if (!claim.claimed) {
    try {
      await verifyCfAccessJwt(c.req.raw, c.env);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
  }

  return c.json({
    ok: true,
    status: await resolveSetupStatus(c.env, c.req.raw),
  });
});

setupRoutes.post("/api/setup/custom-domain", async (c) => {
  return c.json(
    {
      error:
        "Custom domains are now configured through Tiller Self Host setup. Run `tiller host setup --hub-url <workersDevHubUrl>` from the protected workers.dev hub URL.",
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

export default setupRoutes;
