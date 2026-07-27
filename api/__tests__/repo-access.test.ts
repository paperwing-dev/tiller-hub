import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoMeta } from "../types";

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
    createRepoWorkspaceFromGitHubAppSelection: vi.fn(),
    getRepoWorkspaceForRepoId: vi.fn(),
    getSelectedRepoWorkspaceForRepoId: vi.fn(),
    isGitHubAppAllowedForRequest: vi.fn(),
  };
});

vi.mock("../github/app", () => ({
  GitHubAppError: mocks.GitHubAppError,
  isGitHubAppAllowedForRequest: mocks.isGitHubAppAllowedForRequest,
}));

vi.mock("../plan/store", () => ({
  createRepoWorkspaceFromGitHubAppSelection: mocks.createRepoWorkspaceFromGitHubAppSelection,
  getRepoWorkspaceForRepoId: mocks.getRepoWorkspaceForRepoId,
  getSelectedRepoWorkspaceForRepoId: mocks.getSelectedRepoWorkspaceForRepoId,
}));

const {
  createOrRefreshRepoFromSelectionClaimForRequest,
  loadRepo,
  loadRepoForRequest,
  loadRepoProjection,
  loadTrackedRepoForRequest,
  shouldFailPendingOperationForRepoAccessCode,
} = await import("../repo/access");

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const mainCommit = overrides.mainCommit === undefined ? "main-1" : overrides.mainCommit;
  return {
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    scmModel: "github",
    githubInstallationId: 123,
    githubFullName: "test/repo",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: overrides.githubDefaultBranchHeadSha === undefined ? mainCommit : overrides.githubDefaultBranchHeadSha,
    githubWebhookConfigured: false,
    githubWebhookError: null,
    mainCommit,
    gitArtifactId: "git-1",
    gitStatus: "ready",
    gitError: null,
    gitFormatVersion: 1,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    bootstrappedFromRef: "HEAD",
    lastCommittedFromEnvSlug: null,
    lastCommittedAt: null,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<RepoMeta> = {}) {
  return {
    workspace: { id: "workspace" },
    meta: makeRepoMeta(overrides),
  };
}

describe("repo access boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(true);
  });

  it("loads stored projections without GitHub App validation or workspace exposure", async () => {
    const repo = makeRepo();
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue(repo);

    const result = await loadRepoProjection({} as any, " repo-1 ");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.repo).toEqual(repo.meta);
      expect("workspace" in result.repo).toBe(false);
    }
    expect(mocks.getRepoWorkspaceForRepoId).toHaveBeenCalledWith({}, "repo-1");
    expect(mocks.getSelectedRepoWorkspaceForRepoId).not.toHaveBeenCalled();
    expect(mocks.isGitHubAppAllowedForRequest).not.toHaveBeenCalled();
  });

  it("returns canonical selected-write failures", async () => {
    await expect(loadRepo({} as any, "")).resolves.toMatchObject({
      ok: false,
      status: 400,
      body: { code: "repo_id_required" },
    });

    mocks.getSelectedRepoWorkspaceForRepoId.mockResolvedValueOnce(null);
    await expect(loadRepo({} as any, "missing")).resolves.toMatchObject({
      ok: false,
      status: 404,
      body: { code: "repo_not_found" },
    });

    for (const [code, status] of [
      ["github_app_repo_not_selected", 403],
      ["github_app_missing_installation", 404],
      ["github_app_missing_permissions", 403],
    ] as const) {
      mocks.getSelectedRepoWorkspaceForRepoId.mockRejectedValueOnce(
        new mocks.GitHubAppError(code, code, status),
      );
      await expect(loadRepo({} as any, "repo-1")).resolves.toMatchObject({
        ok: false,
        status,
        body: { code },
      });
    }
  });

  it("gates request-backed repo access on protected hubs or localhost", async () => {
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(false);

    const result = await loadRepoForRequest(
      {} as any,
      new Request("https://hub.example.com/api/repos/repo-1"),
      "repo-1",
    );

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      body: { code: "github_app_public_hub_disabled" },
    });
    expect(mocks.getSelectedRepoWorkspaceForRepoId).not.toHaveBeenCalled();
  });

  it("loads tracked repository state for requests without live GitHub validation", async () => {
    const repo = makeRepo();
    mocks.getRepoWorkspaceForRepoId.mockResolvedValue(repo);

    const allowed = await loadTrackedRepoForRequest(
      {} as any,
      new Request("https://hub.example.com/api/repos/repo-1"),
      "repo-1",
    );

    expect(allowed).toMatchObject({ ok: true, repo });
    expect(mocks.getRepoWorkspaceForRepoId).toHaveBeenCalledWith({}, "repo-1");
    expect(mocks.getSelectedRepoWorkspaceForRepoId).not.toHaveBeenCalled();

    mocks.getRepoWorkspaceForRepoId.mockResolvedValueOnce(null);
    await expect(
      loadTrackedRepoForRequest({} as any, new Request("https://hub.example.com"), "missing"),
    ).resolves.toMatchObject({
      ok: false,
      status: 404,
      body: { code: "repo_not_found" },
    });

    mocks.getRepoWorkspaceForRepoId.mockRejectedValueOnce(new Error("workspace unavailable"));
    await expect(
      loadTrackedRepoForRequest({} as any, new Request("https://hub.example.com"), "repo-1"),
    ).resolves.toMatchObject({
      ok: false,
      status: 409,
      body: { code: "repo_metadata_unavailable", error: "workspace unavailable" },
    });

    vi.clearAllMocks();
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(false);
    await expect(loadTrackedRepoForRequest({} as any, new Request("https://hub.example.com"), "repo-1")).resolves.toMatchObject({
      ok: false,
      status: 403,
      body: { code: "github_app_public_hub_disabled" },
    });
    expect(mocks.getRepoWorkspaceForRepoId).not.toHaveBeenCalled();
  });

  it("gates repo create/refresh before delegating selection-claim validation", async () => {
    const claim = { repositoryId: 123, installationId: 456, fullName: "test/repo" };
    const repo = { ...makeRepo(), created: true };
    mocks.createRepoWorkspaceFromGitHubAppSelection.mockResolvedValue(repo);

    await expect(
      createOrRefreshRepoFromSelectionClaimForRequest({} as any, new Request("https://hub.example.com"), claim),
    ).resolves.toMatchObject({ ok: true, repo });
    expect(mocks.createRepoWorkspaceFromGitHubAppSelection).toHaveBeenCalledWith({}, claim);

    vi.clearAllMocks();
    mocks.isGitHubAppAllowedForRequest.mockResolvedValue(false);
    await expect(
      createOrRefreshRepoFromSelectionClaimForRequest({} as any, new Request("https://hub.example.com"), claim),
    ).resolves.toMatchObject({
      ok: false,
      status: 403,
      body: { code: "github_app_public_hub_disabled" },
    });
    expect(mocks.createRepoWorkspaceFromGitHubAppSelection).not.toHaveBeenCalled();
  });

  it("maps canonical repo access codes to SCM callback failure policy", () => {
    expect(shouldFailPendingOperationForRepoAccessCode("github_app_repo_not_selected")).toBe(true);
    expect(shouldFailPendingOperationForRepoAccessCode("github_app_missing_installation")).toBe(true);
    expect(shouldFailPendingOperationForRepoAccessCode("github_app_missing_permissions")).toBe(true);
    expect(shouldFailPendingOperationForRepoAccessCode("repo_not_found")).toBe(true);
    expect(shouldFailPendingOperationForRepoAccessCode("repo_git_not_ready")).toBe(false);
    expect(shouldFailPendingOperationForRepoAccessCode("github_app_not_configured")).toBe(false);
  });
});
