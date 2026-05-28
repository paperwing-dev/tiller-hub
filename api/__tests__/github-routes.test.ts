import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

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

const { default: githubRoutes } = await import("../github/routes");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", githubRoutes);
  return app;
}

function createEnv() {
  const setConfig = vi.fn();
  return {
    env: {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({ setConfig })),
      },
    } as any,
    setConfig,
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

  it("reports configured status only when GitHub App access is allowed", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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

  it("returns GitHub App selected repositories for protected hubs", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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
    const setupHtml = await setup.text();
    const action = setupHtml.match(/<form method="post" action="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&") ?? "";
    const manifestValue = setupHtml.match(/name="manifest" value="([^"]+)"/)?.[1] ?? "";
    const manifest = JSON.parse(manifestValue
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"));
    const githubAction = new URL(action);
    const state = githubAction.searchParams.get("state") ?? "";
    expect(githubAction.origin).toBe("https://github.com");
    expect(githubAction.pathname).toBe("/settings/apps/new");
    expect(manifest).toMatchObject({
      name: expect.stringMatching(/^hub-[a-z0-9]{6}$/),
      redirect_url: "https://hub.example.com/api/github/manifest/callback",
      setup_url: "https://hub.example.com/api/github/install/callback",
      setup_on_update: true,
      default_permissions: { contents: "write", metadata: "read", pull_requests: "write" },
      default_events: [],
      request_oauth_on_install: false,
    });
    expect(manifest).not.toHaveProperty("hook_attributes");
    expect(state).toContain(".");

    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 987,
      client_id: "Iv1.converted",
      slug: "converted-app",
      pem: "-----BEGIN PRIVATE KEY-----\nconverted\n-----END PRIVATE KEY-----",
    }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const callback = await app.request(
      `https://hub.example.com/api/github/manifest/callback?code=manifest-code&state=${encodeURIComponent(state)}`,
      { headers: { Accept: "application/json" } },
      env,
    );

    expect(callback.status).toBe(200);
    await expect(callback.json()).resolves.toMatchObject({ ok: true });
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
    expect(mocks.invalidateConfigCache).toHaveBeenCalled();
  });

  it("keeps generated GitHub App names within GitHub's length limit", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";

    const setup = await app.request(
      "https://tiller-hub-32.personal-infrastructure.workers.dev/api/github/manifest/setup",
      {},
      env,
    );
    expect(setup.status).toBe(200);
    const setupHtml = await setup.text();
    const manifestValue = setupHtml.match(/name="manifest" value="([^"]+)"/)?.[1] ?? "";
    const manifest = JSON.parse(manifestValue
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&"));

    expect(manifest.name).toMatch(/^tiller-hub-32-[a-z0-9]{6}$/);
    expect(manifest.name.length).toBeLessThanOrEqual(32);
  });

  it("renders a simple install callback page without trusting query params", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";

    const callback = await app.request(
      "https://hub.example.com/api/github/install/callback?installation_id=spoofed",
      {},
      env,
    );

    expect(callback.status).toBe(200);
    expect(callback.headers.get("content-type")).toContain("text/html");
    await expect(callback.text()).resolves.toContain("Installation updated");
  });

  it("tests write access from a selected GitHub App repository claim", async () => {
    const app = createApp();
    const { env } = createEnv();
    mocks.state.protectionMode = "cf-access";
    mocks.state.config = {
      GITHUB_APP_ID: "123",
      GITHUB_APP_CLIENT_ID: "Iv1.client",
      GITHUB_APP_SLUG: "tiller-test",
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
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
