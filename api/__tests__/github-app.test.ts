import { beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalizeGitHubRepo } from "../github/repo";

const mocks = vi.hoisted(() => {
  const state = {
    config: {} as Record<string, string>,
    issuer: "",
  };
  return {
    state,
    importPKCS8: vi.fn(async () => new Uint8Array([1])),
    loadConfig: vi.fn(async () => state.config),
    getOrCreateSecret: vi.fn(),
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

    setIssuer(value: string) {
      mocks.state.issuer = value;
      return this;
    }

    async sign() {
      return "app-jwt";
    }
  },
}));

vi.mock("../setup/config", () => ({
  getOrCreateSecret: mocks.getOrCreateSecret,
  loadConfig: mocks.loadConfig,
}));

const {
  checkGitHubRepoInstallationAccess,
  isGitHubAppInstallationReady,
  listGitHubAppRepositories,
  mintGitHubInstallationToken,
  resolveGitHubAppBotCommitIdentity,
  resolveGitHubAppRepositorySelection,
  resolveGitHubAppRepositorySelectionById,
} = await import("../github/app");

function configureApp(overrides: Record<string, string> = {}) {
  mocks.state.config = {
    GITHUB_APP_ID: "123",
    GITHUB_APP_CLIENT_ID: "Iv1.client",
    GITHUB_APP_SLUG: "tiller-test",
    GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----", // gitleaks:allow -- intentionally invalid fixture
    ...overrides,
  };
}

function mockGitHubFetch(responses: Array<{ status: number; body?: unknown }>) {
  const queue = [...responses];
  const fetchMock = vi.fn(async () => {
    const next = queue.shift();
    if (!next) {
      throw new Error("Unexpected GitHub API request.");
    }
    return new Response(JSON.stringify(next.body ?? {}), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("GitHub App installation tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    configureApp();
    mocks.state.issuer = "";
  });

  it("resolves the app bot's canonical commit identity", async () => {
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 24680,
          login: "tiller-test[bot]",
        },
      },
    ]);

    await expect(resolveGitHubAppBotCommitIdentity({} as any, "installation-token")).resolves.toEqual({
      name: "tiller-test[bot]",
      email: "24680+tiller-test[bot]@users.noreply.github.com",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/users/tiller-test%5Bbot%5D",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer installation-token",
          "User-Agent": "tiller-hub",
        }),
      }),
    );
  });

  it("mints a repo-scoped read-only installation token using the client ID issuer", async () => {
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 1234,
          permissions: { contents: "read", metadata: "read" },
        },
      },
      {
        status: 201,
        body: {
          token: "installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "read", metadata: "read" },
        },
      },
    ]);

    const token = await mintGitHubInstallationToken(
      {} as any,
      canonicalizeGitHubRepo("owner/repo-a", { allowOwnerRepo: true }),
    );

    expect(mocks.state.issuer).toBe("Iv1.client");
    expect(token).toMatchObject({
      token: "installation-token",
      installationId: 1234,
      repository: "owner/repo-a",
      permissions: { contents: "read", metadata: "read" },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/owner/repo-a/installation",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer app-jwt" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/app/installations/1234/access_tokens",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repositories: ["repo-a"],
          permissions: { metadata: "read", contents: "read" },
        }),
      }),
    );
  });

  it("converts GitHub RSA private keys to PKCS#8 before signing JWTs", async () => {
    configureApp({
      GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\\nAQIDBA==\\n-----END RSA PRIVATE KEY-----",
    });
    mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 2222,
          permissions: { contents: "read", metadata: "read" },
        },
      },
      {
        status: 201,
        body: {
          token: "rsa-installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "read", metadata: "read" },
        },
      },
    ]);

    await mintGitHubInstallationToken(
      {} as any,
      canonicalizeGitHubRepo("rsa/repo-rsa", { allowOwnerRepo: true }),
    );

    const importedPem = mocks.importPKCS8.mock.calls[0]?.[0] as string;
    expect(importedPem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(importedPem).toContain("-----END PRIVATE KEY-----");
    expect(importedPem).not.toContain("RSA PRIVATE KEY");
  });

  it("distinguishes a missing owner installation from a repo not selected for an installation", async () => {
    mockGitHubFetch([
      { status: 404, body: { message: "Not Found" } },
      { status: 404, body: { message: "Not Found" } },
      { status: 404, body: { message: "Not Found" } },
    ]);

    await expect(
      mintGitHubInstallationToken(
        {} as any,
        canonicalizeGitHubRepo("missing/repo-b", { allowOwnerRepo: true }),
      ),
    ).rejects.toMatchObject({
      code: "github_app_missing_installation",
      status: 404,
    });

    mockGitHubFetch([
      { status: 404, body: { message: "Not Found" } },
      {
        status: 200,
        body: {
          id: 5678,
          permissions: { contents: "read", metadata: "read" },
        },
      },
    ]);

    await expect(
      mintGitHubInstallationToken(
        {} as any,
        canonicalizeGitHubRepo("selected/repo-c", { allowOwnerRepo: true }),
      ),
    ).rejects.toMatchObject({
      code: "github_app_repo_not_selected",
      status: 403,
    });
  });

  it("rejects installations missing required read permissions", async () => {
    mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 9012,
          permissions: { metadata: "read" },
        },
      },
    ]);

    await expect(
      mintGitHubInstallationToken(
        {} as any,
        canonicalizeGitHubRepo("perms/repo-d", { allowOwnerRepo: true }),
      ),
    ).rejects.toMatchObject({
      code: "github_app_missing_permissions",
      status: 403,
    });
  });

  it("checks PR-ready installation access without minting a token", async () => {
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 3456,
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
    ]);

    await expect(
      checkGitHubRepoInstallationAccess(
        {} as any,
        canonicalizeGitHubRepo("owner/repo-write", { allowOwnerRepo: true }),
        { access: "write" },
      ),
    ).resolves.toMatchObject({
      installationId: 3456,
      repository: "owner/repo-write",
      permissions: { contents: "write", metadata: "read", pull_requests: "write" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.github.com/repos/owner/repo-write/installation");
  });

  it("reports old read-only apps as missing permissions for write access checks", async () => {
    mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 4567,
          permissions: { contents: "read", metadata: "read" },
        },
      },
    ]);

    await expect(
      checkGitHubRepoInstallationAccess(
        {} as any,
        canonicalizeGitHubRepo("owner/repo-old", { allowOwnerRepo: true }),
        { access: "write" },
      ),
    ).rejects.toMatchObject({
      code: "github_app_missing_permissions",
      status: 403,
    });
  });

  it("requires workflows permission for publish access checks", async () => {
    mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 4568,
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
    ]);

    await expect(
      checkGitHubRepoInstallationAccess(
        {} as any,
        canonicalizeGitHubRepo("owner/repo-with-workflows", { allowOwnerRepo: true }),
        { access: "publish" },
      ),
    ).rejects.toMatchObject({
      code: "github_app_missing_permissions",
      status: 403,
    });
  });

  it("can mint an internal write token with PR-ready permissions", async () => {
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 5679,
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
      {
        status: 201,
        body: {
          token: "write-installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
    ]);

    const token = await mintGitHubInstallationToken(
      {} as any,
      canonicalizeGitHubRepo("owner/repo-pr", { allowOwnerRepo: true }),
      { access: "write" },
    );

    expect(token.permissions).toEqual({ metadata: "read", contents: "write", pull_requests: "write" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/app/installations/5679/access_tokens",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repositories: ["repo-pr"],
          permissions: { metadata: "read", contents: "write", pull_requests: "write" },
        }),
      }),
    );
  });

  it("includes workflows permission in publish tokens", async () => {
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: {
          id: 5680,
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
            workflows: "write",
          },
        },
      },
      {
        status: 201,
        body: {
          token: "publish-installation-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: {
            contents: "write",
            metadata: "read",
            pull_requests: "write",
            workflows: "write",
          },
        },
      },
    ]);

    const token = await mintGitHubInstallationToken(
      {} as any,
      canonicalizeGitHubRepo("owner/repo-publish", { allowOwnerRepo: true }),
      { access: "publish" },
    );

    expect(token.permissions).toEqual({
      metadata: "read",
      contents: "write",
      pull_requests: "write",
      workflows: "write",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/app/installations/5680/access_tokens",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          repositories: ["repo-publish"],
          permissions: {
            metadata: "read",
            contents: "write",
            pull_requests: "write",
            workflows: "write",
          },
        }),
      }),
    );
  });

  it("lists repositories selected in write-capable app installations and warns on skipped installs", async () => {
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: [
          {
            id: 1001,
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
            repository_selection: "selected",
          },
          {
            id: 1002,
            permissions: { contents: "read", metadata: "read" },
          },
        ],
      },
      {
        status: 201,
        body: {
          token: "installation-list-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
      {
        status: 200,
        body: {
          repositories: [
            {
              id: 42,
              full_name: "Owner/Repo",
              html_url: "https://github.com/Owner/Repo",
              private: true,
              default_branch: "main",
            },
          ],
        },
      },
    ]);

    await expect(listGitHubAppRepositories({} as any)).resolves.toEqual({
      repositories: [
        {
          repositoryId: 42,
          installationId: 1001,
          fullName: "owner/repo",
          repoUrl: "https://github.com/owner/repo",
          private: true,
          defaultBranch: "main",
        },
      ],
      warnings: [
        expect.objectContaining({
          installationId: 1002,
          code: "github_app_missing_permissions",
        }),
      ],
      repositorySelection: "selected",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/app/installations?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer app-jwt" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/installation/repositories?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer installation-list-token" }),
      }),
    );
  });

  it("requires both installation permissions and at least one usable repository", async () => {
    configureApp({ GITHUB_APP_ID: "setup-ready-app" });
    const fetchMock = mockGitHubFetch([
      {
        status: 200,
        body: [{
          id: 1001,
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          repository_selection: "selected",
        }],
      },
      {
        status: 201,
        body: {
          token: "setup-ready-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
      {
        status: 200,
        body: {
          repositories: [{
            id: 42,
            full_name: "Owner/Repo",
            html_url: "https://github.com/Owner/Repo",
            private: true,
            default_branch: "main",
          }],
        },
      },
    ]);

    await expect(isGitHubAppInstallationReady({} as any)).resolves.toBe(true);
    await expect(isGitHubAppInstallationReady({} as any)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/app/installations?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer app-jwt" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.github.com/installation/repositories?per_page=100&page=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer setup-ready-token" }),
      }),
    );
  });

  it("rejects fabricated selected repo claims that do not match the current app repository list", async () => {
    mockGitHubFetch([
      {
        status: 200,
        body: [
          {
            id: 1001,
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          },
        ],
      },
      {
        status: 201,
        body: {
          token: "installation-list-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
      {
        status: 200,
        body: {
          repositories: [
            {
              id: 42,
              full_name: "owner/repo",
              html_url: "https://github.com/owner/repo",
              private: false,
              default_branch: "main",
            },
          ],
        },
      },
    ]);

    await expect(resolveGitHubAppRepositorySelection({} as any, {
      repositoryId: 99,
      installationId: 1001,
      fullName: "owner/repo",
    })).rejects.toMatchObject({
      code: "github_app_repo_not_selected",
      status: 403,
    });
  });

  it("resolves selected repositories by installation and repository id after a repo rename", async () => {
    mockGitHubFetch([
      {
        status: 200,
        body: [
          {
            id: 1001,
            permissions: { contents: "write", metadata: "read", pull_requests: "write" },
          },
        ],
      },
      {
        status: 201,
        body: {
          token: "installation-list-token",
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
          permissions: { contents: "write", metadata: "read", pull_requests: "write" },
        },
      },
      {
        status: 200,
        body: {
          repositories: [
            {
              id: 42,
              full_name: "owner/renamed",
              html_url: "https://github.com/owner/renamed",
              private: false,
              default_branch: "trunk",
            },
          ],
        },
      },
    ]);

    await expect(resolveGitHubAppRepositorySelectionById({} as any, {
      repositoryId: 42,
      installationId: 1001,
    })).resolves.toMatchObject({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/renamed",
      repoUrl: "https://github.com/owner/renamed",
      defaultBranch: "trunk",
    });
  });
});
