import { SignJWT, importPKCS8 } from "jose";
import type { Env } from "../types";
import { getOrCreateSecret, loadConfig } from "../setup/config";
import { isLocalDevRequest, resolveProtectionState } from "../protection";
import { canonicalizeGitHubRepo, GitHubRepoParseError, type CanonicalGitHubRepo } from "./repo";
import { getDurableObjectStub } from "../durable-object";

export const GITHUB_APP_CONFIG_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_CLIENT_ID",
  "GITHUB_APP_SLUG",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_MANIFEST_SIGNING_KEY",
  "GITHUB_APP_WEBHOOK_SECRET",
  "GITHUB_APP_WEBHOOK_CONFIGURED",
] as const;

export interface GitHubAppConfig {
  appId: string;
  clientId: string;
  slug: string;
  privateKey: string;
  manifestSigningKey?: string;
  webhookSecret?: string;
  webhookConfigured?: boolean;
}

export type GitHubInstallationAccess = "read" | "write" | "publish";

export type GitHubInstallationPermissions =
  | {
      metadata: "read";
      contents: "read";
    }
  | {
      metadata: "read";
      contents: "write";
      pull_requests: "write";
    }
  | {
      metadata: "read";
      contents: "write";
      pull_requests: "write";
      workflows: "write";
    };

export interface GitHubInstallationToken {
  token: string;
  expiresAt: string;
  installationId: number;
  repository: string;
  permissions: GitHubInstallationPermissions;
}

export interface GitHubRepoInstallationAccessCheck {
  installationId: number;
  repository: string;
  permissions: GitHubInstallationPermissions;
}

export class GitHubAppError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 502,
  ) {
    super(message);
    this.name = "GitHubAppError";
  }
}

type HubConfigWriter = {
  setConfig(key: string, value: string): void | Promise<void>;
};

interface GitHubApiResponse<T> {
  status: number;
  body: T | null;
  text: string;
}

interface GitHubInstallationResponse {
  id?: number;
  permissions?: Record<string, string>;
  repository_selection?: "all" | "selected";
}

interface GitHubInstallationRepositoryResponse {
  id?: number;
  full_name?: string;
  html_url?: string;
  private?: boolean;
  default_branch?: string | null;
}

interface GitHubInstallationRepositoriesResponse {
  repositories?: GitHubInstallationRepositoryResponse[];
}

interface GitHubTokenResponse {
  token?: string;
  expires_at?: string;
  permissions?: Record<string, string>;
}

interface GitHubUserResponse {
  id?: number;
  login?: string;
}

export interface GitHubCommitIdentity {
  name: string;
  email: string;
}

export interface GitHubAppRepositorySelection {
  repositoryId: number;
  installationId: number;
  fullName: string;
  repoUrl: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface GitHubAppRepositoryWarning {
  installationId?: number;
  code: string;
  message: string;
}

const TOKEN_CACHE_SKEW_MS = 60_000;
const tokenCache = new Map<string, { token: GitHubInstallationToken; usableUntilMs: number }>();
const botIdentityCache = new Map<string, GitHubCommitIdentity>();
const INSTALLATION_READY_CACHE_MS = 5 * 60_000;
const INSTALLATION_NOT_READY_CACHE_MS = 10_000;
const installationReadyCache = new Map<string, { ready: boolean; usableUntilMs: number }>();
const GITHUB_APP_INSTALLATION_MANAGE_URL = "https://github.com/settings/installations";
const GITHUB_APP_PERMISSION_SETS = {
  read: {
    metadata: "read",
    contents: "read",
  },
  write: {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
  },
  publish: {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    workflows: "write",
  },
} as const satisfies Record<GitHubInstallationAccess, GitHubInstallationPermissions>;
const RSA_PRIVATE_KEY_HEADER = "-----BEGIN RSA PRIVATE KEY-----"; // gitleaks:allow -- protocol delimiter, not key material
const RSA_ENCRYPTION_ALGORITHM_IDENTIFIER = Uint8Array.from([
  0x30, 0x0d,
  0x06, 0x09,
  0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01,
  0x05, 0x00,
]);

function getHubConfigWriter(env: Env): HubConfigWriter {
  return getDurableObjectStub<HubConfigWriter>(env, env.HUB, "hub");
}

function readRequiredConfig(config: Record<string, string>, key: string): string | null {
  const value = config[key]?.trim();
  return value ? value : null;
}

export async function getGitHubAppConfig(env: Env): Promise<GitHubAppConfig | null> {
  const config = await loadConfig(env);
  const appId = readRequiredConfig(config, "GITHUB_APP_ID");
  const clientId = readRequiredConfig(config, "GITHUB_APP_CLIENT_ID");
  const slug = readRequiredConfig(config, "GITHUB_APP_SLUG");
  const privateKeyRaw = readRequiredConfig(config, "GITHUB_APP_PRIVATE_KEY");
  const webhookSecret = readRequiredConfig(config, "GITHUB_APP_WEBHOOK_SECRET");
  const webhookConfigured = config.GITHUB_APP_WEBHOOK_CONFIGURED?.trim() === "true";
  if (!appId || !clientId || !slug || !privateKeyRaw) {
    return null;
  }

  return {
    appId,
    clientId,
    slug,
    privateKey: normalizePrivateKey(privateKeyRaw),
    ...(config.GITHUB_APP_MANIFEST_SIGNING_KEY?.trim()
      ? { manifestSigningKey: config.GITHUB_APP_MANIFEST_SIGNING_KEY.trim() }
      : {}),
    ...(webhookSecret ? { webhookSecret } : {}),
    ...(webhookConfigured ? { webhookConfigured } : {}),
  };
}

export async function resolveGitHubAppBotCommitIdentity(
  env: Env,
  installationToken: string,
): Promise<GitHubCommitIdentity> {
  const config = await getGitHubAppConfig(env);
  if (!config) {
    throw new GitHubAppError("GitHub App is not configured.", "github_app_not_configured", 409);
  }
  const login = `${config.slug}[bot]`;
  const cached = botIdentityCache.get(login);
  if (cached) return cached;

  const response = await fetch(`https://api.github.com/users/${encodeURIComponent(login)}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${installationToken}`,
      "User-Agent": "tiller-hub",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body: GitHubUserResponse = await response.json<GitHubUserResponse>().catch(() => ({}));
  if (
    !response.ok
    || typeof body.id !== "number"
    || !Number.isSafeInteger(body.id)
    || body.id <= 0
    || body.login !== login
  ) {
    throw new GitHubAppError(
      `Failed to resolve GitHub App bot ${login}: HTTP ${response.status}.`,
      "github_app_bot_identity_unavailable",
      502,
    );
  }

  const identity = {
    name: login,
    email: `${body.id}+${login}@users.noreply.github.com`,
  };
  botIdentityCache.set(login, identity);
  return identity;
}

export async function saveGitHubAppConfig(
  env: Env,
  input: {
    appId: string;
    clientId: string;
    slug: string;
    privateKey: string;
    manifestSigningKey?: string | null;
    webhookSecret?: string | null;
    webhookConfigured?: boolean | null;
  },
): Promise<GitHubAppConfig> {
  const appId = input.appId.trim();
  const clientId = input.clientId.trim();
  const slug = input.slug.trim();
  const privateKey = normalizePrivateKey(input.privateKey.trim());
  if (!appId || !clientId || !slug || !privateKey) {
    throw new GitHubAppError("GitHub App ID, client ID, slug, and private key are required.", "github_app_config_invalid", 400);
  }
  if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey)) {
    throw new GitHubAppError("GitHub App private key must be a PEM private key.", "github_app_private_key_invalid", 400);
  }

  const hub = getHubConfigWriter(env);
  await hub.setConfig("GITHUB_APP_ID", appId);
  await hub.setConfig("GITHUB_APP_CLIENT_ID", clientId);
  await hub.setConfig("GITHUB_APP_SLUG", slug);
  await hub.setConfig("GITHUB_APP_PRIVATE_KEY", privateKey);
  if (input.manifestSigningKey?.trim()) {
    await hub.setConfig("GITHUB_APP_MANIFEST_SIGNING_KEY", input.manifestSigningKey.trim());
  }
  if (input.webhookSecret?.trim()) {
    await hub.setConfig("GITHUB_APP_WEBHOOK_SECRET", input.webhookSecret.trim());
  }
  if (input.webhookConfigured === true) {
    await hub.setConfig("GITHUB_APP_WEBHOOK_CONFIGURED", "true");
  } else {
    await hub.setConfig("GITHUB_APP_WEBHOOK_CONFIGURED", "false");
  }

  return {
    appId,
    clientId,
    slug,
    privateKey,
    ...(input.manifestSigningKey?.trim() ? { manifestSigningKey: input.manifestSigningKey.trim() } : {}),
    ...(input.webhookSecret?.trim() ? { webhookSecret: input.webhookSecret.trim() } : {}),
    ...(input.webhookConfigured === true ? { webhookConfigured: true } : {}),
  };
}

export function createGitHubWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function getOrCreateGitHubWebhookSecret(env: Env): Promise<string> {
  return await getOrCreateSecret(env, "GITHUB_APP_WEBHOOK_SECRET", createGitHubWebhookSecret);
}

export async function isGitHubAppAllowedForRequest(env: Env, request: Request): Promise<boolean> {
  if (isLocalDevRequest(env, request)) {
    return true;
  }
  const protection = await resolveProtectionState(env, request.url);
  return protection.protectionMode === "cf-access";
}

function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, "\n").trim();
}

function concatBytes(...chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return Uint8Array.from([length]);
  }
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Uint8Array.from([0x80 | bytes.length, ...bytes]);
}

function derTlv(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes(Uint8Array.from([tag]), derLength(value.length), value);
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  if (!base64) {
    throw new Error("PEM body is empty.");
  }
  const binary = atob(base64);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function derToPem(label: string, der: Uint8Array): string {
  let binary = "";
  for (const byte of der) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return [
    `-----BEGIN ${label}-----`,
    ...lines,
    `-----END ${label}-----`,
  ].join("\n");
}

function convertRsaPrivateKeyToPkcs8(pem: string): string {
  const rsaPrivateKey = pemToDer(pem);
  const privateKeyInfo = derTlv(0x30, concatBytes(
    derTlv(0x02, Uint8Array.from([0])),
    RSA_ENCRYPTION_ALGORITHM_IDENTIFIER,
    derTlv(0x04, rsaPrivateKey),
  ));
  return derToPem("PRIVATE KEY", privateKeyInfo);
}

function privateKeyForJwtImport(privateKey: string): string {
  const normalized = normalizePrivateKey(privateKey);
  return normalized.startsWith(RSA_PRIVATE_KEY_HEADER)
    ? convertRsaPrivateKeyToPkcs8(normalized)
    : normalized;
}

async function createGitHubAppJwt(config: GitHubAppConfig): Promise<string> {
  let key: CryptoKey | Uint8Array;
  try {
    key = await importPKCS8(privateKeyForJwtImport(config.privateKey), "RS256");
  } catch (error) {
    throw new GitHubAppError(
      `GitHub App private key could not be imported: ${error instanceof Error ? error.message : String(error)}`,
      "github_app_private_key_invalid",
      400,
    );
  }
  const now = Math.floor(Date.now() / 1000);
  return await new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .setIssuer(config.clientId)
    .sign(key);
}

async function githubApi<T>(
  path: string,
  token: string,
  options?: {
    method?: string;
    body?: unknown;
  },
): Promise<GitHubApiResponse<T>> {
  const response = await fetch(`https://api.github.com${path}`, {
    method: options?.method ?? "GET",
    headers: {
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "tiller-hub",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
    },
    ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text().catch(() => "");
  let body: T | null = null;
  if (text) {
    try {
      body = JSON.parse(text) as T;
    } catch {
      body = null;
    }
  }
  return { status: response.status, body, text };
}

function readGitHubMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && typeof (body as Record<string, unknown>).message === "string") {
    return (body as Record<string, string>).message;
  }
  return fallback;
}

export function getGitHubAppInstallUrl(slug: string): string {
  return `https://github.com/apps/${slug}/installations/new`;
}

export function getGitHubAppManageUrl(): string {
  return GITHUB_APP_INSTALLATION_MANAGE_URL;
}

function permissionSetForAccess(access: GitHubInstallationAccess): GitHubInstallationPermissions {
  const permissions = GITHUB_APP_PERMISSION_SETS[access];
  if (access === "read") {
    return {
      metadata: permissions.metadata,
      contents: "read",
    };
  }
  if (access === "publish") {
    return {
      metadata: permissions.metadata,
      contents: "write",
      pull_requests: "write",
      workflows: "write",
    };
  }
  return {
    metadata: permissions.metadata,
    contents: "write",
    pull_requests: "write",
  };
}

function permissionCacheKey(permissions: GitHubInstallationPermissions): string {
  return Object.entries(permissions)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
}

function hasRequiredPermissions(
  permissions: Record<string, string> | undefined,
  access: GitHubInstallationAccess,
): boolean {
  if (!permissions) return false;
  if (permissions.metadata !== "read") return false;
  if (access === "read") {
    return permissions.contents === "read" || permissions.contents === "write";
  }
  if (permissions.contents !== "write" || permissions.pull_requests !== "write") {
    return false;
  }
  return access !== "publish" || permissions.workflows === "write";
}

function isInstallationListResponse(value: unknown): value is GitHubInstallationResponse[] {
  return Array.isArray(value);
}

function parseGitHubRepositoryResponse(
  installationId: number,
  value: GitHubInstallationRepositoryResponse,
): GitHubAppRepositorySelection | null {
  if (
    typeof value.id !== "number" ||
    typeof value.full_name !== "string" ||
    !value.full_name.includes("/")
  ) {
    return null;
  }
  const repo = canonicalizeGitHubRepo(value.full_name, { allowOwnerRepo: true });
  return {
    repositoryId: value.id,
    installationId,
    fullName: repo.fullName,
    repoUrl: repo.htmlUrl,
    private: value.private === true,
    defaultBranch: typeof value.default_branch === "string" && value.default_branch.trim()
      ? value.default_branch.trim()
      : null,
  };
}

function missingPermissionsMessage(access: GitHubInstallationAccess): string {
  if (access === "publish") {
    return "The GitHub App needs Workflows: read and write to publish changes under .github/workflows. Update the App permission, then approve the request for its installation.";
  }
  return access === "write"
    ? "The GitHub App installation is missing contents:write, pull_requests:write, or metadata:read permissions."
    : "The GitHub App installation is missing contents:read or metadata:read permissions.";
}

async function resolveOwnerInstallation(
  owner: string,
  jwt: string,
): Promise<GitHubInstallationResponse | null> {
  const org = await githubApi<GitHubInstallationResponse>(`/orgs/${owner}/installation`, jwt);
  if (org.status === 200 && org.body?.id) return org.body;

  const user = await githubApi<GitHubInstallationResponse>(`/users/${owner}/installation`, jwt);
  if (user.status === 200 && user.body?.id) return user.body;
  return null;
}

async function resolveRepoInstallation(
  repo: CanonicalGitHubRepo,
  jwt: string,
): Promise<GitHubInstallationResponse> {
  const response = await githubApi<GitHubInstallationResponse>(
    `/repos/${repo.owner}/${repo.repo}/installation`,
    jwt,
  );
  if (response.status === 200 && response.body?.id) {
    return response.body;
  }

  if (response.status === 404) {
    const ownerInstallation = await resolveOwnerInstallation(repo.owner, jwt);
    if (ownerInstallation?.id) {
      throw new GitHubAppError(
        `The GitHub App is installed for ${repo.owner}, but ${repo.fullName} is not selected for the installation.`,
        "github_app_repo_not_selected",
        403,
      );
    }
    throw new GitHubAppError(
      `The GitHub App is not installed for ${repo.owner}.`,
      "github_app_missing_installation",
      404,
    );
  }

  throw new GitHubAppError(
    readGitHubMessage(response.body, `GitHub installation lookup failed with HTTP ${response.status}.`),
    "github_app_installation_lookup_failed",
    502,
  );
}

async function resolveGitHubRepoInstallationAccess(
  env: Env,
  repo: CanonicalGitHubRepo,
  access: GitHubInstallationAccess,
): Promise<{
  jwt: string;
  installationId: number;
  permissions: GitHubInstallationPermissions;
}> {
  const config = await getGitHubAppConfig(env);
  if (!config) {
    throw new GitHubAppError("GitHub App is not configured.", "github_app_not_configured", 409);
  }

  const jwt = await createGitHubAppJwt(config);
  const installation = await resolveRepoInstallation(repo, jwt);
  if (!installation.id) {
    throw new GitHubAppError("GitHub App installation did not include an installation ID.", "github_app_installation_lookup_failed", 502);
  }
  if (!hasRequiredPermissions(installation.permissions, access)) {
    throw new GitHubAppError(
      missingPermissionsMessage(access),
      "github_app_missing_permissions",
      403,
    );
  }

  return {
    jwt,
    installationId: installation.id,
    permissions: permissionSetForAccess(access),
  };
}

export async function checkGitHubRepoInstallationAccess(
  env: Env,
  repo: CanonicalGitHubRepo,
  options?: { access?: GitHubInstallationAccess },
): Promise<GitHubRepoInstallationAccessCheck> {
  const access = options?.access ?? "read";
  const installation = await resolveGitHubRepoInstallationAccess(env, repo, access);
  return {
    installationId: installation.installationId,
    repository: repo.fullName,
    permissions: installation.permissions,
  };
}

export async function mintGitHubInstallationToken(
  env: Env,
  repo: CanonicalGitHubRepo,
  options?: { access?: GitHubInstallationAccess },
): Promise<GitHubInstallationToken> {
  const access = options?.access ?? "read";
  const installation = await resolveGitHubRepoInstallationAccess(env, repo, access);
  const requestedPermissions = permissionSetForAccess(access);

  const cacheKey = `${repo.fullName}:${installation.installationId}:${permissionCacheKey(requestedPermissions)}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.usableUntilMs) {
    return cached.token;
  }

  const tokenResponse = await githubApi<GitHubTokenResponse>(
    `/app/installations/${installation.installationId}/access_tokens`,
    installation.jwt,
    {
      method: "POST",
      body: {
        repositories: [repo.repo],
        permissions: requestedPermissions,
      },
    },
  );
  if (tokenResponse.status !== 201 || !tokenResponse.body?.token || !tokenResponse.body.expires_at) {
    if (tokenResponse.status === 422 || /permission/i.test(tokenResponse.text)) {
      throw new GitHubAppError(
        readGitHubMessage(tokenResponse.body, "The GitHub App is missing required repository permissions."),
        "github_app_missing_permissions",
        403,
      );
    }
    throw new GitHubAppError(
      readGitHubMessage(tokenResponse.body, `GitHub installation token creation failed with HTTP ${tokenResponse.status}.`),
      "github_app_token_create_failed",
      502,
    );
  }
  if (!hasRequiredPermissions(tokenResponse.body.permissions, access)) {
    throw new GitHubAppError(
      `GitHub returned an installation token without the requested ${access} permissions.`,
      "github_app_missing_permissions",
      403,
    );
  }

  const token: GitHubInstallationToken = {
    token: tokenResponse.body.token,
    expiresAt: tokenResponse.body.expires_at,
    installationId: installation.installationId,
    repository: repo.fullName,
    permissions: requestedPermissions,
  };
  const expiresAtMs = Date.parse(token.expiresAt);
  if (Number.isFinite(expiresAtMs)) {
    tokenCache.set(cacheKey, {
      token,
      usableUntilMs: Math.max(Date.now(), expiresAtMs - TOKEN_CACHE_SKEW_MS),
    });
  }
  return token;
}

async function mintGitHubInstallationTokenForInstallation(
  installationId: number,
  jwt: string,
  access: GitHubInstallationAccess,
): Promise<GitHubInstallationToken> {
  const requestedPermissions = permissionSetForAccess(access);
  const tokenResponse = await githubApi<GitHubTokenResponse>(
    `/app/installations/${installationId}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: {
        permissions: requestedPermissions,
      },
    },
  );
  if (tokenResponse.status !== 201 || !tokenResponse.body?.token || !tokenResponse.body.expires_at) {
    throw new GitHubAppError(
      readGitHubMessage(tokenResponse.body, `GitHub installation token creation failed with HTTP ${tokenResponse.status}.`),
      tokenResponse.status === 422 ? "github_app_missing_permissions" : "github_app_token_create_failed",
      tokenResponse.status === 422 ? 403 : 502,
    );
  }
  if (!hasRequiredPermissions(tokenResponse.body.permissions, access)) {
    throw new GitHubAppError(
      `GitHub returned an installation token without the requested ${access} permissions.`,
      "github_app_missing_permissions",
      403,
    );
  }
  return {
    token: tokenResponse.body.token,
    expiresAt: tokenResponse.body.expires_at,
    installationId,
    repository: "*",
    permissions: requestedPermissions,
  };
}

async function listInstallationRepositories(
  installationId: number,
  installationToken: string,
): Promise<GitHubAppRepositorySelection[]> {
  const repositories: GitHubAppRepositorySelection[] = [];
  for (let page = 1; page < 100; page += 1) {
    const response = await githubApi<GitHubInstallationRepositoriesResponse>(
      `/installation/repositories?per_page=100&page=${page}`,
      installationToken,
    );
    if (response.status !== 200) {
      throw new GitHubAppError(
        readGitHubMessage(response.body, `GitHub repository listing failed with HTTP ${response.status}.`),
        "github_app_repository_list_failed",
        502,
      );
    }
    const items = response.body?.repositories ?? [];
    repositories.push(
      ...items.flatMap((item) => {
        const parsed = parseGitHubRepositoryResponse(installationId, item);
        return parsed ? [parsed] : [];
      }),
    );
    if (items.length < 100) {
      break;
    }
  }
  return repositories;
}

async function listGitHubAppInstallations(jwt: string): Promise<GitHubInstallationResponse[]> {
  const installations: GitHubInstallationResponse[] = [];
  for (let page = 1; page < 100; page += 1) {
    const response = await githubApi<GitHubInstallationResponse[]>(
      `/app/installations?per_page=100&page=${page}`,
      jwt,
    );
    if (response.status !== 200 || !isInstallationListResponse(response.body)) {
      throw new GitHubAppError(
        readGitHubMessage(response.body, `GitHub installation listing failed with HTTP ${response.status}.`),
        "github_app_installation_list_failed",
        502,
      );
    }
    installations.push(...response.body);
    if (response.body.length < 100) {
      break;
    }
  }
  return installations;
}

/** Setup is complete only after at least one writable repository is usable. */
export async function isGitHubAppInstallationReady(env: Env): Promise<boolean> {
  const config = await getGitHubAppConfig(env);
  if (!config) return false;

  const cacheKey = `${config.appId}:${config.clientId}`;
  const cached = installationReadyCache.get(cacheKey);
  if (cached && cached.usableUntilMs > Date.now()) {
    return cached.ready;
  }

  const jwt = await createGitHubAppJwt(config);
  const installations = await listGitHubAppInstallations(jwt);
  let ready = false;
  for (const installation of installations) {
    if (!installation.id || !hasRequiredPermissions(installation.permissions, "write")) continue;
    const token = await mintGitHubInstallationTokenForInstallation(installation.id, jwt, "write");
    const repositories = await listInstallationRepositories(installation.id, token.token);
    if (repositories.length > 0) {
      ready = true;
      break;
    }
  }
  installationReadyCache.set(cacheKey, {
    ready,
    usableUntilMs: Date.now() + (ready ? INSTALLATION_READY_CACHE_MS : INSTALLATION_NOT_READY_CACHE_MS),
  });
  return ready;
}

export async function listGitHubAppRepositories(env: Env): Promise<{
  repositories: GitHubAppRepositorySelection[];
  warnings: GitHubAppRepositoryWarning[];
  repositorySelection: "all" | "selected" | "unknown";
}> {
  const config = await getGitHubAppConfig(env);
  if (!config) {
    throw new GitHubAppError("GitHub App is not configured.", "github_app_not_configured", 409);
  }

  const jwt = await createGitHubAppJwt(config);
  const installations = await listGitHubAppInstallations(jwt);

  const repositories: GitHubAppRepositorySelection[] = [];
  const warnings: GitHubAppRepositoryWarning[] = [];
  const repositorySelections: Array<"all" | "selected"> = [];
  if (installations.length === 0) {
    warnings.push({
      code: "github_app_missing_installation",
      message: "The GitHub App is not installed on any account.",
    });
  }
  for (const installation of installations) {
    if (!installation.id) {
      warnings.push({
        code: "github_app_installation_missing_id",
        message: "A GitHub App installation did not include an installation ID.",
      });
      continue;
    }
    if (!hasRequiredPermissions(installation.permissions, "write")) {
      warnings.push({
        installationId: installation.id,
        code: "github_app_missing_permissions",
        message: missingPermissionsMessage("write"),
      });
      continue;
    }
    if (installation.repository_selection === "all" || installation.repository_selection === "selected") {
      repositorySelections.push(installation.repository_selection);
    }

    try {
      const token = await mintGitHubInstallationTokenForInstallation(installation.id, jwt, "write");
      repositories.push(...await listInstallationRepositories(installation.id, token.token));
    } catch (error) {
      warnings.push({
        installationId: installation.id,
        code: error instanceof GitHubAppError ? error.code : "github_app_repository_list_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const deduped = new Map<string, GitHubAppRepositorySelection>();
  for (const repository of repositories) {
    deduped.set(`${repository.installationId}:${repository.repositoryId}`, repository);
  }
  return {
    repositories: Array.from(deduped.values()).sort((left, right) => left.fullName.localeCompare(right.fullName)),
    warnings,
    repositorySelection: repositorySelections.length > 0 && repositorySelections.every((selection) => selection === "all")
      ? "all"
      : repositorySelections.length > 0
        ? "selected"
        : "unknown",
  };
}

export async function resolveGitHubAppRepositorySelection(
  env: Env,
  claim: {
    repositoryId: number;
    installationId: number;
    fullName: string;
  },
): Promise<GitHubAppRepositorySelection> {
  if (
    !Number.isInteger(claim.repositoryId) ||
    claim.repositoryId <= 0 ||
    !Number.isInteger(claim.installationId) ||
    claim.installationId <= 0
  ) {
    throw new GitHubAppError("repositoryId and installationId must be positive integers.", "github_app_repo_claim_invalid", 400);
  }
  let requested: CanonicalGitHubRepo;
  try {
    requested = canonicalizeGitHubRepo(claim.fullName, { allowOwnerRepo: true });
  } catch (error) {
    if (error instanceof GitHubRepoParseError) {
      throw new GitHubAppError(error.message, "github_app_repo_claim_invalid", 400);
    }
    throw error;
  }
  const { repositories, warnings } = await listGitHubAppRepositories(env);
  const match = repositories.find((repository) =>
    repository.repositoryId === claim.repositoryId &&
    repository.installationId === claim.installationId &&
    repository.fullName === requested.fullName
  );
  if (!match) {
    const warning = warnings.find((candidate) => candidate.installationId === claim.installationId)
      ?? (repositories.length === 0 ? warnings[0] : undefined);
    if (warning) {
      throw new GitHubAppError(
        warning.message,
        warning.code,
        warning.code === "github_app_missing_installation" ? 404 : warning.code === "github_app_missing_permissions" ? 403 : 502,
      );
    }
    throw new GitHubAppError(
      `${requested.fullName} is not selected in the configured GitHub App installation with required write permissions.`,
      "github_app_repo_not_selected",
      403,
    );
  }
  return match;
}

export async function resolveGitHubAppRepositorySelectionById(
  env: Env,
  claim: {
    repositoryId: number;
    installationId: number;
  },
): Promise<GitHubAppRepositorySelection> {
  if (
    !Number.isInteger(claim.repositoryId) ||
    claim.repositoryId <= 0 ||
    !Number.isInteger(claim.installationId) ||
    claim.installationId <= 0
  ) {
    throw new GitHubAppError("repositoryId and installationId must be positive integers.", "github_app_repo_claim_invalid", 400);
  }
  const { repositories, warnings } = await listGitHubAppRepositories(env);
  const match = repositories.find((repository) =>
    repository.repositoryId === claim.repositoryId &&
    repository.installationId === claim.installationId
  );
  if (!match) {
    const warning = warnings.find((candidate) => candidate.installationId === claim.installationId)
      ?? (repositories.length === 0 ? warnings[0] : undefined);
    if (warning) {
      throw new GitHubAppError(
        warning.message,
        warning.code,
        warning.code === "github_app_missing_installation" ? 404 : warning.code === "github_app_missing_permissions" ? 403 : 502,
      );
    }
    throw new GitHubAppError(
      `Repository ${claim.repositoryId} is not selected in the configured GitHub App installation with required write permissions.`,
      "github_app_repo_not_selected",
      403,
    );
  }
  return match;
}

export async function getOrCreateGitHubManifestSigningKey(env: Env): Promise<string> {
  return await getOrCreateSecret(env, "GITHUB_APP_MANIFEST_SIGNING_KEY", () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  });
}
