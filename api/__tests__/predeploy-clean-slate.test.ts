import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listEnvDefinitionSlugs: vi.fn(),
  listRepoIndexRepoIdsStrict: vi.fn(),
  readEnvDefinition: vi.fn(),
  loadTrackedRepo: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  getEnvReviewStub: vi.fn(),
  getArtifactStoreStub: vi.fn(),
}));

vi.mock("../plan/store", () => ({
  listEnvDefinitionSlugs: mocks.listEnvDefinitionSlugs,
  listRepoIndexRepoIdsStrict: mocks.listRepoIndexRepoIdsStrict,
  readEnvDefinition: mocks.readEnvDefinition,
}));
vi.mock("../repo/access", () => ({
  loadTrackedRepo: mocks.loadTrackedRepo,
}));
vi.mock("../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getEnvReviewStub: mocks.getEnvReviewStub,
  getArtifactStoreStub: mocks.getArtifactStoreStub,
}));

const { inspectPredeployCleanSlate } = await import("../predeploy-clean-slate");

const emptyHubState = {
  sessions: [],
  routableSessionIds: [],
};

describe("predeploy clean-slate inspection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listEnvDefinitionSlugs.mockResolvedValue([]);
    mocks.listRepoIndexRepoIdsStrict.mockResolvedValue([]);
    mocks.readEnvDefinition.mockResolvedValue(null);
    mocks.loadTrackedRepo.mockImplementation(async (_env, repoId) => ({
      ok: true,
      repo: { meta: { repoId } },
    }));
    mocks.getEnvLifecycleStub.mockReturnValue({
      peekMutableState: vi.fn(async () => ({ status: "stopped" })),
      getGitHubPublishOperation: vi.fn(async () => null),
    });
    mocks.getEnvReviewStub.mockReturnValue({
      listWorkloadStateForPredeploy: vi.fn(async () => []),
    });
    mocks.getArtifactStoreStub.mockReturnValue({
      listPlannerWorkloadStateForPredeploy: vi.fn(async () => []),
      listPlanWritersForRepo: vi.fn(async () => []),
      listPlanRuntimeCleanupTargetsForRepo: vi.fn(async () => []),
    });
  });

  it("passes only when no workload state remains", async () => {
    await expect(inspectPredeployCleanSlate({} as any, emptyHubState)).resolves.toEqual({
      ok: true,
      blockers: [],
    });
  });

  it("reports definitions, active runs, retained runtimes, and pending cleanup", async () => {
    mocks.listEnvDefinitionSlugs.mockResolvedValue(["env-1"]);
    mocks.readEnvDefinition.mockResolvedValue({ slug: "env-1", repoId: "repo-1" });
    mocks.getEnvLifecycleStub.mockReturnValue({
      peekMutableState: vi.fn(async () => ({
        status: "failed",
        scheduledRun: { cleanupRequired: true },
      })),
      getGitHubPublishOperation: vi.fn(async () => ({ operationId: "publish-1" })),
    });
    mocks.getEnvReviewStub.mockReturnValue({
      listWorkloadStateForPredeploy: vi.fn(async () => [{
        runId: "env-review-1",
        status: "running",
        hasRuntime: true,
      }]),
    });
    mocks.listRepoIndexRepoIdsStrict.mockResolvedValue(["repo-1"]);
    mocks.getArtifactStoreStub.mockReturnValue({
      listPlannerWorkloadStateForPredeploy: vi.fn(async () => [{
        runId: "planner-1",
        status: "saving",
        hasRuntime: true,
      }]),
      listPlanWritersForRepo: vi.fn(async () => [{
        threadId: "writer-1",
        jobSlug: "writer-job",
        runtime: { backend: "cf", machineId: null, jobSlug: "writer-job", generation: 1 },
        cleanupError: "retry",
      }]),
      listPlanRuntimeCleanupTargetsForRepo: vi.fn(async () => [{
        cleanupId: "cleanup-1",
        repoId: "repo-1",
        kind: "writer",
      }]),
    });

    const status = await inspectPredeployCleanSlate({} as any, emptyHubState);

    expect(status.ok).toBe(false);
    expect(status.blockers.map((blocker) => blocker.kind)).toEqual([
      "environment_definition",
      "pending_environment_cleanup",
      "environment_review_record",
      "active_environment_review",
      "retained_environment_review_runtime",
      "active_github_publish",
      "planner_run_record",
      "active_planner_run",
      "retained_planner_runtime",
      "plan_writer_record",
      "active_plan_writer",
      "retained_plan_writer_runtime",
      "pending_plan_writer_cleanup",
      "pending_plan_runtime_cleanup",
    ]);
  });

  it("rejects terminal workload records even after their runtimes are gone", async () => {
    mocks.listEnvDefinitionSlugs.mockResolvedValue(["env-1"]);
    mocks.readEnvDefinition.mockResolvedValue({ slug: "env-1", repoId: "repo-1" });
    mocks.getEnvReviewStub.mockReturnValue({
      listWorkloadStateForPredeploy: vi.fn(async () => [{
        runId: "env-review-1",
        status: "completed",
        hasRuntime: false,
      }]),
    });
    mocks.listRepoIndexRepoIdsStrict.mockResolvedValue(["repo-1"]);
    mocks.getArtifactStoreStub.mockReturnValue({
      listPlannerWorkloadStateForPredeploy: vi.fn(async () => [{
        runId: "planner-1",
        status: "failed",
        hasRuntime: false,
      }]),
      listPlanWritersForRepo: vi.fn(async () => [{
        threadId: "writer-1",
        stoppedAt: "2026-07-17T00:00:00.000Z",
        removedAt: "2026-07-17T00:00:00.000Z",
        runtime: null,
        jobSlug: null,
        cleanupError: null,
      }]),
      listPlanRuntimeCleanupTargetsForRepo: vi.fn(async () => []),
    });

    const status = await inspectPredeployCleanSlate({} as any, emptyHubState);

    expect(status.ok).toBe(false);
    expect(status.blockers.map((blocker) => blocker.kind)).toEqual([
      "environment_definition",
      "environment_review_record",
      "planner_run_record",
      "plan_writer_record",
    ]);
  });

  it("fails closed when indexed state cannot be read", async () => {
    mocks.listRepoIndexRepoIdsStrict.mockResolvedValue(["repo-1"]);
    mocks.loadTrackedRepo.mockResolvedValue({ ok: false });

    await expect(inspectPredeployCleanSlate({} as any, emptyHubState))
      .rejects.toThrow("unreadable indexed state");
  });

  it("rejects retained, active, and routable Hub sessions", async () => {
    const session = {
      id: "session-1",
      active: 1,
      ended_at: null,
    } as any;

    const status = await inspectPredeployCleanSlate({} as any, {
      sessions: [session],
      routableSessionIds: ["session-1", "orphan-socket"],
    });

    expect(status.ok).toBe(false);
    expect(status.blockers).toEqual([
      { kind: "hub_session_record", resourceId: "session-1" },
      { kind: "active_hub_session", resourceId: "session-1" },
      { kind: "routable_hub_session", resourceId: "session-1" },
      { kind: "routable_hub_session", resourceId: "orphan-socket" },
    ]);
  });
});
