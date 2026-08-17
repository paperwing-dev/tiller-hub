import { Navigate, useLocation, useNavigate, useParams } from "react-router";
import { HomeSettingsFrame } from "./DashboardLayout";
import { useDashboardData } from "./DashboardDataProvider";
import { projectPath, repoSettingsPath } from "./dashboard-paths";
import { RouteLoading } from "./dashboard-route-state";
import SettingsPage from "./SettingsPage";
import { parseAuthConnectIntent } from "./settings-intent";
import WorkspaceSettingsView from "./WorkspaceSettingsView";
import { deleteRepo } from "./api";

function readSettingsReturnTo(state: unknown): string | null {
  if (!state || typeof state !== "object" || !("returnTo" in state)) return null;
  const returnTo = (state as { returnTo?: unknown }).returnTo;
  return typeof returnTo === "string"
    && returnTo.startsWith("/")
    && !returnTo.startsWith("//")
    ? returnTo
    : null;
}

export function SettingsRoute() {
  const data = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = readSettingsReturnTo(location.state);
  if (!data.setupStatus) return <RouteLoading label="Loading settings" />;
  return (
    <HomeSettingsFrame>
      <SettingsPage
        status={data.setupStatus}
        onRefresh={data.refreshSetupStatus}
        onDone={() => {
          if (returnTo) navigate(returnTo, { replace: true });
          else if (location.key !== "default") navigate(-1);
          else navigate("/", { replace: true });
        }}
        authConnectIntent={parseAuthConnectIntent(location.search)}
      />
    </HomeSettingsFrame>
  );
}

export function RepoSettingsRoute() {
  const data = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  const { repoId } = useParams();
  const repo = data.repos.find((candidate) => candidate.repoId === repoId) ?? null;
  const returnTo = readSettingsReturnTo(location.state);
  if (!repo) return <Navigate to="/" replace />;
  if (!data.setupStatus) return <RouteLoading label="Loading settings" />;
  return (
    <WorkspaceSettingsView
      key={repo.repoId}
      repo={repo}
      repos={data.repos}
      status={data.setupStatus}
      activeSection="project"
      onDone={() => {
        if (returnTo) navigate(returnTo, { replace: true });
        else if (location.key !== "default") navigate(-1);
        else navigate(projectPath(repo.repoId), { replace: true });
      }}
      onProjectChange={(nextRepoId) => navigate(repoSettingsPath(nextRepoId), { state: location.state })}
      onRefresh={data.refreshSetupStatus}
      implementationCount={data.envs.filter((env) => env.repoId === repo.repoId).length}
      onRemoveProject={async () => {
        const result = await deleteRepo(data.hubUrl, repo.repoId);
        data.handleDashboardRepoDeleted(result.repoId, result.deletedEnvSlugs);
      }}
    />
  );
}

export function WorkspaceSettingsRoute() {
  const data = useDashboardData();
  const location = useLocation();
  const navigate = useNavigate();
  const { repoId } = useParams();
  if (!data.setupStatus) return <RouteLoading label="Loading settings" />;
  if (!repoId) return <Navigate to="/" replace />;
  const repo = data.repos.find((candidate) => candidate.repoId === repoId) ?? null;
  if (!repo) return <Navigate to="/" replace />;
  const returnTo = readSettingsReturnTo(location.state);
  return (
    <WorkspaceSettingsView
      repo={repo}
      repos={data.repos}
      status={data.setupStatus}
      activeSection="global"
      onRefresh={data.refreshSetupStatus}
      onDone={() => {
        if (returnTo) navigate(returnTo, { replace: true });
        else if (location.key !== "default") navigate(-1);
        else navigate(projectPath(repoId), { replace: true });
      }}
      onProjectChange={() => undefined}
    />
  );
}
