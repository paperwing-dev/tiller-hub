import { Navigate, useParams } from "react-router";
import { useDashboardData } from "./DashboardDataProvider";
import ShipView from "./ShipView";
import ImplementationWorkspaceFrame from "./ImplementationWorkspaceFrame";

export default function ShipRoute() {
  const data = useDashboardData();
  const { envSlug } = useParams();
  const env = data.envs.find((candidate) => candidate.slug === envSlug) ?? null;
  const repo = env ? data.repos.find((candidate) => candidate.repoId === env.repoId) ?? null : null;
  if (!env || !repo) return <Navigate to="/" replace />;
  return (
    <ImplementationWorkspaceFrame repoId={repo.repoId} selectedEnvSlug={env.slug}>
      <ShipView
        key={env.slug}
        env={env}
        repo={repo}
        hubUrl={data.hubUrl}
        onRecoverEnv={data.recoverEnv}
        onRecoverEntities={data.recoverEntities}
      />
    </ImplementationWorkspaceFrame>
  );
}
