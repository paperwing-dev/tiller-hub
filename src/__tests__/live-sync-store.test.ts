import { describe, expect, it } from "vitest";
import type { EnvMeta, RepoMeta, StoredSession } from "../../api/types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../../api/scm/model";
import {
  mergeFetchedEnvs,
  mergeFetchedRepos,
  reconcileFetchedEnvSnapshot,
  reconcileFetchedRepoSnapshot,
  reconcileSelectionAfterEnvRefresh,
  reconcileSelectionAfterRunningEnv,
  reconcileSelectionAfterStoppedEnv,
} from "../live-sync-store";

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
  const repo: RepoMeta = {
    repoId: "repo-1",
    artifactStoreGeneration: null,
    repoUrl: "https://github.com/user/repo",
    githubInstallationId: 98765,
    githubFullName: "user/repo",
    ...createInitialRepoScmState(),
    mainCommit: "main-a",
    gitArtifactId: "artifact-1",
    gitStatus: "ready",
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
  };
  return Object.assign(repo, overrides);
}

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    tag: "test-env",
    machine_id: null,
    metadata: JSON.stringify({ envSlug: "test-env", role: "lead" }),
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 1,
    ended_at: null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeFetchedEnvs", () => {
  it("keeps newer local env snapshots when a full refresh is stale", () => {
    const result = mergeFetchedEnvs(
      [makeEnv({ updatedAt: "2024-01-02T00:00:00.000Z", status: "stopped" })],
      [makeEnv({ updatedAt: "2024-01-01T00:00:00.000Z", status: "starting" })],
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      status: "stopped",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    expect(result.missingSlugs).toEqual([]);
  });

  it("keeps missing envs in the store until targeted verification runs", () => {
    const result = mergeFetchedEnvs(
      [makeEnv(), makeEnv({ slug: "other-env" })],
      [makeEnv()],
    );

    expect(result.items.map((env) => env.slug)).toEqual(["test-env", "other-env"]);
    expect(result.missingSlugs).toEqual(["other-env"]);
  });
});

describe("reconcileFetchedEnvSnapshot", () => {
  it("re-reads the latest env store before merging a completed refresh", () => {
    let currentEnvs = [makeEnv()];
    const fetchedEnvs = [makeEnv()];

    currentEnvs = [
      ...currentEnvs,
      makeEnv({
        slug: "ws-env",
        updatedAt: "2024-01-02T00:00:00.000Z",
        status: "starting",
      }),
    ];

    const result = reconcileFetchedEnvSnapshot(() => currentEnvs, fetchedEnvs);

    expect(result.items.map((env) => env.slug)).toEqual(["test-env", "ws-env"]);
    expect(result.missingSlugs).toEqual(["ws-env"]);
    expect([...result.previousEnvSlugs]).toEqual(["test-env", "ws-env"]);
  });
});

describe("mergeFetchedRepos", () => {
  it("keeps newer local repo snapshots when a full refresh is stale", () => {
    const result = mergeFetchedRepos(
      [makeRepo({ updatedAt: "2024-01-02T00:00:00.000Z", gitStatus: "repair-required" })],
      [makeRepo({ updatedAt: "2024-01-01T00:00:00.000Z", gitStatus: "pending" })],
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      gitStatus: "repair-required",
      updatedAt: "2024-01-02T00:00:00.000Z",
    });
    expect(result.missingRepoIds).toEqual([]);
  });
});

describe("reconcileFetchedRepoSnapshot", () => {
  it("re-reads the latest repo store before merging a completed refresh", () => {
    let currentRepos = [makeRepo()];
    const fetchedRepos = [makeRepo()];

    currentRepos = [
      ...currentRepos,
      makeRepo({
        repoId: "repo-2",
        repoUrl: "https://github.com/user/other",
        updatedAt: "2024-01-02T00:00:00.000Z",
        gitStatus: "pending",
      }),
    ];

    const result = reconcileFetchedRepoSnapshot(() => currentRepos, fetchedRepos);

    expect(result.items.map((repo) => repo.repoId)).toEqual(["repo-1", "repo-2"]);
    expect(result.missingRepoIds).toEqual(["repo-2"]);
  });
});

describe("selection reconciliation", () => {
  it("clears session selection when the session is not attached to a managed environment", () => {
    const selection = { type: "session", sessionId: "session-1" } as const;

    const nextSelection = reconcileSelectionAfterEnvRefresh(
      selection,
      [makeSession({ tag: "local-shell", metadata: JSON.stringify({ role: "lead" }) })],
      new Set(["test-env"]),
      [makeEnv()],
    );

    expect(nextSelection).toEqual({ type: "none" });
  });

  it("uses metadata.envSlug instead of the display tag to keep managed sessions attached", () => {
    const nextSelection = reconcileSelectionAfterEnvRefresh(
      { type: "session", sessionId: "session-1" },
      [makeSession({ tag: "worker-1", metadata: JSON.stringify({ envSlug: "test-env", role: "worker" }) })],
      new Set(["test-env"]),
      [makeEnv({ status: "stopped" })],
    );

    expect(nextSelection).toEqual({ type: "env", envSlug: "test-env" });
  });

  it("clears env-backed session selection when that env is confirmed gone", () => {
    const nextSelection = reconcileSelectionAfterEnvRefresh(
      { type: "session", sessionId: "session-1" },
      [makeSession({ tag: "test-env" })],
      new Set(["test-env"]),
      [],
    );

    expect(nextSelection).toEqual({ type: "none" });
  });

  it("moves a selected env-backed session back to env view once the env stops", () => {
    const nextSelection = reconcileSelectionAfterStoppedEnv(
      { type: "session", sessionId: "session-1" },
      [makeSession({ tag: "test-env" })],
      makeEnv({ status: "stopped" }),
    );

    expect(nextSelection).toEqual({ type: "env", envSlug: "test-env" });
  });

  it("moves a selected env-backed session back to env view while the env is saving changes", () => {
    const nextSelection = reconcileSelectionAfterStoppedEnv(
      { type: "session", sessionId: "session-1" },
      [makeSession({ tag: "test-env" })],
      makeEnv({ status: "saving" }),
    );

    expect(nextSelection).toEqual({ type: "env", envSlug: "test-env" });
  });

  it("moves a selected env-backed session back to env view when the env fails", () => {
    const nextSelection = reconcileSelectionAfterStoppedEnv(
      { type: "session", sessionId: "session-1" },
      [makeSession({ tag: "test-env" })],
      makeEnv({ status: "failed" }),
    );

    expect(nextSelection).toEqual({ type: "env", envSlug: "test-env" });
  });
});

describe("reconcileSelectionAfterRunningEnv", () => {
  it("leaves 'none' selection untouched", () => {
    const next = reconcileSelectionAfterRunningEnv(
      { type: "none" },
      [makeSession()],
      [makeEnv()],
    );
    expect(next).toEqual({ type: "none" });
  });

  it("leaves session selection untouched", () => {
    const selection = { type: "session", sessionId: "session-1" } as const;
    const next = reconcileSelectionAfterRunningEnv(selection, [makeSession()], [makeEnv()]);
    expect(next).toBe(selection);
  });

  it("promotes env selection to the primary session once env is running and session exists", () => {
    const next = reconcileSelectionAfterRunningEnv(
      { type: "env", envSlug: "test-env" },
      [makeSession()],
      [makeEnv({ status: "running" })],
    );
    expect(next).toEqual({ type: "session", sessionId: "session-1" });
  });

  it("does not promote when the env is still starting", () => {
    const selection = { type: "env", envSlug: "test-env" } as const;
    const next = reconcileSelectionAfterRunningEnv(
      selection,
      [makeSession()],
      [makeEnv({ status: "starting" })],
    );
    expect(next).toBe(selection);
  });

  it("does not promote while the primary session has not been observed yet", () => {
    const selection = { type: "env", envSlug: "test-env" } as const;
    const next = reconcileSelectionAfterRunningEnv(
      selection,
      [],
      [makeEnv({ status: "running" })],
    );
    expect(next).toBe(selection);
  });

  it("does not promote when only a non-lead session is attached to the env", () => {
    const selection = { type: "env", envSlug: "test-env" } as const;
    const next = reconcileSelectionAfterRunningEnv(
      selection,
      [
        makeSession({
          metadata: JSON.stringify({ envSlug: "test-env", role: "worker" }),
        }),
      ],
      [makeEnv({ status: "running" })],
    );
    expect(next).toBe(selection);
  });

  it("leaves env selection untouched when the env has vanished", () => {
    const selection = { type: "env", envSlug: "test-env" } as const;
    const next = reconcileSelectionAfterRunningEnv(selection, [makeSession()], []);
    expect(next).toBe(selection);
  });

  it("mirrors reconcileSelectionAfterStoppedEnv: saving demotes, running re-promotes", () => {
    const envSlug = "test-env";
    const sessions = [makeSession()];

    const demoted = reconcileSelectionAfterStoppedEnv(
      { type: "session", sessionId: "session-1" },
      sessions,
      makeEnv({ status: "saving" }),
    );
    expect(demoted).toEqual({ type: "env", envSlug });

    const promoted = reconcileSelectionAfterRunningEnv(
      demoted,
      sessions,
      [makeEnv({ status: "running" })],
    );
    expect(promoted).toEqual({ type: "session", sessionId: "session-1" });
  });
});
