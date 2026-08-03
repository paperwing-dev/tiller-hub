import type { VoicePipelineMetrics } from "@cloudflare/voice/react";

// Voice status and transcript types (from @cloudflare/voice — inlined to
// avoid subpath module resolution issues in the LSP).
type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

interface VoiceAgentProps {
  status: VoiceStatus;
  transcript: TranscriptMessage[];
  interimTranscript: string | null;
  audioLevel: number;
  metrics: VoicePipelineMetrics | null;
  tillerStatus: string | null;
  error: string | null;
  connected: boolean;
  debugEnabled: boolean;
  debugCopyState: "idle" | "copied" | "failed";
  debugEvents: Array<{
    timestamp: number;
    stage: string;
    details?: Record<string, unknown>;
  }>;
  onEnd: () => void;
  onCopyDebug: () => void;
  onToggleDebug: () => void;
  onToggleMute: () => void;
  isMuted: boolean;
}

const WAVEFORM_BARS = [
  { heightClass: "h-3", delay: "0ms" },
  { heightClass: "h-5", delay: "120ms" },
  { heightClass: "h-7", delay: "240ms" },
  { heightClass: "h-5", delay: "360ms" },
  { heightClass: "h-3", delay: "480ms" },
];

export default function VoiceAgent({
  status,
  transcript,
  interimTranscript,
  audioLevel,
  metrics,
  tillerStatus,
  error,
  connected,
  debugEnabled,
  debugCopyState,
  debugEvents,
  onEnd,
  onCopyDebug,
  onToggleDebug,
  onToggleMute,
  isMuted,
}: VoiceAgentProps) {
  const displayStatus = tillerStatus === "reading" ? "reading" : status;

  return (
    <div className="border-t border-kumo-line bg-kumo-recessed p-3">
      <div className="bg-kumo-elevated border border-kumo-line rounded-lg p-3 flex flex-col gap-2">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                !connected
                  ? "bg-kumo-danger"
                  : status === "idle"
                    ? "bg-kumo-fill"
                    : "bg-kumo-success"
              }`}
            />
            <span className="text-sm font-medium text-kumo-default">
              Voice Agent
              {!connected && (
                <span className="ml-1.5 text-xs font-normal text-kumo-danger">
                  (disconnected)
                </span>
              )}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onToggleDebug}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                debugEnabled
                  ? "border-kumo-info/40 bg-kumo-info-tint text-kumo-info hover:bg-kumo-info-tint/70"
                  : "border-kumo-line bg-kumo-base hover:bg-kumo-tint text-kumo-subtle"
              }`}
            >
              Debug {debugEnabled ? "On" : "Off"}
            </button>
            {debugEnabled && (
              <button
                onClick={onCopyDebug}
                className="text-xs px-2.5 py-1 rounded border border-kumo-line bg-kumo-base hover:bg-kumo-tint text-kumo-subtle transition-colors"
              >
                {debugCopyState === "copied"
                  ? "Copied"
                  : debugCopyState === "failed"
                    ? "Copy Failed"
                    : "Copy Debug"}
              </button>
            )}
            <button
              onClick={onToggleMute}
              className={`text-xs px-2.5 py-1 rounded border transition-colors ${
                isMuted
                  ? "border-kumo-danger/40 bg-kumo-danger-tint text-kumo-danger hover:bg-kumo-danger-tint/70"
                  : "border-kumo-line bg-kumo-base hover:bg-kumo-tint text-kumo-subtle"
              }`}
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button
              onClick={onEnd}
              className="text-xs px-2.5 py-1 rounded border border-kumo-line bg-kumo-base hover:bg-kumo-tint text-kumo-subtle transition-colors"
            >
              End Call
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-kumo-danger-tint border border-kumo-danger/30 rounded px-2.5 py-1.5 text-xs text-kumo-danger">
            {error}
          </div>
        )}

        {/* Status visualizer */}
        <div className="flex items-center justify-center py-2 min-h-[48px]">
          {(displayStatus === "thinking" || displayStatus === "reading") && (
            <div className="flex items-center gap-2 text-kumo-subtle">
              <SpinnerIcon className="w-4 h-4 animate-spin" />
              <span className="text-sm">
                {displayStatus === "reading"
                  ? "Reading output..."
                  : "Thinking..."}
              </span>
            </div>
          )}

          {displayStatus === "listening" && (
            <div className="flex flex-col items-center gap-2">
              <div className="flex items-end gap-1" aria-label="Listening">
                {WAVEFORM_BARS.map(({ heightClass, delay }, i) => (
                  <span
                    key={i}
                    className={`w-1.5 ${heightClass} bg-kumo-info rounded-full animate-waveform`}
                    style={{ animationDelay: delay }}
                  />
                ))}
              </div>
              {/* Audio level meter */}
              <div className="w-32 h-1 bg-kumo-tint rounded-full overflow-hidden">
                <div
                  className="h-full bg-kumo-info rounded-full transition-all duration-75"
                  style={{ width: `${Math.min(audioLevel * 500, 100)}%` }}
                />
              </div>
            </div>
          )}

          {displayStatus === "speaking" && (
            <div className="flex items-end gap-1" aria-label="Speaking">
              {WAVEFORM_BARS.map(({ heightClass, delay }, i) => (
                <span
                  key={i}
                  className={`w-1.5 ${heightClass} bg-kumo-success rounded-full animate-waveform`}
                  style={{ animationDelay: delay, animationDuration: "0.6s" }}
                />
              ))}
            </div>
          )}

          {displayStatus === "idle" && (
            <span className="text-sm text-kumo-subtle">
              {connected ? "Ready" : "Connecting..."}
            </span>
          )}
        </div>

        {/* Metrics */}
        {metrics && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[10px] text-kumo-subtle font-mono border-t border-kumo-line pt-1.5">
            <span>LLM {metrics.llm_ms}ms</span>
            <span className="text-kumo-inactive">/</span>
            <span>TTS {metrics.tts_ms}ms</span>
            <span className="text-kumo-inactive">/</span>
            <span>Audio {metrics.first_audio_ms}ms</span>
            <span className="text-kumo-inactive">/</span>
            <span>Total {metrics.total_ms}ms</span>
          </div>
        )}

        {debugEnabled && (
          <div className="border-t border-kumo-line pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-kumo-subtle">
                Debug
              </span>
              <span className="text-[10px] text-kumo-subtle">
                {debugEvents.length} events
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto rounded border border-kumo-line bg-kumo-recessed px-2 py-1.5 font-mono text-[10px] text-kumo-subtle space-y-1">
              {debugEvents.length === 0 ? (
                <p>No debug events yet.</p>
              ) : (
                debugEvents.map((event, i) => (
                  <p key={`${event.timestamp}-${i}`}>
                    <span className="text-kumo-subtle">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{" "}
                    <span className="text-kumo-default">{event.stage}</span>
                    {event.details ? ` ${JSON.stringify(event.details)}` : ""}
                  </p>
                ))
              )}
            </div>
          </div>
        )}

        {/* Transcript */}
        {(transcript.length > 0 || interimTranscript) && (
          <div className="text-xs text-kumo-subtle space-y-1 border-t border-kumo-line pt-2 max-h-32 overflow-y-auto">
            {transcript.slice(-4).map((msg, i) => (
              <p key={i}>
                <span className="font-medium text-kumo-default">
                  {msg.role === "user" ? "You:" : "Agent:"}
                </span>{" "}
                {msg.text || "..."}
              </p>
            ))}
            {interimTranscript && (
              <p className="italic text-kumo-subtle">
                <span className="font-medium text-kumo-default">You:</span>{" "}
                {interimTranscript}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className}>
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
