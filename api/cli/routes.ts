import { Hono, type Context } from "hono";
import { resolveManagedMachineHostStatus } from "../machine-hosts";
import { getSecret } from "../setup/config";
import { resolveProtectionState } from "../protection";
import type { HonoEnv } from "../types";

const NO_STORE_HEADER = "no-store";
const DEFAULT_GATEWAY_TARGET_PORT = 8788;

function trimOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseTargetPort(value: string | undefined): number {
  const parsed = Number.parseInt(value?.trim() ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_GATEWAY_TARGET_PORT;
}

function setNoStore(c: Context<HonoEnv>): void {
  c.header("Cache-Control", NO_STORE_HEADER);
}

function renderCliBootstrapPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tiller CLI Bootstrap</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #f6f8fa;
        color: #24292f;
      }

      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background:
          radial-gradient(circle at top left, rgba(9, 105, 218, 0.1), transparent 28rem),
          linear-gradient(180deg, #f8fbff 0%, #f6f8fa 100%);
      }

      main {
        width: min(34rem, calc(100vw - 2rem));
        border: 1px solid #d0d7de;
        border-radius: 1.25rem;
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 18px 50px rgba(31, 35, 40, 0.08);
        padding: 1.5rem;
      }

      .eyebrow {
        margin: 0;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: #57606a;
      }

      h1 {
        margin: 0.5rem 0 0;
        font-size: 1.5rem;
        line-height: 1.2;
      }

      p {
        margin: 0;
        color: #57606a;
        line-height: 1.5;
      }

      .panel {
        margin-top: 1.25rem;
        border: 1px solid #d0d7de;
        border-radius: 1rem;
        padding: 1rem;
        background: #fff;
      }

      .status {
        font-size: 1rem;
        font-weight: 600;
        color: #24292f;
      }

      .status.success {
        color: #1a7f37;
      }

      .status.error {
        color: #cf222e;
      }

      .detail {
        margin-top: 0.5rem;
        font-size: 0.925rem;
      }

      .meta {
        margin-top: 1rem;
        display: grid;
        gap: 0.75rem;
      }

      .meta-row {
        display: none;
        border-radius: 0.75rem;
        background: #f6f8fa;
        padding: 0.75rem;
      }

      .meta-row.visible {
        display: block;
      }

      .meta-label {
        display: block;
        margin-bottom: 0.35rem;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #57606a;
      }

      code {
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, monospace;
        word-break: break-word;
      }

      .code-shell {
        display: grid;
        gap: 0.75rem;
      }

      .code-value {
        display: block;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .copy-button {
        width: fit-content;
        border: 1px solid #0969da;
        border-radius: 999px;
        background: #0969da;
        color: #fff;
        padding: 0.45rem 0.9rem;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }

      .copy-button:hover {
        background: #0860ca;
      }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Tiller CLI</p>
      <h1>Connect Tiller</h1>
      <div class="panel">
        <p id="status" class="status">Waiting for browser sign-in…</p>
        <p id="detail" class="detail">If this hub is protected, finish the Cloudflare Access login in this tab.</p>
        <div class="meta">
          <div id="hub-row" class="meta-row">
            <span class="meta-label">Hub URL</span>
            <code id="hub-url"></code>
          </div>
          <div id="mode-row" class="meta-row">
            <span class="meta-label">Protection mode</span>
            <code id="protection-mode"></code>
          </div>
          <div id="code-row" class="meta-row">
            <span class="meta-label">Connection code</span>
            <div class="code-shell">
              <code id="connection-code" class="code-value"></code>
              <button id="copy-code" class="copy-button" type="button">Copy code</button>
            </div>
          </div>
        </div>
      </div>
    </main>
    <script>
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

      function showConfig(config) {
        if (config.hubUrl) {
          hubUrlEl.textContent = config.hubUrl;
          hubRowEl.classList.add("visible");
        }

        const label = config.protectionMode === "cf-access" ? "Cloudflare Access" : "Public";
        protectionModeEl.textContent = label;
        modeRowEl.classList.add("visible");
      }

      function encodeConnectionCode(payload) {
        const json = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(json);
        let binary = "";
        for (const byte of bytes) {
          binary += String.fromCharCode(byte);
        }
        return btoa(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/g, "");
      }

      function showConnectionCode(payload) {
        const code = encodeConnectionCode(payload);
        connectionCodeEl.textContent = code;
        codeRowEl.classList.add("visible");
        copyCodeEl.onclick = async () => {
          try {
            await navigator.clipboard.writeText(code);
            copyCodeEl.textContent = "Copied";
            window.setTimeout(() => {
              copyCodeEl.textContent = "Copy code";
            }, 1200);
          } catch {
            copyCodeEl.textContent = "Copy failed";
            window.setTimeout(() => {
              copyCodeEl.textContent = "Copy code";
            }, 1200);
          }
        };
      }

      async function run() {
        const params = new URLSearchParams(window.location.search);
        const portRaw = params.get("port") || "";
        const state = params.get("state") || "";
        const port = Number.parseInt(portRaw, 10);

        if (!Number.isInteger(port) || port < 1 || port > 65535 || !state.trim()) {
          setState("error", "Invalid connection link", "Return to the Tiller CLI and retry the connection flow.");
          return;
        }

        let config;
        try {
          const res = await fetch("/api/cli/bootstrap-config", {
            credentials: "include",
            cache: "no-store",
            headers: { Accept: "application/json" },
          });
          const body = await res.json().catch(() => ({ error: "Unexpected response from the hub." }));
          if (!res.ok) {
            setState(
              "error",
              body.error || "Hub connection setup failed",
              body.hint || "Open Settings → Publish & Protect, then retry from the CLI.",
            );
            return;
          }
          config = body;
        } catch (error) {
          setState(
            "error",
            "Could not read the hub connection configuration",
            error instanceof Error ? error.message : "Retry from the Tiller CLI.",
          );
          return;
        }

        showConfig(config);
        showConnectionCode({ state, ...config });
        setState(
          "",
          "Sending connection details to Tiller…",
          "If Tiller is running on another machine, paste the connection code shown below into the terminal.",
        );

        try {
          const res = await fetch(\`http://127.0.0.1:\${port}/bootstrap-callback\`, {
            method: "POST",
            mode: "cors",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ state, ...config }),
          });
          const body = await res.json().catch(() => ({ error: "Unexpected response from the local callback." }));
          if (!res.ok) {
            setState(
              "",
              body.error || "Connection code ready",
              "The local Tiller callback was not available. If Tiller is running on another machine, paste the connection code shown below into the terminal.",
            );
            return;
          }

          setState(
            "success",
            "Connection complete",
            "Return to your terminal. The CLI will finish startup automatically.",
          );
        } catch (error) {
          setState(
            "",
            "Connection code ready",
            "Could not reach the local Tiller callback. If Tiller is running on another machine, paste the connection code shown below into the terminal.",
          );
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
  const managedMachineHosts = await resolveManagedMachineHostStatus(c.env, protection);
  setNoStore(c);

  if (protection.protectionMode !== "cf-access") {
    return c.json({
      hubUrl: protection.hubUrl,
      protectionMode: "public" as const,
      gatewayHostname: managedMachineHosts.gatewayHostname,
    });
  }

  const clientId = (await getSecret(c.env, "CF_ACCESS_CLIENT_ID"))?.trim() ?? "";
  const clientSecret = (await getSecret(c.env, "CF_ACCESS_CLIENT_SECRET"))?.trim() ?? "";

  if (!clientId || !clientSecret) {
    return c.json(
      {
        error: "This protected hub does not currently have a stored CLI service token.",
        code: "missing_service_token" as const,
        hint: "Open Settings → Publish & Protect and reissue the service token, then run `tiller` again.",
      },
      409,
    );
  }

  return c.json({
    hubUrl: protection.hubUrl,
    protectionMode: "cf-access" as const,
    clientId,
    clientSecret,
    gatewayHostname: managedMachineHosts.gatewayHostname,
  });
});

cliRoutes.get("/api/cli/host-bootstrap", async (c) => {
  const protection = await resolveProtectionState(c.env, c.req.url);
  const managedMachineHosts = await resolveManagedMachineHostStatus(c.env, protection);
  setNoStore(c);

  if (!managedMachineHosts.gatewaySupportAvailable || !managedMachineHosts.gatewayHostname) {
    return c.json(
      {
        error: managedMachineHosts.gatewaySupportReason
          ?? "The protected Tiller gateway is not provisioned yet.",
        code: "gateway_unavailable" as const,
        hint: "Open Settings → Publish & Protect and finish gateway provisioning, then run `tiller host setup` again.",
      },
      409,
    );
  }

  const tunnelId = trimOptional(await getSecret(c.env, "TILLER_GATEWAY_TUNNEL_ID"));
  const tunnelToken = trimOptional(await getSecret(c.env, "TILLER_GATEWAY_TUNNEL_TOKEN"));
  const tunnelName =
    trimOptional(await getSecret(c.env, "TILLER_GATEWAY_TUNNEL_NAME")) ?? "tiller-gateway";
  const gatewayTargetPort = parseTargetPort(await getSecret(c.env, "TILLER_GATEWAY_TUNNEL_TARGET_PORT"));

  if (!tunnelId || !tunnelToken) {
    return c.json(
      {
        error: "This protected hub does not currently have a stored gateway tunnel bootstrap token.",
        code: "missing_gateway_tunnel" as const,
        hint: "Open Settings → Publish & Protect and re-run protected machine-host provisioning, then retry from the CLI.",
      },
      409,
    );
  }

  return c.json({
    gatewayHostname: managedMachineHosts.gatewayHostname,
    gatewayTunnelId: tunnelId,
    gatewayTunnelName: tunnelName,
    gatewayTunnelToken: tunnelToken,
    gatewayTargetPort,
  });
});

cliRoutes.get("/cli/bootstrap", (c) => {
  setNoStore(c);
  return c.html(renderCliBootstrapPage());
});

export default cliRoutes;
