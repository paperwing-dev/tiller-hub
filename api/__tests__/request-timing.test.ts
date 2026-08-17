import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { createApiTimingMiddleware } from "../request-timing";

describe("API request timing", () => {
  it("preserves existing timings and logs only structured slow-request metadata", async () => {
    const warn = vi.fn();
    const times = [100, 2_201];
    const app = new Hono<HonoEnv>();
    app.use("*", createApiTimingMiddleware({
      now: () => times.shift() ?? 2_201,
      warn,
    }));
    app.get("/api/sessions", (c) => {
      c.get("apiRequestTiming").phases.push({ name: "sessions_load", durationMs: 12.3 });
      c.header("Server-Timing", "upstream;dur=4.0");
      return c.json({ ok: true });
    });

    const response = await app.request("https://hub.test/api/sessions?token=secret");

    expect(response.headers.get("Server-Timing")).toContain("upstream;dur=4.0");
    expect(response.headers.get("Server-Timing")).toContain("sessions_load;dur=12.3");
    expect(response.headers.get("Server-Timing")).toContain("total;dur=2101.0");
    expect(warn).toHaveBeenCalledWith({
      event: "slow_api_request",
      method: "GET",
      pathname: "/api/sessions",
      status: 200,
      durationMs: 2_101,
      phases: { sessions_load: 12.3 },
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
  });

  it("does not decorate streaming responses", async () => {
    const app = new Hono<HonoEnv>();
    app.use("*", createApiTimingMiddleware());
    app.get("/events", () => new Response("data: ready\n\n", {
      headers: { "Content-Type": "text/event-stream" },
    }));

    const response = await app.request("https://hub.test/events");

    expect(response.headers.has("Server-Timing")).toBe(false);
  });
});
