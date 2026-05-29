import React, { useEffect, useState } from "react";
import type { EnvMeta, StartupDiagnosticLogTails, StartupDiagnosticsSnapshot } from "../api/types";
import {
  fetchEnvStartupDiagnostics,
  type StartupDiagnosticsState,
} from "./api";
import {
  getEnvAuthBadge,
  getHarnessBadgeClass,
  getHarnessBadgeLabel,
} from "./env-harness";
import { getBackendBadgeLabel, getEnvDisplayName } from "./env-display";

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

const STATUS_LABELS: Record<string, string> = {
  running: "Running",
  starting: "Starting...",
  saving: "Saving changes...",
  stopping: "Stopping...",
  creating: "Creating...",
  deleting: "Deleting...",
  stopped: "Stopped",
  created: "Created",
  destroyed: "Destroyed",
  failed: "Failed",
  unknown: "Unknown",
};

const STEP_LABELS: Record<string, string> = {
  "workspace-sync": "Workspace Sync",
  "stop-control": "Stop Control",
  "prereq-check": "Prereq Check",
  "harness-launch": "Harness Launch",
  "hub-connect": "Hub Connect",
  "runner-ready": "Runner Ready",
  "startup-failed": "Startup Failed",
};

interface EnvWaitingViewProps {
  env: EnvMeta;
  hubUrl: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onStartRequest?: (slug: string) => void;
}

function formatStepLabel(stepId?: string | null): string | null {
  if (!stepId) return null;
  return STEP_LABELS[stepId] ?? stepId;
}

function formatTimestamp(value?: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function describeCurrentState(env: EnvMeta, diagnostics: StartupDiagnosticsSnapshot | null): string {
  if (diagnostics?.currentStepMessage) {
    return diagnostics.currentStepMessage;
  }
  if (env.bootMessage) {
    return env.bootMessage;
  }
  if (env.status === "saving") {
    return "Persisting workspace changes before shutdown...";
  }
  if (env.status === "stopping") {
    return "Workspace saved. Waiting for the container to stop...";
  }
  if (env.status === "starting") {
    return "Container is booting...";
  }
  if (env.status === "creating") {
    return "Preparing environment...";
  }
  if (env.status === "failed") {
    return env.error?.trim() || "Startup failed.";
  }
  return "Container is stopped";
}

function hasLogTail(logTails?: StartupDiagnosticLogTails | null): boolean {
  return Boolean(logTails?.harness || logTails?.stopControl || logTails?.bootstrap);
}

function renderLogTail(title: string, value: string | null) {
  if (!value) return null;
  return (
    <div className="rounded border border-[#30363d] bg-[#0d1117]">
      <div className="border-b border-[#30363d] px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-[#8b949e]">
        {title}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5 text-[#c9d1d9]">
        {value}
      </pre>
    </div>
  );
}

export default function EnvWaitingView({ env, hubUrl, onStartRequest }: EnvWaitingViewProps) {
  const [diagnostics, setDiagnostics] = useState<StartupDiagnosticsState>({ active: null, lastFailed: null });
  const [showLastFailed, setShowLastFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  const status = env.status || "unknown";
  const isCreating = status === "creating";
  const isStarting = status === "starting";
  const isSaving = status === "saving";
  const isStopping = status === "stopping";
  const isDeleting = status === "deleting";
  const isFailed = status === "failed";
  const isStoppedState = status === "stopped" || status === "unknown";
  const isStopped = isStoppedState || isFailed;
  const dotColor = STATUS_COLORS[status] || "bg-[#d0d7de]";
  const label = STATUS_LABELS[status] || status;
  const harness = env.harness;
  const authBadge = getEnvAuthBadge(env);
  const displayName = getEnvDisplayName(env);
  const displayedDiagnostics = diagnostics.active ?? (showLastFailed ? diagnostics.lastFailed : null);
  const currentStepLabel = formatStepLabel(env.bootStepId ?? displayedDiagnostics?.currentStepId ?? null);

  useEffect(() => {
    let cancelled = false;
    setCopyStatus("idle");
    fetchEnvStartupDiagnostics(hubUrl, env.slug)
      .then((next) => {
        if (!cancelled) {
          setDiagnostics(next);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[tiller] Failed to fetch startup diagnostics:", error);
          setDiagnostics({ active: null, lastFailed: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hubUrl, env.slug, env.updatedAt, env.status, env.lifecycleOpId]);

  useEffect(() => {
    setShowLastFailed(false);
  }, [env.slug, diagnostics.active?.opId]);

  const copyDiagnostics = async () => {
    if (!displayedDiagnostics) return;
    try {
      if (!globalThis.navigator?.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await globalThis.navigator.clipboard.writeText(JSON.stringify(displayedDiagnostics, null, 2));
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 1200);
    } catch (error) {
      console.error("[tiller] Failed to copy diagnostics:", error);
      setCopyStatus("failed");
    }
  };

  return (
    <div className="flex-1 flex flex-col">
      <div className="px-4 py-2.5 border-b border-[#d0d7de] flex items-center justify-between bg-[#f6f8fa]">
        <div className="flex items-center gap-3">
          <span className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#24292f]">{displayName}</h2>
              <span className="rounded border border-[#d0d7de] bg-white px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-[#57606a]">
                {getBackendBadgeLabel(env.backend)}
              </span>
              <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getHarnessBadgeClass(harness)}`}>
                {getHarnessBadgeLabel(harness)}
              </span>
              {authBadge && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${authBadge.className}`}>
                  {authBadge.label}
                </span>
              )}
            </div>
            <p className="text-xs text-[#57606a]">
              {label}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {displayedDiagnostics && (
            <button
              onClick={() => void copyDiagnostics()}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
            >
              {copyStatus === "copied" ? "Copied" : copyStatus === "failed" ? "Copy Failed" : "Copy Diagnostics"}
            </button>
          )}
          {!diagnostics.active && diagnostics.lastFailed && (
            <button
              onClick={() => setShowLastFailed((value) => !value)}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
            >
              {showLastFailed ? "Hide Recent Failure" : "Show Recent Failure"}
            </button>
          )}
          {isStopped && (
            <button
              onClick={() => onStartRequest?.(env.slug)}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
            >
              Start
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto bg-[#ffffff]">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-8">
          <div className="rounded-lg border border-[#d0d7de] bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2">
              <span className={`h-3 w-3 rounded-full ${dotColor}`} />
              <span className="text-sm font-medium text-[#24292f]">{label}</span>
              {currentStepLabel && (
                <span className="rounded bg-[#f6f8fa] px-2 py-0.5 text-[11px] font-medium text-[#57606a]">
                  {currentStepLabel}
                </span>
              )}
            </div>

            <div className="mt-3 flex flex-col gap-3">
              {(isCreating || isStarting || isSaving || isStopping || isDeleting) && (
                <div className="flex items-center gap-3">
                  <Spinner />
                  <p className="text-sm text-[#57606a]">{describeCurrentState(env, displayedDiagnostics)}</p>
                </div>
              )}

              {isFailed && (
                <div className="rounded border border-red-200 bg-red-50 px-3 py-2">
                  <p className="text-sm font-medium text-red-700">
                    {displayedDiagnostics?.failure?.message ?? env.error?.trim() ?? "Startup failed."}
                  </p>
                  {displayedDiagnostics?.failure?.lastStepId && (
                    <p className="mt-1 text-xs text-red-700">
                      Failed at {formatStepLabel(displayedDiagnostics.failure.lastStepId)}
                    </p>
                  )}
                </div>
              )}

              {isStoppedState && !isFailed && (
                <p className="text-sm text-[#57606a]">Container is stopped.</p>
              )}
            </div>
          </div>

          {displayedDiagnostics && (
            <div className="rounded-lg border border-[#d0d7de] bg-white shadow-sm overflow-hidden">
              <div className="flex items-center justify-between border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2.5">
                <div>
                  <p className="text-sm font-semibold text-[#24292f]">Startup Diagnostics</p>
                  <p className="text-[11px] text-[#57606a]">
                    Op {displayedDiagnostics.opId} · {displayedDiagnostics.backend.toUpperCase()} · updated {formatTimestamp(displayedDiagnostics.updatedAt) ?? displayedDiagnostics.updatedAt}
                  </p>
                </div>
              </div>

              <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
                <div className="space-y-4">
                  <div className="rounded border border-[#d0d7de]">
                    <div className="border-b border-[#d0d7de] px-3 py-2 text-xs font-medium uppercase tracking-wide text-[#57606a]">
                      Timeline
                    </div>
                    <div className="max-h-80 overflow-y-auto px-3 py-2 font-mono text-xs">
                      {displayedDiagnostics.events.length === 0 ? (
                        <p className="text-[#57606a]">No events reported yet.</p>
                      ) : (
                        displayedDiagnostics.events.map((event, index) => (
                          <div key={`${event.at}-${index}`} className="border-b border-[#f6f8fa] py-2 last:border-b-0">
                            <div className="flex items-center gap-2">
                              <span className="text-[#8b949e]">{formatTimestamp(event.at) ?? event.at}</span>
                              <span className="rounded bg-[#f6f8fa] px-1.5 py-0.5 text-[10px] font-medium text-[#57606a]">
                                {formatStepLabel(event.stepId)}
                              </span>
                              <span className={`text-[10px] font-semibold uppercase tracking-wide ${
                                event.severity === "error"
                                  ? "text-red-600"
                                  : event.severity === "warn"
                                    ? "text-amber-600"
                                    : "text-[#57606a]"
                              }`}
                              >
                                {event.severity}
                              </span>
                            </div>
                            <p className="mt-1 text-[#24292f]">{event.message}</p>
                            {event.detail && (
                              <p className="mt-1 whitespace-pre-wrap text-[#57606a]">{event.detail}</p>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  {hasLogTail(displayedDiagnostics.logTails) && (
                    <div className="space-y-3">
                      {renderLogTail("Harness Log Tail", displayedDiagnostics.logTails.harness)}
                      {renderLogTail("Stop-Control Log Tail", displayedDiagnostics.logTails.stopControl)}
                      {renderLogTail("Bootstrap Log Tail", displayedDiagnostics.logTails.bootstrap)}
                    </div>
                  )}
                </div>

                <div className="space-y-4">
                  <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-[#57606a]">Current Step</p>
                    <p className="mt-2 text-sm font-medium text-[#24292f]">
                      {formatStepLabel(displayedDiagnostics.currentStepId) ?? "Waiting for diagnostics"}
                    </p>
                    <p className="mt-1 text-sm text-[#57606a]">
                      {displayedDiagnostics.currentStepMessage ?? "No step message yet."}
                    </p>
                  </div>

                  <div className="rounded border border-[#d0d7de] bg-[#f6f8fa] p-3">
                    <p className="text-xs font-medium uppercase tracking-wide text-[#57606a]">Failure</p>
                    <p className="mt-2 text-sm text-[#24292f]">
                      {displayedDiagnostics.failure?.message ?? "No startup failure recorded."}
                    </p>
                    {(displayedDiagnostics.failure?.exitCode != null || displayedDiagnostics.failure?.signal) && (
                      <p className="mt-1 text-xs text-[#57606a]">
                        exit={displayedDiagnostics.failure?.exitCode ?? "n/a"} signal={displayedDiagnostics.failure?.signal ?? "n/a"}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin h-5 w-5 text-[#57606a]" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
