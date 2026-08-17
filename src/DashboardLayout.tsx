import { useEffect, useMemo, useState } from 'react';
import type { ComponentProps, ReactNode } from 'react';
import {
  Navigate,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
} from 'react-router';
import { GearSixIcon } from '@phosphor-icons/react';
import { Button } from '@cloudflare/kumo/components/button';
import { Sidebar, useSidebar } from '@cloudflare/kumo/components/sidebar';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import type { EnvMeta, RepoMeta } from '../api/types';
import { useDashboardData } from './DashboardDataProvider';
import SessionList from './SessionList';
import ConnectionsBadge from './ConnectionsBadge';
import UpdateButton from './UpdateBadge';
import { INSTALLER_MAINTENANCE_URL } from './installer-maintenance';
import { getEnvDisplayName } from './env-display';
import { getEnvAuthBadge, getEnvModelLabel } from './env-harness';
import {
  shouldSelectLiveSessionForEnvStatus,
} from './env-runtime';
import { pickPrimaryEnvSession } from './session-attachment';
import {
  envPath,
  planPath,
  projectGlobalSettingsPath,
  projectPath,
  repoSettingsPath,
  sessionPath,
  shipPath,
} from './dashboard-paths';
import {
  getDashboardRouteScope,
  getSessionEnvSlug,
  resolveActiveEnvironmentSlug,
} from './dashboard-route-scope';
import type { DashboardRouteScope } from './dashboard-route-scope';
import { rememberLastProjectId } from './project-selection-storage';

export function TopLevelPage({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-screen bg-kumo-base">
      <div className="border-b border-kumo-line bg-kumo-recessed px-5 py-3">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-3">
          <div className="min-w-0">
            <h1 className="tiller-wordmark text-base font-semibold text-kumo-strong">Tiller</h1>
          </div>
          <div className="flex items-center gap-2">
            <AccessRenewalAction />
            <StatusActions />
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

export function HomeSettingsFrame({
  children,
  settingsPath = '/settings',
  relatedSettingsPath,
  showUpdate = false,
}: {
  children: ReactNode;
  settingsPath?: string;
  relatedSettingsPath?: string;
  showUpdate?: boolean;
}) {
  const navigate = useNavigate();
  const data = useDashboardData();

  return (
    <main className="flex h-screen min-h-0 flex-col overflow-hidden bg-kumo-base">
      <div data-testid="settings-top-bar" className="flex h-16 shrink-0 items-center border-b border-kumo-line bg-kumo-recessed px-4">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={() => navigate('/')}
              className="tiller-wordmark tiller-plan-brand-wordmark inline-flex h-8 w-fit items-center text-[15px] font-bold leading-none text-kumo-default"
              aria-label="Tiller"
            >
              tiller
            </button>
          </div>
          <div className="flex items-center gap-2">
            {showUpdate && (
              <UpdateButton
                status={data.updateStatus}
                issue={data.updateIssue}
                dismissed={data.updateDismissed}
                isChecking={data.isCheckingUpdate}
                onOpen={() => data.setShowUpdate(true)}
              />
            )}
            <AccessRenewalAction />
            <StatusActions settingsPath={settingsPath} relatedSettingsPath={relatedSettingsPath} />
          </div>
        </div>
      </div>
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col overflow-hidden px-5 py-5">
        <div className="flex min-h-0 flex-1 overflow-hidden border border-kumo-line bg-kumo-recessed">
          {children}
        </div>
      </div>
    </main>
  );
}

export function WorkspaceLayout() {
  const data = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  const activeRepo = useActiveWorkspaceRepo();
  const isLocalDev = data.setupStatus?.isLocalDev ?? false;
  const workspaceRepos = activeRepo ? [activeRepo] : [];
  const workspaceEnvs = activeRepo
    ? data.envs.filter((env) => env.repoId === activeRepo.repoId)
    : [];
  const selected = useWorkspaceSelection();
  const routeScope = useDashboardRouteScope();
  const projectWorkspace = (
    routeScope.type === 'plan'
    || routeScope.type === 'project'
    || routeScope.type === 'project-implementations'
  );
  const implementationWorkspace = (
    routeScope.type === 'env'
    || routeScope.type === 'session'
    || routeScope.type === 'ship'
  );
  const integratedWorkspace = projectWorkspace || implementationWorkspace;
  const settingsWorkspace = (
    routeScope.type === 'project-global-settings'
    || routeScope.type === 'repo-settings'
  );
  const activeEnvironmentSlug = resolveActiveEnvironmentSlug(
    routeScope,
    data.sessions,
    data.sessionEnvMap,
  );
  const workspaceHeaderEnv = activeEnvironmentSlug
    ? data.envs.find((env) => env.slug === activeEnvironmentSlug) ?? null
    : null;
  const workspaceHeaderSummary = workspaceHeaderEnv ? <EnvChromeSummary env={workspaceHeaderEnv} /> : null;
  const settingsReturnTo = `${location.pathname}${location.search}${location.hash}`;

  useEffect(() => {
    if (activeRepo) rememberLastProjectId(activeRepo.repoId);
  }, [activeRepo]);

  if (!activeRepo) return <Navigate to="/" replace />;

  if (settingsWorkspace) {
    return (
      <HomeSettingsFrame
        settingsPath={projectGlobalSettingsPath(activeRepo.repoId)}
        relatedSettingsPath={repoSettingsPath(activeRepo.repoId)}
        showUpdate
      >
        <Outlet />
      </HomeSettingsFrame>
    );
  }

  const handleEnvSelect = (slug: string) => {
    const env = data.envs.find((candidate) => candidate.slug === slug) ?? null;
    const matchingSession = pickPrimaryEnvSession(data.sessions, slug);
    if (matchingSession && shouldSelectLiveSessionForEnvStatus(env?.status)) {
      navigate(sessionPath(matchingSession.id));
      return;
    }
    navigate(envPath(slug));
  };

  return (
    <Sidebar.Provider
      key={integratedWorkspace ? 'integrated-workspace' : 'workspace'}
      contained
      defaultOpen={!integratedWorkspace}
      collapsible="icon"
      resizable={!projectWorkspace}
      defaultWidth={320}
      minWidth={280}
      maxWidth={420}
      className={`h-screen min-h-0 bg-kumo-base ${implementationWorkspace ? 'tiller-implementation-workspace' : ''}`}
    >
      {integratedWorkspace && (
        <div className="absolute right-4 top-0 z-[1200] flex h-16 items-center gap-1.5">
          <UpdateButton
            status={data.updateStatus}
            issue={data.updateIssue}
            dismissed={data.updateDismissed}
            isChecking={data.isCheckingUpdate}
            onOpen={() => data.setShowUpdate(true)}
          />
          <AccessRenewalAction />
          <StatusActions
            settingsPath={projectGlobalSettingsPath(activeRepo.repoId)}
            relatedSettingsPath={repoSettingsPath(activeRepo.repoId)}
          />
        </div>
      )}
      {!integratedWorkspace && (
      <Sidebar contentClassName="overflow-x-hidden bg-kumo-recessed">
        <Sidebar.Header className="relative z-[900] h-12 overflow-visible border-b border-kumo-line px-3 py-2 group-data-[state=collapsed]/sidebar:px-0">
          <div className="flex min-w-0 flex-1 items-center justify-between gap-3 group-data-[state=collapsed]/sidebar:w-full group-data-[state=collapsed]/sidebar:justify-center">
            <div className="min-w-0 group-data-[state=collapsed]/sidebar:w-full group-data-[state=collapsed]/sidebar:min-w-0">
              <button
                type="button"
                onClick={() => navigate('/')}
                className="flex min-w-0 cursor-pointer items-center gap-2 text-xs font-semibold uppercase tracking-widest text-kumo-subtle hover:text-kumo-default group-data-[state=collapsed]/sidebar:mx-auto group-data-[state=collapsed]/sidebar:h-10 group-data-[state=collapsed]/sidebar:w-10 group-data-[state=collapsed]/sidebar:min-w-10 group-data-[state=collapsed]/sidebar:justify-center"
                title="Tiller"
                aria-label="Tiller"
              >
                <span
                  aria-hidden="true"
                  className="hidden size-9 shrink-0 items-center justify-center text-base font-bold normal-case tracking-normal group-data-[state=collapsed]/sidebar:flex"
                >
                  T
                </span>
                <span className="tiller-sidebar-open-text group-data-[state=collapsed]/sidebar:hidden">Tiller</span>
              </button>
            </div>
            <div className="tiller-sidebar-open-text flex shrink-0 items-center gap-2 group-data-[state=collapsed]/sidebar:hidden">
              <UpdateButton
                status={data.updateStatus}
                issue={data.updateIssue}
                dismissed={data.updateDismissed}
                isChecking={data.isCheckingUpdate}
                onOpen={() => data.setShowUpdate(true)}
              />
              <AccessRenewalAction />
            </div>
          </div>
        </Sidebar.Header>
        <Sidebar.Content>
          <SidebarSessionList
            repos={workspaceRepos}
            sessions={data.sessions}
            envs={workspaceEnvs}
            hubUrl={data.hubUrl}
            onRecoverEnv={data.recoverEnv}
            onEnvSelect={handleEnvSelect}
            activeEnvironmentSlug={activeEnvironmentSlug}
            onShipSelect={(envSlug) => navigate(shipPath(envSlug))}
            onRepoHomeSelect={(repoId) => navigate(projectPath(repoId))}
            onPlanSelect={(repoId, planArtifactId) => navigate(planPath(repoId, planArtifactId))}
            selectedRepoId={selected.repoId}
            repoSettingsRepoId={selected.repoSettingsRepoId}
            onStartRequest={(slug) => navigate(envPath(slug))}
            onAddEnv={(repoId) => data.setNewEnvTarget({ repoId })}
            onRetryRepoMain={(repoId) => {
              void data.handleRetryRepoMain(repoId);
            }}
          />
        </Sidebar.Content>
        <div className="hidden border-t border-kumo-line px-2 py-2 group-data-[state=collapsed]/sidebar:flex group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:px-0">
          <button
            type="button"
            onClick={() => navigate(repoSettingsPath(activeRepo.repoId), { state: { returnTo: settingsReturnTo } })}
            className={`inline-flex h-8 w-8 items-center justify-center rounded transition-colors group-data-[state=collapsed]/sidebar:h-9 group-data-[state=collapsed]/sidebar:w-9 ${
              selected.repoSettingsRepoId === activeRepo.repoId
                ? 'bg-kumo-info-tint text-kumo-link'
                : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
            }`}
            title="Repo Settings"
            aria-label="Repo Settings"
            aria-current={selected.repoSettingsRepoId === activeRepo.repoId ? 'page' : undefined}
          >
            <GearSixIcon className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <Sidebar.Footer className="border-t border-kumo-line px-2 py-2 group-data-[state=collapsed]/sidebar:border-t-0 group-data-[state=collapsed]/sidebar:px-0 group-data-[state=collapsed]/sidebar:pb-2 group-data-[state=collapsed]/sidebar:pt-0">
          <div className="flex w-full items-center justify-between gap-2 group-data-[state=collapsed]/sidebar:hidden">
            <button
              type="button"
              onClick={() => navigate(repoSettingsPath(activeRepo.repoId), { state: { returnTo: settingsReturnTo } })}
              className={`inline-flex h-8 min-w-0 flex-1 items-center gap-2 rounded px-2 text-xs font-medium transition-colors ${
                selected.repoSettingsRepoId === activeRepo.repoId
                  ? 'bg-kumo-info-tint text-kumo-link'
                  : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
              }`}
              title="Repo Settings"
              aria-label="Repo Settings"
              aria-current={selected.repoSettingsRepoId === activeRepo.repoId ? 'page' : undefined}
            >
              <GearSixIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span className="tiller-sidebar-open-text truncate">Repo Settings</span>
            </button>
            <Sidebar.Trigger aria-label="Toggle navigation" />
          </div>
          <div className="hidden w-full justify-center group-data-[state=collapsed]/sidebar:flex">
            <Sidebar.Trigger aria-label="Toggle navigation" />
          </div>
        </Sidebar.Footer>
        <Sidebar.ResizeHandle aria-label="Resize navigation" />
      </Sidebar>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {!integratedWorkspace && (
        <div className="flex h-12 items-center justify-between gap-3 border-b border-kumo-line bg-kumo-recessed px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Sidebar.Trigger aria-label="Toggle navigation" />
            <div className="min-w-0">{workspaceHeaderSummary}</div>
          </div>
          <StatusActions
            settingsPath={projectGlobalSettingsPath(activeRepo.repoId)}
            relatedSettingsPath={repoSettingsPath(activeRepo.repoId)}
          />
        </div>
        )}
        {data.reconnectExhausted && !data.connected && (
          <div className="bg-kumo-danger-tint border-b border-kumo-danger/30 px-4 py-2 flex items-center justify-between">
            <span className="text-sm text-kumo-danger">Connection lost</span>
            <Button variant="destructive" size="xs" onClick={data.handleReconnect}>
              Reconnect
            </Button>
          </div>
        )}
        {!isLocalDev && data.setupStatus && data.setupStatus.protectionMode === 'public' && (
          <div className="border-b border-kumo-warning/40 bg-kumo-warning-tint px-4 py-2 flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-kumo-default">This hub is publicly accessible.</p>
              <p className="text-xs text-kumo-subtle">
                Open Settings to finish Cloudflare Access for this workers.dev Hub.
              </p>
            </div>
            <button
              onClick={() => navigate(projectGlobalSettingsPath(activeRepo.repoId), { state: { returnTo: settingsReturnTo } })}
              className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
            >
              Open settings
            </button>
          </div>
        )}
        <Outlet />
      </div>
    </Sidebar.Provider>
  );
}

export function StatusActions({
  settingsPath = '/settings',
  relatedSettingsPath,
}: {
  settingsPath?: string;
  relatedSettingsPath?: string;
}) {
  const data = useDashboardData();
  const location = useLocation();
  const [settingsTooltipOpen, setSettingsTooltipOpen] = useState(false);
  const settingsActive = location.pathname === settingsPath || location.pathname === relatedSettingsPath;
  const existingReturnTo = location.state && typeof location.state === "object" && "returnTo" in location.state
    ? (location.state as { returnTo?: unknown }).returnTo
    : null;
  const returnTo = typeof existingReturnTo === "string"
    ? existingReturnTo
    : settingsActive
      ? null
      : `${location.pathname}${location.search}${location.hash}`;
  return (
    <div className="inline-flex items-center gap-1.5">
      <ConnectionsBadge
        hubUrl={data.hubUrl}
        hubConnected={data.connected}
        hostRefreshNonce={data.hostRefreshNonce}
        showHost={Boolean(data.setupStatus?.hostRegistered)}
      />
      <span
        className="relative z-[1000] inline-flex"
        onMouseEnter={() => setSettingsTooltipOpen(true)}
        onMouseLeave={() => setSettingsTooltipOpen(false)}
        onFocus={() => setSettingsTooltipOpen(true)}
        onBlur={() => setSettingsTooltipOpen(false)}
      >
        <NavLink
          to={settingsPath}
          state={returnTo ? { returnTo } : undefined}
          end
          className={({ isActive }) => `inline-flex h-7 w-7 items-center justify-center rounded-none leading-none transition-colors ${
            isActive || settingsActive
              ? 'bg-kumo-info-tint text-kumo-link'
              : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default'
          }`}
          aria-label="Settings"
          aria-current={settingsActive ? 'page' : undefined}
        >
          <GearSixIcon className="h-4 w-4" aria-hidden="true" />
        </NavLink>
        {settingsTooltipOpen && (
          <span className="pointer-events-none absolute right-0 top-full z-[1001] mt-1 w-max rounded-md border border-kumo-line bg-kumo-elevated px-2 py-1 text-xs font-medium text-kumo-default shadow-lg">
            Settings
          </span>
        )}
      </span>
    </div>
  );
}

export function AccessRenewalAction() {
  const data = useDashboardData();
  if (!data.setupStatus?.renewalRecommended) return null;

  const accessExpiration = data.setupStatus.tokenExpiresAt ?? 'an unknown date';
  const parsedAccessExpiration = Date.parse(accessExpiration);
  const formattedAccessExpiration = Number.isFinite(parsedAccessExpiration)
    ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(parsedAccessExpiration))
    : accessExpiration;

  return (
    <Tooltip
      content={`Cloudflare Access expires ${formattedAccessExpiration}. Renew to keep existing CLI, machine, and workload connections active. Updating Tiller also renews Access.`}
      side="bottom"
      align="end"
      delay={250}
      render={(
        <a
          href={`${INSTALLER_MAINTENANCE_URL}?intent=renew`}
          className="inline-flex h-6 items-center rounded border border-kumo-warning/40 bg-kumo-warning-tint px-2 text-[10px] font-medium uppercase tracking-wide text-kumo-warning transition-colors hover:bg-kumo-tint"
        />
      )}
    >
      Renew access
    </Tooltip>
  );
}

export function useDashboardRouteScope(): DashboardRouteScope {
  const location = useLocation();
  return useMemo(() => getDashboardRouteScope(location.pathname), [location.pathname]);
}

export function useActiveWorkspaceRepo(): RepoMeta | null {
  const data = useDashboardData();
  const scope = useDashboardRouteScope();

  if (
    scope.type === 'project'
    || scope.type === 'plan'
    || scope.type === 'project-implementations'
    || scope.type === 'project-global-settings'
    || scope.type === 'repo-settings'
  ) {
    return data.repos.find((repo) => repo.repoId === scope.repoId) ?? null;
  }
  if (scope.type === 'env' || scope.type === 'ship') {
    const env = data.envs.find((candidate) => candidate.slug === scope.envSlug) ?? null;
    return env ? data.repos.find((repo) => repo.repoId === env.repoId) ?? null : null;
  }
  if (scope.type === 'session') {
    const session = data.sessions.find((candidate) => candidate.id === scope.sessionId) ?? null;
    const slug = getSessionEnvSlug(session, scope.sessionId, data.sessionEnvMap);
    const env = slug ? data.envs.find((candidate) => candidate.slug === slug) ?? null : null;
    return env ? data.repos.find((repo) => repo.repoId === env.repoId) ?? null : null;
  }
  return null;
}

export function useWorkspaceSelection(): {
  repoId: string | null;
  repoSettingsRepoId: string | null;
} {
  const scope = useDashboardRouteScope();
  return {
    repoId: scope.type === 'project' || scope.type === 'plan' || scope.type === 'project-implementations' || scope.type === 'repo-settings'
      ? scope.repoId
      : null,
    repoSettingsRepoId: scope.type === 'repo-settings' ? scope.repoId : null,
  };
}

export function SidebarSessionList(props: ComponentProps<typeof SessionList>) {
  const { state } = useSidebar();
  return <SessionList {...props} sidebarCollapsed={state === 'collapsed'} />;
}

export function EnvChromeSummary({ env }: { env: EnvMeta }) {
  const authBadge = getEnvAuthBadge(env);
  const status = formatEnvStatus(env.status);
  const model = getEnvModelLabel(env);

  return (
    <div className="inline-flex min-w-0 items-center gap-1.5">
      <span className="max-w-24 truncate text-xs font-semibold text-kumo-default">
        {getEnvDisplayName(env)}
      </span>
      <span className="rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
        {status}
      </span>
      {authBadge && (
        <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${authBadge.className}`}>
          {authBadge.label}
        </span>
      )}
      {model && (
        <span className="rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] font-medium text-kumo-subtle">
          {model}
        </span>
      )}
    </div>
  );
}

function formatEnvStatus(status: EnvMeta['status']): string {
  if (status === 'running') return 'Running';
  if (status === 'starting') return 'Starting';
  if (status === 'stopping') return 'Stopping';
  if (status === 'saving') return 'Saving';
  if (status === 'creating') return 'Creating';
  if (status === 'deleting') return 'Deleting';
  if (status === 'stopped') return 'Stopped';
  if (status === 'failed') return 'Failed';
  return 'Unknown';
}
