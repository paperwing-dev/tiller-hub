import { useState, useEffect, useCallback, useRef } from 'react';
import type { StoredSession, StoredPermission } from '../api/types';
import {
  fetchSessions,
  fetchMessages,
  fetchPendingPermissions,
  createReconnectingWebSocket,
  fetchSetupStatus,
  createEnv,
  createRepo,
  bootstrapRepoGitArtifact,
  checkForUpdate,
  ApiActionError,
} from './api';
import type {
  CodexAuthPreference,
  EnvHarness,
  LiveMessage,
  ReconnectingWebSocket,
  SetupStatus,
  UpdateCheckResult,
  GitHubRepositorySelection,
} from './api';
import { useToast } from './Toast';
import SessionList from './SessionList';
import SessionView from './SessionView';
import EnvWaitingView from './EnvWaitingView';
import PlanView from './PlanView';
import ChangesView from './ChangesView';
import { NewRepoDialog, NewEnvDialog } from './NewEnvDialog';
import StartPlanDialog from './StartPlanDialog';
import SettingsPage from './SettingsPage';
import SetupWizard from './SetupWizard';
import ConnectionsBadge from './ConnectionsBadge';
import UpdateButton from './UpdateBadge';
import UpdateDialog from './UpdateDialog';
import { dismissUpdate, isUpdateDismissed } from './update-storage';
import { isLoopbackHostname } from '../shared/local-dev';
import { isRepoMainReady } from './repo-status';
import { getBackendBadgeLabel, getEnvDisplayName } from './env-display';
import { getHarnessBadgeLabel } from './env-harness';
import type { DashboardSelection as Selection } from './live-sync-store';
import { reconcileSelectionAfterRunningEnv } from './live-sync-store';
import { useLiveSyncStore } from './useLiveSyncStore';
import {
  shouldShowEnvWaitingViewForStatus,
  shouldSelectLiveSessionForEnvStatus,
} from './env-runtime';
import { pickPrimaryEnvSession } from './session-attachment';

const HUB_URL = window.location.origin;

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
  return result.issue?.code === 'update_check_failed' ? result.issue.message : null;
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

export default function Dashboard() {
  const [sessions, setSessions] = useState<StoredSession[]>([]);
  const [selection, setSelection] = useState<Selection>({ type: 'none' });
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [connected, setConnected] = useState(false);
  const [reconnectExhausted, setReconnectExhausted] = useState(false);
  const [permissions, setPermissions] = useState<
    Map<string, StoredPermission[]>
  >(new Map());
  const [showNewRepo, setShowNewRepo] = useState(false);
  const [newEnvTarget, setNewEnvTarget] = useState<{ repoId: string } | null>(null);
  const [startDialogSlug, setStartDialogSlug] = useState<string | null>(null);
  const [lastRepoMainEvent, setLastRepoMainEvent] = useState<{
    repoId: string;
    repoUrl: string;
    previousMainCommit: string | null;
    currentMainCommit: string | null;
    sourceEnvSlug?: string | null;
  } | null>(null);
  const liveMessageRef = useRef<((msg: LiveMessage) => void) | null>(null);
  const wsRef = useRef<ReconnectingWebSocket | null>(null);
  const lastSeqRef = useRef<Map<string, number>>(new Map());
  const selectionRef = useRef<Selection>({ type: 'none' });
  const sessionsRef = useRef<StoredSession[]>([]);
  const [setupStatus, setSetupStatus] = useState<SetupStatus | null>(null);
  const [setupChecked, setSetupChecked] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateCheckResult | null>(null);
  const [updateIssue, setUpdateIssue] = useState<string | null>(null);
  const [updateIssueCode, setUpdateIssueCode] = useState<string | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(true);
  const [hostRefreshNonce, setHostRefreshNonce] = useState(0);
  const addToast = useToast();
  const titleFlashRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadUpdateStatus = useCallback(async (): Promise<{
    status: UpdateCheckResult | null;
    issue: string | null;
    issueCode: string | null;
    dismissed: boolean;
  }> => {
    try {
      const result = await checkForUpdate(HUB_URL);
      const issue = getTopLevelUpdateIssue(result);
      return {
        status: result,
        issue,
        issueCode: issue ? result.issue?.code ?? null : null,
        dismissed: isUpdateDismissed(result.latestUpdate.sourceId),
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

  const refreshUpdateStatus = useCallback(async () => {
    setIsCheckingUpdate(true);
    const next = await loadUpdateStatus();
    setUpdateStatus(next.status);
    setUpdateIssue(next.issue);
    setUpdateIssueCode(next.issueCode);
    setUpdateDismissed(next.dismissed);
    setIsCheckingUpdate(false);
    return next;
  }, [loadUpdateStatus]);

  const refreshSetupStatus = useCallback(async () => {
    try {
      const nextStatus = await fetchSetupStatus(HUB_URL);
      setSetupStatus(nextStatus);
    } catch {
      setSetupStatus({
        needsSetup: false,
        setupPhase: "complete",
        isLocalDev: isLoopbackHostname(new URL(HUB_URL).hostname),
        currentOrigin: HUB_URL,
        hubUrl: HUB_URL,
        deploymentMode: "hosted",
        selfHostStatus: "not-enabled",
        selfHostSetupAttemptId: null,
        workersDevHubUrl: HUB_URL.includes(".workers.dev") ? HUB_URL : null,
        routeKind: HUB_URL.includes(".workers.dev") ? "workers-dev" : "custom-domain",
        workerServiceName: null,
        modelAuthConfigured: false,
        modelAuthMode: null,
        hostedInfrastructureReady: false,
        hostedBlockingReasons: ["Status response was unavailable."],
        hostedModelReady: false,
        hostedModelBlockingReasons: ["Status response was unavailable."],
        selfHostReady: false,
        selfHostBlockingReasons: ["Status response was unavailable."],
        workersAiConfigured: false,
        hasClaudeSubscription: false,
        hasAnthropicKey: false,
        hasChatGPTAuth: false,
        chatgptAuthStatus: "missing",
        hasOpenAIKey: false,
        codexRouteStatus: "unavailable",
        openaiPlannerConfigured: false,
        openaiPlannerAvailable: false,
        openaiPlannerRoute: null,
        openaiPlannerReason: null,
        hostRegistered: false,
        hostRegisteredMode: "none",
        hostGatewayAvailable: false,
        hostGatewayConfigured: false,
        hostGatewayMode: "none",
        enabledHarnesses: ['claude-code', 'codex', 'opencode'],
        protectionMode: "public",
        protectionCanAutomate: !HUB_URL.includes(".workers.dev"),
        serviceTokenConfigured: false,
        gatewayHostname: null,
        browserProtected: false,
        gatewayProvisioned: false,
        gatewayTunnelConfigured: false,
        gatewaySupportAvailable: false,
        gatewaySupportReason: null,
        workersDevCutoverPending: false,
        unsupportedProtectionConfig: false,
        workersDevAliasDisabled: false,
        protectionAppDomain: null,
        accessConfigured: false,
        accessIssuer: null,
        accessJwksUrl: null,
        hostConnected: false,
        hostConnectionMode: "none",
        idleTimeoutMinutes: 10,
        canonicalMainBootstrapDepth: 0,
        githubAppAvailable: false,
        githubAppConfigured: false,
        githubAppReady: false,
        githubAppSlug: null,
        githubAppInstallUrl: null,
        githubAppManageUrl: "https://github.com/settings/installations",
        githubAppPublicHubDisabled: true,
        buildDiagnostics: {
          channel: "release",
          version: "",
          workersCiCommitSha: null,
          workersCiBranch: null,
        },
        selfUpdateRepo: { status: "not_checked", lastDetectedAt: null },
      });
    }
  }, []);

  const {
    envs,
    repos,
    refreshEnvs,
    refreshRepos,
    refreshRepoEntity,
    recoverEnv,
    recoverEntities,
    handleRepoDeleted,
    removeEnv,
    removeRepo,
    upsertEnv,
    upsertRepo,
  } = useLiveSyncStore({
    hubUrl: HUB_URL,
    sessionsRef,
    setSelection,
    setStartDialogSlug,
    setNewEnvTarget,
  });

  // Keep refs in sync
  useEffect(() => {
    selectionRef.current = selection;
  }, [selection]);
  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    if (selection.type !== 'none' || repos.length === 0) return;
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const repoId = params.get('repoId');
    if (!repoId) return;
    const repo = repos.find((candidate) => candidate.repoId === repoId);
    if (!repo) return;
    setSelection({
      type: 'plan',
      repoId: repo.repoId,
      planArtifactId: params.get('planArtifactId'),
    });
  }, [repos, selection.type]);

  // Auto-promote env selection to its live session once both the env is running
  // and the primary session has been observed.
  useEffect(() => {
    setSelection((current) => reconcileSelectionAfterRunningEnv(current, sessions, envs));
  }, [envs, sessions]);

  useEffect(() => {
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
  }, [loadUpdateStatus]);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await fetchSessions(HUB_URL);
      setSessions(list);
    } catch (err) {
      if ((err as Error).message.includes('401')) {
        // Guard against reload loop — only reload once per 10s
        const lastReload = Number(
          sessionStorage.getItem('tiller-auth-reload') || '0',
        );
        if (Date.now() - lastReload > 10_000) {
          sessionStorage.setItem('tiller-auth-reload', String(Date.now()));
          window.location.reload();
        }
      }
    }
  }, []);

  // Expose a way for TerminalView to report lastSeq
  const updateLastSeq = useCallback((sessionId: string, seq: number) => {
    const current = lastSeqRef.current.get(sessionId);
    if (current == null || seq > current) {
      lastSeqRef.current.set(sessionId, seq);
    }
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
      setShowNewRepo(false);
    },
    [addToast, upsertRepo],
  );

  const handleCreateEnv = useCallback(
    async (
      backend: "cf" | "host",
      harness: EnvHarness,
      codexAuthPreference?: CodexAuthPreference,
    ) => {
      const repoId = newEnvTarget?.repoId;
      if (!repoId) return;
      const env = await createEnv(HUB_URL, repoId, backend, harness, undefined, codexAuthPreference);
      upsertEnv(env);
      addToast({
        title: `${getEnvDisplayName(env)} created`,
        body: `${getBackendBadgeLabel(backend)}, ${getHarnessBadgeLabel(harness)}`,
        variant: 'success',
      });
      setSelection({ type: 'env', envSlug: env.slug });
      setNewEnvTarget(null);
    },
    [addToast, newEnvTarget, upsertEnv],
  );

  const handleRetryRepoMain = useCallback(
    async (repoId: string) => {
      await bootstrapRepoGitArtifact(HUB_URL, repoId);
      void refreshRepoEntity(repoId);
      addToast({
        title: 'Retrying canonical main',
        body: 'Repository bootstrap restarted.',
        variant: 'success',
      });
    },
    [addToast, refreshRepoEntity],
  );

  // Gap-fill: fetch messages missed during disconnect for the active session
  const gapFill = useCallback(async () => {
    const sel = selectionRef.current;
    const activeId = sel.type === 'session' ? sel.sessionId : null;
    if (!activeId) return;
    const lastSeq = lastSeqRef.current.get(activeId);
    if (lastSeq == null) return;

    try {
      const msgs = await fetchMessages(HUB_URL, activeId, {
        afterSeq: lastSeq,
        limit: 1000,
      });
      for (const msg of msgs) {
        liveMessageRef.current?.({
          sessionId: activeId,
          content: msg.content,
          seq: msg.seq,
        });
      }
    } catch (err) {
      console.error('[tiller] gap-fill failed:', err);
    }
  }, []);

  // Load pending permissions for active session on reconnect
  const loadPermissions = useCallback(async () => {
    const sel = selectionRef.current;
    const activeId = sel.type === 'session' ? sel.sessionId : null;
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

  // Immediately remove a permission from local state (called on successful HTTP resolve)
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

  // Flash title when permission needs attention
  const startTitleFlash = useCallback(() => {
    if (titleFlashRef.current) return;
    const original = document.title;
    let on = true;
    titleFlashRef.current = setInterval(() => {
      document.title = on ? '[!] Approval needed' : original;
      on = !on;
    }, 1000);
    // Stop flashing when tab becomes visible
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

  // Handle env selection — find matching session or select env
  const handleEnvSelect = useCallback((slug: string) => {
    const matchingSession = pickPrimaryEnvSession(sessions, slug);
    const env = envs.find((candidate) => candidate.slug === slug) ?? null;
    if (matchingSession && shouldSelectLiveSessionForEnvStatus(env?.status)) {
      setSelection({ type: 'session', sessionId: matchingSession.id });
    } else {
      setSelection({ type: 'env', envSlug: slug });
    }
  }, [envs, sessions]);

  // Handle session selection
  const handleSessionSelect = useCallback((sessionId: string) => {
    setSelection({ type: 'session', sessionId });
  }, []);

  // Check setup status on mount
  useEffect(() => {
    refreshSetupStatus().finally(() => setSetupChecked(true));
  }, [refreshSetupStatus]);

  // Fetch sessions + envs on mount, then connect WS immediately
  useEffect(() => {
    if (!setupChecked || setupStatus?.needsSetup) return;

    refreshSessions();
    refreshEnvs();
    refreshRepos();
    setReconnectExhausted(false);

    const ws = createReconnectingWebSocket(HUB_URL, {
      onConnected: () => {
        setConnected(true);
        setReconnectExhausted(false);
        gapFill();
        loadPermissions();
        refreshDashboardStateAfterHubConnect({
          refreshSessions,
          refreshEnvs,
          refreshRepos,
          refreshSetupStatus,
        });
        addToast({ title: 'Connected', variant: 'success', duration: 2000 });
      },
      onDisconnected: () => {
        setConnected(false);
      },
      onReconnectExhausted: () => {
        setReconnectExhausted(true);
        addToast({
          title: 'Connection lost',
          body: 'Max reconnection attempts reached',
          variant: 'error',
          duration: 0,
        });
      },
      onMessage: (msg) => {
        console.log('[debug] WS message-received:', msg.sessionId, msg.seq, typeof msg.content, 'handler?', !!liveMessageRef.current);
        if (msg.seq != null && msg.sessionId) {
          updateLastSeq(msg.sessionId, msg.seq);
        }
        liveMessageRef.current?.(msg);
      },
      onMachineUpdated: () => {
        refreshSetupStatus();
        setHostRefreshNonce((n) => n + 1);
      },
      onSessionUpdated: (session) => {
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
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        setSelection((prev) =>
          prev.type === 'session' && prev.sessionId === sessionId
            ? { type: 'none' }
            : prev,
        );
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
        // Browser notification when tab is hidden
        if (
          document.hidden &&
          'Notification' in window &&
          Notification.permission === 'granted'
        ) {
          new Notification(
            `Tiller: Permission needed — ${permission.tool_name}`,
            {
              body: `Session requires approval for ${permission.tool_name}`,
              tag: permission.id,
            },
          );
        }
        if (document.hidden) {
          startTitleFlash();
        }
      },
      onEnvUpsert: (env) => {
        upsertEnv(env);
      },
      onEnvRemove: (slug) => {
        removeEnv(slug);
      },
      onRepoUpsert: (repo) => {
        upsertRepo(repo);
      },
      onRepoRemove: (repoId) => {
        removeRepo(repoId);
      },
      onRepoMainChanged: (repoId, repoUrl, previousMainCommit, currentMainCommit, sourceEnvSlug) => {
        setLastRepoMainEvent({
          repoId,
          repoUrl,
          previousMainCommit,
          currentMainCommit,
          sourceEnvSlug,
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
    };
  }, [
    setupChecked,
    setupStatus?.needsSetup,
    refreshSessions,
    refreshEnvs,
    refreshRepos,
    gapFill,
    loadPermissions,
    updateLastSeq,
    addToast,
    startTitleFlash,
    removeEnv,
    removeRepo,
    upsertEnv,
    upsertRepo,
  ]);

  const handleReconnect = () => {
    wsRef.current?.reconnect();
  };

  const selectedSession =
    selection.type === 'session'
      ? sessions.find((s) => s.id === selection.sessionId) || null
      : null;
  const selectedSessionEnv =
    selectedSession
      ? envs.find((env) => env.slug === selectedSession.tag) || null
      : null;
  const selectedEnv =
    selection.type === 'env'
      ? envs.find((e) => e.slug === selection.envSlug) || null
      : null;
  const shouldShowSelectedSession =
    !!selectedSession &&
    (!selectedSessionEnv || !shouldShowEnvWaitingViewForStatus(selectedSessionEnv.status));
  const waitingEnv =
    selectedEnv ??
    (!shouldShowSelectedSession ? selectedSessionEnv : null);

  const planSelection = selection.type === 'plan' ? selection : null;
  const selectedPlanRepo =
    planSelection ? repos.find((repo) => repo.repoId === planSelection.repoId) ?? null : null;
  const newEnvRepo =
    newEnvTarget ? repos.find((repo) => repo.repoId === newEnvTarget.repoId) ?? null : null;
  const changesSelection = selection.type === 'changes' ? selection : null;
  const selectedChangesEnv =
    changesSelection ? envs.find((env) => env.slug === changesSelection.envSlug) ?? null : null;
  const selectedChangesRepo =
    selectedChangesEnv?.repoId
      ? repos.find((repo) => repo.repoId === selectedChangesEnv.repoId) ?? null
      : null;

  const selectedId = selection.type === 'session' ? selection.sessionId : null;
  const selectedEnvSlug = selection.type === 'env' ? selection.envSlug : null;
  const startDialogEnv =
    startDialogSlug ? envs.find((env) => env.slug === startDialogSlug) ?? null : null;
  const startDialogRepo =
    startDialogEnv?.repoId
      ? repos.find((repo) => repo.repoId === startDialogEnv.repoId) ?? null
      : null;

  const selectedPermissions = selectedId
    ? permissions.get(selectedId) || []
    : [];
  const isLocalDev = setupStatus?.isLocalDev ?? false;

  // Setup check: loading or needs first-run setup
  if (!setupChecked) {
    return (
      <div className="flex h-screen items-center justify-center text-[#57606a] text-sm">
        Loading...
      </div>
    );
  }

  if (setupStatus?.needsSetup) {
    return (
      <SetupWizard
        status={setupStatus}
        onRefresh={refreshSetupStatus}
      />
    );
  }

  return (
    <div className="flex h-screen relative">
      <div className="absolute right-4 top-3 z-20 flex items-center gap-2">
        <button
          type="button"
          onClick={() => setSelection({ type: 'settings' })}
          className={`inline-flex h-8 w-8 items-center justify-center rounded-md border text-base leading-none transition-colors ${
            selection.type === 'settings'
              ? 'border-[#0969da] bg-[#ddf4ff] text-[#0969da]'
              : 'border-[#d0d7de] bg-white text-[#57606a] hover:bg-[#f6f8fa] hover:text-[#24292f]'
          }`}
          title="Settings"
          aria-label="Settings"
          aria-current={selection.type === 'settings' ? 'page' : undefined}
        >
          <span aria-hidden="true">&#9881;</span>
        </button>
        <UpdateButton
          status={updateStatus}
          issue={updateIssue}
          dismissed={updateDismissed}
          isChecking={isCheckingUpdate}
          onOpen={() => setSelection({ type: 'update' })}
        />
      </div>

      {/* Sidebar */}
      <div
        className={`${sidebarOpen ? 'w-80' : 'w-0'} overflow-hidden border-r border-[#d0d7de] flex flex-col bg-[#f6f8fa] transition-all duration-200 flex-shrink-0`}
      >
        <div className="px-3 py-2.5 border-b border-[#d0d7de] flex flex-col gap-0.5">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold tracking-widest uppercase text-[#57606a]">
              TILLER
            </span>
            <div className="flex items-center gap-2">
              <ConnectionsBadge
                hubUrl={HUB_URL}
                hubConnected={connected}
                hostRefreshNonce={hostRefreshNonce}
                showHost={setupStatus?.isLocalDev === true || setupStatus?.deploymentMode === "self-host"}
              />
              <button
                onClick={() => setSidebarOpen(false)}
                className="text-[#57606a] hover:text-[#24292f] text-sm leading-none"
                title="Collapse sidebar"
              >
                ←
              </button>
            </div>
          </div>
        </div>
        <div className="px-3 py-2 border-b border-[#d0d7de]">
          <button
            onClick={() => setShowNewRepo(true)}
            className="w-full text-xs px-2.5 py-1.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#24292f] font-medium transition-colors"
          >
            Add Repo
          </button>
        </div>
        <SessionList
          repos={repos}
          sessions={sessions}
          selectedId={selectedId}
          onSelect={handleSessionSelect}
          envs={envs}
          hubUrl={HUB_URL}
          onRecoverEnv={recoverEnv}
          onEnvSelect={handleEnvSelect}
          selectedEnvSlug={selectedEnvSlug}
          onChangesSelect={(envSlug) => setSelection({ type: 'changes', envSlug })}
          selectedChangesEnvSlug={changesSelection?.envSlug ?? null}
          onPlanSelect={(repoId) =>
            setSelection({ type: 'plan', repoId })
          }
          planRepoId={planSelection?.repoId ?? null}
          onStartRequest={(slug) => setStartDialogSlug(slug)}
          onAddEnv={(repoId) => setNewEnvTarget({ repoId })}
          onRetryRepoMain={(repoId) => {
            void handleRetryRepoMain(repoId);
          }}
          onRecoverEntities={recoverEntities}
          onRepoDeleted={handleRepoDeleted}
        />
      </div>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {!sidebarOpen && (
          <button
            onClick={() => setSidebarOpen(true)}
            className="absolute left-0 top-1/2 -translate-y-1/2 z-10 bg-[#f6f8fa] border border-[#d0d7de] border-l-0 rounded-r px-1 py-3 text-[#57606a] hover:text-[#24292f] hover:bg-white transition-colors text-sm"
            title="Expand sidebar"
          >
            →
          </button>
        )}
        {reconnectExhausted && !connected && (
          <div className="bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between">
            <span className="text-sm text-red-600">Connection lost</span>
            <button
              onClick={handleReconnect}
              className="text-xs px-3 py-1 rounded bg-red-600 hover:bg-red-700 text-white font-medium"
            >
              Reconnect
            </button>
          </div>
        )}
        {isLocalDev && selection.type !== 'settings' && (
          <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2">
            <p className="text-sm font-medium text-[#24292f]">Localhost hub</p>
            <p className="text-xs text-[#57606a]">
              This localhost hub is for contributor development and supports Tiller Self Host environments only. Run
              <code>tiller host</code> before starting environments.
            </p>
          </div>
        )}
        {!isLocalDev && setupStatus && setupStatus.protectionMode === 'public' && selection.type !== 'settings' && (
          <div className="border-b border-[#d4a72c]/30 bg-[#fff8c5] px-4 py-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-[#24292f]">This hub is publicly accessible.</p>
              <p className="text-xs text-[#57606a]">
                {setupStatus.routeKind === 'workers-dev'
                  ? 'Open Settings to finish Cloudflare Access for this workers.dev route, or publish a custom domain for Tiller Self Host.'
                  : 'Open Settings to finish protecting this custom domain.'}
              </p>
            </div>
            <button
              onClick={() => setSelection({ type: 'settings' })}
              className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              Open settings
            </button>
          </div>
        )}
        {selection.type === 'settings' && setupStatus ? (
          <SettingsPage
            status={setupStatus}
            onRefresh={refreshSetupStatus}
            onDone={() => setSelection({ type: 'none' })}
          />
        ) : selection.type === 'update' && (updateStatus || updateIssue) ? (
          <UpdateDialog
            hubUrl={HUB_URL}
            status={updateStatus}
            issue={updateIssue}
            issueCode={updateIssueCode}
            isChecking={isCheckingUpdate}
            onDismiss={() => {
              if (updateStatus) {
                dismissUpdate(updateStatus.latestUpdate.sourceId);
                setUpdateDismissed(true);
              }
              setSelection({ type: 'none' });
            }}
            onOpenSettings={() => setSelection({ type: 'settings' })}
            onRetryCheck={() => {
              void refreshUpdateStatus().then((next) => {
                if (next.status && !next.issue && !next.status.updateAvailable) {
                  setSelection({ type: 'none' });
                }
              });
            }}
            onUpdated={() => {
              setUpdateIssue(null);
              setUpdateIssueCode(null);
              setUpdateStatus((prev) => prev
                ? {
                    ...prev,
                    currentUpdate: prev.latestUpdate,
                    updateAvailable: false,
                  }
                : prev);
              setUpdateDismissed(false);
            }}
          />
        ) : changesSelection && selectedChangesEnv && selectedChangesRepo ? (
          <ChangesView
            key={selectedChangesEnv.slug}
            env={selectedChangesEnv}
            repo={selectedChangesRepo}
            hubUrl={HUB_URL}
            onRecoverEnv={recoverEnv}
            onRecoverEntities={recoverEntities}
          />
        ) : shouldShowSelectedSession && selectedSession ? (
          <SessionView
            session={selectedSession}
            env={selectedSessionEnv}
            hubUrl={HUB_URL}
            onWsMessage={liveMessageRef}
            wsSend={wsRef}
            connected={connected}
            updateLastSeq={updateLastSeq}
            permissions={selectedPermissions}
            onPermissionResolved={handlePermissionResolved}
            onRecoverEnv={recoverEnv}
          />
        ) : planSelection && selectedPlanRepo ? (
          <PlanView
            key={planSelection.repoId}
            repoId={planSelection.repoId}
            repoUrl={selectedPlanRepo.repoUrl}
            repoMainCommit={selectedPlanRepo?.mainCommit ?? null}
            planArtifactId={planSelection.planArtifactId ?? null}
            mainEvent={lastRepoMainEvent}
            chatgptAvailable={setupStatus?.openaiPlannerAvailable ?? true}
            chatgptUnavailableReason={setupStatus?.openaiPlannerReason ?? null}
          />
        ) : waitingEnv ? (
          <EnvWaitingView
            env={waitingEnv}
            hubUrl={HUB_URL}
            onRecoverEnv={recoverEnv}
            onStartRequest={(slug) => setStartDialogSlug(slug)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-[#57606a] text-sm">
            Select a session or create a new environment
          </div>
        )}
      </div>

      {showNewRepo && (
        <NewRepoDialog
          onClose={() => setShowNewRepo(false)}
          hubUrl={HUB_URL}
          repos={repos}
          onCreate={handleCreateRepo}
        />
      )}
      {newEnvTarget && newEnvRepo && (
        <NewEnvDialog
          onClose={() => setNewEnvTarget(null)}
          isLocalDev={isLocalDev}
          deploymentMode={setupStatus?.deploymentMode ?? 'hosted'}
          hostConnected={setupStatus?.hostConnected ?? false}
          hostGatewayAvailable={setupStatus?.hostGatewayAvailable ?? false}
          hasClaudeSubscription={setupStatus?.hasClaudeSubscription ?? false}
          hasAnthropicKey={setupStatus?.hasAnthropicKey ?? false}
          hasChatGPTAuth={setupStatus?.hasChatGPTAuth ?? false}
          hasOpenAIKey={setupStatus?.hasOpenAIKey ?? false}
          workersAiConfigured={setupStatus?.workersAiConfigured ?? false}
          enabledHarnesses={setupStatus?.enabledHarnesses ?? ['claude-code']}
          repo={newEnvRepo}
          onCreate={handleCreateEnv}
        />
      )}
      {startDialogEnv && (
        <StartPlanDialog
          env={startDialogEnv}
          repoMainCommit={startDialogRepo?.mainCommit ?? null}
          hubUrl={HUB_URL}
          onClose={() => setStartDialogSlug(null)}
          onStarted={() => {
            recoverEnv(startDialogEnv.slug);
          }}
        />
      )}
    </div>
  );
}
