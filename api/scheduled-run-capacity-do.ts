import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

/**
 * Scheduled Run orchestration is owned by each environment's
 * EnvLifecycleDO. This singleton owns only the one global invariant: at most
 * two scheduler-controlled runs may hold capacity at once.
 */
export const SCHEDULED_RUN_MAX_CONCURRENT = 2;

export interface ScheduledRunLeaseRequest {
  slug: string;
  attemptId: string;
}

export interface ScheduledRunLease {
  slot: number;
  slug: string;
  attemptId: string;
}

export type ScheduledRunAcquireResult =
  | {
      acquired: true;
      idempotent: boolean;
      lease: ScheduledRunLease;
    }
  | {
      acquired: false;
      reason: "capacity";
    }
  | {
      acquired: false;
      reason: "released";
    }
  | {
      acquired: false;
      reason: "attempt-conflict";
      lease: ScheduledRunLease;
    };

export type ScheduledRunReleaseResult =
  | {
      released: true;
      idempotent: boolean;
      lease?: ScheduledRunLease;
    }
  | {
      released: false;
      reason: "attempt-conflict";
      lease: ScheduledRunLease;
    };

export interface ScheduledRunCapacitySnapshot {
  maxConcurrent: number;
  available: number;
  leases: ScheduledRunLease[];
}

interface ScheduledRunLeaseRow {
  slot: number;
  slug: string;
  attempt_id: string;
}

interface ScheduledRunReleaseFenceRow {
  slug: string;
  attempt_sequence: number;
  attempt_id: string;
}

function parseAttemptSequence(attemptId: string): number | null {
  const match = /^attempt-(\d+)-.+$/.exec(attemptId);
  if (!match) return null;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function validateRequest(request: ScheduledRunLeaseRequest): ScheduledRunLeaseRequest {
  const slug = request?.slug?.trim();
  const attemptId = request?.attemptId?.trim();
  if (!slug) throw new TypeError("Scheduled Run lease slug is required.");
  if (!attemptId) throw new TypeError("Scheduled Run lease attemptId is required.");
  if (parseAttemptSequence(attemptId) == null) {
    throw new TypeError("Scheduled Run lease attemptId must contain a positive monotonic sequence.");
  }
  return { slug, attemptId };
}

export class ScheduledRunCapacityDO extends DurableObject<Env> {
  private _db: SqlStorage | null = null;
  private schemaReady = false;

  private get db(): SqlStorage {
    if (!this._db) this._db = this.ctx.storage.sql;
    if (!this.schemaReady) {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_run_capacity_leases (
          slot INTEGER PRIMARY KEY CHECK (slot >= 1 AND slot <= 2),
          slug TEXT NOT NULL UNIQUE,
          attempt_id TEXT NOT NULL
        )
      `);
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_run_capacity_release_fences (
          slug TEXT PRIMARY KEY,
          attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
          attempt_id TEXT NOT NULL
        )
      `);
      this.schemaReady = true;
    }
    return this._db;
  }

  private parseRow(row: ScheduledRunLeaseRow): ScheduledRunLease {
    return {
      slot: Number(row.slot),
      slug: row.slug,
      attemptId: row.attempt_id,
    };
  }

  private findBySlug(slug: string): ScheduledRunLease | null {
    const row = this.db.exec(
      "SELECT slot, slug, attempt_id FROM scheduled_run_capacity_leases WHERE slug = ?",
      slug,
    ).toArray()[0] as unknown as ScheduledRunLeaseRow | undefined;
    return row ? this.parseRow(row) : null;
  }

  private wasReleased(slug: string, attemptId: string): boolean {
    const attemptSequence = parseAttemptSequence(attemptId)!;
    const fence = this.findReleaseFence(slug);
    return Boolean(fence && attemptSequence <= Number(fence.attempt_sequence));
  }

  private findReleaseFence(slug: string): ScheduledRunReleaseFenceRow | null {
    return (this.db.exec(
      "SELECT slug, attempt_sequence, attempt_id FROM scheduled_run_capacity_release_fences WHERE slug = ?",
      slug,
    ).toArray()[0] as unknown as ScheduledRunReleaseFenceRow | undefined) ?? null;
  }

  private recordReleaseFence(slug: string, attemptId: string): void {
    const attemptSequence = parseAttemptSequence(attemptId)!;

    const existing = this.findReleaseFence(slug);
    if (!existing) {
      this.db.exec(
        "INSERT INTO scheduled_run_capacity_release_fences (slug, attempt_sequence, attempt_id) VALUES (?, ?, ?)",
        slug,
        attemptSequence,
        attemptId,
      );
      return;
    }
    if (attemptSequence > Number(existing.attempt_sequence)) {
      this.db.exec(
        "UPDATE scheduled_run_capacity_release_fences SET attempt_sequence = ?, attempt_id = ? WHERE slug = ?",
        attemptSequence,
        attemptId,
        slug,
      );
    }
  }

  acquire(request: ScheduledRunLeaseRequest): ScheduledRunAcquireResult {
    const { slug, attemptId } = validateRequest(request);
    if (this.wasReleased(slug, attemptId)) {
      return { acquired: false, reason: "released" };
    }
    const existing = this.findBySlug(slug);
    if (existing) {
      if (existing.attemptId === attemptId) {
        return { acquired: true, idempotent: true, lease: existing };
      }
      return { acquired: false, reason: "attempt-conflict", lease: existing };
    }

    const occupied = new Set(
      (this.db.exec(
        "SELECT slot FROM scheduled_run_capacity_leases ORDER BY slot",
      ).toArray() as Array<{ slot: number }>).map((row) => Number(row.slot)),
    );
    let slot: number | null = null;
    for (let candidate = 1; candidate <= SCHEDULED_RUN_MAX_CONCURRENT; candidate += 1) {
      if (!occupied.has(candidate)) {
        slot = candidate;
        break;
      }
    }
    if (slot == null) return { acquired: false, reason: "capacity" };

    this.db.exec(
      "INSERT INTO scheduled_run_capacity_leases (slot, slug, attempt_id) VALUES (?, ?, ?)",
      slot,
      slug,
      attemptId,
    );
    return {
      acquired: true,
      idempotent: false,
      lease: { slot, slug, attemptId },
    };
  }

  release(request: ScheduledRunLeaseRequest): ScheduledRunReleaseResult {
    const { slug, attemptId } = validateRequest(request);
    return this.ctx.storage.transactionSync(() => {
      if (this.wasReleased(slug, attemptId)) {
        return { released: true, idempotent: true };
      }

      const existing = this.findBySlug(slug);
      if (!existing) {
        // Fence a delayed/lost acquire for this exact attempt even when no
        // lease is visible yet. The owner may be resolving an ambiguous RPC;
        // without this tombstone, an acquire delivered after inspection could
        // recreate an orphan lease after the environment has gone terminal.
        this.recordReleaseFence(slug, attemptId);
        return { released: true, idempotent: false };
      }
      if (existing.attemptId !== attemptId) {
        return { released: false, reason: "attempt-conflict", lease: existing };
      }

      this.recordReleaseFence(slug, attemptId);
      this.db.exec(
        "DELETE FROM scheduled_run_capacity_leases WHERE slug = ? AND attempt_id = ?",
        slug,
        attemptId,
      );
      return { released: true, idempotent: false, lease: existing };
    });
  }

  inspect(): ScheduledRunCapacitySnapshot {
    const leases = (this.db.exec(
      "SELECT slot, slug, attempt_id FROM scheduled_run_capacity_leases ORDER BY slot",
    ).toArray() as unknown as ScheduledRunLeaseRow[]).map((row) => this.parseRow(row));
    return {
      maxConcurrent: SCHEDULED_RUN_MAX_CONCURRENT,
      available: SCHEDULED_RUN_MAX_CONCURRENT - leases.length,
      leases,
    };
  }
}
