import type { EnvReviewRun, EnvReviewTab } from "./api";
import type { AgentTabStatus, AgentTabStatusKind } from "./AgentTabStatusIndicator";

export const ENV_REVIEW_VIEWED_STORAGE_PREFIX = "tiller:implementation-reviewer-viewed:v1";

export function envReviewTabStatus(input: {
  tab: EnvReviewTab;
  latestRun?: EnvReviewRun | null;
  acknowledgedRunId?: string | null;
  modelLabel?: string | null;
  effortLabel?: string | null;
}): AgentTabStatus {
  const runId = input.latestRun?.runId ?? input.tab.latestRunId;
  return implementationReviewStatus({
    status: input.latestRun?.status ?? input.tab.status,
    runId,
    acknowledgedRunId: input.acknowledgedRunId,
    error: input.latestRun?.error,
    configuration: describeConfiguration(input.modelLabel, input.effortLabel),
  });
}

export function implementationReviewStatus(input: {
  status: string | null | undefined;
  runId?: string | null;
  acknowledgedRunId?: string | null;
  error?: string | null;
  configuration?: string | null;
}): AgentTabStatus {
  const { status: rawStatus, runId, acknowledgedRunId, error } = input;
  const configuration = input.configuration?.trim() ?? "";

  if (rawStatus === "preparing") {
    return makeStatus("starting", "Preparing", withConfiguration("Capturing the implementation snapshot.", configuration), runId);
  }
  if (rawStatus === "queued") {
    return makeStatus("starting", "Queued", withConfiguration("Waiting for a reviewer container.", configuration), runId);
  }
  if (rawStatus === "setting_up") {
    return makeStatus("starting", "Starting", withConfiguration("Starting the reviewer group.", configuration), runId);
  }
  if (rawStatus === "running" || rawStatus === "active") {
    return makeStatus("working", "Working", withConfiguration("The reviewer is checking the implementation.", configuration), runId);
  }
  if (rawStatus === "ready" || rawStatus === "completed") {
    if (!runId) {
      return makeStatus("idle", "Ready", withConfiguration("No review is in progress.", configuration));
    }
    return acknowledgedRunId === runId
      ? makeStatus("viewed", "Viewed", withConfiguration("The latest implementation review has been viewed.", configuration), runId)
      : makeStatus("finished", "New result", withConfiguration("A new implementation review is ready.", configuration), runId);
  }
  if (rawStatus === "cancelled") {
    return makeStatus("stopped", "Stopped", withConfiguration("The reviewer stopped before completion.", configuration), runId);
  }
  if (rawStatus === "failed") {
    return makeStatus("error", "Error", withConfiguration(error?.trim() || "The reviewer run failed.", configuration), runId);
  }
  return makeStatus("idle", "Ready", withConfiguration("No review is in progress.", configuration));
}

export function envReviewViewedStorageKey(envSlug: string, sessionId: string): string {
  return `${ENV_REVIEW_VIEWED_STORAGE_PREFIX}:${envSlug}:${sessionId}`;
}

export function readEnvReviewViewedRuns(
  storage: Pick<Storage, "getItem"> | null,
  envSlug: string,
  sessionId: string,
): Record<string, string> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(envReviewViewedStorageKey(envSlug, sessionId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => (
      Boolean(entry[0]) && typeof entry[1] === "string" && Boolean(entry[1])
    )));
  } catch {
    return {};
  }
}

export function writeEnvReviewViewedRuns(
  storage: Pick<Storage, "setItem"> | null,
  envSlug: string,
  sessionId: string,
  acknowledgements: Record<string, string>,
): void {
  if (!storage) return;
  try {
    storage.setItem(envReviewViewedStorageKey(envSlug, sessionId), JSON.stringify(acknowledgements));
  } catch {
    // Attention state remains functional in memory when storage is unavailable.
  }
}

function makeStatus(
  kind: AgentTabStatusKind,
  label: string,
  detail: string,
  runId?: string | null,
): AgentTabStatus {
  return { kind, label, detail, ...(runId ? { runId } : {}) };
}

function describeConfiguration(model: string | null | undefined, effort: string | null | undefined): string {
  return [model?.trim() || null, effort?.trim() ? `${effort.trim()} reasoning` : null]
    .filter(Boolean)
    .join(" · ");
}

function withConfiguration(detail: string, configuration: string): string {
  if (!configuration) return detail;
  const trimmedDetail = detail.trim();
  const punctuatedDetail = /[.!?]$/.test(trimmedDetail) ? trimmedDetail : `${trimmedDetail}.`;
  return `${punctuatedDetail} ${configuration}.`;
}
