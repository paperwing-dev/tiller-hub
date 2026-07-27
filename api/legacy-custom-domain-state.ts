export const LEGACY_CUSTOM_DOMAIN_STATE_KEY = "TILLER_SELF_HOST_STATE";
export const LEGACY_CUSTOM_DOMAIN_SETUP_SESSION_KEY =
  "TILLER_SELF_HOST_SETUP_SESSION";

export interface LegacyCustomDomainState {
  resources: {
    workerCustomDomain: {
      hostname: string;
      service: string;
      accountId: string;
      zoneId: string;
      domainId: string;
    };
    hubAccess: {
      appId: string;
      browserPolicyId: string;
      serviceTokenPolicyId: string;
    };
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Defensive parser for the one retired state record needed by the atomic
 * cleanup-manifest capture. It intentionally exposes no credential material.
 */
export function parseLegacyCustomDomainState(
  raw: string | undefined,
): LegacyCustomDomainState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const root = record(parsed);
  const resources = record(root?.resources);
  const domain = record(resources?.workerCustomDomain);
  const access = record(resources?.hubAccess);
  if (!domain || !access) return null;

  const hostname = requiredString(domain.hostname);
  const service = requiredString(domain.service);
  const accountId = requiredString(domain.accountId);
  const zoneId = requiredString(domain.zoneId);
  const domainId = requiredString(domain.domainId);
  const appId = requiredString(access.appId);
  const browserPolicyId = requiredString(access.browserPolicyId);
  const serviceTokenPolicyId = requiredString(access.serviceTokenPolicyId);
  if (
    !hostname
    || !service
    || !accountId
    || !zoneId
    || !domainId
    || !appId
    || !browserPolicyId
    || !serviceTokenPolicyId
  ) {
    return null;
  }

  return {
    resources: {
      workerCustomDomain: {
        hostname,
        service,
        accountId,
        zoneId,
        domainId,
      },
      hubAccess: {
        appId,
        browserPolicyId,
        serviceTokenPolicyId,
      },
    },
  };
}
