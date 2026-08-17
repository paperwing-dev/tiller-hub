import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import DashboardDataProvider from './DashboardDataProvider';
import { EnvGuard, ProjectGuard, SessionGuard } from './dashboard-guards';
import { WorkspaceLayout } from './DashboardLayout';
import {
  EnvWaitingRoute,
  LegacyChangesRoute,
  WorkspaceRootRoute,
  UpdateRoute,
} from './dashboard-route-views';
import { RouteLoading } from './dashboard-route-state';

const PlanRoute = lazy(() => import('./dashboard-plan-route'));
const ProjectImplementationsRoute = lazy(() => import('./dashboard-implementations-route'));
const ShipRoute = lazy(() => import('./dashboard-ship-route'));
const SessionRoute = lazy(() => import('./dashboard-session-route'));
const SettingsRoute = lazy(() => import('./dashboard-settings-routes').then((module) => ({
  default: module.SettingsRoute,
})));
const RepoSettingsRoute = lazy(() => import('./dashboard-settings-routes').then((module) => ({
  default: module.RepoSettingsRoute,
})));
const WorkspaceSettingsRoute = lazy(() => import('./dashboard-settings-routes').then((module) => ({
  default: module.WorkspaceSettingsRoute,
})));

function lazyRoute(element: ReactNode, label: string) {
  return <Suspense fallback={<RouteLoading label={label} />}>{element}</Suspense>;
}

export {
  getTopLevelUpdateIssue,
  getUpdateCheckFailure,
  recoverBrowserAuthentication,
  refreshDashboardStateAfterHubConnect,
  useDashboardData,
} from './DashboardDataProvider';

export const dashboardRoutes: RouteObject[] = [
  {
    element: <DashboardDataProvider />,
    children: [
      { index: true, element: <WorkspaceRootRoute /> },
      { path: 'settings', element: lazyRoute(<SettingsRoute />, 'Loading settings') },
      { path: 'update', element: <UpdateRoute /> },
      {
        path: 'projects/:repoId',
        element: (
          <ProjectGuard>
            <WorkspaceLayout />
          </ProjectGuard>
        ),
        children: [
          { index: true, element: lazyRoute(<PlanRoute />, 'Loading Plan') },
          { path: 'plan', element: lazyRoute(<PlanRoute />, 'Loading Plan') },
          { path: 'plan/:planArtifactId', element: lazyRoute(<PlanRoute />, 'Loading Plan') },
          { path: 'implementations', element: lazyRoute(<ProjectImplementationsRoute />, 'Loading implementations') },
          { path: 'global-settings', element: lazyRoute(<WorkspaceSettingsRoute />, 'Loading settings') },
          { path: 'settings', element: lazyRoute(<RepoSettingsRoute />, 'Loading repository settings') },
        ],
      },
      {
        path: 'envs/:envSlug/changes',
        element: <LegacyChangesRoute />,
      },
      {
        path: 'envs/:envSlug',
        element: (
          <EnvGuard>
            <WorkspaceLayout />
          </EnvGuard>
        ),
        children: [
          { index: true, element: <EnvWaitingRoute /> },
          { path: 'ship', element: lazyRoute(<ShipRoute />, 'Loading Ship') },
        ],
      },
      {
        path: 'sessions/:sessionId',
        element: (
          <SessionGuard>
            <WorkspaceLayout />
          </SessionGuard>
        ),
        children: [{ index: true, element: lazyRoute(<SessionRoute />, 'Loading session') }],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

export default DashboardDataProvider;
