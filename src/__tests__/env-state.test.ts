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
  const env: EnvMeta = {
    slug: "test-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/user/repo",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "test-env",
      mainCommit: "main-a",
    }),
  };
  return Object.assign(env, overrides);
}

function makeRepo(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const mainCommit = overrides.mainCommit === undefined ? "main-a" : overrides.mainCommit;
  const repo: RepoMeta = {
    repoId: "repo-1",
    artifactStoreGeneration: null,
    repoUrl: "https://github.com/user/repo",
    githubInstallationId: 98765,
    githubFullName: "user/repo",
    ...createInitialRepoScmState(),
    githubDefaultBranch: overrides.githubDefaultBranch ?? "main",
    githubDefaultBranchHeadSha: overrides.githubDefaultBranchHeadSha === undefined ? mainCommit : overrides.githubDefaultBranchHeadSha,
    mainCommit,
    gitArtifactId: "artifact-1",
    gitStatus: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
  };
  return Object.assign(repo, overrides);
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

  it("does not let a late pre-profile update replace a newer Codex auth projection", () => {
    const profileBacked = makeEnv({
      harness: "codex",
      codexAuthMode: "subscription",
      updatedAt: "2024-01-01T00:00:00.001Z",
      status: "starting",
    });
    const preProfile = makeEnv({
      harness: "codex",
      updatedAt: "2024-01-01T00:00:00.000Z",
      status: "starting",
    });

    const result = upsertEnvMeta([profileBacked], preProfile);

    expect(result.changed).toBe(false);
    expect(result.items[0]).toMatchObject({ codexAuthMode: "subscription" });
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
      githubBaseCommitSha: "main-a",
    });
    const repo = makeRepo({ mainCommit: "main-b", githubDefaultBranchHeadSha: "main-b" });

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
