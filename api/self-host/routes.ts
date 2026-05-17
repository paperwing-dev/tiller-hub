import { Hono } from "hono";
import type { Context } from "hono";
import { normalizeCloudflareUiError } from "../cloudflare-errors";
import type { HonoEnv } from "../types";
import {
  verifyCfAccessJwt,
  verifyCfAccessServiceToken,
  verifyCloudflareAccessToken,
  verifyWorkersDevRollbackAccess,
} from "../auth";
import { getRouteKind, resolveProtectionState } from "../protection";
import {
  revokeSelfHostSetupCredentials,
} from "../access/manage";
import { resolveSetupStatus } from "../setup/status-resolver";
import {
  accessCertsUrl,
  commitSelfHostProgress,
  commitSelfHostMutation,
  createSelfHostFailureProgress,
  createPendingSelfHostState,
  expireSelfHostStateIfNeeded,
  failSelfHostSetup,
  isSelfHostStateExpired,
  readConfigValue,
  readSelfHostState,
  readWorkersDevRollbackConfig,
  rollbackConfigEntries,
  type PendingSelfHostState,
  type PromotedSelfHostState,
  type SelfHostSetupProgress,
  type SelfHostSetupProgressStep,
  type SelfHostState,
} from "./state";
import { prepareSelfHostResources } from "./provisioner";

const NO_STORE_HEADER = "no-store";

function setNoStore(c: Context<HonoEnv>): void {
  c.header("Cache-Control", NO_STORE_HEADER);
}

function normalizeEmails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const email = item.trim().toLowerCase();
    if (!email) continue;
    deduped.add(email);
  }
  return [...deduped];
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function requestHostname(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

function getPayloadEmail(payload: Record<string, unknown>): string | null {
  for (const key of ["email", "common_name", "preferred_username"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().includes("@")) {
      return value.trim().toLowerCase();
    }
  }
  return null;
}

function setupGateBody(setupPhase: string): { error: string; code: string; setupPhase: string; hint: string } {
  if (setupPhase === "protect-hub") {
    return {
      error: "Protect this workers.dev hub with Cloudflare Access before starting Tiller Self Host setup.",
      code: "setup_phase_protect_hub",
      setupPhase,
      hint: "Finish the Protect Hub step, reload the protected workers.dev URL, then rerun `tiller host setup`.",
    };
  }
  if (setupPhase === "model-access") {
    return {
      error: "Finish model access setup before starting Tiller Self Host setup.",
      code: "setup_phase_model_access",
      setupPhase,
      hint: "Configure the model credentials shown in setup, then rerun `tiller host setup`.",
    };
  }
  return {
    error: "Finish first-run setup before starting Tiller Self Host setup.",
    code: "setup_phase_incomplete",
    setupPhase,
    hint: "Complete the remaining setup step, then rerun `tiller host setup`.",
  };
}

function selfHostExpected(state: SelfHostState): { attemptId: string; phase: SelfHostState["phase"] } {
  return { attemptId: state.attemptId, phase: state.phase };
}

function setupProgress(
  step: SelfHostSetupProgressStep,
  message: string,
  options: { error?: string; updatedAt?: string } = {},
): SelfHostSetupProgress {
  return {
    step,
    message,
    ...(options.error ? { error: options.error } : {}),
    updatedAt: options.updatedAt ?? new Date().toISOString(),
  };
}

async function commitTerminalFailure(
  c: Context<HonoEnv>,
  state: PromotedSelfHostState,
  progress: SelfHostSetupProgress & { step: "failed" },
): Promise<SelfHostState | null> {
  return failSelfHostSetup(c.env, state, progress);
}

function isCliProgressStep(value: unknown): value is SelfHostSetupProgressStep {
  return value === "docker"
    || value === "cloudflared"
    || value === "image"
    || value === "activate"
    || value === "failed";
}

function activeCustomDomainConfigEntries(
  state: PendingSelfHostState,
  clientSecret: string,
): Record<string, string | null> {
  const { resources } = state;
  return {
    HUB_PUBLIC_URL: resources.workerCustomDomain.hubUrl,
    WORKER_SERVICE_NAME: resources.workerCustomDomain.service,
    WORKERS_DEV_ALIAS_DISABLED: "false",
    TILLER_DEPLOYMENT_MODE: "hosted",
    CF_ACCESS_CONFIGURED: "true",
    CF_ACCESS_APP_ID: resources.hubAccess.appId,
    CF_ACCESS_AUD: resources.hubAccess.aud,
    CF_ACCESS_TEAM_DOMAIN: resources.hubAccess.issuer,
    CF_ACCESS_JWKS_URL: resources.hubAccess.jwksUrl ?? "",
    CF_ACCESS_APP_DOMAIN: resources.hubAccess.appDomain,
    CF_ACCESS_APP_TYPE: "",
    CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN: "",
    CF_ACCESS_CLIENT_ID: resources.hubAccess.clientId,
    CF_ACCESS_CLIENT_SECRET: clientSecret,
    CF_ACCESS_BROWSER_POLICY_ID: resources.hubAccess.browserPolicyId,
    CF_ACCESS_SERVICE_TOKEN_ID: resources.hubAccess.serviceTokenId,
    CF_ACCESS_SERVICE_TOKEN_POLICY_ID: resources.hubAccess.serviceTokenPolicyId,
    TILLER_GATEWAY_HOSTNAME: resources.gateway.hostname,
    CF_ACCESS_GATEWAY_APP_ID: resources.gateway.appId,
    CF_ACCESS_GATEWAY_APP_DOMAIN: resources.gateway.appDomain,
    CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: resources.gateway.serviceTokenPolicyId,
    TILLER_GATEWAY_TUNNEL_ID: resources.gateway.tunnelId,
    TILLER_GATEWAY_TUNNEL_NAME: resources.gateway.tunnelName,
    TILLER_GATEWAY_TUNNEL_TARGET_PORT: String(resources.gateway.tunnelTargetPort),
  };
}

function promotedSelfHostState(state: PendingSelfHostState): PromotedSelfHostState {
  return {
    schemaVersion: 2,
    phase: "promoted",
    attemptId: state.attemptId,
    expiresAt: state.expiresAt,
    rollback: state.rollback,
    resources: state.resources,
    progress: setupProgress("credentials-issued", "One-time Self Host credentials were issued to the CLI."),
    secretMaterial: {
      enableToken: state.secretMaterial.enableToken,
    },
  };
}

function enabledSelfHostState(state: PromotedSelfHostState): SelfHostState {
  return {
    schemaVersion: 2,
    phase: "enabled",
    attemptId: state.attemptId,
    rollback: state.rollback,
    resources: state.resources,
    progress: setupProgress("complete", "Tiller Self Host is enabled."),
  };
}

async function revokeStoredSelfHostResources(apiToken: string, state: SelfHostState): Promise<void> {
  await revokeSelfHostSetupCredentials(apiToken, {
    accountId: state.resources.workerCustomDomain.accountId,
    hubAppId: state.resources.hubAccess.appId,
    hubBrowserPolicyId: state.resources.hubAccess.browserPolicyId,
    hubServiceTokenPolicyId: state.resources.hubAccess.serviceTokenPolicyId,
    hubServiceTokenId: state.resources.hubAccess.serviceTokenId,
    gatewayAppId: state.resources.gateway.appId,
    gatewayServiceTokenPolicyId: state.resources.gateway.serviceTokenPolicyId,
  });
}

function renderSelfHostSetupPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tiller Self Host Setup</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fa; color: #24292f; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fa; }
      main { width: min(42rem, calc(100vw - 2rem)); border: 1px solid #d0d7de; border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgba(31,35,40,.08); padding: 1.5rem; }
      h1 { margin: 0; font-size: 1.35rem; line-height: 1.2; }
      p { color: #57606a; line-height: 1.5; }
      form { display: grid; gap: .9rem; margin-top: 1rem; }
      label { display: grid; gap: .35rem; font-size: .78rem; font-weight: 700; color: #57606a; text-transform: uppercase; letter-spacing: .08em; }
      input, textarea { border: 1px solid #d0d7de; border-radius: 8px; padding: .7rem .8rem; font: inherit; color: #24292f; }
      textarea { min-height: 5rem; resize: vertical; }
      button { justify-self: start; border: 0; border-radius: 8px; background: #0969da; color: #fff; padding: .7rem 1rem; font: inherit; font-weight: 700; cursor: pointer; }
      button:disabled { opacity: .55; cursor: not-allowed; }
      .panel { margin-top: 1rem; border: 1px solid #d0d7de; border-radius: 8px; background: #f6f8fa; padding: .85rem; }
      .error { color: #cf222e; }
      .success { color: #1a7f37; }
      code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    </style>
  </head>
  <body>
    <main>
      <h1>Tiller Self Host Setup</h1>
      <p id="intro">This flow graduates your protected workers.dev hub to a protected custom domain and hands one-time host credentials back to the CLI.</p>
      <div id="status" class="panel">Checking hub setup...</div>
      <form id="setup-form" hidden>
        <label>
          Custom hostname
          <input id="hostname" name="hostname" placeholder="tiller.example.com" autocomplete="off" required />
        </label>
        <label>
          Allowed emails
          <textarea id="emails" name="emails" placeholder="you@example.com"></textarea>
        </label>
        <label>
          Cloudflare API token
          <input id="api-token" name="api-token" type="password" autocomplete="off" required />
        </label>
        <button id="submit" type="submit">Continue</button>
      </form>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const callbackPort = params.get("port") || "";
      const callbackState = params.get("state") || "";
      const statusEl = document.getElementById("status");
      const formEl = document.getElementById("setup-form");
      const submitEl = document.getElementById("submit");

      function setStatus(message, kind) {
        statusEl.textContent = message;
        statusEl.className = kind ? "panel " + kind : "panel";
      }

      function parseEmails(value) {
        return value.split(/[\\s,;]+/).map((item) => item.trim().toLowerCase()).filter(Boolean);
      }

      async function checkReady() {
        const port = Number.parseInt(callbackPort, 10);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !callbackState.trim()) {
          setStatus("Invalid setup link. Return to the terminal and rerun tiller host setup.", "error");
          return;
        }
        const response = await fetch("/api/setup/status", { credentials: "include", cache: "no-store" });
        const status = await response.json().catch(() => null);
        if (!response.ok || !status) {
          setStatus("Could not read setup status. Reload this page after signing in through Cloudflare Access.", "error");
          return;
        }
        if (status.setupPhase !== "complete") {
          const detail = status.setupPhase === "protect-hub"
            ? "Protect this workers.dev hub with Cloudflare Access, then rerun tiller host setup."
            : status.setupPhase === "model-access"
              ? "Finish model access setup, then rerun tiller host setup."
              : "Finish first-run setup, then rerun tiller host setup.";
          setStatus(detail, "error");
          return;
        }
        setStatus("Enter the custom domain and Cloudflare token to prepare Self Host.", "");
        formEl.hidden = false;
      }

      formEl.addEventListener("submit", async (event) => {
        event.preventDefault();
        submitEl.disabled = true;
        setStatus("Preparing custom domain, Access, service token, and gateway resources...", "");
        try {
          const response = await fetch("/api/setup/self-host/prepare", {
            method: "POST",
            credentials: "include",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              hostname: document.getElementById("hostname").value,
              emails: parseEmails(document.getElementById("emails").value),
              apiToken: document.getElementById("api-token").value,
            }),
          });
          const body = await response.json().catch(() => ({ error: "Unexpected response from the hub." }));
          if (!response.ok) {
            setStatus(body.error || "Self Host preparation failed.", "error");
            submitEl.disabled = false;
            return;
          }
          setStatus("Custom domain prepared. Continue through Cloudflare Access on the custom domain.", "success");
          const promote = new URL("/cli/self-host-promote", body.customHubUrl);
          promote.searchParams.set("attemptId", body.attemptId);
          promote.searchParams.set("nonce", body.nonce);
          promote.searchParams.set("port", callbackPort);
          promote.searchParams.set("state", callbackState);
          promote.searchParams.set("workersDevHubUrl", body.workersDevHubUrl);
          window.location.href = promote.toString();
        } catch (error) {
          setStatus(error instanceof Error ? error.message : "Self Host preparation failed.", "error");
          submitEl.disabled = false;
        }
      });

      void checkReady();
    </script>
  </body>
</html>`;
}

function renderSelfHostPromotePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tiller Self Host Promotion</title>
    <style>
      :root { color-scheme: light; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #f6f8fa; color: #24292f; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f8fa; }
      main { width: min(38rem, calc(100vw - 2rem)); border: 1px solid #d0d7de; border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgba(31,35,40,.08); padding: 1.5rem; }
      h1 { margin: 0; font-size: 1.35rem; }
      p { color: #57606a; line-height: 1.5; }
      .panel { margin-top: 1rem; border: 1px solid #d0d7de; border-radius: 8px; background: #f6f8fa; padding: .85rem; }
      .error { color: #cf222e; }
      .success { color: #1a7f37; }
    </style>
  </head>
  <body>
    <main>
      <h1>Completing Tiller Self Host</h1>
      <p>The custom domain is being verified through Cloudflare Access. Keep the terminal window open.</p>
      <div id="status" class="panel">Promoting the custom domain...</div>
    </main>
    <script>
      const params = new URLSearchParams(window.location.search);
      const attemptId = params.get("attemptId") || "";
      const nonce = params.get("nonce") || "";
      const callbackPort = params.get("port") || "";
      const callbackState = params.get("state") || "";
      const statusEl = document.getElementById("status");

      function setStatus(message, kind) {
        statusEl.textContent = message;
        statusEl.className = kind ? "panel " + kind : "panel";
      }

      function renderLifecycle(lifecycle) {
        const progress = lifecycle && typeof lifecycle === "object" ? lifecycle.progress : null;
        if (lifecycle && lifecycle.phase === "enabled") {
          setStatus("Tiller Self Host is enabled. You can close this window.", "success");
          return true;
        }
        if (progress && progress.step === "complete") {
          setStatus(progress.message || "Tiller Self Host is enabled. You can close this window.", "success");
          return true;
        }
        if (progress && progress.step === "failed") {
          setStatus(progress.error ? progress.message + " " + progress.error : progress.message || "Self Host setup failed.", "error");
          return true;
        }
        if (progress && progress.message) {
          setStatus(progress.message, "");
          return false;
        }
        setStatus("Waiting for local host checks...", "");
        return false;
      }

      async function pollLifecycle() {
        try {
          const response = await fetch("/api/setup/self-host/lifecycle?attemptId=" + encodeURIComponent(attemptId), {
            credentials: "include",
            cache: "no-store",
          });
          const body = await response.json().catch(() => ({ error: "Unexpected lifecycle response from the hub." }));
          if (!response.ok) {
            setStatus(body.error || "Could not read Self Host setup progress.", "error");
            return;
          }
          if (renderLifecycle(body)) return;
        } catch {
          setStatus("Waiting for local host checks...", "");
        }
        window.setTimeout(pollLifecycle, 1500);
      }

      async function run() {
        const port = Number.parseInt(callbackPort, 10);
        if (!attemptId || !nonce || !callbackState || !Number.isInteger(port) || port < 1 || port > 65535) {
          setStatus("Invalid promotion link. Rerun tiller host setup from the workers.dev URL.", "error");
          return;
        }

        const promoteResponse = await fetch("/api/setup/self-host/promote", {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ attemptId, nonce }),
        });
        const payload = await promoteResponse.json().catch(() => ({ error: "Unexpected response from the hub." }));
        if (!promoteResponse.ok) {
          setStatus(payload.error || "Custom-domain promotion failed. Rerun setup from the workers.dev URL.", "error");
          return;
        }

        setStatus("Sending one-time credentials to the CLI...", "");
        try {
          const callbackResponse = await fetch("http://127.0.0.1:" + port + "/self-host-setup-callback", {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({ state: callbackState, ...payload }),
          });
          const callbackBody = await callbackResponse.json().catch(() => ({ error: "Unexpected response from the local callback." }));
          if (!callbackResponse.ok) {
            setStatus(callbackBody.error || "The local CLI callback did not accept the setup payload. Rerun setup from the workers.dev URL.", "error");
            return;
          }
          setStatus("Credential handoff complete. Waiting for local Docker, gateway, and image checks...", "");
          pollLifecycle();
        } catch {
          setStatus("Could not reach the local CLI callback. Rerun setup from the workers.dev URL to rotate the one-time credentials.", "error");
        }
      }

      void run();
    </script>
  </body>
</html>`;
}

const selfHostRoutes = new Hono<HonoEnv>();

selfHostRoutes.get("/cli/self-host-setup", (c) => {
  setNoStore(c);
  return c.html(renderSelfHostSetupPage());
});

selfHostRoutes.get("/cli/self-host-promote", (c) => {
  setNoStore(c);
  return c.html(renderSelfHostPromotePage());
});

selfHostRoutes.post("/api/setup/self-host/prepare", async (c) => {
  if (getRouteKind(c.req.url) !== "workers-dev") {
    return c.json({
      error: "Self Host setup must start from the protected workers.dev hub URL.",
      code: "workers_dev_required",
    }, 400);
  }

  if (!c.req.header("Cf-Access-Jwt-Assertion")?.trim()) {
    return c.json({
      error: "Self Host setup requires browser Cloudflare Access authentication on the protected workers.dev hub.",
      code: "browser_access_required",
    }, 401);
  }

  const body = await c.req.json<{ hostname?: string; apiToken?: string; emails?: unknown }>()
    .catch(() => ({} as { hostname?: string; apiToken?: string; emails?: unknown }));
  const hostname = body.hostname?.trim() ?? "";
  const apiToken = body.apiToken?.trim() ?? "";
  const emails = normalizeEmails(body.emails);

  if (!hostname) return c.json({ error: "Custom domain hostname is required" }, 400);
  if (!apiToken) return c.json({ error: "Cloudflare API token is required" }, 400);
  if (emails.length === 0) return c.json({ error: "At least one allowed email address is required" }, 400);

  const setupStatus = await resolveSetupStatus(c.env, c.req.raw);
  if (setupStatus.setupPhase !== "complete") {
    const gate = setupGateBody(setupStatus.setupPhase);
    return c.json(gate, 409);
  }

  const protection = await resolveProtectionState(c.env, c.req.url);
  if (protection.protectionMode !== "cf-access") {
    return c.json({
      error: "Self Host setup requires the workers.dev hub to be protected by Cloudflare Access.",
      code: "workers_dev_access_required",
    }, 409);
  }

  const existing = await expireSelfHostStateIfNeeded(c.env);

  try {
    const rollback = existing?.rollback ?? await readWorkersDevRollbackConfig(c.env, protection.currentOrigin);
    const prepared = await prepareSelfHostResources({
      env: c.env,
      requestUrl: c.req.url,
      apiToken,
      hostname,
      emails,
    });
    const state = createPendingSelfHostState({
      rollback,
      resources: prepared.resources,
      clientSecret: prepared.clientSecret,
      tunnelToken: prepared.tunnelToken,
    });

    const stored = await commitSelfHostMutation(c.env, {
      expected: existing ? selfHostExpected(existing) : { state: "absent" },
      nextState: state,
      configEntries: existing && existing.phase !== "pending"
        ? rollbackConfigEntries(existing.rollback)
        : {},
    });
    if (!stored) {
      await prepared.cleanupDraftResources().catch(() => {});
      return c.json({ error: "Another Self Host setup attempt started first. Reload and try again." }, 409);
    }
    if (existing) {
      await revokeStoredSelfHostResources(apiToken, existing).catch((error) => {
        console.warn("[self-host] Failed to revoke superseded Cloudflare resources:", error);
      });
    }

    return c.json({
      ok: true,
      attemptId: state.attemptId,
      nonce: state.nonce,
      customHubUrl: prepared.customHubUrl,
      workersDevHubUrl: state.rollback.workersDevHubUrl,
      gatewayHostname: prepared.gatewayHostname,
      expiresAt: state.expiresAt,
    });
  } catch (error) {
    const normalized = normalizeCloudflareUiError(error, hostname);
    return c.json(normalized, normalized.status);
  }
});

selfHostRoutes.post("/api/setup/self-host/promote", async (c) => {
  const body = await c.req.json<{ attemptId?: string; nonce?: string }>()
    .catch(() => ({} as { attemptId?: string; nonce?: string }));
  const attemptId = normalizeOptionalString(body.attemptId);
  const nonce = normalizeOptionalString(body.nonce);
  await expireSelfHostStateIfNeeded(c.env);
  const state = await readSelfHostState(c.env);

  if (!state || state.phase !== "pending") {
    return c.json({ error: "No pending Self Host setup attempt is available. Rerun setup from the workers.dev URL." }, 409);
  }
  if (isSelfHostStateExpired(state)) {
    return c.json({ error: "Self Host setup expired. Rerun setup from the workers.dev URL." }, 409);
  }
  if (!attemptId || attemptId !== state.attemptId || !nonce || nonce !== state.nonce) {
    return c.json({ error: "Self Host setup attempt did not match." }, 400);
  }
  if (requestHostname(c.req.url) !== state.resources.workerCustomDomain.hostname) {
    return c.json({ error: "Self Host promotion must be completed from the pending custom domain." }, 400);
  }

  const token = c.req.header("Cf-Access-Jwt-Assertion")?.trim() ?? "";
  if (!token) {
    return c.json({ error: "Cloudflare Access did not send a custom-domain JWT." }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await verifyCloudflareAccessToken(token, {
      audience: state.resources.hubAccess.aud,
      issuer: state.resources.hubAccess.issuer,
      jwksUrl: state.resources.hubAccess.jwksUrl || accessCertsUrl(state.resources.hubAccess.issuer),
    }) as Record<string, unknown>;
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid pending custom-domain JWT" }, 401);
  }

  const email = getPayloadEmail(payload);
  if (!email) {
    return c.json({ error: "Cloudflare Access JWT did not include an email address." }, 403);
  }

  const clientSecret = state.secretMaterial.clientSecret;
  const tunnelToken = state.secretMaterial.tunnelToken;
  const promoted = promotedSelfHostState(state);
  const committed = await commitSelfHostMutation(c.env, {
    expected: selfHostExpected(state),
    nextState: promoted,
    configEntries: activeCustomDomainConfigEntries(state, clientSecret),
  });
  if (!committed) {
    return c.json({ error: "Self Host setup credentials were already consumed. Rerun setup from the workers.dev URL." }, 409);
  }

  return c.json({
    kind: "self-host-setup",
    hubUrl: state.resources.workerCustomDomain.hubUrl,
    workersDevHubUrl: state.rollback.workersDevHubUrl,
    protectionMode: "cf-access",
    clientId: state.resources.hubAccess.clientId,
    clientSecret,
    gatewayHostname: state.resources.gateway.hostname,
    gatewayTunnelId: state.resources.gateway.tunnelId,
    gatewayTunnelName: state.resources.gateway.tunnelName,
    gatewayTunnelToken: tunnelToken,
    gatewayTargetPort: state.resources.gateway.tunnelTargetPort,
    setupAttemptId: state.attemptId,
    enableToken: promoted.secretMaterial.enableToken,
  });
});

selfHostRoutes.post("/api/setup/self-host/progress", async (c) => {
  try {
    await verifyCfAccessServiceToken(c.req.raw, c.env);
  } catch {
    return c.json({ error: "Self Host setup progress requires the active custom-domain service token." }, 401);
  }

  const body = await c.req.json<{
    setupAttemptId?: string;
    setupToken?: string;
    step?: unknown;
    message?: string;
    error?: string;
  }>().catch(() => ({}));
  const setupAttemptId = normalizeOptionalString(body.setupAttemptId);
  const setupToken = normalizeOptionalString(body.setupToken);
  const message = normalizeOptionalString(body.message);
  const error = body.error ? normalizeOptionalString(body.error) : "";
  if (!setupAttemptId || !setupToken) {
    return c.json({ error: "Self Host setup attempt and setup token are required." }, 400);
  }
  if (!isCliProgressStep(body.step)) {
    return c.json({ error: "Unsupported Self Host setup progress step." }, 400);
  }

  const state = await readSelfHostState(c.env);
  if (!state || state.phase !== "promoted") {
    return c.json({ error: "No promoted Self Host setup attempt is waiting for progress." }, 409);
  }
  if (isSelfHostStateExpired(state)) {
    const progress = createSelfHostFailureProgress("Self Host setup expired before it was enabled.", {
      error: "Rolled back to Hosted Tiller. Rerun setup from the workers.dev URL.",
    });
    const failed = await commitTerminalFailure(c, state, progress);
    if (!failed || failed.attemptId !== state.attemptId || failed.phase !== "failed") {
      return c.json({ error: "Self Host setup expiry conflicted with another lifecycle change. Try again." }, 409);
    }
    return c.json({ ok: true, phase: "failed", progress: failed.progress });
  }
  if (setupAttemptId !== state.attemptId || setupToken !== state.secretMaterial.enableToken) {
    return c.json({ error: "Invalid Self Host setup progress token." }, 401);
  }
  if (requestHostname(c.req.url) !== state.resources.workerCustomDomain.hostname) {
    return c.json({ error: "Self Host setup progress must be called on the active custom domain." }, 400);
  }

  const progress = setupProgress(
    body.step,
    message || (body.step === "failed" ? "Self Host setup failed." : "Self Host setup is running."),
    error ? { error } : {},
  );
  if (progress.step === "failed") {
    const failed = await commitTerminalFailure(c, state, progress as SelfHostSetupProgress & { step: "failed" });
    if (!failed || failed.attemptId !== state.attemptId || failed.phase !== "failed") {
      return c.json({ error: "Self Host setup failure conflicted with another lifecycle change. Try again." }, 409);
    }
    return c.json({ ok: true, phase: "failed", progress: failed.progress });
  }

  const committed = await commitSelfHostProgress(c.env, {
    expected: { attemptId: state.attemptId },
    progress,
  });
  if (!committed) {
    return c.json({ error: "Self Host setup progress conflicted with another lifecycle change. Try again." }, 409);
  }

  return c.json({ ok: true, phase: "promoted", progress });
});

selfHostRoutes.get("/api/setup/self-host/lifecycle", async (c) => {
  const attemptId = normalizeOptionalString(c.req.query("attemptId"));
  if (!attemptId) return c.json({ error: "Self Host setup attempt ID is required." }, 400);

  const state = await readSelfHostState(c.env);
  if (!state || state.attemptId !== attemptId) {
    return c.json({ error: "Self Host setup attempt was not found." }, 404);
  }
  if (state.phase === "pending" && isSelfHostStateExpired(state)) {
    await expireSelfHostStateIfNeeded(c.env);
    return c.json({ error: "Self Host setup expired. Rerun setup from the workers.dev URL." }, 410);
  }
  if (state.phase === "promoted" && isSelfHostStateExpired(state)) {
    const progress = createSelfHostFailureProgress("Self Host setup expired before it was enabled.", {
      error: "Rolled back to Hosted Tiller. Rerun setup from the workers.dev URL.",
    });
    const failed = await commitTerminalFailure(c, state, progress);
    if (!failed || failed.attemptId !== state.attemptId || failed.phase !== "failed") {
      return c.json({ error: "Self Host setup expiry conflicted with another lifecycle change. Try again." }, 409);
    }
    return c.json({
      ok: true,
      attemptId: failed.attemptId,
      phase: failed.phase,
      progress: failed.progress,
    });
  }

  return c.json({
    ok: true,
    attemptId: state.attemptId,
    phase: state.phase,
    progress: state.progress ?? null,
  });
});

selfHostRoutes.post("/api/setup/self-host/enable", async (c) => {
  try {
    await verifyCfAccessServiceToken(c.req.raw, c.env);
  } catch {
    return c.json({ error: "Self Host enable requires the active custom-domain service token." }, 401);
  }

  const body = await c.req.json<{ setupAttemptId?: string; enableToken?: string }>()
    .catch(() => ({} as { setupAttemptId?: string; enableToken?: string }));
  const setupAttemptId = normalizeOptionalString(body.setupAttemptId);
  const enableToken = normalizeOptionalString(body.enableToken);
  const state = await expireSelfHostStateIfNeeded(c.env);
  if (!state || state.phase !== "promoted") {
    return c.json({ error: "No promoted Self Host setup attempt is waiting for enable." }, 409);
  }
  if (setupAttemptId !== state.attemptId || enableToken !== state.secretMaterial.enableToken) {
    return c.json({ error: "Invalid Self Host enable token." }, 401);
  }
  if (requestHostname(c.req.url) !== state.resources.workerCustomDomain.hostname) {
    return c.json({ error: "Self Host enable must be called on the active custom domain." }, 400);
  }

  const protection = await resolveProtectionState(c.env, c.req.url);
  const gatewayHostname = await readConfigValue(c.env, "TILLER_GATEWAY_HOSTNAME");
  const gatewayAppId = await readConfigValue(c.env, "CF_ACCESS_GATEWAY_APP_ID");
  const gatewayPolicyId = await readConfigValue(c.env, "CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID");
  const gatewayTunnelId = await readConfigValue(c.env, "TILLER_GATEWAY_TUNNEL_ID");
  if (
    protection.routeKind !== "custom-domain"
    || protection.protectionMode !== "cf-access"
    || !protection.serviceTokenConfigured
    || !gatewayHostname
    || !gatewayAppId
    || !gatewayPolicyId
    || !gatewayTunnelId
  ) {
    return c.json({
      error: "Self Host cloud prerequisites are not active yet. Rerun setup from the workers.dev URL.",
    }, 409);
  }

  const enabled = enabledSelfHostState(state);
  const committed = await commitSelfHostMutation(c.env, {
    expected: selfHostExpected(state),
    nextState: enabled,
    configEntries: {
      TILLER_DEPLOYMENT_MODE: "self-host",
    },
  });
  if (!committed) {
    return c.json({ error: "Self Host enable conflicted with another lifecycle change. Try again." }, 409);
  }

  return c.json({
    ok: true,
    status: await resolveSetupStatus(c.env, c.req.raw),
    progress: enabled.progress ?? null,
  });
});

async function returnToHosted(c: Context<HonoEnv>) {
  const state = await readSelfHostState(c.env);
  if (!state) {
    return c.json({
      error: "No recoverable Self Host state is stored. Rerun setup from the protected workers.dev hub URL.",
    }, 409);
  }

  try {
    if (
      getRouteKind(c.req.url) === "workers-dev"
      && (state.phase === "promoted" || state.phase === "enabled")
    ) {
      await verifyWorkersDevRollbackAccess(c.req.raw, c.env);
    } else {
      await verifyCfAccessJwt(c.req.raw, c.env);
    }
  } catch {
    return c.json({ error: "Return to Hosted Tiller requires browser Cloudflare Access authentication." }, 401);
  }

  const committed = await commitSelfHostMutation(c.env, {
    expected: selfHostExpected(state),
    nextState: null,
    configEntries: rollbackConfigEntries(state.rollback),
  });
  if (!committed) {
    return c.json({ error: "Return to Hosted Tiller conflicted with another lifecycle change. Try again." }, 409);
  }

  return c.json({
    ok: true,
    redirectUrl: state.rollback.workersDevHubUrl || normalizeOrigin(c.req.url),
  });
}

selfHostRoutes.post("/api/setup/self-host/return-to-hosted", returnToHosted);

export default selfHostRoutes;
