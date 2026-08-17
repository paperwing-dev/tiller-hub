import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";

const mocks = vi.hoisted(() => ({
  appendThreadMessage: vi.fn(),
  cleanupEnvReviewRunRuntime: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getEnvReviewStub: vi.fn(),
  getThreadStub: vi.fn(),
  listPlannerProviders: vi.fn(),
  loadEnvView: vi.fn(),
  loadRepoForRequest: vi.fn(),
}));

vi.mock("../../env/view", () => ({ loadEnvView: mocks.loadEnvView }));
vi.mock("../../repo/access", () => ({ loadRepoForRequest: mocks.loadRepoForRequest }));
vi.mock("../../planner/runtime", () => ({ appendThreadMessage: mocks.appendThreadMessage }));
vi.mock("../../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getEnvReviewStub: mocks.getEnvReviewStub,
  getThreadStub: mocks.getThreadStub,
}));
vi.mock("../../planner/providers", () => ({
  listPlannerProviders: mocks.listPlannerProviders,
  findPlannerProviderModel: (providers: any[], providerId: string, modelId: string) => {
    const provider = providers.find((candidate) => candidate.id === providerId);
    const model = provider?.models.find((candidate: { id: string }) => candidate.id === modelId);
    return provider && model ? { provider, model } : null;
  },
  findPlannerProviderEffort: (provider: any, effort: string, model?: any) => (
    (model?.efforts ?? provider.efforts).find((candidate: { id: string }) => candidate.id === effort) ?? null
  ),
  getPlannerProviderModelDefaultEffort: (provider: any, model: any) => (
    model.defaultEffort ?? provider.defaultEffort
  ),
}));
vi.mock("../dispatch", () => ({
  cleanupEnvReviewRunRuntime: mocks.cleanupEnvReviewRunRuntime,
  resolveNewEnvReviewLaunchProvenance: vi.fn(async () => ({
    schemaVersion: 1,
    backend: "cf",
    machineId: null,
  })),
}));

const { default: envReviewRoutes } = await import("../routes");

const state = {
  session: {
    envSlug: "env-1",
    repoId: "repo-1",
    mainSessionId: "session-1",
    latestPreparationOpId: null,
    latestPreparation: null,
    latestChangeSummary: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  },
  tabs: [],
  runs: [],
  feedback: [],
};

const provider = (
  id: string,
  model: string,
  efforts: string[],
  defaultEffort: string,
) => ({
  id,
  displayName: id,
  available: true,
  disabledReasons: [],
  capabilities: { reviewer: true },
  models: [{ id: model, displayName: model, available: true }],
  efforts: efforts.map((effort) => ({ id: effort, displayName: effort })),
  defaultEffort,
});

const providers = [
  provider("codex", "gpt-5.5", ["low", "medium", "high", "xhigh"], "xhigh"),
  provider("claude-code", "sonnet", ["low", "medium", "high", "xhigh", "max"], "high"),
  provider("opencode", "kimi", ["low", "medium", "high"], "high"),
];

const TEST_LAUNCH_PROVENANCE = {
  schemaVersion: 1 as const,
  backend: "cf" as const,
  machineId: null,
};

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", envReviewRoutes);
  return app;
}

function createEnv() {
  return {
    HUB: {
      idFromName: () => "hub",
      get: () => ({
        getSession: vi.fn(async () => ({
          id: "session-1",
          metadata: JSON.stringify({ envSlug: "env-1", role: "lead" }),
        })),
      }),
    },
  } as any;
}

function recipeRoles(overrides: Record<string, Partial<{ provider: string; model: string; effort: string }>> = {}) {
  return [
    { roleId: "bug-reviewer", provider: "codex", model: "gpt-5.5", effort: "xhigh", ...overrides["bug-reviewer"] },
    { roleId: "simplification-reviewer", provider: "claude-code", model: "sonnet", effort: "max", ...overrides["simplification-reviewer"] },
    { roleId: "plan-compliance-reviewer", provider: "opencode", model: "kimi", effort: "high", ...overrides["plan-compliance-reviewer"] },
  ];
}

const fanoutSkill = {
  id: "code-review",
  surface: "review",
  command: "code-review",
  label: "Code Review",
  description: "Review code.",
  sharedInstructions: "Use one immutable workspace snapshot.",
  overviewInstructions: "Deduplicate findings.",
  overviewMode: "auto",
  agents: ["bugs", "simplification", "compliance"].map((id) => ({
    id,
    label: id,
    instructions: `Review ${id}.`,
    routeKey: "codex:gpt-5.5",
    effort: "high",
    reportMode: "auto",
  })),
  origin: "builtin",
  customized: true,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
};

const parentTab = {
  threadId: "parent-1",
  envSlug: "env-1",
  repoId: "repo-1",
  mainSessionId: "session-1",
  provider: "claude-code",
  model: "sonnet",
  effort: "max",
  roleLabel: "Parent Reviewer",
  taskKind: "correctness",
  customTask: null,
  status: "idle",
  latestRunId: null,
  removedAt: null,
  skillInvocationId: null,
  skillAgentId: null,
  nodeKind: "generic",
  skillRootThreadId: null,
};

const primaryTab = {
  ...parentTab,
  threadId: "primary-1",
  provider: "codex",
  model: "gpt-5.5",
  effort: "low",
  roleLabel: "Reviewer",
};

describe("env review effort routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadEnvView.mockResolvedValue({
      slug: "env-1",
      repoId: "repo-1",
      harness: "codex",
      harnessSettings: { model: "gpt-5.5", effort: "low" },
    });
    mocks.loadRepoForRequest.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          artifactStoreGeneration: "generation-1",
        },
        workspace: {},
      },
    });
    mocks.listPlannerProviders.mockResolvedValue({ providers });
    mocks.appendThreadMessage.mockResolvedValue({ id: "message-1" });
    mocks.cleanupEnvReviewRunRuntime.mockResolvedValue(null);
    mocks.getThreadStub.mockReturnValue({
      createThread: vi.fn(async () => ({})),
      listMessages: vi.fn(async () => []),
      appendMessage: vi.fn(async () => ({})),
    });
  });

  it("restores saved reviewer configurations for a new environment session", async () => {
    const inheritedTab = { ...primaryTab, threadId: "inherited-1" };
    const review = {
      inheritReviewerTabsFromLatestSession: vi.fn(async () => ({
        status: "inherited",
        tabs: [inheritedTab],
      })),
      getState: vi.fn(async () => ({ ...state, tabs: [inheritedTab] })),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const response = await createApp().request(
      "/api/envs/env-1/review?sessionId=session-1",
      undefined,
      createEnv(),
    );

    expect(response.status).toBe(200);
    expect(review.inheritReviewerTabsFromLatestSession).toHaveBeenCalledWith({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
    });
    expect(mocks.getThreadStub).toHaveBeenCalledWith(expect.anything(), "inherited-1");
    expect(await response.json()).toMatchObject({ tabs: [{ threadId: "inherited-1" }] });
  });

  it("rejects stale per-workload backend selection before creating a review run", async () => {
    const response = await createApp().request("/api/envs/env-1/review/tabs/thread-1/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        backend: "cf",
      }),
    }, createEnv());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Execution backend selection moved to Settings. Refresh or update this client.",
      code: "backend_selection_removed",
    });
    expect(mocks.loadEnvView).not.toHaveBeenCalled();
  });

  it("retires the standalone Code Review recipe endpoint", async () => {
    const review = {
      getState: vi.fn(async () => state),
      beginPreparationOperation: vi.fn(),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const response = await createApp().request("/api/envs/env-1/review/recipes/code-review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        roles: recipeRoles(),
      }),
    }, createEnv());

    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("/code-review") });
    expect(review.beginPreparationOperation).not.toHaveBeenCalled();
  });

  it("starts the first reviewer message with the implementor model", async () => {
    const review = {
      getRun: vi.fn(async () => null),
      ensurePrimaryReviewerTab: vi.fn(async (input) => ({
        status: "created",
        tab: { ...primaryTab, ...input },
      })),
      reserveTopLevelRun: vi.fn(async (input) => ({
        status: "created",
        run: { ...input, status: "preparing" },
      })),
      scheduleOrchestration: vi.fn(async () => undefined),
      cancelRun: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({ ...state, tabs: [primaryTab] })),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const response = await createApp().request("/api/envs/env-1/review/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        requestId: "message-1",
        text: "Check the implementation.",
      }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.ensurePrimaryReviewerTab).toHaveBeenCalledWith(expect.objectContaining({
      provider: "codex",
      model: "gpt-5.5",
      effort: "low",
      mainSessionId: "session-1",
    }));
    expect(review.reserveTopLevelRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "message-1",
      threadId: "primary-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "low",
      customTask: "Check the implementation.",
    }));
    expect(mocks.appendThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      "user",
      "Check the implementation.",
      [],
      { id: "env-review-message:message-1", runId: "message-1" },
    );
  });

  it("replays a parentless message without creating another reviewer", async () => {
    let run: any = null;
    const review = {
      getRun: vi.fn(async () => run),
      getTab: vi.fn(async () => primaryTab),
      ensurePrimaryReviewerTab: vi.fn(async () => ({ status: "created", tab: primaryTab })),
      reserveTopLevelRun: vi.fn(async (input) => {
        if (!run) run = { ...input, status: "preparing" };
        return { status: run.runId === input.runId ? (run === input ? "created" : "existing") : "conflict", run };
      }),
      scheduleOrchestration: vi.fn(async () => undefined),
      cancelRun: vi.fn(async () => undefined),
      getState: vi.fn(async () => ({ ...state, tabs: [primaryTab], runs: run ? [run] : [] })),
    };
    let reservationCount = 0;
    review.reserveTopLevelRun.mockImplementation(async (input) => {
      reservationCount += 1;
      if (!run) run = { ...input, status: "preparing" };
      return { status: reservationCount === 1 ? "created" : "existing", run };
    });
    mocks.getEnvReviewStub.mockReturnValue(review);
    const request = (text: string) => createApp().request("/api/envs/env-1/review/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "message-retry", text }),
    }, createEnv());

    expect((await request("Check the implementation.")).status).toBe(202);
    expect((await request("Check the implementation.")).status).toBe(200);
    expect((await request("Use this id for something else.")).status).toBe(409);

    expect(review.ensurePrimaryReviewerTab).toHaveBeenCalledTimes(1);
    expect(review.reserveTopLevelRun).toHaveBeenCalledTimes(2);
    expect(mocks.appendThreadMessage).toHaveBeenCalledTimes(2);
    expect(mocks.appendThreadMessage).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      "user",
      "Check the implementation.",
      [],
      { id: "env-review-message:message-retry", runId: "message-retry" },
    );
  });

  it("starts a Review skill without a selected reviewer using the implementor model", async () => {
    const invocation = {
      invocationId: "request-primary",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "env-review-skill-root:request-primary",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "active",
      overviewMode: "auto",
      includedMessageIds: [],
      overviewRunId: null,
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(invocation),
      getRun: vi.fn(async () => null),
      reserveSkillInvocation: vi.fn(async () => ({
        status: "created",
        invocation,
        tabs: [],
        runs: [],
      })),
      listSkillInvocationTabs: vi.fn(async () => []),
      listSkillInvocationRuns: vi.fn(async () => []),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getArtifactStoreStub.mockReturnValue({ listStoredAgentSkills: vi.fn(async () => [fanoutSkill]) });

    const response = await createApp().request("/api/envs/env-1/review/skills/code-review/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "request-primary" }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.reserveSkillInvocation).toHaveBeenCalledWith(expect.objectContaining({
      parentThreadId: "env-review-skill-root:request-primary",
      overviewRoute: {
        provider: "codex",
        model: "gpt-5.5",
        effort: "low",
      },
    }));
  });

  it("re-reviews with the same child conversations and a fresh preparation", async () => {
    const completedInvocation = {
      invocationId: "invocation-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "parent-1",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "completed",
      overviewMode: "auto",
      includedMessageIds: ["old-message"],
      overviewRunId: "overview-1",
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:01:00.000Z",
    };
    const tabs = fanoutSkill.agents.map((agent, index) => ({
      ...primaryTab,
      threadId: `existing-child-${index + 1}`,
      effort: "high",
      roleLabel: agent.label,
      skillInvocationId: completedInvocation.invocationId,
      skillAgentId: agent.id,
    }));
    let currentInvocation: any = completedInvocation;
    let rerunRuns: any[] = [];
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => currentInvocation),
      listSkillInvocationTabs: vi.fn(async () => tabs),
      getRun: vi.fn(async () => null),
      restartSkillInvocation: vi.fn(async (input) => {
        currentInvocation = {
          ...completedInvocation,
          invocationId: input.requestId,
          preparationOpId: "rerun-request-1",
          status: "setting_up",
          includedMessageIds: [],
          overviewRunId: null,
        };
        rerunRuns = tabs.map((tab, index) => ({
          runId: `env-review-skill-rerun:${input.requestId}:${fanoutSkill.agents[index]!.id}`,
          threadId: tab.threadId,
          envSlug: "env-1",
          repoId: "repo-1",
          mainSessionId: "session-1",
          provider: tab.provider,
          model: tab.model,
          effort: tab.effort,
          roleLabel: tab.roleLabel,
          taskKind: "custom",
          customTask: fanoutSkill.agents[index]!.instructions,
          status: "preparing",
          preparationOpId: "rerun-request-1",
          skillInvocationId: input.requestId,
          skillAgentId: fanoutSkill.agents[index]!.id,
          skillRunRole: "report_initial",
        }));
        return { status: "created", invocation: currentInvocation, tabs, runs: rerunRuns };
      }),
      activateSkillInvocation: vi.fn(async () => {
        currentInvocation = { ...currentInvocation, status: "active" };
        return currentInvocation;
      }),
      scheduleOrchestration: vi.fn(async () => undefined),
      listSkillInvocationRuns: vi.fn(async () => rerunRuns),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const response = await createApp().request("/api/envs/env-1/review/skill-invocations/invocation-1/rerun", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        requestId: "rerun-request-1",
        expectedRoundId: "invocation-1",
      }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      kind: "skill_root",
      invocation: {
        invocationId: "rerun-request-1",
        preparationOpId: "rerun-request-1",
        status: "active",
        includedMessageIds: [],
        overviewRunId: null,
      },
      tabs: tabs.map((tab) => expect.objectContaining({ threadId: tab.threadId })),
    });
    expect(review.restartSkillInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "invocation-1",
      requestId: "rerun-request-1",
      agents: fanoutSkill.agents.map((agent) => expect.objectContaining({
        id: agent.id,
        launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
      })),
    }));
    expect(mocks.appendThreadMessage).toHaveBeenCalledTimes(fanoutSkill.agents.length);
    expect(mocks.appendThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      "user",
      expect.stringContaining("Use the existing conversation and your earlier findings as context."),
      [],
      expect.objectContaining({
        id: "env-review-skill-rerun-message:rerun-request-1:bugs",
        runId: "env-review-skill-rerun:rerun-request-1:bugs",
      }),
    );
  });

  it("stops an active round, cleans up only its reviewer runtimes, and removes its records", async () => {
    const invocation = {
      invocationId: "invocation-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "parent-1",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "active",
      overviewMode: "auto",
      includedMessageIds: [],
      overviewRunId: null,
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:01:00.000Z",
    };
    const stoppedRun = {
      runId: "child-run-1",
      threadId: "child-1",
      status: "cancelled",
      runtime: { jobSlug: "env-review-child-run-1" },
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    };
    const review = {
      getSkillInvocation: vi.fn(async () => invocation),
      cancelSkillInvocation: vi.fn(async () => ({
        ...invocation,
        status: "cancelled",
        cancelledAt: "2026-07-09T00:02:00.000Z",
      })),
      listSkillInvocationRuns: vi.fn(async () => [stoppedRun]),
      removeSkillInvocation: vi.fn(async () => ({
        status: "removed",
        parentThreadId: "parent-1",
        childThreadIds: ["child-1"],
      })),
      getState: vi.fn(async () => ({ ...state, tabs: [parentTab] })),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const response = await createApp().request(
      "/api/envs/env-1/review/skill-invocations/invocation-1?sessionId=session-1",
      { method: "DELETE" },
      createEnv(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      parentThreadId: "parent-1",
      removedChildThreadIds: ["child-1"],
      state: { tabs: [expect.objectContaining({ threadId: "parent-1" })] },
    });
    expect(review.cancelSkillInvocation).toHaveBeenCalledWith("invocation-1");
    expect(mocks.cleanupEnvReviewRunRuntime).toHaveBeenCalledWith(
      expect.anything(),
      review,
      stoppedRun,
    );
    expect(review.removeSkillInvocation).toHaveBeenCalledWith({
      invocationId: "invocation-1",
      envSlug: "env-1",
      mainSessionId: "session-1",
    });
    expect(review.cancelSkillInvocation.mock.invocationCallOrder[0])
      .toBeLessThan(review.removeSkillInvocation.mock.invocationCallOrder[0]!);
  });

  it("keeps a stopped round when reviewer runtime cleanup fails", async () => {
    const invocation = {
      invocationId: "invocation-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "parent-1",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "active",
    };
    const review = {
      getSkillInvocation: vi.fn(async () => invocation),
      cancelSkillInvocation: vi.fn(async () => ({ ...invocation, status: "cancelled" })),
      listSkillInvocationRuns: vi.fn(async () => [{
        runId: "child-run-1",
        runtime: { jobSlug: "env-review-child-run-1" },
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      }]),
      removeSkillInvocation: vi.fn(),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.cleanupEnvReviewRunRuntime.mockRejectedValue(new Error("runtime destroy failed"));

    const response = await createApp().request(
      "/api/envs/env-1/review/skill-invocations/invocation-1?sessionId=session-1",
      { method: "DELETE" },
      createEnv(),
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "review_round_cleanup_failed",
      error: expect.stringContaining("Retry Remove"),
    });
    expect(review.cancelSkillInvocation).toHaveBeenCalledWith("invocation-1");
    expect(review.removeSkillInvocation).not.toHaveBeenCalled();
  });

  it("reserves a reusable skill root using the saved Report efforts", async () => {
    const invocation = {
      invocationId: "request-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "env-review-skill-root:request-1",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "active",
      overviewMode: "manual",
      includedMessageIds: [],
      overviewRunId: null,
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => null),
      getRun: vi.fn(async () => null),
      reserveSkillInvocation: vi.fn(async () => ({ status: "created", invocation, tabs: [], runs: [] })),
      listSkillInvocationTabs: vi.fn(async () => []),
      listSkillInvocationRuns: vi.fn(async () => []),
    };
    review.getSkillInvocation.mockResolvedValueOnce(null).mockResolvedValue(invocation);
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getArtifactStoreStub.mockReturnValue({ listStoredAgentSkills: vi.fn(async () => [fanoutSkill]) });

    const response = await createApp().request("/api/envs/env-1/review/skills/code-review/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "request-1", overviewMode: "manual" }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.reserveSkillInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "request-1",
      parentThreadId: "env-review-skill-root:request-1",
      overviewMode: "manual",
      overviewRoute: {
        provider: "codex",
        model: "gpt-5.5",
        effort: "low",
      },
      agents: fanoutSkill.agents.map((agent) => expect.objectContaining({
        id: agent.id,
        effort: "high",
        launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
      })),
    }));
  });

  it("creates a one-agent Review as a standalone skill root", async () => {
    const preset = {
      ...fanoutSkill,
      id: "focused",
      command: "focused",
      origin: "custom",
      sharedInstructions: "Use the saved focused-review instructions.",
      agents: [{
        ...fanoutSkill.agents[0],
        label: "Focused Reviewer",
        instructions: "Inspect the focused risk.",
        routeKey: "codex:gpt-5.5",
      }],
    };
    const rootThreadId = "env-review-skill-root:preset-1";
    const invocation = {
      invocationId: "preset-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: rootThreadId,
      definitionSnapshot: preset,
      preparationOpId: "op-1",
      status: "active",
      overviewMode: "auto",
      includedMessageIds: [],
      overviewRunId: null,
    };
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(invocation),
      reserveSkillInvocation: vi.fn(async () => ({
        status: "created",
        invocation,
        tabs: [],
        runs: [],
      })),
      listSkillInvocationTabs: vi.fn(async () => []),
      listSkillInvocationRuns: vi.fn(async () => []),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getArtifactStoreStub.mockReturnValue({ listStoredAgentSkills: vi.fn(async () => [preset]) });
    const response = await createApp().request("/api/envs/env-1/review/skills/focused/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "preset-1" }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.reserveSkillInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "preset-1",
      parentThreadId: rootThreadId,
      overviewRoute: null,
      agents: [expect.objectContaining({
        id: "bugs",
        provider: "codex",
        model: "gpt-5.5",
        effort: "high",
      })],
    }));
    expect(await response.json()).toMatchObject({ kind: "skill_root" });
  });

  it("replays idempotent setup for a reserved Review fanout", async () => {
    let invocation = {
      invocationId: "setup-retry-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "env-review-skill-root:setup-retry-1",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "setting_up",
      overviewMode: "auto",
      includedMessageIds: [],
      overviewRunId: null,
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };
    const tabs = fanoutSkill.agents.map((agent) => ({
      ...parentTab,
      threadId: `child-${agent.id}`,
      skillInvocationId: invocation.invocationId,
      skillAgentId: agent.id,
      nodeKind: "report",
      skillRootThreadId: invocation.parentThreadId,
    }));
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => invocation),
      getTab: vi.fn(async (threadId: string) => threadId === invocation.parentThreadId
        ? { ...parentTab, threadId, nodeKind: "skill_root", skillRootThreadId: threadId }
        : null),
      listSkillInvocationTabs: vi.fn(async () => tabs),
      listSkillInvocationRuns: vi.fn(async () => fanoutSkill.agents.map((agent) => ({
        runId: `setup-retry-1:${agent.id}`,
        skillAgentId: agent.id,
        skillRunRole: "report_initial",
        status: "preparing",
      }))),
      activateSkillInvocation: vi.fn(async () => {
        invocation = { ...invocation, status: "active" };
        return invocation;
      }),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    const appendMessage = vi.fn(async () => ({}));
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getThreadStub.mockReturnValue({
      createThread: vi.fn(async () => ({})),
      appendMessage,
    });

    const response = await createApp().request("/api/envs/env-1/review/skills/code-review/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "setup-retry-1", overviewMode: "auto" }),
    }, createEnv());

    expect(response.status).toBe(200);
    expect((await response.json() as any).invocation.status).toBe("active");
    expect(review.activateSkillInvocation).toHaveBeenCalledWith("setup-retry-1");
    expect(appendMessage).toHaveBeenCalledTimes(3);
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: "skill-setup:setup-retry-1:bugs",
    }));
  });

  it("replays an active fanout after controls change and reschedules unfinished children", async () => {
    const invocation = {
      invocationId: "active-retry-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "env-review-skill-root:active-retry-1",
      definitionSnapshot: fanoutSkill,
      preparationOpId: "op-1",
      status: "active",
      overviewMode: "manual",
      includedMessageIds: [],
      overviewRunId: null,
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    };
    const runs = [{
      runId: "child-run-1",
      skillRunRole: "report_initial",
      status: "queued",
    }];
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => invocation),
      listSkillInvocationTabs: vi.fn(async () => []),
      listSkillInvocationRuns: vi.fn(async () => runs),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);

    const response = await createApp().request("/api/envs/env-1/review/skills/code-review/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "active-retry-1", overviewMode: "auto" }),
    }, createEnv());

    expect(response.status).toBe(200);
    expect(review.scheduleOrchestration).toHaveBeenCalled();
  });

  it("inherits the tab effort for reviewer follow-up runs", async () => {
    const tab = {
      threadId: "thread-1",
      envSlug: "env-1",
      mainSessionId: "session-1",
      removedAt: null,
      status: "ready",
      provider: "claude-code",
      model: "sonnet",
      effort: "max",
      roleLabel: "Bug Reviewer",
      nodeKind: "generic",
    };
    const review = {
      getTab: vi.fn(async () => tab),
      getActiveSkillInvocationForParent: vi.fn(async () => null),
      reserveTopLevelRun: vi.fn(async (input) => ({ status: "created", run: { ...input, status: "preparing" } })),
      scheduleOrchestration: vi.fn(async () => undefined),
      getState: vi.fn(async () => state),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getThreadStub.mockReturnValue({
      createThread: vi.fn(async () => ({})),
      listMessages: vi.fn(async () => []),
    });

    const response = await createApp().request("/api/envs/env-1/review/tabs/thread-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", text: "Check the latest change." }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.reserveTopLevelRun).toHaveBeenCalledWith(expect.objectContaining({
      provider: "claude-code",
      model: "sonnet",
      effort: "max",
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    }));
  });

  it("passes a child follow-up as the active instruction outside filtered history", async () => {
    const text = "Re-check the retry path I just changed.";
    const skill = {
      ...fanoutSkill,
      agents: [{ ...fanoutSkill.agents[0], id: "bugs", instructions: "Find correctness bugs." }],
    };
    const tab = {
      ...parentTab,
      threadId: "child-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Bug Reviewer",
      status: "ready",
      skillInvocationId: "invocation-1",
      skillAgentId: "bugs",
      nodeKind: "report",
      skillRootThreadId: "skill-root-1",
    };
    const invocation = {
      invocationId: "invocation-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      definitionSnapshot: skill,
      preparationOpId: "op-1",
    };
    const initial = {
      runId: "initial-1",
      skillRunRole: "report_initial",
      skillAgentId: "bugs",
      preparationOpId: "op-1",
      preparation: { completedAt: "2026-08-13T00:00:00.000Z" },
      changeContext: {
        summary: { total: 0, added: 0, modified: 0, deleted: 0, omitted: 0, truncated: 0, files: [] },
        files: [],
        limits: { maxFiles: 25, maxDiffBytesPerFile: 20_000, maxTotalDiffBytes: 60_000, maxFileBytesForDiff: 200_000 },
      },
      planBasis: null,
    };
    const updateRun = vi.fn(async (input) => ({ ...input }));
    const createRun = vi.fn(async (input) => ({ ...input, status: "preparing" }));
    const review = {
      getTab: vi.fn(async () => tab),
      getLatestSkillInvocationForRoot: vi.fn(async () => invocation),
      listSkillInvocationRuns: vi.fn(async () => [initial]),
      createRun,
      createSkillFollowupIfNoActive: vi.fn(async (input) => ({
        ok: true,
        run: await createRun(input),
      })),
      updateRun,
      appendRunEvent: vi.fn(async () => undefined),
      scheduleOrchestration: vi.fn(async () => undefined),
      cancelRun: vi.fn(async () => undefined),
      getState: vi.fn(async () => state),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getThreadStub.mockReturnValue({
      createThread: vi.fn(async () => ({})),
      listMessages: vi.fn(async () => []),
    });

    const response = await createApp().request("/api/envs/env-1/review/tabs/child-1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: "session-1",
        text,
        expectedRoundId: "invocation-1",
      }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.createSkillFollowupIfNoActive).toHaveBeenCalledWith(
      expect.objectContaining({ customTask: text }),
    );
    expect(mocks.appendThreadMessage).toHaveBeenCalledWith(
      expect.anything(),
      "user",
      text,
      [],
      expect.objectContaining({ runId: expect.any(String) }),
    );
    expect(updateRun).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining(`Current instruction:\n${text}`),
    }));
  });
});
