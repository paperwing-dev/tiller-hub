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
import type { EnvMeta } from "../types";

function createMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "demo-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    runnerId: null,
    runnerMachineId: null,
    backend: "host",
    harness: "codex",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    status: "stopped",
    ...overrides,
  };
}

describe("lifecycle op-id propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getIdleTimeoutMinutes.mockResolvedValue(15);
  });

  it("passes trimmed start and stop op ids through the host runner control path", async () => {
    const requestLocalRunner = vi
      .fn()
      .mockResolvedValueOnce({
        machineId: "host-1",
        result: { runnerId: "demo-env" },
      })
      .mockResolvedValueOnce({
        machineId: "host-1",
        result: { callbackExpected: false },
      });
    const env = {
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub"),
        get: vi.fn().mockReturnValue({ requestLocalRunner }),
      },
    } as any;

    const backend = await createHostRunnerBackend(env);
    await backend.start(
      createMeta({ runnerMachineId: "host-1" }),
      { FOO: "bar" },
      { startOpId: " start-op-1 " },
    );
    await expect(
      backend.stop(createMeta({ runnerMachineId: "host-1" }), { stopOpId: " stop-op-1 " }),
    ).resolves.toEqual({ callbackExpected: false });

    expect(requestLocalRunner).toHaveBeenNthCalledWith(
      1,
      "host-1",
      "start",
      "demo-env",
      {
        repoUrl: "https://github.com/test/repo",
        envVars: { FOO: "bar" },
        startOpId: "start-op-1",
      },
    );
    expect(requestLocalRunner).toHaveBeenNthCalledWith(
      2,
      "host-1",
      "stop",
      "demo-env",
      {
        stopOpId: "stop-op-1",
      },
    );
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
