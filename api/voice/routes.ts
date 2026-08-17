import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { getDurableObjectStub } from "../durable-object";

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

  const authorization = c.get("authorization");
  if (!authorization || authorization.kind !== "global") {
    return c.json({ error: "Global authority required" }, 403);
  }

  const stub = getDurableObjectStub<DurableObjectStub>(
    c.env,
    c.env.TILLER_VOICE,
    sessionId,
  );
  return stub.fetch(new Request(c.req.url, c.req.raw));
});

export default voiceApp;
