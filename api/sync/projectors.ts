import {
  hasExplicitEnvScmFields,
  hasExplicitRepoScmFields,
  isEnvStatus,
  isRepoGitStatus,
  type EnvMeta,
  type RepoMeta,
} from "../types";

export function assertExplicitEnvSummaryFields(meta: Pick<EnvMeta, "slug" | "status" | "updatedAt">): void {
  if (!isEnvStatus(meta.status) || typeof meta.updatedAt !== "string") {
    throw new Error(`Env summary is missing explicit core fields for ${meta.slug}`);
  }
}

export function assertExplicitRepoSummaryFields(meta: Pick<RepoMeta, "repoId" | "gitStatus" | "updatedAt">): void {
  if (!isRepoGitStatus(meta.gitStatus) || typeof meta.updatedAt !== "string") {
    throw new Error(`Repo summary is missing explicit core fields for ${meta.repoId}`);
  }
}

export function assertExplicitEnvScmFields(meta: EnvMeta): void {
  if (!hasExplicitEnvScmFields(meta)) {
    throw new Error(`Env summary is missing explicit environment schema fields for ${meta.slug}`);
  }
}

export function assertExplicitRepoScmFields(meta: RepoMeta): void {
  if (!hasExplicitRepoScmFields(meta)) {
    throw new Error(`Repo summary is missing explicit repository schema fields for ${meta.repoId}`);
  }
}

export function requireExplicitStoredEnvMeta(meta: EnvMeta): EnvMeta {
  assertExplicitEnvSummaryFields(meta);
  assertExplicitEnvScmFields(meta);
  return meta;
}

export function projectEnvSummary(meta: EnvMeta): EnvMeta {
  return requireExplicitStoredEnvMeta(meta);
}

export function projectRepoSummary(meta: RepoMeta): RepoMeta {
  assertExplicitRepoSummaryFields(meta);
  assertExplicitRepoScmFields(meta);
  return meta;
}
