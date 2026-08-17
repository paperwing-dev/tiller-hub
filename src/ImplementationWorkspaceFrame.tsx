import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import type { Artifact, PlanAttentionItem } from "../api/coordination/types";
import { useDashboardData } from "./DashboardDataProvider";
import ImplementationsSidebar, {
  implementationDisplayName,
  implementationHasShipTarget,
  implementationHasUnreadUpdate,
  implementationNeedsAttention,
} from "./ImplementationsSidebar";
import ProjectWorkspaceChrome from "./ProjectWorkspaceChrome";
import { ApiActionError, deleteEnv, fetchRepoArtifacts, stopEnv } from "./api";
import { envPath, sessionPath, shipPath } from "./dashboard-paths";
import { canStopEnvStatus, shouldSelectLiveSessionForEnvStatus } from "./env-runtime";
import { listPlanArtifacts } from "./plan-artifacts";
import { pickPrimaryEnvSession } from "./session-attachment";
import { useToast } from "./Toast";
import { useLocation, useNavigate } from "react-router";
import ConfirmationDialog from "./ConfirmationDialog";
import {
  ImplementationWorkspaceProvider,
  type ImplementationWorkspaceContextValue,
} from "./ImplementationWorkspaceContext";

function implementationStatusLabel(status: string): string {
  return status ? `${status.slice(0, 1).toUpperCase()}${status.slice(1)}` : "Unknown";
}

export default function ImplementationWorkspaceFrame({
  repoId,
  selectedEnvSlug = null,
  children,
}: {
  repoId: string;
  selectedEnvSlug?: string | null;
  children: ReactNode;
}) {
  const data = useDashboardData();
  const navigate = useNavigate();
  const location = useLocation();
  const addToast = useToast();
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [planAttention, setPlanAttention] = useState<PlanAttentionItem[]>([]);
  const [stoppingEnvSlug, setStoppingEnvSlug] = useState<string | null>(null);
  const [deletingEnvSlug, setDeletingEnvSlug] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ slug: string; name: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let request = 0;
    const loadArtifacts = () => {
      const currentRequest = ++request;
      return fetchRepoArtifacts(data.hubUrl, repoId)
        .then((next) => {
          if (cancelled || currentRequest !== request) return;
          setArtifacts(next.artifacts);
          setPlanAttention(next.attention ?? []);
        })
        .catch(() => {
          if (cancelled || currentRequest !== request) return;
          setArtifacts([]);
          setPlanAttention([]);
        });
    };
    const handlePlanArtifactHint = (hintRepoId: string) => {
      if (hintRepoId === repoId) void loadArtifacts();
    };

    void loadArtifacts();
    data.planArtifactHintRef.current = handlePlanArtifactHint;
    return () => {
      cancelled = true;
      if (data.planArtifactHintRef.current === handlePlanArtifactHint) {
        data.planArtifactHintRef.current = null;
      }
    };
  }, [data.hubUrl, data.planArtifactHintRef, repoId]);

  const plans = useMemo(() => listPlanArtifacts(artifacts), [artifacts]);
  const activePlanIds = useMemo(() => new Set(plans
    .filter((plan) => plan.status !== "completed" && plan.status !== "archived")
    .map((plan) => plan.id)), [plans]);
  const planAttentionCount = useMemo(() => new Set(planAttention
    .filter((item) => activePlanIds.has(item.planArtifactId))
    .map((item) => item.planArtifactId)).size, [activePlanIds, planAttention]);
  const envs = data.envs.filter((env) => env.repoId === repoId);
  const selectedEnv = selectedEnvSlug
    ? envs.find((env) => env.slug === selectedEnvSlug) ?? null
    : null;
  const implementationName = selectedEnv
    ? implementationDisplayName(selectedEnv, plans)
    : null;
  const attentionCount = envs.filter(implementationNeedsAttention).length;
  const updateCount = envs.filter(implementationHasUnreadUpdate).length;
  const canStop = selectedEnv ? canStopEnvStatus(selectedEnv.status) : false;
  const implementationStopped = selectedEnv?.status === "stopped";
  const hasShipTarget = selectedEnv ? implementationHasShipTarget(selectedEnv) : false;
  const canShip = implementationStopped && hasShipTarget;
  const shipTooltip = !implementationStopped
    ? "Stop this environment before shipping."
    : hasShipTarget
      ? "Review and ship this implementation."
      : "No changes to ship yet.";
  const canDelete = implementationStopped;
  const showingShipView = selectedEnv
    ? location.pathname === shipPath(selectedEnv.slug)
    : false;

  const selectImplementation = (envSlug: string) => {
    const env = envs.find((candidate) => candidate.slug === envSlug) ?? null;
    const session = pickPrimaryEnvSession(data.sessions, envSlug);
    if (session && shouldSelectLiveSessionForEnvStatus(env?.status)) {
      navigate(sessionPath(session.id));
      return;
    }
    navigate(envPath(envSlug));
  };

  const stopImplementation = async () => {
    if (!selectedEnv || !canStop || stoppingEnvSlug) return;
    setStoppingEnvSlug(selectedEnv.slug);
    try {
      const result = await stopEnv(data.hubUrl, selectedEnv.slug);
      data.recoverEnv(selectedEnv.slug, result.status);
    } catch (error) {
      console.error("[tiller] Failed to stop implementation:", error);
      addToast({
        title: "Couldn’t stop implementation",
        body: [
          error instanceof Error ? error.message : "Environment action failed.",
          error instanceof ApiActionError ? error.hint : null,
        ].filter(Boolean).join(" "),
        variant: "error",
      });
    } finally {
      setStoppingEnvSlug(null);
    }
  };

  const deleteImplementation = async () => {
    if (!deleteTarget || deletingEnvSlug) return;
    setDeletingEnvSlug(deleteTarget.slug);
    try {
      await deleteEnv(data.hubUrl, deleteTarget.slug);
      data.recoverEnv(deleteTarget.slug, "deleting");
      setDeleteTarget(null);
    } catch (error) {
      console.error("[tiller] Failed to delete implementation:", error);
      addToast({
        title: "Couldn’t delete implementation",
        body: [
          error instanceof Error ? error.message : "Environment action failed.",
          error instanceof ApiActionError ? error.hint : null,
        ].filter(Boolean).join(" "),
        variant: "error",
      });
    } finally {
      setDeletingEnvSlug(null);
    }
  };

  const contextValue = useMemo<ImplementationWorkspaceContextValue>(() => ({
    selectedEnvSlug: selectedEnv?.slug ?? null,
    implementationName,
  }), [implementationName, selectedEnv?.slug]);

  return (
    <ImplementationWorkspaceProvider value={contextValue}>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <ProjectWorkspaceChrome
          repoId={repoId}
          activeView="implementations"
          planCount={plans.length}
          planUpdateCount={planAttentionCount}
          implementationCount={envs.length}
          implementationAttentionCount={attentionCount}
          implementationUpdateCount={updateCount}
        />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <aside className="tiller-workspace-sidebar-shell flex w-80 shrink-0 border-r border-kumo-line bg-kumo-recessed">
            <ImplementationsSidebar
              repoId={repoId}
              envs={envs}
              plan={null}
              plans={plans}
              selectedEnvSlug={selectedEnvSlug}
              onSelect={selectImplementation}
              onStartFresh={() => data.setNewEnvTarget({ repoId, planChoice: "none" })}
              onStartWithPlan={() => data.setNewEnvTarget({ repoId, planChoice: "specific" })}
            />
          </aside>
          <div className="tiller-plan-implementation-surface flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            {selectedEnv && implementationName && !showingShipView && (
              <div
                data-testid="implementation-workspace-header"
                className="tiller-implementation-workspace-header flex h-12 shrink-0 items-center justify-between gap-4 border-b border-kumo-line bg-kumo-recessed px-4"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <h2 className="min-w-0 truncate text-[13px] font-semibold text-kumo-default" title={implementationName}>
                    {implementationName}
                  </h2>
                  <span className="shrink-0 rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-kumo-subtle">
                    {implementationStatusLabel(selectedEnv.status)}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {canStop && (
                    <button
                      type="button"
                      className="tiller-dialog-button tiller-dialog-button--secondary"
                      onClick={() => void stopImplementation()}
                      disabled={stoppingEnvSlug === selectedEnv.slug}
                    >
                      {stoppingEnvSlug === selectedEnv.slug ? "Stopping…" : "Stop"}
                    </button>
                  )}
                  <Tooltip
                    content={shipTooltip}
                    side="bottom"
                    align="end"
                    delay={250}
                    render={(
                      <span
                        className="inline-flex"
                        tabIndex={canShip ? undefined : 0}
                        aria-label={canShip ? undefined : shipTooltip}
                      />
                    )}
                  >
                    <button
                      type="button"
                      className={`tiller-dialog-button tiller-dialog-button--secondary ${canShip ? "" : "pointer-events-none"}`}
                      onClick={() => navigate(shipPath(selectedEnv.slug))}
                      disabled={!canShip}
                    >
                      Ship
                    </button>
                  </Tooltip>
                  {canDelete && (
                    <button
                      type="button"
                      className="tiller-dialog-button tiller-dialog-button--secondary"
                      onClick={() => setDeleteTarget({
                        slug: selectedEnv.slug,
                        name: implementationName,
                      })}
                      disabled={deletingEnvSlug === selectedEnv.slug}
                      title="Permanently delete this implementation"
                    >
                      {deletingEnvSlug === selectedEnv.slug ? "Deleting…" : "Delete"}
                    </button>
                  )}
                </div>
              </div>
            )}
            {children}
          </div>
        </div>
      </div>
      <ConfirmationDialog
        open={deleteTarget !== null}
        title="Delete implementation?"
        description={deleteTarget
          ? `"${deleteTarget.name}" and its container and R2 storage will be permanently deleted.`
          : ""}
        confirmLabel="Delete implementation"
        busyLabel="Deleting…"
        busy={deletingEnvSlug !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={deleteImplementation}
      />
    </ImplementationWorkspaceProvider>
  );
}
