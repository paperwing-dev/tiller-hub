import { describe, expect, it, vi } from "vitest";
import { createInitialEnvScmState, createInitialRepoScmState } from "../../scm/model";
import {
  commitRepoMainState,
  listEnvDefinitionSlugs,
  listEnvMetas,
  persistEnvDefinition,
  readEnvDefinition,
  readEnvMeta,
  readRepoMetaFromWorkspace,
} from "../store";

function makeEnvSummary(overrides: Record<string, unknown> = {}) {
  return {
    slug: "env-1",
    repoUrl: "https://github.com/paperwing-dev/example",
    backend: "cf",
    harness: "claude-code",
    runnerMachineId: "env-1",
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:00:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "env-1",
    }),
    ...overrides,
  };
}

function makeEnvDefinition(overrides: Record<string, unknown> = {}) {
  return {
    slug: "env-1",
    repoUrl: "https://github.com/paperwing-dev/example",
    backend: "cf",
    harness: "claude-code",
    startupPlanId: null,
    branchName: "env/env-1",
    createdAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("repo store env metadata helpers", () => {
  it("persists canonical main commit updates to repo metadata", async () => {
    const writeWorkspaceFile = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const workspace = {
      writeWorkspaceFile,
    } as any;

    const nextMeta = await commitRepoMainState({
      env,
      workspace,
      meta: {
        repoId: "repo-123",
        repoUrl: "https://github.com/paperwing-dev/example",
        ...createInitialRepoScmState(),
        mainCommit: "abc123",
        gitArtifactId: "g-old",
        gitStatus: "ready",
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
      mainCommit: "def456",
      sourceEnvSlug: "env-1",
    });

    expect(nextMeta).toMatchObject({
      repoId: "repo-123",
      mainCommit: "def456",
      lastCommittedFromEnvSlug: "env-1",
    });
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "/.tiller/repo/meta.json",
      expect.stringContaining("\"mainCommit\": \"def456\""),
    );
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "repo:repo-123",
      expect.stringContaining("\"repoId\":\"repo-123\""),
    );
  });

  it("ignores repo index entries when reading env metadata", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            repoId: "repo-123",
            repoUrl: "https://github.com/paperwing-dev/example",
            updatedAt: "2026-03-30T00:00:00.000Z",
          }),
        ),
      },
    } as any;

    await expect(readEnvMeta(env, "repo:repo-123")).resolves.toBeNull();
  });

  it("lists only envs that have an envdef row, ignoring unrelated keys in the shared namespace", async () => {
    const env = {
      ENVS_KV: {
        list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string }) => {
          if (prefix === "envdef:") {
            return {
              keys: [{ name: "envdef:env-1" }],
              list_complete: true,
              cursor: undefined,
            };
          }
          return { keys: [], list_complete: true, cursor: undefined };
        }),
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === "env-1") {
            return JSON.stringify(makeEnvSummary());
          }
          return null;
        }),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toEqual([
      expect.objectContaining({
        slug: "env-1",
        repoUrl: "https://github.com/paperwing-dev/example",
        runnerMachineId: "env-1",
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        status: "running",
      }),
    ]);
    expect(env.ENVS_KV.list).toHaveBeenCalledWith({ prefix: "envdef:", cursor: undefined });
  });

  it("persists env definitions separately from summary cache rows", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue(JSON.stringify(makeEnvDefinition()));
    const env = {
      ENVS_KV: { put, get },
    } as any;

    await persistEnvDefinition(env, {
      ...makeEnvDefinition(),
    });

    expect(put).toHaveBeenCalledWith(
      "envdef:env-1",
      expect.stringContaining("\"slug\":\"env-1\""),
    );
    await expect(readEnvDefinition(env, "env-1")).resolves.toMatchObject({
      slug: "env-1",
      branchName: "env/env-1",
    });
  });

  it("returns one entry per envdef slug regardless of other keys in the namespace", async () => {
    const env = {
      ENVS_KV: {
        list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string }) => {
          if (prefix === "envdef:") {
            return {
              keys: [{ name: "envdef:env-1" }],
              list_complete: true,
              cursor: undefined,
            };
          }
          return { keys: [], list_complete: true, cursor: undefined };
        }),
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === "env-1") {
            return JSON.stringify(makeEnvSummary());
          }
          return null;
        }),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toHaveLength(1);
  });

  it("lists env definition slugs even when summary cache rows are missing", async () => {
    const env = {
      ENVS_KV: {
        list: vi
          .fn()
          .mockResolvedValueOnce({
            keys: [{ name: "envdef:env-1" }],
            list_complete: false,
            cursor: "cursor-2",
          })
          .mockResolvedValueOnce({
            keys: [{ name: "envdef:env-2" }],
            list_complete: true,
            cursor: undefined,
          }),
      },
    } as any;

    await expect(listEnvDefinitionSlugs(env)).resolves.toEqual(["env-1", "env-2"]);
    expect(env.ENVS_KV.list).toHaveBeenNthCalledWith(1, { prefix: "envdef:", cursor: undefined });
    expect(env.ENVS_KV.list).toHaveBeenNthCalledWith(2, { prefix: "envdef:", cursor: "cursor-2" });
  });

  it("skips malformed env summary cache rows instead of failing the full list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      ENVS_KV: {
        list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string }) => {
          if (prefix === "envdef:") {
            return {
              keys: [{ name: "envdef:env-bad" }, { name: "envdef:env-good" }],
              list_complete: true,
              cursor: undefined,
            };
          }
          return { keys: [], list_complete: true, cursor: undefined };
        }),
        get: vi.fn().mockImplementation(async (key: string) => {
          if (key === "env-bad") {
            return JSON.stringify({
              slug: "env-bad",
              repoUrl: "https://github.com/paperwing-dev/example",
              backend: "cf",
              harness: "claude-code",
              createdAt: "2026-03-30T00:00:00.000Z",
              updatedAt: "2026-03-30T00:00:00.000Z",
              status: "running",
            });
          }
          if (key === "env-good") {
            return JSON.stringify(makeEnvSummary({
              slug: "env-good",
              runnerMachineId: "env-good",
            }));
          }
          return null;
        }),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toEqual([
      expect.objectContaining({ slug: "env-good", runnerMachineId: "env-good" }),
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[repo-store] Skipping invalid env summary cache row env-bad:",
      expect.stringContaining("missing explicit environment schema fields"),
    );
  });

  it("re-reads KV values instead of trusting stale list metadata", async () => {
    const env = {
      ENVS_KV: {
        list: vi.fn().mockImplementation(async ({ prefix }: { prefix?: string }) => {
          if (prefix === "envdef:") {
            return {
              keys: [
                {
                  name: "envdef:env-1",
                  metadata: {
                    slug: "env-1",
                    repoUrl: "https://github.com/paperwing-dev/example",
                    runnerMachineId: "env-1",
                    createdAt: "2026-03-30T00:00:00.000Z",
                    branchName: "env/env-1",
                  },
                },
              ],
              list_complete: true,
              cursor: undefined,
            };
          }
          return { keys: [], list_complete: true, cursor: undefined };
        }),
        get: vi.fn().mockResolvedValue(
          JSON.stringify(makeEnvSummary()),
        ),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toEqual([
      expect.objectContaining({
        slug: "env-1",
        repoUrl: "https://github.com/paperwing-dev/example",
        runnerMachineId: "env-1",
        createdAt: "2026-03-30T00:00:00.000Z",
        branchName: "env/env-1",
      }),
    ]);
  });

  it("follows KV pagination cursors when listing env summaries", async () => {
    const env = {
      ENVS_KV: {
        list: vi
          .fn()
          .mockResolvedValueOnce({
            keys: [{ name: "envdef:env-1" }],
            list_complete: false,
            cursor: "cursor-2",
          })
          .mockResolvedValueOnce({
            keys: [{ name: "envdef:env-2" }],
            list_complete: true,
            cursor: undefined,
          }),
        get: vi.fn().mockImplementation(async (key: string) => JSON.stringify(
          makeEnvSummary({
            slug: key,
            runnerMachineId: key,
          }),
        )),
      },
    } as any;

    await expect(listEnvMetas(env)).resolves.toEqual([
      expect.objectContaining({ slug: "env-1", runnerMachineId: "env-1" }),
      expect.objectContaining({ slug: "env-2", runnerMachineId: "env-2" }),
    ]);
    expect(env.ENVS_KV.list).toHaveBeenNthCalledWith(1, { prefix: "envdef:", cursor: undefined });
    expect(env.ENVS_KV.list).toHaveBeenNthCalledWith(2, { prefix: "envdef:", cursor: "cursor-2" });
  });

  it("rejects summary rows that omit harness", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            slug: "env-1",
            repoUrl: "https://github.com/paperwing-dev/example",
            backend: "cf",
            createdAt: "2026-03-30T00:00:00.000Z",
          }),
        ),
      },
    } as any;

    await expect(readEnvMeta(env, "env-1")).rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects summary rows that omit updatedAt", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            slug: "env-1",
            repoUrl: "https://github.com/paperwing-dev/example",
            backend: "cf",
            harness: "claude-code",
            createdAt: "2026-03-30T00:00:00.000Z",
            status: "running",
          }),
        ),
      },
    } as any;

    await expect(readEnvMeta(env, "env-1")).rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects summary rows that omit status", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            slug: "env-1",
            repoUrl: "https://github.com/paperwing-dev/example",
            backend: "cf",
            harness: "claude-code",
            createdAt: "2026-03-30T00:00:00.000Z",
            updatedAt: "2026-03-30T00:00:00.000Z",
          }),
        ),
      },
    } as any;

    await expect(readEnvMeta(env, "env-1")).rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects env definition rows that omit harness", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            slug: "env-1",
            repoUrl: "https://github.com/paperwing-dev/example",
            backend: "cf",
            createdAt: "2026-03-30T00:00:00.000Z",
          }),
        ),
      },
    } as any;

    await expect(readEnvDefinition(env, "env-1")).rejects.toThrow("missing explicit environment schema fields");
  });

  it("rejects repo workspace metadata that omit gitStatus", async () => {
    const { gitStatus: _gitStatus, ...repoScmWithoutStatus } = createInitialRepoScmState();
    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(JSON.stringify({
        repoId: "repo-123",
        repoUrl: "https://github.com/paperwing-dev/example",
        ...repoScmWithoutStatus,
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      })),
    } as any;

    await expect(readRepoMetaFromWorkspace(workspace)).rejects.toThrow("missing explicit repository schema fields");
  });
});
