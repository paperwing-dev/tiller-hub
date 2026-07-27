import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { StoredSession } from "../api/types";
import { fetchMessages } from "./api";
import { useResolvedTheme } from "./theme";
import {
  TerminalRecoveryController,
  type DurableTerminalMessage,
  type TerminalRecoveryState,
} from "./terminal-recovery";
import LoadingIndicator from "./LoadingIndicator";

export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;

// LRU cache for serialized terminal state (max 8 sessions)
const MAX_CACHE = 8;
const terminalCache = new Map<string, { serialized: string; lastSeq: number }>();
const RECENT_OUTPUT_NOTICE = "Showing recent output; older missed output was skipped.";

function cacheSet(sessionId: string, serialized: string, lastSeq: number) {
  terminalCache.delete(sessionId); // re-insert at end for LRU order
  terminalCache.set(sessionId, { serialized, lastSeq });
  if (terminalCache.size > MAX_CACHE) {
    const oldest = terminalCache.keys().next().value;
    terminalCache.delete(oldest!);
  }
}

export interface TerminalViewHandle {
  acceptMessage: (message: DurableTerminalMessage) => void;
  recover: () => void;
  clear: () => void;
}

interface TerminalViewProps {
  session: StoredSession;
  hubUrl: string;
  fontSize?: number;
  updateLastSeq?: (sessionId: string, seq: number) => void;
  interactive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  onRecoveryState?: (state: TerminalRecoveryState) => void;
  onDetach?: () => void;
  onDurableMessageComplete?: (message: DurableTerminalMessage) => void;
}

export function getTerminalTheme(mode: "light" | "dark" = "light") {
  if (mode === "dark") {
    return {
      background: "#1c1c1c",
      foreground: "#e6e6e6",
      cursor: "#58a6ff",
      cursorAccent: "#1c1c1c",
      selectionBackground: "rgba(88, 166, 255, 0.25)",
      black: "#484f58",
      red: "#ff7b72",
      green: "#3fb950",
      yellow: "#d29922",
      blue: "#58a6ff",
      magenta: "#bc8cff",
      cyan: "#39c5cf",
      white: "#b1bac4",
      brightBlack: "#6e7681",
      brightRed: "#ffa198",
      brightGreen: "#56d364",
      brightYellow: "#e3b341",
      brightBlue: "#79c0ff",
      brightMagenta: "#d2a8ff",
      brightCyan: "#56d4dd",
      brightWhite: "#f0f6fc",
    };
  }
  return {
    background: "#ffffff",
    foreground: "#24292f",
    cursor: "#0969da",
    cursorAccent: "#ffffff",
    selectionBackground: "rgba(9, 105, 218, 0.15)",
    black: "#24292f",
    red: "#cf222e",
    green: "#1a7f37",
    yellow: "#9a6700",
    blue: "#0969da",
    magenta: "#8250df",
    cyan: "#0969da",
    white: "#6e7781",
    brightBlack: "#57606a",
    brightRed: "#a40e26",
    brightGreen: "#116329",
    brightYellow: "#7d4e00",
    brightBlue: "#218bff",
    brightMagenta: "#a475f9",
    brightCyan: "#3192aa",
    brightWhite: "#24292f",
  };
}

export default forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  {
    session,
    hubUrl,
    fontSize = 15,
    updateLastSeq,
    interactive = false,
    onInput,
    onResize,
    onRecoveryState,
    onDetach,
    onDurableMessageComplete,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const recoveryRef = useRef<TerminalRecoveryController | null>(null);
  const lastSeqRef = useRef(0);
  const stableSerializedRef = useRef("");
  const fallbackSessionRef = useRef(session.id);
  const fallbackAttemptedRef = useRef(false);
  const fallbackPendingRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const userScrolledUpRef = useRef(false);
  const interactiveRef = useRef(interactive);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const onRecoveryStateRef = useRef(onRecoveryState);
  const onDurableMessageCompleteRef = useRef(onDurableMessageComplete);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const resolvedTheme = useResolvedTheme();

  interactiveRef.current = interactive;
  onInputRef.current = onInput;
  onResizeRef.current = onResize;
  onRecoveryStateRef.current = onRecoveryState;
  onDurableMessageCompleteRef.current = onDurableMessageComplete;

  if (fallbackSessionRef.current !== session.id) {
    fallbackSessionRef.current = session.id;
    fallbackAttemptedRef.current = false;
    fallbackPendingRef.current = false;
  }

  useEffect(() => {
    setHistoryNotice(null);
  }, [session.id]);

  // Re-theme the live terminal when the app theme changes.
  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(resolvedTheme);
    }
  }, [resolvedTheme]);

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
    setShowNewOutput(false);
    userScrolledUpRef.current = false;
  }, []);

  const recover = useCallback(() => {
    const controller = recoveryRef.current;
    if (!controller) return;
    const state = controller.recoveryState;
    if (state.status !== "fault") {
      controller.recoverGap();
      return;
    }
    if (state.code === "fetch_failed" || state.code === "deadline") controller.retry();
  }, []);

  useEffect(() => {
    if (!interactive || !lastSizeRef.current) return;
    onResize?.(lastSizeRef.current.cols, lastSizeRef.current.rows);
  }, [interactive, onResize]);

  useImperativeHandle(ref, () => ({
    acceptMessage: (message) => recoveryRef.current?.acceptLive(message),
    recover,
    clear: () => {
      termRef.current?.clear();
      try {
        stableSerializedRef.current = serializeRef.current?.serialize() ?? "";
      } catch {
        // A user clear remains local even if serialization is unavailable.
      }
    },
  }), [recover]);

  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) recover();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [recover]);

  // Effect: Terminal setup + replay (depends on session.id and hubUrl)
  useEffect(() => {
    if (!containerRef.current) return;

    lastSeqRef.current = 0;
    stableSerializedRef.current = "";
    userScrolledUpRef.current = false;
    setHistoryError(null);
    setShowNewOutput(false);
    lastSizeRef.current = null;

    const term = new Terminal({
      cols: 120,
      rows: 40,
      theme: getTerminalTheme(document.documentElement.dataset.mode === "dark" ? "dark" : "light"),
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
      fontSize,
      scrollback: 10000,
      convertEol: false,
      disableStdin: false,
      cursorBlink: false,
    });

    const fitAddon = new FitAddon();
    const serializeAddon = new SerializeAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(serializeAddon);
    term.open(containerRef.current);
    fitAddon.fit();
    const reportSize = () => {
      const cols = term.cols;
      const rows = term.rows;
      const previous = lastSizeRef.current;
      if (previous?.cols === cols && previous?.rows === rows) {
        return;
      }
      lastSizeRef.current = { cols, rows };
      onResizeRef.current?.(cols, rows);
    };
    reportSize();
    termRef.current = term;
    serializeRef.current = serializeAddon;

    const viewportEl = containerRef.current.querySelector(".xterm-viewport");
    let resizeFrame: number | null = null;
    const scheduleFit = () => {
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        const activeBuffer = term.buffer.active;
        const wasFollowingOutput = !userScrolledUpRef.current
          && activeBuffer.viewportY >= activeBuffer.baseY;
        fitAddon.fit();
        if (wasFollowingOutput) term.scrollToBottom();
        reportSize();
      });
    };
    window.addEventListener("resize", scheduleFit);
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(scheduleFit)
      : null;
    resizeObserver?.observe(containerRef.current);
    const inputDisposable = term.onData((data) => {
      if (!interactiveRef.current) return;
      onInputRef.current?.(data);
    });
    const focusTerminal = () => term.focus();
    containerRef.current.addEventListener("mousedown", focusTerminal);

    // Scroll detection via xterm viewport
    let scrollHandler: (() => void) | null = null;
    if (viewportEl) {
      scrollHandler = () => {
        const { scrollTop, scrollHeight, clientHeight } = viewportEl as HTMLElement;
        const atBottom = scrollHeight - scrollTop - clientHeight < 20;
        if (atBottom) {
          userScrolledUpRef.current = false;
          setShowNewOutput(false);
        } else {
          userScrolledUpRef.current = true;
        }
      };
      viewportEl.addEventListener("scroll", scrollHandler);
    }

    let cancelled = false;

    const restoreStableScreen = (callback: () => void) => {
      if (cancelled) {
        callback();
        return;
      }
      term.reset();
      if (stableSerializedRef.current) {
        term.write(stableSerializedRef.current, callback);
      } else {
        callback();
      }
    };
    const captureStableScreen = () => {
      if (cancelled) return;
      try {
        stableSerializedRef.current = serializeAddon.serialize();
      } catch {
        // Keep the preceding stable serialization as the rollback point.
      }
    };
    const terminalMetricsEnabled = (() => {
      try { return window.localStorage.getItem("tiller:terminal-metrics") === "true"; }
      catch { return false; }
    })();
    const parseSamples: number[] = [];
    let peakRecoveryMessages = 0;
    let peakRecoveryBytes = 0;
    const reportParseSample = (durationMs: number) => {
      if (!terminalMetricsEnabled) return;
      parseSamples.push(durationMs);
      if (parseSamples.length < 256) return;
      const sorted = [...parseSamples].sort((left, right) => left - right);
      const at = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
      console.info("[tiller] terminal metrics", {
        label: "browser_xterm_parse",
        count: sorted.length,
        p50Ms: at(0.5),
        p95Ms: at(0.95),
        p99Ms: at(0.99),
        peakRecoveryMessages,
        peakRecoveryBytes,
      });
      parseSamples.length = 0;
      peakRecoveryMessages = 0;
      peakRecoveryBytes = 0;
    };
    const normalizeFetched = async (opts: {
      limit: number;
      afterSeq?: number;
      maxBytes: number;
      signal: AbortSignal;
      onBytes(receivedBytes: number): void;
    }) => {
      const messages = await fetchMessages(hubUrl, session.id, opts);
      return messages.map((message): DurableTerminalMessage => ({
        id: message.id,
        sessionId: message.session_id,
        seq: message.seq,
        content: message.content,
        ...(message.local_id !== null ? { localId: message.local_id } : {}),
      }));
    };
    const recovery = new TerminalRecoveryController({
      sessionId: session.id,
      fetchPage: normalizeFetched,
      write: (message, callback) => {
        const content = message.content as { type?: string; data?: string } | null;
        const data = content?.type === "terminal-output" && typeof content.data === "string"
          ? content.data
          : "";
        const parseStartedAt = performance.now();
        term.write(data, () => {
          reportParseSample(performance.now() - parseStartedAt);
          if (data && userScrolledUpRef.current) setShowNewOutput(true);
          onDurableMessageCompleteRef.current?.(message);
          callback();
        });
      },
      onSequenceComplete: (seq) => {
        if (cancelled || seq <= lastSeqRef.current) return;
        lastSeqRef.current = seq;
        updateLastSeq?.(session.id, seq);
      },
      onStateChange: (state) => {
        if (cancelled) return;
        if (
          state.status === "fault" &&
          (state.code === "overflow" || state.code === "deadline") &&
          !fallbackAttemptedRef.current
        ) {
          fallbackAttemptedRef.current = true;
          fallbackPendingRef.current = true;
          terminalCache.delete(session.id);
          setHistoryError(null);
          setLoading(true);
          onRecoveryStateRef.current?.({ status: "recovering" });
          setRecoveryEpoch((epoch) => epoch + 1);
          return;
        }
        onRecoveryStateRef.current?.(state);
        setLoading(state.status === "recovering");
        if (state.status === "ready" && fallbackPendingRef.current) {
          fallbackPendingRef.current = false;
          fallbackAttemptedRef.current = false;
          setHistoryNotice(RECENT_OUTPUT_NOTICE);
        }
        setHistoryError(state.status === "fault"
          ? `Terminal recovery stopped (${state.code.replace("_", " ")}).`
          : null);
      },
      onStableWriteComplete: captureStableScreen,
      restoreStableScreen,
      onQueueUsage: (messages, bytes) => {
        peakRecoveryMessages = Math.max(peakRecoveryMessages, messages);
        peakRecoveryBytes = Math.max(peakRecoveryBytes, bytes);
      },
      onSettled: (lastSeq) => {
        if (cancelled) return;
        captureStableScreen();
        cacheSet(session.id, stableSerializedRef.current, lastSeq);
      },
    });
    recoveryRef.current = recovery;

    const cached = terminalCache.get(session.id);
    if (cached) {
      recovery.startCacheRestore(
        cached.lastSeq,
        new TextEncoder().encode(cached.serialized).byteLength,
        (callback) => term.write(cached.serialized, callback),
      );
    } else {
      void recovery.startCold();
    }

    return () => {
      cancelled = true;
      recovery.dispose();
      recoveryRef.current = null;
      if (viewportEl && scrollHandler) {
        viewportEl.removeEventListener("scroll", scrollHandler);
      }
      inputDisposable.dispose();
      containerRef.current?.removeEventListener("mousedown", focusTerminal);
      window.removeEventListener("resize", scheduleFit);
      resizeObserver?.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      term.dispose();
      termRef.current = null;
      serializeRef.current = null;
    };
  }, [session.id, hubUrl, fontSize, updateLastSeq, recoveryEpoch]);

  return (
    <div className="flex-1 min-h-0 overflow-hidden relative">
      <div
        ref={containerRef}
        className={`absolute inset-0 px-2 py-1 ${resolvedTheme === "dark" ? "bg-[#1c1c1c]" : "bg-white"}`}
      />
      {loading && (
        <LoadingIndicator label="Loading terminal history" className="pointer-events-none absolute inset-0" />
      )}
      {historyError && (
        <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-kumo-base/90 text-kumo-danger text-sm">
          <span>{historyError}</span>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-kumo-default hover:bg-kumo-tint"
              onClick={() => recoveryRef.current?.retry()}
            >
              Retry
            </button>
            {onDetach && (
              <button
                type="button"
                className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-kumo-subtle hover:bg-kumo-tint"
                onClick={onDetach}
              >
                Detach
              </button>
            )}
          </div>
        </div>
      )}
      {historyNotice && !historyError && (
        <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded border border-kumo-warning/40 bg-kumo-elevated px-3 py-1.5 text-xs text-kumo-subtle shadow-sm">
          {historyNotice}
        </div>
      )}
      {showNewOutput && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-kumo-base hover:bg-kumo-tint text-kumo-subtle text-xs px-3 py-1.5 rounded-full shadow-md border border-kumo-line transition-colors z-10"
        >
          New output &darr;
        </button>
      )}
    </div>
  );
});
