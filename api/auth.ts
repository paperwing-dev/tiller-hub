import { decodeJwt } from "jose";
import { createMiddleware } from "hono/factory";
import type { HonoEnv, Env } from "./types";
import { getSecret } from "./setup/config";
import { resolveEnabledHarnesses } from "./env/harness";
import { hasEnabledHarnessModelAuth, resolveModelAuthState, resolveProtectionState, isLocalDevRequest } from "./protection";

/**
 * Verify the CF Access JWT assertion.
 *
 * CF Access fully verifies the JWT (signature, expiry, audience) at the edge
 * BEFORE the request reaches this Worker. Re-verifying the signature here
 * requires an outbound HTTPS fetch to the JWKS endpoint, which takes up to
 * 30 seconds on a cold Worker isolate and is the root cause of slow WS connects.
 *
 * Instead: decode the token without signature verification (just parse the
 * base64 payload) and check the audience claim. The edge guarantee makes the
 * signature re-check redundant for Workers sitting entirely behind CF Access.
 */
export async function verifyCfAccessJwt(request: Request, env: Env): Promise<void> {
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) throw new Error("Missing Cf-Access-Jwt-Assertion");

  let claims: ReturnType<typeof decodeJwt>;
  try {
    claims = decodeJwt(token);
  } catch {
    throw new Error("Malformed JWT");
  }

  const aud = claims.aud;
  const cfAccessAud = await getSecret(env, "CF_ACCESS_AUD");
  if (!cfAccessAud) throw new Error("CF_ACCESS_AUD not configured");
  const valid = Array.isArray(aud)
    ? aud.includes(cfAccessAud)
    : aud === cfAccessAud;
  if (!valid) throw new Error("Invalid audience");
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

/**
 * Hono middleware — verifies CF Access JWT.
 * Skips /health and WebSocket upgrades (WS auth happens in onConnect).
 * Public hubs skip auth here. Protected hubs still rely on Cloudflare Access at
 * the edge; the Worker only validates the audience when CF forwards a JWT.
 */
export const authMiddleware = createMiddleware<HonoEnv>(async (c, next) => {
  if (c.req.path === "/health") return next();
  if (c.req.path === "/api/setup/status") return next();

  // Setup routes stay open until model auth is configured.
  if (c.req.path.startsWith("/api/setup")) {
    const modelAuth = await resolveModelAuthState(c.env);
    if (!hasEnabledHarnessModelAuth(modelAuth, resolveEnabledHarnesses(c.env))) return next();
  }

  if (c.req.header("upgrade")?.toLowerCase() === "websocket") return next();

  try {
    await maybeVerifyCfAccessRequest(c.req.raw, c.env);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  return next();
});
