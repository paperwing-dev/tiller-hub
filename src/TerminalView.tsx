import { useEffect, useRef, useImperativeHandle, forwardRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SerializeAddon } from "@xterm/addon-serialize";
import type { StoredSession } from "../api/types";
import { fetchMessages } from "./api";

// LRU cache for serialized terminal state (max 8 sessions)
const MAX_CACHE = 8;
const terminalCache = new Map<string, { serialized: string; lastSeq: number }>();

function cacheSet(sessionId: string, serialized: string, lastSeq: number) {
  terminalCache.delete(sessionId); // re-insert at end for LRU order
  terminalCache.set(sessionId, { serialized, lastSeq });
  if (terminalCache.size > MAX_CACHE) {
    const oldest = terminalCache.keys().next().value;
    terminalCache.delete(oldest!);
  }
}

export interface TerminalViewHandle {
  write: (data: string) => void;
  writeMessage: (data: string, seq: number) => void;
  clear: () => void;
}

interface TerminalViewProps {
  session: StoredSession;
  hubUrl: string;
  updateLastSeq?: (sessionId: string, seq: number) => void;
  interactive?: boolean;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
}

export default forwardRef<TerminalViewHandle, TerminalViewProps>(function TerminalView(
  { session, hubUrl, updateLastSeq, interactive = false, onInput, onResize },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const serializeRef = useRef<SerializeAddon | null>(null);
  const lastSeqRef = useRef(0);
  const writtenSeqsRef = useRef(new Set<number>());
  const [loading, setLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showNewOutput, setShowNewOutput] = useState(false);
  const userScrolledUpRef = useRef(false);
  const interactiveRef = useRef(interactive);
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  interactiveRef.current = interactive;
  onInputRef.current = onInput;
  onResizeRef.current = onResize;

  const scrollToBottom = useCallback(() => {
    termRef.current?.scrollToBottom();
    setShowNewOutput(false);
    userScrolledUpRef.current = false;
  }, []);

  useEffect(() => {
    if (!interactive || !lastSizeRef.current) return;
    onResize?.(lastSizeRef.current.cols, lastSizeRef.current.rows);
  }, [interactive, onResize]);

  useImperativeHandle(ref, () => ({
    write: (data: string) => {
      termRef.current?.write(data);
      if (userScrolledUpRef.current) {
        setShowNewOutput(true);
      }
    },
    writeMessage: (data: string, seq: number) => {
      if (writtenSeqsRef.current.has(seq)) return;
      writtenSeqsRef.current.add(seq);
      termRef.current?.write(data);
      if (userScrolledUpRef.current) {
        setShowNewOutput(true);
      }
    },
    clear: () => termRef.current?.clear(),
  }));

  // Effect: Terminal setup + replay (depends on session.id and hubUrl)
  useEffect(() => {
    if (!containerRef.current) return;

    lastSeqRef.current = 0;
    writtenSeqsRef.current = new Set<number>();
    userScrolledUpRef.current = false;
    setShowNewOutput(false);
    lastSizeRef.current = null;

    const term = new Terminal({
      cols: 120,
      rows: 40,
      theme: {
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
      },
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

    const handleWindowResize = () => {
      fitAddon.fit();
      reportSize();
    };
    window.addEventListener("resize", handleWindowResize);
    const inputDisposable = term.onData((data) => {
      if (!interactiveRef.current) return;
      onInputRef.current?.(data);
    });
    const focusTerminal = () => term.focus();
    containerRef.current.addEventListener("mousedown", focusTerminal);

    // Scroll detection via xterm viewport
    const viewportEl = containerRef.current.querySelector(".xterm-viewport");
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

    function trackSeq(seq: number) {
      if (seq > lastSeqRef.current) {
        lastSeqRef.current = seq;
        updateLastSeq?.(session.id, seq);
      }
    }

    const cached = terminalCache.get(session.id);

    if (cached) {
      // Cache hit: restore serialized state, then fetch only new messages
      lastSeqRef.current = cached.lastSeq;
      updateLastSeq?.(session.id, cached.lastSeq);
      setLoading(true);
      setHistoryError(null);
      term.write(cached.serialized, () => {
        if (cancelled) return;
        fetchMessages(hubUrl, session.id, {
          afterSeq: cached.lastSeq,
          limit: 1000,
        })
          .then((msgs) => {
            if (cancelled) return;
            if (msgs.length > 0) {
              const chunks: string[] = [];
              for (const msg of msgs) {
                const content = tryParse(msg.content) as { type?: string; data?: string } | null;
                if (content?.type === "terminal-output" && content.data) {
                  if (msg.seq != null && writtenSeqsRef.current.has(msg.seq)) continue;
                  if (msg.seq != null) writtenSeqsRef.current.add(msg.seq);
                  chunks.push(content.data);
                }
                if (msg.seq != null) trackSeq(msg.seq);
              }
              if (chunks.length > 0) {
                term.write(chunks.join(""), () => {
                  if (!cancelled) setLoading(false);
                });
              } else {
                setLoading(false);
              }
            } else {
              setLoading(false);
            }
          })
          .catch((err) => {
            if (cancelled) return;
            setHistoryError("Failed to load new messages");
            console.error("[tiller] fetchMessages (incremental):", err);
            setLoading(false);
          });
      });
    } else {
      // No cache: fetch recent messages and batch-write
      setLoading(true);
      setHistoryError(null);
      fetchMessages(hubUrl, session.id, { limit: 200 })
        .then((msgs) => {
          if (cancelled) return;
          // API returns newest-first, reverse for chronological replay
          const sorted = msgs.reverse();
          const chunks: string[] = [];
          for (const msg of sorted) {
            const content = tryParse(msg.content) as { type?: string; data?: string } | null;
            if (content?.type === "terminal-output" && content.data) {
              if (msg.seq != null && writtenSeqsRef.current.has(msg.seq)) continue;
              if (msg.seq != null) writtenSeqsRef.current.add(msg.seq);
              chunks.push(content.data);
            }
            if (msg.seq != null) trackSeq(msg.seq);
          }
          if (chunks.length > 0) {
            term.write(chunks.join(""), () => {
              if (!cancelled) setLoading(false);
            });
          } else {
            setLoading(false);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setHistoryError("Failed to load history");
          console.error("[tiller] fetchMessages:", err);
          setLoading(false);
        });
    }

    return () => {
      cancelled = true;
      // Serialize terminal state into cache before disposing
      try {
        const serialized = serializeRef.current?.serialize();
        if (serialized && lastSeqRef.current > 0) {
          cacheSet(session.id, serialized, lastSeqRef.current);
        }
      } catch {
        // serialization failed — skip cache
      }
      if (viewportEl && scrollHandler) {
        viewportEl.removeEventListener("scroll", scrollHandler);
      }
      inputDisposable.dispose();
      containerRef.current?.removeEventListener("mousedown", focusTerminal);
      window.removeEventListener("resize", handleWindowResize);
      term.dispose();
      termRef.current = null;
      serializeRef.current = null;
    };
  }, [session.id, hubUrl, updateLastSeq]);

  return (
    <div className="flex-1 min-h-0 overflow-hidden relative">
      <div
        ref={containerRef}
        className="absolute inset-0 px-2 py-1"
      />
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[#57606a] text-sm pointer-events-none">
          Loading history...
        </div>
      )}
      {historyError && (
        <div className="absolute inset-0 flex items-center justify-center text-red-600 text-sm pointer-events-none">
          {historyError}
        </div>
      )}
      {showNewOutput && (
        <button
          onClick={scrollToBottom}
          className="absolute bottom-3 left-1/2 -translate-x-1/2 bg-white hover:bg-[#f6f8fa] text-[#57606a] text-xs px-3 py-1.5 rounded-full shadow-md border border-[#d0d7de] transition-colors z-10"
        >
          New output &darr;
        </button>
      )}
    </div>
  );
});

function tryParse(json: string): unknown {
  if (!json) return null;
  try {
    return typeof json === "string" ? JSON.parse(json) : json;
  } catch {
    return null;
  }
}
