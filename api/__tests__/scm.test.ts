import { describe, expect, it } from "vitest";
import {
  ENV_SNAPSHOT_DURABILITY_EXCLUDES,
  shouldExcludeFromEnvSnapshot,
} from "../scm/constants";
import {
  buildEnvBranchName,
  buildEnvSnapshotKey,
  normalizeScmArtifactMetadata,
} from "../scm/artifacts";
import {
  buildScmContainerEnvVars,
  buildGitHubEnvBranchName,
  createInitialEnvScmState,
  createInitialRepoScmState,
  deriveBranchBackedEnvStatus,
  deriveGitHubEnvBranchStatus,
  isRecoverableGitHubPublishFailure,
  isEnvTransitioning,
  parseScmBooleanFlag,
} from "../scm/model";

describe("SCM artifact layout", () => {
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

  it("uses the environment incarnation to avoid reusing a stale GitHub PR branch", () => {
    expect(buildGitHubEnvBranchName(
      "auth cleanup",
      "env-12345678-90ab-cdef-1234-567890abcdef",
    )).toBe("tiller/env/auth-cleanup-1234567890ab");
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

  it("keeps active GitHub publishing in the live-sync transition set", () => {
    const stable = {
      status: "stopped" as const,
      scmOperationType: null,
      githubPublishStatus: "idle" as const,
      githubPublishOperationId: null,
    };

    expect(isEnvTransitioning(stable)).toBe(false);
    expect(isEnvTransitioning({
      ...stable,
      githubPublishStatus: "publishing",
    })).toBe(true);
    expect(isEnvTransitioning({
      ...stable,
      githubPublishOperationId: "operation-1",
    })).toBe(true);
  });
});

describe("branch-backed env behavior", () => {
  it("recovers legacy workflow permission failures from false git attention", () => {
    const failure = {
      githubPublishStatus: "failed" as const,
      githubPublishError: "refusing to update workflow files without `workflows` permission",
    };

    expect(isRecoverableGitHubPublishFailure(failure)).toBe(true);
    expect(
      deriveGitHubEnvBranchStatus(
        {
          ...failure,
          githubBaseCommitSha: "head-1",
          githubPrState: null,
          githubMergedAt: null,
          workspaceDirty: true,
          workspaceNeedsAttention: true,
        },
        { githubDefaultBranchHeadSha: "head-1" },
      ),
    ).toBe("ready-to-merge");
  });

  it("recovers credential-scoped repository failures from false git attention", () => {
    const failure = {
      githubPublishStatus: "failed" as const,
      githubPublishError: "Failed to push tiller/env/demo: remote: Repository not found.",
      githubBaseCommitSha: "base-sha",
      githubPrState: null,
      githubMergedAt: null,
      workspaceDirty: true,
      workspaceNeedsAttention: true,
    };

    expect(isRecoverableGitHubPublishFailure(failure)).toBe(true);
    expect(deriveGitHubEnvBranchStatus(failure, {
      githubDefaultBranchHeadSha: "base-sha",
    })).toBe("ready-to-merge");
  });

  it("keeps retryable GitHub publish failures out of needs-attention", () => {
    expect(
      deriveGitHubEnvBranchStatus(
        {
          githubBaseCommitSha: "head-1",
          githubPublishStatus: "failed",
          githubPrState: null,
          githubMergedAt: null,
          workspaceDirty: true,
          workspaceNeedsAttention: false,
        },
        {
          githubDefaultBranchHeadSha: "head-2",
        },
      ),
    ).toBe("behind-main");
  });

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
