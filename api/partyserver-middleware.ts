import { env } from "hono/adapter";
import { createMiddleware } from "hono/factory";
import { routePartykitRequest } from "partyserver";

/** The small Hono adapter we use from hono-party, kept local until that package supports Workers Types v5. */
export function partyserverMiddleware() {
  return createMiddleware(async (c, next) => {
    const isWebSocket = c.req.header("upgrade")?.toLowerCase() === "websocket";
    const response = await routePartykitRequest(c.req.raw.clone(), env(c));
    if (!isWebSocket) return response ?? next();

    const webSocket = (response as (Response & { webSocket?: WebSocket }) | null)?.webSocket;
    if (!webSocket) return next();
    return new Response(null, {
      status: 101,
      webSocket,
    } as ResponseInit);
  });
}
