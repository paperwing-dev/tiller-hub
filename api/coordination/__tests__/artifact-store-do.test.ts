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
import { MAX_PLAN_MARKDOWN_BYTES } from "../planning";
import { DEFAULT_PLAN_REVIEW_SKILL } from "../../planner/agent-skills";

type SqlResultRow = Record<string, unknown>;

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

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  close(): void {
    this.sql.close();
  }
}

function createSubject(storage = new FakeStorage()) {
  return {
    storage,
    store: new ArtifactStoreDO({ storage } as any, {} as any),
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const CURRENT_CF_LAUNCH = {
  schemaVersion: 1 as const,
  backend: "cf" as const,
  machineId: null,
};

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

describe("ArtifactStoreDO plan skill invocations", () => {
  it("reserves child ids once, hides linked reviewers, and derives terminal status", () => {
    const { storage, store } = createSubject();
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
      planArtifactId: "plan-1",
      parentThreadId: "plan-skills-plan-1",
      definitionSnapshot: definition,
      basis: {
        artifactId: "plan-1",
        title: "Plan",
        markdown: "# Frozen plan",
        version: 7,
        gitBaseCommitSha: "base-1",
      },
      agents: [
        { id: "architecture", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
        { id: "risk", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
      ],
    };
    const first = store.reservePlanSkillInvocation(input);
    const second = store.reservePlanSkillInvocation(input);
    expect(first.status).toBe("created");
    expect(second.status).toBe("existing");
    if (first.status === "conflict" || second.status === "conflict") throw new Error("unexpected conflict");
    expect(second.runs.map((run) => run.runId)).toEqual(first.runs.map((run) => run.runId));
    expect(second.reviewers.map((reviewer) => reviewer.threadId)).toEqual(first.reviewers.map((reviewer) => reviewer.threadId));
    expect(store.listReviewers("repo-1", "plan-1")).toEqual([]);
    expect(first.runs[0]?.input?.basis).toEqual(input.basis);

    store.activatePlanSkillInvocation("invoke-1");
    store.updatePlannerRun({ runId: first.runs[0]!.runId, status: "completed", completedAt: new Date().toISOString() });
    expect(store.getPlanSkillInvocation("invoke-1")?.status).toBe("active");
    store.updatePlannerRun({ runId: first.runs[1]!.runId, status: "failed", completedAt: new Date().toISOString(), error: "failed" });
    expect(store.getPlanSkillInvocation("invoke-1")?.status).toBe("completed");

    const followup = store.createPlannerRun({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      threadId: first.reviewers[0]!.threadId,
      skillInvocationId: "invoke-1",
      skillAgentId: "architecture",
      skillRunRole: "child_followup",
      input: { basis: input.basis },
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    store.updatePlannerRun({ runId: followup.runId, status: "completed", completedAt: new Date().toISOString() });
    expect(store.getPlanSkillInvocation("invoke-1")?.status).toBe("completed");
    storage.close();
  });

  it("fails a fanout when no initial child succeeds and keeps exactly one invocation table", () => {
    const { storage, store } = createSubject();
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
      planArtifactId: "plan-1",
      parentThreadId: "plan-skills-plan-1",
      definitionSnapshot: definition,
      basis: { artifactId: "plan-1", title: "Plan", markdown: "frozen", version: 1, gitBaseCommitSha: null },
      agents: [
        { id: "one", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
        { id: "two", provider: "fake", model: "fake-fast", launchProvenance: CURRENT_CF_LAUNCH },
      ],
    });
    if (reserved.status === "conflict") throw new Error("unexpected conflict");
    store.activatePlanSkillInvocation("invoke-zero");
    for (const run of reserved.runs) {
      store.updatePlannerRun({ runId: run.runId, status: "failed", completedAt: new Date().toISOString(), error: "no result" });
    }
    expect(store.getPlanSkillInvocation("invoke-zero")?.status).toBe("failed");
    const tables = storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%skill_invocations'").toArray();
    expect(tables).toEqual([{ name: "plan_skill_invocations" }]);
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
    expect(first).toMatchObject({
      title: "Manual title",
      body: { markdown: "# Manual title\n\nChanged by hand." },
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
    expect(renamed).toMatchObject({
      title: "Renamed manual title",
      body: { markdown: "## Title\n\nRenamed manual title\n\n## Summary\nChanged again." },
      basis: { mainCommit: "main-1" },
      status: "evaluating",
      version: 9,
    });

    const empty = store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "" });
    expect(empty).toMatchObject({
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

    const completed = store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "completed" });
    expect(() => store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "Nope" }))
      .toThrow(/only draft, evaluating, or todo/i);
    store.updateArtifactStatus({ repoId: "repo-1", id: plan.id, status: "archived", expectedVersion: completed.version });
    expect(() => store.savePlan({ repoId: "repo-1", id: plan.id, markdown: "Still nope" }))
      .toThrow(/only draft, evaluating, or todo/i);
    storage.close();
  });
});

describe("ArtifactStoreDO plan discard", () => {
  it("hard-deletes draft plans with their refs and reviewer registry rows", () => {
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
    store.upsertReviewer({
      ...reviewerInput(),
      planArtifactId: plan.id,
    });

    const discarded = store.discardPlan({ repoId: "repo-1", id: plan.id, expectedVersion: plan.version });

    expect(discarded.id).toBe(plan.id);
    expect(store.getArtifact(plan.id)).toBeNull();
    expect(store.listRefs()).toEqual([]);
    expect(store.listReviewers("repo-1", plan.id, { includeRemoved: true })).toEqual([]);

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

  it("refuses active planner runs and retained warm-runtime provenance before mutation", () => {
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
    expect(() => store.discardPlan({ repoId: "repo-1", id: plan.id })).toThrow(/active planner run/i);
    expect(store.getArtifact(plan.id)).not.toBeNull();
    store.updateActivePlannerRun({ runId: run.runId, status: "cancelled" });

    const writer = store.startPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "sonnet",
      basisCommit: "main-1",
      startBodyDigest: sha256("Do the work.\n"),
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const runtime = {
      jobSlug: "plan-writer-job",
      generation: 1,
    };
    store.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    expect(() => store.discardPlan({ repoId: "repo-1", id: plan.id })).toThrow(/Stop the Plan Writer/i);
    store.fencePlanWriterStop({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: 1,
      reason: "user",
    });
    expect(() => store.discardPlan({ repoId: "repo-1", id: plan.id })).toThrow(/runtime provenance/i);
    expect(store.getArtifact(plan.id)).not.toBeNull();

    expect(store.clearPlanWriterRuntimeIfCurrent(writer.threadId, { ...runtime, generation: 99 })).toBeNull();
    expect(store.getPlanWriter("repo-1", plan.id)?.runtime).toEqual(runtime);
    store.clearPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    expect(store.discardPlan({ repoId: "repo-1", id: plan.id }).id).toBe(plan.id);
    storage.close();
  });
});

describe("ArtifactStoreDO Plan Writer", () => {
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
      launchProvenance: subscriptionProvenance,
      codexAuthMode: "subscription",
    });

    const runtime = {
      jobSlug: "plan-writer-1",
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
      launchProvenance: subscriptionProvenance,
      codexAuthMode: "subscription",
    });

    const second = store.startPlanWriter({
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
      launchProvenance: apiKeyProvenance,
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
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "claude-code",
      model: "claude-test",
      basisCommit: "main-1",
      startBodyDigest: originalDigest,
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    const retried = store.startPlanWriter({
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
      jobSlug: "plan-writer-job-1",
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

    expect(store.fencePlanWriterStop({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: 1,
      reason: "user",
    }).status).toBe("stopped");
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

    expect(() => store.startPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "codex-test",
      basisCommit: "main-1",
      startBodyDigest: updatedDigest,
      launchProvenance: CURRENT_CF_LAUNCH,
    })).toThrow(/cleanup/i);
    store.clearPlanWriterRuntimeIfCurrent(first.threadId, runtime);
    const second = store.startPlanWriter({
      repoId: "repo-1",
      planArtifactId: plan.id,
      provider: "codex",
      model: "codex-test",
      basisCommit: "main-1",
      startBodyDigest: updatedDigest,
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(second).toMatchObject({ provider: "codex", generation: 2 });
    expect(store.fencePlanWriterStop({
      repoId: "repo-1",
      planArtifactId: plan.id,
      expectedGeneration: 1,
      reason: "user",
    }).status).toBe("stale");
    expect(store.getPlanWriter("repo-1", plan.id)?.stoppedAt).toBeUndefined();
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
    expect(manuallySaved.version).toBe(2);

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
    })).toEqual({ status: "rejected", reason: "plan_ineligible" });
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
    const created = store.createPlannerRunIfNoActive({
      repoId: "repo-1",
      planArtifactId: "plan-1",
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
      planArtifactId: "plan-1",
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
      planArtifactId: "plan-1",
      role: "reviewer",
      provider: "fake",
      model: "fake-fast",
      startedAt: "2026-06-01T00:00:02.000Z",
      launchProvenance: CURRENT_CF_LAUNCH,
    });
    expect(next.ok).toBe(true);
    expect(store.getLatestPlannerRun("repo-1", "plan-1", "reviewer")).toMatchObject({
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
