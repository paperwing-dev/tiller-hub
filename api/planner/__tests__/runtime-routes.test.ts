import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";
import { MAX_PLAN_MARKDOWN_BYTES } from "../../coordination/planning";
import { plannerJobSlug } from "../dispatch";
import { planWriterTerminalId } from "../plan-writer-contract";
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
  const actual = await vi.importActual<typeof import("../../codex-runtime-auth")>("../../codex-runtime-auth");
  return {
    ...actual,
    exchangeCodexRuntimeAuth: mocks.exchangeCodexRuntimeAuth,
  };
});

vi.mock("../../setup/config", () => ({
  getSecret: mocks.getSecret,
  getOrCreateSecret: mocks.getOrCreateSecret,
}));

const [
  { default: plannerRoutes },
  { default: plannerRuntimeRoutes },
  { mintPlannerRunToken, mintPlanWriterRuntimeToken },
] = await Promise.all([
  import("../routes"),
  import("../runtime-routes"),
  import("../runtime-token"),
]);

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", plannerRoutes);
  app.route("/", plannerRuntimeRoutes);
  return app;
}

function createEnv(overrides: Record<string, unknown> = {}) {
  return {
    TILLER_ENABLE_FAKE_PLANNER_PROVIDER: "1",
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
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getPlannerRunStub.mockReturnValue({
      destroyPlannerJob: vi.fn().mockResolvedValue(undefined),
    });
    mocks.getThreadStub.mockImplementation((_env: unknown, threadId: string) => {
      let thread = threads.get(threadId);
      if (!thread) {
        thread = createThread();
        threads.set(threadId, thread);
      }
      return asAsyncStub(thread);
    });
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
    input: Parameters<InstanceType<typeof ArtifactStoreDO>["createPlannerRun"]>[0],
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
    input: Parameters<InstanceType<typeof ArtifactStoreDO>["startPlanWriter"]>[0],
  ) {
    const launchProvenance = input.launchProvenance ?? {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
    };
    const writer = artifactStore.startPlanWriter({
      ...input,
      launchProvenance,
    });
    artifactStore.setPlanWriterRuntimeIfCurrent(writer.threadId, {
      jobSlug: planWriterTerminalId("repo-1", writer.planArtifactId, writer.generation!),
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
    init: RequestInit & { token?: string | null; env?: Record<string, unknown> } = {},
  ) {
    const token = init.token === undefined
      ? await mintPlanWriterRuntimeToken({} as any, "repo-1", planArtifactId, generation)
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

    const first = await app.request(`/api/repos/repo-1/plans/${plan.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "# Manual title\n\nNew body." }),
    }, createEnv() as any);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      artifact: {
        title: "Manual title",
        body: { markdown: "# Manual title\n\nNew body." },
        basis: { mainCommit: "main-1", envSlug: "env-1" },
        status: "evaluating",
        version: 2,
      },
    });

    const renamed = await app.request(`/api/repos/repo-1/plans/${plan.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "## Title\n\nRenamed manual title\n\n## Summary\nNew body." }),
    }, createEnv() as any);
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({
      artifact: {
        title: "Renamed manual title",
        body: { markdown: "## Title\n\nRenamed manual title\n\n## Summary\nNew body." },
        version: 3,
      },
    });

    const empty = await app.request(`/api/repos/repo-1/plans/${plan.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "" }),
    }, createEnv() as any);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toMatchObject({
      artifact: { title: "Renamed manual title", body: { markdown: "" }, version: 4 },
    });
  });

  it("rejects oversized Markdown and read-only plan statuses", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const oversized = await app.request(`/api/repos/repo-1/plans/${plan.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: `${"a".repeat(MAX_PLAN_MARKDOWN_BYTES - 1)}é` }),
    }, createEnv() as any);
    expect(oversized.status).toBe(413);
    expect(artifactStore.getArtifact(plan.id)).toMatchObject({ version: 1, body: plan.body });

    artifactStore.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "completed" });
    const completed = await app.request(`/api/repos/repo-1/plans/${plan.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "Cannot save" }),
    }, createEnv() as any);
    expect(completed.status).toBe(409);

    const archivedVersion = artifactStore.getArtifact(plan.id)?.version;
    artifactStore.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "archived",
      expectedVersion: archivedVersion,
    });
    const archived = await app.request(`/api/repos/repo-1/plans/${plan.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "Still cannot save" }),
    }, createEnv() as any);
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
    const changedAccount = await runtimeRequest(app, run.runId, "/runtime-auth", {
      method: "POST",
      env: {},
      body: "{}",
    });
    expect(changedAccount.status).toBe(409);
    expect(await changedAccount.json()).toMatchObject({ code: "needs_reconnect" });

    artifactStore.updateActivePlannerRun({ runId: run.runId, status: "cancelled" });
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
      artifactStore.updateActivePlannerRun({ runId: run.runId, status: "cancelled" });
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
    expect(await wrongGeneration.json()).toMatchObject({ code: "runtime_inactive" });

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
    expect(await changedAccount.json()).toMatchObject({ code: "needs_reconnect" });
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

    const missing = await runtimeRequest(app, run.runId, "/context", { token: null });
    expect(missing.status).toBe(401);

    const wrong = await runtimeRequest(app, run.runId, "/context", { token: "not-the-token" });
    expect(wrong.status).toBe(401);

    const wrongRun = await runtimeRequest(app, "nonexistent-run", "/context", { token: "junk" });
    expect(wrongRun.status).toBe(401);

    const validForMissing = await runtimeRequest(app, "nonexistent-run", "/context");
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
    const runResponse = await runtimeRequest(app, residualRun.runId, "/context");
    expect(runResponse.status).toBe(404);
    expect(artifactStore.getPlannerRun(residualRun.runId)?.lastContactAt).toBeUndefined();

    const residualWriter = artifactStore.startPlanWriter({
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

    const response = await writerRuntimeRequest(app, plan.id, writer.generation!, "/stop", {
      method: "POST",
      body: JSON.stringify({
        reason: "runtime_ended",
        startupError: "Provider exited before the native composer became available.",
      }),
    });

    expect(response.status).toBe(200);
    expect(artifactStore.getPlanWriter("repo-1", plan.id)).toMatchObject({
      stopReason: "runtime_ended",
      startupError: "Provider exited before the native composer became available.",
    });
    expect(artifactStore.getPlanWriter("repo-1", plan.id)?.stoppedAt).toBeTruthy();
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
    thread.createThread({ id: reviewer.threadId, scope: { type: "repo", repoId: "repo-1" }, kind: "chat" });
    thread.appendMessage({ senderSessionId: "user", seq: 1, kind: "chat", body: { role: "user", text: "What about rollback?" } });
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
    const body = await res.json() as any;
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
    expect(artifactStore.getPlannerRun(run.runId)?.lastContactAt).toBeUndefined();
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
    expect(artifactStore.getPlannerRun(run.runId)?.lastContactAt).toBeUndefined();
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

    artifactStore.updatePlannerRun({ runId: run.runId, status: "cancelled", completedAt: new Date().toISOString() });
    const afterCancel = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({ events: [] }),
    });
    expect(await afterCancel.json()).toMatchObject({ ignored: true, runStatus: "cancelled" });
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

    expect(await response.json()).toMatchObject({ ok: true, ignored: true, runStatus: "cancelled" });
    expect(artifactStore.listPlannerRunEvents(run.runId)).toHaveLength(0);
    expect(artifactStore.getPlannerRun(run.runId)?.lastContactAt).toBeUndefined();
  });

  it("flips queued to running on runtime_startup", async () => {
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
      body: JSON.stringify({
        events: [{ type: "runtime_startup", message: "provider-controlled", data: { command: "secret" } }],
      }),
    });
    expect(await res.json()).toMatchObject({ runStatus: "running" });
    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({ status: "running" });
    expect(artifactStore.listPlannerRunEvents(run.runId)).toEqual([
      expect.objectContaining({
        type: "runtime_startup",
        message: "Reviewer runtime started.",
      }),
    ]);
    expect(artifactStore.listPlannerRunEvents(run.runId)[0]?.data).toBeUndefined();

    const activity = await runtimeRequest(app, run.runId, "/events", {
      method: "POST",
      body: JSON.stringify({
        events: [{ type: "model_activity", message: "Running: rg -n reviewer packages/hub" }],
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
    thread.createThread({ id: reviewer.threadId, scope: { type: "repo", repoId: "repo-1" }, kind: "chat" });
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
    expect(thread.listMessages({ limit: 10 })[0].body).toMatchObject({ text: "First result." });

    const cancelledRun = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
    });
    artifactStore.updatePlannerRun({ runId: cancelledRun.runId, status: "cancelled", completedAt: new Date().toISOString() });
    const late = await runtimeRequest(app, cancelledRun.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "succeeded", text: "Late result." }),
    });
    expect(await late.json()).toMatchObject({ ignored: true, runStatus: "cancelled" });
    expect(artifactStore.getPlannerRun(cancelledRun.runId)).toMatchObject({ status: "cancelled" });
  });

  it("retries retained runtime cleanup when a duplicate terminal result arrives", async () => {
    const app = createTestApp();
    const plan = createPlan();
    const run = createCurrentPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      threadId: "thread-cleanup-retry",
    });
    const destroyPlannerJob = vi.fn()
      .mockRejectedValueOnce(new Error("transient cleanup failure"))
      .mockResolvedValueOnce(undefined);
    mocks.getPlannerRunStub.mockReturnValue({ destroyPlannerJob });

    const firstCtx = createExecutionCtx();
    const first = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "failed", error: "review failed" }),
      executionCtx: firstCtx,
    });
    expect(await first.json()).toMatchObject({ runStatus: "failed" });
    await firstCtx.waitUntil.mock.calls[0]?.[0];
    expect(artifactStore.getPlannerRun(run.runId)?.runtime).toMatchObject({
      jobSlug: plannerJobSlug(run.runId),
    });

    const retryCtx = createExecutionCtx();
    const duplicate = await runtimeRequest(app, run.runId, "/result", {
      method: "POST",
      body: JSON.stringify({ status: "failed", error: "duplicate" }),
      executionCtx: retryCtx,
    });
    expect(await duplicate.json()).toMatchObject({ ignored: true, runStatus: "failed" });
    await retryCtx.waitUntil.mock.calls[0]?.[0];

    expect(destroyPlannerJob).toHaveBeenCalledTimes(2);
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
    thread.createThread({ id: reviewer.threadId, scope: { type: "repo", repoId: "repo-1" }, kind: "chat" });
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
    expect(await res.json()).toMatchObject({ ok: true, runStatus: "completed" });

    const messages = thread.listMessages({ limit: 10 });
    expect(messages).toHaveLength(1);
    expect(messages[0].body).toMatchObject({ role: "assistant", text: expect.stringContaining("rollback") });
    expect(artifactStore.getReviewer(reviewer.threadId)).toMatchObject({
      status: "completed",
    });
    const types = artifactStore.listPlannerRunEvents(run.runId).map((event) => event.type);
    expect(types).toEqual(expect.arrayContaining(["contribution_candidate", "run_completed"]));
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
    thread.createThread({ id: reviewer.threadId, scope: { type: "repo", repoId: "repo-1" }, kind: "chat" });
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
      body: JSON.stringify({ status: "succeeded", text: "Stale reviewer feedback." }),
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
    expect(await response.json()).toMatchObject({ ignored: true, runStatus: "cancelled" });
    expect(thread.listMessages({ limit: 10 })).toHaveLength(0);
    expect(artifactStore.updateReviewerRunStateIfCurrent({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: oldRun.runId,
      status: "failed",
      error: "late failure",
    })).toBeNull();
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
      body: JSON.stringify({ status: "failed", error: "codex exec exited with code 1" }),
    });
    expect(await res.json()).toMatchObject({ runStatus: "failed" });
    expect(artifactStore.getPlannerRun(run.runId)).toMatchObject({
      status: "failed",
      error: "codex exec exited with code 1",
    });
    const types = artifactStore.listPlannerRunEvents(run.runId).map((event) => event.type);
    expect(types).toContain("run_failed");
  });
});

describe("planner run watchdog", () => {
  let artifactStore: InstanceType<typeof ArtifactStoreDO>;

  beforeEach(() => {
    artifactStore = createStore();
    vi.resetAllMocks();
    mocks.getOpenAIStatus.mockResolvedValue({ authenticated: false });
    mocks.getSecret.mockResolvedValue(undefined);
    mocks.getOrCreateSecret.mockResolvedValue("test-runtime-secret");
    mocks.getArtifactStoreStub.mockReturnValue(asAsyncStub(artifactStore));
    mocks.getThreadStub.mockImplementation(() => asAsyncStub(createThread()));
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

  function createStaleRun(planArtifactId: string) {
    const run = artifactStore.createPlannerRun({
      repoId: "repo-1",
      planArtifactId,
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    artifactStore.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });
    return run;
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
    const body = await res.json() as any;
    expect(body.run.status).toBe("failed");
    expect(body.run.error).toContain("timed out");
    expect(body.events.map((event: { type: string }) => event.type)).toContain("run_failed");
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
    const body = await res.json() as any;
    expect(body.run.status).toBe("queued");
    expect(artifactStore.getPlannerRun(stale.runId)).toMatchObject({ status: "queued" });
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
        headers: { "Content-Type": "application/json", "X-Tiller-Planner-Run-Token": token },
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
    const body = await res.json() as any;
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
    const body = await res.json() as any;
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
    const body = await res.json() as any;
    expect(body.run.status).toBe("failed");
  });

});
