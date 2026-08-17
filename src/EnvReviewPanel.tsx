import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { Textarea } from "@cloudflare/kumo/components/input";
import { Popover } from "@cloudflare/kumo/components/popover";
import { CaretRightIcon, DotsThreeIcon, GearSixIcon, StopIcon } from "@phosphor-icons/react";
import {
  ApiActionError,
  addEnvReviewer,
  cancelEnvReviewRun,
  cancelReviewSkillInvocation,
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
  removeReviewSkillInvocation,
  rerunReviewSkillInvocation,
  sendEnvReviewMessage,
  sendReviewSkillOverview,
  updateReviewSkillControls,
  type AgentRoute,
  type AgentSkillDefinition,
  type EnvReviewFeedback,
  type EnvReviewFanoutHandoff,
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
import AgentTabStatusIndicator from "./AgentTabStatusIndicator";
import ReviewerActivityDetails from "./ReviewerActivityDetails";
import {
  BottomPaneResizeHandle,
  useResizableBottomPane,
} from "./ResizableBottomPane";
import {
  envReviewTabStatus,
  implementationReviewStatus,
  readEnvReviewViewedRuns,
  writeEnvReviewViewedRuns,
} from "./env-review-tab-status";
import { useSerializedRefresh } from "./useSerializedRefresh";
import { resolveReviewerRailKeyboardAction } from "./reviewer-rail-keyboard";

const DEFAULT_REVIEWERS_HEIGHT = 320;
const MIN_REVIEWERS_HEIGHT = 160;
const MIN_TERMINAL_HEIGHT = 120;
const REVIEWERS_HEIGHT_STORAGE_KEY = "tiller:implementor-reviewers-height";
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
  onSendToHarness: (text: string, deliveryId?: string) => Promise<{ ok: boolean; error?: string }>;
  onLayoutChange?: () => void;
}

function isActiveStatus(status: string): boolean {
  return status === "preparing" || status === "queued" || status === "running";
}

function isActiveInvocationRow(row: { status?: unknown }): boolean {
  return row.status === "active" || row.status === "setting_up";
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

function mergeThreadMessages(
  current: ThreadMessage[],
  incoming: ThreadMessage[],
): ThreadMessage[] {
  const byId = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) byId.set(message.id, message);
  return [...byId.values()].sort((left, right) => left.seq - right.seq);
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

function readFanoutHandoff(feedback: EnvReviewFeedback): EnvReviewFanoutHandoff | null {
  const handoff = feedback.metadata?.reviewHandoff;
  const isTarget = (value: unknown): value is EnvReviewFanoutHandoff["models"][number] => isRecord(value)
    && typeof value.provider === "string"
    && typeof value.model === "string";
  if (
    !isRecord(handoff)
    || handoff.schemaVersion !== 1
    || handoff.kind !== "fanout_overview"
    || typeof handoff.skillLabel !== "string"
    || typeof handoff.reviewerCount !== "number"
    || !Array.isArray(handoff.models)
    || !handoff.models.every(isTarget)
  ) return null;
  return handoff as unknown as EnvReviewFanoutHandoff;
}

function formatModelList(models: EnvReviewFanoutHandoff["models"]): string {
  const labels = models.map((target) => `${target.provider}/${target.model}`);
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

function formatFanoutFeedbackForHarness(handoff: EnvReviewFanoutHandoff, text: string): string {
  const models = formatModelList(handoff.models);
  const reviewerCount = `${handoff.reviewerCount} reviewer${handoff.reviewerCount === 1 ? "" : "s"}`;
  return [
    "[Tiller reviewer feedback]",
    `${handoff.skillLabel}: synthesized from ${reviewerCount}${models ? ` (${models})` : ""}.`,
    "",
    text.trim(),
    "",
  ].join("\n");
}

export function formatFeedbackForHarness(feedback: EnvReviewFeedback, text: string): string {
  const handoff = readFanoutHandoff(feedback);
  if (handoff) return formatFanoutFeedbackForHarness(handoff, text);
  return [
    `[Tiller reviewer feedback]`,
    `${feedback.roleLabel} (${feedback.provider}/${feedback.model}).`,
    "",
    text.trim(),
    "",
  ].join("\n");
}

function formatSnapshotTime(value: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(date);
}

type ReviewSnapshot = NonNullable<NonNullable<EnvReviewRun["preparation"]>["snapshot"]>;

export function formatReviewBasis(snapshot: ReviewSnapshot): string {
  const source = snapshot.source === "saved-workspace" ? "saved workspace" : "live workspace";
  const staleNotice = snapshot.stale
    ? " It may not include the latest changes from the live workspace."
    : "";
  return `Review basis: ${source} snapshot captured ${formatSnapshotTime(snapshot.createdAt)}.${staleNotice}`;
}

function runPreparation(run: EnvReviewRun) {
  return run.preparation;
}

export function formatReviewBasisSummary(run: EnvReviewRun): string {
  const preparation = runPreparation(run);
  const snapshot = preparation?.snapshot;
  if (!snapshot) {
    return "Frozen review snapshot";
  }
  const summary = run.changeContext?.summary;
  const basis = summary
    ? `${summary.total} file${summary.total === 1 ? "" : "s"} changed`
    : "Frozen review snapshot";
  return snapshot.stale ? `${basis} · Snapshot may be out of date` : basis;
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
  const overviewRun = detail.runs.find((run) => (
    run.runId === invocation.overviewRunId
    && run.skillRunRole === "overview"
    && run.preparationOpId === invocation.preparationOpId
  )) ?? null;
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
          ariaLabel="Overview synthesis mode"
          manualTooltip="Choose which responses to include, optionally add guidance, then create Overview."
          autoTooltip="Wait for every child response, create Overview, and forward its feedback to the implementor automatically."
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
              Create Overview
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
  const {
    height: reviewersHeight,
    paneRef: reviewersPaneRef,
    resizeWithKeyboard,
    startResize,
  } = useResizableBottomPane({
    defaultHeight: DEFAULT_REVIEWERS_HEIGHT,
    minBottomHeight: MIN_REVIEWERS_HEIGHT,
    minTopHeight: MIN_TERMINAL_HEIGHT,
    storageKey: REVIEWERS_HEIGHT_STORAGE_KEY,
  });
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
  const [removingInvocationId, setRemovingInvocationId] = useState<string | null>(null);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [expandedSkillRoots, setExpandedSkillRoots] = useState<Set<string>>(
    () => new Set(),
  );
  const [reviewerActionsOpen, setReviewerActionsOpen] = useState<string | null>(null);
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
  const [feedbackDeliveryInFlightIds, setFeedbackDeliveryInFlightIds] = useState<Set<string>>(() => new Set());
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [online, setOnline] = useState(() => navigator.onLine);
  const [convergenceRetryNeeded, setConvergenceRetryNeeded] = useState(false);
  const [pendingTerminalRefreshCount, setPendingTerminalRefreshCount] = useState(0);
  const transcriptScrollRef = useRef<HTMLDivElement | null>(null);
  const railTabRefs = useRef(new Map<string, HTMLButtonElement>());
  const reviewerActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const transcriptFollowingRef = useRef(true);
  const transcriptThreadRef = useRef<string | null>(null);
  const feedbackDeliveryInFlightRef = useRef(new Set<string>());
  const autoDeliveryAttemptedRef = useRef(new Set<string>());
  const previousHarnessInputReadyRef = useRef(false);
  const reviewSkillRequestRef = useRef(new Map<string, string>());
  const reviewMessageRequestRef = useRef(new Map<string, string>());
  const messageRequestGenerationRef = useRef(new Map<string, number>());
  const invocationSelectionRestoredRef = useRef(false);
  const reviewScopeRef = useRef("");
  const activeThreadIdRef = useRef<string | null>(activeThreadId);
  const selectedInvocationIdRef = useRef<string | null>(selectedInvocationId);
  const invocationTabsRef = useRef<ReviewSkillInvocationDetail["tabs"]>([]);
  const runEventCursorRef = useRef<{ runId: string | null; afterSeq: number }>({ runId: null, afterSeq: 0 });
  const unselectedInvocationActiveRef = useRef(false);
  const handledTerminalSignaturesRef = useRef(new Set<string>());
  const pendingTerminalRefreshesRef = useRef(new Map<string, { threadId: string; inFlight: Promise<void> | null }>());
  reviewScopeRef.current = `${envSlug}:${sessionId}`;
  activeThreadIdRef.current = activeThreadId;
  selectedInvocationIdRef.current = selectedInvocationId;
  invocationTabsRef.current = invocationDetail?.tabs ?? [];

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

  const beginFeedbackDelivery = useCallback((feedbackId: string): boolean => {
    if (feedbackDeliveryInFlightRef.current.has(feedbackId)) return false;
    feedbackDeliveryInFlightRef.current.add(feedbackId);
    setFeedbackDeliveryInFlightIds(new Set(feedbackDeliveryInFlightRef.current));
    return true;
  }, []);

  const finishFeedbackDelivery = useCallback((feedbackId: string) => {
    feedbackDeliveryInFlightRef.current.delete(feedbackId);
    setFeedbackDeliveryInFlightIds(new Set(feedbackDeliveryInFlightRef.current));
  }, []);

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
  }, [onLayoutChange, reviewersHeight]);

  const topLevelTabs = (state?.tabs ?? []).filter((tab) => tab.nodeKind !== "report");
  const tabs = state?.tabs ?? [];
  useEffect(() => {
    const active = tabs.find((tab) => tab.threadId === activeThreadId);
    if (active?.nodeKind !== "report" || !active.skillRootThreadId) return;
    setExpandedSkillRoots((current) =>
      current.has(active.skillRootThreadId!)
        ? current
        : new Set([...current, active.skillRootThreadId!]),
    );
  }, [activeThreadId, tabs]);
  const railTabs = topLevelTabs.flatMap((tab) => [
    tab,
    ...(tab.nodeKind === "skill_root" && expandedSkillRoots.has(tab.threadId)
      ? tabs.filter(
          (candidate) =>
            candidate.nodeKind === "report" &&
            candidate.skillRootThreadId === tab.threadId,
        )
      : []),
  ]);
  const railKeyboardNodes = railTabs.map((tab) => {
    const reports = tab.nodeKind === "skill_root"
      ? tabs.filter(
          (candidate) =>
            candidate.nodeKind === "report" &&
            candidate.skillRootThreadId === tab.threadId,
        )
      : [];
    return {
      id: tab.threadId,
      ...(tab.nodeKind === "report" && tab.skillRootThreadId
        ? { parentId: tab.skillRootThreadId }
        : {}),
      ...(reports.length > 0
        ? {
            expandable: true,
            expanded: expandedSkillRoots.has(tab.threadId),
            firstChildId: reports[0]!.threadId,
          }
        : {}),
    };
  });
  const activeTab = tabs.find((tab) => tab.threadId === activeThreadId) ?? null;
  const directSkillInvocation =
    invocationDetail?.invocation.definitionSnapshot.agents.length === 1;
  const overviewSelected =
    activeSkillView === "overview" &&
    Boolean(invocationDetail) &&
    !directSkillInvocation;
  const overviewRun = invocationDetail?.runs.find((run) => (
    run.runId === invocationDetail.invocation.overviewRunId
    && run.skillRunRole === "overview"
    && run.preparationOpId === invocationDetail.invocation.preparationOpId
  )) ?? null;
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
  const activeSkillRootThreadId = activeTab?.nodeKind === "report"
    ? activeTab.skillRootThreadId
    : activeTab?.nodeKind === "skill_root"
      ? activeTab.threadId
      : null;
  const listedActiveSkillInvocation = activeSkillRootThreadId
    ? invocationRows.find((row) =>
        row.parentThreadId === activeSkillRootThreadId
        && (row.status === "active" || row.status === "setting_up")
      ) ?? null
    : null;
  const listedDetailInvocation = invocationDetail
    ? invocationRows.find((row) => row.invocationId === invocationDetail.invocation.invocationId) ?? null
    : null;
  const detailActiveSkillInvocation = invocationDetail?.invocation.parentThreadId === activeSkillRootThreadId
    && (invocationDetail.invocation.status === "active" || invocationDetail.invocation.status === "setting_up")
    && (!listedDetailInvocation || isActiveInvocationRow(listedDetailInvocation))
    ? invocationDetail.invocation
    : null;
  const activeSkillInvocation = listedActiveSkillInvocation ?? detailActiveSkillInvocation;
  const activeSkillDetail = invocationDetail?.invocation.invocationId === activeSkillInvocation?.invocationId
    ? invocationDetail
    : null;
  const activeParentLocked = Boolean(
    activeSkillInvocation
    && (
      activeSkillInvocation.status === "setting_up"
      || !activeSkillDetail
      || activeSkillDetail.runs.some((run) => isActiveStatus(run.status))
    )
  );
  const selectedRootHistory = invocationDetail
    ? invocationRows.filter((row) => (
        row.parentThreadId === invocationDetail.invocation.parentThreadId
        && typeof row.invocationId === "string"
      ))
    : [];
  const basisRun = activeRun ?? (overviewSelected
    ? invocationDetail?.runs.find((run) => Boolean(runPreparation(run)?.snapshot)) ?? null
    : null);
  const activeFeedback = useMemo(() => (state?.feedback ?? []).filter((item) => (
    item.threadId === activeTab?.threadId
    && (!overviewSelected || item.metadata.skillInvocationId === invocationDetail?.invocation.invocationId)
  )), [activeTab?.threadId, invocationDetail?.invocation.invocationId, overviewSelected, state?.feedback]);
  const visibleMessages = useMemo(() => {
    if (!overviewSelected || !invocationDetail) return messages;
    const invocationRunIds = new Set(invocationDetail.runs.map((run) => run.runId));
    const invocationFeedbackMessageIds = new Set(activeFeedback.map((feedback) => feedback.messageId));
    return messages.filter((message) => {
      const runId = messageRunId(message);
      return invocationFeedbackMessageIds.has(message.id) || Boolean(runId && invocationRunIds.has(runId));
    });
  }, [activeFeedback, invocationDetail, messages, overviewSelected]);
  const feedbackByMessageId = useMemo(
    () => new Map(activeFeedback.map((feedback) => [feedback.messageId, feedback])),
    [activeFeedback],
  );
  const unmatchedFeedback = useMemo(
    () => activeFeedback.filter((feedback) => !visibleMessages.some((message) => message.id === feedback.messageId)),
    [activeFeedback, visibleMessages],
  );
  const hasActiveRuns = tabs.some((tab) => isActiveStatus(tab.status))
    || (state?.runs ?? []).some((run) => isActiveStatus(run.status))
    || invocationRows.some((row) => row.status === "active" || row.status === "setting_up");
  const commentaryMessages = useMemo(() => runEvents.flatMap((event) => {
    const text = event.message?.trim();
    return event.type === "model_commentary" && text
      ? [{ id: `${event.runId}:${event.seq}`, text }]
      : [];
  }), [runEvents]);
  const latestLiveUpdate = commentaryMessages[commentaryMessages.length - 1]?.text ?? null;

  useEffect(() => {
    if (!documentVisible || !activeTab || !activeReadyRunId) return;
    acknowledgeViewedRun(activeTab.threadId, activeReadyRunId);
  }, [acknowledgeViewedRun, activeReadyRunId, activeTab, documentVisible]);

  useEffect(() => {
    if (!documentVisible || !overviewSelected || !overviewAttentionKey || !overviewResultId) return;
    if (overviewRun?.status !== "ready" && invocationDetail?.invocation.status !== "completed") return;
    acknowledgeViewedRun(overviewAttentionKey, overviewResultId);
  }, [
    acknowledgeViewedRun,
    documentVisible,
    invocationDetail?.invocation.status,
    overviewAttentionKey,
    overviewResultId,
    overviewRun?.status,
    overviewSelected,
  ]);
  const performStateRefresh = useCallback(async (): Promise<EnvReviewState> => {
    const scope = `${envSlug}:${sessionId}`;
    const next = await fetchEnvReviewState(hubUrl, envSlug, sessionId);
    if (reviewScopeRef.current === scope) {
      setState(next);
      setActiveThreadId((current) => (
        current === null
        || next.tabs.some((tab) => tab.threadId === current)
        || invocationTabsRef.current.some((tab) => tab.threadId === current)
          ? current
          : null
      ));
      setError(null);
    }
    return next;
  }, [envSlug, hubUrl, sessionId]);
  const { invalidateAndWait: invalidateState } = useSerializedRefresh(performStateRefresh);

  const loadState = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      await invalidateState();
    } catch (loadError) {
      if (!quiet) {
        setError(loadError instanceof Error ? loadError.message : "Failed to load reviewers");
      }
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [invalidateState]);

  useEffect(() => {
    setState(null);
    setInvocationRows([]);
    setInvocationDetail(null);
    setActiveThreadId(null);
    setSelectedInvocationId(null);
    setActiveSkillView(null);
    setReviewerActionsOpen(null);
    setMessages([]);
    setRunEvents([]);
    invocationTabsRef.current = [];
    feedbackDeliveryInFlightRef.current.clear();
    autoDeliveryAttemptedRef.current.clear();
    reviewSkillRequestRef.current.clear();
    reviewMessageRequestRef.current.clear();
    messageRequestGenerationRef.current.clear();
    handledTerminalSignaturesRef.current.clear();
    pendingTerminalRefreshesRef.current.clear();
    runEventCursorRef.current = { runId: null, afterSeq: 0 };
    unselectedInvocationActiveRef.current = false;
    activeThreadIdRef.current = null;
    selectedInvocationIdRef.current = null;
    setFeedbackDeliveryInFlightIds(new Set());
    setPendingTerminalRefreshCount(0);
    setConvergenceRetryNeeded(false);
    invocationSelectionRestoredRef.current = false;
  }, [envSlug, sessionId]);

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

  const performInvocationRowsRefresh = useCallback(async () => {
    const scope = `${envSlug}:${sessionId}`;
    const result = await fetchReviewSkillInvocations(hubUrl, envSlug, sessionId, { limit: 20 });
    if (reviewScopeRef.current === scope) {
      setInvocationRows((current) => [
        ...result.invocations,
        ...current.filter((row) => !result.invocations.some((fresh) => fresh.invocationId === row.invocationId)),
      ]);
    }
    return result;
  }, [envSlug, hubUrl, sessionId]);
  const { invalidateAndWait: invalidateInvocationRows } = useSerializedRefresh(
    performInvocationRowsRefresh,
  );

  const loadInvocationRows = useCallback(async () => {
    try {
      await invalidateInvocationRows();
    } catch {
      // History restoration is best-effort; ordinary reviewer tabs remain usable.
    }
  }, [invalidateInvocationRows]);

  useEffect(() => {
    if (selectedInvocationId || !activeThreadId) return;
    const active = invocationRows.find(
      (row) => row.parentThreadId === activeThreadId && isActiveInvocationRow(row),
    );
    const latestForParent = !invocationSelectionRestoredRef.current && activeThreadId
      ? invocationRows.find((row) => row.parentThreadId === activeThreadId)
      : null;
    const invocation = active ?? latestForParent;
    if (!invocation || typeof invocation.invocationId !== "string") return;
    invocationSelectionRestoredRef.current = true;
    setSelectedInvocationId(invocation.invocationId);
    setActiveSkillView("overview");
    if (typeof invocation.parentThreadId === "string") setActiveThreadId(invocation.parentThreadId);
  }, [activeThreadId, invocationRows, selectedInvocationId]);

  const selectedInvocationActive = invocationRows.some((row) =>
    row.invocationId === selectedInvocationId
      && (row.status === "active" || row.status === "setting_up")
  );
  const selectedLinkedRunActive = invocationDetail?.invocation.invocationId === selectedInvocationId
    && invocationDetail.runs.some((run) => isActiveStatus(run.status));
  const shouldPollInvocationDetail = selectedInvocationActive || selectedLinkedRunActive;

  const performInvocationDetailRefresh = useCallback(async () => {
    const invocationId = selectedInvocationId;
    if (!invocationId) return null;
    const scope = `${envSlug}:${sessionId}`;
    const detail = await fetchReviewSkillInvocation(hubUrl, envSlug, sessionId, invocationId);
    if (reviewScopeRef.current === scope && selectedInvocationIdRef.current === invocationId) {
      setInvocationDetail(detail);
      setInvocationRows((current) => current.map((row) => row.invocationId === invocationId
        ? !isActiveInvocationRow(row) && isActiveInvocationRow(detail.invocation)
          ? row
          : { ...row, ...detail.invocation }
        : row));
    }
    return detail;
  }, [envSlug, hubUrl, selectedInvocationId, sessionId]);
  const { invalidateAndWait: invalidateInvocationDetail } = useSerializedRefresh(
    performInvocationDetailRefresh,
  );

  useEffect(() => {
    if (!selectedInvocationId) {
      setInvocationDetail(null);
      setActiveSkillView(null);
      return;
    }
    setInvocationDetail((current) => current?.invocation.invocationId === selectedInvocationId ? current : null);
    if (!documentVisible || !online) return;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        await invalidateInvocationDetail();
      } catch {
        // The ordered state/list convergence loop remains the fallback.
      }
      if (!cancelled && shouldPollInvocationDetail) {
        timer = window.setTimeout(() => void poll(), 2_000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    documentVisible,
    invalidateInvocationDetail,
    online,
    selectedInvocationId,
    shouldPollInvocationDetail,
  ]);

  useEffect(() => {
    if (!invocationDetail || invocationDetail.invocation.invocationId !== selectedInvocationId) return;
    const direct = invocationDetail.invocation.definitionSnapshot.agents.length === 1;
    const defaultView = direct ? invocationDetail.invocation.parentThreadId : "overview";
    setActiveSkillView((current) => (!direct && current === "overview") || tabs.some((tab) => tab.threadId === current)
      ? current
      : defaultView);
    if (!direct && activeSkillView === "overview") {
      setActiveThreadId(invocationDetail.invocation.parentThreadId);
    } else if (direct && activeThreadId !== invocationDetail.invocation.parentThreadId) {
      setActiveThreadId(invocationDetail.invocation.parentThreadId);
    }
  }, [activeSkillView, activeThreadId, invocationDetail, selectedInvocationId]);

  useEffect(() => {
    setOverviewGuidance("");
  }, [selectedInvocationId]);

  const performMessageRefresh = useCallback(async () => {
    const threadId = activeTab?.threadId;
    if (!threadId) return [];
    const scope = `${envSlug}:${sessionId}`;
    const generation = (messageRequestGenerationRef.current.get(threadId) ?? 0) + 1;
    messageRequestGenerationRef.current.set(threadId, generation);
    const next = await fetchEnvReviewMessages(hubUrl, envSlug, threadId, sessionId);
    if (
      reviewScopeRef.current === scope
      && activeThreadIdRef.current === threadId
      && messageRequestGenerationRef.current.get(threadId) === generation
    ) setMessages((current) => mergeThreadMessages(current, next));
    return next;
  }, [activeTab?.threadId, envSlug, hubUrl, sessionId]);
  const { invalidateAndWait: invalidateMessages } = useSerializedRefresh(performMessageRefresh);

  useEffect(() => {
    if (!activeTab) {
      setMessages([]);
      return;
    }
    if (!documentVisible || !online) return;
    setMessages([]);
    void invalidateMessages().catch(() => undefined);
  }, [activeTab?.threadId, documentVisible, invalidateMessages, online]);

  const syncPendingTerminalRefreshCount = useCallback(() => {
    setPendingTerminalRefreshCount(pendingTerminalRefreshesRef.current.size);
  }, []);

  const refreshTerminalMessages = useCallback((signature: string, threadId: string): Promise<void> => {
    if (handledTerminalSignaturesRef.current.has(signature)) return Promise.resolve();
    const current = pendingTerminalRefreshesRef.current.get(signature);
    if (current?.inFlight) return current.inFlight;
    const entry = current ?? { threadId, inFlight: null };
    entry.threadId = threadId;
    pendingTerminalRefreshesRef.current.set(signature, entry);
    syncPendingTerminalRefreshCount();
    const scope = `${envSlug}:${sessionId}`;
    const generation = (messageRequestGenerationRef.current.get(threadId) ?? 0) + 1;
    messageRequestGenerationRef.current.set(threadId, generation);
    const request = fetchEnvReviewMessages(hubUrl, envSlug, threadId, sessionId)
      .then((next) => {
        if (reviewScopeRef.current !== scope) return;
        if (
          activeThreadIdRef.current === threadId
          && messageRequestGenerationRef.current.get(threadId) === generation
        ) setMessages((current) => mergeThreadMessages(current, next));
        handledTerminalSignaturesRef.current.add(signature);
        pendingTerminalRefreshesRef.current.delete(signature);
      })
      .catch((refreshError) => {
        if (reviewScopeRef.current === scope) entry.inFlight = null;
        throw refreshError;
      })
      .finally(() => {
        if (reviewScopeRef.current === scope) syncPendingTerminalRefreshCount();
      });
    entry.inFlight = request;
    return request;
  }, [envSlug, hubUrl, sessionId, syncPendingTerminalRefreshCount]);

  const performConvergenceRefresh = useCallback(async () => {
    let firstError: unknown = null;
    try {
      // The list must settle first: it owns active -> terminal observation.
      await invalidateInvocationRows();
    } catch (refreshError) {
      firstError = refreshError;
    }
    try {
      // This drain is deliberately second so generated feedback cannot be missed.
      await invalidateState();
    } catch (refreshError) {
      firstError ??= refreshError;
    }
    if (documentVisible) {
      for (const [signature, pending] of pendingTerminalRefreshesRef.current) {
        try {
          await refreshTerminalMessages(signature, pending.threadId);
        } catch (refreshError) {
          firstError ??= refreshError;
        }
      }
    }
    setConvergenceRetryNeeded(Boolean(firstError));
    if (firstError) throw firstError;
  }, [documentVisible, invalidateInvocationRows, invalidateState, refreshTerminalMessages]);
  const { invalidateAndWait: invalidateConvergence } = useSerializedRefresh(
    performConvergenceRefresh,
  );

  useEffect(() => {
    void loadReviewSkills();
  }, [loadReviewSkills]);

  useEffect(() => {
    setLoading(true);
    void invalidateConvergence()
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : "Failed to load reviewers");
      })
      .finally(() => setLoading(false));
  }, [envSlug, invalidateConvergence, sessionId]);

  const selectedRunActive = Boolean(activeRun && isActiveStatus(activeRun.status));
  const selectedOwnerActive = shouldPollInvocationDetail || selectedRunActive;
  const hasUnselectedActiveInvocation = invocationRows.some((row) => (
    row.invocationId !== selectedInvocationId
      && (row.status === "active" || row.status === "setting_up")
  ));
  const convergenceDrainNeeded = convergenceRetryNeeded || pendingTerminalRefreshCount > 0;

  useEffect(() => {
    const wasActive = unselectedInvocationActiveRef.current;
    unselectedInvocationActiveRef.current = hasUnselectedActiveInvocation;
    if (
      wasActive
      && !hasUnselectedActiveInvocation
      && documentVisible
      && online
    ) {
      void invalidateState().catch(() => setConvergenceRetryNeeded(true));
    }
  }, [documentVisible, hasUnselectedActiveInvocation, invalidateState, online]);

  useEffect(() => {
    if (!online) return;
    const presentationHidden = !documentVisible;
    if (presentationHidden && !hasActiveRuns) return;
    if (!presentationHidden && !convergenceDrainNeeded && !hasActiveRuns) return;
    if (
      !presentationHidden
      && !convergenceDrainNeeded
      && selectedOwnerActive
      && !hasUnselectedActiveInvocation
    ) return;

    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        if (presentationHidden) {
          await invalidateState();
        } else if (convergenceDrainNeeded || !selectedOwnerActive) {
          if (hasUnselectedActiveInvocation || convergenceDrainNeeded) {
            await invalidateConvergence();
          } else {
            await invalidateState();
          }
        } else {
          await invalidateInvocationRows();
        }
      } catch {
        // The applicable owner remains eligible on its next serialized tick.
      }
      if (!cancelled) {
        const delay = presentationHidden ? 10_000 : selectedOwnerActive ? 5_000 : 2_000;
        timer = window.setTimeout(() => void poll(), delay);
      }
    };
    if (presentationHidden) timer = window.setTimeout(() => void poll(), 10_000);
    else void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [
    convergenceDrainNeeded,
    documentVisible,
    hasActiveRuns,
    hasUnselectedActiveInvocation,
    invalidateConvergence,
    invalidateInvocationRows,
    invalidateState,
    online,
    selectedOwnerActive,
  ]);

  const invocationTerminalSignature = invocationDetail
    && invocationDetail.invocation.invocationId === selectedInvocationId
    && invocationDetail.invocation.status !== "active"
    && invocationDetail.invocation.status !== "setting_up"
    ? `invocation:${invocationDetail.invocation.invocationId}:${invocationDetail.invocation.status}:${invocationDetail.invocation.updatedAt}`
    : null;
  const invocationTerminalThreadId = invocationTerminalSignature
    ? invocationDetail?.invocation.parentThreadId ?? null
    : null;
  useEffect(() => {
    if (
      !documentVisible
      || !online
      || !invocationTerminalSignature
      || !invocationTerminalThreadId
    ) return;
    void refreshTerminalMessages(invocationTerminalSignature, invocationTerminalThreadId)
      .then(() => invalidateConvergence())
      .catch(() => {
        setConvergenceRetryNeeded(true);
      });
  }, [
    documentVisible,
    invalidateConvergence,
    invocationTerminalSignature,
    invocationTerminalThreadId,
    online,
    refreshTerminalMessages,
  ]);

  useEffect(() => {
    if (!activeRun) {
      setRunEvents([]);
      runEventCursorRef.current = { runId: null, afterSeq: 0 };
      return;
    }
    if (runEventCursorRef.current.runId !== activeRun.runId) {
      runEventCursorRef.current = { runId: activeRun.runId, afterSeq: 0 };
      setRunEvents([]);
    }
    if (!isActiveStatus(activeRun.status)) return;
    if (!documentVisible || !online) return;
    const scope = `${envSlug}:${sessionId}`;
    const runId = activeRun.runId;
    let cancelled = false;
    let timer: number | null = null;
    let requestController: AbortController | null = null;
    const poll = async () => {
      let keepPolling = isActiveStatus(activeRun.status);
      try {
        requestController = new AbortController();
        const result = await fetchEnvReviewRun(
          hubUrl,
          envSlug,
          runId,
          sessionId,
          runEventCursorRef.current.runId === runId ? runEventCursorRef.current.afterSeq : 0,
          requestController.signal,
        );
        if (cancelled || reviewScopeRef.current !== scope || result.run.runId !== runId) return;
        const maxSeq = result.events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
        if (runEventCursorRef.current.runId === runId) {
          runEventCursorRef.current.afterSeq = Math.max(runEventCursorRef.current.afterSeq, maxSeq);
        }
        setRunEvents((current) => {
          const merged = new Map(current.map((event) => [`${event.runId}:${event.seq}`, event]));
          for (const event of result.events) {
            if (event.type === "model_commentary" && event.message?.trim()) {
              merged.set(`${event.runId}:${event.seq}`, event);
            }
          }
          return [...merged.values()].sort((left, right) => left.seq - right.seq);
        });
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
        keepPolling = isActiveStatus(result.run.status);
        if (!keepPolling) {
          const terminalSignature = `run:${result.run.runId}:${result.run.status}:${result.run.completedAt ?? result.run.error ?? ""}`;
          try {
            await refreshTerminalMessages(terminalSignature, result.run.threadId);
            await invalidateConvergence();
          } catch {
            setConvergenceRetryNeeded(true);
          }
        }
      } catch {
        // The visible run probe retries while its last known state is active.
      } finally {
        requestController = null;
      }
      if (!cancelled && keepPolling) timer = window.setTimeout(() => void poll(), 3_000);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController?.abort();
    };
  }, [
    activeRun?.runId,
    activeRun?.status,
    documentVisible,
    envSlug,
    hubUrl,
    invalidateConvergence,
    online,
    refreshTerminalMessages,
    sessionId,
  ]);

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
  }, [activeRun?.status, activeTab?.threadId, commentaryMessages.length, latestLiveUpdate, unmatchedFeedback.length, visibleMessages.length]);

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

  const selectRailTab = useCallback(
    (tab: EnvReviewTab) => {
      setActiveThreadId(tab.threadId);
      invocationSelectionRestoredRef.current = true;
      const rootThreadId =
        tab.nodeKind === "report"
          ? tab.skillRootThreadId
          : tab.nodeKind === "skill_root"
            ? tab.threadId
            : null;
      if (!rootThreadId) {
        setSelectedInvocationId(null);
        setActiveSkillView(null);
        return;
      }
      const linked = invocationRows.find(
        (row) =>
          row.parentThreadId === rootThreadId && isActiveInvocationRow(row),
      ) ?? invocationRows.find((row) => row.parentThreadId === rootThreadId);
      const invocationId =
        typeof linked?.invocationId === "string" ? linked.invocationId : null;
      if (!invocationId) {
        setSelectedInvocationId(null);
        setActiveSkillView(null);
        return;
      }
      setSelectedInvocationId(invocationId);
      setActiveSkillView(
        tab.nodeKind === "report"
          ? tab.threadId
          : linked?.agentCount === 1
            ? rootThreadId
            : "overview",
      );
    },
    [invocationRows],
  );

  const handleRailKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    tab: EnvReviewTab,
  ) => {
    const action = resolveReviewerRailKeyboardAction(
      event.key,
      tab.threadId,
      railKeyboardNodes,
    );
    if (!action) return;
    event.preventDefault();
    if (action.kind === "expand" || action.kind === "collapse") {
      setExpandedSkillRoots((current) => {
        const next = new Set(current);
        if (action.kind === "expand") next.add(action.id);
        else next.delete(action.id);
        return next;
      });
      return;
    }
    const nextTab = tabs.find((candidate) => candidate.threadId === action.id);
    if (!nextTab) return;
    selectRailTab(nextTab);
    railTabRefs.current.get(nextTab.threadId)?.focus();
  };

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

  const cancelSkillInvocation = useCallback(async (invocationId: string) => {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const cancelled = await cancelReviewSkillInvocation(
        hubUrl,
        envSlug,
        invocationId,
        sessionId,
      );
      setInvocationDetail((current) => current?.invocation.invocationId === invocationId
        ? { ...current, invocation: cancelled }
        : current);
      setInvocationRows((current) => current.map((row) => row.invocationId === invocationId
        ? { ...row, ...cancelled }
        : row));
      await Promise.all([loadState(true), loadInvocationRows()]);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to stop review");
    } finally {
      setLoading(false);
    }
  }, [envSlug, hubUrl, loadInvocationRows, loadState, loading, sessionId]);

  const sendReviewerChatMessage = useCallback(async (text: string): Promise<boolean> => {
    if ((activeTab && isActiveStatus(activeTab.status)) || sendingMessage) return false;
    const actionKey = activeTab ? null : text;
    const requestId = actionKey
      ? reviewMessageRequestRef.current.get(actionKey) ?? crypto.randomUUID()
      : null;
    if (actionKey && requestId) reviewMessageRequestRef.current.set(actionKey, requestId);
    setSendingMessage(true);
    setError(null);
    try {
      const result = await sendEnvReviewMessage(hubUrl, envSlug, activeTab?.threadId ?? null, {
        sessionId,
        text,
        ...(requestId ? { requestId } : {}),
        ...(activeTab?.nodeKind !== "generic" &&
        (invocationDetail?.invocation.invocationId ?? activeTab?.skillInvocationId)
          ? {
              expectedRoundId:
                invocationDetail?.invocation.invocationId ??
                activeTab!.skillInvocationId!,
            }
          : {}),
      });
      if (actionKey) reviewMessageRequestRef.current.delete(actionKey);
      const resultThreadId = result.run?.threadId ?? activeTab?.threadId ?? null;
      if (resultThreadId) {
        messageRequestGenerationRef.current.set(
          resultThreadId,
          (messageRequestGenerationRef.current.get(resultThreadId) ?? 0) + 1,
        );
      }
      setState(result.state);
      setMessages((current) => mergeThreadMessages(current, result.messages));
      setRunEvents([]);
      if (result.run) {
        setActiveThreadId(result.run.threadId);
        if (activeTab?.skillInvocationId) {
          setInvocationDetail((current) => current ? {
            ...current,
            runs: [...current.runs.filter((run) => run.runId !== result.run!.runId), result.run!],
            tabs: current.tabs.map((tab) => tab.threadId === result.run!.threadId
              ? { ...tab, latestRunId: result.run!.runId, status: tabStatusForRunStatus(result.run!.status) }
              : tab),
          } : current);
        }
      }
      if (overviewSelected) {
        invocationSelectionRestoredRef.current = true;
        setSelectedInvocationId(null);
        setActiveSkillView(null);
      }
      return true;
    } catch (error) {
      if (actionKey && error instanceof ApiActionError && error.code !== "message_setup_incomplete") {
        reviewMessageRequestRef.current.delete(actionKey);
      }
      setError(error instanceof Error ? error.message : "Failed to send reviewer message");
      void loadState(true);
      return false;
    } finally {
      setSendingMessage(false);
    }
  }, [activeTab, envSlug, hubUrl, loadState, overviewSelected, sendingMessage, sessionId]);

  const invokeSkill = useCallback(async (skill: AgentSkillDefinition) => {
    if (invokingSkillId) return false;
    const actionKey = `root:${skill.id}`;
    const requestId = reviewSkillRequestRef.current.get(actionKey) ?? crypto.randomUUID();
    reviewSkillRequestRef.current.set(actionKey, requestId);
    setInvokingSkillId(skill.id);
    setError(null);
    try {
      const result = await invokeReviewSkill(hubUrl, envSlug, skill.id, {
        sessionId,
        requestId,
        overviewMode: skill.overviewMode,
      });
      reviewSkillRequestRef.current.delete(actionKey);
      invocationSelectionRestoredRef.current = true;
      invocationTabsRef.current = result.tabs;
      setSelectedInvocationId(result.invocation.invocationId);
      setInvocationDetail(result);
      const directThreadId = result.invocation.definitionSnapshot.agents.length === 1
        ? result.invocation.parentThreadId
        : null;
      setActiveSkillView(directThreadId ?? "overview");
      setActiveThreadId(directThreadId ?? result.invocation.parentThreadId);
      await loadState(true);
      await loadInvocationRows();
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
  }, [envSlug, hubUrl, invokingSkillId, loadInvocationRows, loadState, sessionId]);

  const rerunSkill = useCallback(async (detail: ReviewSkillInvocationDetail) => {
    if (invokingSkillId) return false;
    const actionKey = `rerun:${detail.invocation.invocationId}`;
    const requestId = reviewSkillRequestRef.current.get(actionKey) ?? crypto.randomUUID();
    reviewSkillRequestRef.current.set(actionKey, requestId);
    setInvokingSkillId(detail.invocation.definitionSnapshot.id);
    setError(null);
    try {
      const result = await rerunReviewSkillInvocation(
        hubUrl,
        envSlug,
        detail.invocation.invocationId,
        { sessionId, requestId },
      );
      reviewSkillRequestRef.current.delete(actionKey);
      invocationSelectionRestoredRef.current = true;
      invocationTabsRef.current = result.tabs;
      setSelectedInvocationId(result.invocation.invocationId);
      setInvocationDetail(result);
      const directThreadId = result.invocation.definitionSnapshot.agents.length === 1
        ? result.invocation.parentThreadId
        : null;
      setActiveSkillView(directThreadId ?? "overview");
      setActiveThreadId(directThreadId ?? result.invocation.parentThreadId);
      await loadState(true);
      await loadInvocationRows();
      return true;
    } catch (error) {
      if (error instanceof ApiActionError && error.code !== "skill_setup_incomplete") {
        reviewSkillRequestRef.current.delete(actionKey);
      }
      setError(error instanceof Error ? error.message : "Failed to re-review changes");
      return false;
    } finally {
      setInvokingSkillId(null);
    }
  }, [envSlug, hubUrl, invokingSkillId, loadInvocationRows, loadState, sessionId]);

  const removeSkillRound = useCallback(async (detail: ReviewSkillInvocationDetail) => {
    const invocationId = detail.invocation.invocationId;
    const parentThreadId = detail.invocation.parentThreadId;
    if (removingInvocationId || invokingSkillId) return false;
    setRemovingInvocationId(invocationId);
    setError(null);
    try {
      const result = await removeReviewSkillInvocation(
        hubUrl,
        envSlug,
        invocationId,
        sessionId,
      );
      invocationSelectionRestoredRef.current = true;
      setSelectedInvocationId(null);
      setInvocationDetail(null);
      setActiveSkillView(null);
      setActiveThreadId(result.state.tabs.find((tab) => tab.nodeKind !== "report")?.threadId ?? null);
      setState(result.state);
      setRunEvents([]);
      setInvocationRows((current) => current.filter((row) => row.parentThreadId !== parentThreadId));
      await loadInvocationRows();
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to remove review round");
      return false;
    } finally {
      setRemovingInvocationId(null);
    }
  }, [envSlug, hubUrl, invokingSkillId, loadInvocationRows, removingInvocationId, sessionId]);

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
      void loadInvocationRows();
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
      void loadInvocationRows();
      void loadState(true);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to send Manual Overview");
    }
  }, [envSlug, hubUrl, invocationDetail, loadInvocationRows, loadState, overviewGuidance, sessionId]);

  const sendFeedback = useCallback(async (
    feedback: EnvReviewFeedback,
    text: string,
    formatted: boolean,
  ) => {
    if (!beginFeedbackDelivery(feedback.feedbackId)) return;
    const delivered = feedback.status === "pending"
      ? feedback.deliveredText ?? text
      : formatted
        ? text
        : formatFeedbackForHarness(feedback, text);
    setSendError(null);
    try {
      if (feedback.status === "ready") {
        await markEnvReviewFeedback(hubUrl, envSlug, feedback.feedbackId, "pending", {
          sessionId,
          deliveredText: delivered,
        });
      }
      const sent = await onSendToHarness(delivered, feedback.feedbackId);
      if (!sent.ok) {
        setSendError(sent.error || "Harness did not acknowledge feedback");
        return;
      }
      await markEnvReviewFeedback(hubUrl, envSlug, feedback.feedbackId, "sent", {
        sessionId,
        deliveredText: delivered,
      });
      setPreview((current) => current?.feedback.feedbackId === feedback.feedbackId ? null : current);
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send feedback");
    } finally {
      await loadState(true);
      finishFeedbackDelivery(feedback.feedbackId);
    }
  }, [
    beginFeedbackDelivery,
    envSlug,
    finishFeedbackDelivery,
    hubUrl,
    loadState,
    onSendToHarness,
    sessionId,
  ]);

  useEffect(() => {
    if (harnessInputReady && !previousHarnessInputReadyRef.current) {
      autoDeliveryAttemptedRef.current.clear();
    }
    previousHarnessInputReadyRef.current = harnessInputReady;
  }, [harnessInputReady]);

  useEffect(() => {
    if (!state || !harnessInputReady) return;
    for (const feedback of state.feedback) {
      if (
        (feedback.status !== "ready" && feedback.status !== "pending")
        || feedback.metadata.overviewMode !== "auto"
        || !feedback.metadata.skillInvocationId
        || autoDeliveryAttemptedRef.current.has(
          `${feedback.feedbackId}:${feedback.status}`,
        )
      ) continue;
      autoDeliveryAttemptedRef.current.add(
        `${feedback.feedbackId}:${feedback.status}`,
      );
      void sendFeedback(feedback, feedback.text, false);
    }
  }, [harnessInputReady, sendFeedback, state]);

  const confirmSend = useCallback(async () => {
    if (!preview) return;
    await sendFeedback(preview.feedback, preview.text, preview.formatted);
  }, [preview, sendFeedback]);

  const renderFeedbackActions = (feedback: EnvReviewFeedback) => {
    const deliveryInFlight = feedbackDeliveryInFlightIds.has(feedback.feedbackId);
    const deliverable = feedback.status === "ready" || feedback.status === "pending";
    return <div className="mt-2 flex flex-wrap items-center gap-2">
      <span className="text-[10px] uppercase text-kumo-subtle">{feedback.status}</span>
      <button
        type="button"
        aria-label="Send review feedback"
        onClick={() => void sendFeedback(
          feedback,
          feedback.deliveredText ?? feedback.text,
          Boolean(feedback.deliveredText),
        )}
        disabled={!deliverable || !harnessInputReady || deliveryInFlight}
        className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
      >
        {deliveryInFlight ? "Sending…" : feedback.status === "pending" ? "Retry delivery" : "Send"}
      </button>
      <button
        type="button"
        onClick={() => setPreview({ feedback, text: feedback.text, formatted: false })}
        disabled={feedback.status !== "ready" || deliveryInFlight}
        className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
      >
        Edit & Send
      </button>
      {!harnessInputReady && feedback.status === "pending" && (
        <span className="text-xs text-kumo-subtle">Harness input unavailable.</span>
      )}
    </div>;
  };
  const activeRunLabel = activeRun?.status === "preparing"
    ? "Preparing review snapshot..."
    : activeRun?.status === "queued"
      ? "Reviewer queued..."
      : activeRun?.status === "running"
        ? "Reviewer is working..."
        : null;
  const composerDisabled = loading
    || sendingMessage
    || Boolean(activeTab && isActiveStatus(activeTab.status))
    || activeParentLocked;
  const composerPlaceholder = overviewSelected
    ? activeParentLocked ? "Overview is collecting reports..." : "Message Overview"
    : !activeTab
    ? "Ask for a review or type / for Review skills"
    : isActiveStatus(activeTab.status) || activeParentLocked
      ? "Reviewer is working..."
      : activeTab.skillInvocationId
        ? `Follow up with ${activeTab.roleLabel}`
        : "Message this reviewer or type / for skills";
  const headerRouteSummary = activeRun
    ? `${formatModelLabel(providers, activeRun.provider, activeRun.model)} · ${formatEffortLabel(providers, activeRun.provider, activeRun.effort)} effort`
    : null;
  const headerBasisSummary = basisRun && runPreparation(basisRun)?.snapshot
    ? formatReviewBasisSummary(basisRun)
    : null;
  const headerSummary = [headerRouteSummary, headerBasisSummary].filter(Boolean).join(" · ")
    || "Choose a reviewer or start from the composer";
  const headerBasisTitle = basisRun && runPreparation(basisRun)?.snapshot
    ? formatReviewBasis(runPreparation(basisRun)!.snapshot!)
    : undefined;

  return (
    <>
      <BottomPaneResizeHandle
        label="Resize terminal and Review"
        value={reviewersHeight ?? DEFAULT_REVIEWERS_HEIGHT}
        onKeyDown={resizeWithKeyboard}
        onPointerDown={startResize}
      />
      <div
        ref={reviewersPaneRef}
        data-testid="env-review-panel"
        className="tiller-reviewer-surface flex shrink-0 flex-col bg-kumo-base"
        style={{ height: reviewersHeight ?? DEFAULT_REVIEWERS_HEIGHT }}
        role="region"
        aria-label="Review"
      >
      <div className="flex min-h-12 items-center justify-between gap-3 border-b border-kumo-line px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-semibold text-kumo-default">
              {overviewSelected
                ? `${invocationDetail?.invocation.definitionSnapshot.label ?? "Skill"} Overview`
                : activeTab?.roleLabel ?? "Implementation Review"}
            </div>
            <div className="truncate text-[10px] text-kumo-subtle" title={headerBasisTitle}>
              {headerSummary}
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {selectedRootHistory.length > 1 && (
            <select
              aria-label="Implementation Review round history"
              className="max-w-56 rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs"
              value={selectedInvocationId ?? ""}
              onChange={(event) => {
                setSelectedInvocationId(event.target.value);
                setActiveSkillView("overview");
              }}
            >
              {selectedRootHistory.map((row) => (
                <option key={String(row.invocationId)} value={String(row.invocationId)}>
                  {String(row.status ?? "round")}
                  {typeof row.createdAt === "string"
                    ? ` · ${new Date(row.createdAt).toLocaleString()}`
                    : ""}
                </option>
              ))}
            </select>
          )}
          {invocationDetail &&
            ["completed", "failed", "cancelled"].includes(
              invocationDetail.invocation.status,
            ) && (
              <button
                type="button"
                onClick={() => void rerunSkill(invocationDetail)}
                disabled={Boolean(invokingSkillId) || Boolean(removingInvocationId)}
                className="rounded border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
              >
                Re-review changes
              </button>
            )}
        </div>
      </div>

      {error && <div className="border-b border-kumo-line px-3 py-2 text-xs text-kumo-danger">{error}</div>}
      {sendError && <div className="border-b border-kumo-line px-3 py-2 text-xs text-kumo-danger">{sendError}</div>}

      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_224px] overflow-hidden">
        <main className="flex min-h-0 min-w-0 flex-col overflow-hidden">
          <div
            ref={transcriptScrollRef}
            aria-label="Implementor reviewer conversation"
            className="tiller-reviewer-transcript min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 pb-6"
            onScroll={(event) => {
              const transcript = event.currentTarget;
              transcriptFollowingRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
                <= TRANSCRIPT_BOTTOM_THRESHOLD;
            }}
          >
            {!activeTab ? (
              <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
                Ask a code-aware question or type / to run a Review skill.
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
                {visibleMessages.length === 0 && !activeRun && !overviewSelected && (
                  <div className="py-8 text-center text-sm text-kumo-subtle">
                    Run a review or ask this reviewer a code-aware question.
                  </div>
                )}
                {visibleMessages.map((message) => {
                  const role = messageRole(message);
                  const text = messageText(message);
                  const feedback = feedbackByMessageId.get(message.id) ?? null;
                  const reportRun = invocationDetail?.runs.find((run) => run.runId === messageRunId(message));
                  const overviewEligible = role === "assistant"
                    && reportRun?.threadId === activeTab?.threadId
                    && reportRun.status === "ready"
                    && reportRun.preparationOpId === invocationDetail?.invocation.preparationOpId
                    && (reportRun.skillRunRole === "report_initial" || reportRun.skillRunRole === "report_followup");
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
                          && !directSkillInvocation
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
                {(activeRunLabel || activeParentLocked) && (
                  <div className="flex justify-start" data-testid="reviewer-run-status">
                    <div className="max-w-[80%] rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
                      <div className="flex items-center justify-between gap-3">
                        <span className="animate-pulse">
                          {activeParentLocked ? "Reviewers are working…" : activeRunLabel}
                        </span>
                        <button
                          type="button"
                          aria-label="Stop review"
                          title="Stop review"
                          disabled={loading || (activeSkillRootThreadId ? !activeSkillInvocation : !activeRun)}
                          onClick={() => {
                            const invocationId = activeSkillInvocation?.invocationId;
                            if (typeof invocationId === "string") void cancelSkillInvocation(invocationId);
                            else if (!activeSkillRootThreadId && activeRun) void cancelRun(activeRun);
                          }}
                          className="grid size-7 shrink-0 place-items-center border border-kumo-line bg-kumo-base text-kumo-default hover:bg-kumo-tint disabled:opacity-50"
                        >
                          <StopIcon aria-hidden="true" size={13} weight="fill" />
                        </button>
                      </div>
                      <ReviewerActivityDetails messages={commentaryMessages} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
          <div className="min-h-[57px] bg-kumo-base">
            <PlanChatInput
              disabled={composerDisabled}
              placeholder={composerPlaceholder}
              onSend={(message) => sendReviewerChatMessage(message)}
              skills={!overviewSelected && !activeTab?.skillInvocationId ? reviewSkills : []}
              onInvokeSkill={!overviewSelected && !activeTab?.skillInvocationId ? invokeSkill : undefined}
              compact
              showSkillTrigger
            />
          </div>
        </main>
        <aside className="tiller-agent-switcher tiller-implementation-reviewer-switcher flex min-h-0 flex-col border-l border-kumo-line bg-kumo-base" aria-label="Reviewers">
          <div className="tiller-agent-switcher-header tiller-workspace-sidebar-header flex h-12 shrink-0 items-center gap-1 border-b border-kumo-line px-3">
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-kumo-default">
              Reviewers
            </span>
            <button
              type="button"
              aria-label="Reviewer skill settings"
              onClick={() => setSkillsOpen(true)}
              className="flex size-8 items-center justify-center text-xs text-kumo-default hover:bg-kumo-tint"
            >
              <GearSixIcon className="size-3.5" weight="bold" aria-hidden="true" />
            </button>
            <AddReviewerMenu
              activeReviewerCount={topLevelTabs.filter((tab) => tab.nodeKind === "generic").length}
              providers={providers}
              disabled={loading}
              compact
              iconOnly
              onAdd={(input) => void addReviewer(input)}
              skills={reviewSkills}
              onInvokeSkill={(skill) => void invokeSkill(skill)}
            />
          </div>
          <div
            role="tree"
            aria-label="Reviewer conversations"
            className="tiller-agent-card-stack grid min-h-0 flex-1 content-start gap-0 overflow-y-auto p-2"
          >
            {railTabs.map((tab) => {
              const active = activeTab?.threadId === tab.threadId;
              const hasReports = tab.nodeKind === "skill_root" && tabs.some(
                (candidate) =>
                  candidate.nodeKind === "report" &&
                  candidate.skillRootThreadId === tab.threadId,
              );
              const latestRun = runForTab(combinedState, tab);
              const activeInvocation = active && tab.nodeKind === "skill_root"
                ? activeSkillInvocation
                : null;
              const rootDetail = active && invocationDetail?.invocation.parentThreadId === tab.threadId
                ? invocationDetail
                : null;
              const rowWorking = tab.nodeKind === "skill_root"
                ? Boolean(activeInvocation)
                : Boolean(latestRun && isActiveStatus(latestRun.status));
              const rowActionLabel = rowWorking
                ? tab.nodeKind === "skill_root" ? "Stop review" : "Stop reviewer"
                : tab.nodeKind === "skill_root" ? "Remove review" : "Remove reviewer";
              const rowActionDisabled = loading
                || (tab.nodeKind === "skill_root"
                  ? rowWorking
                    ? typeof activeInvocation?.invocationId !== "string"
                    : !rootDetail
                  : rowWorking && !latestRun);
              const performRowAction = () => {
                setReviewerActionsOpen(null);
                if (tab.nodeKind === "skill_root") {
                  if (rowWorking && typeof activeInvocation?.invocationId === "string") {
                    void cancelSkillInvocation(activeInvocation.invocationId);
                  } else if (rootDetail) {
                    void removeSkillRound(rootDetail);
                  }
                } else if (tab.nodeKind === "generic") {
                  if (rowWorking && latestRun) void cancelRun(latestRun);
                  else void removeTab(tab.threadId);
                }
              };
              const status = tab.nodeKind === "skill_root" && overviewSelected && active
                ? overviewTabStatus
                : envReviewTabStatus({
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
                  });
              return (
                <Popover
                  key={tab.threadId}
                  open={reviewerActionsOpen === tab.threadId}
                  onOpenChange={(open) => setReviewerActionsOpen(open ? tab.threadId : null)}
                >
                  <div
                    role="presentation"
                    className={`tiller-plan-agent-list-item flex h-11 min-w-0 items-stretch ${tab.nodeKind === "report" ? "tiller-plan-agent-list-item--report pl-4" : ""} ${active ? "tiller-plan-agent-row-selected" : ""}`}
                    title={`${formatModelLabel(providers, tab.provider, tab.model)} · ${formatEffortLabel(providers, tab.provider, tab.effort)} effort`}
                  >
                    {hasReports && (
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-label={`${expandedSkillRoots.has(tab.threadId) ? "Collapse" : "Expand"} ${tab.roleLabel} Reports`}
                      className="flex w-6 shrink-0 items-center justify-center text-kumo-subtle hover:text-kumo-default"
                      onClick={() =>
                        setExpandedSkillRoots((current) => {
                          const next = new Set(current);
                          if (next.has(tab.threadId)) next.delete(tab.threadId);
                          else next.add(tab.threadId);
                          return next;
                        })
                      }
                    >
                      <CaretRightIcon
                        className={`size-3 transition-transform ${expandedSkillRoots.has(tab.threadId) ? "rotate-90" : ""}`}
                        weight="bold"
                        aria-hidden="true"
                      />
                    </button>
                    )}
                    <button
                    type="button"
                    ref={(node) => {
                      if (node) railTabRefs.current.set(tab.threadId, node);
                      else railTabRefs.current.delete(tab.threadId);
                    }}
                    role="treeitem"
                    aria-label={tab.roleLabel}
                    aria-description={`${status.label}. ${status.detail}`}
                    aria-level={tab.nodeKind === "report" ? 2 : 1}
                    aria-expanded={hasReports ? expandedSkillRoots.has(tab.threadId) : undefined}
                    aria-current={active ? "page" : undefined}
                    tabIndex={active || (!activeThreadId && railTabs[0]?.threadId === tab.threadId) ? 0 : -1}
                    className="tiller-plan-agent-row flex min-w-0 flex-1 items-center gap-2 px-3 text-left text-xs text-kumo-default hover:bg-kumo-tint"
                    onClick={() => selectRailTab(tab)}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Delete" &&
                        active &&
                        tab.nodeKind !== "report" &&
                        !rowActionDisabled
                      ) {
                        event.preventDefault();
                        performRowAction();
                        return;
                      }
                      handleRailKeyDown(event, tab);
                    }}
                  >
                      <AgentTabStatusIndicator status={status} card />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{tab.roleLabel}</span>
                      <span className="tiller-workspace-sidebar-meta shrink-0 truncate text-[10px] text-kumo-subtle">
                        {status.label}
                      </span>
                    </button>
                    {active && tab.nodeKind !== "report" && (
                      <button
                        ref={(node) => {
                          if (node) reviewerActionRefs.current.set(tab.threadId, node);
                          else reviewerActionRefs.current.delete(tab.threadId);
                        }}
                        type="button"
                        tabIndex={-1}
                        aria-label={`Actions for ${tab.roleLabel}`}
                        aria-expanded={reviewerActionsOpen === tab.threadId}
                        onClick={() => setReviewerActionsOpen((current) => (
                          current === tab.threadId ? null : tab.threadId
                        ))}
                        className="tiller-plan-agent-action flex h-11 w-10 shrink-0 items-center justify-center text-current hover:bg-white/10"
                      >
                        <DotsThreeIcon className="size-4" weight="bold" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                  {active && tab.nodeKind !== "report" && (
                    <Popover.Content
                      anchor={reviewerActionRefs.current.get(tab.threadId) ?? null}
                      side="left"
                      align="start"
                      sideOffset={6}
                      positionMethod="fixed"
                      className="w-44 p-1"
                    >
                      <div className="tiller-plan-agent-actions-menu" role="menu" aria-label={`${tab.roleLabel} actions`}>
                        <button
                          type="button"
                          role="menuitem"
                          disabled={rowActionDisabled}
                          onClick={performRowAction}
                          className="flex w-full px-2 py-1.5 text-left text-[13px] text-kumo-danger hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {rowActionLabel}
                        </button>
                      </div>
                    </Popover.Content>
                  )}
                </Popover>
              );
            })}
          </div>
        </aside>
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
                disabled={feedbackDeliveryInFlightIds.has(preview.feedback.feedbackId)}
                className="h-72 w-full resize-none rounded border border-kumo-line bg-kumo-base p-3 font-mono text-xs text-kumo-default"
              />
            </div>
            <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
              <button
                type="button"
                onClick={() => setPreview(null)}
                disabled={feedbackDeliveryInFlightIds.has(preview.feedback.feedbackId)}
                className="rounded border border-kumo-line px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void confirmSend()}
                disabled={
                  !harnessInputReady
                  || !preview.text.trim()
                  || feedbackDeliveryInFlightIds.has(preview.feedback.feedbackId)
                }
                className="rounded bg-kumo-brand px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
              >
                {feedbackDeliveryInFlightIds.has(preview.feedback.feedbackId) ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}
      </div>
    </>
  );
}
