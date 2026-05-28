import { Hono } from "hono";
import { normalizeCloudflareUiError } from "../cloudflare-errors";
import type { HonoEnv } from "../types";
import { resolveProtectionState } from "../protection";
import { resolveSetupStatus } from "../setup/status-resolver";
import {
  resolveAccountForHostname,
} from "./cloudflare-api";
import {
  buildPersistedManagedAccessConfig,
  cleanupSupersededManagedHubAccess,
  persistManagedAccessConfig,
  prepareManagedExactHostAccess,
  readManagedAccessConfigSnapshot,
  restoreManagedAccessConfigSnapshot,
} from "./manage";

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

const accessRoutes = new Hono<HonoEnv>();

accessRoutes.post("/api/access/setup", async (c) => {
  const body = await c.req.json<{
    apiToken?: string;
    emails?: unknown;
    accessTeamDomain?: string;
  }>();
  const apiToken = body.apiToken?.trim() ?? "";
  const emails = normalizeEmails(body.emails);
  const accessTeamDomain = body.accessTeamDomain?.trim() ?? "";

  if (!apiToken) {
    return c.json({ error: "Cloudflare API token is required" }, 400);
  }

  const protection = await resolveProtectionState(c.env, c.req.url);
  const hostname = new URL(protection.hubUrl).hostname;

  if (protection.routeKind === "workers-dev") {
    return c.json(
      {
        error: "Automated Access setup is only supported for custom domains. For workers.dev, enable Access in the Cloudflare dashboard and save the audience/team-domain details in setup.",
      },
      400,
    );
  }

  const { accountId, zoneName } = await resolveAccountForHostname(apiToken, hostname);
  const configSnapshot = await readManagedAccessConfigSnapshot(c.env);
  const prepared = await prepareManagedExactHostAccess(c.env, {
    apiToken,
    accountId,
    hostname,
    emails,
    reuseExistingServiceToken: true,
    accessTeamDomain,
  });

  try {
    await persistManagedAccessConfig(c.env, buildPersistedManagedAccessConfig(prepared));
    await cleanupSupersededManagedHubAccess(apiToken, prepared).catch(() => {});
    const status = await resolveSetupStatus(c.env, c.req.raw);

    return c.json({
      ok: true,
      hostname,
      hubUrl: protection.hubUrl,
      zoneName,
      appId: prepared.app.id,
      aud: prepared.app.aud,
      appDomain: prepared.appDomain,
      clientId: prepared.serviceToken.client_id,
      clientSecret: prepared.serviceToken.client_secret,
      emails,
      status,
    });
  } catch (error) {
    await prepared.cleanupDraftResources().catch(() => {});
    await restoreManagedAccessConfigSnapshot(c.env, configSnapshot).catch(() => {});
    const normalized = normalizeCloudflareUiError(error, hostname);
    return c.json(normalized, normalized.status);
  }
});

export default accessRoutes;
