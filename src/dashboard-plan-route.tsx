import { Navigate, useParams } from "react-router";
import { useDashboardData } from "./DashboardDataProvider";
import PlanView from "./PlanView";

export default function PlanRoute() {
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
