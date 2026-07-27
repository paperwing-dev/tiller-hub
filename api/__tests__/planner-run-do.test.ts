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
      transaction: async <T>(callback: (value: typeof transaction) => Promise<T>) => callback(transaction),
    },
    container: { destroy },
  };
  return { runtime: new PlannerRunDO(ctx as any, {} as any), destroy };
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
