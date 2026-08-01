import type { Env } from "../types";
import { normalizeCanonicalWorkersDevHostname } from "../canonical-workers-dev";
import type {
  WorkersDevAccessCredentialV1,
  WorkersDevAccessLifecycle,
  WorkersDevAccessRuntimeCredential,
  WorkersDevAccessRuntimeTrust,
  WorkersDevAccessTrustV1,
} from "./types";

// Kept for the legacy broker fallback until post-acceptance removal. Fresh
// installer deployments read trust and credentials only from Worker bindings.
export const WORKERS_DEV_ACCESS_TRUST_KEY = "__private:workers_dev_access:trust:v1";
export const WORKERS_DEV_ACCESS_CREDENTIAL_KEY = "__private:workers_dev_access:credential:v1";
export const WORKERS_DEV_ACCESS_PENDING_JOB_KEY = "__private:workers_dev_access:pending_job:v1";
export const WORKERS_DEV_ACCESS_COMPLETED_JOB_PREFIX = "__private:workers_dev_access:completed_job:v1:";
export const WORKERS_DEV_ACCESS_RESULT_DIGEST_KEY = "__private:workers_dev_access:result_digest_key:v1";

const RENEWAL_WARNING_MS = 30 * 24 * 60 * 60 * 1_000;

type WorkersDevAccessStore = {
  getWorkersDevAccessTrust(hostname: string): Promise<WorkersDevAccessTrustV1 | null>;
  getWorkersDevAccessCredential(): Promise<WorkersDevAccessCredentialV1 | null>;
  getWorkersDevAccessLifecycle(): Promise<WorkersDevAccessLifecycle>;
};

const positiveLegacyTrustCache = new Map<string, WorkersDevAccessTrustV1>();

function getLegacyStore(env: Env): WorkersDevAccessStore | null {
  if (!env.HUB) return null;
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id) as unknown as WorkersDevAccessStore;
}

function isInstallerManaged(env: Env): boolean {
  return Boolean(env.TILLER_INSTALLER_SCHEMA?.trim());
}

export function normalizeWorkersDevHostname(value: string): string {
  return normalizeCanonicalWorkersDevHostname(value);
}

export function normalizeOwnerEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isRenewalRecommended(tokenExpiresAt: string, now = Date.now()): boolean {
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
  if (env.TILLER_INSTALLER_SCHEMA?.trim() !== "1") {
    return null;
  }
  const releaseId = env.TILLER_RELEASE_ID?.trim() ?? "";
  const hostname = normalizeWorkersDevHostname(env.TILLER_WORKERS_DEV_HOSTNAME ?? "");
  const issuer = exactHttpsOrigin(env.CF_ACCESS_ISSUER ?? "");
  const audience = env.CF_ACCESS_AUDIENCE?.trim() ?? "";
  const serviceClientId = env.CF_ACCESS_SERVICE_CLIENT_ID?.trim() ?? "";
  const tokenExpiresAt = env.CF_ACCESS_TOKEN_EXPIRES_AT?.trim() ?? "";
  const ownerEmail = normalizeOwnerEmail(env.TILLER_OWNER_EMAIL ?? "");
  const currentSecret = env.CF_ACCESS_SERVICE_CLIENT_SECRET?.trim() ?? "";
  if (
    !/^[0-9a-f]{40}$/.test(releaseId)
    || !hostname.startsWith("tiller.")
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

async function readLegacyTrust(env: Env, hostname: string): Promise<WorkersDevAccessTrustV1 | null> {
  const cached = positiveLegacyTrustCache.get(hostname);
  if (cached) return cached;
  const store = getLegacyStore(env);
  const loaded = store && typeof store.getWorkersDevAccessTrust === "function"
    ? await store.getWorkersDevAccessTrust(hostname)
    : null;
  if (loaded) positiveLegacyTrustCache.set(hostname, loaded);
  return loaded;
}

export async function readWorkersDevAccessTrust(
  env: Env,
  hostnameInput: string,
): Promise<WorkersDevAccessRuntimeTrust | null> {
  const hostname = normalizeWorkersDevHostname(hostnameInput);
  if (!hostname || !hostname.endsWith(".workers.dev")) return null;

  if (isInstallerManaged(env)) {
    const configured = readBindingAccess(env);
    return configured?.trust.workersDevHostname === hostname ? configured.trust : null;
  }

  return readLegacyTrust(env, hostname);
}

export function clearWorkersDevAccessTrustCache(hostnameInput?: string): void {
  if (!hostnameInput) {
    positiveLegacyTrustCache.clear();
    return;
  }
  positiveLegacyTrustCache.delete(normalizeWorkersDevHostname(hostnameInput));
}

export async function readWorkersDevAccessCredential(
  env: Env,
): Promise<WorkersDevAccessRuntimeCredential | null> {
  if (isInstallerManaged(env)) return readBindingAccess(env)?.credential ?? null;
  const store = getLegacyStore(env);
  return store && typeof store.getWorkersDevAccessCredential === "function"
    ? await store.getWorkersDevAccessCredential()
    : null;
}

export async function readWorkersDevAccessLifecycle(
  env: Env,
): Promise<WorkersDevAccessLifecycle> {
  if (isInstallerManaged(env)) {
    const configured = readBindingAccess(env);
    if (configured) {
      return {
        configured: true,
        workersDevHostname: configured.trust.workersDevHostname,
        tokenExpiresAt: configured.credential.tokenExpiresAt,
        renewalRecommended: isRenewalRecommended(configured.credential.tokenExpiresAt),
      };
    }
  } else {
    const store = getLegacyStore(env);
    if (store && typeof store.getWorkersDevAccessLifecycle === "function") {
      return store.getWorkersDevAccessLifecycle();
    }
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
  if (isInstallerManaged(env)) return readBindingAccess(env)?.trust ?? null;
  return readCanonicalLegacyWorkersDevAccessTrust(env);
}

/** Temporary full legacy shape used only by the old broker renewal flow. */
export async function readCanonicalLegacyWorkersDevAccessTrust(
  env: Env,
): Promise<WorkersDevAccessTrustV1 | null> {
  if (isInstallerManaged(env)) return null;
  const lifecycle = await readWorkersDevAccessLifecycle(env);
  return lifecycle.workersDevHostname
    ? readLegacyTrust(env, lifecycle.workersDevHostname)
    : null;
}
