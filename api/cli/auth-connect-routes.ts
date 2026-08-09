import { Hono, type Context } from "hono";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import type {
  AuthConnectProvider,
  AuthConnectStatusResult,
  CodexConnectBoundaryResult,
} from "../codex-auth-coordinator";
import { invalidateConfigCache } from "../setup/config";
import type { Env, HonoEnv } from "../types";
import { getDurableObjectStub } from "../durable-object";

const MAX_PACKAGE_BODY_BYTES = 8 * 1_024;
const MAX_UPLOAD_BODY_BYTES = 64 * 1_024;
const PACKAGE_TTL_SECONDS = 5 * 60;
const PROVIDERS = new Set<AuthConnectProvider>(["codex", "claude"]);

class RequestBodyTooLargeError extends Error {}

export interface AuthConnectPackageV1 {
  version: 1;
  hubUrl: string;
  state: string;
  iat: number;
  exp: number;
  grants: Partial<Record<AuthConnectProvider, string>>;
}

interface AuthConnectStub {
  issueAuthConnectGrants(
    providers: AuthConnectProvider[],
    connectionId?: string,
  ): Promise<Record<AuthConnectProvider, string | undefined>>;
  consumeAuthConnectGrant(provider: AuthConnectProvider, grant: string): Promise<boolean>;
  recordAuthConnectResult(
    provider: AuthConnectProvider,
    grant: string,
    result: "success" | "error",
    error?: string,
  ): Promise<boolean>;
  getAuthConnectStatus(connectionId: string): Promise<AuthConnectStatusResult>;
  connectCodexAuth(authJson: string): Promise<CodexConnectBoundaryResult>;
}

interface HubConfigStub {
  setConfig(key: string, value: string): Promise<void> | void;
}

function authStub(env: Env): AuthConnectStub {
  return getDurableObjectStub<AuthConnectStub>(env, env.CODEX_AUTH, "codex-auth");
}

function hubStub(env: Env): HubConfigStub {
  return getDurableObjectStub<HubConfigStub>(env, env.HUB, "hub");
}

function setNoStore(c: Context<HonoEnv>): void {
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (!Number.isFinite(declared) || declared < 0 || declared > maxBytes) {
      throw new RequestBodyTooLargeError();
    }
  }
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new RequestBodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseProviders(value: unknown): AuthConnectProvider[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PROVIDERS.size) {
    throw new Error("Invalid providers");
  }
  const providers = value.map((provider) => {
    if (typeof provider !== "string" || !PROVIDERS.has(provider as AuthConnectProvider)) {
      throw new Error("Invalid providers");
    }
    return provider as AuthConnectProvider;
  });
  if (new Set(providers).size !== providers.length) throw new Error("Invalid providers");
  return providers;
}

function parsePackageRequest(value: unknown): {
  publicKeyJwk: JWK;
  state: string;
  providers: AuthConnectProvider[];
} {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "providers,publicKeyJwk,state") {
    throw new Error("Invalid authentication connection request");
  }
  const state = typeof value.state === "string" ? value.state.trim() : "";
  if (!state || state.length > 512) throw new Error("Invalid authentication connection state");
  if (!isRecord(value.publicKeyJwk)) throw new Error("Invalid connection public key");
  const jwk = value.publicKeyJwk;
  if (
    Object.keys(jwk).sort().join(",") !== "crv,kty,x,y"
    || jwk.kty !== "EC"
    || jwk.crv !== "P-256"
    || typeof jwk.x !== "string"
    || typeof jwk.y !== "string"
    || !/^[A-Za-z0-9_-]{43}$/.test(jwk.x)
    || !/^[A-Za-z0-9_-]{43}$/.test(jwk.y)
    || "d" in jwk
  ) throw new Error("Invalid connection public key");
  return {
    publicKeyJwk: jwk as JWK,
    state,
    providers: parseProviders(value.providers),
  };
}

async function requireGrant(
  c: Context<HonoEnv>,
  provider: AuthConnectProvider,
): Promise<{ ok: true; grant: string } | { ok: false; response: Response }> {
  const grant = c.req.header("X-Tiller-Auth-Grant")?.trim() ?? "";
  if (!grant || !await authStub(c.env).consumeAuthConnectGrant(provider, grant)) {
    return {
      ok: false,
      response: c.json({ error: "The authentication connection grant is invalid or expired.", code: "auth_grant_invalid" }, 403),
    };
  }
  return { ok: true, grant };
}

async function recordResult(
  c: Context<HonoEnv>,
  provider: AuthConnectProvider,
  grant: string,
  result: "success" | "error",
  error?: string,
): Promise<void> {
  try {
    await authStub(c.env).recordAuthConnectResult(provider, grant, result, error);
  } catch {
    // Result tracking must never turn a completed credential upload into a failure.
  }
}

const authConnectRoutes = new Hono<HonoEnv>();

authConnectRoutes.get("/cli/auth-connect", (c) => {
  setNoStore(c);
  const source = new URL(c.req.url);
  const destination = new URL("/settings", source);
  destination.searchParams.set("auth_connect", "1");
  for (const key of ["port", "state", "key", "providers"]) {
    const value = source.searchParams.get(key);
    if (value !== null) destination.searchParams.set(key, value);
  }
  return c.redirect(`${destination.pathname}${destination.search}`, 302);
});

authConnectRoutes.post("/api/cli/auth-connect-package", async (c) => {
  setNoStore(c);
  try {
    const raw = await readBoundedText(c.req.raw, MAX_PACKAGE_BODY_BYTES);
    const input = parsePackageRequest(JSON.parse(raw) as unknown);
    const connectionId = crypto.randomUUID();
    const grants = await authStub(c.env).issueAuthConnectGrants(input.providers, connectionId);
    const now = Math.floor(Date.now() / 1_000);
    const hubUrl = new URL(c.req.url).origin;
    const authPackage: AuthConnectPackageV1 = {
      version: 1,
      hubUrl,
      state: input.state,
      iat: now,
      exp: now + PACKAGE_TTL_SECONDS,
      grants: Object.fromEntries(input.providers.map((provider) => [provider, grants[provider]])),
    };
    const plaintext = new TextEncoder().encode(JSON.stringify(authPackage));
    const publicKey = await importJWK(input.publicKeyJwk, "ECDH-ES");
    const envelope = await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "tiller-auth-connect+jwe" })
      .encrypt(publicKey);
    return c.json({ envelope, connection_id: connectionId });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: "Authentication connection request is too large." }, 413);
    }
    return c.json({ error: "Authentication connection request was rejected." }, 400);
  }
});

authConnectRoutes.get("/api/cli/auth-connect-status", async (c) => {
  setNoStore(c);
  const connectionId = c.req.query("connection_id")?.trim() ?? "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(connectionId)) {
    return c.json({ error: "Invalid authentication connection ID." }, 400);
  }
  return c.json(await authStub(c.env).getAuthConnectStatus(connectionId));
});

authConnectRoutes.post("/api/auth/subscriptions/codex/connect", async (c) => {
  setNoStore(c);
  let raw: string;
  try {
    raw = await readBoundedText(c.req.raw, MAX_UPLOAD_BODY_BYTES);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? c.json({ error: "Codex authentication upload is too large." }, 413)
      : c.json({ error: "Codex authentication upload was rejected." }, 400);
  }
  let body: unknown;
  try { body = JSON.parse(raw) as unknown; } catch { return c.json({ error: "Codex authentication upload was rejected." }, 400); }
  if (
    !isRecord(body)
    || Object.keys(body).sort().join(",") !== "auth_json,version"
    || body.version !== 1
    || typeof body.auth_json !== "string"
    || !body.auth_json.trim()
  ) return c.json({ error: "Codex authentication upload was rejected." }, 400);
  const authorization = await requireGrant(c, "codex");
  if (!authorization.ok) return authorization.response;
  try {
    const result = await authStub(c.env).connectCodexAuth(body.auth_json);
    if (!result.ok) {
      const error = result.reason === "needs_reconnect"
        ? "Codex rejected the subscription login. Run `tiller auth connect codex` again."
        : "Codex subscription authentication is temporarily unavailable. Retry the connection.";
      await recordResult(c, "codex", authorization.grant, "error", error);
      return c.json({ error, code: result.reason }, result.reason === "needs_reconnect" ? 409 : 503);
    }
    await hubStub(c.env).setConfig("openaiBillingMode", "subscription");
    invalidateConfigCache();
    await recordResult(c, "codex", authorization.grant, "success");
    return c.json({
      ok: true,
      authenticated: true,
      expires_at: Date.parse(result.credential.expiresAt),
      account_id: result.credential.accountId,
    });
  } catch (error) {
    await recordResult(
      c,
      "codex",
      authorization.grant,
      "error",
      "Tiller could not finish the Codex connection. Retry the connection.",
    );
    throw error;
  }
});

authConnectRoutes.post("/api/auth/subscriptions/claude/connect", async (c) => {
  setNoStore(c);
  let raw: string;
  try {
    raw = await readBoundedText(c.req.raw, MAX_UPLOAD_BODY_BYTES);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? c.json({ error: "Claude authentication upload is too large." }, 413)
      : c.json({ error: "Claude authentication upload was rejected." }, 400);
  }
  let body: unknown;
  try { body = JSON.parse(raw) as unknown; } catch { return c.json({ error: "Claude authentication upload was rejected." }, 400); }
  if (
    !isRecord(body)
    || Object.keys(body).sort().join(",") !== "oauth_token,version"
    || body.version !== 1
    || typeof body.oauth_token !== "string"
    || !body.oauth_token.trim()
    || body.oauth_token.length > 16 * 1_024
  ) return c.json({ error: "Claude authentication upload was rejected." }, 400);
  const authorization = await requireGrant(c, "claude");
  if (!authorization.ok) return authorization.response;
  try {
    const hub = hubStub(c.env);
    await hub.setConfig("CLAUDE_CODE_OAUTH_TOKEN", body.oauth_token.trim());
    await hub.setConfig("claudeBillingMode", "subscription");
    invalidateConfigCache();
    await recordResult(c, "claude", authorization.grant, "success");
    return c.json({ ok: true, authenticated: true });
  } catch (error) {
    await recordResult(
      c,
      "claude",
      authorization.grant,
      "error",
      "Tiller could not save the Claude subscription. Retry the connection.",
    );
    throw error;
  }
});

export default authConnectRoutes;
