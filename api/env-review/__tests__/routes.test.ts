import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";

const mocks = vi.hoisted(() => ({
  appendThreadMessage: vi.fn(),
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
  getLocationHintOptions: vi.fn(() => undefined),
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
  cleanupEnvReviewRunRuntime: vi.fn(),
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
};

describe("env review effort routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.loadEnvView.mockResolvedValue({ slug: "env-1", repoId: "repo-1" });
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

  it("reserves a fanout on the selected idle parent using the saved child efforts", async () => {
    const invocation = {
      invocationId: "request-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "parent-1",
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
      getTab: vi.fn(async () => parentTab),
      getActiveSkillInvocationForParent: vi.fn(async () => null),
      reserveSkillInvocation: vi.fn(async () => ({ status: "created", invocation, tabs: [], runs: [] })),
      listSkillInvocationTabs: vi.fn(async () => []),
      listSkillInvocationRuns: vi.fn(async () => []),
    };
    review.getSkillInvocation.mockResolvedValueOnce(null).mockResolvedValue(invocation);
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getArtifactStoreStub.mockReturnValue({ listStoredAgentSkills: vi.fn(async () => [fanoutSkill]) });

    const response = await createApp().request("/api/envs/env-1/review/tabs/parent-1/skills/code-review/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "request-1", overviewMode: "manual" }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.reserveSkillInvocation).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: "request-1",
      parentThreadId: "parent-1",
      overviewMode: "manual",
      agents: fanoutSkill.agents.map((agent) => expect.objectContaining({
        id: agent.id,
        effort: "high",
        launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
      })),
    }));
  });

  it("runs a one-agent preset as a normal turn on the selected reviewer", async () => {
    const preset = {
      ...fanoutSkill,
      id: "focused",
      command: "focused",
      origin: "custom",
      agents: [{
        ...fanoutSkill.agents[0],
        // Hidden fanout routing is preserved but does not govern a preset,
        // which executes on the selected parent reviewer.
        routeKey: "claude-code:claude-fable-5",
      }],
    };
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => null),
      getRun: vi.fn(async () => null),
      getTab: vi.fn(async () => parentTab),
      getActiveSkillInvocationForParent: vi.fn(async () => null),
      reserveTopLevelRun: vi.fn(async (input) => ({ status: "created", run: { ...input, status: "preparing" } })),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getArtifactStoreStub.mockReturnValue({ listStoredAgentSkills: vi.fn(async () => [preset]) });
    mocks.getThreadStub.mockReturnValue({
      createThread: vi.fn(async () => ({})),
      listMessages: vi.fn(async () => []),
      appendMessage: vi.fn(async () => ({})),
    });

    const response = await createApp().request("/api/envs/env-1/review/tabs/parent-1/skills/focused/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "preset-1" }),
    }, createEnv());

    expect(response.status).toBe(202);
    expect(review.reserveTopLevelRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: "preset-1",
      threadId: "parent-1",
      provider: "claude-code",
      model: "sonnet",
      effort: "max",
      skillDefinitionSnapshot: preset,
    }));
    expect(review).not.toHaveProperty("reserveSkillInvocation");
  });

  it("replays incomplete setup for an existing Review preset run", async () => {
    const existingRun = {
      runId: "preset-retry",
      threadId: "parent-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      roleLabel: "Reviewer",
      taskKind: "custom",
      status: "preparing",
      skillDefinitionSnapshot: { ...fanoutSkill, id: "focused", command: "focused", agents: [fanoutSkill.agents[0]] },
    };
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => null),
      getRun: vi.fn(async () => existingRun),
      scheduleOrchestration: vi.fn(async () => undefined),
    };
    const appendMessage = vi.fn(async () => ({}));
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getThreadStub.mockReturnValue({
      createThread: vi.fn(async () => ({})),
      listMessages: vi.fn(async () => []),
      appendMessage,
    });

    const response = await createApp().request("/api/envs/env-1/review/tabs/parent-1/skills/focused/invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: "session-1", requestId: "preset-retry" }),
    }, createEnv());

    expect(response.status).toBe(200);
    expect(appendMessage).toHaveBeenCalledWith(expect.objectContaining({
      id: "skill-preset:preset-retry",
      body: expect.objectContaining({ runId: "preset-retry" }),
    }));
    expect(review.scheduleOrchestration).toHaveBeenCalled();
  });

  it("replays idempotent setup for a reserved Review fanout", async () => {
    let invocation = {
      invocationId: "setup-retry-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "parent-1",
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
    }));
    const review = {
      failStaleSkillInvocations: vi.fn(async () => []),
      getSkillInvocation: vi.fn(async () => invocation),
      listSkillInvocationTabs: vi.fn(async () => tabs),
      listSkillInvocationRuns: vi.fn(async () => []),
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

    const response = await createApp().request("/api/envs/env-1/review/tabs/parent-1/skills/code-review/invoke", {
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
      parentThreadId: "parent-1",
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
      skillRunRole: "child_initial",
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

    const response = await createApp().request("/api/envs/env-1/review/tabs/parent-1/skills/code-review/invoke", {
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
    };
    const review = {
      getTab: vi.fn(async () => tab),
      getActiveSkillInvocationForParent: vi.fn(async () => null),
      reserveTopLevelRun: vi.fn(async (input) => ({ status: "created", run: { ...input, status: "preparing" } })),
      scheduleOrchestration: vi.fn(async () => undefined),
      getState: vi.fn(async () => state),
    };
    mocks.getEnvReviewStub.mockReturnValue(review);
    mocks.getThreadStub.mockReturnValue({ listMessages: vi.fn(async () => []) });

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
});
