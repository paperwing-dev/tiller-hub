import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

let RepoMergeLockDO: typeof import("../scm/repo-merge-lock-do").RepoMergeLockDO;

class FakeStorage {
  private values = new Map<string, unknown>();
  private alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }

  async list<T>(options?: { prefix?: string }): Promise<Map<string, T>> {
    const out = new Map<string, T>();
    for (const [key, value] of this.values.entries()) {
      if (options?.prefix && !key.startsWith(options.prefix)) {
        continue;
      }
      out.set(key, value as T);
    }
    return out;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }
}

function createRepoMergeLockDO() {
  const storage = new FakeStorage();
  const state = {
    storage,
  } as any;
  return {
    storage,
    instance: new RepoMergeLockDO(state, {} as any),
  };
}

describe("RepoMergeLockDO", () => {
  beforeAll(async () => {
    ({ RepoMergeLockDO } = await import("../scm/repo-merge-lock-do"));
  });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-09T18:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains completed operations briefly, then purges them on alarm", async () => {
    const { storage, instance } = createRepoMergeLockDO();

    await instance.createOperation({
      operationId: "op-1",
      type: "merge-into-main",
      envSlug: "demo-env",
      ownerId: "demo-env",
    });
    await instance.completeOperation({
      operationId: "op-1",
      result: {
        action: "merged",
      },
    });

    expect(await instance.getOperation("op-1")).toMatchObject({
      status: "succeeded",
    });
    expect(await storage.getAlarm()).not.toBeNull();

    vi.setSystemTime(new Date("2026-04-09T18:11:00.000Z"));
    await instance.alarm();

    await expect(instance.getOperation("op-1")).resolves.toBeNull();
  });

  it("fails stale pending operations after the timeout window", async () => {
    const { storage, instance } = createRepoMergeLockDO();

    await instance.createOperation({
      operationId: "op-stale",
      type: "merge-into-main",
      envSlug: "demo-env",
      ownerId: "demo-env",
    });

    vi.setSystemTime(new Date("2026-04-09T18:16:00.000Z"));
    await instance.alarm();

    await expect(instance.getOperation("op-stale")).resolves.toMatchObject({
      status: "failed",
      error: expect.stringContaining("timed out"),
    });
    expect(await storage.getAlarm()).not.toBeNull();
  });
});
