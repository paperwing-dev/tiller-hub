import {
  createRemoteJWKSet,
  decodeJwt,
  jwtVerify,
  type JWTPayload,
} from "jose";
import { createMiddleware } from "hono/factory";
import type {
  HonoEnv,
  Env,
  RequestAuthorization,
  WsAuthorization,
} from "./types";
import { resolveProtectionState, isLocalDevRequest } from "./protection";
import { requiresWorkersDevAccessProtection } from "./setup/protect-hub";
import {
  normalizeOwnerEmail,
  readWorkersDevAccessTrust,
} from "./workers-dev-access/records";
import type {
  AccessPrincipal,
  WorkersDevAccessRuntimeTrust,
} from "./workers-dev-access/types";
import { resolveCanonicalRequestOrigin } from "./canonical-origin";
import { getSecret } from "./setup/config";
import { getEnvLifecycleStub } from "./helpers";
import { readEnvDefinition } from "./plan/store";
import {
  constantTimeEqual,
  TILLER_CAPABILITY_HEADER,
  verifyEnvironmentRuntimeCapability,
} from "./env/runtime-capability";
import { verifyPlanWriterRuntimeToken } from "./planner/runtime-token";

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

async function resolveAccessJwtValidationConfig(
  request: Request,
  env: Env,
): Promise<{
  audience: string;
  issuer: string | null;
  jwksUrl: string | null;
}> {
  const url = new URL(request.url);
  const trust = await readWorkersDevAccessTrust(env, url.hostname);
  if (!trust)
    throw new Error("Canonical workers.dev Access trust is not configured");
  return {
    audience: trust.audience,
    issuer: trust.issuer,
    jwksUrl: accessCertsUrl(trust.issuer),
  };
}

function assertAudience(payload: JWTPayload, audience: string): void {
  const aud = payload.aud;
  const valid = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
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
  if (
    payload.nbf !== undefined &&
    (!Number.isFinite(payload.nbf) || payload.nbf > now + 60)
  ) {
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
    throw new Error(
      "Cloudflare Access JWT verification config is not configured",
    );
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
export async function verifyCfAccessJwt(
  request: Request,
  env: Env,
): Promise<JWTPayload> {
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
  trust: WorkersDevAccessRuntimeTrust,
): AccessPrincipal {
  const rawEmail = typeof payload.email === "string" ? payload.email : "";
  const email = normalizeOwnerEmail(rawEmail);
  const commonName =
    typeof payload.common_name === "string" ? payload.common_name.trim() : "";

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
  if (!trust)
    throw new Error("Canonical workers.dev Access trust is not configured");
  const token = request.headers.get("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");
  const payload = await verifyCfAccessJwt(request, env);
  return classifyWorkersDevPrincipal(payload, trust);
}

async function protectHubRequired(
  request: Request,
  env: Env,
): Promise<boolean> {
  const isLocalDev = isLocalDevRequest(env, request);
  const protection = await resolveProtectionState(env, request.url);
  return requiresWorkersDevAccessProtection({
    isLocalDev,
    accessConfigured: protection.accessConfigured,
  });
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const PUBLIC_ROUTES = new Set(["GET /health", "POST /api/github/webhook"]);
const BOOTSTRAP_ROUTES = new Set([
  "GET /api/update/check",
  "GET /api/installer/probe",
]);
const FINALIZATION_ENV_ROUTES = new Set([
  // The container entrypoint repeats the already-authorized self-stop after
  // its harness exits. Keep that exact, idempotent request available while
  // the same incarnation is saving so stop-control can finish its receipt.
  "stop",
  "boot-progress",
  "runner-stopped",
  "workspace-synced",
  "stop-failed",
  "harness-failed",
]);
const FINALIZATION_WORKSPACE_ROUTES = new Set([
  "GET manifest",
  "POST files",
  "POST delete",
  "GET deletions",
  "PUT deletions",
  "POST write",
]);

class AuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: 401 | 403 = 403,
  ) {
    super(message);
  }
}

function routeKey(request: Request): string {
  const url = new URL(request.url);
  return `${request.method.toUpperCase()} ${url.pathname}`;
}

function isWebSocket(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

function decoded(value: string): string | null {
  try {
    return decodeURIComponent(value).trim() || null;
  } catch {
    return null;
  }
}

async function assertOwnerOrigin(request: Request, env: Env): Promise<void> {
  if (SAFE_METHODS.has(request.method.toUpperCase()) && !isWebSocket(request))
    return;
  const supplied = request.headers.get("Origin")?.trim() ?? "";
  if (isLocalDevRequest(env, request) && !supplied) return;
  const expected = await resolveCanonicalRequestOrigin(env, request);
  if (supplied !== expected) {
    throw new AuthorizationError(
      "Request origin does not match the canonical Hub origin",
    );
  }
}

async function hasControlSecret(request: Request, env: Env): Promise<boolean> {
  const supplied = request.headers.get(TILLER_CAPABILITY_HEADER)?.trim() ?? "";
  if (!supplied) return false;
  const expected =
    (await getSecret(env, "TILLER_CONTROL_SECRET", { fresh: true }))?.trim() ??
    "";
  return Boolean(expected && constantTimeEqual(supplied, expected));
}

const GITHUB_PUBLISH_OPERATION_HEADER = "X-Tiller-GitHub-Publish-Operation-Id";
const GITHUB_PUBLISH_TOKEN_HEADER = "X-Tiller-GitHub-Publish-Token";

async function authenticateGitHubPublishRuntime(
  request: Request,
  env: Env,
): Promise<boolean> {
  const path = new URL(request.url).pathname;
  const method = request.method.toUpperCase();
  const workspace = /^\/api\/workspace\/([^/]+)\/(download|deletions)$/.exec(
    path,
  );
  const result =
    /^\/api\/envs\/([^/]+)\/github\/publish-draft-pr\/([^/]+)\/result$/.exec(
      path,
    );
  if (!((method === "GET" && workspace) || (method === "POST" && result)))
    return false;

  const envSlug = decoded((workspace ?? result)![1]);
  const operationId =
    request.headers.get(GITHUB_PUBLISH_OPERATION_HEADER)?.trim() ?? "";
  const supplied =
    request.headers.get(GITHUB_PUBLISH_TOKEN_HEADER)?.trim() ?? "";
  const resultOperationId = result ? decoded(result[2]) : null;
  if (
    !envSlug ||
    !operationId ||
    !supplied ||
    (resultOperationId && resultOperationId !== operationId)
  ) {
    return false;
  }
  const operation = await getEnvLifecycleStub(
    env,
    envSlug,
  ).getGitHubPublishOperation();
  return Boolean(
    operation &&
    operation.envSlug === envSlug &&
    operation.operationId === operationId &&
    operation.callbackToken &&
    constantTimeEqual(operation.callbackToken, supplied),
  );
}

function environmentSlugFromRuntimeRoute(request: Request): string | null {
  const path = new URL(request.url).pathname;
  const match = /^\/api\/(?:workspace|envs)\/([^/]+)(?:\/|$)/.exec(path);
  return match ? decoded(match[1]) : null;
}

const WORKSPACE_RUNTIME_ROUTES = new Set([
  "GET manifest",
  "GET file",
  "POST files",
  "POST write",
  "GET deletions",
  "PUT deletions",
  "DELETE file",
  "POST delete",
  "GET readdir",
  "GET glob",
  "GET info",
  "GET download",
]);

function environmentRuntimeRouteAllowed(
  request: Request,
  slug: string,
): boolean {
  const method = request.method.toUpperCase();
  const path = new URL(request.url).pathname;
  const encodedSlug = path.split("/")[3] ?? "";
  if (decoded(encodedSlug) !== slug) return false;
  const workspacePrefix = `/api/workspace/${encodedSlug}/`;
  if (path.startsWith(workspacePrefix)) {
    const suffix = path.slice(workspacePrefix.length);
    return WORKSPACE_RUNTIME_ROUTES.has(`${method} ${suffix}`);
  }
  const suffix = path.slice(`/api/envs/${encodedSlug}/`.length);
  if (method === "POST" && suffix === "sessions") return true;
  if (method === "GET" && /^sessions\/[^/]+$/.test(suffix)) return true;
  if (method === "POST" && /^sessions\/[^/]+\/permissions$/.test(suffix))
    return true;
  if (
    method === "GET" &&
    /^sessions\/[^/]+\/permissions\/[^/]+$/.test(suffix)
  )
    return true;
  if (method === "POST" && suffix === "codex/runtime-auth") return true;
  if (method === "POST" && suffix === "scheduled-run/idle") return true;
  if (method === "POST" && suffix === "plan-execution/complete") return true;
  if (
    (method === "GET" || method === "POST") &&
    suffix === "startup-diagnostics"
  )
    return true;
  if (method === "POST" && FINALIZATION_ENV_ROUTES.has(suffix)) return true;
  if (
    method === "POST" &&
    (suffix === "infra-ready" || suffix === "runner-ready")
  )
    return true;
  if (
    method === "POST" &&
    (suffix === "implementor-attention/completions" ||
      suffix === "implementor-attention/acknowledge")
  )
    return true;
  return false;
}

function finalizationRuntimeRoute(request: Request): boolean {
  const path = new URL(request.url).pathname;
  const workspace = /^\/api\/workspace\/[^/]+\/([^/]+)$/.exec(path);
  if (workspace) {
    return FINALIZATION_WORKSPACE_ROUTES.has(
      `${request.method.toUpperCase()} ${workspace[1]}`,
    );
  }
  const match = /^\/api\/envs\/[^/]+\/(.+)$/.exec(path);
  return (
    request.method === "POST" &&
    Boolean(match && FINALIZATION_ENV_ROUTES.has(match[1]))
  );
}

async function authenticateEnvironmentRuntime(
  request: Request,
  env: Env,
  envSlug: string,
): Promise<Extract<RequestAuthorization, { kind: "environment" }> | null> {
  if (!environmentRuntimeRouteAllowed(request, envSlug)) return null;
  return authenticateEnvironmentRuntimeState(
    env,
    envSlug,
    request.headers.get(TILLER_CAPABILITY_HEADER),
    finalizationRuntimeRoute(request),
  );
}

async function authenticateEnvironmentRuntimeState(
  env: Env,
  envSlug: string,
  capability: string | null,
  allowFinalization: boolean,
): Promise<Extract<RequestAuthorization, { kind: "environment" }> | null> {
  const [definition, subject] = await Promise.all([
    readEnvDefinition(env, envSlug),
    getEnvLifecycleStub(env, envSlug).getEnvironmentRuntimeSubject(),
  ]);
  if (
    !definition ||
    !subject ||
    subject.envSlug !== envSlug ||
    definition.incarnationId !== subject.incarnationId ||
    !(await verifyEnvironmentRuntimeCapability(
      env,
      subject,
      capability,
    ))
  )
    return null;
  const active =
    subject.lifecycle.activeOperation === "start" &&
    subject.lifecycle.activeOpId === subject.startOperationId &&
    (subject.lifecycle.phase === "starting" ||
      subject.lifecycle.phase === "running");
  const finalizing =
    allowFinalization &&
    subject.lifecycle.activeOperation === "stop" &&
    (subject.lifecycle.phase === "saving" ||
      subject.lifecycle.phase === "stopping" ||
      (
        subject.lifecycle.phase === "failed" &&
        subject.lifecycle.infraState !== "stopped" &&
        subject.failedStopFinalizationAuthorized
      ));
  if (!active && !finalizing) return null;
  return {
    kind: "environment",
    envSlug,
    incarnationId: subject.incarnationId,
    startOperationId: subject.startOperationId,
  };
}

async function globalAuthorization(
  principal: AccessPrincipal,
  request: Request,
  env: Env,
  tryControlSecret = true,
): Promise<Extract<RequestAuthorization, { kind: "global" }> | null> {
  if (principal.kind === "owner") {
    await assertOwnerOrigin(request, env);
    return { kind: "global", source: "owner", ownerEmail: principal.email };
  }
  if (principal.kind === "local-dev") {
    await assertOwnerOrigin(request, env);
    return { kind: "global", source: "local-dev" };
  }
  if (tryControlSecret && await hasControlSecret(request, env))
    return { kind: "global", source: "control" };
  return null;
}

type BaseAuthorization =
  | Extract<RequestAuthorization, { kind: "global" }>
  | { kind: "service" };

async function authenticateBaseAuthorization(
  request: Request,
  env: Env,
  options: { deferControlSecret?: boolean } = {},
): Promise<BaseAuthorization> {
  if (await protectHubRequired(request, env)) {
    throw new AuthorizationError(
      "Protect this hub with Cloudflare Access before using the API",
    );
  }
  let principal: AccessPrincipal;
  try {
    principal = await authenticateAccessRequest(request, env);
  } catch (error) {
    throw new AuthorizationError(
      error instanceof Error ? error.message : "Unauthorized",
      401,
    );
  }
  const global = await globalAuthorization(
    principal,
    request,
    env,
    !options.deferControlSecret,
  );
  if (global) return global;
  if (principal.kind === "service") return { kind: "service" };
  throw new AuthorizationError("Unauthorized", 401);
}

export async function classifyRequestAuthorization(
  request: Request,
  env: Env,
): Promise<RequestAuthorization> {
  if (PUBLIC_ROUTES.has(routeKey(request))) return { kind: "public" };
  const base = await authenticateBaseAuthorization(request, env, {
    deferControlSecret: true,
  });
  if (base.kind === "global") return base;
  const envSlug = environmentSlugFromRuntimeRoute(request);
  if (envSlug) {
    const runtime = await authenticateEnvironmentRuntime(request, env, envSlug);
    if (runtime) return runtime;
  }
  if (await hasControlSecret(request, env))
    return { kind: "global", source: "control" };
  if (BOOTSTRAP_ROUTES.has(routeKey(request))) return { kind: "bootstrap" };
  if (await authenticateGitHubPublishRuntime(request, env))
    return { kind: "specialized" };
  throw new AuthorizationError(
    "A control or environment capability is required",
  );
}

export async function authenticateWebSocketAuthorization(
  request: Request,
  env: Env,
): Promise<WsAuthorization> {
  const base = await authenticateBaseAuthorization(request, env, {
    deferControlSecret: true,
  });
  if (base.kind === "global") return base;

  const url = new URL(request.url);
  if (url.pathname !== "/parties/hub/hub") {
    if (await hasControlSecret(request, env))
      return { kind: "global", source: "control" };
    throw new AuthorizationError(
      "Scoped runtime WebSockets are limited to the Hub endpoint",
    );
  }
  const sessionId = url.searchParams.get("sessionId")?.trim() ?? "";
  const envSlug = url.searchParams.get("envSlug")?.trim() ?? "";
  if (envSlug && sessionId) {
    if (
      await authenticateEnvironmentRuntimeState(
        env,
        envSlug,
        request.headers.get(TILLER_CAPABILITY_HEADER),
        false,
      )
    ) {
      return { kind: "environment", envSlug, sessionId };
    }
  }

  // The environment path above is the high-volume scoped runtime path. Once
  // it fails, preserve the classifier invariant that a valid control secret
  // always grants global authority before considering another scoped class.
  if (await hasControlSecret(request, env))
    return { kind: "global", source: "control" };

  const repoId = url.searchParams.get("repoId")?.trim() ?? "";
  const planArtifactId = url.searchParams.get("planArtifactId")?.trim() ?? "";
  const generation = Number(url.searchParams.get("generation"));
  if (
    repoId &&
    planArtifactId &&
    sessionId &&
    Number.isInteger(generation) &&
    generation > 0 &&
    (await verifyPlanWriterRuntimeToken(
      env,
      repoId,
      planArtifactId,
      generation,
      request.headers.get("X-Tiller-Plan-Writer-Token"),
    ))
  ) {
    return {
      kind: "planWriter",
      repoId,
      planArtifactId,
      generation,
      sessionId,
    };
  }
  throw new AuthorizationError(
    "A scoped runtime or control capability is required",
  );
}

function setupProtectionRequiredResponse(): Response {
  return Response.json(
    {
      error: "Protect this hub with Cloudflare Access before using the API.",
      code: "setup_protection_required",
      setupPhase: "protect-hub",
    },
    { status: 403 },
  );
}

function authorizationErrorResponse(error: unknown): Response {
  if (
    error instanceof AuthorizationError &&
    error.message.startsWith("Protect this hub")
  ) {
    return setupProtectionRequiredResponse();
  }
  const status = error instanceof AuthorizationError ? error.status : 401;
  return Response.json(
    {
      error:
        status === 401
          ? "Unauthorized"
          : error instanceof Error
            ? error.message
            : "Forbidden",
    },
    { status },
  );
}

export async function hubAuthGuardResponse(
  request: Request,
  env: Env,
): Promise<Response | null> {
  try {
    if (isWebSocket(request))
      await authenticateWebSocketAuthorization(request, env);
    else await classifyRequestAuthorization(request, env);
    return null;
  } catch (error) {
    return authorizationErrorResponse(error);
  }
}

/**
 * Hono middleware — verifies CF Access JWT.
 * Allows only the exact public routes selected above. API WebSocket routes are
 * classified here; the Hub PartyServer classifies its own upgrade in onConnect.
 */
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  const existing = c.get("authorization");
  if (existing) return next();
  try {
    const authorization = isWebSocket(c.req.raw)
      ? await authenticateWebSocketAuthorization(c.req.raw, c.env)
      : await classifyRequestAuthorization(c.req.raw, c.env);
    c.set("authorization", authorization as RequestAuthorization);
  } catch (error) {
    return authorizationErrorResponse(error);
  }
  return next();
});

/**
 * Service authentication for subrouters whose handlers already verify their
 * own run-scoped token. Mount those subrouters before the default API guard so
 * only their actually registered routes receive this classification.
 */
export const specializedServiceAuthMiddleware = createMiddleware<HonoEnv>(
  async (c, next) => {
    const existing = c.get("authorization");
    if (existing?.kind === "global" || existing?.kind === "specialized") {
      return next();
    }
    try {
      const base = await authenticateBaseAuthorization(c.req.raw, c.env);
      c.set(
        "authorization",
        base.kind === "global" ? base : { kind: "specialized" },
      );
    } catch (error) {
      return authorizationErrorResponse(error);
    }
    return next();
  },
);
