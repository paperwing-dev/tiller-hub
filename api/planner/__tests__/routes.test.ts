import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";
import {
  ArtifactStoreDO,
  ThreadDO,
  asAsyncStub,
  createExecutionCtx,
  createStore,
  createThread,
} from "./test-harness";

const mocks = vi.hoisted(() => ({
  loadRepoForRequest: vi.fn(),
  loadTrackedRepoForRequest: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getThreadStub: vi.fn(),
  getOpenAIStatus: vi.fn(),
  getSecret: vi.fn(),
  getOrCreateSecret: vi.fn(),
  getIdleTimeoutMinutes: vi.fn(),
  getBillingSelections: vi.fn(),
  getPlannerRunStub: vi.fn(),
  startPlannerJob: vi.fn(),
  ensurePlanWriterRuntime: vi.fn(),
  inspectPlanWriterRuntime: vi.fn(),
  destroyPlanWriterRuntime: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../../repo/access", () => ({
  loadRepoForRequest: mocks.loadRepoForRequest,
  loadTrackedRepoForRequest: mocks.loadTrackedRepoForRequest,
}));

vi.mock("../../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getThreadStub: mocks.getThreadStub,
  getPlannerRunStub: mocks.getPlannerRunStub,
}));

vi.mock("../../openai-auth", () => ({
  getStatus: mocks.getOpenAIStatus,
  getReadOnlyStatus: mocks.getOpenAIStatus,
}));

vi.mock("../../setup/config", () => ({
  getSecret: mocks.getSecret,
  getOrCreateSecret: mocks.getOrCreateSecret,
  getIdleTimeoutMinutes: mocks.getIdleTimeoutMinutes,
  getBillingSelections: mocks.getBillingSelections,
}));

const { default: plannerRoutes } = await import("../routes");

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", plannerRoutes);
  return app;
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const { HUB: overrideHubValue, ...rest } = overrides;
  const overrideHub = overrideHubValue as {
    idFromName?: (...args: unknown[]) => unknown;
    get?: (...args: unknown[]) => Record<string, unknown>;
  } | undefined;
  return {
    TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "1",
    ENVS_KV: {
      get: vi.fn(async () => null),
      put: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
    },
    HUB: {
      idFromName: overrideHub?.idFromName ?? (() => "hub-id"),
      get: (...args: unknown[]) => ({
        ...(overrideHub?.get?.(...args) ?? {}),
        resolveNewExecutionPlacement: vi.fn().mockResolvedValue({
          backend: "cf",
          machineId: null,
        }),
        getExecutionStatus: vi.fn().mockResolvedValue({
          selected: { target: "cf" },
          selectedHost: null,
          candidate: { state: "not_connected" },
          executionReady: true,
        }),
      }),
    },
    ...rest,
  };
}

const CURRENT_CF_LAUNCH = {
  schemaVersion: 1 as const,
  backend: "cf" as const,
  machineId: null,
};

describe("planner routes", () => {
  let artifactStore: InstanceType<typeof ArtifactStoreDO>;
  let threads: Map<string, InstanceType<typeof ThreadDO>>;

  beforeEach(() => {
    artifactStore = createStore();
    threads = new Map();
    vi.resetAllMocks();
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: false });
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) => key === "OPENAI_API_KEY" ? "test-key" : undefined);
    mocks.getOrCreateSecret.mockResolvedValue("test-runtime-secret");
    mocks.getIdleTimeoutMinutes.mockResolvedValue(15);
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: "api",
      openaiBillingMode: "api",
    });
    mocks.startPlannerJob.mockResolvedValue(undefined);
    mocks.ensurePlanWriterRuntime.mockResolvedValue({ created: true });
    mocks.inspectPlanWriterRuntime.mockImplementation(async (jobSlug: string) => ({
      registered: true,
      live: true,
      jobSlug,
    }));
    mocks.destroyPlanWriterRuntime.mockResolvedValue(undefined);
    mocks.getPlannerRunStub.mockReturnValue({
      startPlannerJob: mocks.startPlannerJob,
      ensurePlanWriterRuntime: mocks.ensurePlanWriterRuntime,
      inspectPlanWriterRuntime: mocks.inspectPlanWriterRuntime,
      destroyPlanWriterRuntime: mocks.destroyPlanWriterRuntime,
    });
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getThreadStub.mockImplementation((_env: unknown, threadId: string) => {
      let thread = threads.get(threadId);
      if (!thread) {
        thread = createThread();
        threads.set(threadId, thread);
      }
      return asAsyncStub(thread);
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
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          mainCommit: "main-1",
          gitStatus: "ready",
        },
        workspace: {},
      },
    });
  });

  it.each([
    "/api/repos/repo-1/plans/plan-1/live-writer/start",
    "/api/repos/repo-1/plans/plan-1/reviewers",
    "/api/repos/repo-1/plans/plan-1/reviewers/thread-1/messages",
    "/api/repos/repo-1/plans/plan-1/skills/code-review/invoke",
  ])("rejects stale per-workload backend selection on %s", async (path) => {
    const response = await createTestApp().request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend: "host" }),
    }, createEnv() as any);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Execution backend selection moved to Settings. Refresh or update this client.",
      code: "backend_selection_removed",
    });
    expect(mocks.loadTrackedRepoForRequest).not.toHaveBeenCalled();
  });

  it("hides the fake provider unless the dev flag enables it", async () => {
    const app = createTestApp();
    const production = await app.request("/api/repos/repo-1/planner-providers", {}, createEnv({
      TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "0",
      LOCAL_DEV_ONLY_BACKEND: "false",
    }) as any);
    const productionBody = await production.json() as {
      providers: Array<{ id: string; available: boolean; disabledReasons: string[]; capabilities: { writer: boolean } }>;
    };
    expect(productionBody.providers.map((provider) => provider.id)).not.toContain("fake");
    // CLI providers are listed in production, but only available when a
    // runtime backend is reachable and auth fits that backend.
    const productionOpenCode = productionBody.providers.find((provider) => provider.id === "opencode");
    expect(productionOpenCode).toBeTruthy();
    expect(productionOpenCode!.available).toBe(false);
    expect(productionOpenCode!.capabilities.writer).toBe(false);
    const productionClaude = productionBody.providers.find((provider) => provider.id === "claude-code");
    expect(productionClaude).toBeTruthy();
    expect(productionClaude!.available).toBe(false);
    expect(productionClaude!.disabledReasons[0]).toMatch(/execution backend|Cloudflare/i);

    const dev = await app.request("/api/repos/repo-1/planner-providers", {}, createEnv() as any);
    const devBody = await dev.json() as { providers: Array<{ id: string; capabilities: { writer: boolean } }>; reviewerSkills?: unknown };
    expect(devBody.providers.map((provider) => provider.id)).toContain("fake");
    expect(devBody.providers.find((provider) => provider.id === "fake")?.capabilities.writer).toBe(false);
    expect(devBody.reviewerSkills).toBeUndefined();
    expect((devBody as { executions?: unknown }).executions).toBeUndefined();
    expect(mocks.loadTrackedRepoForRequest).toHaveBeenCalled();
    expect(mocks.loadRepoForRequest).not.toHaveBeenCalled();
  });

  it("manages canonical Plan skills and built-in overrides", async () => {
    const app = createTestApp();

    const initial = await app.request("/api/repos/repo-1/skills?surface=plan", {}, createEnv() as any);
    expect(initial.status).toBe(200);
    const initialBody = await initial.json() as any;
    expect(initialBody.skills).toEqual([
      expect.objectContaining({
        id: "plan-review",
        command: "plan-review",
        origin: "builtin",
        customized: false,
        agents: [expect.objectContaining({ routeKey: "codex:gpt-5.5" })],
      }),
    ]);

    const duplicateBuiltIn = await app.request(
      "/api/repos/repo-1/skills",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surface: "plan",
          command: "/Plan-Review",
          label: "Plan Review",
          description: "",
          sharedInstructions: "Override",
          agents: [{
            id: "one",
            label: "Reviewer",
            instructions: "Review.",
            routeKey: "codex:gpt-5.5",
            effort: "xhigh",
            reportMode: "manual",
          }],
        }),
      },
      createEnv() as any,
    );
    expect(duplicateBuiltIn.status).toBe(409);

    const created = await app.request(
      "/api/repos/repo-1/skills",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surface: "plan",
          command: "/API-Review",
          label: "API Review",
          description: "Check API changes.",
          sharedInstructions: "Review API compatibility.",
          overviewInstructions: "",
          overviewMode: "manual",
          agents: [{
            id: "api",
            label: "API Reviewer",
            instructions: "Check compatibility.",
            // Presets execute on the current writer. Their hidden fanout
            // route must not block the turn when that route is unavailable.
            routeKey: "claude-code:claude-fable-5",
            effort: "high",
            reportMode: "manual",
          }],
        }),
      },
      createEnv() as any,
    );
    expect(created.status).toBe(201);
    const createdBody = await created.json() as any;
    expect(createdBody.skill).toMatchObject({
      command: "api-review",
      label: "API Review",
      origin: "custom",
    });

    const duplicate = await app.request(
      "/api/repos/repo-1/skills",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...createdBody.skill,
          id: undefined,
          command: "API-REVIEW",
          label: "Duplicate",
        }),
      },
      createEnv() as any,
    );
    expect(duplicate.status).toBe(409);

    const updated = await app.request(
      `/api/repos/repo-1/skills/plan/${createdBody.skill.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command: "data-review",
          label: "Data Review",
          description: "Check data paths.",
          sharedInstructions: "Review data migrations.",
        }),
      },
      createEnv() as any,
    );
    expect(updated.status).toBe(200);
    expect((await updated.json() as any).skill).toMatchObject({
      id: createdBody.skill.id,
      command: "data-review",
      label: "Data Review",
    });

    const overridden = await app.request(
      "/api/repos/repo-1/skills/plan/plan-review",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Plan Review",
          description: "Custom built-in review.",
          sharedInstructions: "Return Plan Assessment only.",
        }),
      },
      createEnv() as any,
    );
    expect(overridden.status).toBe(200);
    expect((await overridden.json() as any).skill).toMatchObject({
      command: "plan-review",
      origin: "builtin",
      customized: true,
      sharedInstructions: "Return Plan Assessment only.",
    });

    const reset = await app.request(
      "/api/repos/repo-1/skills/plan/plan-review",
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(reset.status).toBe(200);
    expect((await reset.json() as any).skill).toMatchObject({
      command: "plan-review",
      customized: false,
    });

    const removed = await app.request(
      `/api/repos/repo-1/skills/plan/${createdBody.skill.id}`,
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(removed.status).toBe(200);
    const final = await app.request("/api/repos/repo-1/skills?surface=plan", {}, createEnv() as any);
    expect((await final.json() as any).skills.map((skill: any) => skill.command)).toEqual(["plan-review"]);
  });

  it("does not register the removed writer-runs endpoint", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/writer-runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "fake", model: "fake-fast", action: "start" }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    expect(res.status).toBe(404);
  });

  it("runs a one-agent Plan Skill through one-shot reviewer fanout", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n\nPlan body." },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const created = await app.request(
      "/api/repos/repo-1/skills",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surface: "plan",
          command: "api-review",
          label: "API Review",
          sharedInstructions: "Custom API review instructions.",
          agents: [{
            id: "api",
            label: "API Reviewer",
            instructions: "Check compatibility.",
            routeKey: "codex:gpt-5.5",
            effort: "high",
            reportMode: "manual",
          }],
        }),
      },
      createEnv() as any,
    );
    const skill = (await created.json() as any).skill;
    const runRes = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/skills/${skill.id}/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "single-agent-skill-1" }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
      createExecutionCtx() as any,
    );
    expect(runRes.status).toBe(201);
    const body = await runRes.json() as any;
    expect(body.kind).toBe("fanout");
    expect(body.reviewers).toHaveLength(1);
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      role: "reviewer",
      skill: "api-review",
      input: {
        effort: "high",
        basis: { markdown: "# Draft\n\nPlan body." },
        skillSnapshot: { instructions: "Custom API review instructions.\n\nCheck compatibility." },
      },
    });
    expect(artifactStore.listPlanSkillInvocations({ repoId: "repo-1", planArtifactId: plan.id }))
      .toHaveLength(1);
  });

  it("rejects unknown reviewer models and stored skill routes before reading global billing", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    mocks.getBillingSelections.mockClear();

    const reviewerResponse = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude-code", model: "unknown-model" }),
      },
      createEnv() as any,
    );
    expect(reviewerResponse.status).toBe(400);
    expect(mocks.getBillingSelections).not.toHaveBeenCalled();

    artifactStore.upsertStoredAgentSkill({
      repoId: "repo-1",
      definition: {
        id: "legacy-invalid-route",
        surface: "plan",
        command: "legacy-invalid-route",
        label: "Legacy invalid route",
        description: "",
        sharedInstructions: "Review it.",
        overviewInstructions: "",
        overviewMode: "manual",
        agents: [{
          id: "invalid",
          label: "Invalid",
          routeKey: "claude-code:unknown-model",
          effort: "high",
          instructions: "Review it.",
          reportMode: "manual",
        }],
        origin: "custom",
        customized: true,
        createdAt: null,
        updatedAt: null,
      },
    });
    const skillResponse = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/skills/legacy-invalid-route/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "unknown-route-skill" }),
      },
      createEnv({ PLANNER_RUN: {} }) as any,
      createExecutionCtx() as any,
    );
    expect(skillResponse.status).toBe(400);
    expect(await skillResponse.json()).toMatchObject({
      error: "Unknown agent route: claude-code:unknown-model",
    });
    expect(mocks.getBillingSelections).not.toHaveBeenCalled();
  });

  it("replays idempotent setup for a reserved Plan fanout", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Reserved",
      body: { markdown: "# Reserved basis" },
      status: "draft",
      createdBy: "test",
    });
    const definition = {
      id: "retry-skill",
      surface: "plan" as const,
      command: "retry-skill",
      label: "Retry Skill",
      description: "",
      sharedInstructions: "Use the reserved basis.",
      overviewInstructions: "",
      overviewMode: "manual" as const,
      agents: ["one", "two"].map((id) => ({
        id,
        label: id,
        instructions: `Review ${id}.`,
        routeKey: "codex:gpt-5.5",
        effort: "high" as const,
        reportMode: "manual" as const,
      })),
      origin: "custom" as const,
      customized: true,
      createdAt: null,
      updatedAt: null,
    };
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "setup-retry-1",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: `plan-skills-${plan.id}`,
      definitionSnapshot: definition,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: plan.body.markdown,
        version: plan.version ?? 1,
        gitBaseCommitSha: "main-1",
      },
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      })),
    });
    if (reserved.status !== "created") throw new Error(`Unexpected reservation status: ${reserved.status}`);
    expect(reserved.invocation.status).toBe("setting_up");

    const response = await createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/skills/retry-skill/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "setup-retry-1" }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    expect(response.status).toBe(200);
    expect(["active", "completed"]).toContain((await response.json() as any).invocation.status);
    for (const reviewer of reserved.reviewers) {
      const setupId = `skill-setup:setup-retry-1:${reviewer.skillAgentId}`;
      expect(threads.get(reviewer.threadId)?.listMessages({ limit: 10 }).filter((message) => message.id === setupId)).toHaveLength(1);
    }
  });

  it("uses the fanout request id as the invocation id and replays the reserved child ids", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Frozen",
      body: { markdown: "# Immutable basis" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const created = await app.request("/api/repos/repo-1/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surface: "plan",
        command: "double-check",
        label: "Double Check",
        sharedInstructions: "Review the exact Plan basis.",
        overviewInstructions: "",
        overviewMode: "manual",
        agents: ["architecture", "risk"].map((id) => ({
          id,
          label: id,
          instructions: `Review ${id}.`,
          routeKey: "codex:gpt-5.5",
          effort: "high",
          reportMode: "manual",
        })),
      }),
    }, createEnv() as any);
    const skill = (await created.json() as any).skill;
    const invoke = () => app.request(
      `/api/repos/repo-1/plans/${plan.id}/skills/${skill.id}/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "fanout-request-1" }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
      createExecutionCtx() as any,
    );

    const first = await invoke();
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({ kind: "fanout", invocation: { invocationId: "fanout-request-1" } });
    expect(firstBody.runs).toHaveLength(2);
    expect(firstBody.runs[0].input).toMatchObject({
      effort: "high",
      basis: { markdown: "# Immutable basis", version: 1, gitBaseCommitSha: "main-1" },
    });

    const replay = await invoke();
    expect(replay.status).toBe(200);
    const replayBody = await replay.json() as any;
    expect(replayBody.runs.map((run: any) => run.runId)).toEqual(firstBody.runs.map((run: any) => run.runId));
    expect(replayBody.reviewers.map((reviewer: any) => reviewer.threadId)).toEqual(
      firstBody.reviewers.map((reviewer: any) => reviewer.threadId),
    );

    const secondRun = firstBody.runs[1];
    const secondReviewer = firstBody.reviewers.find((reviewer: any) => reviewer.threadId === secondRun.threadId);
    artifactStore.updateActivePlannerRun({
      runId: secondRun.runId,
      status: "completed",
      completedAt: "2026-07-10T00:01:00.000Z",
    });
    const secondThread = threads.get(secondReviewer.threadId)!;
    secondThread.appendMessage({
      id: "second-child-report",
      senderSessionId: "assistant",
      seq: 2,
      kind: "chat",
      body: { role: "assistant", text: "Second child report", runId: secondRun.runId },
      artifactIds: [plan.id],
    });
    const forwarded = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/skill-invocations/fanout-request-1/forward`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "forward-second-child", messageIds: ["second-child-report"] }),
      },
      createEnv() as any,
    );
    expect(forwarded.status, JSON.stringify(await forwarded.clone().json())).toBe(200);
    expect((await forwarded.json() as any).contributions[0]).toMatchObject({
      sourceThreadId: secondReviewer.threadId,
      sourceMessageId: "second-child-report",
      text: "Second child report",
    });

    const conflict = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/skills/plan-review/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "fanout-request-1" }),
      },
      createEnv() as any,
    );
    expect(conflict.status).toBe(409);
  });

  it("rejects dispatched Plan fanouts before reservation when Git metadata is unavailable", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Waiting for Git",
      body: { markdown: "# Waiting" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const created = await app.request("/api/repos/repo-1/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        surface: "plan",
        command: "git-check",
        label: "Git Check",
        sharedInstructions: "Review against the pinned Git base.",
        agents: ["one", "two"].map((id) => ({
          id,
          label: id,
          instructions: `Review ${id}.`,
          routeKey: "codex:gpt-5.5",
          effort: "high",
          reportMode: "manual",
        })),
      }),
    }, createEnv() as any);
    const skill = (await created.json() as any).skill;
    mocks.loadTrackedRepoForRequest.mockResolvedValue({
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          mainCommit: "main-1",
          gitStatus: "loading",
        },
        workspace: {},
      },
    });

    const response = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/skills/${skill.id}/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "git-unavailable-fanout" }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(409);
    expect(artifactStore.getPlanSkillInvocation("git-unavailable-fanout")).toBeNull();
  });

  it("stores repository Plan Writer Settings and rejects unknown route keys", async () => {
    const app = createTestApp();
    const initial = await app.request("/api/repos/repo-1/plan-writer-settings", {}, createEnv() as any);
    const initialBody = await initial.json() as any;
    expect(initialBody).toMatchObject({
      settings: { routeKey: "codex:gpt-5.5", effort: "xhigh", updatedAt: null },
    });
    expect(initialBody.settings).not.toHaveProperty("fastMode");
    const invalid = await app.request("/api/repos/repo-1/plan-writer-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeKey: "missing:model", planFormat: "# Format" }),
    }, createEnv() as any);
    expect(invalid.status).toBe(400);
    const reviewerOnlyRoute = await app.request("/api/repos/repo-1/plan-writer-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeKey: "opencode:kimi-k2.7-code", planFormat: "# Format" }),
    }, createEnv() as any);
    expect(reviewerOnlyRoute.status).toBe(400);
    const invalidEffort = await app.request("/api/repos/repo-1/plan-writer-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ routeKey: "codex:gpt-5.5", effort: "ultra", planFormat: "# Format" }),
    }, createEnv() as any);
    expect(invalidEffort.status).toBe(400);
    const saved = await app.request("/api/repos/repo-1/plan-writer-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routeKey: "codex:gpt-5.5",
        effort: "low",
        fastMode: true,
        planFormat: "# Repository Plan Format",
      }),
    }, createEnv() as any);
    expect(saved.status).toBe(200);
    const savedBody = await saved.json() as any;
    expect(savedBody).toMatchObject({
      settings: {
        routeKey: "codex:gpt-5.5",
        effort: "low",
        planFormat: "# Repository Plan Format",
        updatedAt: expect.any(String),
      },
    });
    expect(savedBody.settings).not.toHaveProperty("fastMode");
  });

  it("keeps Plan Writer reads inert and makes Start and Stop explicit and idempotent", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const hub = {
      broadcastPlanWriterState: vi.fn(),
      revokePlanWriterTerminal: vi.fn(),
    };
    const nativeEnv = createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: "test-key",
      HUB: { idFromName: () => "hub", get: () => hub },
    }) as any;

    const initial = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer`,
      {},
      nativeEnv,
    );
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ writer: { lifecycle: "not_running", generation: null } });
    expect(mocks.ensurePlanWriterRuntime).not.toHaveBeenCalled();

    const invalidEffort = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.5", effort: "ultra" }),
      },
      nativeEnv,
    );
    expect(invalidEffort.status).toBe(400);
    expect(mocks.ensurePlanWriterRuntime).not.toHaveBeenCalled();

    const fastSettings = await app.request("/api/repos/repo-1/plan-writer-settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        routeKey: "codex:gpt-5.5",
        effort: "low",
        fastMode: true,
        planFormat: "# Plan",
      }),
    }, nativeEnv);
    expect(fastSettings.status).toBe(200);

    const start = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.5", effort: "low" }),
      },
      nativeEnv,
    );
    expect(start.status).toBe(202);
    expect(await start.json()).toMatchObject({
      writer: {
        lifecycle: "starting",
        generation: 1,
        provider: "codex",
        effort: "low",
        basisCommit: "main-1",
      },
    });
    expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledTimes(1);
    expect(artifactStore.getPlanWriter("repo-1", plan.id)?.fastMode).toBeUndefined();

    const replayedStart = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude-code", model: "claude-fable-5" }),
      },
      nativeEnv,
    );
    expect(replayedStart.status).toBe(200);
    expect(await replayedStart.json()).toMatchObject({ writer: { generation: 1, provider: "codex" } });
    expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledTimes(1);

    const stop = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      },
      nativeEnv,
    );
    expect(stop.status).toBe(200);
    expect(await stop.json()).toMatchObject({
      writer: { lifecycle: "not_running", generation: 1, stopReason: "user" },
    });
    expect(hub.revokePlanWriterTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(1);

    const replayedStop = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      },
      nativeEnv,
    );
    expect(replayedStop.status).toBe(200);
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(1);
  });

  it("fences and destroys a late Plan Writer launch when Stop wins during Starting", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const hub = { broadcastPlanWriterState: vi.fn(), revokePlanWriterTerminal: vi.fn() };
    const nativeEnv = createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: "test-key",
      HUB: { idFromName: () => "hub", get: () => hub },
    }) as any;
    let releaseLaunch!: () => void;
    mocks.ensurePlanWriterRuntime.mockReturnValueOnce(new Promise((resolve) => {
      releaseLaunch = () => resolve({ created: true });
    }));

    const starting = app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.5" }),
      },
      nativeEnv,
    );
    await vi.waitFor(() => expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledTimes(1));
    const stopped = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      },
      nativeEnv,
    );
    expect(stopped.status).toBe(200);
    releaseLaunch();
    expect((await starting).status).toBe(200);
    const finalWriter = artifactStore.getPlanWriter("repo-1", plan.id);
    expect(finalWriter).toMatchObject({
      generation: 1,
      stopReason: "user",
    });
    expect(finalWriter?.runtime).toBeUndefined();
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(2);
  });

  it("cleans a dead retained runtime before reserving the next generation", async () => {
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" || key === "ANTHROPIC_API_KEY" ? "test-key" : undefined
    );
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const nativeEnv = createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: "test-key",
      ANTHROPIC_API_KEY: "test-key",
      HUB: { idFromName: () => "hub", get: () => ({ broadcastPlanWriterState: vi.fn() }) },
    }) as any;
    const first = await app.request(`/api/repos/repo-1/plans/${plan.id}/live-writer/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "codex", model: "gpt-5.5" }),
    }, nativeEnv);
    expect(first.status).toBe(202);

    mocks.inspectPlanWriterRuntime.mockResolvedValueOnce({
      registered: true,
      live: false,
      jobSlug: `plan-writer-${plan.id}`,
    });
    const replacement = await app.request(`/api/repos/repo-1/plans/${plan.id}/live-writer/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "claude-code", model: "sonnet" }),
    }, nativeEnv);
    const replacementBody = await replacement.json();
    expect((replacementBody as any).error).toBeUndefined();
    expect({ status: replacement.status, body: replacementBody }).toMatchObject({
      status: 202,
      body: { writer: { generation: 2, provider: "claude-code", lifecycle: "starting" } },
    });
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledTimes(2);
  });

  it("finishes an already-reserved generation on a retried Start", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n" },
      status: "draft",
      createdBy: "test",
    });
    artifactStore.startPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "ccf66bca01216e8ea5f53356c76e270ca3bc468b23d1788f41bd9333890c7cdd",
      launchProvenance: {
        schemaVersion: 1,
        backend: "cf",
        machineId: null,
        codexExecution: {
          kind: "api-key-app-server",
          surface: "plan-writer",
          backend: "cf",
        },
      },
    });
    const app = createTestApp();
    const nativeEnv = createEnv({
      PLANNER_RUN: {},
      OPENAI_API_KEY: "test-key",
      HUB: { idFromName: () => "hub", get: () => ({ broadcastPlanWriterState: vi.fn() }) },
    }) as any;
    const response = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "claude-code", model: "ignored" }),
      },
      nativeEnv,
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ writer: { generation: 1, provider: "codex" } });
    expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledTimes(1);
  });

  it("reuses a Plan reviewer's selected effort for follow-up runs", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft" },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const added = await app.request(`/api/repos/repo-1/plans/${plan.id}/reviewers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "fake", model: "fake-fast", effort: "low" }),
    }, createEnv() as any);
    const reviewer = (await added.json() as any).reviewer;

    const response = await app.request(`/api/repos/repo-1/plans/${plan.id}/reviewers/${reviewer.threadId}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "Review this plan." }),
    }, createEnv() as any, createExecutionCtx() as any);

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.run.input.effort).toBe("low");
    expect(body.message).toMatchObject({
      senderSessionId: "user",
      body: { role: "user", text: "Review this plan." },
    });
    expect(body).not.toHaveProperty("messages");
  });

  it("rejects reviewer skill and message actions after the reviewer tab is removed", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n\nPlan body." },
      status: "draft",
      createdBy: "test",
    });
    const app = createTestApp();
    const reviewerRes = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "fake", model: "fake-fast", effort: "low" }),
      },
      createEnv() as any,
    );
    const reviewerBody = await reviewerRes.json() as any;
    expect(reviewerBody.reviewer.effort).toBe("low");
    const threadId = reviewerBody.reviewer.threadId;

    const deleteRes = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${threadId}`,
      { method: "DELETE" },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    expect(deleteRes.status).toBe(200);

    const skillRun = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${threadId}/skill-runs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ skillId: "plan-review" }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    expect(skillRun.status).toBe(404);

    const messages = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${threadId}/messages`,
      {},
      createEnv() as any,
    );
    expect(messages.status).toBe(404);

    const messageRun = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Review this." }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    expect(messageRun.status).toBe(404);

    const sendToWriter = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${threadId}/messages/message-1/send-to-writer`,
      { method: "POST" },
      createEnv() as any,
    );
    expect(sendToWriter.status).toBe(404);
  });

  it("filters one-shot reviewer run events with afterSeq", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Existing",
      body: { markdown: "# Existing plan\n\nSteps." },
      status: "draft",
      createdBy: "test",
    });
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: "reviewer-thread-1",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    for (const type of ["run_queued", "runtime_startup", "run_completed"]) {
      artifactStore.appendPlannerRunEvent({
        runId: run.runId,
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        type,
      });
    }
    artifactStore.updateActivePlannerRun({
      runId: run.runId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    const app = createTestApp();
    const query = `role=reviewer&threadId=${run.threadId}`;
    const all = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/latest?${query}`,
      {},
      createEnv() as any,
    );
    const allBody = await all.json() as any;
    expect(allBody.run.runId).toBe(run.runId);
    expect(allBody.events).toHaveLength(3);

    const delta = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/latest?${query}&afterSeq=2`,
      {},
      createEnv() as any,
    );
    const deltaBody = await delta.json() as any;
    expect(deltaBody.events.map((event: { seq: number }) => event.seq)).toEqual([3]);

    const invalid = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/latest?${query}&afterSeq=-1`,
      {},
      createEnv() as any,
    );
    expect(invalid.status).toBe(400);
  });
  it("returns 404 for a run fetched under the wrong or nonexistent plan", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Owning plan",
      body: { markdown: "# Plan" },
      status: "draft",
      createdBy: "test",
    });
    const otherPlan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Other plan",
      body: { markdown: "# Other" },
      status: "draft",
      createdBy: "test",
    });
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const app = createTestApp();

    const mismatch = await app.request(
      `/api/repos/repo-1/plans/${otherPlan.id}/runs/${run.runId}`,
      {},
      createEnv() as any,
    );
    expect(mismatch.status).toBe(404);

    const missingPlan = await app.request(
      `/api/repos/repo-1/plans/nonexistent-plan/runs/${run.runId}`,
      {},
      createEnv() as any,
    );
    expect(missingPlan.status).toBe(404);

    const matching = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${run.runId}`,
      {},
      createEnv() as any,
    );
    expect(matching.status).toBe(200);
    expect(((await matching.json()) as any).run.runId).toBe(run.runId);
  });

});
