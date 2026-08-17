import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  getState: vi.fn(),
  onActivityExpired: vi.fn(),
}));

vi.mock("@cloudflare/containers", () => ({
  Container: class {
    ctx: unknown;
    env: unknown;
    start = mocks.start;
    getState = mocks.getState;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    async onActivityExpired() {
      await mocks.onActivityExpired();
    }
  },
}));

const { PlannerRunDO } = await import("../planner-run-do");

function createSubject() {
  const values = new Map<string, unknown>();
  const transaction = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { values.set(key, value); },
    delete: async (key: string) => values.delete(key),
  };
  const destroy = vi.fn(async () => undefined);
  const ctx = {
    storage: {
      get: transaction.get,
      put: transaction.put,
      transaction: async <T>(callback: (value: typeof transaction) => Promise<T>) => callback(transaction),
    },
    container: { destroy },
  };
  return { runtime: new PlannerRunDO(ctx as any, {} as any), destroy, ctx };
}

describe("PlannerRunDO Plan Writer fencing", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.start.mockResolvedValue(undefined);
    mocks.getState.mockResolvedValue({ status: "running", lastChange: 0 });
    mocks.onActivityExpired.mockResolvedValue(undefined);
  });

  it("converges deterministic creates and destroys only the exact identity", async () => {
    const { runtime, destroy } = createSubject();
    expect(await runtime.ensurePlanWriterRuntime("writer-1", { A: "1" })).toEqual({
      jobSlug: "writer-1",
      created: true,
    });
    expect(await runtime.ensurePlanWriterRuntime("writer-1", { A: "2" })).toEqual({
      jobSlug: "writer-1",
      created: false,
    });
    expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(await runtime.inspectPlanWriterRuntime("writer-1")).toEqual({ registered: true, live: true, jobSlug: "writer-1" });
    await expect(runtime.ensurePlanWriterRuntime("writer-2", {})).rejects.toThrow(/already reserved/);
    await expect(runtime.destroyPlanWriterRuntime("writer-2")).rejects.toThrow(/refusing to destroy/i);

    await runtime.destroyPlanWriterRuntime("writer-1");
    await runtime.destroyPlanWriterRuntime("writer-1");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(await runtime.inspectPlanWriterRuntime("writer-1")).toEqual({ registered: false, live: false, jobSlug: null });
  });

  it("releases the reservation when container startup fails", async () => {
    const { runtime } = createSubject();
    mocks.start.mockRejectedValueOnce(new Error("create failed"));
    await expect(runtime.ensurePlanWriterRuntime("writer-1", {})).rejects.toThrow("create failed");
    expect(await runtime.inspectPlanWriterRuntime("writer-1")).toEqual({ registered: false, live: false, jobSlug: null });
  });

  it("permanently rejects a Plan Writer start when cleanup arrives first", async () => {
    const { runtime, destroy, ctx } = createSubject();

    await runtime.destroyPlanWriterRuntime("writer-1");

    const restarted = new PlannerRunDO(ctx as any, {} as any);
    await expect(restarted.ensurePlanWriterRuntime("writer-1", {})).rejects.toThrow(/already destroyed/i);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("permanently rejects a one-shot planner start when cleanup arrives first", async () => {
    const { runtime, destroy, ctx } = createSubject();

    await runtime.destroyPlannerJob();
    await runtime.destroyPlannerJob();

    const restarted = new PlannerRunDO(ctx as any, {} as any);
    await expect(restarted.startPlannerJob({})).rejects.toThrow(/already destroyed/i);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("requires the protected reviewer protocol for one-shot planner starts", async () => {
    const { runtime } = createSubject();

    await expect(runtime.startPlannerJob({})).rejects.toThrow(/protected reviewer isolation/i);
    expect(mocks.start).not.toHaveBeenCalled();

    await runtime.startPlannerJob({ TILLER_REVIEWER_ISOLATION_PROTOCOL: "1" });
    expect(mocks.start).toHaveBeenCalledWith({
      envVars: { TILLER_REVIEWER_ISOLATION_PROTOCOL: "1" },
      enableInternet: true,
    });
  });

  it("distinguishes a retained reservation from a live container", async () => {
    const { runtime } = createSubject();
    await runtime.ensurePlanWriterRuntime("writer-1", {});
    mocks.getState.mockResolvedValueOnce({ status: "stopped_with_code", exitCode: 1, lastChange: 1 });
    expect(await runtime.inspectPlanWriterRuntime("writer-1")).toEqual({
      registered: true,
      live: false,
      jobSlug: "writer-1",
    });
  });

  it("lets the Plan Writer supervisor own expiry for a reserved identity", async () => {
    const { runtime, destroy } = createSubject();
    await runtime.ensurePlanWriterRuntime("writer-1", {});

    await runtime.onActivityExpired();

    expect(mocks.onActivityExpired).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
  });

  it("retains normal container expiry for one-shot planner jobs", async () => {
    const { runtime } = createSubject();

    await runtime.onActivityExpired();

    expect(mocks.onActivityExpired).toHaveBeenCalledTimes(1);
  });
});
