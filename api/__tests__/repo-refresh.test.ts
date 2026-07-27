import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMeta } from "../types";
import { createInitialRepoScmState } from "../scm/model";

const mocks = vi.hoisted(() => {
  class GitHubAppError extends Error {
    constructor(
      message: string,
      readonly code: string,
      readonly status = 502,
    ) {
      super(message);
      this.name = "GitHubAppError";
    }
  }
  return {
    GitHubAppError,
    isGitHubAppAllowedForRequest: vi.fn(),
    resolveGitHubAppRepositorySelectionById: vi.fn(),
    loadTrackedRepo: vi.fn(),
    patchRepoDefaultHeadIfCurrent: vi.fn(),
    readGitHubDefaultBranchState: vi.fn(),
    broadcastRepoUpsert: vi.fn(),
    broadcastRepoMainChange: vi.fn(),
  };
});

vi.mock("../github/app", () => ({
  GitHubAppError: mocks.GitHubAppError,
  isGitHubAppAllowedForRequest: mocks.isGitHubAppAllowedForRequest,
  resolveGitHubAppRepositorySelectionById: mocks.resolveGitHubAppRepositorySelectionById,
}));

vi.mock("../repo/access", () => ({
  loadTrackedRepo: mocks.loadTrackedRepo,
}));

vi.mock("../plan/store", () => ({
  patchRepoDefaultHeadIfCurrent: mocks.patchRepoDefaultHeadIfCurrent,
  readGitHubDefaultBranchState: mocks.readGitHubDefaultBranchState,
  repoDefaultHeadIdentityFromMeta: (meta: RepoMeta) => ({
    githubFullName: meta.githubFullName,
    repoUrl: meta.repoUrl,
    githubDefaultBranch: meta.githubDefaultBranch,
    githubDefaultBranchHeadSha: meta.githubDefaultBranchHeadSha,
    gitStatus: meta.gitStatus,
    gitError: meta.gitError,
  }),
}));

const { refreshGitHubDefaultBranchHead } = await import("../repo/refresh");

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-06-16T00:00:00.000Z";
  return {
    repoId: "42",
    repoUrl: "https://github.com/owner/old",
    ...createInitialRepoScmState(),
    githubInstallationId: 1001,
    githubFullName: "owner/old",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-old",
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

function makeEnv() {
  return {
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({
        broadcastRepoUpsert: mocks.broadcastRepoUpsert,
        broadcastRepoMainChange: mocks.broadcastRepoMainChange,
      })),
    },
  } as any;
}

describe("GitHub default branch refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recovers repo and default branch renames and broadcasts changed main", async () => {
    const current = makeRepoMeta();
    const refreshed = makeRepoMeta({
      repoUrl: "https://github.com/owner/new",
      githubFullName: "owner/new",
      githubDefaultBranch: "trunk",
      githubDefaultBranchHeadSha: "main-new",
    });
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: current } });
    mocks.resolveGitHubAppRepositorySelectionById.mockResolvedValue({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/new",
      repoUrl: "https://github.com/owner/new",
      private: false,
      defaultBranch: "trunk",
    });
    mocks.readGitHubDefaultBranchState.mockResolvedValue({ headSha: "main-new", error: null });
    mocks.patchRepoDefaultHeadIfCurrent.mockResolvedValue({
      repo: refreshed,
      changed: true,
      mainChanged: true,
      conflict: false,
    });

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      failureKind: null,
      changed: true,
      mainChanged: true,
      repo: { meta: { githubFullName: "owner/new", githubDefaultBranch: "trunk" } },
    });
    expect(mocks.resolveGitHubAppRepositorySelectionById).toHaveBeenCalledWith(expect.anything(), {
      repositoryId: 42,
      installationId: 1001,
    });
    expect(mocks.patchRepoDefaultHeadIfCurrent).toHaveBeenCalledWith(expect.objectContaining({
      expected: expect.objectContaining({
        githubFullName: "owner/old",
        githubDefaultBranchHeadSha: "main-old",
      }),
      next: expect.objectContaining({
        githubFullName: "owner/new",
        githubDefaultBranch: "trunk",
        githubDefaultBranchHeadSha: "main-new",
      }),
    }));
    expect(mocks.broadcastRepoUpsert).toHaveBeenCalledWith(expect.objectContaining({
      githubFullName: "owner/new",
    }));
    expect(mocks.broadcastRepoMainChange).toHaveBeenCalledWith(
      "42",
      "https://github.com/owner/new",
      "main-old",
      "main-new",
      null,
    );
  });

  it("classifies GitHub App permission failures as access errors", async () => {
    const current = makeRepoMeta();
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: current } });
    mocks.resolveGitHubAppRepositorySelectionById.mockRejectedValue(
      new mocks.GitHubAppError("missing permissions", "github_app_missing_permissions", 403),
    );

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      repo: { meta: current },
      failureKind: "access_error",
      code: "github_app_missing_permissions",
      status: 403,
    });
  });

  it("classifies GitHub App failures during default branch reads as access errors", async () => {
    const current = makeRepoMeta();
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: current } });
    mocks.resolveGitHubAppRepositorySelectionById.mockResolvedValue({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/old",
      repoUrl: "https://github.com/owner/old",
      private: false,
      defaultBranch: "main",
    });
    mocks.readGitHubDefaultBranchState.mockRejectedValue(
      new mocks.GitHubAppError("missing permissions", "github_app_missing_permissions", 403),
    );

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      repo: { meta: current },
      failureKind: "access_error",
      code: "github_app_missing_permissions",
      status: 403,
    });
    expect(mocks.patchRepoDefaultHeadIfCurrent).not.toHaveBeenCalled();
  });

  it("persists unsupported tree metadata and reports not-ready", async () => {
    const current = makeRepoMeta();
    const repaired = makeRepoMeta({
      gitStatus: "repair-required",
      gitError: "unsupported metadata",
    });
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: current } });
    mocks.resolveGitHubAppRepositorySelectionById.mockResolvedValue({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/old",
      repoUrl: "https://github.com/owner/old",
      private: false,
      defaultBranch: "main",
    });
    mocks.readGitHubDefaultBranchState.mockResolvedValue({ headSha: "main-old", error: "unsupported metadata" });
    mocks.patchRepoDefaultHeadIfCurrent.mockResolvedValue({
      repo: repaired,
      changed: true,
      mainChanged: false,
      conflict: false,
    });

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      failureKind: "not_ready",
      error: "unsupported metadata",
      repo: { meta: { gitStatus: "repair-required", gitError: "unsupported metadata" } },
    });
    expect(mocks.broadcastRepoUpsert).toHaveBeenCalledTimes(1);
    expect(mocks.broadcastRepoMainChange).not.toHaveBeenCalled();
  });

  it("classifies unexpected refresh failures as transient", async () => {
    const current = makeRepoMeta();
    mocks.loadTrackedRepo.mockResolvedValue({ ok: true, repo: { workspace: {}, meta: current } });
    mocks.resolveGitHubAppRepositorySelectionById.mockResolvedValue({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/old",
      repoUrl: "https://github.com/owner/old",
      private: false,
      defaultBranch: "main",
    });
    mocks.readGitHubDefaultBranchState.mockRejectedValue(new Error("GitHub timeout"));

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      repo: { meta: current },
      failureKind: "transient_error",
      error: "GitHub timeout",
    });
    expect(mocks.patchRepoDefaultHeadIfCurrent).not.toHaveBeenCalled();
  });

  it("retries a CAS conflict instead of accepting a different ready head", async () => {
    const current = makeRepoMeta({ githubDefaultBranchHeadSha: "main-old" });
    const concurrent = makeRepoMeta({ githubDefaultBranchHeadSha: "main-webhook" });
    mocks.loadTrackedRepo
      .mockResolvedValueOnce({ ok: true, repo: { workspace: {}, meta: current } })
      .mockResolvedValueOnce({ ok: true, repo: { workspace: {}, meta: concurrent } });
    mocks.resolveGitHubAppRepositorySelectionById.mockResolvedValue({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/old",
      repoUrl: "https://github.com/owner/old",
      private: false,
      defaultBranch: "main",
    });
    mocks.readGitHubDefaultBranchState
      .mockResolvedValueOnce({ headSha: "main-refresh", error: null })
      .mockResolvedValueOnce({ headSha: "main-webhook", error: null });
    mocks.patchRepoDefaultHeadIfCurrent
      .mockResolvedValueOnce({
        repo: concurrent,
        changed: false,
        mainChanged: false,
        conflict: true,
      })
      .mockResolvedValueOnce({
        repo: concurrent,
        changed: false,
        mainChanged: false,
        conflict: false,
      });

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      failureKind: null,
      repo: { meta: { githubDefaultBranchHeadSha: "main-webhook" } },
    });
    expect(mocks.readGitHubDefaultBranchState).toHaveBeenCalledTimes(2);
    expect(mocks.patchRepoDefaultHeadIfCurrent).toHaveBeenCalledTimes(2);
  });

  it("preserves not-ready classification when a CAS conflict already wrote the same repair state", async () => {
    const current = makeRepoMeta({ githubDefaultBranchHeadSha: "main-old" });
    const repaired = makeRepoMeta({
      githubDefaultBranchHeadSha: null,
      gitStatus: "repair-required",
      gitError: "GitHub default branch head is unavailable.",
    });
    mocks.loadTrackedRepo
      .mockResolvedValueOnce({ ok: true, repo: { workspace: {}, meta: current } })
      .mockResolvedValueOnce({ ok: true, repo: { workspace: {}, meta: repaired } });
    mocks.resolveGitHubAppRepositorySelectionById.mockResolvedValue({
      repositoryId: 42,
      installationId: 1001,
      fullName: "owner/old",
      repoUrl: "https://github.com/owner/old",
      private: false,
      defaultBranch: "main",
    });
    mocks.readGitHubDefaultBranchState.mockResolvedValue({
      headSha: null,
      error: "GitHub default branch head is unavailable.",
    });
    mocks.patchRepoDefaultHeadIfCurrent.mockResolvedValue({
      repo: repaired,
      changed: false,
      mainChanged: false,
      conflict: true,
    });

    await expect(refreshGitHubDefaultBranchHead(makeEnv(), "42")).resolves.toMatchObject({
      failureKind: "not_ready",
      error: "GitHub default branch head is unavailable.",
      repo: { meta: { gitStatus: "repair-required", githubDefaultBranchHeadSha: null } },
    });
    expect(mocks.readGitHubDefaultBranchState).toHaveBeenCalledTimes(1);
    expect(mocks.patchRepoDefaultHeadIfCurrent).toHaveBeenCalledTimes(1);
  });
});
