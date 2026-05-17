import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { HonoEnv } from "../../types";
import workspaceRoutes from "../routes";

function createTestApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", workspaceRoutes);
  return app;
}

describe("workspace routes", () => {
  it("removes URL-based workspace initialization", async () => {
    const app = createTestApp();
    const res = await app.request("/api/workspace/dev/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repoUrl: "https://github.com/test/repo" }),
    }, {} as any);

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({
      code: "workspace_init_removed",
    });
  });
});
