import type { Env } from "../types";
import { getLocationHintOptions } from "../helpers";
import { getSecret, invalidateConfigCache } from "../setup/config";
import {
  type CloudflareAccessApp,
  type CloudflareAccessPolicy,
  type CloudflareServiceToken,
  createAccessApp,
  createAccessEmailPolicy,
  createAccessServiceTokenPolicy,
  createRemoteManagedTunnel,
  createServiceToken,
  deleteAccessApp,
  deleteAccessPolicy,
  deleteServiceToken,
  ensureTunnelDnsRecord,
  getTunnelToken,
  listAccessApps,
  listAccessPolicies,
  listTunnels,
  putTunnelConfiguration,
} from "./cloudflare-api";

const MANAGED_BROWSER_POLICY_NAME = "Allow hub users";
const MANAGED_SERVICE_TOKEN_POLICY_NAME = "Allow hub service token";
const MANAGED_BROWSER_POLICY_PRECEDENCE = 100;
const MANAGED_SERVICE_TOKEN_POLICY_PRECEDENCE = 200;
const MANAGED_GATEWAY_TUNNEL_NAME = "tiller-gateway";
const MANAGED_GATEWAY_TUNNEL_TARGET_PORT = 8788;
const MANAGED_ACCESS_CONFIG_KEYS = [
  "CF_ACCESS_APP_ID",
  "CF_ACCESS_AUD",
  "CF_ACCESS_APP_DOMAIN",
  "CF_ACCESS_APP_TYPE",
  "CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN",
  "CF_ACCESS_CLIENT_ID",
  "CF_ACCESS_CLIENT_SECRET",
  "CF_ACCESS_BROWSER_POLICY_ID",
  "CF_ACCESS_SERVICE_TOKEN_ID",
  "CF_ACCESS_SERVICE_TOKEN_POLICY_ID",
  "TILLER_GATEWAY_HOSTNAME",
  "CF_ACCESS_GATEWAY_APP_ID",
  "CF_ACCESS_GATEWAY_APP_DOMAIN",
  "CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID",
  "TILLER_GATEWAY_TUNNEL_ID",
  "TILLER_GATEWAY_TUNNEL_NAME",
  "TILLER_GATEWAY_TUNNEL_TOKEN",
  "TILLER_GATEWAY_TUNNEL_TARGET_PORT",
] as const;

function managedServiceConfig(): {
  label: string;
  hostnameKey: string;
  appIdKey: string;
  appDomainKey: string;
  policyIdKey: string;
} {
  return {
    label: "Gateway",
    hostnameKey: "TILLER_GATEWAY_HOSTNAME",
    appIdKey: "CF_ACCESS_GATEWAY_APP_ID",
    appDomainKey: "CF_ACCESS_GATEWAY_APP_DOMAIN",
    policyIdKey: "CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID",
  };
}

function normalizeDomain(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function wildcardCoversHost(pattern: string, hostname: string): boolean {
  const normalizedPattern = normalizeDomain(pattern);
  if (!normalizedPattern.startsWith("*.")) return false;
  const suffix = normalizedPattern.slice(2);
  return hostname.endsWith(`.${suffix}`);
}

function readConfigId(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export interface AccessCoverage {
  exactApp: CloudflareAccessApp | null;
  overlappingWildcardApp: CloudflareAccessApp | null;
}

export interface PreparedManagedAccess {
  accountId: string;
  hostname: string;
  app: CloudflareAccessApp;
  appDomain: string;
  browserPolicy: CloudflareAccessPolicy | null;
  serviceToken: CloudflareServiceToken;
  serviceTokenPolicy: CloudflareAccessPolicy;
  previousAppId: string | null;
  previousBrowserPolicyId: string | null;
  previousServiceTokenId: string | null;
  previousServiceTokenPolicyId: string | null;
  cleanupDraftResources(): Promise<void>;
}

export interface PreparedManagedServiceHostAccess {
  accountId: string;
  hostname: string;
  app: CloudflareAccessApp;
  appDomain: string;
  browserPolicy: null;
  serviceToken: null;
  serviceTokenPolicy: CloudflareAccessPolicy;
  previousAppId: string | null;
  previousBrowserPolicyId: null;
  previousServiceTokenId: null;
  previousServiceTokenPolicyId: string | null;
  cleanupDraftResources(): Promise<void>;
}

export interface PersistedAccessConfig {
  appId: string;
  appAud: string;
  appDomain: string;
  clientId: string;
  clientSecret: string;
  browserPolicyId: string | null;
  serviceTokenId: string;
  serviceTokenPolicyId: string;
}

export interface PersistedManagedServiceHostAccessConfig {
  hostname: string;
  appId: string;
  appDomain: string;
  serviceTokenPolicyId: string;
  tunnelId: string;
  tunnelName: string;
  tunnelToken: string;
  tunnelTargetPort: number;
}

export interface ProvisionedManagedServiceHosts {
  gateway: PreparedManagedServiceHostAccess;
}

export function buildWildcardUnsupportedMessage(hostnameInput: string, wildcardDomainInput: string): string {
  const hostname = normalizeDomain(hostnameInput);
  const wildcardDomain = normalizeDomain(wildcardDomainInput);
  return `The requested hostname ${hostname} is already protected by the existing Cloudflare Access wildcard app ${wildcardDomain}. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside ${wildcardDomain}, or update Cloudflare Access so Tiller can own ${hostname} directly.`;
}

export function findExactAndWildcardApps(
  hostnameInput: string,
  apps: CloudflareAccessApp[],
): AccessCoverage {
  const hostname = normalizeDomain(hostnameInput);
  let exactApp: CloudflareAccessApp | null = null;
  let overlappingWildcardApp: CloudflareAccessApp | null = null;

  for (const app of apps) {
    const domain = normalizeDomain(app.domain);
    if (!domain) continue;

    if (domain === hostname) {
      exactApp = app;
      continue;
    }

    if (!wildcardCoversHost(domain, hostname)) continue;

    if (!overlappingWildcardApp) {
      overlappingWildcardApp = app;
      continue;
    }

    const currentLength = normalizeDomain(overlappingWildcardApp.domain).length;
    if (domain.length > currentLength) {
      overlappingWildcardApp = app;
    }
  }

  return { exactApp, overlappingWildcardApp };
}

export async function resolveAccessCoverage(
  apiToken: string,
  accountId: string,
  hostname: string,
): Promise<AccessCoverage> {
  const apps = await listAccessApps(apiToken, accountId);
  return findExactAndWildcardApps(hostname, apps);
}

export function assertNoUnsupportedWildcardCoverage(
  hostnameInput: string,
  coverage: AccessCoverage,
): void {
  const wildcardDomain = coverage.overlappingWildcardApp?.domain?.trim();
  if (!wildcardDomain) return;
  throw new Error(buildWildcardUnsupportedMessage(hostnameInput, wildcardDomain));
}

export function allocateAccessPolicyPrecedence(
  policies: Array<Pick<CloudflareAccessPolicy, "precedence">>,
  preferredPrecedence: number,
): number {
  const used = new Set<number>();
  for (const policy of policies) {
    const precedence = typeof policy.precedence === "string"
      ? Number.parseInt(policy.precedence, 10)
      : policy.precedence;
    if (typeof precedence === "number" && Number.isFinite(precedence)) {
      used.add(precedence);
    }
  }

  let next = preferredPrecedence;
  while (used.has(next)) {
    next += 1;
  }
  return next;
}

export async function prepareManagedExactHostAccess(
  env: Env,
  options: {
    apiToken: string;
    accountId: string;
    hostname: string;
    emails: string[];
    reuseExistingServiceToken?: boolean;
  },
): Promise<PreparedManagedAccess> {
  const hostname = normalizeDomain(options.hostname);
  const coverage = await resolveAccessCoverage(
    options.apiToken,
    options.accountId,
    hostname,
  );
  assertNoUnsupportedWildcardCoverage(hostname, coverage);
  const { exactApp } = coverage;

  if (!exactApp && options.emails.length === 0) {
    throw new Error("At least one email address is required the first time Tiller creates an exact-host Access app.");
  }

  const app = exactApp ?? await createAccessApp(options.apiToken, options.accountId, {
    domain: hostname,
    name: `Tiller Hub (${hostname})`,
  });
  if (!app.id || !app.aud) {
    throw new Error("Cloudflare did not return the exact-host Access application identifiers.");
  }

  const previousAppId = readConfigId(await getSecret(env, "CF_ACCESS_APP_ID"));
  const previousBrowserPolicyId = readConfigId(await getSecret(env, "CF_ACCESS_BROWSER_POLICY_ID"));
  const previousServiceTokenId = readConfigId(await getSecret(env, "CF_ACCESS_SERVICE_TOKEN_ID"));
  const previousServiceTokenPolicyId = readConfigId(await getSecret(env, "CF_ACCESS_SERVICE_TOKEN_POLICY_ID"));
  const previousClientId = readConfigId(await getSecret(env, "CF_ACCESS_CLIENT_ID"));
  const previousClientSecret = readConfigId(await getSecret(env, "CF_ACCESS_CLIENT_SECRET"));
  const existingPolicies = exactApp ? await listAccessPolicies(options.apiToken, options.accountId, app.id) : [];
  const reservedBrowserPolicyPrecedence = options.emails.length > 0
    ? allocateAccessPolicyPrecedence(existingPolicies, MANAGED_BROWSER_POLICY_PRECEDENCE)
    : null;
  const reservedServiceTokenPolicyPrecedence = allocateAccessPolicyPrecedence(
    [
      ...existingPolicies,
      ...(reservedBrowserPolicyPrecedence == null ? [] : [{ precedence: reservedBrowserPolicyPrecedence }]),
    ],
    MANAGED_SERVICE_TOKEN_POLICY_PRECEDENCE,
  );

  let browserPolicy: CloudflareAccessPolicy | null = null;
  let serviceToken: CloudflareServiceToken | null = null;
  let serviceTokenPolicy: CloudflareAccessPolicy | null = null;
  const reusedExistingServiceToken = Boolean(
    options.reuseExistingServiceToken
      && previousServiceTokenId
      && previousClientId
      && previousClientSecret,
  );

  const cleanupDraftResources = async () => {
    if (serviceTokenPolicy?.id) {
      await deleteAccessPolicy(options.apiToken, options.accountId, app.id!, serviceTokenPolicy.id).catch(() => {});
    }
    if (serviceToken?.id && !reusedExistingServiceToken) {
      await deleteServiceToken(options.apiToken, options.accountId, serviceToken.id).catch(() => {});
    }
    if (browserPolicy?.id) {
      await deleteAccessPolicy(options.apiToken, options.accountId, app.id!, browserPolicy.id).catch(() => {});
    }
    if (!exactApp) {
      await deleteAccessApp(options.apiToken, options.accountId, app.id!).catch(() => {});
    }
  };

  try {
    if (options.emails.length > 0) {
      browserPolicy = await createAccessEmailPolicy(options.apiToken, options.accountId, app.id, {
        name: MANAGED_BROWSER_POLICY_NAME,
        emails: options.emails,
        precedence: reservedBrowserPolicyPrecedence!,
      });
    }

    if (reusedExistingServiceToken) {
      serviceToken = {
        id: previousServiceTokenId!,
        client_id: previousClientId!,
        client_secret: previousClientSecret!,
      };
    } else {
      serviceToken = await createServiceToken(options.apiToken, options.accountId, {
        name: `Tiller Hub (${hostname}) service token`,
      });
      if (!serviceToken.id || !serviceToken.client_id || !serviceToken.client_secret) {
        throw new Error("Cloudflare did not return complete service token credentials.");
      }
    }

    serviceTokenPolicy = await createAccessServiceTokenPolicy(options.apiToken, options.accountId, app.id, {
      name: MANAGED_SERVICE_TOKEN_POLICY_NAME,
      tokenId: serviceToken.id,
      precedence: reservedServiceTokenPolicyPrecedence,
    });
  } catch (error) {
    await cleanupDraftResources().catch(() => {});
    throw error;
  }

  if (!serviceToken || !serviceTokenPolicy) {
    await cleanupDraftResources().catch(() => {});
    throw new Error("Cloudflare did not complete exact-host Access setup.");
  }

  return {
    accountId: options.accountId,
    hostname,
    app,
    appDomain: hostname,
    browserPolicy,
    serviceToken,
    serviceTokenPolicy,
    previousAppId,
    previousBrowserPolicyId,
    previousServiceTokenId,
    previousServiceTokenPolicyId,
    cleanupDraftResources,
  };
}

export async function prepareManagedServiceHostAccess(
  env: Env,
  options: {
    apiToken: string;
    accountId: string;
    hostname: string | null;
    serviceTokenId: string;
  },
): Promise<PreparedManagedServiceHostAccess> {
  const config = managedServiceConfig();
  const hostname = normalizeDomain(options.hostname);
  if (!hostname) {
    throw new Error("Could not determine the Gateway hostname for this hub.");
  }

  const coverage = await resolveAccessCoverage(options.apiToken, options.accountId, hostname);
  assertNoUnsupportedWildcardCoverage(hostname, coverage);
  const { exactApp } = coverage;

  const app = exactApp ?? await createAccessApp(options.apiToken, options.accountId, {
    domain: hostname,
    name: `Tiller ${config.label} (${hostname})`,
  });
  if (!app.id) {
    throw new Error("Cloudflare did not return the exact-host Access application identifier.");
  }

  const previousAppId = readConfigId(await getSecret(env, config.appIdKey));
  const previousServiceTokenPolicyId = readConfigId(await getSecret(env, config.policyIdKey));
  const existingPolicies = exactApp ? await listAccessPolicies(options.apiToken, options.accountId, app.id) : [];
  const reservedServiceTokenPolicyPrecedence = allocateAccessPolicyPrecedence(
    existingPolicies,
    MANAGED_SERVICE_TOKEN_POLICY_PRECEDENCE,
  );

  let serviceTokenPolicy: CloudflareAccessPolicy | null = null;

  const cleanupDraftResources = async () => {
    if (serviceTokenPolicy?.id) {
      await deleteAccessPolicy(options.apiToken, options.accountId, app.id!, serviceTokenPolicy.id).catch(() => {});
    }
    if (!exactApp) {
      await deleteAccessApp(options.apiToken, options.accountId, app.id!).catch(() => {});
    }
  };

  try {
    serviceTokenPolicy = await createAccessServiceTokenPolicy(options.apiToken, options.accountId, app.id, {
      name: MANAGED_SERVICE_TOKEN_POLICY_NAME,
      tokenId: options.serviceTokenId,
      precedence: reservedServiceTokenPolicyPrecedence,
    });
  } catch (error) {
    await cleanupDraftResources().catch(() => {});
    throw error;
  }

  if (!serviceTokenPolicy) {
    await cleanupDraftResources().catch(() => {});
    throw new Error("Cloudflare did not complete exact-host Access setup.");
  }

  return {
    accountId: options.accountId,
    hostname,
    app,
    appDomain: hostname,
    browserPolicy: null,
    serviceToken: null,
    serviceTokenPolicy,
    previousAppId,
    previousBrowserPolicyId: null,
    previousServiceTokenId: null,
    previousServiceTokenPolicyId,
    cleanupDraftResources,
  };
}

async function provisionManagedGatewayTunnel(
  env: Env,
  options: {
    apiToken: string;
    accountId: string;
    zoneId: string;
    hostname: string;
  },
): Promise<PersistedManagedServiceHostAccessConfig> {
  const hostname = normalizeDomain(options.hostname);
  if (!hostname) {
    throw new Error("Could not determine the Gateway hostname for this hub.");
  }

  const persistedTunnelId = readConfigId(await getSecret(env, "TILLER_GATEWAY_TUNNEL_ID"));
  const persistedTunnelName =
    readConfigId(await getSecret(env, "TILLER_GATEWAY_TUNNEL_NAME")) ?? MANAGED_GATEWAY_TUNNEL_NAME;
  const persistedTunnelToken = readConfigId(await getSecret(env, "TILLER_GATEWAY_TUNNEL_TOKEN"));

  let tunnelId = persistedTunnelId;
  let tunnelToken = persistedTunnelToken;
  const tunnelName = persistedTunnelName || MANAGED_GATEWAY_TUNNEL_NAME;

  if (!tunnelId) {
    const existing = await listTunnels(options.apiToken, options.accountId, { name: tunnelName });
    const matchedTunnel = existing.find((tunnel) => tunnel.name?.trim() === tunnelName);
    if (matchedTunnel?.id) {
      tunnelId = matchedTunnel.id.trim();
      if (!tunnelToken && typeof matchedTunnel.token === "string" && matchedTunnel.token.trim()) {
        tunnelToken = matchedTunnel.token.trim();
      }
    }
  }

  if (!tunnelId) {
    const created = await createRemoteManagedTunnel(options.apiToken, options.accountId, {
      name: tunnelName,
    });
    tunnelId = created.id?.trim() ?? "";
    tunnelToken = typeof created.token === "string" ? created.token.trim() : "";
  }

  if (!tunnelId) {
    throw new Error("Cloudflare did not return a managed gateway tunnel id.");
  }

  if (!tunnelToken) {
    tunnelToken = await getTunnelToken(options.apiToken, options.accountId, tunnelId);
  }

  await putTunnelConfiguration(options.apiToken, options.accountId, tunnelId, {
    ingress: [
      {
        hostname,
        service: `http://127.0.0.1:${MANAGED_GATEWAY_TUNNEL_TARGET_PORT}`,
        originRequest: {},
      },
      {
        service: "http_status:404",
      },
    ],
  });

  await ensureTunnelDnsRecord(options.apiToken, options.zoneId, hostname, tunnelId);

  return {
    hostname,
    appId: "",
    appDomain: hostname,
    serviceTokenPolicyId: "",
    tunnelId,
    tunnelName,
    tunnelToken,
    tunnelTargetPort: MANAGED_GATEWAY_TUNNEL_TARGET_PORT,
  };
}

async function setHubConfig(env: Env, entries: Record<string, string | null>): Promise<void> {
  const id = env.HUB.idFromName("hub");
  const hub = env.HUB.get(id, getLocationHintOptions(env)) as unknown as {
    setConfig(key: string, value: string): Promise<void> | void;
  };

  for (const [key, value] of Object.entries(entries)) {
    await hub.setConfig(key, value ?? "");
  }
}

export async function persistManagedAccessConfig(
  env: Env,
  values: PersistedAccessConfig,
): Promise<void> {
  await setHubConfig(env, {
    CF_ACCESS_APP_ID: values.appId,
    CF_ACCESS_AUD: values.appAud,
    CF_ACCESS_APP_DOMAIN: values.appDomain,
    CF_ACCESS_APP_TYPE: "",
    CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN: "",
    CF_ACCESS_CLIENT_ID: values.clientId,
    CF_ACCESS_CLIENT_SECRET: values.clientSecret,
    CF_ACCESS_BROWSER_POLICY_ID: values.browserPolicyId,
    CF_ACCESS_SERVICE_TOKEN_ID: values.serviceTokenId,
    CF_ACCESS_SERVICE_TOKEN_POLICY_ID: values.serviceTokenPolicyId,
  });
  invalidateConfigCache();
}

export type ManagedAccessConfigSnapshot = Record<(typeof MANAGED_ACCESS_CONFIG_KEYS)[number], string | null>;

export async function readManagedAccessConfigSnapshot(env: Env): Promise<ManagedAccessConfigSnapshot> {
  const snapshot = {} as ManagedAccessConfigSnapshot;

  for (const key of MANAGED_ACCESS_CONFIG_KEYS) {
    snapshot[key] = readConfigId(await getSecret(env, key));
  }

  return snapshot;
}

export async function restoreManagedAccessConfigSnapshot(
  env: Env,
  snapshot: ManagedAccessConfigSnapshot,
): Promise<void> {
  await setHubConfig(env, snapshot);
  invalidateConfigCache();
}

export async function persistManagedServiceHostAccessConfig(
  env: Env,
  values: {
    gateway: PersistedManagedServiceHostAccessConfig;
  },
): Promise<void> {
  await setHubConfig(env, {
    TILLER_GATEWAY_HOSTNAME: values.gateway.hostname,
    CF_ACCESS_GATEWAY_APP_ID: values.gateway.appId,
    CF_ACCESS_GATEWAY_APP_DOMAIN: values.gateway.appDomain,
    CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: values.gateway.serviceTokenPolicyId,
    TILLER_GATEWAY_TUNNEL_ID: values.gateway.tunnelId,
    TILLER_GATEWAY_TUNNEL_NAME: values.gateway.tunnelName,
    TILLER_GATEWAY_TUNNEL_TOKEN: values.gateway.tunnelToken,
    TILLER_GATEWAY_TUNNEL_TARGET_PORT: String(values.gateway.tunnelTargetPort),
  });
  invalidateConfigCache();
}

export function buildPersistedManagedAccessConfig(
  prepared: PreparedManagedAccess,
): PersistedAccessConfig {
  return {
    appId: prepared.app.id!,
    appAud: prepared.app.aud!,
    appDomain: prepared.appDomain,
    clientId: prepared.serviceToken.client_id,
    clientSecret: prepared.serviceToken.client_secret,
    browserPolicyId: prepared.browserPolicy?.id ?? prepared.previousBrowserPolicyId,
    serviceTokenId: prepared.serviceToken.id,
    serviceTokenPolicyId: prepared.serviceTokenPolicy.id,
  };
}

export function buildPersistedManagedServiceHostAccessConfig(
  prepared: PreparedManagedServiceHostAccess,
  tunnel: {
    tunnelId: string;
    tunnelName: string;
    tunnelToken: string;
    tunnelTargetPort: number;
  },
): PersistedManagedServiceHostAccessConfig {
  return {
    hostname: prepared.hostname,
    appId: prepared.app.id!,
    appDomain: prepared.appDomain,
    serviceTokenPolicyId: prepared.serviceTokenPolicy.id,
    tunnelId: tunnel.tunnelId,
    tunnelName: tunnel.tunnelName,
    tunnelToken: tunnel.tunnelToken,
    tunnelTargetPort: tunnel.tunnelTargetPort,
  };
}

export async function cleanupSupersededManagedHubAccess(
  apiToken: string,
  prepared: PreparedManagedAccess,
): Promise<void> {
  if (prepared.previousAppId && prepared.previousAppId !== prepared.app.id) {
    await deleteAccessApp(apiToken, prepared.accountId, prepared.previousAppId).catch(() => {});
  } else {
    if (
      prepared.browserPolicy
      && prepared.previousBrowserPolicyId
      && prepared.previousBrowserPolicyId !== prepared.browserPolicy.id
    ) {
      await deleteAccessPolicy(apiToken, prepared.accountId, prepared.app.id!, prepared.previousBrowserPolicyId).catch(() => {});
    }
    if (
      prepared.previousServiceTokenPolicyId &&
      prepared.previousServiceTokenPolicyId !== prepared.serviceTokenPolicy.id
    ) {
      await deleteAccessPolicy(
        apiToken,
        prepared.accountId,
        prepared.app.id!,
        prepared.previousServiceTokenPolicyId,
      ).catch(() => {});
    }
  }
  if (
    prepared.previousServiceTokenId
    && prepared.serviceToken
    && prepared.previousServiceTokenId !== prepared.serviceToken.id
  ) {
    await deleteServiceToken(apiToken, prepared.accountId, prepared.previousServiceTokenId).catch(() => {});
  }
}

export async function cleanupSupersededManagedServiceHostAccess(
  apiToken: string,
  prepared: PreparedManagedServiceHostAccess,
): Promise<void> {
  if (prepared.previousAppId && prepared.previousAppId !== prepared.app.id) {
    await deleteAccessApp(apiToken, prepared.accountId, prepared.previousAppId).catch(() => {});
    return;
  }

  if (
    prepared.previousServiceTokenPolicyId
    && prepared.previousServiceTokenPolicyId !== prepared.serviceTokenPolicy.id
  ) {
    await deleteAccessPolicy(
      apiToken,
      prepared.accountId,
      prepared.app.id!,
      prepared.previousServiceTokenPolicyId,
    ).catch(() => {});
  }
}

export async function provisionManagedServiceHosts(
  env: Env,
  options: {
    apiToken: string;
    accountId: string;
    zoneId: string;
    gatewayHostname: string | null;
    serviceTokenId: string;
  },
): Promise<ProvisionedManagedServiceHosts> {
  let preparedGateway: PreparedManagedServiceHostAccess | null = null;
  try {
    preparedGateway = await prepareManagedServiceHostAccess(env, {
      apiToken: options.apiToken,
      accountId: options.accountId,
      hostname: options.gatewayHostname,
      serviceTokenId: options.serviceTokenId,
    });

    const gatewayTunnel = await provisionManagedGatewayTunnel(env, {
      apiToken: options.apiToken,
      accountId: options.accountId,
      zoneId: options.zoneId,
      hostname: preparedGateway.hostname,
    });

    await persistManagedServiceHostAccessConfig(env, {
      gateway: buildPersistedManagedServiceHostAccessConfig(preparedGateway, {
        tunnelId: gatewayTunnel.tunnelId,
        tunnelName: gatewayTunnel.tunnelName,
        tunnelToken: gatewayTunnel.tunnelToken,
        tunnelTargetPort: gatewayTunnel.tunnelTargetPort,
      }),
    });

    await cleanupSupersededManagedServiceHostAccess(options.apiToken, preparedGateway).catch(() => {});

    return {
      gateway: preparedGateway,
    };
  } catch (error) {
    await preparedGateway?.cleanupDraftResources().catch(() => {});
    throw error;
  }
}
