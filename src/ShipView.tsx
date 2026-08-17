import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Button, LinkButton } from "@cloudflare/kumo/components/button";
import ReactDiffViewer from "react-diff-viewer-continued";
import type { EnvMeta, RepoMeta } from "../api/types";
import {
  fetchEnvChangeFile,
  fetchEnvChanges,
  publishEnvDraftPr,
  resetEnvToRepo,
  stopEnv,
  type EnvChangeEntry,
  type EnvChangeFileResponse,
  type EnvChangesResponse,
} from "./api";
import { getDisplayEnvBranchStatus } from "./env-state";
import { useResolvedTheme } from "./theme";
import { getEnvDisplayName } from "./env-display";
import type { RecoverEntitiesOptions } from "./live-sync-store";
import { getGitHubEnvTargetUrl } from "./github-links";
import { canStopEnvStatus } from "./env-runtime";
import { envPath } from "./dashboard-paths";
import { useToast } from "./Toast";
import { useImplementationWorkspaceContext } from "./ImplementationWorkspaceContext";

interface ShipViewProps {
  env: EnvMeta;
  repo: RepoMeta;
  hubUrl: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onRecoverEntities?: (options?: RecoverEntitiesOptions) => void;
}

interface PublishAttempt {
  operationId: string;
  action: "create" | "update";
  previousPublishedAt: string | null;
  observedOperation: boolean;
}

function shortCommit(value?: string | null): string {
  return value ? value.slice(0, 12) : "unknown";
}

function formatStatus(status: string): string {
  if (status === "added") return "Added";
  if (status === "deleted") return "Deleted";
  return "Modified";
}

function formatBytes(value: number | null): string {
  if (value === null) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function groupFiles(files: EnvChangeEntry[]): Array<{ title: string; files: EnvChangeEntry[] }> {
  return [
    { title: "Modified", files: files.filter((file) => file.status === "modified") },
    { title: "Added", files: files.filter((file) => file.status === "added") },
    { title: "Deleted", files: files.filter((file) => file.status === "deleted") },
  ].filter((group) => group.files.length > 0);
}

function isNewerPublishTimestamp(current: string | null, previous: string | null): boolean {
  if (!current) return false;
  const currentTime = Date.parse(current);
  if (!Number.isFinite(currentTime)) return false;
  if (!previous) return true;
  const previousTime = Date.parse(previous);
  return Number.isFinite(previousTime) && currentTime > previousTime;
}

export default function ShipView({
  env,
  repo,
  hubUrl,
  onRecoverEnv,
  onRecoverEntities,
}: ShipViewProps) {
  const navigate = useNavigate();
  const addToast = useToast();
  const implementationWorkspace = useImplementationWorkspaceContext();
  const resolvedTheme = useResolvedTheme();
  const [publishAttempt, setPublishAttempt] = useState<PublishAttempt | null>(null);
  const settledPublishOperationsRef = useRef<Set<string>>(new Set());
  const branchStatus = getDisplayEnvBranchStatus(env, repo);
  const publishInProgress = publishAttempt !== null
    || env.githubPublishStatus === "publishing"
    || !!env.githubPublishOperationId;
  const isStopped = (env.status ?? "unknown") === "stopped";
  const canStopForReview = canStopEnvStatus(env.status);
  const canRepoAction = isStopped && !publishInProgress;
  const canLoadPreview = canRepoAction && branchStatus !== "needs-attention";
  const hasOpenPr = env.githubPrState === "open" && Boolean(env.githubPrUrl);
  const hasNewWorkspaceChanges = Boolean(env.workspaceDirty || branchStatus === "ready-to-merge");
  const canPublish = canRepoAction
    && branchStatus !== "needs-attention"
    && (hasNewWorkspaceChanges || env.githubPublishStatus === "failed");
  const publishLabel = hasOpenPr ? "Update Draft PR" : "Create Draft PR";
  const [changes, setChanges] = useState<EnvChangesResponse | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [fileDiff, setFileDiff] = useState<EnvChangeFileResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const groupedFiles = useMemo(() => groupFiles(changes?.files ?? []), [changes]);
  const selectedEntry = useMemo(
    () => changes?.files.find((file) => file.path === selectedPath) ?? null,
    [changes, selectedPath],
  );
  const displayName = implementationWorkspace?.selectedEnvSlug === env.slug
    ? implementationWorkspace.implementationName ?? getEnvDisplayName(env)
    : getEnvDisplayName(env);
  const githubTargetUrl = getGitHubEnvTargetUrl(env, repo);
  const publishFailure = env.githubPublishStatus === "failed"
    ? env.githubPublishError?.trim() || "GitHub publish failed."
    : null;

  useEffect(() => {
    if (!publishAttempt) return;

    const operationMatches = env.githubPublishOperationId === publishAttempt.operationId
      || env.githubPendingPublish?.operationId === publishAttempt.operationId;
    if (operationMatches && !publishAttempt.observedOperation) {
      setPublishAttempt((current) => current?.operationId === publishAttempt.operationId
        ? { ...current, observedOperation: true }
        : current);
      return;
    }
    if (!publishAttempt.observedOperation || operationMatches) return;
    if (env.githubPublishStatus === "publishing" || env.githubPublishOperationId) return;

    if (env.githubPublishStatus === "failed" || env.githubPublishStatus === "attention") {
      if (settledPublishOperationsRef.current.has(publishAttempt.operationId)) return;
      settledPublishOperationsRef.current.add(publishAttempt.operationId);
      setPublishAttempt(null);
      setError(env.githubPublishError?.trim() || "GitHub publish failed.");
      return;
    }

    if (env.githubPublishStatus === "up-to-date") {
      if (settledPublishOperationsRef.current.has(publishAttempt.operationId)) return;
      settledPublishOperationsRef.current.add(publishAttempt.operationId);
      setPublishAttempt(null);
      addToast({ title: "No changes to publish", variant: "info" });
      return;
    }

    if (
      env.githubPublishStatus !== "published"
      || !isNewerPublishTimestamp(env.githubLastPublishedAt, publishAttempt.previousPublishedAt)
    ) {
      return;
    }

    if (settledPublishOperationsRef.current.has(publishAttempt.operationId)) return;
    settledPublishOperationsRef.current.add(publishAttempt.operationId);
    setPublishAttempt(null);
    const result = publishAttempt.action === "create" ? "created" : "updated";
    addToast({
      title: env.githubPrNumber
        ? `Draft PR #${env.githubPrNumber} ${result}`
        : `Draft PR ${result}`,
      variant: "success",
    });
    navigate(envPath(env.slug), { replace: true });
  }, [addToast, env, navigate, publishAttempt]);

  const loadChanges = async () => {
    if (!canLoadPreview) {
      setChanges(null);
      setSelectedPath(null);
      setFileDiff(null);
      return;
    }
    setLoading(true);
    setError(null);
    setHint(null);
    setFileDiff(null);
    try {
      const next = await fetchEnvChanges(hubUrl, env.slug);
      setChanges(next);
      setSelectedPath((current) => {
        if (current && next.files.some((file) => file.path === current)) return current;
        return next.files[0]?.path ?? null;
      });
    } catch (err) {
      setChanges(null);
      setSelectedPath(null);
      setFileDiff(null);
      setError(err instanceof Error ? err.message : "Failed to load changes.");
      setHint(err && typeof err === "object" && "hint" in err ? String(err.hint ?? "") || null : null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setChanges(null);
    setSelectedPath(null);
    setFileDiff(null);
    void loadChanges();
    // branchStatus is intentionally included so stale/open transitions replace the preview.
  }, [hubUrl, env.slug, env.updatedAt, repo.updatedAt, branchStatus, canLoadPreview]);

  useEffect(() => {
    if (!selectedPath || !canLoadPreview) {
      setFileDiff(null);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    setFileDiff(null);
    fetchEnvChangeFile(hubUrl, env.slug, selectedPath)
      .then((next) => {
        if (!cancelled) setFileDiff(next);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load file diff.");
          setHint(err && typeof err === "object" && "hint" in err ? String(err.hint ?? "") || null : null);
        }
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [hubUrl, env.slug, selectedPath, branchStatus, canLoadPreview, selectedEntry?.oldHash, selectedEntry?.newHash]);

  const runAction = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setHint(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Environment action failed.");
      setHint(err && typeof err === "object" && "hint" in err ? String(err.hint ?? "") || null : null);
    } finally {
      setBusy(false);
    }
  };

  const publishDraftPr = () => runAction(async () => {
    const action = hasOpenPr ? "update" : "create";
    const previousPublishedAt = env.githubLastPublishedAt;
    const res = await publishEnvDraftPr(hubUrl, env.slug);
    if (res.noChanges) {
      setPublishAttempt(null);
      addToast({ title: "No changes to publish", variant: "info" });
    } else if (res.pending) {
      if (!res.operationId) {
        throw new Error("GitHub accepted the publish request without an operation ID.");
      }
      setPublishAttempt({
        operationId: res.operationId,
        action,
        previousPublishedAt,
        observedOperation: false,
      });
    }
    if (!res.pending) {
      onRecoverEnv?.(env.slug);
    }
    onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
  });

  const resetToMain = () => {
    if (!confirm(`Reset "${displayName}" (slug: ${env.slug}) to the GitHub default branch? This will discard unpublished changes.`)) {
      return;
    }
    void runAction(async () => {
      await resetEnvToRepo(hubUrl, env.slug);
      onRecoverEnv?.(env.slug);
      onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
    });
  };

  const stopForReview = () => runAction(async () => {
    const result = await stopEnv(hubUrl, env.slug);
    onRecoverEnv?.(env.slug, result.status);
  });

  const actionBar = (
    <div className="flex flex-wrap items-center gap-2">
      {canPublish && (
        <Button
          variant="primary"
          size="sm"
          onClick={publishDraftPr}
          disabled={busy}
        >
          {publishLabel}
        </Button>
      )}
      {canRepoAction && (branchStatus === "ready-to-merge" || branchStatus === "needs-attention") && (
        <Button
          variant="secondary"
          size="sm"
          onClick={resetToMain}
          disabled={busy}
        >
          Reset to Main
        </Button>
      )}
      {canRepoAction && (
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void loadChanges()}
          disabled={busy || loading}
        >
          Refresh
        </Button>
      )}
      {githubTargetUrl && (
        <LinkButton
          href={githubTargetUrl}
          external
          variant="secondary"
          size="sm"
        >
          {env.githubPrUrl ? "Open PR" : "Open in GitHub"}
        </LinkButton>
      )}
    </div>
  );

  return (
    <div className="tiller-implementation-ship flex min-h-0 flex-1 flex-col bg-kumo-base">
      <div className="tiller-implementation-ship-header border-b border-kumo-line bg-kumo-recessed px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Ship</div>
            <h2 className="mt-0.5 truncate text-base font-semibold text-kumo-strong">{displayName}</h2>
            <p className="mt-1 text-xs text-kumo-subtle">
              Review changes and create or update the draft PR · Base {shortCommit(env.githubBaseCommitSha)} · Default {shortCommit(repo.githubDefaultBranchHeadSha)}
            </p>
          </div>
          {actionBar}
        </div>
        {branchStatus === "behind-main" && (
          <div className="mt-3 rounded border border-kumo-warning/40 bg-kumo-warning-tint px-3 py-2 text-xs text-kumo-warning">
            The GitHub default branch has changed since this environment was created. Publishing is still allowed. To pull in latest main, start this environment and ask the agent to pull in main.
          </div>
        )}
        {branchStatus === "needs-attention" && (
          <div className="mt-3 rounded border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">
            This environment has conflicts or unsupported git state. Reset to Main to discard it.
          </div>
        )}
        {(error || publishFailure) && (
          <div className="mt-3 rounded border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-xs text-kumo-danger">
            <div>{error || publishFailure}</div>
            {hint && <div className="mt-1 text-kumo-danger">{hint}</div>}
          </div>
        )}
      </div>

      {publishInProgress ? (
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-kumo-subtle">
          Publishing the draft PR...
        </div>
      ) : !isStopped ? (
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="max-w-md text-center">
            <h3 className="text-sm font-semibold text-kumo-strong">Stop to review changes</h3>
            <p className="mt-1 text-sm text-kumo-subtle">
              Ship uses the saved, stopped workspace so the diff cannot change while you review it.
            </p>
            {canStopForReview && (
              <Button
                variant="primary"
                size="sm"
                className="mt-4"
                onClick={stopForReview}
                disabled={busy}
              >
                Stop to review and ship
              </Button>
            )}
            {!canStopForReview && (
              <p className="mt-3 text-xs text-kumo-subtle">
                Waiting for the environment to reach a stoppable state.
              </p>
            )}
          </div>
        </div>
      ) : branchStatus === "needs-attention" ? (
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-kumo-subtle">
          Shipping is unavailable until this environment is reset or repaired.
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-kumo-subtle">Loading changes...</div>
      ) : changes && changes.summary.total === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-kumo-subtle">
          There are no changes to ship.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,320px)_minmax(0,1fr)] overflow-hidden">
          <div className="tiller-implementation-ship-files flex min-h-0 flex-col border-r border-kumo-line bg-kumo-recessed">
            <div className="shrink-0 border-b border-kumo-line px-3 py-2 text-xs text-kumo-subtle">
              {changes ? `${changes.summary.total} changed file${changes.summary.total === 1 ? "" : "s"}` : "Changed files"}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {groupedFiles.map((group) => (
                <div key={group.title} className="border-b border-kumo-line py-2">
                  <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-kumo-subtle">
                    {group.title}
                  </div>
                  {group.files.map((file) => (
                    <button
                      key={file.path}
                      onClick={() => setSelectedPath(file.path)}
                      aria-current={file.path === selectedPath ? "true" : undefined}
                      className={`tiller-implementation-ship-file block w-full px-3 py-1.5 text-left text-xs hover:bg-kumo-base ${
                        file.path === selectedPath ? "bg-kumo-base text-kumo-link" : "text-kumo-default"
                      }`}
                    >
                      <div className="truncate font-mono">{file.path}</div>
                      <div className="mt-0.5 text-[11px] text-kumo-subtle">
                        {formatStatus(file.status)} · {formatBytes(file.oldSize)} {"->"} {formatBytes(file.newSize)}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="min-h-0 min-w-0 overflow-auto">
            {!selectedEntry ? (
              <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">Select a file</div>
            ) : fileLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">Loading file diff...</div>
            ) : fileDiff && !fileDiff.previewable ? (
              <div className="p-4 text-sm text-kumo-subtle">
                <div className="font-medium text-kumo-default">{selectedEntry.path}</div>
                <div className="mt-1 text-xs">
                  This file is not previewable
                  {fileDiff.reason ? ` (${fileDiff.reason})` : ""}.
                </div>
              </div>
            ) : fileDiff ? (
              <div className="tiller-implementation-ship-diff min-w-0 bg-[var(--tiller-theme-on-action)]">
                <div className="tiller-implementation-ship-file-header border-b border-kumo-line bg-kumo-recessed px-3 py-2 font-mono text-xs text-kumo-subtle">
                  {fileDiff.path}
                </div>
                <ReactDiffViewer
                  oldValue={fileDiff.oldString}
                  newValue={fileDiff.newString}
                  splitView={false}
                  showDiffOnly={true}
                  extraLinesSurroundingDiff={3}
                  useDarkTheme={resolvedTheme === "dark"}
                  styles={{
                    variables: {
                      light: {
                        diffViewerBackground: "var(--tiller-theme-on-action)",
                        diffViewerColor: "var(--paperwing-ink)",
                        gutterBackground: "var(--tiller-theme-on-action)",
                        gutterBackgroundDark: "var(--tiller-theme-on-action)",
                        emptyLineBackground: "var(--tiller-theme-on-action)",
                        codeFoldBackground: "var(--tiller-theme-on-action)",
                        codeFoldGutterBackground: "var(--tiller-theme-on-action)",
                        diffViewerTitleBackground: "var(--tiller-theme-on-action)",
                        addedBackground: "#dafbe1",
                        addedColor: "#1a7f37",
                        removedBackground: "#ffebe9",
                        removedColor: "#cf222e",
                        wordAddedBackground: "#aceebb",
                        wordRemovedBackground: "#ffcecb",
                      },
                      dark: {
                        diffViewerBackground: "#1c1c1c",
                        diffViewerColor: "#e6e6e6",
                        addedBackground: "#12261e",
                        addedColor: "#3fb950",
                        removedBackground: "#25171c",
                        removedColor: "#ff7b72",
                        wordAddedBackground: "#1f4429",
                        wordRemovedBackground: "#552527",
                      },
                    },
                    contentText: {
                      fontSize: "12px",
                      lineHeight: "18px",
                    },
                    lineNumber: {
                      fontSize: "11px",
                      lineHeight: "18px",
                    },
                  }}
                />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
}
