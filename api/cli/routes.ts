import { Hono, type Context } from "hono";
import { CompactEncrypt, importJWK, type JWK } from "jose";
import { resolveProtectionState } from "../protection";
import type { HonoEnv } from "../types";
import {
  readCanonicalWorkersDevAccessTrust,
  readWorkersDevAccessCredential,
} from "../workers-dev-access/records";
import { getOrCreateSecret } from "../setup/config";

const CONTROL_SECRET_KEY = "TILLER_CONTROL_SECRET";

function generateControlSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const MAX_CONNECT_PACKAGE_BODY_BYTES = 8 * 1_024;

class RequestBodyTooLargeError extends Error {}

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
    const declaredLength = Number(contentLength);
    if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > maxBytes) {
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

function parseConnectPackageRequest(value: unknown): { publicKeyJwk: JWK; state: string } {
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "publicKeyJwk,state") {
    throw new Error("Invalid connection package request");
  }
  const state = typeof value.state === "string" ? value.state.trim() : "";
  if (!state || state.length > 512) throw new Error("Invalid connection state");
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
  ) {
    throw new Error("Invalid connection public key");
  }
  return { publicKeyJwk: jwk as JWK, state };
}

function renderCliBootstrapPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>Tiller CLI Bootstrap</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, sans-serif; background: #f6f8fa; color: #24292f; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: radial-gradient(circle at top left, #0969da1a, transparent 28rem), #f6f8fa; }
      main { box-sizing: border-box; width: min(36rem, calc(100vw - 2rem)); border: 1px solid #d0d7de; border-radius: 1.25rem; background: #fffc; box-shadow: 0 18px 50px #1f232814; padding: 1.5rem; }
      .eyebrow { margin: 0; font-size: .75rem; font-weight: 700; letter-spacing: .14em; text-transform: uppercase; color: #57606a; }
      h1 { margin: .5rem 0 0; font-size: 1.6rem; }
      p { margin: 0; color: #57606a; line-height: 1.5; }
      .panel { margin-top: 1.25rem; border: 1px solid #d0d7de; border-radius: 1rem; padding: 1rem; background: #fff; }
      .status { font-size: 1rem; font-weight: 650; color: #24292f; }
      .status.success { color: #1a7f37; } .status.error { color: #cf222e; }
      .detail { margin-top: .5rem; font-size: .925rem; }
      .meta { margin-top: 1rem; display: grid; gap: .75rem; }
      .meta-row { display: none; border-radius: .75rem; background: #f6f8fa; padding: .75rem; }
      .meta-row.visible { display: block; }
      .meta-label { display: block; margin-bottom: .35rem; font-size: .75rem; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: #57606a; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-word; }
      .code-shell { display: grid; gap: .75rem; } .code-value { display: block; overflow-wrap: anywhere; white-space: pre-wrap; }
      button { width: fit-content; border: 1px solid #0969da; border-radius: 999px; background: #0969da; color: #fff; padding: .5rem 1rem; font: inherit; font-weight: 650; cursor: pointer; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Tiller CLI</p>
      <h1>Connect Tiller</h1>
      <div class="panel">
        <p id="status" class="status">Waiting for browser sign-in…</p>
        <p id="detail" class="detail">If this Hub is protected, finish the Cloudflare Access login in this tab.</p>
        <div class="meta">
          <div id="hub-row" class="meta-row"><span class="meta-label">Hub URL</span><code id="hub-url"></code></div>
          <div id="mode-row" class="meta-row"><span class="meta-label">Protection mode</span><code id="protection-mode"></code></div>
          <div id="code-row" class="meta-row">
            <span class="meta-label">Connection code</span>
            <div class="code-shell"><code id="connection-code" class="code-value"></code><button id="copy-code" type="button">Copy code</button></div>
          </div>
        </div>
      </div>
    </main>
    <script>
      const STORAGE_KEY = "tiller-cli-connect-v1";
      const CONNECTION_REQUEST_TTL_MS = 5 * 60 * 1000;
      const statusEl = document.getElementById("status");
      const detailEl = document.getElementById("detail");
      const hubRowEl = document.getElementById("hub-row");
      const hubUrlEl = document.getElementById("hub-url");
      const modeRowEl = document.getElementById("mode-row");
      const protectionModeEl = document.getElementById("protection-mode");
      const codeRowEl = document.getElementById("code-row");
      const connectionCodeEl = document.getElementById("connection-code");
      const copyCodeEl = document.getElementById("copy-code");

      function setState(kind, title, detail) {
        statusEl.textContent = title;
        statusEl.className = kind ? "status " + kind : "status";
        detailEl.textContent = detail;
      }

      function showConfig(hubUrl, mode) {
        hubUrlEl.textContent = hubUrl;
        hubRowEl.classList.add("visible");
        protectionModeEl.textContent = mode === "cf-access" ? "Cloudflare Access" : "Public";
        modeRowEl.classList.add("visible");
      }

      function encodePublicCode(payload) {
        const bytes = new TextEncoder().encode(JSON.stringify(payload));
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
      }

      function showConnectionCode(code) {
        connectionCodeEl.textContent = code;
        codeRowEl.classList.add("visible");
        copyCodeEl.onclick = async () => {
          try {
            await navigator.clipboard.writeText(code);
            copyCodeEl.textContent = "Copied";
          } catch {
            copyCodeEl.textContent = "Copy failed";
          }
          window.setTimeout(() => { copyCodeEl.textContent = "Copy code"; }, 1200);
        };
      }

      function hideConnectionCode() {
        connectionCodeEl.textContent = "";
        codeRowEl.classList.remove("visible");
        copyCodeEl.onclick = null;
      }

      function decodeBase64UrlJson(value) {
        const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
        const binary = atob(padded);
        return JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
      }

      function readConnectionRequest() {
        const params = new URLSearchParams(location.search);
        const port = Number.parseInt(params.get("port") || "", 10);
        const state = params.get("state") || "";
        const key = params.get("key") || "";
        if (Number.isInteger(port) && port >= 1 && port <= 65535 && state && key) {
          try {
            const request = { port, state, publicKeyJwk: decodeBase64UrlJson(key), createdAt: Date.now() };
            sessionStorage.setItem(STORAGE_KEY, JSON.stringify(request));
            return request;
          } catch {}
        }
        try {
          const request = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "null");
          const age = Date.now() - Number(request?.createdAt);
          if (
            request
            && Number.isInteger(request.port)
            && request.state
            && request.publicKeyJwk
            && Number.isFinite(age)
            && age >= 0
            && age <= CONNECTION_REQUEST_TTL_MS
          ) return request;
          sessionStorage.removeItem(STORAGE_KEY);
          return null;
        } catch {
          sessionStorage.removeItem(STORAGE_KEY);
          return null;
        }
      }

      async function deliver(port, body, connectionCode) {
        showConnectionCode(connectionCode);
        setState("", "Sending connection details to Tiller…", "If Tiller is on another machine, paste the connection code shown below into the terminal.");
        try {
          const response = await fetch("http://127.0.0.1:" + port + "/bootstrap-callback", {
            method: "POST",
            mode: "cors",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const value = await response.json().catch(() => ({}));
          if (!response.ok) {
            setState("", value.error || "Connection code ready", "Paste the connection code shown below into the terminal.");
            return;
          }
          sessionStorage.removeItem(STORAGE_KEY);
          hideConnectionCode();
          setState("success", "Connection complete", "Return to your terminal. The CLI will finish startup automatically.");
        } catch {
          setState("", "Connection code ready", "Could not reach the local callback. Paste the connection code shown below into the terminal.");
        }
      }

      async function run() {
        const request = readConnectionRequest();
        if (!request) {
          setState("error", "Invalid connection link", "Return to the Tiller CLI and retry the connection flow.");
          return;
        }
        try {
          const response = await fetch("/api/cli/bootstrap-config", { credentials: "include", cache: "no-store", headers: { Accept: "application/json" } });
          const value = await response.json().catch(() => ({}));
          if (response.ok && value.protectionMode === "public") {
            showConfig(value.hubUrl, "public");
            const payload = { state: request.state, ...value };
            await deliver(request.port, payload, encodePublicCode(payload));
            return;
          }
          if (value.code === "setup_protection_required") {
            setState(
              "error",
              "This Hub needs Access repair",
              "Use the documented maintainer Access repair procedure, then retry this command.",
            );
            return;
          }
          if (response.status !== 410 || value.code !== "generic_secret_bootstrap_disabled") {
            throw new Error(value.error || "Hub connection setup failed.");
          }

          const packageResponse = await fetch("/api/cli/connect-package", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ publicKeyJwk: request.publicKeyJwk, state: request.state }),
          });
          const packageValue = await packageResponse.json().catch(() => ({}));
          if (!packageResponse.ok || !packageValue.envelope) {
            throw new Error(packageValue.error || "Connection package could not be issued.");
          }
          showConfig(location.origin, "cf-access");
          await deliver(request.port, { envelope: packageValue.envelope }, packageValue.envelope);
        } catch (error) {
          setState("error", "Connection setup failed", error instanceof Error ? error.message : "Retry from the Tiller CLI.");
        }
      }

      void run();
    </script>
  </body>
</html>`;
}

const cliRoutes = new Hono<HonoEnv>();

cliRoutes.get("/api/cli/bootstrap-config", async (c) => {
  const protection = await resolveProtectionState(c.env, c.req.url);
  setNoStore(c);
  if (protection.protectionMode !== "cf-access") {
    return c.json({ hubUrl: protection.hubUrl, protectionMode: "public" as const });
  }
  return c.json({
    error: "Protected hubs issue credentials only through encrypted tiller connect.",
    code: "generic_secret_bootstrap_disabled" as const,
    hubUrl: protection.hubUrl,
    protectionMode: "cf-access" as const,
  }, 410);
});

cliRoutes.post("/api/cli/connect-package", async (c) => {
  setNoStore(c);
  try {
    const raw = await readBoundedText(c.req.raw, MAX_CONNECT_PACKAGE_BODY_BYTES);
    const input = parseConnectPackageRequest(JSON.parse(raw) as unknown);
    const protection = await resolveProtectionState(c.env, c.req.url);
    const hubUrl = new URL(protection.hubUrl).origin;
    if (protection.protectionMode !== "cf-access" || hubUrl !== protection.hubUrl) {
      return c.json({
        error: "Encrypted connection packages are available from a protected Tiller Hub.",
        code: "protected_connection_required",
      }, 409);
    }
    const [trust, credential, controlSecret] = await Promise.all([
      readCanonicalWorkersDevAccessTrust(c.env),
      readWorkersDevAccessCredential(c.env),
      getOrCreateSecret(c.env, CONTROL_SECRET_KEY, generateControlSecret),
    ]);
    const clientId = trust?.serviceClientId.trim() ?? "";
    const clientSecret = credential?.currentSecret.trim() ?? "";
    const tokenExpiresAt = credential?.tokenExpiresAt.trim() ?? "";
    const activeWorkersDevTrustMatches =
      trust?.workersDevHostname === new URL(hubUrl).hostname;
    if (
      !trust
      || !credential
      || !activeWorkersDevTrustMatches
      || !clientId
      || !clientSecret
      || !/^[A-Za-z0-9_-]{43}$/.test(controlSecret)
      || !Number.isFinite(Date.parse(tokenExpiresAt))
    ) {
      return c.json({
        error: "The protected Hub connection credential is unavailable.",
        code: "connection_credential_unavailable",
      }, 409);
    }
    const publicKey = await importJWK(input.publicKeyJwk, "ECDH-ES");
    const now = Math.floor(Date.now() / 1_000);
    const plaintext = new TextEncoder().encode(JSON.stringify({
      hubUrl,
      clientId,
      clientSecret,
      controlSecret,
      tokenExpiresAt,
      state: input.state,
      iat: now,
      exp: now + 5 * 60,
    }));
    const envelope = await new CompactEncrypt(plaintext)
      .setProtectedHeader({ alg: "ECDH-ES", enc: "A256GCM", typ: "tiller-connect+jwe" })
      .encrypt(publicKey);
    return c.json({ envelope });
  } catch {
    return c.json({ error: "Connection package request was rejected." }, 400);
  }
});

cliRoutes.get("/cli/bootstrap", (c) => {
  setNoStore(c);
  return c.html(renderCliBootstrapPage());
});

export default cliRoutes;
