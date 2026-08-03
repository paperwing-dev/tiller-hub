import React, { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type {
  EnvMeta,
  StartupDiagnosticLogTails,
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
} from "../api/types";
import { fetchEnvStartupDiagnostics } from "./api";
import SailingScene from "./SailingScene";
import { getEnvWaitingPresentation } from "./env-waiting-presentation";

const EMPTY_DIAGNOSTICS: StartupDiagnosticsState = {
  active: null,
  lastFailed: null,
};

const STEP_LABELS: Record<string, string> = {
  "workspace-sync": "Workspace Sync",
  "stop-control": "Stop Control",
  "prereq-check": "Prerequisite Check",
  "harness-launch": "Harness Launch",
  "hub-connect": "Hub Connection",
  "runner-ready": "Runner Ready",
  "startup-failed": "Startup Failed",
};

interface EnvWaitingViewProps {
  env: EnvMeta;
  hubUrl: string;
  onRecoverEnv?: (slug: string, status?: string) => void;
  onStartRequest?: (slug: string) => void;
}

interface DiagnosticsResult {
  envIdentity: string;
  value: StartupDiagnosticsState;
}

interface DetailsState {
  operationKey: string;
  open: boolean;
}

interface CopyStatus {
  opId: string | null;
  state: "idle" | "copied" | "failed";
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

function formatElapsedTime(elapsedMs: number): string {
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function hasLogTail(logTails?: StartupDiagnosticLogTails | null): boolean {
  return Boolean(logTails?.harness || logTails?.stopControl || logTails?.bootstrap);
}

function renderLogTail(title: string, value: string | null) {
  if (!value) return null;
  return (
    <div className="rounded-lg border border-kumo-line bg-kumo-contrast">
      <div className="border-b border-kumo-line px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-kumo-inverse opacity-70">
        {title}
      </div>
      <pre className="overflow-x-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5 text-kumo-inverse">
        {value}
      </pre>
    </div>
  );
}

function DiagnosticsPanel({
  snapshot,
  copyStatus,
  onCopy,
}: {
  snapshot: StartupDiagnosticsSnapshot;
  copyStatus: CopyStatus;
  onCopy: (snapshot: StartupDiagnosticsSnapshot) => void;
}) {
  const copyLabel = copyStatus.opId === snapshot.opId
    ? copyStatus.state === "copied"
      ? "Copied"
      : copyStatus.state === "failed"
        ? "Copy Failed"
        : "Copy Diagnostics"
    : "Copy Diagnostics";

  return (
    <section
      aria-label={`Startup diagnostics for operation ${snapshot.opId}`}
      className="overflow-hidden rounded-lg border border-kumo-line bg-kumo-elevated"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-kumo-line bg-kumo-recessed px-4 py-3">
        <div>
          <h3 className="text-sm font-semibold text-kumo-strong">Startup diagnostics</h3>
          <p className="mt-0.5 text-[11px] text-kumo-subtle">
            Operation {snapshot.opId} · {snapshot.backend.toUpperCase()} · started {formatTimestamp(snapshot.startedAt) ?? snapshot.startedAt} · updated {formatTimestamp(snapshot.updatedAt) ?? snapshot.updatedAt}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => onCopy(snapshot)}
        >
          {copyLabel}
        </Button>
      </div>

      <div className="grid gap-4 p-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,0.9fr)]">
        <div className="space-y-4">
          <div className="rounded border border-kumo-line">
            <div className="border-b border-kumo-line px-3 py-2 text-xs font-medium uppercase tracking-wide text-kumo-subtle">
              Timeline
            </div>
            <div className="max-h-80 overflow-y-auto px-3 py-2 font-mono text-xs">
              {snapshot.events.length === 0 ? (
                <p className="text-kumo-subtle">No events reported yet.</p>
              ) : (
                snapshot.events.map((event, index) => (
                  <div
                    key={`${event.at}-${index}`}
                    className="border-b border-kumo-hairline py-2 last:border-b-0"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-kumo-subtle">{formatTimestamp(event.at) ?? event.at}</span>
                      <span className="rounded bg-kumo-recessed px-1.5 py-0.5 text-[10px] font-medium text-kumo-subtle">
                        {formatStepLabel(event.stepId)}
                      </span>
                      <span
                        className={`text-[10px] font-semibold uppercase tracking-wide ${
                          event.severity === "error"
                            ? "text-kumo-danger"
                            : event.severity === "warn"
                              ? "text-kumo-warning"
                              : "text-kumo-subtle"
                        }`}
                      >
                        {event.severity}
                      </span>
                    </div>
                    <p className="mt-1 text-kumo-default">{event.message}</p>
                    {event.detail && (
                      <p className="mt-1 whitespace-pre-wrap text-kumo-subtle">{event.detail}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>

          {hasLogTail(snapshot.logTails) && (
            <div className="space-y-3">
              {renderLogTail("Harness Log Tail", snapshot.logTails.harness)}
              {renderLogTail("Stop-Control Log Tail", snapshot.logTails.stopControl)}
              {renderLogTail("Bootstrap Log Tail", snapshot.logTails.bootstrap)}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <div className="rounded border border-kumo-line bg-kumo-recessed p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Current step</p>
            <p className="mt-2 text-sm font-medium text-kumo-default">
              {formatStepLabel(snapshot.currentStepId) ?? "Waiting for diagnostics"}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm text-kumo-subtle">
              {snapshot.currentStepMessage ?? "No step message yet."}
            </p>
          </div>

          <div className="rounded border border-kumo-line bg-kumo-recessed p-3">
            <p className="text-xs font-medium uppercase tracking-wide text-kumo-subtle">Failure</p>
            <p className="mt-2 whitespace-pre-wrap text-sm text-kumo-default">
              {snapshot.failure?.message ?? "No startup failure recorded."}
            </p>
            {snapshot.failure?.lastStepId && (
              <p className="mt-1 text-xs text-kumo-subtle">
                Last step: {formatStepLabel(snapshot.failure.lastStepId)}
              </p>
            )}
            {(snapshot.failure?.exitCode != null || snapshot.failure?.signal) && (
              <p className="mt-1 text-xs text-kumo-subtle">
                exit={snapshot.failure?.exitCode ?? "n/a"} signal={snapshot.failure?.signal ?? "n/a"}
              </p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export default function EnvWaitingView({ env, hubUrl, onStartRequest }: EnvWaitingViewProps) {
  const envIdentity = env.incarnationId ?? env.slug;
  const operationKey = `${envIdentity}:${env.lifecycleOpId ?? "no-operation"}`;
  const [diagnosticsResult, setDiagnosticsResult] = useState<DiagnosticsResult>(() => ({
    envIdentity,
    value: EMPTY_DIAGNOSTICS,
  }));
  const [detailsState, setDetailsState] = useState<DetailsState>(() => ({
    operationKey,
    open: false,
  }));
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>({ opId: null, state: "idle" });
  const autoOpenedOperationKeysRef = useRef(new Set<string>());
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const diagnostics = diagnosticsResult.envIdentity === envIdentity
    ? diagnosticsResult.value
    : EMPTY_DIAGNOSTICS;
  const presentation = getEnvWaitingPresentation(env, diagnostics);
  const detailsOpen = detailsState.operationKey === operationKey && detailsState.open;
  const activeDiagnostics = diagnostics.active;
  const previousFailure = diagnostics.lastFailed?.opId === activeDiagnostics?.opId
    ? null
    : diagnostics.lastFailed;

  const matchingStartedAt = presentation.elapsedTimeEligible
    && Boolean(env.lifecycleOpId)
    && activeDiagnostics !== null
    && activeDiagnostics.opId === env.lifecycleOpId
    ? activeDiagnostics.startedAt
    : null;

  useEffect(() => {
    let cancelled = false;
    setCopyStatus({ opId: null, state: "idle" });

    fetchEnvStartupDiagnostics(hubUrl, env.slug)
      .then((next) => {
        if (!cancelled) {
          setDiagnosticsResult({ envIdentity, value: next });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.warn("[tiller] Failed to fetch startup diagnostics:", error);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [envIdentity, env.lifecycleOpId, env.slug, env.status, env.updatedAt, hubUrl]);

  useEffect(() => {
    if (presentation.displayState !== "startup-failure") return;
    if (autoOpenedOperationKeysRef.current.has(operationKey)) return;

    autoOpenedOperationKeysRef.current.add(operationKey);
    setDetailsState({ operationKey, open: true });
  }, [operationKey, presentation.displayState]);

  useEffect(() => {
    if (!matchingStartedAt) {
      setElapsedMs(null);
      return undefined;
    }

    const startedAtMs = Date.parse(matchingStartedAt);
    const updateElapsedTime = () => {
      const nextElapsedMs = Date.now() - startedAtMs;
      setElapsedMs(
        Number.isFinite(startedAtMs) && nextElapsedMs >= 0
          ? nextElapsedMs
          : null,
      );
    };

    updateElapsedTime();
    const timer = setInterval(updateElapsedTime, 1000);
    return () => clearInterval(timer);
  }, [matchingStartedAt, operationKey]);

  useEffect(() => () => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
    }
  }, []);

  const copyDiagnostics = async (snapshot: StartupDiagnosticsSnapshot) => {
    if (copyResetTimerRef.current) {
      clearTimeout(copyResetTimerRef.current);
      copyResetTimerRef.current = null;
    }

    try {
      if (!globalThis.navigator?.clipboard?.writeText) {
        throw new Error("Clipboard API unavailable");
      }
      await globalThis.navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2));
      setCopyStatus({ opId: snapshot.opId, state: "copied" });
      copyResetTimerRef.current = setTimeout(() => {
        setCopyStatus({ opId: null, state: "idle" });
        copyResetTimerRef.current = null;
      }, 1200);
    } catch (error) {
      console.error("[tiller] Failed to copy diagnostics:", error);
      setCopyStatus({ opId: snapshot.opId, state: "failed" });
    }
  };

  const primaryActionLabel = presentation.primaryAction === "start"
    ? "Start environment"
    : presentation.primaryAction === "retry"
      ? "Try again"
      : null;

  return (
    <div className="flex flex-1 flex-col">
      <div className="flex-1 overflow-y-auto bg-kumo-base">
        <main className="mx-auto flex min-h-full w-full max-w-4xl flex-col items-center px-4 py-8 sm:px-6 sm:py-12">
          <div className="flex w-full flex-col items-center text-center">
            <h1 className="text-2xl font-semibold tracking-tight text-kumo-strong sm:text-3xl">
              {presentation.heading}
            </h1>

            <p className="mt-3 flex min-h-6 flex-wrap items-baseline justify-center gap-x-2 text-sm text-kumo-subtle sm:text-base">
              <span aria-live="polite" aria-atomic="true">{presentation.actionText}</span>
              {elapsedMs != null && (
                <span data-testid="startup-elapsed" className="tabular-nums text-kumo-subtle">
                  Elapsed {formatElapsedTime(elapsedMs)}
                </span>
              )}
            </p>

            <div className="mt-7 flex w-full justify-center sm:mt-9">
              <SailingScene motionVariant={presentation.motionVariant} />
            </div>

            {primaryActionLabel && (
              <Button
                type="button"
                variant="primary"
                size="lg"
                className="mt-7"
                onClick={() => onStartRequest?.(env.slug)}
              >
                {primaryActionLabel}
              </Button>
            )}

            <details
              key={operationKey}
              open={detailsOpen}
              onToggle={(event) => {
                setDetailsState({
                  operationKey,
                  open: event.currentTarget.open,
                });
              }}
              className="mt-8 w-full rounded-xl border border-kumo-line bg-kumo-elevated text-left shadow-sm"
            >
              <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-kumo-default sm:px-5">
                Technical details
              </summary>

              <div className="space-y-4 border-t border-kumo-line p-4 sm:p-5">
                <section aria-labelledby="environment-metadata-heading">
                  <h2 id="environment-metadata-heading" className="text-xs font-semibold uppercase tracking-wide text-kumo-subtle">
                    Environment metadata
                  </h2>
                  <dl className="mt-2 grid gap-2 rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-xs sm:grid-cols-2">
                    <div>
                      <dt className="font-medium text-kumo-subtle">Status</dt>
                      <dd className="mt-0.5 font-mono text-kumo-default">{env.status}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-kumo-subtle">Operation ID</dt>
                      <dd className="mt-0.5 break-all font-mono text-kumo-default">{env.lifecycleOpId ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-kumo-subtle">Lifecycle operation</dt>
                      <dd className="mt-0.5 font-mono text-kumo-default">{env.lifecycleOperation ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-kumo-subtle">Desired state</dt>
                      <dd className="mt-0.5 font-mono text-kumo-default">{env.lifecycleDesiredState ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-kumo-subtle">Startup step</dt>
                      <dd className="mt-0.5 font-mono text-kumo-default">{env.bootStepId ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt className="font-medium text-kumo-subtle">Last updated</dt>
                      <dd className="mt-0.5 font-mono text-kumo-default">{formatTimestamp(env.updatedAt) ?? env.updatedAt}</dd>
                    </div>
                  </dl>
                  {(env.bootMessage || env.error) && (
                    <div className="mt-2 rounded-lg border border-kumo-line bg-kumo-recessed p-3 text-xs">
                      <p className="font-medium text-kumo-subtle">Raw environment message</p>
                      {env.bootMessage && <p className="mt-1 whitespace-pre-wrap text-kumo-default">{env.bootMessage}</p>}
                      {env.error && <p className="mt-1 whitespace-pre-wrap text-kumo-danger">{env.error}</p>}
                    </div>
                  )}
                </section>

                {activeDiagnostics ? (
                  <DiagnosticsPanel
                    snapshot={activeDiagnostics}
                    copyStatus={copyStatus}
                    onCopy={(snapshot) => void copyDiagnostics(snapshot)}
                  />
                ) : (
                  <p className="rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-subtle">
                    No active startup diagnostics are available.
                  </p>
                )}

                {previousFailure && (
                  <details
                    key={`${envIdentity}:last-failed:${previousFailure.opId}`}
                    className="rounded-lg border border-kumo-line bg-kumo-base"
                  >
                    <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-kumo-default">
                      Previous startup failure
                    </summary>
                    <div className="border-t border-kumo-line p-3">
                      <DiagnosticsPanel
                        snapshot={previousFailure}
                        copyStatus={copyStatus}
                        onCopy={(snapshot) => void copyDiagnostics(snapshot)}
                      />
                    </div>
                  </details>
                )}
              </div>
            </details>
          </div>
        </main>
      </div>
    </div>
  );
}
