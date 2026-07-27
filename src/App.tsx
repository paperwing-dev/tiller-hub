import { Navigate } from 'react-router-dom';
import type { RouteObject } from 'react-router-dom';
import DashboardDataProvider from './DashboardDataProvider';
import { EnvGuard, ProjectGuard, SessionGuard } from './dashboard-guards';
import { WorkspaceLayout } from './DashboardLayout';
import {
  EnvWaitingRoute,
  LegacyChangesRoute,
  PlanRoute,
  ProjectWorkspaceHomeRoute,
  ProjectsHomeRoute,
  RepoSettingsRoute,
  SessionRoute,
  ShipRoute,
  SettingsRoute,
  UpdateRoute,
  WorkspaceSettingsRoute,
} from './dashboard-route-views';

export {
  getTopLevelUpdateIssue,
  getUpdateCheckFailure,
  refreshDashboardStateAfterHubConnect,
  useDashboardData,
} from './DashboardDataProvider';

export const dashboardRoutes: RouteObject[] = [
  {
    element: <DashboardDataProvider />,
    children: [
      { index: true, element: <ProjectsHomeRoute /> },
      { path: 'settings', element: <SettingsRoute /> },
      { path: 'update', element: <UpdateRoute /> },
      {
        path: 'projects/:repoId',
        element: (
          <ProjectGuard>
            <WorkspaceLayout />
          </ProjectGuard>
        ),
        children: [
          { index: true, element: <ProjectWorkspaceHomeRoute /> },
          { path: 'plan', element: <PlanRoute /> },
          { path: 'plan/:planArtifactId', element: <PlanRoute /> },
          { path: 'global-settings', element: <WorkspaceSettingsRoute /> },
          { path: 'settings', element: <RepoSettingsRoute /> },
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
          { path: 'ship', element: <ShipRoute /> },
        ],
      },
      {
        path: 'sessions/:sessionId',
        element: (
          <SessionGuard>
            <WorkspaceLayout />
          </SessionGuard>
        ),
        children: [{ index: true, element: <SessionRoute /> }],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];

export default DashboardDataProvider;
