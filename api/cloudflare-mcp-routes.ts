import { Hono } from "hono";
import type { Context } from "hono";
import type { HonoEnv } from "./types";
import type { HubDO } from "./hub";
import { proxyCloudflareMcpRequest, type CloudflareMcpProxyHub } from "./cloudflare-mcp";

type CloudflareMcpHub = Pick<
  HubDO,
  | "validateCloudflareMcpProxyToken"
  | "getValidCloudflareMcpAccessToken"
  | "recordCloudflareMcpAuditEvent"
>;

function getHub(env: HonoEnv["Bindings"]): CloudflareMcpHub {
  const id = env.HUB.idFromName("hub");
  return env.HUB.get(id) as unknown as CloudflareMcpHub;
}

const cloudflareMcpRoutes = new Hono<HonoEnv>();

async function handleProxy(c: Context<HonoEnv>) {
  return await proxyCloudflareMcpRequest(c.req.raw, getHub(c.env) as unknown as CloudflareMcpProxyHub);
}

cloudflareMcpRoutes.get("/api/mcp/cloudflare", handleProxy);
cloudflareMcpRoutes.post("/api/mcp/cloudflare", handleProxy);
cloudflareMcpRoutes.delete("/api/mcp/cloudflare", handleProxy);

export default cloudflareMcpRoutes;
