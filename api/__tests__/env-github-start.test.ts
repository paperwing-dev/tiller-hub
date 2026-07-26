import { describe, expect, it, vi } from "vitest";
import type { EnvMeta, RepoMeta } from "../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../scm/model";
import {
  getGitHubStartBaseAdvanceDecision,
  hasGitHubPublicationState,
  isGitHubDraftOverlayEmpty,
} from "../env/github-start";

function makeEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const now = "2026-06-16T00:00:00.000Z";
  return {
    slug: "env-1",
    repoId: "42",
    repoUrl: "https://github.com/owner/repo",
    backend: "cf",
    harness: "codex",
    createdAt: now,
    updatedAt: now,
    status: "stopped",
    ...createInitialEnvScmState({
      slug: "env-1",
      githubBaseBranch: "main",
      githubBaseCommitSha: "main-old",
    }),
    ...overrides,
  };
}

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-06-16T00:00:00.000Z";
  return {
    repoId: "42",
    repoUrl: "https://github.com/owner/repo",
    githubInstallationId: 1001,
    githubFullName: "owner/repo",
    ...createInitialRepoScmState(),
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-new",
    gitStatus: "ready",
    gitError: null,
    createdAt: now,
    updatedAt: now,
    bootstrappedFromRef: "main",
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
    ...overrides,
  };
}

describe("GitHub start helpers", () => {
  it("treats an empty hashed draft manifest and deleted-path metadata as an empty overlay", async () => {
    await expect(isGitHubDraftOverlayEmpty({
      getHashedManifest: vi.fn().mockResolvedValue([]),
      readGitHubDeletedWorkspacePaths: vi.fn().mockResolvedValue([]),
    })).resolves.toBe(true);

    await expect(isGitHubDraftOverlayEmpty({
      getHashedManifest: vi.fn().mockResolvedValue([]),
      readGitHubDeletedWorkspacePaths: vi.fn().mockResolvedValue(["/deleted.ts"]),
    })).resolves.toBe(false);
  });

  it("does not count the generated GitHub branch name as publication state", () => {
    expect(hasGitHubPublicationState(makeEnvMeta({ githubBranch: "tiller/env/env-1" }))).toBe(false);
    expect(hasGitHubPublicationState(makeEnvMeta({ githubHeadCommitSha: "draft-head" }))).toBe(true);
    expect(hasGitHubPublicationState(makeEnvMeta({ githubPublishStatus: "published" }))).toBe(true);
    expect(hasGitHubPublicationState(makeEnvMeta({ githubLastPublishedWorkspaceHash: "hash" }))).toBe(true);
  });

  it("advances clean stopped GitHub envs when refreshed main differs", () => {
    expect(getGitHubStartBaseAdvanceDecision({
      meta: makeEnvMeta({ githubBaseCommitSha: "main-old" }),
      repo: makeRepoMeta({ githubDefaultBranchHeadSha: "main-new" }),
      startable: true,
      overlayEmpty: true,
      refreshFailureKind: null,
    })).toEqual({
      action: "advance",
      baseBranch: "main",
      baseCommitSha: "main-new",
    });
  });

  it("keeps pinned or publication-state envs on the stored base", () => {
    expect(getGitHubStartBaseAdvanceDecision({
      meta: makeEnvMeta({ startupPlanId: "plan-1" }),
      repo: makeRepoMeta(),
      startable: true,
      overlayEmpty: true,
      refreshFailureKind: null,
    })).toMatchObject({ action: "stored" });

    expect(getGitHubStartBaseAdvanceDecision({
      meta: makeEnvMeta({ githubPrNumber: 12 }),
      repo: makeRepoMeta(),
      startable: true,
      overlayEmpty: true,
      refreshFailureKind: null,
    })).toMatchObject({ action: "stored" });
  });

  it("blocks clean candidates on not-ready or access refresh failures", () => {
    expect(getGitHubStartBaseAdvanceDecision({
      meta: makeEnvMeta(),
      repo: makeRepoMeta(),
      startable: true,
      overlayEmpty: true,
      refreshFailureKind: "not_ready",
      refreshError: "unsupported metadata",
      refreshCode: "github_default_branch_not_ready",
      refreshStatus: 409,
    })).toEqual({
      action: "block",
      failureKind: "not_ready",
      error: "unsupported metadata",
      code: "github_default_branch_not_ready",
      status: 409,
    });

    expect(getGitHubStartBaseAdvanceDecision({
      meta: makeEnvMeta({ startupPlanId: "plan-1" }),
      repo: makeRepoMeta(),
      startable: true,
      overlayEmpty: true,
      refreshFailureKind: "access_error",
      refreshError: "repo not selected",
      refreshCode: "github_app_repo_not_selected",
      refreshStatus: 403,
    })).toMatchObject({ action: "stored" });
  });

  it("skips auto-advance on transient refresh failures", () => {
    expect(getGitHubStartBaseAdvanceDecision({
      meta: makeEnvMeta(),
      repo: makeRepoMeta(),
      startable: true,
      overlayEmpty: true,
      refreshFailureKind: "transient_error",
      refreshError: "timeout",
    })).toEqual({
      action: "stored",
      reason: "refresh_transient_error",
    });
  });
});
