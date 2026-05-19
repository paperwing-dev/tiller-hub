import { describe, expect, it } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../../api/scm/model";
import {
  getDisplayEnvBranchStatus,
  removeEnvMeta,
  removeRepoMeta,
  upsertEnvMeta,
  upsertRepoMeta,
} from "../env-state";

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "test-env",
    repoUrl: "https://github.com/user/repo",
    repoId: "repo-1",
    backend: "cf",
    harness: "claude-code",
    runnerMachineId: "machine-123",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "test-env",
      mainCommit: "main-a",
    }),
    ...overrides,
  };
}

function makeRepo(overrides: Partial<RepoMeta> = {}): RepoMeta {
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/user/repo",
    ...createInitialRepoScmState(),
    mainCommit: "main-a",
    gitArtifactId: "artifact-1",
    gitStatus: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
    ...overrides,
  };
}

describe("upsertEnvMeta", () => {
  it("adds unknown envs", () => {
    const result = upsertEnvMeta([], makeEnv());
    expect(result.changed).toBe(true);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      slug: "test-env",
      status: "running",
    });
  });

  it("ignores stale env snapshots", () => {
    const current = makeEnv({ updatedAt: "2024-01-02T00:00:00.000Z", status: "stopped" });
    const incoming = makeEnv({ updatedAt: "2024-01-01T00:00:00.000Z", status: "starting" });

    const result = upsertEnvMeta([current], incoming);
    expect(result.changed).toBe(false);
    expect(result.items[0]).toEqual(current);
  });

  it("accepts newer env snapshots", () => {
    const current = makeEnv({ updatedAt: "2024-01-01T00:00:00.000Z", status: "starting" });
    const incoming = makeEnv({ updatedAt: "2024-01-02T00:00:00.000Z", status: "running", bootMessage: "Ready" });

    const result = upsertEnvMeta([current], incoming);
    expect(result.changed).toBe(true);
    expect(result.items[0]).toMatchObject({
      status: "running",
      bootMessage: "Ready",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
  });

  it("throws when an incoming env summary omits updatedAt", () => {
    expect(() => upsertEnvMeta([], makeEnv({ updatedAt: undefined as never }))).toThrow(
      "Env summary is missing explicit core fields",
    );
  });
});

describe("upsertRepoMeta", () => {
  it("ignores stale repo snapshots", () => {
    const current = makeRepo({ updatedAt: "2024-01-02T00:00:00.000Z", gitStatus: "ready" });
    const incoming = makeRepo({ updatedAt: "2024-01-01T00:00:00.000Z", gitStatus: "pending" });

    const result = upsertRepoMeta([current], incoming);
    expect(result.changed).toBe(false);
    expect(result.items[0]).toEqual(current);
  });

  it("updates known repos with newer summaries", () => {
    const result = upsertRepoMeta(
      [makeRepo()],
      makeRepo({
        updatedAt: "2024-01-03T00:00:00.000Z",
        gitStatus: "repair-required",
        gitError: "bootstrap failed",
      }),
    );

    expect(result.changed).toBe(true);
    expect(result.items[0]).toMatchObject({
      gitStatus: "repair-required",
      gitError: "bootstrap failed",
    });
  });

  it("throws when an incoming repo summary omits gitStatus", () => {
    expect(() => upsertRepoMeta([], makeRepo({ gitStatus: undefined as never }))).toThrow(
      "Repo summary is missing explicit core fields",
    );
  });
});

describe("remove helpers", () => {
  it("removes envs by slug", () => {
    const result = removeEnvMeta([makeEnv(), makeEnv({ slug: "other-env" })], "test-env");
    expect(result.changed).toBe(true);
    expect(result.items.map((env) => env.slug)).toEqual(["other-env"]);
  });

  it("removes repos by repoId", () => {
    const result = removeRepoMeta([makeRepo(), makeRepo({ repoId: "repo-2" })], "repo-1");
    expect(result.changed).toBe(true);
    expect(result.items.map((repo) => repo.repoId)).toEqual(["repo-2"]);
  });
});

describe("getDisplayEnvBranchStatus", () => {
  it("derives behind-main from repo main commit", () => {
    const env = makeEnv({
      branchStatus: "up-to-date",
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    });
    const repo = makeRepo({ mainCommit: "main-b" });

    expect(getDisplayEnvBranchStatus(env, repo)).toBe("behind-main");
  });

  it("derives ready-to-merge from a dirty workspace", () => {
    const env = makeEnv({
      workspaceDirty: true,
      baseMainCommit: "main-a",
      lastKnownMainCommit: "main-a",
    });

    expect(getDisplayEnvBranchStatus(env, makeRepo())).toBe("ready-to-merge");
  });
});
