import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  startSandbox,
  stopSandbox,
  getIdleTimeoutMinutes,
} = vi.hoisted(() => ({
  startSandbox: vi.fn(),
  stopSandbox: vi.fn(),
  getIdleTimeoutMinutes: vi.fn(),
}));

vi.mock("../helpers", () => ({
  getSandboxStub: vi.fn(() => ({
    startSandbox,
    stopSandbox,
    getStatus: vi.fn(),
    destroySandbox: vi.fn(),
    fetch: vi.fn(),
  })),
  getLocationHintOptions: vi.fn(() => undefined),
}));

vi.mock("../setup/config", () => ({
  getIdleTimeoutMinutes,
}));

import { createCloudflareRunnerBackend } from "../env/runner-backend-cf";
import { createHostRunnerBackend } from "../env/runner-backend-host";
import { createInitialEnvScmState } from "../scm/model";
import type { EnvMeta } from "../types";

function createMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "host",
    executionPlacement: { backend: "host", machineId: "host-1" },
    harness: "codex",
    harnessSettings: null,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    status: "stopped",
    ...createInitialEnvScmState({ slug: "demo-env", mainCommit: null }),
    ...overrides,
  };
}

describe("lifecycle op-id propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIdleTimeoutMinutes.mockResolvedValue(15);
  });

  it("uses one fenced operation id on the host wire while validating lifecycle ids", async () => {
    const requestLocalRunner = vi
      .fn()
      .mockResolvedValueOnce({
        machineId: "host-1",
        result: {
          runnerId: "demo-env",
          commandGeneration: 41,
          operationId: "start-op-1",
          desiredState: "running",
        },
      })
      .mockResolvedValueOnce({
        machineId: "host-1",
        result: {
          callbackExpected: false,
          commandGeneration: 42,
          operationId: "stop-op-1",
          desiredState: "stopped",
        },
      });
    const env = {
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub"),
        get: vi.fn().mockReturnValue({ requestLocalRunner }),
      },
    } as any;

    const backend = await createHostRunnerBackend(env);
    await backend.start(
      createMeta(),
      { FOO: "bar" },
      {
        startOpId: " start-op-1 ",
        runnerCommand: {
          commandGeneration: 41,
          operationId: "start-op-1",
          desiredState: "running",
        },
      },
    );
    await expect(
      backend.stop(createMeta(), {
        stopOpId: " stop-op-1 ",
        runnerCommand: {
          commandGeneration: 42,
          operationId: "stop-op-1",
          desiredState: "stopped",
        },
      }),
    ).resolves.toEqual({ callbackExpected: false });

    expect(requestLocalRunner).toHaveBeenNthCalledWith(
      1,
      "host-1",
      "start",
      "demo-env",
      {
        repoUrl: "https://github.com/test/repo",
        envVars: { FOO: "bar" },
        commandGeneration: 41,
        operationId: "start-op-1",
        desiredState: "running",
      },
    );
    expect(requestLocalRunner).toHaveBeenNthCalledWith(
      2,
      "host-1",
      "stop",
      "demo-env",
      {
        commandGeneration: 42,
        operationId: "stop-op-1",
        desiredState: "stopped",
      },
    );
  });

  it("passes fenced command claims through host create and destroy", async () => {
    const requestLocalRunner = vi
      .fn()
      .mockResolvedValueOnce({
        machineId: "host-1",
        result: {
          runnerId: "demo-env",
          commandGeneration: 3,
          operationId: "create-op-3",
          desiredState: "running",
        },
      })
      .mockResolvedValueOnce({
        machineId: "host-1",
        result: {
          removed: true,
          commandGeneration: 4,
          operationId: "destroy-op-4",
          desiredState: "absent",
        },
      });
    const env = {
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub"),
        get: vi.fn().mockReturnValue({ requestLocalRunner }),
      },
    } as any;
    const backend = await createHostRunnerBackend(env);

    await backend.create(createMeta(), { FOO: "bar" }, {
      startOpId: "create-op-3",
      runnerCommand: {
        commandGeneration: 3,
        operationId: "create-op-3",
        desiredState: "running",
      },
    });
    await backend.destroy(createMeta(), {
      runnerCommand: {
        commandGeneration: 4,
        operationId: "destroy-op-4",
        desiredState: "absent",
      },
    });

    expect(requestLocalRunner).toHaveBeenNthCalledWith(1, "host-1", "create", "demo-env", {
      repoUrl: "https://github.com/test/repo",
      envVars: { FOO: "bar" },
      commandGeneration: 3,
      operationId: "create-op-3",
      desiredState: "running",
    });
    expect(requestLocalRunner).toHaveBeenNthCalledWith(2, "host-1", "destroy", "demo-env", {
      commandGeneration: 4,
      operationId: "destroy-op-4",
      desiredState: "absent",
    });
  });

  it("injects the start op id into cloudflare sandbox env vars and forwards the stop op id", async () => {
    const backend = createCloudflareRunnerBackend({} as any);

    await backend.start(
      createMeta({ backend: "cf" }),
      { FOO: "bar" },
      { startOpId: " start-op-2 " },
    );
    await expect(
      backend.stop(createMeta({ backend: "cf" }), { stopOpId: "stop-op-2" }),
    ).resolves.toEqual({ callbackExpected: true });

    expect(getIdleTimeoutMinutes).toHaveBeenCalled();
    expect(startSandbox).toHaveBeenCalledWith(
      "demo-env",
      {
        FOO: "bar",
        TILLER_LIFECYCLE_START_OP_ID: "start-op-2",
      },
      15,
      "start-op-2",
    );
    expect(stopSandbox).toHaveBeenCalledWith("stop-op-2");
  });
});
