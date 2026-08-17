import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../../types";

const mocks = vi.hoisted(() => ({
  appendThreadMessage: vi.fn(),
  cleanupEnvReviewRunRuntime: vi.fn(),
  getEnvReviewStub: vi.fn(),
  getThreadStub: vi.fn(),
  verifyEnvReviewRunToken: vi.fn(),
  exchangeCodexRuntimeAuth: vi.fn(),
}));

vi.mock("../../planner/runtime", () => ({
  appendThreadMessage: mocks.appendThreadMessage,
}));
vi.mock("../../helpers", () => ({
  getEnvReviewStub: mocks.getEnvReviewStub,
  getThreadStub: mocks.getThreadStub,
}));
vi.mock("../runtime-token", () => ({
  verifyEnvReviewRunToken: mocks.verifyEnvReviewRunToken,
}));
vi.mock("../dispatch", () => ({
  cleanupEnvReviewRunRuntime: mocks.cleanupEnvReviewRunRuntime,
  envReviewJobSlug: (runId: string) => `env-review-${runId}`,
  resolveNewEnvReviewLaunchProvenance: vi.fn(),
}));
vi.mock("../../codex-runtime-auth", async () => {
  const actual = await vi.importActual<typeof import("../../codex-runtime-auth")>("../../codex-runtime-auth");
  return {
    ...actual,
    exchangeCodexRuntimeAuth: mocks.exchangeCodexRuntimeAuth,
  };
});

const { default: envReviewRuntimeRoutes } = await import("../runtime-routes");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.use("*", async (c, next) => {
    c.set("authorization", { kind: "specialized" });
    return next();
  });
  app.route("/", envReviewRuntimeRoutes);
  return app;
}

function currentRun<T extends { runId: string }>(run: T) {
  const launchProvenance = "launchProvenance" in run && run.launchProvenance
    ? { schemaVersion: 1 as const, ...run.launchProvenance }
    : { schemaVersion: 1 as const, backend: "cf" as const, machineId: null };
  const suppliedRuntime = "runtime" in run ? run.runtime : null;
  const runtime = suppliedRuntime && typeof suppliedRuntime === "object" && "jobSlug" in suppliedRuntime
    ? { jobSlug: suppliedRuntime.jobSlug }
    : { jobSlug: `env-review-${run.runId}` };
  return {
    ...run,
    launchProvenance,
    runtime,
  };
}

describe("env review runtime context", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.verifyEnvReviewRunToken.mockResolvedValue(true);
    mocks.cleanupEnvReviewRunRuntime.mockResolvedValue(undefined);
    mocks.exchangeCodexRuntimeAuth.mockResolvedValue({
      ok: true,
      access_token: "runtime-access-token",
      account_id: "chatgpt-account",
      expires_at: "2026-07-13T20:00:00.000Z",
    });
  });

  it("fails closed for a residual review record without runtime provenance", async () => {
    const getRun = vi.fn(async () => ({
      runId: "run-residual",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "queued",
      prompt: "Do not execute this residual record.",
    }));
    mocks.getEnvReviewStub.mockReturnValue({ getRun });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-residual/context",
      { headers: { "X-Tiller-Env-Review-Run-Token": "run-token" } },
      {} as any,
    );

    expect(response.status).toBe(404);
    expect(getRun).toHaveBeenCalledOnce();
    expect(mocks.appendThreadMessage).not.toHaveBeenCalled();
    expect(mocks.cleanupEnvReviewRunRuntime).not.toHaveBeenCalled();
  });

  it("exchanges credentials only for an authorized active subscription leaf run", async () => {
    const run = currentRun({
      runId: "run-auth",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "running",
      runtime: { backend: "cf", machineId: null, jobSlug: "env-review-run-auth" },
      launchProvenance: {
        backend: "cf",
        machineId: null,
        codexExecution: {
          kind: "subscription-app-server",
          surface: "environment-reviewer",
          backend: "cf",
        },
      },
    });
    let pinnedAccountId: string | null = null;
    const acceptCodexRuntimeAuth = vi.fn(async (_runId: string, accountId: string) => {
      if (pinnedAccountId && pinnedAccountId !== accountId) return "account_changed" as const;
      pinnedAccountId = accountId;
      return "accepted" as const;
    });
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
      acceptCodexRuntimeAuth,
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-auth/runtime-auth",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Env-Review-Run-Token": "run-token",
        },
        body: JSON.stringify({ rejected_access_token_sha256: "c".repeat(64) }),
      },
      {} as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      access_token: "runtime-access-token",
      account_id: "chatgpt-account",
      expires_at: "2026-07-13T20:00:00.000Z",
    });
    expect(mocks.exchangeCodexRuntimeAuth).toHaveBeenCalledWith(
      expect.anything(),
      "c".repeat(64),
    );

    mocks.exchangeCodexRuntimeAuth.mockResolvedValueOnce({
      ok: true,
      access_token: "replacement-token",
      account_id: "different-account",
      expires_at: "2026-07-13T21:00:00.000Z",
    });
    const changedAccount = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-auth/runtime-auth",
      {
        method: "POST",
        headers: { "X-Tiller-Env-Review-Run-Token": "run-token" },
        body: "{}",
      },
      {} as any,
      { waitUntil: vi.fn() } as any,
    );
    expect(changedAccount.status).toBe(409);
    expect(await changedAccount.json()).toMatchObject({ code: "needs_reconnect" });

    mocks.verifyEnvReviewRunToken.mockResolvedValue(false);
    mocks.exchangeCodexRuntimeAuth.mockClear();
    const unauthorized = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-auth/runtime-auth",
      {
        method: "POST",
        headers: { "X-Tiller-Env-Review-Run-Token": "wrong" },
      },
      {} as any,
    );
    expect(unauthorized.status).toBe(401);
    expect(mocks.exchangeCodexRuntimeAuth).not.toHaveBeenCalled();
  });

  it("rejects terminal subscription reviewer exchanges", async () => {
    const activeRun = currentRun({
      runId: "run-fenced",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "running",
      runtime: { backend: "cf", machineId: null, jobSlug: "env-review-run-fenced" },
      launchProvenance: {
        backend: "cf",
        machineId: null,
        codexExecution: {
          kind: "subscription-app-server",
          surface: "environment-reviewer",
          backend: "cf",
        },
      },
    });
    const getRun = vi.fn(async () => activeRun);
    mocks.getEnvReviewStub.mockReturnValue({
      getRun,
      acceptCodexRuntimeAuth: vi.fn(async () => "inactive" as const),
    });

    getRun.mockResolvedValue({ ...activeRun, status: "ready" });
    const terminal = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-fenced/runtime-auth",
      { method: "POST", headers: { "X-Tiller-Env-Review-Run-Token": "run-token" } },
      {} as any,
    );
    expect(terminal.status).toBe(409);
    expect(await terminal.json()).toMatchObject({ code: "runtime_inactive" });
    expect(mocks.exchangeCodexRuntimeAuth).not.toHaveBeenCalled();
  });

  it("does not return credentials when the review becomes terminal during exchange", async () => {
    const activeRun = currentRun({
      runId: "run-race",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "running",
      runtime: { backend: "cf", machineId: null, jobSlug: "env-review-run-race" },
      launchProvenance: {
        backend: "cf",
        machineId: null,
        codexExecution: {
          kind: "subscription-app-server",
          surface: "environment-reviewer",
          backend: "cf",
        },
      },
    });
    const getRun = vi.fn(async () => activeRun);
    mocks.getEnvReviewStub.mockReturnValue({
      getRun,
      acceptCodexRuntimeAuth: vi.fn(async () => "inactive" as const),
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-race/runtime-auth",
      { method: "POST", headers: { "X-Tiller-Env-Review-Run-Token": "run-token" } },
      {} as any,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "runtime_inactive" });
  });

  it("returns the persisted effort to the provider runtime", async () => {
    const run = currentRun({
      runId: "run-1",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "claude-code",
      model: "sonnet",
      effort: "max",
      roleLabel: "Bug Reviewer",
      skillRunRole: "report_initial",
      status: "queued",
      prompt: "Review this workspace.",
      preparation: {
        status: "succeeded",
        snapshot: {
          snapshotId: "snapshot-1",
          githubDeletedPaths: ["src/old.ts"],
        },
      },
      changeContext: { summary: { total: 1 } },
      planBasis: { source: "none" },
    });
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-1/context",
      { headers: { "X-Tiller-Env-Review-Run-Token": "run-token" } },
      {} as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: {
        runId: "run-1",
        provider: "claude-code",
        model: "sonnet",
        effort: "max",
        requiresRepositoryInspection: true,
      },
      workspace: {
        githubDeletedPaths: ["src/old.ts"],
      },
    });
  });

  it("exempts synthesis-only Overview runs from repository inspection", async () => {
    const run = currentRun({
      runId: "run-overview",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Code Review Overview",
      skillRunRole: "overview",
      status: "queued",
      prompt: "Synthesize only the frozen child reports.",
      preparation: {
        status: "succeeded",
        snapshot: {
          snapshotId: "snapshot-1",
          githubDeletedPaths: [],
        },
      },
    });
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-overview/context",
      { headers: { "X-Tiller-Env-Review-Run-Token": "run-token" } },
      {} as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      run: { requiresRepositoryInspection: false },
    });
  });

  it("serves the complete frozen change material for reviewer inspection", async () => {
    const run = currentRun({
      runId: "run-inspection",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Bug Reviewer",
      status: "queued",
      prompt: "Review this workspace.",
      preparation: {
        status: "succeeded",
        snapshot: {
          snapshotId: "snapshot-1",
          githubDeletedPaths: [],
        },
      },
    });
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
    });
    const get = vi.fn(async () => ({ body: new Uint8Array([1, 2, 3]) }));

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-inspection/inspection.tar",
      { headers: { "X-Tiller-Env-Review-Run-Token": "run-token" } },
      { BUCKET: { get } } as any,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-tar");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(get).toHaveBeenCalledWith("envs/env-1/review-snapshots/snapshot-1.inspection.tar");
  });

  it("rejects legacy provider events without recording contact", async () => {
    const queuedRun = currentRun({
      runId: "run-events",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "claude-code",
      model: "sonnet",
      effort: "high",
      roleLabel: "Reviewer",
      status: "queued",
    });
    const recordRunContact = vi.fn(async () => undefined);
    const updateRun = vi.fn();
    const appendRunEvent = vi.fn(async () => undefined);
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => queuedRun),
      recordRunContact,
      updateRun,
      appendRunEvent,
    });

    for (const type of ["progress", "assistant_message"]) {
      const response = await createApp().request(
        "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-events/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tiller-Env-Review-Run-Token": "run-token",
          },
          body: JSON.stringify({ events: [{ type, message: "obsolete" }] }),
        },
        {} as any,
      );
      expect(response.status).toBe(400);
    }
    expect(recordRunContact).not.toHaveBeenCalled();
    expect(updateRun).not.toHaveBeenCalled();
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed event batches without recording contact", async () => {
    const run = currentRun({
      runId: "run-events",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "queued",
    });
    const recordRunContact = vi.fn(async () => undefined);
    const appendRunEvent = vi.fn(async () => undefined);
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
      recordRunContact,
      appendRunEvent,
    });

    for (const body of [
      "{",
      JSON.stringify({}),
      JSON.stringify({ events: null }),
      JSON.stringify({ events: [null] }),
    ]) {
      const response = await createApp().request(
        "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-events/events",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Tiller-Env-Review-Run-Token": "run-token",
          },
          body,
        },
        {} as any,
      );
      expect(response.status).toBe(400);
    }
    expect(recordRunContact).not.toHaveBeenCalled();
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("ignores model activity for terminal runs", async () => {
    const run = currentRun({
      runId: "run-terminal",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      status: "ready",
    });
    const recordRunContact = vi.fn(async () => undefined);
    const appendRunEvent = vi.fn(async () => undefined);
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
      recordRunContact,
      appendRunEvent,
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-terminal/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Env-Review-Run-Token": "run-token",
        },
        body: JSON.stringify({
          events: [{ type: "model_activity", message: "Late private command" }],
        }),
      },
      {} as any,
    );

    expect(await response.json()).toMatchObject({ ok: true, ignored: true, runStatus: "ready" });
    expect(recordRunContact).not.toHaveBeenCalled();
    expect(appendRunEvent).not.toHaveBeenCalled();
  });

  it("records current startup, model activity, and commentary events", async () => {
    const queuedRun = currentRun({
      runId: "run-events",
      envSlug: "env-1",
      repoId: "repo-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      roleLabel: "Reviewer",
      status: "queued",
    });
    const runningRun = { ...queuedRun, status: "running" };
    const recordRunContact = vi.fn(async () => undefined);
    const updateRun = vi.fn(async () => runningRun);
    const appendRunEvent = vi.fn(async () => undefined);
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => queuedRun),
      recordRunContact,
      updateRun,
      appendRunEvent,
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-events/events",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Env-Review-Run-Token": "run-token",
        },
        body: JSON.stringify({
          events: [
            { type: "runtime_startup", message: "provider controlled" },
            { type: "model_activity", message: "Read: packages/hub/src/EnvReviewPanel.tsx" },
            { type: "model_commentary", message: "I’m checking how the panel consumes events." },
          ],
        }),
      },
      {} as any,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, runStatus: "running" });
    expect(recordRunContact).toHaveBeenCalledWith("run-events");
    expect(updateRun).toHaveBeenCalledWith({ runId: "run-events", status: "running" });
    expect(appendRunEvent).toHaveBeenNthCalledWith(1, {
      runId: "run-events",
      type: "runtime_startup",
      message: "Reviewer runtime started.",
    });
    expect(appendRunEvent).toHaveBeenNthCalledWith(2, {
      runId: "run-events",
      type: "model_activity",
      message: "Read: packages/hub/src/EnvReviewPanel.tsx",
    });
    expect(appendRunEvent).toHaveBeenNthCalledWith(3, {
      runId: "run-events",
      type: "model_commentary",
      message: "I’m checking how the panel consumes events.",
    });
  });

  it("finalizes with the assistant message already stored under the stable id", async () => {
    const run = currentRun({
      runId: "run-result",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Reviewer",
      taskKind: "correctness",
      status: "running",
      skillInvocationId: null,
      skillRunRole: null,
      runtime: null,
    });
    const readyRun = { ...run, status: "ready" };
    const completeRunSuccessfully = vi.fn(async () => ({
      status: "completed",
      run: readyRun,
      feedback: null,
    }));
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
      completeRunSuccessfully,
    });
    mocks.getThreadStub.mockReturnValue({});
    mocks.appendThreadMessage.mockResolvedValue({
      id: "env-review-result:run-result",
      threadId: "thread-1",
      body: { role: "assistant", text: "First stored result", runId: "run-result" },
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-result/result",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Env-Review-Run-Token": "run-token",
        },
        body: JSON.stringify({ status: "succeeded", text: "Concurrent later result" }),
      },
      {} as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(response.status).toBe(200);
    expect(completeRunSuccessfully).toHaveBeenCalledWith(expect.objectContaining({
      messageId: "env-review-result:run-result",
      text: "First stored result",
    }));
  });

  it("rechecks Auto Overview when a successful initial result callback is retried", async () => {
    const run = currentRun({
      runId: "run-ready",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      roleLabel: "Reviewer",
      taskKind: "correctness",
      status: "ready",
      skillInvocationId: "invocation-1",
      skillRunRole: "report_initial",
      runtime: null,
    });
    const getSkillInvocation = vi.fn(async () => ({
      invocationId: "invocation-1",
      status: "active",
      overviewMode: "manual",
      definitionSnapshot: { agents: [{ id: "one" }, { id: "two" }] },
      overviewRunId: null,
    }));
    mocks.getEnvReviewStub.mockReturnValue({
      getRun: vi.fn(async () => run),
      getSkillInvocation,
    });

    const response = await createApp().request(
      "https://hub.test/api/env-review-runtime/envs/env-1/runs/run-ready/result",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Env-Review-Run-Token": "run-token",
        },
        body: JSON.stringify({ status: "succeeded", text: "Retry" }),
      },
      {} as any,
      { waitUntil: vi.fn() } as any,
    );

    expect(response.status).toBe(200);
    expect(getSkillInvocation).toHaveBeenCalledWith("invocation-1");
  });
});
