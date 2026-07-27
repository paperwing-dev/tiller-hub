import { Hono } from "hono";
import { authenticateAccessRequest } from "../auth";
import { getLocationHintOptions } from "../helpers";
import type { HonoEnv } from "../types";

// Authenticated voice WebSocket route.
//
// Uses idFromName(sessionId) so one TillerVoice DO instance per Claude session.

const voiceApp = new Hono<HonoEnv>();

voiceApp.get("/api/voice/session", async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") {
    return c.json({ error: "Expected WebSocket upgrade" }, 426);
  }

  const sessionId = c.req.query("sessionId");
  if (!sessionId) {
    return c.json({ error: "Missing sessionId" }, 400);
  }

  try {
    await authenticateAccessRequest(c.req.raw, c.env);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const id = c.env.TILLER_VOICE.idFromName(sessionId);
  const stub = c.env.TILLER_VOICE.get(id, getLocationHintOptions(c.env));
  return stub.fetch(new Request(c.req.url, c.req.raw));
});

export default voiceApp;
