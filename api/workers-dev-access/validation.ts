import type {
  PendingWorkersDevAccessJobV1,
  WorkersDevAccessBootstrapResultV1,
  WorkersDevAccessRenewResultV1,
  WorkersDevAccessTrustV1,
} from "./types";
import { normalizeOwnerEmail, normalizeWorkersDevHostname } from "./records";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_SECRET_LENGTH = 4_096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported fields`);
  }
}

function requiredString(
  value: unknown,
  label: string,
  maxLength = MAX_IDENTIFIER_LENGTH,
): string {
  if (typeof value !== "string") throw new Error(`${label} is required`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw new Error(`${label} is invalid`);
  return normalized;
}

function isoTimestamp(value: unknown, label: string): string {
  const raw = requiredString(value, label, 128);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) throw new Error(`${label} is invalid`);
  return new Date(parsed).toISOString();
}

function normalizeIssuer(value: unknown): string {
  const raw = requiredString(value, "issuer");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("issuer is invalid");
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || (parsed.pathname !== "/" && parsed.pathname !== "")
    || parsed.search
    || parsed.hash
    || !/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(parsed.hostname)
  ) {
    throw new Error("issuer is invalid");
  }
  return `https://${parsed.hostname.toLowerCase()}`;
}

function targetHostname(job: PendingWorkersDevAccessJobV1): string {
  let origin: URL;
  try {
    origin = new URL(job.origin);
  } catch {
    throw new Error("job origin is invalid");
  }
  if (origin.protocol !== "https:" || origin.origin !== job.origin) {
    throw new Error("job origin is invalid");
  }
  const hostname = normalizeWorkersDevHostname(origin.hostname);
  if (!hostname.endsWith(".workers.dev")) throw new Error("job origin is invalid");
  return hostname;
}

export function normalizeBootstrapCompletion(
  value: unknown,
  job: PendingWorkersDevAccessJobV1,
): WorkersDevAccessBootstrapResultV1 {
  if (!isRecord(value)) throw new Error("bootstrap result is invalid");
  assertExactKeys(value, ["trust", "credential"], "bootstrap result");
  if (!isRecord(value.trust) || !isRecord(value.credential)) {
    throw new Error("bootstrap result is invalid");
  }
  assertExactKeys(value.trust, [
    "version",
    "ownerEmail",
    "accountId",
    "workerName",
    "workersDevHostname",
    "issuer",
    "audience",
    "serviceTokenId",
    "serviceClientId",
    "configuredAt",
  ], "bootstrap trust");
  assertExactKeys(value.credential, [
    "version",
    "currentSecret",
    "tokenExpiresAt",
    "updatedAt",
  ], "bootstrap credential");

  if (value.trust.version !== 1 || value.credential.version !== 1) {
    throw new Error("bootstrap result version is unsupported");
  }
  const ownerEmail = normalizeOwnerEmail(requiredString(value.trust.ownerEmail, "owner email", 320));
  if (!EMAIL_PATTERN.test(ownerEmail)) throw new Error("owner email is invalid");
  const workersDevHostname = normalizeWorkersDevHostname(
    requiredString(value.trust.workersDevHostname, "workers.dev hostname"),
  );
  if (workersDevHostname !== targetHostname(job)) {
    throw new Error("bootstrap result hostname did not match");
  }
  const workerName = requiredString(value.trust.workerName, "Worker name");
  if (workerName !== job.workerName) throw new Error("bootstrap result Worker did not match");

  const configuredAt = isoTimestamp(value.trust.configuredAt, "configuredAt");
  const updatedAt = isoTimestamp(value.credential.updatedAt, "updatedAt");
  const tokenExpiresAt = isoTimestamp(value.credential.tokenExpiresAt, "tokenExpiresAt");
  if (Date.parse(tokenExpiresAt) <= Date.parse(updatedAt)) {
    throw new Error("service token expiration is invalid");
  }

  return {
    trust: {
      version: 1,
      ownerEmail,
      accountId: requiredString(value.trust.accountId, "account ID"),
      workerName,
      workersDevHostname,
      issuer: normalizeIssuer(value.trust.issuer),
      audience: requiredString(value.trust.audience, "audience"),
      serviceTokenId: requiredString(value.trust.serviceTokenId, "service token ID"),
      serviceClientId: requiredString(value.trust.serviceClientId, "service client ID"),
      configuredAt,
    },
    credential: {
      version: 1,
      currentSecret: requiredString(value.credential.currentSecret, "service client secret", MAX_SECRET_LENGTH),
      tokenExpiresAt,
      updatedAt,
    },
  };
}

export function normalizeRenewCompletion(
  value: unknown,
  trust: WorkersDevAccessTrustV1,
): WorkersDevAccessRenewResultV1 {
  if (!isRecord(value)) throw new Error("renewal result is invalid");
  assertExactKeys(value, [
    "accountId",
    "serviceTokenId",
    "serviceClientId",
    "tokenExpiresAt",
    "updatedAt",
  ], "renewal result");
  const accountId = requiredString(value.accountId, "account ID");
  const serviceTokenId = requiredString(value.serviceTokenId, "service token ID");
  const serviceClientId = requiredString(value.serviceClientId, "service client ID");
  if (
    accountId !== trust.accountId
    || serviceTokenId !== trust.serviceTokenId
    || serviceClientId !== trust.serviceClientId
  ) {
    throw new Error("Cloudflare configuration changed");
  }
  const updatedAt = isoTimestamp(value.updatedAt, "updatedAt");
  const tokenExpiresAt = isoTimestamp(value.tokenExpiresAt, "tokenExpiresAt");
  if (Date.parse(tokenExpiresAt) <= Date.parse(updatedAt)) {
    throw new Error("service token expiration is invalid");
  }
  return { accountId, serviceTokenId, serviceClientId, tokenExpiresAt, updatedAt };
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
