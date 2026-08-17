import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

const mocks = vi.hoisted(() => ({
  loadTrackedRepoForRequest: vi.fn(),
  listEnvDefinitionSlugs: vi.fn(),
  readEnvDefinition: vi.fn(),
  deleteRepoIndex: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  getEnvReviewStub: vi.fn(),
  destroyWorkspace: vi.fn(),
}));

vi.mock("../repo/access", () => ({
  createOrRefreshRepoFromSelectionClaimForRequest: vi.fn(),
  githubAppPublicHubDisabledBody: vi.fn(() => ({})),
  loadRepoForRequest: vi.fn(),
  loadRepoProjection: vi.fn(),
  loadTrackedRepoForRequest: mocks.loadTrackedRepoForRequest,
}));

vi.mock("../plan/store", () => ({
  deleteRepoIndex: mocks.deleteRepoIndex,
  listEnvDefinitionSlugs: mocks.listEnvDefinitionSlugs,
  listRepos: vi.fn(async () => []),
  persistRepoMeta: vi.fn(),
  readEnvDefinition: mocks.readEnvDefinition,
}));

vi.mock("../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getEnvReviewStub: mocks.getEnvReviewStub,
}));

vi.mock("../github/app", async () => {
  const actual = await vi.importActual<typeof import("../github/app")>("../github/app");
  return { ...actual, isGitHubAppAllowedForRequest: vi.fn(async () => true) };
});

const { default: repoRoutes } = await import("../repo/routes");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", repoRoutes);
  return app;
}

function createEnv() {
  const hub = {
    deleteRepoSessionEnv: vi.fn(async () => undefined),
    deleteRepoMcpServers: vi.fn(async () => undefined),
    broadcastRepoRemove: vi.fn(async () => undefined),
  };
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => hub),
    },
    hub,
  };
}

function executionCtx() {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() };
}

describe("repository deletion safety", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          artifactStoreGeneration: "generation-1",
        },
        workspace: { destroyWorkspace: mocks.destroyWorkspace },
      },
    });
    mocks.listEnvDefinitionSlugs.mockResolvedValue([]);
    mocks.readEnvDefinition.mockResolvedValue(null);
    mocks.getArtifactStoreStub.mockReturnValue({
      listPlannerWorkloadStateForPredeploy: vi.fn(async () => []),
      listPlanWritersForRepo: vi.fn(async () => []),
      listPlanRuntimeCleanupTargetsForRepo: vi.fn(async () => []),
      finalizeRepositoryDeletion: vi.fn(async () => undefined),
    });
    mocks.getEnvLifecycleStub.mockReturnValue({ getGitHubPublishOperation: vi.fn(async () => null) });
    mocks.getEnvReviewStub.mockReturnValue({ listActiveRuns: vi.fn(async () => []) });
  });

  it("refuses every attached environment and never cascades deletion", async () => {
    mocks.listEnvDefinitionSlugs.mockResolvedValue(["env-1"]);
    mocks.readEnvDefinition.mockResolvedValue({ slug: "env-1", repoId: "repo-1", backend: "host" });
    const { HUB, hub } = createEnv();
    const ctx = executionCtx();

    const res = await createApp().request("/api/repos/repo-1", { method: "DELETE" }, { HUB } as any, ctx as any);
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "repository_delete_blocked",
      blockers: [expect.objectContaining({ kind: "environment", id: "env-1" })],
    });
    expect(mocks.deleteRepoIndex).not.toHaveBeenCalled();
    expect(hub.broadcastRepoRemove).not.toHaveBeenCalled();
    expect(mocks.destroyWorkspace).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("refuses active reviewer work and retained Plan Writer ownership before mutation", async () => {
    mocks.getArtifactStoreStub.mockReturnValue({
      listPlannerWorkloadStateForPredeploy: vi.fn(async () => [{
        runId: "run-1",
        status: "running",
        hasRuntime: false,
      }]),
      listPlanWritersForRepo: vi.fn(async () => [{
        threadId: "writer-1",
        role: "writer",
        planArtifactId: "plan-1",
        jobSlug: "job-1",
      }]),
      listPlanRuntimeCleanupTargetsForRepo: vi.fn(async () => [{
        cleanupId: "cleanup-1",
        ownerId: "writer-1",
        kind: "writer",
      }]),
      finalizeRepositoryDeletion: vi.fn(async () => undefined),
    });
    const { HUB, hub } = createEnv();
    const ctx = executionCtx();
    const res = await createApp().request("/api/repos/repo-1", { method: "DELETE" }, { HUB } as any, ctx as any);

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      blockers: expect.arrayContaining([
        expect.objectContaining({ kind: "planner_run", id: "run-1" }),
        expect.objectContaining({ kind: "plan_writer", id: "writer-1" }),
        expect.objectContaining({ kind: "plan_writer_runtime", id: "writer-1" }),
        expect.objectContaining({ kind: "plan_runtime_cleanup", id: "cleanup-1" }),
      ]),
    });
    expect(mocks.deleteRepoIndex).not.toHaveBeenCalled();
    expect(hub.broadcastRepoRemove).not.toHaveBeenCalled();
  });

  it("deletes only the repository when the complete scan is clear", async () => {
    const artifactStore = mocks.getArtifactStoreStub();
    const { HUB, hub } = createEnv();
    const ctx = executionCtx();
    const res = await createApp().request("/api/repos/repo-1", { method: "DELETE" }, { HUB } as any, ctx as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, repoId: "repo-1", deletedEnvSlugs: [] });
    expect(mocks.getArtifactStoreStub).toHaveBeenCalledWith(
      expect.anything(),
      "repo-1",
      "generation-1",
    );
    expect(artifactStore.finalizeRepositoryDeletion).toHaveBeenCalledWith("repo-1");
    expect(mocks.destroyWorkspace).toHaveBeenCalledOnce();
    expect(mocks.deleteRepoIndex).toHaveBeenCalledWith(expect.anything(), "repo-1");
    expect(hub.broadcastRepoRemove).toHaveBeenCalledWith("repo-1");
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
