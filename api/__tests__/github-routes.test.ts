import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { installedAccessBindings, TEST_WORKERS_DEV_HOSTNAME } from "./access-binding-fixture";

const INVALID_PRIVATE_KEY = [
  "-----BEGIN PRIVATE KEY-----", // gitleaks:allow -- intentionally invalid fixture delimiter
  "key",
  "-----END PRIVATE KEY-----",
].join("\\n");

const mocks = vi.hoisted(() => {
  const state = {
    config: {} as Record<string, string>,
    localDev: false,
    protectionMode: "public",
    privateKeyInvalid: false,
  };
  return {
    state,
    importPKCS8: vi.fn(async () => {
      if (state.privateKeyInvalid) {
        throw new Error("bad key");
      }
      return new Uint8Array([1]);
    }),
    getOrCreateSecret: vi.fn(async () => "manifest-signing-key"),
    invalidateConfigCache: vi.fn(),
    loadConfig: vi.fn(async () => state.config),
    isLocalDevRequest: vi.fn(() => state.localDev),
    resolveProtectionState: vi.fn(async () => ({
      protectionMode: state.protectionMode,
    })),
    handleGitHubWebhook: vi.fn(),
    mintGitHubInstallationToken: vi.fn(),
    validateGitHubBridgeRequest: vi.fn(),
  };
});

vi.mock("jose", () => ({
  importPKCS8: mocks.importPKCS8,
  SignJWT: class {
    setProtectedHeader() {
      return this;
    }

    setIssuedAt() {
      return this;
    }

    setExpirationTime() {
      return this;
    }

    setIssuer() {
      return this;
    }

    async sign() {
      return "app-jwt";
    }
  },
}));

vi.mock("../setup/config", () => ({
  getOrCreateSecret: mocks.getOrCreateSecret,
  invalidateConfigCache: mocks.invalidateConfigCache,
  loadConfig: mocks.loadConfig,
}));

vi.mock("../protection", () => ({
  isLocalDevRequest: mocks.isLocalDevRequest,
  resolveProtectionState: mocks.resolveProtectionState,
}));

vi.mock("../github/app", async () => {
  const actual = await vi.importActual<typeof import("../github/app")>("../github/app");
  return {
    ...actual,
    mintGitHubInstallationToken: mocks.mintGitHubInstallationToken,
  };
});

vi.mock("../github/bridge", async () => {
  const actual = await vi.importActual<typeof import("../github/bridge")>("../github/bridge");
  return {
    ...actual,
    validateGitHubBridgeRequest: mocks.validateGitHubBridgeRequest,
  };
});

vi.mock("../github/webhook-service", () => ({
  handleGitHubWebhook: mocks.handleGitHubWebhook,
}));

const {
  default: githubRoutes,
  MAX_GITHUB_WEBHOOK_BODY_BYTES,
} = await import("../github/routes");
const { GitHubAppError } = await import("../github/app");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", githubRoutes);
  return app;
}

function createEnv(workersDevHostname = TEST_WORKERS_DEV_HOSTNAME) {
  const setConfig = vi.fn();
  const trust = {
    version: 1,
    ownerEmail: "owner@example.com",
    accountId: "",
    workerName: "tiller",
    workersDevHostname,
    issuer: "https://team.cloudflareaccess.com",
    audience: "audience-1",
    serviceTokenId: "service-token-1",
    serviceClientId: "client.access",
    configuredAt: "2026-07-17T00:00:00.000Z",
  };
  return {
    env: {
      ...installedAccessBindings({
        hostname: workersDevHostname,
        issuer: trust.issuer,
        audience: trust.audience,
        serviceClientId: trust.serviceClientId,
        ownerEmail: trust.ownerEmail,
      }),
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({
          setConfig,
        })),
      },
    } as any,
    setConfig,
  };
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parseManifestSetup(html: string): {
  action: URL;
  manifest: {
    name?: unknown;
    hook_attributes?: Record<string, unknown>;
    [key: string]: unknown;
  };
} {
  const action = html.match(/<form method="post" action="([^"]+)"/)?.[1];
  const manifest = html.match(/name="manifest" value="([^"]+)"/)?.[1];
  if (!action || !manifest) {
    throw new Error("GitHub manifest setup form was incomplete.");
  }
  return {
    action: new URL(decodeHtmlAttribute(action)),
    manifest: JSON.parse(decodeHtmlAttribute(manifest)),
  };
}

describe("GitHub App routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    mocks.state.config = {};
    mocks.state.localDev = false;
    mocks.state.protectionMode = "public";
    mocks.state.privateKeyInvalid = false;
  });

  it("passes a bounded webhook body and signature headers to the existing HMAC handler", async () => {
    const app = createApp();
    const { env } = createEnv();
    const payload = '{"zen":"keep it logically awesome"}';
    mocks.handleGitHubWebhook.mockResolvedValue({
      status: 202,
      body: { ok: true },
    });

    const response = await app.request("https://hub.example.com/api/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Hub-Signature-256": "sha256=signed",
      },
      body: payload,
    }, env);

    expect(response.status).toBe(202);
    expect(mocks.handleGitHubWebhook).toHaveBeenCalledOnce();
    const [receivedEnv, receivedRequest, receivedBody] = mocks.handleGitHubWebhook.mock.calls[0];
    expect(receivedEnv).toBe(env);
    expect((receivedRequest as Request).headers.get("X-Hub-Signature-256"))
      .toBe("sha256=signed");
    expect(new TextDecoder().decode(receivedBody as ArrayBuffer)).toBe(payload);
  });

  it("rejects an oversized declared webhook body before HMAC verification", async () => {
    const app = createApp();
    const { env } = createEnv();

    const response = await app.request("https://hub.example.com/api/github/webhook", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(MAX_GITHUB_WEBHOOK_BODY_BYTES + 1),
      },
      body: "{}",
    }, env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_webhook_payload_too_large",
    });
    expect(mocks.handleGitHubWebhook).not.toHaveBeenCalled();
  });

  it("rejects a streamed webhook body that crosses the limit before HMAC verification", async () => {
    const app = createApp();
    const { env } = createEnv();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_GITHUB_WEBHOOK_BODY_BYTES));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    const request = new Request("https://hub.example.com/api/github/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await app.request(request, undefined, env);

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_webhook_payload_too_large",
    });
    expect(mocks.handleGitHubWebhook).not.toHaveBeenCalled();
  });

  it("blocks GitHub App setup and token minting on public hubs", async () => {
    const app = createApp();
    const { env } = createEnv();

    const setup = await app.request("https://hub.example.com/api/github/manifest/setup", {}, env);
    expect(setup.status).toBe(403);
    await expect(setup.json()).resolves.toMatchObject({
      code: "github_app_public_hub_disabled",
    });

    const token = await app.request("https://hub.example.com/api/github/token?repo=owner/repo", {}, env);
    expect(token.status).toBe(403);
    await expect(token.json()).resolves.toMatchObject({
      code: "github_app_public_hub_disabled",
    });

    const testAccess = await app.request("https://hub.example.com/api/github/test-access", {
      method: "POST",
      body: JSON.stringify({ repo: "owner/repo" }),
      headers: { "Content-Type": "application/json" },
    }, env);
    expect(testAccess.status).toBe(200);
    await expect(testAccess.json()).resolves.toMatchObject({
      ok: false,
      status: "public_hub_disabled",
    });
  });

  it.each([
    ["github_app_missing_installation", 404],
    ["github_app_repo_not_selected", 403],
    ["github_app_missing_permissions", 403],
  ] as const)("preserves %s from live token minting", async (code, status) => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.validateGitHubBridgeRequest.mockResolvedValue({
      ok: true,
      record: {
        id: "bridge-1",
        subject: { type: "github-planner", jobSlug: "planner-1", repoId: "42" },
      },
      repo: {
        owner: "owner",
        repo: "repo",
        fullName: "owner/repo",
        htmlUrl: "https://github.com/owner/repo",
      },
    });
    mocks.mintGitHubInstallationToken.mockRejectedValue(
      new GitHubAppError(code, code, status),
    );

    const response = await app.request("https://hub.example.com/api/github/token?repo=owner/repo", {}, env);

    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ code });
    expect(mocks.validateGitHubBridgeRequest).toHaveBeenCalled();
    expect(mocks.mintGitHubInstallationToken).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fullName: "owner/repo" }),
      { access: "read" },
    );
  });

  it("reports configured status only when GitHub App access is allowed", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };

    const publicStatus = await app.request("https://hub.example.com/api/github/status", {}, env);
    await expect(publicStatus.json()).resolves.toMatchObject({
      configured: false,
      publicHub: true,
    });

    mocks.state.protectionMode = "cf-access";
    const protectedStatus = await app.request("https://hub.example.com/api/github/status", {}, env);
    await expect(protectedStatus.json()).resolves.toMatchObject({
      configured: true,
      publicHub: false,
      slug: "tiller-test",
      installUrl: "https://github.com/apps/tiller-test/installations/new",
      manageUrl: "https://github.com/settings/installations",
    });
  });

  it("clears stale webhook-configured status when manual app config is saved", async () => {
    const app = createApp();
    const { env, setConfig } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "old-app",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
      GITHUB_APP_WEBHOOK_SECRET: "old-secret",
      GITHUB_APP_WEBHOOK_CONFIGURED: "true",
    };

    const res = await app.request("https://hub.example.com/api/github/app-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        appId: "456",
        clientId: "Iv1.next",
        slug: "manual-app",
        privateKey: INVALID_PRIVATE_KEY,
        webhookSecret: "manual-secret",
      }),
    }, env);

    expect(res.status).toBe(200);
    expect(setConfig).toHaveBeenCalledWith("GITHUB_APP_WEBHOOK_CONFIGURED", "false");
  });

  it("returns GitHub App selected repositories for protected hubs", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/app/installations?per_page=100&page=1")) {
        return new Response(JSON.stringify([
          {
            id: 111,
            repository_selection: "all",
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/app/installations/111/access_tokens")) {
        return new Response(JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/installation/repositories?per_page=100&page=1")) {
        return new Response(JSON.stringify({
          repositories: [
            {
              id: 42,
              full_name: "Owner/Repo",
              private: true,
              default_branch: "main",
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const response = await app.request("https://hub.example.com/api/github/repositories", {}, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      repositories: [
        {
          repositoryId: 42,
          installationId: 111,
          fullName: "owner/repo",
          repoUrl: "https://github.com/owner/repo",
          private: true,
          defaultBranch: "main",
        },
      ],
      warnings: [],
      repositorySelection: "all",
    });
  });

  it("returns a typed missing-installation state when the app has no installations", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/app/installations?per_page=100&page=1")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const response = await app.request("https://hub.example.com/api/github/repositories", {}, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_app_missing_installation",
      repositories: [],
      warnings: [expect.objectContaining({ code: "github_app_missing_installation" })],
    });
  });

  it("returns a typed GitHub API error state when all repository listings fail", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/app/installations?per_page=100&page=1")) {
        return new Response(JSON.stringify([
          {
            id: 111,
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/app/installations/111/access_tokens")) {
        return new Response(JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/installation/repositories?per_page=100&page=1")) {
        return new Response(JSON.stringify({ message: "GitHub unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const response = await app.request("https://hub.example.com/api/github/repositories", {}, env);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      code: "github_app_repository_list_failed",
      repositories: [],
      warnings: [expect.objectContaining({ code: "github_app_repository_list_failed" })],
    });
  });

  it("creates a minimal manifest and stores converted app config on callback", async () => {
    const app = createApp();
    const { env, setConfig } = createEnv();
    mocks.state.protectionMode = "cf-access";

    const setup = await app.request("https://hub.example.com/api/github/manifest/setup", {}, env);
    expect(setup.status).toBe(200);
    const { action: githubAction, manifest } = parseManifestSetup(await setup.text());
    const state = githubAction.searchParams.get("state") ?? "";
    expect(githubAction.origin).toBe("https://github.com");
    expect(githubAction.pathname).toBe("/settings/apps/new");
    expect(manifest).toMatchObject({
      name: expect.stringMatching(/^tiller-[a-f0-9]{12}$/),
      redirect_url: "https://tiller.preview.workers.dev/api/github/manifest/callback",
      setup_url: "https://tiller.preview.workers.dev/api/github/install/callback",
      setup_on_update: true,
      default_permissions: { contents: "write", metadata: "read", pull_requests: "write", workflows: "write" },
      default_events: ["pull_request", "push"],
      request_oauth_on_install: false,
      hook_attributes: {
        url: "https://tiller.preview.workers.dev/api/github/webhook",
        active: true,
      },
    });
    expect(manifest.hook_attributes).not.toHaveProperty("secret");
    expect(mocks.getOrCreateSecret).toHaveBeenCalledWith(
      env,
      "GITHUB_APP_MANIFEST_SIGNING_KEY",
      expect.any(Function),
    );
    expect(mocks.getOrCreateSecret).not.toHaveBeenCalledWith(
      env,
      "GITHUB_APP_WEBHOOK_SECRET",
      expect.any(Function),
    );
    expect(state).toContain(".");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 987,
      client_id: "Iv1.converted",
      slug: "converted-app",
      pem: "-----BEGIN PRIVATE KEY-----\nconverted\n-----END PRIVATE KEY-----", // gitleaks:allow -- intentionally invalid fixture
      webhook_secret: "github-generated-webhook-secret",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const callback = await app.request(
      `https://hub.example.com/api/github/manifest/callback?code=manifest-code&state=${encodeURIComponent(state)}`,
      {},
      env,
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("https://github.com/apps/converted-app/installations/new");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/manifest-code/conversions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(setConfig).toHaveBeenCalledWith("GITHUB_APP_ID", "987");
    expect(setConfig).toHaveBeenCalledWith("GITHUB_APP_CLIENT_ID", "Iv1.converted");
    expect(setConfig).toHaveBeenCalledWith("GITHUB_APP_SLUG", "converted-app");
    expect(setConfig).toHaveBeenCalledWith(
      "GITHUB_APP_PRIVATE_KEY",
      "-----BEGIN PRIVATE KEY-----\nconverted\n-----END PRIVATE KEY-----",
    );
    expect(setConfig).toHaveBeenCalledWith(
      "GITHUB_APP_WEBHOOK_SECRET",
      "github-generated-webhook-secret",
    );
    expect(setConfig).toHaveBeenCalledWith("GITHUB_APP_WEBHOOK_CONFIGURED", "true");
    expect(mocks.invalidateConfigCache).toHaveBeenCalled();
  });

  it("generates a fresh random GitHub App name for every setup attempt", async () => {
    const app = createApp();
    const { env } = createEnv("tiller.preview-account.workers.dev");
    mocks.state.protectionMode = "cf-access";
    let nameByte = 1;
    const randomValues = vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint8Array) => {
      array.fill(array.byteLength === 6 ? nameByte++ : 0);
      return array;
    }) as typeof crypto.getRandomValues);

    try {
      const names: string[] = [];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const setup = await app.request(
          "https://tiller.preview-account.workers.dev/api/github/manifest/setup",
          {},
          env,
        );
        expect(setup.status).toBe(200);
        names.push(String(parseManifestSetup(await setup.text()).manifest.name));
      }

      expect(names).toEqual([
        "tiller-010101010101",
        "tiller-020202020202",
      ]);
      expect(names[0]).not.toBe(names[1]);
      expect(names.every((name) => /^tiller-[a-f0-9]{12}$/.test(name))).toBe(true);
    } finally {
      randomValues.mockRestore();
    }
  });

  it("rejects an invalid manifest callback state before conversion", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const callback = await app.request(
      "https://hub.example.com/api/github/manifest/callback?code=manifest-code&state=invalid",
      {},
      env,
    );

    expect(callback.status).toBe(400);
    await expect(callback.json()).resolves.toMatchObject({
      code: "github_app_manifest_state_invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves the JSON manifest callback response", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    const setup = await app.request("https://hub.example.com/api/github/manifest/setup", {}, env);
    const state = parseManifestSetup(await setup.text()).action.searchParams.get("state") ?? "";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: 988,
      client_id: "Iv1.json",
      slug: "json-app",
      pem: "-----BEGIN PRIVATE KEY-----\njson\n-----END PRIVATE KEY-----", // gitleaks:allow -- intentionally invalid fixture
      webhook_secret: "json-webhook-secret",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })));

    const callback = await app.request(
      `https://hub.example.com/api/github/manifest/callback?code=json-code&state=${encodeURIComponent(state)}`,
      { headers: { Accept: "application/json" } },
      env,
    );

    expect(callback.status).toBe(200);
    expect(callback.headers.get("location")).toBeNull();
    await expect(callback.json()).resolves.toMatchObject({ ok: true });
  });

  it("returns an installation callback to the server-derived Tiller origin", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";

    const callback = await app.request(
      "https://hub.example.com/api/github/install/callback?installation_id=spoofed",
      {},
      env,
    );

    expect(callback.status).toBe(303);
    expect(callback.headers.get("location")).toBe("https://tiller.preview.workers.dev/");
    expect(callback.headers.get("location")).not.toContain("spoofed");
  });

  it("tests write access from a selected GitHub App repository claim", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/app/installations?per_page=100&page=1")) {
        return new Response(JSON.stringify([
          {
            id: 111,
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/app/installations/111/access_tokens")) {
        return new Response(JSON.stringify({
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        }), { status: 201, headers: { "Content-Type": "application/json" } });
      }
      if (url.endsWith("/installation/repositories?per_page=100&page=1")) {
        return new Response(JSON.stringify({
          repositories: [
            {
              id: 42,
              full_name: "Owner/Repo",
              private: true,
              default_branch: "main",
            },
          ],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const response = await app.request("https://hub.example.com/api/github/test-access", {
      method: "POST",
      body: JSON.stringify({ repositoryId: 42, installationId: 111, fullName: "Owner/Repo" }),
      headers: { "Content-Type": "application/json" },
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      status: "ready",
      repo: "owner/repo",
      installUrl: "https://github.com/apps/tiller-test/installations/new",
      manageUrl: "https://github.com/settings/installations",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://api.github.com/app/installations?per_page=100&page=1",
      "https://api.github.com/app/installations/111/access_tokens",
      "https://api.github.com/installation/repositories?per_page=100&page=1",
    ]);
  });

  it("reports read-only app installations as permission upgrades", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/app/installations?per_page=100&page=1")) {
        return new Response(JSON.stringify([
          {
            id: 1234,
            permissions: { contents: "read", metadata: "read" },
          },
        ]), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    }));

    const response = await app.request("https://hub.example.com/api/github/test-access", {
      method: "POST",
      body: JSON.stringify({ repositoryId: 42, installationId: 1234, fullName: "owner/repo" }),
      headers: { "Content-Type": "application/json" },
    }, env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      status: "missing_permissions",
      repo: "owner/repo",
    });
  });

  it("normalizes invalid repo and invalid config access test failures", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: INVALID_PRIVATE_KEY,
    };

    const invalidRepo = await app.request("https://hub.example.com/api/github/test-access", {
      method: "POST",
      body: JSON.stringify({ fullName: "owner/repo" }),
      headers: { "Content-Type": "application/json" },
    }, env);
    await expect(invalidRepo.json()).resolves.toMatchObject({
      ok: false,
      status: "invalid_repo",
    });

    mocks.state.privateKeyInvalid = true;
    const invalidConfig = await app.request("https://hub.example.com/api/github/test-access", {
      method: "POST",
      body: JSON.stringify({ repositoryId: 42, installationId: 1234, fullName: "owner/repo" }),
      headers: { "Content-Type": "application/json" },
    }, env);
    await expect(invalidConfig.json()).resolves.toMatchObject({
      ok: false,
      status: "invalid_config",
    });
  });
});
