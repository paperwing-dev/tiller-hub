import { createRemoteJWKSet, decodeJwt, jwtVerify, type JWTPayload } from "jose";
import { createMiddleware } from "hono/factory";
import type { HonoEnv, Env } from "./types";
import {
  resolveProtectionState,
  isLocalDevRequest,
  type ProtectionState,
} from "./protection";
import { requiresWorkersDevAccessProtection } from "./setup/protect-hub";
import {
  normalizeOwnerEmail,
  readCanonicalWorkersDevAccessTrust,
  readWorkersDevAccessTrust,
} from "./workers-dev-access/records";
import type { AccessPrincipal, WorkersDevAccessTrustV1 } from "./workers-dev-access/types";

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

function assertAccessAppPayload(payload: JWTPayload): void {
  if ((payload as Record<string, unknown>).type !== "app") {
    throw new Error("JWT is not a Cloudflare Access application token");
  }
}

async function resolveAccessJwtValidationConfig(request: Request, env: Env): Promise<{
  audience: string;
  issuer: string | null;
  jwksUrl: string | null;
}> {
  const url = new URL(request.url);
  const trust = await readWorkersDevAccessTrust(env, url.hostname);
  if (!trust) throw new Error("Canonical workers.dev Access trust is not configured");
  return {
    audience: trust.audience,
    issuer: trust.issuer,
    jwksUrl: accessCertsUrl(trust.issuer),
  };
}

function assertAudience(payload: JWTPayload, audience: string): void {
  const aud = payload.aud;
  const valid = Array.isArray(aud)
    ? aud.includes(audience)
    : aud === audience;
  if (!valid) throw new Error("Invalid audience");
}

function assertAccessTimeClaims(payload: JWTPayload): void {
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isFinite(payload.iat) || !Number.isFinite(payload.exp)) {
    throw new Error("Cloudflare Access JWT is missing required time claims");
  }
  if (payload.iat! > now + 60 || payload.exp! <= now) {
    throw new Error("Cloudflare Access JWT time claims are invalid");
  }
  if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > now + 60)) {
    throw new Error("Cloudflare Access JWT time claims are invalid");
  }
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
    assertAccessTimeClaims(verified.payload);
    return verified.payload;
  } catch {
    throw new Error("Invalid JWT");
  }
}

/**
 * Verify the CF Access JWT assertion.
 *
 * Require full JWT verification when Access is configured. Audience-only JWT
 * checks are not sufficient because a Worker may still be reachable outside the
 * Access application during route cutovers.
 */
export async function verifyCfAccessJwt(request: Request, env: Env): Promise<JWTPayload> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");

  try {
    decodeJwt(token);
  } catch {
    throw new Error("Malformed JWT");
  }

  const validation = await resolveAccessJwtValidationConfig(request, env);
  return verifyCloudflareAccessToken(token, validation);
}

function classifyWorkersDevPrincipal(
  payload: JWTPayload,
  trust: WorkersDevAccessTrustV1,
): AccessPrincipal {
  const rawEmail = typeof payload.email === "string" ? payload.email : "";
  const email = normalizeOwnerEmail(rawEmail);
  const commonName = typeof payload.common_name === "string" ? payload.common_name.trim() : "";

  if (email && !commonName && email === trust.ownerEmail) {
    return { kind: "owner", email };
  }
  if (!email && commonName && commonName === trust.serviceClientId) {
    return { kind: "service" };
  }
  throw new Error("Cloudflare Access principal is not authorized for this Hub");
}

export async function authenticateAccessRequest(
  request: Request,
  env: Env,
): Promise<AccessPrincipal> {
  if (isLocalDevRequest(env, request)) return { kind: "local-dev" };

  const hostname = new URL(request.url).hostname;
  const trust = await readWorkersDevAccessTrust(env, hostname);
  if (!trust) throw new Error("Canonical workers.dev Access trust is not configured");
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");
  const payload = await verifyCfAccessJwt(request, env);
  return classifyWorkersDevPrincipal(payload, trust);
}

export async function authenticateCanonicalOwner(
  request: Request,
  env: Env,
): Promise<Extract<AccessPrincipal, { kind: "owner" | "local-dev" }>> {
  const principal = await authenticateAccessRequest(request, env);
  if (principal.kind === "local-dev") {
    if (!isLocalDevRequest(env, request)) {
      throw new Error("Owner authentication is required");
    }
    return principal;
  }
  if (principal.kind !== "owner") throw new Error("Owner authentication is required");
  const trust = await readCanonicalWorkersDevAccessTrust(env);
  if (!trust || principal.email !== trust.ownerEmail) {
    throw new Error("Owner authentication is required");
  }
  return principal;
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
  return {
    isLocalDev,
    protection,
    protectHubRequired: requiresWorkersDevAccessProtection({
      isLocalDev,
      accessConfigured: protection.accessConfigured,
    }),
  };
}

type RouteAuthMode =
  | "normal"
  | "public"
  | "owner";

interface RouteAuthPolicy {
  path: string;
  method?: string;
  mode: RouteAuthMode;
  protectHubAllowlisted?: boolean;
  canonicalAccessBootstrap?: boolean;
}

const ROUTE_AUTH_POLICIES: RouteAuthPolicy[] = [
  { path: "/health", mode: "public", protectHubAllowlisted: true },
  { path: "/api/setup/status", method: "GET", mode: "normal", protectHubAllowlisted: true, canonicalAccessBootstrap: true },
  { path: "/api/setup/workers-dev-access/oauth/start", method: "POST", mode: "normal", protectHubAllowlisted: true },
  { path: "/api/setup/workers-dev-access/broker/proof", method: "POST", mode: "public" },
  { path: "/api/setup/workers-dev-access/broker/complete", method: "POST", mode: "public" },
  { path: "/api/settings/workers-dev-access/oauth/start", method: "POST", mode: "owner" },
  { path: "/api/execution/status", method: "GET", mode: "owner" },
  { path: "/api/cli/connect-package", method: "POST", mode: "owner" },
  { path: "/api/github/app-config", method: "POST", mode: "owner" },
  { path: "/api/github/manifest/setup", method: "GET", mode: "owner" },
  { path: "/api/github/manifest/callback", method: "GET", mode: "owner" },
  { path: "/api/github/install", method: "GET", mode: "owner" },
  { path: "/api/github/install/callback", method: "GET", mode: "owner" },
  { path: "/api/github/manage", method: "GET", mode: "owner" },
  { path: "/api/update/hub-repo/detect", method: "POST", mode: "owner" },
  { path: "/api/update/hub-repo/select", method: "POST", mode: "owner" },
  { path: "/api/update/apply", method: "POST", mode: "owner" },
  { path: "/api/update/repair/cloudflare-redeploy", method: "POST", mode: "owner" },
  { path: "/cli/bootstrap", method: "GET", mode: "public" },
  { path: "/api/github/webhook", method: "POST", mode: "public" },
  { path: "/api/mcp/cloudflare", method: "GET", mode: "public" },
  { path: "/api/mcp/cloudflare", method: "POST", mode: "public" },
  { path: "/api/mcp/cloudflare", method: "DELETE", mode: "public" },
];

function resolveRouteAuthPolicy(path: string, method: string): RouteAuthPolicy {
  if (
    method === "POST" &&
    /^\/api\/envs\/[^/]+\/github\/publish-draft-pr\/[^/]+\/result$/.test(path)
  ) {
    return { path, method, mode: "public" };
  }
  const explicit = ROUTE_AUTH_POLICIES.find((policy) => {
    return policy.path === path && (!policy.method || policy.method === method);
  });
  if (explicit) return explicit;
  if (path === "/api/setup" || path.startsWith("/api/setup/")) {
    return { path, method, mode: "owner" };
  }
  if (path === "/api/settings" || path.startsWith("/api/settings/")) {
    return { path, method, mode: "owner" };
  }
  return { path, method, mode: "normal" };
}

async function verifyCanonicalAccessBootstrap(request: Request, env: Env): Promise<void> {
  const hostname = new URL(request.url).hostname;
  const trust = await readWorkersDevAccessTrust(env, hostname);
  if (!trust) throw new Error("Canonical workers.dev Access trust is not available");
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");
  const payload = await verifyCloudflareAccessToken(token, {
    audience: trust.audience,
    issuer: trust.issuer,
    jwksUrl: accessCertsUrl(trust.issuer),
  });
  classifyWorkersDevPrincipal(payload, trust);
}

async function tryVerifyCanonicalAccessBootstrap(request: Request, env: Env): Promise<boolean> {
  try {
    await verifyCanonicalAccessBootstrap(request, env);
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
    || (path === "/api/setup/workers-dev-access/oauth/start" && method === "POST");
}

export async function hubAuthGuardResponse(
  request: Request,
  env: Env,
  options: { skipNormalAuthForWebSocket?: boolean } = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const policy = resolveRouteAuthPolicy(path, request.method);
  if (policy.mode === "public") return null;

  const state = await resolveAuthGuardState(request, env);
  if (state.protectHubRequired) {
    if (policy.protectHubAllowlisted) {
      return null;
    }
    return setupProtectionRequiredResponse();
  }

  if (state.isLocalDev) return null;

  if (policy.mode === "owner") {
    try {
      await authenticateCanonicalOwner(request, env);
      return null;
    } catch {
      return unauthorizedResponse();
    }
  }

  if (
    policy.canonicalAccessBootstrap
    && await tryVerifyCanonicalAccessBootstrap(request, env)
  ) {
    return null;
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
    await authenticateAccessRequest(request, env);
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
