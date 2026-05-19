import { describe, it, expect, vi } from "vitest";

vi.mock("../setup/config", () => ({
  getSecret: async () => undefined,
}));

import { destroyEnv } from "../env/service";

describe("destroyEnv", () => {
  it("deletes KV entry even when runner backend destroy fails", async () => {
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const getAllSessions = vi.fn().mockResolvedValue([]);
    const destroyWorkspace = vi.fn().mockResolvedValue(undefined);
    const clearMutableState = vi.fn().mockResolvedValue(null);

    const env = {
      ENVS_KV: { delete: kvDelete },
      BUCKET: {
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      // getWorkspaceStub uses WORKSPACE DO binding
      WORKSPACE: {
        idFromName: vi.fn().mockReturnValue("ws-id"),
        get: vi.fn().mockReturnValue({ destroyWorkspace }),
      },
      ENV_LIFECYCLE: {
        idFromName: vi.fn().mockReturnValue("lifecycle-id"),
        get: vi.fn().mockReturnValue({ clearMutableState }),
      },
      // No active host registration — getRunnerBackend will throw for the host backend
    } as any;

    const meta = {
      slug: "test-env",
      repoUrl: "https://github.com/test/repo",
      runnerMachineId: "m-123",
      backend: "host" as const,
      createdAt: "2024-01-01",
    };

    const hub = { broadcastEnvRemove: broadcast, getAllSessions, deleteSession: vi.fn() };

    // Should NOT throw even though no runner is registered
    await destroyEnv(env, meta, hub);

    expect(destroyWorkspace).toHaveBeenCalled();
    expect(kvDelete).toHaveBeenCalledWith("test-env");
    expect(kvDelete).toHaveBeenCalledWith("envdef:test-env");
    expect(kvDelete).toHaveBeenCalledTimes(2);
    expect(clearMutableState).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("test-env");
  });

  it("deletes KV entry when runner backend is available and destroy succeeds", async () => {
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const getAllSessions = vi.fn().mockResolvedValue([]);
    const destroyWorkspace = vi.fn().mockResolvedValue(undefined);
    const backendDestroy = vi.fn().mockResolvedValue(undefined);
    const clearMutableState = vi.fn().mockResolvedValue(null);

    const env = {
      ENVS_KV: { delete: kvDelete },
      BUCKET: {
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      WORKSPACE: {
        idFromName: vi.fn().mockReturnValue("ws-id"),
        get: vi.fn().mockReturnValue({ destroyWorkspace }),
      },
      ENV_LIFECYCLE: {
        idFromName: vi.fn().mockReturnValue("lifecycle-id"),
        get: vi.fn().mockReturnValue({ clearMutableState }),
      },
      SANDBOX: {
        idFromName: vi.fn().mockReturnValue("sb-id"),
        get: vi.fn().mockReturnValue({ destroySandbox: backendDestroy }),
      },
    } as any;

    const meta = {
      slug: "test-env",
      repoUrl: "https://github.com/test/repo",
      runnerMachineId: "m-123",
      backend: "cf" as const,
      createdAt: "2024-01-01",
    };

    const hub = { broadcastEnvRemove: broadcast, getAllSessions, deleteSession: vi.fn() };

    await destroyEnv(env, meta, hub);

    expect(destroyWorkspace).toHaveBeenCalled();
    expect(kvDelete).toHaveBeenCalledWith("test-env");
    expect(kvDelete).toHaveBeenCalledWith("envdef:test-env");
    expect(kvDelete).toHaveBeenCalledTimes(2);
    expect(clearMutableState).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("test-env");
  });
});
