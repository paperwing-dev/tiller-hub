import type { Env } from "./types";

export const CLOUDFLARE_API_MCP_INTEGRATION_ID = "cloudflare_api";
export const CLOUDFLARE_API_MCP_SERVER_ID = "tiller_cloudflare_api";
export const CLOUDFLARE_MCP_PROXY_TOKEN_HEADER = "X-Tiller-MCP-Proxy-Token";
export const CLOUDFLARE_MCP_PROXY_TOKEN_ENV_VAR = "TILLER_CLOUDFLARE_MCP_PROXY_TOKEN";

export const CLOUDFLARE_MCP_PROXY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
export const CLOUDFLARE_MCP_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const CLOUDFLARE_MCP_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const cloudflareApiConnector = {
  integrationId: CLOUDFLARE_API_MCP_INTEGRATION_ID,
  serverId: CLOUDFLARE_API_MCP_SERVER_ID,
  label: "Cloudflare API",
  mcpUrl: "https://mcp.cloudflare.com/mcp",
  resource: "https://mcp.cloudflare.com",
  issuer: "https://mcp.cloudflare.com",
  authorizationEndpoint: "https://mcp.cloudflare.com/authorize",
  tokenEndpoint: "https://mcp.cloudflare.com/token",
  registrationEndpoint: "https://mcp.cloudflare.com/register",
} as const;

export type CloudflareMcpConnectionStatus = "not_connected" | "connected" | "reauth_required";

export interface CloudflareMcpStatus {
  integrationId: string;
  serverId: string;
  label: string;
  mcpUrl: string;
  status: CloudflareMcpConnectionStatus;
  connected: boolean;
  enabled: boolean;
  scopes: string[];
  expiresAt: number | null;
  account: { id: string | null; name: string | null } | null;
  lastAuthError: string | null;
  lastAuthErrorAt: string | null;
}

export interface CloudflareMcpOAuthClient {
  clientId: string;
  clientSecret?: string | null;
}

export interface CloudflareMcpTokenResponse {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

export interface CloudflareMcpStoredSecrets {
  accessToken: string;
  refreshToken: string;
}

export interface CloudflareMcpAccessTokenResult {
  accessToken: string;
}

export type CloudflareMcpLaunchTokenValidation = {
  ok: true;
  repoId: string;
  envSlug: string;
  serverId: string;
} | {
  ok: false;
  code: "cloudflare_proxy_auth_failed";
};

export interface CloudflareMcpProxyAuditEvent {
  repoId: string;
  envSlug: string;
  serverId: string;
  httpMethod: string;
  jsonRpcMethod: string | null;
  responseStatus: number;
  errorCode: string | null;
}

export interface CloudflareMcpProxyHub {
  validateCloudflareMcpProxyToken(token: string): Promise<CloudflareMcpLaunchTokenValidation>;
  getValidCloudflareMcpAccessToken(repoId: string, options?: { forceRefresh?: boolean }): Promise<CloudflareMcpAccessTokenResult>;
  recordCloudflareMcpAuditEvent(event: CloudflareMcpProxyAuditEvent): void | Promise<void>;
}

export class CloudflareMcpUserError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "CloudflareMcpUserError";
    this.status = status;
    this.code = code;
  }
}

export function isCloudflareMcpReauthRequired(error: unknown): boolean {
  return error instanceof CloudflareMcpUserError && error.code === "cloudflare_reauth_required";
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlRandom(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readEnvString(env: Env, name: string): string | null {
  const value = (env as unknown as Record<string, unknown>)[name];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseScopes(value: string | null | undefined): string[] {
  if (!value?.trim()) return [];
  if (value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) {
        return [...new Set(parsed.filter((scope): scope is string => typeof scope === "string" && Boolean(scope.trim())).map((scope) => scope.trim()))];
      }
    } catch {
      return [];
    }
  }
  return [...new Set(value.split(/\s+/).map((scope) => scope.trim()).filter(Boolean))];
}

export function createCloudflareMcpStatus(input: {
  enabled?: boolean;
  scopes?: string[] | string | null;
  expiresAt?: number | null;
  accountId?: string | null;
  accountName?: string | null;
  lastAuthError?: string | null;
  lastAuthErrorAt?: string | null;
} | null): CloudflareMcpStatus {
  const connected = Boolean(input);
  const lastAuthError = input?.lastAuthError?.trim() || null;
  const scopes = Array.isArray(input?.scopes)
    ? input.scopes
    : parseScopes(typeof input?.scopes === "string" ? input.scopes : null);
  const accountId = input?.accountId?.trim() || null;
  const accountName = input?.accountName?.trim() || null;

  return {
    integrationId: cloudflareApiConnector.integrationId,
    serverId: cloudflareApiConnector.serverId,
    label: cloudflareApiConnector.label,
    mcpUrl: cloudflareApiConnector.mcpUrl,
    status: !connected ? "not_connected" : lastAuthError ? "reauth_required" : "connected",
    connected,
    enabled: Boolean(input?.enabled) && connected && !lastAuthError,
    scopes,
    expiresAt: input?.expiresAt ?? null,
    account: accountId || accountName ? { id: accountId, name: accountName } : null,
    lastAuthError,
    lastAuthErrorAt: input?.lastAuthErrorAt ?? null,
  };
}

export function buildCloudflareMcpRedirectUri(origin: string, repoId: string): string {
  return `${origin.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repoId)}/cloudflare-mcp/callback`;
}

export function getCloudflareMcpRequestIdentity(request: Request): string | null {
  const email = request.headers.get("Cf-Access-Authenticated-User-Email")?.trim()
    || request.headers.get("CF-Access-Authenticated-User-Email")?.trim()
    || "";
  if (email) return `cf-access-email:${email.toLowerCase()}`;

  const jwt = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(parts[1]))) as Record<string, unknown>;
    const sub = typeof payload.sub === "string" ? payload.sub.trim() : "";
    return sub ? `cf-access-sub:${sub}` : null;
  } catch {
    return null;
  }
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  return Uint8Array.from(atob(normalized + padding), (char) => char.charCodeAt(0));
}

export async function createCloudflareMcpPkcePair(): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64UrlRandom(32);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: bytesToBase64Url(new Uint8Array(digest)) };
}

export function createCloudflareMcpOAuthState(): string {
  return `cfmcp_${base64UrlRandom(32)}`;
}

export function resolveConfiguredCloudflareMcpOAuthClient(env: Env): CloudflareMcpOAuthClient | null {
  const clientId = readEnvString(env, "CLOUDFLARE_MCP_OAUTH_CLIENT_ID");
  if (!clientId) return null;
  return {
    clientId,
    clientSecret: readEnvString(env, "CLOUDFLARE_MCP_OAUTH_CLIENT_SECRET"),
  };
}

export async function registerCloudflareMcpOAuthClient(args: {
  redirectUri: string;
  hubOrigin: string;
  fetcher?: typeof fetch;
}): Promise<CloudflareMcpOAuthClient> {
  const fetcher = args.fetcher ?? fetch;
  let response: Response;
  try {
    response = await fetcher(cloudflareApiConnector.registrationEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      redirect: "manual",
      body: JSON.stringify({
        client_name: "Tiller Cloudflare API MCP",
        client_uri: args.hubOrigin,
        redirect_uris: [args.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      }),
    });
  } catch {
    throw new CloudflareMcpUserError(502, "cloudflare_oauth_registration_failed", "Cloudflare OAuth client registration failed.");
  }

  if (!response.ok) {
    throw new CloudflareMcpUserError(502, "cloudflare_oauth_registration_failed", "Cloudflare OAuth client registration failed.");
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload) || !readString(payload.client_id)?.trim()) {
    throw new CloudflareMcpUserError(502, "cloudflare_oauth_registration_failed", "Cloudflare OAuth client registration response was incomplete.");
  }
  return {
    clientId: readString(payload.client_id)!.trim(),
    clientSecret: readString(payload.client_secret)?.trim() || null,
  };
}

export function buildCloudflareMcpAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  pkceChallenge: string;
  scope?: string | null;
}): string {
  const url = new URL(cloudflareApiConnector.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", args.clientId);
  url.searchParams.set("redirect_uri", args.redirectUri);
  url.searchParams.set("state", args.state);
  url.searchParams.set("code_challenge", args.pkceChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("resource", cloudflareApiConnector.resource);
  if (args.scope?.trim()) {
    url.searchParams.set("scope", args.scope.trim());
  }
  return url.toString();
}

export async function exchangeCloudflareMcpOAuthCode(args: {
  client: CloudflareMcpOAuthClient;
  code: string;
  redirectUri: string;
  pkceVerifier: string;
  fetcher?: typeof fetch;
}): Promise<CloudflareMcpTokenResponse> {
  return await requestCloudflareMcpToken({
    client: args.client,
    fetcher: args.fetcher,
    params: {
      grant_type: "authorization_code",
      code: args.code,
      redirect_uri: args.redirectUri,
      code_verifier: args.pkceVerifier,
      resource: cloudflareApiConnector.resource,
    },
  });
}

export async function refreshCloudflareMcpOAuthToken(args: {
  client: CloudflareMcpOAuthClient;
  refreshToken: string;
  fetcher?: typeof fetch;
}): Promise<CloudflareMcpTokenResponse> {
  return await requestCloudflareMcpToken({
    client: args.client,
    fetcher: args.fetcher,
    params: {
      grant_type: "refresh_token",
      refresh_token: args.refreshToken,
      resource: cloudflareApiConnector.resource,
    },
  });
}

async function requestCloudflareMcpToken(args: {
  client: CloudflareMcpOAuthClient;
  params: Record<string, string>;
  fetcher?: typeof fetch;
}): Promise<CloudflareMcpTokenResponse> {
  const fetcher = args.fetcher ?? fetch;
  const body = new URLSearchParams({
    client_id: args.client.clientId,
    ...args.params,
  });
  if (args.client.clientSecret) {
    body.set("client_secret", args.client.clientSecret);
  }

  let response: Response;
  try {
    response = await fetcher(cloudflareApiConnector.tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      redirect: "manual",
      body: body.toString(),
    });
  } catch {
    throw new CloudflareMcpUserError(502, "cloudflare_upstream_error", "Cloudflare OAuth token endpoint is unavailable.");
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    const oauthError = isRecord(payload) ? readString(payload.error)?.trim() || null : null;
    const isDefinitiveAuthFailure = (response.status === 400 || response.status === 401)
      && (
        oauthError === "invalid_grant"
        || oauthError === "invalid_client"
        || oauthError === "unauthorized_client"
      );
    if (isDefinitiveAuthFailure) {
      throw new CloudflareMcpUserError(401, "cloudflare_reauth_required", "Cloudflare authorization failed. Reconnect Cloudflare API MCP.");
    }
    throw new CloudflareMcpUserError(502, "cloudflare_upstream_error", "Cloudflare OAuth token endpoint is unavailable.");
  }
  const payload = await response.json().catch(() => null);
  if (!isRecord(payload) || !readString(payload.access_token)?.trim()) {
    throw new CloudflareMcpUserError(502, "cloudflare_oauth_token_invalid", "Cloudflare OAuth token response was incomplete.");
  }
  return {
    access_token: readString(payload.access_token)!.trim(),
    refresh_token: readString(payload.refresh_token)?.trim() || undefined,
    token_type: readString(payload.token_type)?.trim() || "Bearer",
    expires_in: readFiniteNumber(payload.expires_in) ?? undefined,
    scope: readString(payload.scope)?.trim() || undefined,
  };
}

export async function fetchCloudflareMcpAccountMetadata(
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string | null; name: string | null } | null> {
  try {
    const response = await fetcher("https://api.cloudflare.com/client/v4/accounts?per_page=1", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
      redirect: "manual",
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const result = isRecord(payload) && Array.isArray(payload.result) ? payload.result[0] : null;
    if (!isRecord(result)) return null;
    return {
      id: readString(result.id)?.trim() || null,
      name: readString(result.name)?.trim() || null,
    };
  } catch {
    return null;
  }
}

export function buildStoredCloudflareMcpTokenFields(args: {
  tokens: CloudflareMcpTokenResponse;
  previousRefreshToken?: string | null;
}): {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scopes: string[];
  expiresAt: number;
} {
  const accessToken = args.tokens.access_token?.trim();
  const refreshToken = args.tokens.refresh_token?.trim() || args.previousRefreshToken?.trim();
  if (!accessToken || !refreshToken) {
    throw new CloudflareMcpUserError(502, "cloudflare_oauth_token_invalid", "Cloudflare OAuth token response was incomplete.");
  }
  const expiresIn = Number.isFinite(args.tokens.expires_in) && (args.tokens.expires_in ?? 0) > 0
    ? args.tokens.expires_in!
    : 3600;
  return {
    accessToken,
    refreshToken,
    tokenType: args.tokens.token_type?.trim() || "Bearer",
    scopes: parseScopes(args.tokens.scope),
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

export function createCloudflareMcpProxyToken(): string {
  return `tcmpt_${base64UrlRandom(32)}`;
}

export async function hashCloudflareMcpProxyToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return bytesToBase64Url(new Uint8Array(digest));
}

const SAFE_RETRY_JSON_RPC_METHODS = new Set([
  "initialize",
  "ping",
  "tools/list",
  "prompts/list",
  "resources/list",
]);

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const SENSITIVE_INBOUND_HEADERS = new Set([
  "authorization",
  "cookie",
  "cf-access-jwt-assertion",
  "cf-access-authenticated-user-email",
  "cf-access-client-id",
  "cf-access-client-secret",
  "x-tiller-mcp-proxy-token",
]);

const SENSITIVE_RESPONSE_HEADERS = new Set([
  "www-authenticate",
  "set-cookie",
  "location",
]);

function parseJsonRpcPostBody(bodyText: string): {
  ok: true;
  id: unknown;
  hasId: boolean;
  method: string;
  retrySafe: boolean;
} | {
  ok: false;
  status: number;
  code: string;
  message: string;
  id?: unknown;
  hasId?: boolean;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { ok: false, status: 400, code: "cloudflare_upstream_error", message: "Malformed JSON-RPC request." };
  }
  if (Array.isArray(parsed)) {
    return { ok: false, status: 400, code: "cloudflare_retry_not_safe", message: "Batch JSON-RPC requests are not supported by this proxy." };
  }
  if (!isRecord(parsed)) {
    return { ok: false, status: 400, code: "cloudflare_upstream_error", message: "JSON-RPC request must be an object." };
  }
  const hasId = Object.prototype.hasOwnProperty.call(parsed, "id");
  const idIsValid = !hasId
    || parsed.id === null
    || typeof parsed.id === "string"
    || typeof parsed.id === "number";
  const errorContext = hasId && idIsValid
    ? { id: parsed.id, hasId }
    : {};
  if (hasId && !idIsValid) {
    return {
      ok: false,
      status: 400,
      code: "cloudflare_upstream_error",
      message: "JSON-RPC request id is invalid.",
    };
  }
  if (parsed.jsonrpc !== "2.0") {
    return {
      ok: false,
      status: 400,
      code: "cloudflare_upstream_error",
      message: "JSON-RPC version is invalid.",
      ...errorContext,
    };
  }
  const method = readString(parsed.method)?.trim();
  if (!method) {
    return {
      ok: false,
      status: 400,
      code: "cloudflare_upstream_error",
      message: "JSON-RPC request method is invalid.",
      ...errorContext,
    };
  }
  if (
    Object.prototype.hasOwnProperty.call(parsed, "params")
    && parsed.params !== undefined
    && !Array.isArray(parsed.params)
    && !isRecord(parsed.params)
  ) {
    return {
      ok: false,
      status: 400,
      code: "cloudflare_upstream_error",
      message: "JSON-RPC request params are invalid.",
      ...errorContext,
    };
  }
  return {
    ok: true,
    id: hasId ? parsed.id : null,
    hasId,
    method,
    retrySafe: hasId && SAFE_RETRY_JSON_RPC_METHODS.has(method),
  };
}

function httpError(status: number, code: string, message: string): Response {
  return Response.json({ error: message, code }, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function jsonRpcError(id: unknown, code: string, message: string): Response {
  return Response.json({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32000,
      message,
      data: { code },
    },
  }, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function postErrorResponse(
  parsed: { id?: unknown; hasId?: boolean },
  status: number,
  code: string,
  message: string,
): Response {
  return parsed.hasId ? jsonRpcError(parsed.id, code, message) : httpError(status, code, message);
}

function proxyAccessTokenError(error: unknown): { status: number; code: string; message: string } {
  if (isCloudflareMcpReauthRequired(error)) {
    return {
      status: 401,
      code: "cloudflare_reauth_required",
      message: "Cloudflare API MCP requires reconnect.",
    };
  }
  return {
    status: 502,
    code: "cloudflare_upstream_error",
    message: "Cloudflare API MCP authorization is temporarily unavailable.",
  };
}

type ProxyErrorDetails = { status: number; code: string; message: string };
type PostErrorContext = { id?: unknown; hasId?: boolean };

function proxyErrorResponse(details: ProxyErrorDetails, postContext?: PostErrorContext): Response {
  return postContext
    ? postErrorResponse(postContext, details.status, details.code, details.message)
    : httpError(details.status, details.code, details.message);
}

function buildUpstreamHeaders(request: Request, accessToken: string): Headers {
  const headers = new Headers();
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || SENSITIVE_INBOUND_HEADERS.has(lower) || lower.startsWith("cf-access-")) continue;
    if (
      lower === "accept"
      || lower === "content-type"
      || lower === "mcp-session-id"
      || lower === "mcp-protocol-version"
      || lower === "last-event-id"
    ) {
      headers.set(name, value);
    }
  }
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function sanitizeResponseHeaders(upstreamHeaders: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstreamHeaders) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower) || SENSITIVE_RESPONSE_HEADERS.has(lower)) continue;
    if (
      lower === "content-type"
      || lower === "cache-control"
      || lower === "mcp-session-id"
      || lower === "mcp-protocol-version"
    ) {
      headers.set(name, value);
    }
  }
  headers.set("Cache-Control", "no-store");
  return headers;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function mapProxyUpstreamResponse(upstream: Response): ProxyErrorDetails | null {
  if (isRedirectStatus(upstream.status)) {
    return {
      status: 502,
      code: "cloudflare_upstream_redirect",
      message: "Cloudflare API MCP returned an unexpected redirect.",
    };
  }
  if (!upstream.ok) {
    if (upstream.status === 401) {
      return {
        status: 401,
        code: "cloudflare_reauth_required",
        message: "Cloudflare API MCP requires reconnect.",
      };
    }
    return {
      status: 502,
      code: "cloudflare_upstream_error",
      message: "Cloudflare API MCP returned an upstream error.",
    };
  }
  return null;
}

function proxySuccessResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: sanitizeResponseHeaders(upstream.headers),
  });
}

async function recordAudit(
  hub: CloudflareMcpProxyHub,
  validation: Extract<CloudflareMcpLaunchTokenValidation, { ok: true }>,
  request: Request,
  response: Response,
  jsonRpcMethod: string | null,
  errorCode: string | null,
): Promise<Response> {
  await hub.recordCloudflareMcpAuditEvent({
    repoId: validation.repoId,
    envSlug: validation.envSlug,
    serverId: validation.serverId,
    httpMethod: request.method,
    jsonRpcMethod,
    responseStatus: response.status,
    errorCode,
  });
  return response;
}

async function finalizeAuditedProxyError(
  hub: CloudflareMcpProxyHub,
  validation: Extract<CloudflareMcpLaunchTokenValidation, { ok: true }>,
  request: Request,
  details: ProxyErrorDetails,
  jsonRpcMethod: string | null,
  postContext?: PostErrorContext,
): Promise<Response> {
  return recordAudit(
    hub,
    validation,
    request,
    proxyErrorResponse(details, postContext),
    jsonRpcMethod,
    details.code,
  );
}

async function getProxyAccessToken(
  hub: CloudflareMcpProxyHub,
  repoId: string,
  forceRefresh = false,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: ProxyErrorDetails }> {
  try {
    return { ok: true, accessToken: (await hub.getValidCloudflareMcpAccessToken(repoId, { forceRefresh })).accessToken };
  } catch (error) {
    return { ok: false, error: proxyAccessTokenError(error) };
  }
}

async function fetchUpstream(
  request: Request,
  accessToken: string,
  bodyText?: string,
): Promise<{ ok: true; upstream: Response } | { ok: false; error: ProxyErrorDetails }> {
  try {
    return {
      ok: true,
      upstream: await fetch(cloudflareApiConnector.mcpUrl, {
        method: request.method,
        headers: buildUpstreamHeaders(request, accessToken),
        redirect: "manual",
        body: request.method === "POST" ? bodyText ?? "" : undefined,
      }),
    };
  } catch {
    return {
      ok: false,
      error: {
        status: 502,
        code: "cloudflare_upstream_error",
        message: "Cloudflare API MCP returned an upstream error.",
      },
    };
  }
}

export async function proxyCloudflareMcpRequest(
  request: Request,
  hub: CloudflareMcpProxyHub,
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return httpError(405, "cloudflare_upstream_error", "Method not allowed.");
  }

  const proxyToken = request.headers.get(CLOUDFLARE_MCP_PROXY_TOKEN_HEADER)?.trim() ?? "";
  if (!proxyToken) {
    return httpError(401, "cloudflare_proxy_auth_failed", "Cloudflare MCP proxy token is missing or invalid.");
  }

  const validation = await hub.validateCloudflareMcpProxyToken(proxyToken);
  if (!validation.ok) {
    return httpError(401, "cloudflare_proxy_auth_failed", "Cloudflare MCP proxy token is missing or invalid.");
  }

  if (request.method === "POST") {
    const bodyText = await request.text();
    const parsed = parseJsonRpcPostBody(bodyText);
    if (!parsed.ok) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        { status: parsed.status, code: parsed.code, message: parsed.message },
        null,
        parsed,
      );
    }

    const token = await getProxyAccessToken(hub, validation.repoId);
    if (!token.ok) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        token.error,
        parsed.method,
        parsed,
      );
    }
    let upstreamResult = await fetchUpstream(request, token.accessToken, bodyText);
    if (!upstreamResult.ok) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        upstreamResult.error,
        parsed.method,
        parsed,
      );
    }
    let upstream = upstreamResult.upstream;

    const initialRedirect = mapProxyUpstreamResponse(upstream);
    if (initialRedirect?.code === "cloudflare_upstream_redirect") {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        initialRedirect,
        parsed.method,
        parsed,
      );
    }

    if (upstream.status === 401) {
      if (!parsed.retrySafe) {
        await getProxyAccessToken(hub, validation.repoId, true);
        return finalizeAuditedProxyError(
          hub,
          validation,
          request,
          {
            status: 401,
            code: "cloudflare_retry_not_safe",
            message: "Cloudflare API MCP authorization failed and retry is not safe for this request.",
          },
          parsed.method,
          parsed,
        );
      }
      const refreshed = await getProxyAccessToken(hub, validation.repoId, true);
      if (!refreshed.ok) {
        return finalizeAuditedProxyError(
          hub,
          validation,
          request,
          refreshed.error,
          parsed.method,
          parsed,
        );
      }
      upstreamResult = await fetchUpstream(request, refreshed.accessToken, bodyText);
      if (!upstreamResult.ok) {
        return finalizeAuditedProxyError(
          hub,
          validation,
          request,
          upstreamResult.error,
          parsed.method,
          parsed,
        );
      }
      upstream = upstreamResult.upstream;
    }

    const upstreamError = mapProxyUpstreamResponse(upstream);
    if (upstreamError) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        upstreamError,
        parsed.method,
        parsed,
      );
    }
    return recordAudit(hub, validation, request, proxySuccessResponse(upstream), parsed.method, null);
  }

  if (request.method === "GET") {
    const token = await getProxyAccessToken(hub, validation.repoId);
    if (!token.ok) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        token.error,
        null,
      );
    }
    let upstreamResult = await fetchUpstream(request, token.accessToken);
    if (!upstreamResult.ok) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        upstreamResult.error,
        null,
      );
    }
    let upstream = upstreamResult.upstream;

    if (upstream.status === 401) {
      const refreshed = await getProxyAccessToken(hub, validation.repoId, true);
      if (!refreshed.ok) {
        return finalizeAuditedProxyError(
          hub,
          validation,
          request,
          refreshed.error,
          null,
        );
      }
      upstreamResult = await fetchUpstream(request, refreshed.accessToken);
      if (!upstreamResult.ok) {
        return finalizeAuditedProxyError(
          hub,
          validation,
          request,
          upstreamResult.error,
          null,
        );
      }
      upstream = upstreamResult.upstream;
    }

    const upstreamError = mapProxyUpstreamResponse(upstream);
    if (upstreamError) {
      return finalizeAuditedProxyError(
        hub,
        validation,
        request,
        upstreamError,
        null,
      );
    }
    return recordAudit(hub, validation, request, proxySuccessResponse(upstream), null, null);
  }

  const token = await getProxyAccessToken(hub, validation.repoId, true);
  if (!token.ok) {
    return finalizeAuditedProxyError(
      hub,
      validation,
      request,
      token.error,
      null,
    );
  }
  const upstreamResult = await fetchUpstream(request, token.accessToken);
  if (!upstreamResult.ok) {
    return finalizeAuditedProxyError(
      hub,
      validation,
      request,
      upstreamResult.error,
      null,
    );
  }
  const upstreamError = mapProxyUpstreamResponse(upstreamResult.upstream);
  if (upstreamError) {
    return finalizeAuditedProxyError(
      hub,
      validation,
      request,
      upstreamError,
      null,
    );
  }
  return recordAudit(hub, validation, request, new Response(null, {
    status: 204,
    headers: sanitizeResponseHeaders(upstreamResult.upstream.headers),
  }), null, null);
}
