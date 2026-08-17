import React, { useEffect, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import type {
  EnvMeta,
  StartupDiagnosticsState,
} from "../api/types";
import { fetchEnvStartupDiagnostics, startEnv } from "./api";
import { getEnvWaitingPresentation } from "./env-waiting-presentation";
import { getBackendBadgeLabel } from "./env-display";
import { getEnvAuthBadge, getEnvModelLabel, getHarnessBadgeLabel } from "./env-harness";

const WAVE_WIDTH = 76;
const WAVE_HEIGHT = 18;
const WAVE_FRAME_MS = 33;
const WAVE_SPEED = 1.35;

export function renderAsciiWaveFrame(
  phase: number,
  width = WAVE_WIDTH,
  height = WAVE_HEIGHT,
): string {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => " "));
  for (let x = 0; x < width; x += 1) {
    const primaryCenter = height * 0.45
      + Math.sin(x * 0.14 + phase) * 2.8
      + Math.sin(x * 0.055 - phase * 0.65) * 1.7;
    const primaryThickness = 2.4 + (Math.sin(x * 0.1 - phase * 0.35) + 1) * 0.9;
    const secondaryCenter = height * 0.68
      + Math.sin(x * 0.105 - phase * 0.8) * 2.1
      + Math.sin(x * 0.24 + phase * 0.45) * 0.7;

    for (let y = 0; y < height; y += 1) {
      const primaryDistance = Math.abs(y - primaryCenter);
      const secondaryDistance = Math.abs(y - secondaryCenter);
      const texture = Math.sin(x * 0.73 + y * 1.31 + phase * 1.9);
      const drift = Math.sin(x * 0.19 - y * 0.42 - phase);
      if (primaryDistance <= primaryThickness) {
        const edge = primaryDistance / primaryThickness;
        grid[y]![x] = edge > 0.8
          ? texture > 0.05 ? "." : "'"
          : texture > 0.56 ? "+"
            : drift > 0.2 ? "/"
              : drift < -0.2 ? "\\" : ",";
      }
      if (secondaryDistance <= 1.15 && (grid[y]![x] === " " || texture > 0.25)) {
        grid[y]![x] = texture > 0.4 ? "+" : texture < -0.45 ? "." : "~";
      }
    }
  }
  return grid.map((row) => row.join("").trimEnd()).join("\n");
}

export function EnvironmentLaunchIllustration({
  compact = false,
  animated = true,
}: {
  compact?: boolean;
  animated?: boolean;
} = {}) {
  const waveRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (!animated) return undefined;
    const reduceMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const requestFrame = globalThis.requestAnimationFrame?.bind(globalThis);
    const cancelFrame = globalThis.cancelAnimationFrame?.bind(globalThis);
    if (reduceMotion || !requestFrame || !cancelFrame) return undefined;

    let frameRequest = 0;
    let lastFrameAt: number | null = null;
    let phase = 0;

    const animate = (now: number) => {
      if (lastFrameAt === null) lastFrameAt = now;
      const elapsedMs = now - lastFrameAt;
      if (elapsedMs >= WAVE_FRAME_MS) {
        phase += (elapsedMs / 1000) * WAVE_SPEED;
        if (waveRef.current) waveRef.current.textContent = renderAsciiWaveFrame(phase);
        lastFrameAt = now;
      }
      frameRequest = requestFrame(animate);
    };

    frameRequest = requestFrame(animate);
    return () => cancelFrame(frameRequest);
  }, [animated]);

  return (
    <div
      className={`tiller-launch-illustration ${compact ? "tiller-launch-illustration--compact" : ""}`}
      role="img"
      aria-label={animated ? "Animated ASCII ocean waves" : "ASCII ocean waves"}
    >
      <pre ref={waveRef} className="tiller-launch-waves" aria-hidden="true">{renderAsciiWaveFrame(0)}</pre>
    </div>
  );
}

function EnvironmentLaunchMetadata({
  env,
  implementationMode,
}: {
  env: EnvMeta;
  implementationMode?: "fresh" | "plan" | null;
}) {
  const authLabel = getEnvAuthBadge(env)?.label ?? "Global settings";
  const planLabel = implementationMode === "plan"
    ? "Fixed plan"
    : implementationMode === "fresh"
      ? "No plan"
      : "Launch mode pending";
  const fullText = [
    `Harness: ${getHarnessBadgeLabel(env.harness)}`,
    `Model: ${getEnvModelLabel(env) ?? "Default model"}`,
    env.harnessSettings?.effort ?? "Default effort",
    authLabel,
    getBackendBadgeLabel(env.backend),
    planLabel,
  ].join(" · ");
  return (
    <div className="tiller-launch-runtime-viewport" aria-label={fullText}>
      <div className="tiller-launch-runtime-line">
        <span>{fullText}</span>
        <span className="tiller-launch-runtime-caret" aria-hidden="true" />
      </div>
    </div>
  );
}

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
}

interface DiagnosticsResult {
  envIdentity: string;
  value: StartupDiagnosticsState;
}

function formatStepLabel(stepId?: string | null): string | null {
  if (!stepId) return null;
  return STEP_LABELS[stepId] ?? stepId;
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

export default function EnvWaitingView({ env, hubUrl, onRecoverEnv }: EnvWaitingViewProps) {
  const envIdentity = env.incarnationId ?? env.slug;
  const operationKey = `${envIdentity}:${env.lifecycleOpId ?? "no-operation"}`;
  const [diagnosticsResult, setDiagnosticsResult] = useState<DiagnosticsResult>(() => ({
    envIdentity,
    value: EMPTY_DIAGNOSTICS,
  }));
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [startingMode, setStartingMode] = useState<"fresh" | "plan" | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const diagnostics = diagnosticsResult.envIdentity === envIdentity
    ? diagnosticsResult.value
    : EMPTY_DIAGNOSTICS;
  const presentation = getEnvWaitingPresentation(env, diagnostics);
  const activeDiagnostics = diagnostics.active;

  const matchingStartedAt = presentation.elapsedTimeEligible
    && Boolean(env.lifecycleOpId)
    && activeDiagnostics !== null
    && activeDiagnostics.opId === env.lifecycleOpId
    ? activeDiagnostics.startedAt
    : null;

  useEffect(() => {
    let cancelled = false;

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

  const canStart = presentation.primaryAction === "start" || presentation.primaryAction === "retry";
  const showProgressWave = presentation.displayState === "preparing"
    || presentation.displayState === "saving"
    || presentation.displayState === "stopping";
  const progressStepLabel = presentation.displayState === "preparing"
    ? formatStepLabel(env.bootStepId ?? activeDiagnostics?.currentStepId ?? null) ?? "Preparing"
    : presentation.displayState === "saving"
      ? formatStepLabel(env.bootStepId) ?? "Workspace Sync"
      : "Stopping";
  const progressMessage = presentation.displayState === "preparing"
    ? activeDiagnostics?.currentStepMessage ?? env.bootMessage ?? presentation.actionText
    : env.bootMessage ?? presentation.actionText;
  const handleStart = async (implementationMode: "fresh" | "plan") => {
    setStartingMode(implementationMode);
    setStartError(null);
    try {
      const result = await startEnv(hubUrl, env.slug, { implementationMode });
      onRecoverEnv?.(env.slug, result.status);
    } catch (error) {
      setStartError(error instanceof Error ? error.message : "Failed to start environment");
    } finally {
      setStartingMode(null);
    }
  };

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

            <div className="mt-7 flex w-full flex-col sm:mt-9">
              {showProgressWave ? (
                <>
                  {presentation.displayState === "preparing" && (
                    <EnvironmentLaunchMetadata
                      env={env}
                      implementationMode={activeDiagnostics?.implementationMode}
                    />
                  )}
                  <EnvironmentLaunchIllustration compact />
                  <div className="tiller-launch-current-step border-t border-kumo-line pt-3 text-left">
                    <span className="tiller-launch-current-step-label">
                      {progressStepLabel}
                    </span>
                    <span className="min-w-0 truncate text-[12px] text-kumo-subtle">
                      Current: {progressMessage}
                    </span>
                  </div>
                </>
              ) : (
                <EnvironmentLaunchIllustration animated={false} />
              )}
            </div>

            {canStart && (
              <div className="mt-7 flex flex-col items-center gap-3">
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    loading={startingMode === "fresh"}
                    disabled={startingMode !== null}
                    onClick={() => void handleStart("fresh")}
                  >
                    Start fresh
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="lg"
                    loading={startingMode === "plan"}
                    disabled={startingMode !== null || !env.startupPlanId}
                    title={env.startupPlanId ? "Implement the environment's saved plan" : "This environment has no saved plan"}
                    onClick={() => void handleStart("plan")}
                  >
                    Start with plan
                  </Button>
                </div>
                <p className="max-w-xl text-xs leading-5 text-kumo-subtle">
                  Start fresh for an interactive session, or start with plan to have the implementor execute the saved plan automatically.
                </p>
                {startError && <p role="alert" className="text-xs text-kumo-danger">{startError}</p>}
              </div>
            )}

          </div>
        </main>
      </div>
    </div>
  );
}
