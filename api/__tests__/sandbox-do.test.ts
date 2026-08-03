import { beforeEach, describe, expect, it, vi } from "vitest";

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

import { SandboxDO } from "../sandbox-do";

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
  return {
    noteRunnerStopped: vi.fn().mockResolvedValue(
      createLifecycleState(overrides),
    ),
    noteFencedRunnerAbsentBeforeNightStart: vi.fn().mockResolvedValue(false),
    noteFencedNightStartRejectedBeforeMutation: vi.fn().mockResolvedValue(false),
    getStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(null),
    clearStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(undefined),
  };
}

describe("SandboxDO", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("waits only for the stop-control port before considering startup complete", async () => {
    const startAndWaitForPorts = vi.fn().mockResolvedValue(undefined);
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: {
        storage: {
          put: ReturnType<typeof vi.fn>;
        };
      };
      startAndWaitForPorts: typeof startAndWaitForPorts;
    };

    instance.ctx = {
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    instance.defaultPort = 7681;
    instance.stopControlPort = 8790;
    instance.startAndWaitForPorts = startAndWaitForPorts;

    await instance.startSandbox("demo-env", { HUB_URL: "https://example.test" }, 15);

    expect(instance.ctx.storage.put).toHaveBeenCalledWith("slug", "demo-env");
    expect(instance.sleepAfter).toBe("15m");
    expect(startAndWaitForPorts).toHaveBeenCalledWith({
      ports: [8790],
      cancellationOptions: {
        portReadyTimeoutMS: 30_000,
      },
      startOptions: {
        envVars: { HUB_URL: "https://example.test" },
        enableInternet: true,
      },
    });
  });

  it("prepares a durable stop before signalling the container", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      text: vi.fn().mockResolvedValue(""),
    });
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: {
        container: {
          running: boolean;
          getTcpPort: ReturnType<typeof vi.fn>;
        };
        storage: {
          put: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
      stop: typeof stop;
    };

    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    instance.stopControlPort = 8790;
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.stop = stop;

    await instance.stopSandbox("stop-op-1");

    expect(instance.ctx.storage.put).toHaveBeenCalledWith("lifecycle-op-id", "stop-op-1");
    expect(instance.ctx.container.getTcpPort).toHaveBeenCalledWith(8790);
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1/prepare-stop", {
      method: "POST",
      headers: expect.any(Headers),
    });
    const request = fetch.mock.calls[0]?.[1] as { headers: Headers };
    expect(request.headers.get("X-Tiller-Lifecycle-Op-Id")).toBe("stop-op-1");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("does not signal the container if durable stop preparation fails", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue("snapshot upload failed"),
    });
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: {
        container: {
          running: boolean;
          getTcpPort: ReturnType<typeof vi.fn>;
        };
        storage: {
          put: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
      stop: typeof stop;
    };

    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    instance.stopControlPort = 8790;
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.stop = stop;

    await expect(instance.stopSandbox("stop-op-1")).rejects.toThrow("snapshot upload failed");
    expect(stop).not.toHaveBeenCalled();
  });

  it("extracts JSON stop-control errors before surfacing them", async () => {
    const stop = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: vi.fn().mockResolvedValue(JSON.stringify({ ok: false, error: "Not found" })),
    });
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: {
        container: {
          running: boolean;
          getTcpPort: ReturnType<typeof vi.fn>;
        };
        storage: {
          put: ReturnType<typeof vi.fn>;
          delete: ReturnType<typeof vi.fn>;
        };
      };
      stop: typeof stop;
    };

    instance.ctx = {
      container: {
        running: true,
        getTcpPort: vi.fn().mockReturnValue({ fetch }),
      },
      storage: {
        put: vi.fn().mockResolvedValue(undefined),
        delete: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    instance.stopControlPort = 8790;
    instance.lifecycleOpStorageKey = "lifecycle-op-id";
    instance.stop = stop;

    await expect(instance.stopSandbox("stop-op-1")).rejects.toThrow("Not found");
    expect(stop).not.toHaveBeenCalled();
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

    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", "exit");
    // onStop must NOT write to KV — lifecycle projection handles status
    expect(put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(1);
    expect(instance.ctx.storage.delete).toHaveBeenCalledWith("lifecycle-op-id");
  });

  it("uses lifecycle DO workspace-synced relay for accurate broadcast when marking env stopped", async () => {
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
      noteRunnerStopped: vi.fn().mockResolvedValue(
        createLifecycleState({
          phase: "stopped",
          lastRunnerState: "stopped",
          updatedAt: "2026-04-10T00:00:06.000Z",
        }),
      ),
      getStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue({
        opId: "stop-op-1",
        patch: {
          workspaceDirty: true,
          workspaceNeedsAttention: false,
          workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
          baseMainCommit: "head-old",
          lastKnownMainCommit: "head-old",
          branchStatus: "ready-to-merge",
        },
      }),
      clearStopWorkspaceSyncedMeta: vi.fn().mockResolvedValue(undefined),
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

    expect(lifecycleStub.noteRunnerStopped).toHaveBeenCalledWith("stop-op-1", "exit");
    // Must NOT write to KV
    expect(put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(1);
    expect(projectedMeta.status).toBe("stopped");
    expect(projectedMeta.workspaceDirty).toBe(true);
    expect(projectedMeta.workspaceLastSyncedAt).toBe("2026-04-10T00:00:05.000Z");
    // Cleanup relay
    expect(lifecycleStub.clearStopWorkspaceSyncedMeta).toHaveBeenCalledTimes(1);
  });

  it("broadcasts starting status without writing to KV when container reports infra-ready", async () => {
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
  });

  it("requests lifecycle-controlled save only after the harness grants an idle claim", async () => {
    const requestStop = vi.fn().mockResolvedValue(createLifecycleState());
    const noteStopDispatchFailed = vi.fn().mockResolvedValue(null);
    mocks.getEnvLifecycleStub.mockReturnValue({
      requestStop,
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

    const stopSandbox = vi.fn().mockResolvedValue(undefined);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        eligible: true,
        remainingIdleMs: 0,
        reason: "eligible",
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
      stopSandbox: typeof stopSandbox;
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
    instance.stopSandbox = stopSandbox;

    await instance.onActivityExpired();

    expect(requestStop).toHaveBeenCalledTimes(1);
    expect(instance.env.ENVS_KV.put).not.toHaveBeenCalled();
    expect(mocks.projectAndPersistEnvSummary).toHaveBeenCalledTimes(2);
    expect(stopSandbox).toHaveBeenCalledWith("stop-op-1", "idle-claim-1");
    expect(noteStopDispatchFailed).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1/prepare-idle-stop",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ idleTimeoutMs: 60_000 }),
      }),
    );
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
  });

  it("fails closed and renews when harness activity control is unavailable", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("connect ENOENT"));
    const renewActivityTimeout = vi.fn();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
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
    warn.mockRestore();
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
    const stopSandbox = vi.fn();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getHub.mockReturnValue({});
    mocks.projectAndPersistEnvSummary.mockRejectedValue(new Error("lifecycle unavailable"));
    const instance = Object.create(SandboxDO.prototype) as SandboxDO & {
      ctx: any;
      env: any;
      renewActivityTimeout: typeof renewActivityTimeout;
      stopSandbox: typeof stopSandbox;
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
    instance.stopSandbox = stopSandbox;

    await instance.onActivityExpired();

    expect(stopSandbox).not.toHaveBeenCalled();
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
    error.mockRestore();
  });
});
