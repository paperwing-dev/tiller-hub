import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { routePartykitRequest } = vi.hoisted(() => ({
  routePartykitRequest: vi.fn(),
}));

vi.mock("partyserver", () => ({ routePartykitRequest }));

import { partyserverMiddleware } from "../partyserver-middleware";
import type { HonoEnv } from "../types";

describe("partyserverMiddleware", () => {
  beforeEach(() => routePartykitRequest.mockReset());

  it("returns PartyServer HTTP responses", async () => {
    routePartykitRequest.mockResolvedValue(new Response("party"));
    const app = new Hono<HonoEnv>();
    app.use("/parties/*", partyserverMiddleware());

    const response = await app.request(
      "https://hub.example/parties/hub/hub",
      {},
      { DO_LOCATION_HINT: "wnam" } as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("party");
    expect(routePartykitRequest).toHaveBeenCalledTimes(1);
    expect(routePartykitRequest.mock.calls[0]?.[2]).toEqual({ locationHint: "wnam" });
  });

  it("falls through when PartyServer does not match", async () => {
    routePartykitRequest.mockResolvedValue(null);
    const app = new Hono();
    app.use("/parties/*", partyserverMiddleware());
    app.get("/parties/*", (c) => c.text("fallback", 404));

    const response = await app.request("https://hub.example/parties/unknown");

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("fallback");
  });
});
