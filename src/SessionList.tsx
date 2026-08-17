import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { PlusIcon, TrashIcon } from "@phosphor-icons/react";
import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Popover } from "@cloudflare/kumo/components/popover";
import { Tooltip } from "@cloudflare/kumo/components/tooltip";
import type { StoredSession, EnvMeta, RepoMeta } from "../api/types";
import { ApiActionError, cancelScheduledRun, deleteEnv, fetchRepoArtifacts, stopEnv } from "./api";
import { planPath } from "./dashboard-paths";
import { getDisplayEnvBranchStatus } from "./env-state";
import {
  getHarnessBadgeClass,
  getHarnessBadgeLabel,
} from "./env-harness";
import {
  EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
  getBackendBadgeLabel,
  getEnvDisplayName,
} from "./env-display";
import { canStopEnvStatus, isEnvRunningStatus } from "./env-runtime";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";
import { listPlanArtifacts } from "./plan-artifacts";
import ConfirmationDialog from "./ConfirmationDialog";

interface SessionListProps {
  repos: RepoMeta[];
  sessions: StoredSession[];
  envs?: EnvMeta[];
  hubUrl?: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onEnvSelect?: (slug: string) => void;
  activeEnvironmentSlug?: string | null;
  onShipSelect?: (slug: string) => void;
  onPlanSelect?: (repoId: string, planArtifactId?: string | null) => void;
  planRepoId?: string | null;
  selectedRepoId?: string | null;
  repoSettingsRepoId?: string | null;
  onStartRequest?: (slug: string) => void;
  onAddEnv?: (repoId: string) => void;
  onRetryRepoMain?: (repoId: string) => void;
  sidebarCollapsed?: boolean;
  onRepoHomeSelect?: (repoId: string) => void;
}

export default function SessionList({
  repos,
  sessions,
  envs = [],
  hubUrl = "",
  onRecoverEnv,
  onEnvSelect,
  activeEnvironmentSlug,
  onShipSelect,
  onPlanSelect,
  planRepoId,
  selectedRepoId,
  repoSettingsRepoId,
  onStartRequest,
  onAddEnv,
  onRetryRepoMain,
  sidebarCollapsed = false,
  onRepoHomeSelect,
}: SessionListProps) {
  const [planLabels, setPlanLabels] = useState<Record<string, string>>({});
  const fetchedPlanRepoIdsRef = useRef<Set<string>>(new Set());

  const repoGroups = repos.map((repo) => ({
    repo,
    envs: envs.filter((env) => matchesRepo(repo, env)),
  }));

  useEffect(() => {
    fetchedPlanRepoIdsRef.current = new Set();
    setPlanLabels({});
  }, [hubUrl]);

  useEffect(() => {
    if (!hubUrl) return;
    const repoIds = Array.from(new Set(
      envs
        .filter((env) => !!env.startupPlanId && !!env.repoId)
        .map((env) => env.repoId),
    ));
    for (const repoId of repoIds) {
      if (fetchedPlanRepoIdsRef.current.has(repoId)) continue;
      fetchedPlanRepoIdsRef.current.add(repoId);
      void fetchRepoArtifacts(hubUrl, repoId)
        .then((state) => {
          const labels: Record<string, string> = {};
          for (const plan of listPlanArtifacts(state.artifacts)) {
            labels[planLabelCacheKey(repoId, plan.id)] = plan.title || "Untitled plan";
          }
          setPlanLabels((current) => ({ ...current, ...labels }));
        })
        .catch(() => {
          // Keep rendering the fallback label when plan artifacts are unavailable.
        });
    }
  }, [envs, hubUrl]);

  return (
    <div className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden">
      {repoGroups.map(({ repo, envs: repoEnvs }) => (
        <div key={repo.repoId} className="min-w-0 max-w-full overflow-x-hidden border-b border-kumo-line">
          {!sidebarCollapsed && (
            <RepoGroupHeader
              repo={repo}
              onPlanSelect={onPlanSelect}
              onRetryRepoMain={onRetryRepoMain}
              onRepoHomeSelect={onRepoHomeSelect}
              planSelected={planRepoId === repo.repoId}
            />
          )}
          <div>
            {!sidebarCollapsed && (
              <div className="flex items-center gap-3 border-b border-kumo-line bg-kumo-base px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <h2 className="truncate text-xs font-semibold text-kumo-strong">Implementor Environments</h2>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  icon={PlusIcon}
                  onClick={() => onAddEnv?.(repo.repoId)}
                  disabled={!isRepoMainReady(repo)}
                  aria-label="Add implementor environment"
                  className="shrink-0"
                >
                  Add
                </Button>
              </div>
            )}
            {repoEnvs.length === 0 ? (
              !sidebarCollapsed && (
                isRepoMainReady(repo) ? (
                  <div className="min-w-0 p-2.5">
                    <button
                      type="button"
                      onClick={() => onAddEnv?.(repo.repoId)}
                      aria-label="Add the first implementor environment"
                      className="flex min-w-0 w-full items-start gap-3 overflow-hidden rounded border border-dashed border-kumo-info/50 bg-kumo-info/5 px-3 py-3 text-left transition-colors hover:border-kumo-info hover:bg-kumo-info/10"
                    >
                      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-kumo-info/15 text-lg font-medium text-kumo-info">+</span>
                      <span className="min-w-0 flex-1">
                        <span className="block whitespace-normal break-words text-xs font-semibold leading-4 text-kumo-strong">Add an implementor environment</span>
                        <span className="mt-0.5 block whitespace-normal break-words text-[11px] leading-4 text-kumo-subtle">Create the first environment where an agent can implement this plan.</span>
                      </span>
                    </button>
                  </div>
                ) : null
              )
            ) : (
              repoEnvs
                .sort(compareSidebarOrder)
                .map((env) => (
                  <EnvCard
                    key={env.slug}
                    env={env}
                    repo={repo}
                    hubUrl={hubUrl}
                    onRecoverEnv={onRecoverEnv}
                    onSelect={(slug) => onEnvSelect?.(slug)}
                    onStartRequest={onStartRequest}
                    selected={activeEnvironmentSlug === env.slug}
                    onShipSelect={onShipSelect}
                    onPlanSelect={onPlanSelect}
                    planLabel={getEnvPlanLabel(env, repo, planLabels)}
                    sidebarCollapsed={sidebarCollapsed}
                  />
                ))
            )}
          </div>
        </div>
      ))}

      {!sidebarCollapsed && repos.length === 0 && sessions.length === 0 && (
        <p className="tiller-sidebar-open-text p-3 text-sm text-kumo-subtle whitespace-normal tiller-sidebar-wrap">No repositories yet</p>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-kumo-success",
  starting: "bg-kumo-warning animate-pulse",
  saving: "bg-kumo-warning animate-pulse",
  stopping: "bg-kumo-warning animate-pulse",
  creating: "bg-kumo-info animate-pulse",
  deleting: "bg-kumo-danger animate-pulse",
  stopped: "bg-kumo-line",
  created: "bg-kumo-info",
  destroyed: "bg-kumo-danger",
  failed: "bg-kumo-danger",
};

function EnvCard({
  env,
  repo,
  hubUrl,
  onRecoverEnv,
  onSelect,
  onStartRequest,
  selected,
  onShipSelect,
  onPlanSelect,
  planLabel,
  sidebarCollapsed,
}: {
  env: EnvMeta;
  repo: RepoMeta;
  hubUrl: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onSelect?: (slug: string) => void;
  onStartRequest?: (slug: string) => void;
  selected?: boolean;
  onShipSelect?: (slug: string) => void;
  onPlanSelect?: (repoId: string, planArtifactId?: string | null) => void;
  planLabel: string;
  sidebarCollapsed: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; hint: string | null } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const previewAnchorRef = useRef<HTMLDivElement | null>(null);
  const previewCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const status = env.status || "unknown";
  const isCreating = status === "creating";
  const isStarting = status === "starting";
  const isSaving = status === "saving";
  const isRunning = canStopEnvStatus(status);
  const isStopping = status === "stopping";
  const isDeleting = status === "deleting";
  const isFailed = status === "failed";
  const isPublishPending = env.githubPublishStatus === "publishing" || !!env.githubPublishOperationId;
  const scheduledRun = env.scheduledRun;
  const scheduledRunActive = scheduledRun?.state === "running";
  const scheduledRunFinalizing = scheduledRun?.stage === "saving";
  const scheduledRunImplementing = scheduledRunActive && !scheduledRunFinalizing;
  const scheduledRunScheduled = scheduledRun?.state === "scheduled" && !scheduledRunFinalizing;
  const scheduledRunInterrupted = scheduledRun?.state === "interrupted";
  const scheduledRunCleanupRequired = scheduledRun?.cleanupRequired === true;
  const canStart = (status === "stopped" || status === "unknown" || isFailed)
    && !isPublishPending
    && !scheduledRunCleanupRequired
    && !scheduledRunActive
    && scheduledRun?.state !== "scheduled";
  const branchStatus = getDisplayEnvBranchStatus(env, repo);
  const needsImplementorAttention = Boolean(env.implementorAttentionToken);

  const showActionError = (err: unknown, fallback: string) => {
    console.error("[tiller] env action failed:", err);
    setActionError({
      message: err instanceof Error ? err.message : fallback,
      hint: err instanceof ApiActionError ? err.hint ?? null : null,
    });
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      showActionError(err, "Environment action failed.");
    } finally {
      setBusy(false);
    }
  };

  const deleteEnvironment = async () => {
    if (busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await deleteEnv(hubUrl, env.slug);
      onRecoverEnv?.(env.slug, "deleting");
    } catch (err) {
      showActionError(err, "Failed to delete environment.");
    } finally {
      setBusy(false);
      setDeleteDialogOpen(false);
    }
  };

  const dotColor = needsImplementorAttention
    ? "bg-kumo-info"
    : scheduledRun?.state === "completed"
    ? STATUS_COLORS.running
    : scheduledRun?.state === "failed" || scheduledRun?.state === "interrupted"
      ? STATUS_COLORS.failed
      : scheduledRunActive || scheduledRunScheduled
        ? STATUS_COLORS.starting
        : STATUS_COLORS[status] || "bg-kumo-line";

  let label: string;
  if (scheduledRunCleanupRequired) label = "Failed";
  else if (scheduledRunFinalizing) label = "Saving and finalizing";
  else if (scheduledRunScheduled) label = "Scheduled · 3:00 AM";
  else if (scheduledRunImplementing) label = "Implementing plan";
  else if (scheduledRun?.state === "completed") label = "Completed";
  else if (scheduledRunInterrupted) label = "Interrupted";
  else if (scheduledRun?.state === "failed") label = "Failed";
  else if (isDeleting) label = "Deleting...";
  else if (isCreating) label = "Creating...";
  else if (isStarting) label = "Starting...";
  else if (isSaving) label = "Saving workspace…";
  else if (isStopping) label = "Stopping...";
  else if (isPublishPending) label = "Publishing draft PR...";
  else if (isFailed) label = "Failed";
  else if (canStart) label = "Stopped";
  else if (isEnvRunningStatus(status)) label = "Running";
  else label = status;
  const dotLabel = needsImplementorAttention ? "Needs attention" : label;

  const harness = env.harness;
  const displayName = getEnvDisplayName(env);
  const hasDistinctDisplayName = displayName !== env.slug;
  const environmentIdentity = `"${displayName}" (slug: ${env.slug})`;
  const deleteControlLabel = hasDistinctDisplayName
    ? `Delete ${displayName} (slug: ${env.slug})`
    : `Delete ${displayName}`;
  const showShip = Boolean(
    status === "stopped" && onShipSelect && hasShipTarget(env, branchStatus),
  );
  const railLabel = env.sidebarSlot ? String(env.sidebarSlot) : "?";
  const railLabelText = `${hasDistinctDisplayName ? `${displayName} - Slug: ${env.slug}` : displayName} - Plan: ${planLabel} - ${getHarnessBadgeLabel(harness)} - ${dotLabel}`;
  const attentionMessages = Array.from(new Set([
    scheduledRun?.state === "failed" ? scheduledRun.error || "Scheduled run failed." : null,
    scheduledRunInterrupted ? scheduledRun?.error || "Scheduled run interrupted." : null,
    scheduledRunCleanupRequired
      ? EXISTING_EXECUTION_UNAVAILABLE_MESSAGE
      : null,
    isFailed ? env.error?.trim() || "Environment failed." : null,
    branchStatus === "needs-attention" ? "Needs attention" : null,
    env.githubPublishStatus === "failed" ? env.githubPublishError?.trim() || "GitHub publish failed." : null,
    actionError?.message ?? null,
    actionError?.hint ?? null,
  ].filter((message): message is string => Boolean(message))));
  const handleSelect = () => {
    setPreviewOpen(false);
    onSelect?.(env.slug);
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handleSelect();
  };
  const clearPreviewClose = () => {
    if (!previewCloseTimeoutRef.current) return;
    clearTimeout(previewCloseTimeoutRef.current);
    previewCloseTimeoutRef.current = null;
  };
  const openPreview = () => {
    if (!sidebarCollapsed) return;
    clearPreviewClose();
    setPreviewOpen(true);
  };
  const schedulePreviewClose = () => {
    clearPreviewClose();
    previewCloseTimeoutRef.current = setTimeout(() => {
      setPreviewOpen(false);
      previewCloseTimeoutRef.current = null;
    }, 220);
  };

  useEffect(() => {
    if (!sidebarCollapsed) setPreviewOpen(false);
  }, [sidebarCollapsed]);

  useEffect(() => () => {
    if (previewCloseTimeoutRef.current) {
      clearTimeout(previewCloseTimeoutRef.current);
    }
  }, []);

  return (
    <Popover
      open={sidebarCollapsed && previewOpen}
      onOpenChange={(open) => setPreviewOpen(sidebarCollapsed && open)}
    >
    <div
      ref={previewAnchorRef}
      data-testid={`env-card-${env.slug}`}
      className={`max-w-full cursor-pointer overflow-x-hidden border-b border-l-2 border-kumo-line px-3 py-3 transition-colors last:border-b-0 group-data-[state=collapsed]/sidebar:flex group-data-[state=collapsed]/sidebar:h-11 group-data-[state=collapsed]/sidebar:items-center group-data-[state=collapsed]/sidebar:justify-center group-data-[state=collapsed]/sidebar:border-b-0 group-data-[state=collapsed]/sidebar:border-l-0 group-data-[state=collapsed]/sidebar:bg-transparent group-data-[state=collapsed]/sidebar:px-0 group-data-[state=collapsed]/sidebar:py-1 group-data-[state=collapsed]/sidebar:hover:bg-kumo-tint ${
      selected
        ? "border-l-kumo-info bg-kumo-info-tint hover:bg-kumo-info-tint"
        : "border-l-transparent bg-kumo-base hover:bg-kumo-tint"
    }`}
      onClick={handleSelect}
      onKeyDown={handleKeyDown}
      onMouseEnter={openPreview}
      onMouseLeave={schedulePreviewClose}
      onFocus={openPreview}
      onBlur={schedulePreviewClose}
      role="button"
      tabIndex={0}
      aria-label={railLabelText}
      aria-current={selected ? "page" : undefined}
    >
      <div className="flex min-w-0 max-w-full items-center gap-2 group-data-[state=collapsed]/sidebar:relative group-data-[state=collapsed]/sidebar:h-8 group-data-[state=collapsed]/sidebar:w-8 group-data-[state=collapsed]/sidebar:justify-center">
        <Tooltip
          content={dotLabel}
          side="right"
          delay={250}
          render={(
            <span
              role="img"
              aria-label={`Status: ${dotLabel}`}
              className={`h-2 w-2 shrink-0 rounded-full group-data-[state=collapsed]/sidebar:absolute group-data-[state=collapsed]/sidebar:bottom-0 group-data-[state=collapsed]/sidebar:right-0 group-data-[state=collapsed]/sidebar:ring-2 group-data-[state=collapsed]/sidebar:ring-kumo-recessed ${dotColor}`}
            />
          )}
        />
        <span
          title={displayName}
          className="tiller-sidebar-open-text min-w-0 flex-1 truncate text-sm font-semibold text-kumo-strong group-data-[state=collapsed]/sidebar:hidden"
        >
          {displayName}
        </span>
        <span className={`hidden h-7 w-7 items-center justify-center rounded border text-[11px] font-semibold tabular-nums group-data-[state=collapsed]/sidebar:flex ${
          selected
            ? "border-kumo-info bg-kumo-info-tint text-kumo-link"
            : "border-kumo-line bg-kumo-base text-kumo-default"
        }`}>
          {railLabel}
        </span>
      </div>
      {hasDistinctDisplayName && (
        <div className="tiller-sidebar-open-text mt-0.5 ml-4 truncate text-[11px] leading-4 text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">
          Slug: {env.slug}
        </div>
      )}
      <div className="tiller-sidebar-open-text mt-1 ml-4 flex min-w-0 items-start gap-1 text-xs leading-4 text-kumo-subtle group-data-[state=collapsed]/sidebar:hidden">
        <span className="shrink-0">Plan:</span>
        <PlanValueLink
          repoId={repo.repoId}
          planArtifactId={env.startupPlanId}
          label={planLabel}
          onPlanSelect={onPlanSelect}
        />
      </div>
      <div className="tiller-sidebar-open-text mt-2.5 ml-4 flex min-w-0 items-center gap-1.5 group-data-[state=collapsed]/sidebar:hidden" onClick={(e) => e.stopPropagation()}>
        <span className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getHarnessBadgeClass(harness)}`}>
          {getHarnessBadgeLabel(harness)}
        </span>
        <span
          data-testid={`env-backend-badge-${env.slug}`}
          className="shrink-0 rounded border border-kumo-line bg-kumo-recessed px-1.5 py-0.5 text-[10px] font-medium text-kumo-default"
        >
          {getBackendBadgeLabel(env.backend)}
        </span>
        <span className="min-w-0 flex-1" />
        {canStart && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onStartRequest?.(env.slug)}
            disabled={busy}
          >
            Start
          </Button>
        )}
        {scheduledRunScheduled && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => run(async () => {
              await cancelScheduledRun(hubUrl, env.slug);
              onRecoverEnv?.(env.slug);
            })}
            disabled={busy}
          >
            Cancel
          </Button>
        )}
        {(isRunning || scheduledRunActive || scheduledRunCleanupRequired) && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => run(async () => {
              const res = await stopEnv(hubUrl, env.slug);
              onRecoverEnv?.(env.slug, res.status);
            })}
            disabled={busy}
          >
            Stop
          </Button>
        )}
        {showShip && (
          <Button
            variant="secondary"
            size="xs"
            onClick={() => onShipSelect?.(env.slug)}
            disabled={busy}
          >
            Ship
          </Button>
        )}
        {!isDeleting && (
          <Tooltip
            content={deleteControlLabel}
            side="top"
            delay={250}
            render={(
              <button
                type="button"
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-kumo-subtle transition-colors hover:bg-kumo-danger-tint hover:text-kumo-danger disabled:cursor-not-allowed disabled:opacity-40"
                aria-label={deleteControlLabel}
                onClick={() => setDeleteDialogOpen(true)}
                disabled={busy || isPublishPending || isSaving || isStopping || scheduledRunFinalizing || scheduledRunActive || scheduledRunCleanupRequired}
              />
            )}
          >
            <TrashIcon className="h-3.5 w-3.5" aria-hidden="true" />
          </Tooltip>
        )}
      </div>
      {attentionMessages.map((message) => (
        <p
          key={message}
          className="tiller-sidebar-open-text mt-1 ml-4 w-[calc(100%-1rem)] whitespace-normal text-[11px] leading-4 text-kumo-danger tiller-sidebar-wrap group-data-[state=collapsed]/sidebar:hidden"
        >
          {message}
        </p>
      ))}
    </div>
      <Popover.Content
        anchor={previewAnchorRef}
        side="right"
        align="center"
        sideOffset={10}
        positionMethod="fixed"
        className="w-72 p-0"
      >
        <div
          role="button"
          tabIndex={0}
          className="block w-full rounded-lg px-4 py-3 text-left transition-colors hover:bg-kumo-tint"
          onClick={() => {
            handleSelect();
            setPreviewOpen(false);
          }}
          onKeyDown={handleKeyDown}
          onMouseEnter={openPreview}
          onMouseLeave={schedulePreviewClose}
          onFocus={openPreview}
          onBlur={schedulePreviewClose}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className={`h-2 w-2 flex-shrink-0 rounded-full ${dotColor}`} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-kumo-strong">
              {displayName}
            </span>
            <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getHarnessBadgeClass(harness)}`}>
              {getHarnessBadgeLabel(harness)}
            </span>
          </div>
          <div className="mt-2 grid gap-1 text-xs text-kumo-subtle">
            <EnvPreviewRow label="Status" value={dotLabel} />
            <EnvPreviewRow label="Backend" value={getBackendBadgeLabel(env.backend)} />
            <EnvPreviewRow label="Slug" value={env.slug} />
            <EnvPreviewRow label="Sidebar slot" value={env.sidebarSlot ? `#${env.sidebarSlot}` : "Unassigned"} />
            <EnvPreviewPlanRow
              repoId={repo.repoId}
              planArtifactId={env.startupPlanId}
              label={planLabel}
              onPlanSelect={onPlanSelect}
            />
            {showShip && <EnvPreviewRow label="Ship" value={formatShipState(env, branchStatus)} />}
            {attentionMessages.map((message) => (
              <p key={message} className="mt-1 text-[11px] leading-4 text-kumo-danger">{message}</p>
            ))}
          </div>
          <span className="mt-3 inline-flex text-xs font-medium text-kumo-link">
            Open
          </span>
        </div>
      </Popover.Content>
      <ConfirmationDialog
        open={deleteDialogOpen}
        title="Delete environment?"
        description={`${environmentIdentity} and its container and R2 storage will be permanently deleted.`}
        confirmLabel="Delete environment"
        busyLabel="Deleting…"
        busy={busy}
        onOpenChange={setDeleteDialogOpen}
        onConfirm={deleteEnvironment}
      />
    </Popover>
  );
}

function PlanValueLink({
  repoId,
  planArtifactId,
  label,
  onPlanSelect,
}: {
  repoId: string;
  planArtifactId: string | null;
  label: string;
  onPlanSelect?: (repoId: string, planArtifactId?: string | null) => void;
}) {
  if (!planArtifactId) {
    return <span title={label} className="min-w-0 text-kumo-default">{label}</span>;
  }
  return (
    <a
      href={planPath(repoId, planArtifactId)}
      title={label}
      className="min-w-0 whitespace-normal break-words text-kumo-link hover:underline"
      onClick={(event) => {
        event.stopPropagation();
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (!onPlanSelect) return;
        event.preventDefault();
        onPlanSelect(repoId, planArtifactId);
      }}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {label}
    </a>
  );
}

function EnvPreviewPlanRow({
  repoId,
  planArtifactId,
  label,
  onPlanSelect,
}: {
  repoId: string;
  planArtifactId: string | null;
  label: string;
  onPlanSelect?: (repoId: string, planArtifactId?: string | null) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>Plan</span>
      <span className="min-w-0 truncate text-kumo-default">
        <PlanValueLink
          repoId={repoId}
          planArtifactId={planArtifactId}
          label={label}
          onPlanSelect={onPlanSelect}
        />
      </span>
    </div>
  );
}

function EnvPreviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span>{label}</span>
      <span className="min-w-0 truncate text-kumo-default">{value}</span>
    </div>
  );
}

function matchesRepo(repo: RepoMeta, env: EnvMeta): boolean {
  return env.repoId === repo.repoId;
}

function planLabelCacheKey(repoId: string, planArtifactId: string): string {
  return `${repoId}:${planArtifactId}`;
}

function getEnvPlanLabel(env: EnvMeta, repo: RepoMeta, planLabels: Record<string, string>): string {
  if (!env.startupPlanId) return "No plan";
  return planLabels[planLabelCacheKey(repo.repoId, env.startupPlanId)] ?? "Selected plan";
}

function compareSidebarOrder(left: EnvMeta, right: EnvMeta): number {
  const leftSlot = left.sidebarSlot ?? Number.MAX_SAFE_INTEGER;
  const rightSlot = right.sidebarSlot ?? Number.MAX_SAFE_INTEGER;
  return leftSlot - rightSlot
    || left.createdAt.localeCompare(right.createdAt)
    || left.slug.localeCompare(right.slug);
}

function RepoGroupHeader({
  repo,
  onPlanSelect,
  onRepoHomeSelect,
  planSelected,
}: {
  repo: RepoMeta;
  onPlanSelect?: (repoId: string, planArtifactId?: string | null) => void;
  onRetryRepoMain?: (repoId: string) => void;
  onRepoHomeSelect?: (repoId: string) => void;
  planSelected?: boolean;
}) {
  const repoMainReady = isRepoMainReady(repo);
  const repoMainStatusLabel = getRepoMainStatusLabel(repo);
  const repoMainStatusDetail = getRepoMainStatusDetail(repo);
  const label = repoLabel(repo.repoUrl);
  const selectRepo = () => onRepoHomeSelect?.(repo.repoId);
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectRepo();
  };
  const handlePlan = (event: MouseEvent<HTMLAnchorElement>) => {
    event.stopPropagation();
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (!onPlanSelect) return;
    event.preventDefault();
    onPlanSelect?.(repo.repoId);
  };
  const statusBadge = !repoMainReady ? (
    repo.gitStatus === "repair-required" ? (
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-xs text-kumo-subtle">
        <Badge variant="error">{repoMainStatusLabel}</Badge>
        {repoMainStatusDetail && (
          <span className="tiller-sidebar-open-text min-w-0 whitespace-normal text-[11px] font-normal text-kumo-subtle tiller-sidebar-wrap">
            {repoMainStatusDetail}
          </span>
        )}
      </div>
    ) : (
      <div
        role="status"
        aria-live="polite"
        aria-label={`${repoMainStatusLabel}. Repository setup is in progress.`}
        className="mt-2 flex min-w-0 items-center"
        data-testid="repo-main-pending-indicator"
      >
        <Badge variant="warning">
          <span className="flex items-center gap-1.5">
            <span
              className="block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border-2 border-current border-r-transparent motion-reduce:animate-none"
              aria-hidden="true"
            />
            <span>{repoMainStatusLabel}…</span>
          </span>
        </Badge>
      </div>
    )
  ) : null;

  return (
    <div
      className="max-w-full overflow-x-hidden bg-kumo-base px-3 py-3 transition-colors hover:bg-kumo-tint"
      role="button"
      tabIndex={0}
      onClick={selectRepo}
      onKeyDown={handleKeyDown}
    >
      <div className="flex min-w-0 items-start">
        <div className="min-w-0 max-w-full">
          <a
            href={githubRepoHref(repo.repoUrl)}
            target="_blank"
            rel="noreferrer"
            className="tiller-sidebar-open-text whitespace-normal text-sm font-semibold text-kumo-strong hover:text-kumo-link hover:underline tiller-sidebar-wrap"
            onClick={(event) => event.stopPropagation()}
          >
            {label}
          </a>
          <p className="tiller-sidebar-open-text mt-0.5 whitespace-normal text-[11px] text-kumo-subtle tiller-sidebar-wrap">Repo actions dock below</p>
        </div>
      </div>
      <div className="min-w-0">
        {statusBadge}
      </div>
      <div className="mt-3 border border-kumo-line bg-kumo-base">
        {repoMainReady ? (
          <a
            href={planPath(repo.repoId)}
            aria-current={planSelected ? "page" : undefined}
            className="flex min-h-10 w-full items-center justify-center gap-2 border-l-2 border-l-kumo-brand bg-kumo-base px-2 text-xs font-medium text-kumo-link transition-colors hover:bg-kumo-tint"
            onClick={handlePlan}
            onKeyDown={(event) => event.stopPropagation()}
          >
            Plan
          </a>
        ) : (
          <button
            type="button"
            className="flex min-h-10 w-full items-center justify-center gap-2 border-l-2 border-l-kumo-brand bg-kumo-base px-2 text-xs font-medium text-kumo-link transition-colors disabled:cursor-default disabled:text-kumo-subtle disabled:opacity-60"
            disabled
          >
            Plan
          </button>
        )}
      </div>
    </div>
  );
}

function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function githubRepoHref(repoUrl: string): string {
  try {
    const parsed = new URL(repoUrl);
    if (parsed.hostname === "github.com" || parsed.hostname === "www.github.com") {
      return `https://github.com${parsed.pathname.replace(/\.git$/, "").replace(/\/+$/, "")}`;
    }
  } catch {
    // Fall through to the label-based URL below.
  }
  return `https://github.com/${repoLabel(repoUrl).replace(/\.git$/, "").replace(/\/+$/, "")}`;
}

function hasShipTarget(env: EnvMeta, branchStatus: NonNullable<EnvMeta["branchStatus"]>): boolean {
  if (env.workspaceDirty) return true;
  if (branchStatus === "ready-to-merge" || branchStatus === "needs-attention") return true;
  if (env.githubPrUrl) return true;
  if (env.githubPublishStatus === "publishing" || env.githubPublishStatus === "failed") return true;
  return Boolean(
    env.githubHeadCommitSha &&
      env.githubPublishStatus === "published" &&
      env.githubPrState !== "closed" &&
      env.githubPrState !== "merged" &&
      !env.githubMergedAt,
  );
}

function formatShipState(env: EnvMeta, branchStatus: NonNullable<EnvMeta["branchStatus"]>): string {
  if (branchStatus === "needs-attention") return "Needs attention";
  if (env.githubPublishStatus === "publishing") return "Publishing PR";
  if (env.githubPublishStatus === "failed") return "Publish failed";
  if (env.githubPrState === "open" && env.workspaceDirty) return "Update PR";
  if (env.githubPrUrl) return "Open PR";
  if (env.workspaceDirty || branchStatus === "ready-to-merge") return "Create PR";
  return "Review published branch";
}
