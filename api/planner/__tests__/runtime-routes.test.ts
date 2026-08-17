import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";
import { MAX_PLAN_MARKDOWN_BYTES } from "../../coordination/planning";
import { plannerJobSlug } from "../dispatch";
import { planWriterTerminalId, sha256Hex } from "../plan-writer-contract";
import {
  DEFAULT_PLAN_REVIEW_SKILL,
  DEFAULT_PLAN_HEALTH_SKILL,
} from "../agent-skills";
import {
  ArtifactStoreDO,
  ThreadDO,
  asAsyncStub,
  createExecutionCtx,
  createStore,
  createThread,
} from "./test-harness";

const mocks = vi.hoisted(() => ({
  loadTrackedRepo: vi.fn(),
  loadTrackedRepoForRequest: vi.fn(),
  getArtifactStoreStub: vi.fn(),
  getThreadStub: vi.fn(),
  getPlannerRunStub: vi.fn(),
  getOpenAIStatus: vi.fn(),
  exchangeCodexRuntimeAuth: vi.fn(),
  getSecret: vi.fn(),
  getOrCreateSecret: vi.fn(),
  getBillingSelections: vi.fn(),
  broadcastPlanArtifactUpdated: vi.fn(),
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
  loadTrackedRepo: mocks.loadTrackedRepo,
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

vi.mock("../../codex-runtime-auth", async () => {
  const actual = await vi.importActual<
    typeof import("../../codex-runtime-auth")
  >("../../codex-runtime-auth");
  return {
    ...actual,
    exchangeCodexRuntimeAuth: mocks.exchangeCodexRuntimeAuth,
  };
});

vi.mock("../../setup/config", () => ({
  getSecret: mocks.getSecret,
  getOrCreateSecret: mocks.getOrCreateSecret,
  getBillingSelections: mocks.getBillingSelections,
}));

const [
  { default: plannerRoutes },
  { default: plannerRuntimeRoutes },
  { mintPlannerRunToken, mintPlanWriterRuntimeToken },
  { executeReviewerRun },
] = await Promise.all([
  import("../routes"),
  import("../runtime-routes"),
  import("../runtime-token"),
  import("../runtime"),
]);

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("authorization", { kind: "specialized" });
    return next();
  });
  app.route("/", plannerRoutes);
  app.route("/", plannerRuntimeRoutes);
  return app;
}

function healthOutput(
  level: "low" | "medium" | "high",
  size: "small" | "medium" | "large",
  riskSummary: string,
  changeSizeSummary = "The work has a bounded coordination footprint.",
): string {
  return JSON.stringify({
    risk: { level, summary: riskSummary },
    changeSize: { size, summary: changeSizeSummary },
  });
}

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "1",
    HUB: {
      idFromName: () => "hub-id",
      get: () => ({
        resolveNewExecutionPlacement: vi
          .fn()
          .mockResolvedValue({ backend: "cf", machineId: null }),
        getExecutionStatus: vi.fn().mockResolvedValue({
          selected: { target: "cf" },
          selectedHost: null,
          candidate: { state: "not_connected" },
          executionReady: true,
        }),
        broadcastPlanArtifactUpdated: mocks.broadcastPlanArtifactUpdated,
      }),
    },
    ...overrides,
  };
}

describe("planner runtime routes", () => {
  let artifactStore: InstanceType<typeof ArtifactStoreDO>;
  let threads: Map<string, InstanceType<typeof ThreadDO>>;

  beforeEach(() => {
    artifactStore = createStore();
    threads = new Map();
    vi.resetAllMocks();
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: false });
    mocks.exchangeCodexRuntimeAuth.mockResolvedValue({
      ok: true,
      access_token: "runtime-access-token",
      account_id: "chatgpt-account",
      expires_at: "2026-07-13T20:00:00.000Z",
    });
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.getOrCreateSecret.mockResolvedValue("test-runtime-secret");
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: null,
      openaiBillingMode: null,
    });
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getPlannerRunStub.mockReturnValue({
      destroyPlannerJob: vi.fn().mockResolvedValue(undefined),
    });
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
    const loadedRepo = {
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          githubFullName: "test/repo",
          githubDefaultBranchHeadSha: "main-1",
          gitStatus: "ready",
          gitError: null,
          artifactStoreGeneration: "generation-1",
          mainCommit: "main-1",
        },
        workspace: {},
      },
    };
    mocks.loadTrackedRepo.mockResolvedValue(loadedRepo);
    mocks.loadTrackedRepoForRequest.mockResolvedValue(loadedRepo);
  });

  function createPlan(markdown = "# Plan\n\nInitial.") {
    return artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown },
      status: "draft",
      createdBy: "test",
    });
  }

  function createContribution(planArtifactId: string, text: string) {
    return artifactStore.createPlanContribution({
      repoId: "repo-1",
      planArtifactId,
      provider: "fake",
      model: "fake-fast",
      skill: "plan-review",
      text,
    });
  }

  function createCurrentPlannerRun(
    input: Parameters<
      InstanceType<typeof ArtifactStoreDO>["createPlannerRun"]
    >[0],
  ) {
    const launchProvenance = input.launchProvenance ?? {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
    };
    const run = artifactStore.createPlannerRun({
      ...input,
      launchProvenance,
    });
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });
    return run;
  }

  function startCurrentPlanWriter(
    input: Parameters<
      InstanceType<typeof ArtifactStoreDO>["startPlanWriter"]
    >[0],
  ) {
    const launchProvenance = input.launchProvenance ?? {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
    };
    const writer = artifactStore.startPlanWriter({
      skills: [],
      ...input,
      launchProvenance,
    });
    artifactStore.setPlanWriterRuntimeIfCurrent(writer.threadId, {
      jobSlug: planWriterTerminalId(
        "repo-1",
        writer.planArtifactId,
        writer.generation!,
      ),
      generation: writer.generation!,
    });
    return writer;
  }

  async function tokenFor(runId: string): Promise<string> {
    return mintPlannerRunToken({} as any, runId);
  }

  async function runtimeRequest(
    app: ReturnType<typeof createTestApp>,
    runId: string,
    path: string,
    init: RequestInit & {
      token?: string | null;
      env?: Record<string, unknown>;
      executionCtx?: ReturnType<typeof createExecutionCtx>;
    } = {},
  ) {
    const token = init.token === undefined ? await tokenFor(runId) : init.token;
    const {
      env: envOverrides,
      executionCtx = createExecutionCtx(),
      token: _token,
      ...requestInit
    } = init;
    return app.request(
      `/api/planner-runtime/repos/repo-1/runs/${runId}${path}`,
      {
        ...requestInit,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Tiller-Planner-Run-Token": token } : {}),
          ...(init.headers ?? {}),
        },
      },
      createEnv(envOverrides) as any,
      executionCtx as any,
    );
  }

  async function writerRuntimeRequest(
    app: ReturnType<typeof createTestApp>,
    planArtifactId: string,
    generation: number,
    path: string,
    init: RequestInit & {
      token?: string | null;
      env?: Record<string, unknown>;
    } = {},
  ) {
    const token =
      init.token === undefined
        ? await mintPlanWriterRuntimeToken(
            {} as any,
            "repo-1",
            planArtifactId,
            generation,
          )
        : init.token;
    const { env: envOverrides, token: _token, ...requestInit } = init;
    return app.request(
      `/api/planner-runtime/repos/repo-1/plans/${planArtifactId}/writers/${generation}${path}`,
      {
        ...requestInit,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { "X-Tiller-Plan-Writer-Token": token } : {}),
          ...(init.headers ?? {}),
        },
      },
      createEnv(envOverrides) as any,
      createExecutionCtx() as any,
    );
  }

  function subscriptionProfile(surface: "plan-writer" | "plan-reviewer") {
    return {
      kind: "subscription-app-server" as const,
      surface,
      backend: "cf" as const,
    };
  }

  it("saves manual Markdown without rebasing and synchronizes its derived title", async () => {
    const app = createTestApp();
    const plan = artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1", envSlug: "env-1" },
      title: "",
      body: { markdown: "" },
      status: "evaluating",
      createdBy: "test",
    });

    const first = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "# Manual title\n\nNew body." }),
      },
      createEnv() as any,
    );
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      artifact: {
        title: "Manual title",
        body: { markdown: "# Manual title\n\nNew body.\n" },
        basis: { mainCommit: "main-1", envSlug: "env-1" },
        status: "evaluating",
        version: 2,
      },
    });

    const renamed = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: "## Title\n\nRenamed manual title\n\n## Summary\nNew body.",
        }),
      },
      createEnv() as any,
    );
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      artifact: {
        title: "Renamed manual title",
        body: {
          markdown:
            "## Title\n\nRenamed manual title\n\n## Summary\nNew body.\n",
        },
        version: 3,
      },
    });

    const empty = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "" }),
      },
      createEnv() as any,
    );
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      artifact: {
        title: "Renamed manual title",
        body: { markdown: "" },
        version: 4,
      },
    });

    const oversizedCanonicalNoOp = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: " ".repeat(MAX_PLAN_MARKDOWN_BYTES + 1),
        }),
      },
      createEnv() as any,
    );
    expect(oversizedCanonicalNoOp.status).toBe(200);
    expect(await oversizedCanonicalNoOp.json()).toMatchObject({
      changed: false,
      artifact: { version: 4, body: { markdown: "" } },
    });
  });

  it("rejects oversized Markdown and read-only plan statuses", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const oversized = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          markdown: `${"a".repeat(MAX_PLAN_MARKDOWN_BYTES - 1)}é`,
        }),
      },
      createEnv() as any,
    );
    expect(oversized.status).toBe(413);
    expect(artifactStore.getArtifact(plan.id)).toMatchObject({
      version: 1,
      body: plan.body,
    });

    artifactStore.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "completed",
    });
    const completed = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "Cannot save" }),
      },
      createEnv() as any,
    );
    expect(completed.status).toBe(409);

    const archivedVersion = artifactStore.getArtifact(plan.id)?.version;
    artifactStore.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "archived",
      expectedVersion: archivedVersion,
    });
    const archived = await app.request(
      `/api/repos/repo-1/plans/${plan.id}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markdown: "Still cannot save" }),
      },
      createEnv() as any,
    );
    expect(archived.status).toBe(409);
  });

  it("exchanges credentials only for the current subscription reviewer leaf run", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: {
        schemaVersion: 1,
        backend: "cf",
        machineId: null,
        codexExecution: subscriptionProfile("plan-reviewer"),
      },
    });
    const response = await runtimeRequest(app, run.runId, "/runtime-auth", {
      method: "POST",
      env: {},
      body: JSON.stringify({ rejected_access_token_sha256: "a".repeat(64) }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "runtime-access-token",
      account_id: "chatgpt-account",
      expires_at: "2026-07-13T20:00:00.000Z",
    });
    expect(mocks.exchangeCodexRuntimeAuth).toHaveBeenCalledWith(
      expect.anything(),
      "a".repeat(64),
    );

    mocks.exchangeCodexRuntimeAuth.mockResolvedValueOnce({
      ok: true,
      access_token: "replacement-token",
      account_id: "different-account",
      expires_at: "2026-07-13T21:00:00.000Z",
    });
    const changedAccount = await runtimeRequest(
      app,
      run.runId,
      "/runtime-auth",
      {
        method: "POST",
        env: {},
        body: "{}",
      },
    );
    expect(changedAccount.status).toBe(409);
    expect(await changedAccount.json()).toMatchObject({
      code: "needs_reconnect",
    });

    artifactStore.updateActivePlannerRun({
      runId: run.runId,
      status: "cancelled",
    });
    mocks.exchangeCodexRuntimeAuth.mockClear();
    const stale = await runtimeRequest(app, run.runId, "/runtime-auth", {
      method: "POST",
      env: {},
      body: "{}",
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "runtime_inactive" });
    expect(mocks.exchangeCodexRuntimeAuth).not.toHaveBeenCalled();
  });

  it("does not return reviewer credentials when the run is cancelled during exchange", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: {
        schemaVersion: 1,
        backend: "cf",
        machineId: null,
        codexExecution: subscriptionProfile("plan-reviewer"),
      },
    });
    mocks.exchangeCodexRuntimeAuth.mockImplementationOnce(async () => {
      artifactStore.updateActivePlannerRun({
        runId: run.runId,
        status: "cancelled",
      });
      return {
        ok: true,
        access_token: "runtime-access-token",
        account_id: "chatgpt-account",
        expires_at: "2026-07-13T20:00:00.000Z",
      };
    });

    const response = await runtimeRequest(app, run.runId, "/runtime-auth", {
      method: "POST",
      env: {},
      body: "{}",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "runtime_inactive" });
  });

  it("fences Plan Writer runtime auth by generation and stored profile", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      fastMode: true,
      basisCommit: "main-1",
      startBodyDigest: "b".repeat(64),
      launchProvenance: {
        schemaVersion: 1,
        backend: "cf",
        machineId: null,
        codexExecution: subscriptionProfile("plan-writer"),
      },
    });
    const context = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/context",
    );
    expect(context.status).toBe(200);
    expect(await context.json()).toMatchObject({ writer: { fastMode: true } });

    const wrongGeneration = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation! + 1,
      "/runtime-auth",
      {
        method: "POST",
        env: {},
        body: "{}",
      },
    );
    expect(wrongGeneration.status).toBe(409);
    expect(await wrongGeneration.json()).toMatchObject({
      code: "runtime_inactive",
    });

    const response = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/runtime-auth",
      {
        method: "POST",
        env: {},
        body: "{}",
      },
    );
    expect(response.status).toBe(200);
    expect(mocks.exchangeCodexRuntimeAuth).toHaveBeenCalledTimes(1);

    mocks.exchangeCodexRuntimeAuth.mockResolvedValueOnce({
      ok: true,
      access_token: "replacement-token",
      account_id: "different-account",
      expires_at: "2026-07-13T21:00:00.000Z",
    });
    const changedAccount = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/runtime-auth",
      { method: "POST", env: {}, body: "{}" },
    );
    expect(changedAccount.status).toBe(409);
    expect(await changedAccount.json()).toMatchObject({
      code: "needs_reconnect",
    });
  });

  it("returns the exact frozen writer skill projection and accepts requestId-only Claude invocation", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan\n");
    const projectedHealth = DEFAULT_PLAN_HEALTH_SKILL;
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: "c".repeat(64),
      skills: [projectedHealth],
    });
    const context = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/context",
    );
    expect(await context.json()).toMatchObject({
      skills: [projectedHealth],
      capabilities: { repoPlansV1: true },
    });

    const oldContract = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/skills/health/invoke",
      {
        method: "POST",
        body: JSON.stringify({
          requestId: "writer-risk-old",
          skills: [projectedHealth],
        }),
      },
    );
    expect(oldContract.status).toBe(400);

    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: true });
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: null,
      openaiBillingMode: "api",
    });
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" ? "test-key" : undefined,
    );
    const invoked = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/skills/health/invoke",
      {
        method: "POST",
        body: JSON.stringify({ requestId: "writer-risk-1" }),
        env: { PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" },
      },
    );
    expect(invoked.status, JSON.stringify(await invoked.clone().json())).toBe(
      201,
    );
    expect(await invoked.json()).toMatchObject({
      ok: true,
      invocation: {
        invocationId: "writer-risk-1",
        parentThreadId: "plan-skill-root:writer-risk-1",
        definitionSnapshot: { id: "plan-health", command: "health" },
      },
    });
    expect(mocks.broadcastPlanArtifactUpdated).toHaveBeenCalledWith(
      "repo-1",
      plan.id,
    );
    const run = artifactStore.listPlanSkillInvocationRuns("writer-risk-1")[0]!;
    expect(run.input).not.toHaveProperty("initialResultHandler");
    const raw = (artifactStore as any)._db
      .exec("SELECT input_json FROM planner_runs WHERE run_id = ?", run.runId)
      .toArray()[0] as { input_json: string };
    expect(JSON.parse(raw.input_json)).toMatchObject({
      initialResultHandler: "plan-health@1",
    });

    const history = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${encodeURIComponent("plan-skill-root:writer-risk-1")}/skill-invocations/latest`,
      {},
      createEnv() as any,
    );
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({
      invocation: {
        invocationId: "writer-risk-1",
        parentThreadId: "plan-skill-root:writer-risk-1",
      },
      reviewers: [{ threadId: run.threadId }],
      runs: [{ runId: run.runId }],
    });
  });

  it("serves the strict repository-plan command union and hints every successful mutation", async () => {
    const app = createTestApp();
    const source = createPlan("# Source\n");
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: source.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "c".repeat(64),
    });
    const older = artifactStore.createArtifact({
      id: "older-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "older-main" },
      title: "Older",
      body: { markdown: "# Older\r\n\r\nBody.\r\n\r\n" },
      status: "archived",
      createdAt: "2026-08-14T00:00:00.000Z",
      updatedAt: "2026-08-14T00:00:00.000Z",
      version: 4,
    });
    artifactStore.createArtifact({
      id: "hidden-basis-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-2", mainCommit: "main-2" },
      title: "Hidden basis",
      body: { markdown: "# Hidden basis\n" },
    });
    artifactStore.createArtifact({
      id: "cross-repo-plan",
      repoId: "repo-2",
      type: "plan",
      basis: { repoId: "repo-2", mainCommit: "main-2" },
      title: "Cross repo",
      body: { markdown: "# Cross repo\n" },
    });

    const command = (body: Record<string, unknown>) =>
      writerRuntimeRequest(app, source.id, writer.generation!, "/repo-plans", {
        method: "POST",
        body: JSON.stringify(body),
      });

    const listed = await command({ operation: "list" });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as any;
    expect(listedBody.plans.map((plan: any) => plan.id)).toEqual([
      source.id,
      older.id,
    ]);
    expect(listedBody.plans[1]).toEqual({
      id: older.id,
      title: "Older",
      status: "archived",
      version: 4,
      updatedAt: "2026-08-14T00:00:00.000Z",
      basisCommit: "older-main",
    });

    const read = await command({ operation: "read", planId: older.id });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({
      id: older.id,
      title: "Older",
      status: "archived",
      version: 4,
      updatedAt: "2026-08-14T00:00:00.000Z",
      basisCommit: "older-main",
      markdown: "# Older\n\nBody.\n",
    });
    const terminalUpdate = await command({
      operation: "update",
      planId: older.id,
      expectedVersion: 4,
      markdown: "# Cannot edit\n",
    });
    expect(terminalUpdate.status).toBe(409);
    expect(await terminalUpdate.json()).toMatchObject({
      code: "plan_not_editable",
      error: expect.stringMatching(/completed or archived/i),
    });
    const hidden = await command({
      operation: "read",
      planId: "cross-repo-plan",
    });
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toMatchObject({ code: "plan_not_found" });

    const requestId = "00000000-0000-4000-8000-000000000001";
    const createBody = {
      operation: "create",
      requestId,
      markdown: "# Created\r\n\r\nBody.\r\n\r\n",
    };
    const created = await command(createBody);
    expect(created.status).toBe(200);
    expect(await created.json()).toMatchObject({
      id: `plan-tool-${requestId}`,
      title: "Created",
      status: "draft",
      version: 2,
      basisCommit: "main-1",
    });
    expect(artifactStore.getArtifact(`plan-tool-${requestId}`)).toMatchObject({
      body: { markdown: "# Created\n\nBody.\n" },
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      createdBy: `plan-writer:${source.id}:${writer.generation}`,
      version: 2,
    });
    expect(
      artifactStore.getArtifact(`plan-tool-${requestId}`),
    ).not.toHaveProperty("parentArtifactId");
    const replay = await command(createBody);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ version: 2 });

    const target = artifactStore.createArtifact({
      id: "update-target",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Target",
      body: { markdown: "# Target\n" },
      status: "todo",
      version: 5,
    });
    const unchanged = await command({
      operation: "update",
      planId: target.id,
      expectedVersion: 5,
      markdown: "# Target\r\n\r\n",
    });
    expect(unchanged.status).toBe(200);
    expect(await unchanged.json()).toMatchObject({ version: 5 });
    const updated = await command({
      operation: "update",
      planId: target.id,
      expectedVersion: 5,
      markdown: "# Renamed\n\nChanged.\n",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: target.id,
      title: "Renamed",
      version: 6,
    });
    const responseLostReplay = await command({
      operation: "update",
      planId: target.id,
      expectedVersion: 5,
      markdown: "# Renamed\n\nChanged.\n",
    });
    expect(responseLostReplay.status).toBe(200);
    expect(await responseLostReplay.json()).toMatchObject({ version: 6 });
    const conflict = await command({
      operation: "update",
      planId: target.id,
      expectedVersion: 4,
      markdown: "# Conflict\n",
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      code: "version_conflict",
      currentVersion: 6,
    });
    const self = await command({
      operation: "update",
      planId: source.id,
      expectedVersion: 1,
      markdown: "# Self\n",
    });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({
      code: "conflict",
      error: expect.stringMatching(/owned plan/i),
    });

    const activeTarget = artifactStore.createArtifact({
      id: "active-writer-target",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Active target",
      body: { markdown: "# Active target\n" },
      status: "draft",
    });
    startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: activeTarget.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "d".repeat(64),
    });
    const activeWriterConflict = await command({
      operation: "update",
      planId: activeTarget.id,
      expectedVersion: 1,
      markdown: "# Blocked\n",
    });
    expect(activeWriterConflict.status).toBe(409);
    expect(await activeWriterConflict.json()).toMatchObject({
      code: "conflict",
      error: expect.stringMatching(/active Scribe/i),
    });

    for (const invalid of [
      { operation: "list", repoId: "repo-2" },
      { operation: "read" },
      { operation: "create", requestId: "not-a-uuid", markdown: "# Bad\n" },
      {
        operation: "update",
        planId: target.id,
        expectedVersion: 0,
        markdown: "# Bad\n",
      },
      { operation: "unknown" },
    ]) {
      const response = await command(invalid);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }

    const oversized = await command({
      operation: "create",
      requestId: "00000000-0000-4000-8000-000000000002",
      markdown: `# Large\n${"é".repeat(MAX_PLAN_MARKDOWN_BYTES)}`,
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toMatchObject({ code: "invalid_request" });

    const mutationHints = mocks.broadcastPlanArtifactUpdated.mock.calls.filter(
      ([repoId, planId]) =>
        repoId === "repo-1" &&
        (planId === `plan-tool-${requestId}` || planId === target.id),
    );
    expect(mutationHints).toEqual([
      ["repo-1", `plan-tool-${requestId}`],
      ["repo-1", `plan-tool-${requestId}`],
      ["repo-1", target.id],
      ["repo-1", target.id],
      ["repo-1", target.id],
    ]);
  });

  it("allows a custom /plan-risk command from a frozen Plan Writer", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan\n");
    const customPlanRisk = {
      ...DEFAULT_PLAN_HEALTH_SKILL,
      id: "custom-plan-risk",
      command: "plan-risk",
      label: "Custom Plan Risk",
      origin: "custom" as const,
      customized: true,
      agents: [
        {
          ...DEFAULT_PLAN_HEALTH_SKILL.agents[0]!,
          id: "custom-plan-risk-assessor",
          label: "Custom Risk Assessor",
        },
      ],
    };
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: "c".repeat(64),
      skills: [customPlanRisk],
    });
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: true });
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: null,
      openaiBillingMode: "api",
    });
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" ? "test-key" : undefined,
    );

    const response = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/skills/plan-risk/invoke",
      {
        method: "POST",
        body: JSON.stringify({ requestId: "custom-plan-risk-request" }),
        env: { PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" },
      },
    );

    expect(response.status, JSON.stringify(await response.clone().json())).toBe(
      201,
    );
    expect(await response.json()).toMatchObject({
      invocation: {
        invocationId: "custom-plan-risk-request",
        definitionSnapshot: {
          id: "custom-plan-risk",
          command: "plan-risk",
        },
      },
    });
  });

  it("rejects pre-cutover writer launch provenance", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan\n");
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: "c".repeat(64),
      skills: [DEFAULT_PLAN_HEALTH_SKILL],
    });
    (artifactStore as any)._db.exec(
      "UPDATE reviewer_registry SET launch_provenance_json = ? WHERE thread_id = ?",
      JSON.stringify({ schemaVersion: 1, backend: "cf", machineId: null }),
      writer.threadId,
    );

    const context = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/context",
    );
    expect(context.status).toBe(500);

    const invocation = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/skills/health/invoke",
      {
        method: "POST",
        body: JSON.stringify({ requestId: "legacy-writer-risk" }),
      },
    );
    expect(invocation.status).toBe(500);
  });

  it("reruns a terminal Scribe-origin Plan Review invocation", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan review\n");
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: "c".repeat(64),
      skills: [DEFAULT_PLAN_REVIEW_SKILL],
    });
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: true });
    mocks.getBillingSelections.mockResolvedValue({
      claudeBillingMode: null,
      openaiBillingMode: "api",
    });
    mocks.getSecret.mockImplementation(async (_env: unknown, key: string) =>
      key === "OPENAI_API_KEY" ? "test-key" : undefined,
    );
    const invoked = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/skills/plan-review/invoke",
      {
        method: "POST",
        body: JSON.stringify({ requestId: "writer-plan-review-1" }),
        env: { PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" },
      },
    );
    expect(invoked.status, JSON.stringify(await invoked.clone().json())).toBe(
      201,
    );
    const initialRun = artifactStore.listPlanSkillInvocationRuns(
      "writer-plan-review-1",
    )[0]!;
    artifactStore.updateActivePlannerRun({
      runId: initialRun.runId,
      status: "completed",
      completedAt: "2026-08-15T00:00:00.000Z",
    });

    const rerun = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/reviewers/${encodeURIComponent("plan-skill-root:writer-plan-review-1")}/skill-invocations/writer-plan-review-1/rerun`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: "writer-plan-review-rerun",
          expectedRoundId: "writer-plan-review-1",
        }),
      },
      createEnv({ PLANNER_RUN: {}, OPENAI_API_KEY: "test-key" }) as any,
      createExecutionCtx() as any,
    );

    expect(rerun.status, JSON.stringify(await rerun.clone().json())).toBe(200);
    expect(await rerun.json()).toMatchObject({
      invocation: {
        invocationId: "writer-plan-review-rerun",
        parentThreadId: "plan-skill-root:writer-plan-review-1",
      },
      runs: expect.arrayContaining([
        expect.objectContaining({
          runId: "plan-skill-round:writer-plan-review-rerun:plan-architecture",
        }),
      ]),
    });
  });

  it("does not return writer credentials when its generation stops during exchange", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "c".repeat(64),
      launchProvenance: {
        schemaVersion: 1,
        backend: "cf",
        machineId: null,
        codexExecution: subscriptionProfile("plan-writer"),
      },
    });
    mocks.exchangeCodexRuntimeAuth.mockImplementationOnce(async () => {
      artifactStore.fencePlanWriterStop({
        repoId: "repo-1",
        planArtifactId: plan.id,
        expectedGeneration: writer.generation!,
        reason: "user",
      });
      return {
        ok: true,
        access_token: "runtime-access-token",
        account_id: "chatgpt-account",
        expires_at: "2026-07-13T20:00:00.000Z",
      };
    });

    const response = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/runtime-auth",
      { method: "POST", env: {}, body: "{}" },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "runtime_inactive" });
  });

  it("records ordered Scribe completions without resurrecting acknowledged replays", async () => {
    const app = createTestApp();
    const broadcastPlanArtifactUpdated = vi.fn();
    const runtimeEnv = {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({ broadcastPlanArtifactUpdated })),
      },
    };
    const plan = createPlan();
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: "e".repeat(64),
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    const runtime = artifactStore.getPlanWriter("repo-1", plan.id)?.runtime!;
    artifactStore.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: writer.generation!,
      runtime,
      providerConversationId: "claude-session-1",
    });

    const first = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/completions",
      {
        method: "POST",
        body: JSON.stringify({ sequence: 1 }),
        env: runtimeEnv,
      },
    );
    expect(first.status).toBe(204);
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([
      {
        planArtifactId: plan.id,
        sourceKind: "scribe",
        sourceId: writer.threadId,
        token: "1:1",
      },
    ]);
    expect(
      artifactStore.acknowledgePlanAttention({
        repoId: "repo-1",
        planArtifactId: plan.id,
        sourceKind: "scribe",
        sourceId: writer.threadId,
        token: "1:1",
      }),
    ).toBe("acknowledged");

    const replay = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/completions",
      {
        method: "POST",
        body: JSON.stringify({ sequence: 1 }),
        env: runtimeEnv,
      },
    );
    expect(replay.status).toBe(204);
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(1);
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([]);

    const second = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/completions",
      {
        method: "POST",
        body: JSON.stringify({ sequence: 2 }),
        env: runtimeEnv,
      },
    );
    expect(second.status).toBe(204);
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(2);
    const stale = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/completions",
      {
        method: "POST",
        body: JSON.stringify({ sequence: 1 }),
        env: runtimeEnv,
      },
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: "sequence" });

    artifactStore.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "archived",
    });
    const terminal = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/completions",
      {
        method: "POST",
        body: JSON.stringify({ sequence: 3 }),
        env: runtimeEnv,
      },
    );
    expect(terminal.status).toBe(409);
    expect(await terminal.json()).toMatchObject({ reason: "runtime" });
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([]);
  });

  it("stales Plan Health only for changed managed publications and hints only for changes", async () => {
    const app = createTestApp();
    const broadcastPlanWriterState = vi.fn();
    const broadcastPlanArtifactUpdated = vi.fn();
    const runtimeEnv = {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({
          broadcastPlanWriterState,
          broadcastPlanArtifactUpdated,
        })),
      },
    };
    const plan = createPlan("# Plan\n");
    (artifactStore as any)._db.exec(
      "UPDATE artifacts SET plan_health_json = ? WHERE id = ?",
      JSON.stringify({
        schemaVersion: 1,
        assessments: {
          risk: { level: "low", summary: "Localized and reversible." },
          changeSize: { size: "small", summary: "Localized work." },
        },
        assessedAt: "2026-08-15T00:00:00.000Z",
        basisVersion: plan.version ?? 1,
        skillInvocationId: "risk-before-publication",
      }),
      plan.id,
    );
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: await sha256Hex("# Plan\n"),
    });
    const runtime = artifactStore.getPlanWriter("repo-1", plan.id)?.runtime!;
    artifactStore.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: writer.generation!,
      runtime,
      providerConversationId: "scribe-publication-session",
    });

    const unchanged = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/publications",
      {
        method: "POST",
        env: runtimeEnv,
        body: JSON.stringify({
          providerConversationId: "scribe-publication-session",
          sequence: 1,
          providerEventId: "publication-1",
          markdown: "# Plan\r\n\r\n \t",
          bodyDigest: await sha256Hex("# Plan\n"),
        }),
      },
    );
    expect(await unchanged.json()).toMatchObject({
      status: "unchanged",
      changed: false,
      artifactVersion: 1,
    });
    expect(
      artifactStore.getArtifact(plan.id)?.planHealth?.staleAt,
    ).toBeUndefined();
    expect(broadcastPlanArtifactUpdated).not.toHaveBeenCalled();

    const changedMarkdown = "# Plan\n\nChanged.\n";
    const changed = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/publications",
      {
        method: "POST",
        env: runtimeEnv,
        body: JSON.stringify({
          providerConversationId: "scribe-publication-session",
          sequence: 2,
          providerEventId: "publication-2",
          markdown: changedMarkdown,
          bodyDigest: await sha256Hex(changedMarkdown),
        }),
      },
    );
    expect(await changed.json()).toMatchObject({
      status: "updated",
      changed: true,
      artifactVersion: 2,
    });
    const staleAt = artifactStore.getArtifact(plan.id)?.planHealth?.staleAt;
    expect(staleAt).toEqual(expect.any(String));
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(1);

    const replay = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/publications",
      {
        method: "POST",
        env: runtimeEnv,
        body: JSON.stringify({
          providerConversationId: "scribe-publication-session",
          sequence: 2,
          providerEventId: "publication-2",
          markdown: changedMarkdown,
          bodyDigest: await sha256Hex(changedMarkdown),
        }),
      },
    );
    expect(await replay.json()).toMatchObject({
      status: "replayed",
      changed: false,
      artifactVersion: 2,
    });
    expect(artifactStore.getArtifact(plan.id)?.planHealth?.staleAt).toBe(
      staleAt,
    );
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(1);

    const changedAgainMarkdown = "# Plan\n\nChanged again.\n";
    const changedAgain = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/publications",
      {
        method: "POST",
        env: runtimeEnv,
        body: JSON.stringify({
          providerConversationId: "scribe-publication-session",
          sequence: 3,
          providerEventId: "publication-3",
          markdown: changedAgainMarkdown,
          bodyDigest: await sha256Hex(changedAgainMarkdown),
        }),
      },
    );
    expect(await changedAgain.json()).toMatchObject({
      status: "updated",
      changed: true,
      artifactVersion: 3,
    });
    expect(artifactStore.getArtifact(plan.id)?.planHealth?.staleAt).toBe(
      staleAt,
    );

    const revertedMarkdown = "# Plan\n";
    const reverted = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/publications",
      {
        method: "POST",
        env: runtimeEnv,
        body: JSON.stringify({
          providerConversationId: "scribe-publication-session",
          sequence: 4,
          providerEventId: "publication-4",
          markdown: revertedMarkdown,
          bodyDigest: await sha256Hex(revertedMarkdown),
        }),
      },
    );
    expect(await reverted.json()).toMatchObject({
      status: "updated",
      changed: true,
      artifactVersion: 4,
    });
    expect(artifactStore.getArtifact(plan.id)?.planHealth?.staleAt).toBe(
      staleAt,
    );
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(3);
    expect(broadcastPlanWriterState).toHaveBeenCalledTimes(5);
  });

  it("rejects callbacks without a valid run token, even for missing runs", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      input: { githubBaseCommitSha: "main-1" },
    });

    const missing = await runtimeRequest(app, run.runId, "/context", {
      token: null,
    });
    expect(missing.status).toBe(401);

    const wrong = await runtimeRequest(app, run.runId, "/context", {
      token: "not-the-token",
    });
    expect(wrong.status).toBe(401);

    const wrongRun = await runtimeRequest(app, "nonexistent-run", "/context", {
      token: "junk",
    });
    expect(wrongRun.status).toBe(401);

    const validForMissing = await runtimeRequest(
      app,
      "nonexistent-run",
      "/context",
    );
    expect(validForMissing.status).toBe(404);
  });

  it("fails closed for residual reviewer and writer records without current provenance", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const residualRun = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    (artifactStore as any)._db.exec(
      "UPDATE planner_runs SET launch_provenance_json = NULL WHERE run_id = ?",
      residualRun.runId,
    );
    const runResponse = await runtimeRequest(
      app,
      residualRun.runId,
      "/context",
    );
    expect(runResponse.status).toBe(404);
    expect(
      artifactStore.getPlannerRun(residualRun.runId)?.lastContactAt,
    ).toBeUndefined();

    const residualWriter = artifactStore.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: "d".repeat(64),
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    (artifactStore as any)._db.exec(
      "UPDATE reviewer_registry SET launch_provenance_json = NULL WHERE thread_id = ?",
      residualWriter.threadId,
    );
    const writerResponse = await writerRuntimeRequest(
      app,
      plan.id,
      residualWriter.generation!,
      "/context",
    );
    expect(writerResponse.status).toBe(404);
  });

  it("turns supervisor startup failures into a durable stopped writer error", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const writer = startCurrentPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      basisCommit: "main-1",
      startBodyDigest: "a".repeat(64),
    });

    const response = await writerRuntimeRequest(
      app,
      plan.id,
      writer.generation!,
      "/stop",
      {
        method: "POST",
        body: JSON.stringify({
          reason: "runtime_ended",
          startupError:
            "Provider exited before the native composer became available.",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(artifactStore.getPlanWriter("repo-1", plan.id)).toMatchObject({
      stopReason: "runtime_ended",
      startupError:
        "Provider exited before the native composer became available.",
    });
    expect(
      artifactStore.getPlanWriter("repo-1", plan.id)?.stoppedAt,
    ).toBeTruthy();
  });

  it("serves reviewer skill instructions and thread messages", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      skill: "plan-review",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    thread.appendMessage({
      senderSessionId: "user",
      seq: 1,
      kind: "chat",
      body: { role: "user", text: "What about rollback?" },
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      skill: "plan-review",
      threadId: reviewer.threadId,
      input: {
        skillSnapshot: {
          id: "plan-review",
          command: "plan-review",
          label: "Plan Review",
          instructions: "Return Plan Assessment, Concerns, and Recommendation.",
        },
      },
    });

    const res = await runtimeRequest(app, run.runId, "/context");
    const body = (await res.json()) as any;
    expect(body.skillInstructions).toContain("Plan Assessment");
    expect(body.threadMessages).toHaveLength(1);
    expect(body.threadMessagesTruncated).toBe(false);
  });

  it("rejects every container event except runtime_startup", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });

    for (const type of ["artifact_saved", "progress", "assistant_message"]) {
      const forbidden = await runtimeRequest(app, run.runId, "/events", {
        method: "POST",
        body: JSON.stringify({ events: [{ type, message: "nope" }] }),
      });
      expect(forbidden.status).toBe(400);
    }
    const missingMessage = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({ events: [{ type: "model_activity" }] }),
    });
    expect(missingMessage.status).toBe(400);
    expect(artifactStore.listPlannerRunEvents(run.runId)).toHaveLength(0);
    expect(
      artifactStore.getPlannerRun(run.runId)?.lastContactAt,
    ).toBeUndefined();
  });

  it("requires an explicit valid event array before recording liveness", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });

    for (const body of [
      "{",
      JSON.stringify({}),
      JSON.stringify({ events: null }),
      JSON.stringify({ events: [null] }),
    ]) {
      const response = await runtimeRequest(app, run.runId, "/events", {
        method: "POST",
        body,
      });
      expect(response.status).toBe(400);
    }
    expect(
      artifactStore.getPlannerRun(run.runId)?.lastContactAt,
    ).toBeUndefined();
    expect(artifactStore.listPlannerRunEvents(run.runId)).toHaveLength(0);
  });

  it("treats an empty event batch as a pure status poll", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });

    const res = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({ events: [] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, runStatus: "queued" });
    expect(artifactStore.listPlannerRunEvents(run.runId)).toHaveLength(0);

    artifactStore.updatePlannerRun({
      runId: run.runId,
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    const afterCancel = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({ events: [] }),
    });
    expect(await afterCancel.json()).toMatchObject({
      ignored: true,
      runStatus: "cancelled",
    });
  });

  it("ignores activity that arrives after a run becomes terminal", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });
    artifactStore.updatePlannerRun({
      runId: run.runId,
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });

    const response = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({
        events: [{ type: "model_activity", message: "Late private command" }],
      }),
    });

    expect(await response.json()).toMatchObject({
      ok: true,
      ignored: true,
      runStatus: "cancelled",
    });
    expect(artifactStore.listPlannerRunEvents(run.runId)).toHaveLength(0);
    expect(
      artifactStore.getPlannerRun(run.runId)?.lastContactAt,
    ).toBeUndefined();
  });

  it("returns exact immutable Health callback and replay bodies without a thread result", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan\n");
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "risk-callback",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:risk-callback",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Plan\n",
        version: plan.version ?? 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "plan-health-assessor",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: {
            schemaVersion: 1,
            backend: "cf",
            machineId: null,
          },
        },
      ],
    });
    if (reserved.status !== "created")
      throw new Error("expected Health reservation");
    artifactStore.activatePlanSkillInvocation("risk-callback");
    const run = reserved.runs[0]!;
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });

    const first = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: healthOutput("low", "small", "Localized and reversible."),
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody).toEqual({
      ok: true,
      runStatus: "completed",
      result: {
        kind: "plan-health",
        schemaVersion: 1,
        assessments: {
          risk: { level: "low", summary: "Localized and reversible." },
          changeSize: {
            size: "small",
            summary: "The work has a bounded coordination footprint.",
          },
        },
        assessedAt: expect.any(String),
        basisVersion: 1,
        application: "applied",
      },
    });
    expect(
      threads.get(run.threadId!)?.listMessages({ limit: 10 }) ?? [],
    ).toHaveLength(0);

    const replay = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: healthOutput(
          "high",
          "large",
          "Must not replace the first result.",
        ),
      }),
    });
    expect(await replay.json()).toEqual({ ...firstBody, ignored: true });
  });

  it("returns exact plan_changed Health callback and replay bodies", async () => {
    const app = createTestApp();
    const plan = createPlan("# Original\n");
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "risk-plan-changed-callback",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:risk-plan-changed-callback",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Original\n",
        version: 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "plan-health-assessor",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: {
            schemaVersion: 1,
            backend: "cf",
            machineId: null,
          },
        },
      ],
    });
    if (reserved.status !== "created")
      throw new Error("expected Health reservation");
    artifactStore.activatePlanSkillInvocation("risk-plan-changed-callback");
    artifactStore.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: "# Changed\n",
    });
    const run = reserved.runs[0]!;
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });

    const first = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: healthOutput(
          "high",
          "large",
          "The assessed plan crosses several systems.",
        ),
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as any;
    expect(firstBody).toEqual({
      ok: true,
      runStatus: "completed",
      result: {
        kind: "plan-health",
        schemaVersion: 1,
        assessments: {
          risk: {
            level: "high",
            summary: "The assessed plan crosses several systems.",
          },
          changeSize: {
            size: "large",
            summary: "The work has a bounded coordination footprint.",
          },
        },
        assessedAt: expect.any(String),
        basisVersion: 1,
        application: "plan_changed",
      },
    });
    const replay = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: healthOutput("low", "small", "Must be ignored."),
      }),
    });
    expect(await replay.json()).toEqual({ ...firstBody, ignored: true });
    expect(artifactStore.getArtifact(plan.id)?.planHealth).toBeUndefined();
  });

  it("runs in-process Health output through structured completion without a thread assistant message", async () => {
    const plan = createPlan("# In-process\n");
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "risk-in-process",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:risk-in-process",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# In-process\n",
        version: 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "plan-health-assessor",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: {
            schemaVersion: 1,
            backend: "cf",
            machineId: null,
          },
        },
      ],
    });
    if (reserved.status !== "created")
      throw new Error("expected Health reservation");
    artifactStore.activatePlanSkillInvocation("risk-in-process");
    const thread = createThread();
    const run = reserved.runs[0]!;

    const finished = await executeReviewerRun({ artifactStore, thread, run });

    expect(finished.status).toBe("completed");
    expect(thread.listMessages({ limit: 10 })).toEqual([]);
    expect(
      artifactStore.getPlanSkillInvocation("risk-in-process")?.result,
    ).toMatchObject({
      kind: "plan-health",
      assessments: {
        risk: { level: "medium" },
        changeSize: { size: "medium" },
      },
      application: "applied",
    });
    expect(artifactStore.getArtifact(plan.id)?.planHealth).toMatchObject({
      assessments: {
        risk: { level: "medium" },
        changeSize: { size: "medium" },
      },
      skillInvocationId: "risk-in-process",
    });
  });

  it.each([
    [
      "invalid output",
      {
        status: "succeeded",
        text: '{"level":"Low","summary":"Wrong casing."}',
      },
    ],
    ["provider failure", { status: "failed", error: "Provider unavailable." }],
  ])(
    "returns a terminal Risk failure for %s and replays it",
    async (_case, callback) => {
      const app = createTestApp();
      const plan = createPlan("# Plan\n");
      const parent = artifactStore.upsertReviewer({
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "fake",
        model: "fake-fast",
      });
      const invocationId = `risk-failure-${callback.status}`;
      const reserved = artifactStore.reservePlanSkillInvocation({
        invocationId,
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: `plan-skill-root:${invocationId}`,
        definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
        basis: {
          artifactId: plan.id,
          title: plan.title,
          markdown: "# Plan\n",
          version: 1,
          gitBaseCommitSha: "main-1",
        },
        agents: [
          {
            id: "plan-health-assessor",
            provider: "fake",
            model: "fake-fast",
            launchProvenance: {
              schemaVersion: 1,
              backend: "cf",
              machineId: null,
            },
          },
        ],
      });
      if (reserved.status !== "created")
        throw new Error("expected Health reservation");
      artifactStore.activatePlanSkillInvocation(invocationId);
      const run = reserved.runs[0]!;
      artifactStore.setPlannerRunRuntime(run.runId, {
        jobSlug: plannerJobSlug(run.runId),
      });

      const first = await runtimeRequest(app, run.runId, "/result", {
        method: "POST",
        body: JSON.stringify(callback),
      });
      const firstBody = (await first.json()) as any;
      expect(first.status).toBe(200);
      expect(firstBody).toEqual({
        ok: true,
        runStatus: "failed",
        error: expect.any(String),
      });
      const replay = await runtimeRequest(app, run.runId, "/result", {
        method: "POST",
        body: JSON.stringify(callback),
      });
      expect(await replay.json()).toEqual({ ...firstBody, ignored: true });
      expect(
        artifactStore.getPlanSkillInvocation(invocationId)?.result,
      ).toBeNull();
    },
  );

  it("rejects malformed failed callback envelopes without terminalizing Plan Health", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan\n");
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "risk-malformed-failure",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:risk-malformed-failure",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Plan\n",
        version: 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "plan-health-assessor",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: {
            schemaVersion: 1,
            backend: "cf",
            machineId: null,
          },
        },
      ],
    });
    if (reserved.status !== "created")
      throw new Error("expected Health reservation");
    artifactStore.activatePlanSkillInvocation("risk-malformed-failure");
    const run = reserved.runs[0]!;
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });

    for (const callback of [
      { status: "failed" },
      { status: "failed", error: "   " },
      { status: "failed", error: "No.", text: "extra" },
    ]) {
      const response = await runtimeRequest(app, run.runId, "/result", {
        method: "POST",
        body: JSON.stringify(callback),
      });
      expect(response.status).toBe(400);
    }
    expect(artifactStore.getPlannerRun(run.runId)?.status).toBe("queued");
    expect(
      artifactStore.getPlanSkillInvocation("risk-malformed-failure")?.status,
    ).toBe("active");
  });

  it("returns the exact cancelled Health callback response", async () => {
    const app = createTestApp();
    const plan = createPlan("# Plan\n");
    const parent = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    const reserved = artifactStore.reservePlanSkillInvocation({
      invocationId: "risk-cancelled",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:risk-cancelled",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Plan\n",
        version: 1,
        gitBaseCommitSha: "main-1",
      },
      agents: [
        {
          id: "plan-health-assessor",
          provider: "fake",
          model: "fake-fast",
          launchProvenance: {
            schemaVersion: 1,
            backend: "cf",
            machineId: null,
          },
        },
      ],
    });
    if (reserved.status !== "created")
      throw new Error("expected Health reservation");
    artifactStore.activatePlanSkillInvocation("risk-cancelled");
    const run = reserved.runs[0]!;
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });
    artifactStore.cancelPlanSkillInvocation("risk-cancelled");
    const response = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: '{"level":"low","summary":"Late."}',
      }),
    });
    expect(await response.json()).toEqual({
      ok: true,
      ignored: true,
      runStatus: "cancelled",
      error: "Skill invocation cancelled.",
    });
  });

  it("flips queued to running on runtime_startup", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      threadId: reviewer.threadId,
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "queued",
      error: null,
    });

    const res = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            type: "runtime_startup",
            message: "provider-controlled",
            data: { command: "secret" },
          },
        ],
      }),
    });
    expect(await res.json()).toMatchObject({ runStatus: "running" });
    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({
      status: "running",
    });
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "running",
    });
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([
      expect.objectContaining({
        type: "runtime_startup",
        message: "Reviewer runtime started.",
      }),
    ]);
    expect(
      artifactStore.listPlannerRunEvents(run.runId)[0]?.data,
    ).toBeUndefined();

    const activity = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({
        events: [
          {
            type: "model_activity",
            message: "Running: rg -n reviewer packages/hub",
          },
          {
            type: "model_commentary",
            message: "I’m tracing the reviewer event path.",
          },
        ],
      }),
    });
    expect(activity.status).toBe(200);
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([
      expect.objectContaining({
        type: "runtime_startup",
        message: "Reviewer runtime started.",
      }),
      expect.objectContaining({
        type: "model_activity",
        message: "Running: rg -n reviewer packages/hub",
      }),
      expect.objectContaining({
        type: "model_commentary",
        message: "I’m tracing the reviewer event path.",
      }),
    ]);
  });

  it("ignores duplicate and post-cancellation results", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      threadId: reviewer.threadId,
      input: { githubBaseCommitSha: "main-1" },
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "queued",
      error: null,
    });

    const first = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", text: "First result." }),
    });
    expect(await first.json()).toMatchObject({ runStatus: "completed" });

    const duplicate = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", text: "Duplicate result." }),
    });
    expect(duplicate.status).toBe(404);
    expect(thread.listMessages({ limit: 10 })).toHaveLength(1);
    expect(thread.listMessages({ limit: 10 })[0].body).toMatchObject({
      text: "First result.",
    });

    const cancelledRun = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });
    artifactStore.updatePlannerRun({
      runId: cancelledRun.runId,
      status: "cancelled",
      completedAt: new Date().toISOString(),
    });
    const late = await runtimeRequest(app, cancelledRun.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", text: "Late result." }),
    });
    expect(await late.json()).toMatchObject({
      ignored: true,
      runStatus: "cancelled",
    });
    expect(artifactStore.getPlannerRun(cancelledRun.runId)).toMatchObject({
      status: "cancelled",
    });
  });

  it("retries retained runtime cleanup when a duplicate terminal result arrives", async () => {
    const app = createTestApp();
    const broadcastPlanArtifactUpdated = vi.fn();
    const runtimeEnv = {
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({ broadcastPlanArtifactUpdated })),
      },
    };
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      threadId: "thread-cleanup-retry",
    });
    const destroyPlannerJob = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockResolvedValueOnce(undefined);
    mocks.getPlannerRunStub.mockReturnValue({ destroyPlannerJob });

    const firstCtx = createExecutionCtx();
    const first = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "failed", error: "review failed" }),
      executionCtx: firstCtx,
      env: runtimeEnv,
    });
    expect(await first.json()).toMatchObject({ runStatus: "failed" });
    await firstCtx.waitUntil.mock.calls[0]?.[0];
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toMatchObject({
      jobSlug: plannerJobSlug(run.runId),
    });
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(1);

    const retryCtx = createExecutionCtx();
    const duplicate = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "failed", error: "duplicate" }),
      executionCtx: retryCtx,
      env: runtimeEnv,
    });
    expect(await duplicate.json()).toMatchObject({
      ignored: true,
      runStatus: "failed",
    });
    await retryCtx.waitUntil.mock.calls[0]?.[0];

    expect(destroyPlannerJob).toHaveBeenCalledTimes(2);
    expect(broadcastPlanArtifactUpdated).toHaveBeenCalledTimes(1);
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toBeUndefined();
  });

  it("reviewer result appends the thread message and completes the one-shot run", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      skill: "plan-review",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      skill: "plan-review",
      threadId: reviewer.threadId,
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "queued",
      error: null,
    });

    const res = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: "The plan is missing a rollback step.",
      }),
    });
    expect(await res.json()).toMatchObject({
      ok: true,
      runStatus: "completed",
    });

    const messages = thread.listMessages({ limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toMatchObject({
      role: "assistant",
      text: expect.stringContaining("rollback"),
    });
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "completed",
    });
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([
      {
        planArtifactId: plan.id,
        sourceKind: "reviewer",
        sourceId: reviewer.threadId,
        token: run.runId,
      },
    ]);
    const types = artifactStore
      .listPlannerRunEvents(run.runId)
      .map((event) => event.type);
    expect(types).toEqual(
      expect.arrayContaining(["contribution_candidate", "run_completed"]),
    );
  });

  it("resumes a saved reviewer result without duplicating its message or terminal events", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      threadId: reviewer.threadId,
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "running",
      error: null,
    });

    let finishAttempts = 0;
    const asyncStore = asAsyncStub(artifactStore) as any;
    mocks.getArtifactStoreStub.mockReturnValue(
      new Proxy(asyncStore, {
        get(target, property, receiver) {
          if (property === "finishActiveReviewerRun") {
            return async (
              input: Parameters<
                typeof artifactStore.finishActiveReviewerRun
              >[0],
            ) => {
              finishAttempts += 1;
              if (finishAttempts === 1)
                throw new Error("transient ArtifactStore failure");
              return artifactStore.finishActiveReviewerRun(input);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );

    const first = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: "One durable result.",
      }),
    });
    expect(first.status).toBe(500);
    expect(artifactStore.getPlannerRun(run.runId)?.status).toBe("saving");
    expect(thread.listMessages({ limit: 10 })).toHaveLength(1);

    const retry = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: "One durable result.",
      }),
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ runStatus: "completed" });
    expect(thread.listMessages({ limit: 10 })).toHaveLength(1);
    expect(
      artifactStore
        .listPlannerRunEvents(run.runId)
        .filter(
          (event) =>
            event.type === "contribution_candidate" ||
            event.type === "run_completed",
        )
        .map((event) => event.type),
    ).toEqual(["contribution_candidate", "run_completed"]);
  });

  it("rejects a failure callback while a successful reviewer result is being saved", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      threadId: reviewer.threadId,
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "running",
      error: null,
    });
    expect(artifactStore.claimPlannerRunSaving(run.runId)).toMatchObject({
      status: "saving",
    });

    const executionCtx = createExecutionCtx();
    const response = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "failed",
        error: "callback delivery failed",
      }),
      executionCtx,
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Reviewer result is still being saved.",
    });
    const savedRun = artifactStore.getPlannerRun(run.runId);
    expect(savedRun).toMatchObject({ status: "saving" });
    expect(savedRun?.error).toBeUndefined();
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([]);
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([]);
    expect(executionCtx.waitUntil).not.toHaveBeenCalled();
  });

  it("finalizes overlapping reviewer result callbacks exactly once", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      threadId: reviewer.threadId,
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "running",
      error: null,
    });

    let signalFirstFinish!: () => void;
    const firstFinish = new Promise<void>((resolve) => {
      signalFirstFinish = resolve;
    });
    let signalBothFinishes!: () => void;
    const bothFinishes = new Promise<void>((resolve) => {
      signalBothFinishes = resolve;
    });
    let releaseFinishes!: () => void;
    const finishGate = new Promise<void>((resolve) => {
      releaseFinishes = resolve;
    });
    let finishCalls = 0;
    const asyncStore = asAsyncStub(artifactStore) as any;
    mocks.getArtifactStoreStub.mockReturnValue(
      new Proxy(asyncStore, {
        get(target, property, receiver) {
          if (property === "finishActiveReviewerRun") {
            return async (
              input: Parameters<
                typeof artifactStore.finishActiveReviewerRun
              >[0],
            ) => {
              finishCalls += 1;
              if (finishCalls === 1) signalFirstFinish();
              if (finishCalls === 2) signalBothFinishes();
              await finishGate;
              return artifactStore.finishActiveReviewerRun(input);
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );

    const request = () =>
      runtimeRequest(app, run.runId, "/result", {
        method: "POST",
        body: JSON.stringify({
          status: "succeeded",
          text: "One concurrent result.",
        }),
      });
    const first = request();
    await firstFinish;
    const second = request();
    await bothFinishes;
    releaseFinishes();

    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    await expect(
      Promise.all(responses.map((response) => response.json())),
    ).resolves.toEqual([
      expect.objectContaining({ runStatus: "completed" }),
      expect.objectContaining({ runStatus: "completed" }),
    ]);
    expect(thread.listMessages({ limit: 10 })).toHaveLength(1);
    expect(
      artifactStore
        .listPlannerRunEvents(run.runId)
        .filter(
          (event) =>
            event.type === "contribution_candidate" ||
            event.type === "run_completed",
        )
        .map((event) => event.type),
    ).toEqual(["contribution_candidate", "run_completed"]);
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([
      {
        planArtifactId: plan.id,
        sourceKind: "reviewer",
        sourceId: reviewer.threadId,
        token: run.runId,
      },
    ]);
  });

  it("does not publish or overwrite a newer reviewer run when cancellation wins the result race", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      skill: "plan-review",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const oldRun = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      threadId: reviewer.threadId,
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: oldRun.runId,
      status: "running",
      error: null,
    });

    let signalClaimStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => {
      signalClaimStarted = resolve;
    });
    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    const asyncStore = asAsyncStub(artifactStore) as any;
    const guardedStore = new Proxy(asyncStore, {
      get(target, property, receiver) {
        if (property === "claimPlannerRunSaving") {
          return async (runId: string) => {
            signalClaimStarted();
            await claimGate;
            return artifactStore.claimPlannerRunSaving(runId);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });
    mocks.getArtifactStoreStub.mockReturnValue(guardedStore);

    const resultRequest = runtimeRequest(app, oldRun.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "succeeded",
        text: "Stale reviewer feedback.",
      }),
    });
    await claimStarted;
    const cancelled = artifactStore.cancelActivePlannerRun(oldRun.runId);
    artifactStore.updateReviewerRunStateIfCurrent({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: oldRun.runId,
      status: cancelled.status,
      error: null,
    });
    const newRun = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "claude-code",
      model: "claude-sonnet-4.5",
      threadId: reviewer.threadId,
    });
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: newRun.runId,
      status: "queued",
      error: null,
    });
    releaseClaim();

    const response = await resultRequest;
    expect(await response.json()).toMatchObject({
      ignored: true,
      runStatus: "cancelled",
    });
    expect(thread.listMessages({ limit: 10 })).toHaveLength(0);
    expect(
      artifactStore.updateReviewerRunStateIfCurrent({
        repoId: "repo-1",
        planArtifactId: plan.id,
        threadId: reviewer.threadId,
        runId: oldRun.runId,
        status: "failed",
        error: "late failure",
      }),
    ).toBeNull();
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      runId: newRun.runId,
      status: "queued",
    });
  });

  it("records reported failures with the error message", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });

    const res = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({
        status: "failed",
        error: "codex exec exited with code 1",
      }),
    });
    expect(await res.json()).toMatchObject({ runStatus: "failed" });
    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({
      status: "failed",
      error: "codex exec exited with code 1",
    });
    const types = artifactStore
      .listPlannerRunEvents(run.runId)
      .map((event) => event.type);
    expect(types).toContain("run_failed");
  });
});

describe("planner run watchdog", () => {
  let artifactStore: InstanceType<typeof ArtifactStoreDO>;
  let threads: Map<string, InstanceType<typeof ThreadDO>>;

  beforeEach(() => {
    artifactStore = createStore();
    threads = new Map();
    vi.resetAllMocks();
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: false });
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.getOrCreateSecret.mockResolvedValue("test-runtime-secret");
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getPlannerRunStub.mockReturnValue({
      destroyPlannerJob: vi.fn().mockResolvedValue(undefined),
    });
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
    const loadedRepo = {
      ok: true,
      repo: {
        meta: {
          repoId: "repo-1",
          repoUrl: "https://github.com/test/repo",
          artifactStoreGeneration: "generation-1",
          mainCommit: "main-1",
        },
        workspace: {},
      },
    };
    mocks.loadTrackedRepo.mockResolvedValue(loadedRepo);
    mocks.loadTrackedRepoForRequest.mockResolvedValue(loadedRepo);
  });

  function createPlan() {
    return artifactStore.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Plan" },
      status: "draft",
      createdBy: "test",
    });
  }

  function createStaleRun(planArtifactId: string, threadId?: string) {
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      ...(threadId ? { threadId } : {}),
      startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });
    return run;
  }

  function createStaleSavingReviewer(planArtifactId: string) {
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId,
      provider: "codex",
      model: "gpt-5.5",
    });
    const thread = createThread();
    threads.set(reviewer.threadId, thread);
    thread.createThread({
      id: reviewer.threadId,
      scope: { type: "repo", repoId: "repo-1" },
      kind: "chat",
    });
    const run = createStaleRun(planArtifactId, reviewer.threadId);
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "running",
      error: null,
    });
    expect(artifactStore.claimPlannerRunSaving(run.runId)).toMatchObject({
      status: "saving",
    });
    return { reviewer, run, thread };
  }

  it("fails a stale active run on GET runs/:runId", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const stale = createStaleRun(plan.id);

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${stale.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;
    expect(body.run.status).toBe("failed");
    expect(body.run.error).toContain("timed out");
    expect(body.events.map((event: { type: string }) => event.type)).toContain(
      "run_failed",
    );
  });

  it("retries retained runtime cleanup when a terminal run is polled", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createStaleRun(plan.id);
    artifactStore.updatePlannerRun({
      runId: run.runId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "Dispatch failed.",
    });

    const executionCtx = createExecutionCtx();
    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${run.runId}`,
      {},
      createEnv({ PLANNER_RUN: {} }) as any,
      executionCtx as any,
    );

    expect(((await res.json()) as any).run).toMatchObject({
      status: "failed",
      runtime: { jobSlug: plannerJobSlug(run.runId) },
    });
    expect(executionCtx.waitUntil).toHaveBeenCalledTimes(1);
    await executionCtx.waitUntil.mock.calls[0]?.[0];
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toBeUndefined();
  });

  it("recovers a durable reviewer result left in saving", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const { reviewer, run, thread } = createStaleSavingReviewer(plan.id);
    thread.appendMessage({
      id: `reviewer-result:${run.runId}`,
      senderSessionId: "assistant",
      seq: 1,
      kind: "chat",
      body: {
        role: "assistant",
        text: "Recovered reviewer feedback.",
        runId: run.runId,
      },
      artifactIds: [plan.id],
    });

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${run.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;

    expect(body.run.status).toBe("completed");
    expect(thread.listMessages({ limit: 10 })).toHaveLength(1);
    expect(body.events.map((event: { type: string }) => event.type)).toEqual([
      "contribution_candidate",
      "run_completed",
    ]);
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "completed",
    });
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([
      {
        planArtifactId: plan.id,
        sourceKind: "reviewer",
        sourceId: reviewer.threadId,
        token: run.runId,
      },
    ]);
  });

  it("abandons a stale saving run only when no durable result exists", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const { reviewer, run, thread } = createStaleSavingReviewer(plan.id);

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${run.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;

    expect(body.run).toMatchObject({
      status: "failed",
      error: expect.stringContaining("timed out"),
    });
    expect(thread.listMessages({ limit: 10 })).toEqual([]);
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "failed",
    });
    expect(artifactStore.listPlanAttention("repo-1")).toEqual([
      expect.objectContaining({
        sourceId: reviewer.threadId,
        token: run.runId,
      }),
    ]);
  });

  it("does not abandon saving after a result callback records fresh contact", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const { run } = createStaleSavingReviewer(plan.id);
    expect(
      artifactStore.getPlannerRunAndRecordContact(run.runId),
    ).toMatchObject({
      status: "saving",
      lastContactAt: expect.any(String),
    });

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${run.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;

    expect(body.run.status).toBe("saving");
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([]);
  });

  it("does not fail a long run with recent server-owned lifecycle contact", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const stale = createStaleRun(plan.id);
    artifactStore.appendPlannerRunEvent({
      runId: stale.runId,
      repoId: "repo-1",
      planArtifactId: plan.id,
      type: "runtime_startup",
      message: "Reviewer runtime started.",
    });

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${stale.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;
    expect(body.run.status).toBe("queued");
    expect(artifactStore.getPlannerRun(stale.runId)).toMatchObject({
      status: "queued",
    });
  });

  it.each(["queued", "running"] as const)(
    "rechecks callback contact before failing a stale %s run",
    async (status) => {
      const app = createTestApp();
      const plan = createPlan();
      const stale = createStaleRun(plan.id);
      if (status === "running") {
        artifactStore.updateActivePlannerRun({
          runId: stale.runId,
          status: "running",
        });
      }
      const asyncStore = asAsyncStub(artifactStore) as any;
      mocks.getArtifactStoreStub.mockReturnValue(
        new Proxy(asyncStore, {
          get(target, property, receiver) {
            if (property === "finishActiveReviewerRun") {
              return async (
                input: Parameters<
                  typeof artifactStore.finishActiveReviewerRun
                >[0],
              ) => {
                // Simulate a valid result callback reaching ArtifactStore after
                // the watchdog's initial snapshot but before finalization.
                artifactStore.getPlannerRunAndRecordContact(stale.runId);
                return artifactStore.finishActiveReviewerRun(input);
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      );

      const res = await app.request(
        `/api/repos/repo-1/plans/${plan.id}/runs/${stale.runId}`,
        {},
        createEnv() as any,
      );
      const body = (await res.json()) as any;

      expect(body.run.status).toBe(status);
      expect(body.run.lastContactAt).toEqual(expect.any(String));
      expect(body.events).toEqual([]);
    },
  );

  it.each(["queued", "running"] as const)(
    "lets a valid heartbeat fence watchdog failure for a stale %s run",
    async (status) => {
      const app = createTestApp();
      const plan = createPlan();
      const stale = createStaleRun(plan.id);
      if (status === "running") {
        artifactStore.updateActivePlannerRun({
          runId: stale.runId,
          status: "running",
        });
      }
      const asyncStore = asAsyncStub(artifactStore) as any;
      mocks.getArtifactStoreStub.mockReturnValue(
        new Proxy(asyncStore, {
          get(target, property, receiver) {
            if (property === "acceptReviewerRuntimeEventBatch") {
              return async (
                runId: string,
                events: Parameters<
                  typeof artifactStore.acceptReviewerRuntimeEventBatch
                >[1],
              ) => {
                const accepted = artifactStore.acceptReviewerRuntimeEventBatch(
                  runId,
                  events,
                );
                artifactStore.finishActiveReviewerRun({
                  runId,
                  repoId: "repo-1",
                  planArtifactId: plan.id,
                  status: "failed",
                  completedAt: new Date().toISOString(),
                  error: "Timed out.",
                  staleActiveCutoff: new Date(
                    Date.now() - 15 * 60 * 1000,
                  ).toISOString(),
                  events: [{ type: "run_failed", message: "Timed out." }],
                });
                return accepted;
              };
            }
            return Reflect.get(target, property, receiver);
          },
        }),
      );
      const token = await mintPlannerRunToken({} as any, stale.runId);

      const poll = await app.request(
        `/api/planner-runtime/repos/repo-1/runs/${stale.runId}/events`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tiller-Planner-Run-Token": token,
          },
          body: JSON.stringify({ events: [] }),
        },
        createEnv() as any,
      );

      expect(await poll.json()).toMatchObject({ ok: true, runStatus: status });
      expect(artifactStore.getPlannerRun(stale.runId)).toMatchObject({
        status,
        lastContactAt: expect.any(String),
      });
      expect(artifactStore.listPlannerRunEvents(stale.runId)).toEqual([]);
    },
  );

  it("does not regress a cancelled reviewer when startup loses the transaction order", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const reviewer = artifactStore.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
    });
    const run = createStaleRun(plan.id, reviewer.threadId);
    artifactStore.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "queued",
      error: null,
    });
    const asyncStore = asAsyncStub(artifactStore) as any;
    mocks.getArtifactStoreStub.mockReturnValue(
      new Proxy(asyncStore, {
        get(target, property, receiver) {
          if (property === "acceptReviewerRuntimeEventBatch") {
            return async (
              runId: string,
              events: Parameters<
                typeof artifactStore.acceptReviewerRuntimeEventBatch
              >[1],
            ) => {
              const cancelled = artifactStore.cancelActivePlannerRun(runId);
              artifactStore.updateReviewerRunStateIfCurrent({
                repoId: "repo-1",
                planArtifactId: plan.id,
                threadId: reviewer.threadId,
                runId,
                status: cancelled.status,
                error: null,
              });
              return artifactStore.acceptReviewerRuntimeEventBatch(
                runId,
                events,
              );
            };
          }
          return Reflect.get(target, property, receiver);
        },
      }),
    );
    const token = await mintPlannerRunToken({} as any, run.runId);

    const response = await app.request(
      `/api/planner-runtime/repos/repo-1/runs/${run.runId}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Planner-Run-Token": token,
        },
        body: JSON.stringify({ events: [{ type: "runtime_startup" }] }),
      },
      createEnv() as any,
    );

    expect(await response.json()).toMatchObject({
      ok: true,
      ignored: true,
      runStatus: "cancelled",
    });
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "cancelled",
    });
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([]);
  });

  it("treats empty runtime status polls as infrastructure liveness", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const stale = createStaleRun(plan.id);
    const token = await mintPlannerRunToken({} as any, stale.runId);
    const poll = await app.request(
      `/api/planner-runtime/repos/repo-1/runs/${stale.runId}/events`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Planner-Run-Token": token,
        },
        body: JSON.stringify({ events: [] }),
      },
      createEnv() as any,
    );
    expect(poll.status).toBe(200);

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${stale.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;
    expect(body.run.status).toBe("queued");
  });

  it("fails a run whose last event is also older than the stale window", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const stale = createStaleRun(plan.id);
    artifactStore.appendPlannerRunEvent({
      runId: stale.runId,
      repoId: "repo-1",
      planArtifactId: plan.id,
      type: "runtime_startup",
      message: "Reviewer runtime started.",
      createdAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/${stale.runId}`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;
    expect(body.run.status).toBe("failed");
    expect(body.run.error).toContain("timed out");
  });

  it("fails a stale active run on GET runs/latest", async () => {
    const app = createTestApp();
    const plan = createPlan();
    createStaleRun(plan.id);

    const res = await app.request(
      `/api/repos/repo-1/plans/${plan.id}/runs/latest?role=reviewer`,
      {},
      createEnv() as any,
    );
    const body = (await res.json()) as any;
    expect(body.run.status).toBe("failed");
  });
});
