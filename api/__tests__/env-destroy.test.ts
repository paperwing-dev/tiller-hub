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
  it("rebases host Destroy once without repeating deletion cleanup", async () => {
    const kvDelete = vi.fn().mockResolvedValue(undefined);
    const destroyWorkspace = vi.fn().mockResolvedValue(undefined);
    const finalizeDeletion = vi.fn().mockResolvedValue(undefined);
    let attempts = 0;
    const requestLocalRunner = vi.fn().mockImplementation(async (
      _machineId: string,
      action: string,
      _slug: string,
      options: Record<string, unknown>,
    ) => {
      expect(action).toBe("destroy");
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(
          new Error("Runner command generation 1 was superseded by 60."),
          {
            code: "runner_command_superseded_before_mutation",
            currentCommandGeneration: 60,
          },
        );
      }
      return {
        machineId: "m-123",
        result: {
          removed: true,
          commandGeneration: options.commandGeneration,
          operationId: options.operationId,
          desiredState: options.desiredState,
        },
      };
    });
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
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({ requestLocalRunner }),
      },
    } as any;
    const hub = {
      broadcastEnvRemove: vi.fn().mockResolvedValue(undefined),
      getAllSessions: vi.fn().mockResolvedValue([]),
      deleteSession: vi.fn(),
    };
    const initial = {
      commandGeneration: 1,
      operationId: "destroy-op-1",
      desiredState: "absent" as const,
    };
    const rebaseRunnerCommand = vi.fn().mockResolvedValue({
      ...initial,
      commandGeneration: 61,
    });

    await destroyEnv(env, createEnvMeta({
      backend: "host",
      executionPlacement: { backend: "host", machineId: "m-123" },
    }), hub, {
      runnerCommand: initial,
      rebaseRunnerCommand,
    });

    expect(rebaseRunnerCommand).toHaveBeenCalledWith(initial, 60);
    expect(requestLocalRunner).toHaveBeenCalledTimes(2);
    expect(requestLocalRunner.mock.calls.map((call) => call[3].commandGeneration))
      .toEqual([1, 61]);
    expect(destroyWorkspace).toHaveBeenCalledTimes(1);
    expect(finalizeDeletion).toHaveBeenCalledTimes(1);
  });

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
    };

    await expect(destroyEnv(env, createEnvMeta(), hub)).rejects.toThrow("durable finalization unavailable");

    expect(kvDelete).toHaveBeenCalledWith("test-env");
    expect(kvDelete).not.toHaveBeenCalledWith("envdef:test-env");
    expect(broadcast).not.toHaveBeenCalled();
  });
});
