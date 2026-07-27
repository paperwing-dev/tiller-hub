import { describe, it, expect, vi } from "vitest";
import { createInitialEnvScmState } from "../scm/model";
import type { EnvMeta } from "../types";

vi.mock("../setup/config", () => ({
  getSecret: async () => undefined,
}));

import { destroyEnv } from "../env/service";

function createEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const slug = overrides.slug ?? "test-env";
  return {
    slug,
    repoUrl: "https://github.com/test/repo",
    backend: "cf",
    harness: "claude-code",
    createdAt: "2024-01-01",
    updatedAt: "2024-01-01",
    status: "stopped",
    ...createInitialEnvScmState({ slug, mainCommit: null }),
    ...overrides,
  };
}

describe("destroyEnv", () => {
  it("preserves all durable environment data when host runner destruction fails", async () => {
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const getAllSessions = vi.fn().mockResolvedValue([]);
    const destroyWorkspace = vi.fn().mockResolvedValue(undefined);
    const finalizeDeletion = vi.fn().mockResolvedValue(undefined);

    const env = {
      ENVS_KV: {
        delete: kvDelete,
        get: vi.fn().mockResolvedValue(null),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      },
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
        get: vi.fn().mockReturnValue({ finalizeDeletion }),
      },
      ENV_REVIEW: {
        idFromName: vi.fn().mockReturnValue("review-id"),
        get: vi.fn().mockReturnValue({
          finalizeEnvironmentDeletion: vi.fn().mockResolvedValue(undefined),
        }),
      },
      // No active host registration — getRunnerBackend will throw for the host backend
    } as any;

    const meta = createEnvMeta({
      slug: "test-env",
      repoUrl: "https://github.com/test/repo",
      backend: "host" as const,
      executionPlacement: { backend: "host", machineId: "m-123" },
      createdAt: "2024-01-01",
    });

    const hub = {
      broadcastEnvRemove: broadcast,
      getAllSessions,
      deleteSession: vi.fn(),
      revokeCloudflareMcpProxyTokensForEnv: vi.fn(),
    };

    await expect(destroyEnv(env, meta, hub)).rejects.toThrow();

    expect(destroyWorkspace).not.toHaveBeenCalled();
    expect(kvDelete).not.toHaveBeenCalled();
    expect(finalizeDeletion).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("deletes KV entry when runner backend is available and destroy succeeds", async () => {
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const getAllSessions = vi.fn().mockResolvedValue([]);
    const destroyWorkspace = vi.fn().mockResolvedValue(undefined);
    const backendDestroy = vi.fn().mockResolvedValue(undefined);
    const finalizeDeletion = vi.fn().mockResolvedValue(undefined);

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
        get: vi.fn().mockReturnValue({ finalizeDeletion }),
      },
      ENV_REVIEW: {
        idFromName: vi.fn().mockReturnValue("review-id"),
        get: vi.fn().mockReturnValue({
          finalizeEnvironmentDeletion: vi.fn().mockResolvedValue(undefined),
        }),
      },
      SANDBOX: {
        idFromName: vi.fn().mockReturnValue("sb-id"),
        get: vi.fn().mockReturnValue({ destroySandbox: backendDestroy }),
      },
    } as any;

    const meta = createEnvMeta({
      slug: "test-env",
      repoUrl: "https://github.com/test/repo",
      backend: "cf" as const,
      executionPlacement: { backend: "cf", machineId: null },
      createdAt: "2024-01-01",
    });

    const hub = {
      broadcastEnvRemove: broadcast,
      getAllSessions,
      deleteSession: vi.fn(),
      revokeCloudflareMcpProxyTokensForEnv: vi.fn(),
    };

    await destroyEnv(env, meta, hub);

    expect(destroyWorkspace).toHaveBeenCalled();
    expect(kvDelete).toHaveBeenCalledWith("test-env");
    expect(kvDelete).toHaveBeenCalledWith("envdef:test-env");
    expect(kvDelete).toHaveBeenCalledTimes(2);
    expect(finalizeDeletion).toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith("test-env");
  });

  it("keeps the discoverable definition and reports failure when lifecycle finalization fails", async () => {
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const broadcast = vi.fn().mockResolvedValue(undefined);
    const finalizeDeletion = vi.fn().mockRejectedValue(new Error("durable finalization unavailable"));
    const env = {
      ENVS_KV: { delete: kvDelete },
      BUCKET: {
        list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
        delete: vi.fn().mockResolvedValue(undefined),
      },
      WORKSPACE: {
        idFromName: vi.fn().mockReturnValue("ws-id"),
        get: vi.fn().mockReturnValue({ destroyWorkspace: vi.fn().mockResolvedValue(undefined) }),
      },
      ENV_LIFECYCLE: {
        idFromName: vi.fn().mockReturnValue("lifecycle-id"),
        get: vi.fn().mockReturnValue({ finalizeDeletion }),
      },
      ENV_REVIEW: {
        idFromName: vi.fn().mockReturnValue("review-id"),
        get: vi.fn().mockReturnValue({
          finalizeEnvironmentDeletion: vi.fn().mockResolvedValue(undefined),
        }),
      },
      SANDBOX: {
        idFromName: vi.fn().mockReturnValue("sb-id"),
        get: vi.fn().mockReturnValue({ destroySandbox: vi.fn().mockResolvedValue(undefined) }),
      },
    } as any;
    const hub = {
      broadcastEnvRemove: broadcast,
      getAllSessions: vi.fn().mockResolvedValue([]),
      deleteSession: vi.fn(),
      revokeCloudflareMcpProxyTokensForEnv: vi.fn(),
    };

    await expect(destroyEnv(env, createEnvMeta(), hub)).rejects.toThrow("durable finalization unavailable");

    expect(kvDelete).toHaveBeenCalledWith("test-env");
    expect(kvDelete).not.toHaveBeenCalledWith("envdef:test-env");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
