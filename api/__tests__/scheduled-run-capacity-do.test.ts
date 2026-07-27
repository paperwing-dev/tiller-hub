import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { Env } from "../types";
import {
  SCHEDULED_RUN_MAX_CONCURRENT,
  ScheduledRunCapacityDO,
} from "../scheduled-run-capacity-do";

type SqlResultRow = Record<string, unknown>;

function result<T extends SqlResultRow>(rows: T[], rowsWritten = 0) {
  return {
    rowsWritten,
    toArray: () => rows,
    *[Symbol.iterator](): IterableIterator<T> { yield* rows; },
  };
}

class FakeSqlStorage {
  private readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...params: SQLInputValue[]) {
    if (/^\s*(select|pragma)\b/i.test(query)) {
      return result(this.db.prepare(query).all(...params) as SqlResultRow[]);
    }
    if (params.length > 0) {
      const update = this.db.prepare(query).run(...params);
      return result([], Number(update.changes ?? 0));
    }
    this.db.exec(query);
    return result([]);
  }
}

function makeSubject(sql = new FakeSqlStorage()) {
  const storage = {
    sql,
    transactionSync: <T>(closure: () => T): T => closure(),
    setAlarm: () => {
      throw new Error("capacity coordinator must not set alarms");
    },
    deleteAlarm: () => {
      throw new Error("capacity coordinator must not delete alarms");
    },
  };
  const ctx = { storage } as unknown as DurableObjectState;
  return { subject: new ScheduledRunCapacityDO(ctx, {} as Env), sql };
}

describe("ScheduledRunCapacityDO capacity leases", () => {
  it("allocates the two slots deterministically and refuses a third lease", () => {
    const { subject } = makeSubject();

    expect(subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      acquired: true,
      idempotent: false,
      lease: { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
    });
    expect(subject.acquire({ slug: "env-b", attemptId: "attempt-1-b" })).toEqual({
      acquired: true,
      idempotent: false,
      lease: { slot: 2, slug: "env-b", attemptId: "attempt-1-b" },
    });
    expect(subject.acquire({ slug: "env-c", attemptId: "attempt-1-c" })).toEqual({
      acquired: false,
      reason: "capacity",
    });
  });

  it("reuses the lowest free slot", () => {
    const { subject } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });
    subject.acquire({ slug: "env-b", attemptId: "attempt-1-b" });
    subject.release({ slug: "env-a", attemptId: "attempt-1-a" });

    expect(subject.acquire({ slug: "env-c", attemptId: "attempt-1-c" })).toMatchObject({
      acquired: true,
      lease: { slot: 1, slug: "env-c", attemptId: "attempt-1-c" },
    });
  });

  it("makes acquiring the same slug and attempt idempotent", () => {
    const { subject } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });

    expect(subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      acquired: true,
      idempotent: true,
      lease: { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
    });
    expect(subject.inspect().leases).toHaveLength(1);
  });

  it("rejects a different attempt while the slug owns a lease", () => {
    const { subject } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });

    expect(subject.acquire({ slug: "env-a", attemptId: "attempt-2-new" })).toEqual({
      acquired: false,
      reason: "attempt-conflict",
      lease: { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
    });
  });

  it("does not release a lease for the wrong slug-attempt pair", () => {
    const { subject } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });

    expect(subject.release({ slug: "env-a", attemptId: "attempt-2-new" })).toEqual({
      released: false,
      reason: "attempt-conflict",
      lease: { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
    });
    expect(subject.inspect().leases).toEqual([
      { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
    ]);
  });

  it("makes repeated exact-pair releases harmless", () => {
    const { subject } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });

    expect(subject.release({ slug: "env-a", attemptId: "attempt-1-a" })).toMatchObject({
      released: true,
      idempotent: false,
    });
    expect(subject.release({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      released: true,
      idempotent: true,
    });
  });

  it("makes a released attempt durably terminal to late acquire retries", () => {
    const { subject, sql } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });
    subject.release({ slug: "env-a", attemptId: "attempt-1-a" });

    const reconstructed = makeSubject(sql).subject;
    expect(reconstructed.acquire({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      acquired: false,
      reason: "released",
    });
    expect(reconstructed.inspect().leases).toEqual([]);

    expect(reconstructed.acquire({ slug: "env-a", attemptId: "attempt-2-b" })).toMatchObject({
      acquired: true,
      lease: { slot: 1, slug: "env-a", attemptId: "attempt-2-b" },
    });
    expect(reconstructed.release({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      released: true,
      idempotent: true,
    });
    expect(reconstructed.inspect().leases).toEqual([
      { slot: 1, slug: "env-a", attemptId: "attempt-2-b" },
    ]);
  });

  it("tombstones an unknown exact release so a delayed acquire cannot leak capacity", () => {
    const { subject } = makeSubject();
    expect(subject.release({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      released: true,
      idempotent: false,
    });
    expect(subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      acquired: false,
      reason: "released",
    });
    expect(subject.release({ slug: "env-a", attemptId: "attempt-1-a" })).toEqual({
      released: true,
      idempotent: true,
    });
  });

  it("collapses ordered release history into one durable high-water fence per slug", () => {
    const { subject, sql } = makeSubject();
    const attempt = (sequence: number) => `attempt-${sequence}-test`;

    expect(subject.release({ slug: "env-a", attemptId: attempt(1) })).toEqual({
      released: true,
      idempotent: false,
    });
    for (let sequence = 2; sequence <= 100; sequence += 1) {
      expect(subject.acquire({ slug: "env-a", attemptId: attempt(sequence) })).toMatchObject({
        acquired: true,
      });
      expect(subject.release({ slug: "env-a", attemptId: attempt(sequence) })).toMatchObject({
        released: true,
      });
    }

    expect(sql.exec(
      "SELECT slug, attempt_sequence, attempt_id FROM scheduled_run_capacity_release_fences WHERE slug = ?",
      "env-a",
    ).toArray()).toEqual([{
      slug: "env-a",
      attempt_sequence: 100,
      attempt_id: attempt(100),
    }]);
    const reconstructed = makeSubject(sql).subject;
    expect(reconstructed.acquire({ slug: "env-a", attemptId: attempt(1) })).toEqual({
      acquired: false,
      reason: "released",
    });
    expect(reconstructed.acquire({ slug: "env-a", attemptId: attempt(57) })).toEqual({
      acquired: false,
      reason: "released",
    });
    expect(reconstructed.acquire({ slug: "env-a", attemptId: attempt(101) })).toMatchObject({
      acquired: true,
      lease: { slug: "env-a", attemptId: attempt(101) },
    });
  });

  it("keeps leases durably until their exact pair is released", () => {
    const { subject, sql } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });

    const reconstructed = makeSubject(sql).subject;
    expect(reconstructed.inspect().leases).toEqual([
      { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
    ]);
  });

  it("reports a stable, slot-ordered capacity snapshot", () => {
    const { subject } = makeSubject();
    subject.acquire({ slug: "env-a", attemptId: "attempt-1-a" });
    subject.acquire({ slug: "env-b", attemptId: "attempt-1-b" });

    expect(subject.inspect()).toEqual({
      maxConcurrent: SCHEDULED_RUN_MAX_CONCURRENT,
      available: 0,
      leases: [
        { slot: 1, slug: "env-a", attemptId: "attempt-1-a" },
        { slot: 2, slug: "env-b", attemptId: "attempt-1-b" },
      ],
    });
  });

  it.each([
    [{ slug: "", attemptId: "attempt-1-a" }, "slug"],
    [{ slug: "env-a", attemptId: "" }, "attemptId"],
    [{ slug: "env-a", attemptId: "attempt-unordered" }, "monotonic"],
  ])("rejects invalid lease identity %o", (request, field) => {
    const { subject } = makeSubject();
    expect(() => subject.acquire(request)).toThrow(field);
    expect(() => subject.release(request)).toThrow(field);
  });
});
