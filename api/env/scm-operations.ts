import type { Env, RepoMeta } from "../types";
import type { RepoScmOperationRecord } from "../scm/repo-merge-lock-do";
import { getScmOperationStore } from "../scm/operation-store";

export function createScmOperationId(): string {
  return `op-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

export function getRepoGitNotReadyError(
  repo: Pick<RepoMeta, "mainCommit" | "gitArtifactId" | "gitStatus" | "gitError">,
): string | null {
  if (repo.gitStatus === "repair-required") {
    return repo.gitError
      ? `Canonical main bootstrap failed: ${repo.gitError}`
      : "Canonical main bootstrap failed. Retry the repo bootstrap before creating environments.";
  }
  if (repo.gitStatus !== "ready" || !repo.gitArtifactId || !repo.mainCommit) {
    return "Canonical main is not ready yet for this repository. Wait for repo git bootstrap to finish.";
  }
  return null;
}

export function readScmOperationHeader(header: string | undefined | null): string | null {
  const value = header?.trim();
  return value ? value : null;
}

export function readScmOperationIntHeader(header: string | undefined | null): number | null {
  const value = readScmOperationHeader(header);
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function readScmOperationDurationHeader(header: string | undefined | null): number | null {
  const parsed = readScmOperationIntHeader(header);
  return parsed !== null && parsed >= 0 ? parsed : null;
}

export async function waitForRepoScmOperation(
  env: Env,
  repoId: string,
  operationId: string,
  timeoutMs = 90_000,
): Promise<RepoScmOperationRecord | null> {
  const store = getScmOperationStore(env, repoId);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const current = await store.getOperation(operationId);
    if (current && current.status !== "pending") {
      return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return await store.getOperation(operationId);
}

export function buildScmOperationResponse(record: RepoScmOperationRecord): Record<string, unknown> {
  if (record.status === "failed") {
    throw new Error(record.error || "SCM operation failed");
  }

  return {
    ok: true,
    operationId: record.operationId,
    pending: record.status === "pending",
    ...(record.result ?? {}),
  };
}

export async function ensureNoPendingRepoScmOperationForEnv(
  env: Env,
  repoId: string,
  slug: string,
): Promise<RepoScmOperationRecord | null> {
  const store = getScmOperationStore(env, repoId);
  return await store.findPendingOperationForEnv(slug);
}
