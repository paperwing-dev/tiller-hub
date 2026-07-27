import { useState, useRef, useCallback, useEffect } from "react";

export type AgentStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "thinking"
  | "reading"
  | "speaking"
  | "error";

export interface UseVoiceAgentReturn {
  voiceActive: boolean;
  status: AgentStatus;
  transcript: string | null;
  agentMessage: string | null;
  startAgent(): Promise<void>;
  stopAgent(): void;
  summarizeOutput(content: string): void;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useVoiceAgent(hubUrl: string, sessionId: string): UseVoiceAgentReturn {
  const [voiceActive, setVoiceActive] = useState(false);
  const [status, setStatus] = useState<AgentStatus>("idle");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [agentMessage, setAgentMessage] = useState<string | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const controlWsRef = useRef<WebSocket | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const intentionalStopRef = useRef(false);

  // Base URL for API calls (HTTP, not WS)
  const apiBase = hubUrl.replace(/\/$/, "");

  useEffect(() => {
    return () => {
      intentionalStopRef.current = true;
      teardown();
    };
  }, []);

  const teardown = () => {
    pcRef.current?.close();
    pcRef.current = null;

    controlWsRef.current?.close();
    controlWsRef.current = null;

    if (audioElRef.current) {
      audioElRef.current.srcObject = null;
      audioElRef.current = null;
    }
  };

  const stopAgent = useCallback(async () => {
    intentionalStopRef.current = true;

    // Tell the DO to end the session (closes SFU adapters)
    try {
      await fetch(`${apiBase}/api/voice/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });
    } catch {}

    teardown();
    setVoiceActive(false);
    setStatus("idle");
    setTranscript(null);
    setAgentMessage(null);
    intentionalStopRef.current = false;
  }, [apiBase, sessionId]);

  const summarizeOutput = useCallback((content: string) => {
    const ws = controlWsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: "summarize-output", content }));
  }, []);

  const startAgent = useCallback(async () => {
    intentionalStopRef.current = false;
    setStatus("connecting");
    setVoiceActive(true);

    try {
      // ── Step 1: Init DO ────────────────────────────────────────────
      await fetch(`${apiBase}/api/voice/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });

      // ── Step 2: Get mic with browser AEC ──────────────────────────
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });

      // ── Step 3: Create RTCPeerConnection ──────────────────────────
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
      });
      pcRef.current = pc;

      // Add mic track
      for (const track of stream.getAudioTracks()) {
        pc.addTrack(track, stream);
      }

      // Play incoming TTS audio (no AudioContext needed — browser handles decoding)
      pc.ontrack = (e) => {
        if (!audioElRef.current) {
          audioElRef.current = new Audio();
          audioElRef.current.autoplay = true;
        }
        audioElRef.current.srcObject = e.streams[0];
      };

      // ── Step 4: Create SDP offer ──────────────────────────────────
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // Wait for ICE gathering to complete
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") { resolve(); return; }
        pc.onicegatheringstatechange = () => {
          if (pc.iceGatheringState === "complete") resolve();
        };
        setTimeout(resolve, 5000); // 5s timeout
      });

      // ── Step 5: /api/voice/connect → SDP answer ───────────────────
      const connectRes = await fetch(`${apiBase}/api/voice/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sessionId,
          sessionDescription: pc.localDescription,
        }),
      });

      if (!connectRes.ok) throw new Error(`connect failed: ${connectRes.status}`);

      const connectData = await connectRes.json() as {
        sessionDescription: RTCSessionDescriptionInit;
        sfuSessionId: string;
        audioTrackName: string;
        pull: { ingestSessionId: string; ingestTrackName: string };
      };

      await pc.setRemoteDescription(connectData.sessionDescription);

      // ── Step 6: Pull TTS audio track ──────────────────────────────
      const pullRes = await fetch(`${apiBase}/api/voice/pull-track`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          sfuSessionId: connectData.sfuSessionId,
          ingestSessionId: connectData.pull.ingestSessionId,
          ingestTrackName: connectData.pull.ingestTrackName,
        }),
      });

      const pullData = await pullRes.json() as {
        sessionDescription?: RTCSessionDescriptionInit;
        requiresImmediateRenegotiation?: boolean;
      };

      // ── Step 7: Renegotiate if needed ─────────────────────────────
      if (pullData.sessionDescription) {
        await pc.setRemoteDescription(pullData.sessionDescription);
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        await fetch(`${apiBase}/api/voice/renegotiate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            sfuSessionId: connectData.sfuSessionId,
            sessionDescription: pc.localDescription,
          }),
        });
      }

      // ── Step 8: Open control WS ───────────────────────────────────
      const wsBase = apiBase.replace(/^http/, "ws");
      const controlWs = new WebSocket(
        `${wsBase}/api/voice/session/${encodeURIComponent(sessionId)}/ws/control`,
      );
      controlWsRef.current = controlWs;

      controlWs.addEventListener("open", () => {
        if (intentionalStopRef.current) return;
        controlWs.send(JSON.stringify({ type: "session-context", sessionId }));
      });

      controlWs.addEventListener("message", (event) => {
        if (typeof event.data !== "string") return;
        let msg: { type: string; status?: AgentStatus; text?: string; message?: string };
        try { msg = JSON.parse(event.data); } catch { return; }
        switch (msg.type) {
          case "status": if (msg.status) setStatus(msg.status); break;
          case "transcript": if (msg.text) setTranscript(msg.text); break;
          case "agent-message": if (msg.text) setAgentMessage(msg.text); break;
          case "error": console.error("[VoiceAgent-SFU]", msg.message); break;
        }
      });

      controlWs.addEventListener("close", () => {
        if (!intentionalStopRef.current) {
          teardown();
          setStatus("error");
          setVoiceActive(false);
        }
      });

      controlWs.addEventListener("error", () => {
        teardown();
        setStatus("error");
        setVoiceActive(false);
      });

      // ── Step 9: Wait for PeerConnection to connect ────────────────
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("ICE timeout")), 15000);
        pc.oniceconnectionstatechange = () => {
          if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
            clearTimeout(timeout);
            resolve();
          }
          if (pc.iceConnectionState === "failed") {
            clearTimeout(timeout);
            reject(new Error("ICE failed"));
          }
        };
        if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
          clearTimeout(timeout);
          resolve();
        }
      });

      // ── Step 10: Start forwarding mic audio to DO ─────────────────
      await fetch(`${apiBase}/api/voice/start-forwarding`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ sessionId }),
      });

    } catch (err) {
      console.error("[VoiceAgent-SFU] startAgent error:", err);
      teardown();
      setStatus("error");
      setVoiceActive(false);
    }
  }, [apiBase, sessionId]);

  return { voiceActive, status, transcript, agentMessage, startAgent, stopAgent, summarizeOutput };
}
