import {
  hasExplicitEnvScmFields,
  hasExplicitRepoGitHubPublishFields,
  hasExplicitRepoScmFields,
  isEnvStatus,
  isRepoGitStatus,
  type EnvMeta,
  type RepoMeta,
} from "../api/types";
import {
  deriveGitHubEnvBranchStatus,
  getEffectiveEnvBranchStatus,
} from "../api/scm/model";

function assertExplicitEnvSummary(env: Pick<EnvMeta, "slug" | "status" | "updatedAt">): void {
  if (!isEnvStatus(env.status) || typeof env.updatedAt !== "string") {
    throw new Error(`Env summary is missing explicit core fields for ${env.slug}`);
  }
}

function assertExplicitRepoSummary(repo: Pick<RepoMeta, "repoId" | "gitStatus" | "updatedAt" | "githubInstallationId" | "githubFullName">): void {
  if (
    !isRepoGitStatus(repo.gitStatus) ||
    typeof repo.updatedAt !== "string" ||
    !Number.isInteger(repo.githubInstallationId) ||
    repo.githubInstallationId <= 0 ||
    typeof repo.githubFullName !== "string" ||
    !repo.githubFullName
  ) {
    throw new Error(`Repo summary is missing explicit core fields for ${repo.repoId}`);
  }
}

function assertExplicitEnvScm(env: EnvMeta): void {
  if (!hasExplicitEnvScmFields(env)) {
    throw new Error(`Env summary is missing explicit environment schema fields for ${env.slug}`);
  }
}

function assertExplicitRepoScm(repo: RepoMeta): void {
  if (!hasExplicitRepoScmFields(repo)) {
    throw new Error(`Repo summary is missing explicit repository schema fields for ${repo.repoId}`);
  }
}

function assertExplicitRepoGitHubPublish(repo: RepoMeta): void {
  if (!hasExplicitRepoGitHubPublishFields(repo)) {
    throw new Error(`Repo summary has invalid GitHub publish metadata for ${repo.repoId}`);
  }
}

function parseTimestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid summary timestamp: ${value}`);
  }
  return parsed;
}

function shouldAcceptIncoming(currentUpdatedAt: string, incomingUpdatedAt: string): boolean {
  const current = parseTimestamp(currentUpdatedAt);
  const incoming = parseTimestamp(incomingUpdatedAt);
  return incoming >= current;
}

function isEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function requireExplicitEnvMeta<T extends EnvMeta>(env: T): T {
  assertExplicitEnvSummary(env);
  assertExplicitEnvScm(env);
  return env;
}

export function requireExplicitRepoMeta<T extends RepoMeta>(repo: T): T {
  assertExplicitRepoSummary(repo);
  assertExplicitRepoScm(repo);
  assertExplicitRepoGitHubPublish(repo);
  return repo;
}

export function upsertEnvMeta(
  envs: EnvMeta[],
  incoming: EnvMeta,
): { items: EnvMeta[]; changed: boolean } {
  const nextEnv = requireExplicitEnvMeta(incoming);
  const index = envs.findIndex((env) => env.slug === nextEnv.slug);
  if (index === -1) {
    return {
      items: [...envs, nextEnv],
      changed: true,
    };
  }

  const current = envs[index];
  if (!shouldAcceptIncoming(current.updatedAt, nextEnv.updatedAt)) {
    return { items: envs, changed: false };
  }
  if (isEqual(current, nextEnv)) {
    return { items: envs, changed: false };
  }

  const items = [...envs];
  items[index] = nextEnv;
  return { items, changed: true };
}

export function removeEnvMeta(
  envs: EnvMeta[],
  slug: string,
): { items: EnvMeta[]; changed: boolean } {
  const items = envs.filter((env) => env.slug !== slug);
  return {
    items,
    changed: items.length !== envs.length,
  };
}

export function upsertRepoMeta(
  repos: RepoMeta[],
  incoming: RepoMeta,
): { items: RepoMeta[]; changed: boolean } {
  const nextRepo = requireExplicitRepoMeta(incoming);
  const index = repos.findIndex((repo) => repo.repoId === nextRepo.repoId);
  if (index === -1) {
    return {
      items: [...repos, nextRepo],
      changed: true,
    };
  }

  const current = repos[index];
  if (!shouldAcceptIncoming(current.updatedAt, nextRepo.updatedAt)) {
    return { items: repos, changed: false };
  }
  if (isEqual(current, nextRepo)) {
    return { items: repos, changed: false };
  }

  const items = [...repos];
  items[index] = nextRepo;
  return { items, changed: true };
}

export function removeRepoMeta(
  repos: RepoMeta[],
  repoId: string,
): { items: RepoMeta[]; changed: boolean } {
  const items = repos.filter((repo) => repo.repoId !== repoId);
  return {
    items,
    changed: items.length !== repos.length,
  };
}

export function getDisplayEnvBranchStatus(
  env: EnvMeta,
  repo: RepoMeta | null | undefined,
): NonNullable<EnvMeta["branchStatus"]> {
  const explicitEnv = requireExplicitEnvMeta(env);
  const explicitRepo = repo ? requireExplicitRepoMeta(repo) : null;
  if (explicitEnv.scmModel === "github") {
    return deriveGitHubEnvBranchStatus(explicitEnv, explicitRepo);
  }
  return getEffectiveEnvBranchStatus(explicitEnv, explicitRepo);
}
