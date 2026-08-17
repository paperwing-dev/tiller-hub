import { matchPath } from 'react-router';
import type { StoredSession } from '../api/types';
import { getManagedEnvSlug } from './session-attachment';

export type DashboardRouteScope =
  | { type: 'home' }
  | { type: 'settings' }
  | { type: 'update' }
  | { type: 'project'; repoId: string }
  | { type: 'plan'; repoId: string; planArtifactId: string | null }
  | { type: 'project-implementations'; repoId: string }
  | { type: 'project-global-settings'; repoId: string }
  | { type: 'repo-settings'; repoId: string }
  | { type: 'env'; envSlug: string }
  | { type: 'ship'; envSlug: string }
  | { type: 'session'; sessionId: string }
  | { type: 'unknown' };

export function getSessionEnvSlugFromSession(session: StoredSession): string | null {
  return getManagedEnvSlug(session) ?? (session.tag?.trim() || null);
}

export function getSessionEnvSlug(
  session: StoredSession | null,
  sessionId: string,
  sessionEnvMap: Map<string, string>,
): string | null {
  if (session) {
    return getManagedEnvSlug(session)
      ?? sessionEnvMap.get(session.id)
      ?? (session.tag?.trim() || null);
  }
  return sessionEnvMap.get(sessionId) ?? null;
}

export function resolveActiveEnvironmentSlug(
  scope: DashboardRouteScope,
  sessions: StoredSession[],
  sessionEnvMap: Map<string, string>,
): string | null {
  if (scope.type === 'env' || scope.type === 'ship') {
    return scope.envSlug;
  }
  if (scope.type !== 'session') return null;
  const session = sessions.find((candidate) => candidate.id === scope.sessionId) ?? null;
  return getSessionEnvSlug(session, scope.sessionId, sessionEnvMap);
}

export function getDashboardRouteScope(pathname: string): DashboardRouteScope {
  if (matchPath({ path: '/', end: true }, pathname)) return { type: 'home' };
  if (matchPath({ path: '/settings', end: true }, pathname)) return { type: 'settings' };
  if (matchPath({ path: '/update', end: true }, pathname)) return { type: 'update' };

  const session = matchPath({ path: '/sessions/:sessionId', end: true }, pathname);
  if (session?.params.sessionId) {
    return { type: 'session', sessionId: session.params.sessionId };
  }
  const ship = matchPath({ path: '/envs/:envSlug/ship', end: true }, pathname)
    ?? matchPath({ path: '/envs/:envSlug/changes', end: true }, pathname);
  if (ship?.params.envSlug) {
    return { type: 'ship', envSlug: ship.params.envSlug };
  }
  const env = matchPath({ path: '/envs/:envSlug', end: true }, pathname);
  if (env?.params.envSlug) {
    return { type: 'env', envSlug: env.params.envSlug };
  }
  const planArtifact = matchPath({ path: '/projects/:repoId/plan/:planArtifactId', end: true }, pathname);
  if (planArtifact?.params.repoId) {
    return {
      type: 'plan',
      repoId: planArtifact.params.repoId,
      planArtifactId: planArtifact.params.planArtifactId ?? null,
    };
  }
  const plan = matchPath({ path: '/projects/:repoId/plan', end: true }, pathname);
  if (plan?.params.repoId) {
    return { type: 'plan', repoId: plan.params.repoId, planArtifactId: null };
  }
  const implementations = matchPath({ path: '/projects/:repoId/implementations', end: true }, pathname);
  if (implementations?.params.repoId) {
    return { type: 'project-implementations', repoId: implementations.params.repoId };
  }
  const repoSettings = matchPath({ path: '/projects/:repoId/settings', end: true }, pathname);
  if (repoSettings?.params.repoId) {
    return { type: 'repo-settings', repoId: repoSettings.params.repoId };
  }
  const projectGlobalSettings = matchPath({ path: '/projects/:repoId/global-settings', end: true }, pathname);
  if (projectGlobalSettings?.params.repoId) {
    return { type: 'project-global-settings', repoId: projectGlobalSettings.params.repoId };
  }
  const project = matchPath({ path: '/projects/:repoId', end: true }, pathname);
  if (project?.params.repoId) {
    return { type: 'project', repoId: project.params.repoId };
  }

  return { type: 'unknown' };
}

export function routeTouchesDeletedRepo(
  pathname: string,
  repoId: string,
  deletedEnvSlugs: string[],
  sessionEnvMap: Map<string, string>,
): boolean {
  const scope = getDashboardRouteScope(pathname);
  if (
    (
      scope.type === 'project'
      || scope.type === 'plan'
      || scope.type === 'project-implementations'
      || scope.type === 'project-global-settings'
      || scope.type === 'repo-settings'
    )
    && scope.repoId === repoId
  ) {
    return true;
  }
  return deletedEnvSlugs.some((envSlug) => routeScopeTouchesEnv(scope, envSlug, sessionEnvMap));
}

export function routeTouchesDeletedEnv(
  pathname: string,
  envSlug: string,
  sessionEnvMap: Map<string, string>,
): boolean {
  return routeScopeTouchesEnv(getDashboardRouteScope(pathname), envSlug, sessionEnvMap);
}

function routeScopeTouchesEnv(
  scope: DashboardRouteScope,
  envSlug: string,
  sessionEnvMap: Map<string, string>,
): boolean {
  if ((scope.type === 'env' || scope.type === 'ship') && scope.envSlug === envSlug) {
    return true;
  }
  if (scope.type !== 'session') return false;
  return sessionEnvMap.get(scope.sessionId) === envSlug;
}
