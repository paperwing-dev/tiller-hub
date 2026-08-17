import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

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

const mocks = vi.hoisted(() => ({
  loadEnvView: vi.fn(),
  getWorkspaceStub: vi.fn(),
}));

vi.mock("../../env/view", () => ({
  loadEnvView: mocks.loadEnvView,
}));

vi.mock("../../helpers", () => ({
  getWorkspaceStub: mocks.getWorkspaceStub,
  getThreadStub: vi.fn(),
}));

import { EnvReviewDO } from "../env-review-do";
import { DEFAULT_CODE_REVIEW_SKILL } from "../../planner/agent-skills";

const TEST_LAUNCH_PROVENANCE = {
  schemaVersion: 1 as const,
  backend: "cf" as const,
  machineId: null,
};

const TEST_OVERVIEW_ROUTE = {
  provider: "fake",
  model: "fake-fast",
  effort: "medium" as const,
};

type SqlResultRow = Record<string, unknown>;
const encoder = new TextEncoder();

function createSqlResult<T extends SqlResultRow>(rows: T[], rowsWritten = 0) {
  return {
    rowsWritten,
    toArray(): T[] {
      return rows;
    },
    one(): T {
      const row = rows[0];
      if (!row) throw new Error("No rows");
      return row;
    },
    *[Symbol.iterator](): IterableIterator<T> {
      yield* rows;
    },
  };
}

class FakeSqlStorage {
  private readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...params: SQLInputValue[]) {
    if (/^\s*(select|pragma)\b/i.test(query)) {
      const rows = this.db.prepare(query).all(...params) as SqlResultRow[];
      return createSqlResult(rows);
    }

    if (params.length > 0) {
      const result = this.db.prepare(query).run(...params);
      return createSqlResult([], Number(result.changes ?? 0));
    }

    this.db.exec(query);
    return createSqlResult([]);
  }

  close(): void {
    this.db.close();
  }
}

class FakeStorage {
  readonly sql = new FakeSqlStorage();
  private alarm: number | null = null;

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  close(): void {
    this.sql.close();
  }
}

function createSubject(storage = new FakeStorage(), env: Record<string, unknown> = {}) {
  mocks.loadEnvView.mockResolvedValue({
    slug: "env-1",
    repoId: "repo-1",
    scmModel: "github",
    githubBaseCommitSha: "base-sha",
    status: "running",
    lifecyclePhase: "running",
    scmOperationType: null,
    githubPublishStatus: "idle",
  });
  mocks.getWorkspaceStub.mockReturnValue({
    downloadTar: vi.fn(async () => new Uint8Array(1024)),
    globWorkspace: vi.fn(async () => [{ path: "/src/a.txt", type: "file" }]),
    readWorkspaceFileBytes: vi.fn(async (path: string) => path === "/src/a.txt" ? encoder.encode("a") : null),
    readGitHubDeletedWorkspacePaths: vi.fn(async () => []),
    computeWorkspaceTreeHash: vi.fn(async () => "workspace-hash"),
  });
  return {
    storage,
    review: new EnvReviewDO({ storage } as any, env as any),
  };
}

function createTab(review: EnvReviewDO) {
  return review.addReviewerTab({
    envSlug: "env-1",
    repoId: "repo-1",
    mainSessionId: "session-1",
    threadId: "thread-1",
    provider: "fake",
    model: "fake-fast",
    effort: "medium",
  });
}

describe("EnvReviewDO", () => {
  it("creates state on first access without touching updated_at on later reads", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
      const { storage, review } = createSubject();
      const input = {
        envSlug: "env-1",
        repoId: "repo-1",
        mainSessionId: "session-1",
      };

      const first = review.getState(input);
      vi.setSystemTime(new Date("2026-08-12T11:00:00.000Z"));
      const second = review.getState(input);

      expect(second.session.createdAt).toBe(first.session.createdAt);
      expect(second.session.updatedAt).toBe(first.session.updatedAt);
      vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
      const mismatchedRead = review.getState({ ...input, repoId: "repo-2" });
      expect(mismatchedRead.session.repoId).toBe("repo-1");
      expect(mismatchedRead.session.updatedAt).toBe(first.session.updatedAt);

      vi.setSystemTime(new Date("2026-08-12T13:00:00.000Z"));
      expect(review.getOrCreateSession({ ...input, repoId: "repo-2" })).toMatchObject({
        repoId: "repo-2",
        updatedAt: "2026-08-12T13:00:00.000Z",
      });
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates one primary reviewer and keeps its original implementor selection", () => {
    const { storage, review } = createSubject();
    const first = review.ensurePrimaryReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });
    const second = review.ensurePrimaryReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "claude-code",
      model: "claude-opus-4-8",
      effort: "max",
    });

    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    expect(second.tab).toMatchObject({
      threadId: first.tab.threadId,
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
    }).tabs).toHaveLength(1);
    storage.close();
  });

  it("inherits reviewer configurations once when an environment opens a new lead session", () => {
    const { storage, review } = createSubject();
    const first = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
      roleLabel: "Correctness Reviewer",
      taskKind: "correctness",
    });
    review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-2",
      provider: "claude-code",
      model: "claude-opus-4.8",
      effort: "max",
      roleLabel: "Architecture Reviewer",
      taskKind: "architecture",
    });

    const inherited = review.inheritReviewerTabsFromLatestSession({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-2",
    });
    expect(inherited.status).toBe("inherited");
    expect(inherited.tabs).toHaveLength(2);
    expect(inherited.tabs[0]).toMatchObject({
      provider: first.provider,
      model: first.model,
      effort: first.effort,
      roleLabel: first.roleLabel,
      mainSessionId: "session-2",
      status: "idle",
      latestRunId: null,
    });
    expect(inherited.tabs[0]?.threadId).toBe(first.threadId);
    expect(review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
    }).tabs).toHaveLength(0);

    const repeated = review.inheritReviewerTabsFromLatestSession({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-2",
    });
    expect(repeated.status).toBe("existing");
    expect(repeated.tabs.map((tab) => tab.threadId)).toEqual(inherited.tabs.map((tab) => tab.threadId));
    expect(review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-2",
    }).tabs).toHaveLength(2);
    storage.close();
  });

  it("reuses an explicitly added reviewer as the primary conversation", () => {
    const { storage, review } = createSubject();
    const explicit = createTab(review);

    const ensured = review.ensurePrimaryReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });

    expect(ensured.status).toBe("existing");
    expect(ensured.tab.threadId).toBe(explicit.threadId);
    expect(ensured.tab).toMatchObject({
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
    });
    storage.close();
  });

  it("bounds stored event history for a reviewer run", () => {
    const { storage, review } = createSubject();
    for (let index = 1; index <= 205; index += 1) {
      review.appendRunEvent({
        runId: "run-bounded",
        type: "model_activity",
        message: `Action ${index}`,
      });
    }

    const events = review.listRunEvents("run-bounded");
    expect(events).toHaveLength(200);
    expect(events[0]).toMatchObject({ seq: 6, message: "Action 6" });
    expect(events.at(-1)).toMatchObject({ seq: 205, message: "Action 205" });
    storage.close();
  });

  it("purges historical provider activity while retaining lifecycle events", () => {
    const storage = new FakeStorage();
    const first = new EnvReviewDO({ storage } as any, {} as any);
    first.listActiveRuns();
    for (const [seq, type, message] of [
      [1, "progress", "private command"],
      [2, "assistant_message", "intermediate response"],
      [3, "runtime_startup", "Reviewer runtime started."],
      [4, "run_completed", "Reviewer feedback is ready."],
    ] as const) {
      storage.sql.exec(
        `INSERT INTO env_review_run_events (
          run_id, seq, type, message, data_json, created_at
        ) VALUES (?, ?, ?, ?, NULL, ?)`,
        "run-history",
        seq,
        type,
        message,
        "2026-07-14T00:00:00.000Z",
      );
    }

    const restarted = new EnvReviewDO({ storage } as any, {} as any);
    expect(restarted.listRunEvents("run-history").map((event) => event.type)).toEqual([
      "runtime_startup",
      "run_completed",
    ]);
    storage.close();
  });

  it("freezes Codex launch provenance on each reviewer leaf run", () => {
    const { storage, review } = createSubject();
    const tab = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-provenance",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    const preparation = review.beginPreparationOperation({
      opId: "op-provenance",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    const subscriptionProvenance = {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
      codexExecution: {
        kind: "subscription-app-server" as const,
        surface: "environment-reviewer" as const,
        backend: "cf" as const,
      },
    };
    const run = review.createRun({
      runId: "run-provenance",
      threadId: tab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: tab.provider,
      model: tab.model,
      effort: tab.effort,
      roleLabel: "Reviewer",
      taskKind: "correctness",
      preparationOpId: preparation.operation.opId,
      launchProvenance: subscriptionProvenance,
    });
    expect(run).toMatchObject({
      launchProvenance: subscriptionProvenance,
    });
    review.updateRun({
      runId: run.runId,
      status: "queued",
      runtime: {
        jobSlug: "env-review-run-provenance",
      },
    });
    expect(review.acceptCodexRuntimeAuth(run.runId, "account-1")).toBe("accepted");
    expect(review.acceptCodexRuntimeAuth(run.runId, "account-1")).toBe("accepted");
    expect(review.acceptCodexRuntimeAuth(run.runId, "account-2")).toBe("account_changed");

    const completed = review.updateRun({
      runId: run.runId,
      status: "failed",
      completedAt: "2026-07-13T20:00:00.000Z",
      error: "test",
    });
    expect(completed).toMatchObject({
      launchProvenance: subscriptionProvenance,
    });
    expect(review.acceptCodexRuntimeAuth(run.runId, "account-1")).toBe("inactive");
    storage.close();
  });

  it("persists effort on reviewer tabs and runs", () => {
    const { storage, review } = createSubject();
    const tab = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-effort",
      provider: "claude-code",
      model: "opus",
      effort: "max",
    });
    const preparation = review.beginPreparationOperation({
      opId: "op-effort",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    const run = review.createRun({
      runId: "run-effort",
      threadId: tab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: tab.provider,
      model: tab.model,
      effort: tab.effort,
      roleLabel: "Reviewer",
      taskKind: "correctness",
      preparationOpId: preparation.operation.opId,
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });

    expect(tab.effort).toBe("max");
    expect(run.effort).toBe("max");
    expect(review.getState({ envSlug: "env-1", repoId: "repo-1", mainSessionId: "session-1" })).toMatchObject({
      tabs: [expect.objectContaining({ effort: "max" })],
      runs: [expect.objectContaining({ effort: "max" })],
    });
    storage.close();
  });

  it("enumerates raw run statuses for fail-closed maintenance checks", () => {
    const { storage, review } = createSubject();
    const tab = createTab(review);
    const preparation = review.beginPreparationOperation({
      opId: "op-status",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    const run = review.createRun({
      runId: "run-status",
      threadId: tab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: tab.provider,
      model: tab.model,
      effort: tab.effort,
      roleLabel: "Reviewer",
      taskKind: "correctness",
      preparationOpId: preparation.operation.opId,
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    storage.sql.exec("UPDATE env_review_runs SET status = ? WHERE run_id = ?", "corrupt", run.runId);

    expect(review.listActiveRuns()).toEqual([]);
    expect(review.listWorkloadStateForPredeploy()).toEqual([{
      runId: run.runId,
      status: "corrupt",
      hasRuntime: false,
    }]);

    storage.close();
  });

  it("allows one active preparation per env session and treats duplicate completion as idempotent", () => {
    const { storage, review } = createSubject();

    const first = review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
      requestUrl: "https://hub.example/api/envs/env-1/review",
    });
    const second = review.beginPreparationOperation({
      opId: "op-2",
      envSlug: "env-1",
      sessionId: "session-1",
    });

    expect(first.status).toBe("created");
    expect(first.operation.requestUrl).toBe("https://hub.example/api/envs/env-1/review");
    expect(first.operation.timeoutAt).toEqual(expect.any(String));
    expect(second.status).toBe("existing");
    expect(second.operation.opId).toBe("op-1");

    const otherSession = review.beginPreparationOperation({
      opId: "op-3",
      envSlug: "env-1",
      sessionId: "session-2",
    });
    expect(otherSession.status).toBe("created");
    expect(otherSession.operation.opId).toBe("op-3");

    const snapshot = {
      snapshotId: "snapshot-1",
      source: "live-harness" as const,
      mode: "github-overlay" as const,
      stale: false,
      createdAt: "2026-06-21T00:00:00.000Z",
      snapshotHash: "hash-1",
      baseCommitSha: "base-sha",
      githubDeletedPaths: [],
      r2Key: "envs/env-1/review-snapshots/snapshot-1.tar",
    };
    const result = {
      formatVersion: 1,
      status: "succeeded" as const,
      opId: "op-1",
      snapshot,
      changedCount: 2,
      deletedCount: 1,
      uploadedBytes: 123,
      completedAt: "2026-06-21T00:00:00.000Z",
    };
    expect(review.completePreparationOperation({ opId: "op-1", result })?.status).toBe("succeeded");
    expect(review.completePreparationOperation({
      opId: "op-1",
      result: { ...result, changedCount: 99 },
    })?.result?.changedCount).toBe(2);

    storage.close();
  });

  it("persists snapshot request attempts and accepts only matching upload tokens", () => {
    const { storage, review } = createSubject();
    review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
      requestUrl: "https://hub.example/api/envs/env-1/review",
    });

    expect(review.markPreparationRequestAttempt({
      opId: "op-1",
      ackToken: "ack-1",
      requestedAt: "2026-06-21T00:00:00.000Z",
    })).toMatchObject({
      ackToken: "ack-1",
      snapshotAttempts: 1,
      snapshotRequestedAt: "2026-06-21T00:00:00.000Z",
    });

    const snapshot = {
      snapshotId: "snapshot-1",
      source: "live-harness" as const,
      mode: "github-overlay" as const,
      stale: false,
      createdAt: "2026-06-21T00:01:00.000Z",
      snapshotHash: "hash-1",
      baseCommitSha: "base-sha",
      githubDeletedPaths: [],
      r2Key: "envs/env-1/review-snapshots/snapshot-1.tar",
    };
    const result = {
      formatVersion: 1,
      status: "succeeded" as const,
      opId: "op-1",
      snapshot,
      changedCount: 2,
      deletedCount: 0,
      uploadedBytes: 42,
      completedAt: "2026-06-21T00:01:00.000Z",
    };
    expect(review.completeSnapshotPreparation({
      envSlug: "env-1",
      sessionId: "session-1",
      opId: "op-1",
      uploadToken: "wrong-token",
      result,
    })).toMatchObject({ status: "rejected" });
    expect(review.getPreparationOperation("op-1")?.status).toBe("preparing");

    expect(review.completeSnapshotPreparation({
      envSlug: "env-1",
      sessionId: "session-1",
      opId: "op-1",
      uploadToken: "ack-1",
      result,
    })).toMatchObject({
      status: "completed",
      operation: expect.objectContaining({
        status: "succeeded",
        result: expect.objectContaining({ changedCount: 2, snapshot }),
      }),
    });

    storage.close();
  });

  it("keeps completed snapshot identity immutable across later result updates", () => {
    const { storage, review } = createSubject();
    review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    review.markPreparationRequestAttempt({
      opId: "op-1",
      ackToken: "token-1",
      requestedAt: "2026-06-21T00:00:00.000Z",
    });
    const snapshot = {
      snapshotId: "snapshot-1",
      source: "live-harness" as const,
      mode: "github-overlay" as const,
      stale: false,
      createdAt: "2026-06-21T00:00:01.000Z",
      snapshotHash: "hash-1",
      baseCommitSha: "base-sha",
      githubDeletedPaths: [],
      r2Key: "envs/env-1/review-snapshots/snapshot-1.tar",
    };
    const completed = review.completeSnapshotPreparation({
      envSlug: "env-1",
      sessionId: "session-1",
      opId: "op-1",
      uploadToken: "token-1",
      result: {
        formatVersion: 1,
        status: "succeeded",
        opId: "op-1",
        snapshot,
        changedCount: 1,
        deletedCount: 0,
        uploadedBytes: 1024,
        completedAt: "2026-06-21T00:00:01.000Z",
      },
    });
    expect(completed.status).toBe("completed");

    review.updatePreparationResult({
      opId: "op-1",
      result: {
        formatVersion: 1,
        status: "succeeded",
        opId: "op-1",
        snapshot: {
          ...snapshot,
          snapshotId: "snapshot-2",
          snapshotHash: "hash-2",
          r2Key: "envs/env-1/review-snapshots/snapshot-2.tar",
        },
        changedCount: 2,
        deletedCount: 0,
        uploadedBytes: 2048,
        completedAt: "2026-06-21T00:00:02.000Z",
      },
    });

    expect(review.getPreparationOperation("op-1")?.result).toMatchObject({
      changedCount: 2,
      snapshot: expect.objectContaining({
        snapshotId: "snapshot-1",
        snapshotHash: "hash-1",
        r2Key: "envs/env-1/review-snapshots/snapshot-1.tar",
      }),
    });

    storage.close();
  });

  it("alarm requests a live review snapshot with a durable upload token", async () => {
    const sendEnvReviewSnapshotRequest = vi.fn().mockResolvedValue({ sent: true });
    const { storage, review } = createSubject(new FakeStorage(), {
      HUB: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ sendEnvReviewSnapshotRequest })),
      },
    });
    const tab = createTab(review);
    const preparation = review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
      requestUrl: "https://hub.example/api/envs/env-1/review",
    });
    const run = review.createRun({
      runId: "run-1",
      threadId: tab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "fake",
      model: "fake-fast",
      effort: tab.effort,
      roleLabel: "Reviewer",
      taskKind: "correctness",
      preparationOpId: preparation.operation.opId,
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });

    await review.alarm();

    expect(sendEnvReviewSnapshotRequest).toHaveBeenCalledWith(
      "session-1",
      "op-1",
      "env-1",
      expect.any(String),
      expect.objectContaining({
        uploadUrl: "https://hub.example/api/envs/env-1/review/snapshots/op-1",
        snapshotMode: "github-overlay",
        maxBytes: expect.any(Number),
        excludePrefixes: expect.any(Array),
      }),
    );
    expect(review.getPreparationOperation("op-1")).toMatchObject({
      ackToken: expect.any(String),
      snapshotAttempts: 1,
    });
    expect(review.listRunEvents(run.runId).map((event) => event.type)).toContain("snapshot_requested");
    expect(await storage.getAlarm()).toEqual(expect.any(Number));

    storage.close();
  });

  it("creates a stale saved-workspace snapshot immediately when no owner harness is connected", async () => {
    const sendEnvReviewSnapshotRequest = vi.fn().mockResolvedValue({
      sent: false,
      error: "No active harness session is connected for review snapshot.",
    });
    const bucket = {
      put: vi.fn(async () => ({})),
      delete: vi.fn(async () => undefined),
      list: vi.fn(async () => ({ objects: [], truncated: false })),
      get: vi.fn(async () => null),
      head: vi.fn(async () => null),
    };
    const { storage, review } = createSubject(new FakeStorage(), {
      BUCKET: bucket,
      HUB: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ sendEnvReviewSnapshotRequest })),
      },
    });
    review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
      requestUrl: "https://hub.example/api/envs/env-1/review",
    });

    await review.alarm();

    expect(review.getPreparationOperation("op-1")).toMatchObject({
      status: "succeeded",
      result: expect.objectContaining({
        snapshot: expect.objectContaining({
          source: "saved-workspace",
          stale: true,
          baseCommitSha: "base-sha",
          r2Key: expect.stringMatching(/^envs\/env-1\/review-snapshots\/.+\.tar$/),
        }),
      }),
    });
    expect(bucket.put).toHaveBeenCalledWith(
      expect.stringMatching(/^envs\/env-1\/review-snapshots\/.+\.tar$/),
      expect.any(Uint8Array),
      expect.objectContaining({ httpMetadata: { contentType: "application/x-tar" } }),
    );

    storage.close();
  });

  it("removing an active reviewer cancels its run and unused preparation operation", () => {
    const { storage, review } = createSubject();
    const tab = createTab(review);
    const preparation = review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    const run = review.createRun({
      runId: "run-1",
      threadId: tab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "fake",
      model: "fake-fast",
      effort: tab.effort,
      roleLabel: "Reviewer",
      taskKind: "correctness",
      preparationOpId: preparation.operation.opId,
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });

    review.removeReviewerTab(tab.threadId, "session-1");

    expect(review.getRun(run.runId)).toMatchObject({
      status: "cancelled",
      error: "Reviewer removed before the run completed.",
    });
    expect(review.getPreparationOperation("op-1")).toMatchObject({
      status: "failed",
      error: "Review preparation cancelled because all waiting reviewers were removed.",
    });
    expect(review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
    }).tabs).toEqual([]);

    storage.close();
  });

  it("moves feedback through ready, pending, sent, and dismissed states", () => {
    const { storage, review } = createSubject();
    const tab = createTab(review);
    const preparation = review.beginPreparationOperation({
      opId: "op-1",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    const run = review.createRun({
      runId: "run-1",
      threadId: tab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "fake",
      model: "fake-fast",
      effort: tab.effort,
      roleLabel: "Reviewer",
      taskKind: "correctness",
      recipeInstructions: "Focus on regressions.",
      preparationOpId: preparation.operation.opId,
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    expect(run.recipeInstructions).toBe("Focus on regressions.");
    const feedback = review.createFeedback({
      envSlug: run.envSlug,
      repoId: run.repoId,
      mainSessionId: run.mainSessionId,
      threadId: run.threadId,
      runId: run.runId,
      messageId: "message-1",
      provider: run.provider,
      model: run.model,
      roleLabel: run.roleLabel,
      text: "Review text",
    });

    expect(feedback.status).toBe("ready");
    expect(review.updateFeedbackStatus({
      feedbackId: feedback.feedbackId,
      status: "pending",
      deliveredText: "Delivered text",
    })?.status).toBe("pending");
    expect(review.getFeedback(feedback.feedbackId)?.deliveredText).toBe("Delivered text");
    expect(review.updateFeedbackStatus({ feedbackId: feedback.feedbackId, status: "sent" })?.sentAt).toBeTruthy();
    expect(review.updateFeedbackStatus({ feedbackId: feedback.feedbackId, status: "dismissed" })?.dismissedAt).toBeTruthy();

    storage.close();
  });

  it("reserves one linked fanout, freezes one Overview, and unlocks its parent at terminal", () => {
    const { storage, review } = createSubject();
    const parent = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "parent-1",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Parent",
    });
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      agents: DEFAULT_CODE_REVIEW_SKILL.agents.slice(0, 2),
    };
    const input = {
      invocationId: "review-invoke-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:review-invoke-1",
      definitionSnapshot: definition,
      overviewMode: "manual" as const,
      preparationOpId: "op-skill-1",
      requestUrl: "https://hub.example/api/envs/env-1/review",
      overviewRoute: TEST_OVERVIEW_ROUTE,
      agents: definition.agents.map((agent, index) => ({
        id: agent.id,
        provider: index === 0 ? "fake" : "other-provider",
        model: index === 0 ? "fake-fast" : "other-model",
        effort: index === 0 ? "medium" as const : "high" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      })),
    };
    const first = review.reserveSkillInvocation(input);
    const second = review.reserveSkillInvocation({ ...input, overviewMode: "auto" });
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status === "conflict" || first.status === "parent_locked" || second.status === "conflict" || second.status === "parent_locked") {
      throw new Error("unexpected reservation result");
    }
    expect(second.runs.map((run) => run.runId)).toEqual(first.runs.map((run) => run.runId));
    expect(first.runs.every((run) =>
      run.launchProvenance?.backend === "cf"
      && run.launchProvenance.machineId === null
    )).toBe(true);
    expect(first.tabs).toHaveLength(definition.agents.length);
    expect(first.tabs.map((tab) => ({
      skillInvocationId: tab.skillInvocationId,
      skillAgentId: tab.skillAgentId,
    }))).toEqual(expect.arrayContaining(definition.agents.map((agent) => ({
      skillInvocationId: input.invocationId,
      skillAgentId: agent.id,
    }))));
    expect(review.listSkillInvocationTabs(input.invocationId).map((tab) => tab.skillAgentId))
      .toEqual(expect.arrayContaining(definition.agents.map((agent) => agent.id)));
    const firstReservedTab = first.tabs.find((tab) => tab.skillAgentId === definition.agents[0]!.id)!;
    expect(review.getTab(firstReservedTab.threadId)).toMatchObject({
      skillInvocationId: input.invocationId,
      skillAgentId: definition.agents[0]!.id,
    });
    expect(review.getState({ envSlug: "env-1", repoId: "repo-1", mainSessionId: "session-1" }).tabs.map((tab) => tab.nodeKind))
      .toEqual(["generic", "skill_root", "report", "report"]);
    review.activateSkillInvocation(input.invocationId);

    const preparation = {
      formatVersion: 1,
      status: "succeeded" as const,
      opId: first.invocation.preparationOpId,
      snapshot: {
        snapshotId: "snapshot-1",
        source: "live-harness" as const,
        mode: "full" as const,
        stale: false,
        createdAt: "2026-07-10T00:00:00.000Z",
        snapshotHash: "hash",
        baseCommitSha: null,
        githubDeletedPaths: [],
        r2Key: "snapshot.tar",
      },
      // An empty workspace diff is still a valid immutable Review basis.
      // Fanout setup and child execution must not special-case it as missing.
      changedCount: 0,
      deletedCount: 0,
      uploadedBytes: 10,
      completedAt: "2026-07-10T00:00:00.000Z",
      error: null,
    };
    const changeContext = {
      generatedAt: "2026-07-10T00:00:00.000Z",
      summary: { total: 0, added: 0, modified: 0, deleted: 0, omitted: 0, truncated: 0, files: [] },
      files: [],
      limits: { maxFiles: 25, maxDiffBytesPerFile: 20_000, maxTotalDiffBytes: 60_000, maxFileBytesForDiff: 200_000 },
    };
    const planBasis = { source: "none" as const, artifactId: null, version: null, title: null, markdown: null };
    review.updateRun({
      runId: first.runs[0]!.runId,
      status: "ready",
      preparation,
      changeContext,
      planBasis,
      completedAt: "2026-07-10T00:01:00.000Z",
    });
    review.recordSkillReport(first.runs[0]!.runId, "message-1");
    review.updateRun({
      runId: first.runs[1]!.runId,
      status: "ready",
      preparation,
      changeContext,
      planBasis,
      completedAt: "2026-07-10T00:01:00.000Z",
    });
    review.recordSkillReport(first.runs[1]!.runId, "message-2");
    const controlled = review.updateSkillInvocationControls({
      invocationId: input.invocationId,
      overviewMode: "manual",
      includedMessageIds: ["message-1"],
    });
    expect(controlled?.includedMessageIds).toEqual(["message-1"]);
    const payload = {
      invocationId: input.invocationId,
      skillId: definition.id,
      skillLabel: definition.label,
      mode: "manual" as const,
      reports: [],
      failureNotices: [],
      guidance: "Focus on correctness.",
      overviewInstructions: definition.overviewInstructions,
      frozenAt: "2026-07-10T00:02:00.000Z",
    };
    expect(review.assignSkillOverview({
      invocationId: input.invocationId,
      overviewRunId: "stale-overview",
      expectedOverviewMode: "manual",
      expectedIncludedMessageIds: ["message-2"],
      payload,
      provider: parent.provider,
      model: parent.model,
      effort: parent.effort,
      roleLabel: "Overview",
      preparation,
      changeContext,
      planBasis,
      prompt: "Stale overview prompt",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    })).toMatchObject({ status: "controls_changed", run: null });
    expect(review.getRun("stale-overview")).toBeNull();
    const assigned = review.assignSkillOverview({
      invocationId: input.invocationId,
      overviewRunId: "overview-1",
      expectedOverviewMode: "manual",
      expectedIncludedMessageIds: ["message-1"],
      payload,
      provider: parent.provider,
      model: parent.model,
      effort: parent.effort,
      roleLabel: "Overview",
      preparation,
      changeContext,
      planBasis,
      prompt: "Frozen overview prompt",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    expect(assigned?.status).toBe("created");
    expect(assigned?.run?.launchProvenance).toEqual(TEST_LAUNCH_PROVENANCE);
    const raced = review.assignSkillOverview({
      invocationId: input.invocationId,
      overviewRunId: "overview-2",
      expectedOverviewMode: "manual",
      expectedIncludedMessageIds: ["message-1"],
      payload: { ...payload, guidance: "different" },
      provider: parent.provider,
      model: parent.model,
      effort: parent.effort,
      roleLabel: "Overview",
      preparation,
      changeContext,
      planBasis,
      prompt: "Different prompt",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    expect(raced).toMatchObject({ status: "existing", run: { runId: "overview-1", frozenOverview: payload } });
    expect(review.updateSkillInvocationControls({
      invocationId: input.invocationId,
      overviewMode: "auto",
      includedMessageIds: ["message-2"],
    })?.includedMessageIds).toEqual(["message-1"]);
    const overviewCompletion = review.completeRunSuccessfully({
      runId: "overview-1",
      messageId: "overview-message-1",
      text: "Frozen Overview",
      completedAt: "2026-07-10T00:03:00.000Z",
    });
    expect(overviewCompletion).toMatchObject({
      status: "completed",
      run: { status: "ready" },
      feedback: {
        feedbackId: "skill-overview:overview-1",
        text: "Frozen Overview",
        metadata: {
          reviewHandoff: {
            schemaVersion: 1,
            kind: "fanout_overview",
            skillLabel: definition.label,
            reviewerCount: 2,
            models: [
              { provider: "fake", model: "fake-fast" },
              { provider: "other-provider", model: "other-model" },
            ],
          },
        },
      },
    });
    expect(review.completeRunSuccessfully({
      runId: "overview-1",
      messageId: "overview-message-1",
      text: "Frozen Overview",
    })).toMatchObject({
      status: "terminal",
      feedback: { feedbackId: "skill-overview:overview-1" },
    });
    expect(review.getSkillInvocation(input.invocationId)?.status).toBe("completed");
    expect(review.getActiveSkillInvocationForParent(input.parentThreadId, "session-1")).toBeNull();
    review.completePreparationOperation({ opId: first.invocation.preparationOpId, result: preparation });
    const restarted = review.restartSkillInvocation({
      invocationId: input.invocationId,
      requestId: "rerun-request-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      requestUrl: "https://hub.example/api/envs/env-1/review/skill-invocations/review-invoke-1/rerun",
      overviewRoute: { provider: "codex", model: "gpt-5.5", effort: "xhigh" },
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      })),
    });
    expect(restarted.status).toBe("created");
    if (restarted.status === "conflict" || restarted.status === "not_found" || restarted.status === "parent_locked") {
      throw new Error("unexpected restart result");
    }
    expect(restarted.invocation).toMatchObject({
      invocationId: "rerun-request-1",
      preparationOpId: "rerun-request-1",
      status: "setting_up",
      includedMessageIds: [],
      overviewRunId: null,
    });
    expect(restarted.tabs.map((tab) => tab.threadId)).toEqual(first.tabs.map((tab) => tab.threadId));
    expect(review.getTab(input.parentThreadId)).toMatchObject({
      skillInvocationId: "rerun-request-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh",
    });
    expect(restarted.tabs.every((tab) => tab.skillInvocationId === "rerun-request-1")).toBe(true);
    expect(restarted.runs).toHaveLength(definition.agents.length);
    expect(restarted.runs.every((run) => (
      run.preparationOpId === "rerun-request-1"
      && run.skillRunRole === "report_initial"
      && run.customTask === "Continue this review against the latest workspace snapshot. Use the existing conversation and your earlier findings as context. Verify what was fixed, discard findings that no longer apply, and report remaining or newly introduced issues."
    ))).toBe(true);
    review.activateSkillInvocation("rerun-request-1");
    review.recordSkillReport(first.runs[0]!.runId, "old-round-message");
    expect(review.getSkillInvocation("rerun-request-1")?.includedMessageIds).toEqual([]);
    const replayed = review.restartSkillInvocation({
      invocationId: input.invocationId,
      requestId: "rerun-request-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      requestUrl: "https://hub.example/retry",
      agents: definition.agents.map((agent) => ({ id: agent.id })),
    });
    expect(replayed.status).toBe("existing");
    if (replayed.status === "conflict" || replayed.status === "not_found" || replayed.status === "parent_locked") {
      throw new Error("unexpected replay result");
    }
    expect(replayed.runs.map((run) => run.runId)).toEqual(restarted.runs.map((run) => run.runId));
    const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%skill_invocations'").toArray();
    expect(tables).toEqual([{ name: "env_review_skill_invocations" }]);
    storage.close();
  });

  it("runs a single-agent skill through its root with direct feedback and no Overview", () => {
    const { storage, review } = createSubject();
    const parent = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "direct-parent",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Origin Reviewer",
    });
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      id: "focused-review",
      command: "focused-review",
      label: "Focused Review",
      sharedInstructions: "",
      agents: [{
        ...DEFAULT_CODE_REVIEW_SKILL.agents[0]!,
        label: "Focused Agent",
        instructions: "Inspect the focused risk and report directly.",
      }],
    };
    const input = {
      invocationId: "direct-invocation",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:direct-invocation",
      definitionSnapshot: definition,
      overviewMode: "auto" as const,
      preparationOpId: "direct-op",
      requestUrl: "https://hub.example/review",
      agents: [{
        id: definition.agents[0]!.id,
        provider: "claude-code",
        model: "sonnet",
        effort: "high" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      }],
    };
    const reserved = review.reserveSkillInvocation(input);
    if (reserved.status === "conflict" || reserved.status === "parent_locked") {
      throw new Error("unexpected reservation result");
    }
    expect(reserved.tabs).toHaveLength(1);
    expect(reserved.runs).toHaveLength(1);
    expect(reserved.runs[0]).toMatchObject({
      provider: "claude-code",
      model: "sonnet",
      effort: "high",
      roleLabel: "Focused Agent",
      recipeInstructions: "Inspect the focused risk and report directly.",
    });
    review.activateSkillInvocation(input.invocationId);
    expect(review.assignSkillOverview({
      invocationId: input.invocationId,
      overviewRunId: "forbidden-overview",
      expectedOverviewMode: "auto",
      expectedIncludedMessageIds: [],
      payload: {
        invocationId: input.invocationId,
        skillId: definition.id,
        skillLabel: definition.label,
        mode: "auto",
        reports: [],
        failureNotices: [],
        guidance: null,
        overviewInstructions: definition.overviewInstructions,
        frozenAt: "2026-07-10T00:00:00.000Z",
      },
      provider: parent.provider,
      model: parent.model,
      effort: parent.effort,
      roleLabel: "Overview",
      preparation: null,
      changeContext: null,
      planBasis: null,
      prompt: "must not run",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    })).toMatchObject({ status: "not_active", run: null });
    expect(review.getRun("forbidden-overview")).toBeNull();

    const completed = review.completeRunSuccessfully({
      runId: reserved.runs[0]!.runId,
      messageId: "direct-message",
      text: "Direct attributed finding.",
    });
    expect(completed).toMatchObject({
      status: "completed",
      feedback: {
        feedbackId: `env-review:${reserved.runs[0]!.runId}`,
        status: "ready",
        text: "Direct attributed finding.",
        roleLabel: "Focused Agent",
        provider: "claude-code",
        model: "sonnet",
        metadata: {
          skillInvocationId: input.invocationId,
          role: "Focused Agent",
          provider: "claude-code",
          model: "sonnet",
        },
      },
    });
    expect(review.getSkillInvocation(input.invocationId)).toMatchObject({
      status: "completed",
      overviewRunId: null,
    });
    expect(review.getActiveSkillInvocationForParent(input.parentThreadId, "session-1")).toBeNull();

    const restarted = review.restartSkillInvocation({
      invocationId: input.invocationId,
      requestId: "direct-rerun",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      requestUrl: "https://hub.example/review/rerun",
      agents: [{ id: definition.agents[0]!.id, launchProvenance: TEST_LAUNCH_PROVENANCE }],
    });
    expect(restarted).toMatchObject({
      status: "created",
      invocation: { invocationId: "direct-rerun", status: "setting_up" },
      runs: [{ skillRunRole: "root_initial" }],
    });
    if (restarted.status === "conflict" || restarted.status === "not_found" || restarted.status === "parent_locked") {
      throw new Error("unexpected restart result");
    }
    review.activateSkillInvocation("direct-rerun");
    review.updateRun({
      runId: restarted.runs[0]!.runId,
      status: "failed",
      completedAt: "2026-07-10T00:04:00.000Z",
      error: "Configured child failed.",
    });
    expect(review.getSkillInvocation("direct-rerun")).toMatchObject({
      status: "failed",
      error: "Configured child failed.",
    });
    storage.close();
  });

  it("cancels a single-agent root invocation", () => {
    const { storage, review } = createSubject();
    const parent = createTab(review);
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      sharedInstructions: "",
      agents: [{ ...DEFAULT_CODE_REVIEW_SKILL.agents[0]! }],
    };
    const input = {
      invocationId: "direct-cancel",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:direct-cancel",
      definitionSnapshot: definition,
      overviewMode: "manual" as const,
      preparationOpId: "direct-cancel-op",
      requestUrl: "https://hub.example/review",
      agents: [{
        id: definition.agents[0]!.id,
        provider: "fake",
        model: "fake-fast",
        effort: "medium" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      }],
    };
    const reserved = review.reserveSkillInvocation(input);
    if (reserved.status === "conflict" || reserved.status === "parent_locked") throw new Error("unexpected reservation result");
    review.activateSkillInvocation(input.invocationId);
    expect(review.cancelSkillInvocation(input.invocationId)).toMatchObject({ status: "cancelled" });
    expect(review.getRun(reserved.runs[0]!.runId)).toMatchObject({ status: "cancelled" });
    expect(review.getActiveSkillInvocationForParent(input.parentThreadId, "session-1")).toBeNull();
    storage.close();
  });

  it("removes a stopped skill round and its children while preserving the parent reviewer", () => {
    const { storage, review } = createSubject();
    const parent = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "remove-parent",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Parent",
    });
    const ordinaryParentRun = review.createRun({
      runId: "ordinary-parent-run",
      threadId: parent.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: parent.provider,
      model: parent.model,
      effort: parent.effort,
      roleLabel: parent.roleLabel,
      taskKind: "correctness",
      preparationOpId: "ordinary-parent-op",
      initialStatus: "ready",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      agents: DEFAULT_CODE_REVIEW_SKILL.agents.slice(0, 2),
    };
    const fanout = review.reserveSkillInvocation({
      invocationId: "remove-fanout",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:remove-fanout",
      definitionSnapshot: definition,
      overviewMode: "manual",
      overviewRoute: TEST_OVERVIEW_ROUTE,
      preparationOpId: "remove-fanout-op",
      requestUrl: "https://hub.example/review",
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        provider: "fake",
        model: "fake-fast",
        effort: "medium" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      })),
    });
    expect(fanout.status).toBe("created");
    if (fanout.status === "conflict" || fanout.status === "parent_locked") {
      throw new Error("unexpected reservation result");
    }
    review.activateSkillInvocation("remove-fanout");
    const overview = review.createRun({
      runId: "remove-overview",
      threadId: fanout.invocation.parentThreadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: parent.provider,
      model: parent.model,
      effort: parent.effort,
      roleLabel: "Overview",
      taskKind: "custom",
      preparationOpId: fanout.invocation.preparationOpId,
      skillInvocationId: fanout.invocation.invocationId,
      skillRunRole: "overview",
      skillDefinitionSnapshot: definition,
      initialStatus: "queued",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    const childRun = fanout.runs[0]!;
    const runtime = { jobSlug: "remove-child-runtime" };
    review.updateRun({ runId: childRun.runId, runtime });
    review.appendRunEvent({ runId: childRun.runId, type: "test", message: "Stored event" });
    const feedback = review.createFeedback({
      envSlug: childRun.envSlug,
      repoId: childRun.repoId,
      mainSessionId: childRun.mainSessionId,
      threadId: childRun.threadId,
      runId: childRun.runId,
      messageId: "remove-child-message",
      provider: childRun.provider,
      model: childRun.model,
      roleLabel: childRun.roleLabel,
      text: "Stored feedback",
    });

    expect(review.removeSkillInvocation({
      invocationId: "remove-fanout",
      envSlug: "env-1",
      mainSessionId: "session-1",
    })).toEqual({ status: "active" });
    review.cancelSkillInvocation("remove-fanout");
    expect(review.removeSkillInvocation({
      invocationId: "remove-fanout",
      envSlug: "env-1",
      mainSessionId: "session-1",
    })).toEqual({ status: "runtime_retained" });
    expect(review.clearRunRuntimeIfCurrent(childRun.runId, runtime)).toMatchObject({ runtime: null });

    expect(review.removeSkillInvocation({
      invocationId: "remove-fanout",
      envSlug: "env-1",
      mainSessionId: "session-1",
    })).toMatchObject({
      status: "removed",
      parentThreadId: fanout.invocation.parentThreadId,
      childThreadIds: expect.arrayContaining([
        fanout.invocation.parentThreadId,
        ...fanout.tabs.map((tab) => tab.threadId),
      ]),
    });
    expect(review.getSkillInvocation("remove-fanout")).toMatchObject({ status: "cancelled" });
    expect(review.listSkillInvocationTabs("remove-fanout")).toHaveLength(fanout.tabs.length);
    expect(review.listSkillInvocationRuns("remove-fanout")).not.toEqual([]);
    expect(review.getRun(overview.runId)).toBeTruthy();
    expect(review.getTab(fanout.tabs[0]!.threadId)).toMatchObject({ removedAt: expect.any(String) });
    expect(review.getFeedback(feedback.feedbackId)).toBeTruthy();
    expect(review.listRunEvents(childRun.runId)).toHaveLength(1);
    expect(review.getTab(parent.threadId)).toMatchObject({
      threadId: parent.threadId,
      latestRunId: ordinaryParentRun.runId,
      status: "ready",
      removedAt: null,
    });
    storage.close();
  });

  it("atomically excludes ordinary top-level turns and direct removal from a skill root", () => {
    const { storage, review } = createSubject();
    const parent = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "atomic-parent",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Parent",
    });
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      agents: DEFAULT_CODE_REVIEW_SKILL.agents.slice(0, 2),
    };
    const fanout = review.reserveSkillInvocation({
      invocationId: "atomic-fanout",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:atomic-fanout",
      definitionSnapshot: definition,
      overviewMode: "manual",
      overviewRoute: TEST_OVERVIEW_ROUTE,
      preparationOpId: "atomic-fanout-op",
      requestUrl: "https://hub.example/review",
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        provider: "fake",
        model: "fake-fast",
        effort: "medium" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      })),
    });
    expect(fanout.status).toBe("created");
    review.activateSkillInvocation("atomic-fanout");
    expect(review.reserveTopLevelRun({
      runId: "blocked-parent-run",
      threadId: fanout.invocation.parentThreadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Parent",
      taskKind: "correctness",
      preparationOpId: "blocked-parent-op",
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    }).status).toBe("parent_locked");
    expect(review.removeReviewerTabIfUnlocked(fanout.invocation.parentThreadId, "env-1", "session-1").status).toBe("skill_child");

    review.cancelSkillInvocation("atomic-fanout");
    expect(review.getActiveSkillInvocationForParent(fanout.invocation.parentThreadId)).toBeNull();
    storage.close();
  });

  it("does not include a child report when cancellation wins completion", () => {
    const { storage, review } = createSubject();
    const parent = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "cancel-parent",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Parent",
    });
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      agents: DEFAULT_CODE_REVIEW_SKILL.agents.slice(0, 2),
    };
    const reserved = review.reserveSkillInvocation({
      invocationId: "cancel-race",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:cancel-race",
      definitionSnapshot: definition,
      overviewMode: "auto",
      overviewRoute: TEST_OVERVIEW_ROUTE,
      preparationOpId: "cancel-race-op",
      requestUrl: "https://hub.example/review",
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        provider: "fake",
        model: "fake-fast",
        effort: "medium" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      })),
    });
    if (reserved.status === "conflict" || reserved.status === "parent_locked") throw new Error("unexpected reservation result");
    review.activateSkillInvocation("cancel-race");
    const child = reserved.runs[0]!;
    expect(review.recordSkillReport(child.runId, "too-early")).toBeNull();
    expect(review.getSkillInvocation("cancel-race")?.includedMessageIds).toEqual([]);
    review.cancelRun(child.runId);
    expect(review.completeRunSuccessfully({
      runId: child.runId,
      messageId: "cancelled-message",
      text: "Late report",
    })).toMatchObject({ status: "terminal", run: { status: "cancelled" } });
    expect(review.getSkillInvocation("cancel-race")?.includedMessageIds).toEqual([]);
    storage.close();
  });

  it("keeps Manual collection active when a follow-up can still produce the only eligible report", () => {
    const { storage, review } = createSubject();
    const parent = review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "parent-manual",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: "Parent",
    });
    const definition = {
      ...DEFAULT_CODE_REVIEW_SKILL,
      agents: DEFAULT_CODE_REVIEW_SKILL.agents.slice(0, 2),
    };
    const reserved = review.reserveSkillInvocation({
      invocationId: "manual-followup",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "skill-root:manual-followup",
      definitionSnapshot: definition,
      overviewMode: "manual",
      overviewRoute: TEST_OVERVIEW_ROUTE,
      preparationOpId: "op-manual-followup",
      requestUrl: "https://hub.example/api/envs/env-1/review",
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        provider: "fake",
        model: "fake-fast",
        effort: "medium" as const,
        launchProvenance: TEST_LAUNCH_PROVENANCE,
      })),
    });
    if (reserved.status === "conflict" || reserved.status === "parent_locked") throw new Error("unexpected reservation result");
    review.activateSkillInvocation("manual-followup");
    review.updateRun({
      runId: reserved.runs[0]!.runId,
      status: "failed",
      completedAt: "2026-07-10T00:01:00.000Z",
      error: "Initial report failed.",
    });
    const followup = review.createRun({
      runId: "manual-followup-run",
      threadId: reserved.runs[0]!.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
      roleLabel: reserved.runs[0]!.roleLabel,
      taskKind: "custom",
      customTask: "Try the review again.",
      preparationOpId: reserved.invocation.preparationOpId,
      skillInvocationId: reserved.invocation.invocationId,
      skillAgentId: reserved.runs[0]!.skillAgentId,
      skillRunRole: "report_followup",
      skillDefinitionSnapshot: definition,
      launchProvenance: TEST_LAUNCH_PROVENANCE,
    });
    review.updateRun({
      runId: reserved.runs[1]!.runId,
      status: "failed",
      completedAt: "2026-07-10T00:02:00.000Z",
      error: "Initial report failed.",
    });
    expect(review.getSkillInvocation("manual-followup")?.status).toBe("active");

    review.updateRun({
      runId: followup.runId,
      status: "ready",
      completedAt: "2026-07-10T00:03:00.000Z",
      error: null,
    });
    expect(review.getSkillInvocation("manual-followup")?.status).toBe("active");

    storage.close();
  });

  it("claims ready feedback once with the exact delivered text", () => {
    const { storage, review } = createSubject();
    const feedback = review.createFeedback({
      feedbackId: "feedback-claim",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-1",
      runId: "run-1",
      messageId: "message-1",
      provider: "fake",
      model: "fake-fast",
      roleLabel: "Overview",
      text: "Report",
    });
    expect(feedback.status).toBe("ready");
    expect(review.claimFeedbackPending({ feedbackId: feedback.feedbackId, deliveredText: "exact payload" })).toMatchObject({
      status: "claimed",
      feedback: { status: "pending", deliveredText: "exact payload" },
    });
    expect(review.claimFeedbackPending({ feedbackId: feedback.feedbackId, deliveredText: "loser payload" })).toMatchObject({
      status: "conflict",
      feedback: { deliveredText: "exact payload" },
    });
    storage.close();
  });

  it("scopes reviewer state by env and main session", () => {
    const { storage, review } = createSubject();

    review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      threadId: "thread-1",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
    });
    review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-2",
      threadId: "thread-2",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
    });

    const sessionOne = review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
    });
    const sessionTwo = review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-2",
    });

    expect(sessionOne.tabs.map((tab) => tab.threadId)).toEqual(["thread-1"]);
    expect(sessionTwo.tabs.map((tab) => tab.threadId)).toEqual(["thread-2"]);

    review.removeReviewerTab("thread-2", "session-1");
    expect(review.getState({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-2",
    }).tabs.map((tab) => tab.threadId)).toEqual(["thread-2"]);

    storage.close();
  });

  it("fences deleted lead sessions while allowing a new environment session", async () => {
    const { storage, review } = createSubject();
    review.getOrCreateSession({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-old",
    });

    await review.finalizeEnvironmentDeletion(["session-old", "session-late"]);

    expect(() => review.addReviewerTab({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-late",
      threadId: "late-thread",
      provider: "fake",
      model: "fake-fast",
      effort: "medium",
    })).toThrow("finalized for deletion");
    expect(review.getOrCreateSession({
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-new",
    }).mainSessionId).toBe("session-new");

    storage.close();
  });
});
