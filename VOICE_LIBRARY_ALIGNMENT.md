# HAPI Voice Library Alignment

This package uses `@cloudflare/voice` as the primary voice transport and pipeline layer, but it does not yet follow every recommended pattern from the Cloudflare voice docs/design.

## Current Providers And Models

- STT provider: `WorkersAIFluxSTT`
- STT model: `@cf/deepgram/flux` (via the library's Workers AI Flux session)
- TTS provider: `WorkersAITTS`
- TTS model: the library default Workers AI TTS model used by `WorkersAITTS`
- Main voice turn router: deterministic local routing in `api/hapi-voice.ts`
- Main voice-turn LLM: none for ordinary requests; actionable requests are usually relayed directly to Claude
- Summarization LLM for terminal/Claude output: `@cf/moonshotai/kimi-k2.5`

## Current Flow

- Client mic/audio lifecycle: `@cloudflare/voice/react` via `useVoiceAgent`
- Voice transport/routing: native `/agents/...` routing via `routeAgentRequest()`
- End-of-turn detection: Flux streaming STT + client/library silence handling
- Main user turn handling:
  - simple conversational checks like `can you hear me` use a direct local fast-path reply
  - permission phrases like `approve that` or `deny that` are handled deterministically
  - most actionable requests are routed directly to Claude
- Claude output readback:
  - terminal output is buffered and filtered client-side in `src/SessionView.tsx`
  - readback is armed only after a successful Claude relay confirmation
  - one summary is spoken per relay request after a quiet period
  - summarized server-side in `api/hapi-voice.ts`
  - then spoken back through the voice TTS pipeline

## What We Are Following

- `withVoice(Agent)` is used for the server-side voice Durable Object in `api/hapi-voice.ts`.
- `useVoiceAgent` is used on the client in `src/SessionView.tsx`.
- Native `/agents/...` routing is used via `routeAgentRequest()` in `api/index.ts`.
- `WorkersAIFluxSTT` is used for streaming STT.
- `WorkersAITTS` is used for speech synthesis.
- The built-in voice lifecycle is used: call start/end, interruption, transcript updates, metrics, and SQLite-backed message persistence.
- The implementation keeps the library's WebSocket-native 1:1 voice architecture instead of using the older custom WS audio protocol.
- The client uses the library's built-in mic capture, silence detection, playback, transcript handling, and connection management.
- The server still uses the library's built-in persistence, transcript history, interruption handling, and TTS playback flow.

## What We Are Not Fully Following Yet

- `onTurn()` does not currently use the docs-preferred `streamText(...)` pattern for the main voice response path.
- We are not currently using the ideal streaming LLM -> sentence-chunked TTS flow for main actionable voice turns.
- Tool execution is not currently handled through the AI SDK's integrated tool loop in the way shown by the library examples.
- We added custom buffering/filtering for spoken Claude output in `src/SessionView.tsx`, which is outside the library's core examples.
- We added custom deterministic routing and direct-reply logic in `api/hapi-voice.ts` to stabilize HAPI-specific voice behavior.

## Why We Deviated

- The `streamText(...tools...)` path was leaking raw tool/function JSON into spoken output instead of consistently executing tools and returning a normal assistant reply.
- Example failure mode:

```text
Agent: {"type": "function", "name": "relay_to_claude", ...}
```

- To restore reliability quickly, `onTurn()` was simplified into deterministic routing instead of relying on the model to decide every action.
- We added local fast-path replies for simple prompts because generic model responses were sometimes low quality.
- We route most actionable requests straight to Claude because Claude is the real execution engine for this package.
- This gives deterministic spoken confirmations such as:
  - `I sent that to Claude.`
  - `I approved that permission.`
  - `I denied that permission.`

## Current Tradeoff

What we gain:

- More reliable tool behavior for HAPI-specific actions (`relay_to_claude`, `resolve_permission`)
- No raw function-call JSON being spoken to the user
- Simpler debugging while the voice pipeline is being stabilized
- More control over what parts of Claude's terminal output are spoken aloud
- Clearer separation between HAPI's voice layer and Claude's actual coding work

What we lose:

- Full alignment with the library's preferred `streamText(...)` response generation pattern
- Best-in-class streaming response behavior for tool-driven turns
- Cleaner long-term parity with the official examples
- More custom application logic to maintain around summarization and spoken-output filtering

## Target End State

The desired final architecture is:

1. Keep `@cloudflare/voice` for transport, STT, TTS, persistence, metrics, and interruption handling.
2. Decide whether to keep deterministic routing permanently or move back toward a clean `streamText(...)` flow.
3. Preserve reliable HAPI tool execution without leaking raw tool payloads into the spoken response.
4. Keep deterministic spoken acknowledgements after tool execution.
5. Reduce the amount of app-specific filtering needed in `src/SessionView.tsx` by making spoken output more semantically targeted upstream.

## Files Most Relevant To This Alignment

- `api/hapi-voice.ts`
- `api/index.ts`
- `src/SessionView.tsx`
- `src/VoiceAgent.tsx`
