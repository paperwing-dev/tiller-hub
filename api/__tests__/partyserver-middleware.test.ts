import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { routePartykitRequest } = vi.hoisted(() => ({
  routePartykitRequest: vi.fn(),
}));

vi.mock("partyserver", () => ({ routePartykitRequest }));

import { partyserverMiddleware } from "../partyserver-middleware";

describe("partyserverMiddleware", () => {
  beforeEach(() => routePartykitRequest.mockReset());

  it("returns PartyServer HTTP responses", async () => {
    routePartykitRequest.mockResolvedValue(new Response("party"));
    const app = new Hono();
    app.use("/parties/*", partyserverMiddleware());

    const response = await app.request("https://hub.example/parties/hub/hub");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("party");
    expect(routePartykitRequest).toHaveBeenCalledTimes(1);
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
