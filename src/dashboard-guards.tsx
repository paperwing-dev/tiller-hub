import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, useLocation, useParams } from 'react-router';
import type { DashboardData } from './DashboardDataProvider';
import { useDashboardData } from './DashboardDataProvider';
import { RouteLoading, RouteLoadError } from './dashboard-route-state';
import { getDashboardRouteScope, getSessionEnvSlug } from './dashboard-route-scope';
import {
  shouldShowEnvWaitingViewForStatus,
  shouldSelectLiveSessionForEnvStatus,
} from './env-runtime';
import { pickPrimaryEnvSession } from './session-attachment';
import {
  envPath,
  projectImplementationsPath,
  sessionPath,
} from './dashboard-paths';

export function ProjectGuard({ children }: { children: ReactNode }) {
  const { repoId } = useParams();
  const data = useDashboardData();
  if (!repoId) return <Navigate to="/" replace />;
  if (data.reposLoadState === 'idle' || data.reposLoadState === 'loading') {
    return <RouteLoading label="Loading repository" />;
  }
  if (data.reposLoadState === 'error') {
    return <RouteLoadError label="Repository load failed" onRetry={() => void data.refreshRepos()} />;
  }
  if (!data.repos.some((repo) => repo.repoId === repoId)) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export function EnvGuard({ children }: { children: ReactNode }) {
  const { envSlug } = useParams();
  const location = useLocation();
  const data = useDashboardData();
  const scope = getDashboardRouteScope(location.pathname);
  if (!envSlug) return <Navigate to="/" replace />;
  if (data.envsLoadState === 'idle' || data.envsLoadState === 'loading') {
    return <RouteLoading label="Loading environment" />;
  }
  if (data.envsLoadState === 'error') {
    return <RouteLoadError label="Environment load failed" onRetry={() => void data.refreshEnvs()} />;
  }
  const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
  if (!env) {
    const repoId = data.getKnownEnvRepoId(envSlug);
    return <Navigate to={repoId ? projectImplementationsPath(repoId) : '/'} replace />;
  }
  const repoGate = workspaceRepoGate(data, env.repoId);
  if (repoGate) return <>{repoGate}</>;
  return (
    <EnvLiveSessionGate data={data} env={env} scope={scope}>
      {children}
    </EnvLiveSessionGate>
  );
}

function EnvLiveSessionGate({
  children,
  data,
  env,
  scope,
}: {
  children: ReactNode;
  data: DashboardData;
  env: { slug: string; status?: string | null; updatedAt?: string | null };
  scope: ReturnType<typeof getDashboardRouteScope>;
}) {
  const maxLookupAttempts = 3;
  const [lookupAttempts, setLookupAttempts] = useState(0);
  const primarySession = pickPrimaryEnvSession(data.sessions, env.slug);
  const shouldOpenLiveSession = scope.type === 'env' && shouldSelectLiveSessionForEnvStatus(env.status);
  const lookupKey = `${env.slug}:${env.status ?? ''}:${env.updatedAt ?? ''}`;
  const refreshSessions = data.refreshSessions;
  const refreshEnvs = data.refreshEnvs;
  const sessionsLoadState = data.sessionsLoadState;

  useEffect(() => {
    setLookupAttempts(0);
  }, [lookupKey]);

  useEffect(() => {
    if (!shouldOpenLiveSession || primarySession || sessionsLoadState !== 'loaded') return;
    if (lookupAttempts >= maxLookupAttempts) return;

    const timer = window.setTimeout(() => {
      setLookupAttempts((attempts) => attempts + 1);
      if (lookupAttempts === maxLookupAttempts - 1) {
        // A running lifecycle with no lead session can mean Cloudflare
        // replaced the container without delivering its final status hook.
        // The authoritative env refresh performs a fresh runner inspection
        // and turns that stale running state into a restartable failure.
        void Promise.all([refreshSessions(), refreshEnvs()]);
      } else {
        void refreshSessions();
      }
    }, lookupAttempts === 0 ? 0 : 1000);

    return () => window.clearTimeout(timer);
  }, [
    lookupAttempts,
    primarySession,
    refreshEnvs,
    refreshSessions,
    sessionsLoadState,
    shouldOpenLiveSession,
  ]);

  if (shouldOpenLiveSession && primarySession) {
    return <Navigate to={sessionPath(primarySession.id)} replace />;
  }

  if (shouldOpenLiveSession) {
    if (sessionsLoadState === 'error') {
      return <RouteLoadError label="Harness load failed" onRetry={() => void refreshSessions()} />;
    }
    // Keep the implementation workspace and its detailed startup progress on
    // screen while the lead session connects. Replacing it with a route-wide
    // spinner makes the normal creating -> starting transition look like a
    // full page reload.
  }

  return <>{children}</>;
}

export function SessionGuard({ children }: { children: ReactNode }) {
  const { sessionId } = useParams();
  const data = useDashboardData();
  if (!sessionId) return <Navigate to="/" replace />;

  if (data.sessionsLoadState === 'idle' || data.sessionsLoadState === 'loading') {
    return <RouteLoading label="Loading session" />;
  }
  if (data.sessionsLoadState === 'error') {
    return <RouteLoadError label="Session load failed" onRetry={() => void data.refreshSessions()} />;
  }

  const session = data.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  const envSlug = getSessionEnvSlug(session, sessionId, data.sessionEnvMap);
  if (!session) {
    if (!envSlug) return <Navigate to="/" replace />;
    if (data.envsLoadState === 'idle' || data.envsLoadState === 'loading') {
      return <RouteLoading label="Finding session environment" />;
    }
    if (data.envsLoadState === 'error') {
      return <RouteLoadError label="Environment load failed" onRetry={() => void data.refreshEnvs()} />;
    }
    const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
    if (env) {
      const repoGate = workspaceRepoGate(data, env.repoId);
      if (repoGate) return <>{repoGate}</>;
    }
    return <Navigate to={env ? envPath(env.slug) : '/'} replace />;
  }

  if (!envSlug) return <Navigate to="/" replace />;
  if (data.envsLoadState === 'idle' || data.envsLoadState === 'loading') {
    return <RouteLoading label="Loading session environment" />;
  }
  if (data.envsLoadState === 'error') {
    return <RouteLoadError label="Environment load failed" onRetry={() => void data.refreshEnvs()} />;
  }
  const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
  if (!env) return <Navigate to="/" replace />;
  const repoGate = workspaceRepoGate(data, env.repoId);
  if (repoGate) return <>{repoGate}</>;
  if (shouldShowEnvWaitingViewForStatus(env.status)) {
    return <Navigate to={envPath(env.slug)} replace />;
  }
  return <>{children}</>;
}

export function workspaceRepoGate(data: DashboardData, repoId: string): ReactNode | null {
  if (data.reposLoadState === 'idle' || data.reposLoadState === 'loading') {
    return <RouteLoading label="Loading repository" />;
  }
  if (data.reposLoadState === 'error') {
    return <RouteLoadError label="Repository load failed" onRetry={() => void data.refreshRepos()} />;
  }
  if (!data.repos.some((repo) => repo.repoId === repoId)) {
    return <Navigate to="/" replace />;
  }
  return null;
}
