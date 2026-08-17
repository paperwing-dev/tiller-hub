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
  type TerminalRecoveryFaultCode,
  type TerminalRecoveryState,
} from "./terminal-recovery";
import { BrowserTerminalMetricRecorder } from "./browser-terminal-metrics";
import LoadingIndicator from "./LoadingIndicator";

export const TERMINAL_MINIMUM_CONTRAST_RATIO = 4.5;
export const TERMINAL_DEFAULT_FONT_SIZE = 12;
export const TERMINAL_FONT_SIZE_STORAGE_KEY = "tiller:terminal-font-size";

const TERMINAL_FONT_SIZE_CHANGE_EVENT = "tiller:terminal-font-size-change";
const TERMINAL_MIN_FONT_SIZE = 8;
const TERMINAL_MAX_FONT_SIZE = 24;
export const TERMINAL_CHECKPOINT_INTERVAL_MS = 2_000;
const MAX_PENDING_INPUT_METRIC_SAMPLES = 1_024;
const RECENT_OUTPUT_NOTICE_DURATION_MS = 8_000;
const RECENT_OUTPUT_NOTICE = "Showing recent output; older terminal output was skipped.";

// LRU cache for serialized terminal state (max 8 sessions)
const MAX_CACHE = 8;
interface TerminalCheckpoint {
  serialized: string;
  seq: number;
}

const terminalCache = new Map<string, TerminalCheckpoint>();

type TerminalFontSizeShortcut = "increase" | "decrease" | "reset";

function clampTerminalFontSize(value: number): number {
  return Math.min(TERMINAL_MAX_FONT_SIZE, Math.max(TERMINAL_MIN_FONT_SIZE, Math.round(value)));
}

function readTerminalFontSize(defaultFontSize: number): number {
  try {
    const stored = window.localStorage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    if (stored !== null) {
      const parsed = Number(stored);
      if (Number.isFinite(parsed)) return clampTerminalFontSize(parsed);
    }
  } catch {
    // Storage may be unavailable in privacy-restricted browser contexts.
  }
  return clampTerminalFontSize(defaultFontSize);
}

function getTerminalFontSizeShortcut(event: KeyboardEvent): TerminalFontSizeShortcut | null {
  if ((!event.metaKey && !event.ctrlKey) || event.altKey) return null;
  if (event.key === "+" || event.key === "=") return "increase";
  if (event.key === "-" || event.key === "_") return "decrease";
  if (event.key === "0") return "reset";
  return null;
}

export function translateTerminalKeyEvent(event: KeyboardEvent): string | null {
  if (
    event.type !== "keydown"
    || event.key !== "Backspace"
    || !event.metaKey
    || event.shiftKey
    || event.altKey
    || event.ctrlKey
    || event.isComposing
  ) {
    return null;
  }
  return "\x15";
}

function cacheSet(sessionId: string, checkpoint: TerminalCheckpoint) {
  terminalCache.delete(sessionId); // re-insert at end for LRU order
  terminalCache.set(sessionId, checkpoint);
  if (terminalCache.size > MAX_CACHE) {
    const oldest = terminalCache.keys().next().value;
    terminalCache.delete(oldest!);
  }
}

function readTerminalMetricsOverride(): boolean {
  try { return window.localStorage.getItem("tiller:terminal-metrics") === "true"; }
  catch { return false; }
}

export interface TerminalViewHandle {
  acceptMessage: (message: DurableTerminalMessage) => void;
  recover: () => void;
  clear: () => void;
  refit: () => void;
  markInputEnqueued: (inputSeq: number) => void;
  markInputAcknowledged: (inputSeq: number, ok: boolean) => void;
}

export interface TerminalResizeRequest {
  /** True takes the controller lease; false reports a passive layout change. */
  claim?: boolean;
}

interface TerminalViewProps {
  session: StoredSession;
  hubUrl: string;
  fontSize?: number;
  surface?: "default" | "implementation";
  updateLastSeq?: (sessionId: string, seq: number) => void;
  interactive?: boolean;
  metricsEnabled?: boolean;
  visible?: boolean;
  onInput?: (data: string) => void;
  onPaste?: (text: string) => void;
  onResize?: (cols: number, rows: number, request?: TerminalResizeRequest) => void;
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
    fontSize = TERMINAL_DEFAULT_FONT_SIZE,
    surface = "default",
    updateLastSeq,
    interactive = false,
    metricsEnabled = false,
    visible = true,
    onInput,
    onPaste,
    onResize,
    onRecoveryState,
    onDetach,
    onDurableMessageComplete,
  },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const recoveryRef = useRef<TerminalRecoveryController | null>(null);
  const lastSeqRef = useRef(0);
  const checkpointRef = useRef<TerminalCheckpoint | null>(null);
  const recentOutputResetSessionRef = useRef<string | null>(null);
  const quietRecoveryRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [historyFault, setHistoryFault] = useState<TerminalRecoveryFaultCode | null>(null);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [recoveryEpoch, setRecoveryEpoch] = useState(0);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const userScrolledUpRef = useRef(false);
  const interactiveRef = useRef(interactive);
  const [metricsOverrideEnabled] = useState(readTerminalMetricsOverride);
  const metricsEnabledRef = useRef(metricsEnabled || metricsOverrideEnabled);
  const visibleRef = useRef(visible);
  const previousVisibleRef = useRef(visible);
  const onInputRef = useRef(onInput);
  const onPasteRef = useRef(onPaste);
  const onResizeRef = useRef(onResize);
  const onRecoveryStateRef = useRef(onRecoveryState);
  const onDurableMessageCompleteRef = useRef(onDurableMessageComplete);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const scheduleClaimRef = useRef<(() => void) | null>(null);
  const scheduleCheckpointRef = useRef<(() => void) | null>(null);
  const recordBrowserMetricRef = useRef<((label: string, durationMs: number) => void) | null>(null);
  const browserMetricRecorderRef = useRef<BrowserTerminalMetricRecorder | null>(null);
  const pendingInputAckMetricsRef = useRef(new Map<number, number>());
  const pendingInputPaintMetricsRef = useRef(new Map<number, number>());
  const resolvedTheme = useResolvedTheme();

  interactiveRef.current = interactive;
  metricsEnabledRef.current = metricsEnabled || metricsOverrideEnabled;
  visibleRef.current = visible;
  onInputRef.current = onInput;
  onPasteRef.current = onPaste;
  onResizeRef.current = onResize;
  onRecoveryStateRef.current = onRecoveryState;
  onDurableMessageCompleteRef.current = onDurableMessageComplete;

  useEffect(() => {
    recentOutputResetSessionRef.current = null;
    setHistoryNotice(null);
  }, [session.id]);

  useEffect(() => {
    if (!historyNotice) return;
    const timer = window.setTimeout(
      () => setHistoryNotice(null),
      RECENT_OUTPUT_NOTICE_DURATION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [historyNotice]);

  useEffect(() => {
    if (metricsEnabledRef.current) return;
    pendingInputAckMetricsRef.current.clear();
    pendingInputPaintMetricsRef.current.clear();
    browserMetricRecorderRef.current?.reset();
  }, [metricsEnabled, metricsOverrideEnabled]);

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

  const restartFromRecentOutput = useCallback(() => {
    const controller = recoveryRef.current;
    if (!controller) return;
    const state = controller.recoveryState;
    if (
      state.status !== "fault"
      || (state.code !== "overflow" && state.code !== "deadline")
    ) return;
    terminalCache.delete(session.id);
    checkpointRef.current = null;
    recentOutputResetSessionRef.current = session.id;
    quietRecoveryRef.current = false;
    setHistoryFault(null);
    setHistoryNotice(null);
    setLoading(true);
    onRecoveryStateRef.current?.({ status: "recovering" });
    setRecoveryEpoch((epoch) => epoch + 1);
  }, [session.id]);

  const retryHistory = useCallback(() => {
    const controller = recoveryRef.current;
    if (!controller) return;
    if (
      controller.recoveryState.status === "fault"
      && controller.recoveryState.code === "overflow"
    ) {
      restartFromRecentOutput();
      return;
    }
    controller.retry();
  }, [restartFromRecentOutput]);

  const recover = useCallback((quiet = false) => {
    const controller = recoveryRef.current;
    if (!controller) return;
    const state = controller.recoveryState;
    if (state.status !== "fault") {
      quietRecoveryRef.current = quiet && state.status === "ready";
      controller.recoverGap();
      return;
    }
    quietRecoveryRef.current = false;
    if (state.code === "fetch_failed" || state.code === "deadline") controller.retry();
  }, []);

  useEffect(() => {
    if (!interactive || !visible || document.hidden || !document.hasFocus()) return;
    scheduleClaimRef.current?.();
  }, [interactive, visible]);

  useEffect(() => {
    const wasVisible = previousVisibleRef.current;
    previousVisibleRef.current = visible;
    if (!wasVisible && visible) {
      scheduleFitRef.current?.();
      if (interactive && !document.hidden && document.hasFocus()) {
        scheduleClaimRef.current?.();
      }
    }
  }, [interactive, visible]);

  useImperativeHandle(ref, () => ({
    acceptMessage: (message) => recoveryRef.current?.acceptLive(message),
    recover: () => recover(false),
    refit: () => scheduleFitRef.current?.(),
    clear: () => {
      termRef.current?.clear();
      scheduleCheckpointRef.current?.();
    },
    markInputEnqueued: (inputSeq) => {
      if (!metricsEnabledRef.current) return;
      const startedAt = performance.now();
      if (pendingInputAckMetricsRef.current.size >= MAX_PENDING_INPUT_METRIC_SAMPLES) {
        const oldest = pendingInputAckMetricsRef.current.keys().next().value;
        if (oldest !== undefined) pendingInputAckMetricsRef.current.delete(oldest);
      }
      if (pendingInputPaintMetricsRef.current.size >= MAX_PENDING_INPUT_METRIC_SAMPLES) {
        const oldest = pendingInputPaintMetricsRef.current.keys().next().value;
        if (oldest !== undefined) pendingInputPaintMetricsRef.current.delete(oldest);
      }
      pendingInputAckMetricsRef.current.set(inputSeq, startedAt);
      pendingInputPaintMetricsRef.current.set(inputSeq, startedAt);
    },
    markInputAcknowledged: (inputSeq, ok) => {
      const startedAt = pendingInputAckMetricsRef.current.get(inputSeq);
      pendingInputAckMetricsRef.current.delete(inputSeq);
      if (!ok) pendingInputPaintMetricsRef.current.delete(inputSeq);
      if (ok && startedAt !== undefined) {
        recordBrowserMetricRef.current?.(
          "browser_input_to_pty_ack",
          performance.now() - startedAt,
        );
      }
    },
  }), [recover]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) return;
      recover(true);
      if (!visibleRef.current) return;
      scheduleFitRef.current?.();
      if (interactiveRef.current && document.hasFocus()) scheduleClaimRef.current?.();
    };
    const onWindowFocus = () => {
      if (document.hidden || !visibleRef.current) return;
      scheduleFitRef.current?.();
      if (interactiveRef.current) scheduleClaimRef.current?.();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onWindowFocus);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, [recover]);

  // Effect: Terminal setup + replay (depends on session.id and hubUrl)
  useEffect(() => {
    if (!containerRef.current) return;

    lastSeqRef.current = 0;
    checkpointRef.current = null;
    pendingInputAckMetricsRef.current.clear();
    pendingInputPaintMetricsRef.current.clear();
    userScrolledUpRef.current = false;
    setLoading(true);
    setHistoryFault(null);
    setShowNewOutput(false);
    lastSizeRef.current = null;

    const defaultFontSize = clampTerminalFontSize(fontSize);
    const term = new Terminal({
      cols: 120,
      rows: 40,
      theme: getTerminalTheme(document.documentElement.dataset.mode === "dark" ? "dark" : "light"),
      minimumContrastRatio: TERMINAL_MINIMUM_CONTRAST_RATIO,
      fontSize: readTerminalFontSize(defaultFontSize),
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
    const reportSize = (claim = false) => {
      const cols = term.cols;
      const rows = term.rows;
      const previous = lastSizeRef.current;
      if (previous?.cols === cols && previous?.rows === rows && !claim) {
        return;
      }
      lastSizeRef.current = { cols, rows };
      onResizeRef.current?.(cols, rows, { claim });
    };
    if (visibleRef.current) {
      fitAddon.fit();
      reportSize(
        interactiveRef.current && !document.hidden && document.hasFocus(),
      );
    }
    termRef.current = term;

    const viewportEl = containerRef.current.querySelector(".xterm-viewport");
    let resizeFrame: number | null = null;
    let pendingFit = false;
    let pendingClaim = false;
    const scheduleUpdate = (fit: boolean, claim: boolean) => {
      if (!visibleRef.current) return;
      pendingFit ||= fit || lastSizeRef.current === null;
      pendingClaim ||=
        claim && interactiveRef.current && !document.hidden && document.hasFocus();
      if (!pendingFit && !pendingClaim) return;
      if (resizeFrame !== null) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = null;
        const fitOnReport = pendingFit;
        const claimOnReport =
          pendingClaim && interactiveRef.current && !document.hidden && document.hasFocus();
        pendingFit = false;
        pendingClaim = false;
        if (!visibleRef.current) return;
        if (fitOnReport) {
          const activeBuffer = term.buffer.active;
          const wasFollowingOutput = !userScrolledUpRef.current
            && activeBuffer.viewportY >= activeBuffer.baseY;
          fitAddon.fit();
          if (wasFollowingOutput) term.scrollToBottom();
        }
        reportSize(claimOnReport);
      });
    };
    const scheduleFit = () => scheduleUpdate(true, false);
    const scheduleClaim = () => scheduleUpdate(false, true);
    const schedulePassiveFit = () => scheduleFit();
    scheduleFitRef.current = scheduleFit;
    scheduleClaimRef.current = scheduleClaim;
    window.addEventListener("resize", schedulePassiveFit);
    const resizeObserver = typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(schedulePassiveFit)
      : null;
    resizeObserver?.observe(containerRef.current);
    const inputDisposable = term.onData((data) => {
      if (!interactiveRef.current) return;
      onInputRef.current?.(data);
    });
    term.attachCustomKeyEventHandler((event) => {
      const translated = translateTerminalKeyEvent(event);
      if (translated === null) return true;

      event.preventDefault();
      event.stopPropagation();
      term.input(translated, true);
      return false;
    });
    const handlePaste = (event: ClipboardEvent) => {
      const paste = onPasteRef.current;
      if (!interactiveRef.current || !paste || !event.clipboardData) return;
      const text = event.clipboardData.getData("text/plain");
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (text) paste(text);
    };
    containerRef.current.addEventListener("paste", handlePaste, true);
    const focusTerminal = () => {
      term.focus();
      scheduleClaim();
    };
    const claimFocusedTerminal = () => scheduleClaim();
    containerRef.current.addEventListener("pointerdown", focusTerminal);
    containerRef.current.addEventListener("focusin", claimFocusedTerminal);

    const applyFontSize = (nextFontSize: number) => {
      const normalized = clampTerminalFontSize(nextFontSize);
      if (term.options.fontSize === normalized) return;
      term.options.fontSize = normalized;
      scheduleFit();
    };
    const persistFontSize = (nextFontSize: number) => {
      try {
        window.localStorage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(nextFontSize));
      } catch {
        // Resizing should still work when browser storage is unavailable.
      }
      window.dispatchEvent(new CustomEvent<number>(TERMINAL_FONT_SIZE_CHANGE_EVENT, {
        detail: nextFontSize,
      }));
    };
    const handleFontSizeShortcut = (event: KeyboardEvent) => {
      const shortcut = getTerminalFontSizeShortcut(event);
      if (!shortcut) return;

      event.preventDefault();
      event.stopPropagation();
      const currentFontSize = typeof term.options.fontSize === "number"
        ? term.options.fontSize
        : defaultFontSize;
      const nextFontSize = shortcut === "reset"
        ? defaultFontSize
        : clampTerminalFontSize(currentFontSize + (shortcut === "increase" ? 1 : -1));
      applyFontSize(nextFontSize);
      persistFontSize(nextFontSize);
    };
    const handleSharedFontSize = (event: Event) => {
      const nextFontSize = (event as CustomEvent<unknown>).detail;
      if (typeof nextFontSize === "number" && Number.isFinite(nextFontSize)) {
        applyFontSize(nextFontSize);
      }
    };
    containerRef.current.addEventListener("keydown", handleFontSizeShortcut, true);
    window.addEventListener(TERMINAL_FONT_SIZE_CHANGE_EVENT, handleSharedFontSize);

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
    let initialScreenAvailable = false;
    let coldMountTargetSeq: number | null = null;
    const revealInitialScreen = () => {
      if (cancelled || initialScreenAvailable) return;
      initialScreenAvailable = true;
      setLoading(false);
    };

    let checkpointTimer: number | null = null;
    let lastCheckpointAt = Number.NEGATIVE_INFINITY;
    const cancelPendingCheckpoint = () => {
      if (checkpointTimer === null) return;
      window.clearTimeout(checkpointTimer);
      checkpointTimer = null;
    };
    const restoreStableScreen = (callback: () => void) => {
      cancelPendingCheckpoint();
      if (cancelled) {
        callback();
        return;
      }
      term.reset();
      const checkpoint = checkpointRef.current;
      if (checkpoint?.serialized) {
        term.write(checkpoint.serialized, callback);
      } else {
        callback();
      }
    };
    const browserMetrics = new BrowserTerminalMetricRecorder(
      session.id,
      () => metricsEnabledRef.current,
    );
    browserMetricRecorderRef.current = browserMetrics;
    const recordBrowserMetric = (label: string, durationMs: number) => {
      browserMetrics.record(label, durationMs);
    };
    recordBrowserMetricRef.current = recordBrowserMetric;
    const normalizeFetched = async (opts: {
      limit: number;
      afterSeq?: number;
      maxBytes: number;
      signal: AbortSignal;
      onBytes(receivedBytes: number): void;
    }) => {
      const messages = await fetchMessages(hubUrl, session.id, opts);
      const normalized = messages.map((message): DurableTerminalMessage => ({
        id: message.id,
        sessionId: message.session_id,
        seq: message.seq,
        content: message.content,
        ...(message.local_id !== null ? { localId: message.local_id } : {}),
      }));
      if (opts.afterSeq === undefined) {
        coldMountTargetSeq = normalized.reduce(
          (max, message) => Math.max(max, message.seq),
          0,
        );
        if (coldMountTargetSeq === 0) revealInitialScreen();
      }
      return normalized;
    };
    let recovery: TerminalRecoveryController;
    const scheduleCheckpoint = () => {
      if (cancelled || document.hidden || !visibleRef.current || checkpointTimer !== null) return;
      const delayMs = Math.max(
        0,
        lastCheckpointAt + TERMINAL_CHECKPOINT_INTERVAL_MS - performance.now(),
      );
      checkpointTimer = window.setTimeout(() => {
        checkpointTimer = null;
        if (cancelled || document.hidden || !visibleRef.current || !recovery.isSettled) return;
        const checkpointStartedAt = performance.now();
        try {
          const checkpoint = {
            serialized: serializeAddon.serialize(),
            seq: recovery.lastSeq,
          };
          checkpointRef.current = checkpoint;
          cacheSet(session.id, checkpoint);
          lastCheckpointAt = performance.now();
          recordBrowserMetric("browser_checkpoint", lastCheckpointAt - checkpointStartedAt);
        } catch {
          // Keep the preceding completed checkpoint as the rollback point.
        }
      }, delayMs);
    };
    scheduleCheckpointRef.current = scheduleCheckpoint;
    recovery = new TerminalRecoveryController({
      sessionId: session.id,
      fetchPage: normalizeFetched,
      write: (message, callback) => {
        const content = message.content as { type?: string; data?: string } | null;
        const data = content?.type === "terminal-output" && typeof content.data === "string"
          ? content.data
          : "";
        const parseStartedAt = performance.now();
        term.write(data, () => {
          recordBrowserMetric("browser_xterm_write", performance.now() - parseStartedAt);
          const paintedAt = performance.now();
          for (const startedAt of pendingInputPaintMetricsRef.current.values()) {
            recordBrowserMetric(
              "browser_input_to_first_xterm_write_callback",
              paintedAt - startedAt,
            );
          }
          pendingInputPaintMetricsRef.current.clear();
          if (data && userScrolledUpRef.current) setShowNewOutput(true);
          onDurableMessageCompleteRef.current?.(message);
          callback();
        });
      },
      onSequenceComplete: (seq) => {
        if (cancelled || seq <= lastSeqRef.current) return;
        lastSeqRef.current = seq;
        updateLastSeq?.(session.id, seq);
        if (coldMountTargetSeq !== null && seq >= coldMountTargetSeq) {
          revealInitialScreen();
        }
      },
      onStateChange: (state) => {
        if (cancelled) return;
        if (
          state.status === "fault"
          && state.code === "deadline"
          && recentOutputResetSessionRef.current !== session.id
        ) {
          // A slow initial catch-up is recoverable and does not imply corrupt
          // history. Retry once from the bounded recent tail, as the CLI does.
          restartFromRecentOutput();
          return;
        }
        if (state.status === "fault") cancelPendingCheckpoint();
        // A healthy terminal already has a stable screen. Background catch-up
        // after visibility restoration should not replace it with a loading
        // overlay (or make the Scribe tab look disconnected).
        if (state.status === "recovering" && quietRecoveryRef.current) {
          return;
        }
        quietRecoveryRef.current = false;
        if (state.status === "fault") {
          initialScreenAvailable = checkpointRef.current !== null;
        } else if (state.status === "ready") {
          revealInitialScreen();
          if (recentOutputResetSessionRef.current === session.id) {
            recentOutputResetSessionRef.current = null;
            setHistoryNotice(RECENT_OUTPUT_NOTICE);
          }
        }
        onRecoveryStateRef.current?.(state);
        setLoading(state.status === "recovering" && !initialScreenAvailable);
        setHistoryFault(state.status === "fault" ? state.code : null);
      },
      getStableSequence: () => checkpointRef.current?.seq,
      restoreStableScreen,
      onQueueUsage: (messages, bytes) => {
        browserMetrics.observeRecoveryQueue(messages, bytes);
      },
      onSettled: (lastSeq) => {
        if (cancelled) return;
        if (lastSeq === recovery.lastSeq) scheduleCheckpoint();
      },
    });
    recoveryRef.current = recovery;

    const cached = terminalCache.get(session.id);
    if (cached) {
      checkpointRef.current = cached;
      lastCheckpointAt = performance.now();
      recovery.startCacheRestore(
        cached.seq,
        new TextEncoder().encode(cached.serialized).byteLength,
        (callback) => term.write(cached.serialized, () => {
          revealInitialScreen();
          callback();
        }),
      );
    } else {
      void recovery.startCold();
    }

    return () => {
      cancelled = true;
      cancelPendingCheckpoint();
      browserMetrics.dispose();
      if (browserMetricRecorderRef.current === browserMetrics) {
        browserMetricRecorderRef.current = null;
      }
      recordBrowserMetricRef.current = null;
      if (scheduleCheckpointRef.current === scheduleCheckpoint) {
        scheduleCheckpointRef.current = null;
      }
      pendingInputAckMetricsRef.current.clear();
      pendingInputPaintMetricsRef.current.clear();
      recovery.dispose();
      recoveryRef.current = null;
      if (viewportEl && scrollHandler) {
        viewportEl.removeEventListener("scroll", scrollHandler);
      }
      inputDisposable.dispose();
      containerRef.current?.removeEventListener("paste", handlePaste, true);
      containerRef.current?.removeEventListener("pointerdown", focusTerminal);
      containerRef.current?.removeEventListener("focusin", claimFocusedTerminal);
      containerRef.current?.removeEventListener("keydown", handleFontSizeShortcut, true);
      window.removeEventListener("resize", schedulePassiveFit);
      window.removeEventListener(TERMINAL_FONT_SIZE_CHANGE_EVENT, handleSharedFontSize);
      resizeObserver?.disconnect();
      if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
      if (scheduleFitRef.current === scheduleFit) scheduleFitRef.current = null;
      if (scheduleClaimRef.current === scheduleClaim) scheduleClaimRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [session.id, hubUrl, fontSize, updateLastSeq, recoveryEpoch, restartFromRecentOutput]);

  const historyError = historyFault === "overflow"
    ? "Terminal history is too large to restore safely."
    : historyFault
      ? `Terminal recovery stopped (${historyFault.replace(/_/g, " ")}).`
      : null;

  return (
    <div className={`tiller-terminal flex-1 min-h-0 overflow-hidden relative ${
      surface === "implementation" ? "tiller-terminal--implementation" : "tiller-terminal--default"
    }`}>
      <div
        ref={containerRef}
        className={`tiller-terminal-canvas absolute inset-0 ${
          surface === "implementation"
            ? "tiller-terminal-canvas--implementation"
            : "tiller-terminal-canvas--default"
        } ${resolvedTheme === "dark" ? "bg-[#1c1c1c]" : "bg-white"}`}
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
              onClick={retryHistory}
            >
              {historyFault === "overflow" ? "Show recent output" : "Retry"}
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
