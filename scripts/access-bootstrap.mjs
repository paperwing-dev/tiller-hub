import { Resolver } from "node:dns/promises";
import https from "node:https";

const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";
const PUBLIC_DNS_SERVERS = ["1.1.1.1", "8.8.8.8"];

export class ScriptCloudflareApiError extends Error {
  constructor({ message, status, path, method }) {
    super(message);
    this.name = "ScriptCloudflareApiError";
    this.status = status;
    this.path = path;
    this.method = method;
  }
}

function normalizeDomain(value) {
  return value?.trim().toLowerCase() ?? "";
}

function wildcardCoversHost(pattern, hostname) {
  const normalizedPattern = normalizeDomain(pattern);
  if (!normalizedPattern.startsWith("*.")) return false;
  const suffix = normalizedPattern.slice(2);
  return hostname.endsWith(`.${suffix}`);
}

function hostnameMatchesZone(hostname, zoneName) {
  const normalizedHost = normalizeDomain(hostname);
  const normalizedZone = normalizeDomain(zoneName);
  return normalizedHost === normalizedZone || normalizedHost.endsWith(`.${normalizedZone}`);
}

function findBestMatchingZone(hostname, zones) {
  const normalizedHost = normalizeDomain(hostname);
  let bestMatch = null;

  for (const zone of zones) {
    if (!hostnameMatchesZone(normalizedHost, zone.name)) continue;
    if (!bestMatch || normalizeDomain(zone.name).length > normalizeDomain(bestMatch.name).length) {
      bestMatch = zone;
    }
  }

  return bestMatch;
}

async function cloudflareApi(apiToken, path, init = {}, fetchImpl = fetch) {
  const method = init.method ?? "GET";
  const response = await fetchImpl(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const message = body?.errors?.map((error) => error.message).filter(Boolean).join("; ")
      || `Cloudflare API request failed: ${response.status}`;
    throw new ScriptCloudflareApiError({
      message,
      status: response.status,
      path,
      method,
    });
  }

  return body.result;
}

async function listAccessibleZones(apiToken, fetchImpl = fetch) {
  const zones = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi(
      apiToken,
      `/zones?per_page=50&page=${page}`,
      { method: "GET" },
      fetchImpl,
    );
    zones.push(...result);
    if (result.length < 50) break;
  }

  return zones;
}

export async function resolveAccountForHostname(apiToken, hostname, fetchImpl = fetch) {
  const zones = await listAccessibleZones(apiToken, fetchImpl);
  const zone = findBestMatchingZone(hostname, zones);
  if (!zone) {
    throw new Error("No accessible Cloudflare zone matched that hostname.");
  }

  const accountId = zone.account?.id?.trim();
  if (!accountId) {
    throw new Error("Could not determine the Cloudflare account for that hostname.");
  }

  return { accountId, zoneName: zone.name };
}

async function listAccessApps(apiToken, accountId, fetchImpl = fetch) {
  const apps = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi(
      apiToken,
      `/accounts/${accountId}/access/apps?page=${page}&per_page=50`,
      { method: "GET" },
      fetchImpl,
    );
    apps.push(...result);
    if (result.length < 50) break;
  }

  return apps;
}

function findExactAndWildcardApps(hostnameInput, apps) {
  const hostname = normalizeDomain(hostnameInput);
  let exactApp = null;
  let overlappingWildcardApp = null;

  for (const app of apps) {
    const domain = normalizeDomain(app.domain);
    if (!domain) continue;

    if (domain === hostname) {
      exactApp = app;
      continue;
    }

    if (!wildcardCoversHost(domain, hostname)) continue;

    if (!overlappingWildcardApp || domain.length > normalizeDomain(overlappingWildcardApp.domain).length) {
      overlappingWildcardApp = app;
    }
  }

  return { exactApp, overlappingWildcardApp };
}

async function listServiceTokens(apiToken, accountId, fetchImpl = fetch) {
  const tokens = [];

  for (let page = 1; page <= 10; page += 1) {
    const result = await cloudflareApi(
      apiToken,
      `/accounts/${accountId}/access/service_tokens?page=${page}&per_page=50`,
      { method: "GET" },
      fetchImpl,
    );
    tokens.push(...result);
    if (result.length < 50) break;
  }

  return tokens;
}

function buildTokenTemplateHelp(hostname) {
  return `Create a Cloudflare API token from the "Edit Cloudflare Workers" template, then add rows with Scope Account, Permission Access: Apps and Policies, Access Edit; and Scope Account, Permission Access: Service Tokens, Access. Scope it to the account and zone that own ${hostname}.`;
}

function buildWildcardUnsupportedMessage(hostnameInput, wildcardDomainInput) {
  const hostname = normalizeDomain(hostnameInput);
  const wildcardDomain = normalizeDomain(wildcardDomainInput);
  return `The requested hostname ${hostname} is already protected by the existing Cloudflare Access wildcard app ${wildcardDomain}. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside ${wildcardDomain}, or update Cloudflare Access so Tiller can own ${hostname} directly.`;
}

function extractWildcardUnsupportedDetails(message, fallbackHostname = "") {
  const match = message.match(
    /requested hostname (?<hostname>\S+) is already protected by the existing Cloudflare Access wildcard app (?<wildcard>\S+)\./i,
  );
  if (match?.groups?.wildcard) {
    return {
      hostname: normalizeDomain(match.groups.hostname || fallbackHostname),
      wildcardDomain: normalizeDomain(match.groups.wildcard),
    };
  }

  const legacyMatch = message.match(/wildcard Cloudflare Access app (?<wildcard>\S+)/i);
  if (!legacyMatch?.groups?.wildcard) return null;

  return {
    hostname: normalizeDomain(fallbackHostname),
    wildcardDomain: normalizeDomain(legacyMatch.groups.wildcard),
  };
}

export function normalizeScriptCloudflareError(error, hostname) {
  if (
    error instanceof Error
    && /already (?:covered by the wildcard Cloudflare Access app|protected by the existing Cloudflare Access wildcard app)/i.test(error.message)
  ) {
    const details = extractWildcardUnsupportedDetails(error.message, hostname);
    if (details?.hostname && details?.wildcardDomain) {
      return buildWildcardUnsupportedMessage(details.hostname, details.wildcardDomain);
    }
    return error.message;
  }

  if (!(error instanceof ScriptCloudflareApiError)) {
    return error instanceof Error ? error.message : String(error);
  }

  const target = hostname ? ` for ${hostname}` : "";

  if ((error.status === 401 || error.status === 403) && error.path.startsWith("/zones")) {
    return `Cloudflare rejected the API token while reading zones${target}. The token needs a row with Scope Zone, Permission Zone, Access Read on the target zone. ${buildTokenTemplateHelp(hostname)}`;
  }

  if ((error.status === 401 || error.status === 403) && error.path.includes("/access/apps")) {
    return `Cloudflare rejected the API token while managing Access apps or policies${target}. The token needs a row with Scope Account, Permission Access: Apps and Policies, Access Edit. ${buildTokenTemplateHelp(hostname)}`;
  }

  if ((error.status === 401 || error.status === 403) && error.path.includes("/access/service_tokens")) {
    return `Cloudflare rejected the API token while managing Access service tokens${target}. The token needs a row with Scope Account, Permission Access: Service Tokens, Access Edit. If that permission is not visible in the dashboard, create the token from an account role that can manage Zero Trust service tokens.`;
  }

  if ((error.status === 401 || error.status === 403) && error.path.includes("/workers/")) {
    return `Cloudflare rejected the API token while managing the Worker domain${target}. The token needs rows with Scope Account, Permission Workers Scripts, Access Edit and Scope Zone, Permission Workers Routes, Access Edit. ${buildTokenTemplateHelp(hostname)}`;
  }

  return error.message;
}

export async function verifyBootstrapAccess(apiToken, hostname, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const { accountId, zoneName } = await resolveAccountForHostname(apiToken, hostname, fetchImpl);
  const apps = await listAccessApps(apiToken, accountId, fetchImpl);
  await listServiceTokens(apiToken, accountId, fetchImpl);
  const coverage = findExactAndWildcardApps(hostname, apps);
  if (coverage.overlappingWildcardApp?.domain) {
    throw new Error(buildWildcardUnsupportedMessage(hostname, coverage.overlappingWildcardApp.domain));
  }
  return {
    accountId,
    zoneName,
    exactAppExists: Boolean(coverage.exactApp),
  };
}

function extractErrorText(error) {
  if (error instanceof Error) {
    const cause = error.cause;
    const causeMessage =
      typeof cause === "object" && cause && "message" in cause && typeof cause.message === "string"
        ? cause.message
        : "";
    const causeCode =
      typeof cause === "object" && cause && "code" in cause && typeof cause.code === "string"
        ? cause.code
        : "";
    return [error.message, causeMessage, causeCode].filter(Boolean).join(" ");
  }

  return String(error);
}

function isDnsResolutionFailure(error) {
  return /enotfound|getaddrinfo|could not resolve/i.test(extractErrorText(error));
}

async function resolveViaPublicDns(hostname) {
  const resolver = new Resolver();
  resolver.setServers(PUBLIC_DNS_SERVERS);

  const ipv4Addresses = new Set();
  try {
    const results = await resolver.resolve(hostname, "A");
    for (const result of results) {
      if (typeof result === "string" && result) {
        ipv4Addresses.add(result);
      }
    }
  } catch {
    // Best effort: fall through to AAAA if A records are unavailable.
  }

  if (ipv4Addresses.size > 0) {
    return [...ipv4Addresses];
  }

  const ipv6Addresses = new Set();
  try {
    const results = await resolver.resolve(hostname, "AAAA");
    for (const result of results) {
      if (typeof result === "string" && result) {
        ipv6Addresses.add(result);
      }
    }
  } catch {
    // No public records available.
  }

  return [...ipv6Addresses];
}

function classifyAvailabilityStatus(status) {
  if (status === 200) return "reachable";
  if (status === 301 || status === 302 || status === 307 || status === 308 || status === 401 || status === 403) {
    return "protected";
  }
  return null;
}

async function probeViaResolvedAddress(hubUrl, headers, address) {
  const target = new URL(`${hubUrl.replace(/\/+$/, "")}/health`);
  const family = address.includes(":") ? 6 : 4;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: "GET",
      headers,
      servername: target.hostname,
      lookup(_hostname, options, callback) {
        if (options?.all) {
          callback(null, [{ address, family }]);
          return;
        }
        callback(null, address, family);
      },
      },
      (res) => {
        res.resume();
        resolve({
          status: res.statusCode ?? 0,
          location: typeof res.headers.location === "string" ? res.headers.location : null,
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Timed out probing ${target.hostname} via ${address}`));
    });
    req.end();
  });
}

async function fetchViaResolvedAddress(urlInput, init, address) {
  const target = new URL(urlInput);
  const family = address.includes(":") ? 6 : 4;
  const headers = init?.headers ?? {};
  const method = init?.method ?? "GET";
  const body = init?.body;

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        method,
        headers,
        servername: target.hostname,
        lookup(_hostname, options, callback) {
          if (options?.all) {
            callback(null, [{ address, family }]);
            return;
          }
          callback(null, address, family);
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) {
              responseHeaders.set(key, value.join(", "));
            } else if (typeof value === "string") {
              responseHeaders.set(key, value);
            }
          }
          resolve(
            new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 0,
              headers: responseHeaders,
            }),
          );
        });
      },
    );

    req.on("error", reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error(`Timed out requesting ${target.hostname} via ${address}`));
    });

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

export async function waitForHubAvailability(
  hubUrl,
  headers = {},
  options = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const attempts = options.attempts ?? 60;
  const delayMs = options.delayMs ?? 5_000;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const onRetry = options.onRetry ?? null;
  const resolveViaPublicDnsImpl = options.resolveViaPublicDnsImpl ?? resolveViaPublicDns;
  const probeViaResolvedAddressImpl = options.probeViaResolvedAddressImpl ?? probeViaResolvedAddress;
  const hostname = new URL(hubUrl).hostname;
  let lastError = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetchImpl(`${hubUrl.replace(/\/+$/, "")}/health`, {
        headers,
        redirect: "manual",
      });
      const classified = classifyAvailabilityStatus(res.status);
      if (classified) {
        return classified;
      }
      lastError = new Error(`Hub health check returned ${res.status}`);
    } catch (error) {
      if (isDnsResolutionFailure(error)) {
        const publicAddresses = await resolveViaPublicDnsImpl(hostname).catch(() => []);
        if (publicAddresses.length === 0) {
          lastError = new Error(`DNS for ${hostname} is not resolvable on public DNS yet.`);
        } else {
          let probedState = null;
          let lastProbeError = null;
          for (const address of publicAddresses) {
            try {
              const result = await probeViaResolvedAddressImpl(hubUrl, headers, address);
              probedState = classifyAvailabilityStatus(result.status);
              if (probedState) {
                return probedState;
              }
              lastProbeError = new Error(`Edge probe via ${address} returned ${result.status}`);
            } catch (probeError) {
              lastProbeError = probeError;
            }
          }

          lastError = new Error(
            `Public DNS for ${hostname} is live (${publicAddresses.join(", ")}), but edge probes are not ready yet${lastProbeError ? `: ${extractErrorText(lastProbeError)}` : "."}`,
          );
        }
      } else if (/econnrefused/i.test(extractErrorText(error))) {
        lastError = new Error("The custom domain resolved, but refused the connection.");
      } else {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }

    if (attempt < attempts - 1) {
      if (onRetry) {
        onRetry({
          attempt: attempt + 1,
          attempts,
          message: lastError?.message ?? "Waiting for the custom domain to become reachable.",
        });
      }
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error("Timed out waiting for the deployed hub to become reachable.");
}

export async function probeHubState(hubUrl, headers = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;

  try {
    const res = await fetchImpl(`${hubUrl.replace(/\/+$/, "")}/health`, {
      headers,
      redirect: "manual",
    });

    if (res.ok) return "reachable";
    if (res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308 || res.status === 401 || res.status === 403) {
      return "protected";
    }
    return "reachable";
  } catch {
    return "missing";
  }
}

export async function ensureProtectedCustomDomain(
  hubUrl,
  {
    apiToken,
    emails,
  },
  options = {},
) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolveViaPublicDnsImpl = options.resolveViaPublicDnsImpl ?? resolveViaPublicDns;
  const fetchViaResolvedAddressImpl = options.fetchViaResolvedAddressImpl ?? fetchViaResolvedAddress;
  const requestUrl = `${hubUrl.replace(/\/+$/, "")}/api/access/setup`;
  const requestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    redirect: "manual",
    body: JSON.stringify({
      apiToken,
      emails,
    }),
  };
  let response;

  try {
    response = await fetchImpl(requestUrl, requestInit);
  } catch (error) {
    if (!isDnsResolutionFailure(error)) {
      throw error;
    }

    const publicAddresses = await resolveViaPublicDnsImpl(new URL(hubUrl).hostname).catch(() => []);
    if (publicAddresses.length === 0) {
      throw error;
    }

    let lastError = error;
    for (const address of publicAddresses) {
      try {
        response = await fetchViaResolvedAddressImpl(requestUrl, requestInit, address);
        break;
      } catch (resolvedError) {
        lastError = resolvedError;
      }
    }

    if (!response) {
      throw lastError;
    }
  }

  const body = await response.json().catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) {
    throw new Error(body.error || `Cloudflare Access setup failed: ${response.status}`);
  }

  return body;
}
