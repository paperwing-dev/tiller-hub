import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import executionRoutes from "../execution/routes";
import type { Env, ExecutionStatus, HonoEnv } from "../types";

const status: ExecutionStatus = {
  selected: { target: "cf" },
  selectedHost: null,
  candidate: { state: "not_connected" },
  executionReady: true,
};

const manifest = {
  version: 1 as const,
  capturedAt: "2026-07-17T00:00:00.000Z",
  customHostname: "legacy.example.com",
  workerService: "tiller-hub",
  accountId: "account-1",
  zoneId: "zone-1",
  customDomainId: "domain-1",
  accessApplicationId: "app-1",
  accessPolicyIds: ["policy-1", "policy-2"],
};

function createSubject(overrides: {
  manifest?: typeof manifest | null;
  setResult?: unknown;
} = {}) {
  const store = {
    getExecutionStatus: vi.fn(async () => status),
    setExecutionBackend: vi.fn(async () => (
      overrides.setResult ?? { ok: true, status }
    )),
    getLegacyCustomDomainCleanupManifest: vi.fn(async () => (
      overrides.manifest === undefined ? manifest : overrides.manifest
    )),
  };
  const env = {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => store),
    },
  } as unknown as Env;
  const app = new Hono<HonoEnv>();
  app.route("/", executionRoutes);
  return { app, env, store };
}

describe("execution settings routes", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads status directly on every uncached request", async () => {
    const { app, env, store } = createSubject();

    const first = await app.request("/api/execution/status", {}, env);
    const second = await app.request("/api/execution/status", {}, env);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    expect(store.getExecutionStatus).toHaveBeenCalledTimes(2);
    await expect(first.json()).resolves.toEqual(status);
  });

  it("passes the exact machine precondition and returns structured conflicts", async () => {
    const conflict = {
      ok: false as const,
      code: "execution_candidate_changed" as const,
      message: "The available machine changed or disconnected.",
      status,
    };
    const { app, env, store } = createSubject({ setResult: conflict });

    const response = await app.request("/api/settings/execution-backend", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target: "host",
        expectedMachineId: "machine-1",
      }),
    }, env);

    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(store.setExecutionBackend).toHaveBeenCalledWith({
      target: "host",
      expectedMachineId: "machine-1",
    });
    await expect(response.json()).resolves.toEqual(conflict);
  });

  it("downloads only the versioned secret-free cleanup manifest", async () => {
    const { app, env } = createSubject();
    const response = await app.request(
      "/api/settings/legacy-custom-domain-cleanup",
      {},
      env,
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Disposition")).toBe(
      'attachment; filename="tiller-legacy-custom-domain-cleanup-v1.json"',
    );
    expect(body).toEqual(manifest);
    expect(JSON.stringify(body)).not.toMatch(/secret|credential|token/i);
  });

  it("returns an uncached 404 when no cleanup manifest exists", async () => {
    const { app, env } = createSubject({ manifest: null });
    const response = await app.request(
      "/api/settings/legacy-custom-domain-cleanup",
      {},
      env,
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
