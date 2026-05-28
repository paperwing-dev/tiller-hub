import type { Env } from "../types";
import { CloudflareApiError } from "../cloudflare-errors";
import { getLocationHintOptions } from "../helpers";
import { getSecret } from "./config";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const HOSTNAME_PATTERN = /^(?=.{1,253}$)(?!-)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

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

interface CloudflareWorkerDomain {
  id: string;
  hostname: string;
  service: string;
  zone_id: string;
  zone_name: string;
}

interface CloudflareSubdomainStatus {
  enabled: boolean;
  previews_enabled: boolean;
}

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

export function normalizeCustomDomainHostname(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Custom domain is required");
  }

  const candidate = trimmed.includes("://") ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("Enter a valid hostname, for example `tiller.example.com`");
  }

  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash || url.port) {
    throw new Error("Enter only the hostname, without path, query, fragment, credentials, or port");
  }

  const hostname = url.hostname.toLowerCase();
  if (!HOSTNAME_PATTERN.test(hostname)) {
    throw new Error("Enter a valid hostname, for example `tiller.example.com`");
  }
  if (hostname.endsWith(".workers.dev")) {
    throw new Error("Use your own domain hostname here, not a `workers.dev` URL");
  }

  return hostname;
}

export function resolveWorkerServiceNameFromHostname(hostname: string): string | null {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized.endsWith(".workers.dev")) return null;

  const firstLabel = normalized.split(".")[0]?.trim();
  return firstLabel || null;
}

export function findBestMatchingZone(
  hostname: string,
  zones: CloudflareZone[],
): CloudflareZone | null {
  const normalized = hostname.toLowerCase();
  let bestMatch: CloudflareZone | null = null;

  for (const zone of zones) {
    const zoneName = zone.name.toLowerCase();
    if (normalized !== zoneName && !normalized.endsWith(`.${zoneName}`)) {
      continue;
    }

    if (!bestMatch || zoneName.length > bestMatch.name.length) {
      bestMatch = zone;
    }
  }

  return bestMatch;
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

async function listWorkerDomains(
  apiToken: string,
  accountId: string,
): Promise<CloudflareWorkerDomain[]> {
  return cloudflareApi<CloudflareWorkerDomain[]>(
    apiToken,
    `/accounts/${accountId}/workers/domains`,
    { method: "GET" },
  );
}

export async function verifyWorkerDomainAccess(
  apiToken: string,
  accountId: string,
): Promise<void> {
  await listWorkerDomains(apiToken, accountId);
}

async function attachWorkerDomain(
  apiToken: string,
  accountId: string,
  serviceName: string,
  hostname: string,
): Promise<CloudflareWorkerDomain> {
  return cloudflareApi<CloudflareWorkerDomain>(
    apiToken,
    `/accounts/${accountId}/workers/domains`,
    {
      method: "PUT",
      body: JSON.stringify({
        hostname,
        service: serviceName,
      }),
    },
  );
}

async function deleteWorkerDomain(
  apiToken: string,
  accountId: string,
  domainId: string,
): Promise<void> {
  await cloudflareApi(
    apiToken,
    `/accounts/${accountId}/workers/domains/${domainId}`,
    {
      method: "DELETE",
    },
  );
}

async function disableWorkerSubdomain(
  apiToken: string,
  accountId: string,
  serviceName: string,
): Promise<CloudflareSubdomainStatus> {
  return cloudflareApi<CloudflareSubdomainStatus>(
    apiToken,
    `/accounts/${accountId}/workers/scripts/${serviceName}/subdomain`,
    {
      method: "DELETE",
    },
  );
}

async function resolveStoredWorkerServiceName(env: Env): Promise<string | null> {
  const stored = (await getSecret(env, "WORKER_SERVICE_NAME"))?.trim();
  return stored || null;
}

export async function resolveWorkerServiceName(
  env: Env,
  requestUrl: string,
): Promise<string | null> {
  const currentHost = new URL(requestUrl).hostname;
  return resolveWorkerServiceNameFromHostname(currentHost) ?? await resolveStoredWorkerServiceName(env);
}

export interface ConnectedCustomDomain {
  hostname: string;
  hubUrl: string;
  service: string;
  zoneName: string;
}

export interface EnsuredCustomDomain extends ConnectedCustomDomain {
  accountId: string;
  zoneId: string;
  domainId: string;
  attachedNow: boolean;
}

export interface DisabledWorkerSubdomain {
  workersDevEnabled: boolean;
  previewsEnabled: boolean;
}

export async function ensureWorkerCustomDomain(
  env: Env,
  requestUrl: string,
  apiToken: string,
  hostnameInput: string,
): Promise<EnsuredCustomDomain> {
  const token = apiToken.trim();
  if (!token) {
    throw new Error("Cloudflare API token is required");
  }

  const hostname = normalizeCustomDomainHostname(hostnameInput);
  const serviceName = await resolveWorkerServiceName(env, requestUrl);
  if (!serviceName) {
    throw new Error("Could not determine the Worker service name. Retry from the `workers.dev` deployment URL.");
  }

  const zones = await listAccessibleZones(token);
  const zone = findBestMatchingZone(hostname, zones);
  if (!zone) {
    throw new Error("No accessible Cloudflare zone matched that hostname");
  }

  const accountId = zone.account?.id?.trim();
  if (!accountId) {
    throw new Error("Could not determine the Cloudflare account for that zone");
  }

  const existingDomains = await listWorkerDomains(token, accountId);
  const existingDomain = existingDomains.find((domain) => domain.hostname.toLowerCase() === hostname);
  let attachedDomain = existingDomain;
  let attachedNow = false;

  if (!existingDomain || existingDomain.service !== serviceName) {
    attachedDomain = await attachWorkerDomain(token, accountId, serviceName, hostname);
    attachedNow = true;
  }
  if (!attachedDomain) {
    throw new Error(`Cloudflare did not return a Worker domain for ${hostname}`);
  }

  return {
    hostname,
    hubUrl: trimTrailingSlashes(`https://${hostname}`),
    service: serviceName,
    zoneName: zone.name,
    accountId,
    zoneId: zone.id,
    domainId: attachedDomain.id,
    attachedNow,
  };
}

export async function disableWorkerDevAlias(
  apiToken: string,
  accountId: string,
  serviceName: string,
): Promise<DisabledWorkerSubdomain> {
  const result = await disableWorkerSubdomain(apiToken.trim(), accountId, serviceName);
  return {
    workersDevEnabled: Boolean(result.enabled),
    previewsEnabled: Boolean(result.previews_enabled),
  };
}

export async function detachWorkerCustomDomain(
  apiToken: string,
  accountId: string,
  domainId: string,
): Promise<void> {
  await deleteWorkerDomain(apiToken.trim(), accountId, domainId);
}

export async function connectWorkerCustomDomain(
  env: Env,
  requestUrl: string,
  apiToken: string,
  hostnameInput: string,
): Promise<ConnectedCustomDomain> {
  const connected = await ensureWorkerCustomDomain(env, requestUrl, apiToken, hostnameInput);
  const hub = env.HUB.get(env.HUB.idFromName("hub"), getLocationHintOptions(env)) as unknown as {
    setConfig(key: string, value: string): void;
  };
  await hub.setConfig("HUB_PUBLIC_URL", connected.hubUrl);
  await hub.setConfig("WORKER_SERVICE_NAME", connected.service);

  return {
    hostname: connected.hostname,
    hubUrl: connected.hubUrl,
    service: connected.service,
    zoneName: connected.zoneName,
  };
}
