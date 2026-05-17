import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { resolveHostStatus } from "./status-resolver";

const hostRoutes = new Hono<HonoEnv>();

hostRoutes.get("/api/host/status", async (c) => {
  return c.json(await resolveHostStatus(c.env));
});

export default hostRoutes;
