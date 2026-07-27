import { Hono } from "hono";
import type { HonoEnv, Env } from "../types";

// SFU helper ─────────────────────────────────────────────────────────

async function sfuFetch(env: Env, path: string, body?: unknown): Promise<Response> {
  const url = `${env.SFU_API_BASE}/apps/${env.REALTIME_SFU_APP_ID}${path}`;
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.REALTIME_SFU_BEARER_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
}

function buildWssUrl(request: Request, pathname: string): string {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function getVoiceDO(env: Env, sessionId: string) {
  const id = env.VOICE.idFromName(sessionId);
  return env.VOICE.get(id);
}

// Hono app ────────────────────────────────────────────────────────────

const sfuVoiceApp = new Hono<HonoEnv>();

// POST /api/voice/init — initialize DO with sessionId
sfuVoiceApp.post("/api/voice/init", async (c) => {
  const body = await c.req.json<{ sessionId: string }>();
  const { sessionId } = body;

  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

  const stub = getVoiceDO(c.env, sessionId);
  await stub.fetch(new Request("https://internal/init", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  }));

  return c.json({ ok: true });
});

// POST /api/voice/connect — WebRTC SDP negotiation + ingest adapter creation
sfuVoiceApp.post("/api/voice/connect", async (c) => {
  const { sessionId, sessionDescription } = await c.req.json<{
    sessionId: string;
    sessionDescription: unknown;
  }>();

  if (!sessionId || !sessionDescription) {
    return c.json({ error: "Missing sessionId or sessionDescription" }, 400);
  }

  // 1. Create SFU session
  const sessionRes = await sfuFetch(c.env, "/sessions/new");
  const sessionData = await sessionRes.json() as { sessionId?: string };
  if (!sessionData.sessionId) {
    return c.json({ error: "Failed to create SFU session", detail: sessionData }, 500);
  }
  const sfuSessionId = sessionData.sessionId;

  // 2. Add tracks (autoDiscover from SDP offer)
  const tracksRes = await sfuFetch(c.env, `/sessions/${sfuSessionId}/tracks/new`, {
    autoDiscover: true,
    sessionDescription,
  });
  const tracksData = await tracksRes.json() as {
    sessionDescription?: unknown;
    tracks?: { kind?: string; trackName?: string }[];
  };
  if (!tracksData.sessionDescription) {
    return c.json({ error: "Failed to add tracks", detail: tracksData }, 500);
  }

  const audioTrack = tracksData.tracks?.find((t) => t.kind === "audio" || !t.kind);
  const audioTrackName = audioTrack?.trackName ?? tracksData.tracks?.[0]?.trackName;
  if (!audioTrackName) {
    return c.json({ error: "No audio track found", detail: tracksData }, 500);
  }

  // 3. Create ingest adapter (TTS audio → SFU)
  const ingestCallbackUrl = buildWssUrl(c.req.raw, `/api/voice/session/${sessionId}/ws/ingest`);
  const ingestRes = await sfuFetch(c.env, "/adapters/websocket/new", {
    tracks: [{
      location: "local",
      trackName: sessionId,
      endpoint: ingestCallbackUrl,
      inputCodec: "pcm",
      mode: "buffer",
    }],
  });
  const ingestData = await ingestRes.json() as {
    tracks?: { adapterId?: string; sessionId?: string }[];
  };
  if (!ingestData.tracks?.[0]?.adapterId) {
    return c.json({ error: "Failed to create ingest adapter", detail: ingestData }, 500);
  }

  // 4. Store SFU state on the DO
  const stub = getVoiceDO(c.env, sessionId);
  await stub.fetch(new Request("https://internal/set-sfu-state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sfuSessionId,
      audioTrackName,
      ingestAdapterId: ingestData.tracks[0].adapterId,
      ingestSessionId: ingestData.tracks[0].sessionId,
    }),
  }));

  return c.json({
    sessionDescription: tracksData.sessionDescription,
    sfuSessionId,
    audioTrackName,
    pull: {
      ingestSessionId: ingestData.tracks[0].sessionId,
      ingestTrackName: sessionId,
    },
  });
});

// POST /api/voice/pull-track — pull TTS audio into learner's SFU session
sfuVoiceApp.post("/api/voice/pull-track", async (c) => {
  const { sfuSessionId, ingestSessionId, ingestTrackName } = await c.req.json<{
    sfuSessionId: string;
    ingestSessionId: string;
    ingestTrackName: string;
  }>();

  if (!sfuSessionId || !ingestSessionId || !ingestTrackName) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  const pullRes = await sfuFetch(c.env, `/sessions/${sfuSessionId}/tracks/new`, {
    tracks: [{ location: "remote", sessionId: ingestSessionId, trackName: ingestTrackName }],
  });
  const pullData = await pullRes.json() as { errorCode?: string; sessionDescription?: unknown; tracks?: unknown; requiresImmediateRenegotiation?: boolean };

  if (pullData.errorCode) {
    return c.json({ error: "Pull track failed", detail: pullData }, 500);
  }

  return c.json({
    sessionDescription: pullData.sessionDescription,
    requiresImmediateRenegotiation: pullData.requiresImmediateRenegotiation,
    tracks: pullData.tracks,
  });
});

// POST /api/voice/renegotiate — forward SDP answer to SFU
sfuVoiceApp.post("/api/voice/renegotiate", async (c) => {
  const { sfuSessionId, sessionDescription } = await c.req.json<{
    sfuSessionId: string;
    sessionDescription: unknown;
  }>();

  if (!sfuSessionId || !sessionDescription) {
    return c.json({ error: "Missing sfuSessionId or sessionDescription" }, 400);
  }

  const url = `${c.env.SFU_API_BASE}/apps/${c.env.REALTIME_SFU_APP_ID}/sessions/${sfuSessionId}/renegotiate`;
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${c.env.REALTIME_SFU_BEARER_TOKEN}`,
    },
    body: JSON.stringify({ sessionDescription }),
  });
  const data = await res.json() as { errorCode?: string };

  if (data.errorCode) {
    return c.json({ error: "Renegotiate failed", detail: data }, 500);
  }

  return c.json({ ok: true, ...data });
});

// POST /api/voice/start-forwarding — create stream adapter (learner mic → DO)
sfuVoiceApp.post("/api/voice/start-forwarding", async (c) => {
  const { sessionId } = await c.req.json<{ sessionId: string }>();
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

  const stub = getVoiceDO(c.env, sessionId);

  // Get stored SFU state from DO
  const stateRes = await stub.fetch(new Request("https://internal/sfu-state"));
  const sfuState = await stateRes.json() as { sfuSessionId?: string; audioTrackName?: string };

  if (!sfuState.sfuSessionId || !sfuState.audioTrackName) {
    return c.json({ error: "SFU state not set. Call /api/voice/connect first." }, 400);
  }

  const streamCallbackUrl = buildWssUrl(c.req.raw, `/api/voice/session/${sessionId}/ws/stream`);

  const streamRes = await sfuFetch(c.env, "/adapters/websocket/new", {
    tracks: [{
      location: "remote",
      sessionId: sfuState.sfuSessionId,
      trackName: sfuState.audioTrackName,
      endpoint: streamCallbackUrl,
      outputCodec: "pcm",
    }],
  });
  const streamData = await streamRes.json() as {
    tracks?: { adapterId?: string }[];
  };

  if (!streamData.tracks?.[0]?.adapterId) {
    return c.json({ error: "Failed to create stream adapter", detail: streamData }, 500);
  }

  await stub.fetch(new Request("https://internal/set-stream-adapter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ streamAdapterId: streamData.tracks[0].adapterId }),
  }));

  return c.json({ ok: true });
});

// POST /api/voice/end — end session
sfuVoiceApp.post("/api/voice/end", async (c) => {
  const { sessionId } = await c.req.json<{ sessionId: string }>();
  if (!sessionId) return c.json({ error: "Missing sessionId" }, 400);

  const stub = getVoiceDO(c.env, sessionId);
  const res = await stub.fetch(new Request("https://internal/end", { method: "POST" }));
  return res;
});

// Proxy /api/voice/session/:sessionId/* → DO (WS connections from SFU + browser)
sfuVoiceApp.all("/api/voice/session/:sessionId/*", async (c) => {
  const sessionId = c.req.param("sessionId");
  const stub = getVoiceDO(c.env, sessionId);

  // Strip the prefix to get the path the DO expects
  const url = new URL(c.req.url);
  const suffix = url.pathname.replace(`/api/voice/session/${sessionId}`, "") || "/";

  const isWebSocket = c.req.header("upgrade") === "websocket";

  return stub.fetch(new Request(`https://internal${suffix}`, {
    method: c.req.method,
    headers: c.req.raw.headers,
    ...(isWebSocket ? {} : { body: c.req.raw.body }),
  }));
});

export default sfuVoiceApp;
