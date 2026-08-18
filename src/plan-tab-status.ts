import type {
  PlannerEffort,
  PlannerRun,
  PlanWriterState,
  ReviewerRegistryEntry,
} from "../api/coordination/types";
import type { AgentTabStatus, AgentTabStatusKind } from "./AgentTabStatusIndicator";

export type PlanTabStatusKind = AgentTabStatusKind;
export type PlanTabStatus = AgentTabStatus;

export interface PlanWriterTabStatusOptions {
  operation?: "starting" | "stopping" | null;
  saving?: boolean;
  connecting?: boolean;
  connectingDetail?: string | null;
  error?: string | null;
  routeLabel?: string | null;
  effortLabel?: string | null;
}

const RUN_STATUS_ORDER: Record<PlannerRun["status"], number> = {
  queued: 0,
  running: 1,
  saving: 2,
  completed: 3,
  failed: 3,
  cancelled: 3,
};

const TERMINAL_RUN_STATUSES = new Set<PlannerRun["status"]>(["completed", "failed", "cancelled"]);

export function planWriterTabStatus(
  writer: PlanWriterState,
  options: PlanWriterTabStatusOptions = {},
): PlanTabStatus {
  const configuration = describeConfiguration(options.routeLabel, options.effortLabel);
  const runtimeError = writer.cleanupError
    ? `Cleanup failed: ${writer.cleanupError}`
    : writer.startupError
      ? `Startup failed: ${writer.startupError}`
      : null;

  if (runtimeError) {
    return status("error", "Error", withConfiguration(runtimeError, configuration));
  }
  if (writer.synchronization.state === "sync_failed") {
    return status(
      "error",
      "Sync issue",
      withConfiguration(writer.synchronization.error ?? "Plan synchronization failed.", configuration),
    );
  }
  const localError = options.error?.trim() || null;
  if (localError) {
    return status("error", "Error", withConfiguration(localError, configuration));
  }
  if (options.operation === "stopping") {
    return status("stopping", "Stopping", withConfiguration("Stopping the live Scribe.", configuration));
  }
  if (options.operation === "starting") {
    return status("starting", "Starting", withConfiguration("Starting the live Scribe.", configuration));
  }
  if (options.saving || writer.synchronization.state === "saving") {
    return status("saving", "Saving", withConfiguration("Saving the latest plan changes.", configuration));
  }
  if (writer.lifecycle === "starting" || options.connecting) {
    return status(
      "starting",
      options.connecting ? "Connecting" : "Starting",
      withConfiguration(
        options.connecting
          ? options.connectingDetail?.trim() || "Connecting to the live Scribe."
          : "Starting the live Scribe.",
        configuration,
      ),
    );
  }
  if (writer.lifecycle === "running") {
    return status("running", "Live", withConfiguration("The Scribe is live and ready.", configuration));
  }
  if (writer.generation !== null || writer.stopReason) {
    return status("stopped", "Stopped", withConfiguration(writerStopReason(writer), configuration));
  }
  return status("idle", "Not started", withConfiguration("Start the Scribe when you are ready.", configuration));
}

export function reviewerTabStatus(input: {
  reviewer: ReviewerRegistryEntry;
  latestRun?: PlannerRun | null;
  hasUnreadResult?: boolean;
  modelLabel?: string | null;
  effortLabel?: string | null;
}): PlanTabStatus {
  const { reviewer, latestRun, hasUnreadResult = true } = input;
  const hasPolledRun = input.latestRun !== undefined;
  const runId = hasPolledRun ? latestRun?.runId : reviewer.runId;
  const runStatus = hasPolledRun ? latestRun?.status : reviewer.status;
  const runError = hasPolledRun ? latestRun?.error : reviewer.error;
  const effort = hasPolledRun ? latestRun?.input?.effort ?? reviewer.effort : reviewer.effort;
  const configuration = describeConfiguration(
    input.modelLabel ?? reviewer.model,
    input.effortLabel ?? effortDisplayName(effort),
  );

  // New reviewer registry rows start as queued before any run exists. A run ID
  // is the durable proof that there is actually work to display.
  if (!runId || !runStatus) {
    return status("idle", "Ready", withConfiguration("Ready for your next question.", configuration));
  }
  if (runStatus === "queued") {
    return status("starting", "Queued", withConfiguration("Waiting for a reviewer container.", configuration), runId);
  }
  if (runStatus === "running") {
    return status("working", "Working", withConfiguration("The reviewer is working on your question.", configuration), runId);
  }
  if (runStatus === "saving") {
    return status("saving", "Saving", withConfiguration("Saving the reviewer response.", configuration), runId);
  }
  if (runStatus === "completed") {
    return hasUnreadResult
      ? status("finished", "New result", withConfiguration("A new reviewer response is ready.", configuration), runId)
      : status("viewed", "Viewed", withConfiguration("The latest reviewer response has been viewed.", configuration), runId);
  }
  if (runStatus === "cancelled") {
    return status("stopped", "Stopped", withConfiguration("The reviewer stopped before completion.", configuration), runId);
  }
  return status(
    "error",
    "Error",
    withConfiguration(runError?.trim() || "The reviewer run failed.", configuration),
    runId,
  );
}

/**
 * Accepts monotonic updates for one reviewer thread. Runtime timestamps keep a
 * delayed poll from replacing a newer dispatch; status ordering keeps a stale
 * active callback from reviving a terminal run.
 */
export function newestReviewerRun(
  current: PlannerRun | null | undefined,
  incoming: PlannerRun | null,
): PlannerRun | null {
  if (!incoming) return current === undefined ? null : current;
  if (!current) return incoming;
  if (current.runId === incoming.runId) {
    const currentTerminal = TERMINAL_RUN_STATUSES.has(current.status);
    const incomingTerminal = TERMINAL_RUN_STATUSES.has(incoming.status);
    if (currentTerminal && !incomingTerminal) return current;
    if (currentTerminal && incomingTerminal && current.status !== incoming.status) return current;
    return RUN_STATUS_ORDER[incoming.status] >= RUN_STATUS_ORDER[current.status] ? incoming : current;
  }

  const currentStartedAt = Date.parse(current.startedAt);
  const incomingStartedAt = Date.parse(incoming.startedAt);
  if (Number.isFinite(currentStartedAt) && Number.isFinite(incomingStartedAt)) {
    return incomingStartedAt >= currentStartedAt ? incoming : current;
  }
  return incoming;
}

function status(
  kind: PlanTabStatusKind,
  label: string,
  detail: string,
  runId?: string,
): PlanTabStatus {
  return { kind, label, detail, ...(runId ? { runId } : {}) };
}

function effortDisplayName(effort: PlannerEffort | undefined): string | null {
  if (!effort) return null;
  if (effort === "xhigh") return "Extra High";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

function describeConfiguration(routeOrModel: string | null | undefined, effort: string | null | undefined): string {
  return [routeOrModel?.trim() || null, effort?.trim() ? `${effort.trim()} reasoning` : null]
    .filter(Boolean)
    .join(" · ");
}

function withConfiguration(detail: string, configuration: string): string {
  if (!configuration) return detail;
  const trimmedDetail = detail.trim();
  const punctuatedDetail = /[.!?]$/.test(trimmedDetail) ? trimmedDetail : `${trimmedDetail}.`;
  return `${punctuatedDetail} ${configuration}.`;
}

function writerStopReason(writer: PlanWriterState): string {
  if (writer.stopReason === "user") return "The live Scribe was stopped.";
  if (writer.stopReason === "idle") return "The live Scribe stopped after inactivity.";
  if (writer.stopReason === "completed") return "The live Scribe stopped when the plan was completed.";
  if (writer.stopReason === "archived") return "The live Scribe stopped when the plan was archived.";
  if (writer.stopReason === "mode_invalidated") return "The live Scribe stopped because planning mode changed.";
  if (writer.stopReason === "watchdog") return "The live Scribe was stopped by its watchdog.";
  if (writer.stopReason === "runtime_ended") return "The live Scribe runtime ended.";
  return "The live Scribe is not running.";
}
