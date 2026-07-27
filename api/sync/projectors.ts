import {
  hasExplicitEnvScmFields,
  hasExplicitRepoGitHubPublishFields,
  hasExplicitRepoScmFields,
  isEnvStatus,
  isRepoGitStatus,
  type EnvMeta,
  type RepoMeta,
} from "../types";
import { githubRepoUrlFromFullName } from "../github/repo";
import { isExecutionPlacement } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function assertExplicitEnvSummaryFields(meta: unknown): void {
  const record = isRecord(meta) ? meta : {};
  if (!isEnvStatus(typeof record.status === "string" ? record.status : null) || typeof record.updatedAt !== "string") {
    const slug = typeof record.slug === "string" ? record.slug : "unknown";
    throw new Error(`Env summary is missing explicit core fields for ${slug}`);
  }
}

export function assertExplicitRepoSummaryFields(meta: unknown): void {
  const record = isRecord(meta) ? meta : {};
  if (
    !isRepoGitStatus(typeof record.gitStatus === "string" ? record.gitStatus : null) ||
    typeof record.updatedAt !== "string" ||
    typeof record.githubInstallationId !== "number" ||
    !Number.isInteger(record.githubInstallationId) ||
    record.githubInstallationId <= 0 ||
    typeof record.githubFullName !== "string" ||
    typeof record.repoUrl !== "string" ||
    record.repoUrl !== githubRepoUrlFromFullName(record.githubFullName)
  ) {
    const repoId = typeof record.repoId === "string" ? record.repoId : "unknown";
    throw new Error(`Repo summary is missing explicit core fields for ${repoId}`);
  }
}

export function assertExplicitEnvScmFields(meta: unknown): void {
  if (!hasExplicitEnvScmFields(meta)) {
    const record = isRecord(meta) ? meta : {};
    const slug = typeof record.slug === "string" ? record.slug : "unknown";
    throw new Error(`Env summary is missing explicit environment schema fields for ${slug}`);
  }
}

export function assertExplicitRepoScmFields(meta: unknown): void {
  if (!hasExplicitRepoScmFields(meta)) {
    const record = isRecord(meta) ? meta : {};
    const repoId = typeof record.repoId === "string" ? record.repoId : "unknown";
    throw new Error(`Repo summary is missing explicit repository schema fields for ${repoId}`);
  }
}

export function assertExplicitRepoGitHubPublishFields(meta: unknown): void {
  if (!hasExplicitRepoGitHubPublishFields(meta)) {
    const record = isRecord(meta) ? meta : {};
    const repoId = typeof record.repoId === "string" ? record.repoId : "unknown";
    throw new Error(`Repo summary has invalid GitHub publish metadata for ${repoId}`);
  }
}

export function requireExplicitStoredEnvMeta(meta: EnvMeta): EnvMeta {
  assertExplicitEnvSummaryFields(meta);
  assertExplicitEnvScmFields(meta);
  if (
    !meta.incarnationId?.trim()
    || !isExecutionPlacement(meta.executionPlacement)
    || meta.backend !== meta.executionPlacement.backend
  ) {
    throw new Error(`Env summary is missing immutable workload identity or placement for ${meta.slug}`);
  }
  return meta;
}

export function projectEnvSummary(meta: EnvMeta): EnvMeta {
  return requireExplicitStoredEnvMeta(meta);
}

export function projectRepoSummary(meta: RepoMeta): RepoMeta {
  assertExplicitRepoSummaryFields(meta);
  assertExplicitRepoScmFields(meta);
  assertExplicitRepoGitHubPublishFields(meta);
  return meta;
}
