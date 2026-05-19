import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { createInitialRepoScmState } from "../scm/model";
import { projectRepoSummary } from "../sync/projectors";

const mocks = vi.hoisted(() => ({
  getRepoWorkspaceForRepoId: vi.fn(),
  listRepos: vi.fn(),
  listEnvMetas: vi.fn(),
  readRepoIndexEntry: vi.fn(),
  ensureRepoWorkspaceFromRepoUrl: vi.fn(),
  deriveRepoId: vi.fn(),
  deleteRepoIndex: vi.fn(),
  persistRepoMeta: vi.fn(),
  getScmBootstrapStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  getRunnerBackend: vi.fn(),
  getLocationHintOptions: vi.fn(),
  getSecret: vi.fn(),
  getCanonicalMainBootstrapDepth: vi.fn(),
  resolveProtectionState: vi.fn(),
  resolveContainerHubUrl: vi.fn(),
  integratePlanReviews: vi.fn(),
  runPlanReviewRound: vi.fn(),
  getRepoMergeLockStub: vi.fn(),
}));

vi.mock("../plan/store", async () => {
  const actual = await vi.importActual<typeof import("../plan/store")>("../plan/store");
  return {
    ...actual,
    getRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
    listRepos: mocks.listRepos,
    listEnvMetas: mocks.listEnvMetas,
    readRepoIndexEntry: mocks.readRepoIndexEntry,
    ensureRepoWorkspaceFromRepoUrl: mocks.ensureRepoWorkspaceFromRepoUrl,
    deriveRepoId: mocks.deriveRepoId,
    deleteRepoIndex: mocks.deleteRepoIndex,
    persistRepoMeta: mocks.persistRepoMeta,
  };
});

vi.mock("../helpers", () => ({
  getScmBootstrapStub: mocks.getScmBootstrapStub,
  getWorkspaceStub: mocks.getWorkspaceStub,
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getRepoMergeLockStub: mocks.getRepoMergeLockStub,
  getLocationHintOptions: mocks.getLocationHintOptions,
}));

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

vi.mock("../setup/config", () => ({
  getSecret: mocks.getSecret,
  getCanonicalMainBootstrapDepth: mocks.getCanonicalMainBootstrapDepth,
}));

vi.mock("../protection", async () => {
  const actual = await vi.importActual<typeof import("../protection")>("../protection");
  return {
    ...actual,
    resolveProtectionState: mocks.resolveProtectionState,
  };
});

vi.mock("../env/hub-url", () => ({
  resolveContainerHubUrl: mocks.resolveContainerHubUrl,
}));

vi.mock("../plan/review-service", () => ({
  integratePlanReviews: mocks.integratePlanReviews,
  runPlanReviewRound: mocks.runPlanReviewRound,
}));

const { default: repoRoutes } = await import("../repo/routes");

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", repoRoutes);
  return app;
}

function createExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
  };
}

function createRepoBinding(overrides: Record<string, unknown> = {}) {
  return {
    ENVS_KV: {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockResolvedValue({ keys: [] }),
    },
    BUCKET: {
      put: vi.fn().mockResolvedValue({ key: "repos/repo-1/git-artifacts/g1.tar.zst" }),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
    },
    HUB: {
      idFromName: vi.fn().mockReturnValue("hub-id"),
      get: vi.fn().mockReturnValue({
        broadcastEnvRemove: vi.fn(),
        broadcastRepoUpsert: vi.fn(),
        broadcastRepoRemove: vi.fn(),
        broadcastRepoMainChange: vi.fn(),
        getAllSessions: vi.fn().mockResolvedValue([]),
        deleteSession: vi.fn().mockResolvedValue(undefined),
      }),
    },
    ...overrides,
  };
}

function makeRepoMeta(overrides: Record<string, unknown> = {}) {
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    ...createInitialRepoScmState(),
    createdAt: "2026-04-09T00:00:00.000Z",
    updatedAt: "2026-04-09T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
    ...overrides,
  };
}

describe("repo git artifact routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.listRepos.mockResolvedValue([]);
    mocks.listEnvMetas.mockResolvedValue([]);
    mocks.integratePlanReviews.mockResolvedValue({});
    mocks.runPlanReviewRound.mockResolvedValue({});
    mocks.resolveProtectionState.mockResolvedValue({
      protectionMode: "public",
    });
    mocks.resolveContainerHubUrl.mockResolvedValue("https://hub.example.com");
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.getCanonicalMainBootstrapDepth.mockResolvedValue(0);
    mocks.getScmBootstrapStub.mockReturnValue({
      startBootstrapJob: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getEnvLifecycleStub.mockReturnValue({
      clearMutableState: vi.fn().mockResolvedValue(null),
    });
  });

  it("stores uploaded canonical git artifacts for branch-backed repos", async () => {
    const env = createRepoBinding();
    const workspace = {};
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace,
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: "g-old",
        gitStatus: "pending",
        gitProgressPhase: "Uploading canonical main",
        gitProgressStartedAt: "2026-04-09T00:00:00.000Z",
        gitProgressUpdatedAt: "2026-04-09T00:00:02.000Z",
      }),
    });

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zstd",
          "X-Tiller-Git-Head": "abc123",
        },
        body: "git-artifact-body",
      },
      env as any,
      executionCtx as any,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      repoId: "repo-1",
      mainCommit: "abc123",
      gitStatus: "ready",
    });
    expect(env.BUCKET.put).toHaveBeenCalledTimes(1);
    expect(mocks.persistRepoMeta).toHaveBeenCalledTimes(1);
    expect(mocks.persistRepoMeta.mock.calls[0][2]).toMatchObject({
      repoId: "repo-1",
      mainCommit: "abc123",
      gitStatus: "ready",
      gitProgressPhase: null,
      gitLastBootstrapDurationMs: expect.any(Number),
    });
    expect(env.HUB.get().broadcastRepoMainChange).toHaveBeenCalledWith(
      "repo-1",
      "https://github.com/test/repo",
      null,
      "abc123",
      null,
    );
    expect(env.BUCKET.delete).not.toHaveBeenCalled();
  });

  it("GET /api/repos/:repoId returns the same shape used for websocket repo upserts", async () => {
    const env = createRepoBinding();
    const meta = makeRepoMeta({
      mainCommit: "abc123",
      gitArtifactId: "g-current",
      gitStatus: "ready",
      gitProgressPhase: null,
      gitProgressStartedAt: null,
      gitProgressUpdatedAt: null,
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta,
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1",
      { method: "GET" },
      env as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(projectRepoSummary(meta));
  });

  it("rejects replacing the canonical git artifact once bootstrap has completed", async () => {
    const env = createRepoBinding();
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: "abc123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
      }),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zstd",
          "X-Tiller-Git-Head": "def456",
        },
        body: "git-artifact-body",
      },
      env as any,
    );

    expect(res.status).toBe(409);
    expect(mocks.persistRepoMeta).not.toHaveBeenCalled();
  });

  it("emits env removes before repo remove during repo deletion", async () => {
    const env = createRepoBinding();
    env.BUCKET.list = vi.fn().mockResolvedValue({ objects: [] });
    const hub = env.HUB.get() as {
      broadcastEnvRemove: ReturnType<typeof vi.fn>;
      broadcastRepoRemove: ReturnType<typeof vi.fn>;
    };
    mocks.getWorkspaceStub.mockReturnValue({
      destroyWorkspace: vi.fn().mockResolvedValue(undefined),
    });
    mocks.readRepoIndexEntry.mockResolvedValue({
      repoId: "repo-1",
      repoUrl: "https://github.com/test/repo",
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: "abc123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
      }),
    });
    mocks.listEnvMetas.mockResolvedValue([
      {
        slug: "env-a",
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        runnerMachineId: "machine-a",
        createdAt: "2026-04-09T00:00:00.000Z",
      },
      {
        slug: "env-b",
        repoId: "repo-1",
        repoUrl: "https://github.com/test/repo",
        runnerMachineId: "machine-b",
        createdAt: "2026-04-09T00:00:00.000Z",
      },
    ]);
    mocks.deleteRepoIndex.mockResolvedValue(undefined);

    const app = createTestApp();
    const executionCtx = createExecutionCtx();
    const res = await app.request(
      "/api/repos/repo-1",
      { method: "DELETE" },
      env as any,
      executionCtx as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      repoId: "repo-1",
      deletedEnvSlugs: ["env-a", "env-b"],
    });
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    const deletedKeys = env.ENVS_KV.delete.mock.calls.map(([key]) => key);
    expect(deletedKeys).toEqual(
      expect.arrayContaining(["env-a", "env-b", "envdef:env-a", "envdef:env-b"]),
    );
    expect(deletedKeys.indexOf("env-a")).toBeLessThan(deletedKeys.indexOf("envdef:env-a"));
    expect(deletedKeys.indexOf("env-b")).toBeLessThan(deletedKeys.indexOf("envdef:env-b"));
    expect(hub.broadcastEnvRemove).toHaveBeenCalledWith("env-a");
    expect(hub.broadcastEnvRemove).toHaveBeenCalledWith("env-b");
    expect(hub.broadcastRepoRemove).toHaveBeenCalledWith("repo-1");
    expect(
      Math.max(...hub.broadcastEnvRemove.mock.invocationCallOrder),
    ).toBeLessThan(hub.broadcastRepoRemove.mock.invocationCallOrder[0]);
  });

  it("only accepts staged repo artifacts for the reserved merge artifact id", async () => {
    const env = createRepoBinding();
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: "abc123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
      }),
    });
    mocks.getRepoMergeLockStub.mockReturnValue({
      getOperation: vi.fn().mockResolvedValue({
        operationId: "op-merge",
        type: "merge-into-main",
        status: "pending",
        gitArtifactId: "g-reserved",
      }),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/scm-operations/op-merge/git-artifact",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/zstd",
          "X-Tiller-Git-Artifact-Id": "g-wrong",
        },
        body: "git-artifact-body",
      },
      env as any,
    );

    expect(res.status).toBe(409);
    expect(env.BUCKET.put).not.toHaveBeenCalled();
  });

  it("downloads the current canonical git artifact", async () => {
    const env = createRepoBinding({
      BUCKET: {
        get: vi.fn().mockResolvedValue({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("repo-git-body"));
              controller.close();
            },
          }),
          customMetadata: {
            gitHead: "abc123",
          },
          httpMetadata: {
            contentType: "application/zstd",
          },
        }),
      },
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: "abc123",
        gitArtifactId: "g-current",
        gitStatus: "ready",
      }),
    });

    const app = createTestApp();
    const res = await app.request("/api/repos/repo-1/git-artifact", { method: "GET" }, env as any);

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tiller-git-artifact-id")).toBe("g-current");
    expect(res.headers.get("x-tiller-git-head")).toBe("abc123");
    await expect(res.text()).resolves.toBe("repo-git-body");
  });

  it("starts a repo git bootstrap job with the repo artifact upload URL", async () => {
    const env = createRepoBinding();
    const workspace = {};
    const startBootstrapJob = vi.fn().mockResolvedValue(undefined);
    mocks.getScmBootstrapStub.mockReturnValue({
      startBootstrapJob,
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace,
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
      }),
    });
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) => {
      if (key === "GITHUB_TOKEN") return "gh-token";
      if (key === "CF_ACCESS_CLIENT_ID") return "cf-id";
      if (key === "CF_ACCESS_CLIENT_SECRET") return "cf-secret";
      return undefined;
    });
    mocks.resolveProtectionState.mockResolvedValue({
      protectionMode: "cf-access",
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact/bootstrap",
      { method: "POST" },
      env as any,
    );

    expect(res.status).toBe(202);
    expect(mocks.persistRepoMeta).toHaveBeenCalledWith(
      env,
      workspace,
      expect.objectContaining({
        repoId: "repo-1",
        gitStatus: "pending",
        gitError: null,
        gitProgressPhase: "Starting bootstrap container",
      }),
    );
    expect(startBootstrapJob).toHaveBeenCalledTimes(1);
    const [repoId, envVars] = startBootstrapJob.mock.calls[0];
    expect(repoId).toBe("repo-1");
    expect(envVars).toMatchObject({
      TILLER_BOOTSTRAP_MODE: "repo-git",
      TILLER_REPO_ID: "repo-1",
      TILLER_REPO_GIT_ARTIFACT_URL: "https://hub.example.com/api/repos/repo-1/git-artifact",
      TILLER_REPO_GIT_FAILURE_URL: "https://hub.example.com/api/repos/repo-1/git-artifact/bootstrap-failed",
      TILLER_REPO_GIT_PROGRESS_URL: "https://hub.example.com/api/repos/repo-1/git-artifact/bootstrap-progress",
      TILLER_REPO_GIT_BOOTSTRAP_REF: "HEAD",
      TILLER_REPO_GIT_BOOTSTRAP_DEPTH: "0",
      GITHUB_TOKEN: "gh-token",
      CF_ACCESS_CLIENT_ID: "cf-id",
      CF_ACCESS_CLIENT_SECRET: "cf-secret",
    });
    expect(mocks.getRunnerBackend).not.toHaveBeenCalled();
  });

  it("keeps canonical main bootstrap on Cloudflare containers outside local-only development mode", async () => {
    const env = createRepoBinding();
    const startBootstrapJob = vi.fn().mockResolvedValue(undefined);
    mocks.getScmBootstrapStub.mockReturnValue({
      startBootstrapJob,
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
      }),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact/bootstrap",
      { method: "POST" },
      env as any,
    );

    expect(res.status).toBe(202);
    expect(startBootstrapJob).toHaveBeenCalledTimes(1);
    expect(mocks.getRunnerBackend).not.toHaveBeenCalled();
  });

  it("uses the host backend for bootstrap in local-only development mode", async () => {
    const backendCreate = vi.fn().mockResolvedValue({});
    const env = createRepoBinding({
      LOCAL_DEV_ONLY_BACKEND: "true",
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
      }),
    });
    mocks.getRunnerBackend.mockResolvedValue({
      create: backendCreate,
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact/bootstrap",
      { method: "POST" },
      env as any,
    );

    expect(res.status).toBe(202);
    expect(mocks.getRunnerBackend).toHaveBeenCalledWith(env, "host");
    expect(mocks.getScmBootstrapStub).not.toHaveBeenCalled();
  });

  it("passes the configured canonical main depth into bootstrap env vars", async () => {
    const startBootstrapJob = vi.fn().mockResolvedValue(undefined);
    const env = createRepoBinding();
    mocks.getCanonicalMainBootstrapDepth.mockResolvedValue(25);
    mocks.getScmBootstrapStub.mockReturnValue({
      startBootstrapJob,
    });
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace: {},
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
      }),
    });
    const app = createTestApp();
    await app.request(
      "/api/repos/repo-1/git-artifact/bootstrap",
      { method: "POST" },
      env as any,
    );

    expect(startBootstrapJob.mock.calls[0]?.[1]).toMatchObject({
      TILLER_REPO_GIT_BOOTSTRAP_DEPTH: "25",
    });
  });

  it("records repo bootstrap progress phases", async () => {
    const env = createRepoBinding();
    const workspace = {};
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace,
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
        gitError: null,
        gitProgressStartedAt: "2026-04-09T00:00:00.000Z",
      }),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact/bootstrap-progress",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ phase: "Uploading canonical main" }),
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mocks.persistRepoMeta).toHaveBeenCalledWith(
      env,
      workspace,
      expect.objectContaining({
        repoId: "repo-1",
        gitStatus: "pending",
        gitProgressPhase: "Uploading canonical main",
      }),
    );
  });

  it("marks repos as repair-required when bootstrap failure is reported", async () => {
    const env = createRepoBinding();
    const workspace = {};
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue({
      workspace,
      meta: makeRepoMeta({
        mainCommit: null,
        gitArtifactId: null,
        gitStatus: "pending",
        gitError: null,
      }),
    });

    const app = createTestApp();
    const res = await app.request(
      "/api/repos/repo-1/git-artifact/bootstrap-failed",
      {
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
        },
        body: "git clone failed",
      },
      env as any,
    );

    expect(res.status).toBe(200);
    expect(mocks.persistRepoMeta).toHaveBeenCalledWith(
      env,
      workspace,
      expect.objectContaining({
        repoId: "repo-1",
        gitStatus: "repair-required",
        gitError: "git clone failed",
      }),
    );
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      repoId: "repo-1",
      gitStatus: "repair-required",
      gitError: "git clone failed",
    });
  });
});
