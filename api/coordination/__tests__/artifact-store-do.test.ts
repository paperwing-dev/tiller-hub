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

import { ArtifactStoreDO } from "../artifact-store-do";

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
});

describe("ArtifactStoreDO reviewer registry", () => {
  it("allows multiple active reviewers with the same model", () => {
    const { storage, store } = createSubject();

    const first = store.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      reviewerModel: "@cf/nvidia/nemotron-3-120b-a12b",
    });
    const second = store.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      reviewerModel: "@cf/nvidia/nemotron-3-120b-a12b",
    });
    expect(second.threadId).not.toBe(first.threadId);
    expect(store.listReviewers("repo-1", "plan-1")).toEqual([first, second]);

    const removed = store.removeReviewer("repo-1", "plan-1", first.threadId);
    expect(removed.removedAt).toBeTruthy();
    expect(store.listReviewers("repo-1", "plan-1")).toEqual([second]);
    expect(store.listReviewers("repo-1", "plan-1", { includeRemoved: true })).toHaveLength(2);

    const third = store.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      reviewerModel: "@cf/nvidia/nemotron-3-120b-a12b",
    });
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
    const second = store.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      reviewerModel: "@cf/nvidia/nemotron-3-120b-a12b",
    });
    expect(second.threadId).not.toBe("thread-1");
    expect(store.listReviewers("repo-1", "plan-1")).toHaveLength(2);

    const afterRestart = new ArtifactStoreDO({ storage } as any, {} as any);
    const third = afterRestart.upsertReviewer({
      repoId: "repo-1",
      planArtifactId: "plan-1",
      reviewerModel: "@cf/nvidia/nemotron-3-120b-a12b",
    });
    expect(third.threadId).not.toBe("thread-1");
    expect(afterRestart.listReviewers("repo-1", "plan-1")).toHaveLength(3);

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
      repoId: "repo-1",
      planArtifactId: plan.id,
      reviewerModel: "@cf/nvidia/nemotron-3-120b-a12b",
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
});
