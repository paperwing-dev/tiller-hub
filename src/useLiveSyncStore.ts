import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { EnvMeta, RepoMeta } from "../api/types";
import { fetchEnv, fetchEnvs, fetchRepo, fetchRepos } from "./api";
import {
  requireExplicitEnvMeta,
  requireExplicitRepoMeta,
  removeEnvMeta,
  removeRepoMeta,
  upsertEnvMeta,
  upsertRepoMeta,
} from "./env-state";
import {
  type NewEnvTarget,
  type RecoverEntitiesOptions,
  reconcileFetchedEnvSnapshot,
  reconcileFetchedRepoSnapshot,
} from "./live-sync-store";
import { isEnvTransitioning, isRepoTransitioning } from "../api/scm/model";

const WATCHDOG_DELAYS_MS = [10_000, 30_000, 60_000, 120_000];

type WatchdogEntry = {
  timer: ReturnType<typeof setTimeout>;
  attempt: number;
  updatedAt: string;
};

interface UseLiveSyncStoreOptions {
  hubUrl: string;
  setStartDialogSlug: Dispatch<SetStateAction<string | null>>;
  setNewEnvTarget: Dispatch<SetStateAction<NewEnvTarget | null>>;
}

export function useLiveSyncStore({
  hubUrl,
  setStartDialogSlug,
  setNewEnvTarget,
}: UseLiveSyncStoreOptions) {
  const [envs, setEnvs] = useState<EnvMeta[]>([]);
  const [repos, setRepos] = useState<RepoMeta[]>([]);
  const envsRef = useRef<EnvMeta[]>([]);
  const reposRef = useRef<RepoMeta[]>([]);
  const envWatchdogsRef = useRef<Map<string, WatchdogEntry>>(new Map());
  const repoWatchdogsRef = useRef<Map<string, WatchdogEntry>>(new Map());

  const updateEnvStore = useCallback((next: EnvMeta[]) => {
    envsRef.current = next;
    setEnvs(next);
  }, []);

  const updateRepoStore = useCallback((next: RepoMeta[]) => {
    reposRef.current = next;
    setRepos(next);
  }, []);

  const clearEnvWatchdog = useCallback((slug: string) => {
    const existing = envWatchdogsRef.current.get(slug);
    if (!existing) return;
    clearTimeout(existing.timer);
    envWatchdogsRef.current.delete(slug);
  }, []);

  const clearRepoWatchdog = useCallback((repoId: string) => {
    const existing = repoWatchdogsRef.current.get(repoId);
    if (!existing) return;
    clearTimeout(existing.timer);
    repoWatchdogsRef.current.delete(repoId);
  }, []);

  const removeEnv = useCallback((slug: string) => {
    clearEnvWatchdog(slug);
    setStartDialogSlug((current) => (current === slug ? null : current));
    const { items, changed } = removeEnvMeta(envsRef.current, slug);
    if (changed) {
      updateEnvStore(items);
    }
  }, [clearEnvWatchdog, setStartDialogSlug, updateEnvStore]);

  const removeRepo = useCallback((repoId: string) => {
    clearRepoWatchdog(repoId);
    setNewEnvTarget((current) => (current?.repoId === repoId ? null : current));
    const { items, changed } = removeRepoMeta(reposRef.current, repoId);
    if (changed) {
      updateRepoStore(items);
    }
  }, [clearRepoWatchdog, setNewEnvTarget, updateRepoStore]);

  const upsertEnv = useCallback((incoming: EnvMeta) => {
    const env = requireExplicitEnvMeta(incoming);
    const { items, changed } = upsertEnvMeta(envsRef.current, env);
    if (changed) {
      updateEnvStore(items);
    }
    if (!isEnvTransitioning(env)) {
      clearEnvWatchdog(env.slug);
    }
    return env;
  }, [clearEnvWatchdog, updateEnvStore]);

  const upsertRepo = useCallback((incoming: RepoMeta) => {
    const repo = requireExplicitRepoMeta(incoming);
    const { items, changed } = upsertRepoMeta(reposRef.current, repo);
    if (changed) {
      updateRepoStore(items);
    }
    if (!isRepoTransitioning(repo)) {
      clearRepoWatchdog(repo.repoId);
    }
    return repo;
  }, [clearRepoWatchdog, updateRepoStore]);

  const refreshEnvEntity = useCallback(async (slug: string): Promise<EnvMeta | null> => {
    try {
      return upsertEnv(await fetchEnv(hubUrl, slug));
    } catch (err) {
      if ((err as Error).message.includes("404")) {
        removeEnv(slug);
        return null;
      }
      console.error("[tiller] Failed to fetch env:", err);
      return envsRef.current.find((env) => env.slug === slug) ?? null;
    }
  }, [hubUrl, removeEnv, upsertEnv]);

  const refreshRepoEntity = useCallback(async (repoId: string): Promise<RepoMeta | null> => {
    try {
      return upsertRepo(await fetchRepo(hubUrl, repoId));
    } catch (err) {
      if ((err as Error).message.includes("404")) {
        removeRepo(repoId);
        return null;
      }
      console.error("[tiller] Failed to fetch repo:", err);
      return reposRef.current.find((repo) => repo.repoId === repoId) ?? null;
    }
  }, [hubUrl, removeRepo, upsertRepo]);

  const refreshEnvs = useCallback(async (): Promise<boolean> => {
    try {
      const fetched = await fetchEnvs(hubUrl);
      const list = fetched.map((env) => requireExplicitEnvMeta(env));
      const { items, missingSlugs } = reconcileFetchedEnvSnapshot(
        () => envsRef.current,
        list,
      );
      updateEnvStore(items);

      if (missingSlugs.length > 0) {
        await Promise.all(missingSlugs.map((slug) => refreshEnvEntity(slug)));
      }

      const nextEnvs = envsRef.current;
      const nextSlugs = new Set(nextEnvs.map((env) => env.slug));
      setStartDialogSlug((current) => (current && !nextSlugs.has(current) ? null : current));
      return true;
    } catch (err) {
      console.error("[tiller] Failed to fetch envs:", err);
      return false;
    }
  }, [hubUrl, refreshEnvEntity, setStartDialogSlug, updateEnvStore]);

  const refreshRepos = useCallback(async (): Promise<boolean> => {
    try {
      const fetched = await fetchRepos(hubUrl);
      const list = fetched.map((repo) => requireExplicitRepoMeta(repo));
      const { items, missingRepoIds } = reconcileFetchedRepoSnapshot(
        () => reposRef.current,
        list,
      );
      updateRepoStore(items);

      if (missingRepoIds.length > 0) {
        await Promise.all(missingRepoIds.map((repoId) => refreshRepoEntity(repoId)));
      }

      const nextRepoIds = new Set(reposRef.current.map((repo) => repo.repoId));
      setNewEnvTarget((current) => (current && !nextRepoIds.has(current.repoId) ? null : current));
      return true;
    } catch (err) {
      console.error("[tiller] Failed to fetch repos:", err);
      return false;
    }
  }, [hubUrl, refreshRepoEntity, setNewEnvTarget, updateRepoStore]);

  const scheduleEnvWatchdog = useCallback((slug: string, attempt: number, updatedAt: string) => {
    clearEnvWatchdog(slug);
    const delay = WATCHDOG_DELAYS_MS[Math.min(attempt, WATCHDOG_DELAYS_MS.length - 1)];
    const timer = window.setTimeout(async () => {
      envWatchdogsRef.current.delete(slug);
      const env = await refreshEnvEntity(slug);
      if (env && isEnvTransitioning(env)) {
        scheduleEnvWatchdog(slug, attempt + 1, env.updatedAt);
      }
    }, delay);
    envWatchdogsRef.current.set(slug, { timer, attempt, updatedAt });
  }, [clearEnvWatchdog, refreshEnvEntity]);

  const scheduleRepoWatchdog = useCallback((repoId: string, attempt: number, updatedAt: string) => {
    clearRepoWatchdog(repoId);
    const delay = WATCHDOG_DELAYS_MS[Math.min(attempt, WATCHDOG_DELAYS_MS.length - 1)];
    const timer = window.setTimeout(async () => {
      repoWatchdogsRef.current.delete(repoId);
      const repo = await refreshRepoEntity(repoId);
      if (repo && isRepoTransitioning(repo)) {
        scheduleRepoWatchdog(repoId, attempt + 1, repo.updatedAt);
      }
    }, delay);
    repoWatchdogsRef.current.set(repoId, { timer, attempt, updatedAt });
  }, [clearRepoWatchdog, refreshRepoEntity]);

  useEffect(() => {
    return () => {
      for (const { timer } of envWatchdogsRef.current.values()) {
        clearTimeout(timer);
      }
      for (const { timer } of repoWatchdogsRef.current.values()) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    const nextSlugs = new Set(envs.map((env) => env.slug));
    for (const slug of envWatchdogsRef.current.keys()) {
      if (!nextSlugs.has(slug)) {
        clearEnvWatchdog(slug);
      }
    }
    for (const env of envs) {
      if (!isEnvTransitioning(env)) {
        clearEnvWatchdog(env.slug);
        continue;
      }
      const updatedAt = env.updatedAt;
      const existing = envWatchdogsRef.current.get(env.slug);
      if (existing?.updatedAt === updatedAt) {
        continue;
      }
      scheduleEnvWatchdog(env.slug, 0, updatedAt);
    }
  }, [clearEnvWatchdog, envs, scheduleEnvWatchdog]);

  useEffect(() => {
    const nextRepoIds = new Set(repos.map((repo) => repo.repoId));
    for (const repoId of repoWatchdogsRef.current.keys()) {
      if (!nextRepoIds.has(repoId)) {
        clearRepoWatchdog(repoId);
      }
    }
    for (const repo of repos) {
      if (!isRepoTransitioning(repo)) {
        clearRepoWatchdog(repo.repoId);
        continue;
      }
      const existing = repoWatchdogsRef.current.get(repo.repoId);
      if (existing?.updatedAt === repo.updatedAt) {
        continue;
      }
      scheduleRepoWatchdog(repo.repoId, 0, repo.updatedAt);
    }
  }, [clearRepoWatchdog, repos, scheduleRepoWatchdog]);

  const recoverEnv = useCallback((slug: string, status?: string) => {
    if (status) {
      const nextStatus = status as EnvMeta["status"];
      const current = envsRef.current;
      const idx = current.findIndex((e) => e.slug === slug);
      if (idx !== -1 && current[idx].status !== nextStatus) {
        const next = [...current];
        next[idx] = { ...current[idx], status: nextStatus };
        updateEnvStore(next);
      }
    } else {
      void refreshEnvEntity(slug);
    }
  }, [refreshEnvEntity, updateEnvStore]);

  const recoverEntities = useCallback((options?: RecoverEntitiesOptions) => {
    if (options?.slug) {
      void refreshEnvEntity(options.slug);
    }
    if (options?.repoId) {
      void refreshRepoEntity(options.repoId);
    }
  }, [refreshEnvEntity, refreshRepoEntity]);

  const handleRepoDeleted = useCallback((repoId: string, deletedEnvSlugs: string[]) => {
    for (const slug of deletedEnvSlugs) {
      removeEnv(slug);
    }
    removeRepo(repoId);
  }, [removeEnv, removeRepo]);

  return {
    envs,
    repos,
    refreshEnvs,
    refreshRepos,
    refreshEnvEntity,
    refreshRepoEntity,
    recoverEnv,
    recoverEntities,
    handleRepoDeleted,
    removeEnv,
    removeRepo,
    upsertEnv,
    upsertRepo,
  };
}
