import type { Env } from "../types";
import { getLocationHintOptions } from "../helpers";
import type {
  WorkersDevAccessCredentialV1,
  WorkersDevAccessLifecycle,
  WorkersDevAccessTrustV1,
} from "./types";
import { normalizeCanonicalWorkersDevHostname } from "../canonical-workers-dev";

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

const positiveTrustCache = new Map<string, WorkersDevAccessTrustV1>();

function getStore(env: Env): WorkersDevAccessStore | null {
  if (!env.HUB) return null;
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id, getLocationHintOptions(env)) as unknown as WorkersDevAccessStore;
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

/**
 * Cache only a positively loaded canonical trust record. In particular, a
 * fresh Hub never negatively caches "not configured", so the first request
 * after the atomic broker commit can immediately load the new trust root.
 */
export async function readWorkersDevAccessTrust(
  env: Env,
  hostnameInput: string,
): Promise<WorkersDevAccessTrustV1 | null> {
  const hostname = normalizeWorkersDevHostname(hostnameInput);
  if (!hostname || !hostname.endsWith(".workers.dev")) return null;

  const cached = positiveTrustCache.get(hostname);
  if (cached) return cached;

  const store = getStore(env);
  const loaded = store && typeof store.getWorkersDevAccessTrust === "function"
    ? await store.getWorkersDevAccessTrust(hostname)
    : null;
  if (!loaded) return null;
  positiveTrustCache.set(hostname, loaded);
  return loaded;
}

export function clearWorkersDevAccessTrustCache(hostnameInput?: string): void {
  if (!hostnameInput) {
    positiveTrustCache.clear();
    return;
  }
  positiveTrustCache.delete(normalizeWorkersDevHostname(hostnameInput));
}

/** Credential and expiry material is deliberately never cached. */
export async function readWorkersDevAccessCredential(
  env: Env,
): Promise<WorkersDevAccessCredentialV1 | null> {
  const store = getStore(env);
  return store && typeof store.getWorkersDevAccessCredential === "function"
    ? await store.getWorkersDevAccessCredential()
    : null;
}

/** Lifecycle data is deliberately read fresh for Settings and warnings. */
export async function readWorkersDevAccessLifecycle(
  env: Env,
): Promise<WorkersDevAccessLifecycle> {
  const store = getStore(env);
  return store && typeof store.getWorkersDevAccessLifecycle === "function"
    ? await store.getWorkersDevAccessLifecycle()
    : {
        configured: false,
        workersDevHostname: null,
        tokenExpiresAt: null,
        renewalRecommended: false,
      };
}

export async function readCanonicalWorkersDevAccessTrust(
  env: Env,
): Promise<WorkersDevAccessTrustV1 | null> {
  const lifecycle = await readWorkersDevAccessLifecycle(env);
  return lifecycle.workersDevHostname
    ? readWorkersDevAccessTrust(env, lifecycle.workersDevHostname)
    : null;
}
