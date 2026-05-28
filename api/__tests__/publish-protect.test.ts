import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

vi.mock("../setup/config", () => ({
  getIdleTimeoutMinutes: vi.fn(async () => 10),
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
}));

import setupRoutes from "../setup/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", setupRoutes);
  return app;
}

describe("POST /api/setup/publish-protect", () => {
  it("is removed", async () => {
    const app = createApp();
    const res = await app.request(
      "/api/setup/publish-protect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostname: "tiller.paperwing.dev",
          apiToken: "cfat_test",
          emails: ["jamie@example.com"],
        }),
      },
      {} as any,
    );

    expect(res.status).toBe(404);
  });
});
