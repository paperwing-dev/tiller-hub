import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Textarea } from "@cloudflare/kumo/components/input";
import {
  ApiActionError,
  addEnvReviewer,
  cancelEnvReviewRun,
  fetchEnvReviewMessages,
  fetchEnvReviewRun,
  fetchEnvReviewState,
  fetchAgentSkills,
  fetchPlannerProviders,
  fetchReviewSkillInvocation,
  fetchReviewSkillInvocations,
  invokeReviewSkill,
  markEnvReviewFeedback,
  removeEnvReviewer,
  sendEnvReviewMessage,
  sendReviewSkillOverview,
  updateReviewSkillControls,
  cancelReviewSkillInvocation,
  type AgentRoute,
  type AgentSkillDefinition,
  type EnvReviewFeedback,
  type EnvReviewRun,
  type EnvReviewRunEvent,
  type EnvReviewState,
  type EnvReviewTab,
  type PlannerProviderMetadata,
  type ThreadMessage,
  type ReviewSkillInvocationDetail,
} from "./api";
import AddReviewerMenu, { type AddReviewerAction } from "./AddReviewerMenu";
import MarkdownContent from "./MarkdownContent";
import PlanChatInput from "./PlanChatInput";
import SkillAutomationToggle from "./SkillAutomationToggle";
import SkillEditorDialog from "./SkillEditorDialog";
import { codexAuthModeLabel } from "./codex-auth-ui";
import AgentTabButton from "./AgentTabButton";
import AgentTabStatusIndicator from "./AgentTabStatusIndicator";
import {
  envReviewTabStatus,
  implementationReviewStatus,
  readEnvReviewViewedRuns,
  writeEnvReviewViewedRuns,
} from "./env-review-tab-status";

const DEFAULT_REVIEWERS_HEIGHT = 320;
const TRANSCRIPT_BOTTOM_THRESHOLD = 24;

function getSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

interface EnvReviewPanelProps {
  envSlug: string;
  repoId: string;
  sessionId: string;
  hubUrl: string;
  harnessInputReady: boolean;
  onSendToHarness: (text: string) => Promise<{ ok: boolean; error?: string }>;
  onLayoutChange?: () => void;
}

function isActiveStatus(status: string): boolean {
  return status === "preparing" || status === "queued" || status === "running";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageText(message: ThreadMessage): string {
  if (isRecord(message.body) && typeof message.body.text === "string") return message.body.text;
  return typeof message.body === "string" ? message.body : "";
}

function messageRole(message: ThreadMessage): "user" | "assistant" {
  if (isRecord(message.body) && message.body.role === "user") return "user";
  if (isRecord(message.body) && message.body.role === "assistant") return "assistant";
  return message.senderSessionId === "user" ? "user" : "assistant";
}

function messageRunId(message: ThreadMessage): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string" ? message.body.runId : null;
}

function tabStatusForRunStatus(status: EnvReviewRun["status"]): EnvReviewTab["status"] {
  if (status === "ready") return "ready";
  if (status === "failed" || status === "cancelled") return "failed";
  return status;
}

function runForTab(state: EnvReviewState | null, tab: EnvReviewTab | null): EnvReviewRun | null {
  if (!state || !tab?.latestRunId) return null;
  return state.runs.find((run) => run.runId === tab.latestRunId) ?? null;
}

function formatModelLabel(providers: PlannerProviderMetadata[], providerId: string, modelId: string): string {
  const provider = providers.find((candidate) => candidate.id === providerId);
  const model = provider?.models.find((candidate) => candidate.id === modelId);
  return `${provider?.displayName ?? providerId} / ${model?.displayName ?? modelId}`;
}

function formatEffortLabel(providers: PlannerProviderMetadata[], providerId: string, effortId: string): string {
  const provider = providers.find((candidate) => candidate.id === providerId);
  return provider?.efforts.find((candidate) => candidate.id === effortId)?.displayName ?? effortId;
}

function formatFeedbackForHarness(feedback: EnvReviewFeedback, text: string): string {
  return [
    `[Tiller reviewer feedback]`,
    `Role: ${feedback.roleLabel}`,
    `Model: ${feedback.provider}/${feedback.model}`,
    `Snapshot prepared: ${feedback.preparationCompletedAt ?? "unknown"}`,
    `Run: ${feedback.runId}`,
    "",
    text.trim(),
    "",
  ].join("\n");
}

function formatPreparationTime(value: string | null | undefined): string {
  if (!value) return "unknown";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatRelativeAge(value: string | null | undefined): string {
  if (!value) return "unknown time ago";
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return formatPreparationTime(value);
  const seconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function runPreparation(run: EnvReviewRun) {
  return run.preparation;
}

function reviewBasisCopy(run: EnvReviewRun): string {
  const preparation = runPreparation(run);
  const snapshot = preparation?.snapshot;
  if (!snapshot) {
    return "Reviewer needs a fresh snapshot. Start a fresh reviewer run.";
  }
  const source = snapshot.source === "saved-workspace" ? "saved workspace" : "live workspace";
  return `Reviewing ${source} from ${formatRelativeAge(snapshot.createdAt)}.`;
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 2v5a3 3 0 0 0 3 3h5" />
      <path d="m10 8 2 2-2 2" />
    </svg>
  );
}

function ReviewSkillOverview({
  detail,
  providers,
  acknowledgedRunIds,
  guidance,
  onGuidanceChange,
  onModeChange,
  onOpenChild,
  onSend,
}: {
  detail: ReviewSkillInvocationDetail;
  providers: PlannerProviderMetadata[];
  acknowledgedRunIds: Readonly<Record<string, string>>;
  guidance: string;
  onGuidanceChange: (value: string) => void;
  onModeChange: (mode: "auto" | "manual") => void;
  onOpenChild: (threadId: string) => void;
  onSend: () => void;
}) {
  const { invocation } = detail;
  const editable = invocation.status === "active" && !invocation.overviewRunId;
  const overviewRun = detail.runs.find((run) => run.skillRunRole === "overview") ?? null;
  return (
    <LayerCard className="mx-auto w-full max-w-3xl border-kumo-info/30 bg-kumo-info/5">
      <div className="flex items-start justify-between gap-3 border-b border-kumo-info/20 px-4 py-3">
        <div>
          <div className="font-mono text-sm font-semibold text-kumo-info">/{invocation.definitionSnapshot.command}</div>
          <p className="mt-1 text-xs text-kumo-subtle">
            {invocation.includedMessageIds.length} of {invocation.definitionSnapshot.agents.length} agent responses included.
          </p>
        </div>
        <SkillAutomationToggle
          value={invocation.overviewMode}
          onChange={onModeChange}
          disabled={!editable}
          ariaLabel="Overview forwarding mode"
          manualTooltip="Choose which responses to send and optionally add guidance first."
          autoTooltip="Wait for every included response and forward the feedback automatically."
        />
      </div>
      <div className="divide-y divide-kumo-line/70">
        {detail.tabs.map((tab) => {
          const tabRuns = detail.runs.filter((run) => run.threadId === tab.threadId);
          const latestRun = tabRuns[tabRuns.length - 1] ?? null;
          const status = latestRun?.status ?? tab.status;
          const visualStatus = envReviewTabStatus({
            tab,
            latestRun,
            acknowledgedRunId: acknowledgedRunIds[tab.threadId] ?? null,
            modelLabel: latestRun ? formatModelLabel(providers, latestRun.provider, latestRun.model) : null,
            effortLabel: latestRun ? formatEffortLabel(providers, latestRun.provider, latestRun.effort) : null,
          });
          const statusCopy = status === "ready" ? "Open result"
            : status === "failed" ? "Failed"
              : status === "cancelled" ? "Stopped"
              : status === "preparing" || status === "queued" || status === "running" ? "Working"
                : "Open tab";
          return (
            <button
              key={tab.threadId}
              type="button"
              onClick={() => onOpenChild(tab.threadId)}
              aria-label={`${tab.roleLabel}, ${visualStatus.label}`}
              className="flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left hover:bg-kumo-tint"
            >
              <span className="flex min-w-0 items-center gap-2">
                <AgentTabStatusIndicator status={visualStatus} />
                <span className="truncate text-xs font-medium text-kumo-default">{tab.roleLabel}</span>
                {latestRun && (
                  <span className="hidden truncate text-[10px] text-kumo-subtle sm:inline">
                    {formatModelLabel(providers, latestRun.provider, latestRun.model)}
                  </span>
                )}
              </span>
              <span className={`text-[10px] font-medium ${status === "failed" ? "text-kumo-danger" : status === "cancelled" ? "text-kumo-subtle" : "text-kumo-info"}`}>
                {statusCopy}
              </span>
            </button>
          );
        })}
      </div>
      {editable && invocation.overviewMode === "manual" && (
        <div className="space-y-2 border-t border-kumo-info/20 px-4 py-3">
          <Textarea
            size="sm"
            aria-label="Overview guidance"
            rows={2}
            value={guidance}
            onChange={(event) => onGuidanceChange(event.target.value)}
            placeholder="Optional: tell the reviewer what to do with this feedback…"
            className="w-full resize-y text-xs"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onSend}
              disabled={invocation.includedMessageIds.length === 0}
              className="rounded bg-kumo-brand px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              Send to reviewer
            </button>
          </div>
        </div>
      )}
      {invocation.overviewRunId && (
        <div className="border-t border-kumo-info/20 px-4 py-3 text-xs text-kumo-subtle">
          Frozen {invocation.overviewMode} Overview · {overviewRun?.status ?? invocation.status}
        </div>
      )}
    </LayerCard>
  );
}

export default function EnvReviewPanel({
  envSlug,
  repoId,
  sessionId,
  hubUrl,
  harnessInputReady,
  onSendToHarness,
  onLayoutChange,
}: EnvReviewPanelProps) {
  const [collapsed, setCollapsed] = useState(false);
  const [state, setState] = useState<EnvReviewState | null>(null);
  const [providers, setProviders] = useState<PlannerProviderMetadata[]>([]);
  const [skillRoutes, setSkillRoutes] = useState<AgentRoute[]>([]);
  const [reviewSkills, setReviewSkills] = useState<AgentSkillDefinition[]>([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [invocationRows, setInvocationRows] = useState<Array<Record<string, unknown>>>([]);
  const [selectedInvocationId, setSelectedInvocationId] = useState<string | null>(null);
  const [invocationDetail, setInvocationDetail] = useState<ReviewSkillInvocationDetail | null>(null);
  const [activeSkillView, setActiveSkillView] = useState<"overview" | string | null>(null);
  const [overviewGuidance, setOverviewGuidance] = useState("");
  const [invokingSkillId, setInvokingSkillId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [viewedRunIds, setViewedRunIds] = useState<Record<string, string>>(() => (
    readEnvReviewViewedRuns(getSessionStorage(), envSlug, sessionId)
  ));
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [runEvents, setRunEvents] = useState<EnvReviewRunEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ feedback: EnvReviewFeedback; text: string; formatted: boolean } | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const transcriptFollowingRef = useRef(true);
  const transcriptThreadRef = useRef<string | null>(null);
  const feedbackBaselineReadyRef = useRef<Set<string> | null>(null);
  const autoDeliveryInFlightRef = useRef(new Set<string>());
  const reviewSkillRequestRef = useRef(new Map<string, string>());

  const acknowledgeViewedRun = useCallback((threadId: string, runId: string) => {
    setViewedRunIds((current) => {
      if (current[threadId] === runId) return current;
      const next = { ...current, [threadId]: runId };
      writeEnvReviewViewedRuns(getSessionStorage(), envSlug, sessionId, next);
      return next;
    });
  }, [envSlug, sessionId]);

  useEffect(() => {
    setViewedRunIds(readEnvReviewViewedRuns(getSessionStorage(), envSlug, sessionId));
  }, [envSlug, sessionId]);

  useLayoutEffect(() => {
    onLayoutChange?.();
  }, [collapsed, onLayoutChange]);

  const topLevelTabs = state?.tabs ?? [];
  const nestedTabs = invocationDetail?.tabs ?? [];
  const tabs = [...topLevelTabs, ...nestedTabs];
  const activeTab = tabs.find((tab) => tab.threadId === activeThreadId) ?? tabs[0] ?? null;
  const overviewSelected = activeSkillView === "overview" && Boolean(invocationDetail);
  const overviewRun = invocationDetail?.runs.find((run) => run.skillRunRole === "overview") ?? null;
  const overviewAttentionKey = invocationDetail ? `overview:${invocationDetail.invocation.invocationId}` : null;
  const overviewResultId = overviewRun?.runId
    ?? (invocationDetail?.invocation.status === "completed" ? invocationDetail.invocation.invocationId : null);
  const overviewTabStatus = implementationReviewStatus({
    status: overviewRun?.status ?? invocationDetail?.invocation.status,
    runId: overviewResultId,
    acknowledgedRunId: overviewAttentionKey ? viewedRunIds[overviewAttentionKey] ?? null : null,
    error: overviewRun?.error ?? invocationDetail?.invocation.error,
  });
  const combinedState = state ? { ...state, runs: [...state.runs, ...(invocationDetail?.runs ?? [])] } : null;
  const activeRun = runForTab(combinedState, activeTab);
  const topLevelTabStatuses = useMemo(() => new Map(topLevelTabs.map((tab) => {
    const latestRun = tab.latestRunId
      ? state?.runs.find((run) => run.runId === tab.latestRunId) ?? null
      : null;
    return [tab.threadId, envReviewTabStatus({
      tab,
      latestRun,
      acknowledgedRunId: viewedRunIds[tab.threadId] ?? null,
      modelLabel: formatModelLabel(
        providers,
        latestRun?.provider ?? tab.provider,
        latestRun?.model ?? tab.model,
      ),
      effortLabel: formatEffortLabel(
        providers,
        latestRun?.provider ?? tab.provider,
        latestRun?.effort ?? tab.effort,
      ),
    })] as const;
  })), [providers, state?.runs, topLevelTabs, viewedRunIds]);
  const activeReadyRunId = activeTab && (activeRun?.status === "ready" || (!activeRun && activeTab.status === "ready"))
    ? activeRun?.runId ?? activeTab.latestRunId
    : null;
  const activeCodexProfile = activeRun?.launchProvenance?.codexExecution;
  const activeParentLocked = Boolean(activeTab && invocationRows.some((row) =>
    row.parentThreadId === activeTab.threadId && (row.status === "active" || row.status === "setting_up")
  ));
  const activePreparation = activeRun ? runPreparation(activeRun) : null;
  const activeFeedback = (state?.feedback ?? []).filter((item) => item.threadId === activeTab?.threadId);
  const feedbackByMessageId = useMemo(
    () => new Map(activeFeedback.map((feedback) => [feedback.messageId, feedback])),
    [activeFeedback],
  );
  const unmatchedFeedback = useMemo(
    () => activeFeedback.filter((feedback) => !messages.some((message) => message.id === feedback.messageId)),
    [activeFeedback, messages],
  );
  const hasActiveRuns = tabs.some((tab) => isActiveStatus(tab.status))
    || (state?.runs ?? []).some((run) => isActiveStatus(run.status))
    || invocationRows.some((row) => row.status === "active" || row.status === "setting_up");
  const visibleRunEvents = useMemo(
    () => runEvents.filter((event) => event.type === "model_activity" && event.message?.trim()).slice(-20),
    [runEvents],
  );
  const latestActivity = useMemo(
    () => visibleRunEvents[visibleRunEvents.length - 1]?.message?.trim() ?? null,
    [visibleRunEvents],
  );

  useEffect(() => {
    if (!activeTab || !activeReadyRunId) return;
    acknowledgeViewedRun(activeTab.threadId, activeReadyRunId);
  }, [acknowledgeViewedRun, activeReadyRunId, activeTab]);

  useEffect(() => {
    if (!overviewSelected || !overviewAttentionKey || !overviewResultId) return;
    if (overviewRun?.status !== "ready" && invocationDetail?.invocation.status !== "completed") return;
    acknowledgeViewedRun(overviewAttentionKey, overviewResultId);
  }, [
    acknowledgeViewedRun,
    invocationDetail?.invocation.status,
    overviewAttentionKey,
    overviewResultId,
    overviewRun?.status,
    overviewSelected,
  ]);
  const loadState = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const next = await fetchEnvReviewState(hubUrl, envSlug, sessionId);
      setState(next);
      setActiveThreadId((current) => current ?? next.tabs[0]?.threadId ?? null);
      setError(null);
    } catch (error) {
      if (!quiet) setError(error instanceof Error ? error.message : "Failed to load reviewers");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [envSlug, hubUrl, sessionId]);

  useEffect(() => {
    feedbackBaselineReadyRef.current = null;
    autoDeliveryInFlightRef.current.clear();
  }, [envSlug, sessionId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  useEffect(() => {
    if (!state) return;
    const ready = state.feedback.filter((feedback) => feedback.status === "ready");
    if (!feedbackBaselineReadyRef.current) {
      feedbackBaselineReadyRef.current = new Set(ready.map((feedback) => feedback.feedbackId));
      return;
    }
    for (const feedback of ready) {
      if (feedbackBaselineReadyRef.current.has(feedback.feedbackId)) continue;
      feedbackBaselineReadyRef.current.add(feedback.feedbackId);
      if (feedback.metadata.overviewMode !== "auto" || !feedback.metadata.skillInvocationId) continue;
      if (autoDeliveryInFlightRef.current.has(feedback.feedbackId)) continue;
      autoDeliveryInFlightRef.current.add(feedback.feedbackId);
      const delivered = formatFeedbackForHarness(feedback, feedback.text);
      void (async () => {
        try {
          await markEnvReviewFeedback(hubUrl, envSlug, feedback.feedbackId, "pending", {
            sessionId,
            deliveredText: delivered,
          });
          if (!harnessInputReady) return;
          const acknowledged = await onSendToHarness(delivered);
          if (!acknowledged.ok) return;
          await markEnvReviewFeedback(hubUrl, envSlug, feedback.feedbackId, "sent", {
            sessionId,
            deliveredText: delivered,
          });
        } catch {
          // Another mounted client may win the ready -> pending claim. Failed
          // transport intentionally stays pending for explicit manual retry.
        } finally {
          autoDeliveryInFlightRef.current.delete(feedback.feedbackId);
          void loadState(true);
        }
      })();
    }
  }, [envSlug, harnessInputReady, hubUrl, loadState, onSendToHarness, sessionId, state]);

  useEffect(() => {
    let cancelled = false;
    void fetchPlannerProviders(hubUrl, repoId)
      .then((result) => {
        if (cancelled) return;
        setProviders(result.providers);
        setSkillRoutes(result.skillRoutes ?? []);
      })
      .catch((error) => {
        if (!cancelled) setError(error instanceof Error ? error.message : "Failed to load reviewer models");
      });
    return () => {
      cancelled = true;
    };
  }, [hubUrl, repoId]);

  const loadReviewSkills = useCallback(async () => {
    try {
      setReviewSkills(await fetchAgentSkills(hubUrl, repoId, "review"));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load Review skills");
    }
  }, [hubUrl, repoId]);

  const loadInvocationRows = useCallback(async (cursor: string | null = null, preserve = false) => {
    try {
      const result = await fetchReviewSkillInvocations(hubUrl, envSlug, sessionId, { limit: 20, cursor });
      setInvocationRows((current) => {
        if (cursor) {
          return [...current, ...result.invocations.filter((row) => !current.some((existing) => existing.invocationId === row.invocationId))];
        }
        if (!preserve) return result.invocations;
        return [
          ...result.invocations,
          ...current.filter((row) => !result.invocations.some((fresh) => fresh.invocationId === row.invocationId)),
        ];
      });
    } catch {
      // Active invocation restoration is best-effort; ordinary reviewer tabs remain usable.
    }
  }, [envSlug, hubUrl, sessionId]);

  useEffect(() => {
    void loadReviewSkills();
    void loadInvocationRows();
  }, [loadInvocationRows, loadReviewSkills]);

  useEffect(() => {
    if (selectedInvocationId) return;
    const active = activeThreadId
      ? invocationRows.find((row) => (
          row.parentThreadId === activeThreadId
          && (row.status === "active" || row.status === "setting_up")
        ))
      : invocationRows.find((row) => row.status === "active" || row.status === "setting_up");
    if (!active || typeof active.invocationId !== "string") return;
    setSelectedInvocationId(active.invocationId);
    setActiveSkillView("overview");
    if (typeof active.parentThreadId === "string") setActiveThreadId(active.parentThreadId);
  }, [activeThreadId, invocationRows, selectedInvocationId]);

  const selectedInvocationActive = invocationRows.some((row) =>
    row.invocationId === selectedInvocationId
      && (row.status === "active" || row.status === "setting_up")
  );
  const selectedLinkedRunActive = invocationDetail?.invocation.invocationId === selectedInvocationId
    && invocationDetail.runs.some((run) => isActiveStatus(run.status));
  const shouldPollInvocationDetail = selectedInvocationActive || selectedLinkedRunActive;

  useEffect(() => {
    if (!selectedInvocationId) {
      setInvocationDetail(null);
      setActiveSkillView(null);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const detail = await fetchReviewSkillInvocation(hubUrl, envSlug, sessionId, selectedInvocationId);
        if (!cancelled) setInvocationDetail(detail);
      } catch {
        if (!cancelled) setInvocationDetail(null);
      }
    };
    void load();
    const interval = shouldPollInvocationDetail
      ? window.setInterval(() => void load(), 2_000)
      : null;
    return () => {
      cancelled = true;
      if (interval !== null) window.clearInterval(interval);
    };
  }, [envSlug, hubUrl, selectedInvocationId, sessionId, shouldPollInvocationDetail]);

  useEffect(() => {
    if (!invocationDetail || invocationDetail.invocation.invocationId !== selectedInvocationId) return;
    setActiveSkillView((current) => current === "overview" || invocationDetail.tabs.some((tab) => tab.threadId === current)
      ? current
      : "overview");
    if (activeSkillView === "overview") {
      setActiveThreadId(invocationDetail.invocation.parentThreadId);
    }
  }, [activeSkillView, invocationDetail, selectedInvocationId]);

  useEffect(() => {
    setOverviewGuidance("");
  }, [selectedInvocationId]);

  useEffect(() => {
    if (!hasActiveRuns) return;
    const interval = window.setInterval(() => {
      void loadState(true);
      void loadInvocationRows(null, true);
    }, 2_000);
    return () => window.clearInterval(interval);
  }, [hasActiveRuns, loadInvocationRows, loadState]);

  useEffect(() => {
    if (!activeTab) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void fetchEnvReviewMessages(hubUrl, envSlug, activeTab.threadId, sessionId)
      .then((next) => {
        if (!cancelled) setMessages(next);
      })
      .catch(() => {
        if (!cancelled) setMessages([]);
      });
    return () => {
      cancelled = true;
    };
  }, [activeRun?.status, activeTab, envSlug, hubUrl, sessionId, state?.feedback.length]);

  useEffect(() => {
    if (!activeRun) {
      setRunEvents([]);
      return;
    }
    setRunEvents([]);
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await fetchEnvReviewRun(hubUrl, envSlug, activeRun.runId, sessionId);
        if (cancelled) return;
        setRunEvents(result.events.filter((event) => event.type === "model_activity"));
        setState((current) => current
          ? {
              ...current,
              runs: current.runs.map((run) => run.runId === result.run.runId ? result.run : run),
              tabs: current.tabs.map((tab) => tab.threadId === result.run.threadId
                ? { ...tab, status: tabStatusForRunStatus(result.run.status) }
                : tab),
            }
          : current);
        setInvocationDetail((current) => current ? {
          ...current,
          runs: current.runs.map((run) => run.runId === result.run.runId ? result.run : run),
          tabs: current.tabs.map((tab) => tab.threadId === result.run.threadId
            ? { ...tab, status: tabStatusForRunStatus(result.run.status) }
            : tab),
        } : current);
        if (result.run.status === "ready" || result.run.status === "failed" || result.run.status === "cancelled") {
          const nextMessages = await fetchEnvReviewMessages(hubUrl, envSlug, result.run.threadId, sessionId);
          if (!cancelled) setMessages(nextMessages);
          void loadState(true);
        }
      } catch {
        // Polling is best-effort; the state poll remains the fallback.
      }
    };
    void poll();
    if (!isActiveStatus(activeRun.status)) return () => {
      cancelled = true;
    };
    const interval = window.setInterval(() => void poll(), 1500);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [activeRun?.runId, activeRun?.status, envSlug, hubUrl, loadState, sessionId]);

  useLayoutEffect(() => {
    const transcript = transcriptScrollRef.current;
    const threadId = activeTab?.threadId ?? null;
    if (transcriptThreadRef.current !== threadId) {
      transcriptThreadRef.current = threadId;
      transcriptFollowingRef.current = true;
    }
    if (!transcript || !transcriptFollowingRef.current) return;
    const top = transcript.scrollHeight;
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({ top, behavior: "auto" });
    } else {
      transcript.scrollTop = top;
    }
  }, [activeRun?.status, activeTab?.threadId, latestActivity, messages.length, unmatchedFeedback.length, visibleRunEvents.length]);

  const addReviewer = useCallback(async (input: AddReviewerAction) => {
    if (!input.provider || !input.model) return;
    setLoading(true);
    try {
      const next = await addEnvReviewer(hubUrl, envSlug, {
        sessionId,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
      });
      setState(next);
      setActiveThreadId(next.tabs[next.tabs.length - 1]?.threadId ?? null);
      setActiveSkillView(null);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to add reviewer");
    } finally {
      setLoading(false);
    }
  }, [envSlug, hubUrl, sessionId]);

  const removeTab = useCallback(async (threadId: string) => {
    try {
      const next = await removeEnvReviewer(hubUrl, envSlug, threadId, sessionId);
      setState(next);
      setActiveThreadId((current) => current === threadId ? next.tabs[0]?.threadId ?? null : current);
      setActiveSkillView(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to remove reviewer");
    }
  }, [envSlug, hubUrl, sessionId]);

  const cancelRun = useCallback(async (run: EnvReviewRun) => {
    setLoading(true);
    try {
      const next = await cancelEnvReviewRun(hubUrl, envSlug, run.runId, { sessionId });
      setState(next);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to stop reviewer");
    } finally {
      setLoading(false);
    }
  }, [envSlug, hubUrl, sessionId]);

  const sendReviewerChatMessage = useCallback(async (text: string): Promise<boolean> => {
    if (!activeTab || isActiveStatus(activeTab.status) || sendingMessage) return false;
    setSendingMessage(true);
    setError(null);
    try {
      const result = await sendEnvReviewMessage(hubUrl, envSlug, activeTab.threadId, {
        sessionId,
        text,
      });
      setState(result.state);
      setMessages(result.messages);
      setRunEvents([]);
      if (result.run) {
        setActiveThreadId(result.run.threadId);
        if (activeTab.skillInvocationId) {
          setInvocationDetail((current) => current ? {
            ...current,
            runs: [...current.runs.filter((run) => run.runId !== result.run!.runId), result.run!],
            tabs: current.tabs.map((tab) => tab.threadId === result.run!.threadId
              ? { ...tab, latestRunId: result.run!.runId, status: tabStatusForRunStatus(result.run!.status) }
              : tab),
          } : current);
        }
      }
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to send reviewer message");
      void loadState(true);
      return false;
    } finally {
      setSendingMessage(false);
    }
  }, [activeTab, envSlug, hubUrl, loadState, sendingMessage, sessionId]);

  const invokeSkill = useCallback(async (skill: AgentSkillDefinition) => {
    if (!activeTab || activeTab.skillInvocationId || isActiveStatus(activeTab.status) || invokingSkillId) return false;
    const actionKey = `${activeTab.threadId}:${skill.id}`;
    const requestId = reviewSkillRequestRef.current.get(actionKey) ?? crypto.randomUUID();
    reviewSkillRequestRef.current.set(actionKey, requestId);
    setInvokingSkillId(skill.id);
    setError(null);
    try {
      const result = await invokeReviewSkill(hubUrl, envSlug, activeTab.threadId, skill.id, {
        sessionId,
        requestId,
        overviewMode: skill.overviewMode,
      });
      reviewSkillRequestRef.current.delete(actionKey);
      if (result.kind === "fanout") {
        setSelectedInvocationId(result.invocation.invocationId);
        setInvocationDetail(result);
        setActiveSkillView("overview");
        setActiveThreadId(result.invocation.parentThreadId);
      }
      await loadState(true);
      await loadInvocationRows(null, true);
      return true;
    } catch (error) {
      if (error instanceof ApiActionError && error.code !== "skill_setup_incomplete") {
        reviewSkillRequestRef.current.delete(actionKey);
      }
      setError(error instanceof Error ? error.message : `Failed to run /${skill.command}`);
      return false;
    } finally {
      setInvokingSkillId(null);
    }
  }, [activeTab, envSlug, hubUrl, invokingSkillId, loadInvocationRows, loadState, sessionId]);

  const setOverviewControls = useCallback(async (
    overviewMode: "auto" | "manual",
    includedMessageIds: string[],
  ) => {
    if (!invocationDetail || invocationDetail.invocation.overviewRunId) return;
    try {
      const invocation = await updateReviewSkillControls(
        hubUrl,
        envSlug,
        invocationDetail.invocation.invocationId,
        { sessionId, overviewMode, includedMessageIds },
      );
      setInvocationDetail((current) => current ? { ...current, invocation } : current);
      void loadInvocationRows(null, true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to update Overview controls");
    }
  }, [envSlug, hubUrl, invocationDetail, loadInvocationRows, sessionId]);

  const toggleOverviewMessage = useCallback((messageId: string) => {
    if (!invocationDetail) return;
    const current = invocationDetail.invocation.includedMessageIds;
    const includedMessageIds = current.includes(messageId)
      ? current.filter((id) => id !== messageId)
      : [...current, messageId];
    void setOverviewControls(invocationDetail.invocation.overviewMode, includedMessageIds);
  }, [invocationDetail, setOverviewControls]);

  const sendManualOverview = useCallback(async () => {
    if (!invocationDetail) return;
    try {
      await sendReviewSkillOverview(hubUrl, envSlug, invocationDetail.invocation.invocationId, {
        sessionId,
        guidance: overviewGuidance.trim() || null,
      });
      setOverviewGuidance("");
      const detail = await fetchReviewSkillInvocation(hubUrl, envSlug, sessionId, invocationDetail.invocation.invocationId);
      setInvocationDetail(detail);
      void loadInvocationRows(null, true);
      void loadState(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to send Manual Overview");
    }
  }, [envSlug, hubUrl, invocationDetail, loadInvocationRows, loadState, overviewGuidance, sessionId]);

  const dismissFeedback = useCallback(async (feedback: EnvReviewFeedback) => {
    try {
      await markEnvReviewFeedback(hubUrl, envSlug, feedback.feedbackId, "dismiss", { sessionId });
      await loadState(true);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to dismiss feedback");
    }
  }, [envSlug, hubUrl, loadState, sessionId]);

  const confirmSend = useCallback(async () => {
    if (!preview) return;
    const delivered = preview.feedback.status === "pending"
      ? preview.feedback.deliveredText ?? preview.text
      : preview.formatted
        ? preview.text
        : formatFeedbackForHarness(preview.feedback, preview.text);
    setSendError(null);
    try {
      if (preview.feedback.status === "ready") {
        await markEnvReviewFeedback(hubUrl, envSlug, preview.feedback.feedbackId, "pending", {
          sessionId,
          deliveredText: delivered,
        });
      }
      const sent = await onSendToHarness(delivered);
      if (!sent.ok) {
        setSendError(sent.error || "Harness did not acknowledge feedback");
        await loadState(true);
        return;
      }
      await markEnvReviewFeedback(hubUrl, envSlug, preview.feedback.feedbackId, "sent", {
        sessionId,
        deliveredText: delivered,
      });
      setPreview(null);
      await loadState(true);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send feedback");
      await loadState(true);
    }
  }, [envSlug, hubUrl, loadState, onSendToHarness, preview, sessionId]);

  const renderFeedbackActions = (feedback: EnvReviewFeedback) => (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase text-kumo-subtle">{feedback.status}</span>
      <button
        type="button"
        onClick={() => setPreview({
          feedback,
          text: feedback.deliveredText ?? feedback.text,
          formatted: Boolean(feedback.deliveredText),
        })}
        disabled={feedback.status === "sent"}
        className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
      >
        {feedback.status === "pending" ? "Retry delivery" : "Send to Harness"}
      </button>
      <button
        type="button"
        onClick={() => setPreview({ feedback, text: feedback.text, formatted: false })}
        disabled={feedback.status !== "ready"}
        className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
      >
        Edit & Send
      </button>
      <button
        type="button"
        onClick={() => void dismissFeedback(feedback)}
        disabled={feedback.status === "sent"}
        className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
      >
        Dismiss
      </button>
      {!harnessInputReady && feedback.status === "pending" && (
        <span className="text-xs text-kumo-subtle">Harness input unavailable.</span>
      )}
    </div>
  );
  const activeRunLabel = activeRun?.status === "preparing"
    ? "Preparing review snapshot..."
    : activeRun?.status === "queued"
      ? "Reviewer queued..."
      : activeRun?.status === "running"
        ? "Reviewer is working..."
        : null;
  const composerDisabled = !activeTab || loading || sendingMessage || isActiveStatus(activeTab.status) || activeParentLocked;
  const composerPlaceholder = overviewSelected
    ? activeParentLocked ? "Overview is collecting reports..." : "Message Overview"
    : !activeTab
    ? "Add a reviewer first"
    : isActiveStatus(activeTab.status) || activeParentLocked
      ? "Reviewer is working..."
      : activeTab.skillInvocationId
        ? `Follow up with ${activeTab.roleLabel}`
        : "Message this reviewer or type / for skills";

  if (collapsed) {
    return (
      <div
        data-testid="env-review-panel"
        className="shrink-0 border-t border-kumo-line bg-kumo-base px-3 py-2"
      >
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          className="text-xs font-medium text-kumo-subtle hover:text-kumo-default"
        >
          Reviewers
        </button>
      </div>
    );
  }

  return (
    <section
      data-testid="env-review-panel"
      className="flex shrink-0 flex-col border-t border-kumo-line bg-kumo-base"
      style={{ height: DEFAULT_REVIEWERS_HEIGHT }}
      aria-label="Reviewers"
    >
      <div className="flex items-start justify-between gap-3 border-b border-kumo-line px-3 py-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-subtle hover:bg-kumo-tint"
            title="Collapse reviewers"
          >
            Reviewers
          </button>
          <div className="flex max-h-16 min-w-0 flex-1 flex-wrap items-center gap-1 overflow-y-auto pr-1">
            {topLevelTabs.map((tab) => (
              <AgentTabButton
                key={tab.threadId}
                label={tab.roleLabel}
                status={topLevelTabStatuses.get(tab.threadId) ?? implementationReviewStatus({
                  status: tab.status,
                  runId: tab.latestRunId,
                })}
                active={activeTab?.threadId === tab.threadId}
                onClick={() => {
                  setActiveThreadId(tab.threadId);
                  const linkedInvocation = invocationRows.find((row) => (
                    row.parentThreadId === tab.threadId
                    && (row.status === "active" || row.status === "setting_up")
                  ));
                  if (linkedInvocation && typeof linkedInvocation.invocationId === "string") {
                    setSelectedInvocationId(linkedInvocation.invocationId);
                    setActiveSkillView("overview");
                  } else {
                    setSelectedInvocationId(null);
                    setActiveSkillView(null);
                  }
                }}
              />
            ))}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AddReviewerMenu
            activeReviewerCount={topLevelTabs.length}
            providers={providers}
            disabled={loading}
            onAdd={(input) => void addReviewer(input)}
          />
          <button
            type="button"
            onClick={() => setSkillsOpen(true)}
            className="h-8 rounded border border-kumo-line bg-kumo-base px-2 text-xs font-medium text-kumo-default hover:bg-kumo-tint"
          >
            Review Skills
          </button>
        </div>
      </div>

      {error && <div className="border-b border-kumo-line px-3 py-2 text-xs text-kumo-danger">{error}</div>}
      {sendError && <div className="border-b border-kumo-line px-3 py-2 text-xs text-kumo-danger">{sendError}</div>}

      {invocationDetail && activeSkillView && (
        <div className="flex min-h-[48px] items-center gap-2 overflow-x-auto border-b border-kumo-line bg-kumo-base px-3 py-2" data-testid="review-skill-tab-row">
          <div className="mr-1 flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-kumo-subtle">
            <BranchIcon /> /{invocationDetail.invocation.definitionSnapshot.command}
          </div>
          <button
            type="button"
            onClick={() => {
              setActiveSkillView("overview");
              setActiveThreadId(invocationDetail.invocation.parentThreadId);
            }}
            aria-label={`Overview, ${overviewTabStatus.label}`}
            className={`flex h-8 shrink-0 items-center gap-1.5 rounded border px-2 text-xs ${overviewSelected ? "border-kumo-focus bg-kumo-base text-kumo-default" : "border-kumo-line bg-kumo-recessed text-kumo-subtle hover:bg-kumo-tint"}`}
          >
            <AgentTabStatusIndicator status={overviewTabStatus} />
            Overview
          </button>
          {invocationDetail.tabs.map((tab) => {
            const tabRuns = invocationDetail.runs.filter((run) => run.threadId === tab.threadId);
            const latestRun = tabRuns[tabRuns.length - 1];
            const visualStatus = envReviewTabStatus({
              tab,
              latestRun,
              acknowledgedRunId: viewedRunIds[tab.threadId] ?? null,
              modelLabel: latestRun ? formatModelLabel(providers, latestRun.provider, latestRun.model) : null,
              effortLabel: latestRun ? formatEffortLabel(providers, latestRun.provider, latestRun.effort) : null,
            });
            return (
              <button
                key={tab.threadId}
                type="button"
                onClick={() => {
                  setActiveSkillView(tab.threadId);
                  setActiveThreadId(tab.threadId);
                }}
                aria-label={`${tab.roleLabel}, ${visualStatus.label}`}
                className={`flex h-8 shrink-0 items-center gap-1.5 rounded border px-2 text-xs ${activeSkillView === tab.threadId ? "border-kumo-focus bg-kumo-base text-kumo-default" : "border-kumo-line bg-kumo-recessed text-kumo-subtle hover:bg-kumo-tint"}`}
              >
                <AgentTabStatusIndicator status={visualStatus} />
                {tab.roleLabel}
              </button>
            );
          })}
          {(invocationDetail.invocation.status === "active" || invocationDetail.invocation.status === "setting_up") && (
            <button
              type="button"
              onClick={() => void cancelReviewSkillInvocation(hubUrl, envSlug, invocationDetail.invocation.invocationId, sessionId).then(() => {
                void loadInvocationRows(null, true);
                void loadState(true);
              })}
              className="ml-auto shrink-0 rounded border border-kumo-danger/30 px-2 py-1 text-xs text-kumo-danger"
            >Cancel fanout</button>
          )}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[220px_minmax(0,1fr)] overflow-hidden">
        <aside className="min-h-0 overflow-y-auto border-r border-kumo-line p-3 pb-6 text-xs text-kumo-subtle">
          {activeTab ? (
            <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                {activeRun && isActiveStatus(activeRun.status) && (
                  <button
                    type="button"
                    onClick={() => void cancelRun(activeRun)}
                    disabled={loading}
                    className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
                  >
                    Stop
                  </button>
                )}
                {!overviewSelected && (
                  <button
                    type="button"
                    onClick={() => activeTab && void removeTab(activeTab.threadId)}
                    disabled={loading || Boolean(activeTab.skillInvocationId) || activeParentLocked}
                    title={activeTab.skillInvocationId ? "Skill child tabs are retained in history" : activeParentLocked ? "Parent reviewer is locked by the active Overview" : undefined}
                    className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
                  >
                    Remove
                  </button>
                )}
              </div>
              {activeRun?.planBasis && (
                <div>
                  <div className="font-medium text-kumo-default">Plan</div>
                  {activeRun.planBasis.source === "none" ? (
                    <div>No startup plan</div>
                  ) : (
                    <>
                      <div className="truncate">{activeRun.planBasis.title || "Startup plan"}</div>
                      {activeRun.planBasis.version != null && <div>v{activeRun.planBasis.version}</div>}
                    </>
                  )}
                </div>
              )}
              <div>
                <div className="font-medium text-kumo-default">{overviewSelected ? "Overview" : activeTab.roleLabel}</div>
                <div>{formatModelLabel(providers, activeTab.provider, activeTab.model)}</div>
                <div>{formatEffortLabel(providers, activeTab.provider, activeTab.effort)} effort</div>
                {activeCodexProfile && (
                  <div className="mt-1">
                    <span className="rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                      {codexAuthModeLabel(activeCodexProfile.kind === "subscription-app-server" ? "subscription" : "api-key")}
                    </span>
                  </div>
                )}
              </div>
              {activePreparation && (
                <div>
                  <div className="font-medium text-kumo-default">{activePreparation.snapshot ? "Snapshot" : "Preparation"}</div>
                  <div>{formatPreparationTime(activePreparation.snapshot?.createdAt ?? activePreparation.completedAt)}</div>
                  {activePreparation.snapshot && (
                    <div>{activePreparation.snapshot.source === "saved-workspace" ? "Saved workspace" : "Live workspace"}</div>
                  )}
                  <div>{activePreparation.changedCount} changed, {activePreparation.deletedCount} deleted</div>
                </div>
              )}
              {activeRun?.changeContext && (
                <div>
                  <div className="font-medium text-kumo-default">Files</div>
                  <div>{activeRun.changeContext.summary.total} total</div>
                  <div>{activeRun.changeContext.summary.omitted} omitted, {activeRun.changeContext.summary.truncated} truncated</div>
                  <ul className="mt-1 space-y-0.5">
                    {activeRun.changeContext.summary.files.map((file) => (
                      <li key={file.path} className="truncate">
                        {file.status}: {file.path}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p>No reviewers yet.</p>
          )}
        </aside>

        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div
            ref={transcriptScrollRef}
            aria-label="Implementor reviewer conversation"
            className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-6"
            onScroll={(event) => {
              const transcript = event.currentTarget;
              transcriptFollowingRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
                <= TRANSCRIPT_BOTTOM_THRESHOLD;
            }}
          >
            {!activeTab ? (
              <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
                Add a reviewer or run a Review skill.
              </div>
            ) : (
              <>
                {overviewSelected && invocationDetail && (
                  <ReviewSkillOverview
                    detail={invocationDetail}
                    providers={providers}
                    acknowledgedRunIds={viewedRunIds}
                    guidance={overviewGuidance}
                    onGuidanceChange={setOverviewGuidance}
                    onModeChange={(overviewMode) => void setOverviewControls(
                      overviewMode,
                      invocationDetail.invocation.includedMessageIds,
                    )}
                    onOpenChild={(threadId) => {
                      setActiveSkillView(threadId);
                      setActiveThreadId(threadId);
                    }}
                    onSend={() => void sendManualOverview()}
                  />
                )}
                {messages.length === 0 && !activeRun && !overviewSelected && (
                  <div className="py-8 text-center text-sm text-kumo-subtle">
                    Run a review or ask this reviewer a code-aware question.
                  </div>
                )}
              {activeRun && activePreparation && (
                <div className="rounded border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-subtle">
                  {reviewBasisCopy(activeRun)}
                </div>
              )}
                {messages.map((message) => {
                  const role = messageRole(message);
                  const text = messageText(message);
                  const feedback = feedbackByMessageId.get(message.id) ?? null;
                  const reportRun = invocationDetail?.runs.find((run) => run.runId === messageRunId(message));
                  const overviewEligible = role === "assistant"
                    && reportRun?.threadId === activeTab?.threadId
                    && reportRun.status === "ready"
                    && (reportRun.skillRunRole === "child_initial" || reportRun.skillRunRole === "child_followup");
                  if (!text.trim()) return null;
                  return (
                    <div key={message.id} className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
                      <div
                        className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                          role === "user"
                            ? "bg-kumo-brand text-white"
                            : "border border-kumo-line bg-kumo-recessed text-kumo-default"
                        }`}
                      >
                        {role === "assistant" ? (
                          <MarkdownContent>{text}</MarkdownContent>
                        ) : (
                          <div className="whitespace-pre-wrap break-words">{text}</div>
                        )}
                        {overviewEligible
                          && activeTab?.skillInvocationId === invocationDetail?.invocation.invocationId
                          && !invocationDetail.invocation.overviewRunId
                          && invocationDetail.invocation.status === "active" && (
                          <label className="mt-2 flex items-center gap-1.5 border-t border-kumo-line pt-2 text-xs text-kumo-subtle">
                            <input
                              type="checkbox"
                              checked={invocationDetail.invocation.includedMessageIds.includes(message.id)}
                              onChange={() => toggleOverviewMessage(message.id)}
                            />
                            Include in Overview
                          </label>
                        )}
                        {feedback && renderFeedbackActions(feedback)}
                      </div>
                    </div>
                  );
                })}
                {activeRun && activeRunLabel && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
                      <div className="animate-pulse">{activeRunLabel}</div>
                      {latestActivity && (
                        <div className="mt-1 whitespace-pre-wrap break-words text-xs text-kumo-default">{latestActivity}</div>
                      )}
                      {visibleRunEvents.length > 1 && (
                        <details className="mt-2 text-xs">
                          <summary className="cursor-pointer font-medium text-kumo-info">Activity</summary>
                          <div className="mt-1 max-h-40 space-y-1 overflow-auto">
                            {visibleRunEvents.map((event) => (
                              <div
                                key={`${event.runId}:${event.seq}`}
                                className="whitespace-pre-wrap break-words rounded border border-kumo-line bg-kumo-base p-1.5 text-[10px] text-kumo-default"
                              >
                                {event.message}
                              </div>
                            ))}
                          </div>
                        </details>
                      )}
                    </div>
                  </div>
                )}
                {(activeRun?.status === "failed" || activeRun?.status === "cancelled") && (
                  <div className="flex justify-start">
                    <div className="max-w-[80%] rounded-lg border border-kumo-danger/40 bg-kumo-danger/10 px-3 py-2 text-sm text-kumo-danger">
                      {activeRun.error || (activeRun.status === "cancelled" ? "Reviewer stopped." : "Reviewer failed.")}
                    </div>
                  </div>
                )}
                {unmatchedFeedback.map((feedback) => (
                  <div key={feedback.feedbackId} className="rounded border border-kumo-line bg-kumo-recessed px-3 py-2">
                    {renderFeedbackActions(feedback)}
                  </div>
                ))}
              </>
            )}
          </div>
          <div className="bg-kumo-base pb-2">
            <PlanChatInput
              disabled={composerDisabled}
              placeholder={composerPlaceholder}
              onSend={(message) => sendReviewerChatMessage(message)}
              skills={!overviewSelected && !activeTab?.skillInvocationId ? reviewSkills : []}
              onInvokeSkill={!overviewSelected && !activeTab?.skillInvocationId ? invokeSkill : undefined}
            />
          </div>
        </main>
      </div>

      <SkillEditorDialog
        repoId={repoId}
        surface="review"
        open={skillsOpen}
        skills={reviewSkills}
        routes={skillRoutes}
        onOpenChange={setSkillsOpen}
        onChanged={loadReviewSkills}
      />

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded border border-kumo-line bg-kumo-base shadow-xl">
            <div className="border-b border-kumo-line px-4 py-3 text-sm font-semibold text-kumo-default">
              Send to Harness
            </div>
            <div className="min-h-0 flex-1 p-4">
              <textarea
                value={preview.text}
                onChange={(event) => setPreview({ ...preview, text: event.target.value })}
                className="h-72 w-full resize-none rounded border border-kumo-line bg-kumo-base p-3 font-mono text-xs text-kumo-default"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
              <button type="button" onClick={() => setPreview(null)} className="rounded border border-kumo-line px-3 py-1.5 text-sm">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmSend()}
                disabled={!harnessInputReady || !preview.text.trim()}
                className="rounded bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
