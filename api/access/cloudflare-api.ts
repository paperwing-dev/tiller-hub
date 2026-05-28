import { CloudflareApiError } from "../cloudflare-errors";
import { findBestMatchingZone, normalizeCustomDomainHostname } from "../setup/cloudflare";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
export const MANAGED_ACCESS_SESSION_DURATION = "720h";
const MANAGED_ACCESS_SERVICE_TOKEN_DURATION = "8760h";

interface CloudflareEnvelope<T> {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: T;
}

interface CloudflareZone {
  id: string;
  name: string;
  account?: { id?: string | null } | null;
}

export interface CloudflareAccount {
  id: string;
  name?: string | null;
}

export interface CloudflareAccessApp {
  id: string;
  aud?: string | null;
  domain?: string | null;
  name?: string | null;
  type?: string | null;
}

export interface CloudflareAccessPolicy {
  id: string;
  name?: string | null;
  precedence?: number | string | null;
  decision?: string | null;
}

export interface CloudflareServiceToken {
  id: string;
  client_id: string;
  client_secret: string;
}

export interface CloudflareAccessOrganization {
  auth_domain?: string | null;
}

export interface CloudflareTunnel {
  id: string;
  name: string;
  token?: string | null;
}

interface CloudflareWorkerScriptSettings {
  id?: string | null;
}

interface CloudflareWorkerAccountSubdomain {
  subdomain?: string | null;
}

interface CloudflareWorkerSubdomainStatus {
  enabled?: boolean | null;
  previews_enabled?: boolean | null;
}

interface CloudflareDnsRecord {
  id: string;
  type?: string | null;
  name?: string | null;
  content?: string | null;
  proxied?: boolean | null;
}

export interface WorkersDevRouteAccount {
  accountId: string;
  accountName: string | null;
  hostname: string;
  serviceName: string;
  workersDevSubdomain: string;
}

function normalizeWorkersDevLabel(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replace(/\.$/, "") ?? "";
}

export function parseWorkersDevHostname(hostnameInput: string): {
  hostname: string;
  serviceName: string;
  workersDevSubdomain: string;
} {
  const hostname = normalizeWorkersDevLabel(hostnameInput);
  if (!hostname.endsWith(".workers.dev")) {
    throw new Error("workers.dev Access setup only applies to workers.dev hostnames.");
  }

  const labels = hostname.slice(0, -".workers.dev".length).split(".").filter(Boolean);
  if (labels.length < 2) {
    throw new Error("Could not determine the Worker name and workers.dev account subdomain from this route.");
  }

  return {
    hostname,
    serviceName: labels[0],
    workersDevSubdomain: labels.slice(1).join("."),
  };
}

export async function listAccounts(apiToken: string): Promise<CloudflareAccount[]> {
  const accounts: CloudflareAccount[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareAccount[]>(
      apiToken,
      `/accounts?per_page=50&page=${page}`,
      { method: "GET" },
    );
    accounts.push(...result);
    if (result.length < 50) break;
  }

  return accounts;
}

export async function getWorkerAccountSubdomain(
  apiToken: string,
  accountId: string,
): Promise<string | null> {
  const result = await cloudflareApi<CloudflareWorkerAccountSubdomain>(
    apiToken,
    `/accounts/${accountId}/workers/subdomain`,
    { method: "GET" },
  );
  const subdomain = result.subdomain?.trim();
  return subdomain || null;
}

export async function getWorkerScriptSettings(
  apiToken: string,
  accountId: string,
  serviceName: string,
): Promise<CloudflareWorkerScriptSettings> {
  return cloudflareApi<CloudflareWorkerScriptSettings>(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${serviceName}/settings`,
    { method: "GET" },
  );
}

export async function getWorkerScriptSubdomainStatus(
  apiToken: string,
  accountId: string,
  serviceName: string,
): Promise<CloudflareWorkerSubdomainStatus> {
  return cloudflareApi<CloudflareWorkerSubdomainStatus>(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${serviceName}/subdomain`,
    { method: "GET" },
  );
}

export async function resolveAccountForWorkersDevRoute(
  apiToken: string,
  options: { hostname: string; serviceName?: string | null },
): Promise<WorkersDevRouteAccount> {
  const parsed = parseWorkersDevHostname(options.hostname);
  const requestedServiceName = normalizeWorkersDevLabel(options.serviceName) || parsed.serviceName;
  const accounts = await listAccounts(apiToken);
  const matches: CloudflareAccount[] = [];

  for (const account of accounts) {
    const accountId = account.id?.trim();
    if (!accountId) continue;

    let accountSubdomain: string | null = null;
    try {
      accountSubdomain = await getWorkerAccountSubdomain(apiToken, accountId);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.status === 404) {
        continue;
      }
      throw error;
    }

    if (normalizeWorkersDevLabel(accountSubdomain) === parsed.workersDevSubdomain) {
      matches.push(account);
    }
  }

  if (matches.length === 0) {
    throw new Error(`This token cannot find the Cloudflare account that owns ${parsed.hostname}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple Cloudflare accounts matched ${parsed.hostname}. Scope the API token to one account and retry.`);
  }

  const account = matches[0];
  await getWorkerScriptSettings(apiToken, account.id, requestedServiceName);

  const subdomainStatus = await getWorkerScriptSubdomainStatus(apiToken, account.id, requestedServiceName);
  if (subdomainStatus.enabled === false) {
    throw new Error(`The workers.dev route for Worker ${requestedServiceName} is disabled in Cloudflare.`);
  }

  return {
    accountId: account.id,
    accountName: account.name?.trim() || null,
    hostname: parsed.hostname,
    serviceName: requestedServiceName,
    workersDevSubdomain: parsed.workersDevSubdomain,
  };
}

export async function listServiceTokens(
  apiToken: string,
  accountId: string,
): Promise<CloudflareServiceToken[]> {
  const tokens: CloudflareServiceToken[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareServiceToken[]>(
      apiToken,
      `/accounts/${accountId}/access/service_tokens?page=${page}&per_page=50`,
      { method: "GET" },
    );
    tokens.push(...result);
    if (result.length < 50) break;
  }

  return tokens;
}

export async function listAccessApps(
  apiToken: string,
  accountId: string,
): Promise<CloudflareAccessApp[]> {
  const apps: CloudflareAccessApp[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareAccessApp[]>(
      apiToken,
      `/accounts/${accountId}/access/apps?page=${page}&per_page=50`,
      { method: "GET" },
    );
    apps.push(...result);
    if (result.length < 50) break;
  }

  return apps;
}

export async function listAccessPolicies(
  apiToken: string,
  accountId: string,
  appId: string,
): Promise<CloudflareAccessPolicy[]> {
  const policies: CloudflareAccessPolicy[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareAccessPolicy[]>(
      apiToken,
      `/accounts/${accountId}/access/apps/${appId}/policies?page=${page}&per_page=50`,
      { method: "GET" },
    );
    policies.push(...result);
    if (result.length < 50) break;
  }

  return policies;
}

export async function getAccessOrganization(
  apiToken: string,
  accountId: string,
): Promise<CloudflareAccessOrganization> {
  return cloudflareApi<CloudflareAccessOrganization>(
    apiToken,
    `/accounts/${accountId}/access/organizations`,
    { method: "GET" },
  );
}

export async function listTunnels(
  apiToken: string,
  accountId: string,
  options: { name?: string } = {},
): Promise<CloudflareTunnel[]> {
  const params = new URLSearchParams({
    is_deleted: "false",
  });
  if (options.name?.trim()) {
    params.set("name", options.name.trim());
  }

  return cloudflareApi<CloudflareTunnel[]>(
    apiToken,
    `/accounts/${accountId}/cfd_tunnel?${params.toString()}`,
    { method: "GET" },
  );
}

export async function createRemoteManagedTunnel(
  apiToken: string,
  accountId: string,
  options: { name: string },
): Promise<CloudflareTunnel> {
  return cloudflareApi<CloudflareTunnel>(
    apiToken,
    `/accounts/${accountId}/cfd_tunnel`,
    {
      method: "POST",
      body: JSON.stringify({
        name: options.name,
        config_src: "cloudflare",
      }),
    },
  );
}

export async function getTunnelToken(
  apiToken: string,
  accountId: string,
  tunnelId: string,
): Promise<string> {
  const result = await cloudflareApi<unknown>(
    apiToken,
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`,
    { method: "GET" },
  );

  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }

  if (result && typeof result === "object") {
    const token = (result as { token?: unknown }).token;
    if (typeof token === "string" && token.trim()) {
      return token.trim();
    }
  }

  throw new Error("Cloudflare did not return a tunnel token.");
}

export async function putTunnelConfiguration(
  apiToken: string,
  accountId: string,
  tunnelId: string,
  options: {
    ingress: Array<{
      hostname?: string;
      service: string;
      originRequest?: Record<string, unknown>;
    }>;
  },
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`,
    {
      method: "PUT",
      body: JSON.stringify({
        config: {
          ingress: options.ingress,
        },
      }),
    },
  );
}

export async function ensureTunnelDnsRecord(
  apiToken: string,
  zoneId: string,
  hostname: string,
  tunnelId: string,
): Promise<void> {
  const target = `${tunnelId}.cfargotunnel.com`;
  const query = new URLSearchParams({
    name: hostname,
    type: "CNAME",
  });
  const existing = await cloudflareApi<CloudflareDnsRecord[]>(
    apiToken,
    `/zones/${zoneId}/dns_records?${query.toString()}`,
    { method: "GET" },
  );

  const body = {
    type: "CNAME",
    proxied: true,
    name: hostname,
    content: target,
  };

  if (existing[0]?.id) {
    await cloudflareApi(
      apiToken,
      `/zones/${zoneId}/dns_records/${existing[0].id}`,
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
    return;
  }

  await cloudflareApi(
    apiToken,
    `/zones/${zoneId}/dns_records`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

async function cloudflareApi<T>(
  apiToken: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const method = init?.method ?? "GET";
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });

  let body: CloudflareEnvelope<T> | null = null;
  try {
    body = await response.json<CloudflareEnvelope<T>>();
  } catch {
    body = null;
  }

  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ")
      || `Cloudflare API request failed: ${response.status}`;
    throw new CloudflareApiError({
      message,
      status: response.status,
      path,
      method,
      errors: body?.errors,
    });
  }

  return body.result;
}

async function listAccessibleZones(apiToken: string): Promise<CloudflareZone[]> {
  const zones: CloudflareZone[] = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi<CloudflareZone[]>(
      apiToken,
      `/zones?per_page=50&page=${page}`,
      { method: "GET" },
    );
    zones.push(...result);
    if (result.length < 50) break;
  }

  return zones;
}

export async function resolveAccountForHostname(
  apiToken: string,
  hostnameInput: string,
): Promise<{ hostname: string; accountId: string; zoneId: string; zoneName: string }> {
  const hostname = normalizeCustomDomainHostname(hostnameInput);
  const zones = await listAccessibleZones(apiToken);
  const zone = findBestMatchingZone(hostname, zones);
  if (!zone) {
    throw new Error("No accessible Cloudflare zone matched that hostname");
  }

  const accountId = zone.account?.id?.trim();
  if (!accountId) {
    throw new Error("Could not determine the Cloudflare account for that zone");
  }

  return {
    hostname,
    accountId,
    zoneId: zone.id,
    zoneName: zone.name,
  };
}

export async function createAccessApp(
  apiToken: string,
  accountId: string,
  options: { domain: string; name: string },
): Promise<CloudflareAccessApp> {
  return cloudflareApi<CloudflareAccessApp>(
    apiToken,
    `/accounts/${accountId}/access/apps`,
    {
      method: "POST",
      body: JSON.stringify({
        domain: options.domain,
        type: "self_hosted",
        name: options.name,
        session_duration: MANAGED_ACCESS_SESSION_DURATION,
      }),
    },
  );
}

export async function deleteAccessApp(
  apiToken: string,
  accountId: string,
  appId: string,
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/access/apps/${appId}`,
    {
      method: "DELETE",
    },
  );
}

export async function createAccessEmailPolicy(
  apiToken: string,
  accountId: string,
  appId: string,
  options: { name: string; emails: string[]; precedence: number },
): Promise<CloudflareAccessPolicy> {
  return cloudflareApi<CloudflareAccessPolicy>(
    apiToken,
    `/accounts/${accountId}/access/apps/${appId}/policies`,
    {
      method: "POST",
      body: JSON.stringify({
        name: options.name,
        decision: "allow",
        precedence: options.precedence,
        include: options.emails.map((email) => ({
          email: { email },
        })),
        session_duration: MANAGED_ACCESS_SESSION_DURATION,
      }),
    },
  );
}

export async function updateAccessEmailPolicy(
  apiToken: string,
  accountId: string,
  appId: string,
  policyId: string,
  options: { name: string; emails: string[]; precedence: number },
): Promise<CloudflareAccessPolicy> {
  return cloudflareApi<CloudflareAccessPolicy>(
    apiToken,
    `/accounts/${accountId}/access/apps/${appId}/policies/${policyId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: options.name,
        decision: "allow",
        precedence: options.precedence,
        include: options.emails.map((email) => ({
          email: { email },
        })),
        session_duration: MANAGED_ACCESS_SESSION_DURATION,
      }),
    },
  );
}

export async function deleteAccessPolicy(
  apiToken: string,
  accountId: string,
  appId: string,
  policyId: string,
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/access/apps/${appId}/policies/${policyId}`,
    {
      method: "DELETE",
    },
  );
}

export async function createServiceToken(
  apiToken: string,
  accountId: string,
  options: { name: string },
): Promise<CloudflareServiceToken> {
  return cloudflareApi<CloudflareServiceToken>(
    apiToken,
    `/accounts/${accountId}/access/service_tokens`,
    {
      method: "POST",
      body: JSON.stringify({
        name: options.name,
        duration: MANAGED_ACCESS_SERVICE_TOKEN_DURATION,
      }),
    },
  );
}

export async function deleteServiceToken(
  apiToken: string,
  accountId: string,
  tokenId: string,
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/access/service_tokens/${tokenId}`,
    {
      method: "DELETE",
    },
  );
}

export async function createAccessServiceTokenPolicy(
  apiToken: string,
  accountId: string,
  appId: string,
  options: { name: string; tokenId: string; precedence: number },
): Promise<CloudflareAccessPolicy> {
  return cloudflareApi<CloudflareAccessPolicy>(
    apiToken,
    `/accounts/${accountId}/access/apps/${appId}/policies`,
    {
      method: "POST",
      body: JSON.stringify({
        name: options.name,
        // "Service Auth" in the dashboard maps to the non-identity policy decision in the API.
        decision: "non_identity",
        precedence: options.precedence,
        include: [
          {
            service_token: { token_id: options.tokenId },
          },
        ],
        session_duration: MANAGED_ACCESS_SESSION_DURATION,
      }),
    },
  );
}
