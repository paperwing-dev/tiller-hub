# Voice Agent Architecture: CF Stack vs LiveKit

## How to read this

Two scenarios:
- **Turn-based**: Speak → wait → agent responds. No interruptions. What the current stack does.
- **Real-time**: Flowing conversation, barge-in, agent stops mid-sentence when you speak.

---

## TURN-BASED — Gaps to Production-Ready

The current stack is close. Specific gaps:

### 1. STT Hallucination (in progress)
**Gap**: CF Whisper hallucinates on silence. Nova-3 CF binding failing.
**Fix**: Deepgram REST API directly via fetch. Returns empty string on silence natively.
**Effort**: ~1 hour. Already planned.
**Note**: Nova-3 on CF Workers AI gained WebSocket mode (Oct 2025 changelog) — worth retesting before adding external API key.

### 2. Playback-end feedback loop
**Gap**: `processing = false` is set immediately after the DO sends TTS audio — before the client finishes playing it. A fast speaker could trigger a new turn while agent audio is still playing.
**Fix**: Client sends `{ type: "audio-ended" }` when `source.onended` fires. DO waits for this before re-enabling listening.
**Effort**: ~10 lines each side.

### 3. Max utterance timeout watchdog
**Gap**: If a user starts speaking and drops off (phone put down, network hiccup), `audioChunks` accumulates indefinitely.
**Fix**: 30s watchdog — if accumulating chunks for > 30s, fire the turn pipeline anyway.
**Effort**: ~5 lines.

### 4. Reconnect logic
**Gap**: WebSocket `close` sets status to "error" and stops permanently.
**Fix**: Exponential backoff reconnect with session state resume.
**Effort**: ~20 lines in the client hook.

### 5. Session-context race condition
**Gap**: WS opens → session-context sent → audio starts immediately. If session-context is delayed, early frames use default `sampleRate = 44100`. On 48kHz hardware the WAV header will be wrong.
**Fix**: Don't start ScriptProcessorNode until session-context ACK received from server.
**Effort**: ~5 lines each side.

### Turn-based verdict
**~2 focused hours from production-ready. LiveKit provides zero additional value here.**

---

## REAL-TIME — What You'd Need to Build

Listed in dependency order.

### 1. Client-side VAD
**Why**: Stop continuous audio streaming. Only send speech. Current RMS threshold fires on keyboard noise, misses soft speech.
**What LiveKit provides**: Silero VAD in browser AudioWorklet.
**Open source**: `@ricky0123/vad-web` — Silero VAD via ONNX Runtime in browser. Still maintained (v0.0.30, late 2025).
**CF note**: Requires `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers for SharedArrayBuffer. Falls back to single-thread without them — slower but works.
**Effort**: ~2 hours.

### 2. Streaming STT with Partial Transcripts
**Why**: STT transcribes while user is still talking → LLM can start earlier → lower latency.
**What LiveKit provides**: Deepgram/AssemblyAI WebSocket streaming with interim results.
**Open source**: Deepgram WebSocket API (documented). CF Workers supports outbound WebSocket. ~100 lines.
**Effort**: ~100 lines.

### 3. Streaming LLM → Sentence Chunking → TTS Pipeline
**Why**: User hears first sentence while LLM writes sentence two. Without this, full LLM response must complete before any audio plays.
**What LiveKit provides**: Token streaming + sentence boundary detection + sequential TTS queue.
**Open source**: Workers AI already supports `stream: true`. Sentence detection is ~30 lines (`[.!?]\s+` + abbreviation buffer). Deepgram TTS docs have chunking guidance.
**Effort**: ~150 lines total.

### 4. Acoustic Echo Cancellation Validation
**Why**: TTS played via `AudioContext` may bypass the browser's WebRTC AEC reference signal. If it does, agent speech leaks into the mic, VAD fires, agent interrupts itself in a loop.
**What LiveKit provides**: Routes TTS through WebRTC audio graph (AEC sees it correctly). Krisp noise cancellation (cloud-only, not open source).
**Open source noise cancellation**: `jitsi/rnnoise-wasm` — good for stationary noise, not voice-over-voice.
**What to do**: Test empirically first — play TTS and speak simultaneously, see if VAD fires unexpectedly. May be a non-issue depending on browser/OS. If broken, fix is routing TTS output through `AudioContext.createMediaStreamDestination()` so it enters the WebRTC audio path.
**Effort**: Test = 30 min. Fix if needed = ~50 lines.

### 5. Two-Gate Barge-in Filtering
**Why**: "Um", "uh", a cough shouldn't interrupt the agent. Current stack has single RMS gate and no semantic confirmation.
**What LiveKit provides**:
- `interrupt_speech_duration` — minimum VAD-confirmed speech duration before triggering barge-in (e.g. 500ms)
- `interrupt_min_words` — minimum transcribed word count before committing (e.g. 2 words)

**Open source**: No library — 2 config parameters + ~20 lines of filtering logic.
**Effort**: ~20 lines.

### 6. Barge-in / Interruption Handling
**Why**: User speaks during agent TTS → agent must stop mid-sentence.
**What LiveKit provides**: Async-cancellable pipeline. VAD triggers → cancel in-flight TTS fetch → cancel in-flight LLM stream → clear audio buffer → mark conversation interrupted.
**Architectural blocker**: Current `processing = true` single flag makes this impossible without restructuring. Needs:
- Async-cancellable LLM fetch (AbortController)
- Async-cancellable TTS fetch (AbortController)
- Audio chunk queue that can be flushed mid-stream
- VAD monitoring running *concurrently* with LLM+TTS (not blocked by `processing = true`)

**Open source reference**: Pipecat `src/pipecat/pipeline/task.py` — Python but the dual-priority queue pattern is translatable. Key pattern: high-priority interrupt signals bypass normal processing queue and trigger `cancel_and_clear()` on downstream processors.
**Effort**: 4-6 days. Hardest part is the concurrent architecture, not cancellation itself.

### 7. Playback Position Tracking (required for coherent barge-in)
**Why**: When barge-in happens, LLM may have generated 200 words but agent only spoke 40. Without tracking, full 200-word response ends up in conversation history — multi-turn becomes incoherent.
**What LiveKit provides**: Playback position stored in ChatContext. On interrupt, truncates assistant message to what was actually spoken. (OpenAI Realtime API emits `audio_interrupted` events with audio timestamps for this.)
**What current stack does**: `playAudio()` is fire-and-forget. DO has no idea when audio finishes or how much was heard.
**What you'd build**:
- Client sends `{ type: "audio-chunk-played", index: N }` as each chunk plays
- Client sends `{ type: "audio-ended" }` on `source.onended`
- DO tracks last acknowledged chunk index
- On barge-in: truncate conversation history to `sentences[0..lastAcknowledgedIndex]`

**Effort**: ~100 lines (both sides). Conceptually simple, must be correct.

### 8. Formal Agent State Machine
**What LiveKit provides**: Guarded transitions: `disconnected → connecting → initializing → listening → thinking → speaking`. Guards prevent illegal transitions. Events emitted on each.
**What current stack has**: Informal `status` messages, no guarded transitions.
**Open source**: No library needed — ~50 line state machine.
**Effort**: ~50 lines. Low priority but prevents subtle bugs.

---

## What LiveKit Is Actually Providing

For a CF-native stack, broken down honestly:

| LiveKit component | Turn-based? | Real-time? | CF alternative |
|---|---|---|---|
| WebRTC SFU | Not needed | Only if AEC fails | Cloudflare Calls |
| Agent orchestration | Not needed | Not needed | Durable Objects |
| Turn detection (EOU model) | Already have it | Already have it | smart-turn-v2 (better*) |
| STT integrations | 1 fetch call | Deepgram WS ~100 lines | Workers AI / Deepgram |
| LLM integrations | Already have it | Already have it | Workers AI |
| TTS integrations | Already have it | Already have it | Workers AI |
| **Barge-in framework** | Not needed | **Primary value** | Pipecat source as reference |
| **Playback tracking** | Small gap | **Required for barge-in** | Build yourself |
| **Two-gate filtering** | Not needed | **Prevents false positives** | Build yourself |
| Noise cancellation (Krisp) | Not needed | Test first | rnnoise-wasm |
| Observability | Nice to have | Nice to have | Build yourself |

*smart-turn-v2 is audio-based (not text-based), runs on CF Workers AI in 12ms, catches filler words that STT drops. LiveKit's EOU model is text-based and requires a co-located Python/Node process.

**LiveKit's real value for real-time**: Almost entirely the barge-in framework + playback tracking + filtering. The SFU, integrations, and orchestration are all covered natively by CF.

**For turn-based: LiveKit provides nothing you need.**

---

## Cloudflare Calls vs WebSocket

Cloudflare Calls is a WebRTC SFU — same concept as LiveKit's server. It handles NAT traversal, SRTP, Opus, jitter buffer. The architecture would be:

```
Browser (WebRTC/Opus) → CF Calls SFU → pullTrackToWebSocket → DO (gets PCM)
DO response (PCM) → WebSocket → CF Calls SFU → Browser (WebRTC audio track)
```

The benefit: TTS audio routed back through a WebRTC track is visible to the browser's AEC engine as the speaker reference signal — fixing the self-interruption loop. The current WebSocket approach plays audio via `AudioContext` which may not register as the AEC reference.

**Use Cloudflare Calls only if**: Browser AEC is actually failing to cancel agent audio from `AudioContext` playback. Test empirically. For turn-based, skip it entirely — WebSocket is simpler and works fine.

---

## Effort Summary

| Phase | Items | Effort |
|---|---|---|
| Production turn-based | Deepgram STT + 4 small fixes | ~2 hours |
| Real-time prerequisites | Client VAD + streaming STT + sentence chunking | ~1 day |
| AEC validation + fix | Test self-interruption empirically | ~30 min (or 0) |
| Full real-time barge-in | Async pipeline + two-gate filter + playback tracking | 4-6 days |

The 4-6 day barge-in estimate assumes building it correctly — concurrency, context truncation, false positive handling. Building a version that works 80% of the time is easier; the edge cases are what LiveKit ships and maintains.
