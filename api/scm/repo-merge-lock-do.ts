import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { resolveRepoMergeLockLeaseMs } from "./constants";

const STORAGE_KEY = "repo-merge-lock";
const OPERATION_KEY_PREFIX = "repo-scm-operation:";
const COMPLETED_OPERATION_RETENTION_MS = 10 * 60_000;
const PENDING_OPERATION_TIMEOUT_MS = 15 * 60_000;

export type RepoScmOperationType = "merge-into-main" | "update-from-main";
export type RepoScmOperationStatus = "pending" | "succeeded" | "failed";

export interface RepoScmOperationResult {
  action?: string | null;
  message?: string | null;
  conflictCount?: number | null;
  repoId?: string | null;
  previousMainCommit?: string | null;
  currentMainCommit?: string | null;
}

export interface RepoScmOperationRecord {
  operationId: string;
  type: RepoScmOperationType;
  envSlug: string;
  ownerId: string;
  status: RepoScmOperationStatus;
  createdAt: string;
  updatedAt: string;
  mergeLockToken?: string | null;
  gitArtifactId?: string | null;
  result?: RepoScmOperationResult | null;
  error?: string | null;
}

export interface CreateRepoScmOperationOptions {
  operationId: string;
  type: RepoScmOperationType;
  envSlug: string;
  ownerId: string;
  mergeLockToken?: string | null;
  gitArtifactId?: string | null;
}

export interface CompleteRepoScmOperationOptions {
  operationId: string;
  result: RepoScmOperationResult;
}

export interface FailRepoScmOperationOptions {
  operationId: string;
  error: string;
  result?: RepoScmOperationResult | null;
}

export interface RepoMergeLockRecord {
  ownerId: string;
  operationId: string;
  token: string;
  acquiredAt: string;
  heartbeatAt: string;
  expiresAt: string;
  leaseMs: number;
}

export interface AcquireRepoMergeLockOptions {
  ownerId: string;
  operationId: string;
  leaseMs?: number | null;
}

export type AcquireRepoMergeLockResult =
  | { acquired: true; lock: RepoMergeLockRecord }
  | { acquired: false; lock: RepoMergeLockRecord };

export type RepoMergeLockHeartbeatResult =
  | { ok: true; lock: RepoMergeLockRecord }
  | { ok: false; reason: "not_found" | "not_holder"; lock: RepoMergeLockRecord | null };

export interface RepoMergeLockReleaseResult {
  released: boolean;
  lock: RepoMergeLockRecord | null;
}

function getOperationStorageKey(operationId: string): string {
  return `${OPERATION_KEY_PREFIX}${operationId}`;
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isExpired(lock: RepoMergeLockRecord, now = Date.now()): boolean {
  return parseTimestamp(lock.expiresAt) <= now;
}

function buildLockRecord(options: {
  ownerId: string;
  operationId: string;
  token?: string;
  acquiredAt?: Date;
  leaseMs?: number | null;
}): RepoMergeLockRecord {
  const acquiredAt = options.acquiredAt ?? new Date();
  const leaseMs = resolveRepoMergeLockLeaseMs(options.leaseMs);
  const expiresAt = new Date(acquiredAt.getTime() + leaseMs);
  return {
    ownerId: options.ownerId,
    operationId: options.operationId,
    token: options.token ?? crypto.randomUUID(),
    acquiredAt: acquiredAt.toISOString(),
    heartbeatAt: acquiredAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    leaseMs,
  };
}

export class RepoMergeLockDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private async scheduleAlarmAt(candidate: number | null): Promise<void> {
    if (candidate === null || !Number.isFinite(candidate)) {
      return;
    }
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || candidate < existing) {
      await this.ctx.storage.setAlarm(candidate);
    }
  }

  private async readLock(): Promise<RepoMergeLockRecord | null> {
    const lock = (await this.ctx.storage.get<RepoMergeLockRecord>(STORAGE_KEY)) ?? null;
    if (!lock) return null;
    if (!isExpired(lock)) return lock;

    await this.clearLock();
    return null;
  }

  private async writeLock(lock: RepoMergeLockRecord): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, lock);
    await this.scheduleAlarmAt(parseTimestamp(lock.expiresAt));
  }

  private async clearLock(): Promise<void> {
    await this.ctx.storage.delete(STORAGE_KEY);
  }

  private async listOperationRecords(): Promise<Array<[string, RepoScmOperationRecord]>> {
    const records = await this.ctx.storage.list<RepoScmOperationRecord>({ prefix: OPERATION_KEY_PREFIX });
    return Array.from(records.entries());
  }

  async findPendingOperationForEnv(envSlug: string): Promise<RepoScmOperationRecord | null> {
    const records = await this.listOperationRecords();
    for (const [, record] of records) {
      if (record.envSlug === envSlug && record.status === "pending") {
        return record;
      }
    }
    return null;
  }

  private async scheduleOperationCleanup(record: RepoScmOperationRecord): Promise<void> {
    const cleanupAt =
      record.status === "pending"
        ? parseTimestamp(record.updatedAt) + PENDING_OPERATION_TIMEOUT_MS
        : parseTimestamp(record.updatedAt) + COMPLETED_OPERATION_RETENTION_MS;
    await this.scheduleAlarmAt(cleanupAt);
  }

  private async purgeCompletedOperations(now = Date.now()): Promise<number | null> {
    const records = await this.listOperationRecords();
    let nextCleanupAt: number | null = null;

    for (const [key, record] of records) {
      if (record.status === "pending") {
        const staleAt = parseTimestamp(record.updatedAt) + PENDING_OPERATION_TIMEOUT_MS;
        if (staleAt <= now) {
          const next: RepoScmOperationRecord = {
            ...record,
            status: "failed",
            updatedAt: new Date(now).toISOString(),
            error: record.error ?? "SCM operation timed out before reporting a result.",
          };
          await this.ctx.storage.put(key, next);
          const cleanupAt = parseTimestamp(next.updatedAt) + COMPLETED_OPERATION_RETENTION_MS;
          if (nextCleanupAt === null || cleanupAt < nextCleanupAt) {
            nextCleanupAt = cleanupAt;
          }
          continue;
        }
        if (nextCleanupAt === null || staleAt < nextCleanupAt) {
          nextCleanupAt = staleAt;
        }
        continue;
      }
      const cleanupAt = parseTimestamp(record.updatedAt) + COMPLETED_OPERATION_RETENTION_MS;
      if (cleanupAt <= now) {
        await this.ctx.storage.delete(key);
        continue;
      }
      if (nextCleanupAt === null || cleanupAt < nextCleanupAt) {
        nextCleanupAt = cleanupAt;
      }
    }

    return nextCleanupAt;
  }

  async acquire(options: AcquireRepoMergeLockOptions): Promise<AcquireRepoMergeLockResult> {
    const current = await this.readLock();
    if (current) {
      return { acquired: false, lock: current };
    }

    const next = buildLockRecord(options);
    await this.writeLock(next);
    return { acquired: true, lock: next };
  }

  async heartbeat(token: string, leaseMs?: number | null): Promise<RepoMergeLockHeartbeatResult> {
    const current = await this.readLock();
    if (!current) {
      return { ok: false, reason: "not_found", lock: null };
    }
    if (current.token !== token) {
      return { ok: false, reason: "not_holder", lock: current };
    }

    const renewed = buildLockRecord({
      ownerId: current.ownerId,
      operationId: current.operationId,
      token: current.token,
      acquiredAt: new Date(current.acquiredAt),
      leaseMs: leaseMs ?? current.leaseMs,
    });
    renewed.heartbeatAt = new Date().toISOString();
    renewed.expiresAt = new Date(Date.now() + renewed.leaseMs).toISOString();

    await this.writeLock(renewed);
    return { ok: true, lock: renewed };
  }

  async release(token: string): Promise<RepoMergeLockReleaseResult> {
    const current = await this.readLock();
    if (!current) {
      return { released: false, lock: null };
    }
    if (current.token !== token) {
      return { released: false, lock: current };
    }

    await this.clearLock();
    return { released: true, lock: current };
  }

  async getLock(): Promise<RepoMergeLockRecord | null> {
    return this.readLock();
  }

  async createOperation(options: CreateRepoScmOperationOptions): Promise<RepoScmOperationRecord> {
    const now = new Date().toISOString();
    const record: RepoScmOperationRecord = {
      operationId: options.operationId,
      type: options.type,
      envSlug: options.envSlug,
      ownerId: options.ownerId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      mergeLockToken: options.mergeLockToken ?? null,
      gitArtifactId: options.gitArtifactId ?? null,
      result: null,
      error: null,
    };
    await this.ctx.storage.put(getOperationStorageKey(options.operationId), record);
    await this.scheduleOperationCleanup(record);
    return record;
  }

  async getOperation(operationId: string): Promise<RepoScmOperationRecord | null> {
    return (await this.ctx.storage.get<RepoScmOperationRecord>(getOperationStorageKey(operationId))) ?? null;
  }

  async completeOperation(options: CompleteRepoScmOperationOptions): Promise<RepoScmOperationRecord | null> {
    const current = await this.getOperation(options.operationId);
    if (!current) return null;

    const next: RepoScmOperationRecord = {
      ...current,
      status: "succeeded",
      updatedAt: new Date().toISOString(),
      result: options.result,
      error: null,
    };
    await this.ctx.storage.put(getOperationStorageKey(options.operationId), next);
    await this.scheduleOperationCleanup(next);
    return next;
  }

  async failOperation(options: FailRepoScmOperationOptions): Promise<RepoScmOperationRecord | null> {
    const current = await this.getOperation(options.operationId);
    if (!current) return null;

    const next: RepoScmOperationRecord = {
      ...current,
      status: "failed",
      updatedAt: new Date().toISOString(),
      result: options.result ?? current.result ?? null,
      error: options.error,
    };
    await this.ctx.storage.put(getOperationStorageKey(options.operationId), next);
    await this.scheduleOperationCleanup(next);
    return next;
  }

  async clearOperation(operationId: string): Promise<void> {
    await this.ctx.storage.delete(getOperationStorageKey(operationId));
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    const current = (await this.ctx.storage.get<RepoMergeLockRecord>(STORAGE_KEY)) ?? null;
    if (current && isExpired(current, now)) {
      await this.clearLock();
    }

    const nextCleanupAt = await this.purgeCompletedOperations(now);
    const nextLockAlarm =
      current && !isExpired(current, now)
        ? parseTimestamp(current.expiresAt)
        : null;
    const nextAlarm =
      nextCleanupAt === null
        ? nextLockAlarm
        : nextLockAlarm === null
          ? nextCleanupAt
          : Math.min(nextCleanupAt, nextLockAlarm);

    if (nextAlarm === null) {
      const existing = await this.ctx.storage.getAlarm();
      if (existing !== null) {
        await this.ctx.storage.deleteAlarm();
      }
      return;
    }

    await this.ctx.storage.setAlarm(nextAlarm);
  }
}
