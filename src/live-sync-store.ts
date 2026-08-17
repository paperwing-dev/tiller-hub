import type { EnvMeta, RepoMeta, StoredSession } from "../api/types";
import { upsertEnvMeta, upsertRepoMeta } from "./env-state";
import { isEnvRunningStatus, shouldShowEnvWaitingViewForStatus } from "./env-runtime";
import { getManagedEnvSlug, pickPrimaryEnvSession } from "./session-attachment";

export type DashboardSelection =
  | { type: "none" }
  | { type: "session"; sessionId: string }
  | { type: "env"; envSlug: string }
  | { type: "changes"; envSlug: string }
  | { type: "plan"; repoId: string; planArtifactId?: string | null }
  | { type: "repo-settings"; repoId: string }
  | { type: "update" }
  | { type: "settings" };

export interface NewEnvTarget {
  repoId: string;
  planChoice?: "none" | "specific";
}

export interface RecoverEntitiesOptions {
  slug?: string;
  repoId?: string;
}

export function mergeFetchedEnvs(
  currentEnvs: EnvMeta[],
  fetchedEnvs: EnvMeta[],
): { items: EnvMeta[]; missingSlugs: string[] } {
  const fetchedSlugs = new Set(fetchedEnvs.map((env) => env.slug));
  let items = currentEnvs;
  for (const env of fetchedEnvs) {
    items = upsertEnvMeta(items, env).items;
  }

  return {
    items,
    missingSlugs: currentEnvs
      .map((env) => env.slug)
      .filter((slug) => !fetchedSlugs.has(slug)),
  };
}

export function reconcileFetchedEnvSnapshot(
  getCurrentEnvs: () => EnvMeta[],
  fetchedEnvs: EnvMeta[],
): {
  items: EnvMeta[];
  missingSlugs: string[];
  previousEnvSlugs: Set<string>;
} {
  const currentEnvs = getCurrentEnvs();
  return {
    ...mergeFetchedEnvs(currentEnvs, fetchedEnvs),
    previousEnvSlugs: new Set(currentEnvs.map((env) => env.slug)),
  };
}

export function mergeFetchedRepos(
  currentRepos: RepoMeta[],
  fetchedRepos: RepoMeta[],
): { items: RepoMeta[]; missingRepoIds: string[] } {
  const fetchedRepoIds = new Set(fetchedRepos.map((repo) => repo.repoId));
  let items = currentRepos;
  for (const repo of fetchedRepos) {
    items = upsertRepoMeta(items, repo).items;
  }

  return {
    items,
    missingRepoIds: currentRepos
      .map((repo) => repo.repoId)
      .filter((repoId) => !fetchedRepoIds.has(repoId)),
  };
}

export function reconcileFetchedRepoSnapshot(
  getCurrentRepos: () => RepoMeta[],
  fetchedRepos: RepoMeta[],
): {
  items: RepoMeta[];
  missingRepoIds: string[];
} {
  return mergeFetchedRepos(getCurrentRepos(), fetchedRepos);
}

export function reconcileSelectionAfterEnvRemove(
  current: DashboardSelection,
  sessions: StoredSession[],
  slug: string,
): DashboardSelection {
  if (current.type === "env" && current.envSlug === slug) {
    return { type: "none" };
  }
  if (current.type === "changes" && current.envSlug === slug) {
    return { type: "none" };
  }
  if (current.type === "session") {
    const session = sessions.find((candidate) => candidate.id === current.sessionId);
    if (session && getManagedEnvSlug(session) === slug) {
      return { type: "none" };
    }
  }
  return current;
}

export function reconcileSelectionAfterStoppedEnv(
  current: DashboardSelection,
  sessions: StoredSession[],
  env: Pick<EnvMeta, "slug" | "status">,
): DashboardSelection {
  const shouldShowEnvView = shouldShowEnvWaitingViewForStatus(env.status);

  if (!shouldShowEnvView || current.type !== "session") {
    return current;
  }

  const session = sessions.find((candidate) => candidate.id === current.sessionId);
  if (session && getManagedEnvSlug(session) === env.slug) {
    return { type: "env", envSlug: env.slug };
  }
  return current;
}

export function reconcileSelectionAfterRunningEnv(
  current: DashboardSelection,
  sessions: StoredSession[],
  envs: EnvMeta[],
): DashboardSelection {
  if (current.type !== "env" && current.type !== "changes") {
    return current;
  }
  const env = envs.find((candidate) => candidate.slug === current.envSlug);
  if (!env || !isEnvRunningStatus(env.status)) {
    return current;
  }
  const session = pickPrimaryEnvSession(sessions, current.envSlug);
  if (!session) {
    return current;
  }
  return { type: "session", sessionId: session.id };
}

export function reconcileSelectionAfterEnvRefresh(
  current: DashboardSelection,
  sessions: StoredSession[],
  previousEnvSlugs: Set<string>,
  nextEnvs: EnvMeta[],
): DashboardSelection {
  const nextSlugs = new Set(nextEnvs.map((env) => env.slug));

  if (current.type === "env" && !nextSlugs.has(current.envSlug)) {
    return { type: "none" };
  }
  if (current.type === "changes" && !nextSlugs.has(current.envSlug)) {
    return { type: "none" };
  }

  if (current.type !== "session") {
    return current;
  }

  const session = sessions.find((candidate) => candidate.id === current.sessionId);
  const selectedEnvSlug = session ? getManagedEnvSlug(session) : null;
  if (!selectedEnvSlug) {
    return { type: "none" };
  }
  const selectedEnv = nextEnvs.find((candidate) => candidate.slug === selectedEnvSlug) ?? null;
  if (
    selectedEnv &&
    shouldShowEnvWaitingViewForStatus(selectedEnv.status)
  ) {
    return { type: "env", envSlug: selectedEnv.slug };
  }
  if (previousEnvSlugs.has(selectedEnvSlug) && !nextSlugs.has(selectedEnvSlug)) {
    return { type: "none" };
  }
  return current;
}

export function reconcileSelectionAfterRepoRemove(
  current: DashboardSelection,
  repoId: string,
): DashboardSelection {
  if (current.type === "plan" && current.repoId === repoId) {
    return { type: "none" };
  }
  if (current.type === "repo-settings" && current.repoId === repoId) {
    return { type: "none" };
  }
  return current;
}

export function reconcileSelectionAfterRepoRefresh(
  current: DashboardSelection,
  nextRepoIds: Set<string>,
): DashboardSelection {
  if (current.type === "plan" && !nextRepoIds.has(current.repoId)) {
    return { type: "none" };
  }
  if (current.type === "repo-settings" && !nextRepoIds.has(current.repoId)) {
    return { type: "none" };
  }
  return current;
}
