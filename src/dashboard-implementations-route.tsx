import { Navigate, useParams } from "react-router";
import { useDashboardData } from "./DashboardDataProvider";
import ImplementationWorkspaceFrame from "./ImplementationWorkspaceFrame";
import {
  implementationHasUnreadUpdate,
  implementationNeedsAttention,
} from "./ImplementationsSidebar";
import { WorkspaceSignal } from "./WorkspaceMetadata";
import { Button } from "@cloudflare/kumo/components/button";

export default function ProjectImplementationsRoute() {
  const data = useDashboardData();
  const { repoId } = useParams();
  const repo = data.repos.find((candidate) => candidate.repoId === repoId) ?? null;
  if (!repo || !repoId) return <Navigate to="/" replace />;

  const envs = data.envs.filter((env) => env.repoId === repoId);
  const attentionCount = envs.filter(implementationNeedsAttention).length;
  const updateCount = envs.filter(implementationHasUnreadUpdate).length;
  const runningCount = envs.filter((env) => env.status === "running").length;

  if (envs.length === 0) {
    return (
      <ImplementationWorkspaceFrame repoId={repoId}>
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <div className="max-w-sm px-6 text-center">
            <h1 className="text-sm font-semibold text-kumo-default">Start your first implementation</h1>
            <p className="mt-2 text-sm leading-6 text-kumo-subtle">
              Create an isolated workspace and start working on this project.
            </p>
            <Button
              type="button"
              variant="primary"
              size="sm"
              className="mt-4"
              onClick={() => data.setNewEnvTarget({ repoId, planChoice: "none" })}
            >
              Start implementation
            </Button>
          </div>
        </div>
      </ImplementationWorkspaceFrame>
    );
  }

  return (
    <ImplementationWorkspaceFrame repoId={repoId}>
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <div className="max-w-sm px-6 text-center">
          <p className="text-sm font-semibold text-kumo-default">Implementation workspace</p>
          <p className="mt-2 text-sm leading-6 text-kumo-subtle">
            Select an implementation from the sidebar to open its workspace.
          </p>
          <div className="mt-5 flex justify-center gap-5 font-mono text-[11px] tabular-nums text-kumo-default">
            <span>{envs.length} total</span>
            <span>{runningCount} running</span>
            {updateCount > 0 && (
              <span className="flex items-center gap-1">
                <WorkspaceSignal
                  kind="update"
                  label={`${updateCount} ${updateCount === 1 ? "implementation is" : "implementations are"} waiting for you`}
                />
                {updateCount} waiting
              </span>
            )}
            {attentionCount > 0 && (
              <span className="flex items-center gap-1">
                <WorkspaceSignal
                  kind="warning"
                  label={`${attentionCount} ${attentionCount === 1 ? "implementation needs" : "implementations need"} attention`}
                />
                {attentionCount} needs attention
              </span>
            )}
          </div>
        </div>
      </div>
    </ImplementationWorkspaceFrame>
  );
}
