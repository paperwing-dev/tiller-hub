import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@cloudflare/kumo/components/button";
import { Textarea } from "@cloudflare/kumo/components/input";
import {
  fetchLatestPlannerRun,
  fetchReviewerMessages,
  sendReviewerMessage,
  type PlannerRun,
  type PlannerRunEvent,
  type ThreadMessage,
} from "./api";
import LoadingIndicator from "./LoadingIndicator";
import { codexAuthModeLabel } from "./codex-auth-ui";

function isActiveRun(run: PlannerRun | null): boolean {
  return run?.status === "queued" || run?.status === "running" || run?.status === "saving";
}

interface ReviewerChatProps {
  repoId: string;
  planArtifactId: string;
  threadId: string;
  provider: string;
  model: string;
  hidden?: boolean;
  sentMessageIds?: Set<string>;
  disabled?: boolean;
  disabledReason?: string | null;
  onLatestRunChange?: (run: PlannerRun | null) => void;
  onForward: (messageId: string) => Promise<void> | void;
}

const HUB_URL = window.location.origin;
const ACTIVE_RUN_POLL_INTERVAL_MS = 750;
const IDLE_RUN_POLL_INTERVAL_MS = 2_000;
const STICKY_BOTTOM_THRESHOLD_PX = 24;

function ReviewerComposer({
  disabled,
  busy,
  placeholder,
  onSend,
}: {
  disabled: boolean;
  busy: boolean;
  placeholder: string;
  onSend: (message: string) => void | boolean | Promise<void | boolean>;
}) {
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(async () => {
    const message = input.trim();
    if (!message || disabled || pending || busy) return;
    setPending(true);
    setInput("");
    try {
      const result = await onSend(message);
      if (result === false) setInput(message);
    } catch (error) {
      setInput(message);
      throw error;
    } finally {
      setPending(false);
      inputRef.current?.focus();
    }
  }, [busy, disabled, input, onSend, pending]);

  return (
    <div className="border-t border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex gap-2">
        <Textarea
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          placeholder={busy && !disabled ? "Wait for this reviewer..." : placeholder}
          rows={1}
          className="flex-1 resize-none"
          disabled={disabled || pending}
        />
        <Button
          variant="primary"
          onClick={() => void handleSend()}
          disabled={disabled || pending || busy || !input.trim()}
        >
          {pending ? "Sending…" : "Send"}
        </Button>
      </div>
    </div>
  );
}

export default function ReviewerChat({
  repoId,
  planArtifactId,
  threadId,
  model,
  hidden = false,
  sentMessageIds = new Set(),
  disabled = false,
  disabledReason = null,
  onLatestRunChange,
  onForward,
}: ReviewerChatProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [pendingMessage, setPendingMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [forwarding, setForwarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const forceScrollToBottomRef = useRef(false);
  const latestRunChangeRef = useRef(onLatestRunChange);
  const reportedRunSignatureRef = useRef<string | null>(null);
  latestRunChangeRef.current = onLatestRunChange;
  const loadMessages = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setMessages(await fetchReviewerMessages(HUB_URL, repoId, planArtifactId, threadId));
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to load reviewer messages");
    } finally {
      setLoading(false);
    }
  }, [planArtifactId, repoId, threadId]);

  useEffect(() => {
    void loadMessages();
  }, [loadMessages]);

  // Dispatched reviewer runs complete asynchronously in a container: poll the
  // tab's latest run while it is active and reload the transcript when it
  // finishes (or fails — the error lands as run state, not a thread message).
  const [activeRun, setActiveRun] = useState<PlannerRun | null>(null);
  const [latestRun, setLatestRun] = useState<PlannerRun | null>(null);
  const [runEvents, setRunEvents] = useState<PlannerRunEvent[]>([]);
  const [runError, setRunError] = useState<string | null>(null);
  const handledTerminalRunIdsRef = useRef(new Set<string>());
  const activeRunRef = useRef<PlannerRun | null>(null);

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

  const latestActivity = useMemo(() => {
    for (let index = runEvents.length - 1; index >= 0; index -= 1) {
      const message = runEvents[index].message?.trim();
      if (message) return message;
    }
    return null;
  }, [runEvents]);

  const activeRunPolling = isActiveRun(activeRun);

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
    let cancelled = false;
    const poll = async () => {
      try {
        const result = await fetchLatestPlannerRun(HUB_URL, repoId, planArtifactId, "reviewer", threadId);
        if (cancelled) return;
        const run = result.run;
        setLatestRun(run);
        reportLatestRun(run);
        if (isActiveRun(run)) {
          setActiveRun(run);
          setRunEvents(result.events.filter((event) => event.type === "model_activity"));
          setRunError(null);
          return;
        }
        setActiveRun(null);
        setRunEvents([]);
        setRunError(run?.status === "failed" ? run.error ?? "Reviewer run failed." : null);
        if (run && !handledTerminalRunIdsRef.current.has(run.runId)) {
          handledTerminalRunIdsRef.current.add(run.runId);
          await loadMessages();
          if (cancelled) return;
        }
      } catch {
        // Polling is best-effort; the next tick retries.
      }
    };
    void poll();
    const intervalId = window.setInterval(
      () => void poll(),
      activeRunPolling ? ACTIVE_RUN_POLL_INTERVAL_MS : IDLE_RUN_POLL_INTERVAL_MS,
    );
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRunPolling, loadMessages, planArtifactId, repoId, reportLatestRun, threadId]);

  // Returns false on failure so the composer preserves the draft.
  const handleSend = useCallback(async (text: string): Promise<boolean> => {
    if (sending || disabled || activeRunRef.current) return false;
    forceScrollToBottomRef.current = true;
    setPendingMessage(text);
    setSending(true);
    setError(null);
    try {
      const result = await sendReviewerMessage(HUB_URL, repoId, planArtifactId, threadId, text);
      setMessages((current) => current.some((message) => message.id === result.message.id)
        ? current
        : [...current, result.message]);
      if (result.run) {
        setActiveRun(result.run);
        setLatestRun(result.run);
        reportLatestRun(result.run);
      }
      return true;
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to send reviewer message");
      return false;
    } finally {
      setPendingMessage(null);
      setSending(false);
    }
  }, [disabled, planArtifactId, repoId, reportLatestRun, sending, threadId]);

  const handleForward = useCallback(async (message: ThreadMessage) => {
    const text = readThreadMessageText(message);
    if (!text || forwarding || sentMessageIds.has(message.id) || disabled) return;
    setForwarding(true);
    try {
      await onForward(message.id);
      setError(null);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Failed to send feedback to the writer");
    } finally {
      setForwarding(false);
    }
  }, [disabled, forwarding, onForward, sentMessageIds]);

  return (
    <div className={`h-full min-h-0 flex-1 flex-col ${hidden ? "hidden" : "flex"}`}>
      <div className="border-b border-kumo-line bg-kumo-recessed px-4 py-2 text-xs font-medium text-kumo-subtle">
        <div className="flex items-center gap-2">
          <span>Reviewer · {model}</span>
          {latestRun?.codexAuthMode && (
            <span className="rounded border border-kumo-line bg-kumo-base px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
              {codexAuthModeLabel(latestRun.codexAuthMode)}
            </span>
          )}
        </div>
      </div>
      <div
        ref={transcriptRef}
        aria-label="Reviewer conversation"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4"
        onScroll={(event) => {
          const transcript = event.currentTarget;
          stickToBottomRef.current = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight
            <= STICKY_BOTTOM_THRESHOLD_PX;
        }}
      >
        {loading && <LoadingIndicator label="Loading reviewer messages" className="py-8" />}
        {!loading && !activeRun && messages.length === 0 && !error && !runError && (
          <div className="py-8 text-center text-sm text-kumo-subtle">
            Ask this reviewer anything about the plan — it reads the actual code.
          </div>
        )}
        {messages.map((message) => {
          const role = readThreadMessageRole(message);
          const text = readThreadMessageText(message);
          const canForward = role === "assistant" && text.trim().length > 0;
          const sent = sentMessageIds.has(message.id);
          return (
            <div key={message.id} className={`flex ${role === "user" ? "justify-end" : "justify-start"}`}>
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  role === "user"
                    ? "bg-kumo-brand text-white"
                    : "border border-kumo-line bg-kumo-recessed text-kumo-default"
                }`}
              >
                <div className="whitespace-pre-wrap break-words">{text}</div>
                {canForward && (
                  <Button
                    size="sm"
                    onClick={() => void handleForward(message)}
                    disabled={forwarding || sent || disabled}
                    className="mt-2 disabled:bg-kumo-success-tint disabled:!text-kumo-success"
                    title={disabled ? disabledReason ?? undefined : undefined}
                  >
                    {sent ? "Sent to Writer" : "Send to Writer"}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
        {pendingMessage && (
          <div className="flex justify-end" data-testid="pending-reviewer-message">
            <div className="max-w-[80%] rounded-lg bg-kumo-brand px-3 py-2 text-sm text-white">
              <div className="whitespace-pre-wrap break-words">{pendingMessage}</div>
              <div className="mt-1 text-[10px] text-white/70">Sending…</div>
            </div>
          </div>
        )}
        {(sending || activeRun) && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
              <div className="animate-pulse">{sending ? "Starting reviewer…" : "Reviewer is working…"}</div>
              {latestActivity && (
                <div className="mt-1 whitespace-pre-wrap break-words text-xs text-kumo-default">{latestActivity}</div>
              )}
            </div>
          </div>
        )}
        {runError && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
              {runError}
            </div>
          </div>
        )}
        {error && (
          <div className="rounded border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
            {error}
          </div>
        )}
      </div>
      <ReviewerComposer
        disabled={disabled}
        busy={sending || Boolean(activeRun)}
        placeholder={disabled ? disabledReason ?? "Reviewer input is disabled" : "Ask for a code-aware critique..."}
        onSend={(message) => handleSend(message)}
      />
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
