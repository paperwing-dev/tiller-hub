export interface RepoSessionEnvMetadata {
  name: string;
  updatedAt: string;
}

export interface RepoSessionEnvPatch {
  set?: Record<string, string>;
  delete?: string[];
}

export class SessionEnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionEnvValidationError";
  }
}

export const SESSION_ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const SESSION_ENV_MAX_NAME_LENGTH = 64;
export const SESSION_ENV_MAX_VALUE_BYTES = 16 * 1024;
export const SESSION_ENV_MAX_VARS_PER_REPO = 64;
export const SESSION_ENV_MAX_TOTAL_VALUE_BYTES = 64 * 1024;

const RESERVED_PREFIXES = [
  "RUNNER_",
  "CF_ACCESS_",
] as const;

const ALLOWED_TILLER_SESSION_ENV_NAMES = new Set([
  "TILLER_WORKER_NAME",
]);

const RESERVED_EXACT_NAMES = new Set([
  "HUB_URL",
  "NAMESPACE",
  "NODE_OPTIONS",
  "REPO_SLUG",
  "REPO_URL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_RATE_LIMIT_TIER",
  "CLAUDE_CODE_SUBSCRIPTION_TYPE",
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "OPENCODE_API_KEY",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_DISABLE_AUTOUPDATE",
  "OPENCODE_PROVIDER_HEADERS",
]);

function isReservedSessionEnvName(name: string): boolean {
  if (RESERVED_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return true;
  }
  if (name.startsWith("TILLER_") && !ALLOWED_TILLER_SESSION_ENV_NAMES.has(name)) {
    return true;
  }
  return RESERVED_EXACT_NAMES.has(name);
}

function valueByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeName(value: string): string {
  return value;
}

export function validateSessionEnvName(input: string): string {
  const name = normalizeName(input);
  if (!name) {
    throw new SessionEnvValidationError("Environment variable name is required.");
  }
  if (name.length > SESSION_ENV_MAX_NAME_LENGTH) {
    throw new SessionEnvValidationError(`Environment variable name must be ${SESSION_ENV_MAX_NAME_LENGTH} characters or less.`);
  }
  if (!SESSION_ENV_NAME_PATTERN.test(name)) {
    throw new SessionEnvValidationError("Environment variable names must start with a letter or underscore and contain only letters, numbers, and underscores.");
  }
  if (isReservedSessionEnvName(name)) {
    throw new SessionEnvValidationError(`${name} is reserved by Tiller and cannot be set as a session environment variable.`);
  }
  return name;
}

export function validateSessionEnvValue(name: string, value: string): string {
  if (value.length === 0) {
    throw new SessionEnvValidationError(`${name} cannot be empty.`);
  }
  if (value.includes("\0")) {
    throw new SessionEnvValidationError(`${name} cannot contain NUL bytes.`);
  }
  if (value.includes("\n") || value.includes("\r")) {
    throw new SessionEnvValidationError(`${name} cannot contain multiple lines.`);
  }
  const bytes = valueByteLength(value);
  if (bytes > SESSION_ENV_MAX_VALUE_BYTES) {
    throw new SessionEnvValidationError(`${name} must be ${SESSION_ENV_MAX_VALUE_BYTES} bytes or less.`);
  }
  return value;
}

export function normalizeSessionEnvPatch(input: unknown): RepoSessionEnvPatch {
  if (!input || typeof input !== "object") {
    throw new SessionEnvValidationError("Request body must be an object.");
  }
  const record = input as Record<string, unknown>;
  const patch: RepoSessionEnvPatch = {};

  if (record.set !== undefined) {
    if (!record.set || typeof record.set !== "object" || Array.isArray(record.set)) {
      throw new SessionEnvValidationError("set must be an object of environment variable names to string values.");
    }
    const set: Record<string, string> = {};
    for (const [rawName, rawValue] of Object.entries(record.set as Record<string, unknown>)) {
      if (typeof rawValue !== "string") {
        throw new SessionEnvValidationError(`${rawName} must be a string.`);
      }
      const name = validateSessionEnvName(rawName);
      set[name] = validateSessionEnvValue(name, rawValue);
    }
    if (Object.keys(set).length > 0) {
      patch.set = set;
    }
  }

  if (record.delete !== undefined) {
    if (!Array.isArray(record.delete)) {
      throw new SessionEnvValidationError("delete must be an array of environment variable names.");
    }
    const names = [...new Set(record.delete.map((rawName) => {
      if (typeof rawName !== "string") {
        throw new SessionEnvValidationError("delete must contain only environment variable names.");
      }
      return validateSessionEnvName(rawName);
    }))];
    if (names.length > 0) {
      patch.delete = names;
    }
  }

  if (!patch.set && !patch.delete) {
    throw new SessionEnvValidationError("Provide at least one of set or delete.");
  }

  return patch;
}

export function validateSessionEnvRepoLimits(values: Record<string, string>): void {
  const names = Object.keys(values);
  if (names.length > SESSION_ENV_MAX_VARS_PER_REPO) {
    throw new SessionEnvValidationError(`A repository can have at most ${SESSION_ENV_MAX_VARS_PER_REPO} session environment variables.`);
  }

  let totalBytes = 0;
  for (const [name, value] of Object.entries(values)) {
    validateSessionEnvName(name);
    validateSessionEnvValue(name, value);
    totalBytes += valueByteLength(value);
  }
  if (totalBytes > SESSION_ENV_MAX_TOTAL_VALUE_BYTES) {
    throw new SessionEnvValidationError(`Session environment values for a repository must total ${SESSION_ENV_MAX_TOTAL_VALUE_BYTES} bytes or less.`);
  }
}

export function applySessionEnvPatch(
  existing: Record<string, string>,
  patch: RepoSessionEnvPatch,
): Record<string, string> {
  const next = { ...existing };
  for (const name of patch.delete ?? []) {
    delete next[name];
  }
  for (const [name, value] of Object.entries(patch.set ?? {})) {
    next[name] = value;
  }
  validateSessionEnvRepoLimits(next);
  return next;
}
