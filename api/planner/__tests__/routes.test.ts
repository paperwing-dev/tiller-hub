import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";
import { listHarnessModels } from "../../../shared/harness-catalog";
import {
  ArtifactStoreDO,
  ThreadDO,
  asAsyncStub,
  createExecutionCtx,
  createStore,
  createThread,
} from "./test-harness";
import { DEFAULT_PLAN_HEALTH_SKILL } from "../agent-skills";

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

function healthOutput(
  level: "low" | "medium" | "high",
  size: "small" | "medium" | "large",
  riskSummary: string,
): string {
  return JSON.stringify({
    risk: { level, summary: riskSummary },
    changeSize: {
      size,
      summary: "The work has a bounded coordination footprint.",
    },
  });
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const { HUB: overrideHubValue, ...rest } = overrides;
  const overrideHub = overrideHubValue as
    | {
        idFromName?: (...args: unknown[]) => unknown;
        get?: (...args: unknown[]) => Record<string, unknown>;
      }
    | undefined;
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
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" ? "test-key" : undefined,
    );
    mocks.getOrCreateSecret.mockResolvedValue("test-runtime-secret");
    mocks.getIdleTimeoutMinutes.mockResolvedValue(15);
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: "api",
      openaiBillingMode: "api",
    });
    mocks.startPlannerJob.mockResolvedValue(undefined);
    mocks.ensurePlanWriterRuntime.mockResolvedValue({ created: true });
    mocks.inspectPlanWriterRuntime.mockImplementation(
      async (jobSlug: string) => ({
        registered: true,
        live: true,
        jobSlug,
      }),
    );
    mocks.destroyPlanWriterRuntime.mockResolvedValue(undefined);
    mocks.getPlannerRunStub.mockReturnValue({
      startPlannerJob: mocks.startPlannerJob,
      ensurePlanWriterRuntime: mocks.ensurePlanWriterRuntime,
      inspectPlanWriterRuntime: mocks.inspectPlanWriterRuntime,
      destroyPlanWriterRuntime: mocks.destroyPlanWriterRuntime,
    });
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getThreadStub.mockImplementation(
      (_env: unknown, threadId: string) => {
        let thread = threads.get(threadId);
        if (!thread) {
          thread = createThread();
          threads.set(threadId, thread);
        }
        return asAsyncStub(thread);
      },
    );
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
    const response = await createTestApp().request(
      path,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ backend: "host" }),
      },
      createEnv() as any,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "Execution backend selection moved to Settings. Refresh or update this client.",
      code: "backend_selection_removed",
    });
    expect(mocks.loadTrackedRepoForRequest).not.toHaveBeenCalled();
  });

  it("hides the fake provider unless the dev flag enables it", async () => {
    const app = createTestApp();
    const production = await app.request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({
        TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "0",
        LOCAL_DEV_ONLY_BACKEND: "false",
      }) as any,
    );
    const productionBody = (await production.json()) as {
      providers: Array<{
        id: string;
        available: boolean;
        disabledReasons: string[];
        capabilities: { writer: boolean };
      }>;
    };
    expect(
      productionBody.providers.map((provider) => provider.id),
    ).not.toContain("fake");
    // CLI providers are listed in production, but only available when a
    // runtime backend is reachable and auth fits that backend.
    const productionOpenCode = productionBody.providers.find(
      (provider) => provider.id === "opencode",
    );
    expect(productionOpenCode).toBeTruthy();
    expect(productionOpenCode!.available).toBe(false);
    expect(productionOpenCode!.capabilities.writer).toBe(true);
    const productionClaude = productionBody.providers.find(
      (provider) => provider.id === "claude-code",
    );
    expect(productionClaude).toBeTruthy();
    expect(productionClaude!.available).toBe(false);
    expect(productionClaude!.disabledReasons[0]).toMatch(
      /execution backend|Cloudflare/i,
    );

    const dev = await app.request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv() as any,
    );
    const devBody = (await dev.json()) as {
      providers: Array<{ id: string; capabilities: { writer: boolean } }>;
      reviewerSkills?: unknown;
    };
    expect(devBody.providers.map((provider) => provider.id)).toContain("fake");
    expect(
      devBody.providers.find((provider) => provider.id === "fake")?.capabilities
        .writer,
    ).toBe(false);
    expect(devBody.reviewerSkills).toBeUndefined();
    expect((devBody as { executions?: unknown }).executions).toBeUndefined();
    expect(mocks.loadTrackedRepoForRequest).toHaveBeenCalled();
    expect(mocks.loadRepoForRequest).not.toHaveBeenCalled();
  });

  it("exposes every credential-aware OpenCode writer route without expanding reviewer or skill models", async () => {
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" || key === "ANTHROPIC_API_KEY"
        ? "test-key"
        : undefined,
    );
    const response = await createTestApp().request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({ PLANNER_RUN: {}, AI: {} }) as any,
    );
    const body = (await response.json()) as any;
    const writerRoutes = body.writerRoutes.filter(
      (route: any) => route.harness === "opencode",
    );
    expect(writerRoutes.map((route: any) => route.modelId)).toEqual(
      listHarnessModels("opencode").map((entry) => entry.id),
    );
    for (const entry of listHarnessModels("opencode")) {
      expect(
        writerRoutes.find((route: any) => route.modelId === entry.id),
      ).toMatchObject({
        available: true,
        supportedEfforts: [...entry.efforts],
      });
    }
    expect(
      body.providers.find((provider: any) => provider.id === "opencode").models,
    ).toEqual([
      expect.objectContaining({ id: "@cf/moonshotai/kimi-k2.7-code" }),
    ]);
    expect(
      body.skillRoutes.filter((route: any) => route.harness === "opencode"),
    ).toHaveLength(1);
  });

  it("reports route-specific OpenCode credential failures", async () => {
    mocks.getSecret.mockResolvedValue(undefined);
    const response = await createTestApp().request(
      "/api/repos/repo-1/planner-providers",
      {},
      createEnv({ PLANNER_RUN: {} }) as any,
    );
    const routes = ((await response.json()) as any).writerRoutes.filter(
      (route: any) => route.harness === "opencode",
    );
    const byCredential = new Map(
      listHarnessModels("opencode").map((entry) => [
        entry.credential,
        entry.id,
      ]),
    );
    expect(
      routes.find(
        (route: any) => route.modelId === byCredential.get("openai-api-key"),
      ),
    ).toMatchObject({
      available: false,
      disabledReason: expect.stringMatching(/OpenAI API key/),
    });
    expect(
      routes.find(
        (route: any) => route.modelId === byCredential.get("anthropic-api-key"),
      ),
    ).toMatchObject({
      available: false,
      disabledReason: expect.stringMatching(/Claude API key/),
    });
    expect(
      routes.find(
        (route: any) => route.modelId === byCredential.get("workers-ai"),
      ),
    ).toMatchObject({
      available: false,
      disabledReason: "Requires Workers AI.",
    });
  });

  it("requires a UUID idempotency key and the exact plan-agent reset confirmation", async () => {
    const app = createTestApp();
    const missingKey = await app.request(
      "/api/repos/repo-1/plan-agents/reset",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmation: "RESET_ALL_PLAN_AGENTS" }),
      },
      createEnv() as any,
    );
    expect(missingKey.status).toBe(400);
    await expect(missingKey.json()).resolves.toMatchObject({
      code: "invalid_request",
      error: expect.stringMatching(/Idempotency-Key/),
    });

    const invalidConfirmation = await app.request(
      "/api/repos/repo-1/plan-agents/reset",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "00000000-0000-4000-8000-000000000201",
        },
        body: JSON.stringify({
          confirmation: "RESET_ALL_PLAN_AGENTS",
          force: true,
        }),
      },
      createEnv() as any,
    );
    expect(invalidConfirmation.status).toBe(400);
    await expect(invalidConfirmation.json()).resolves.toEqual({
      error:
        "Request body must contain only confirmation: RESET_ALL_PLAN_AGENTS.",
      code: "invalid_request",
    });
  });

  it("resets plan agents through the API and replays without deleting replacements", async () => {
    const plan = artifactStore.createArtifact({
      id: "api-reset-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Reset",
      body: { markdown: "# Reset\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest:
        "c6ef50666b5f4d202776a3c11812fc6e7b51b8c661220a8b49aa36b2f5ff4c97",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: "api-reset-reviewer",
      provider: "fake",
      model: "fake-fast",
    });
    const resetId = "00000000-0000-4000-8000-000000000202";
    const request = () =>
      createTestApp().request(
        "/api/repos/repo-1/plan-agents/reset",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resetId,
          },
          body: JSON.stringify({ confirmation: "RESET_ALL_PLAN_AGENTS" }),
        },
        createEnv() as any,
      );

    const response = await request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      resetId,
      resetAt: expect.any(String),
      plansPreserved: 1,
      scribesRemoved: 1,
      reviewersRemoved: 1,
      runsRetired: 0,
      cleanupQueued: 1,
      replayed: false,
    });
    expect(artifactStore.getArtifact(plan.id)).toEqual(plan);
    expect(artifactStore.getReviewer(writer.threadId)).toBeNull();

    const replacement = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: "api-reset-replacement",
      provider: "fake",
      model: "fake-fast",
    });
    const replay = await request();
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toMatchObject({
      ok: true,
      resetId,
      replayed: true,
      reviewersRemoved: 1,
    });
    expect(artifactStore.getReviewer(replacement.threadId)).toBeTruthy();
  });

  it("returns bounded plan-agent reset ownership conflicts as HTTP 409", async () => {
    vi.spyOn(artifactStore, "resetPlanAgents")
      .mockResolvedValueOnce({
        status: "unsupported_cleanup_ownership",
        blockerCount: 1,
        blockers: [
          {
            kind: "cleanup",
            planArtifactId: "plan-1",
            ownerId: "legacy-owner",
            cleanupId: "cleanup-1",
          },
        ],
      })
      .mockResolvedValueOnce({ status: "idempotency_conflict" });
    const send = (resetId: string) =>
      createTestApp().request(
        "/api/repos/repo-1/plan-agents/reset",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": resetId,
          },
          body: JSON.stringify({ confirmation: "RESET_ALL_PLAN_AGENTS" }),
        },
        createEnv() as any,
      );

    const unsupported = await send("00000000-0000-4000-8000-000000000203");
    expect(unsupported.status).toBe(409);
    await expect(unsupported.json()).resolves.toEqual({
      error:
        "Plan agents could not be reset because runtime cleanup ownership is unsupported.",
      code: "unsupported_cleanup_ownership",
      blockerCount: 1,
      blockers: [
        {
          kind: "cleanup",
          planArtifactId: "plan-1",
          ownerId: "legacy-owner",
          cleanupId: "cleanup-1",
        },
      ],
    });

    const conflict = await send("00000000-0000-4000-8000-000000000204");
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  it("manages canonical Plan skills and built-in overrides", async () => {
    const app = createTestApp();

    const initial = await app.request(
      "/api/repos/repo-1/skills?surface=plan",
      {},
      createEnv() as any,
    );
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as any;
    expect(initialBody.skills).toEqual([
      expect.objectContaining({
        id: "plan-review",
        command: "plan-review",
        origin: "builtin",
        customized: false,
        agents: [expect.objectContaining({ routeKey: "codex:gpt-5.5" })],
      }),
      expect.objectContaining({
        id: "plan-health",
        command: "health",
        origin: "builtin",
        customized: false,
        agents: [
          expect.objectContaining({
            id: "plan-health-assessor",
            routeKey: "codex:gpt-5.5",
          }),
        ],
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
          agents: [
            {
              id: "one",
              label: "Reviewer",
              instructions: "Review.",
              routeKey: "codex:gpt-5.5",
              effort: "xhigh",
              reportMode: "manual",
            },
          ],
        }),
      },
      createEnv() as any,
    );
    expect(duplicateBuiltIn.status).toBe(409);

    const oneAgentWithoutSharedInstructions = await app.request(
      "/api/repos/repo-1/skills",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          surface: "plan",
          command: "future-one-agent",
          label: "Future one-agent Skill",
          sharedInstructions: "",
          agents: [
            {
              id: "one",
              label: "Reviewer",
              instructions: "Combined future instructions.",
              routeKey: "codex:gpt-5.5",
              effort: "xhigh",
              reportMode: "manual",
            },
          ],
        }),
      },
      createEnv() as any,
    );
    expect(oneAgentWithoutSharedInstructions.status).toBe(201);
    const futureOneAgentBody = (await oneAgentWithoutSharedInstructions.json()) as any;
    expect(futureOneAgentBody).toMatchObject({
      skill: {
        sharedInstructions: "",
        agents: [{ instructions: "Combined future instructions." }],
      },
    });

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
          agents: [
            {
              id: "api",
              label: "API Reviewer",
              instructions: "Check compatibility.",
              routeKey: "claude-code:claude-fable-5",
              effort: "high",
              reportMode: "manual",
            },
          ],
        }),
      },
      createEnv() as any,
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as any;
    expect(createdBody.skill).toMatchObject({
      command: "api-review",
      label: "API Review",
      origin: "custom",
      sharedInstructions: "",
      agents: [{
        instructions: "Review API compatibility.\n\nCheck compatibility.",
      }],
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
    expect(((await updated.json()) as any).skill).toMatchObject({
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
    expect(((await overridden.json()) as any).skill).toMatchObject({
      command: "plan-review",
      origin: "builtin",
      customized: true,
      sharedInstructions: "",
      agents: [{ instructions: expect.stringContaining("Return Plan Assessment only.") }],
    });

    const reset = await app.request(
      "/api/repos/repo-1/skills/plan/plan-review",
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(reset.status).toBe(200);
    expect(((await reset.json()) as any).skill).toMatchObject({
      command: "plan-review",
      customized: false,
    });

    const healthOverride = await app.request(
      "/api/repos/repo-1/skills/plan/plan-health",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label: "Delivery Health",
          description: "Custom health description.",
          sharedInstructions: "Use custom Risk and Change Size rubrics.",
          agents: [
            {
              id: "plan-health-assessor",
              label: "Health Analyst",
              instructions: "Explain both assessments.",
              routeKey: "codex:gpt-5.5",
              effort: "xhigh",
              reportMode: "manual",
            },
          ],
        }),
      },
      createEnv() as any,
    );
    expect(healthOverride.status).toBe(200);
    expect(((await healthOverride.json()) as any).skill).toMatchObject({
      id: "plan-health",
      command: "health",
      label: "Delivery Health",
      overviewMode: "manual",
      overviewInstructions: "",
      customized: true,
      agents: [
        {
          id: "plan-health-assessor",
          label: "Health Analyst",
          effort: "xhigh",
          reportMode: "manual",
        },
      ],
    });
    const invalidHealthShape = await app.request(
      "/api/repos/repo-1/skills/plan/plan-health",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agents: [] }),
      },
      createEnv() as any,
    );
    expect(invalidHealthShape.status).toBe(400);
    const healthReset = await app.request(
      "/api/repos/repo-1/skills/plan/plan-health",
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(await healthReset.json()).toMatchObject({
      skill: {
        id: "plan-health",
        command: "health",
        label: "Plan Health",
        customized: false,
        agents: [
          { id: "plan-health-assessor", effort: "high", reportMode: "manual" },
        ],
      },
    });

    const removed = await app.request(
      `/api/repos/repo-1/skills/plan/${createdBody.skill.id}`,
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(removed.status).toBe(200);
    const removedFutureOneAgent = await app.request(
      `/api/repos/repo-1/skills/plan/${futureOneAgentBody.skill.id}`,
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(removedFutureOneAgent.status).toBe(200);
    const final = await app.request(
      "/api/repos/repo-1/skills?surface=plan",
      {},
      createEnv() as any,
    );
    expect(
      ((await final.json()) as any).skills.map((skill: any) => skill.command),
    ).toEqual(["plan-review", "health"]);
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
        body: JSON.stringify({
          provider: "fake",
          model: "fake-fast",
          action: "start",
        }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    expect(res.status).toBe(404);
  });

  it("runs a one-agent Plan Skill as a standalone reusable root", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n\nPlan body." },
      status: "draft",
      createdBy: "test",
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
      effort: "low",
    });
    const parentThread = createThread();
    threads.set(parent.threadId, parentThread);
    parentThread.createThread({
      id: parent.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
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
          agents: [
            {
              id: "api",
              label: "API Reviewer",
              instructions: "Check compatibility.",
              routeKey: "codex:gpt-5.5",
              effort: "high",
              reportMode: "manual",
            },
          ],
        }),
      },
      createEnv() as any,
    );
    const skill = ((await created.json()) as any).skill;
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
    const body = (await runRes.json()) as any;
    expect(body.kind).toBe("skill_root");
    expect(body.invocation).toMatchObject({
      invocationId: "single-agent-skill-1",
      parentThreadId: "plan-skill-root:single-agent-skill-1",
    });
    expect(body.reviewers).toEqual([
      expect.objectContaining({
        threadId: "plan-skill-root:single-agent-skill-1",
        nodeKind: "skill_root",
      }),
    ]);
    expect(body.runs[0]).toMatchObject({
      role: "reviewer",
      skill: "api-review",
      skillRunRole: "root_initial",
      input: {
        effort: "high",
        basis: { markdown: "# Draft\n\nPlan body.\n" },
        skillSnapshot: {
          instructions:
            "Custom API review instructions.\n\nCheck compatibility.",
        },
      },
    });
    const rootThread = threads.get(body.invocation.parentThreadId)!;
    const setupMessage = rootThread.listMessages({ limit: 20 }).find(
      (message) => message.id === `skill-setup:${body.runs[0].runId}`,
    );
    expect(setupMessage).toMatchObject({
      threadId: body.invocation.parentThreadId,
      body: { role: "user", runId: body.runs[0].runId },
    });
    const retry = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/skills/${skill.id}/invoke`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "single-agent-skill-1" }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
    );
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      kind: "skill_root",
      invocation: { invocationId: body.invocation.invocationId },
      runs: [{ runId: body.runs[0].runId }],
    });
    expect(
      rootThread
        .listMessages({ limit: 20 })
        .filter((message) => message.id === setupMessage!.id),
    ).toHaveLength(1);
    const transcript = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${body.invocation.parentThreadId}/messages`,
      {},
      createEnv() as any,
    );
    await expect(transcript.json()).resolves.toMatchObject({
      messages: [{ id: setupMessage!.id }],
      runAttributions: {
        [body.runs[0].runId]: {
          status: "queued",
          provider: "codex",
          model: "gpt-5.5",
          effort: "high",
          command: "api-review",
          agentLabel: "API Reviewer",
        },
      },
    });
    expect(
      artifactStore.listPlanSkillInvocations({
        repoId: "repo-1",
        planArtifactId: plan.id,
      }),
    ).toHaveLength(1);
  });

  it("isolates a skill root from unrelated messages in an existing reviewer", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft" },
      status: "draft",
      createdBy: "test",
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const parentThread = createThread();
    threads.set(parent.threadId, parentThread);
    parentThread.createThread({
      id: parent.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const skill = artifactStore.upsertStoredAgentSkill({
      repoId: "repo-1",
      definition: {
        id: "command-conflict-skill",
        surface: "plan",
        command: "command-conflict",
        label: "Command Conflict",
        description: "",
        sharedInstructions: "Review the plan.",
        overviewInstructions: "",
        overviewMode: "manual",
        agents: [
          {
            id: "api",
            label: "API Reviewer",
            instructions: "Check compatibility.",
            routeKey: "codex:gpt-5.5",
            effort: "high",
            reportMode: "manual",
          },
        ],
        origin: "custom",
        customized: true,
        createdAt: null,
        updatedAt: null,
      },
    });
    const requestId = "conflicting-command-request";
    parentThread.appendMessage({
      id: `plan-skill-command:${requestId}`,
      senderSessionId: "user",
      seq: 1,
      kind: "chat",
      body: {
        role: "user",
        text: "/different-command",
        runId: "different-run",
      },
      artifactIds: [plan.id],
    });
    const app = createTestApp();
    const invoke = (id: string) =>
      app.request(
        `/api/repos/repo-1/plans/${plan.id}/skills/${skill.id}/invoke`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId: id }),
        },
        createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
        createExecutionCtx() as any,
      );

    const isolated = await invoke(requestId);
    expect(isolated.status).toBe(201);
    await expect(isolated.json()).resolves.toMatchObject({
      kind: "skill_root",
      invocation: {
        invocationId: requestId,
        parentThreadId: `plan-skill-root:${requestId}`,
      },
    });

    const fresh = await invoke("fresh-command-request");
    expect(fresh.status).toBe(201);
    await expect(fresh.json()).resolves.toMatchObject({
      kind: "skill_root",
      invocation: { parentThreadId: "plan-skill-root:fresh-command-request" },
    });
  });

  it("rejects unknown reviewer models and stored skill routes", async () => {
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
        body: JSON.stringify({
          provider: "claude-code",
          model: "unknown-model",
        }),
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
        agents: [
          {
            id: "invalid",
            label: "Invalid",
            routeKey: "claude-code:unknown-model",
            effort: "high",
            instructions: "Review it.",
            reportMode: "manual",
          },
        ],
        origin: "custom",
        customized: true,
        createdAt: null,
        updatedAt: null,
      },
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
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
    expect(mocks.getBillingSelections).toHaveBeenCalledOnce();
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
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "setup-retry-1",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:setup-retry-1",
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
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "low" },
    });
    if (reserved.status !== "created")
      throw new Error(`Unexpected reservation status: ${reserved.status}`);
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
    expect(["active", "completed"]).toContain(
      ((await response.json()) as any).invocation.status,
    );
    for (const reviewer of reserved.reviewers) {
      const run = reserved.runs.find(
        (candidate) => candidate.skillAgentId === reviewer.skillAgentId,
      )!;
      const setupId = `skill-setup:${run.runId}`;
      expect(
        threads
          .get(reviewer.threadId)
          ?.listMessages({ limit: 10 })
          .filter((message) => message.id === setupId),
      ).toHaveLength(1);
    }
  });

  it("reconciles queued Reports and leaves a manual round ready for Overview", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Recover dispatch",
      body: { markdown: "# Recover dispatch" },
      status: "draft",
      createdBy: "test",
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const definition = {
      id: "recover-dispatch",
      surface: "plan" as const,
      command: "recover-dispatch",
      label: "Recover Dispatch",
      description: "",
      sharedInstructions: "Review the plan.",
      overviewInstructions: "",
      overviewMode: "manual" as const,
      agents: ["one", "two"].map((id) => ({
        id,
        label: id,
        instructions: `Review ${id}.`,
        routeKey: "fake:fake-fast",
        effort: "low" as const,
        reportMode: "manual" as const,
      })),
      origin: "custom" as const,
      customized: true,
      createdAt: null,
      updatedAt: null,
    };
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "recover-active-fanout",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:recover-active-fanout",
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
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "low" },
    });
    if (reserved.status !== "created")
      throw new Error("expected fanout reservation");
    expect(
      artifactStore.activatePlanSkillInvocation(
        reserved.invocation.invocationId,
      )?.status,
    ).toBe("active");
    const executionCtx = createExecutionCtx();

    const response = await createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${reserved.invocation.parentThreadId}/skill-invocations/latest`,
      {},
      createEnv() as any,
      executionCtx as any,
    );
    expect(response.status).toBe(200);
    await Promise.all(
      executionCtx.waitUntil.mock.calls.map(([promise]) => promise),
    );

    expect(
      artifactStore.listPlanSkillInvocationRuns(
        reserved.invocation.invocationId,
      ),
    ).toEqual(
      reserved.runs.map((run) =>
        expect.objectContaining({ runId: run.runId, status: "completed" }),
      ),
    );
    expect(
      artifactStore.getPlanSkillInvocation(reserved.invocation.invocationId)
        ?.status,
    ).toBe("active");
    for (const run of reserved.runs) {
      expect(
        artifactStore
          .listPlannerRunEvents(run.runId)
          .filter((event) => event.type === "run_queued"),
      ).toHaveLength(1);
    }
  });

  it("runs the stale-child watchdog from the latest fanout endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    try {
      const plan = artifactStore.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: "Stale child",
        body: { markdown: "# Stale child" },
        status: "draft",
        createdBy: "test",
      });
      const parent = artifactStore.upsertReviewer({
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "fake",
        model: "fake-fast",
      });
      const definition = {
        id: "stale-child",
        surface: "plan" as const,
        command: "stale-child",
        label: "Stale Child",
        description: "",
        sharedInstructions: "Review the plan.",
        overviewInstructions: "",
        overviewMode: "manual" as const,
        agents: [
          {
            id: "one",
            label: "One",
            instructions: "Review it.",
            routeKey: "codex:gpt-5.5",
            effort: "high" as const,
            reportMode: "manual" as const,
          },
        ],
        origin: "custom" as const,
        customized: true,
        createdAt: null,
        updatedAt: null,
      };
      const reserved = artifactStore.reservePlanSkillInvocation({
        invocationId: "stale-active-fanout",
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: "plan-skill-root:stale-active-fanout",
        definitionSnapshot: definition,
        basis: {
          artifactId: plan.id,
          title: plan.title,
          markdown: plan.body.markdown,
          version: plan.version ?? 1,
          gitBaseCommitSha: "main-1",
        },
        agents: [
          {
            id: "one",
            provider: "codex",
            model: "gpt-5.5",
            launchProvenance: CURRENT_CF_LAUNCH,
          },
        ],
      });
      if (reserved.status !== "created")
        throw new Error("expected fanout reservation");
      const run = reserved.runs[0]!;
      artifactStore.ensurePlannerRunQueuedEvent({
        runId: run.runId,
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        type: "run_queued",
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      artifactStore.updatePlannerRun({ runId: run.runId, status: "running" });
      artifactStore.activatePlanSkillInvocation(
        reserved.invocation.invocationId,
      );
      vi.setSystemTime(new Date("2026-08-12T00:16:00.000Z"));

      const response = await createTestApp().request(
        `/api/repos/repo-1/plans/${plan.id}/reviewers/${reserved.invocation.parentThreadId}/skill-invocations/latest`,
        {},
        createEnv() as any,
        createExecutionCtx() as any,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        invocation: { invocationId: "stale-active-fanout", status: "failed" },
        runs: [expect.objectContaining({ runId: run.runId, status: "failed" })],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails stale Health setup through structured completion and broadcasts an artifact hint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    try {
      const plan = artifactStore.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: "Risk setup timeout",
        body: { markdown: "# Risk setup timeout\n" },
        status: "draft",
        createdBy: "test",
      });
      const parent = artifactStore.upsertReviewer({
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "fake",
        model: "fake-fast",
      });
      const reserved = artifactStore.reservePlanSkillInvocation({
        invocationId: "stale-risk-setup",
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: "plan-skill-root:stale-risk-setup",
        definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
        basis: {
          artifactId: plan.id,
          title: plan.title,
          markdown: "# Risk setup timeout\n",
          version: 1,
          gitBaseCommitSha: "main-1",
        },
        agents: [
          {
            id: "plan-health-assessor",
            provider: "fake",
            model: "fake-fast",
            launchProvenance: CURRENT_CF_LAUNCH,
          },
        ],
      });
      if (reserved.status !== "created")
        throw new Error("expected Health reservation");
      vi.setSystemTime(new Date("2026-08-12T00:02:11.000Z"));
      const broadcastPlanArtifactUpdated = vi.fn();

      const response = await createTestApp().request(
        `/api/repos/repo-1/plans/${plan.id}/reviewers/${reserved.invocation.parentThreadId}/skill-invocations/latest`,
        {},
        createEnv({
          HUB: {
            get: () => ({ broadcastPlanArtifactUpdated }),
          },
        }) as any,
      );

      expect(response.status).toBe(200);
      const body = (await response.json()) as any;
      expect(body).toMatchObject({
        invocation: {
          invocationId: "stale-risk-setup",
          status: "failed",
          error: "Skill setup timed out before all child threads were ready.",
          result: null,
        },
        runs: [
          expect.objectContaining({
            status: "failed",
            error: "Skill setup timed out before all child threads were ready.",
          }),
        ],
      });
      expect(broadcastPlanArtifactUpdated).toHaveBeenCalledWith(
        "repo-1",
        plan.id,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("sweeps a stale active Health through the structured failure coordinator before serving history", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    try {
      const plan = artifactStore.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: "Stale Risk runtime",
        body: { markdown: "# Stale Risk runtime\n" },
        status: "draft",
        createdBy: "test",
      });
      const parent = artifactStore.upsertReviewer({
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "fake",
        model: "fake-fast",
      });
      const reserved = artifactStore.reservePlanSkillInvocation({
        invocationId: "stale-risk-runtime",
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: "plan-skill-root:stale-risk-runtime",
        definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
        basis: {
          artifactId: plan.id,
          title: plan.title,
          markdown: "# Stale Risk runtime\n",
          version: 1,
          gitBaseCommitSha: "main-1",
        },
        agents: [
          {
            id: "plan-health-assessor",
            provider: "fake",
            model: "fake-fast",
            launchProvenance: CURRENT_CF_LAUNCH,
          },
        ],
      });
      if (reserved.status !== "created")
        throw new Error("expected Health reservation");
      const run = reserved.runs[0]!;
      artifactStore.ensurePlannerRunQueuedEvent({
        runId: run.runId,
        repoId: run.repoId,
        planArtifactId: run.planArtifactId,
        type: "run_queued",
        createdAt: "2026-08-12T00:00:00.000Z",
      });
      artifactStore.updatePlannerRun({ runId: run.runId, status: "running" });
      artifactStore.activatePlanSkillInvocation("stale-risk-runtime");
      vi.setSystemTime(new Date("2026-08-12T00:16:00.000Z"));

      const app = createTestApp();
      const history = await app.request(
        `/api/repos/repo-1/plans/${plan.id}/reviewers/${reserved.invocation.parentThreadId}/skill-invocations`,
        {},
        createEnv() as any,
        createExecutionCtx() as any,
      );
      expect(history.status).toBe(200);

      const response = await app.request(
        `/api/repos/repo-1/plans/${plan.id}/reviewers/${reserved.invocation.parentThreadId}/skill-invocations/stale-risk-runtime`,
        {},
        createEnv() as any,
        createExecutionCtx() as any,
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        invocation: {
          invocationId: "stale-risk-runtime",
          status: "failed",
          error: "Reviewer run timed out without reporting a result.",
          result: null,
        },
        runs: [
          expect.objectContaining({
            status: "failed",
            error: "Reviewer run timed out without reporting a result.",
          }),
        ],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes Plan Health child cancellation through invocation cancellation", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Generic Risk cancellation",
      body: { markdown: "# Generic Risk cancellation\n" },
      status: "draft",
      createdBy: "test",
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "generic-risk-cancel",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:generic-risk-cancel",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Generic Risk cancellation\n",
        version: 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "plan-health-assessor",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: CURRENT_CF_LAUNCH,
        },
      ],
    });
    if (reserved.status !== "created")
      throw new Error("expected Health reservation");
    artifactStore.activatePlanSkillInvocation("generic-risk-cancel");
    const broadcastPlanArtifactUpdated = vi.fn();

    const response = await createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${reserved.runs[0]!.runId}/cancel`,
      { method: "POST" },
      createEnv({
        HUB: {
          get: () => ({ broadcastPlanArtifactUpdated }),
        },
      }) as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      run: { status: "cancelled" },
    });
    expect(
      artifactStore.getPlanSkillInvocation("generic-risk-cancel"),
    ).toMatchObject({ status: "cancelled", result: null });
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledWith(
      "repo-1",
      plan.id,
    );
  });

  it("cancels and archives an active skill root when it is removed", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Removal fence",
      body: { markdown: "# Removal fence" },
      status: "draft",
      createdBy: "test",
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const definition = {
      id: "remove-fence",
      surface: "plan" as const,
      command: "remove-fence",
      label: "Remove Fence",
      description: "",
      sharedInstructions: "Review.",
      overviewInstructions: "",
      overviewMode: "manual" as const,
      agents: [
        {
          id: "one",
          label: "One",
          instructions: "Review.",
          routeKey: "fake:fake-fast",
          effort: "low" as const,
          reportMode: "manual" as const,
        },
      ],
      origin: "custom" as const,
      customized: true,
      createdAt: null,
      updatedAt: null,
    };
    artifactStore.reservePlanSkillInvocation({
      invocationId: "route-remove-fence",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:route-remove-fence",
      definitionSnapshot: definition,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: plan.body.markdown,
        version: 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "one",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: CURRENT_CF_LAUNCH,
        },
      ],
    });

    const response = await createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/plan-skill-root:route-remove-fence`,
      { method: "DELETE" },
      createEnv() as any,
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
    expect(artifactStore.getPlanSkillInvocation("route-remove-fence")).toMatchObject({
      status: "cancelled",
    });
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
    const created = await app.request(
      "/api/repos/repo-1/skills",
      {
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
      },
      createEnv() as any,
    );
    const skill = ((await created.json()) as any).skill;
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const invoke = () =>
      app.request(
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
    const firstBody = (await first.json()) as any;
    expect(firstBody).toMatchObject({
      kind: "skill_root",
      invocation: { invocationId: "fanout-request-1" },
    });
    expect(firstBody.runs).toHaveLength(2);
    expect(firstBody.runs[0].input).toMatchObject({
      effort: "high",
      basis: {
        markdown: "# Immutable basis\n",
        version: 1,
        gitBaseCommitSha: "main-1",
      },
    });

    const replay = await invoke();
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as any;
    expect(replayBody.runs.map((run: any) => run.runId)).toEqual(
      firstBody.runs.map((run: any) => run.runId),
    );
    expect(
      replayBody.reviewers.map((reviewer: any) => reviewer.threadId),
    ).toEqual(firstBody.reviewers.map((reviewer: any) => reviewer.threadId));

    const secondRun = firstBody.runs[1];
    const secondReviewer = firstBody.reviewers.find(
      (reviewer: any) => reviewer.threadId === secondRun.threadId,
    );
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
      body: {
        role: "assistant",
        text: "Second child report",
        runId: secondRun.runId,
      },
      artifactIds: [plan.id],
    });
    const forwarded = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/scribe-handoffs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "forward-second-child",
          sources: [
            {
              threadId: secondReviewer.threadId,
              messageId: "second-child-report",
            },
          ],
          content: "Second child report",
        }),
      },
      createEnv() as any,
    );
    expect(
      forwarded.status,
      JSON.stringify(await forwarded.clone().json()),
    ).toBe(201);
    expect(((await forwarded.json()) as any).contribution).toMatchObject({
      sourceKind: "curated_reviewer_handoff",
      sourceRefs: [
        {
          threadId: secondReviewer.threadId,
          messageId: "second-child-report",
          runId: secondRun.runId,
        },
      ],
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

    for (const run of firstBody.runs) {
      artifactStore.updateActivePlannerRun({
        runId: run.runId,
        status: "completed",
        completedAt: "2026-07-10T00:02:00.000Z",
      });
    }
    artifactStore.failPlanSkillInvocation(
      "fanout-request-1",
      "No Overview was requested for this test round.",
    );
    const saved = artifactStore.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: "# Latest basis\n\nChanged after the first review.",
    });
    const rerunPath = `/api/repos/repo-1/plans/${plan.id}/reviewers/${firstBody.invocation.parentThreadId}/skill-invocations/fanout-request-1/rerun`;
    const rerunResponse = await app.request(
      rerunPath,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "rerun-1",
          expectedRoundId: "fanout-request-1",
        }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
      createExecutionCtx() as any,
    );
    expect(
      rerunResponse.status,
      JSON.stringify(await rerunResponse.clone().json()),
    ).toBe(200);
    const rerunBody = (await rerunResponse.json()) as any;
    expect(rerunBody.invocation).toMatchObject({
      invocationId: "rerun-1",
      parentThreadId: firstBody.invocation.parentThreadId,
      basis: {
        markdown: "# Latest basis\n\nChanged after the first review.\n",
        version: saved.artifact.version,
      },
    });
    expect(
      rerunBody.reviewers.map((reviewer: any) => reviewer.threadId),
    ).toEqual(firstBody.reviewers.map((reviewer: any) => reviewer.threadId));
    expect(rerunBody.runs.map((run: any) => run.runId)).toEqual([
      "plan-skill-round:rerun-1:architecture",
      "plan-skill-round:rerun-1:risk",
    ]);
    const exactRerun = await app.request(
      rerunPath,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "rerun-1",
          expectedRoundId: "fanout-request-1",
        }),
      },
      createEnv({ TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "0" }) as any,
    );
    expect(exactRerun.status).toBe(200);
    expect(
      ((await exactRerun.json()) as any).runs.map((run: any) => run.runId),
    ).toEqual(rerunBody.runs.map((run: any) => run.runId));
  });

  it("lists and reopens immutable Plan Skill invocation history after a newer invocation", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "History",
      body: { markdown: "# History\n" },
      status: "draft",
      createdBy: "test",
    });
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserveHealth = (invocationId: string) =>
      artifactStore.reservePlanSkillInvocation({
        invocationId,
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: `plan-skill-root:${invocationId}`,
        definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
        basis: {
          artifactId: plan.id,
          title: plan.title,
          markdown: "# History\n",
          version: plan.version ?? 1,
          gitBaseCommitSha: "main-1",
        },
        agents: [
          {
            id: "plan-health-assessor",
            provider: "fake",
            model: "fake-fast",
            launchProvenance: CURRENT_CF_LAUNCH,
          },
        ],
      });
    const first = reserveHealth("health-history-1");
    if (first.status !== "created")
      throw new Error("expected first reservation");
    artifactStore.activatePlanSkillInvocation("health-history-1");
    artifactStore.completePlanHealthReviewerOutput(first.runs[0]!.runId, {
      status: "succeeded",
      text: healthOutput("low", "small", "The first immutable assessment."),
    });
    const second = reserveHealth("health-history-2");
    if (second.status !== "created")
      throw new Error("expected second reservation");
    artifactStore.activatePlanSkillInvocation("health-history-2");
    artifactStore.completePlanHealthReviewerOutput(second.runs[0]!.runId, {
      status: "succeeded",
      text: healthOutput(
        "medium",
        "medium",
        "The second immutable assessment.",
      ),
    });
    artifactStore.removeReviewer("repo-1", plan.id, parent.threadId);

    const app = createTestApp();
    const history = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${encodeURIComponent(second.invocation.parentThreadId)}/skill-invocations?limit=20`,
      {},
      createEnv() as any,
    );
    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toMatchObject({
      invocations: [
        { invocationId: "health-history-2", skillId: "plan-health" },
      ],
      nextCursor: null,
    });

    const detail = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${encodeURIComponent(first.invocation.parentThreadId)}/skill-invocations/health-history-1`,
      {},
      createEnv() as any,
    );
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      invocation: {
        invocationId: "health-history-1",
        result: {
          kind: "plan-health",
          assessments: {
            risk: { level: "low" },
            changeSize: { size: "small" },
          },
          application: "applied",
        },
      },
    });
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
    const created = await app.request(
      "/api/repos/repo-1/skills",
      {
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
      },
      createEnv() as any,
    );
    const skill = ((await created.json()) as any).skill;
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
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
    expect(
      artifactStore.getPlanSkillInvocation("git-unavailable-fanout"),
    ).toBeNull();
  });

  it("stores repository Plan Writer Settings and rejects unknown route keys", async () => {
    const app = createTestApp();
    const initial = await app.request(
      "/api/repos/repo-1/plan-writer-settings",
      {},
      createEnv() as any,
    );
    const initialBody = (await initial.json()) as any;
    expect(initialBody).toMatchObject({
      settings: { routeKey: "codex:gpt-5.5", effort: "xhigh", updatedAt: null },
    });
    expect(initialBody.settings).not.toHaveProperty("fastMode");
    const invalid = await app.request(
      "/api/repos/repo-1/plan-writer-settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeKey: "missing:model",
          planFormat: "# Format",
        }),
      },
      createEnv() as any,
    );
    expect(invalid.status).toBe(400);
    const openCodeRoute = await app.request(
      "/api/repos/repo-1/plan-writer-settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeKey: "opencode:kimi-k2.7-code",
          planFormat: "# Format",
        }),
      },
      createEnv({ PLANNER_RUN: {}, AI: {} }) as any,
    );
    expect(openCodeRoute.status).toBe(200);
    expect(await openCodeRoute.json()).toMatchObject({
      settings: { routeKey: "opencode:kimi-k2.7-code", effort: "high" },
    });
    const invalidEffort = await app.request(
      "/api/repos/repo-1/plan-writer-settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeKey: "codex:gpt-5.5",
          effort: "ultra",
          planFormat: "# Format",
        }),
      },
      createEnv() as any,
    );
    expect(invalidEffort.status).toBe(400);
    const saved = await app.request(
      "/api/repos/repo-1/plan-writer-settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeKey: "codex:gpt-5.5",
          effort: "low",
          fastMode: true,
          planFormat: "# Repository Plan Format",
        }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
    );
    expect(saved.status).toBe(200);
    const savedBody = (await saved.json()) as any;
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

  it("starts every OpenCode credential-binding family from its route key", async () => {
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" || key === "ANTHROPIC_API_KEY"
        ? "test-key"
        : undefined,
    );
    const cases = [
      {
        routeKey: "opencode:gpt-5.5",
        model: "gpt-5.5",
        effort: "xhigh",
        env: { PLANNER_RUN: {}, OPENAI_API_KEY: "test-openai-key" },
      },
      {
        routeKey: "opencode:claude-fable-5",
        model: "claude-fable-5",
        effort: "xhigh",
        env: { PLANNER_RUN: {}, ANTHROPIC_API_KEY: "test-anthropic-key" },
      },
      {
        routeKey: "opencode:kimi-k2.7-code",
        model: "@cf/moonshotai/kimi-k2.7-code",
        effort: "high",
        env: { PLANNER_RUN: {}, AI: {} },
      },
    ];
    const app = createTestApp();
    for (const entry of cases) {
      const plan = artifactStore.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: entry.routeKey,
        body: { markdown: "# Draft\n" },
        status: "draft",
        createdBy: "test",
      });
      const response = await app.request(
        `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ routeKey: entry.routeKey }),
        },
        createEnv(entry.env) as any,
      );
      expect({
        status: response.status,
        body: await response.json(),
      }).toMatchObject({
        status: 202,
        body: {
          writer: {
            lifecycle: "starting",
            provider: "opencode",
            model: entry.model,
            effort: entry.effort,
          },
        },
      });
    }
  });

  it("keeps Scribe reads inert and makes Start and Abandon explicit and idempotent", async () => {
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
    expect(await initial.json()).toMatchObject({
      writer: { lifecycle: "not_running", generation: null },
    });
    expect(mocks.ensurePlanWriterRuntime).not.toHaveBeenCalled();

    const invalidEffort = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.5",
          effort: "ultra",
        }),
      },
      nativeEnv,
    );
    expect(invalidEffort.status).toBe(400);
    expect(mocks.ensurePlanWriterRuntime).not.toHaveBeenCalled();

    const fastSettings = await app.request(
      "/api/repos/repo-1/plan-writer-settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          routeKey: "codex:gpt-5.5",
          effort: "low",
          fastMode: true,
          planFormat: "# Plan",
        }),
      },
      nativeEnv,
    );
    expect(fastSettings.status).toBe(200);

    const start = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "codex",
          model: "gpt-5.5",
          effort: "low",
        }),
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
    expect(
      artifactStore.getPlanWriter("repo-1", plan.id)?.fastMode,
    ).toBeUndefined();

    const replayedStart = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "claude-code",
          model: "claude-fable-5",
        }),
      },
      nativeEnv,
    );
    expect(replayedStart.status).toBe(200);
    expect(await replayedStart.json()).toMatchObject({
      writer: { generation: 1, provider: "codex" },
    });
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
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
    });
    expect(hub.revokePlanWriterTerminal).not.toHaveBeenCalled();
    expect(mocks.destroyPlanWriterRuntime).not.toHaveBeenCalled();

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
    expect(mocks.destroyPlanWriterRuntime).not.toHaveBeenCalled();
  });

  it("fences and destroys a late Plan Writer launch when Abandon wins during Starting", async () => {
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
    let releaseLaunch!: () => void;
    mocks.ensurePlanWriterRuntime.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseLaunch = () => resolve({ created: true });
      }),
    );

    const starting = app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "codex", model: "gpt-5.5" }),
      },
      nativeEnv,
    );
    await vi.waitFor(() =>
      expect(mocks.ensurePlanWriterRuntime).toHaveBeenCalledTimes(1),
    );
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
    expect(mocks.destroyPlanWriterRuntime).toHaveBeenCalledTimes(1);
  });

  it("abandons an offline Scribe immediately and starts a replacement generation", async () => {
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

    const first = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeKey: "codex:gpt-5.5" }),
      },
      nativeEnv,
    );
    expect(first.status).toBe(202);
    const abandoned = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/stop`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ expectedGeneration: 1 }),
      },
      nativeEnv,
    );
    expect({
      status: abandoned.status,
      body: await abandoned.json(),
    }).toMatchObject({
      status: 200,
      body: {
        writer: { lifecycle: "not_running", generation: 1 },
        cleanupPending: true,
        cleanupCode: "runtime_cleanup_deferred",
      },
    });
    expect(artifactStore.getPlanWriter("repo-1", plan.id)).toMatchObject({
      generation: 1,
      stoppedAt: expect.any(String),
    });
    expect(
      artifactStore.getPlanWriter("repo-1", plan.id)?.runtime,
    ).toBeUndefined();
    expect(
      artifactStore.listPlanRuntimeCleanupTargetsForRepo("repo-1"),
    ).toEqual([expect.objectContaining({ kind: "writer", generation: 1 })]);
    expect(mocks.destroyPlanWriterRuntime).not.toHaveBeenCalled();

    const replacement = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeKey: "codex:gpt-5.5" }),
      },
      nativeEnv,
    );
    expect({
      status: replacement.status,
      body: await replacement.json(),
    }).toMatchObject({
      status: 202,
      body: { writer: { lifecycle: "starting", generation: 2 } },
    });
    expect(
      artifactStore.listPlanRuntimeCleanupTargetsForRepo("repo-1"),
    ).toEqual([expect.objectContaining({ kind: "writer", generation: 1 })]);
  });

  it("detaches a dead retained runtime before reserving the next generation", async () => {
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" || key === "ANTHROPIC_API_KEY"
        ? "test-key"
        : undefined,
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
      HUB: {
        idFromName: () => "hub",
        get: () => ({
          broadcastPlanWriterState: vi.fn(),
          revokePlanWriterTerminal: vi.fn(),
        }),
      },
    }) as any;
    const first = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeKey: "codex:gpt-5.5" }),
      },
      nativeEnv,
    );
    expect(first.status).toBe(202);

    mocks.inspectPlanWriterRuntime.mockResolvedValueOnce({
      registered: true,
      live: false,
      jobSlug: `plan-writer-${plan.id}`,
    });
    const replacement = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/live-writer/start`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routeKey: "claude-code:claude-fable-5" }),
      },
      nativeEnv,
    );
    const replacementBody = await replacement.json();
    expect((replacementBody as any).error).toBeUndefined();
    expect({ status: replacement.status, body: replacementBody }).toMatchObject(
      {
        status: 202,
        body: {
          writer: {
            generation: 2,
            provider: "claude-code",
            lifecycle: "starting",
          },
        },
      },
    );
    expect(mocks.destroyPlanWriterRuntime).not.toHaveBeenCalled();
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
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest:
        "ccf66bca01216e8ea5f53356c76e270ca3bc468b23d1788f41bd9333890c7cdd",
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
      HUB: {
        idFromName: () => "hub",
        get: () => ({ broadcastPlanWriterState: vi.fn() }),
      },
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
    expect(await response.json()).toMatchObject({
      writer: { generation: 1, provider: "codex" },
    });
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
    const added = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "fake",
          model: "fake-fast",
          effort: "low",
        }),
      },
      createEnv() as any,
    );
    const reviewer = ((await added.json()) as any).reviewer;

    const response = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${reviewer.threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Review this plan." }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.run.input.effort).toBe("low");
    expect(body.message).toMatchObject({
      senderSessionId: "user",
      body: { role: "user", text: "Review this plan." },
    });
    expect(body).not.toHaveProperty("messages");
  });

  it("creates a canonical edited Scribe handoff with source provenance", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft" },
      status: "draft",
      createdBy: "test",
    });
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
      effort: "low",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: reviewer.threadId,
      launchProvenance: CURRENT_CF_LAUNCH,
      input: { sourcePlanVersion: plan.version ?? 1 },
    });
    artifactStore.updatePlannerRun({
      runId: run.runId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    thread.appendMessage({
      id: "reviewer-message-1",
      senderSessionId: "assistant",
      seq: 1,
      kind: "chat",
      body: {
        role: "assistant",
        text: "Original reviewer feedback",
        runId: run.runId,
      },
      artifactIds: [plan.id],
    });

    const response = await createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/scribe-handoffs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "edited-handoff-1",
          sources: [
            { threadId: reviewer.threadId, messageId: "reviewer-message-1" },
          ],
          content: "Edited reviewer feedback",
        }),
      },
      createEnv() as any,
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      contribution: {
        sourceKind: "curated_reviewer_handoff",
        sourceThreadId: reviewer.threadId,
        sourceMessageId: "reviewer-message-1",
        sourceRefs: [
          {
            threadId: reviewer.threadId,
            messageId: "reviewer-message-1",
            runId: run.runId,
          },
        ],
        provider: "fake",
        model: "fake-fast",
        text: "Edited reviewer feedback",
      },
      created: true,
    });

    const overviewRun = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: reviewer.threadId,
      skillRunRole: "overview",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    artifactStore.updatePlannerRun({
      runId: overviewRun.runId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    thread.appendMessage({
      id: "overview-message-1",
      senderSessionId: "assistant",
      seq: 2,
      kind: "chat",
      body: {
        role: "assistant",
        text: "Canonical Overview",
        runId: overviewRun.runId,
      },
      artifactIds: [plan.id],
    });
    const duplicateOverview = await createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/scribe-handoffs`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "duplicate-overview-handoff",
          sources: [
            { threadId: reviewer.threadId, messageId: "overview-message-1" },
          ],
          content: "Canonical Overview",
        }),
      },
      createEnv() as any,
    );
    expect(duplicateOverview.status).toBe(409);
    await expect(duplicateOverview.json()).resolves.toMatchObject({
      error: expect.stringContaining("canonical Share with Scribe"),
    });
  });

  it("does not rebind a reviewer run when a terminal transition wins startup", async () => {
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft" },
      status: "draft",
      createdBy: "test",
    });
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
      effort: "low",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    let signalRunRead!: () => void;
    const runRead = new Promise<void>((resolve) => {
      signalRunRead = resolve;
    });
    let releaseRunRead!: () => void;
    const runReadGate = new Promise<void>((resolve) => {
      releaseRunRead = resolve;
    });
    const asyncStore = asAsyncStub(artifactStore) as any;
    mocks.getArtifactStoreStub.mockReturnValue(
      new Proxy(asyncStore, {
        get(target, property, receiver) {
          if (property === "getPlannerRun") {
            return async (runId: string) => {
              signalRunRead();
              await runReadGate;
              return artifactStore.getPlannerRun(runId);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );

    const request = createTestApp().request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${reviewer.threadId}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Review this plan." }),
      },
      createEnv() as any,
      createExecutionCtx() as any,
    );
    await runRead;
    artifactStore.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "completed",
    });
    releaseRunRead();

    const response = await request;
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "The plan changed before reviewer work started.",
    });
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "cancelled",
    });
    expect(
      artifactStore.getActiveRunForThread(
        "repo-1",
        plan.id,
        "reviewer",
        reviewer.threadId,
      ),
    ).toBeNull();
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
        body: JSON.stringify({
          provider: "fake",
          model: "fake-fast",
          effort: "low",
        }),
      },
      createEnv() as any,
    );
    const reviewerBody = (await reviewerRes.json()) as any;
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
    const allBody = (await all.json()) as any;
    expect(allBody.run.runId).toBe(run.runId);
    expect(allBody.events).toHaveLength(3);

    const delta = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/latest?${query}&afterSeq=2`,
      {},
      createEnv() as any,
    );
    const deltaBody = (await delta.json()) as any;
    expect(deltaBody.events.map((event: { seq: number }) => event.seq)).toEqual(
      [3],
    );

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
