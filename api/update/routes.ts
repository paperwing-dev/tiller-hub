import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { checkForUpdate } from "./check-release";

const updateRoutes = new Hono<HonoEnv>();

updateRoutes.get("/api/update/check", async (c) => {
  return c.json(await checkForUpdate(c.env));
});

updateRoutes.post("/api/update/apply", async (c) => {
  const { applyUpdate } = await import("./deploy");
  const body: { apiToken?: string } = await c.req.json<{ apiToken?: string }>().catch(() => ({}));

  if (!body.apiToken?.trim()) {
    return c.json({ error: "Cloudflare API token is required" }, 400);
  }

  try {
    return c.json(await applyUpdate(c.env, c.req.url, body.apiToken));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Update failed";
    return c.json({ ok: false, error: message }, 500);
  }
});

export default updateRoutes;
