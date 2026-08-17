import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Dialog } from "@cloudflare/kumo/components/dialog";
import {
  fetchLatestPlannerRun,
  fetchLatestPlanSkillInvocation,
  fetchPlannerRun,
  fetchReviewerMessages,
  sendReviewerMessage,
  type AgentSkillDefinition,
  type PlanSkillInvokeResult,
  type PlanSkillInvocationDetail,
  type PlannerRun,
  type PlannerRunEvent,
  type ThreadMessage,
} from "./api";
import type { PlannerRunStatus, ReviewerRunAttribution } from "../api/coordination/types";
import LoadingIndicator from "./LoadingIndicator";
import { codexAuthModeLabel } from "./codex-auth-ui";
import PlanChatInput from "./PlanChatInput";
import { useSerializedRefresh } from "./useSerializedRefresh";
import PlanSkillFanout from "./PlanSkillFanout";
import MarkdownContent from "./MarkdownContent";
import ResizableAgentBar from "./ResizableAgentBar";
import { PLAN_AGENT_LABEL } from "./plan-agent-copy";
import {
  ReviewerResponseActions,
  ReviewerTranscriptMessage,
} from "./ReviewerTranscriptMessage";
import ReviewerActivityDetails from "./ReviewerActivityDetails";

function isActiveRun(run: PlannerRun | null): boolean {
  return run?.status === "queued" || run?.status === "running" || run?.status === "saving";
}

interface ReviewerChatProps {
  repoId: string;
  planArtifactId: string;
  threadId: string;
  provider: string;
  model: string;
  nodeKind?: "generic" | "skill_root" | "report";
  skillRootThreadId?: string | null;
  runHint?: {
    runId: string | null;
    status: PlannerRunStatus | null;
    updatedAt: string;
  };
  hidden?: boolean;
  handoffStatuses?: ReadonlyMap<string, ReviewerMessageHandoffStatus>;
  focusMessage?: { messageId: string; requestId: string } | null;
  planSkillHistoryRefreshToken?: number;
  disabled?: boolean;
  disabledReason?: string | null;
  compact?: boolean;
  skills?: AgentSkillDefinition[];
  onInvokeSkill?: (skill: AgentSkillDefinition, parentThreadId: string) => Promise<PlanSkillInvokeResult | false>;
  onLatestRunChange?: (run: PlannerRun | null) => void;
  onHandoff?: (sources: Array<{ threadId: string; messageId: string }>, content: string) => Promise<void>;
  onForward?: (messageId: string, text?: string) => Promise<void> | void;
}

export type ReviewerMessageHandoffStatus = "waiting" | "shared" | "removed";

const EMPTY_HANDOFF_STATUSES: ReadonlyMap<string, ReviewerMessageHandoffStatus> = new Map();

const HUB_URL = window.location.origin;
const ACTIVE_RUN_POLL_INTERVAL_MS = 3_000;
const STICKY_BOTTOM_THRESHOLD_PX = 24;

function reviewerDraftStorageKey(repoId: string, planArtifactId: string, threadId: string): string {
  const scope = [repoId, planArtifactId, threadId].map(encodeURIComponent).join(":");
  return `tiller:plan-reviewer-draft:${scope}`;
}

export default function ReviewerChat({
  repoId,
  planArtifactId,
  threadId,
  model,
  nodeKind = "generic",
  skillRootThreadId = null,
  runHint = { runId: null, status: null, updatedAt: "" },
  hidden = false,
  handoffStatuses = EMPTY_HANDOFF_STATUSES,
  focusMessage = null,
  planSkillHistoryRefreshToken = 0,
  disabled = false,
  disabledReason = null,
  compact = false,
  skills = [],
  onInvokeSkill,
  onLatestRunChange,
  onHandoff,
  onForward,
}: ReviewerChatProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [runAttributions, setRunAttributions] = useState<Record<string, ReviewerRunAttribution>>({});
  const [fanoutDetail, setFanoutDetail] = useState<PlanSkillInvocationDetail | null>(null);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [forwardPreview, setForwardPreview] = useState<{
    message: ThreadMessage;
    text: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const messageRefs = useRef(new Map<string, HTMLDivElement>());
  const handledFocusRequestRef = useRef<string | null>(null);
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const stickToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const latestRunChangeRef = useRef(onLatestRunChange);
  const reportedRunSignatureRef = useRef<string | null>(null);
  const messageScopeRef = useRef("");
  const messageRequestGenerationRef = useRef(0);
  messageScopeRef.current = `${repoId}:${planArtifactId}:${threadId}`;
  latestRunChangeRef.current = onLatestRunChange;
  const performMessageLoad = useCallback(async (): Promise<void> => {
    const scope = `${repoId}:${planArtifactId}:${threadId}`;
    const generation = ++messageRequestGenerationRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await fetchReviewerMessages(HUB_URL, repoId, planArtifactId, threadId);
      if (messageScopeRef.current !== scope || messageRequestGenerationRef.current !== generation) return;
      if (Array.isArray(next)) {
        setMessages(next as ThreadMessage[]);
        setRunAttributions({});
      } else {
        setMessages(next.messages);
        setRunAttributions(next.runAttributions);
      }
    } catch (error) {
      if (messageScopeRef.current === scope && messageRequestGenerationRef.current === generation) {
        setError(error instanceof Error ? error.message : "Failed to load reviewer messages");
      }
      throw error;
    } finally {
      if (messageScopeRef.current === scope) setLoading(false);
    }
  }, [planArtifactId, repoId, threadId]);
  const { invalidateAndWait: invalidateMessages } = useSerializedRefresh(performMessageLoad);

  useEffect(() => {
    if (hidden) return;
    void invalidateMessages().catch(() => undefined);
  }, [hidden, invalidateMessages]);

  useEffect(() => {
    if (hidden || nodeKind === "generic") {
      setFanoutDetail(null);
      return;
    }
    void fetchLatestPlanSkillInvocation(
      HUB_URL,
      repoId,
      planArtifactId,
      skillRootThreadId ?? threadId,
    )
      .then(setFanoutDetail)
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "Failed to load skill round",
        ),
      );
  }, [hidden, nodeKind, planArtifactId, repoId, skillRootThreadId, threadId]);

  // Dispatched reviewer runs complete asynchronously in a container: poll the
  // tab's latest run while it is active and reload the transcript when it
  // finishes (or fails — the error lands as run state, not a thread message).
  const [activeRun, setActiveRun] = useState<PlannerRun | null>(null);
  const [latestRun, setLatestRun] = useState<PlannerRun | null>(null);
  const [runEvents, setRunEvents] = useState<PlannerRunEvent[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const handledTerminalSignaturesRef = useRef(new Set<string>());
  const activeRunRef = useRef<PlannerRun | null>(null);
  const preferredRunIdRef = useRef<string | null>(null);
  const eventCursorRef = useRef<{ runId: string | null; afterSeq: number }>({ runId: null, afterSeq: 0 });
  const [pollRevision, setPollRevision] = useState(0);
  const [documentVisible, setDocumentVisible] = useState(() => !document.hidden);
  const [online, setOnline] = useState(() => navigator.onLine);

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

  const reportLatestRun = useCallback((run: PlannerRun | null) => {
    const signature = [
      repoId,
      planArtifactId,
      threadId,
      run?.runId ?? "none",
      run?.status ?? "none",
      run?.startedAt ?? "",
      run?.provider ?? "",
      run?.model ?? "",
      run?.input?.effort ?? "",
      run?.error ?? "",
      run?.completedAt ?? "",
    ].join("|");
    if (reportedRunSignatureRef.current === signature) return;
    reportedRunSignatureRef.current = signature;
    latestRunChangeRef.current?.(run);
  }, [planArtifactId, repoId, threadId]);

  useEffect(() => {
    activeRunRef.current = activeRun;
  }, [activeRun]);

  const commentaryMessages = useMemo(() => runEvents.flatMap((event) => {
    const text = event.message?.trim();
    return event.type === "model_commentary" && text
      ? [{ id: `${event.runId}:${event.seq}`, text }]
      : [];
  }), [runEvents]);
  const latestActivity = commentaryMessages[commentaryMessages.length - 1]?.text ?? null;

  useLayoutEffect(() => {
    const transcript = transcriptRef.current;
    const force = forceScrollToBottomRef.current;
    forceScrollToBottomRef.current = false;
    if (!transcript || (!force && !stickToBottomRef.current)) return;
    const top = transcript.scrollHeight;
    if (typeof transcript.scrollTo === "function") {
      transcript.scrollTo({ top, behavior: "auto" });
    } else {
      transcript.scrollTop = top;
    }
    stickToBottomRef.current = true;
  }, [activeRun?.runId, activeRun?.status, error, latestActivity, messages.length, pendingMessage, runError]);

  useEffect(() => {
    if (hidden || !focusMessage || handledFocusRequestRef.current === focusMessage.requestId) return;
    const message = messageRefs.current.get(focusMessage.messageId);
    if (!message) return;
    handledFocusRequestRef.current = focusMessage.requestId;
    message.scrollIntoView?.({ block: "center", behavior: "smooth" });
    setHighlightedMessageId(focusMessage.messageId);
    const timer = window.setTimeout(() => setHighlightedMessageId((current) => (
      current === focusMessage.messageId ? null : current
    )), 2_500);
    return () => window.clearTimeout(timer);
  }, [focusMessage?.messageId, focusMessage?.requestId, hidden, messages]);

  useEffect(() => {
    if (hidden || !documentVisible || !online) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let requestController: AbortController | null = null;
    let targetRunId = preferredRunIdRef.current ?? runHint.runId;

    const schedule = (delayMs: number) => {
      if (cancelled) return;
      timer = window.setTimeout(() => void poll(), delayMs);
    };

    const poll = async () => {
      let retryDelay: number | null = null;
      try {
        requestController = new AbortController();
        const cursor = eventCursorRef.current.runId === targetRunId
          ? eventCursorRef.current.afterSeq
          : 0;
        const result = targetRunId
          ? await fetchPlannerRun(HUB_URL, repoId, planArtifactId, targetRunId, cursor, requestController.signal)
          : await fetchLatestPlannerRun(
              HUB_URL,
              repoId,
              planArtifactId,
              "reviewer",
              threadId,
              requestController.signal,
            );
        if (cancelled) return;
        const run = result.run;
        setLatestRun(run);
        reportLatestRun(run);
        if (!run) {
          setActiveRun(null);
          setRunEvents([]);
          setRunError(null);
          return;
        }

        const runChanged = eventCursorRef.current.runId !== run.runId;
        if (runChanged) {
          eventCursorRef.current = { runId: run.runId, afterSeq: 0 };
          setRunEvents([]);
        }
        targetRunId = run.runId;
        const maxSeq = result.events.reduce(
          (maximum, event) => Math.max(maximum, event.seq),
          eventCursorRef.current.afterSeq,
        );
        eventCursorRef.current = { runId: run.runId, afterSeq: maxSeq };
        const displayEvents = result.events.filter((event) => (
          event.type === "model_commentary" && event.message?.trim()
        ));
        if (displayEvents.length > 0) {
          setRunEvents((current) => {
            const merged = new Map<number, PlannerRunEvent>();
            for (const event of runChanged ? [] : current) merged.set(event.seq, event);
            for (const event of displayEvents) merged.set(event.seq, event);
            return [...merged.values()].sort((left, right) => left.seq - right.seq);
          });
        }

        if (isActiveRun(run)) {
          setActiveRun(run);
          setRunError(null);
          retryDelay = ACTIVE_RUN_POLL_INTERVAL_MS;
        } else {
          setActiveRun(null);
          if (preferredRunIdRef.current === run.runId) preferredRunIdRef.current = null;
          setRunError(run.status === "failed" ? run.error ?? "Reviewer run failed." : null);
          const terminalSignature = [run.runId, run.status, run.completedAt ?? "", run.error ?? ""].join("|");
          if (!handledTerminalSignaturesRef.current.has(terminalSignature)) {
            try {
              await invalidateMessages();
              if (!cancelled) handledTerminalSignaturesRef.current.add(terminalSignature);
            } catch {
              // Keep the signature eligible for the next activation, visibility
              // resume, registry hint, or explicit retry without idle polling.
            }
          }
        }
      } catch {
        const hintedActive = runHint.status === "queued"
          || runHint.status === "running"
          || runHint.status === "saving"
          || isActiveRun(activeRunRef.current);
        if (targetRunId && hintedActive) retryDelay = ACTIVE_RUN_POLL_INTERVAL_MS;
      } finally {
        requestController = null;
      }
      if (retryDelay !== null) schedule(retryDelay);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
      requestController?.abort();
    };
  }, [
    documentVisible,
    hidden,
    invalidateMessages,
    online,
    planArtifactId,
    pollRevision,
    repoId,
    reportLatestRun,
    runHint.runId,
    runHint.status,
    runHint.updatedAt,
    threadId,
  ]);

  // Returns false on failure so the composer preserves the draft.
  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (sending || disabled || activeRunRef.current) return false;
    forceScrollToBottomRef.current = true;
    setPendingMessage(text);
    setSending(true);
    setError(null);
    try {
      const result = await sendReviewerMessage(
        HUB_URL,
        repoId,
        planArtifactId,
        threadId,
        text,
        fanoutDetail?.invocation.invocationId ?? undefined,
      );
      messageRequestGenerationRef.current += 1;
      // Remove the optimistic row before publishing the stored row so the
      // current user turn can never render twice, even across unbatched state updates.
      setPendingMessage(null);
      setMessages((current) => current.some((message) => message.id === result.message.id)
        ? current
        : [...current, result.message]);
      if (result.run) {
        preferredRunIdRef.current = result.run.runId;
        setActiveRun(result.run);
        setLatestRun(result.run);
        reportLatestRun(result.run);
        setPollRevision((current) => current + 1);
      }
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to send reviewer message");
      return false;
    } finally {
      setPendingMessage(null);
      setSending(false);
    }
  }, [
    disabled,
    fanoutDetail?.invocation.invocationId,
    planArtifactId,
    repoId,
    reportLatestRun,
    sending,
    threadId,
  ]);

  const handleForward = useCallback(async (message: ThreadMessage, editedText?: string): Promise<boolean> => {
    const text = editedText ?? readThreadMessageText(message);
    if (!text.trim() || forwarding || handoffStatuses.has(message.id) || disabled) return false;
    setForwarding(true);
    try {
      if (onHandoff) await onHandoff([{ threadId, messageId: message.id }], text);
      else if (onForward) await onForward(message.id, editedText === undefined ? undefined : text);
      else throw new Error("Scribe handoff is unavailable");
      setError(null);
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to share context with the Scribe");
      return false;
    } finally {
      setForwarding(false);
    }
  }, [disabled, forwarding, handoffStatuses, onForward, onHandoff, threadId]);

  const handleInvokeSkill = useCallback(async (skill: AgentSkillDefinition): Promise<boolean> => {
    if (!onInvokeSkill) return false;
    setError(null);
    try {
      const result = await onInvokeSkill(skill, threadId);
      if (result === false) return false;
      if (!result || typeof result !== "object" || !("kind" in result)) return true;
      // Skill launches create a new rail conversation. The parent surface
      // refreshes the rail and selects that root; this generic transcript does
      // not absorb the skill's messages.
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Failed to run /${skill.command}`);
      return false;
    }
  }, [onInvokeSkill, threadId]);

  const confirmEditedForward = useCallback(async () => {
    if (!forwardPreview) return;
    const sent = await handleForward(forwardPreview.message, forwardPreview.text);
    if (sent) setForwardPreview(null);
  }, [forwardPreview, handleForward]);

  if (hidden) return null;

  const activeRunLabel = sending
    ? "Starting reviewer…"
    : activeRun?.skill
      ? `Running /${activeRun.skill} with ${activeRun.input?.skillDefinitionSnapshot?.agents[0]?.label ?? "reviewer"} · ${activeRun.model} · ${activeRun.input?.effort ?? "default"}`
      : "Reviewer is working…";

  return (
    <div className="tiller-reviewer-surface flex h-full min-h-0 flex-1 flex-col">
      {!compact && <div className="border-b border-kumo-line bg-kumo-recessed px-4 py-2 text-xs font-medium text-kumo-subtle">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0">Reviewer · {model}</span>
            {latestRun?.codexAuthMode && (
              <span className="rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                {codexAuthModeLabel(latestRun.codexAuthMode)}
              </span>
            )}
          </div>
          <span className="truncate text-[10px] font-normal">Advises on the plan · conversation retained</span>
        </div>
      </div>}
      {nodeKind === "skill_root" && <PlanSkillFanout
        repoId={repoId}
        planArtifactId={planArtifactId}
        parentThreadId={threadId}
        initialDetail={fanoutDetail}
        active={!hidden}
        refreshToken={planSkillHistoryRefreshToken}
        disabled={disabled}
        disabledReason={disabledReason}
        onLatestDetailChange={setFanoutDetail}
      />}
      <div
        ref={transcriptRef}
        aria-label="Reviewer conversation"
        className={compact
          ? "tiller-reviewer-transcript min-h-0 flex-1 overflow-y-auto py-1"
          : "min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"}
        onScroll={(event) => {
          const transcript = event.currentTarget;
          stickToBottomRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
            <= STICKY_BOTTOM_THRESHOLD_PX;
        }}
      >
        {loading && <LoadingIndicator label="Loading reviewer messages" className="py-8" />}
        {!loading && !activeRun && messages.length === 0 && !error && !runError && (
          <div className={compact
            ? "mx-3 my-4 border border-kumo-line bg-kumo-recessed px-4 py-4 text-[13px] leading-5 text-kumo-subtle"
            : "py-8 text-center text-sm text-kumo-subtle"}
          >
            This reviewer critiques the plan without editing it. Ask about risks, missing steps, or alternatives; the conversation is retained between turns.
          </div>
        )}
        {messages.map((message) => {
          const role = readThreadMessageRole(message);
          const text = readThreadMessageText(message);
          const handoffStatus = handoffStatuses.get(message.id);
          const messageRunId = readThreadMessageRunId(message);
          const attribution = messageRunId ? runAttributions[messageRunId] : undefined;
          const canForward = role === "assistant"
            && text.trim().length > 0
            && attribution?.skillRunRole !== "overview"
            && (!isRecord(message.body) || message.body.forwardable !== false);
          if (compact) {
            const responseState = handoffStatus === "shared"
              ? "sent"
              : handoffStatus === "waiting"
                ? "delivering"
                : handoffStatus === "removed"
                  ? "dismissed"
                  : "ready";
            return (
              <ReviewerTranscriptMessage
                key={message.id}
                role={role}
                author={role === "user" ? "You" : "Reviewer"}
                createdAt={message.createdAt}
              >
                {role === "assistant" ? (
                  <MarkdownContent className="tiller-reviewer-markdown">{text}</MarkdownContent>
                ) : (
                  <div className="whitespace-pre-wrap break-words text-pretty">{text}</div>
                )}
                {attribution?.command && (
                  <div className="mt-1 text-[10px] text-kumo-subtle">
                    /{attribution.command} · {attribution.agentLabel ?? "Reviewer"} · {attribution.provider} / {attribution.model}{attribution.effort ? ` / ${attribution.effort}` : ""}
                  </div>
                )}
                {canForward && (
                  <ReviewerResponseActions
                    state={responseState}
                    label={handoffStatus === "waiting"
                      ? `Waiting for ${PLAN_AGENT_LABEL}`
                      : handoffStatus === "shared"
                        ? `Sent to ${PLAN_AGENT_LABEL}`
                        : handoffStatus === "removed"
                          ? `Removed from ${PLAN_AGENT_LABEL}`
                          : "Response ready"}
                  >
                    {!handoffStatus && (
                      <>
                        <button
                          type="button"
                          onClick={() => void handleForward(message)}
                          disabled={forwarding || disabled}
                          className="inline-flex h-7 items-center text-[11px] font-medium text-kumo-default hover:text-kumo-info disabled:opacity-50"
                          title={disabled ? disabledReason ?? undefined : `Send this response to ${PLAN_AGENT_LABEL}`}
                        >
                          Send to {PLAN_AGENT_LABEL}
                        </button>
                        <button
                          type="button"
                          onClick={() => setForwardPreview({ message, text })}
                          disabled={forwarding || disabled}
                          className="inline-flex h-7 items-center text-[11px] font-medium text-kumo-subtle hover:text-kumo-default disabled:opacity-50"
                          title={disabled ? disabledReason ?? undefined : undefined}
                        >
                          Edit first
                        </button>
                      </>
                    )}
                  </ReviewerResponseActions>
                )}
              </ReviewerTranscriptMessage>
            );
          }
          return (
            <div
              key={message.id}
              ref={(node) => {
                if (node) messageRefs.current.set(message.id, node);
                else messageRefs.current.delete(message.id);
              }}
              data-reviewer-message-id={message.id}
              className={`flex rounded transition-shadow ${role === "user" ? "justify-end" : "justify-start"} ${
                highlightedMessageId === message.id ? "ring-2 ring-kumo-focus ring-offset-2" : ""
              }`}
            >
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  role === "user"
                    ? "bg-kumo-brand text-white"
                    : "border border-kumo-line bg-kumo-recessed text-kumo-default"
                }`}
              >
                <div className="whitespace-pre-wrap break-words">{text}</div>
                {role === "assistant" && attribution?.command && (
                  <div className="mt-1 text-[10px] text-kumo-subtle">
                    /{attribution.command} · {attribution.agentLabel ?? "Reviewer"} · {attribution.provider} / {attribution.model}{attribution.effort ? ` / ${attribution.effort}` : ""}
                  </div>
                )}
                {role === "user" && attribution?.command && (attribution.status === "failed" || attribution.status === "cancelled") && (
                  <div className="mt-1 text-[10px] text-white/75">
                    {attribution.status === "failed" ? "Failed" : "Cancelled"}{attribution.error ? ` · ${attribution.error}` : ""}
                  </div>
                )}
                {canForward && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => void handleForward(message)}
                      disabled={forwarding || Boolean(handoffStatus) || disabled}
                      className={handoffStatus === "shared" ? "disabled:bg-kumo-success-tint disabled:!text-kumo-success" : ""}
                      title={disabled ? disabledReason ?? undefined : undefined}
                    >
                      {forwarding
                        ? "Sharing…"
                        : handoffStatus === "waiting"
                          ? "Waiting for Scribe"
                          : handoffStatus === "shared"
                            ? "Sent to Plan Writer"
                            : handoffStatus === "removed"
                              ? "Removed from Scribe"
                              : "Share with Scribe"}
                    </Button>
                    {!handoffStatus && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setForwardPreview({ message, text })}
                        disabled={forwarding || disabled}
                        title={disabled ? disabledReason ?? undefined : undefined}
                      >
                        Edit &amp; Send to Scribe
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {pendingMessage && (compact ? (
          <ReviewerTranscriptMessage role="user" author="You" testId="pending-reviewer-message">
            <div className="whitespace-pre-wrap break-words">{pendingMessage}</div>
            <div className="mt-1 text-[10px] text-kumo-subtle">Sending…</div>
          </ReviewerTranscriptMessage>
        ) : (
          <div className="flex justify-end" data-testid="pending-reviewer-message">
            <div className="max-w-[80%] rounded-lg bg-kumo-brand px-3 py-2 text-sm text-white">
              <div className="whitespace-pre-wrap break-words">{pendingMessage}</div>
              <div className="mt-1 text-[10px] text-white/70">Sending…</div>
            </div>
          </div>
        ))}
        {(sending || activeRun) && (compact ? (
          <ReviewerTranscriptMessage role="assistant" author="Reviewer" testId="reviewer-run-status">
            <div className="animate-pulse text-kumo-subtle">{activeRunLabel}</div>
            <ReviewerActivityDetails messages={commentaryMessages} />
          </ReviewerTranscriptMessage>
        ) : (
          <div className="flex justify-start" data-testid="reviewer-run-status">
            <div className="max-w-[80%] rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
              <div className="animate-pulse">{activeRunLabel}</div>
              <ReviewerActivityDetails messages={commentaryMessages} />
            </div>
          </div>
        ))}
        {runError && (
          <div className={compact ? "border-b border-kumo-line px-3 py-3" : "flex justify-start"}>
            <div className={compact ? "text-[13px] text-kumo-danger" : "max-w-[80%] rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger"}>
              {runError}
            </div>
          </div>
        )}
        {error && (
          <div className={compact ? "border-b border-kumo-line px-3 py-3 text-[13px] text-kumo-danger" : "rounded border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger"}>
            {error}
          </div>
        )}
      </div>
      {compact ? (
        <ResizableAgentBar
          ariaLabel="Resize reviewer lower bar"
          defaultHeight={57}
          minHeight={57}
          storageKey="tiller:reviewer-lower-bar-height"
        >
          <PlanChatInput
            disabled={disabled}
            busy={sending || Boolean(activeRun)}
            placeholder={disabled ? disabledReason ?? "Reviewer input is disabled" : "Ask this reviewer…"}
            busyPlaceholder="Reviewer is working…"
            optimisticClear
            draftStorageKey={reviewerDraftStorageKey(repoId, planArtifactId, threadId)}
            skills={skills}
            onInvokeSkill={handleInvokeSkill}
            onSend={(message) => handleSend(message)}
            compact
            showSkillTrigger
          />
        </ResizableAgentBar>
      ) : (
        <PlanChatInput
          disabled={disabled}
          busy={sending || Boolean(activeRun)}
          placeholder={disabled ? disabledReason ?? "Reviewer input is disabled" : "Ask for a code-aware critique..."}
          busyPlaceholder="Run a /skill or wait for this reviewer..."
          optimisticClear
          draftStorageKey={reviewerDraftStorageKey(repoId, planArtifactId, threadId)}
          skills={skills}
          onInvokeSkill={handleInvokeSkill}
          onSend={(message) => handleSend(message)}
        />
      )}
      <Dialog.Root
        open={Boolean(forwardPreview)}
        onOpenChange={(open) => {
          if (!open && !forwarding) setForwardPreview(null);
        }}
      >
        <Dialog className="flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden p-0">
          <div className="border-b border-kumo-line px-4 py-3">
            <Dialog.Title className="text-sm font-semibold text-kumo-strong">
              Edit &amp; Send to Scribe
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-kumo-subtle">
              Adjust the reviewer feedback before sharing it with the plan Scribe.
            </Dialog.Description>
          </div>
          <div className="min-h-0 flex-1 p-4">
            <textarea
              aria-label="Message to Scribe"
              value={forwardPreview?.text ?? ""}
              onChange={(event) => setForwardPreview((current) => (
                current ? { ...current, text: event.target.value } : current
              ))}
              disabled={forwarding}
              className="h-72 w-full resize-none rounded border border-kumo-line bg-kumo-base p-3 font-mono text-xs text-kumo-default"
            />
          </div>
          <div className="flex justify-end gap-2 border-t border-kumo-line px-4 py-3">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => setForwardPreview(null)}
              disabled={forwarding}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void confirmEditedForward()}
              disabled={forwarding || !forwardPreview?.text.trim()}
            >
              {forwarding ? "Sending…" : "Send to Scribe"}
            </Button>
          </div>
        </Dialog>
      </Dialog.Root>
    </div>
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readThreadMessageRole(message: ThreadMessage): "user" | "assistant" {
  if (isRecord(message.body) && message.body.role === "user") return "user";
  if (isRecord(message.body) && message.body.role === "assistant") return "assistant";
  return message.senderSessionId === "user" ? "user" : "assistant";
}

function readThreadMessageText(message: ThreadMessage): string {
  if (isRecord(message.body) && typeof message.body.text === "string") return message.body.text;
  if (typeof message.body === "string") return message.body;
  return "";
}

function readThreadMessageRunId(message: ThreadMessage): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string"
    ? message.body.runId
    : null;
}
