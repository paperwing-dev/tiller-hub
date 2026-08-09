import type { Env } from "../types";
import { normalizeCanonicalWorkersDevHostname } from "../canonical-workers-dev";
import type {
  WorkersDevAccessLifecycle,
  WorkersDevAccessRuntimeCredential,
  WorkersDevAccessRuntimeTrust,
} from "./types";

const RENEWAL_WARNING_MS = 30 * 24 * 60 * 60 * 1_000;
const MAINTAINER_DEV_HOSTNAME_PREFIX = "tiller-dev.";

export function normalizeOwnerEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isRenewalRecommended(tokenExpiresAt: string, now = Date.now()): boolean {
  const expiresAt = Date.parse(tokenExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt - now <= RENEWAL_WARNING_MS;
}

function exactHttpsOrigin(value: string): string | null {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:"
      && parsed.origin === value.trim()
      && !parsed.username
      && !parsed.password
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

function readBindingAccess(env: Env): {
  trust: WorkersDevAccessRuntimeTrust;
  credential: WorkersDevAccessRuntimeCredential;
} | null {
  const maintainerDevSchema = env.TILLER_MAINTAINER_DEV_SCHEMA?.trim() ?? "";
  const installerSchema = env.TILLER_INSTALLER_SCHEMA?.trim() ?? "";
  let hostnameAllowed: (hostname: string) => boolean;
  if (maintainerDevSchema) {
    if (maintainerDevSchema !== "1" || installerSchema) return null;
    hostnameAllowed = (hostname) => hostname.startsWith(MAINTAINER_DEV_HOSTNAME_PREFIX);
  } else {
    if (installerSchema !== "1") return null;
    hostnameAllowed = (hostname) => hostname.startsWith("tiller.");
  }

  const releaseId = env.TILLER_RELEASE_ID?.trim() ?? "";
  const hostname = normalizeCanonicalWorkersDevHostname(env.TILLER_WORKERS_DEV_HOSTNAME ?? "");
  const issuer = exactHttpsOrigin(env.CF_ACCESS_ISSUER ?? "");
  const audience = env.CF_ACCESS_AUDIENCE?.trim() ?? "";
  const serviceClientId = env.CF_ACCESS_SERVICE_CLIENT_ID?.trim() ?? "";
  const tokenExpiresAt = env.CF_ACCESS_TOKEN_EXPIRES_AT?.trim() ?? "";
  const ownerEmail = normalizeOwnerEmail(env.TILLER_OWNER_EMAIL ?? "");
  const currentSecret = env.CF_ACCESS_SERVICE_CLIENT_SECRET?.trim() ?? "";
  if (
    !/^[0-9a-f]{40}$/.test(releaseId)
    || !hostnameAllowed(hostname)
    || !issuer
    || !issuer.endsWith(".cloudflareaccess.com")
    || !audience
    || !serviceClientId
    || !Number.isFinite(Date.parse(tokenExpiresAt))
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)
    || !currentSecret
  ) return null;

  return {
    trust: {
      ownerEmail,
      workersDevHostname: hostname,
      issuer,
      audience,
      serviceClientId,
    },
    credential: {
      currentSecret,
      tokenExpiresAt: new Date(Date.parse(tokenExpiresAt)).toISOString(),
    },
  };
}

export async function readWorkersDevAccessTrust(
  env: Env,
  hostnameInput: string,
): Promise<WorkersDevAccessRuntimeTrust | null> {
  const hostname = normalizeCanonicalWorkersDevHostname(hostnameInput);
  if (!hostname) return null;

  const configured = readBindingAccess(env);
  return configured?.trust.workersDevHostname === hostname ? configured.trust : null;
}

export async function readWorkersDevAccessCredential(
  env: Env,
): Promise<WorkersDevAccessRuntimeCredential | null> {
  return readBindingAccess(env)?.credential ?? null;
}

export async function readWorkersDevAccessLifecycle(
  env: Env,
): Promise<WorkersDevAccessLifecycle> {
  const configured = readBindingAccess(env);
  if (configured) {
    return {
      configured: true,
      workersDevHostname: configured.trust.workersDevHostname,
      tokenExpiresAt: configured.credential.tokenExpiresAt,
      renewalRecommended: isRenewalRecommended(configured.credential.tokenExpiresAt),
    };
  }
  return {
    configured: false,
    workersDevHostname: null,
    tokenExpiresAt: null,
    renewalRecommended: false,
  };
}

export async function readCanonicalWorkersDevAccessTrust(
  env: Env,
): Promise<WorkersDevAccessRuntimeTrust | null> {
  return readBindingAccess(env)?.trust ?? null;
}
