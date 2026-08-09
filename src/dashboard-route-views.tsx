import { Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { Button } from '@cloudflare/kumo/components/button';
import type { EnvMeta, RepoMeta } from '../api/types';
import { useDashboardData } from './DashboardDataProvider';
import SessionView from './SessionView';
import EnvWaitingView from './EnvWaitingView';
import PlanView from './PlanView';
import ShipView from './ShipView';
import ProjectsHome from './ProjectsHome';
import SettingsPage, { parseAuthConnectIntent } from './SettingsPage';
import RepoSettingsPage from './RepoSettingsPage';
import { isRepoMainReady } from './repo-status';
import { getSessionEnvSlug } from './dashboard-route-scope';
import { RouteLoading } from './dashboard-route-state';
import {
  HomeSettingsFrame,
  StatusActions,
} from './DashboardLayout';
import {
  planPath,
  projectPath,
  shipPath,
} from './dashboard-paths';

export function ProjectsHomeRoute() {
  const data = useDashboardData();
  const navigate = useNavigate();
  const setupStatus = data.setupStatus;
  const onboarding = setupStatus
    ? {
        ...setupStatus.dashboardOnboarding,
        modelReady: setupStatus.modelAuthConfigured,
        machineReady: setupStatus.hostConnected,
      }
    : null;
  return (
    <div className="relative min-h-screen bg-kumo-base">
      <ProjectsHome
        repos={data.repos}
        envs={data.envs}
        hubUrl={data.hubUrl}
        toolbar={<StatusActions />}
        onboarding={onboarding}
        onDismissOnboarding={data.dismissDashboardOnboarding}
        onOpenSettings={() => navigate('/settings')}
        onAddProject={() => data.setShowNewRepo(true)}
        onOpenProject={(repoId) => navigate(projectPath(repoId))}
        onProjectDeleted={data.handleDashboardRepoDeleted}
      />
    </div>
  );
}

export function SettingsRoute() {
  const data = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  if (!data.setupStatus) {
    return <RouteLoading label="Loading settings" />;
  }
  return (
    <HomeSettingsFrame>
      <SettingsPage
        status={data.setupStatus}
        onRefresh={data.refreshSetupStatus}
        onDone={() => navigate('/', { replace: true })}
        authConnectIntent={parseAuthConnectIntent(location.search)}
      />
    </HomeSettingsFrame>
  );
}

export function UpdateRoute() {
  return <ProjectsHomeRoute />;
}

export function ProjectWorkspaceHomeRoute() {
  const data = useDashboardData();
  const navigate = useNavigate();
  const { repoId } = useParams();
  const repo = data.repos.find((candidate) => candidate.repoId === repoId) ?? null;
  if (!repo) return <Navigate to="/" replace />;
  const envs = data.envs.filter((env) => env.repoId === repo.repoId);
  return (
    <ProjectWorkspaceHome
      repo={repo}
      envs={envs}
      onAddEnv={() => data.setNewEnvTarget({ repoId: repo.repoId })}
      onPlan={() => navigate(planPath(repo.repoId))}
    />
  );
}

export function PlanRoute() {
  const data = useDashboardData();
  const { repoId, planArtifactId } = useParams();
  const repo = data.repos.find((candidate) => candidate.repoId === repoId) ?? null;
  if (!repo || !repoId) return <Navigate to="/" replace />;
  return (
    <PlanView
      key={repo.repoId}
      repoId={repo.repoId}
      repoUrl={repo.repoUrl}
      repoMainCommit={repo.mainCommit ?? null}
      planArtifactId={planArtifactId ?? null}
      mainEvent={data.lastRepoMainEvent}
      chatgptAvailable={data.setupStatus?.openaiPlannerAvailable ?? true}
      chatgptUnavailableReason={data.setupStatus?.openaiPlannerReason ?? null}
    />
  );
}

export function RepoSettingsRoute() {
  const data = useDashboardData();
  const navigate = useNavigate();
  const { repoId } = useParams();
  const repo = data.repos.find((candidate) => candidate.repoId === repoId) ?? null;
  if (!repo) return <Navigate to="/" replace />;
  return (
    <RepoSettingsPage
      key={repo.repoId}
      repo={repo}
      onDone={() => navigate(projectPath(repo.repoId))}
    />
  );
}

export function WorkspaceSettingsRoute() {
  const data = useDashboardData();
  const navigate = useNavigate();
  const { repoId } = useParams();
  if (!data.setupStatus) {
    return <RouteLoading label="Loading settings" />;
  }
  if (!repoId) return <Navigate to="/" replace />;
  return (
    <SettingsPage
      status={data.setupStatus}
      onRefresh={data.refreshSetupStatus}
      onDone={() => navigate(projectPath(repoId), { replace: true })}
    />
  );
}

export function EnvWaitingRoute() {
  const data = useDashboardData();
  const { envSlug } = useParams();
  const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
  if (!env) return <Navigate to="/" replace />;
  return (
    <EnvWaitingView
      env={env}
      hubUrl={data.hubUrl}
      onRecoverEnv={data.recoverEnv}
      onStartRequest={(slug) => data.setStartDialogSlug(slug)}
    />
  );
}

export function ShipRoute() {
  const data = useDashboardData();
  const { envSlug } = useParams();
  const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
  const repo = env ? data.repos.find((candidate) => candidate.repoId === env.repoId) ?? null : null;
  if (!env || !repo) return <Navigate to="/" replace />;
  return (
    <ShipView
      key={env.slug}
      env={env}
      repo={repo}
      hubUrl={data.hubUrl}
      onRecoverEnv={data.recoverEnv}
      onRecoverEntities={data.recoverEntities}
    />
  );
}

export function LegacyChangesRoute() {
  const { envSlug } = useParams();
  return envSlug ? <Navigate to={shipPath(envSlug)} replace /> : <Navigate to="/" replace />;
}

export function SessionRoute() {
  const data = useDashboardData();
  const { sessionId } = useParams();
  const session = data.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  if (!session || !sessionId) return <Navigate to="/" replace />;
  const envSlug = getSessionEnvSlug(session, session.id, data.sessionEnvMap);
  const env = envSlug ? data.envs.find((candidate) => candidate.slug === envSlug) ?? null : null;
  const selectedPermissions = data.permissions.get(session.id) || [];
  return (
    <SessionView
      session={session}
      env={env}
      hubUrl={data.hubUrl}
      onWsMessage={data.liveMessageRef}
      onTerminalAck={data.terminalAckRef}
      wsSend={data.wsRef}
      connected={data.connected}
      terminalFastLane={data.terminalFastLane}
      updateLastSeq={data.updateLastSeq}
      permissions={selectedPermissions}
      onPermissionResolved={data.handlePermissionResolved}
      onRecoverEnv={data.recoverEnv}
    />
  );
}

export function ProjectWorkspaceHome({
  repo,
  envs,
  onAddEnv,
  onPlan,
}: {
  repo: RepoMeta;
  envs: EnvMeta[];
  onAddEnv: () => void;
  onPlan: () => void;
}) {
  const repoReady = isRepoMainReady(repo);
  const runningCount = envs.filter((env) => env.status === 'running').length;
  const changedCount = envs.filter((env) => env.branchStatus === 'ready-to-merge' || env.workspaceDirty).length;

  return (
    <div className="flex-1 overflow-auto bg-kumo-base">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-6">
        <div className="border-b border-kumo-line pb-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-widest text-kumo-subtle">Repository</p>
            <h2 className="mt-1 truncate text-lg font-semibold text-kumo-strong">{repo.githubFullName}</h2>
            <a
              href={repo.repoUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-1 block truncate text-xs text-kumo-link hover:underline"
            >
              {repo.repoUrl}
            </a>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <ProjectMetric label="Envs" value={envs.length} />
          <ProjectMetric label="Running" value={runningCount} />
          <ProjectMetric label="Changed" value={changedCount} />
        </div>

        <div className="grid gap-3 md:grid-cols-2">
          <ProjectActionBox
            title="Testing"
            description="Plan and review the next test environment before starting more work."
            actionLabel="Open Plan"
            onAction={onPlan}
            disabled={!repoReady}
          />
          <ProjectActionBox
            title="Add Env"
            description="Create a new isolated environment for implementation, review, or follow-up work."
            actionLabel="Add Env"
            onAction={onAddEnv}
            disabled={!repoReady}
          />
        </div>
      </div>
    </div>
  );
}

export function ProjectMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="border border-kumo-line bg-kumo-recessed p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle">{label}</p>
      <p className="mt-1 text-lg font-semibold text-kumo-strong">{value}</p>
    </div>
  );
}

export function ProjectActionBox({
  title,
  description,
  actionLabel,
  onAction,
  disabled,
}: {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex min-h-36 flex-col justify-between border border-kumo-line bg-kumo-recessed p-4">
      <div>
        <p className="text-sm font-semibold text-kumo-strong">{title}</p>
        <p className="mt-2 text-sm leading-5 text-kumo-subtle">{description}</p>
      </div>
      <div className="mt-4">
        <Button variant="secondary" size="sm" onClick={onAction} disabled={disabled}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
