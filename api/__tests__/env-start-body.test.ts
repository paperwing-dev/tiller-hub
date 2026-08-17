import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

const actionMocks = vi.hoisted(() => ({
  createEnvAction: vi.fn(),
  startEnvAction: vi.fn(),
}));

vi.mock("../env/lifecycle-actions", () => ({
  createEnvAction: actionMocks.createEnvAction,
  deleteEnvAction: vi.fn(),
  startEnvAction: actionMocks.startEnvAction,
  stopEnvAction: vi.fn(),
}));

const { default: envRoutes } = await import("../env/routes");

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", envRoutes);
  return app;
}

describe("POST /api/envs/:slug/start request body", () => {
  beforeEach(() => {
    actionMocks.startEnvAction.mockReset().mockResolvedValue({
      status: 200,
      body: { ok: true, slug: "demo", status: "starting" },
    });
  });

  it.each([
    ["malformed JSON", '{"harnessSettings":'],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"settings"'],
    ["a number", "42"],
  ])("rejects %s instead of defaulting settings", async (_label, body) => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs/demo/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_json_body" });
    expect(actionMocks.startEnvAction).not.toHaveBeenCalled();
  });

  it.each(["fresh", "plan"] as const)("passes the %s implementation mode to Start", async (implementationMode) => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs/demo/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ implementationMode }),
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(200);
    expect(actionMocks.startEnvAction).toHaveBeenCalledWith(expect.objectContaining({ implementationMode }));
  });

  it("rejects an unknown implementation mode", async () => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs/demo/start",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ implementationMode: "surprise" }),
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_implementation_mode" });
    expect(actionMocks.startEnvAction).not.toHaveBeenCalled();
  });

  it.each([
    ["without a content type", {}],
    ["with an explicitly empty JSON body", {
      headers: { "Content-Type": "application/json" },
      body: "",
    }],
  ])("preserves bodyless old-client Starts %s", async (_label, init) => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs/demo/start",
      { method: "POST", ...init },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(200);
    expect(actionMocks.startEnvAction).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo",
        harnessSettings: undefined,
      }),
    );
  });
});

describe("POST /api/envs request body", () => {
  beforeEach(() => {
    actionMocks.createEnvAction.mockReset().mockResolvedValue({
      status: 201,
      body: { ok: true, slug: "demo", status: "creating" },
    });
  });

  it.each([
    ["malformed JSON", '{"repoId":'],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"settings"'],
    ["a number", "42"],
  ])("rejects %s as an invalid JSON object", async (_label, body) => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_json_body" });
    expect(actionMocks.createEnvAction).not.toHaveBeenCalled();
  });

  it("rejects a non-string slug before invoking creation", async () => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          harness: "codex",
          slug: 42,
        }),
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: "invalid_slug" });
    expect(actionMocks.createEnvAction).not.toHaveBeenCalled();
  });

  it("keeps accepting a valid JSON object without a content type", async () => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs",
      {
        method: "POST",
        body: JSON.stringify({
          repoId: "repo-1",
          harness: "codex",
        }),
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(201);
    expect(actionMocks.createEnvAction).toHaveBeenCalledWith(expect.objectContaining({
      repoId: "repo-1",
      harness: "codex",
    }));
  });

  it("rejects retired per-workload backend selection", async () => {
    const response = await createApp().request(
      "https://hub.example.com/api/envs",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoId: "repo-1",
          backend: "cf",
          harness: "codex",
        }),
      },
      {} as HonoEnv["Bindings"],
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "backend_selection_removed",
    });
    expect(actionMocks.createEnvAction).not.toHaveBeenCalled();
  });
});
