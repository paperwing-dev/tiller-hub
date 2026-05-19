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

export interface CloudflareTunnel {
  id: string;
  name: string;
  token?: string | null;
}

interface CloudflareDnsRecord {
  id: string;
  type?: string | null;
  name?: string | null;
  content?: string | null;
  proxied?: boolean | null;
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
