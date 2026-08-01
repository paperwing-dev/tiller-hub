import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadEnvView: vi.fn(),
  loadRepo: vi.fn(),
  buildEnvReviewChangeContext: vi.fn(),
  buildEnvReviewPrompt: vi.fn(),
  readEnvReviewPlanBasis: vi.fn(),
  resolveEnvReviewDispatchTarget: vi.fn(),
  dispatchEnvReviewRun: vi.fn(),
  destroyEnvReviewRuntimeJob: vi.fn(),
}));

vi.mock("../../env/view", () => ({ loadEnvView: mocks.loadEnvView }));
vi.mock("../../repo/access", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../repo/access")>()),
  loadRepo: mocks.loadRepo,
}));
vi.mock("../context", () => ({
  buildEnvReviewChangeContext: mocks.buildEnvReviewChangeContext,
  buildEnvReviewPrompt: mocks.buildEnvReviewPrompt,
  readEnvReviewPlanBasis: mocks.readEnvReviewPlanBasis,
}));
vi.mock("../dispatch", () => ({
  resolveEnvReviewDispatchTarget: mocks.resolveEnvReviewDispatchTarget,
  resolveNewEnvReviewLaunchProvenance: vi.fn(),
  dispatchEnvReviewRun: mocks.dispatchEnvReviewRun,
  destroyEnvReviewRuntimeJob: mocks.destroyEnvReviewRuntimeJob,
}));
vi.mock("../../helpers", () => ({
  getThreadStub: vi.fn(() => ({ listMessages: vi.fn(async () => []) })),
  getWorkspaceStub: vi.fn(),
}));
vi.mock("../snapshots", () => ({
  ENV_REVIEW_SNAPSHOT_EXCLUDE_PREFIXES: [],
  ENV_REVIEW_SNAPSHOT_FORMAT_VERSION: 1,
  ENV_REVIEW_SNAPSHOT_MAX_BYTES: 1_000_000,
  buildReviewSnapshotTarFromWorkspace: vi.fn(),
  normalizeReviewSnapshotDeletedPaths: vi.fn((paths) => paths),
  r2ObjectToBytes: vi.fn(async () => new Uint8Array()),
  storeAndCompleteReviewSnapshot: vi.fn(),
  validateReviewSnapshotTar: vi.fn(),
  TarBackedEnvReviewWorkspaceSource: class {
    async getHashedManifest() {
      return [];
    }
  },
}));

const { processEnvReviewOrchestration } = await import("../orchestrator");

describe("environment-review dispatch orchestration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEnvView.mockResolvedValue({
      slug: "env-1",
      repoId: "repo-1",
      startupPlanId: null,
    });
    mocks.loadRepo.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          githubFullName: "test/repo",
        },
      },
    });
    mocks.buildEnvReviewChangeContext.mockResolvedValue({ summary: { total: 1 } });
    mocks.readEnvReviewPlanBasis.mockResolvedValue(null);
    mocks.resolveEnvReviewDispatchTarget.mockResolvedValue({
      backend: "host",
      machineId: "machine-1",
      jobSlug: "env-review-run-1",
      codexAuthPreference: "subscription",
    });
    mocks.dispatchEnvReviewRun.mockResolvedValue({
      backend: "host",
      machineId: "machine-1",
      jobSlug: "env-review-run-1",
    });
  });

  it("persists the exact runtime target before starting the physical runtime", async () => {
    const planBasis = {
      source: "startup-plan" as const,
      artifactId: "plan-1",
      version: 7,
      title: "Pinned plan",
      markdown: "# Pinned plan",
    };
    mocks.readEnvReviewPlanBasis.mockResolvedValue(planBasis);
    mocks.buildEnvReviewPrompt.mockReturnValue("Frozen review prompt");
    const run = {
      runId: "run-1",
      threadId: "thread-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Correctness Reviewer",
      taskKind: "correctness",
      customTask: null,
      recipeInstructions: null,
      status: "preparing",
      prompt: null,
      preparation: null,
      changeContext: null,
      // Parsed database rows use null before initial context is attached. The
      // orchestrator must still pin the startup Plan it reads for this run.
      planBasis: null,
      runtime: null,
      launchProvenance: {
        schemaVersion: 1,
        backend: "host",
        machineId: "machine-1",
      },
      skillRunRole: "child_initial",
    };
    const preparation = {
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
      status: "succeeded",
      requestUrl: "https://hub.example.com/api/envs/env-1/review",
      result: {
        opId: "op-1",
        status: "succeeded",
        completedAt: "2026-01-01T00:00:00.000Z",
        snapshot: {
          r2Key: "review-snapshots/env-1/op-1.tar",
          baseCommitSha: "base-1",
          githubDeletedPaths: [],
        },
      },
    };
    const updateRun = vi.fn(async (input) => ({ ...run, ...input }));
    const review = {
      listActivePreparationOperations: vi.fn(async () => []),
      listDispatchablePreparationOperations: vi.fn(async () => [preparation]),
      recordChangeSummary: vi.fn(async () => undefined),
      updatePreparationResult: vi.fn(async () => undefined),
      listRunsForPreparationOperation: vi.fn(async () => [run]),
      updateRun,
      appendRunEvent: vi.fn(async () => undefined),
      getRun: vi.fn(async () => ({ ...run, runtime: {
        jobSlug: "env-review-run-1",
      } })),
      scheduleOrchestration: vi.fn(async () => undefined),
    };

    await processEnvReviewOrchestration(review as any, {
      BUCKET: { get: vi.fn(async () => ({})) },
    } as any);

    expect(updateRun).toHaveBeenCalledWith({
      runId: "run-1",
      runtime: {
        jobSlug: "env-review-run-1",
      },
    });
    expect(mocks.buildEnvReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({ planBasis }));
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-1",
      status: "queued",
      planBasis,
      prompt: "Frozen review prompt",
    }));
    expect(updateRun.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.dispatchEnvReviewRun.mock.invocationCallOrder[0],
    );
    expect(mocks.dispatchEnvReviewRun).toHaveBeenCalledWith(expect.objectContaining({
      target: expect.objectContaining({
        jobSlug: "env-review-run-1",
      }),
    }));
  });

  it("copies a pinned initial-child basis to unfinished siblings without rereading the Plan", async () => {
    const pinnedPreparation = {
      opId: "shared-op",
      status: "succeeded",
      completedAt: "2026-01-01T00:00:00.000Z",
      snapshot: { r2Key: "snapshot.tar", baseCommitSha: "base-1", githubDeletedPaths: [] },
    };
    const pinnedChangeContext = { summary: { total: 1, files: [] }, files: [], generatedAt: "old" };
    const pinnedPlanBasis = {
      source: "startup-plan" as const,
      artifactId: "plan-1",
      version: 3,
      title: "Original plan",
      markdown: "# Original plan",
    };
    const pinnedRun = {
      runId: "pinned-child",
      threadId: "thread-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Pinned",
      taskKind: "custom",
      status: "queued",
      prompt: "Already pinned",
      preparation: pinnedPreparation,
      changeContext: pinnedChangeContext,
      planBasis: pinnedPlanBasis,
      runtime: { jobSlug: "already-running" },
      skillInvocationId: "invocation-1",
      skillRunRole: "child_initial",
    };
    const unfinishedRun = {
      ...pinnedRun,
      runId: "unfinished-child",
      threadId: "thread-2",
      roleLabel: "Unfinished",
      status: "preparing",
      prompt: null,
      preparation: null,
      changeContext: null,
      planBasis: null,
      runtime: null,
    };
    const operation = {
      opId: "shared-op",
      envSlug: "env-1",
      sessionId: "session-1",
      status: "succeeded",
      result: pinnedPreparation,
    };
    mocks.buildEnvReviewPrompt.mockReturnValue("Sibling prompt on original basis");
    const updateRun = vi.fn(async (input) => ({ ...unfinishedRun, ...input }));
    const review = {
      listActivePreparationOperations: vi.fn(async () => []),
      listDispatchablePreparationOperations: vi.fn(async () => [operation]),
      listRunsForPreparationOperation: vi.fn(async () => [pinnedRun, unfinishedRun]),
      recordChangeSummary: vi.fn(async () => undefined),
      updatePreparationResult: vi.fn(async () => undefined),
      updateRun,
      appendRunEvent: vi.fn(async () => undefined),
      getRun: vi.fn(async () => ({
        ...unfinishedRun,
        status: "queued",
        prompt: "Sibling prompt on original basis",
        preparation: pinnedPreparation,
        changeContext: pinnedChangeContext,
        planBasis: pinnedPlanBasis,
        runtime: { jobSlug: "env-review-run-1" },
      })),
      scheduleOrchestration: vi.fn(async () => undefined),
    };

    await processEnvReviewOrchestration(review as any, { BUCKET: { get: vi.fn() } } as any);

    expect(mocks.readEnvReviewPlanBasis).not.toHaveBeenCalled();
    expect(mocks.buildEnvReviewChangeContext).not.toHaveBeenCalled();
    expect(mocks.buildEnvReviewPrompt).toHaveBeenCalledWith(expect.objectContaining({
      preparation: pinnedPreparation,
      changeContext: pinnedChangeContext,
      planBasis: pinnedPlanBasis,
    }));
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "unfinished-child",
      preparation: pinnedPreparation,
      changeContext: pinnedChangeContext,
      planBasis: pinnedPlanBasis,
    }));
  });
});
