import { Hono, type Context } from "hono";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import type { AuthConnectProvider, CodexConnectBoundaryResult } from "../codex-auth-coordinator";
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
  issueAuthConnectGrants(providers: AuthConnectProvider[]): Promise<Record<AuthConnectProvider, string | undefined>>;
  consumeAuthConnectGrant(provider: AuthConnectProvider, grant: string): Promise<boolean>;
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

function renderAuthConnectPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Connect subscriptions to Tiller</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f8fa; color: #24292f; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top left, #0969da1a, transparent 28rem), #f6f8fa; }
      main { box-sizing: border-box; width: min(38rem, calc(100vw - 2rem)); border: 1px solid #d0d7de; border-radius: 1.25rem; background: #fffc; box-shadow: 0 18px 50px #1f232814; padding: 1.5rem; }
      .eyebrow { margin: 0; font-size: .75rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #57606a; }
      h1 { margin: .5rem 0 0; font-size: 1.6rem; } p { color: #57606a; line-height: 1.5; }
      .panel { margin-top: 1.25rem; border: 1px solid #d0d7de; border-radius: 1rem; padding: 1rem; background: #fff; }
      .status { margin: 0; font-size: 1rem; font-weight: 650; color: #24292f; } .success { color: #1a7f37; } .error { color: #cf222e; }
      .detail { margin: .5rem 0 0; font-size: .925rem; }
      .code { display: none; margin-top: 1rem; border-radius: .75rem; background: #f6f8fa; padding: .75rem; }
      .code.visible { display: grid; gap: .75rem; } code { overflow-wrap: anywhere; white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      button { width: fit-content; border: 1px solid #0969da; border-radius: 999px; background: #0969da; color: #fff; padding: .5rem 1rem; font: inherit; font-weight: 650; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Tiller CLI</p>
      <h1>Approve subscription connection</h1>
      <div class="panel">
        <p id="status" class="status">Checking owner access…</p>
        <p id="detail" class="detail">This approval creates five-minute, single-use grants for the providers requested by your terminal.</p>
        <div id="code-shell" class="code"><code id="code"></code><button id="copy" type="button">Copy connection code</button></div>
      </div>
    </main>
    <script>
      const statusEl = document.getElementById("status");
      const detailEl = document.getElementById("detail");
      const codeShell = document.getElementById("code-shell");
      const codeEl = document.getElementById("code");
      const copyEl = document.getElementById("copy");
      function state(kind, title, detail) { statusEl.className = "status " + kind; statusEl.textContent = title; detailEl.textContent = detail; }
      function showCode(code) { codeEl.textContent = code; codeShell.classList.add("visible"); copyEl.onclick = async () => { try { await navigator.clipboard.writeText(code); copyEl.textContent = "Copied"; } catch { copyEl.textContent = "Copy failed"; } setTimeout(() => copyEl.textContent = "Copy connection code", 1200); }; }
      function decode(value) { const normalized = value.replace(/-/g, "+").replace(/_/g, "/"); return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(normalized + "=".repeat((4 - normalized.length % 4) % 4)), c => c.charCodeAt(0)))); }
      async function run() {
        const params = new URLSearchParams(location.search);
        const port = Number.parseInt(params.get("port") || "", 10);
        const stateValue = params.get("state") || "";
        const key = params.get("key") || "";
        const providers = (params.get("providers") || "").split(",").filter(Boolean);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !stateValue || !key || providers.length < 1) { state("error", "Invalid connection link", "Return to the Tiller CLI and retry."); return; }
        try {
          const response = await fetch("/api/cli/auth-connect-package", { method: "POST", credentials: "include", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ publicKeyJwk: decode(key), state: stateValue, providers }) });
          const value = await response.json().catch(() => ({}));
          if (!response.ok || !value.envelope) throw new Error(value.error || "Connection approval failed.");
          showCode(value.envelope);
          state("", "Sending approval to Tiller…", "If the browser is on another machine, paste the connection code into your terminal.");
          try {
            const callback = await fetch("http://127.0.0.1:" + port + "/auth-connect-callback", { method: "POST", mode: "cors", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ envelope: value.envelope }) });
            if (!callback.ok) throw new Error();
            codeShell.classList.remove("visible");
            state("success", "Subscriptions approved", "Return to your terminal while Tiller finishes the connection.");
          } catch { state("", "Connection code ready", "Paste the connection code into your terminal."); }
        } catch (error) { state("error", "Connection approval failed", error instanceof Error ? error.message : "Retry from the Tiller CLI."); }
      }
      void run();
    </script>
  </body>
</html>`;
}

async function requireGrant(c: Context<HonoEnv>, provider: AuthConnectProvider): Promise<Response | null> {
  const grant = c.req.header("X-Tiller-Auth-Grant")?.trim() ?? "";
  if (!grant || !await authStub(c.env).consumeAuthConnectGrant(provider, grant)) {
    return c.json({ error: "The authentication connection grant is invalid or expired.", code: "auth_grant_invalid" }, 403);
  }
  return null;
}

const authConnectRoutes = new Hono<HonoEnv>();

authConnectRoutes.get("/cli/auth-connect", (c) => {
  setNoStore(c);
  return c.html(renderAuthConnectPage());
});

authConnectRoutes.post("/api/cli/auth-connect-package", async (c) => {
  setNoStore(c);
  try {
    const raw = await readBoundedText(c.req.raw, MAX_PACKAGE_BODY_BYTES);
    const input = parsePackageRequest(JSON.parse(raw) as unknown);
    const grants = await authStub(c.env).issueAuthConnectGrants(input.providers);
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
    return c.json({ envelope });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: "Authentication connection request is too large." }, 413);
    }
    return c.json({ error: "Authentication connection request was rejected." }, 400);
  }
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
  const blocked = await requireGrant(c, "codex");
  if (blocked) return blocked;
  const result = await authStub(c.env).connectCodexAuth(body.auth_json);
  if (!result.ok) {
    return c.json({
      error: result.reason === "needs_reconnect"
        ? "Codex rejected the subscription login. Run `tiller auth connect codex` again."
        : "Codex subscription authentication is temporarily unavailable. Retry the connection.",
      code: result.reason,
    }, result.reason === "needs_reconnect" ? 409 : 503);
  }
  await hubStub(c.env).setConfig("openaiBillingMode", "subscription");
  invalidateConfigCache();
  return c.json({
    ok: true,
    authenticated: true,
    expires_at: Date.parse(result.credential.expiresAt),
    account_id: result.credential.accountId,
  });
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
  const blocked = await requireGrant(c, "claude");
  if (blocked) return blocked;
  const hub = hubStub(c.env);
  await hub.setConfig("CLAUDE_CODE_OAUTH_TOKEN", body.oauth_token.trim());
  await hub.setConfig("claudeBillingMode", "subscription");
  invalidateConfigCache();
  return c.json({ ok: true, authenticated: true });
});

export default authConnectRoutes;
