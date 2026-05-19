// Voice status and transcript types (from @cloudflare/voice — inlined to
// avoid subpath module resolution issues in the LSP).
type VoiceStatus = "idle" | "listening" | "thinking" | "speaking";

interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
  timestamp?: number;
}

interface PipelineMetrics {
  vad_ms: number;
  stt_ms: number;
  llm_ms: number;
  tts_ms: number;
  first_audio_ms: number;
  total_ms: number;
}

interface VoiceAgentProps {
  status: VoiceStatus;
  transcript: TranscriptMessage[];
  interimTranscript: string | null;
  audioLevel: number;
  metrics: PipelineMetrics | null;
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
    <div className="border-t border-[#d0d7de] bg-[#f6f8fa] p-3">
      <div className="bg-white border border-[#d0d7de] rounded-lg p-3 flex flex-col gap-2">
        {/* Header row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span
              className={`w-2 h-2 rounded-full ${
                !connected
                  ? "bg-red-500"
                  : status === "idle"
                    ? "bg-[#d0d7de]"
                    : "bg-green-500"
              }`}
            />
            <span className="text-sm font-medium text-[#24292f]">
              Voice Agent
              {!connected && (
                <span className="ml-1.5 text-xs font-normal text-red-600">
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
                  ? "border-blue-300 bg-blue-50 text-blue-700 hover:bg-blue-100"
                  : "border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a]"
              }`}
            >
              Debug {debugEnabled ? "On" : "Off"}
            </button>
            {debugEnabled && (
              <button
                onClick={onCopyDebug}
                className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
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
                  ? "border-red-300 bg-red-50 text-red-600 hover:bg-red-100"
                  : "border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a]"
              }`}
            >
              {isMuted ? "Unmute" : "Mute"}
            </button>
            <button
              onClick={onEnd}
              className="text-xs px-2.5 py-1 rounded border border-[#d0d7de] bg-white hover:bg-[#f6f8fa] text-[#57606a] transition-colors"
            >
              End Call
            </button>
          </div>
        </div>

        {/* Error banner */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded px-2.5 py-1.5 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Status visualizer */}
        <div className="flex items-center justify-center py-2 min-h-[48px]">
          {(displayStatus === "thinking" || displayStatus === "reading") && (
            <div className="flex items-center gap-2 text-[#57606a]">
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
                    className={`w-1.5 ${heightClass} bg-blue-500 rounded-full animate-waveform`}
                    style={{ animationDelay: delay }}
                  />
                ))}
              </div>
              {/* Audio level meter */}
              <div className="w-32 h-1 bg-[#eaeef2] rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-75"
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
                  className={`w-1.5 ${heightClass} bg-green-500 rounded-full animate-waveform`}
                  style={{ animationDelay: delay, animationDuration: "0.6s" }}
                />
              ))}
            </div>
          )}

          {displayStatus === "idle" && (
            <span className="text-sm text-[#57606a]">
              {connected ? "Ready" : "Connecting..."}
            </span>
          )}
        </div>

        {/* Metrics */}
        {metrics && (
          <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-[10px] text-[#57606a] font-mono border-t border-[#d0d7de] pt-1.5">
            <span>STT {metrics.stt_ms}ms</span>
            <span className="text-[#d0d7de]">/</span>
            <span>LLM {metrics.llm_ms}ms</span>
            <span className="text-[#d0d7de]">/</span>
            <span>TTS {metrics.tts_ms}ms</span>
            <span className="text-[#d0d7de]">/</span>
            <span>Audio {metrics.first_audio_ms}ms</span>
          </div>
        )}

        {debugEnabled && (
          <div className="border-t border-[#d0d7de] pt-2">
            <div className="mb-1 flex items-center justify-between">
              <span className="text-[11px] font-medium uppercase tracking-wide text-[#57606a]">
                Debug
              </span>
              <span className="text-[10px] text-[#8b949e]">
                {debugEvents.length} events
              </span>
            </div>
            <div className="max-h-32 overflow-y-auto rounded border border-[#d0d7de] bg-[#f6f8fa] px-2 py-1.5 font-mono text-[10px] text-[#57606a] space-y-1">
              {debugEvents.length === 0 ? (
                <p>No debug events yet.</p>
              ) : (
                debugEvents.map((event, i) => (
                  <p key={`${event.timestamp}-${i}`}>
                    <span className="text-[#8b949e]">
                      {new Date(event.timestamp).toLocaleTimeString()}
                    </span>{" "}
                    <span className="text-[#24292f]">{event.stage}</span>
                    {event.details ? ` ${JSON.stringify(event.details)}` : ""}
                  </p>
                ))
              )}
            </div>
          </div>
        )}

        {/* Transcript */}
        {(transcript.length > 0 || interimTranscript) && (
          <div className="text-xs text-[#57606a] space-y-1 border-t border-[#d0d7de] pt-2 max-h-32 overflow-y-auto">
            {transcript.slice(-4).map((msg, i) => (
              <p key={i}>
                <span className="font-medium text-[#24292f]">
                  {msg.role === "user" ? "You:" : "Agent:"}
                </span>{" "}
                {msg.text || "..."}
              </p>
            ))}
            {interimTranscript && (
              <p className="italic text-[#8b949e]">
                <span className="font-medium text-[#24292f]">You:</span>{" "}
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
