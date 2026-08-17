import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { StoredSession, StoredPermission, EnvMeta, WsServerMessage } from "../api/types";
import type { LiveMessage, ReconnectingWebSocket } from "./api";
import type { TerminalResizeRequest, TerminalViewHandle } from "./TerminalView";
import TerminalView from "./TerminalView";
import PermissionBanner from "./PermissionBanner";
import StatusBar from "./StatusBar";
import VoiceAgent from "./VoiceAgent";
import EnvReviewPanel from "./EnvReviewPanel";
import { useVoiceAgent } from "@cloudflare/voice/react";
import type { UseVoiceAgentReturn } from "@cloudflare/voice/react";
import { canStopEnvStatus } from "./env-runtime";
import { TerminalAckTracker } from "./terminal-ack-tracker";
import type { TerminalAckOperation } from "./terminal-ack-tracker";
import type { TerminalRecoveryState } from "./terminal-recovery";

const CLI_PROMPT_DISMISS_KEY = "tiller:session-cli-prompt-dismissed";
const TERMINAL_RESIZE_NOTICE_MS = 4000;

type TerminalAckMessage =
  | Extract<WsServerMessage, { type: "terminal-input-ack" }>
  | Extract<WsServerMessage, { type: "terminal-control-ack" }>;

interface TerminalAlert {
  message: string;
  operation?: TerminalAckOperation;
  source: "stale" | "failure" | "drop" | "detached";
  tone: "warning" | "error";
}

interface SessionViewProps {
  session: StoredSession;
  env?: (
    Pick<
      EnvMeta,
      | "slug"
      | "status"
    > &
    Partial<Pick<EnvMeta, "backend" | "repoId" | "startupPlanId">>
  ) | null;
  hubUrl: string;
  onWsMessage: MutableRefObject<((msg: LiveMessage) => void) | null>;
  onTerminalAck?: MutableRefObject<((msg: TerminalAckMessage) => void) | null>;
  wsSend: MutableRefObject<ReconnectingWebSocket | null>;
  connected: boolean;
  terminalFastLane?: boolean;
  terminalMetrics?: boolean;
  updateLastSeq: (sessionId: string, seq: number) => void;
  permissions?: StoredPermission[];
  onPermissionResolved: (permId: string) => void;
  onRecoverEnv?: (slug: string, status?: string) => void;
}

function sanitizeTerminalPasteText(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
    .replace(/\u001b/g, "");
}

export default function SessionView({
  session,
  env,
  hubUrl,
  onWsMessage,
  onTerminalAck,
  wsSend,
  connected,
  terminalFastLane = false,
  terminalMetrics = false,
  updateLastSeq,
  permissions = [],
  onPermissionResolved,
}: SessionViewProps) {
  const [terminalAlert, setTerminalAlert] = useState<TerminalAlert | null>(null);
  const [terminalRecoveryState, setTerminalRecoveryState] = useState<TerminalRecoveryState>({ status: "recovering" });
  const [terminalDetached, setTerminalDetached] = useState(false);
  const [cliPromptDismissed, setCliPromptDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem(CLI_PROMPT_DISMISS_KEY) === "true";
    } catch {
      return false;
    }
  });
  const termRef = useRef<TerminalViewHandle>(null);
  const termOutputBufferRef = useRef("");
  const summarizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSummarySentAtRef = useRef(0);
  const awaitingClaudeSummaryRef = useRef(false);
  const clientIdRef = useRef(crypto.randomUUID());
  const inputSeqRef = useRef(0);
  const controlSeqRef = useRef(0);
  const lastTerminalSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const terminalRecoveryStateRef = useRef<TerminalRecoveryState>({ status: "recovering" });
  const ackTrackerRef = useRef<TerminalAckTracker | null>(null);
  const pendingInputAckPromisesRef = useRef(new Map<number, {
    resolve: (value: { ok: boolean; error?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>());
  if (!ackTrackerRef.current) {
    ackTrackerRef.current = new TerminalAckTracker({
      onStaleWarning: ({ message, operation }) =>
        setTerminalAlert((current) => current?.tone === "error"
          ? current
          : { message, operation, source: "stale", tone: "warning" }),
      onRecovered: () =>
        setTerminalAlert((current) => current?.source === "stale" ? null : current),
      onFailure: (message) =>
        setTerminalAlert({ message, source: "failure", tone: "error" }),
      onDrop: (message) =>
        setTerminalAlert((current) => current?.tone === "error"
          ? current
          : { message, source: "drop", tone: "warning" }),
    });
  }

  // Custom status from the server (e.g. "reading" for terminal summarization)
  const [tillerStatus, setTillerStatus] = useState<string | null>(null);
  const [voiceDebugEnabled, setVoiceDebugEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("tiller-voice-debug") === "true";
  });
  const [voiceDebugEvents, setVoiceDebugEvents] = useState<
    Array<{
      timestamp: number;
      stage: string;
      details?: Record<string, unknown>;
    }>
  >([]);
  const [debugCopyState, setDebugCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");

  // Voice call state — tracks whether user has started a call
  const [voiceActive, setVoiceActive] = useState(false);

  // Voice feature disabled: invoking useVoiceAgent opens a WebSocket to
  // /api/voice/session on every session mount, which was flooding the console
  // with errors and polling. Hook call is preserved (commented) and the return
  // shape is stubbed below so the rest of the component keeps type-checking.
  // Flip VOICE_DISABLED to false and uncomment the hook call to restore.
  const VOICE_DISABLED = true;
  // const {
  //   status,
  //   transcript,
  //   interimTranscript,
  //   audioLevel,
  //   isMuted,
  //   connected: voiceConnected,
  //   error: voiceError,
  //   metrics,
  //   startCall,
  //   endCall,
  //   toggleMute,
  //   sendJSON,
  //   lastCustomMessage,
  // } = useVoiceAgent({
  //   agent: "TillerVoice",
  //   name: session.id,
  // });
  const voiceStub: UseVoiceAgentReturn = {
    status: "idle",
    transcript: [],
    interimTranscript: null,
    metrics: null,
    audioLevel: 0,
    isMuted: false,
    connected: false,
    error: null,
    outputDeviceError: null,
    startCall: async () => {},
    endCall: () => {},
    toggleMute: () => {},
    sendText: () => {},
    sendJSON: () => {},
    lastCustomMessage: null,
  };
  const {
    status,
    transcript,
    interimTranscript,
    audioLevel,
    isMuted,
    connected: voiceConnected,
    error: voiceError,
    metrics,
    startCall,
    endCall,
    toggleMute,
    sendJSON,
    lastCustomMessage,
  } = voiceStub;

  const voiceIsInCall = status !== "idle";

  // Watch for custom messages from the server (e.g. tiller-status, speaker_conflict)
  useEffect(() => {
    if (!lastCustomMessage || typeof lastCustomMessage !== "object") return;
    const msg = lastCustomMessage as {
      type?: string;
      status?: string;
      timestamp?: number;
      stage?: string;
      details?: Record<string, unknown>;
    };
    if (msg.type === "tiller-status") {
      setTillerStatus(msg.status ?? null);
    }
    const debugStage = msg.stage;
    if (msg.type === "debug" && debugStage) {
      setVoiceDebugEvents((events) =>
        [
          ...events,
          {
            timestamp: msg.timestamp ?? Date.now(),
            stage: debugStage,
            details: msg.details,
          },
        ].slice(-200),
      );
    }
    // Clear custom status when voice status changes to listening/idle
    if (status === "listening" || status === "idle") {
      setTillerStatus(null);
    }
  }, [lastCustomMessage, status]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("tiller-voice-debug", String(voiceDebugEnabled));
  }, [voiceDebugEnabled]);

  useEffect(() => {
    if (!voiceConnected) return;
    sendJSON({ type: "debug", enabled: voiceDebugEnabled });
  }, [voiceConnected, voiceDebugEnabled, sendJSON]);

  // Refs for summarize timer callbacks (avoid stale closures)
  const sendJSONRef = useRef(sendJSON);
  sendJSONRef.current = sendJSON;
  const voiceActiveRef = useRef(voiceActive);
  voiceActiveRef.current = voiceActive;

  useEffect(() => {
    const lastMessage = transcript[transcript.length - 1];
    if (!lastMessage || lastMessage.role !== "assistant") return;

    if (/^i sent that to claude\.?$/i.test(lastMessage.text.trim())) {
      awaitingClaudeSummaryRef.current = true;
      termOutputBufferRef.current = "";
      lastSummarySentAtRef.current = 0;
      if (summarizeTimerRef.current) {
        clearTimeout(summarizeTimerRef.current);
        summarizeTimerRef.current = null;
      }
    }
  }, [transcript]);

  const flushBufferedOutput = useCallback(() => {
    if (summarizeTimerRef.current) {
      clearTimeout(summarizeTimerRef.current);
      summarizeTimerRef.current = null;
    }

    const buffered = normalizeOutputForSpeech(termOutputBufferRef.current);

    if (
      !voiceActiveRef.current ||
      !awaitingClaudeSummaryRef.current ||
      buffered.length < 120
    ) {
      termOutputBufferRef.current = "";
      return;
    }

    const now = Date.now();
    const summaryCooldownMs = 12000;
    const elapsed = now - lastSummarySentAtRef.current;
    if (elapsed < summaryCooldownMs) {
      summarizeTimerRef.current = setTimeout(
        flushBufferedOutput,
        summaryCooldownMs - elapsed,
      );
      return;
    }

    termOutputBufferRef.current = "";
    lastSummarySentAtRef.current = now;
    awaitingClaudeSummaryRef.current = false;

    sendJSONRef.current({
      type: "summarize-output",
      content: buffered,
    });
  }, []);

  // Handle starting/stopping voice
  // Note: startCall() does NOT throw on failure — it sets the error state
  // and returns. We always show the voice panel so the user can see errors.
  const handleStartVoice = useCallback(async () => {
    setVoiceActive(true);
    await startCall();
  }, [startCall]);

  const handleStopVoice = useCallback(() => {
    endCall();
    setVoiceActive(false);
    setTillerStatus(null);
    setVoiceDebugEvents([]);
    if (summarizeTimerRef.current) {
      clearTimeout(summarizeTimerRef.current);
      summarizeTimerRef.current = null;
    }
    termOutputBufferRef.current = "";
    lastSummarySentAtRef.current = 0;
    awaitingClaudeSummaryRef.current = false;
  }, [endCall]);

  // Clear summarize timer when voice goes inactive
  useEffect(() => {
    if (!voiceActive) {
      if (summarizeTimerRef.current) {
        clearTimeout(summarizeTimerRef.current);
        summarizeTimerRef.current = null;
      }
      termOutputBufferRef.current = "";
      lastSummarySentAtRef.current = 0;
      awaitingClaudeSummaryRef.current = false;
    }
  }, [voiceActive]);

  const handleClear = () => {
    termRef.current?.clear();
  };

  const handleReviewLayoutChange = useCallback(() => {
    termRef.current?.refit();
  }, []);

  const handleToggleVoiceDebug = useCallback(() => {
    setVoiceDebugEnabled((enabled) => !enabled);
  }, []);

  const handleDismissCliPrompt = useCallback(() => {
    setCliPromptDismissed(true);
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(CLI_PROMPT_DISMISS_KEY, "true");
    } catch {
      // Ignore storage failures; the in-memory dismissal still applies.
    }
  }, []);

  // Route live WS messages to the terminal via the proven callback path
  useEffect(() => {
    onWsMessage.current = (msg) => {
      if (msg.sessionId !== session.id) return;
      const content =
        typeof msg.content === "string" ? tryParse(msg.content) : msg.content;
      termRef.current?.acceptMessage({
        id: msg.id,
        sessionId: msg.sessionId,
        seq: msg.seq,
        content,
        ...(msg.localId !== undefined ? { localId: msg.localId } : {}),
      });
    };
    return () => {
      onWsMessage.current = null;
    };
  }, [session.id, onWsMessage]);

  const handleDurableMessageComplete = useCallback((message: {
    content: unknown;
  }) => {
    const content = message.content as { type?: string; data?: string } | null;
    if (
      content?.type !== "terminal-output" ||
      !content.data ||
      !voiceActiveRef.current ||
      !awaitingClaudeSummaryRef.current
    ) return;
    termOutputBufferRef.current += stripAnsi(content.data);
    if (summarizeTimerRef.current) clearTimeout(summarizeTimerRef.current);
    summarizeTimerRef.current = setTimeout(flushBufferedOutput, 4000);
  }, [flushBufferedOutput]);

  useEffect(() => {
    if (connected) termRef.current?.recover();
  }, [connected]);

  useEffect(() => {
    if (!connected || !terminalFastLane || terminalDetached) return;
    wsSend.current?.send({
      type: "reconnect",
      sessionId: session.id,
      lastSeq: 0,
      revive: false,
      replay: false,
    });
  }, [connected, session.id, terminalDetached, terminalFastLane, wsSend]);

  // Clear terminal alerts when the connection restores.
  useEffect(() => {
    if (connected) setTerminalAlert(null);
  }, [connected]);

  useEffect(() => {
    if (terminalAlert?.source !== "stale" || terminalAlert.operation !== "resize") return;
    const displayedAlert = terminalAlert;
    const timer = setTimeout(() => {
      setTerminalAlert((current) => current === displayedAlert ? null : current);
    }, TERMINAL_RESIZE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [terminalAlert]);

  const clearPendingAcks = useCallback(() => {
    ackTrackerRef.current?.clear();
    for (const pending of pendingInputAckPromisesRef.current.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error: "Terminal ACK was cleared before completion" });
    }
    pendingInputAckPromisesRef.current.clear();
  }, []);

  useEffect(() => {
    clientIdRef.current = crypto.randomUUID();
    inputSeqRef.current = 0;
    controlSeqRef.current = 0;
    clearPendingAcks();
    setTerminalAlert(null);
    setTerminalDetached(false);
    terminalRecoveryStateRef.current = { status: "recovering" };
    setTerminalRecoveryState({ status: "recovering" });
    return clearPendingAcks;
  }, [clearPendingAcks, session.id]);

  useEffect(() => {
    const sessionId = session.id;
    return () => {
      wsSend.current?.send?.({
        type: "terminal-detach",
        sessionId,
        clientId: clientIdRef.current,
      });
    };
  }, [session.id, wsSend]);

  // ACKs are live-only; anything in flight when the socket drops will never
  // be acked, so clear pending state instead of leaking timers and warnings.
  useEffect(() => {
    if (!connected) clearPendingAcks();
  }, [clearPendingAcks, connected]);

  const warnSendFailed = useCallback((what: string) => {
    ackTrackerRef.current?.warnSendFailed(what);
  }, []);

  const trackInputAck = useCallback((inputSeq: number) => {
    ackTrackerRef.current?.trackInput(inputSeq);
  }, []);

  const trackControlAck = useCallback((
    controlSeq: number,
    action: "resize" | "abort",
  ) => {
    ackTrackerRef.current?.trackControl(controlSeq, action);
  }, []);

  const clearInputAck = useCallback((inputSeq: number, error?: string) => {
    termRef.current?.markInputAcknowledged?.(inputSeq, !error);
    ackTrackerRef.current?.handleInputAck(inputSeq, error);
  }, []);

  const clearControlAck = useCallback((controlSeq: number, error?: string) => {
    ackTrackerRef.current?.handleControlAck(controlSeq, error);
  }, []);

  useEffect(() => {
    if (!onTerminalAck) return;
    onTerminalAck.current = (msg) => {
      if (msg.sessionId !== session.id || msg.clientId !== clientIdRef.current) return;
      if (msg.type === "terminal-input-ack") {
        clearInputAck(msg.inputSeq, msg.ok ? undefined : msg.error ?? "remote session rejected input");
        const pending = pendingInputAckPromisesRef.current.get(msg.inputSeq);
        if (pending) {
          clearTimeout(pending.timer);
          pendingInputAckPromisesRef.current.delete(msg.inputSeq);
          pending.resolve({ ok: msg.ok, ...(msg.ok ? {} : { error: msg.error ?? "remote session rejected input" }) });
        }
        return;
      }
      clearControlAck(msg.controlSeq, msg.ok ? undefined : msg.error ?? "remote session rejected control");
    };
    return () => {
      onTerminalAck.current = null;
    };
  }, [clearControlAck, clearInputAck, onTerminalAck, session.id]);

  const handleCopyVoiceDebug = useCallback(async () => {
    const text = voiceDebugEvents
      .map((event) => {
        const ts = new Date(event.timestamp).toISOString();
        const details = event.details
          ? ` ${JSON.stringify(event.details)}`
          : "";
        return `${ts} ${event.stage}${details}`;
      })
      .join("\n");

    try {
      await navigator.clipboard.writeText(text || "No debug events yet.");
      setDebugCopyState("copied");
    } catch {
      setDebugCopyState("failed");
    }
    setTimeout(() => setDebugCopyState("idle"), 1500);
  }, [voiceDebugEvents]);

  // Terminal input/control is fast-lane-only: live sends never queue, and
  // there is deliberately no durable fallback — durable raw input would be
  // queued during a disconnect and replayed stale into the PTY on reconnect.
  const sendRawKey = useCallback((data: string): boolean => {
    if (
      terminalRecoveryStateRef.current.status !== "ready" ||
      terminalDetached ||
      !terminalFastLane ||
      !wsSend.current?.send
    ) {
      warnSendFailed("terminal input");
      return false;
    }

    const inputSeq = inputSeqRef.current + 1;
    inputSeqRef.current = inputSeq;
    try {
      const sent = wsSend.current.send({
        type: "terminal-input",
        sessionId: session.id,
        clientId: clientIdRef.current,
        inputSeq,
        data,
        ...(lastTerminalSizeRef.current ?? {}),
      });
      if (!sent) {
        warnSendFailed("terminal input");
        return false;
      }
      termRef.current?.markInputEnqueued?.(inputSeq);
      trackInputAck(inputSeq);
      return true;
    } catch (err) {
      console.error("Send key failed:", err);
      warnSendFailed("terminal input");
      return false;
    }
  }, [session.id, terminalDetached, terminalFastLane, trackInputAck, warnSendFailed, wsSend]);

  const sendTextToHarness = useCallback(async (
    text: string,
    deliveryId?: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    if (
      terminalDetached ||
      !terminalFastLane ||
      !connected ||
      !wsSend.current?.send
    ) {
      warnSendFailed("harness instruction");
      return { ok: false, error: "Terminal is not connected" };
    }

    const inputSeq = inputSeqRef.current + 1;
    inputSeqRef.current = inputSeq;
    const normalizedText = sanitizeTerminalPasteText(text);
    const data = `\u001b[200~${normalizedText}\u001b[201~\r`;

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingInputAckPromisesRef.current.delete(inputSeq);
        resolve({ ok: false, error: "Timed out waiting for terminal ACK" });
      }, 15_000);
      pendingInputAckPromisesRef.current.set(inputSeq, { resolve, timer });
      try {
        const sent = wsSend.current?.send({
          type: "terminal-input",
          sessionId: session.id,
          clientId: clientIdRef.current,
          inputSeq,
          data,
          ...(deliveryId ? { deliveryId } : {}),
          ...(lastTerminalSizeRef.current ?? {}),
        });
        if (!sent) {
          clearTimeout(timer);
          pendingInputAckPromisesRef.current.delete(inputSeq);
          warnSendFailed("harness instruction");
          resolve({ ok: false, error: "Terminal send failed" });
          return;
        }
        termRef.current?.markInputEnqueued?.(inputSeq);
        trackInputAck(inputSeq);
      } catch (error) {
        clearTimeout(timer);
        pendingInputAckPromisesRef.current.delete(inputSeq);
        console.error("Send harness instruction failed:", error);
        warnSendFailed("harness instruction");
        resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }, [connected, session.id, terminalDetached, terminalFastLane, trackInputAck, warnSendFailed, wsSend]);

  const sendTerminalControl = useCallback((
    action: "resize" | "abort",
    size?: { cols: number; rows: number },
    request?: TerminalResizeRequest,
  ): boolean => {
    if (!terminalFastLane || !wsSend.current?.send) {
      // Dropped resizes self-heal on reconnect (the terminal re-fits and
      // re-sends its size); aborts must be visible.
      if (action === "abort") warnSendFailed("abort");
      return false;
    }
    const controlSeq = controlSeqRef.current + 1;
    controlSeqRef.current = controlSeq;
    try {
      const sent = wsSend.current.send({
        type: "terminal-control",
        sessionId: session.id,
        clientId: clientIdRef.current,
        controlSeq,
        action,
        ...(size ? { cols: size.cols, rows: size.rows } : {}),
        ...(request?.claim !== undefined ? { claim: request.claim } : {}),
      });
      if (!sent) {
        if (action === "abort") warnSendFailed("abort");
        return false;
      }
      trackControlAck(controlSeq, action);
      return true;
    } catch (err) {
      console.error("Send terminal control failed:", err);
      if (action === "abort") warnSendFailed("abort");
      return false;
    }
  }, [session.id, terminalFastLane, trackControlAck, warnSendFailed, wsSend]);

  const sendTerminalResize = useCallback((
    cols: number,
    rows: number,
    request?: TerminalResizeRequest,
  ) => {
    lastTerminalSizeRef.current = { cols, rows };
    sendTerminalControl("resize", { cols, rows }, request);
  }, [sendTerminalControl]);

  const handleTerminalDetach = useCallback(() => {
    wsSend.current?.send?.({
      type: "terminal-detach",
      sessionId: session.id,
      clientId: clientIdRef.current,
    });
    setTerminalDetached(true);
    setTerminalAlert({
      message: "Terminal detached. Switch sessions or reload to reattach.",
      source: "detached",
      tone: "error",
    });
  }, [session.id, wsSend]);

  const handleTerminalRecoveryState = useCallback((state: TerminalRecoveryState) => {
    terminalRecoveryStateRef.current = state;
    setTerminalRecoveryState(state);
  }, []);

  const active = env ? canStopEnvStatus(env.status) : session.active === 1;
  const meta = useMemo(
    () =>
      tryParse(session.metadata) as {
        host?: string;
        cwd?: string;
      } | null,
    [session.metadata],
  );
  const pendingPermissions = permissions.filter((p) => p.status === "pending");
  const displayName = session.tag;
  const showSessionDetails = !env;
  const showStatusBar = !(
    env
    && connected
    && active
    && pendingPermissions.length === 0
  );
  return (
    <div className={`flex min-h-0 flex-1 flex-col overflow-hidden ${env ? "tiller-implementation-session" : ""}`}>
      {showSessionDetails && (
        <div className="px-4 py-2.5 border-b border-kumo-line flex items-center justify-between bg-kumo-recessed">
          <div className="flex items-center gap-3">
            <span
              className={`w-2.5 h-2.5 rounded-full ${active ? "bg-kumo-success" : "bg-kumo-fill"}`}
            />
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold text-kumo-default">
                  {displayName}
                </h2>
              </div>
              {meta?.host && (
                <p className="text-xs text-kumo-subtle">
                  {meta.host}
                  {meta.cwd ? ` : ${meta.cwd}` : ""}
                </p>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {VOICE_DISABLED ? (
              <button
                type="button"
                disabled
                aria-label="Voice unavailable"
                title="Voice sessions are not available"
                className="flex cursor-not-allowed items-center gap-1 rounded border border-kumo-line bg-kumo-base px-2.5 py-1 text-xs text-kumo-subtle opacity-55"
              >
                <MicIcon className="h-3.5 w-3.5" aria-hidden="true" />
                Voice unavailable
              </button>
            ) : !voiceActive && (
              <button
                onClick={handleStartVoice}
                className="text-xs px-2.5 py-1 rounded border border-kumo-line bg-kumo-base hover:bg-kumo-tint text-kumo-subtle transition-colors flex items-center gap-1"
              >
                <MicIcon className="w-3.5 h-3.5" />
                Start Voice
              </button>
            )}
            <button
              onClick={handleClear}
              className="text-xs px-2.5 py-1 rounded border border-kumo-line bg-kumo-base hover:bg-kumo-tint text-kumo-subtle transition-colors"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {/* Terminal + floating permission overlay */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <TerminalView
            ref={termRef}
            session={session}
            hubUrl={hubUrl}
            surface={env ? "implementation" : "default"}
            fontSize={env ? 14 : undefined}
            updateLastSeq={updateLastSeq}
            interactive={
              active &&
              connected &&
              terminalFastLane === true &&
              terminalRecoveryState.status === "ready" &&
              !terminalDetached
            }
            onInput={sendRawKey}
            onResize={sendTerminalResize}
            onRecoveryState={handleTerminalRecoveryState}
            onDetach={handleTerminalDetach}
            onDurableMessageComplete={handleDurableMessageComplete}
            metricsEnabled={terminalMetrics}
          />
          {terminalAlert && (
            <div
              role={terminalAlert.tone === "error" ? "alert" : "status"}
              className={`absolute right-3 top-3 z-40 max-w-md rounded border bg-kumo-elevated px-3 py-2 text-xs shadow-sm ${
                terminalAlert.tone === "error"
                  ? "border-kumo-danger/40 text-kumo-danger"
                  : "border-kumo-warning/40 text-kumo-warning"
              }`}
            >
              {terminalAlert.message}
            </div>
          )}
          {pendingPermissions.length > 0 && (
            <div className="absolute top-3 left-1/2 -translate-x-1/2 z-40 w-full max-w-xl px-3 flex flex-col gap-2">
              {pendingPermissions.map((perm) => (
                <PermissionBanner
                  key={perm.id}
                  permission={perm}
                  hubUrl={hubUrl}
                  sessionId={session.id}
                  onResolved={onPermissionResolved}
                />
              ))}
            </div>
          )}
          {!cliPromptDismissed && (
            <div className="absolute bottom-3 left-1/2 z-20 flex w-[calc(100%-1.5rem)] max-w-2xl -translate-x-1/2 flex-col items-start justify-between gap-2 border border-kumo-line bg-kumo-elevated px-3 py-2 text-xs shadow-sm sm:flex-row sm:items-center sm:gap-3">
              <p className="min-w-0 text-kumo-subtle">
                Have you tried the tiller cli? Install with{" "}
                <code className="break-all rounded border border-kumo-line bg-kumo-base px-1 py-0.5 text-[11px] text-kumo-default">
                  npm install -g @paperwing-dev/tiller
                </code>
                .
              </p>
              <button
                type="button"
                onClick={handleDismissCliPrompt}
                className="shrink-0 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              >
                Dismiss
              </button>
            </div>
          )}
        </div>

        {/* Voice agent panel */}
        {(voiceActive || voiceIsInCall) && (
          <VoiceAgent
            status={status}
            transcript={transcript}
            interimTranscript={interimTranscript}
            audioLevel={audioLevel}
            metrics={metrics}
            tillerStatus={tillerStatus}
            error={voiceError}
            connected={voiceConnected}
            debugEnabled={voiceDebugEnabled}
            debugCopyState={debugCopyState}
            debugEvents={voiceDebugEvents}
            onEnd={handleStopVoice}
            onCopyDebug={handleCopyVoiceDebug}
            onToggleDebug={handleToggleVoiceDebug}
            onToggleMute={toggleMute}
            isMuted={isMuted}
          />
        )}

        {env?.slug && env.repoId && (
          <EnvReviewPanel
            envSlug={env.slug}
            repoId={env.repoId}
            sessionId={session.id}
            hubUrl={hubUrl}
            harnessInputReady={
              active &&
              connected &&
              terminalFastLane &&
              !terminalDetached
            }
            onSendToHarness={sendTextToHarness}
            onLayoutChange={handleReviewLayoutChange}
          />
        )}
      </div>

      {/* Status bar */}
      {showStatusBar && <StatusBar
        connected={connected}
        sessionActive={active}
        pendingPermissions={pendingPermissions.length}
      />}

    </div>
  );
}

function MicIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function tryParse(json: string): unknown {
  if (!json) return null;
  try {
    return typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return null;
  }
}

// Strip ANSI escape codes for clean text to send to the LLM
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
}

function normalizeOutputForSpeech(str: string): string {
  const cleaned = stripAnsi(str)
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ");

  const lines = cleaned
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !shouldIgnoreSpeechLine(line));

  return lines
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function shouldIgnoreSpeechLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;

  // Shell prompts and local echoes.
  if (/^>\s+/.test(normalized)) return true;
  if (/^\$\s+/.test(normalized)) return true;
  if (/^\s*abort sent\s*$/i.test(normalized)) return true;

  // Progress-only chatter from Claude Code / terminal activity.
  if (
    /^(reading|searching|thinking|planning|cooking|writing|editing|updating|analyzing|checking|running|executing|reviewing|exploring|fetching|building|installing|loading|resolving|scanning|opening|creating|deleting|moving|renaming|summarizing)\b/i.test(
      normalized,
    ) &&
    normalized.length <= 120
  ) {
    return true;
  }

  // Short status lines like "3 files", "12 matches", "Done", etc.
  if (/^\d+\s+(files?|results?|matches?|edits?|changes?)\b/i.test(normalized)) {
    return true;
  }
  if (/^(done|complete|completed|success|succeeded|ok)$/i.test(normalized)) {
    return true;
  }

  // Tool/status headings that are usually not meaningful aloud.
  if (/^(tool use|status|progress|thinking|working)[:\-]?$/i.test(normalized)) {
    return true;
  }

  return false;
}
