import { getRepoMergeLockStub } from "../helpers";
import type { Env } from "../types";
import type {
  AcquireRepoMergeLockOptions,
  AcquireRepoMergeLockResult,
  CompleteRepoScmOperationOptions,
  CreateRepoScmOperationOptions,
  FailRepoScmOperationOptions,
  RepoMergeLockHeartbeatResult,
  RepoMergeLockRecord,
  RepoMergeLockReleaseResult,
  RepoScmOperationRecord,
} from "./repo-merge-lock-do";

/**
 * Thin wrapper over RepoMergeLockDO that makes the storage backend an internal detail.
 *
 * The repo merge lock DO is authoritative for SCM operation lifecycle; callers should
 * not directly couple route/workflow code to DO APIs.
 */
export interface ScmOperationStore {
  getMergeLock(): Promise<RepoMergeLockRecord | null>;
  acquireMergeLock(options: AcquireRepoMergeLockOptions): Promise<AcquireRepoMergeLockResult>;
  heartbeatMergeLock(token: string, leaseMs?: number | null): Promise<RepoMergeLockHeartbeatResult>;
  releaseMergeLock(token: string): Promise<RepoMergeLockReleaseResult>;

  createOperation(options: CreateRepoScmOperationOptions): Promise<RepoScmOperationRecord>;
  getOperation(operationId: string): Promise<RepoScmOperationRecord | null>;
  findPendingOperationForEnv(envSlug: string): Promise<RepoScmOperationRecord | null>;
  completeOperation(options: CompleteRepoScmOperationOptions): Promise<RepoScmOperationRecord | null>;
  failOperation(options: FailRepoScmOperationOptions): Promise<RepoScmOperationRecord | null>;
  clearOperation(operationId: string): Promise<void>;
}

export function getScmOperationStore(env: Env, repoId: string): ScmOperationStore {
  const stub = getRepoMergeLockStub(env, repoId);
  return {
    getMergeLock: async () => await stub.getLock(),
    acquireMergeLock: async (options) => await stub.acquire(options),
    heartbeatMergeLock: async (token, leaseMs) => await stub.heartbeat(token, leaseMs),
    releaseMergeLock: async (token) => await stub.release(token),

    createOperation: async (options) => await stub.createOperation(options),
    getOperation: async (operationId) => await stub.getOperation(operationId),
    findPendingOperationForEnv: async (envSlug) => await stub.findPendingOperationForEnv(envSlug),
    completeOperation: async (options) => await stub.completeOperation(options),
    failOperation: async (options) => await stub.failOperation(options),
    clearOperation: async (operationId) => await stub.clearOperation(operationId),
  };
}

