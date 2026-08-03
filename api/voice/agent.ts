import { Agent, type Connection, type WSMessage } from "agents";
import {
  withVoice,
  WorkersAIFluxSTT,
  WorkersAITTS,
  type VoiceTurnContext,
} from "@cloudflare/voice";
import type { HubDO } from "../hub";
import type { Env } from "../types";
import { KIMI_K2_7_CODE } from "../../shared/harness-catalog";
import { getDurableObjectStub } from "../durable-object";

// ── Hub stub type ───────────────────────────────────────────────────

type HubStub = Pick<
  HubDO,
  "addMessage" | "getPendingPermissions" | "resolvePermission"
>;

interface ToolCall {
  name: string;
  args: Record<string, string>;
}

// ── System prompt ───────────────────────────────────────────────────

const SUMMARY_MODEL = KIMI_K2_7_CODE.providerModel;

function getDirectReply(transcript: string): string | null {
  const text = transcript.trim().toLowerCase();
  if (!text) return null;

  if (/^(hi|hello|hey|yo)\b/.test(text)) {
    return "Hi. I'm here.";
  }

  if (
    /\b(can you hear me|do you hear me|can you respond|please respond to me|are you there)\b/.test(
      text,
    )
  ) {
    return "Yes, I can hear you.";
  }

  if (/\b(test(ing)?|mic check|sound check)\b/.test(text)) {
    return "Audio sounds good on my side.";
  }

  if (/\b(what can you do|help|how can you help)\b/.test(text)) {
    return "I can send requests to Claude, approve permissions, and read back useful results.";
  }

  return null;
}

function getPermissionDecision(
  transcript: string,
): "allowed" | "denied" | null {
  const text = transcript.trim().toLowerCase();
  if (!text) return null;

  if (
    /\b(approve|allow|yes allow|yes approve|grant permission|accept it)\b/.test(
      text,
    )
  ) {
    return "allowed";
  }

  if (/\b(deny|reject|block|don't allow|do not allow|no deny)\b/.test(text)) {
    return "denied";
  }

  return null;
}

function getRelayMessage(transcript: string): string {
  return transcript
    .trim()
    .replace(/^ask\s+claude(\s+code)?\s+to\s+/i, "")
    .replace(/^tell\s+claude(\s+code)?\s+to\s+/i, "")
    .replace(/^have\s+claude(\s+code)?\s+/i, "")
    .replace(/^can\s+you\s+ask\s+claude(\s+code)?\s+to\s+/i, "")
    .replace(/^please\s+ask\s+claude(\s+code)?\s+to\s+/i, "")
    .trim();
}

function isLowQualitySummary(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return true;

  return (
    normalized === "no result yet" ||
    normalized === "no result yet." ||
    normalized.includes("message might have been cutoff") ||
    normalized.includes("cut off") ||
    normalized.includes("cutoff") ||
    normalized === "carteaining" ||
    normalized === "carteaining."
  );
}

// ── Voice agent ─────────────────────────────────────────────────────

const VoiceAgent = withVoice(Agent);

export class TillerVoice extends VoiceAgent<Env> {
  // --- Providers ---
  // Flux: streaming STT with built-in end-of-turn detection via Workers AI.
  // No VAD needed — Flux has built-in turn detection.
  streamingStt = new WorkersAIFluxSTT(this.env.AI);
  tts = new WorkersAITTS(this.env.AI);


  // The session ID is the DO instance name (this.name), set via idFromName(sessionId).

  // --- Single-speaker enforcement ---
  // Only one connection can be the active speaker at a time. This prevents
  // two browser tabs from capturing audio simultaneously.

  #activeSpeakerId: string | null = null;
  #pipelineBusy = false;
  #debugConnections = new Set<string>();

  #sendDebug(
    connection: Connection,
    stage: string,
    details?: Record<string, unknown>,
  ): void {
    if (!this.#debugConnections.has(connection.id)) return;
    connection.send(
      JSON.stringify({
        type: "debug",
        timestamp: Date.now(),
        stage,
        details,
      }),
    );
  }

  beforeCallStart(connection: Connection): boolean {
    if (this.#activeSpeakerId && this.#activeSpeakerId !== connection.id) {
      connection.send(
        JSON.stringify({
          type: "speaker_conflict",
          message:
            "Another tab is the active speaker. Close it or refresh to take over.",
        }),
      );
      return false;
    }
    this.#activeSpeakerId = connection.id;
    return true;
  }

  onCallEnd(connection: Connection): void {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
    }
    this.#pipelineBusy = false;
    this.#sendDebug(connection, "call_end");
  }

  onClose(connection: Connection): void {
    if (this.#activeSpeakerId === connection.id) {
      this.#activeSpeakerId = null;
    }
    this.#debugConnections.delete(connection.id);
  }

  onInterrupt(connection: Connection): void {
    this.#pipelineBusy = false;
    this.#sendDebug(connection, "interrupt");
  }

  afterTranscribe(transcript: string, connection: Connection): string | null {
    this.#sendDebug(connection, "after_transcribe", { transcript });
    return transcript;
  }

  beforeSynthesize(text: string, connection: Connection): string | null {
    this.#sendDebug(connection, "before_synthesize", {
      text: text.slice(0, 160),
    });
    return text;
  }

  // --- Non-voice message handling ---

  onMessage(connection: Connection, message: WSMessage): void {
    if (typeof message !== "string") return;

    let data: { type: string; content?: string; enabled?: boolean };
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    if (data.type === "debug") {
      if (data.enabled) this.#debugConnections.add(connection.id);
      else this.#debugConnections.delete(connection.id);
      this.#sendDebug(connection, "debug_enabled", { enabled: !!data.enabled });
      return;
    }

    if (data.type === "summarize-output" && data.content?.trim()) {
      this.#processSummarize(connection, data.content.trim());
    }

    if (data.type === "kick_speaker") {
      this.#handleKick(connection);
    }
  }

  #handleKick(requester: Connection): void {
    if (!this.#activeSpeakerId) return;

    const activeConn = [...this.getConnections()].find(
      (c) => c.id === this.#activeSpeakerId,
    );

    if (activeConn) {
      activeConn.send(
        JSON.stringify({
          type: "kicked",
          message: "Another session has taken over as the active speaker.",
        }),
      );
      this.forceEndCall(activeConn);
    }

    this.#activeSpeakerId = null;
    requester.send(
      JSON.stringify({
        type: "speaker_available",
        message: "Previous speaker disconnected. You can start a call.",
      }),
    );
  }

  // --- Voice agent logic ---

  async onTurn(transcript: string, context: VoiceTurnContext) {
    this.#pipelineBusy = true;
    // Clear flag when the turn's AbortSignal fires (interrupt or disconnect)
    context.signal.addEventListener(
      "abort",
      () => {
        this.#pipelineBusy = false;
      },
      { once: true },
    );

    const sessionId = this.name; // DO instance name = Claude session ID

    console.log("[TillerVoice] onTurn start", { sessionId, transcript });
    this.#sendDebug(context.connection, "on_turn_start", { transcript });

    const directReply = getDirectReply(transcript);
    if (directReply) {
      this.#sendDebug(context.connection, "on_turn_direct_reply", {
        transcript,
        reply: directReply,
      });
      this.#pipelineBusy = false;
      return directReply;
    }

    try {
      const permissionDecision = getPermissionDecision(transcript);
      if (permissionDecision) {
        const spoken = await this.#executeToolCall(
          {
            name: "resolve_permission",
            args: { decision: permissionDecision },
          },
          sessionId,
          context.connection,
        );
        this.#sendDebug(context.connection, "on_turn_complete", {
          yieldedText: !!spoken,
          route: "permission",
        });
        return spoken;
      }

      const relayMessage = getRelayMessage(transcript) || transcript.trim();
      const spoken = await this.#executeToolCall(
        { name: "relay_to_claude", args: { message: relayMessage } },
        sessionId,
        context.connection,
      );
      this.#sendDebug(context.connection, "on_turn_complete", {
        yieldedText: !!spoken,
        route: "relay_to_claude",
        relayMessage,
      });
      return spoken;
    } finally {
      this.#pipelineBusy = false;
    }
  }

  // --- Greeting on call start ---

  async onCallStart(connection: Connection): Promise<void> {
    // Use getConversationHistory() which handles schema init (cf_voice_messages
    // table creation) internally — avoids "no such table" on a fresh DO.
    const hasHistory = this.getConversationHistory(1).length > 0;

    const greeting = hasHistory ? "Welcome back." : "Hi, I'm Tiller.";

    try {
      this.#sendDebug(connection, "call_start", { hasHistory });
      await this.speak(connection, greeting);
    } catch (err) {
      // If TTS fails for the greeting (e.g. model unavailable), don't kill the
      // call — the user can still speak and get text responses. Log and continue.
      console.error("[TillerVoice] Greeting TTS failed:", err);
    }
  }

  // --- Terminal output summarization ---

  async #processSummarize(
    connection: Connection,
    content: string,
  ): Promise<void> {
    // Drop summarize requests if the agent is already thinking/speaking
    // to avoid competing for the audio channel (speak() would abort the pipeline)
    if (this.#pipelineBusy) return;
    // Only summarize for the active speaker
    if (this.#activeSpeakerId !== connection.id) return;
    this.#sendDebug(connection, "summarize_output_start", {
      contentLength: content.length,
    });

    // Send custom status for the UI
    connection.send(JSON.stringify({ type: "tiller-status", status: "reading" }));

    try {
      const truncated = content.length > 4000 ? content.slice(-4000) : content;
      const result = (await this.env.AI.run(
        SUMMARY_MODEL as never,
        {
          messages: [
            {
              role: "user",
              content:
                `You are Tiller, a voice assistant for a Claude Code session.\n` +
                `Summarize the following terminal output in ONE short sentence (max 15 words).\n` +
                `Ignore progress chatter, tool narration, file-count updates, and ephemeral verbs like reading, searching, cooking, or analyzing.\n` +
                `Only speak the user-meaningful result. If there is no substantive result yet, return an empty response.\n` +
                `Plain language, no filler.\n\n${truncated}`,
            },
          ],
          max_tokens: 60,
        } as never,
      )) as { response?: string };

      const summary = this.#cleanAssistantText(result.response ?? "");
      if (summary && !isLowQualitySummary(summary)) {
        await this.speak(connection, summary);
      }
    } catch (err) {
      console.error("[TillerVoice] processSummarize error:", err);
    }
  }

  // --- Hub helper ---

  #getHub(): HubStub {
    return getDurableObjectStub<HubStub>(this.env, this.env.HUB, "hub");
  }

  #cleanAssistantText(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return "";
    if (
      (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
      /relay_to_claude|resolve_permission|tool_calls|"type"\s*:\s*"function"/.test(
        trimmed,
      )
    ) {
      return "";
    }
    return trimmed;
  }

  async #executeToolCall(
    tool: ToolCall,
    sessionId: string,
    connection: Connection,
  ): Promise<string> {
    const hub = this.#getHub();

    if (tool.name === "relay_to_claude") {
      const message = tool.args.message?.trim();
      if (!message) return "I couldn't figure out what to send to Claude.";
      await hub.addMessage(
        crypto.randomUUID(),
        sessionId,
        { role: "user", type: "user-input", data: message + "\r" },
        null,
      );
      console.log("[TillerVoice] relay_to_claude", { sessionId, message });
      this.#sendDebug(connection, "tool_relay_to_claude", { message });
      return "I sent that to Claude.";
    }

    if (tool.name === "resolve_permission") {
      const decision = (tool.args.decision ?? "denied") as "allowed" | "denied";
      const reason = tool.args.reason;
      const pending = await hub.getPendingPermissions(sessionId);
      if (pending.length === 0)
        return "There are no pending permissions right now.";
      await hub.resolvePermission(pending[0].id, decision, reason);
      console.log("[TillerVoice] resolve_permission", {
        sessionId,
        permissionId: pending[0].id,
        decision,
      });
      this.#sendDebug(connection, "tool_resolve_permission", {
        permissionId: pending[0].id,
        decision,
      });
      return decision === "allowed"
        ? "I approved that permission."
        : "I denied that permission.";
    }

    return "I couldn't complete that action.";
  }
}
