import { Hono } from "hono";
import type { HonoEnv, Env } from "../types";
import { invalidateConfigCache } from "../setup/config";
import {
  GitHubAppError,
  getGitHubAppConfig,
  getGitHubAppInstallUrl,
  getGitHubAppManageUrl,
  getOrCreateGitHubManifestSigningKey,
  getOrCreateGitHubWebhookSecret,
  isGitHubAppAllowedForRequest,
  listGitHubAppRepositories,
  mintGitHubInstallationToken,
  resolveGitHubAppRepositorySelection,
  saveGitHubAppConfig,
} from "./app";
import { githubBridgeTokenAccess, validateGitHubBridgeRequest } from "./bridge";
import { handleGitHubWebhook } from "./webhook-service";
import { resolveCanonicalRequestOrigin } from "../canonical-origin";

const githubRoutes = new Hono<HonoEnv>();
export const MAX_GITHUB_WEBHOOK_BODY_BYTES = 25_000_000;

class GitHubWebhookBodyTooLargeError extends Error {}

async function readBoundedWebhookBody(request: Request): Promise<ArrayBuffer> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isFinite(declaredLength)
      || declaredLength < 0
      || declaredLength > MAX_GITHUB_WEBHOOK_BODY_BYTES
    ) {
      throw new GitHubWebhookBodyTooLargeError();
    }
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_GITHUB_WEBHOOK_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new GitHubWebhookBodyTooLargeError();
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
  return body.buffer;
}

interface GitHubManifestConversionResponse {
  id?: number;
  client_id?: string;
  slug?: string;
  pem?: string;
  webhook_secret?: string;
}

type GitHubAccessTestStatus =
  | "ready"
  | "not_configured"
  | "missing_installation"
  | "repo_not_selected"
  | "missing_permissions"
  | "invalid_repo"
  | "invalid_config"
  | "github_error"
  | "public_hub_disabled";

function jsonError(error: unknown): { body: Record<string, unknown>; status: number } {
  if (error instanceof GitHubAppError) {
    return {
      status: error.status,
      body: { error: error.message, code: error.code },
    };
  }
  return {
    status: 502,
    body: { error: error instanceof Error ? error.message : String(error) },
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(normalized), (char) => char.charCodeAt(0));
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function createManifestState(env: Env): Promise<string> {
  const signingKey = await getOrCreateGitHubManifestSigningKey(env);
  const nonce = new Uint8Array(16);
  crypto.getRandomValues(nonce);
  const payload = base64Url(new TextEncoder().encode(JSON.stringify({
    nonce: base64Url(nonce),
    issuedAt: Date.now(),
  })));
  const signature = await hmacHex(signingKey, payload);
  return `${payload}.${signature}`;
}

async function verifyManifestState(env: Env, state: string): Promise<boolean> {
  const [payload, signature] = state.split(".");
  if (!payload || !signature) return false;
  const signingKey = await getOrCreateGitHubManifestSigningKey(env);
  if (await hmacHex(signingKey, payload) !== signature) return false;

  try {
    const parsed = JSON.parse(new TextDecoder().decode(decodeBase64Url(payload))) as { issuedAt?: unknown };
    return typeof parsed.issuedAt === "number" && Date.now() - parsed.issuedAt < 10 * 60_000;
  } catch {
    return false;
  }
}

async function buildManifest(env: Env, request: Request) {
  const origin = await resolveCanonicalRequestOrigin(env, request);
  const url = new URL(origin);
  return {
    name: buildGitHubAppName(),
    url: url.origin,
    redirect_url: `${url.origin}/api/github/manifest/callback`,
    setup_url: `${url.origin}/api/github/install/callback`,
    setup_on_update: true,
    public: false,
    hook_attributes: {
      url: `${url.origin}/api/github/webhook`,
      active: true,
    },
    default_permissions: {
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      workflows: "write",
    },
    default_events: ["pull_request", "push"],
    request_oauth_on_install: false,
  };
}

function buildGitHubAppName(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  const suffix = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `tiller-${suffix}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function manifestSetupForm(actionUrl: string, manifest: object): string {
  const manifestJson = JSON.stringify(manifest);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Create GitHub App</title>
  <style>
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #24292f; background: #f6f8fa; }
    main { width: min(420px, calc(100vw - 32px)); border: 1px solid #d0d7de; border-radius: 12px; background: #fff; padding: 24px; box-shadow: 0 16px 40px rgba(31, 35, 40, 0.08); }
    h1 { margin: 0; font-size: 20px; line-height: 1.3; }
    p { margin: 10px 0 0; color: #57606a; font-size: 14px; line-height: 1.5; }
    button { margin-top: 16px; border: 1px solid #0969da; border-radius: 6px; background: #0969da; color: #fff; font-size: 13px; font-weight: 600; padding: 8px 12px; cursor: pointer; }
  </style>
</head>
<body>
  <main>
    <h1>Opening GitHub</h1>
    <p>Continue in GitHub to create the Tiller GitHub App.</p>
    <form method="post" action="${escapeHtml(actionUrl)}">
      <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
      <button type="submit">Continue to GitHub</button>
    </form>
  </main>
  <script>document.querySelector("form").submit();</script>
</body>
</html>`;
}

async function convertManifestCode(code: string): Promise<GitHubManifestConversionResponse> {
  const response = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "tiller-hub",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await response.text().catch(() => "");
  let body: GitHubManifestConversionResponse | Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) as GitHubManifestConversionResponse : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const message = typeof (body as Record<string, unknown>).message === "string"
      ? String((body as Record<string, unknown>).message)
      : `GitHub manifest conversion failed with HTTP ${response.status}.`;
    throw new GitHubAppError(message, "github_app_manifest_conversion_failed", 502);
  }
  return body as GitHubManifestConversionResponse;
}

async function statusPayload(env: Env, request: Request) {
  const allowed = await isGitHubAppAllowedForRequest(env, request);
  const config = allowed ? await getGitHubAppConfig(env) : null;
  return {
    available: allowed && Boolean(config),
    configured: allowed && Boolean(config),
    publicHub: !allowed,
    appId: config?.appId ?? null,
    clientId: config?.clientId ?? null,
    slug: config?.slug ?? null,
    installUrl: config ? getGitHubAppInstallUrl(config.slug) : null,
    manageUrl: getGitHubAppManageUrl(),
    webhookConfigured: config?.webhookConfigured === true,
    webhookUrl: `${await resolveCanonicalRequestOrigin(env, request)}/api/github/webhook`,
    disabledReason: allowed ? null : "GitHub App private repo access is only available on protected hubs and localhost.",
  };
}

async function githubActionUrls(env: Env): Promise<{ installUrl: string | null; manageUrl: string }> {
  const config = await getGitHubAppConfig(env);
  return {
    installUrl: config ? getGitHubAppInstallUrl(config.slug) : null,
    manageUrl: getGitHubAppManageUrl(),
  };
}

function accessTestResponse(
  status: GitHubAccessTestStatus,
  message: string,
  urls: { installUrl?: string | null; manageUrl?: string | null },
  repo?: string,
) {
  return {
    ok: status === "ready",
    status,
    message,
    ...(repo ? { repo } : {}),
    installUrl: urls.installUrl ?? null,
    manageUrl: urls.manageUrl ?? getGitHubAppManageUrl(),
  };
}

function accessTestStatusForError(error: unknown): { status: GitHubAccessTestStatus; message: string } {
  if (error instanceof GitHubAppError) {
    switch (error.code) {
      case "github_app_not_configured":
        return { status: "not_configured", message: error.message };
      case "github_app_missing_installation":
        return { status: "missing_installation", message: error.message };
      case "github_app_repo_not_selected":
        return { status: "repo_not_selected", message: error.message };
      case "github_app_missing_permissions":
        return { status: "missing_permissions", message: error.message };
      case "github_app_repo_claim_invalid":
        return { status: "invalid_repo", message: error.message };
      case "github_app_private_key_invalid":
      case "github_app_config_invalid":
        return { status: "invalid_config", message: error.message };
      default:
        return { status: "github_error", message: error.message };
    }
  }
  return {
    status: "github_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

githubRoutes.get("/api/github/status", async (c) => {
  return c.json(await statusPayload(c.env, c.req.raw));
});

githubRoutes.post("/api/github/app-config", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App private repo access is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }

  const body: {
    appId?: string;
    clientId?: string;
    slug?: string;
    privateKey?: string;
    webhookSecret?: string;
  } = await c.req.json<{
    appId?: string;
    clientId?: string;
    slug?: string;
    privateKey?: string;
    webhookSecret?: string;
  }>().catch(() => ({}));
  try {
    const webhookSecret = body.webhookSecret?.trim() || await getOrCreateGitHubWebhookSecret(c.env);
    await saveGitHubAppConfig(c.env, {
      appId: body.appId ?? "",
      clientId: body.clientId ?? "",
      slug: body.slug ?? "",
      privateKey: body.privateKey ?? "",
      webhookSecret,
    });
    invalidateConfigCache();
    return c.json({ ok: true, status: await statusPayload(c.env, c.req.raw) });
  } catch (error) {
    const normalized = jsonError(error);
    return c.json(normalized.body, normalized.status as any);
  }
});

githubRoutes.get("/api/github/manifest/setup", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App setup is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }

  const state = await createManifestState(c.env);
  const manifest = await buildManifest(c.env, c.req.raw);
  const account = c.req.query("account")?.trim();
  const baseUrl = account
    ? `https://github.com/organizations/${encodeURIComponent(account)}/settings/apps/new`
    : "https://github.com/settings/apps/new";
  const url = new URL(baseUrl);
  url.searchParams.set("state", state);
  return c.html(manifestSetupForm(url.toString(), manifest));
});

githubRoutes.get("/api/github/manifest/callback", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App setup is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }

  const code = c.req.query("code")?.trim() ?? "";
  const state = c.req.query("state")?.trim() ?? "";
  if (!code || !state || !(await verifyManifestState(c.env, state))) {
    return c.json({ error: "Invalid GitHub App manifest callback.", code: "github_app_manifest_state_invalid" }, 400);
  }

  try {
    const converted = await convertManifestCode(code);
    if (
      !converted.id
      || !converted.client_id
      || !converted.slug
      || !converted.pem
      || !converted.webhook_secret
    ) {
      return c.json({ error: "GitHub manifest conversion response was incomplete.", code: "github_app_manifest_incomplete" }, 502);
    }
    await saveGitHubAppConfig(c.env, {
      appId: String(converted.id),
      clientId: converted.client_id,
      slug: converted.slug,
      privateKey: converted.pem,
      webhookSecret: converted.webhook_secret,
      webhookConfigured: true,
    });
    invalidateConfigCache();

    if (c.req.header("Accept")?.includes("application/json")) {
      return c.json({ ok: true, status: await statusPayload(c.env, c.req.raw) });
    }
    return c.redirect(getGitHubAppInstallUrl(converted.slug), 303);
  } catch (error) {
    const normalized = jsonError(error);
    return c.json(normalized.body, normalized.status as any);
  }
});

githubRoutes.get("/api/github/install/callback", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App installation callback is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }
  return c.redirect(`${await resolveCanonicalRequestOrigin(c.env, c.req.raw)}/`, 303);
});

githubRoutes.get("/api/github/install", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App installation is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }
  const config = await getGitHubAppConfig(c.env);
  if (!config) {
    return c.json({ error: "GitHub App is not configured.", code: "github_app_not_configured" }, 409);
  }
  return c.redirect(getGitHubAppInstallUrl(config.slug));
});

githubRoutes.get("/api/github/manage", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App installation management is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }
  return c.redirect(getGitHubAppManageUrl());
});

githubRoutes.post("/api/github/test-access", async (c) => {
  const allowed = await isGitHubAppAllowedForRequest(c.env, c.req.raw);
  const urls = allowed ? await githubActionUrls(c.env) : { installUrl: null, manageUrl: getGitHubAppManageUrl() };
  if (!allowed) {
    return c.json(accessTestResponse(
      "public_hub_disabled",
      "GitHub App private repo access is only available on protected hubs and localhost.",
      urls,
    ));
  }

  const body: {
    repositoryId?: unknown;
    installationId?: unknown;
    fullName?: unknown;
  } = await c.req.json<{
    repositoryId?: unknown;
    installationId?: unknown;
    fullName?: unknown;
  }>().catch(() => ({}));
  if (
    !Number.isInteger(body.repositoryId) ||
    !Number.isInteger(body.installationId) ||
    typeof body.fullName !== "string" ||
    !body.fullName.trim()
  ) {
    return c.json(accessTestResponse(
      "invalid_repo",
      "Select a repository from the GitHub App repository list.",
      urls,
    ));
  }

  try {
    const repositoryId = body.repositoryId as number;
    const installationId = body.installationId as number;
    const fullName = body.fullName;
    const selection = await resolveGitHubAppRepositorySelection(c.env, {
      repositoryId,
      installationId,
      fullName,
    });
    return c.json(accessTestResponse(
      "ready",
      `GitHub App access is ready for ${selection.fullName}.`,
      urls,
      selection.fullName,
    ));
  } catch (error) {
    const normalized = accessTestStatusForError(error);
    return c.json(accessTestResponse(normalized.status, normalized.message, urls, typeof body.fullName === "string" ? body.fullName : undefined));
  }
});

githubRoutes.get("/api/github/repositories", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App repository selection is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
      repositories: [],
      warnings: [],
    }, 403);
  }

  try {
    const result = await listGitHubAppRepositories(c.env);
    if (result.repositories.length === 0) {
      const blockingWarning =
        result.warnings.find((warning) => warning.code === "github_app_missing_installation") ??
        result.warnings.find((warning) => warning.code === "github_app_missing_permissions") ??
        result.warnings.find((warning) => warning.code === "github_app_repository_list_failed") ??
        result.warnings.find((warning) => warning.code === "github_app_installation_list_failed");
      return c.json({
        error: blockingWarning?.message ?? "No repositories are selected in the configured GitHub App installation with required write permissions.",
        code: blockingWarning?.code ?? "github_app_no_usable_repositories",
        repositories: [],
        warnings: result.warnings,
        repositorySelection: result.repositorySelection,
      }, 409);
    }
    return c.json(result);
  } catch (error) {
    const normalized = jsonError(error);
    return c.json(
      {
        ...normalized.body,
        repositories: [],
        warnings: [],
        repositorySelection: "unknown",
      },
      normalized.status as any,
    );
  }
});

githubRoutes.get("/api/github/token", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json({
      error: "GitHub App private repo access is only available on protected hubs and localhost.",
      code: "github_app_public_hub_disabled",
    }, 403);
  }

  const validation = await validateGitHubBridgeRequest(c.env, c.req.raw, c.req.query("repo"));
  if (!validation.ok) {
    return c.json(validation.body, validation.status as any);
  }

  try {
    const token = await mintGitHubInstallationToken(c.env, validation.repo, {
      access: githubBridgeTokenAccess(validation.record),
    });
    return c.json({
      token: token.token,
      expiresAt: token.expiresAt,
      repository: token.repository,
      installationId: token.installationId,
      permissions: token.permissions,
    });
  } catch (error) {
    const normalized = jsonError(error);
    return c.json(normalized.body, normalized.status as any);
  }
});

githubRoutes.post("/api/github/webhook", async (c) => {
  let rawBody: ArrayBuffer;
  try {
    rawBody = await readBoundedWebhookBody(c.req.raw);
  } catch (error) {
    if (error instanceof GitHubWebhookBodyTooLargeError) {
      return c.json({
        error: "GitHub webhook payload is too large.",
        code: "github_webhook_payload_too_large",
      }, 413);
    }
    return c.json({
      error: "GitHub webhook request could not be read.",
      code: "github_webhook_request_invalid",
    }, 400);
  }
  const result = await handleGitHubWebhook(c.env, c.req.raw, rawBody);
  return c.json(result.body, result.status as any);
});

export default githubRoutes;
