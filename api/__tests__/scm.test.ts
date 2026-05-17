import { describe, expect, it } from "vitest";
import {
  DEFAULT_REPO_MERGE_LOCK_LEASE_MS,
  ENV_SNAPSHOT_DURABILITY_EXCLUDES,
  MAX_REPO_MERGE_LOCK_LEASE_MS,
  MIN_REPO_MERGE_LOCK_LEASE_MS,
  resolveRepoMergeLockLeaseMs,
  shouldExcludeFromEnvSnapshot,
} from "../scm/constants";
import {
  buildEnvBranchName,
  buildEnvSnapshotKey,
  buildRepoGitArtifactKey,
  normalizeScmArtifactMetadata,
} from "../scm/artifacts";
import {
  buildScmContainerEnvVars,
  createInitialEnvScmState,
  createInitialRepoScmState,
  deriveBranchBackedEnvStatus,
  parseScmBooleanFlag,
  resolveRequestedStartupPlanId,
} from "../scm/model";

describe("SCM artifact layout", () => {
  it("builds the canonical repo git artifact key", () => {
    expect(buildRepoGitArtifactKey({ repoId: "repo-123", generationId: "g42" })).toBe(
      "repos/repo-123/git-artifacts/g42.tar.zst",
    );
  });

  it("builds the env snapshot key", () => {
    expect(buildEnvSnapshotKey({ envSlug: "auth-cleanup", snapshotId: "s7" })).toBe(
      "envs/auth-cleanup/snapshots/s7.tar.zst",
    );
  });

  it("derives unique env branch names from the env slug", () => {
    expect(buildEnvBranchName("auth-cleanup")).toBe("env/auth-cleanup");
  });

  it("normalizes artifact metadata to string values", () => {
    expect(
      normalizeScmArtifactMetadata({
        generationId: "g42",
        formatVersion: 1,
        compacted: true,
        ignored: null,
      }),
    ).toEqual({
      generationId: "g42",
      formatVersion: "1",
      compacted: "true",
    });
  });
});

describe("env snapshot exclusions", () => {
  it("keeps the exclusions list discoverable and non-empty", () => {
    expect(ENV_SNAPSHOT_DURABILITY_EXCLUDES.length).toBeGreaterThan(0);
    expect(ENV_SNAPSHOT_DURABILITY_EXCLUDES).toContain("/node_modules");
    expect(ENV_SNAPSHOT_DURABILITY_EXCLUDES).toContain("/.claude/settings.local.json");
  });

  it("matches excluded directories by prefix", () => {
    expect(shouldExcludeFromEnvSnapshot("/node_modules/react/index.js")).toBe(true);
    expect(shouldExcludeFromEnvSnapshot("dist/assets/main.js")).toBe(true);
    expect(shouldExcludeFromEnvSnapshot("/src/index.ts")).toBe(false);
    expect(shouldExcludeFromEnvSnapshot("/node_modules-cache/foo")).toBe(false);
  });
});

describe("repo merge lock lease defaults", () => {
  it("uses the default lease when no override is provided", () => {
    expect(resolveRepoMergeLockLeaseMs()).toBe(DEFAULT_REPO_MERGE_LOCK_LEASE_MS);
  });

  it("clamps the lease into the supported range", () => {
    expect(resolveRepoMergeLockLeaseMs(1)).toBe(MIN_REPO_MERGE_LOCK_LEASE_MS);
    expect(resolveRepoMergeLockLeaseMs(MAX_REPO_MERGE_LOCK_LEASE_MS * 10)).toBe(MAX_REPO_MERGE_LOCK_LEASE_MS);
    expect(resolveRepoMergeLockLeaseMs(15_000)).toBe(15_000);
  });
});

describe("SCM model defaults", () => {
  it("parses boolean config flags conservatively", () => {
    expect(parseScmBooleanFlag("true")).toBe(true);
    expect(parseScmBooleanFlag(" YES ")).toBe(true);
    expect(parseScmBooleanFlag("0")).toBe(false);
    expect(parseScmBooleanFlag(undefined)).toBe(false);
  });

  it("annotates repos for pending git snapshot bootstrapping", () => {
    expect(createInitialRepoScmState()).toMatchObject({
      gitArtifactId: null,
      mainCommit: null,
      gitStatus: "pending",
      gitFormatVersion: 1,
    });
  });

  it("annotates envs with visible branch defaults", () => {
    expect(createInitialEnvScmState({
      slug: "auth-cleanup",
    })).toMatchObject({
      branchName: "env/auth-cleanup",
      branchStatus: "up-to-date",
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: null,
    });
  });

  it("builds scm env vars for branch-backed containers", () => {
    expect(
      buildScmContainerEnvVars({
        branchName: "env/auth-cleanup",
      }),
    ).toEqual({
      TILLER_BRANCH_NAME: "env/auth-cleanup",
    });
  });
});

describe("branch-backed env behavior", () => {
  it("derives behind-main before ready-to-merge", () => {
    expect(
      deriveBranchBackedEnvStatus(
        {
          branchStatus: null,
          baseMainCommit: "head-1",
          lastKnownMainCommit: "head-1",
          workspaceDirty: true,
          workspaceNeedsAttention: false,
        },
        {
          mainCommit: "head-2",
        },
      ),
    ).toBe("behind-main");
  });

  it("derives ready-to-merge when local work exists on current main", () => {
    expect(
      deriveBranchBackedEnvStatus(
        {
          branchStatus: null,
          baseMainCommit: "head-1",
          lastKnownMainCommit: "head-1",
          workspaceDirty: true,
          workspaceNeedsAttention: false,
        },
        {
          mainCommit: "head-1",
        },
      ),
    ).toBe("ready-to-merge");
  });

  it("freezes startup plan selection for branch-backed envs", () => {
    expect(
      resolveRequestedStartupPlanId(
        {
          startupPlanId: "plan-1",
        },
        undefined,
      ),
    ).toBe("plan-1");

    expect(() =>
      resolveRequestedStartupPlanId(
        {
          startupPlanId: "plan-1",
        },
        "plan-2",
      ),
    ).toThrow(/freeze the startup plan/);
  });

  it("preserves an existing ready-to-merge status when git ancestry is unavailable", () => {
    expect(
      deriveBranchBackedEnvStatus(
        {
          branchStatus: "ready-to-merge",
          workspaceDirty: false,
          workspaceNeedsAttention: false,
          baseMainCommit: null,
          lastKnownMainCommit: null,
        },
        {
          mainCommit: null,
        },
      ),
    ).toBe("ready-to-merge");
  });

  it("treats dirty workspaces as ready-to-merge when base equals main", () => {
    expect(
      deriveBranchBackedEnvStatus(
        {
          branchStatus: null,
          workspaceDirty: true,
          workspaceNeedsAttention: false,
          baseMainCommit: "head-1",
          lastKnownMainCommit: "head-1",
        },
        {
          mainCommit: "head-1",
        },
      ),
    ).toBe("ready-to-merge");
  });

  it("treats workspaceNeedsAttention as needs-attention", () => {
    expect(
      deriveBranchBackedEnvStatus(
        {
          branchStatus: null,
          workspaceDirty: true,
          workspaceNeedsAttention: true,
          baseMainCommit: "head-1",
          lastKnownMainCommit: "head-1",
        },
        {
          mainCommit: "head-1",
        },
      ),
    ).toBe("needs-attention");
  });
});
