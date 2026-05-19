import { Hono } from "hono";
import { normalizeCloudflareUiError } from "../cloudflare-errors";
import type { HonoEnv } from "../types";
import { deriveManagedMachineHostnames } from "../machine-hosts";
import { resolveProtectionState } from "../protection";
import { getSecret } from "../setup/config";
import { resolveSetupStatus } from "../setup/status-resolver";
import {
  resolveAccountForHostname,
} from "./cloudflare-api";
import {
  buildPersistedManagedAccessConfig,
  cleanupSupersededManagedHubAccess,
  persistManagedAccessConfig,
  prepareManagedExactHostAccess,
  provisionManagedServiceHosts,
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
  }>();
  const apiToken = body.apiToken?.trim() ?? "";
  const emails = normalizeEmails(body.emails);

  if (!apiToken) {
    return c.json({ error: "Cloudflare API token is required" }, 400);
  }

  const protection = await resolveProtectionState(c.env, c.req.url);
  const hostname = new URL(protection.hubUrl).hostname;

  if (protection.hostKind === "workers-dev") {
    return c.json(
      {
        error: "Cloudflare Access is only supported after you connect a custom domain. workers.dev deployments stay public.",
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

accessRoutes.post("/api/access/provision-machine-hosts", async (c) => {
  const body = await c.req.json<{ apiToken?: string }>();
  const apiToken = body.apiToken?.trim() ?? "";

  if (!apiToken) {
    return c.json({ error: "Cloudflare API token is required" }, 400);
  }

  const protection = await resolveProtectionState(c.env, c.req.url);
  if (protection.hostKind === "workers-dev") {
    return c.json(
      { error: "Protected machine hosts are only available after you connect a custom domain." },
      400,
    );
  }

  const currentStatus = await resolveSetupStatus(c.env, c.req.raw);
  if (!currentStatus.browserProtected) {
    return c.json(
      { error: "Protect the hub browser access first, then provision the Tiller gateway hostname." },
      409,
    );
  }

  const hostname = new URL(protection.hubUrl).hostname;
  const { accountId, zoneId, zoneName } = await resolveAccountForHostname(apiToken, hostname);
  const managedHosts = deriveManagedMachineHostnames(protection.hubUrl);
  const serviceTokenId = (await getSecret(c.env, "CF_ACCESS_SERVICE_TOKEN_ID"))?.trim() ?? "";
  if (!serviceTokenId) {
    return c.json(
      {
        error: "The protected hub is missing its shared machine service token record. Repair browser protection first, then retry machine-host provisioning.",
      },
      409,
    );
  }

  try {
    const provisioned = await provisionManagedServiceHosts(c.env, {
      apiToken,
      accountId,
      zoneId,
      gatewayHostname: managedHosts.gatewayHostname,
      serviceTokenId,
    });
    const status = await resolveSetupStatus(c.env, c.req.raw);

    return c.json({
      ok: true,
      hostname,
      hubUrl: protection.hubUrl,
      zoneName,
      gatewayHostname: provisioned.gateway.hostname,
      status,
    });
  } catch (error) {
    const normalized = normalizeCloudflareUiError(error, hostname);
    return c.json(normalized, normalized.status);
  }
});

export default accessRoutes;
