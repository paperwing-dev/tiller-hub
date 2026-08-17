import {
  createContext,
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import {
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router';
import type { EnvMeta, RepoMeta, StoredSession, StoredPermission, WsServerMessage } from '../api/types';
import {
  fetchSessions,
  fetchPendingPermissions,
  createReconnectingWebSocket,
  fetchSetupStatus,
  createEnv,
  createRepo,
  checkForUpdate,
  dismissDashboardOnboarding as dismissDashboardOnboardingRequest,
  ApiActionError,
  acknowledgeImplementorAttention,
  isApiAuthenticationError,
  type CreateEnvOptions,
} from './api';
import type {
  LiveMessage,
  ReconnectingWebSocket,
  SetupStatus,
  UpdateCheckResult,
  GitHubRepositorySelection,
} from './api';
import { useToast } from './Toast';
import { ignoreUpdateUntilNext, isUpdateDismissed } from './update-storage';
import { isRepoMainReady } from './repo-status';
import { getBackendBadgeLabel, getEnvDisplayName } from './env-display';
import { getHarnessBadgeLabel } from './env-harness';
import type { NewEnvTarget, RecoverEntitiesOptions } from './live-sync-store';
import { useLiveSyncStore } from './useLiveSyncStore';
import {
  getDashboardRouteScope,
  getSessionEnvSlugFromSession,
  routeTouchesDeletedEnv,
  routeTouchesDeletedRepo,
} from './dashboard-route-scope';
import { RouteLoading, SetupStatusLoadError } from './dashboard-route-state';
import { useSerializedRefresh } from './useSerializedRefresh';
import {
  envPath,
  projectImplementationsPath,
  projectPath,
} from './dashboard-paths';
import {
  acknowledgeImplementorAttentionAndRecover,
  resolveVisibleImplementorAttentionTarget,
} from './implementor-attention';

const HUB_URL = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
const AUTH_RELOAD_STORAGE_KEY = 'tiller-auth-reload';
const AUTH_RELOAD_COOLDOWN_MS = 10_000;

const NewRepoDialog = lazy(() => import('./NewEnvDialog').then((module) => ({
  default: module.NewRepoDialog,
})));
const NewEnvDialog = lazy(() => import('./NewEnvDialog').then((module) => ({
  default: module.NewEnvDialog,
})));
const SetupWizard = lazy(() => import('./SetupWizard'));
const UpdateDialog = lazy(() => import('./UpdateDialog'));

interface BrowserAuthenticationTarget {
  location: Pick<Location, 'reload'>;
  sessionStorage: Pick<Storage, 'getItem' | 'setItem'>;
}

export function recoverBrowserAuthentication(
  error: unknown,
  target: BrowserAuthenticationTarget = window,
  now = Date.now(),
): boolean {
  if (!isApiAuthenticationError(error)) return false;

  let shouldReload = true;
  try {
    const lastReload = Number(target.sessionStorage.getItem(AUTH_RELOAD_STORAGE_KEY) ?? '');
    const reloadIsRecent = Number.isFinite(lastReload)
      && now >= lastReload
      && now - lastReload < AUTH_RELOAD_COOLDOWN_MS;
    shouldReload = !reloadIsRecent;
    if (shouldReload) {
      target.sessionStorage.setItem(AUTH_RELOAD_STORAGE_KEY, String(now));
    }
  } catch {
    // A browser may deny sessionStorage while still allowing a top-level auth navigation.
  }

  if (shouldReload) target.location.reload();
  return true;
}

export type LoadState = 'idle' | 'loading' | 'loaded' | 'error';

export function settleDashboardReadState(current: LoadState, succeeded: boolean): LoadState {
  if (succeeded) return 'loaded';
  return current === 'loaded' ? current : 'error';
}

export type TerminalAckMessage =
  | Extract<WsServerMessage, { type: 'terminal-input-ack' }>
  | Extract<WsServerMessage, { type: 'terminal-control-ack' }>;

export interface DashboardData {
  hubUrl: string;
  sessions: StoredSession[];
  repos: RepoMeta[];
  envs: EnvMeta[];
  sessionsLoadState: LoadState;
  reposLoadState: LoadState;
  envsLoadState: LoadState;
  refreshSessions: () => Promise<boolean>;
  refreshRepos: () => Promise<boolean>;
  refreshEnvs: () => Promise<boolean>;
  refreshSetupStatus: () => Promise<void>;
  dismissDashboardOnboarding: () => Promise<void>;
  setupStatus: SetupStatus | null;
  updateStatus: UpdateCheckResult | null;
  updateIssue: string | null;
  updateIssueCode: string | null;
  updateDismissed: boolean;
  isCheckingUpdate: boolean;
  refreshUpdateStatus: (options?: { forceRefresh?: boolean }) => Promise<{
    status: UpdateCheckResult | null;
    issue: string | null;
    issueCode: string | null;
    dismissed: boolean;
  }>;
  connected: boolean;
  terminalFastLane: boolean;
  terminalMetrics: boolean;
  reconnectExhausted: boolean;
  hostRefreshNonce: number;
  permissions: Map<string, StoredPermission[]>;
  liveMessageRef: MutableRefObject<((msg: LiveMessage) => void) | null>;
  terminalAckRef: MutableRefObject<((msg: TerminalAckMessage) => void) | null>;
  planWriterRefreshHintRef: MutableRefObject<((repoId: string, planArtifactId: string) => void) | null>;
  planArtifactHintRef: MutableRefObject<((repoId: string, planArtifactId: string) => void) | null>;
  wsRef: MutableRefObject<ReconnectingWebSocket | null>;
  updateLastSeq: (sessionId: string, seq: number) => void;
  handlePermissionResolved: (permId: string) => void;
  handleReconnect: () => void;
  recoverEnv: (slug: string, status?: string) => void;
  recoverEntities: (options?: RecoverEntitiesOptions) => void;
  setShowNewRepo: (show: boolean) => void;
  setShowUpdate: (show: boolean) => void;
  setNewEnvTarget: Dispatch<SetStateAction<NewEnvTarget | null>>;
  setStartDialogSlug: Dispatch<SetStateAction<string | null>>;
  handleCreateRepo: (selection: GitHubRepositorySelection) => Promise<void>;
  handleCreateEnv: (options: CreateEnvOptions) => Promise<void>;
  handleDashboardRepoDeleted: (repoId: string, deletedEnvSlugs: string[]) => void;
  handleRetryRepoMain: (repoId: string) => Promise<void>;
  getKnownEnvRepoId: (slug: string) => string | null;
  sessionEnvMap: Map<string, string>;
  lastRepoMainEvent: {
    repoId: string;
    repoUrl: string;
    previousMainCommit: string | null;
    currentMainCommit: string | null;
    sourceEnvSlug?: string | null;
  } | null;
}

const DashboardDataContext = createContext<DashboardData | null>(null);

export function useDashboardData(): DashboardData {
  const value = useContext(DashboardDataContext);
  if (!value) {
    throw new Error('useDashboardData must be used inside DashboardDataProvider');
  }
  return value;
}

export function refreshDashboardStateAfterHubConnect(actions: {
  refreshSessions: () => void;
  refreshEnvs: () => void;
  refreshRepos: () => void;
  refreshSetupStatus: () => void;
}): void {
  actions.refreshSessions();
  actions.refreshEnvs();
  actions.refreshRepos();
  actions.refreshSetupStatus();
}

export function getTopLevelUpdateIssue(result: UpdateCheckResult): string | null {
  return result.errors[0]?.message ?? null;
}

export function getUpdateDismissalSourceId(result: UpdateCheckResult): string {
  return result.stableRelease?.releaseId
    ?? result.currentRelease.releaseId
    ?? result.currentRelease.hubVersion;
}

export function getUpdateCheckFailure(error: unknown): { message: string; code: string | null } {
  if (error instanceof ApiActionError) {
    return {
      message: error.message,
      code: error.code ?? null,
    };
  }
  return {
    message: error instanceof Error ? error.message : 'Self-update check failed.',
    code: null,
  };
}

export default function DashboardDataProvider() {
  const navigate = useNavigate();
  const location = useLocation();
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [connected, setConnected] = useState(false);
  const [terminalFastLane, setTerminalFastLane] = useState(false);
  const [terminalMetrics, setTerminalMetrics] = useState(false);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const [permissions, setPermissions] = useState<Map<string, StoredPermission[]>>(new Map());
  const [showNewRepo, setShowNewRepo] = useState(false);
  const [showUpdate, setShowUpdate] = useState(false);
  const [newEnvTarget, setNewEnvTarget] = useState<NewEnvTarget | null>(null);
  const [startDialogSlug, setStartDialogSlug] = useState<string | null>(null);
  const [lastRepoMainEvent, setLastRepoMainEvent] = useState<{
    repoId: string;
    repoUrl: string;
    previousMainCommit: string | null;
    currentMainCommit: string | null;
    sourceEnvSlug?: string | null;
  } | null>(null);
  const liveMessageRef = useRef<((msg: LiveMessage) => void) | null>(null);
  const terminalAckRef = useRef<((msg: TerminalAckMessage) => void) | null>(null);
  const planWriterRefreshHintRef = useRef<((repoId: string, planArtifactId: string) => void) | null>(null);
  const planArtifactHintRef = useRef<((repoId: string, planArtifactId: string) => void) | null>(null);
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const activeSessionIdRef = useRef<string | null>(null);
  const titleFlashRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionEnvMapRef = useRef<Map<string, string>>(new Map());
  const envRepoIdMapRef = useRef<Map<string, string>>(new Map());
  const locationPathnameRef = useRef(location.pathname);
  const [sessionEnvMap, setSessionEnvMap] = useState<Map<string, string>>(() => new Map());
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupLoadError, setSetupLoadError] = useState<string | null>(null);
  const [setupChecked, setSetupChecked] = useState(false);
  const [sessionsLoadState, setSessionsLoadState] = useState<LoadState>('idle');
  const [envsLoadState, setEnvsLoadState] = useState<LoadState>('idle');
  const [reposLoadState, setReposLoadState] = useState<LoadState>('idle');
  const [dashboardBootstrapped, setDashboardBootstrapped] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckResult | null>(null);
  const [updateIssue, setUpdateIssue] = useState<string | null>(null);
  const [updateIssueCode, setUpdateIssueCode] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(true);
  const [hostRefreshNonce, setHostRefreshNonce] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document !== 'undefined' && !document.hidden,
  );
  const addToast = useToast();
  const setupReady = setupChecked && !!setupStatus && !setupStatus.needsSetup;

  const {
    envs,
    repos,
    refreshEnvs: refreshEnvsStore,
    refreshRepos: refreshReposStore,
    refreshRepoEntity,
    recoverEnv,
    recoverEntities,
    handleRepoDeleted: handleStoreRepoDeleted,
    removeEnv,
    removeRepo,
    upsertEnv,
    upsertRepo,
  } = useLiveSyncStore({
    hubUrl: HUB_URL,
    setStartDialogSlug,
    setNewEnvTarget,
  });

  useEffect(() => {
    const scope = getDashboardRouteScope(location.pathname);
    activeSessionIdRef.current = scope.type === 'session' ? scope.sessionId : null;
    locationPathnameRef.current = location.pathname;
  }, [location.pathname]);

  useEffect(() => {
    envRepoIdMapRef.current = new Map(envs.map((env) => [env.slug, env.repoId]));
  }, [envs]);

  useEffect(() => {
    const handleVisibility = () => setDocumentVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  const implementorAttentionTarget = resolveVisibleImplementorAttentionTarget({
    visible: documentVisible,
    pathname: location.pathname,
    envs,
    sessions,
  });
  const implementorAttentionSlug = implementorAttentionTarget?.slug ?? null;
  const implementorAttentionToken = implementorAttentionTarget?.token ?? null;

  useEffect(() => {
    if (!implementorAttentionSlug || !implementorAttentionToken) return;
    const abortController = new AbortController();
    void acknowledgeImplementorAttentionAndRecover(
      { slug: implementorAttentionSlug, token: implementorAttentionToken },
      (slug, token) => acknowledgeImplementorAttention(
        HUB_URL,
        slug,
        token,
        abortController.signal,
      ),
      recoverEnv,
      {
        signal: abortController.signal,
        shouldRetry: (error) => !(error instanceof ApiActionError)
          || error.status === null
          || error.status === 408
          || error.status === 425
          || error.status === 429
          || error.status >= 500,
        onRetry: (error) => {
          console.error('[tiller] Failed to acknowledge implementor attention; retrying:', error);
        },
      },
    )
      .catch((error) => {
        if (!abortController.signal.aborted) {
          console.error('[tiller] Failed to acknowledge implementor attention:', error);
        }
      });
    return () => {
      abortController.abort();
    };
  }, [implementorAttentionSlug, implementorAttentionToken, recoverEnv]);

  const getKnownEnvRepoId = useCallback(
    (slug: string) => envRepoIdMapRef.current.get(slug) ?? null,
    [],
  );

  const rememberSessions = useCallback((list: StoredSession[]) => {
    let changed = false;
    for (const session of list) {
      const slug = getSessionEnvSlugFromSession(session);
      if (!slug) continue;
      if (sessionEnvMapRef.current.get(session.id) === slug) continue;
      sessionEnvMapRef.current.set(session.id, slug);
      changed = true;
    }
    if (changed) {
      setSessionEnvMap(new Map(sessionEnvMapRef.current));
    }
  }, []);

  const rememberSession = useCallback((session: StoredSession) => {
    rememberSessions([session]);
  }, [rememberSessions]);

  const loadUpdateStatus = useCallback(async (forceRefresh = false): Promise<{
    status: UpdateCheckResult | null;
    issue: string | null;
    issueCode: string | null;
    dismissed: boolean;
  }> => {
    try {
      const result = await checkForUpdate(HUB_URL, { forceRefresh });
      const issue = getTopLevelUpdateIssue(result);
      return {
        status: result,
        issue,
        issueCode: issue ? result.errors[0]?.code ?? null : null,
        dismissed: isUpdateDismissed(getUpdateDismissalSourceId(result)),
      };
    } catch (error) {
      const failure = getUpdateCheckFailure(error);
      return {
        status: null,
        issue: failure.message,
        issueCode: failure.code,
        dismissed: false,
      };
    }
  }, []);

  const refreshUpdateStatus = useCallback(async (options: { forceRefresh?: boolean } = {}) => {
    setIsCheckingUpdate(true);
    const next = await loadUpdateStatus(options.forceRefresh === true);
    setUpdateStatus(next.status);
    setUpdateIssue(next.issue);
    setUpdateIssueCode(next.issueCode);
    setUpdateDismissed(next.dismissed);
    setIsCheckingUpdate(false);
    return next;
  }, [loadUpdateStatus]);

  const performSetupStatusRefresh = useCallback(async () => {
    try {
      const nextStatus = await fetchSetupStatus(HUB_URL);
      setSetupStatus(nextStatus);
      setSetupLoadError(null);
    } catch (error) {
      if (recoverBrowserAuthentication(error)) {
        setSetupLoadError('Your Cloudflare Access session expired. Reload this page to sign in again.');
        return;
      }
      setSetupLoadError('Setup status could not be loaded.');
    }
  }, []);

  const {
    refresh: bootstrapSetupStatus,
    invalidateAndWait: invalidateSetupStatus,
  } = useSerializedRefresh(performSetupStatusRefresh);
  const refreshSetupStatus = useCallback(async (): Promise<void> => {
    await invalidateSetupStatus();
  }, [invalidateSetupStatus]);

  const dismissDashboardOnboarding = useCallback(async () => {
    await dismissDashboardOnboardingRequest(HUB_URL);
    await refreshSetupStatus();
  }, [refreshSetupStatus]);

  const performSessionsRefresh = useCallback(async (): Promise<boolean> => {
    setSessionsLoadState((current) => current === 'loaded' ? current : 'loading');
    try {
      const list = await fetchSessions(HUB_URL);
      rememberSessions(list);
      setSessions(list);
      setSessionsLoadState('loaded');
      return true;
    } catch (err) {
      recoverBrowserAuthentication(err);
      setSessionsLoadState((current) => settleDashboardReadState(current, false));
      return false;
    }
  }, [rememberSessions]);

  const {
    refresh: bootstrapSessions,
    invalidateAndWait: invalidateSessions,
  } = useSerializedRefresh(performSessionsRefresh);
  const refreshSessions = useCallback(async (): Promise<boolean> => {
    return (await invalidateSessions()) ?? false;
  }, [invalidateSessions]);

  const performEnvsRefresh = useCallback(async (): Promise<boolean> => {
    setEnvsLoadState((current) => current === 'loaded' ? current : 'loading');
    const ok = await refreshEnvsStore();
    setEnvsLoadState((current) => settleDashboardReadState(current, ok));
    return ok;
  }, [refreshEnvsStore]);

  const {
    refresh: bootstrapEnvs,
    invalidateAndWait: invalidateEnvs,
  } = useSerializedRefresh(performEnvsRefresh);
  const refreshEnvs = useCallback(async (): Promise<boolean> => {
    return (await invalidateEnvs()) ?? false;
  }, [invalidateEnvs]);

  const performReposRefresh = useCallback(async (): Promise<boolean> => {
    setReposLoadState((current) => current === 'loaded' ? current : 'loading');
    const ok = await refreshReposStore();
    setReposLoadState((current) => settleDashboardReadState(current, ok));
    return ok;
  }, [refreshReposStore]);

  const {
    refresh: bootstrapRepos,
    invalidateAndWait: invalidateRepos,
  } = useSerializedRefresh(performReposRefresh);
  const refreshRepos = useCallback(async (): Promise<boolean> => {
    return (await invalidateRepos()) ?? false;
  }, [invalidateRepos]);

  useEffect(() => {
    if (!setupReady) return;
    let cancelled = false;

    setIsCheckingUpdate(true);
    void loadUpdateStatus()
      .then((next) => {
        if (cancelled) return;
        setUpdateStatus(next.status);
        setUpdateIssue(next.issue);
        setUpdateIssueCode(next.issueCode);
        setUpdateDismissed(next.dismissed);
        setIsCheckingUpdate(false);
      });

    return () => {
      cancelled = true;
    };
  }, [loadUpdateStatus, setupReady]);

  useEffect(() => {
    bootstrapSetupStatus().finally(() => setSetupChecked(true));
  }, [bootstrapSetupStatus]);

  const retrySetupStatus = useCallback(() => {
    setSetupChecked(false);
    void refreshSetupStatus().finally(() => setSetupChecked(true));
  }, [refreshSetupStatus]);

  const updateLastSeq = useCallback((sessionId: string, seq: number) => {
    const current = lastSeqRef.current.get(sessionId);
    if (current == null || seq > current) {
      lastSeqRef.current.set(sessionId, seq);
    }
  }, []);

  const loadPermissions = useCallback(async () => {
    const activeId = activeSessionIdRef.current;
    if (!activeId) return;
    try {
      const perms = await fetchPendingPermissions(HUB_URL, activeId);
      setPermissions((prev) => {
        const next = new Map(prev);
        next.set(activeId, perms);
        return next;
      });
    } catch (err) {
      console.error('[tiller] loadPermissions failed:', err);
    }
  }, []);

  const handlePermissionResolved = useCallback((permId: string) => {
    setPermissions((prev) => {
      const next = new Map(prev);
      for (const [sid, perms] of next) {
        const filtered = perms.filter((p) => p.id !== permId);
        if (filtered.length !== perms.length) {
          next.set(sid, filtered);
        }
      }
      return next;
    });
  }, []);

  const startTitleFlash = useCallback(() => {
    if (titleFlashRef.current) return;
    const original = document.title;
    let on = true;
    titleFlashRef.current = setInterval(() => {
      document.title = on ? '[!] Approval needed' : original;
      on = !on;
    }, 1000);
    const stop = () => {
      if (!document.hidden) {
        clearInterval(titleFlashRef.current!);
        titleFlashRef.current = null;
        document.title = original;
        document.removeEventListener('visibilitychange', stop);
      }
    };
    document.addEventListener('visibilitychange', stop);
  }, []);

  const handleCreateRepo = useCallback(
    async (selection: GitHubRepositorySelection) => {
      const repo = await createRepo(HUB_URL, selection);
      upsertRepo(repo);
      addToast({
        title: 'Repository added',
        body: isRepoMainReady(repo)
          ? selection.fullName
          : `${selection.fullName} · preparing canonical main`,
        variant: 'success',
      });
      navigate(projectPath(repo.repoId));
      setShowNewRepo(false);
    },
    [addToast, navigate, upsertRepo],
  );

  const handleCreateEnv = useCallback(
    async (options: CreateEnvOptions) => {
      const repoId = newEnvTarget?.repoId;
      if (!repoId) return;
      const env = await createEnv(HUB_URL, repoId, options);
      upsertEnv(env);
      addToast({
        title: `${getEnvDisplayName(env)} created`,
        body: `${getBackendBadgeLabel(env.backend)}, ${getHarnessBadgeLabel(options.harness)}`,
        variant: 'success',
      });
      navigate(envPath(env.slug));
      setNewEnvTarget(null);
    },
    [addToast, navigate, newEnvTarget, upsertEnv],
  );

  const handleRetryRepoMain = useCallback(
    async (repoId: string) => {
      await refreshRepoEntity(repoId);
      addToast({
        title: 'Refreshing repository',
        body: 'GitHub repository metadata refreshed.',
        variant: 'success',
      });
    },
    [addToast, refreshRepoEntity],
  );

  const handleDashboardRepoDeleted = useCallback((repoId: string, deletedEnvSlugs: string[]) => {
    handleStoreRepoDeleted(repoId, deletedEnvSlugs);
    if (routeTouchesDeletedRepo(location.pathname, repoId, deletedEnvSlugs, sessionEnvMapRef.current)) {
      navigate('/', { replace: true });
    }
  }, [handleStoreRepoDeleted, location.pathname, navigate]);

  const handleDashboardEnvRemoved = useCallback((slug: string) => {
    const repoId = envRepoIdMapRef.current.get(slug) ?? null;
    removeEnv(slug);
    if (repoId && routeTouchesDeletedEnv(locationPathnameRef.current, slug, sessionEnvMapRef.current)) {
      navigate(projectImplementationsPath(repoId), { replace: true });
    }
  }, [navigate, removeEnv]);

  useEffect(() => {
    if (!setupReady || dashboardBootstrapped) return;
    const terminal = [sessionsLoadState, envsLoadState, reposLoadState]
      .every((state) => state === 'loaded' || state === 'error');
    if (terminal) setDashboardBootstrapped(true);
  }, [dashboardBootstrapped, envsLoadState, reposLoadState, sessionsLoadState, setupReady]);

  useEffect(() => {
    if (!setupReady) return;

    void bootstrapSessions();
    void bootstrapEnvs();
    void bootstrapRepos();
    setReconnectExhausted(false);

    const ws = createReconnectingWebSocket(HUB_URL, {
      onConnected: () => {
        setConnected(true);
        setReconnectExhausted(false);
        void loadPermissions();
        refreshDashboardStateAfterHubConnect({
          refreshSessions: () => void invalidateSessions(),
          refreshEnvs: () => void invalidateEnvs(),
          refreshRepos: () => void invalidateRepos(),
          refreshSetupStatus: () => void invalidateSetupStatus(),
        });
        addToast({ title: 'Connected', variant: 'success', duration: 2000 });
      },
      onDisconnected: () => {
        setConnected(false);
        setTerminalFastLane(false);
        setTerminalMetrics(false);
      },
      onReconnectExhausted: () => {
        setReconnectExhausted(true);
        setTerminalFastLane(false);
        setTerminalMetrics(false);
        addToast({
          title: 'Connection lost',
          body: 'Max reconnection attempts reached',
          variant: 'error',
          duration: 0,
        });
      },
      onCapabilities: (capabilities) => {
        setTerminalFastLane(capabilities.terminalFastLane);
        setTerminalMetrics(capabilities.terminalMetrics);
      },
      onMessage: (msg) => {
        liveMessageRef.current?.(msg);
      },
      onTerminalInputAck: (msg) => {
        terminalAckRef.current?.(msg);
      },
      onTerminalControlAck: (msg) => {
        terminalAckRef.current?.(msg);
      },
      onMachineUpdated: () => {
        void invalidateSetupStatus();
        setHostRefreshNonce((n) => n + 1);
      },
      onSessionUpdated: (session) => {
        rememberSession(session);
        setSessions((prev) => {
          const idx = prev.findIndex((s) => s.id === session.id);
          if (idx >= 0) {
            const next = [...prev];
            next[idx] = session;
            return next;
          }
          return [session, ...prev];
        });
      },
      onSessionDeleted: (sessionId) => {
        setSessions((prev) => {
          const existing = prev.find((session) => session.id === sessionId);
          if (existing) rememberSession(existing);
          return prev.filter((session) => session.id !== sessionId);
        });
      },
      onPermissionCreated: (permission) => {
        setPermissions((prev) => {
          const next = new Map(prev);
          const existing = next.get(permission.session_id) || [];
          next.set(permission.session_id, [...existing, permission]);
          return next;
        });
        addToast({
          title: 'Permission requested',
          body: `${permission.tool_name} needs approval`,
          variant: 'warning',
        });
        if (
          document.hidden &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          new Notification(`Tiller: Permission needed - ${permission.tool_name}`, {
            body: `Session requires approval for ${permission.tool_name}`,
            tag: permission.id,
          });
        }
        if (document.hidden) {
          startTitleFlash();
        }
      },
      onEnvUpsert: (env) => {
        upsertEnv(env);
      },
      onEnvRemove: (slug) => {
        handleDashboardEnvRemoved(slug);
      },
      onRepoUpsert: (repo) => {
        upsertRepo(repo);
      },
      onRepoRemove: (repoId) => {
        removeRepo(repoId);
      },
      onPlanArtifactUpdated: (repoId, planArtifactId) => {
        // Keep the selected Scribe's terminal lifecycle converged without
        // presenting this generic artifact/attention hint as active saving.
        planWriterRefreshHintRef.current?.(repoId, planArtifactId);
        planArtifactHintRef.current?.(repoId, planArtifactId);
      },
      onPlanWriterState: (repoId, planArtifactId) => {
        planWriterRefreshHintRef.current?.(repoId, planArtifactId);
      },
      onRepoMainChanged: (repoId, repoUrl, previousMainCommit, currentMainCommit, sourceEnvSlug) => {
        setLastRepoMainEvent({
          repoId,
          repoUrl,
          previousMainCommit,
          currentMainCommit,
          sourceEnvSlug,
        });
        addToast({
          title: 'Repository updated',
          body: 'Tiller merged new changes from GitHub.',
          variant: 'info',
          duration: 5000,
        });
      },
      onPermissionResolved: (permission) => {
        setPermissions((prev) => {
          const next = new Map(prev);
          const existing = next.get(permission.session_id) || [];
          next.set(
            permission.session_id,
            existing.filter((p) => p.id !== permission.id),
          );
          return next;
        });
      },
      onError: (err) => {
        console.error('[tiller ws]', err);
      },
    });

    wsRef.current = ws;

    return () => {
      ws.close();
      wsRef.current = null;
      setTerminalFastLane(false);
    };
  }, [
    setupReady,
    bootstrapSessions,
    bootstrapEnvs,
    bootstrapRepos,
    invalidateSessions,
    invalidateEnvs,
    invalidateRepos,
    invalidateSetupStatus,
    loadPermissions,
    updateLastSeq,
    addToast,
    startTitleFlash,
    handleDashboardEnvRemoved,
    removeRepo,
    upsertEnv,
    upsertRepo,
    rememberSession,
  ]);

  const handleReconnect = useCallback(() => {
    wsRef.current?.reconnect();
  }, []);

  const value = useMemo<DashboardData>(() => ({
    hubUrl: HUB_URL,
    sessions,
    repos,
    envs,
    sessionsLoadState,
    reposLoadState,
    envsLoadState,
    refreshSessions,
    refreshRepos,
    refreshEnvs,
    refreshSetupStatus,
    dismissDashboardOnboarding,
    setupStatus,
    updateStatus,
    updateIssue,
    updateIssueCode,
    updateDismissed,
    isCheckingUpdate,
    refreshUpdateStatus,
    connected,
    terminalFastLane,
    terminalMetrics,
    reconnectExhausted,
    hostRefreshNonce,
    permissions,
    liveMessageRef,
    terminalAckRef,
    planWriterRefreshHintRef,
    planArtifactHintRef,
    wsRef,
    updateLastSeq,
    handlePermissionResolved,
    handleReconnect,
    recoverEnv,
    recoverEntities,
    setShowNewRepo,
    setShowUpdate,
    setNewEnvTarget,
    setStartDialogSlug,
    handleCreateRepo,
    handleCreateEnv,
    handleDashboardRepoDeleted,
    handleRetryRepoMain,
    getKnownEnvRepoId,
    sessionEnvMap,
    lastRepoMainEvent,
  }), [
    sessions,
    repos,
    envs,
    sessionsLoadState,
    reposLoadState,
    envsLoadState,
    refreshSessions,
    refreshRepos,
    refreshEnvs,
    refreshSetupStatus,
    dismissDashboardOnboarding,
    setupStatus,
    updateStatus,
    updateIssue,
    updateIssueCode,
    updateDismissed,
    isCheckingUpdate,
    refreshUpdateStatus,
    connected,
    terminalFastLane,
    terminalMetrics,
    reconnectExhausted,
    hostRefreshNonce,
    permissions,
    updateLastSeq,
    handlePermissionResolved,
    handleReconnect,
    recoverEnv,
    recoverEntities,
    setNewEnvTarget,
    handleCreateRepo,
    handleCreateEnv,
    handleDashboardRepoDeleted,
    handleRetryRepoMain,
    getKnownEnvRepoId,
    sessionEnvMap,
    lastRepoMainEvent,
  ]);

  if (!setupChecked) {
    return <RouteLoading label="Loading Tiller" fullScreen />;
  }

  if (!setupStatus) {
    return (
      <SetupStatusLoadError
        message={setupLoadError ?? 'Setup status could not be loaded.'}
        onRetry={retrySetupStatus}
      />
    );
  }

  if (setupStatus?.needsSetup) {
    return (
      <Suspense fallback={<RouteLoading label="Loading setup" fullScreen />}>
        <SetupWizard
          status={setupStatus}
          onRefresh={refreshSetupStatus}
        />
      </Suspense>
    );
  }

  if (!dashboardBootstrapped) {
    return <RouteLoading label="Loading workspace" fullScreen />;
  }

  return (
    <DashboardDataContext.Provider value={value}>
      <Outlet />
      <Suspense fallback={<RouteLoading label="Loading dialog" />}>
        <DashboardDialogs
          showNewRepo={showNewRepo}
          showUpdate={showUpdate || location.pathname === '/update'}
          newEnvTarget={newEnvTarget}
        />
      </Suspense>
    </DashboardDataContext.Provider>
  );
}

function DashboardDialogs({
  showNewRepo,
  showUpdate,
  newEnvTarget,
}: {
  showNewRepo: boolean;
  showUpdate: boolean;
  newEnvTarget: NewEnvTarget | null;
}) {
  const data = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  const newEnvRepo = newEnvTarget
    ? data.repos.find((repo) => repo.repoId === newEnvTarget.repoId) ?? null
    : null;
  const closeUpdate = () => {
    data.setShowUpdate(false);
    if (location.pathname === '/update') navigate('/', { replace: true });
  };
  return (
    <>
      {showNewRepo && (
        <NewRepoDialog
          onClose={() => data.setShowNewRepo(false)}
          hubUrl={data.hubUrl}
          repos={data.repos}
          githubAppConfigured={data.setupStatus?.githubAppConfigured ?? false}
          onCreate={data.handleCreateRepo}
        />
      )}
      {newEnvTarget && newEnvRepo && (
        <NewEnvDialog
          onClose={() => data.setNewEnvTarget(null)}
          hubUrl={data.hubUrl}
          hasClaudeSubscription={data.setupStatus?.hasClaudeSubscription ?? false}
          hasAnthropicKey={data.setupStatus?.hasAnthropicKey ?? false}
          hasChatGPTAuth={data.setupStatus?.hasChatGPTAuth ?? false}
          chatgptAuthStatus={data.setupStatus?.chatgptAuthStatus ?? 'missing'}
          hasOpenAIKey={data.setupStatus?.hasOpenAIKey ?? false}
          claudeBillingMode={data.setupStatus?.claudeBillingMode ?? null}
          openaiBillingMode={data.setupStatus?.openaiBillingMode ?? null}
          workersAiConfigured={data.setupStatus?.workersAiConfigured ?? false}
          enabledHarnesses={data.setupStatus?.enabledHarnesses ?? ['claude-code']}
          repo={newEnvRepo}
          initialPlanChoice={newEnvTarget.planChoice}
          hideStartupPlan={newEnvTarget.planChoice === 'none'}
          onRefreshSetupStatus={data.refreshSetupStatus}
          onCreate={data.handleCreateEnv}
        />
      )}
      {showUpdate && (
        <UpdateDialog
          hubUrl={data.hubUrl}
          status={data.updateStatus}
          issue={data.updateIssue}
          issueCode={data.updateIssueCode}
          isChecking={data.isCheckingUpdate}
          hasExecutionMachine={Boolean(data.setupStatus?.hostRegistered)}
          onDismiss={closeUpdate}
          onIgnore={() => {
            if (data.updateStatus) {
              ignoreUpdateUntilNext(getUpdateDismissalSourceId(data.updateStatus));
              data.refreshUpdateStatus().catch(() => undefined);
            }
            closeUpdate();
          }}
          onOpenSettings={() => {
            data.setShowUpdate(false);
            navigate('/settings', {
              state: { returnTo: `${location.pathname}${location.search}${location.hash}` },
            });
          }}
          onCheckNow={() => {
            void data.refreshUpdateStatus({ forceRefresh: true });
          }}
        />
      )}
    </>
  );
}
