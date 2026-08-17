import { Navigate, useParams } from "react-router";
import { useDashboardData } from "./DashboardDataProvider";
import { getSessionEnvSlug } from "./dashboard-route-scope";
import SessionView from "./SessionView";
import ImplementationWorkspaceFrame from "./ImplementationWorkspaceFrame";

export default function SessionRoute() {
  const data = useDashboardData();
  const { sessionId } = useParams();
  const session = data.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  if (!session || !sessionId) return <Navigate to="/" replace />;
  const envSlug = getSessionEnvSlug(session, session.id, data.sessionEnvMap);
  const env = envSlug ? data.envs.find((candidate) => candidate.slug === envSlug) ?? null : null;
  if (!env) return <Navigate to="/" replace />;
  return (
    <ImplementationWorkspaceFrame repoId={env.repoId} selectedEnvSlug={env.slug}>
      <SessionView
        session={session}
        env={env}
        hubUrl={data.hubUrl}
        onWsMessage={data.liveMessageRef}
        onTerminalAck={data.terminalAckRef}
        wsSend={data.wsRef}
        connected={data.connected}
        terminalFastLane={data.terminalFastLane}
        terminalMetrics={data.terminalMetrics}
        updateLastSeq={data.updateLastSeq}
        permissions={data.permissions.get(session.id) || []}
        onPermissionResolved={data.handlePermissionResolved}
        onRecoverEnv={data.recoverEnv}
      />
    </ImplementationWorkspaceFrame>
  );
}
