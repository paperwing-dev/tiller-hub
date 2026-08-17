export interface RepoMcpServer {
  id: string;
  label: string;
  url: string;
  enabled: boolean;
}

export class McpServersValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpServersValidationError";
  }
}

export const REPO_MCP_MAX_SERVERS = 16;
export const REPO_MCP_MAX_ID_LENGTH = 64;
export const REPO_MCP_MAX_LABEL_LENGTH = 80;
export const REPO_MCP_MAX_URL_LENGTH = 512;
export const TILLER_MCP_SERVERS_ENV_VAR = "TILLER_MCP_SERVERS_JSON";

const GENERATED_ID_PREFIX = "tiller_";
const GENERATED_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const LOCAL_HOST_SUFFIXES = [
  "corp",
  "example",
  "home",
  "home.arpa",
  "internal",
  "intranet",
  "invalid",
  "lan",
  "local",
  "localdomain",
  "localhost",
  "onion",
  "test",
];

export interface RepoMcpServersPutSuccess {
  ok: true;
  servers: RepoMcpServer[];
}

export interface RepoMcpServersPutValidationFailure {
  ok: false;
  error: string;
}

export type RepoMcpServersPutResult =
  | RepoMcpServersPutSuccess
  | RepoMcpServersPutValidationFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createGeneratedMcpServerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let suffix = "";
  for (const byte of bytes) {
    suffix += GENERATED_ID_ALPHABET[byte & 31];
  }
  return `${GENERATED_ID_PREFIX}${suffix}`;
}

export function generateRepoMcpServerId(existingIds: Iterable<string> = []): string {
  const existing = new Set(existingIds);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const id = createGeneratedMcpServerId();
    if (!existing.has(id)) {
      return id;
    }
  }
  throw new McpServersValidationError("Could not generate a unique MCP server id.");
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");
}

function isIpLiteral(hostname: string): boolean {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    return true;
  }
  return hostname.includes(":");
}

function matchesHostnameSuffix(hostname: string, suffix: string): boolean {
  return hostname === suffix || hostname.endsWith(`.${suffix}`);
}

function validatePublicLookingHostname(hostname: string): void {
  const normalized = normalizeHostname(hostname);
  if (!normalized) {
    throw new McpServersValidationError("MCP server URL must include a hostname.");
  }
  if (isIpLiteral(normalized)) {
    throw new McpServersValidationError("MCP server URL cannot use an IP literal.");
  }
  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    throw new McpServersValidationError("MCP server URL cannot use localhost.");
  }
  const labels = normalized.split(".");
  if (labels.length < 2) {
    throw new McpServersValidationError("MCP server URL must use a public hostname.");
  }
  if (labels.some((label) => label.length === 0)) {
    throw new McpServersValidationError("MCP server URL hostname is invalid.");
  }
  const suffix = LOCAL_HOST_SUFFIXES.find((candidate) => matchesHostnameSuffix(normalized, candidate));
  if (suffix) {
    throw new McpServersValidationError(`MCP server URL cannot use .${suffix} hostnames.`);
  }
}

export function canonicalizeRepoMcpServerUrl(input: string): string {
  const value = input.trim();
  if (!value) {
    throw new McpServersValidationError("MCP server URL is required.");
  }
  if (value.length > REPO_MCP_MAX_URL_LENGTH) {
    throw new McpServersValidationError(`MCP server URL must be ${REPO_MCP_MAX_URL_LENGTH} characters or less.`);
  }
  if (value.includes("?")) {
    throw new McpServersValidationError("MCP server URL cannot include a query string.");
  }
  if (value.includes("#")) {
    throw new McpServersValidationError("MCP server URL cannot include a fragment.");
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpServersValidationError("MCP server URL is invalid.");
  }

  if (parsed.protocol !== "https:") {
    throw new McpServersValidationError("MCP server URL must use https.");
  }
  if (parsed.username || parsed.password) {
    throw new McpServersValidationError("MCP server URL cannot include credentials.");
  }
  if (parsed.search) {
    throw new McpServersValidationError("MCP server URL cannot include a query string.");
  }
  if (parsed.hash) {
    throw new McpServersValidationError("MCP server URL cannot include a fragment.");
  }
  validatePublicLookingHostname(parsed.hostname);

  const canonical = parsed.href;
  if (canonical.length > REPO_MCP_MAX_URL_LENGTH) {
    throw new McpServersValidationError(`MCP server URL must be ${REPO_MCP_MAX_URL_LENGTH} characters or less.`);
  }
  return canonical;
}

function normalizeKnownId(rawId: unknown, knownIds: Set<string>): string | null {
  if (rawId === undefined || rawId === null) {
    return null;
  }
  if (typeof rawId !== "string") {
    throw new McpServersValidationError("MCP server id must be a string.");
  }
  const id = rawId.trim();
  if (!id) {
    return null;
  }
  if (id.length > REPO_MCP_MAX_ID_LENGTH) {
    throw new McpServersValidationError(`MCP server id must be ${REPO_MCP_MAX_ID_LENGTH} characters or less.`);
  }
  if (!knownIds.has(id)) {
    throw new McpServersValidationError("Unknown MCP server id.");
  }
  return id;
}

export function normalizeRepoMcpServersRequest(
  input: unknown,
  options: {
    existingIds: Iterable<string>;
    generateId?: (existingIds: Iterable<string>) => string;
  },
): RepoMcpServer[] {
  if (!isRecord(input)) {
    throw new McpServersValidationError("Request body must be an object.");
  }
  if (!Array.isArray(input.servers)) {
    throw new McpServersValidationError("servers must be an array.");
  }
  if (input.servers.length > REPO_MCP_MAX_SERVERS) {
    throw new McpServersValidationError(`A repository can have at most ${REPO_MCP_MAX_SERVERS} MCP servers.`);
  }

  const knownIds = new Set(options.existingIds);
  const assignedIds = new Set<string>();
  const enabledUrls = new Set<string>();
  const generateId = options.generateId ?? generateRepoMcpServerId;
  const servers: RepoMcpServer[] = [];

  for (const rawServer of input.servers) {
    if (!isRecord(rawServer)) {
      throw new McpServersValidationError("Each MCP server must be an object.");
    }

    let id = normalizeKnownId(rawServer.id, knownIds);
    if (!id) {
      id = generateId(new Set([...knownIds, ...assignedIds]));
      if (id.length > REPO_MCP_MAX_ID_LENGTH) {
        throw new McpServersValidationError(`MCP server id must be ${REPO_MCP_MAX_ID_LENGTH} characters or less.`);
      }
      if (knownIds.has(id) || assignedIds.has(id)) {
        throw new McpServersValidationError("Could not generate a unique MCP server id.");
      }
    }
    if (assignedIds.has(id)) {
      throw new McpServersValidationError("Duplicate MCP server id.");
    }
    assignedIds.add(id);

    if (typeof rawServer.label !== "string") {
      throw new McpServersValidationError("MCP server label must be a string.");
    }
    const label = rawServer.label.trim();
    if (!label) {
      throw new McpServersValidationError("MCP server label is required.");
    }
    if (label.length > REPO_MCP_MAX_LABEL_LENGTH) {
      throw new McpServersValidationError(`MCP server label must be ${REPO_MCP_MAX_LABEL_LENGTH} characters or less.`);
    }

    if (typeof rawServer.url !== "string") {
      throw new McpServersValidationError("MCP server URL must be a string.");
    }
    const url = canonicalizeRepoMcpServerUrl(rawServer.url);

    if (typeof rawServer.enabled !== "boolean") {
      throw new McpServersValidationError("MCP server enabled must be a boolean.");
    }
    if (rawServer.enabled) {
      if (enabledUrls.has(url)) {
        throw new McpServersValidationError("Duplicate enabled MCP server URL.");
      }
      enabledUrls.add(url);
    }

    servers.push({
      id,
      label,
      url,
      enabled: rawServer.enabled,
    });
  }

  return servers;
}
