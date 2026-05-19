# Cloudflare Workers AI Model Notes

## STT: @cf/deepgram/nova-3

**Status: Broken for binary audio input**

All input formats tried and rejected with `AiError: 5006: required properties at '/audio' are 'body,contentType'`:
- Base64 string (original approach)
- `ReadableStream` wrapping a `Uint8Array`
- `ArrayBuffer` (`wav.buffer`)

The model's TypeScript types suggest `{ body, contentType }` is correct, but the runtime consistently rejects it regardless of body type.

**Workaround**: Fall back to `@cf/openai/whisper`.

---

## STT: @cf/openai/whisper

**Status: Working** (with correct input format)

Input must be `number[]` containing the **raw bytes of a WAV file** — not float32 PCM samples, not int16 samples.

```typescript
// WRONG — float32 PCM samples (causes 3016 tensor decode error)
audio: Array.from(merged)  // Float32Array

// WRONG — int16 PCM samples (causes 3010 invalid audio error)
audio: Array.from(int16)   // Int16Array

// CORRECT — WAV file bytes
audio: Array.from(wav)     // Uint8Array from buildWav()
```

The WAV must be built at the actual sample rate of the AudioContext (48000Hz on most browsers/macOS), NOT hardcoded to 16kHz. Sending 16kHz WAV headers with 48kHz data causes silent/garbled transcripts.

---

## LLM Tool Calling: @cf/meta/llama-3.1-8b-instruct-fp8

**Status: Unreliable for tool calls — DO NOT USE for tool calling**

The 8b model does not reliably emit a `tool_calls` field in its response. Instead it narrates what it "would" call:

> "To resolve the prompt, we need to call the 'relay_to_claude' function with the 'message' parameter set to 'Testing 1, 2, 3.'"

It also hallucinates context (e.g., claims there's a "code snippet" in the prompt when there isn't).

**Fix**: Use `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for any LLM step that needs structured tool calls. It reliably produces `tool_calls` in the response.

---

## TTS: @cf/deepgram/aura-1

**Status: Untested end-to-end** (blocked by STT failures upstream). Code handles both base64 string output and ArrayBuffer output since workers-types and runtime disagree on the return type.
