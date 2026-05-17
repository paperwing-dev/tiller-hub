import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { createMiddleware } from "hono/factory";
import type { HonoEnv, Env } from "./types";
import { getSecret, invalidateConfigCache } from "./setup/config";
import { getLocationHintOptions } from "./helpers";
import {
  getRouteKind,
  resolveProtectionState,
  isLocalDevRequest,
  type ProtectionState,
} from "./protection";
import { requiresWorkersDevAccessProtection } from "./setup/protect-hub";
import { readSelfHostState } from "./self-host/state";

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getRemoteJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(url);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksCache.set(url, jwks);
  return jwks;
}

export function accessCertsUrl(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/cdn-cgi/access/certs`;
}

export function normalizeAccessUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function normalizeCloudflareAccessIssuer(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) return "";

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return "";
  }

  if (url.protocol !== "https:") return "";
  if (url.username || url.password || url.port || url.search || url.hash) return "";
  if (url.pathname && url.pathname !== "/") return "";
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/i.test(url.hostname)) return "";
  return `https://${url.hostname.toLowerCase()}`;
}

function inferSingleAudience(payload: JWTPayload): string {
  const aud = payload.aud;
  if (typeof aud === "string") return aud.trim();
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === "string") {
    return aud[0].trim();
  }
  return "";
}

function assertAccessAppPayload(payload: JWTPayload): void {
  if ((payload as Record<string, unknown>).type !== "app") {
    throw new Error("JWT is not a Cloudflare Access application token");
  }
}

export function inferCloudflareAccessJwtConfig(token: string): {
  audience: string;
  issuer: string;
} {
  let payload: JWTPayload;
  try {
    payload = decodeJwt(token);
  } catch {
    throw new Error("Malformed JWT");
  }

  const issuer = normalizeCloudflareAccessIssuer(payload.iss);
  if (!issuer) {
    throw new Error("JWT issuer is not a Cloudflare Access team domain");
  }
  assertAccessAppPayload(payload);

  const audience = inferSingleAudience(payload);
  if (!audience) {
    throw new Error("JWT must contain exactly one Access audience");
  }

  return { audience, issuer };
}

async function resolveAccessJwtValidationConfig(env: Env): Promise<{
  audience: string;
  issuer: string | null;
  jwksUrl: string | null;
}> {
  const audience = (await getSecret(env, "CF_ACCESS_AUD"))?.trim() ?? "";
  if (!audience) throw new Error("CF_ACCESS_AUD not configured");
  const issuer = normalizeAccessUrl((await getSecret(env, "CF_ACCESS_TEAM_DOMAIN")) ?? "") || null;
  const jwksUrl = normalizeAccessUrl((await getSecret(env, "CF_ACCESS_JWKS_URL")) ?? "")
    || (issuer ? accessCertsUrl(issuer) : null);
  return { audience, issuer, jwksUrl };
}

function assertAudience(payload: JWTPayload, audience: string): void {
  const aud = payload.aud;
  const valid = Array.isArray(aud)
    ? aud.includes(audience)
    : aud === audience;
  if (!valid) throw new Error("Invalid audience");
}

export async function verifyCloudflareAccessToken(
  token: string,
  validation: {
    audience: string;
    issuer: string | null;
    jwksUrl: string | null;
  },
): Promise<JWTPayload> {
  if (!validation.jwksUrl) {
    throw new Error("Cloudflare Access JWT verification config is not configured");
  }

  try {
    const verified = await jwtVerify(token, getRemoteJwks(validation.jwksUrl), {
      audience: validation.audience,
      ...(validation.issuer ? { issuer: validation.issuer } : {}),
    });
    assertAccessAppPayload(verified.payload);
    assertAudience(verified.payload, validation.audience);
    return verified.payload;
  } catch {
    throw new Error("Invalid JWT");
  }
}

export async function verifyInferredCloudflareAccessToken(
  token: string,
  config: { audience: string; issuer: string },
): Promise<void> {
  await verifyCloudflareAccessToken(token, {
    audience: config.audience,
    issuer: config.issuer,
    jwksUrl: accessCertsUrl(config.issuer),
  });
}

/**
 * Verify the CF Access JWT assertion.
 *
 * Require full JWT verification when Access is configured. Audience-only JWT
 * checks are not sufficient because a Worker may still be reachable outside the
 * Access application during route cutovers.
 */
export async function verifyCfAccessJwt(request: Request, env: Env): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");

  try {
    decodeJwt(token);
  } catch {
    throw new Error("Malformed JWT");
  }

  const validation = await resolveAccessJwtValidationConfig(env);
  await verifyCloudflareAccessToken(token, validation);
}

export async function verifyCfAccessServiceToken(request: Request, env: Env): Promise<void> {
  const clientId = request.headers.get("CF-Access-Client-Id")?.trim() ?? "";
  const clientSecret = request.headers.get("CF-Access-Client-Secret")?.trim() ?? "";
  if (!clientId || !clientSecret) {
    throw new Error("Missing Cloudflare Access service token");
  }

  const expectedClientId = (await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim() ?? "";
  const expectedClientSecret = (await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim() ?? "";
  if (!expectedClientId || !expectedClientSecret) {
    throw new Error("Cloudflare Access service token is not configured");
  }
  if (clientId !== expectedClientId || clientSecret !== expectedClientSecret) {
    throw new Error("Invalid Cloudflare Access service token");
  }
}

export async function maybeVerifyCfAccessRequest(request: Request, env: Env): Promise<void> {
  const protection = await resolveProtectionState(env, request.url);
  if (protection.protectionMode !== "cf-access") return;
  if (isLocalDevRequest(env, request)) return;
  if (request.headers.get("Cf-Access-Jwt-Assertion")) {
    await verifyCfAccessJwt(request, env);
    return;
  }
  await verifyCfAccessServiceToken(request, env);
}

export async function resolveAuthGuardState(
  request: Request,
  env: Env,
): Promise<{
  isLocalDev: boolean;
  protection: ProtectionState;
  protectHubRequired: boolean;
}> {
  const isLocalDev = isLocalDevRequest(env, request);
  const protection = await resolveProtectionState(env, request.url);
  const currentRouteKind = getRouteKind(request.url);
  return {
    isLocalDev,
    protection,
    protectHubRequired: requiresWorkersDevAccessProtection({
      isLocalDev,
      currentRouteKind,
      accessConfigured: protection.accessConfigured,
    }),
  };
}

type RouteAuthMode =
  | "normal"
  | "public"
  | "browser-jwt"
  | "self-host-pending-custom-jwt"
  | "workers-dev-browser"
  | "service-token";

interface RouteAuthPolicy {
  path: string;
  method?: string;
  mode: RouteAuthMode;
  protectHubAllowlisted?: boolean;
  workersDevRollback?: boolean;
}

type WorkersDevAccessConfigStore = {
  claimWorkersDevAccessConfig(input: {
    audience: string;
    teamDomain: string;
  }): {
    claimed: boolean;
    audience: string | null;
    teamDomain: string | null;
  } | Promise<{
    claimed: boolean;
    audience: string | null;
    teamDomain: string | null;
  }>;
};

function getWorkersDevAccessConfigStore(env: Env): WorkersDevAccessConfigStore | null {
  const namespace = (env as unknown as {
    HUB?: {
      idFromName(name: string): unknown;
      get(id: unknown, options?: unknown): unknown;
    };
  }).HUB;
  if (!namespace) return null;
  const id = namespace.idFromName("hub");
  return namespace.get(id, getLocationHintOptions(env)) as WorkersDevAccessConfigStore;
}

async function tryClaimWorkersDevAccessConfigFromJwt(request: Request, env: Env): Promise<boolean> {
  if (getRouteKind(request.url) !== "workers-dev") return false;
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) return false;

  const store = getWorkersDevAccessConfigStore(env);
  if (!store) return false;

  try {
    const inferred = inferCloudflareAccessJwtConfig(token);
    await verifyInferredCloudflareAccessToken(token, inferred);
    const claim = await store.claimWorkersDevAccessConfig({
      audience: inferred.audience,
      teamDomain: inferred.issuer,
    });
    if (!claim.claimed) return false;
    invalidateConfigCache();
    return true;
  } catch {
    return false;
  }
}

const ROUTE_AUTH_POLICIES: RouteAuthPolicy[] = [
  { path: "/health", mode: "public", protectHubAllowlisted: true },
  { path: "/api/setup/status", method: "GET", mode: "normal", protectHubAllowlisted: true, workersDevRollback: true },
  { path: "/api/setup/workers-dev-access", method: "POST", mode: "normal", protectHubAllowlisted: true },
  { path: "/api/setup/verify-cloudflare-token", method: "POST", mode: "public" },
  { path: "/cli/self-host-setup", method: "GET", mode: "workers-dev-browser", workersDevRollback: true },
  { path: "/api/setup/self-host/prepare", method: "POST", mode: "workers-dev-browser", workersDevRollback: true },
  { path: "/cli/self-host-promote", method: "GET", mode: "self-host-pending-custom-jwt" },
  { path: "/api/setup/self-host/promote", method: "POST", mode: "self-host-pending-custom-jwt" },
  { path: "/api/setup/self-host/progress", method: "POST", mode: "service-token" },
  { path: "/api/setup/self-host/lifecycle", method: "GET", mode: "browser-jwt" },
  { path: "/api/setup/self-host/enable", method: "POST", mode: "service-token" },
  { path: "/api/setup/self-host/return-to-hosted", method: "POST", mode: "workers-dev-browser", workersDevRollback: true },
];

function resolveRouteAuthPolicy(path: string, method: string): RouteAuthPolicy {
  return ROUTE_AUTH_POLICIES.find((policy) => {
    return policy.path === path && (!policy.method || policy.method === method);
  }) ?? { path, method, mode: "normal" };
}

export async function verifyWorkersDevRollbackAccess(request: Request, env: Env): Promise<void> {
  if (getRouteKind(request.url) !== "workers-dev") {
    throw new Error("workers.dev rollback Access only applies to workers.dev requests");
  }
  const state = await readSelfHostState(env);
  if (!state || (state.phase !== "promoted" && state.phase !== "enabled")) {
    throw new Error("No promoted or enabled Self Host state is available for workers.dev rollback");
  }
  const rollback = state?.rollback.browserAccess;
  if (!rollback) {
    throw new Error("Workers.dev rollback Access metadata is not available");
  }

  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) {
    throw new Error("Missing Cf-Access-Jwt-Assertion");
  }
  const audience = rollback.aud.trim();
  const issuer = normalizeAccessUrl(rollback.issuer ?? "");
  const jwksUrl = normalizeAccessUrl(rollback.jwksUrl ?? "") || (issuer ? accessCertsUrl(issuer) : "");
  if (!audience || !jwksUrl) {
    throw new Error("Workers.dev rollback Access metadata is incomplete");
  }
  await verifyCloudflareAccessToken(token, {
    audience,
    issuer: issuer || null,
    jwksUrl,
  });
}

async function tryVerifyWorkersDevRollbackAccess(request: Request, env: Env): Promise<boolean> {
  try {
    await verifyWorkersDevRollbackAccess(request, env);
    return true;
  } catch {
    return false;
  }
}

function setupProtectionRequiredResponse(): Response {
  return Response.json({
    error: "Protect this hub with Cloudflare Access before using the API.",
    code: "setup_protection_required",
    setupPhase: "protect-hub",
  }, { status: 403 });
}

function unauthorizedResponse(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

function isPublicSetupApiAllowed(path: string, method: string): boolean {
  return (path === "/api/setup/status" && method === "GET")
    || (path === "/api/setup/verify-cloudflare-token" && method === "POST");
}

export async function hubAuthGuardResponse(
  request: Request,
  env: Env,
  options: { skipNormalAuthForWebSocket?: boolean } = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const policy = resolveRouteAuthPolicy(path, request.method);
  if (policy.mode === "public") return null;
  if (policy.mode === "self-host-pending-custom-jwt") return null;

  const state = await resolveAuthGuardState(request, env);
  if (state.protectHubRequired) {
    if (policy.protectHubAllowlisted) {
      await tryClaimWorkersDevAccessConfigFromJwt(request, env);
      return null;
    }
    if (await tryClaimWorkersDevAccessConfigFromJwt(request, env)) return null;
    return setupProtectionRequiredResponse();
  }

  if (state.isLocalDev) return null;

  if (policy.mode === "browser-jwt") {
    if (!request.headers.get("Cf-Access-Jwt-Assertion")?.trim()) {
      return unauthorizedResponse();
    }
    try {
      await verifyCfAccessJwt(request, env);
      return null;
    } catch {
      return unauthorizedResponse();
    }
  }

  if (policy.mode === "service-token") {
    try {
      await verifyCfAccessServiceToken(request, env);
      return null;
    } catch {
      return unauthorizedResponse();
    }
  }

  if (
    policy.mode === "workers-dev-browser"
    && getRouteKind(request.url) === "workers-dev"
    && !request.headers.get("Cf-Access-Jwt-Assertion")?.trim()
  ) {
    return unauthorizedResponse();
  }

  if (
    policy.workersDevRollback
    && await tryVerifyWorkersDevRollbackAccess(request, env)
  ) {
    return null;
  }

  if (
    policy.workersDevRollback
    && getRouteKind(request.url) === "workers-dev"
    && !request.headers.get("Cf-Access-Jwt-Assertion")?.trim()
    && (
      request.headers.get("CF-Access-Client-Id")?.trim()
      || request.headers.get("CF-Access-Client-Secret")?.trim()
    )
  ) {
    const selfHostState = await readSelfHostState(env);
    if (selfHostState?.phase === "promoted" || selfHostState?.phase === "enabled") {
      return unauthorizedResponse();
    }
  }

  if (options.skipNormalAuthForWebSocket && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return null;
  }

  if (state.protection.protectionMode !== "cf-access") {
    if (path.startsWith("/api/setup") && !isPublicSetupApiAllowed(path, request.method)) {
      return unauthorizedResponse();
    }
    return null;
  }

  try {
    await maybeVerifyCfAccessRequest(request, env);
    return null;
  } catch {
    return unauthorizedResponse();
  }
}

export const dynamicEntrypointAuthResponse = hubAuthGuardResponse;

/**
 * Hono middleware — verifies CF Access JWT.
 * Skips /health and WebSocket upgrades (WS auth happens in onConnect).
 * Public hubs skip auth here. Protected hubs require a valid Access JWT or the
 * stored Access service token at the Worker boundary.
 */
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const blocked = await hubAuthGuardResponse(c.req.raw, c.env, {
    skipNormalAuthForWebSocket: true,
  });
  if (blocked) return blocked;
  return next();
});
