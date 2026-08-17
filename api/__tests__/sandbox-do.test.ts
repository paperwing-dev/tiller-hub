import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getHub: vi.fn(),
  projectAndPersistEnvSummary: vi.fn(),
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));

vi.mock("../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
}));

vi.mock("../env/service", () => ({
  getHub: mocks.getHub,
  projectAndPersistEnvSummary: mocks.projectAndPersistEnvSummary,
}));

import {
  CONTAINER_INSTANCE_ALLOCATION_TIMEOUT_MS,
  SandboxDO,
} from "../sandbox-do";
import { ENV_LIFECYCLE_START_TIMEOUT_MS } from "../env-lifecycle";

const runtimeScope = {
  envSlug: "demo-env",
  incarnationId: "inc-1",
  startOperationId: "start-op-1",
};

const stopScope = {
  ...runtimeScope,
  stopOperationId: "stop-op-1",
};

const preparedReceipt = {
  ...stopScope,
  workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
};

function createLifecycleState(overrides: Record<string, unknown> = {}) {
  return {
    phase: "saving",
    activeOpId: "stop-op-1",
    activeOperation: "stop",
    desiredState: "stopped",
    lastRunnerState: "running",
    lastWorkspaceSyncedAckOpId: null,
    infraState: "ready",
    runtimeReady: false,
    lastError: null,
    lastErrorAt: null,
    updatedAt: "2026-04-10T00:00:00.000Z",
    ...overrides,
  };
}

function createLifecycleStubForStop(overrides: Record<string, unknown> = {}) {
  const state = createLifecycleState(overrides);
  return {
    getState: vi.fn().mockResolvedValue(state),
    noteRunnerStopped: vi.fn().mockResolvedValue(state),
    noteFencedRunnerAbsentBeforeNightStart: vi.fn().mockResolvedValue(false),
    noteFencedNightStartRejectedBeforeMutation: vi.fn().mockResolvedValue(false),
    getStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(null),
    clearStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(undefined),
  };
}

let diagnosticLog: ReturnType<typeof vi.spyOn>;

function sandboxIdleDecisions() {
  return diagnosticLog.mock.calls
    .map((call: unknown[]) => {
      const value = call[0];
      if (typeof value !== "string") return null;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((value: Record<string, unknown> | null) => value?.component === "sandbox_idle_alarm");
}

function createIdleAlarmInstance(fetch: ReturnType<typeof vi.fn>, timeoutMs = 60_000) {
  const renewActivityTimeout = vi.fn();
  const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
    ctx: any;
    env: any;
    renewActivityTimeout: typeof renewActivityTimeout;
  };
  instance.ctx = {
    container: {
      running: true,
      getTcpPort: vi.fn().mockReturnValue({ fetch }),
    },
    storage: {
      get: vi.fn().mockImplementation((key: string) => Promise.resolve(
        key === "slug" ? "demo-env" : timeoutMs,
      )),
    },
  };
  instance.env = {};
  instance.configuredIdleTimeoutMs = timeoutMs;
  instance.renewActivityTimeout = renewActivityTimeout;
  return { instance, renewActivityTimeout };
}

function createStopInstance(options: {
  running?: boolean;
  response?: { ok: boolean; status?: number; body?: string };
  storedReceipt?: unknown;
  storedIntent?: unknown;
  schedules?: Array<{ payload?: unknown }>;
} = {}) {
  const response = options.response ?? {
    ok: true,
    body: JSON.stringify({
      ok: true,
      receipt: {
        opId: stopScope.stopOperationId,
        workspaceLastSyncedAt: preparedReceipt.workspaceLastSyncedAt,
      },
    }),
  };
  const fetch = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    text: vi.fn().mockResolvedValue(response.body ?? ""),
  });
  const put = vi.fn().mockResolvedValue(undefined);
  const remove = vi.fn().mockResolvedValue(undefined);
  const signal = vi.fn();
  const schedule = vi.fn().mockResolvedValue(undefined);
  const listSchedules = vi.fn().mockResolvedValue(options.schedules ?? []);
  const stop = vi.fn().mockResolvedValue(undefined);
  const instance = Object.create(SandboxDO.prototype) as SandboxDO & Record<string, any>;
  instance.ctx = {
    container: {
      running: options.running ?? true,
      getTcpPort: vi.fn().mockReturnValue({ fetch }),
      signal,
    },
    storage: {
      get: vi.fn().mockImplementation((key: string) => {
        if (key === "runtime-scope-v1") return Promise.resolve(runtimeScope);
        if (key === "prepared-stop-receipt-v1") {
          return Promise.resolve(options.storedReceipt);
        }
        if (key === "termination-intent-v1") {
          return Promise.resolve(options.storedIntent);
        }
        return Promise.resolve(undefined);
      }),
      put,
      delete: remove,
    },
  };
  instance.env = {};
  instance.stopControlPort = 8790;
  instance.lifecycleOpStorageKey = "lifecycle-op-id";
  instance.schedule = schedule;
  instance.listSchedules = listSchedules;
  instance.stop = stop;
  return { instance, fetch, put, remove, signal, schedule, listSchedules, stop };
}

async function expectSingleIdleDecision(
  instance: SandboxDO,
  expected: Record<string, unknown>,
) {
  diagnosticLog.mockClear();
  await instance.onActivityExpired();
  const decisions = sandboxIdleDecisions();
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toEqual(expect.objectContaining({
    component: "sandbox_idle_alarm",
    event: "decision",
    timeoutMs: expect.any(Number),
    remainingIdleMs: expect.any(Number),
    timestamp: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ...expected,
  }));
  expect(decisions[0]!.idleSince === null || typeof decisions[0]!.idleSince === "number").toBe(true);
  expect(
    decisions[0]!.elapsedIdleMs === null || typeof decisions[0]!.elapsedIdleMs === "number",
  ).toBe(true);
  return decisions[0]!;
}

describe("SandboxDO", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    diagnosticLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("waits for allocation without blocking runner dispatch on workspace hydration", async () => {
    const start = vi.fn().mockResolvedValue(undefined);
    const deleteSchedules = vi.fn();
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: {
        storage: {
          put: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
      start: typeof start;
      deleteSchedules: typeof deleteSchedules;
    };

    instance.ctx = {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    instance.defaultPort = 7681;
    instance.stopControlPort = 8790;
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.start = start;
    instance.deleteSchedules = deleteSchedules;

    await instance.startSandbox(
      "demo-env",
      { HUB_URL: "https://example.test" },
      15,
      runtimeScope,
    );

    expect(instance.ctx.storage.put).toHaveBeenCalledWith("slug", "demo-env");
    expect(instance.ctx.storage.put).toHaveBeenCalledWith("runtime-scope-v1", runtimeScope);
    expect(instance.ctx.storage.put).toHaveBeenCalledWith("lifecycle-op-id", "start-op-1");
    expect(instance.ctx.storage.delete).toHaveBeenCalledWith(
      "prepared-stop-receipt-v1",
    );
    expect(instance.ctx.storage.delete).toHaveBeenCalledWith("termination-intent-v1");
    expect(deleteSchedules).toHaveBeenCalledWith("terminatePreparedStop");
    expect(instance.sleepAfter).toBe("15m");
    expect(start).toHaveBeenCalledWith(
      {
        envVars: { HUB_URL: "https://example.test" },
        enableInternet: true,
      },
      {
        portToCheck: 8790,
        retries: Math.ceil(CONTAINER_INSTANCE_ALLOCATION_TIMEOUT_MS / 300),
        waitInterval: 300,
      },
    );
    expect(CONTAINER_INSTANCE_ALLOCATION_TIMEOUT_MS).toBeGreaterThan(8_000);
    expect(ENV_LIFECYCLE_START_TIMEOUT_MS).toBeGreaterThanOrEqual(
      CONTAINER_INSTANCE_ALLOCATION_TIMEOUT_MS + 180_000 + 30_000,
    );
  });

  it("prepares and persists an exact workspace receipt without stopping the container", async () => {
    const { instance, fetch, put, signal, stop } = createStopInstance();

    await expect(instance.prepareWorkspaceStop(stopScope)).resolves.toEqual({
      status: "prepared",
      receipt: preparedReceipt,
    });

    expect(put).toHaveBeenCalledWith("lifecycle-op-id", "stop-op-1");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1/prepare-stop", {
      method: "POST",
      headers: expect.any(Headers),
    });
    const request = fetch.mock.calls[0]?.[1] as { headers: Headers };
    expect(request.headers.get("X-Tiller-Lifecycle-Op-Id")).toBe("stop-op-1");
    expect(request.headers.get("X-Tiller-Workspace-Ack-Owner")).toBe("hub");
    expect(put).toHaveBeenCalledWith("prepared-stop-receipt-v1", preparedReceipt);
    expect(signal).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not schedule or stop when receipt persistence fails", async () => {
    const { instance, put, schedule, signal, stop } = createStopInstance();
    put.mockImplementation((key: string) => key === "prepared-stop-receipt-v1"
      ? Promise.reject(new Error("receipt storage unavailable"))
      : Promise.resolve(undefined));

    await expect(instance.prepareWorkspaceStop(stopScope)).rejects.toThrow(
      "receipt storage unavailable",
    );
    expect(schedule).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("does not schedule or stop if durable workspace preparation fails", async () => {
    const { instance, schedule, signal, stop } = createStopInstance({
      response: { ok: false, status: 500, body: "snapshot upload failed" },
    });

    await expect(instance.prepareWorkspaceStop(stopScope)).rejects.toThrow("snapshot upload failed");
    expect(schedule).not.toHaveBeenCalled();
    expect(signal).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it("extracts JSON stop-control errors before surfacing them", async () => {
    const { instance } = createStopInstance({
      response: {
        ok: false,
        status: 404,
        body: JSON.stringify({ ok: false, error: "Not found" }),
      },
    });

    await expect(instance.prepareWorkspaceStop(stopScope)).rejects.toThrow("Not found");
  });

  it("returns the same persisted receipt without preparing twice", async () => {
    const { instance, fetch, put } = createStopInstance({
      running: false,
      storedReceipt: preparedReceipt,
    });

    await expect(instance.prepareWorkspaceStop(stopScope)).resolves.toEqual({
      status: "prepared",
      receipt: preparedReceipt,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("never fabricates a receipt for an absent container", async () => {
    const { instance, fetch, put } = createStopInstance({ running: false });

    await expect(instance.prepareWorkspaceStop(stopScope)).resolves.toEqual({
      status: "absent-unprepared",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects a workspace receipt for a different Stop operation", async () => {
    const { instance, put } = createStopInstance({
      response: {
        ok: true,
        body: JSON.stringify({
          ok: true,
          receipt: {
            opId: "stop-op-other",
            workspaceLastSyncedAt: preparedReceipt.workspaceLastSyncedAt,
          },
        }),
      },
    });

    await expect(instance.prepareWorkspaceStop(stopScope)).rejects.toThrow(
      "malformed or mismatched workspace receipt",
    );
    expect(put).not.toHaveBeenCalledWith("prepared-stop-receipt-v1", expect.anything());
  });

  it("schedules termination only for the exact persisted receipt", async () => {
    const { instance, put, schedule, stop } = createStopInstance({
      storedReceipt: preparedReceipt,
    });

    await expect(instance.schedulePreparedTermination(stopScope)).resolves.toEqual({
      status: "scheduled",
    });
    expect(put).toHaveBeenCalledWith("termination-intent-v1", stopScope);
    expect(schedule).toHaveBeenCalledWith(1, "terminatePreparedStop", stopScope);
    expect(stop).not.toHaveBeenCalled();
  });

  it("treats an exact scheduled termination as idempotent", async () => {
    const { instance, schedule } = createStopInstance({
      storedReceipt: preparedReceipt,
      schedules: [{ payload: stopScope }],
    });

    await expect(instance.schedulePreparedTermination(stopScope)).resolves.toEqual({
      status: "already-scheduled",
    });
    expect(schedule).not.toHaveBeenCalled();
  });

  it("terminates from the later scheduled event after revalidating the receipt", async () => {
    const { instance, stop } = createStopInstance({
      storedReceipt: preparedReceipt,
      storedIntent: stopScope,
    });

    await instance.terminatePreparedStop(stopScope);
    expect(stop).toHaveBeenCalledWith("SIGTERM");
  });

  it("broadcasts failed status without writing to KV when container exits before finalization", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = createLifecycleStubForStop({
      phase: "failed",
      lastRunnerState: "stopped",
      lastError:
        "Container exited before snapshot persistence completed (exit). Recent workspace changes may not be saved.",
      lastErrorAt: "2026-04-10T00:00:05.000Z",
      updatedAt: "2026-04-10T00:00:05.000Z",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockResolvedValue({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      createdAt: "2026-04-10T00:00:00.000Z",
      status: "failed",
    });

    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: {
        ENVS_KV: { get: ReturnType<typeof vi.fn>; put: typeof put };
        HUB: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      };
    };

    instance.ctx = {
      storage: {
        get: vi.fn()
          .mockResolvedValueOnce("demo-env")       // slug
          .mockResolvedValueOnce("stop-op-1")       // lifecycleOpStorageKey
          .mockResolvedValueOnce("demo-env"),        // slug (finally block)
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          status: "saving",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        put,
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({}),
      },
    } as any;

    await instance.onStop({ reason: "exit" });

    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", null);
    // onStop must NOT write to KV — lifecycle projection handles status
    expect(put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(1);
    expect(instance.ctx.storage.delete).not.toHaveBeenCalled();
  });

  it("projects unexpected container output before recording a runtime failure", async () => {
    const lifecycleStub = createLifecycleStubForStop({
      phase: "running",
      activeOpId: "start-op-1",
      activeOperation: "start",
      desiredState: "running",
    });
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockResolvedValue({ status: "failed" });
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & { ctx: any; env: any };
    instance.ctx = {
      storage: {
        get: vi.fn()
          .mockResolvedValueOnce("demo-env")
          .mockResolvedValueOnce("start-op-1")
          .mockResolvedValueOnce("demo-env"),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.env = {};
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await instance.onStop({ exitCode: 17, reason: "private container output" });
    } finally {
      consoleError.mockRestore();
    }

    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith(
      "start-op-1",
      expect.stringMatching(/^The environment runtime stopped unexpectedly\. Reference ID: TLR-/),
    );
    expect(JSON.stringify(lifecycleStub.noteRunnerStopped.mock.calls)).not.toContain("private container output");
  });

  it("only reports runner exit after LifecycleDO owns the workspace acknowledgement", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const projectedMeta = {
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      createdAt: "2026-04-10T00:00:00.000Z",
      status: "stopped",
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
    };
    const lifecycleStub = {
      getState: vi.fn().mockResolvedValue(createLifecycleState({ phase: "stopping" })),
      noteRunnerStopped: vi.fn().mockResolvedValue(
        createLifecycleState({
          phase: "stopped",
          lastRunnerState: "stopped",
          updatedAt: "2026-04-10T00:00:06.000Z",
        }),
      ),
    };
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockResolvedValue(projectedMeta);

    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: {
        ENVS_KV: { get: ReturnType<typeof vi.fn>; put: typeof put };
        HUB: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      };
    };

    instance.ctx = {
      storage: {
        get: vi.fn()
          .mockResolvedValueOnce("demo-env")       // slug
          .mockResolvedValueOnce("stop-op-1"),      // lifecycleOpStorageKey
        delete: vi.fn().mockResolvedValue(undefined),
      },
    };
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          status: "saving",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        put,
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({}),
      },
    } as any;

    await instance.onStop({ reason: "exit" });

    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", null);
    // Must NOT write to KV
    expect(put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(1);
    expect(projectedMeta.status).toBe("stopped");
    expect(projectedMeta.workspaceDirty).toBe(true);
    expect(projectedMeta.workspaceLastSyncedAt).toBe("2026-04-10T00:00:05.000Z");
    expect(instance.ctx.storage.delete).toHaveBeenCalledWith("lifecycle-op-id");
    expect(instance.ctx.storage.delete).toHaveBeenCalledWith("prepared-stop-receipt-v1");
    expect(instance.ctx.storage.delete).toHaveBeenCalledWith("termination-intent-v1");
  });

  it("retains persisted stop state and retries when runner-exit notification fails", async () => {
    const lifecycleStub = {
      getState: vi.fn().mockResolvedValue(createLifecycleState({ phase: "stopping" })),
      noteRunnerStopped: vi.fn().mockRejectedValue(new Error("lifecycle binding unavailable")),
    };
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    const remove = vi.fn().mockResolvedValue(undefined);
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: Record<string, never>;
    };
    instance.ctx = {
      storage: {
        get: vi.fn()
          .mockResolvedValueOnce("demo-env")
          .mockResolvedValueOnce("stop-op-1"),
        delete: remove,
      },
    };
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.env = {};
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(instance.onStop({ reason: "exit" })).rejects.toThrow(
        "lifecycle binding unavailable",
      );
    } finally {
      consoleError.mockRestore();
    }

    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", null);
    expect(remove).not.toHaveBeenCalled();
  });

  it("broadcasts starting status without writing to KV when allocation completes", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const lifecycleStub = {
      noteInfraReady: vi.fn().mockResolvedValue(
        createLifecycleState({
          phase: "starting",
          activeOpId: "start-op-1",
          activeOperation: "start",
          desiredState: "running",
          lastRunnerState: "running",
          infraState: "ready",
          runtimeReady: false,
        }),
      ),
    };
    mocks.getEnvLifecycleStub.mockReturnValue(lifecycleStub);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockResolvedValue({
      slug: "demo-env",
      repoUrl: "https://github.com/test/repo",
      createdAt: "2026-04-10T00:00:00.000Z",
      status: "starting",
    });

    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: {
        ENVS_KV: { get: ReturnType<typeof vi.fn>; put: typeof put };
        HUB: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      };
    };

    instance.ctx = {
      storage: {
        get: vi.fn().mockResolvedValueOnce("demo-env").mockResolvedValueOnce("start-op-1"),
      },
    } as any;
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          status: "starting",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        put,
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({}),
      },
    } as any;

    await instance.onStart();

    expect(lifecycleStub.noteInfraReady).toHaveBeenCalledWith("start-op-1");
    // Must NOT write to KV
    expect(put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(1);

    mocks.projectAndPersistEnvSummary.mockRejectedValueOnce(new Error("projection unavailable"));
    instance.ctx.storage.get
      .mockResolvedValueOnce("demo-env")
      .mockResolvedValueOnce("start-op-1");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(instance.onStart()).resolves.toBeUndefined();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("requests lifecycle-controlled save only after the harness grants an idle claim", async () => {
    const requestStop = vi.fn().mockResolvedValue(createLifecycleState());
    const ensureStopDispatchScheduled = vi.fn().mockResolvedValue(true);
    const noteStopDispatchFailed = vi.fn().mockResolvedValue(null);
    mocks.getEnvLifecycleStub.mockReturnValue({
      requestStop,
      ensureStopDispatchScheduled,
      noteStopDispatchFailed,
    });
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary
      .mockResolvedValueOnce({
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2026-04-10T00:00:00.000Z",
        status: "running",
      })
      .mockResolvedValueOnce({
        slug: "demo-env",
        repoUrl: "https://github.com/test/repo",
        createdAt: "2026-04-10T00:00:00.000Z",
        status: "saving",
      });

    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        eligible: true,
        remainingIdleMs: 0,
        reason: "eligible",
        status: "idle",
        idleSince: Date.now() - 60_000,
        claimId: "idle-claim-1",
      }),
    });
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: {
        container: {
          running: boolean;
          getTcpPort: ReturnType<typeof vi.fn>;
        };
        storage: { get: ReturnType<typeof vi.fn> };
      };
      env: {
        ENVS_KV: { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
        HUB: { idFromName: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
      };
    };

    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        get: vi.fn().mockImplementation((key: string) => Promise.resolve(
          key === "idle-timeout-ms" ? 60_000 : "demo-env",
        )),
      },
    } as any;
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          slug: "demo-env",
          repoUrl: "https://github.com/test/repo",
          repoId: "repo-1",
          status: "running",
          createdAt: "2026-04-10T00:00:00.000Z",
          updatedAt: "2026-04-10T00:00:00.000Z",
        })),
        put: vi.fn().mockResolvedValue(undefined),
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({
          broadcastEnvUpsert: vi.fn(),
        }),
      },
    } as any;
    await instance.onActivityExpired();

    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(instance.env.ENVS_KV.put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(2);
    expect(ensureStopDispatchScheduled).toHaveBeenCalledWith(
      "stop-op-1",
      { idleClaimId: "idle-claim-1" },
    );
    expect(noteStopDispatchFailed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1/prepare-idle-stop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idleTimeoutMs: 60_000 }),
      }),
    );
    expect(sandboxIdleDecisions()).toEqual([
      expect.objectContaining({
        decision: "stop",
        reason: "eligible",
        detail: "eligible",
        environmentSlug: "demo-env",
        timeoutMs: 60_000,
        activityStatus: "idle",
        remainingIdleMs: 0,
      }),
    ]);
  });

  it("keeps a silent working turn alive across repeated timeout callbacks", async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        eligible: false,
        remainingIdleMs: 60_000,
        reason: "working",
      }),
    }));
    const renewActivityTimeout = vi.fn();
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: any;
      renewActivityTimeout: typeof renewActivityTimeout;
    };
    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        get: vi.fn().mockResolvedValue(60_000),
      },
    };
    instance.env = {};
    instance.renewActivityTimeout = renewActivityTimeout;

    await instance.onActivityExpired();
    await instance.onActivityExpired();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(renewActivityTimeout).toHaveBeenCalledTimes(2);
    expect(instance.sleepAfter).toBe("60s");
    expect(mocks.projectAndPersistEnvSummary).not.toHaveBeenCalled();
    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
    expect(sandboxIdleDecisions()).toEqual([
      expect.objectContaining({ decision: "renew", reason: "working", detail: "working" }),
      expect.objectContaining({ decision: "renew", reason: "working", detail: "working" }),
    ]);
  });

  it("fails closed and renews when harness activity control is unavailable", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connect ENOENT"));
    const renewActivityTimeout = vi.fn();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: any;
      renewActivityTimeout: typeof renewActivityTimeout;
    };
    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        get: vi.fn().mockResolvedValue(90_000),
      },
    };
    instance.env = {};
    instance.renewActivityTimeout = renewActivityTimeout;

    await instance.onActivityExpired();

    expect(renewActivityTimeout).toHaveBeenCalledTimes(1);
    expect(instance.sleepAfter).toBe("90s");
    expect(mocks.projectAndPersistEnvSummary).not.toHaveBeenCalled();
    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
    expect(sandboxIdleDecisions()).toEqual([
      expect.objectContaining({
        decision: "renew",
        reason: "unavailable",
        detail: "activity_unavailable",
      }),
    ]);
  });

  it("releases an eligible claim instead of falling back when lifecycle state is unreadable", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          ok: true,
          eligible: true,
          remainingIdleMs: 0,
          reason: "eligible",
          claimId: "idle-claim-unreadable",
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    const renewActivityTimeout = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockRejectedValue(new Error("lifecycle unavailable"));
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: any;
      renewActivityTimeout: typeof renewActivityTimeout;
    };
    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        get: vi.fn().mockImplementation((key: string) => Promise.resolve(
          key === "idle-timeout-ms" ? 60_000 : "demo-env",
        )),
      },
    };
    instance.env = {};
    instance.renewActivityTimeout = renewActivityTimeout;
    await instance.onActivityExpired();

    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]).toEqual([
      "http://127.0.0.1/prepare-idle-stop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "release",
          claimId: "idle-claim-unreadable",
        }),
      }),
    ]);
    expect(renewActivityTimeout).toHaveBeenCalledTimes(1);
    expect(sandboxIdleDecisions()).toEqual([
      expect.objectContaining({
        decision: "renew",
        reason: "failed_preparation",
        detail: "lifecycle_preparation_failed",
      }),
    ]);
  });

  it("preserves selected claim state without retaining untrusted response text", async () => {
    const idleSince = Date.now() - 60_000;
    const sensitive = "PROMPT_OUTPUT_FILE_CREDENTIAL_TOKEN";
    const claimFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        eligible: false,
        remainingIdleMs: 12_345,
        reason: sensitive,
        status: "idle",
        idleSince,
        error: sensitive,
      }),
    });
    const { instance: claimInstance } = createIdleAlarmInstance(claimFetch);
    const preparation = await (claimInstance as any).requestIdleStopPreparation(60_000);
    expect(preparation).toEqual({
      eligible: false,
      remainingIdleMs: 12_345,
      reason: "unknown",
      status: "idle",
      idleSince,
      error: true,
    });
    expect(JSON.stringify(preparation)).not.toContain(sensitive);
  });

  it("logs and renews after insufficient idle time", async () => {
    const idleSince = Date.now() - 47_655;
    const insufficient = createIdleAlarmInstance(vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        eligible: false,
        remainingIdleMs: 12_345,
        reason: "insufficient_idle",
        status: "idle",
        idleSince,
      }),
    }));
    const decision = await expectSingleIdleDecision(insufficient.instance, {
      decision: "renew",
      reason: "insufficient_idle",
      detail: "insufficient_idle",
      environmentSlug: "demo-env",
      timeoutMs: 60_000,
      activityStatus: "idle",
      idleSince,
      remainingIdleMs: 12_345,
    });
    expect(decision.elapsedIdleMs).toBeGreaterThanOrEqual(47_655);
    expect(insufficient.renewActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not copy untrusted claim reasons into unavailable decisions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const sensitive = "PROMPT_OUTPUT_FILE_CREDENTIAL_TOKEN";
    const unavailable = createIdleAlarmInstance(vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        eligible: false,
        remainingIdleMs: 60_000,
        reason: sensitive,
        error: sensitive,
      }),
    }));
    const decision = await expectSingleIdleDecision(unavailable.instance, {
      decision: "renew",
      reason: "unavailable",
      detail: "unknown_claim_reason",
    });
    expect(JSON.stringify(decision)).not.toContain(sensitive);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
  });

  it("logs unavailable when the container is not running", async () => {
    const unavailable = createIdleAlarmInstance(vi.fn());
    unavailable.instance.ctx.container.running = false;
    await expectSingleIdleDecision(unavailable.instance, {
      decision: "renew",
      reason: "unavailable",
      detail: "container_not_running",
      environmentSlug: "demo-env",
      timeoutMs: 60_000,
    });
    expect(unavailable.renewActivityTimeout).not.toHaveBeenCalled();
  });

  it("logs unavailable when idle-timeout storage cannot be read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unavailable = createIdleAlarmInstance(vi.fn());
    unavailable.instance.ctx.storage.get = vi.fn().mockImplementation((key: string) => {
      if (key === "slug") return Promise.resolve("demo-env");
      return Promise.reject(new Error("storage unavailable"));
    });
    await expectSingleIdleDecision(unavailable.instance, {
      decision: "renew",
      reason: "unavailable",
      detail: "idle_timeout_state_unavailable",
      environmentSlug: "demo-env",
      timeoutMs: 60_000,
    });
    expect(unavailable.renewActivityTimeout).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("releases the claim and logs failed preparation when the slug disappears", async () => {
    let slugReads = 0;
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          eligible: true,
          remainingIdleMs: 0,
          reason: "eligible",
          status: "idle",
          idleSince: Date.now() - 60_000,
          claimId: "missing-slug-claim",
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    const failed = createIdleAlarmInstance(fetch);
    failed.instance.ctx.storage.get = vi.fn().mockImplementation((key: string) => {
      if (key === "idle-timeout-ms") return Promise.resolve(60_000);
      slugReads += 1;
      return Promise.resolve(slugReads === 1 ? "demo-env" : undefined);
    });
    await expectSingleIdleDecision(failed.instance, {
      decision: "renew",
      reason: "failed_preparation",
      detail: "environment_slug_unavailable",
      environmentSlug: "demo-env",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(failed.renewActivityTimeout).toHaveBeenCalledTimes(1);
  });

  it("releases the claim and logs failed preparation for a non-stoppable lifecycle", async () => {
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockResolvedValue({ status: "stopped" });
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          eligible: true,
          remainingIdleMs: 0,
          reason: "eligible",
          claimId: "stopped-claim",
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    const failed = createIdleAlarmInstance(fetch);
    await expectSingleIdleDecision(failed.instance, {
      decision: "renew",
      reason: "failed_preparation",
      detail: "lifecycle_not_stoppable",
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
  });

  it("logs failed preparation when durable stop dispatch fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValue({ status: "saving" });
    const noteStopDispatchFailed = vi.fn().mockResolvedValue(undefined);
    const ensureStopDispatchScheduled = vi.fn().mockRejectedValue(new Error("dispatch failed"));
    mocks.getEnvLifecycleStub.mockReturnValue({
      requestStop: vi.fn().mockResolvedValue(createLifecycleState()),
      ensureStopDispatchScheduled,
      noteStopDispatchFailed,
    });
    const fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValue({
          eligible: true,
          remainingIdleMs: 0,
          reason: "eligible",
          claimId: "dispatch-failure-claim",
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    const failed = createIdleAlarmInstance(fetch);
    await expectSingleIdleDecision(failed.instance, {
      decision: "renew",
      reason: "failed_preparation",
      detail: "durable_stop_preparation_failed",
    });
    expect(noteStopDispatchFailed).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("authorizes eligible claims independently of diagnostic status fields", async () => {
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValueOnce({ status: "saving" });
    const ensureStopDispatchScheduled = vi.fn().mockResolvedValue(true);
    mocks.getEnvLifecycleStub.mockReturnValue({
      requestStop: vi.fn().mockResolvedValue(createLifecycleState()),
      ensureStopDispatchScheduled,
      noteStopDispatchFailed: vi.fn(),
    });
    const eligibleButWorking = createIdleAlarmInstance(vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        eligible: true,
        remainingIdleMs: 0,
        reason: "eligible",
        status: "working",
        idleSince: null,
        claimId: "eligible-claim",
      }),
    }));
    await expectSingleIdleDecision(eligibleButWorking.instance, {
      decision: "stop",
      reason: "eligible",
      detail: "eligible",
      activityStatus: "working",
    });
    expect(ensureStopDispatchScheduled).toHaveBeenCalledWith(
      "stop-op-1",
      { idleClaimId: "eligible-claim" },
    );
  });
});
