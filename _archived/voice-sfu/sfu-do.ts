import type { HubDO } from "../hub";
import type { Env } from "../types";

// ── Protobuf helpers ─────────────────────────────────────────────────

function encodeVarint(value: number): number[] {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
  bytes.push(value & 0x7f);
  return bytes;
}

function decodeVarint(buf: Uint8Array, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos];
    result |= (byte & 0x7f) << shift;
    pos++;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result, pos];
}

function encodeSfuPacket(payload: Uint8Array): Uint8Array {
  const payloadTag = [0x2a];
  const payloadLen = encodeVarint(payload.length);
  const totalLen = payloadTag.length + payloadLen.length + payload.length;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const b of payloadTag) out[offset++] = b;
  for (const b of payloadLen) out[offset++] = b;
  out.set(payload, offset);
  return out;
}

function decodeSfuPacket(buf: Uint8Array): { sequenceNumber: number; timestamp: number; payload: Uint8Array } {
  let offset = 0;
  let sequenceNumber = 0;
  let timestamp = 0;
  let payload = new Uint8Array(0);

  while (offset < buf.length) {
    const [tag, newOffset] = decodeVarint(buf, offset);
    offset = newOffset;
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x07;

    if (wireType === 0) {
      const [value, nextOffset] = decodeVarint(buf, offset);
      offset = nextOffset;
      if (fieldNumber === 1) sequenceNumber = value;
      if (fieldNumber === 2) timestamp = value;
    } else if (wireType === 2) {
      const [len, nextOffset] = decodeVarint(buf, offset);
      offset = nextOffset;
      if (fieldNumber === 5) payload = buf.slice(offset, offset + len);
      offset += len;
    } else { break; }
  }

  return { sequenceNumber, timestamp, payload };
}

// ── Audio format conversion ──────────────────────────────────────────

function calculateRmsEnergy(pcm16bit: Uint8Array): number {
  const view = new DataView(pcm16bit.buffer, pcm16bit.byteOffset, pcm16bit.byteLength);
  const sampleCount = Math.floor(pcm16bit.length / 2);
  if (sampleCount === 0) return 0;
  let sumSquares = 0;
  for (let i = 0; i < sampleCount; i++) {
    const sample = view.getInt16(i * 2, true) / 32768;
    sumSquares += sample * sample;
  }
  return Math.sqrt(sumSquares / sampleCount);
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function downsample48kStereoTo16kMono(input: Uint8Array): Uint8Array {
  const bytesPerFrame = 4;
  const totalFrames = Math.floor(input.length / bytesPerFrame);
  const decimation = 3;
  const outputFrames = Math.floor(totalFrames / decimation);
  if (outputFrames === 0) return new Uint8Array(0);

  const output = new Uint8Array(outputFrames * 2);
  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outputView = new DataView(output.buffer);

  for (let i = 0; i < outputFrames; i++) {
    let sum = 0;
    for (let j = 0; j < decimation; j++) {
      const frameIdx = i * decimation + j;
      if (frameIdx >= totalFrames) break;
      const srcIdx = frameIdx * bytesPerFrame;
      const left = inputView.getInt16(srcIdx, true);
      const right = inputView.getInt16(srcIdx + 2, true);
      sum += (left + right) / 2;
    }
    const mono = Math.round(sum / decimation);
    outputView.setInt16(i * 2, Math.max(-32768, Math.min(32767, mono)), true);
  }
  return output;
}

function resample16kMonoTo48kStereo(input: Uint8Array): Uint8Array {
  const inputSamples = Math.floor(input.length / 2);
  if (inputSamples === 0) return new Uint8Array(0);

  const ratio = 3;
  const outputSamples = inputSamples * ratio;
  const output = new Uint8Array(outputSamples * 2 * 2);
  const inputView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outputView = new DataView(output.buffer);

  let outIdx = 0;
  for (let i = 0; i < inputSamples; i++) {
    const current = inputView.getInt16(i * 2, true);
    const next = i + 1 < inputSamples ? inputView.getInt16((i + 1) * 2, true) : current;
    for (let r = 0; r < ratio; r++) {
      const t = r / ratio;
      const sample = Math.round(current + (next - current) * t);
      const clamped = Math.max(-32768, Math.min(32767, sample));
      outputView.setInt16(outIdx, clamped, true); outIdx += 2;
      outputView.setInt16(outIdx, clamped, true); outIdx += 2;
    }
  }
  return output;
}

// ── Types ────────────────────────────────────────────────────────────

type HubStub = Pick<HubDO, "addMessage" | "getPendingPermissions" | "resolvePermission">;

interface ToolCall {
  name: string;
  args: Record<string, string>;
}

// ── VoiceDO (SFU transport) ──────────────────────────────────────────

export class VoiceDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  // Session context
  private sessionId: string | null = null;

  // SFU WebSocket connections
  private streamWs: WebSocket | null = null;  // SFU → DO: mic audio
  private ingestWs: WebSocket | null = null;  // DO → SFU: TTS audio
  private controlWs: WebSocket | null = null; // Browser ↔ DO: JSON status

  // Nova STT streaming WebSocket (outbound, pins DO in memory)
  private novaWs: WebSocket | null = null;
  private partialText = "";
  private currentUtterance = "";
  private utteranceTimer: ReturnType<typeof setTimeout> | null = null;

  // SFU state
  private sfuSessionId: string | null = null;
  private audioTrackName: string | null = null;
  private ingestAdapterId: string | null = null;
  private ingestSessionId: string | null = null;
  private streamAdapterId: string | null = null;

  // Processing state
  private isProcessing = false;
  private isSpeaking = false;
  private conversationHistory: { role: "user" | "assistant"; content: string }[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/^\/+/, "/");

    switch (pathname) {
      case "/init":
        return this.handleInit(request);
      case "/set-sfu-state":
        return this.handleSetSfuState(request);
      case "/sfu-state":
        return Response.json({
          sfuSessionId: this.sfuSessionId,
          audioTrackName: this.audioTrackName,
        });
      case "/set-stream-adapter":
        return this.handleSetStreamAdapter(request);
      case "/end":
        return this.handleEnd();
      case "/ws/stream":
        return this.handleStreamWebSocket(request);
      case "/ws/ingest":
        return this.handleIngestWebSocket(request);
      case "/ws/control":
        return this.handleControlWebSocket(request);
      default:
        return new Response("Not found", { status: 404 });
    }
  }

  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json() as { sessionId?: string };
    if (body.sessionId) this.sessionId = body.sessionId;
    return Response.json({ ok: true });
  }

  private async handleSetSfuState(request: Request): Promise<Response> {
    const s = await request.json() as {
      sfuSessionId: string;
      audioTrackName: string;
      ingestAdapterId: string;
      ingestSessionId: string;
    };
    this.sfuSessionId = s.sfuSessionId;
    this.audioTrackName = s.audioTrackName;
    this.ingestAdapterId = s.ingestAdapterId;
    this.ingestSessionId = s.ingestSessionId;
    return Response.json({ ok: true });
  }

  private async handleSetStreamAdapter(request: Request): Promise<Response> {
    const { streamAdapterId } = await request.json() as { streamAdapterId: string };
    this.streamAdapterId = streamAdapterId;
    return Response.json({ ok: true });
  }

  // ── WebSocket handlers ────────────────────────────────────────────

  private handleStreamWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.streamWs = server;

    let messageCount = 0;
    let novaConnecting = false;

    server.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer)) return;
      messageCount++;

      if (!this.novaWs && !novaConnecting) {
        novaConnecting = true;
        this.connectNovaSTT()
          .then(() => { novaConnecting = false; })
          .catch((err) => { novaConnecting = false; console.error("[VoiceDO-SFU] Nova connect failed:", err); });
      }

      const packet = decodeSfuPacket(new Uint8Array(event.data));
      if (packet.payload.length > 0) this.forwardAudioToNova(packet.payload);
    });

    server.addEventListener("close", () => {
      this.streamWs = null;
      if (this.novaWs?.readyState === WebSocket.OPEN) {
        try { this.novaWs.send(JSON.stringify({ type: "Finalize" })); } catch {}
      }
    });

    server.addEventListener("error", (e) => console.error("[VoiceDO-SFU] stream WS error:", e));

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleIngestWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.ingestWs = server;

    server.addEventListener("close", () => { this.ingestWs = null; });
    server.addEventListener("error", (e) => console.error("[VoiceDO-SFU] ingest WS error:", e));

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleControlWebSocket(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    this.controlWs = server;

    server.addEventListener("message", async (event) => {
      if (typeof event.data !== "string") return;
      let data: { type: string; sessionId?: string; content?: string };
      try { data = JSON.parse(event.data); } catch { return; }

      if (data.type === "session-context") {
        if (data.sessionId) this.sessionId = data.sessionId;
        this.sendControl({ type: "status", status: "listening" });
        return;
      }

      if (data.type === "summarize-output" && !this.isProcessing) {
        const content = (data.content ?? "").trim();
        if (content) await this.processSummarize(content);
      }
    });

    server.addEventListener("close", () => { this.controlWs = null; });
    server.addEventListener("error", (e) => console.error("[VoiceDO-SFU] control WS error:", e));

    this.sendControl({ type: "status", status: "listening" });
    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Nova STT ──────────────────────────────────────────────────────

  private async connectNovaSTT(): Promise<void> {
    const url = `https://api.cloudflare.com/client/v4/accounts/${this.env.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/deepgram/nova-3?encoding=linear16&sample_rate=16000`;
    const resp = await fetch(url, {
      headers: { Upgrade: "websocket", Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}` },
    });

    const ws = resp.webSocket;
    if (!ws) throw new Error(`Nova WS failed: ${resp.status}`);
    ws.accept();
    this.novaWs = ws;

    ws.addEventListener("message", (event) => {
      if (typeof event.data === "string") this.handleNovaMessage(event.data);
    });
    ws.addEventListener("close", () => { this.novaWs = null; });
    ws.addEventListener("error", (e) => console.error("[VoiceDO-SFU] Nova error:", e));
  }

  private handleNovaMessage(data: string): void {
    try {
      const msg = JSON.parse(data);
      const transcript = msg?.channel?.alternatives?.[0]?.transcript || "";

      if (msg.is_final && transcript.trim()) {
        this.currentUtterance += (this.currentUtterance ? " " : "") + transcript.trim();
        this.partialText = "";

        if (this.utteranceTimer) clearTimeout(this.utteranceTimer);

        if (msg.speech_final) {
          this.processCompletedUtterance();
        } else {
          this.utteranceTimer = setTimeout(() => {
            this.utteranceTimer = null;
            this.processCompletedUtterance();
          }, 1200);
        }
      } else if (!msg.is_final && transcript.trim()) {
        this.partialText = transcript.trim();
      }
    } catch (err) {
      console.error("[VoiceDO-SFU] Nova parse error:", err, data);
    }
  }

  private processCompletedUtterance(): void {
    if (!this.currentUtterance.trim()) return;
    if (this.isProcessing || this.isSpeaking) return;

    const utterance = this.currentUtterance.trim();
    this.currentUtterance = "";
    this.partialText = "";

    // Optional smart-turn gate (extra gate on top of Nova's speech_final)
    if ((this.env.SMART_TURN_VERSION ?? "v2") === "off") {
      this.processTurn(utterance).catch((err) => console.error("[VoiceDO-SFU] processTurn error:", err));
      return;
    }

    // Run smart-turn but don't block — it's advisory in SFU mode since Nova's
    // speech_final is already reliable
    this.processTurn(utterance).catch((err) => console.error("[VoiceDO-SFU] processTurn error:", err));
  }

  private forwardAudioToNova(chunk: Uint8Array): void {
    if (!this.novaWs || this.novaWs.readyState !== WebSocket.OPEN) return;
    if (this.isSpeaking) return; // Echo guard

    const mono16k = downsample48kStereoTo16kMono(chunk);
    if (mono16k.length === 0) return;

    // Energy gate — filter silence before forwarding
    if (calculateRmsEnergy(mono16k) < 0.005) return;

    try {
      this.novaWs.send(mono16k.buffer as ArrayBuffer);
    } catch (err) {
      console.error("[VoiceDO-SFU] Nova send error:", err);
    }
  }

  // ── STT → LLM → TTS pipeline ─────────────────────────────────────

  private async processTurn(transcript: string): Promise<void> {
    this.isProcessing = true;
    this.sendControl({ type: "status", status: "thinking" });
    this.sendControl({ type: "transcript", text: transcript });

    try {
      const { text: agentText, tool } = await this.runLLM(transcript);

      if (tool) await this.executeTool(tool);

      const spoken = agentText.trim();

      this.conversationHistory.push({ role: "user", content: transcript });
      if (spoken) this.conversationHistory.push({ role: "assistant", content: spoken });
      if (this.conversationHistory.length > 12) this.conversationHistory = this.conversationHistory.slice(-12);

      if (!spoken) { this.sendControl({ type: "status", status: "listening" }); return; }

      this.sendControl({ type: "agent-message", text: spoken });
      await this.sfuSpeak(spoken);
    } catch (err) {
      console.error("[VoiceDO-SFU] processTurn error:", err);
      this.sendControl({ type: "status", status: "listening" });
    } finally {
      this.isProcessing = false;
    }
  }

  private async runLLM(transcript: string): Promise<{ text: string; tool: ToolCall | null }> {
    const system = [
      "You are Tiller, a voice assistant for a Claude Code session.",
      this.sessionId ? `Active session: ${this.sessionId}.` : "",
      "Use relay_to_claude when the user asks to do anything with their code or session.",
      "Use resolve_permission when the user says 'approve', 'allow', 'deny', or 'reject'.",
      "Always include a brief spoken reply (1-2 sentences). Keep it conversational.",
    ].filter(Boolean).join(" ");

    const tools = [
      {
        type: "function" as const,
        function: {
          name: "relay_to_claude",
          description: "Send a message or instruction to the active Claude coding session",
          parameters: {
            type: "object",
            properties: { message: { type: "string", description: "The message to send to Claude" } },
            required: ["message"],
          },
        },
      },
      {
        type: "function" as const,
        function: {
          name: "resolve_permission",
          description: "Approve or deny the most recent pending tool permission request",
          parameters: {
            type: "object",
            properties: {
              decision: { type: "string", description: "'allowed' or 'denied'" },
              reason: { type: "string", description: "Optional brief reason" },
            },
            required: ["decision"],
          },
        },
      },
    ];

    const historySlice = this.conversationHistory.slice(-12);
    const result = await this.env.AI.run("@cf/meta/llama-3.1-8b-instruct-fp8", {
      messages: [
        { role: "system" as const, content: system },
        ...historySlice,
        { role: "user" as const, content: transcript },
      ],
      tools,
      max_tokens: 200,
    });

    const text = result.response ?? "";
    const rawCall = result.tool_calls?.[0] as
      | { function: { name: string; arguments: string | Record<string, string> } }
      | { name: string; arguments: Record<string, string> }
      | undefined;

    let tool: ToolCall | null = null;
    if (rawCall) {
      if ("function" in rawCall) {
        const rawArgs = rawCall.function.arguments;
        let args: Record<string, string> = {};
        try { args = typeof rawArgs === "string" ? JSON.parse(rawArgs) : rawArgs; } catch {}
        tool = { name: rawCall.function.name, args };
      } else {
        tool = { name: rawCall.name, args: rawCall.arguments };
      }
    }

    return { text, tool };
  }

  private async executeTool(tool: ToolCall): Promise<void> {
    if (!this.sessionId) return;

    const hubId = this.env.HUB.idFromName("hub");
    const hub = this.env.HUB.get(hubId) as unknown as HubStub;

    if (tool.name === "relay_to_claude") {
      const message = tool.args.message?.trim();
      if (message) {
        await hub.addMessage(crypto.randomUUID(), this.sessionId,
          { role: "user", type: "user-input", data: message + "\r" }, null);
      }
    } else if (tool.name === "resolve_permission") {
      const decision = (tool.args.decision ?? "denied") as "allowed" | "denied";
      const pending = await hub.getPendingPermissions(this.sessionId);
      if (pending.length > 0) await hub.resolvePermission(pending[0].id, decision, tool.args.reason);
    }
  }

  // ── TTS via SFU ingest ────────────────────────────────────────────

  private async sfuSpeak(text: string): Promise<void> {
    if (!this.ingestWs) {
      this.sendControl({ type: "status", status: "listening" });
      return;
    }

    this.isSpeaking = true;
    this.sendControl({ type: "status", status: "speaking" });

    try {
      const ttsResponse = (await withTimeout(
        (this.env.AI as any).run("@cf/deepgram/aura-1", {
          text,
          encoding: "linear16",
          sample_rate: 16000,
          container: "none",
        }, { returnRawResponse: true }),
        10_000,
        "TTS",
      )) as Response;

      const audioBuffer = await ttsResponse.arrayBuffer();
      const pcm16kMono = new Uint8Array(audioBuffer);
      const pcm48kStereo = resample16kMonoTo48kStereo(pcm16kMono);

      const CHUNK_SIZE = 32 * 1024 - 8;
      for (let i = 0; i < pcm48kStereo.length; i += CHUNK_SIZE) {
        const chunk = pcm48kStereo.slice(i, Math.min(i + CHUNK_SIZE, pcm48kStereo.length));
        const packet = encodeSfuPacket(chunk);
        if (this.ingestWs?.readyState === WebSocket.OPEN) {
          try { this.ingestWs.send(packet); }
          catch { break; }
        } else { break; }
      }

      // Estimate playback and clear speaking flag after
      const durationMs = (pcm48kStereo.length / 192000) * 1000;
      setTimeout(() => {
        this.isSpeaking = false;
        this.sendControl({ type: "status", status: "listening" });
      }, durationMs);
    } catch (err) {
      console.error("[VoiceDO-SFU] sfuSpeak error:", err);
      this.isSpeaking = false;
      this.sendControl({ type: "status", status: "listening" });
    }
  }

  // ── Output summarization (70B model) ─────────────────────────────

  private async processSummarize(terminalOutput: string): Promise<void> {
    this.isProcessing = true;
    this.sendControl({ type: "status", status: "reading" });
    try {
      const truncated = terminalOutput.length > 4000 ? terminalOutput.slice(-4000) : terminalOutput;
      const result = await this.env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "user" as const, content:
          `You are Tiller, a voice assistant for a Claude Code session.\n` +
          `Summarize the following terminal output in 2-3 short spoken sentences.\n` +
          `Focus on what Claude did. Plain language, no ANSI codes.\n\n${truncated}` }],
        max_tokens: 150,
      });
      const summary = (result.response ?? "").trim();
      if (!summary) { this.sendControl({ type: "status", status: "listening" }); return; }
      this.sendControl({ type: "agent-message", text: summary });
      await this.sfuSpeak(summary);
    } catch (err) {
      console.error("[VoiceDO-SFU] processSummarize error:", err);
      this.sendControl({ type: "status", status: "listening" });
    } finally { this.isProcessing = false; }
  }

  // ── Session end ───────────────────────────────────────────────────

  private async handleEnd(): Promise<Response> {
    try { this.streamWs?.close(); } catch {}
    try { this.ingestWs?.close(); } catch {}
    try { this.controlWs?.close(); } catch {}
    try { this.novaWs?.close(); } catch {}

    const tracks: { adapterId: string }[] = [];
    if (this.streamAdapterId) tracks.push({ adapterId: this.streamAdapterId });
    if (this.ingestAdapterId) tracks.push({ adapterId: this.ingestAdapterId });

    if (tracks.length > 0 && this.env.SFU_API_BASE && this.env.REALTIME_SFU_APP_ID) {
      try {
        await fetch(
          `${this.env.SFU_API_BASE}/apps/${this.env.REALTIME_SFU_APP_ID}/adapters/websocket/close`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${this.env.REALTIME_SFU_BEARER_TOKEN}`,
            },
            body: JSON.stringify({ tracks }),
          },
        );
      } catch (err) { console.error("[VoiceDO-SFU] adapter close error:", err); }
    }

    return Response.json({ ok: true });
  }

  // ── Helpers ───────────────────────────────────────────────────────

  private sendControl(msg: object): void {
    if (!this.controlWs) return;
    try { this.controlWs.send(JSON.stringify(msg)); } catch {}
  }
}
