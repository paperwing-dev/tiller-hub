import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvDefinition, RepoMeta } from "../types";
import { makeEnvDefinition, makeMutableState, makeRepoMeta, makeSummaryCacheRow } from "./fixtures/env";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
}));

vi.mock("../helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../helpers")>();
  return {
    ...actual,
    getEnvLifecycleStub: mocks.getEnvLifecycleStub,
    getWorkspaceStub: mocks.getWorkspaceStub,
  };
});

const { envExists, listEnvViews, loadEnvView } = await import("../env/view");

function createMemoryKV(initialEntries: Record<string, string> = {}) {
  const data = new Map(Object.entries(initialEntries));
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      data.delete(key);
    }),
    list: vi.fn(async ({ prefix, cursor }: { prefix?: string; cursor?: string } = {}) => ({
      keys: Array.from(data.keys())
        .filter((key) => key.startsWith(prefix ?? ""))
        .sort()
        .map((name) => ({ name })),
      list_complete: true,
      cursor,
    })),
  };
}

function storeEnvDefinition(kv: ReturnType<typeof createMemoryKV>, definition: EnvDefinition) {
  kv.data.set(`envdef:${definition.slug}`, JSON.stringify(definition));
}

function storeRepo(kv: ReturnType<typeof createMemoryKV>, repo: RepoMeta = makeRepoMeta()) {
  kv.data.set(`repo:${repo.repoId}`, JSON.stringify({
    repoId: repo.repoId,
    updatedAt: repo.updatedAt,
  }));
  mocks.getWorkspaceStub.mockImplementation((_env: unknown, name: string) => ({
    readWorkspaceFile: vi.fn(async (path: string) => {
      if (name !== `plan-store:${repo.repoId}` || path !== "/.tiller/repo/meta.json") {
        return null;
      }
      const { repoUrl: _repoUrl, ...stored } = repo;
      return JSON.stringify(stored);
    }),
  }));
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getEnvLifecycleStub.mockReturnValue({
    peekMutableState: vi.fn(async () => makeMutableState()),
  });
  mocks.getWorkspaceStub.mockReset();
});

describe("env authoritative views", () => {
  it("composes env metadata from definition, mutable state, and repo metadata without summary KV", async () => {
    const kv = createMemoryKV();
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "env-1", repoId: "repo-1" }));
    storeRepo(kv, makeRepoMeta({ repoId: "repo-1", repoUrl: "https://github.com/example/repo" }));
    const env = { ENVS_KV: kv } as any;

    const meta = await loadEnvView(env, "env-1");

    expect(meta).toMatchObject({
      slug: "env-1",
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo",
      status: "running",
      runnerId: "runner-1",
      workspaceDirty: false,
    });
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("ignores stale summary cache rows during normal reads", async () => {
    const kv = createMemoryKV({
      "env-1": JSON.stringify(makeSummaryCacheRow({ slug: "env-1", status: "failed", runnerId: "cache-runner" })),
    });
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "env-1" }));
    storeRepo(kv);
    const env = { ENVS_KV: kv } as any;

    const meta = await loadEnvView(env, "env-1");

    expect(meta).toMatchObject({
      slug: "env-1",
      status: "running",
      runnerId: "runner-1",
    });
  });

  it("returns an in-memory unknown view when mutable state is missing", async () => {
    mocks.getEnvLifecycleStub.mockReturnValue({
      peekMutableState: vi.fn(async () => null),
    });
    const kv = createMemoryKV();
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "env-1" }));
    storeRepo(kv);
    const env = { ENVS_KV: kv } as any;

    const meta = await loadEnvView(env, "env-1");

    expect(meta).toMatchObject({
      slug: "env-1",
      status: "unknown",
      updatedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(meta).not.toHaveProperty("runnerId");
    expect(kv.put).not.toHaveBeenCalled();
  });

  it("returns null when no env definition exists", async () => {
    const env = { ENVS_KV: createMemoryKV() } as any;

    await expect(loadEnvView(env, "missing")).resolves.toBeNull();
    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
  });

  it("throws when repo metadata is missing", async () => {
    const kv = createMemoryKV();
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "env-1", repoId: "repo-missing" }));
    const env = { ENVS_KV: kv } as any;

    await expect(loadEnvView(env, "env-1")).rejects.toThrow(
      "Environment env-1 references missing repo repo-missing.",
    );
  });

  it("throws when an env definition row contains a mismatched slug", async () => {
    const kv = createMemoryKV({
      "envdef:env-1": JSON.stringify(makeEnvDefinition({ slug: "other-env" })),
    });
    const env = { ENVS_KV: kv } as any;

    await expect(loadEnvView(env, "env-1")).rejects.toThrow(
      "Env definition for env-1 has mismatched slug other-env.",
    );
    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
  });

  it("lists env views from definitions, skips invalid entries, and sorts by slug", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const kv = createMemoryKV();
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "z-env", repoId: "repo-1" }));
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "a-env", repoId: "repo-1" }));
    storeEnvDefinition(kv, makeEnvDefinition({ slug: "bad-env", repoId: "missing-repo" }));
    kv.data.set("envdef:mismatched-env", JSON.stringify(makeEnvDefinition({ slug: "other-env" })));
    storeRepo(kv);
    const env = { ENVS_KV: kv } as any;

    const views = await listEnvViews(env);

    expect(views.map((view) => view.slug)).toEqual(["a-env", "z-env"]);
    expect(warn).toHaveBeenCalledWith(
      "[envs] Skipping invalid env bad-env:",
      expect.stringContaining("references missing repo missing-repo"),
    );
    expect(warn).toHaveBeenCalledWith(
      "[envs] Skipping invalid env mismatched-env:",
      expect.stringContaining("has mismatched slug other-env"),
    );
    warn.mockRestore();
  });

  it("checks existence from env definitions and treats corrupt definitions as missing", async () => {
    const kv = createMemoryKV({
      "envdef:good-env": JSON.stringify(makeEnvDefinition({ slug: "good-env" })),
      "envdef:bad-env": JSON.stringify({ slug: "bad-env", backend: "cf" }),
      "envdef:mismatched-env": JSON.stringify(makeEnvDefinition({ slug: "other-env" })),
    });
    const env = { ENVS_KV: kv } as any;

    await expect(envExists(env, "good-env")).resolves.toBe(true);
    await expect(envExists(env, "missing-env")).resolves.toBe(false);
    await expect(envExists(env, "bad-env")).resolves.toBe(false);
    await expect(envExists(env, "mismatched-env")).resolves.toBe(false);
  });
});
