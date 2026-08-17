import type { StartupDiagnosticStepId } from "../types";

export type RuntimeFailureCode =
  | "workspace_hydration_failed"
  | "workspace_persistence_failed"
  | "runner_control_failed"
  | "runtime_start_failed"
  | "runtime_stopped_unexpectedly";

export interface RuntimeFailureProjection {
  code: RuntimeFailureCode;
  message: string;
  referenceId: string;
}

const PUBLIC_MESSAGES: Record<RuntimeFailureCode, string> = {
  workspace_hydration_failed: "Tiller couldn’t restore the workspace. Retry Start.",
  workspace_persistence_failed: "Tiller couldn’t confirm the workspace save yet. Saving will retry automatically.",
  runner_control_failed: "Tiller couldn’t complete the runtime operation.",
  runtime_start_failed: "Tiller couldn’t start the environment runtime. Retry Start.",
  runtime_stopped_unexpectedly: "The environment runtime stopped unexpectedly.",
};

export function runtimeFailureCodeForStartupStep(
  stepId?: StartupDiagnosticStepId | null,
): RuntimeFailureCode {
  return stepId === "workspace-sync"
    ? "workspace_hydration_failed"
    : stepId === "stop-control"
      ? "runner_control_failed"
      : "runtime_start_failed";
}

export function isProjectedRuntimeFailure(message?: string | null): boolean {
  return Boolean(message && /\bReference ID: TLR-[A-Z0-9-]+\b/.test(message));
}

export function projectRuntimeFailure(
  code: RuntimeFailureCode,
  detail: unknown,
  context: Record<string, unknown> = {},
): RuntimeFailureProjection {
  const referenceId = `TLR-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  const diagnostic = {
    ...context,
    detail: detail instanceof Error ? detail.message : detail,
  };
  let serializedDiagnostic: string;
  try {
    serializedDiagnostic = JSON.stringify(diagnostic);
  } catch {
    serializedDiagnostic = JSON.stringify({
      contextKeys: Object.keys(context),
      detail: detail instanceof Error ? detail.message : String(detail),
    });
  }
  console.error(`[runtime-failure] ${referenceId} ${code}: ${serializedDiagnostic}`);
  return {
    code,
    message: `${PUBLIC_MESSAGES[code]} Reference ID: ${referenceId}`,
    referenceId,
  };
}
