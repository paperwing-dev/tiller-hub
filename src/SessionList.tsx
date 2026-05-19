import { useState } from "react";
import type { StoredSession, EnvMeta, RepoMeta } from "../api/types";
import { ApiActionError, deleteEnv, deleteRepo, mergeEnvIntoMain, resetEnvToRepo, stopEnv } from "./api";
import { getDisplayEnvBranchStatus } from "./env-state";
import type { RecoverEntitiesOptions } from "./live-sync-store";
import {
  getEnvAuthBadge,
  getEnvModelBadge,
  getLeadHarnessBadge,
  getHarnessBadgeClass,
  getHarnessBadgeLabel,
} from "./env-harness";
import { canStopEnvStatus, isEnvRunningStatus } from "./env-runtime";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "./repo-status";
import { pickPrimaryEnvSession } from "./session-attachment";

interface SessionListProps {
  repos: RepoMeta[];
  sessions: StoredSession[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  permissionCounts?: Record<string, number>;
  envs?: EnvMeta[];
  hubUrl?: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onEnvSelect?: (slug: string) => void;
  selectedEnvSlug?: string | null;
  onPlanSelect?: (repoId: string, repoUrl: string) => void;
  planRepoId?: string | null;
  onStartRequest?: (slug: string) => void;
  onAddEnv?: (repoId: string, repoUrl: string) => void;
  onRetryRepoMain?: (repoId: string) => void;
  onRecoverEntities?: (options?: RecoverEntitiesOptions) => void;
  onRepoDeleted?: (repoId: string, deletedEnvSlugs: string[]) => void;
}

export default function SessionList({
  repos,
  sessions,
  selectedId,
  onSelect,
  permissionCounts = {},
  envs = [],
  hubUrl = "",
  onRecoverEnv,
  onEnvSelect,
  selectedEnvSlug,
  onPlanSelect,
  planRepoId,
  onStartRequest,
  onAddEnv,
  onRetryRepoMain,
  onRecoverEntities,
  onRepoDeleted,
}: SessionListProps) {
  const envSessionMap = new Map<string, StoredSession>();
  for (const env of envs) {
    const session = pickPrimaryEnvSession(sessions, env.slug);
    if (session) {
      envSessionMap.set(env.slug, session);
    }
  }

  const repoGroups = repos.map((repo) => ({
    repo,
    envs: envs.filter((env) => matchesRepo(repo, env)),
  }));

  return (
    <div className="flex-1 overflow-y-auto">
      {repoGroups.map(({ repo, envs: repoEnvs }) => (
        <div key={repo.repoId} className="border-b border-[#e1e4e8]">
          <RepoGroupHeader
            repo={repo}
            planRepoId={planRepoId}
            hubUrl={hubUrl}
            envCount={repoEnvs.length}
            onPlanSelect={onPlanSelect}
            onAddEnv={onAddEnv}
            onRetryRepoMain={onRetryRepoMain}
            onRecoverEntities={onRecoverEntities}
            onRepoDeleted={onRepoDeleted}
          />
          <div className="ml-3 border-l border-[#e1e4e8]">
            {repoEnvs.length === 0 ? (
              <p className="px-3 py-2 text-xs text-[#6e7781]">
                {isRepoMainReady(repo) ? (
                  <>
                    No environments yet —{" "}
                    <button
                      onClick={() => onAddEnv?.(repo.repoId, repo.repoUrl)}
                      className="text-[#0969da] hover:underline"
                    >
                      add one
                    </button>
                  </>
                ) : (
                  getRepoMainStatusDetail(repo)
                )}
              </p>
            ) : (
              repoEnvs.map((env) => {
                const session = envSessionMap.get(env.slug);
                const permCount = session ? (permissionCounts[session.id] || 0) : 0;
                const isSelected =
                  planRepoId === repo.repoId ||
                  (session ? session.id === selectedId : selectedEnvSlug === env.slug);

                return (
                  <EnvCard
                    key={env.slug}
                    env={env}
                    repo={repo}
                    permCount={permCount}
                    hubUrl={hubUrl}
                    onRecoverEnv={onRecoverEnv}
                    onSelect={(slug) => onEnvSelect?.(slug)}
                    onStartRequest={onStartRequest}
                    onRecoverEntities={onRecoverEntities}
                    selected={isSelected}
                  />
                );
              })
            )}
          </div>
        </div>
      ))}

      {repos.length === 0 && sessions.length === 0 && (
        <p className="p-3 text-sm text-[#57606a]">No repositories yet</p>
      )}
    </div>
  );
}

const STATUS_COLORS: Record<string, string> = {
  running: "bg-green-500",
  starting: "bg-yellow-400 animate-pulse",
  saving: "bg-yellow-400 animate-pulse",
  stopping: "bg-yellow-400 animate-pulse",
  creating: "bg-blue-400 animate-pulse",
  deleting: "bg-red-400 animate-pulse",
  stopped: "bg-[#d0d7de]",
  created: "bg-blue-400",
  destroyed: "bg-red-400",
  failed: "bg-red-500",
};

function EnvCard({
  env,
  repo,
  permCount,
  hubUrl,
  onRecoverEnv,
  onSelect,
  onStartRequest,
  onRecoverEntities,
  selected,
}: {
  env: EnvMeta;
  repo: RepoMeta;
  permCount: number;
  hubUrl: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onSelect?: (slug: string) => void;
  onStartRequest?: (slug: string) => void;
  onRecoverEntities?: (options?: RecoverEntitiesOptions) => void;
  selected?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<{ message: string; hint: string | null } | null>(null);
  const status = env.status || "unknown";
  const isCreating = status === "creating";
  const isStarting = status === "starting";
  const isSaving = status === "saving";
  const isRunning = canStopEnvStatus(status);
  const isStopping = status === "stopping";
  const isDeleting = status === "deleting";
  const isFailed = status === "failed";
  const isScmPending = !!env.scmOperationType;
  const canStart = (status === "stopped" || status === "unknown" || isFailed) && !isScmPending;
  const canRepoAction = status === "stopped" && !isScmPending;
  const branchStatus = getDisplayEnvBranchStatus(env, repo);

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

  const dotColor = STATUS_COLORS[status] || "bg-[#d0d7de]";

  let label: string;
  if (isDeleting) label = "Deleting...";
  else if (isCreating) label = "Creating...";
  else if (isStarting) label = "Starting...";
  else if (isSaving) label = "Saving changes...";
  else if (isStopping) label = "Stopping...";
  else if (isScmPending) label = formatScmOperationLabel(env.scmOperationType);
  else if (isFailed) label = "Failed";
  else if (canStart) label = "Stopped";
  else if (isEnvRunningStatus(status)) label = "Running";
  else label = status;

  const harness = env.harness;
  const authBadge = getEnvAuthBadge(env);
  const modelBadge = getEnvModelBadge(env);
  const harnessBadge = getLeadHarnessBadge(env);

  return (
    <div className={`px-3 py-2.5 border-b border-[#e1e4e8] hover:bg-white transition-colors cursor-pointer ${
      selected ? "bg-white border-l-2 border-l-[#0969da]" : "border-l-2 border-l-transparent"
    }`} onClick={() => onSelect?.(env.slug)}>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
        <span className="text-sm font-medium truncate flex-1 text-[#24292f]">{env.slug}</span>
        <span className="flex-shrink-0 rounded border border-[#d0d7de] bg-[#f6f8fa] px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#57606a]">
          {env.backend}
        </span>
        <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getHarnessBadgeClass(harness)}`}>
          {getHarnessBadgeLabel(harness)}
        </span>
        {authBadge && (
          <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${authBadge.className}`}>
            {authBadge.label}
          </span>
        )}
        {modelBadge && (
          <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${modelBadge.className}`}>
            {modelBadge.label}
          </span>
        )}
        {harnessBadge && (
          <span className={`flex-shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${harnessBadge.className}`}>
            {harnessBadge.label}
          </span>
        )}
        {permCount > 0 && (
          <span className="flex-shrink-0 bg-amber-100 text-amber-700 text-xs font-medium px-1.5 py-0.5 rounded-full border border-amber-200">
            {permCount}
          </span>
        )}
        <span className="text-xs text-[#6e7781]">{label}</span>
      </div>
      <p className="text-xs text-[#0969da] mt-0.5 ml-4 truncate">
        {repoLabel(env.repoUrl)}
      </p>

      <p className="text-[11px] text-[#57606a] mt-0.5 ml-4">
        Plan: {env.startupPlanId ? "Selected" : "None"}
      </p>
      <p className="text-[11px] text-[#57606a] mt-0.5 ml-4">
        {`Branch: ${env.branchName || env.slug} · ${formatBranchStatus(branchStatus)}`}
      </p>
      {syncDetailText(env, repo) && (
        <p className="text-[11px] text-[#6e7781] mt-0.5 ml-4">
          {syncDetailText(env, repo)}
        </p>
      )}
      {isScmPending && scmProgressText(env) && (
        <p className="text-[11px] text-[#6e7781] mt-0.5 ml-4">
          {scmProgressText(env)}
        </p>
      )}
      {actionError && (
        <p className="text-[11px] text-red-600 mt-0.5 ml-4">
          {actionError.message}
        </p>
      )}
      {actionError?.hint && (
        <p className="text-[11px] text-red-500 mt-0.5 ml-4">
          {actionError.hint}
        </p>
      )}
      <div className="flex gap-1 mt-1.5 ml-4 flex-wrap" onClick={(e) => e.stopPropagation()}>
        {canStart && (
          <button
            onClick={() => onStartRequest?.(env.slug)}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Start
          </button>
        )}
        {isRunning && (
          <button
            onClick={() => run(async () => {
              const res = await stopEnv(hubUrl, env.slug);
              onRecoverEnv?.(env.slug, res.status);
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Stop
          </button>
        )}
        {canRepoAction && branchStatus !== "needs-attention" && (
          <button
            onClick={() => run(async () => {
              const res = await mergeEnvIntoMain(hubUrl, env.slug);
              if (res.pending) {
                onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
                return;
              }
              onRecoverEnv?.(env.slug);
              onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
            })}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Promote to Main
          </button>
        )}
        {canRepoAction && (branchStatus === "ready-to-merge" || branchStatus === "needs-attention" || branchStatus === "behind-main") && (
          <button
            onClick={() => {
              if (!confirm(`Reset "${env.slug}" to main? This will discard unpromoted changes.`)) {
                return;
              }
              void run(async () => {
                await resetEnvToRepo(hubUrl, env.slug);
                onRecoverEnv?.(env.slug);
                onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
              });
            }}
            disabled={busy}
            className="text-xs px-2 py-0.5 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] disabled:opacity-40"
          >
            Reset to Main
          </button>
        )}
        {!isDeleting && (
          <button
            onClick={async () => {
              if (confirm(`Delete environment "${env.slug}"? This will destroy the container and wipe R2 storage.`)) {
                setBusy(true);
                setActionError(null);
                try {
                  await deleteEnv(hubUrl, env.slug);
                  onRecoverEnv?.(env.slug, "deleting");
                } catch (err) {
                  showActionError(err, "Failed to delete environment.");
                } finally {
                  setBusy(false);
                }
              }
            }}
            disabled={busy || isScmPending || isSaving || isStopping}
            className="text-xs px-2 py-0.5 rounded border border-red-200 bg-white hover:bg-red-50 text-red-600 disabled:opacity-40"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );
}

function matchesRepo(repo: RepoMeta, env: EnvMeta): boolean {
  if (env.repoId) return env.repoId === repo.repoId;
  return normalizeRepoUrl(env.repoUrl) === normalizeRepoUrl(repo.repoUrl);
}

function RepoGroupHeader({
  repo,
  planRepoId,
  hubUrl,
  envCount,
  onPlanSelect,
  onAddEnv,
  onRetryRepoMain,
  onRecoverEntities,
  onRepoDeleted,
}: {
  repo: RepoMeta;
  planRepoId?: string | null;
  hubUrl: string;
  envCount: number;
  onPlanSelect?: (repoId: string, repoUrl: string) => void;
  onAddEnv?: (repoId: string, repoUrl: string) => void;
  onRetryRepoMain?: (repoId: string) => void;
  onRecoverEntities?: (options?: RecoverEntitiesOptions) => void;
  onRepoDeleted?: (repoId: string, deletedEnvSlugs: string[]) => void;
}) {
  const [busy, setBusy] = useState(false);
  const repoMainReady = isRepoMainReady(repo);
  const repoMainStatusLabel = getRepoMainStatusLabel(repo);
  const repoMainStatusDetail = getRepoMainStatusDetail(repo);

  return (
    <div className={`px-3 py-1.5 text-xs font-semibold text-[#57606a] ${planRepoId === repo.repoId ? "bg-white" : "bg-[#f6f8fa]"}`}>
      <div className="truncate mb-1">{repoLabel(repo.repoUrl)}</div>
      <div className="mb-1 flex items-center gap-2">
        <span
          className={`rounded border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            repoMainReady
              ? "border-emerald-200 bg-white text-emerald-700"
              : repo.gitStatus === "repair-required"
                ? "border-red-200 bg-white text-red-700"
                : "border-amber-200 bg-white text-amber-800"
          }`}
        >
          {repoMainStatusLabel}
        </span>
        {!repoMainReady && repoMainStatusDetail && (
          <span className="text-[11px] font-normal text-[#6e7781]">
            {repoMainStatusDetail}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onAddEnv?.(repo.repoId, repo.repoUrl)}
          disabled={!repoMainReady}
          className="rounded border border-[#d0d7de] bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#24292f] hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Add Env
        </button>
        {!repoMainReady && (
          <button
            onClick={() => onRetryRepoMain?.(repo.repoId)}
            disabled={busy}
            className="rounded border border-[#d0d7de] bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#24292f] hover:bg-[#f6f8fa] disabled:cursor-not-allowed disabled:opacity-40"
          >
            Retry Main
          </button>
        )}
        <button
          onClick={() => onPlanSelect?.(repo.repoId, repo.repoUrl)}
          disabled={!repoMainReady}
          className="rounded border border-[#d8b4fe] bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#7c3aed] hover:bg-[#faf5ff] disabled:cursor-not-allowed disabled:opacity-40"
        >
          Plan
        </button>
        <button
          onClick={async () => {
            const envWarning = envCount > 0
              ? `\n\nThis will also destroy ${envCount} environment(s) and their containers.`
              : "";
            if (!confirm(`Delete repo "${repoLabel(repo.repoUrl)}"?${envWarning}`)) return;
            setBusy(true);
            try {
              const result = await deleteRepo(hubUrl, repo.repoId);
              if (onRepoDeleted) {
                onRepoDeleted(result.repoId, result.deletedEnvSlugs);
              } else {
                onRecoverEntities?.({ repoId: result.repoId });
              }
            } catch (err) {
              console.error("[tiller] repo delete failed:", err);
              alert(err instanceof Error ? err.message : "Failed to delete repo.");
            } finally {
              setBusy(false);
            }
          }}
          disabled={busy}
          className="rounded border border-red-200 bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-red-600 hover:bg-red-50 disabled:opacity-40"
        >
          {busy ? "..." : "Delete"}
        </button>
      </div>
    </div>
  );
}

function repoLabel(repoUrl: string): string {
  return repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, "");
}

function normalizeRepoUrl(repoUrl: string): string {
  return repoUrl.trim().replace(/\.git$/, "").replace(/\/+$/, "").toLowerCase();
}

function formatBranchStatus(status: string): string {
  if (status === "behind-main") return "Behind main";
  if (status === "ready-to-merge") return "Ready to promote";
  if (status === "needs-attention") return "Needs attention";
  return "Up to date";
}

function formatScmOperationLabel(type?: string | null): string {
  if (type === "merge-into-main") return "Promoting...";
  return "Working...";
}

function syncDetailText(env: EnvMeta, repo: RepoMeta): string | null {
  const branchStatus = getDisplayEnvBranchStatus(env, repo);
  if (branchStatus === "behind-main") {
    return repo.lastCommittedFromEnvSlug
      ? `Main advanced from ${repo.lastCommittedFromEnvSlug}. Promote will try to reconcile your changes, or reset this env to discard them.`
      : "Main has advanced. Promote will try to reconcile your changes, or reset this env to discard them.";
  }
  if (branchStatus === "needs-attention") {
    return "This env has conflicts or unsupported git state. Reset to Main to discard it.";
  }
  if (branchStatus === "ready-to-merge") {
    return "This env has local work and can be promoted into main.";
  }
  return null;
}

function scmProgressText(env: EnvMeta): string | null {
  if (!env.scmOperationType) return null;
  const prefix = "Promote to Main";
  if (env.scmOperationPhase) {
    return `${prefix}: ${env.scmOperationPhase}`;
  }
  return `${prefix} in progress`;
}
