import type {
  EnvMeta,
  StartupDiagnosticStepId,
  StartupDiagnosticsState,
} from "../api/types";
import { getHarnessBadgeLabel } from "./env-harness";

export type EnvWaitingPresentation =
  | {
      displayState: "preparing";
      heading: "Preparing your environment";
      actionText: string;
      elapsedTimeEligible: true;
      primaryAction: "none";
    }
  | {
      displayState: "saving";
      heading: "Saving your work";
      actionText: "Saving workspace…";
      elapsedTimeEligible: false;
      primaryAction: "none";
    }
  | {
      displayState: "stopping";
      heading: "Stopping your environment";
      actionText: "Your work is saved. Finishing shutdown…";
      elapsedTimeEligible: false;
      primaryAction: "none";
    }
  | {
      displayState: "deleting";
      heading: "Removing your environment";
      actionText: "Deleting the environment and its stored workspace…";
      elapsedTimeEligible: false;
      primaryAction: "none";
    }
  | {
      displayState: "stopped";
      heading: "Your environment is stopped";
      actionText: "Start it when you’re ready to continue.";
      elapsedTimeEligible: false;
      primaryAction: "start";
    }
  | {
      displayState: "startup-failure";
      heading: "We couldn’t prepare your environment";
      actionText: "Try starting it again when you’re ready.";
      elapsedTimeEligible: false;
      primaryAction: "retry";
    }
  | {
      displayState: "failure";
      heading: "This environment needs attention";
      actionText: "Tiller couldn’t complete the last environment action.";
      elapsedTimeEligible: false;
      primaryAction: "none";
    }
  | {
      displayState: "save-failure";
      heading: "Workspace saving wasn’t confirmed";
      actionText: "Start again to restore the latest saved workspace. Recent changes may be missing.";
      elapsedTimeEligible: false;
      primaryAction: "retry";
    }
  | {
      displayState: "runtime-failure";
      heading: "Your environment stopped unexpectedly";
      actionText: "Start it again to restore the latest saved workspace.";
      elapsedTimeEligible: false;
      primaryAction: "retry";
    }
  | {
      displayState: "running";
      heading: "Your environment is ready";
      actionText: "Opening your session…";
      elapsedTimeEligible: false;
      primaryAction: "none";
    }
  | {
      displayState: "unknown";
      heading: "Checking your environment";
      actionText: "Waiting for its latest status…";
      elapsedTimeEligible: false;
      primaryAction: "none";
    };

type PresentationEnv = Pick<
  EnvMeta,
  | "status"
  | "harness"
  | "bootStepId"
  | "lifecycleOpId"
  | "lifecycleOperation"
  | "lifecycleDesiredState"
  | "lifecycleInfraState"
>;

function friendlyStartupAction(
  stepId: StartupDiagnosticStepId | string | null | undefined,
  env: Pick<EnvMeta, "harness">,
): string {
  switch (stepId) {
    case "workspace-sync":
      return "Syncing your workspace…";
    case "stop-control":
      return "Starting environment services…";
    case "prereq-check":
      return "Checking required tools…";
    case "harness-launch":
      return `Starting ${getHarnessBadgeLabel(env.harness)}…`;
    case "hub-connect":
      return "Connecting your environment…";
    case "runner-ready":
      return "Almost ready…";
    default:
      return "Getting everything ready…";
  }
}

function hasCorrelatedStartupFailure(
  env: PresentationEnv,
  diagnostics: StartupDiagnosticsState,
): boolean {
  const activeDiagnostics = diagnostics.active;
  return env.status === "failed"
    && env.lifecycleOperation === "start"
    && env.lifecycleDesiredState === "running"
    && Boolean(env.lifecycleOpId)
    && activeDiagnostics !== null
    && activeDiagnostics.opId === env.lifecycleOpId
    && Boolean(activeDiagnostics.failure);
}

export function getEnvWaitingPresentation(
  env: PresentationEnv,
  diagnostics: StartupDiagnosticsState,
): EnvWaitingPresentation {
  // Lifecycle transitions take precedence over any diagnostics that may have
  // arrived for an earlier operation.
  if (env.status === "deleting") {
    return {
      displayState: "deleting",
      heading: "Removing your environment",
      actionText: "Deleting the environment and its stored workspace…",
      elapsedTimeEligible: false,
      primaryAction: "none",
    };
  }

  if (env.status === "saving") {
    return {
      displayState: "saving",
      heading: "Saving your work",
      actionText: "Saving workspace…",
      elapsedTimeEligible: false,
      primaryAction: "none",
    };
  }

  if (env.status === "stopping") {
    return {
      displayState: "stopping",
      heading: "Stopping your environment",
      actionText: "Your work is saved. Finishing shutdown…",
      elapsedTimeEligible: false,
      primaryAction: "none",
    };
  }

  if (env.status === "creating" || env.status === "starting") {
    const matchingDiagnostics = env.lifecycleOpId
      && diagnostics.active?.opId === env.lifecycleOpId
      ? diagnostics.active
      : null;
    return {
      displayState: "preparing",
      heading: "Preparing your environment",
      actionText: friendlyStartupAction(
        matchingDiagnostics?.currentStepId ?? env.bootStepId,
        env,
      ),
      elapsedTimeEligible: true,
      primaryAction: "none",
    };
  }

  if (env.status === "failed") {
    if (hasCorrelatedStartupFailure(env, diagnostics)) {
      return {
        displayState: "startup-failure",
        heading: "We couldn’t prepare your environment",
        actionText: "Try starting it again when you’re ready.",
        elapsedTimeEligible: false,
        primaryAction: "retry",
      };
    }
    if (
      env.lifecycleOperation === "start"
      && env.lifecycleDesiredState === "running"
      && Boolean(env.lifecycleOpId)
    ) {
      return {
        displayState: "runtime-failure",
        heading: "Your environment stopped unexpectedly",
        actionText: "Start it again to restore the latest saved workspace.",
        elapsedTimeEligible: false,
        primaryAction: "retry",
      };
    }
    if (
      env.lifecycleOperation === "stop"
      && env.lifecycleDesiredState === "stopped"
      && env.lifecycleInfraState === "stopped"
      && Boolean(env.lifecycleOpId)
    ) {
      return {
        displayState: "save-failure",
        heading: "Workspace saving wasn’t confirmed",
        actionText: "Start again to restore the latest saved workspace. Recent changes may be missing.",
        elapsedTimeEligible: false,
        primaryAction: "retry",
      };
    }
    return {
      displayState: "failure",
      heading: "This environment needs attention",
      actionText: "Tiller couldn’t complete the last environment action.",
      elapsedTimeEligible: false,
      primaryAction: "none",
    };
  }

  if (env.status === "stopped") {
    return {
      displayState: "stopped",
      heading: "Your environment is stopped",
      actionText: "Start it when you’re ready to continue.",
      elapsedTimeEligible: false,
      primaryAction: "start",
    };
  }

  if (env.status === "running") {
    return {
      displayState: "running",
      heading: "Your environment is ready",
      actionText: "Opening your session…",
      elapsedTimeEligible: false,
      primaryAction: "none",
    };
  }

  return {
    displayState: "unknown",
    heading: "Checking your environment",
    actionText: "Waiting for its latest status…",
    elapsedTimeEligible: false,
    primaryAction: "none",
  };
}
