import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Textarea } from "@cloudflare/kumo/components/input";
import {
  cancelPlanSkillInvocation,
  fetchPlanSkillInvocation,
  fetchPlanSkillInvocations,
  fetchLatestPlanSkillInvocation,
  fetchReviewerMessages,
  rerunPlanSkillInvocation,
  createPlanSkillOverview,
  sharePlanSkillOverview,
  updatePlanSkillControls,
  type PlanSkillInvocationDetail,
} from "./api";
import type {
  PlannerRun,
  SkillInvocationSummary,
  ThreadMessage,
} from "../api/coordination/types";

const HUB_URL = window.location.origin;
const POLL_INTERVAL_MS = 3_000;

interface CurrentReport {
  agentLabel: string;
  message: ThreadMessage;
  initial: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageRole(message: ThreadMessage): string {
  return isRecord(message.body) && typeof message.body.role === "string"
    ? message.body.role
    : message.senderSessionId;
}

function messageText(message: ThreadMessage): string {
  if (isRecord(message.body) && typeof message.body.text === "string")
    return message.body.text;
  return typeof message.body === "string" ? message.body : "";
}

function messageRunId(message: ThreadMessage): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string"
    ? message.body.runId
    : null;
}

function activeStatus(status: unknown): boolean {
  return (
    status === "setting_up" ||
    status === "active" ||
    status === "queued" ||
    status === "running" ||
    status === "saving"
  );
}

function newestInitialByAgent(
  detail: PlanSkillInvocationDetail,
): Map<string, PlannerRun> {
  const newest = new Map<string, PlannerRun>();
  for (const run of detail.runs) {
    if (
      (run.skillRunRole !== "root_initial" &&
        run.skillRunRole !== "report_initial") ||
      !run.skillAgentId
    )
      continue;
    const current = newest.get(run.skillAgentId);
    if (!current || run.startedAt >= current.startedAt) {
      newest.set(run.skillAgentId, run);
    }
  }
  return newest;
}

export default function PlanSkillFanout({
  repoId,
  planArtifactId,
  parentThreadId,
  initialDetail,
  active,
  disabled = false,
  disabledReason = null,
  refreshToken = 0,
  onLatestDetailChange,
}: {
  repoId: string;
  planArtifactId: string;
  parentThreadId: string;
  initialDetail?: PlanSkillInvocationDetail | null;
  active: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
  refreshToken?: number;
  onLatestDetailChange?: (detail: PlanSkillInvocationDetail) => void;
}) {
  const [detail, setDetail] = useState<PlanSkillInvocationDetail | null>(
    initialDetail ?? null,
  );
  const [messagesByThread, setMessagesByThread] = useState<
    Record<string, ThreadMessage[]>
  >({});
  const [overviewGuidance, setOverviewGuidance] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pollRevision, setPollRevision] = useState(0);
  const [history, setHistory] = useState<SkillInvocationSummary[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [selectedInvocationId, setSelectedInvocationId] = useState<
    string | null
  >(null);
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden,
  );
  const [online, setOnline] = useState(() => navigator.onLine);
  const rerunRequestRef = useRef<string | null>(null);
  const invocationScopeRef = useRef(
    initialDetail?.invocation.invocationId ?? null,
  );
  const initialInvocationRef = useRef(
    initialDetail?.invocation.invocationId ?? null,
  );
  const refreshGenerationRef = useRef(0);
  const historyInitializedRef = useRef(false);

  useEffect(() => {
    const handleVisibility = () => setDocumentVisible(!document.hidden);
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const nextInvocationId = initialDetail?.invocation.invocationId ?? null;
    if (initialInvocationRef.current !== nextInvocationId) {
      initialInvocationRef.current = nextInvocationId;
      historyInitializedRef.current = false;
      setPollRevision((current) => current + 1);
    }
    // Parent refreshes carry the latest invocation as a convenience. Do not
    // let them replace an older history entry that the user explicitly opened.
    if (selectedInvocationId === null) setDetail(initialDetail ?? null);
  }, [initialDetail, selectedInvocationId]);

  const invocationId = detail?.invocation.invocationId ?? null;
  useEffect(() => {
    if (invocationScopeRef.current === invocationId) return;
    invocationScopeRef.current = invocationId;
    refreshGenerationRef.current += 1;
    setMessagesByThread((current) => {
      const threadIds = new Set(
        detail?.reviewers.map((reviewer) => reviewer.threadId) ?? [],
      );
      return Object.fromEntries(
        Object.entries(current).filter(([threadId]) => threadIds.has(threadId)),
      );
    });
    setError(null);
    rerunRequestRef.current = null;
  }, [invocationId]);

  useEffect(() => {
    refreshGenerationRef.current += 1;
    historyInitializedRef.current = false;
    setHistory([]);
    setHistoryCursor(null);
    setSelectedInvocationId(null);
  }, [parentThreadId, planArtifactId, repoId]);

  const refresh = useCallback(
    async (
      requestedInvocationId: string | null = selectedInvocationId,
      options: { includeHistory?: boolean } = {},
    ) => {
      const generation = ++refreshGenerationRef.current;
      const includeHistory = options.includeHistory !== false;
      const [next, historyPage] = await Promise.all([
        requestedInvocationId
          ? fetchPlanSkillInvocation(
              HUB_URL,
              repoId,
              planArtifactId,
              parentThreadId,
              requestedInvocationId,
            )
          : fetchLatestPlanSkillInvocation(
              HUB_URL,
              repoId,
              planArtifactId,
              parentThreadId,
            ),
        includeHistory
          ? fetchPlanSkillInvocations(
              HUB_URL,
              repoId,
              planArtifactId,
              parentThreadId,
              { limit: 20 },
            )
          : Promise.resolve(null),
      ]);
      if (!next) {
        if (refreshGenerationRef.current === generation) {
          setDetail(null);
          setMessagesByThread({});
          if (historyPage) {
            historyInitializedRef.current = true;
            setHistory(historyPage.invocations);
            setHistoryCursor(historyPage.nextCursor);
          }
        }
        return null;
      }
      const transcripts = await Promise.all(
        next.reviewers.map(async (reviewer) => ({
          threadId: reviewer.threadId,
          transcript: await fetchReviewerMessages(
            HUB_URL,
            repoId,
            planArtifactId,
            reviewer.threadId,
          ),
        })),
      );
      if (refreshGenerationRef.current !== generation) return null;
      setDetail(next);
      if (requestedInvocationId === null) onLatestDetailChange?.(next);
      if (historyPage) {
        historyInitializedRef.current = true;
        setHistory((current) => {
          const merged = [...historyPage.invocations];
          const seen = new Set(
            merged.map((invocation) => invocation.invocationId),
          );
          for (const invocation of current) {
            if (!seen.has(invocation.invocationId)) merged.push(invocation);
          }
          return merged;
        });
        setHistoryCursor(historyPage.nextCursor);
      }
      setMessagesByThread(
        Object.fromEntries(
          transcripts.map(({ threadId, transcript }) => [
            threadId,
            Array.isArray(transcript)
              ? (transcript as ThreadMessage[])
              : transcript.messages,
          ]),
        ),
      );
      return next;
    },
    [
      onLatestDetailChange,
      parentThreadId,
      planArtifactId,
      repoId,
      selectedInvocationId,
    ],
  );

  const selectInvocation = async (invocationId: string) => {
    if (invocationId === detail?.invocation.invocationId) return;
    setBusy(true);
    setError(null);
    setSelectedInvocationId(invocationId);
    try {
      await refresh(invocationId);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to load Plan Skill history",
      );
    } finally {
      setBusy(false);
    }
  };

  const loadOlderHistory = async () => {
    if (!historyCursor) return;
    setBusy(true);
    setError(null);
    try {
      const page = await fetchPlanSkillInvocations(
        HUB_URL,
        repoId,
        planArtifactId,
        parentThreadId,
        { cursor: historyCursor, limit: 20 },
      );
      setHistory((current) => {
        const seen = new Set(
          current.map((invocation) => invocation.invocationId),
        );
        return [
          ...current,
          ...page.invocations.filter(
            (invocation) => !seen.has(invocation.invocationId),
          ),
        ];
      });
      setHistoryCursor(page.nextCursor);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to load older Plan Skill history",
      );
    } finally {
      setBusy(false);
    }
  };

  const pollingEligible = active && documentVisible && online;

  useEffect(() => {
    if (refreshToken < 1) return;
    void refresh().catch(() => undefined);
  }, [refresh, refreshToken]);

  useEffect(() => {
    if (!pollingEligible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (!cancelled)
        timer = window.setTimeout(() => void poll(), POLL_INTERVAL_MS);
    };
    const poll = async () => {
      try {
        const next = await refresh(undefined, {
          includeHistory: !historyInitializedRef.current,
        });
        if (!cancelled) setError(null);
        const linkedActive = next?.runs.some((run) => activeStatus(run.status));
        if (
          !cancelled &&
          next &&
          (activeStatus(next.invocation.status) || linkedActive)
        ) {
          schedule();
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Failed to load Plan Skill Overview",
          );
          schedule();
        }
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [pollRevision, pollingEligible, refresh]);

  const currentInitials = useMemo(
    () =>
      detail ? newestInitialByAgent(detail) : new Map<string, PlannerRun>(),
    [detail],
  );
  const reports = useMemo(() => {
    if (!detail) return [];
    const result: CurrentReport[] = [];
    for (const agent of detail.invocation.definitionSnapshot.agents) {
      const initial = currentInitials.get(agent.id);
      const reviewer = detail.reviewers.find(
        (candidate) => candidate.skillAgentId === agent.id,
      );
      if (!initial || !reviewer) continue;
      const messages = messagesByThread[reviewer.threadId] ?? [];
      const initialMessage = messages.find(
        (message) =>
          messageRunId(message) === initial.runId &&
          messageRole(message) === "assistant",
      );
      if (initial.status === "completed" && initialMessage) {
        result.push({
          agentLabel: agent.label,
          message: initialMessage,
          initial: true,
        });
      }
      const followups = detail.runs.filter(
        (run) =>
          (run.skillRunRole === "root_followup" ||
            run.skillRunRole === "report_followup") &&
          run.skillAgentId === agent.id &&
          run.status === "completed" &&
          run.startedAt > initial.startedAt,
      );
      const followupByRun = new Map(followups.map((run) => [run.runId, run]));
      for (const message of messages
        .slice()
        .sort((left, right) => left.seq - right.seq)) {
        const run = followupByRun.get(messageRunId(message) ?? "");
        if (run && messageRole(message) === "assistant") {
          result.push({
            agentLabel: agent.label,
            message,
            initial: false,
          });
        }
      }
    }
    return result;
  }, [currentInitials, detail, messagesByThread]);

  if (!detail) return null;
  const invocation = detail.invocation;
  const linkedActive = detail.runs.some((run) => activeStatus(run.status));
  const terminalIdle = !activeStatus(invocation.status) && !linkedActive;
  const latestInvocationId =
    history[0]?.invocationId ?? invocation.invocationId;
  const rerun = async () => {
    const requestId = rerunRequestRef.current ?? crypto.randomUUID();
    rerunRequestRef.current = requestId;
    setBusy(true);
    setError(null);
    try {
      const next = await rerunPlanSkillInvocation(
        HUB_URL,
        repoId,
        planArtifactId,
        parentThreadId,
        invocation.invocationId,
        requestId,
      );
      rerunRequestRef.current = null;
      setSelectedInvocationId(null);
      setDetail(next);
      onLatestDetailChange?.(next);
      setPollRevision((current) => current + 1);
      await refresh(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to re-review changes",
      );
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await cancelPlanSkillInvocation(
        HUB_URL,
        repoId,
        planArtifactId,
        parentThreadId,
        invocation.invocationId,
      );
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Failed to cancel Plan Skill round",
      );
    } finally {
      setBusy(false);
    }
  };

  const saveOverviewControls = async (
    overviewMode: "auto" | "manual",
    includedMessageIds: string[],
  ) => {
    setBusy(true);
    setError(null);
    try {
      setDetail(
        await updatePlanSkillControls(
          HUB_URL,
          repoId,
          planArtifactId,
          parentThreadId,
          invocation.invocationId,
          { overviewMode, includedMessageIds },
        ),
      );
      setPollRevision((current) => current + 1);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Failed to update Overview inputs",
      );
    } finally {
      setBusy(false);
    }
  };

  const createOverview = async () => {
    setBusy(true);
    setError(null);
    try {
      setDetail(
        await createPlanSkillOverview(
          HUB_URL,
          repoId,
          planArtifactId,
          parentThreadId,
          invocation.invocationId,
          overviewGuidance,
        ),
      );
      setOverviewGuidance("");
      setPollRevision((current) => current + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to create Overview");
    } finally {
      setBusy(false);
    }
  };

  const shareOverview = async () => {
    setBusy(true);
    setError(null);
    try {
      await sharePlanSkillOverview(
        HUB_URL,
        repoId,
        planArtifactId,
        parentThreadId,
        invocation.invocationId,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to share Overview");
    } finally {
      setBusy(false);
    }
  };

  if (invocation.definitionSnapshot.agents.length === 1) {
    return (
      <section
        className="border-b border-kumo-line bg-kumo-recessed"
        aria-label={`${invocation.definitionSnapshot.label} review round`}
      >
        <div className="flex min-h-11 items-center gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-kumo-default">
              {invocation.definitionSnapshot.label}
            </div>
            <div className="truncate text-[10px] text-kumo-subtle">
              Plan snapshot from when this review started
            </div>
          </div>
          <div className="ml-auto flex shrink-0 gap-2 px-2 py-1">
            {history.length > 1 && (
              <select
                aria-label="Plan Skill history"
                className="max-w-56 rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs"
                value={invocation.invocationId}
                disabled={busy}
                onChange={(event) => void selectInvocation(event.target.value)}
              >
                {history.map((entry) => (
                  <option key={entry.invocationId} value={entry.invocationId}>
                    /{entry.command} · {entry.status} · {new Date(entry.createdAt).toLocaleString()}
                  </option>
                ))}
              </select>
            )}
            {terminalIdle
              && invocation.invocationId === latestInvocationId
              && invocation.definitionSnapshot.id !== "plan-health" && (
                <Button
                  size="xs"
                  variant="secondary"
                  disabled={busy || disabled}
                  title={disabled ? (disabledReason ?? undefined) : undefined}
                  onClick={() => void rerun()}
                >
                  Re-review changes
                </Button>
              )}
            {!terminalIdle && (
              <Button
                size="xs"
                variant="secondary-destructive"
                disabled={busy}
                onClick={() => void cancel()}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
        {error && <div role="alert" className="px-3 pb-2 text-xs text-kumo-danger">{error}</div>}
      </section>
    );
  }
  const overviewRun = invocation.overviewRunId
    ? detail.runs.find((run) => run.runId === invocation.overviewRunId) ?? null
    : null;

  return (
    <section
      className="border-b border-kumo-line bg-kumo-recessed"
      aria-label={`${invocation.definitionSnapshot.label} Overview`}
    >
      <div className="flex min-h-11 items-center gap-3 border-b border-kumo-line px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-semibold text-kumo-default">
            Overview · {invocation.definitionSnapshot.label}
          </div>
          <div className="truncate text-[10px] text-kumo-subtle">
            Plan snapshot from when this review started
            {` · ${invocation.definitionSnapshot.agents.length} Reports`}
          </div>
        </div>
        <div className="ml-auto flex shrink-0 gap-2 px-2 py-1">
          {history.length > 1 && (
            <select
              aria-label="Plan Skill history"
              className="max-w-56 rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs"
              value={invocation.invocationId}
              disabled={busy}
              onChange={(event) => void selectInvocation(event.target.value)}
            >
              {history.map((entry) => (
                <option key={entry.invocationId} value={entry.invocationId}>
                  /{entry.command} · {entry.status} ·{" "}
                  {new Date(entry.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          )}
          {historyCursor && (
            <Button
              size="xs"
              variant="secondary"
              disabled={busy}
              onClick={() => void loadOlderHistory()}
            >
              Load older
            </Button>
          )}
          {terminalIdle &&
            invocation.invocationId === latestInvocationId &&
            invocation.definitionSnapshot.id !== "plan-health" && (
              <Button
                size="xs"
                variant="secondary"
                disabled={busy || disabled}
                title={disabled ? (disabledReason ?? undefined) : undefined}
                onClick={() => void rerun()}
              >
                Re-review changes
              </Button>
            )}
          {!terminalIdle && (
            <Button
              size="xs"
              variant="secondary-destructive"
              disabled={busy}
              onClick={() => void cancel()}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
      {!invocation.overviewRunId && (
        <div className="bg-kumo-base px-3 py-3">
          <div className="mx-auto max-w-3xl space-y-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <label className="font-medium text-kumo-default" htmlFor={`overview-mode-${invocation.invocationId}`}>
                Overview mode
              </label>
              <select
                id={`overview-mode-${invocation.invocationId}`}
                className="rounded border border-kumo-line bg-kumo-base px-2 py-1"
                value={invocation.overviewMode}
                disabled={busy || invocation.invocationId !== latestInvocationId}
                onChange={(event) =>
                  void saveOverviewControls(
                    event.target.value === "manual" ? "manual" : "auto",
                    invocation.includedMessageIds,
                  )
                }
              >
                <option value="auto">Auto</option>
                <option value="manual">Manual</option>
              </select>
            </div>
            <div className="text-[11px] text-kumo-subtle">
              {invocation.overviewMode === "auto"
                ? "Overview starts after every initial Report is terminal."
                : "Choose the exact successful responses to freeze into Overview."}
            </div>
            {invocation.overviewMode === "manual" && (
              <>
                <div className="max-h-48 space-y-2 overflow-y-auto">
                  {reports.length === 0 ? (
                    <p className="py-2 text-xs text-kumo-subtle">No successful Reports are available yet.</p>
                  ) : reports.map((report) => (
                    <label
                      key={report.message.id}
                      className="flex items-start gap-2 border border-kumo-line bg-kumo-recessed p-2 text-xs"
                    >
                      <input
                        className="mt-0.5"
                        type="checkbox"
                        checked={invocation.includedMessageIds.includes(report.message.id)}
                        disabled={busy}
                        onChange={() => {
                          const included = invocation.includedMessageIds.includes(report.message.id)
                            ? invocation.includedMessageIds.filter((id) => id !== report.message.id)
                            : [...invocation.includedMessageIds, report.message.id];
                          void saveOverviewControls("manual", included);
                        }}
                      />
                      <span>
                        <span className="block font-medium text-kumo-default">{report.agentLabel} · {report.initial ? "Initial Report" : "Follow-up"}</span>
                        <span className="mt-1 line-clamp-2 block text-kumo-subtle">{messageText(report.message)}</span>
                      </span>
                    </label>
                  ))}
                </div>
                <Textarea
                  aria-label="Optional Overview guidance"
                  value={overviewGuidance}
                  onChange={(event) => setOverviewGuidance(event.target.value)}
                  placeholder="Optional guidance for the Overview"
                  rows={2}
                  disabled={busy}
                />
                <div className="flex justify-end">
                  <Button
                    size="sm"
                    disabled={busy || invocation.includedMessageIds.length === 0}
                    onClick={() => void createOverview()}
                  >
                    Create Overview
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      {overviewRun?.status === "completed" && invocation.overviewMode === "manual" && (
        <div className="flex justify-end border-t border-kumo-line bg-kumo-base px-3 py-2">
          <Button size="sm" disabled={busy} onClick={() => void shareOverview()}>
            Share with Scribe
          </Button>
        </div>
      )}
      <div className="bg-kumo-base px-3">
        {error && (
          <div
            role="alert"
            className="mx-auto mt-2 max-w-3xl text-xs text-kumo-danger"
          >
            {error}
          </div>
        )}
      </div>
    </section>
  );
}
