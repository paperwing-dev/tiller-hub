import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv, RepoMeta } from "../types";
import { createInitialRepoScmState } from "../scm/model";

const mocks = vi.hoisted(() => ({
  broadcastPlanArtifactUpdated: vi.fn(),
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

const { default: repoRoutes } = await import("../repo/routes");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", repoRoutes);
  return app;
}

function createEnv() {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        broadcastPlanArtifactUpdated: mocks.broadcastPlanArtifactUpdated,
        broadcastRepoUpsert: mocks.broadcastRepoUpsert,
      })),
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
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(true);
    mocks.getArtifactStoreStub.mockReturnValue({
      getRepoArtifactState: vi.fn().mockResolvedValue({
        artifacts: [],
        refs: [],
        attention: [],
      }),
    });
  });

  it.each([
    ["GET", "/api/repos/123/cloudflare-mcp"],
    ["POST", "/api/repos/123/cloudflare-mcp/connect"],
    ["GET", "/api/repos/123/cloudflare-mcp/callback"],
    ["POST", "/api/repos/123/cloudflare-mcp/enable"],
    ["POST", "/api/repos/123/cloudflare-mcp/disable"],
    ["POST", "/api/repos/123/cloudflare-mcp/disconnect"],
  ])("returns 404 for removed Cloudflare MCP route %s %s", async (method, path) => {
    const response = await createApp().request(`https://hub.example.com${path}`, { method });
    expect(response.status).toBe(404);
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
    mocks.getArtifactStoreStub.mockReturnValue({
      getRepoArtifactState: vi.fn().mockResolvedValue({
        artifacts: [{ id: "plan-1", repoId: "123", type: "plan" }],
        refs: [],
        attention: [{
          planArtifactId: "plan-1",
          sourceKind: "reviewer",
          sourceId: "thread-1",
          token: "run-1",
        }],
      }),
    });

    const res = await createApp().request(
      "https://hub.example.com/api/repos/123/artifacts",
      {},
      createEnv(),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      artifacts: [{ id: "plan-1" }],
      attention: [{ sourceId: "thread-1", token: "run-1" }],
    });
    expect(mocks.loadTrackedRepoForRequest).toHaveBeenCalled();
    expect(mocks.loadRepoForRequest).not.toHaveBeenCalled();
  });

  it("does not load repository attention for an artifact detail request", async () => {
    const meta = makeRepoMeta();
    const getRepoArtifactState = vi.fn();
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.loadRepoArtifacts.mockResolvedValue({
      artifacts: [{ id: "plan-1", repoId: "123", type: "plan" }],
      refs: [],
    });
    mocks.getArtifactStoreStub.mockReturnValue({ getRepoArtifactState });

    const response = await createApp().request(
      "https://hub.example.com/api/repos/123/artifacts/plan-1",
      {},
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ artifact: { id: "plan-1" } });
    expect(getRepoArtifactState).not.toHaveBeenCalled();
  });

  it("acknowledges only the submitted attention token", async () => {
    const meta = makeRepoMeta();
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    const acknowledgePlanAttention = vi.fn()
      .mockReturnValueOnce("acknowledged")
      .mockReturnValueOnce("conflict")
      .mockReturnValueOnce("absent");
    mocks.getArtifactStoreStub.mockReturnValue({ acknowledgePlanAttention });

    const request = () => createApp().request(
      "https://hub.example.com/api/repos/123/plans/plan-1/attention/acknowledge",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceKind: "reviewer",
          sourceId: "thread-1",
          token: "run-1",
        }),
      },
      createEnv(),
    );

    expect((await request()).status).toBe(204);
    const conflict = await request();
    expect(conflict.status).toBe(409);
    expect((await request()).status).toBe(204);
    expect(acknowledgePlanAttention).toHaveBeenCalledWith({
      repoId: "123",
      planArtifactId: "plan-1",
      sourceKind: "reviewer",
      sourceId: "thread-1",
      token: "run-1",
    });
    expect(mocks.broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastPlanArtifactUpdated).toHaveBeenCalledWith("123", "plan-1");
  });

  it("accepts evaluating as a plan artifact status", async () => {
    const meta = makeRepoMeta();
    const updateArtifactStatus = vi.fn().mockReturnValue({
      artifact: {
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
      },
      terminalWriter: null,
      runtimeCleanupRuns: [],
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

  it("reports the exact writer and reviewer targets handed to durable cleanup", async () => {
    const meta = makeRepoMeta();
    const artifact = {
      id: "plan-1",
      repoId: "123",
      type: "plan",
      title: "Done",
      basis: { repoId: "123", mainCommit: "main-1" },
      body: { markdown: "# Done\n" },
      status: "completed",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:01:00.000Z",
      version: 2,
    } as const;
    const terminalWriter = {
      threadId: "plan-writer-plan-1",
      repoId: "123",
      planArtifactId: "plan-1",
      provider: "codex",
      model: "gpt-test",
      role: "writer",
      status: "cancelled",
      generation: 7,
      stoppedAt: "2026-06-16T00:01:00.000Z",
      stopReason: "completed",
      createdAt: "2026-06-16T00:00:00.000Z",
      updatedAt: "2026-06-16T00:01:00.000Z",
    } as const;
    const cancelledRun = {
      runId: "run-1",
      repoId: "123",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "codex",
      model: "gpt-test",
      status: "cancelled",
      startedAt: "2026-06-16T00:00:00.000Z",
      runtime: { jobSlug: "reviewer-job", generation: 1 },
    } as const;
    const writerTarget = {
      schemaVersion: 1,
      cleanupId: "cleanup-writer-1",
      kind: "writer",
      repoId: "123",
      planArtifactId: "plan-1",
      ownerId: terminalWriter.threadId,
      generation: 7,
      runtime: null,
      launchProvenance: null,
    } as const;
    const reviewerTarget = {
      schemaVersion: 1,
      cleanupId: "cleanup-reviewer-1",
      kind: "reviewer",
      repoId: "123",
      planArtifactId: "plan-1",
      ownerId: cancelledRun.runId,
      runtime: { jobSlug: "reviewer-job" },
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    } as const;
    const updateArtifactStatus = vi.fn().mockReturnValue({
      artifact,
      terminalWriter,
      runtimeCleanupRuns: [cancelledRun],
      cleanupTargets: [writerTarget, reviewerTarget],
    });
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.getArtifactStoreStub.mockReturnValue({ updateArtifactStatus });

    const res = await createApp().request("https://hub.example.com/api/repos/123/artifacts/plan-1/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", expectedVersion: 1 }),
    }, createEnv());

    expect(res.status, await res.clone().text()).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
    });
  });

  it("hands terminal runtime cleanup to the durable retry path without delaying the move", async () => {
    const meta = makeRepoMeta();
    const artifact = {
      id: "plan-1",
      repoId: "123",
      type: "plan",
      status: "completed",
      version: 2,
    } as const;
    const terminalWriter = {
      threadId: "plan-writer-plan-1",
      repoId: "123",
      planArtifactId: "plan-1",
      provider: "codex",
      role: "writer",
      generation: 7,
    } as const;
    const cancelledRun = {
      runId: "run-1",
      repoId: "123",
      planArtifactId: "plan-1",
      role: "reviewer",
    } as const;
    const writerTarget = {
      schemaVersion: 1,
      cleanupId: "cleanup-writer-1",
      kind: "writer",
      repoId: "123",
      planArtifactId: "plan-1",
      ownerId: terminalWriter.threadId,
      generation: 7,
      runtime: null,
      launchProvenance: null,
    } as const;
    const reviewerTarget = {
      schemaVersion: 1,
      cleanupId: "cleanup-reviewer-1",
      kind: "reviewer",
      repoId: "123",
      planArtifactId: "plan-1",
      ownerId: cancelledRun.runId,
      runtime: { jobSlug: "reviewer-job" },
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    } as const;
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.getArtifactStoreStub.mockReturnValue({
      updateArtifactStatus: vi.fn().mockResolvedValue({
        artifact,
        terminalWriter,
        runtimeCleanupRuns: [cancelledRun],
        cleanupTargets: [writerTarget, reviewerTarget],
      }),
    });
    const response = await createApp().request(
      "https://hub.example.com/api/repos/123/artifacts/plan-1/status",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "completed", expectedVersion: 1 }),
      },
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
    });
  });

  it("commits a terminal status while cleanup waits for Your machine", async () => {
    const meta = makeRepoMeta();
    const artifact = {
      id: "plan-1",
      repoId: "123",
      type: "plan",
      status: "completed",
      version: 2,
    } as const;
    const terminalWriter = {
      threadId: "plan-writer-plan-1",
      repoId: "123",
      planArtifactId: "plan-1",
      provider: "codex",
      role: "writer",
      generation: 7,
      runtime: { jobSlug: "writer-job", generation: 7 },
      launchProvenance: { schemaVersion: 1, backend: "host", machineId: "machine-1" },
    } as const;
    const writerTarget = {
      schemaVersion: 1,
      cleanupId: "cleanup-writer-1",
      kind: "writer",
      repoId: "123",
      planArtifactId: "plan-1",
      ownerId: terminalWriter.threadId,
      generation: 7,
      runtime: terminalWriter.runtime,
      launchProvenance: terminalWriter.launchProvenance,
    } as const;
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.getArtifactStoreStub.mockReturnValue({
      updateArtifactStatus: vi.fn().mockResolvedValue({
        artifact,
        terminalWriter,
        runtimeCleanupRuns: [],
        cleanupTargets: [writerTarget],
      }),
    });
    const res = await createApp().request("https://hub.example.com/api/repos/123/artifacts/plan-1/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed", expectedVersion: 1 }),
    }, createEnv());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      artifact: { id: "plan-1", status: "completed" },
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
      cleanupWarning: "Plan moved. Scribe cleanup will finish when Your machine reconnects.",
    });
  });

  it("deletes a plan while its exact Scribe cleanup remains pending", async () => {
    const meta = makeRepoMeta();
    const artifact = {
      id: "plan-1",
      repoId: "123",
      type: "plan",
      status: "draft",
      version: 2,
    } as const;
    const terminalWriter = {
      threadId: "plan-writer-plan-1",
      repoId: "123",
      planArtifactId: "plan-1",
      provider: "codex",
      role: "writer",
      generation: 7,
      runtime: { jobSlug: "writer-job", generation: 7 },
      launchProvenance: { schemaVersion: 1, backend: "host", machineId: "machine-1" },
    } as const;
    const writerTarget = {
      schemaVersion: 1,
      cleanupId: "cleanup-writer-delete-1",
      kind: "writer",
      repoId: "123",
      planArtifactId: "plan-1",
      ownerId: terminalWriter.threadId,
      generation: 7,
      runtime: terminalWriter.runtime,
      launchProvenance: terminalWriter.launchProvenance,
    } as const;
    const discardPlan = vi.fn().mockResolvedValue({
      artifact,
      terminalWriter,
      runtimeCleanupRuns: [],
      cleanupTargets: [writerTarget],
    });
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

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      artifact: { id: "plan-1" },
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
      cleanupWarning: "Plan deleted. Scribe cleanup will finish when Your machine reconnects.",
    });
    expect(discardPlan).toHaveBeenCalledOnce();
  });

  it("broadcasts a normal artifact hint after discarding a plan", async () => {
    const meta = makeRepoMeta();
    const artifact = {
      id: "plan-1",
      repoId: "123",
      type: "plan",
      status: "draft",
      version: 2,
    };
    const discardPlan = vi.fn().mockResolvedValue({
      artifact,
      terminalWriter: null,
      runtimeCleanupRuns: [],
      cleanupTargets: [],
    });
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: { workspace: {}, meta },
    });
    mocks.getArtifactStoreStub.mockReturnValue({ discardPlan });

    const response = await createApp().request("https://hub.example.com/api/repos/123/plans/plan-1", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expectedVersion: 2 }),
    }, createEnv());

    expect(response.status).toBe(200);
    expect(mocks.broadcastPlanArtifactUpdated).toHaveBeenCalledWith("123", "plan-1");
  });
});
