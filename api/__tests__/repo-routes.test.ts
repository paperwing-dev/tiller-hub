import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv, RepoMeta } from "../types";
import { createInitialRepoScmState } from "../scm/model";
import { installedAccessBindings, TEST_WORKERS_DEV_HOSTNAME } from "./access-binding-fixture";

const mocks = vi.hoisted(() => ({
  broadcastRepoUpsert: vi.fn(),
  createOrRefreshRepoFromSelectionClaimForRequest: vi.fn(),
  githubAppPublicHubDisabledBody: vi.fn(() => ({
    error: "Repository-backed flows are only available on protected hubs and localhost.",
    code: "github_app_public_hub_disabled",
  })),
  isGitHubAppAllowedForRequest: vi.fn(async () => true),
  loadRepoForRequest: vi.fn(),
  loadRepoProjection: vi.fn(),
  loadTrackedRepoForRequest: vi.fn(),
  refreshGitHubDefaultBranchHead: vi.fn(),
  listRepos: vi.fn(async () => []),
  deleteRepoIndex: vi.fn(),
  getEnvDefinitionKey: vi.fn(),
  listEnvDefinitionSlugs: vi.fn(),
  persistRepoMeta: vi.fn(),
  readEnvDefinition: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  destroyEnv: vi.fn(),
  loadRepoArtifacts: vi.fn(),
  buildCloudflareMcpRedirectUri: vi.fn(),
  getCloudflareMcpRequestIdentity: vi.fn(() => ({ email: "owner@example.com" })),
}));

vi.mock("../coordination", () => ({
  loadRepoArtifacts: mocks.loadRepoArtifacts,
}));

vi.mock("../plan/store", () => ({
  deleteRepoIndex: mocks.deleteRepoIndex,
  getEnvDefinitionKey: mocks.getEnvDefinitionKey,
  listEnvDefinitionSlugs: mocks.listEnvDefinitionSlugs,
  listRepos: mocks.listRepos,
  persistRepoMeta: mocks.persistRepoMeta,
  readEnvDefinition: mocks.readEnvDefinition,
}));

vi.mock("../repo/access", () => ({
  createOrRefreshRepoFromSelectionClaimForRequest: mocks.createOrRefreshRepoFromSelectionClaimForRequest,
  githubAppPublicHubDisabledBody: mocks.githubAppPublicHubDisabledBody,
  loadRepoForRequest: mocks.loadRepoForRequest,
  loadRepoProjection: mocks.loadRepoProjection,
  loadTrackedRepoForRequest: mocks.loadTrackedRepoForRequest,
}));

vi.mock("../repo/refresh", () => ({
  refreshGitHubDefaultBranchHead: mocks.refreshGitHubDefaultBranchHead,
}));

vi.mock("../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
}));

vi.mock("../env/service", () => ({
  destroyEnv: mocks.destroyEnv,
}));

vi.mock("../github/app", () => ({
  isGitHubAppAllowedForRequest: mocks.isGitHubAppAllowedForRequest,
}));

vi.mock("../cloudflare-mcp", () => ({
  CloudflareMcpUserError: class CloudflareMcpUserError extends Error {
    status = 400;
  },
  buildCloudflareMcpRedirectUri: mocks.buildCloudflareMcpRedirectUri,
  getCloudflareMcpRequestIdentity: mocks.getCloudflareMcpRequestIdentity,
}));

const { default: repoRoutes } = await import("../repo/routes");
const { clearWorkersDevAccessTrustCache } = await import("../workers-dev-access/records");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", repoRoutes);
  return app;
}

function createEnv() {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({ broadcastRepoUpsert: mocks.broadcastRepoUpsert })),
    },
  } as unknown as HonoEnv["Bindings"];
}

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-06-16T00:00:00.000Z";
  return {
    repoId: "123",
    artifactStoreGeneration: "generation-1",
    repoUrl: "https://github.com/test/repo",
    ...createInitialRepoScmState(),
    scmModel: "github",
    githubInstallationId: 456,
    githubFullName: "test/repo",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-1",
    gitStatus: "ready",
    gitError: null,
    createdAt: now,
    updatedAt: now,
    bootstrappedFromRef: "main",
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
    ...overrides,
  };
}

describe("repo routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearWorkersDevAccessTrustCache();
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(true);
  });

  it("builds Cloudflare MCP OAuth URLs from canonical workers.dev trust", async () => {
    const meta = makeRepoMeta();
    mocks.loadRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.buildCloudflareMcpRedirectUri.mockImplementation(
      (origin: string, repoId: string) =>
        `${origin}/api/repos/${repoId}/cloudflare-mcp/callback`,
    );
    const startRepoCloudflareMcpOAuth = vi.fn().mockResolvedValue({
      authorizationUrl: "https://dash.cloudflare.com/oauth2/auth",
    });
    const completeRepoCloudflareMcpOAuth = vi.fn().mockResolvedValue({
      state: "connected",
    });
    const trust = {
      version: 1,
      ownerEmail: "owner@example.com",
      accountId: "",
      workerName: "tiller",
      workersDevHostname: TEST_WORKERS_DEV_HOSTNAME,
      issuer: "https://team.cloudflareaccess.com",
      audience: "audience-1",
      serviceTokenId: "token-1",
      serviceClientId: "client-id.access",
      configuredAt: "2026-07-16T00:00:00.000Z",
    };
    const hub = {
      startRepoCloudflareMcpOAuth,
      completeRepoCloudflareMcpOAuth,
      getWorkersDevAccessLifecycle: vi.fn().mockResolvedValue({
        configured: true,
        workersDevHostname: trust.workersDevHostname,
        tokenExpiresAt: "2027-07-16T00:00:00.000Z",
        renewalRecommended: false,
      }),
      getWorkersDevAccessTrust: vi.fn().mockResolvedValue(trust),
    };
    const env = {
      ...installedAccessBindings({
        hostname: trust.workersDevHostname,
        issuer: trust.issuer,
        audience: trust.audience,
        serviceClientId: trust.serviceClientId,
        ownerEmail: trust.ownerEmail,
      }),
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => hub),
      },
    } as any;

    const response = await createApp().request(
      "https://untrusted.example.com/api/repos/123/cloudflare-mcp/connect",
      { method: "POST" },
      env,
    );

    expect(response.status).toBe(200);
    expect(startRepoCloudflareMcpOAuth).toHaveBeenCalledWith("123", {
      redirectUri: "https://tiller.preview.workers.dev/api/repos/123/cloudflare-mcp/callback",
      hubOrigin: "https://tiller.preview.workers.dev",
      requestIdentity: { email: "owner@example.com" },
    });

    const callbackResponse = await createApp().request(
      "https://another-untrusted.example.com/api/repos/123/cloudflare-mcp/callback?code=code-1&state=state-1",
      { headers: { Accept: "application/json" } },
      env,
    );
    expect(callbackResponse.status).toBe(200);
    expect(completeRepoCloudflareMcpOAuth).toHaveBeenCalledWith("123", {
      state: "state-1",
      code: "code-1",
      redirectUri: "https://tiller.preview.workers.dev/api/repos/123/cloudflare-mcp/callback",
      requestIdentity: { email: "owner@example.com" },
    });
  });

  it("broadcasts refreshed GitHub metadata for an existing tracked repo", async () => {
    const meta = makeRepoMeta({ updatedAt: "2026-06-16T01:00:00.000Z" });
    mocks.createOrRefreshRepoFromSelectionClaimForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta, created: false },
    });

    const res = await createApp().request("https://hub.example.com/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repositoryId: 123,
        installationId: 456,
        fullName: "test/repo",
      }),
    }, createEnv());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      repoId: "123",
      githubDefaultBranchHeadSha: "main-1",
      gitStatus: "ready",
    });
    expect(mocks.broadcastRepoUpsert).toHaveBeenCalledWith(expect.objectContaining({
      repoId: "123",
      githubDefaultBranchHeadSha: "main-1",
      gitStatus: "ready",
    }));
  });

  it("refreshes stale GitHub metadata when fetching a pending repo", async () => {
    const pending = makeRepoMeta({
      githubDefaultBranchHeadSha: null,
      gitStatus: "pending",
      updatedAt: "2026-06-16T00:00:00.000Z",
    });
    const refreshed = makeRepoMeta({
      githubDefaultBranchHeadSha: "main-2",
      gitStatus: "ready",
      updatedAt: "2026-06-16T01:00:00.000Z",
    });
    mocks.loadRepoProjection.mockResolvedValue({
      ok: true,
      repo: pending,
    });
    mocks.refreshGitHubDefaultBranchHead.mockResolvedValue({
      repo: { workspace: {}, meta: refreshed, created: false },
      changed: true,
      mainChanged: true,
      failureKind: null,
      error: null,
      code: null,
      status: null,
    });

    const res = await createApp().request("https://hub.example.com/api/repos/123", {}, createEnv());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      repoId: "123",
      githubDefaultBranchHeadSha: "main-2",
      gitStatus: "ready",
    });
    expect(mocks.refreshGitHubDefaultBranchHead).toHaveBeenCalledWith(expect.anything(), "123");
    expect(mocks.broadcastRepoUpsert).not.toHaveBeenCalled();
  });

  it("does not refresh ready GitHub metadata when fetching a repo", async () => {
    const meta = makeRepoMeta({
      githubDefaultBranchHeadSha: "main-1",
      gitStatus: "ready",
    });
    mocks.loadRepoProjection.mockResolvedValue({
      ok: true,
      repo: meta,
    });

    const res = await createApp().request("https://hub.example.com/api/repos/123", {}, createEnv());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      repoId: "123",
      githubDefaultBranchHeadSha: "main-1",
      gitStatus: "ready",
    });
    expect(mocks.createOrRefreshRepoFromSelectionClaimForRequest).not.toHaveBeenCalled();
    expect(mocks.refreshGitHubDefaultBranchHead).not.toHaveBeenCalled();
    expect(mocks.broadcastRepoUpsert).not.toHaveBeenCalled();
  });

  it("loads stored artifacts when live GitHub installation listing is unavailable", async () => {
    const meta = makeRepoMeta();
    mocks.loadRepoForRequest.mockResolvedValue({
      ok: false,
      status: 504,
      body: {
        error: "GitHub installation listing failed with HTTP 504.",
        code: "github_app_installation_list_failed",
      },
    });
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.loadRepoArtifacts.mockResolvedValue({
      artifacts: [{ id: "plan-1", repoId: "123", type: "plan" }],
      refs: [],
    });

    const res = await createApp().request(
      "https://hub.example.com/api/repos/123/artifacts",
      {},
      createEnv(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ artifacts: [{ id: "plan-1" }] });
    expect(mocks.loadTrackedRepoForRequest).toHaveBeenCalled();
    expect(mocks.loadRepoForRequest).not.toHaveBeenCalled();
  });

  it("accepts evaluating as a plan artifact status", async () => {
    const meta = makeRepoMeta();
    const updateArtifactStatus = vi.fn().mockReturnValue({
      id: "plan-1",
      repoId: "123",
      type: "plan",
      title: "Under review",
      basis: { repoId: "123", mainCommit: "main-1" },
      body: { markdown: "Review this plan." },
      status: "evaluating",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:01:00.000Z",
      version: 2,
    });
    mocks.loadRepoForRequest.mockResolvedValue({
      ok: false,
      status: 504,
      body: {
        error: "GitHub installation listing failed with HTTP 504.",
        code: "github_app_installation_list_failed",
      },
    });
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.getArtifactStoreStub.mockReturnValue({ updateArtifactStatus });

    const res = await createApp().request("https://hub.example.com/api/repos/123/artifacts/plan-1/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "evaluating", expectedVersion: 1 }),
    }, createEnv());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      artifact: { id: "plan-1", status: "evaluating" },
    });
    expect(updateArtifactStatus).toHaveBeenCalledWith({
      repoId: "123",
      id: "plan-1",
      status: "evaluating",
      expectedVersion: 1,
    });
    expect(mocks.loadRepoForRequest).not.toHaveBeenCalled();
  });

  it("requires explicit Plan Writer cleanup before discarding a plan", async () => {
    const meta = makeRepoMeta();
    const discardPlan = vi.fn().mockRejectedValue(
      new Error("Plan Writer plan-writer-plan-1 retains runtime provenance. Clean it up before deleting the plan."),
    );
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.getArtifactStoreStub.mockReturnValue({ discardPlan });

    const res = await createApp().request("https://hub.example.com/api/repos/123/plans/plan-1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    }, createEnv());

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringMatching(/stop the Plan Writer/i),
    });
    expect(discardPlan).toHaveBeenCalledOnce();
  });
});
