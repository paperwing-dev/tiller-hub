import { env } from "hono/adapter";
import { createMiddleware } from "hono/factory";
import { routePartykitRequest } from "partyserver";
import { durableObjectOptions } from "./durable-object";
import type { HonoEnv } from "./types";

/** The small Hono adapter we use from hono-party, kept local until that package supports Workers Types v5. */
export function partyserverMiddleware() {
  return createMiddleware<HonoEnv>(async (c, next) => {
    const isWebSocket = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const bindings = env(c);
    const response = await routePartykitRequest(
      c.req.raw.clone(),
      bindings,
      durableObjectOptions(c.env),
    );
    if (!isWebSocket) return response ?? next();

    const webSocket = (response as (Response & { webSocket?: WebSocket }) | null)?.webSocket;
    if (!webSocket) return next();
    return new Response(null, {
      status: 101,
      webSocket,
    } as ResponseInit);
  });
}
