import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { MutableRefObject } from "react";
import type { StoredSession, StoredPermission, EnvMeta } from "../api/types";
import { stopEnv, type LiveMessage, type ReconnectingWebSocket } from "./api";
import type { TerminalViewHandle } from "./TerminalView";
import TerminalView from "./TerminalView";
import PermissionBanner from "./PermissionBanner";
import StatusBar from "./StatusBar";
import VoiceAgent from "./VoiceAgent";
import { useVoiceAgent } from "@cloudflare/voice/react";
import type { UseVoiceAgentReturn } from "@cloudflare/voice/react";
import { getEnvAuthBadge, getEnvModelBadge, getLeadHarnessBadge, getHarnessBadgeClass, getHarnessBadgeLabel } from "./env-harness";
import { canStopEnvStatus } from "./env-runtime";

interface SessionViewProps {
  session: StoredSession;
  env?: Pick<
    EnvMeta,
    | "slug"
    | "status"
    | "harness"
    | "resolvedAuthMode"
    | "authMode"
    | "codexAuthMode"
    | "opencodeProvider"
    | "opencodeModel"
    | "leadHarnessStatus"
  > | null;
  hubUrl: string;
  onWsMessage: MutableRefObject<((msg: LiveMessage) => void) | null>;
  wsSend: MutableRefObject<ReconnectingWebSocket | null>;
  connected: boolean;
  updateLastSeq: (sessionId: string, seq: number) => void;
  permissions?: StoredPermission[];
  onPermissionResolved: (permId: string) => void;
  onRecoverEnv?: (slug: string, status?: string) => void;
}

export default function SessionView({
  session,
  env,
  hubUrl,
  onWsMessage,
  wsSend,
  connected,
  updateLastSeq,
  permissions = [],
  onPermissionResolved,
  onRecoverEnv,
}: SessionViewProps) {
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const termRef = useRef<TerminalViewHandle>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const termOutputBufferRef = useRef("");
  const summarizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSummarySentAtRef = useRef(0);
  const awaitingClaudeSummaryRef = useRef(false);

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
  const [envActionBusy, setEnvActionBusy] = useState(false);

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
    if (msg.type === "debug" && msg.stage) {
      setVoiceDebugEvents((events) =>
        [
          ...events,
          {
            timestamp: msg.timestamp ?? Date.now(),
            stage: msg.stage,
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

  const handleToggleVoiceDebug = useCallback(() => {
    setVoiceDebugEnabled((enabled) => !enabled);
  }, []);

  // Route live WS messages to the terminal via the proven callback path
  useEffect(() => {
    onWsMessage.current = (msg) => {
      console.log('[debug] SessionView saw:', msg.sessionId, 'current:', session.id, 'seq:', msg.seq, 'termRef?', !!termRef.current);
      if (msg.sessionId !== session.id) return;
      const content =
        typeof msg.content === "string" ? tryParse(msg.content) : msg.content;
      const c = content as { type?: string; data?: string } | null;
      console.log('[debug] SessionView parsed type:', c?.type, 'hasData:', !!c?.data);
      if (c?.type === "terminal-output" && c.data) {
        if (msg.seq != null) {
          termRef.current?.writeMessage(c.data, msg.seq);
        } else {
          termRef.current?.write(c.data);
        }

        // Buffer terminal output for auto-speak when voice is active
        if (voiceActiveRef.current && awaitingClaudeSummaryRef.current) {
          termOutputBufferRef.current += stripAnsi(c.data);

          // Debounce pauses in output so short Claude replies are spoken quickly.
          if (summarizeTimerRef.current)
            clearTimeout(summarizeTimerRef.current);
          summarizeTimerRef.current = setTimeout(flushBufferedOutput, 4000);
        }
      }
      // Track seq for gap-fill
      if (msg.seq != null) {
        updateLastSeq(session.id, msg.seq);
      }
    };
    return () => {
      onWsMessage.current = null;
    };
  }, [flushBufferedOutput, session.id, onWsMessage, updateLastSeq]);

  // Clear send error when connection restores
  useEffect(() => {
    if (connected) setSendError(null);
  }, [connected]);

  // Focus the message input when switching into a session so the user can type
  // immediately. Terminal still takes focus on mousedown for raw-key input.
  useEffect(() => {
    textareaRef.current?.focus();
  }, [session.id]);

  const cancelSummarizeTimer = () => {
    if (summarizeTimerRef.current) {
      clearTimeout(summarizeTimerRef.current);
      summarizeTimerRef.current = null;
    }
    termOutputBufferRef.current = "";
  };

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

  const sendRawKey = useCallback((data: string): boolean => {
    if (!wsSend.current?.send) {
      return false;
    }
    try {
      wsSend.current.send({
        type: "message",
        id: crypto.randomUUID(),
        sessionId: session.id,
        content: {
          role: "user",
          type: "user-input",
          data,
        },
      });
      return true;
    } catch (err) {
      console.error("Send key failed:", err);
      return false;
    }
  }, [session.id, wsSend]);

  const sendTerminalResize = useCallback((cols: number, rows: number) => {
    if (!wsSend.current?.send) return;
    try {
      wsSend.current.send({
        type: "message",
        id: crypto.randomUUID(),
        sessionId: session.id,
        content: {
          type: "resize",
          data: JSON.stringify({ cols, rows }),
        },
      });
    } catch (err) {
      console.error("Send resize failed:", err);
    }
  }, [session.id, wsSend]);

  const handleSend = () => {
    const text = input.trim();
    if (!text || sending) return;

    cancelSummarizeTimer();

    if (!wsSend.current?.send) {
      setSendError("Not connected \u2014 message not sent");
      return;
    }

    setSendError(null);
    setSending(true);
    setInput("");
    // Reset textarea height after clearing
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    // Echo input to terminal so user sees what they sent
    termRef.current?.write(`\r\n\x1b[36m> ${text}\x1b[0m\r\n`);

    if (!sendRawKey(text.replace(/\n/g, "\r") + "\r")) {
      setInput(text);
      setSendError("Send failed \u2014 please try again");
    }
    setSending(false);
  };

  const handleAbort = () => {
    if (!wsSend.current?.send) return;
    try {
      wsSend.current.send({
        type: "message",
        id: crypto.randomUUID(),
        sessionId: session.id,
        content: { type: "abort" },
      });
      termRef.current?.write("\r\n\x1b[31m[Abort sent]\x1b[0m\r\n");
    } catch (err) {
      console.error("Abort failed:", err);
    }
  };

  const selectPaletteCommand = (name: string) => {
    if (!wsSend.current?.send) {
      setSendError("Not connected \u2014 command not sent");
      return;
    }
    const text = `/${name}`;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    termRef.current?.write(`\r\n\x1b[36m> ${text}\x1b[0m\r\n`);
    if (!sendRawKey(text.replace(/\n/g, "\r") + "\r")) {
      setSendError("Send failed \u2014 please try again");
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showPalette && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPaletteIndex((i) => Math.min(i + 1, filteredCommands.length - 1));
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setPaletteIndex((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selectPaletteCommand(filteredCommands[clampedIndex].name);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setInput(`/${filteredCommands[clampedIndex].name}`);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setInput("");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    setPaletteIndex(0);
    e.target.style.height = "auto";
    e.target.style.height = e.target.scrollHeight + "px";
  };

  const active = env ? canStopEnvStatus(env.status) : session.active === 1;
  const meta = useMemo(
    () =>
      tryParse(session.metadata) as {
        host?: string;
        cwd?: string;
        slashCommands?: { name: string; description: string }[];
      } | null,
    [session.metadata],
  );
  const pendingPermissions = permissions.filter((p) => p.status === "pending");
  const harness = env?.harness ?? null;
  const authBadge = env ? getEnvAuthBadge(env) : null;
  const modelBadge = env ? getEnvModelBadge(env) : null;
  const harnessBadge = env ? getLeadHarnessBadge(env) : null;
  const envStatus = env?.status ?? "unknown";
  const envCanStop =
    !!env?.slug &&
    canStopEnvStatus(envStatus);

  // Slash command palette
  const showPalette = input.startsWith("/") && !input.includes(" ");
  const paletteFilter = input.slice(1).toLowerCase();
  const filteredCommands = useMemo(() => {
    if (!meta?.slashCommands?.length || !showPalette) return [];
    return meta.slashCommands.filter((cmd) =>
      cmd.name.toLowerCase().startsWith(paletteFilter),
    );
  }, [meta?.slashCommands, showPalette, paletteFilter]);
  const clampedIndex = Math.min(paletteIndex, Math.max(filteredCommands.length - 1, 0));

  const handleStopEnv = useCallback(async () => {
    if (!env?.slug || envActionBusy) return;
    setEnvActionBusy(true);
    try {
      const res = await stopEnv(hubUrl, env.slug);
      onRecoverEnv?.(env.slug, res.status);
    } catch (err) {
      console.error("[tiller] env stop failed:", err);
      alert(err instanceof Error ? err.message : "Failed to stop environment.");
    } finally {
      setEnvActionBusy(false);
    }
  }, [env, envActionBusy, hubUrl, onRecoverEnv]);

  return (
    <>
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-[#d0d7de] flex items-center justify-between bg-[#f6f8fa]">
        <div className="flex items-center gap-3">
          <span
            className={`w-2.5 h-2.5 rounded-full ${active ? "bg-green-500" : "bg-[#d0d7de]"}`}
          />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#24292f]">
                {session.tag}
              </h2>
              {harness && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${getHarnessBadgeClass(harness)}`}>
                  {getHarnessBadgeLabel(harness)}
                </span>
              )}
              {authBadge && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${authBadge.className}`}>
                  {authBadge.label}
                </span>
              )}
              {modelBadge && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${modelBadge.className}`}>
                  {modelBadge.label}
                </span>
              )}
              {harnessBadge && (
                <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${harnessBadge.className}`}>
                  {harnessBadge.label}
                </span>
              )}
            </div>
            {meta?.host && (
              <p className="text-xs text-[#57606a]">
                {meta.host}
                {meta.cwd ? ` : ${meta.cwd}` : ""}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {envCanStop && (
            <button
              onClick={handleStopEnv}
              disabled={envActionBusy}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors disabled:opacity-40"
            >
              Stop
            </button>
          )}
          {!VOICE_DISABLED && !voiceActive && (
            <button
              onClick={handleStartVoice}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors flex items-center gap-1"
            >
              <MicIcon className="w-3.5 h-3.5" />
              Start Voice
            </button>
          )}
          <button
            onClick={handleClear}
            className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
          >
            Clear
          </button>
        </div>
      </div>

      {/* Terminal + floating permission overlay */}
      <div className="flex-1 min-h-0 relative flex flex-col">
        <TerminalView
          ref={termRef}
          session={session}
          hubUrl={hubUrl}
          updateLastSeq={updateLastSeq}
          interactive={active && connected}
          onInput={sendRawKey}
          onResize={sendTerminalResize}
        />
        {pendingPermissions.length > 0 && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 w-full max-w-xl px-3 flex flex-col gap-2">
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

      {/* Status bar */}
      <StatusBar
        connected={connected}
        sessionActive={active}
        pendingPermissions={pendingPermissions.length}
      />

      {/* Input */}
      <div className="p-3 border-t border-[#d0d7de] bg-[#f6f8fa] relative">
        {showPalette && filteredCommands.length > 0 && (
          <div className="absolute bottom-full left-3 right-3 mb-1 bg-white border border-[#d0d7de] rounded-lg shadow-lg max-h-52 overflow-y-auto z-10">
            {filteredCommands.map((cmd, i) => (
              <button
                key={cmd.name}
                onClick={() => selectPaletteCommand(cmd.name)}
                onMouseEnter={() => setPaletteIndex(i)}
                className={`w-full text-left px-3 py-2 text-sm flex items-baseline gap-2 ${
                  i === clampedIndex
                    ? "bg-[#0969da] text-white"
                    : "text-[#24292f] hover:bg-[#f6f8fa]"
                }`}
              >
                <span className="font-mono font-medium">/{cmd.name}</span>
                {cmd.description && (
                  <span
                    className={`text-xs truncate ${
                      i === clampedIndex ? "text-white/70" : "text-[#57606a]"
                    }`}
                  >
                    {cmd.description}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
        {sendError && <p className="text-red-600 text-xs mb-2">{sendError}</p>}
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            placeholder={
              !connected
                ? "Reconnecting..."
                : active
                  ? "Type a message\u2026 (Shift+Enter for newline)"
                  : "Session inactive"
            }
            disabled={!active || sending || !connected}
            rows={1}
            className="flex-1 bg-white border border-[#d0d7de] rounded px-3 py-2 text-sm text-[#24292f] placeholder:text-[#6e7781] overflow-hidden disabled:opacity-50 focus:outline-none focus:border-[#0969da] focus:ring-1 focus:ring-[#0969da]/30 transition-colors max-h-40"
          />
          {active && connected && (
            <>
              <button
                onClick={() => sendRawKey("\x1b[A")}
                className="rounded px-2 py-2 text-sm font-medium border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
                title="Up arrow"
              >
                &#x25B2;
              </button>
              <button
                onClick={() => sendRawKey("\x1b[B")}
                className="rounded px-2 py-2 text-sm font-medium border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
                title="Down arrow"
              >
                &#x25BC;
              </button>
              <button
                onClick={() => sendRawKey("\r")}
                className="rounded px-3 py-2 text-sm font-medium border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
                title="Send Enter keystroke"
              >
                Enter &#x23CE;
              </button>
              <button
                onClick={handleAbort}
                className="bg-red-600 hover:bg-red-700 rounded px-3 py-2 text-sm font-medium text-white transition-colors"
                title="Send Ctrl+C to abort"
              >
                Abort
              </button>
            </>
          )}
          <button
            onClick={handleSend}
            disabled={!active || sending || !input.trim() || !connected}
            className="bg-[#0969da] hover:bg-[#0a5bc4] rounded px-4 py-2 text-sm font-medium text-white disabled:opacity-40 transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </>
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
