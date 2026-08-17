import { useEffect } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router';
import { Button } from '@cloudflare/kumo/components/button';
import type { EnvMeta, RepoMeta } from '../api/types';
import { useDashboardData } from './DashboardDataProvider';
import EnvWaitingView from './EnvWaitingView';
import { isRepoMainReady } from './repo-status';
import { StatusActions } from './DashboardLayout';
import {
  planPath,
  shipPath,
} from './dashboard-paths';
import ImplementationWorkspaceFrame from './ImplementationWorkspaceFrame';
import ProjectWorkspaceChrome from './ProjectWorkspaceChrome';
import { resolveLastProjectId } from './project-selection-storage';
import { RouteLoadError } from './dashboard-route-state';

export function WorkspaceRootRoute() {
  const data = useDashboardData();
  if (data.reposLoadState === 'error') {
    return <RouteLoadError label="Repository load failed" onRetry={() => void data.refreshRepos()} />;
  }
  const repoId = resolveLastProjectId(data.repos.map((repo) => repo.repoId));
  if (repoId) return <Navigate to={planPath(repoId)} replace />;

  return (
    <div className="relative flex h-screen min-h-0 flex-col overflow-hidden bg-kumo-base">
      <div className="absolute right-4 top-0 z-[1200] flex h-16 items-center">
        <StatusActions />
      </div>
      <ProjectWorkspaceChrome
        repoId={null}
        activeView="plans"
        planCount={0}
        implementationCount={0}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside className="tiller-workspace-sidebar-shell flex w-80 shrink-0 flex-col border-r border-kumo-line bg-kumo-recessed">
          <div className="tiller-workspace-sidebar-header flex h-11 shrink-0 items-center border-b border-kumo-line px-3">
            <span className="text-[13px] font-semibold text-kumo-default">Plans</span>
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div className="max-w-sm px-6 text-center">
            <h1 className="text-sm font-semibold text-kumo-default">Add a GitHub repository to get started</h1>
            <p className="mt-2 text-sm leading-6 text-kumo-subtle">
              Choose a repository to use as your first Tiller project.
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="mt-4"
              onClick={() => data.setShowNewRepo(true)}
            >
              Add project
            </Button>
          </div>
        </main>
      </div>
    </div>
  );
}

export function UpdateRoute() {
  const data = useDashboardData();
  useEffect(() => data.setShowUpdate(true), [data.setShowUpdate]);
  return <WorkspaceRootRoute />;
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

export function EnvWaitingRoute() {
  const data = useDashboardData();
  const { envSlug } = useParams();
  const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
  if (!env) return <Navigate to="/" replace />;
  return (
    <ImplementationWorkspaceFrame repoId={env.repoId} selectedEnvSlug={env.slug}>
      <EnvWaitingView
        env={env}
        hubUrl={data.hubUrl}
        onRecoverEnv={data.recoverEnv}
      />
    </ImplementationWorkspaceFrame>
  );
}

export function LegacyChangesRoute() {
  const { envSlug } = useParams();
  return envSlug ? <Navigate to={shipPath(envSlug)} replace /> : <Navigate to="/" replace />;
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
