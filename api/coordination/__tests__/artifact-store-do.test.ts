import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
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

import { ArtifactStoreDO } from "../artifact-store-do";
import {
  MAX_PLAN_MARKDOWN_BYTES,
  PLAN_MARKDOWN_NORMALIZATION_VERSION,
} from "../planning";
import {
  DEFAULT_PLAN_REVIEW_SKILL,
  DEFAULT_PLAN_HEALTH_SKILL,
} from "../../planner/agent-skills";
import {
  plannerJobSlug,
  planWriterTerminalId,
} from "../../planner/runtime-identity";
import { validatePlanWriterLaunchProvenance } from "../execution-provenance";

type SqlResultRow = Record<string, unknown>;

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

function createSqlResult<T extends SqlResultRow>(rows: T[], rowsWritten = 0) {
  return {
    rowsWritten,
    toArray(): T[] {
      return rows;
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
  private alarmAt: number | null = null;

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }

  close(): void {
    this.sql.close();
  }
}

class RollbackProbeStorage extends FakeStorage {
  private failNext = false;

  failNextTransaction(): void {
    this.failNext = true;
  }

  override transactionSync<T>(closure: () => T): T {
    if (!this.failNext) return closure();
    this.failNext = false;
    this.sql.exec("BEGIN");
    try {
      closure();
      throw new Error("Injected transaction failure");
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }
}

function createSubject(storage = new FakeStorage(), env: Record<string, unknown> = {}) {
  const ctx = {
    storage,
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    },
  };
  return {
    storage,
    store: new ArtifactStoreDO(ctx as any, env as any),
  };
}

function reviewerInput() {
  return {
    repoId: "repo-1",
    planArtifactId: "plan-1",
    provider: "fake",
    model: "fake-fast",
    effort: "low" as const,
    skill: "plan-review",
  };
}

function completePlanSkillOverview(store: ArtifactStoreDO, invocationId: string): void {
  const invocation = store.getPlanSkillInvocation(invocationId);
  if (!invocation) throw new Error("expected Plan Skill round");
  const assigned = store.assignPlanSkillOverview({
    invocationId,
    overviewRunId: `overview:${invocationId}`,
    expectedOverviewMode: invocation.overviewMode,
    expectedIncludedMessageIds: invocation.includedMessageIds,
    payload: {
      invocationId,
      skillId: invocation.definitionSnapshot.id,
      skillLabel: invocation.definitionSnapshot.label,
      mode: invocation.overviewMode,
      reports: [],
      failureNotices: [],
      guidance: null,
      overviewInstructions: invocation.definitionSnapshot.overviewInstructions,
      frozenAt: "2026-08-12T00:00:00.000Z",
    },
    prompt: "Synthesize the frozen reports.",
    launchProvenance: CURRENT_CF_LAUNCH,
  });
  if (!assigned?.run) throw new Error("expected Overview run");
  store.updatePlannerRun({
    runId: assigned.run.runId,
    status: "completed",
    completedAt: new Date().toISOString(),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CURRENT_CF_LAUNCH = {
  schemaVersion: 1 as const,
  backend: "cf" as const,
  machineId: null,
};

function createRepoPlanToolSource(store: ArtifactStoreDO) {
  const sourcePlan = store.createArtifact({
    id: "source-plan",
    repoId: "repo-1",
    type: "plan",
    basis: { repoId: "repo-1", mainCommit: "main-1" },
    title: "Source",
    body: { markdown: "# Source\n" },
    status: "draft",
    createdBy: "test",
  });
  const writer = store.startPlanWriter({
    skills: [],
    repoId: "repo-1",
    planArtifactId: sourcePlan.id,
    provider: "codex",
    model: "gpt-test",
    basisCommit: "main-1",
    startBodyDigest: sha256("# Source\n"),
    launchProvenance: CURRENT_CF_LAUNCH,
  });
  const runtime = {
    jobSlug: planWriterTerminalId("repo-1", sourcePlan.id, writer.generation!),
    generation: writer.generation!,
  };
  store.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
  return { sourcePlan, writer, runtime };
}

describe("ArtifactStoreDO schema migration", () => {
  it("upgrades a populated pre-status artifact table idempotently", () => {
    const storage = new FakeStorage();
    storage.sql.exec(`
      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        type TEXT NOT NULL,
        basis_json TEXT NOT NULL,
        basis_main_commit TEXT,
        basis_env_slug TEXT,
        title TEXT NOT NULL,
        body_json TEXT NOT NULL,
        parent_artifact_id TEXT,
        supersedes_artifact_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL
      )
    `);
    storage.sql.exec(
      `
        INSERT INTO artifacts (
          id, repo_id, type, basis_json, basis_main_commit, basis_env_slug,
          title, body_json, parent_artifact_id, supersedes_artifact_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      "plan-1",
      "repo-1",
      "plan",
      JSON.stringify({ repoId: "repo-1", mainCommit: "main-1" }),
      "main-1",
      null,
      "Plan",
      JSON.stringify({ markdown: "Do the work." }),
      null,
      null,
      "test",
      "2026-05-20T00:00:00.000Z",
    );

    const first = new ArtifactStoreDO({ storage } as any, {} as any);
    expect(first.listArtifacts()).toMatchObject([
      {
        id: "plan-1",
        status: "draft",
        updatedAt: "2026-05-20T00:00:00.000Z",
        version: 1,
      },
    ]);

    const second = new ArtifactStoreDO({ storage } as any, {} as any);
    expect(second.listArtifacts()).toHaveLength(1);

    storage.close();
  });

  it("does not mutate historical workload events during schema initialization", () => {
    const storage = new FakeStorage();
    const first = new ArtifactStoreDO({ storage } as any, {} as any);
    first.listArtifacts();
    for (const [seq, type, message] of [
      [1, "progress", "private command"],
      [2, "assistant_message", "intermediate response"],
      [3, "runtime_startup", "Reviewer runtime started."],
      [4, "run_completed", "Reviewer run completed."],
    ] as const) {
      storage.sql.exec(
        `INSERT INTO planner_run_events (
          run_id, repo_id, plan_artifact_id, seq, type, message, data_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
        "run-history",
        "repo-1",
        "plan-1",
        seq,
        type,
        message,
        "2026-07-14T00:00:00.000Z",
      );
    }

    const restarted = new ArtifactStoreDO({ storage } as any, {} as any);
    expect(restarted.listPlannerRunEvents("run-history").map((event) => event.type)).toEqual([
      "progress",
      "assistant_message",
      "runtime_startup",
      "run_completed",
    ]);

    storage.close();
  });

  it("does not stop or delete an active Plan Writer during schema initialization", () => {
    const storage = new FakeStorage();
    const first = new ArtifactStoreDO({ storage } as any, {} as any);
    const plan = first.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan" },
      status: "draft",
      createdBy: "test",
    });
    const writer = first.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan"),
      launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
    });
    first.setPlanWriterRuntimeIfCurrent(writer.threadId, {
      jobSlug: `plan-writer-${plan.id}`,
      generation: writer.generation!,
    });

    const restarted = new ArtifactStoreDO({ storage } as any, {} as any);
    expect(restarted.getPlanWriter("repo-1", plan.id)).toMatchObject({
      threadId: writer.threadId,
      generation: writer.generation,
      runtime: {
        jobSlug: `plan-writer-${plan.id}`,
      },
    });
    expect(restarted.getPlanWriter("repo-1", plan.id)).not.toHaveProperty("stoppedAt");

    storage.close();
  });

});

describe("ArtifactStoreDO environment sidebar slots", () => {
  it("allocates, commits, releases, and reuses the lowest repo slot", () => {
    const { storage, store } = createSubject();

    expect(store.claimEnvironmentSidebarSlot({
      slug: "env-a",
      claimId: "claim-a",
      createdAt: "2026-07-14T00:00:00.000Z",
    })).toEqual({ status: "claimed", slot: 1 });
    expect(store.commitEnvironmentSidebarSlot("env-a", "claim-a")).toBe(true);
    expect(store.claimEnvironmentSidebarSlot({
      slug: "env-b",
      claimId: "claim-b",
      createdAt: "2026-07-14T00:01:00.000Z",
    })).toEqual({ status: "claimed", slot: 2 });
    expect(store.commitEnvironmentSidebarSlot("env-b", "claim-b")).toBe(true);

    expect(store.releaseEnvironmentSidebarSlot("env-a")).toBe(true);
    expect(store.claimEnvironmentSidebarSlot({
      slug: "env-c",
      claimId: "claim-c",
      createdAt: "2026-07-14T00:02:00.000Z",
    })).toEqual({ status: "claimed", slot: 1 });

    storage.close();
  });

  it("reconciles legacy definitions deterministically and preserves reservations", () => {
    const { storage, store } = createSubject();

    expect(store.claimEnvironmentSidebarSlot({
      slug: "env-pending",
      claimId: "claim-pending",
      createdAt: "2026-07-14T00:03:00.000Z",
    })).toEqual({ status: "claimed", slot: 1 });

    expect(store.reconcileEnvironmentSidebarSlots([
      { slug: "env-later", createdAt: "2026-07-14T00:02:00.000Z" },
      { slug: "env-earlier", createdAt: "2026-07-14T00:01:00.000Z" },
    ])).toEqual([
      { slug: "env-earlier", slot: 2 },
      { slug: "env-later", slot: 3 },
    ]);
    expect(store.releaseEnvironmentSidebarSlotClaim("env-pending", "wrong-claim")).toBe(false);
    expect(store.releaseEnvironmentSidebarSlotClaim("env-pending", "claim-pending")).toBe(true);

    storage.close();
  });

  it("recovers an abandoned reservation after its lease expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    try {
      const { storage, store } = createSubject();
      expect(store.claimEnvironmentSidebarSlot({
        slug: "env-pending",
        claimId: "abandoned",
        createdAt: "2026-07-17T00:00:00.000Z",
      })).toEqual({ status: "claimed", slot: 1 });

      vi.advanceTimersByTime(10 * 60_000 + 1);
      expect(store.claimEnvironmentSidebarSlot({
        slug: "env-pending",
        claimId: "retry",
        createdAt: "2026-07-17T00:10:00.001Z",
      })).toEqual({ status: "claimed", slot: 1 });
      expect(store.commitEnvironmentSidebarSlot("env-pending", "abandoned")).toBe(false);
      expect(store.commitEnvironmentSidebarSlot("env-pending", "retry")).toBe(true);

      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ArtifactStoreDO reviewer registry", () => {
  it("allows multiple active reviewers with the same model", () => {
    const { storage, store } = createSubject();

    const first = store.upsertReviewer(reviewerInput());
    const second = store.upsertReviewer(reviewerInput());
    expect(first.effort).toBe("low");
    expect(second.threadId).not.toBe(first.threadId);
    expect(store.listReviewers("repo-1", "plan-1")).toEqual([first, second]);

    const removed = store.removeReviewer("repo-1", "plan-1", first.threadId);
    expect(removed.removedAt).toBeTruthy();
    expect(store.listReviewers("repo-1", "plan-1")).toEqual([second]);
    expect(store.listReviewers("repo-1", "plan-1", { includeRemoved: true })).toHaveLength(2);

    const third = store.upsertReviewer(reviewerInput());
    expect(third.threadId).not.toBe(first.threadId);
    expect(store.listReviewers("repo-1", "plan-1")).toEqual([second, third]);

    storage.close();
  });

  it("drops the old plan/model uniqueness constraint during migration", () => {
    const storage = new FakeStorage();
    storage.sql.exec(`
      CREATE TABLE reviewer_registry (
        thread_id TEXT PRIMARY KEY,
        plan_artifact_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        reviewer_model TEXT NOT NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (plan_artifact_id, reviewer_model)
      )
    `);
    storage.sql.exec(
      `
        INSERT INTO reviewer_registry (
          thread_id, plan_artifact_id, repo_id, reviewer_model, removed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      `,
      "thread-1",
      "plan-1",
      "repo-1",
      "@cf/nvidia/nemotron-3-120b-a12b",
      "2026-05-20T00:00:00.000Z",
      "2026-05-20T00:00:00.000Z",
    );

    const store = new ArtifactStoreDO({ storage } as any, {} as any);
    const second = store.upsertReviewer(reviewerInput());
    expect(second.threadId).not.toBe("thread-1");
    expect(store.listReviewers("repo-1", "plan-1")).toHaveLength(2);

    const afterRestart = new ArtifactStoreDO({ storage } as any, {} as any);
    const third = afterRestart.upsertReviewer(reviewerInput());
    expect(third.threadId).not.toBe("thread-1");
    expect(afterRestart.listReviewers("repo-1", "plan-1")).toHaveLength(3);

    storage.close();
  });

});

describe("ArtifactStoreDO plan attention", () => {
  function createPlanAndReviewer(store: ArtifactStoreDO, options: { skillInvocationId?: string } = {}) {
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      createdBy: "test",
    });
    const reviewer = store.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
      ...(options.skillInvocationId ? { skillInvocationId: options.skillInvocationId } : {}),
    });
    return { plan, reviewer };
  }

  function createCurrentReviewerRun(
    store: ArtifactStoreDO,
    planArtifactId: string,
    threadId: string,
    options: { skillInvocationId?: string; startedAt?: string } = {},
  ) {
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId,
      ...(options.startedAt ? { startedAt: options.startedAt } : {}),
      ...(options.skillInvocationId ? {
        skillInvocationId: options.skillInvocationId,
        skillAgentId: "agent-1",
        skillRunRole: "child_initial" as const,
      } : {}),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId,
      threadId,
      runId: run.runId,
      status: "running",
      error: null,
    });
    return run;
  }

  function finishReviewer(
    store: ArtifactStoreDO,
    run: ReturnType<ArtifactStoreDO["createPlannerRun"]>,
    status: "completed" | "failed" = "completed",
  ) {
    return store.finishActiveReviewerRun({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      status,
      completedAt: "2026-08-10T00:00:00.000Z",
      error: status === "failed" ? "Review failed." : null,
      events: [{
        type: status === "failed" ? "run_failed" : "run_completed",
        message: status === "failed" ? "Review failed." : "Reviewer run completed.",
      }],
    });
  }

  it("fences dispatch failure finalization to the caller's runtime ownership", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
    const runtime = { jobSlug: "planner-run-owned" };
    expect(store.claimPlannerRunRuntime(run.runId, runtime)).toMatchObject({ runtime });
    const finish = (expectedRuntime: { jobSlug: string } | null) => store.finishActiveReviewerRun({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      status: "failed",
      completedAt: "2026-08-10T00:00:00.000Z",
      error: "Dispatch failed.",
      expectedRuntime,
      events: [{ type: "run_failed", message: "Dispatch failed." }],
    });

    expect(finish(null)).toMatchObject({
      finalized: false,
      run: expect.objectContaining({ status: "queued", runtime }),
    });
    expect(finish({ jobSlug: "planner-run-other" })).toMatchObject({
      finalized: false,
      run: expect.objectContaining({ status: "queued", runtime }),
    });
    expect(store.listPlannerRunEvents(run.runId)).toEqual([]);
    expect(finish(runtime)).toMatchObject({
      finalized: true,
      run: expect.objectContaining({ status: "failed", runtime }),
    });
    expect(store.listPlannerRunEvents(run.runId).map((event) => event.type)).toEqual(["run_failed"]);
    storage.close();
  });

  it("acknowledges exact reviewer tokens without letting replays clear or restore newer results", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const first = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
    expect(finishReviewer(store, first)).toMatchObject({ finalized: true });
    expect(store.listPlanAttention("repo-1")).toEqual([{
      planArtifactId: plan.id,
      sourceKind: "reviewer",
      sourceId: reviewer.threadId,
      token: first.runId,
    }]);

    expect(store.acknowledgePlanAttention({
      repoId: "repo-1",
      planArtifactId: plan.id,
      sourceKind: "reviewer",
      sourceId: reviewer.threadId,
      token: first.runId,
    })).toBe("acknowledged");
    expect(store.acknowledgePlanAttention({
      repoId: "repo-1",
      planArtifactId: plan.id,
      sourceKind: "reviewer",
      sourceId: reviewer.threadId,
      token: first.runId,
    })).toBe("absent");
    expect(finishReviewer(store, first)).toMatchObject({ finalized: false });
    expect(store.listPlanAttention("repo-1")).toEqual([]);

    const second = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
    finishReviewer(store, second, "failed");
    expect(store.acknowledgePlanAttention({
      repoId: "repo-1",
      planArtifactId: plan.id,
      sourceKind: "reviewer",
      sourceId: reviewer.threadId,
      token: first.runId,
    })).toBe("conflict");
    expect(store.listPlanAttention("repo-1")[0]?.token).toBe(second.runId);
    storage.close();
  });

  it("returns artifacts, refs, and attention from one repository transaction", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    store.setRef({ repoId: "repo-1", name: "latest-plan", artifactId: plan.id });
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
    finishReviewer(store, run);
    const transaction = vi.spyOn(storage, "transactionSync");

    const state = store.getRepoArtifactState("repo-1");

    expect(transaction).toHaveBeenCalledOnce();
    expect(state.artifacts).toContainEqual(expect.objectContaining({ id: plan.id }));
    expect(state.refs).toEqual([expect.objectContaining({ name: "latest-plan", artifactId: plan.id })]);
    expect(state.attention).toEqual([{
      planArtifactId: plan.id,
      sourceKind: "reviewer",
      sourceId: reviewer.threadId,
      token: run.runId,
    }]);
    storage.close();
  });

  it("binds a new reviewer run atomically and lets duplicate callbacks resume from saving", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);

    const created = store.createPlannerRunIfNoActive({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedPlanVersion: plan.version,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: reviewer.threadId,
      launchProvenance: CURRENT_CF_LAUNCH,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected reviewer run creation");
    expect(store.getReviewer(reviewer.threadId)).toMatchObject({
      runId: created.run.runId,
      status: "queued",
    });
    expect(store.claimPlannerRunSaving(created.run.runId)).toMatchObject({ status: "saving" });
    expect(store.claimPlannerRunSaving(created.run.runId)).toMatchObject({
      runId: created.run.runId,
      status: "saving",
    });
    storage.close();
  });

  it("lets only one in-process executor claim a queued reviewer run", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId);

    expect(store.claimQueuedPlannerRunForInProcess(run.runId)).toMatchObject({
      runId: run.runId,
      status: "running",
      lastContactAt: expect.any(String),
    });
    expect(store.claimQueuedPlannerRunForInProcess(run.runId)).toBeNull();
    expect(store.getReviewer(reviewer.threadId)).toMatchObject({
      runId: run.runId,
      status: "running",
    });
    storage.close();
  });

  it("ensures one queued event across setup retries", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
    const input = {
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      type: "run_queued" as const,
      message: "Queued once.",
    };

    const first = store.ensurePlannerRunQueuedEvent(input);
    const second = store.ensurePlannerRunQueuedEvent(input);
    expect(second).toEqual(first);
    expect(store.listPlannerRunEvents(run.runId)).toEqual([first]);
    storage.close();
  });

  it("keeps a claimed successful result resumable instead of overwriting it with failure", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId);

    expect(store.claimPlannerRunSaving(run.runId)).toMatchObject({ status: "saving" });
    expect(finishReviewer(store, run, "failed")).toMatchObject({
      finalized: false,
      run: expect.objectContaining({ status: "saving" }),
    });
    expect(store.listPlannerRunEvents(run.runId)).toEqual([]);
    expect(store.listPlanAttention("repo-1")).toEqual([]);

    expect(finishReviewer(store, run, "completed")).toMatchObject({
      finalized: true,
      run: expect.objectContaining({ status: "completed" }),
    });
    expect(store.listPlanAttention("repo-1")).toEqual([
      expect.objectContaining({ token: run.runId }),
    ]);
    storage.close();
  });

  it("lets only the stale-saving watchdog abandon a claimed result", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId, {
      startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });
    expect(store.claimPlannerRunSaving(run.runId)).toMatchObject({ status: "saving" });

    expect(store.finishActiveReviewerRun({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "Timed out.",
      staleActiveCutoff: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      events: [{ type: "run_failed", message: "Timed out." }],
    })).toMatchObject({
      finalized: true,
      run: expect.objectContaining({ status: "failed" }),
    });
    storage.close();
  });

  it("rechecks fresh result contact inside stale-saving finalization", () => {
    const { storage, store } = createSubject();
    const { plan, reviewer } = createPlanAndReviewer(store);
    const run = createCurrentReviewerRun(store, plan.id, reviewer.threadId, {
      startedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString(),
    });
    expect(store.claimPlannerRunSaving(run.runId)).toMatchObject({ status: "saving" });
    expect(store.getPlannerRunAndRecordContact(run.runId)).toMatchObject({
      status: "saving",
      lastContactAt: expect.any(String),
    });

    expect(store.finishActiveReviewerRun({
      runId: run.runId,
      repoId: run.repoId,
      planArtifactId: run.planArtifactId,
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "Timed out.",
      staleActiveCutoff: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
      events: [{ type: "run_failed", message: "Timed out." }],
    })).toMatchObject({
      finalized: false,
      run: expect.objectContaining({ status: "saving" }),
    });
    expect(store.listPlannerRunEvents(run.runId)).toEqual([]);
    storage.close();
  });

  it.each(["completed", "archived"] as const)(
    "clears %s-plan attention atomically and fences late completions",
    (terminalStatus) => {
      const { storage, store } = createSubject();
      const { plan, reviewer } = createPlanAndReviewer(store);
      const first = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
      finishReviewer(store, first);
      const late = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
      const lateRuntime = { jobSlug: plannerJobSlug(late.runId) };
      store.setPlannerRunRuntime(late.runId, lateRuntime);

      const writer = store.startPlanWriter({
      skills: [],
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "claude-code",
        model: "claude-test",
        basisCommit: "main-1",
        startBodyDigest: sha256("# Plan\n"),
        launchProvenance: CURRENT_CF_LAUNCH,
      });
      const runtime = {
        jobSlug: planWriterTerminalId("repo-1", plan.id, writer.generation!),
        generation: writer.generation!,
      };
      store.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
      store.registerPlanWriterRuntime({
        repoId: "repo-1",
        planArtifactId: plan.id,
        generation: writer.generation!,
        runtime,
        providerConversationId: "conversation-1",
      });
      expect(store.recordPlanWriterCompletion({
        repoId: "repo-1",
        planArtifactId: plan.id,
        generation: writer.generation!,
        sequence: 1,
      })).toEqual({ status: "recorded" });
      expect(store.listPlanAttention("repo-1")).toHaveLength(2);

      const transition = store.updateArtifactStatus({
        repoId: "repo-1",
        id: plan.id,
        status: terminalStatus,
      });
      expect(store.listPlanAttention("repo-1")).toEqual([]);
      expect(transition.terminalWriter).toMatchObject({
        generation: writer.generation,
        stopReason: terminalStatus,
      });
      expect(transition.runtimeCleanupRuns).toEqual([
        expect.objectContaining({ runId: late.runId, runtime: lateRuntime }),
      ]);
      expect(transition.cleanupTargets).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "writer", ownerId: writer.threadId, runtime }),
        expect.objectContaining({ kind: "reviewer", ownerId: late.runId }),
      ]));
      expect(store.updateArtifactStatus({
        repoId: "repo-1",
        id: plan.id,
        status: terminalStatus,
      })).toMatchObject({
        terminalWriter: null,
        runtimeCleanupRuns: [],
        cleanupTargets: [
          expect.objectContaining({ kind: "writer", generation: writer.generation }),
          expect.objectContaining({ kind: "reviewer", ownerId: late.runId }),
        ],
      });
      store.clearPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
      store.clearPlannerRunRuntimeIfCurrent(late.runId, lateRuntime);
      expect(store.updateArtifactStatus({
        repoId: "repo-1",
        id: plan.id,
        status: terminalStatus,
      })).toMatchObject({ terminalWriter: null, runtimeCleanupRuns: [] });
      expect(store.getPlanWriter("repo-1", plan.id)).toMatchObject({
        stoppedAt: expect.any(String),
        stopReason: terminalStatus,
      });
      expect(finishReviewer(store, late)).toMatchObject({
        finalized: false,
        run: { status: "cancelled" },
      });
      expect(store.recordPlanWriterCompletion({
        repoId: "repo-1",
        planArtifactId: plan.id,
        generation: writer.generation!,
        sequence: 2,
      })).toMatchObject({ status: "stale", reason: "runtime" });

      store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "draft" });
      expect(store.listPlanAttention("repo-1")).toEqual([]);
      expect(store.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toHaveLength(2);
      expect(store.recordPlanWriterCompletion({
        repoId: "repo-1",
        planArtifactId: plan.id,
        generation: writer.generation!,
        sequence: 2,
      })).toMatchObject({ status: "stale", reason: "runtime" });

      const later = createCurrentReviewerRun(store, plan.id, reviewer.threadId);
      expect(finishReviewer(store, later)).toMatchObject({ finalized: true });
      expect(store.listPlanAttention("repo-1")).toEqual([expect.objectContaining({
        sourceKind: "reviewer",
        token: later.runId,
      })]);
      storage.close();
    },
  );

  it("orders Scribe settlements per generation and preserves unread attention when new work starts", () => {
    const { storage, store } = createSubject();
    const { plan } = createPlanAndReviewer(store);
    const first = store.startPlanWriter({
      skills: [DEFAULT_PLAN_HEALTH_SKILL],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const firstRuntime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, 1),
      generation: 1,
    };
    store.setPlanWriterRuntimeIfCurrent(first.threadId, firstRuntime);
    store.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      runtime: firstRuntime,
      providerConversationId: "conversation-1",
    });
    expect(store.recordPlanWriterCompletion({ repoId: "repo-1", planArtifactId: plan.id, generation: 1, sequence: 1 }))
      .toEqual({ status: "recorded" });
    const firstAttention = store.listPlanAttention("repo-1").find((item) => item.sourceKind === "scribe")!;
    expect(firstAttention.token).toBe("1:1");

    store.fencePlanWriterStop({ repoId: "repo-1", planArtifactId: plan.id, expectedGeneration: 1, reason: "user" });
    expect(store.recordPlanWriterCompletion({ repoId: "repo-1", planArtifactId: plan.id, generation: 1, sequence: 1 }))
      .toMatchObject({ status: "stale" });
    store.clearPlanWriterRuntimeIfCurrent(first.threadId, firstRuntime);
    const second = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(second.generation).toBe(2);
    expect(store.listPlanAttention("repo-1").find((item) => item.sourceKind === "scribe")?.token).toBe("1:1");
    const secondRuntime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, 2),
      generation: 2,
    };
    store.setPlanWriterRuntimeIfCurrent(second.threadId, secondRuntime);
    store.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 2,
      runtime: secondRuntime,
      providerConversationId: "conversation-2",
    });
    expect(store.recordPlanWriterCompletion({ repoId: "repo-1", planArtifactId: plan.id, generation: 1, sequence: 2 }))
      .toMatchObject({ status: "stale", reason: "generation" });
    expect(store.recordPlanWriterCompletion({ repoId: "repo-1", planArtifactId: plan.id, generation: 2, sequence: 1 }))
      .toEqual({ status: "recorded" });
    expect(store.listPlanAttention("repo-1").find((item) => item.sourceKind === "scribe")?.token).toBe("2:1");
    expect(store.acknowledgePlanAttention({
      repoId: "repo-1",
      planArtifactId: plan.id,
      sourceKind: "scribe",
      sourceId: second.threadId,
      token: "2:1",
    })).toBe("acknowledged");
    expect(store.recordPlanWriterCompletion({ repoId: "repo-1", planArtifactId: plan.id, generation: 2, sequence: 1 }))
      .toEqual({ status: "replayed" });
    expect(store.recordPlanWriterCompletion({ repoId: "repo-1", planArtifactId: plan.id, generation: 2, sequence: 0 }))
      .toMatchObject({ status: "stale", reason: "sequence" });
    expect(store.listPlanAttention("repo-1").filter((item) => item.sourceKind === "scribe")).toEqual([]);
    storage.close();
  });

  it("never exposes removed reviewers and does expose completed Plan Skill conversations", () => {
    const { storage, store } = createSubject();
    const visible = createPlanAndReviewer(store);
    const visibleRun = createCurrentReviewerRun(store, visible.plan.id, visible.reviewer.threadId);
    finishReviewer(store, visibleRun, "failed");
    expect(store.listPlanAttention("repo-1")).toHaveLength(1);
    store.removeReviewer("repo-1", visible.plan.id, visible.reviewer.threadId);
    expect(store.listPlanAttention("repo-1")).toEqual([]);

    const hidden = createPlanAndReviewer(store, { skillInvocationId: "invocation-1" });
    const hiddenRun = createCurrentReviewerRun(
      store,
      hidden.plan.id,
      hidden.reviewer.threadId,
      { skillInvocationId: "invocation-1" },
    );
    finishReviewer(store, hiddenRun);
    expect(store.listPlanAttention("repo-1")).toHaveLength(1);
    storage.close();
  });

  it("atomically rejects terminal and stale-version work starts", () => {
    const { storage, store } = createSubject();
    const { plan } = createPlanAndReviewer(store);
    const initialVersion = plan.version ?? 1;
    const reviewerStart = () => store.createPlannerRunIfNoActive({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedPlanVersion: initialVersion,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const writerStart = () => store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedPlanVersion: initialVersion,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const skillStart = () => store.reservePlanSkillInvocation({
      invocationId: "late-skill",
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedPlanVersion: initialVersion,
      parentThreadId: `plan-skills-${plan.id}`,
      definitionSnapshot: DEFAULT_PLAN_REVIEW_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Plan",
        version: initialVersion,
        gitBaseCommitSha: "main-1",
      },
      agents: [{
        id: DEFAULT_PLAN_REVIEW_SKILL.agents[0]!.id,
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      }],
    });

    store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "completed" });
    expect(reviewerStart).toThrow(/completed or archived/i);
    expect(writerStart).toThrow(/completed or archived/i);
    expect(skillStart).toThrow(/completed or archived/i);

    store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "draft" });
    expect(reviewerStart).toThrow(/version mismatch/i);
    expect(writerStart).toThrow(/version mismatch/i);
    expect(skillStart).toThrow(/version mismatch/i);
    expect(store.getActivePlannerRun("repo-1", plan.id, "reviewer", null)).toBeNull();
    expect(store.getPlanWriter("repo-1", plan.id)).toBeNull();
    expect(store.getPlanSkillInvocation("late-skill")).toBeNull();
    storage.close();
  });
});

describe("ArtifactStoreDO plan skill invocations", () => {
  it.each(["setting_up", "active"] as const)(
    "cancels a %s invocation atomically when its plan becomes terminal",
    (invocationStatus) => {
      const { storage, store } = createSubject();
      const plan = store.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: "Plan",
        body: { markdown: "# Plan\n" },
        status: "draft",
        createdBy: "test",
      });
      const reserved = store.reservePlanSkillInvocation({
        invocationId: `terminal-${invocationStatus}`,
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: `plan-skill-root:terminal-${invocationStatus}`,
        definitionSnapshot: DEFAULT_PLAN_REVIEW_SKILL,
        basis: {
          artifactId: plan.id,
          title: "Plan",
          markdown: "# Plan",
          version: 1,
          gitBaseCommitSha: "main-1",
        },
        agents: [{
          id: DEFAULT_PLAN_REVIEW_SKILL.agents[0]!.id,
          provider: "fake",
          model: "fake-fast",
          launchProvenance: CURRENT_CF_LAUNCH,
        }],
      });
      if (reserved.status === "conflict") throw new Error("unexpected conflict");
      if (invocationStatus === "active") {
        store.activatePlanSkillInvocation(`terminal-${invocationStatus}`);
      }

      const transition = store.updateArtifactStatus({
        repoId: "repo-1",
        id: plan.id,
        status: "completed",
      });
      expect(store.getPlanSkillInvocation(`terminal-${invocationStatus}`)).toMatchObject({
        status: "cancelled",
        cancelledAt: expect.any(String),
      });
      expect(store.listPlanSkillInvocationRuns(`terminal-${invocationStatus}`))
        .toEqual(reserved.runs.map((run) => expect.objectContaining({
          runId: run.runId,
          status: "cancelled",
        })));

      store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "draft" });
      expect(store.activatePlanSkillInvocation(`terminal-${invocationStatus}`)?.status).toBe("cancelled");
      storage.close();
    },
  );

  it("reserves child ids once, hides linked reviewers, and derives terminal status", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Frozen plan" },
      status: "draft",
    });
    const definition = {
      ...DEFAULT_PLAN_REVIEW_SKILL,
      agents: [
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "architecture" },
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "risk", label: "Risk Reviewer" },
      ],
    };
    const input = {
      invocationId: "invoke-1",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:invoke-1",
      definitionSnapshot: definition,
      basis: {
        artifactId: plan.id,
        title: "Plan",
        markdown: "# Frozen plan",
        version: 7,
        gitBaseCommitSha: "base-1",
      },
      agents: [
        { id: "architecture", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
        { id: "risk", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
      ],
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "medium" as const },
    };
    const first = store.reservePlanSkillInvocation(input);
    const second = store.reservePlanSkillInvocation(input);
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status === "conflict" || second.status === "conflict") throw new Error("unexpected conflict");
    expect(second.runs.map((run) => run.runId)).toEqual(first.runs.map((run) => run.runId));
    expect(second.reviewers.map((reviewer) => reviewer.threadId)).toEqual(first.reviewers.map((reviewer) => reviewer.threadId));
    expect(store.listReviewers("repo-1", plan.id).map((reviewer) => reviewer.nodeKind))
      .toEqual(["skill_root", "report", "report"]);
    expect(first.runs[0]?.input?.basis).toEqual(input.basis);

    store.activatePlanSkillInvocation("invoke-1");
    store.updatePlannerRun({ runId: first.runs[0]!.runId, status: "completed", completedAt: new Date().toISOString() });
    expect(store.getPlanSkillInvocation("invoke-1")?.status).toBe("active");
    store.updatePlannerRun({ runId: first.runs[1]!.runId, status: "failed", completedAt: new Date().toISOString(), error: "failed" });
    completePlanSkillOverview(store, "invoke-1");
    expect(store.getPlanSkillInvocation("invoke-1")?.status).toBe("completed");

    const followup = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: first.reviewers[0]!.threadId,
      skillInvocationId: "invoke-1",
      skillAgentId: "architecture",
      skillRunRole: "report_followup",
      input: { basis: input.basis },
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.updatePlannerRun({ runId: followup.runId, status: "completed", completedAt: new Date().toISOString() });
    expect(store.getPlanSkillInvocation("invoke-1")?.status).toBe("completed");
    storage.close();
  });

  it("does not terminalize an invocation until every frozen agent has a current initial run", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Frozen plan" },
      status: "draft",
    });
    const definition = {
      ...DEFAULT_PLAN_REVIEW_SKILL,
      agents: [
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "one" },
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "two" },
      ],
    };
    const reserved = store.reservePlanSkillInvocation({
      invocationId: "missing-current-agent",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:missing-current-agent",
      definitionSnapshot: definition,
      basis: { artifactId: plan.id, title: "Plan", markdown: "# Frozen plan", version: 1, gitBaseCommitSha: "base-1" },
      agents: definition.agents.map((agent) => ({
        id: agent.id,
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      })),
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "medium" },
    });
    if (reserved.status === "conflict") throw new Error("unexpected conflict");
    store.activatePlanSkillInvocation("missing-current-agent");
    storage.sql.exec("DELETE FROM planner_runs WHERE run_id = ?", reserved.runs[1]!.runId);
    store.updatePlannerRun({
      runId: reserved.runs[0]!.runId,
      status: "completed",
      completedAt: new Date().toISOString(),
    });

    expect(store.getPlanSkillInvocation("missing-current-agent")?.status).toBe("active");
    storage.close();
  });

  it("fences skill-root archival until linked work is cancelled", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan" },
      status: "draft",
    });
    const reserved = store.reservePlanSkillInvocation({
      invocationId: "remove-fence",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:remove-fence",
      definitionSnapshot: DEFAULT_PLAN_REVIEW_SKILL,
      basis: { artifactId: plan.id, title: "Plan", markdown: "# Plan", version: 1, gitBaseCommitSha: "base-1" },
      agents: [{
        id: DEFAULT_PLAN_REVIEW_SKILL.agents[0]!.id,
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      }],
    });
    if (reserved.status === "conflict") throw new Error("unexpected conflict");

    expect(() => store.removeReviewer("repo-1", plan.id, reserved.reviewers[0]!.threadId)).toThrow(/active work/i);
    store.cancelPlanSkillInvocation("remove-fence");
    expect(store.removeReviewer("repo-1", plan.id, reserved.reviewers[0]!.threadId).removedAt).toEqual(expect.any(String));
    storage.close();
  });

  it("fails a fanout when no initial child succeeds and keeps exactly one invocation table", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan" },
      status: "draft",
    });
    const definition = {
      ...DEFAULT_PLAN_REVIEW_SKILL,
      agents: [
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "one" },
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "two" },
      ],
    };
    const reserved = store.reservePlanSkillInvocation({
      invocationId: "invoke-zero",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:invoke-zero",
      definitionSnapshot: definition,
      basis: { artifactId: plan.id, title: "Plan", markdown: "frozen", version: 1, gitBaseCommitSha: null },
      agents: [
        { id: "one", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
        { id: "two", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
      ],
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "medium" },
    });
    if (reserved.status === "conflict") throw new Error("unexpected conflict");
    store.activatePlanSkillInvocation("invoke-zero");
    for (const run of reserved.runs) {
      store.updatePlannerRun({ runId: run.runId, status: "failed", completedAt: new Date().toISOString(), error: "no result" });
    }
    store.failPlanSkillInvocation("invoke-zero", "No Report succeeded, so an Overview could not be created.");
    expect(store.getPlanSkillInvocation("invoke-zero")?.status).toBe("failed");
    const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%skill_invocations'").toArray();
    expect(tables).toEqual([{ name: "plan_skill_invocations" }]);
    storage.close();
  });

  it("reuses frozen child conversations for deterministic reruns with the latest Plan basis", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# First basis" },
      status: "draft",
    });
    const definition = {
      ...DEFAULT_PLAN_REVIEW_SKILL,
      agents: [
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "one", label: "One" },
        { ...DEFAULT_PLAN_REVIEW_SKILL.agents[0]!, id: "two", label: "Two" },
      ],
    };
    const first = store.reservePlanSkillInvocation({
      invocationId: "rerunnable",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:rerunnable",
      definitionSnapshot: definition,
      basis: { artifactId: plan.id, title: "Plan", markdown: "# First basis", version: 1, gitBaseCommitSha: "base-1" },
      agents: definition.agents.map((agent) => ({ id: agent.id, provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH })),
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "medium" },
    });
    if (first.status !== "created") throw new Error("expected initial fanout");
    store.activatePlanSkillInvocation("rerunnable");
    for (const run of first.runs) {
      store.updatePlannerRun({ runId: run.runId, status: "completed", completedAt: new Date().toISOString() });
    }
    completePlanSkillOverview(store, "rerunnable");
    const saved = store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "# Latest basis\n\nChanged." });
    const rerunInput = {
      invocationId: "rerunnable",
      requestId: "rerun-request-1",
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedPlanVersion: saved.artifact.version,
      basis: {
        artifactId: plan.id,
        title: saved.artifact.title,
        markdown: "# Latest basis\n\nChanged.",
        version: saved.artifact.version ?? 2,
        gitBaseCommitSha: "base-2",
      },
      agents: definition.agents.map((agent) => ({ id: agent.id, provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH })),
      overviewRoute: { provider: "codex", model: "gpt-5.5", effort: "high" as const },
    };
    const rerun = store.reservePlanSkillInvocationRerun(rerunInput);
    expect(rerun.status).toBe("created");
    expect(rerun.invocation).toMatchObject({
      invocationId: "rerun-request-1",
      status: "setting_up",
      basis: { markdown: "# Latest basis\n\nChanged.", version: saved.artifact.version },
      definitionSnapshot: definition,
    });
    expect(rerun.reviewers.map((reviewer) => reviewer.threadId)).toEqual(first.reviewers.map((reviewer) => reviewer.threadId));
    expect(store.getReviewer("plan-skill-root:rerunnable")).toMatchObject({
      skillInvocationId: "rerun-request-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
    });
    expect(rerun.reviewers.every((reviewer) => reviewer.skillInvocationId === "rerun-request-1")).toBe(true);
    expect(rerun.runs.map((run) => run.runId)).toEqual([
      "plan-skill-round:rerun-request-1:one",
      "plan-skill-round:rerun-request-1:two",
    ]);
    expect(rerun.runs.every((run) => run.input?.basis?.markdown === "# Latest basis\n\nChanged.")).toBe(true);
    expect(store.reservePlanSkillInvocationRerun(rerunInput)).toMatchObject({
      status: "existing",
      runs: rerun.runs.map((run) => ({ runId: run.runId })),
    });
    expect(() => store.reservePlanSkillInvocationRerun({
      ...rerunInput,
      requestId: "rerun-request-2",
    })).toThrow("Only the latest Plan Skill round can be re-reviewed.");
    storage.close();
  });

  it("measures stale setup from the current rerun attempt", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T00:00:00.000Z"));
    try {
      const { storage, store } = createSubject();
      const plan = store.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "base-1" },
        title: "Plan",
        body: { markdown: "# Plan" },
        status: "draft",
      });
      const first = store.reservePlanSkillInvocation({
        invocationId: "fresh-rerun-setup",
        repoId: "repo-1",
        planArtifactId: plan.id,
        parentThreadId: "plan-skill-root:fresh-rerun-setup",
        definitionSnapshot: DEFAULT_PLAN_REVIEW_SKILL,
        basis: { artifactId: plan.id, title: "Plan", markdown: "# Plan", version: 1, gitBaseCommitSha: "base-1" },
        agents: [{
          id: DEFAULT_PLAN_REVIEW_SKILL.agents[0]!.id,
          provider: "fake",
          model: "fake-fast",
          launchProvenance: CURRENT_CF_LAUNCH,
        }],
      });
      if (first.status === "conflict") throw new Error("unexpected conflict");
      store.activatePlanSkillInvocation("fresh-rerun-setup");
      store.updatePlannerRun({
        runId: first.runs[0]!.runId,
        status: "completed",
        completedAt: new Date().toISOString(),
      });

      vi.setSystemTime(new Date("2026-08-12T00:10:00.000Z"));
      store.reservePlanSkillInvocationRerun({
        invocationId: "fresh-rerun-setup",
        requestId: "attempt-2",
        repoId: "repo-1",
        planArtifactId: plan.id,
        basis: { artifactId: plan.id, title: "Plan", markdown: "# Plan", version: 1, gitBaseCommitSha: "base-1" },
        agents: [{
          id: DEFAULT_PLAN_REVIEW_SKILL.agents[0]!.id,
          provider: "fake",
          model: "fake-fast",
          launchProvenance: CURRENT_CF_LAUNCH,
        }],
      });

      expect(store.failStalePlanSkillInvocations(
        "repo-1",
        plan.id,
        "2026-08-12T00:05:00.000Z",
      )).toEqual([]);
      expect(store.getPlanSkillInvocation("attempt-2")?.status).toBe("setting_up");
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ArtifactStoreDO Plan Health assessments", () => {
  function reserveHealth(
    store: ArtifactStoreDO,
    plan: { id: string; title: string; body: unknown; version?: number },
    invocationId: string,
    parentThreadId?: string,
  ) {
    const rootThreadId = parentThreadId ?? `plan-health-root:${invocationId}`;
    const reserved = store.reservePlanSkillInvocation({
      invocationId,
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: rootThreadId,
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: typeof plan.body === "object" && plan.body && "markdown" in plan.body
          ? String((plan.body as { markdown: unknown }).markdown)
          : "",
        normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
        version: plan.version ?? 1,
        gitBaseCommitSha: "base-1",
      },
      agents: [{
        id: "plan-health-assessor",
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      }],
    });
    if (reserved.status !== "created") throw new Error("expected Health reservation");
    store.activatePlanSkillInvocation(invocationId);
    const parent = store.getReviewer(rootThreadId)!;
    return { parent, run: reserved.runs[0]! };
  }

  it("stores an immutable valid result, applies current content, and safely replays", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan\r\n\r\nShip it.  \r\n" },
      status: "draft",
      version: 4,
    });
    expect(plan.planHealth).toBeUndefined();
    const { run } = reserveHealth(store, plan, "health-1");
    expect(run.input).not.toHaveProperty("initialResultHandler");
    const rawInput = storage.sql.exec(
      "SELECT input_json FROM planner_runs WHERE run_id = ?",
      run.runId,
    ).toArray()[0] as { input_json: string };
    expect(JSON.parse(rawInput.input_json)).toMatchObject({ initialResultHandler: "plan-health@1" });

    const completed = store.completePlanHealthReviewerOutput(run.runId, {
      status: "succeeded",
      text: `  ${healthOutput("medium", "medium", "The rollout crosses several components but has a feasible rollback.", "The work coordinates several components in one phase.")}\n`,
    });
    expect(completed).toMatchObject({
      handled: true,
      finalized: true,
      run: { status: "completed" },
      result: {
        kind: "plan-health",
        schemaVersion: 1,
        assessments: {
          risk: {
            level: "medium",
            summary: "The rollout crosses several components but has a feasible rollback.",
          },
          changeSize: {
            size: "medium",
            summary: "The work coordinates several components in one phase.",
          },
        },
        basisVersion: 4,
        application: "applied",
      },
    });
    const invocation = store.getPlanSkillInvocation("health-1")!;
    expect(invocation.status).toBe("completed");
    expect(invocation.result).toEqual(completed.result);
    expect(store.getArtifact(plan.id)?.planHealth).toMatchObject({
      schemaVersion: 1,
      assessments: completed.result?.assessments,
      basisVersion: 4,
      skillInvocationId: "health-1",
    });
    expect(store.getPlanHealthVirtualMessage(run.threadId!)?.body).toMatchObject({
      role: "assistant",
      text: "Risk: Medium — The rollout crosses several components but has a feasible rollback.\n\nChange size: Medium — The work coordinates several components in one phase.\n\nApplied to the current plan.",
      virtual: "plan-health-result",
      forwardable: false,
    });
    expect(store.completePlanHealthReviewerOutput(run.runId, {
      status: "succeeded",
      text: healthOutput("high", "large", "A replay must not replace the result."),
    })).toMatchObject({
      handled: true,
      finalized: false,
      result: completed.result,
    });

    const followup = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: run.threadId,
      skillInvocationId: "health-1",
      skillAgentId: "plan-health-assessor",
      skillRunRole: "root_followup",
      input: { basis: invocation.basis },
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: run.threadId!,
      runId: followup.runId,
      status: "queued",
    });
    expect(store.completePlanHealthReviewerOutput(run.runId, {
      status: "succeeded",
      text: healthOutput("high", "large", "A late initial callback is still a replay."),
    })).toMatchObject({
      handled: true,
      finalized: false,
      result: completed.result,
    });
    storage.close();
  });

  it("fences Health completion to its runtime owner and terminal plan state", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan" },
      status: "draft",
    });
    const owned = reserveHealth(store, plan, "health-runtime-owner");
    const runtime = { jobSlug: plannerJobSlug(owned.run.runId) };
    store.setPlannerRunRuntime(owned.run.runId, runtime);

    expect(
      store.completePlanHealthReviewerOutput(
        owned.run.runId,
        {
          status: "succeeded",
          text: healthOutput("low", "small", "Localized and reversible."),
        },
        { expectedRuntime: { jobSlug: `${runtime.jobSlug}-stale` } },
      ),
    ).toMatchObject({
      handled: true,
      finalized: false,
      run: { status: "queued" },
    });
    expect(store.getPlanSkillInvocation("health-runtime-owner")).toMatchObject({
      status: "active",
      result: null,
    });
    expect(store.getArtifact(plan.id)?.planHealth).toBeUndefined();

    expect(
      store.completePlanHealthReviewerOutput(
        owned.run.runId,
        {
          status: "succeeded",
          text: healthOutput("low", "small", "Localized and reversible."),
        },
        { expectedRuntime: runtime },
      ),
    ).toMatchObject({ finalized: true, result: { application: "applied" } });

    const terminalPlan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Terminal plan",
      body: { markdown: "# Terminal plan" },
      status: "draft",
    });
    const terminal = reserveHealth(
      store,
      terminalPlan,
      "health-terminal-plan",
    );
    store.updateArtifactStatus({
      repoId: "repo-1",
      id: terminalPlan.id,
      status: "completed",
    });
    const late = store.completePlanHealthReviewerOutput(terminal.run.runId, {
      status: "succeeded",
      text: healthOutput("high", "large", "This result arrived too late."),
    });
    expect(late).toMatchObject({
      handled: true,
      finalized: false,
      run: { status: "cancelled" },
      error: "Skill invocation cancelled.",
    });
    expect(late).not.toHaveProperty("result");
    expect(store.getPlanSkillInvocation("health-terminal-plan")).toMatchObject({
      status: "cancelled",
      result: null,
    });
    expect(store.getArtifact(terminalPlan.id)?.planHealth).toBeUndefined();
    storage.close();
  });

  it("atomically fails invalid or provider output without publishing a result", () => {
    for (const [id, output] of [
      ["invalid-risk", { status: "succeeded" as const, text: '```json\n{"level":"low","summary":"No."}\n```' }],
      ["provider-risk", { status: "failed" as const, error: "Provider unavailable." }],
    ] as const) {
      const { storage, store } = createSubject();
      const plan = store.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "base-1" },
        title: "Plan",
        body: { markdown: "# Plan" },
        status: "draft",
      });
      const { run } = reserveHealth(store, plan, id);
      const result = store.completePlanHealthReviewerOutput(run.runId, output);
      expect(result).toMatchObject({ handled: true, finalized: true, run: { status: "failed" } });
      expect(result).not.toHaveProperty("result");
      expect(store.getPlanSkillInvocation(id)).toMatchObject({ status: "failed", result: null });
      expect(store.getArtifact(plan.id)?.planHealth).toBeUndefined();
      const raw = storage.sql.exec(
        "SELECT result_json FROM plan_skill_invocations WHERE invocation_id = ?",
        id,
      ).toArray()[0] as { result_json: string | null };
      expect(raw.result_json).toBeNull();
      storage.close();
    }
  });

  it("tracks staleness without revision churn and applies after change-then-revert equality", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      version: 2,
    });
    const first = reserveHealth(store, plan, "health-fresh");
    store.completePlanHealthReviewerOutput(first.run.runId, {
      status: "succeeded",
      text: healthOutput("low", "small", "Localized and reversible."),
    });
    const assessed = store.getArtifact(plan.id)!;
    expect(assessed.version).toBe(2);
    expect(assessed.planHealth?.staleAt).toBeUndefined();

    const noOp = store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "# Plan\r\n\r\n  \r\n" });
    expect(noOp).toMatchObject({ changed: false, artifact: { version: 2 } });
    expect(noOp.artifact.planHealth?.staleAt).toBeUndefined();
    const changed = store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "# Plan\n\nChanged." });
    expect(changed).toMatchObject({ changed: true, artifact: { version: 3 } });
    const staleAt = changed.artifact.planHealth?.staleAt;
    expect(staleAt).toEqual(expect.any(String));
    const changedAgain = store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "# Plan\n\nChanged again." });
    expect(changedAgain.artifact.planHealth?.staleAt).toBe(staleAt);

    const current = store.getArtifact(plan.id)!;
    const second = reserveHealth(store, current, "health-reverted");
    store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "# Temporary mismatch" });
    store.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: (current.body as { markdown: string }).markdown,
    });
    expect(store.getArtifact(plan.id)?.planHealth?.staleAt).toBe(staleAt);
    store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "evaluating" });
    const completion = store.completePlanHealthReviewerOutput(second.run.runId, {
      status: "succeeded",
      text: healthOutput("high", "large", "Core infrastructure changes carry a broad blast radius."),
    });
    expect(completion).toMatchObject({
      result: {
        application: "applied",
        assessments: { risk: { level: "high" }, changeSize: { size: "large" } },
      },
    });
    expect(store.getArtifact(plan.id)?.planHealth).toMatchObject({
      assessments: { risk: { level: "high" }, changeSize: { size: "large" } },
      skillInvocationId: "health-reverted",
    });
    expect(store.getArtifact(plan.id)?.planHealth?.staleAt).toBeUndefined();
    storage.close();
  });

  it("records plan_changed, uses marker-only concurrency, and tolerates malformed JSON", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan" },
      status: "draft",
    });
    const active = reserveHealth(store, plan, "active-health");
    const secondParent = store.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "fake",
      model: "fake-fast",
    });
    expect(() => reserveHealth(store, plan, "competing-health", secondParent.threadId))
      .toThrow(/already active/);
    const unrelated = store.reservePlanSkillInvocation({
      invocationId: "unrelated-review",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-skill-root:unrelated-review",
      definitionSnapshot: DEFAULT_PLAN_REVIEW_SKILL,
      basis: { artifactId: plan.id, title: plan.title, markdown: "# Plan", version: 1, gitBaseCommitSha: "base-1" },
      agents: [{
        id: DEFAULT_PLAN_REVIEW_SKILL.agents[0]!.id,
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      }],
    });
    expect(unrelated.status).toBe("created");
    store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "# Changed" });
    const mismatch = store.completePlanHealthReviewerOutput(active.run.runId, {
      status: "succeeded",
      text: healthOutput("medium", "medium", "The assessed basis no longer matches."),
    });
    expect(mismatch).toMatchObject({ result: { application: "plan_changed" } });
    expect(store.getArtifact(plan.id)?.planHealth).toBeUndefined();

    for (const malformed of [
      "not-json",
      JSON.stringify({
        schemaVersion: 1,
        assessments: {
          risk: { level: "low", summary: " padded " },
          changeSize: { size: "small", summary: "Bounded work." },
        },
        assessedAt: "2026-08-12T00:00:00.000Z",
        basisVersion: 1,
        skillInvocationId: "active-health",
      }),
      JSON.stringify({
        schemaVersion: 2,
        assessments: {
          risk: { level: "low", summary: "Fine." },
          changeSize: { size: "small", summary: "Bounded work." },
        },
        assessedAt: "2026-08-12T00:00:00.000Z",
        basisVersion: 1,
        skillInvocationId: "active-health",
      }),
    ]) {
      storage.sql.exec("UPDATE artifacts SET plan_health_json = ? WHERE id = ?", malformed, plan.id);
      expect(store.getArtifact(plan.id)?.planHealth).toBeUndefined();
    }
    for (const malformed of [
      "[]",
      JSON.stringify({
        kind: "plan-health",
        schemaVersion: 1,
        assessments: {
          risk: { level: "low", summary: "Fine." },
          changeSize: { size: "small", summary: "Bounded work." },
        },
        assessedAt: "not-a-date",
        basisVersion: 1,
        application: "applied",
      }),
      JSON.stringify({
        kind: "plan-health",
        schemaVersion: 1,
        assessments: {
          risk: { level: "low", summary: "Fine." },
          changeSize: { size: "small", summary: "Bounded work." },
        },
        assessedAt: "2026-08-12T00:00:00.000Z",
        basisVersion: 1,
        application: "applied",
        extra: true,
      }),
    ]) {
      storage.sql.exec("UPDATE plan_skill_invocations SET result_json = ? WHERE invocation_id = ?", malformed, "active-health");
      expect(store.getPlanSkillInvocation("active-health")?.result).toBeNull();
    }
    storage.sql.exec(
      "UPDATE artifacts SET plan_health_json = NULL, risk_assessment_json = ? WHERE id = ?",
      JSON.stringify({
        level: "low",
        summary: "Legacy Risk must remain inert.",
        assessedAt: "2026-08-12T00:00:00.000Z",
        basisVersion: 1,
        skillInvocationId: "legacy-risk",
      }),
      plan.id,
    );
    expect(store.getArtifact(plan.id)?.planHealth).toBeUndefined();
    storage.close();
  });

});

describe("ArtifactStoreDO manual plan saves", () => {
  it("synchronizes Markdown-derived titles and increments every saved snapshot", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1", envSlug: "env-1" },
      title: "Untitled plan",
      body: { markdown: "" },
      status: "evaluating",
      createdBy: "test",
      createdAt: "2026-07-14T00:00:00.000Z",
      version: 7,
    });

    const first = store.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: "# Manual title\n\nChanged by hand.",
    });
    expect(first).toMatchObject({ changed: true });
    expect(first.artifact).toMatchObject({
      title: "Manual title",
      body: { markdown: "# Manual title\n\nChanged by hand.\n" },
      basis: { repoId: "repo-1", mainCommit: "main-1", envSlug: "env-1" },
      status: "evaluating",
      createdBy: "test",
      createdAt: "2026-07-14T00:00:00.000Z",
      version: 8,
    });

    const renamed = store.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: "## Title\n\nRenamed manual title\n\n## Summary\nChanged again.",
    });
    expect(renamed).toMatchObject({ changed: true });
    expect(renamed.artifact).toMatchObject({
      title: "Renamed manual title",
      body: { markdown: "## Title\n\nRenamed manual title\n\n## Summary\nChanged again.\n" },
      basis: { mainCommit: "main-1" },
      status: "evaluating",
      version: 9,
    });

    const empty = store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "" });
    expect(empty).toMatchObject({ changed: true });
    expect(empty.artifact).toMatchObject({
      title: "Renamed manual title",
      body: { markdown: "" },
      basis: { mainCommit: "main-1" },
      status: "evaluating",
      version: 10,
    });
    storage.close();
  });

  it("enforces the UTF-8 limit and keeps completed or archived plans read-only", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "Initial" },
      status: "todo",
      createdBy: "test",
    });

    expect(() => store.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: `${"a".repeat(MAX_PLAN_MARKDOWN_BYTES - 1)}é`,
    })).toThrow(/1048576 UTF-8 bytes/i);
    expect(store.getArtifact(plan.id)).toMatchObject({ body: { markdown: "Initial" }, version: 1 });

    const completed = store.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "completed",
    }).artifact;
    expect(() => store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "Nope" }))
      .toThrow(/only draft, evaluating, or todo/i);
    store.updateArtifactStatus({
      repoId: "repo-1",
      id: plan.id,
      status: "archived",
      expectedVersion: completed.version,
    });
    expect(() => store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "Still nope" }))
      .toThrow(/only draft, evaluating, or todo/i);
    storage.close();
  });
});

describe("ArtifactStoreDO plan discard", () => {
  it("hard-deletes draft plans with Health results and all related plan state", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "Do the work." },
      status: "draft",
      createdBy: "test",
    });
    store.setRef({ repoId: "repo-1", name: "latest", artifactId: plan.id });
    const reserved = store.reservePlanSkillInvocation({
      invocationId: "discard-risk",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-health-root:discard-risk",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "Do the work.\n",
        normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
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
    expect(reserved.status).toBe("created");
    store.activatePlanSkillInvocation("discard-risk");
    const riskRun = reserved.status === "created" ? reserved.runs[0]! : null;
    expect(
      store.completePlanHealthReviewerOutput(riskRun!.runId, {
        status: "succeeded",
        text: healthOutput("low", "small", "Localized and reversible."),
      }),
    ).toMatchObject({ result: { application: "applied" } });
    expect(store.getPlanSkillInvocation("discard-risk")?.result).toBeTruthy();

    const discarded = store.discardPlan({ repoId: "repo-1", id: plan.id, expectedVersion: plan.version });

    expect(discarded.artifact.id).toBe(plan.id);
    expect(store.getArtifact(plan.id)).toBeNull();
    expect(store.listRefs()).toEqual([]);
    expect(store.listReviewers("repo-1", plan.id, { includeRemoved: true })).toEqual([]);
    for (const table of [
      "plan_skill_invocations",
      "planner_runs",
      "planner_run_events",
      "reviewer_registry",
    ]) {
      const row = storage.sql.exec(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).toArray()[0] as { count: number };
      expect(row.count, table).toBe(0);
    }

    storage.close();
  });

  it("rolls back every discard deletion when the transaction fails", () => {
    const storage = new RollbackProbeStorage();
    const { store } = createSubject(storage);
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n" },
      status: "draft",
      createdBy: "test",
    });
    store.setRef({ repoId: "repo-1", name: "latest", artifactId: plan.id });
    const reserved = store.reservePlanSkillInvocation({
      invocationId: "rollback-risk",
      repoId: "repo-1",
      planArtifactId: plan.id,
      parentThreadId: "plan-health-root:rollback-risk",
      definitionSnapshot: DEFAULT_PLAN_HEALTH_SKILL,
      basis: {
        artifactId: plan.id,
        title: plan.title,
        markdown: "# Draft\n",
        normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
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
    expect(reserved.status).toBe("created");

    storage.failNextTransaction();
    expect(() => store.discardPlan({ repoId: "repo-1", id: plan.id })).toThrow(
      /Injected transaction failure/,
    );
    expect(store.getArtifact(plan.id)).toBeTruthy();
    expect(store.listRefs()).toHaveLength(1);
    expect(store.getPlanSkillInvocation("rollback-risk")).toBeTruthy();
    expect(store.listPlanSkillInvocationRuns("rollback-risk")).toHaveLength(1);
    expect(
      store.listReviewers("repo-1", plan.id, { includeRemoved: true }),
    ).not.toHaveLength(0);
    storage.close();
  });

  it("rejects stale or non-draft discard requests", () => {
    const { storage, store } = createSubject();
    const draft = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "Draft" },
      status: "draft",
      createdBy: "test",
    });
    const todo = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Todo",
      body: { markdown: "Todo" },
      status: "todo",
      createdBy: "test",
    });

    expect(() => store.discardPlan({ repoId: "repo-1", id: draft.id, expectedVersion: 99 }))
      .toThrow(/version mismatch/i);
    expect(() => store.discardPlan({ repoId: "repo-1", id: todo.id, expectedVersion: todo.version }))
      .toThrow(/only draft/i);
    expect(store.getArtifact(draft.id)).toBeTruthy();
    expect(store.getArtifact(todo.id)).toBeTruthy();

    storage.close();
  });

  it("hard-deletes plan state while retaining immutable cleanup targets", async () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "Do the work." },
      status: "draft",
      createdBy: "test",
    });
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const runRuntime = { jobSlug: plannerJobSlug(run.runId) };
    store.setPlannerRunRuntime(run.runId, runRuntime);

    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "sonnet",
      basisCommit: "main-1",
      startBodyDigest: sha256("Do the work.\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const runtime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, 1),
      generation: 1,
    };
    store.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    const discarded = store.discardPlan({ repoId: "repo-1", id: plan.id });

    expect(discarded).toMatchObject({
      artifact: { id: plan.id },
      terminalWriter: {
        threadId: writer.threadId,
        runtime,
        stoppedAt: expect.any(String),
        stopReason: "user",
      },
      runtimeCleanupRuns: [{
        runId: run.runId,
        runtime: runRuntime,
        status: "cancelled",
      }],
      cleanupTargets: expect.arrayContaining([
        expect.objectContaining({
          kind: "writer",
          ownerId: writer.threadId,
          runtime,
          placement: expect.objectContaining({
            backend: "cf",
            machineId: null,
          }),
        }),
        expect.objectContaining({
          kind: "reviewer",
          ownerId: run.runId,
          runtime: runRuntime,
          placement: { backend: "cf", machineId: null },
        }),
      ]),
    });
    expect(store.getArtifact(plan.id)).toBeNull();
    expect(store.getPlanWriter("repo-1", plan.id)).toBeNull();
    expect(store.getPlannerRun(run.runId)).toBeNull();
    const cleanupTargets = store.listPlanRuntimeCleanupTargetsForRepo("repo-1");
    expect(cleanupTargets).toHaveLength(2);
    await vi.waitFor(async () => {
      expect(await storage.getAlarm()).toEqual(expect.any(Number));
    });
    expect(() => store.finalizeRepositoryDeletion("repo-1")).toThrow(/runtime cleanup .* pending/i);
    for (const target of cleanupTargets) {
      expect(store.completePlanRuntimeCleanup(target)).toBe(true);
    }
    expect(store.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual([]);
    expect(() => store.finalizeRepositoryDeletion("repo-1")).not.toThrow();
    storage.close();
  });

  it("rotates failed cleanup targets so an offline batch cannot starve later work", () => {
    const { storage, store } = createSubject();
    const targets = Array.from({ length: 26 }, (_, index) => {
      const plan = store.createArtifact({
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: `Plan ${index + 1}`,
        body: { markdown: `# Plan ${index + 1}\n` },
        status: "draft",
        createdBy: "test",
      });
      const writer = store.startPlanWriter({
      skills: [],
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "codex",
        model: "gpt-test",
        basisCommit: "main-1",
        startBodyDigest: sha256(`# Plan ${index + 1}\n`),
        launchProvenance: CURRENT_CF_LAUNCH,
      });
      return store.abandonPlanWriter({
        repoId: "repo-1",
        planArtifactId: plan.id,
        expectedGeneration: writer.generation!,
        reason: "user",
      }).cleanupTargets[0]!;
    });

    for (const target of targets.slice(0, 25)) {
      store.recordPlanRuntimeCleanupFailure(target, "machine offline");
    }

    const nextBatch = (store as any).listPlanRuntimeCleanupTargets() as typeof targets;
    expect(nextBatch).toHaveLength(25);
    expect(nextBatch[0]?.cleanupId).toBe(targets[25]?.cleanupId);
    storage.close();
  });

  it("runs persisted cleanup through the alarm until the backend confirms success", async () => {
    const revokePlanWriterTerminal = vi.fn()
      .mockRejectedValueOnce(new Error("machine offline"))
      .mockResolvedValueOnce(null);
    const hub = {
      revokePlanWriterTerminal,
      broadcastPlanWriterState: vi.fn(),
    };
    const { storage, store } = createSubject(new FakeStorage(), {
      HUB: { getByName: vi.fn(() => hub) },
    });
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: writer.generation!,
      reason: "user",
    });

    await store.alarm();
    expect(store.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toHaveLength(1);
    expect(await storage.getAlarm()).toEqual(expect.any(Number));

    await store.alarm();
    expect(store.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual([]);
    expect(await storage.getAlarm()).toBeNull();
    expect(revokePlanWriterTerminal).toHaveBeenCalledTimes(2);
    storage.close();
  });

  it("rejects a persisted cleanup target whose workload identity was altered", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.setPlanWriterRuntimeIfCurrent(writer.threadId, {
      jobSlug: planWriterTerminalId("repo-1", plan.id, writer.generation!),
      generation: writer.generation!,
    });
    const target = store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: writer.generation!,
      reason: "user",
    }).cleanupTargets[0]!;
    storage.sql.exec(
      "UPDATE plan_runtime_cleanup SET target_json = ? WHERE cleanup_id = ?",
      JSON.stringify({
        ...target,
        runtime: { ...target.runtime, jobSlug: "unrelated-workload" },
      }),
      target.cleanupId,
    );

    expect(() => store.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toThrow(/malformed persisted/i);
    storage.close();
  });
});

describe("ArtifactStoreDO plan-agent reset", () => {
  it("preserves every plan and ref while retiring all current Scribes and reviewers", async () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      id: "plan-reset-draft",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Draft",
      body: { markdown: "# Draft\n" },
      status: "draft",
      createdBy: "test",
    });
    store.createArtifact({
      id: "plan-reset-completed",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Completed",
      body: { markdown: "# Completed\n" },
      status: "completed",
      createdBy: "test",
    });
    store.setRef({ repoId: "repo-1", name: "latest", artifactId: plan.id });

    const reviewer = store.upsertReviewer({
      ...reviewerInput(),
      planArtifactId: plan.id,
      threadId: "reset-reviewer-thread",
    });
    const runId = "00000000-0000-4000-8000-000000000101";
    const run = store.createPlannerRun({
      runId,
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: reviewer.threadId,
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.updateReviewerRunState({
      repoId: "repo-1",
      planArtifactId: plan.id,
      threadId: reviewer.threadId,
      runId: run.runId,
      status: "running",
    });
    store.setPlannerRunRuntime(run.runId, {
      jobSlug: plannerJobSlug(run.runId),
    });
    store.appendPlannerRunEvent({
      runId: run.runId,
      repoId: "repo-1",
      planArtifactId: plan.id,
      type: "progress",
      message: "Reviewing",
    });
    const orphanedRunId = "00000000-0000-4000-8000-000000000106";
    storage.sql.exec(
      "UPDATE reviewer_registry SET run_id = ? WHERE thread_id = ?",
      orphanedRunId,
      reviewer.threadId,
    );
    store.createPlanContribution({
      repoId: "repo-1",
      planArtifactId: plan.id,
      sourceThreadId: reviewer.threadId,
      provider: "fake",
      model: "fake-fast",
      text: "Keep the migration reversible.",
    });

    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Draft\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const writerRuntime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, writer.generation!),
      generation: writer.generation!,
    };
    store.setPlanWriterRuntimeIfCurrent(writer.threadId, writerRuntime);

    const artifactsBefore = store.listArtifacts();
    const refsBefore = store.listRefs();
    const input = {
      repoId: "repo-1",
      resetId: "00000000-0000-4000-8000-000000000102",
      requestHash: "reset-request-v1",
    };
    const reset = await store.resetPlanAgents(input);

    expect(reset).toMatchObject({
      status: "reset",
      report: {
        resetId: input.resetId,
        resetAt: expect.any(String),
        plansPreserved: 2,
        scribesRemoved: 1,
        reviewersRemoved: 1,
        runsRetired: 2,
        cleanupQueued: 2,
      },
    });
    expect(store.listArtifacts()).toEqual(artifactsBefore);
    expect(store.listRefs()).toEqual(refsBefore);
    for (const table of [
      "plan_contributions",
      "planner_run_events",
      "planner_runs",
      "plan_skill_invocations",
      "reviewer_registry",
    ]) {
      const row = storage.sql
        .exec(
          `SELECT COUNT(*) AS count FROM ${table} WHERE repo_id = ?`,
          "repo-1",
        )
        .toArray()[0] as { count: number };
      expect(row.count, table).toBe(0);
    }
    expect(store.listPlanRuntimeCleanupTargetsForRepo("repo-1")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "writer",
          ownerId: writer.threadId,
          generation: 1,
          runtime: writerRuntime,
          placement: { backend: "cf", machineId: null },
        }),
        expect.objectContaining({
          kind: "reviewer",
          ownerId: run.runId,
          runtime: { jobSlug: plannerJobSlug(run.runId) },
          placement: { backend: "cf", machineId: null },
        }),
      ]),
    );
    expect(await storage.getAlarm()).toEqual(expect.any(Number));
    expect(
      store.setPlanWriterRuntimeIfCurrent(writer.threadId, writerRuntime),
    ).toBeNull();
    expect(() =>
      store.createPlannerRun({
        runId,
        repoId: "repo-1",
        planArtifactId: plan.id,
        role: "reviewer",
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      }),
    ).toThrow(/retired by a plan-agent reset/i);
    expect(() =>
      store.createPlannerRun({
        runId: orphanedRunId,
        repoId: "repo-1",
        planArtifactId: plan.id,
        role: "reviewer",
        provider: "fake",
        model: "fake-fast",
        launchProvenance: CURRENT_CF_LAUNCH,
      }),
    ).toThrow(/retired by a plan-agent reset/i);

    const nextWriter = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Draft\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(nextWriter.generation).toBe(2);
    const nextReviewer = store.upsertReviewer({
      ...reviewerInput(),
      planArtifactId: plan.id,
      threadId: "replacement-reviewer-thread",
    });

    const replay = await store.resetPlanAgents(input);
    expect(replay).toMatchObject({
      status: "replayed",
      report: (reset as Extract<typeof reset, { status: "reset" }>).report,
    });
    expect(store.getPlanWriter("repo-1", plan.id)?.generation).toBe(2);
    expect(store.getReviewer(nextReviewer.threadId)).toBeTruthy();
    await expect(
      store.resetPlanAgents({ ...input, requestHash: "different-request" }),
    ).resolves.toEqual({ status: "idempotency_conflict" });
    expect(store.getReviewer(nextReviewer.threadId)).toBeTruthy();
    storage.close();
  });

  it("normalizes legacy agent and cleanup ownership into stable placement records", async () => {
    const { storage, store } = createSubject();
    const createPlan = (id: string) =>
      store.createArtifact({
        id,
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        title: id,
        body: { markdown: `# ${id}\n` },
        status: "draft",
        createdBy: "test",
      });
    const activePlan = createPlan("legacy-active-plan");
    const detachedPlan = createPlan("legacy-detached-plan");
    const startWriter = (planId: string) =>
      store.startPlanWriter({
        skills: [],
        repoId: "repo-1",
        planArtifactId: planId,
        provider: "codex",
        model: "gpt-test",
        basisCommit: "main-1",
        startBodyDigest: sha256(`# ${planId}\n`),
        launchProvenance: CURRENT_CF_LAUNCH,
      });

    const activeWriter = startWriter(activePlan.id);
    const activeRuntime = {
      jobSlug: planWriterTerminalId(
        "repo-1",
        activePlan.id,
        activeWriter.generation!,
      ),
      generation: activeWriter.generation!,
    };
    store.setPlanWriterRuntimeIfCurrent(activeWriter.threadId, activeRuntime);
    const activeTarget = (store as any).planWriterCleanupTarget(
      store.getPlanWriter("repo-1", activePlan.id),
    );
    (store as any).enqueuePlanRuntimeCleanupTargets(
      [activeTarget],
      new Date().toISOString(),
    );
    storage.sql.exec(
      "UPDATE reviewer_registry SET launch_provenance_json = ? WHERE thread_id = ?",
      null,
      activeWriter.threadId,
    );

    const detachedWriter = startWriter(detachedPlan.id);
    const detachedRuntime = {
      jobSlug: planWriterTerminalId(
        "repo-1",
        detachedPlan.id,
        detachedWriter.generation!,
      ),
      generation: detachedWriter.generation!,
    };
    store.setPlanWriterRuntimeIfCurrent(
      detachedWriter.threadId,
      detachedRuntime,
    );
    const detachedTarget = store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: detachedPlan.id,
      expectedGeneration: detachedWriter.generation!,
      reason: "user",
    }).cleanupTargets[0]!;
    expect(detachedTarget.kind).toBe("writer");
    storage.sql.exec(
      "UPDATE plan_runtime_cleanup SET target_json = ? WHERE cleanup_id = ?",
      JSON.stringify({
        schemaVersion: 1,
        cleanupId: detachedTarget.cleanupId,
        kind: "writer",
        repoId: detachedTarget.repoId,
        planArtifactId: detachedTarget.planArtifactId,
        ownerId: detachedTarget.ownerId,
        generation:
          detachedTarget.kind === "writer" ? detachedTarget.generation : 1,
        runtime: detachedTarget.runtime,
        launchProvenance: { backend: "cf", machineId: null },
      }),
      detachedTarget.cleanupId,
    );

    const reset = await store.resetPlanAgents({
      repoId: "repo-1",
      resetId: "00000000-0000-4000-8000-000000000103",
      requestHash: "legacy-reset",
    });

    expect(reset).toMatchObject({
      status: "reset",
      report: {
        plansPreserved: 2,
        scribesRemoved: 2,
        cleanupQueued: 2,
      },
    });
    expect(store.getArtifact(activePlan.id)).toBeTruthy();
    expect(store.getArtifact(detachedPlan.id)).toBeTruthy();
    const targets = store.listPlanRuntimeCleanupTargetsForRepo("repo-1");
    expect(targets).toHaveLength(2);
    expect(targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          schemaVersion: 2,
          ownerId: activeWriter.threadId,
          runtime: activeRuntime,
          placement: { backend: "cf", machineId: null },
        }),
        expect.objectContaining({
          schemaVersion: 2,
          ownerId: detachedWriter.threadId,
          runtime: detachedRuntime,
          placement: { backend: "cf", machineId: null },
        }),
      ]),
    );
    const storedTargets = storage.sql
      .exec("SELECT target_json FROM plan_runtime_cleanup ORDER BY cleanup_id")
      .toArray() as Array<{ target_json: string }>;
    expect(storedTargets.map((row) => JSON.parse(row.target_json))).toEqual(
      targets
        .slice()
        .sort((left, right) => left.cleanupId.localeCompare(right.cleanupId)),
    );
    storage.close();
  });

  it("rejects unknown cleanup ownership without partially resetting plan state", async () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      id: "blocked-reset-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Blocked",
      body: { markdown: "# Blocked\n" },
      status: "draft",
      createdBy: "test",
    });
    const reviewer = store.upsertReviewer({
      ...reviewerInput(),
      planArtifactId: plan.id,
      threadId: "blocked-reviewer",
    });
    const now = new Date().toISOString();
    storage.sql.exec(
      `INSERT INTO plan_runtime_cleanup (
         cleanup_id, repo_id, plan_artifact_id, target_json,
         attempt_count, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
      "unknown-cleanup-owner",
      "repo-1",
      plan.id,
      JSON.stringify({ schemaVersion: 99 }),
      now,
      now,
    );

    const result = await store.resetPlanAgents({
      repoId: "repo-1",
      resetId: "00000000-0000-4000-8000-000000000104",
      requestHash: "blocked-reset",
    });

    expect(result).toMatchObject({
      status: "unsupported_cleanup_ownership",
      blockerCount: 1,
      blockers: [
        expect.objectContaining({
          kind: "cleanup",
          cleanupId: "unknown-cleanup-owner",
        }),
      ],
    });
    expect(store.getArtifact(plan.id)).toBeTruthy();
    expect(store.getReviewer(reviewer.threadId)).toBeTruthy();
    expect(
      storage.sql.exec("SELECT cleanup_id FROM plan_runtime_cleanup").toArray(),
    ).toEqual([{ cleanup_id: "unknown-cleanup-owner" }]);
    expect(
      storage.sql
        .exec("SELECT reset_id FROM plan_agent_reset_receipts")
        .toArray(),
    ).toEqual([]);
    storage.close();
  });

  it("rolls back the full reset and receipt when its transaction fails", async () => {
    const storage = new RollbackProbeStorage();
    const { store } = createSubject(storage);
    const plan = store.createArtifact({
      id: "rollback-reset-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Rollback",
      body: { markdown: "# Rollback\n" },
      status: "draft",
      createdBy: "test",
    });
    const reviewer = store.upsertReviewer({
      ...reviewerInput(),
      planArtifactId: plan.id,
      threadId: "rollback-reset-reviewer",
    });
    storage.failNextTransaction();

    await expect(
      store.resetPlanAgents({
        repoId: "repo-1",
        resetId: "00000000-0000-4000-8000-000000000105",
        requestHash: "rollback-reset",
      }),
    ).rejects.toThrow(/Injected transaction failure/);

    expect(store.getArtifact(plan.id)).toBeTruthy();
    expect(store.getReviewer(reviewer.threadId)).toBeTruthy();
    expect(
      storage.sql.exec("SELECT cleanup_id FROM plan_runtime_cleanup").toArray(),
    ).toEqual([]);
    expect(
      storage.sql
        .exec("SELECT reset_id FROM plan_agent_reset_receipts")
        .toArray(),
    ).toEqual([]);
    storage.close();
  });

  it("does not let a malformed cleanup row starve valid reset cleanup", async () => {
    const revokePlanWriterTerminal = vi.fn().mockResolvedValue(null);
    const { storage, store } = createSubject(new FakeStorage(), {
      HUB: {
        getByName: vi.fn(() => ({
          revokePlanWriterTerminal,
          broadcastPlanWriterState: vi.fn(),
        })),
      },
    });
    const plan = store.createArtifact({
      id: "cleanup-starvation-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Cleanup",
      body: { markdown: "# Cleanup\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Cleanup\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const validTarget = store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: writer.generation!,
      reason: "user",
    }).cleanupTargets[0]!;
    storage.sql.exec(
      `INSERT INTO plan_runtime_cleanup (
         cleanup_id, repo_id, plan_artifact_id, target_json,
         attempt_count, last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)`,
      "malformed-first",
      "repo-1",
      plan.id,
      "{}",
      "2000-01-01T00:00:00.000Z",
      "2000-01-01T00:00:00.000Z",
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    await store.alarm();

    expect(revokePlanWriterTerminal).toHaveBeenCalledTimes(1);
    expect(
      storage.sql
        .exec(
          "SELECT cleanup_id, attempt_count FROM plan_runtime_cleanup ORDER BY cleanup_id",
        )
        .toArray(),
    ).toEqual([{ cleanup_id: "malformed-first", attempt_count: 1 }]);
    expect(
      storage.sql
        .exec(
          "SELECT cleanup_id FROM plan_runtime_cleanup WHERE cleanup_id = ?",
          validTarget.cleanupId,
        )
        .toArray(),
    ).toEqual([]);
    expect(await storage.getAlarm()).toEqual(expect.any(Number));
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("malformed deferred cleanup"),
      expect.any(String),
    );
    warning.mockRestore();
    storage.close();
  });
});

describe("ArtifactStoreDO repository plan tools", () => {
  it("creates raw-version-2 top-level plans and replays only the same UUID request", () => {
    const { storage, store } = createSubject();
    const { sourcePlan, writer } = createRepoPlanToolSource(store);
    const requestId = "00000000-0000-4000-8000-000000000001";
    const targetPlanId = `plan-tool-${requestId}`;
    const creator = `plan-writer:${sourcePlan.id}:${writer.generation}`;
    const input = {
      kind: "create" as const,
      repoId: "repo-1",
      sourcePlanId: sourcePlan.id,
      sourceGeneration: writer.generation!,
      requestId,
      markdown: "# Created\n",
    };

    expect(store.mutateRepoPlan(input)).toMatchObject({
      ok: true,
      outcome: "created",
      artifact: {
        id: targetPlanId,
        repoId: "repo-1",
        title: "Created",
        body: { markdown: "# Created\n" },
        basis: { repoId: "repo-1", mainCommit: "main-1" },
        status: "draft",
        version: 2,
        createdBy: creator,
      },
    });
    const created = store.getArtifact(targetPlanId)!;
    expect(created.parentArtifactId).toBeUndefined();
    expect(created.supersedesArtifactId).toBeUndefined();
    expect(store.getPlanWriter("repo-1", targetPlanId)).toBeNull();
    expect(store.mutateRepoPlan(input)).toMatchObject({
      ok: true,
      outcome: "replayed",
      artifact: { version: 2 },
    });
    expect(
      store.mutateRepoPlan({
        ...input,
        markdown: "# Collision\n",
      }),
    ).toEqual({ ok: false, code: "idempotency_conflict" });
    expect(
      store.mutateRepoPlan({
        ...input,
        requestId: "00000000-0000-4000-8000-000000000002",
        markdown: "   ",
      }),
    ).toEqual({ ok: false, code: "invalid_request" });
    storage.close();
  });

  it("delegates eligible CAS updates to savePlan and recognizes no-ops and N+1 replays", () => {
    const { storage, store } = createSubject();
    const { sourcePlan, writer } = createRepoPlanToolSource(store);
    const target = store.createArtifact({
      id: "target-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "older-main", envSlug: "env-1" },
      title: "Old title",
      body: { markdown: "# Old title\n\nBody.\n" },
      status: "evaluating",
      parentArtifactId: "parent-plan",
      supersedesArtifactId: "superseded-plan",
      createdBy: "user",
      version: 7,
    });
    (store as any)._db.exec(
      "UPDATE artifacts SET plan_health_json = ? WHERE id = ?",
      JSON.stringify({
        schemaVersion: 1,
        assessments: {
          risk: { level: "low", summary: "Localized." },
          changeSize: { size: "small", summary: "Bounded." },
        },
        assessedAt: "2026-08-15T00:00:00.000Z",
        basisVersion: 7,
        skillInvocationId: "health-1",
      }),
      target.id,
    );
    const update = (markdown: string, expectedVersion = 7) =>
      store.mutateRepoPlan({
        kind: "update",
        repoId: "repo-1",
        sourcePlanId: sourcePlan.id,
        sourceGeneration: writer.generation!,
        targetPlanId: target.id,
        expectedVersion,
        markdown,
      });

    expect(update("# Old title\r\n\r\nBody.\r\n")).toMatchObject({
      ok: true,
      outcome: "unchanged",
      artifact: { version: 7 },
    });
    expect(store.getArtifact(target.id)?.planHealth?.staleAt).toBeUndefined();

    const changed = update("# New title\n\nChanged.\n");
    expect(changed).toMatchObject({
      ok: true,
      outcome: "updated",
      artifact: {
        title: "New title",
        version: 8,
        body: { markdown: "# New title\n\nChanged.\n" },
        basis: { mainCommit: "older-main", envSlug: "env-1" },
        parentArtifactId: "parent-plan",
        supersedesArtifactId: "superseded-plan",
        createdBy: "user",
        planHealth: { staleAt: expect.any(String) },
      },
    });
    (store as any)._db.exec(
      "UPDATE artifacts SET status = 'archived' WHERE id = ?",
      target.id,
    );
    expect(update("# New title\n\nChanged.\n")).toMatchObject({
      ok: true,
      outcome: "replayed",
      artifact: { status: "archived", version: 8 },
    });
    expect(update("# Another\n", 6)).toEqual({
      ok: false,
      code: "version_conflict",
      currentVersion: 8,
    });
    expect(update("# Another\n", 8)).toEqual({
      ok: false,
      code: "plan_not_editable",
    });
    storage.close();
  });

  it("fences source ownership, self/cross-repo targets, and unstopped target Scribes", () => {
    const { storage, store } = createSubject();
    const { sourcePlan, writer } = createRepoPlanToolSource(store);
    const target = store.createArtifact({
      id: "target-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Target",
      body: { markdown: "# Target\n" },
      status: "todo",
      createdBy: "test",
    });
    const base = {
      kind: "update" as const,
      repoId: "repo-1",
      sourcePlanId: sourcePlan.id,
      sourceGeneration: writer.generation!,
      expectedVersion: 1,
      markdown: "# Changed\n",
    };
    expect(
      store.mutateRepoPlan({
        ...base,
        targetPlanId: sourcePlan.id,
      }),
    ).toEqual({ ok: false, code: "self_target" });
    store.createArtifact({
      id: "other-repo-plan",
      repoId: "repo-2",
      type: "plan",
      basis: { repoId: "repo-2", mainCommit: "main-2" },
      title: "Hidden",
      body: { markdown: "# Hidden\n" },
    });
    expect(
      store.mutateRepoPlan({
        ...base,
        targetPlanId: "other-repo-plan",
      }),
    ).toEqual({ ok: false, code: "plan_not_found" });
    store.createArtifact({
      id: "other-basis-plan",
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-2", mainCommit: "main-2" },
      title: "Hidden by basis",
      body: { markdown: "# Hidden by basis\n" },
    });
    expect(
      store.mutateRepoPlan({
        ...base,
        targetPlanId: "other-basis-plan",
      }),
    ).toEqual({ ok: false, code: "plan_not_found" });

    const targetWriter = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: target.id,
      provider: "codex",
      model: "gpt-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Target\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(
      store.mutateRepoPlan({
        ...base,
        targetPlanId: target.id,
      }),
    ).toEqual({ ok: false, code: "target_writer_active" });
    store.fencePlanWriterStop({
      repoId: "repo-1",
      planArtifactId: target.id,
      expectedGeneration: targetWriter.generation!,
      reason: "user",
    });
    expect(
      store.mutateRepoPlan({
        ...base,
        targetPlanId: target.id,
      }),
    ).toMatchObject({ ok: true, outcome: "updated" });

    expect(
      store.mutateRepoPlan({
        ...base,
        sourceGeneration: writer.generation! + 1,
        targetPlanId: target.id,
        expectedVersion: 2,
      }),
    ).toEqual({ ok: false, code: "source_inactive" });
    (store as any)._db.exec(
      "UPDATE artifacts SET basis_main_commit = 'drifted', basis_json = ? WHERE id = ?",
      JSON.stringify({ repoId: "repo-1", mainCommit: "drifted" }),
      sourcePlan.id,
    );
    expect(
      store.mutateRepoPlan({
        ...base,
        targetPlanId: target.id,
        expectedVersion: 2,
      }),
    ).toEqual({ ok: false, code: "source_inactive" });
    storage.close();
  });

  it("lets repository deletion finalization win over replay and validation", () => {
    const { storage, store } = createSubject();
    const { sourcePlan, writer } = createRepoPlanToolSource(store);
    (store as any)._db.exec(
      "INSERT INTO repository_deletion (singleton, deleted_at) VALUES (1, ?)",
      "2026-08-15T00:00:00.000Z",
    );
    expect(
      store.mutateRepoPlan({
        kind: "update",
        repoId: "repo-1",
        sourcePlanId: sourcePlan.id,
        sourceGeneration: writer.generation!,
        targetPlanId: sourcePlan.id,
        expectedVersion: 1,
        markdown: "# Source\n",
      }),
    ).toEqual({ ok: false, code: "source_inactive" });
    storage.close();
  });
});

describe("ArtifactStoreDO Plan Writer", () => {
  it("requires native schema-v2 writer launch provenance", () => {
    const scope = {
      repositoryId: "repo-1",
      planId: "plan-1",
      generation: 1,
    };
    const legacy = (surface: "plan-writer" | "plan-reviewer") => ({
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
      codexExecution: {
        kind: "subscription-app-server" as const,
        surface,
        backend: "cf" as const,
      },
    });

    expect(validatePlanWriterLaunchProvenance(legacy("plan-writer"), scope)).toBeNull();
    expect(validatePlanWriterLaunchProvenance(legacy("plan-reviewer"), scope)).toBeNull();
  });

  it("rejects reviewer-scoped Codex provenance for writer generations", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      createdBy: "test",
    });

    expect(() =>
      store.startPlanWriter({
        skills: [],
        repoId: "repo-1",
        planArtifactId: plan.id,
        provider: "codex",
        model: "gpt-5.5",
        basisCommit: "main-1",
        startBodyDigest: sha256("# Plan\n"),
        launchProvenance: {
          schemaVersion: 1,
          backend: "cf",
          machineId: null,
          codexExecution: {
            kind: "subscription-app-server",
            surface: "plan-reviewer",
            backend: "cf",
          },
        },
      }),
    ).toThrow(/skill projection is invalid/i);
    storage.close();
  });

  it("commits immutable launch provenance with a generation and resolves again only after a new Start", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Original\n" },
      status: "draft",
      createdBy: "test",
    });
    const subscriptionProvenance = {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
      codexExecution: {
        kind: "subscription-app-server" as const,
        surface: "plan-writer" as const,
        backend: "cf" as const,
      },
    };
    const apiKeyProvenance = {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
      codexExecution: {
        kind: "api-key-app-server" as const,
        surface: "plan-writer" as const,
        backend: "cf" as const,
      },
    };
    const digest = sha256("# Original\n");

    const first = store.startPlanWriter({
      skills: [DEFAULT_PLAN_HEALTH_SKILL],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      fastMode: true,
      basisCommit: "main-1",
      startBodyDigest: digest,
      launchProvenance: subscriptionProvenance,
    });
    const retried = store.startPlanWriter({
      skills: [{ ...DEFAULT_PLAN_HEALTH_SKILL, label: "Later settings" }],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      effort: "low",
      fastMode: false,
      basisCommit: "main-1",
      startBodyDigest: digest,
      launchProvenance: apiKeyProvenance,
    });
    expect(retried).toMatchObject({
      generation: 1,
      effort: "high",
      fastMode: true,
      launchProvenance: expect.objectContaining({
        ...subscriptionProvenance,
        schemaVersion: 2,
        skillProjection: expect.objectContaining({
          generation: 1,
          skills: [expect.objectContaining({ id: "plan-health", label: "Plan Health" })],
        }),
      }),
      codexAuthMode: "subscription",
    });

    const runtime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, 1),
      generation: 1,
    };
    store.setPlanWriterRuntimeIfCurrent(first.threadId, runtime);
    store.fencePlanWriterStop({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: 1,
      reason: "user",
    });
    store.clearPlanWriterRuntimeIfCurrent(first.threadId, runtime);
    const stopped = store.getPlanWriter("repo-1", plan.id);
    expect(stopped?.runtime).toBeUndefined();
    expect(stopped).toMatchObject({
      launchProvenance: expect.objectContaining({
        ...subscriptionProvenance,
        schemaVersion: 2,
      }),
      codexAuthMode: "subscription",
    });

    const second = store.startPlanWriter({
      skills: [{ ...DEFAULT_PLAN_HEALTH_SKILL, label: "Later settings" }],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "gpt-5.5",
      effort: "low",
      fastMode: false,
      basisCommit: "main-1",
      startBodyDigest: digest,
      launchProvenance: apiKeyProvenance,
    });
    expect(second).toMatchObject({
      generation: 2,
      launchProvenance: {
        ...apiKeyProvenance,
        schemaVersion: 2,
        skillProjection: {
          version: 1,
          repositoryId: "repo-1",
          planId: plan.id,
          generation: 2,
          skills: [expect.objectContaining({ id: "plan-health", label: "Later settings" })],
        },
      },
      codexAuthMode: "api-key",
    });
    expect(second.fastMode).toBeUndefined();
    storage.close();
  });

  it("converges Start, fences Stop by generation, and publishes complete plans atomically", async () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Original\n" },
      status: "draft",
      createdBy: "test",
    });
    const originalDigest = sha256("# Original\n");
    const first = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-test",
      basisCommit: "main-1",
      startBodyDigest: originalDigest,
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const retried = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "codex-test",
      basisCommit: "main-1",
      startBodyDigest: originalDigest,
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(retried).toMatchObject({
      threadId: first.threadId,
      provider: "claude-code",
      generation: 1,
    });

    const runtime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, 1),
      generation: 1,
    };
    expect(store.setPlanWriterRuntimeIfCurrent(first.threadId, runtime)?.runtime).toEqual(runtime);
    expect(store.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      runtime,
      providerConversationId: "claude-session-1",
    })).toMatchObject({ status: "running", providerConversationId: "claude-session-1" });

    const updatedMarkdown = "# Updated\n\nDo the work.\n";
    const updatedDigest = sha256(updatedMarkdown);
    const updated = await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "claude-session-1",
      sequence: 1,
      providerEventId: "event-1",
      markdown: updatedMarkdown,
      bodyDigest: updatedDigest,
    });
    expect(updated).toMatchObject({ status: "updated", artifactVersion: (plan.version ?? 1) + 1 });
    expect(store.getArtifact(plan.id)).toMatchObject({
      title: "Updated",
      body: { markdown: updatedMarkdown },
    });

    const unchanged = await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "claude-session-1",
      sequence: 2,
      providerEventId: "event-2",
      markdown: updatedMarkdown,
      bodyDigest: updatedDigest,
    });
    expect(unchanged).toMatchObject({ status: "unchanged", artifactVersion: (plan.version ?? 1) + 1 });

    const abandoned = store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: 1,
      reason: "user",
    });
    expect(abandoned).toMatchObject({
      status: "abandoned",
      writer: { generation: 1, stoppedAt: expect.any(String) },
      cleanupTargets: [expect.objectContaining({
        kind: "writer",
        generation: 1,
        runtime,
      })],
    });
    expect(store.getPlanWriter("repo-1", plan.id)?.runtime).toBeUndefined();
    expect(await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "claude-session-1",
      sequence: 2,
      providerEventId: "event-2",
      markdown: updatedMarkdown,
      bodyDigest: updatedDigest,
    })).toMatchObject({ status: "replayed" });
    expect(await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "claude-session-1",
      sequence: 2,
      providerEventId: "event-2",
      markdown: "# Different\n",
      bodyDigest: sha256("# Different\n"),
    })).toEqual({ status: "rejected", reason: "cursor_payload_mismatch" });
    expect(await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "wrong-session",
      sequence: 2,
      providerEventId: "event-2",
      markdown: updatedMarkdown,
      bodyDigest: updatedDigest,
    })).toEqual({ status: "rejected", reason: "conversation_mismatch" });
    expect(await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 2,
      providerConversationId: "claude-session-1",
      sequence: 2,
      providerEventId: "event-2",
      markdown: updatedMarkdown,
      bodyDigest: updatedDigest,
    })).toEqual({ status: "rejected", reason: "generation_mismatch" });

    const second = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "codex-test",
      basisCommit: "main-1",
      startBodyDigest: updatedDigest,
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(second).toMatchObject({ provider: "codex", generation: 2 });
    const secondRuntime = {
      jobSlug: planWriterTerminalId("repo-1", plan.id, 2),
      generation: 2,
    };
    store.setPlanWriterRuntimeIfCurrent(second.threadId, secondRuntime);
    expect(store.completePlanRuntimeCleanup(abandoned.cleanupTargets[0]!)).toBe(true);
    expect(store.getPlanWriter("repo-1", plan.id)).toMatchObject({
      generation: 2,
      runtime: secondRuntime,
    });
    expect(store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: 1,
      reason: "user",
    }).status).toBe("stale");
    expect(store.getPlanWriter("repo-1", plan.id)?.stoppedAt).toBeUndefined();
    storage.close();
  });

  it("clears a stale cleanup-only error when abandoning an already-detached generation", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "codex-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.fencePlanWriterStop({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: writer.generation!,
      reason: "user",
    });
    store.setPlanWriterError({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: writer.generation!,
      kind: "cleanup",
      error: "old cleanup failure",
    });

    const abandoned = store.abandonPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: writer.generation!,
      reason: "user",
    });

    expect(abandoned).toMatchObject({
      status: "abandoned",
      cleanupTargets: [],
      writer: { generation: writer.generation },
    });
    expect(abandoned.writer?.cleanupError).toBeUndefined();
    storage.close();
  });

  it("lets the next valid writer publication overwrite a manual save", async () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Original\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Original\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const runtime = { jobSlug: "job", generation: 1 };
    store.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    store.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      runtime,
      providerConversationId: "session",
    });
    const manuallySaved = store.savePlan({
      repoId: "repo-1",
      id: plan.id,
      markdown: "# Changed manually\n",
    });
    expect(manuallySaved.artifact.version).toBe(2);

    expect(await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "session",
      sequence: 1,
      providerEventId: "event",
      markdown: "# Provider plan\n",
      bodyDigest: sha256("# Provider plan\n"),
    })).toMatchObject({ status: "updated", artifactVersion: 3 });
    expect(store.getArtifact(plan.id)).toMatchObject({
      title: "Provider plan",
      body: { markdown: "# Provider plan\n" },
      version: 3,
    });
    expect(store.getPlanWriter("repo-1", plan.id)?.synchronizationError).toBeUndefined();
    storage.close();
  });

  it("rejects writer publications once the plan becomes ineligible", async () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Original\n" },
      status: "draft",
      createdBy: "test",
    });
    const writer = store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Original\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const runtime = { jobSlug: "job", generation: 1 };
    store.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    store.registerPlanWriterRuntime({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      runtime,
      providerConversationId: "session",
    });

    store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "completed" });
    expect(await store.publishObservedPlan({
      repoId: "repo-1",
      planArtifactId: plan.id,
      generation: 1,
      providerConversationId: "session",
      sequence: 1,
      providerEventId: "event",
      markdown: "# Provider plan\n",
      bodyDigest: sha256("# Provider plan\n"),
    })).toEqual({ status: "rejected", reason: "writer_not_running" });
    expect(store.getArtifact(plan.id)?.body).toEqual({ markdown: "# Original\n" });
    storage.close();
  });
});

describe("ArtifactStoreDO planner coordination", () => {
  it("stores contribution lifecycle separately from legacy review artifacts", () => {
    const { storage, store } = createSubject();
    const contribution = store.createPlanContribution({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      sourceThreadId: "thread-1",
      provider: "fake",
      model: "fake-fast",
      skill: "plan-review",
      text: "Add a migration verification step.",
    });

    expect(store.listPlanContributions("repo-1", "plan-1", { status: "pending" })).toEqual([contribution]);

    const incorporated = store.incorporatePlanContributions("repo-1", "plan-1", [contribution.id]);
    expect(incorporated[0]).toMatchObject({
      id: contribution.id,
      status: "incorporated",
    });
    expect(store.listPlanContributions("repo-1", "plan-1", { status: "pending" })).toEqual([]);

    storage.close();
  });

  it("creates or returns plan contributions idempotently by key", () => {
    const { storage, store } = createSubject();
    const input = {
      repoId: "repo-1",
      planArtifactId: "plan-1",
      sourceKind: "reviewer_message" as const,
      sourceThreadId: "thread-1",
      sourceMessageId: "message-1",
      idempotencyKey: "reviewer-message:thread-1:message-1",
      provider: "fake",
      model: "fake-fast",
      text: "Add a migration verification step.",
    };

    const created = store.createOrGetPlanContribution(input);
    expect(created.status).toBe("created");
    if (created.status !== "created") throw new Error("expected created contribution");

    const existing = store.createOrGetPlanContribution(input);
    expect(existing).toMatchObject({
      status: "existing",
      contribution: { id: created.contribution.id, sourceMessageId: "message-1" },
    });

    const conflict = store.createOrGetPlanContribution({
      ...input,
      text: "Different text for the same idempotency key.",
    });
    expect(conflict.status).toBe("conflict");

    storage.close();
  });

  it("creates curated handoffs atomically with exact ordered source idempotency and send-once checks", () => {
    const { storage, store } = createSubject();
    const sources = [
      { threadId: "thread-a", messageId: "message-a", runId: "run-a" },
      { threadId: "thread-b", messageId: "message-b", runId: "run-b" },
    ];
    const input = {
      repoId: "repo-1",
      planArtifactId: "plan-1",
      idempotencyKey: "scribe-handoff:request-1",
      sourceKind: "curated_reviewer_handoff" as const,
      sourceRunId: "run-a",
      sourceThreadId: "thread-a",
      sourceMessageId: "message-a",
      sourceRefs: sources,
      provider: "codex",
      model: "gpt-5.5",
      text: "  User-edited draft\n",
    };

    const created = store.createOrGetCuratedPlanContribution(input);
    expect(created).toMatchObject({
      status: "created",
      contribution: {
        sourceKind: "curated_reviewer_handoff",
        sourceRefs: sources,
        text: "  User-edited draft\n",
      },
    });
    if (created.status !== "created") throw new Error("expected created handoff");
    expect(store.createOrGetCuratedPlanContribution(input)).toMatchObject({
      status: "existing",
      contribution: { id: created.contribution.id },
    });
    expect(store.createOrGetCuratedPlanContribution({ ...input, text: "Changed" })).toMatchObject({
      status: "conflict",
      reason: "request_payload_changed",
    });
    expect(store.createOrGetCuratedPlanContribution({
      ...input,
      sourceRefs: [...sources].reverse(),
    })).toMatchObject({ status: "conflict" });
    expect(store.createOrGetCuratedPlanContribution({
      ...input,
      idempotencyKey: "scribe-handoff:request-2",
    })).toEqual({ status: "source_used", source: sources[0] });

    store.createPlanContribution({
      repoId: "repo-1",
      planArtifactId: "plan-2",
      sourceKind: "reviewer_message",
      sourceThreadId: "thread-c",
      sourceMessageId: "message-c",
      provider: "fake",
      model: "fake-fast",
      text: "Legacy singular source",
    });
    expect(store.createOrGetCuratedPlanContribution({
      ...input,
      planArtifactId: "plan-2",
      idempotencyKey: "scribe-handoff:request-3",
      sourceRefs: [{ threadId: "thread-c", messageId: "message-c", runId: "run-c" }],
    })).toMatchObject({ status: "source_used", source: { threadId: "thread-c", messageId: "message-c" } });

    store.createPlanContribution({
      repoId: "repo-1",
      planArtifactId: "plan-3",
      sourceKind: "skill_overview",
      sourceThreadId: "overview-root",
      sourceMessageId: "overview-message",
      provider: "fake",
      model: "fake-fast",
      text: "Canonical Overview",
    });
    expect(store.createOrGetCuratedPlanContribution({
      ...input,
      planArtifactId: "plan-3",
      idempotencyKey: "scribe-handoff:request-4",
      sourceRefs: [{ threadId: "overview-root", messageId: "overview-message", runId: "overview-run" }],
    })).toMatchObject({
      status: "source_used",
      source: { threadId: "overview-root", messageId: "overview-message" },
    });
    storage.close();
  });

  it("keeps run state and bounded sequenced events", () => {
    const { storage, store } = createSubject();
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      startedAt: "2026-06-01T00:00:00.000Z",
      launchProvenance: CURRENT_CF_LAUNCH,
    });

    for (let index = 0; index < 205; index += 1) {
      store.appendPlannerRunEvent({
        runId: run.runId,
        repoId: "repo-1",
        planArtifactId: "plan-1",
        type: "progress",
        message: `event ${index}`,
      });
    }

    const events = store.listPlannerRunEvents(run.runId);
    expect(events).toHaveLength(200);
    expect(events[0]?.seq).toBe(6);
    expect(store.listPlannerRunEvents(run.runId, { afterSeq: 202 }).map((event) => event.seq)).toEqual([203, 204, 205]);

    const updated = store.updatePlannerRun({
      runId: run.runId,
      status: "completed",
      completedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(updated).toMatchObject({ status: "completed" });

    storage.close();
  });

  it("freezes reviewer launch provenance on the leaf run and retains its badge after completion", () => {
    const { storage, store } = createSubject();
    const subscriptionProvenance = {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
      codexExecution: {
        kind: "subscription-app-server" as const,
        surface: "plan-reviewer" as const,
        backend: "cf" as const,
      },
    };
    const apiKeyProvenance = {
      schemaVersion: 1 as const,
      backend: "cf" as const,
      machineId: null,
      codexExecution: {
        kind: "api-key-direct-cli" as const,
        surface: "plan-reviewer" as const,
        backend: "cf" as const,
      },
    };
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: subscriptionProvenance,
    });
    expect(run).toMatchObject({
      launchProvenance: subscriptionProvenance,
      codexAuthMode: "subscription",
    });
    const completed = store.updatePlannerRun({
      runId: run.runId,
      status: "completed",
      completedAt: "2026-07-13T20:00:00.000Z",
    });
    expect(completed).toMatchObject({
      launchProvenance: subscriptionProvenance,
      codexAuthMode: "subscription",
    });

    const next = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: apiKeyProvenance,
    });
    expect(next).toMatchObject({
      launchProvenance: apiKeyProvenance,
      codexAuthMode: "api-key",
    });
    storage.close();
  });

  it("fails closed on pre-cutover planner provenance without the schema marker", () => {
    const { storage, store } = createSubject();
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: {
        schemaVersion: 1,
        backend: "cf",
        machineId: null,
      },
    });
    (store as any).db.exec(
      "UPDATE planner_runs SET launch_provenance_json = ? WHERE run_id = ?",
      JSON.stringify({ backend: "cf", machineId: null }),
      run.runId,
    );

    expect(() => store.getPlannerRun(run.runId))
      .toThrow("Malformed planner run launch execution placement");
    storage.close();
  });

  it("requires current launch provenance for every new planner workload", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "main-1" },
      title: "Plan",
      body: { markdown: "# Plan\n" },
      status: "draft",
      createdBy: "test",
    });

    expect(() => store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
    } as any)).toThrow("not from the current workload schema");
    expect(() => store.startPlanWriter({
      skills: [],
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-test",
      basisCommit: "main-1",
      startBodyDigest: sha256("# Plan\n"),
    } as any)).toThrow("not from the current workload schema");

    storage.close();
  });

  it("rejects pre-cutover runtime handles that duplicate execution placement", () => {
    const { storage, store } = createSubject();
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "codex",
      model: "gpt-5.5",
      launchProvenance: {
        schemaVersion: 1,
        backend: "host",
        machineId: "machine-1",
      },
    });

    expect(() => store.setPlannerRunRuntime(run.runId, {
      backend: "host",
      machineId: "machine-1",
      jobSlug: "legacy-runtime",
    } as any)).toThrow("not from the current workload schema");
    expect(store.getPlannerRun(run.runId)?.runtime).toBeUndefined();
    storage.close();
  });

  it("creates active planner runs atomically and exposes latest run state", () => {
    const { storage, store } = createSubject();
    const plan = store.createArtifact({
      repoId: "repo-1",
      type: "plan",
      basis: { repoId: "repo-1", mainCommit: "base-1" },
      title: "Plan",
      body: { markdown: "# Plan" },
      status: "draft",
    });
    const created = store.createPlannerRunIfNoActive({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      startedAt: "2026-06-01T00:00:00.000Z",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected run creation");

    const duplicate = store.createPlannerRunIfNoActive({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("expected duplicate active run");
    expect(duplicate.active.runId).toBe(created.run.runId);

    const cancelled = store.updatePlannerRun({
      runId: created.run.runId,
      status: "cancelled",
      completedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(store.updateActivePlannerRun({
      runId: created.run.runId,
      status: "completed",
      completedAt: "2026-06-01T00:00:01.000Z",
    })).toEqual(cancelled);

    const next = store.createPlannerRunIfNoActive({
      repoId: "repo-1",
      planArtifactId: plan.id,
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      startedAt: "2026-06-01T00:00:02.000Z",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(next.ok).toBe(true);
    expect(store.getLatestPlannerRun("repo-1", plan.id, "reviewer")).toMatchObject({
      startedAt: "2026-06-01T00:00:02.000Z",
    });

    storage.close();
  });

  it("enumerates raw planner statuses for fail-closed maintenance checks", () => {
    const { storage, store } = createSubject();
    const run = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    storage.sql.exec("UPDATE planner_runs SET status = ? WHERE run_id = ?", "corrupt", run.runId);

    expect(store.listActivePlannerRunsForRepo("repo-1")).toEqual([]);
    expect(store.listPlannerWorkloadStateForPredeploy("repo-1")).toEqual([{
      runId: run.runId,
      status: "corrupt",
      hasRuntime: false,
    }]);

    storage.close();
  });

  it("fences late workload and sidebar creation after repository finalization", () => {
    const { storage, store } = createSubject();

    store.finalizeRepositoryDeletion("repo-1");

    expect(() => store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      launchProvenance: CURRENT_CF_LAUNCH,
    })).toThrow("finalized for deletion");
    expect(() => store.claimEnvironmentSidebarSlot({
      slug: "late-env",
      claimId: "late-claim",
      createdAt: "2026-07-17T00:00:00.000Z",
    })).toThrow("finalized for deletion");
    expect(store.listPlannerWorkloadStateForPredeploy("repo-1")).toEqual([]);

    storage.close();
  });

  it("blocks repository finalization while environment creation owns a sidebar slot", () => {
    const { storage, store } = createSubject();

    expect(store.claimEnvironmentSidebarSlot({
      slug: "creating-env",
      claimId: "creation-claim",
      createdAt: "2026-07-17T00:00:00.000Z",
    })).toEqual({ status: "claimed", slot: 1 });

    expect(() => store.finalizeRepositoryDeletion("repo-1"))
      .toThrow("Environment creating-env is still being created.");
    expect(store.releaseEnvironmentSidebarSlotClaim("creating-env", "creation-claim")).toBe(true);

    expect(() => store.finalizeRepositoryDeletion("repo-1")).not.toThrow();
    expect(() => store.claimEnvironmentSidebarSlot({
      slug: "late-env",
      claimId: "late-claim",
      createdAt: "2026-07-17T00:00:01.000Z",
    })).toThrow("finalized for deletion");

    storage.close();
  });

  it("blocks repository finalization while a committed environment slot remains", () => {
    const { storage, store } = createSubject();

    store.claimEnvironmentSidebarSlot({
      slug: "attached-env",
      claimId: "creation-claim",
      createdAt: "2026-07-17T00:00:00.000Z",
    });
    expect(store.commitEnvironmentSidebarSlot("attached-env", "creation-claim")).toBe(true);

    expect(() => store.finalizeRepositoryDeletion("repo-1"))
      .toThrow("Environment attached-env is still attached to this repository.");
    expect(store.releaseEnvironmentSidebarSlot("attached-env")).toBe(true);
    expect(() => store.finalizeRepositoryDeletion("repo-1")).not.toThrow();

    storage.close();
  });

});
