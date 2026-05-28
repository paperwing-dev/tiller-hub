import { useEffect, useMemo, useState } from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import type { EnvMeta, RepoMeta } from "../api/types";
import {
  fetchEnvChangeFile,
  fetchEnvChanges,
  mergeEnvIntoMain,
  resetEnvToRepo,
  updateEnvFromMain,
  type EnvChangeEntry,
  type EnvChangeFileResponse,
  type EnvChangesResponse,
} from "./api";
import { getDisplayEnvBranchStatus } from "./env-state";
import type { RecoverEntitiesOptions } from "./live-sync-store";

interface ChangesViewProps {
  env: EnvMeta;
  repo: RepoMeta;
  hubUrl: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onRecoverEntities?: (options?: RecoverEntitiesOptions) => void;
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

export default function ChangesView({
  env,
  repo,
  hubUrl,
  onRecoverEnv,
  onRecoverEntities,
}: ChangesViewProps) {
  const branchStatus = getDisplayEnvBranchStatus(env, repo);
  const canRepoAction = (env.status ?? "unknown") === "stopped" && !env.scmOperationType;
  const canLoadPreview = canRepoAction && (branchStatus === "ready-to-merge" || branchStatus === "up-to-date");
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
      setError(err instanceof Error ? err.message : "Failed to load promote preview.");
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
    if (!selectedPath || !canLoadPreview || branchStatus !== "ready-to-merge") {
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

  const promote = () => runAction(async () => {
    const res = await mergeEnvIntoMain(hubUrl, env.slug);
    if (!res.pending) {
      onRecoverEnv?.(env.slug);
    }
    onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
  });

  const updateFromMain = () => runAction(async () => {
    const res = await updateEnvFromMain(hubUrl, env.slug);
    if (!res.pending) {
      onRecoverEnv?.(env.slug);
    }
    onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
  });

  const resetToMain = () => {
    if (!confirm(`Reset "${env.slug}" to main? This will discard unpromoted changes.`)) {
      return;
    }
    void runAction(async () => {
      await resetEnvToRepo(hubUrl, env.slug);
      onRecoverEnv?.(env.slug);
      onRecoverEntities?.({ slug: env.slug, repoId: repo.repoId });
    });
  };

  const actionBar = (
    <div className="flex flex-wrap items-center gap-2">
      {canRepoAction && branchStatus === "ready-to-merge" && (
        <button
          onClick={promote}
          disabled={busy}
          className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] hover:bg-[#f6f8fa] disabled:opacity-50"
        >
          Promote to Main
        </button>
      )}
      {canRepoAction && branchStatus === "behind-main" && (
        <button
          onClick={updateFromMain}
          disabled={busy}
          className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] hover:bg-[#f6f8fa] disabled:opacity-50"
        >
          Update from Main
        </button>
      )}
      {canRepoAction && (branchStatus === "ready-to-merge" || branchStatus === "behind-main" || branchStatus === "needs-attention") && (
        <button
          onClick={resetToMain}
          disabled={busy}
          className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-50"
        >
          Reset to Main
        </button>
      )}
      {canRepoAction && branchStatus === "ready-to-merge" && (
        <button
          onClick={() => void loadChanges()}
          disabled={busy || loading}
          className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#57606a] hover:bg-[#f6f8fa] disabled:opacity-50"
        >
          Refresh
        </button>
      )}
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white">
      <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs font-medium uppercase tracking-wide text-[#57606a]">Promote Preview</div>
            <h2 className="mt-0.5 truncate text-base font-semibold text-[#24292f]">{env.slug}</h2>
            <p className="mt-1 truncate text-xs text-[#57606a]">{repo.repoUrl}</p>
            <p className="mt-1 text-xs text-[#57606a]">
              Main {shortCommit(repo.mainCommit)} · Env base {shortCommit(env.baseMainCommit)}
            </p>
          </div>
          {actionBar}
        </div>
        {branchStatus === "behind-main" && (
          <div className="mt-3 rounded border border-[#d4a72c]/40 bg-[#fff8c5] px-3 py-2 text-xs text-[#57606a]">
            Main has changed since this environment was created. Update from Main before previewing or promoting.
          </div>
        )}
        {branchStatus === "needs-attention" && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            This environment has conflicts or unsupported git state. Reset to Main to discard it.
          </div>
        )}
        {error && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
            <div>{error}</div>
            {hint && <div className="mt-1 text-red-600">{hint}</div>}
          </div>
        )}
      </div>

      {!canRepoAction ? (
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-[#57606a]">
          {env.scmOperationType
            ? "Promote Preview is unavailable while an SCM operation is in progress."
            : "Stop this environment to enable Promote Preview."}
        </div>
      ) : branchStatus !== "ready-to-merge" && branchStatus !== "up-to-date" ? (
        <div className="flex flex-1 items-center justify-center px-4 text-sm text-[#57606a]">
          {branchStatus === "behind-main"
            ? "Update this environment from main to enable Promote Preview."
            : "Promote Preview is unavailable for this environment state."}
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[#57606a]">Loading preview...</div>
      ) : changes && changes.summary.total === 0 ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[#57606a]">
          There are no changes to promote from this environment.
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(220px,320px)_1fr]">
          <div className="min-h-0 overflow-y-auto border-r border-[#d0d7de] bg-[#f6f8fa]">
            <div className="border-b border-[#d0d7de] px-3 py-2 text-xs text-[#57606a]">
              {changes ? `${changes.summary.total} changed file${changes.summary.total === 1 ? "" : "s"}` : "Changed files"}
            </div>
            {groupedFiles.map((group) => (
              <div key={group.title} className="border-b border-[#e1e4e8] py-2">
                <div className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-[#57606a]">
                  {group.title}
                </div>
                {group.files.map((file) => (
                  <button
                    key={file.path}
                    onClick={() => setSelectedPath(file.path)}
                    className={`block w-full px-3 py-1.5 text-left text-xs hover:bg-white ${
                      file.path === selectedPath ? "bg-white text-[#0969da]" : "text-[#24292f]"
                    }`}
                  >
                    <div className="truncate font-mono">{file.path}</div>
                    <div className="mt-0.5 text-[11px] text-[#6e7781]">
                      {formatStatus(file.status)} · {formatBytes(file.oldSize)} {"->"} {formatBytes(file.newSize)}
                    </div>
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="min-w-0 overflow-auto">
            {!selectedEntry ? (
              <div className="flex h-full items-center justify-center text-sm text-[#57606a]">Select a file</div>
            ) : fileLoading ? (
              <div className="flex h-full items-center justify-center text-sm text-[#57606a]">Loading file diff...</div>
            ) : fileDiff && !fileDiff.previewable ? (
              <div className="p-4 text-sm text-[#57606a]">
                <div className="font-medium text-[#24292f]">{selectedEntry.path}</div>
                <div className="mt-1 text-xs">
                  This file is not previewable
                  {fileDiff.reason ? ` (${fileDiff.reason})` : ""}.
                </div>
              </div>
            ) : fileDiff ? (
              <div className="min-w-0">
                <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 font-mono text-xs text-[#57606a]">
                  {fileDiff.path}
                </div>
                <ReactDiffViewer
                  oldValue={fileDiff.oldString}
                  newValue={fileDiff.newString}
                  splitView={false}
                  showDiffOnly={true}
                  extraLinesSurroundingDiff={3}
                  useDarkTheme={false}
                  styles={{
                    variables: {
                      light: {
                        diffViewerBackground: "#ffffff",
                        diffViewerColor: "#24292f",
                        addedBackground: "#dafbe1",
                        addedColor: "#1a7f37",
                        removedBackground: "#ffebe9",
                        removedColor: "#cf222e",
                        wordAddedBackground: "#aceebb",
                        wordRemovedBackground: "#ffcecb",
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
