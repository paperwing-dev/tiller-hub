import type { EnvMeta, RepoMeta, ScmOperationType } from "../types";
import type { RepoMergeLockRecord, RepoScmOperationRecord, RepoScmOperationStatus } from "./repo-merge-lock-do";

/**
 * SCM Authority Split (Contract)
 *
 * This repo intentionally splits "what is true" across multiple stores. The
 * goal is to make it obvious which store is authoritative for which question.
 *
 * Authoritative Stores
 * - RepoMergeLockDO:
 *   Authoritative SCM operation lifecycle.
 *   Decides whether an operation is `pending`, `succeeded`, `failed`, or stale.
 * - Repo metadata:
 *   Authoritative canonical `main` pointer (`mainCommit` + `gitArtifactId`).
 *
 * Projected / Non-authoritative Stores
 * - Env KV summary (and env lifecycle DO projection that feeds it):
 *   UI-facing projection of the current SCM state for an env. It must be
 *   reconciled against the authoritative operation record.
 *
 * Payload Storage (Non-authoritative)
 * - R2 SCM artifacts:
 *   Stores env snapshots and staged repo git artifacts. Artifacts do not define
 *   operation lifecycle state.
 *
 * Event Inputs (Non-authoritative)
 * - Runner callbacks:
 *   Progress/result/failure/heartbeat signals. They *request* transitions but do
 *   not directly own durable state.
 */

export type ScmOperationStatus = RepoScmOperationStatus;

export type ScmOperationRecord = RepoScmOperationRecord;
export type ScmMergeLockRecord = RepoMergeLockRecord;

export type ScmCallbackKind = "progress" | "result" | "failed" | "heartbeat";

/**
 * Callback idempotency + staleness semantics:
 *
 * A callback is considered stale/duplicate and must be treated as a no-op when:
 * - The operation record does not exist, OR
 * - The operation record is not `pending`, OR
 * - The operation record is for a different env slug, OR
 * - The env projection does not match the operation (different operationId/type)
 *
 * In those cases services should return `{ outcome: "skipped" }` and avoid
 * mutating the env projection or operation record.
 */
export type ScmCallbackOutcome =
  | { outcome: "skipped"; operationId: string; kind: ScmCallbackKind; reason: "stale" | "duplicate" | "not-found" }
  | { outcome: "progressed"; operationId: string; phase: string }
  | { outcome: "updated"; operationId: string }
  | { outcome: "conflicted"; operationId: string }
  | { outcome: "merged"; operationId: string }
  | { outcome: "failed"; operationId: string; error: string }
  | { outcome: "heartbeat"; operationId: string; expiresAt: string; heartbeatAt: string };

export type ScmStartOutcome =
  | { outcome: "already-current"; repoId: string; currentMainCommit: string | null }
  | { outcome: "started"; operationId: string; pending: boolean }
  | { outcome: "completed"; operationId: string; result: Record<string, unknown> };

export interface ScmServiceResult<
  TBody extends Record<string, unknown>,
  TOutcome extends { outcome: string },
> {
  status: number;
  body: TBody;
  outcome: TOutcome;
}

export interface ScmMergedRepoBroadcast {
  slug: string;
  previousMainCommit: string | null;
  nextRepoMeta: RepoMeta;
}

export type ScmOperationMatchInput = Pick<EnvMeta, "slug" | "scmOperationId" | "scmOperationType">;

export type CanonicalRepoReadiness = Pick<RepoMeta, "gitStatus" | "gitArtifactId" | "mainCommit" | "gitError">;

export function matchesScmOperationProjection(
  meta: ScmOperationMatchInput,
  operation: Pick<ScmOperationRecord, "operationId" | "type" | "envSlug">,
): boolean {
  return (
    meta.slug === operation.envSlug &&
    meta.scmOperationId === operation.operationId &&
    meta.scmOperationType === (operation.type as ScmOperationType)
  );
}
