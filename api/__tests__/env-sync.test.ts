import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { HonoEnv, StoredSession } from "../types";

const mocks = vi.hoisted(() => ({
  getHub: vi.fn(),
  loadEnvView: vi.fn(),
}));

vi.mock("../env/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../env/service")>();
  return {
    ...actual,
    getHub: mocks.getHub,
    loadEnvView: mocks.loadEnvView,
  };
});

import envRoutes from "../env/routes";

function session(
  id: string,
  envSlug: string,
  role: string,
  options: { active?: 0 | 1; endedAt?: string | null } = {},
): StoredSession {
  return {
    id,
    tag: envSlug,
    machine_id: "cloudchamber",
    active: options.active ?? 1,
    created_at: "2026-08-12 00:00:00",
    updated_at: "2026-08-12 00:00:00",
    ended_at: options.endedAt ?? null,
    metadata: JSON.stringify({ envSlug, role }),
    metadata_version: 1,
    agent_state: null,
    agent_state_version: 0,
    todos: null,
    todos_version: 0,
    allowed_tools: null,
    seq: 0,
  };
}

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", envRoutes);
  return app;
}

describe("POST /api/envs/:slug/sync", () => {
  const addMessage = vi.fn();
  const getAllSessions = vi.fn();
  const getRoutableSessionIds = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadEnvView.mockResolvedValue({ slug: "demo-env" });
    mocks.getHub.mockReturnValue({
      addMessage,
      getAllSessions,
      getRoutableSessionIds,
    });
    addMessage.mockResolvedValue({});
  });

  it("sends sync to the routable active lead session UUID", async () => {
    getAllSessions.mockResolvedValue([
      session("lead-session", "demo-env", "lead"),
      session("reviewer-session", "demo-env", "reviewer"),
      session("other-env-session", "other-env", "lead"),
      session("ended-lead", "demo-env", "lead", { endedAt: "2026-08-12 00:01:00" }),
    ]);
    getRoutableSessionIds.mockResolvedValue([
      "lead-session",
      "reviewer-session",
      "other-env-session",
      "ended-lead",
    ]);

    const response = await createApp().request(
      "/api/envs/demo-env/sync",
      { method: "POST" },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      slug: "demo-env",
      message: "Sync triggered",
      sessionCount: 1,
    });
    expect(addMessage).toHaveBeenCalledOnce();
    expect(addMessage).toHaveBeenCalledWith(
      expect.any(String),
      "lead-session",
      { type: "sync" },
      null,
    );
  });

  it("returns a conflict when no lead harness is currently routable", async () => {
    getAllSessions.mockResolvedValue([
      session("stale-lead", "demo-env", "lead"),
      session("reviewer-session", "demo-env", "reviewer"),
    ]);
    getRoutableSessionIds.mockResolvedValue(["reviewer-session"]);

    const response = await createApp().request(
      "/api/envs/demo-env/sync",
      { method: "POST" },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "No active implementor session is connected.",
    });
    expect(addMessage).not.toHaveBeenCalled();
  });

  it("preserves the not-found response", async () => {
    mocks.loadEnvView.mockResolvedValue(null);

    const response = await createApp().request(
      "/api/envs/missing/sync",
      { method: "POST" },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(404);
    expect(getAllSessions).not.toHaveBeenCalled();
  });
});
