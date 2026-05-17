import { Hono } from "hono";
import type { HonoEnv } from "../types";
import { checkForUpdate } from "./check-release";
import { applyGitHubRepoUpdate } from "./github-repo-update";
import { detectHubUpdateRepo, selectHubUpdateRepo } from "./hub-repo";

const updateRoutes = new Hono<HonoEnv>();

updateRoutes.get("/api/update/check", async (c) => {
  return c.json(await checkForUpdate(c.env));
});

updateRoutes.post("/api/update/hub-repo/detect", async (c) => {
  try {
    return c.json(await detectHubUpdateRepo(c.env, { detectedBy: "manual" }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hub update repo detection failed";
    return c.json({ error: message }, 500);
  }
});

updateRoutes.post("/api/update/hub-repo/select", async (c) => {
  const body = await c.req.json<{
    repoId?: unknown;
    installationId?: unknown;
    fullName?: unknown;
    branch?: unknown;
  }>().catch(() => ({}));
  try {
    return c.json(await selectHubUpdateRepo(c.env, body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Hub update repo selection failed";
    return c.json({ error: message }, 400);
  }
});

updateRoutes.post("/api/update/apply", async (c) => {
  return c.json(await applyGitHubRepoUpdate(c.env));
});

updateRoutes.post("/api/update/repair/cloudflare-redeploy", async (c) => {
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
