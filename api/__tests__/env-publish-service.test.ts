import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createInitialEnvScmState,
  createInitialRepoScmState,
} from "../scm/model";

const mocks = vi.hoisted(() => ({
  state: {
    meta: null as any,
    operation: null as any,
  },
  getArtifactStoreStub: vi.fn(),
  getEnvLifecycleStub: vi.fn(),
  getGitHubJobStub: vi.fn(),
  getWorkspaceStub: vi.fn(),
  resolveContainerHubUrl: vi.fn(),
  buildEnvWorkspaceApiBaseUrl: vi.fn(),
  getRunnerBackend: vi.fn(),
  projectAndPersistEnvSummary: vi.fn(),
  projectEnvMetaForAction: vi.fn(),
  getHub: vi.fn(),
  isLifecycleStopInProgress: vi.fn(),
  loadRepo: vi.fn(),
  bridgeCredentialsToEnvVars: vi.fn(),
  createGitHubBridgeRecord: vi.fn(),
  revokeGitHubBridgesForEnvPublish: vi.fn(),
  resolveProtectionState: vi.fn(),
  getSecret: vi.fn(),
  createPullRequest: vi.fn(),
  findOpenPullRequest: vi.fn(),
  readCommitRef: vi.fn(),
  readRepositoryDefaultBranch: vi.fn(),
  updatePullRequest: vi.fn(),
  assertSupportedGitHubBaseMetadata: vi.fn(),
  mintGitHubInstallationToken: vi.fn(),
  resolveGitHubAppBotCommitIdentity: vi.fn(),
  asPlanArtifact: vi.fn(),
  renderArtifactBodyMarkdown: vi.fn(),
  startJob: vi.fn(),
  destroyJob: vi.fn(),
  createRunner: vi.fn(),
  destroyRunner: vi.fn(),
  resolveNewExecutionPlacement: vi.fn(),
  beginGitHubPublishOperation: vi.fn(),
  claimGitHubPublishResult: vi.fn(),
  getGitHubPublishOperation: vi.fn(),
  updateGitHubPublishOperation: vi.fn(),
  markGitHubPublishCleanupPending: vi.fn(),
  finishGitHubPublishOperation: vi.fn(),
}));

vi.mock("../helpers", () => ({
  getArtifactStoreStub: mocks.getArtifactStoreStub,
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getGitHubJobStub: mocks.getGitHubJobStub,
  getWorkspaceStub: mocks.getWorkspaceStub,
}));

vi.mock("../env/hub-url", () => ({
  resolveContainerHubUrl: mocks.resolveContainerHubUrl,
  buildEnvWorkspaceApiBaseUrl: mocks.buildEnvWorkspaceApiBaseUrl,
}));

vi.mock("../env/runner-backends", () => ({
  getRunnerBackend: mocks.getRunnerBackend,
}));

vi.mock("../execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../execution")>()),
  resolveNewExecutionPlacement: mocks.resolveNewExecutionPlacement,
}));

vi.mock("../env/service", () => ({
  getHub: mocks.getHub,
  projectAndPersistEnvSummary: mocks.projectAndPersistEnvSummary,
  projectEnvMetaForAction: mocks.projectEnvMetaForAction,
}));

vi.mock("../env-lifecycle", () => ({
  isLifecycleStopInProgress: mocks.isLifecycleStopInProgress,
}));

vi.mock("../repo/access", () => ({
  loadRepo: mocks.loadRepo,
}));

vi.mock("../github/bridge", () => ({
  bridgeCredentialsToEnvVars: mocks.bridgeCredentialsToEnvVars,
  createGitHubBridgeRecord: mocks.createGitHubBridgeRecord,
  revokeGitHubBridgesForEnvPublish: mocks.revokeGitHubBridgesForEnvPublish,
}));

vi.mock("../protection", () => ({
  resolveProtectionState: mocks.resolveProtectionState,
}));

vi.mock("../setup/config", () => ({
  getSecret: mocks.getSecret,
}));

vi.mock("../github/git-api", () => ({
  createPullRequest: mocks.createPullRequest,
  findOpenPullRequest: mocks.findOpenPullRequest,
  readCommitRef: mocks.readCommitRef,
  readRepositoryDefaultBranch: mocks.readRepositoryDefaultBranch,
  updatePullRequest: mocks.updatePullRequest,
}));

vi.mock("../github/metadata-validation", () => ({
  assertSupportedGitHubBaseMetadata: mocks.assertSupportedGitHubBaseMetadata,
}));

vi.mock("../github/app", () => ({
  mintGitHubInstallationToken: mocks.mintGitHubInstallationToken,
  resolveGitHubAppBotCommitIdentity: mocks.resolveGitHubAppBotCommitIdentity,
}));

vi.mock("../coordination", () => ({
  asPlanArtifact: mocks.asPlanArtifact,
  renderArtifactBodyMarkdown: mocks.renderArtifactBodyMarkdown,
}));

vi.mock("../github/adoption", () => ({
  adoptionPayload: vi.fn(() => "adoption-payload"),
  hmacHex: vi.fn(async () => "adoption-hmac"),
}));

vi.mock("../sync/projectors", () => ({
  projectEnvSummary: vi.fn((meta) => meta),
}));

const { handleGitHubDraftPrPublishResult, startGitHubDraftPrPublish } =
  await import("../github/env-publish-service");

function createMeta() {
  const createdAt = "2026-07-09T18:00:00.000Z";
  return {
    ...createInitialEnvScmState({
      slug: "demo-env",
      startupPlanId: "plan-1",
      mainCommit: "base-sha",
      githubBaseBranch: "main",
      githubBaseCommitSha: "base-sha",
    }),
    slug: "demo-env",
    repoUrl: "https://github.com/example/repo.git",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "codex",
    status: "stopped",
    createdAt,
    updatedAt: createdAt,
    githubHeadCommitSha: "prior-head-sha",
    branchStatus: "ready-to-merge",
  };
}

const repo = {
  meta: {
    ...createInitialRepoScmState(),
    repoId: "repo-1",
    repoUrl: "https://github.com/example/repo.git",
    githubFullName: "example/repo",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "base-sha",
    mainCommit: "base-sha",
    createdAt: "2026-07-09T18:00:00.000Z",
    updatedAt: "2026-07-09T18:00:00.000Z",
  },
  workspace: {},
};

function treeEntry(path: string) {
  return {
    path,
    mode: "100644",
    type: "blob",
    sha: `${path}-sha`,
    size: 10,
  };
}

describe("GitHub draft PR publish service", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.state.meta = createMeta();
    mocks.state.operation = null;

    mocks.projectAndPersistEnvSummary.mockImplementation(
      async () => mocks.state.meta,
    );
    mocks.projectEnvMetaForAction.mockImplementation(async () => ({
      meta: mocks.state.meta,
    }));
    mocks.getHub.mockReturnValue({});
    mocks.isLifecycleStopInProgress.mockReturnValue(false);
    mocks.createRunner.mockResolvedValue(undefined);
    mocks.destroyRunner.mockResolvedValue(undefined);
    mocks.getRunnerBackend.mockResolvedValue({
      create: mocks.createRunner,
      destroy: mocks.destroyRunner,
    });
    mocks.resolveNewExecutionPlacement.mockResolvedValue({
      backend: "cf",
      machineId: null,
    });
    mocks.loadRepo.mockResolvedValue({ ok: true, repo });
    mocks.resolveContainerHubUrl.mockResolvedValue("https://hub.example.test");
    mocks.buildEnvWorkspaceApiBaseUrl.mockReturnValue(
      "https://hub.example.test/api/envs/demo-env/workspace",
    );
    mocks.resolveProtectionState.mockResolvedValue({ protectionMode: "none" });
    mocks.createGitHubBridgeRecord.mockResolvedValue({ id: "bridge-1" });
    mocks.bridgeCredentialsToEnvVars.mockReturnValue({
      TILLER_GITHUB_BRIDGE_ID: "bridge-1",
    });
    mocks.revokeGitHubBridgesForEnvPublish.mockResolvedValue(undefined);
    mocks.getSecret.mockResolvedValue(null);

    mocks.assertSupportedGitHubBaseMetadata.mockResolvedValue({
      tree: {
        treeSha: "base-tree-sha",
        entries: new Map([
          ["src/existing.ts", treeEntry("src/existing.ts")],
          ["src/old.ts", treeEntry("src/old.ts")],
        ]),
      },
      installationToken: "installation-token",
    });
    mocks.getWorkspaceStub.mockReturnValue({
      getHashedManifest: vi.fn().mockResolvedValue([
        { path: "/src/existing.ts", size: 20, sha256: "updated-file-hash" },
        { path: "/src/new.ts", size: 15, sha256: "new-file-hash" },
      ]),
      readGitHubDeletedWorkspacePaths: vi
        .fn()
        .mockResolvedValue(["/src/old.ts"]),
    });
    mocks.getArtifactStoreStub.mockReturnValue({
      getArtifact: vi.fn().mockResolvedValue({
        repoId: "repo-1",
        title: "Implementation Plan: Improve draft PR descriptions",
        body: "## Summary\n\nExplain the feature and its GitHub changes.\n\n## Implementation\n\nInternal details.",
      }),
    });
    mocks.asPlanArtifact.mockImplementation((artifact) => artifact);
    mocks.renderArtifactBodyMarkdown.mockImplementation((body) => String(body));
    mocks.resolveGitHubAppBotCommitIdentity.mockResolvedValue({
      name: "tiller-test[bot]",
      email: "24680+tiller-test[bot]@users.noreply.github.com",
    });

    mocks.beginGitHubPublishOperation.mockImplementation(async (operation) => {
      mocks.state.operation = {
        ...operation,
        resultClaim: null,
        cleanupPending: null,
      };
      mocks.state.meta = {
        ...mocks.state.meta,
        githubPublishOperationId: operation.operationId,
        githubPublishStatus: "publishing",
      };
      return { claimed: true, state: mocks.state.meta };
    });
    mocks.claimGitHubPublishResult.mockImplementation(async ({ claimId }) => {
      if (!mocks.state.operation) return { status: "inactive" };
      mocks.state.operation = {
        ...mocks.state.operation,
        resultClaim: { claimId, expiresAtMs: Date.now() + 60_000 },
      };
      return { status: "claimed", operation: mocks.state.operation };
    });
    mocks.getGitHubPublishOperation.mockImplementation(
      async () => mocks.state.operation,
    );
    mocks.updateGitHubPublishOperation.mockImplementation(async (update) => {
      mocks.state.operation = { ...mocks.state.operation, ...update };
      return { applied: true, state: mocks.state.meta };
    });
    mocks.finishGitHubPublishOperation.mockImplementation(async ({ patch }) => {
      mocks.state.meta = { ...mocks.state.meta, ...patch };
      mocks.state.operation = null;
      return { applied: true, state: mocks.state.meta };
    });
    mocks.getEnvLifecycleStub.mockReturnValue({
      beginGitHubPublishOperation: mocks.beginGitHubPublishOperation,
      claimGitHubPublishResult: mocks.claimGitHubPublishResult,
      getGitHubPublishOperation: mocks.getGitHubPublishOperation,
      updateGitHubPublishOperation: mocks.updateGitHubPublishOperation,
      markGitHubPublishCleanupPending: mocks.markGitHubPublishCleanupPending,
      finishGitHubPublishOperation: mocks.finishGitHubPublishOperation,
    });
    mocks.getGitHubJobStub.mockReturnValue({
      startJob: mocks.startJob,
      destroyJob: mocks.destroyJob,
    });
    mocks.startJob.mockResolvedValue(undefined);
    mocks.destroyJob.mockResolvedValue(undefined);
    mocks.markGitHubPublishCleanupPending.mockResolvedValue(true);

    mocks.mintGitHubInstallationToken.mockResolvedValue({
      token: "write-token",
    });
    mocks.readRepositoryDefaultBranch.mockResolvedValue("main");
    mocks.findOpenPullRequest.mockResolvedValue(null);
    mocks.createPullRequest.mockResolvedValue({
      number: 42,
      htmlUrl: "https://github.com/example/repo/pull/42",
      body: null,
    });
  });

  it("carries feature content, change statuses, and bot identity through publish finalization", async () => {
    const started = await startGitHubDraftPrPublish({
      env: {} as any,
      requestUrl:
        "https://hub.example.test/api/envs/demo-env/github/publish-draft-pr",
      slug: "demo-env",
    });

    expect(started.status).toBe(202);
    const operation = mocks.beginGitHubPublishOperation.mock.calls[0]?.[0];
    expect(operation.pullRequestContent).toMatchObject({
      title: "Improve draft PR descriptions",
    });
    expect(operation).toMatchObject({
      jobSlug: expect.stringContaining("github-publish-demo-env-"),
      executionPlacement: { backend: "cf", machineId: null },
    });
    expect(operation.pullRequestContent.featureMarkdown).toContain(
      "3 files changed (1 added, 1 modified, 1 deleted).",
    );
    expect(operation.pullRequestContent.featureMarkdown).toContain(
      "- Added `src/new.ts`",
    );
    expect(operation.pullRequestContent.featureMarkdown).toContain(
      "- Modified `src/existing.ts`",
    );
    expect(operation.pullRequestContent.featureMarkdown).toContain(
      "- Deleted `src/old.ts`",
    );
    expect(mocks.startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        TILLER_GITHUB_COMMIT_TITLE: "Improve draft PR descriptions",
        TILLER_GITHUB_COMMIT_AUTHOR_NAME: "tiller-test[bot]",
        TILLER_GITHUB_COMMIT_AUTHOR_EMAIL:
          "24680+tiller-test[bot]@users.noreply.github.com",
      }),
    );

    const completed = await handleGitHubDraftPrPublishResult({
      env: {} as any,
      slug: "demo-env",
      operationId: operation.operationId,
      body: {
        status: "published",
        branchHeadSha: "published-head-sha",
        callbackToken: operation.callbackToken,
        workspaceHash: operation.workspaceHash,
      },
    });

    expect(completed.status).toBe(200);
    expect(mocks.destroyJob).toHaveBeenCalledOnce();
    expect(mocks.updateGitHubPublishOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        resultClaimId: expect.stringContaining("github-publish-result-"),
        projection: expect.objectContaining({ pushedCommitSha: "published-head-sha" }),
      }),
    );
    expect(mocks.createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({ token: "write-token" }),
      expect.objectContaining({
        title: "Improve draft PR descriptions",
        head: "tiller/env/demo-env",
        base: "main",
        draft: true,
        body: expect.stringContaining(
          "3 files changed (1 added, 1 modified, 1 deleted).",
        ),
      }),
    );
    const prBody = mocks.createPullRequest.mock.calls[0]?.[1].body as string;
    expect(prBody).toContain("Explain the feature and its GitHub changes.");
    expect(prBody).toContain("- Added `src/new.ts`");
    expect(prBody).toContain("- Modified `src/existing.ts`");
    expect(prBody).toContain("- Deleted `src/old.ts`");
  });

  it("pins a machine publish runtime before dispatch and cleans up that exact machine", async () => {
    mocks.resolveNewExecutionPlacement.mockResolvedValue({
      backend: "host",
      machineId: "machine-1",
    });

    const started = await startGitHubDraftPrPublish({
      env: {} as any,
      requestUrl:
        "https://hub.example.test/api/envs/demo-env/github/publish-draft-pr",
      slug: "demo-env",
    });

    expect(started.status).toBe(202);
    const operation = mocks.beginGitHubPublishOperation.mock.calls[0]?.[0];
    expect(operation.executionPlacement).toEqual({
      backend: "host",
      machineId: "machine-1",
    });
    expect(mocks.createRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: "host",
        executionPlacement: { backend: "host", machineId: "machine-1" },
      }),
      expect.any(Object),
      {
        runnerCommand: {
          commandGeneration: 1,
          operationId: operation.operationId,
          desiredState: "running",
        },
      },
    );
    expect(mocks.startJob).not.toHaveBeenCalled();

    const completed = await handleGitHubDraftPrPublishResult({
      env: {} as any,
      slug: "demo-env",
      operationId: operation.operationId,
      body: {
        status: "failed",
        error: "publish failed",
        callbackToken: operation.callbackToken,
        workspaceHash: operation.workspaceHash,
      },
    });

    expect(completed.status).toBe(200);
    expect(mocks.destroyRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        executionPlacement: { backend: "host", machineId: "machine-1" },
      }),
      {
        runnerCommand: {
          commandGeneration: 2,
          operationId: `${operation.operationId}:cleanup`,
          desiredState: "absent",
        },
      },
    );
  });

  it("persists an exact-placement cleanup retry when dispatch and cleanup both fail", async () => {
    mocks.startJob.mockRejectedValueOnce(new Error("dispatch uncertain"));
    mocks.destroyJob.mockRejectedValueOnce(new Error("job service unavailable"));

    const result = await startGitHubDraftPrPublish({
      env: {} as any,
      requestUrl:
        "https://hub.example.test/api/envs/demo-env/github/publish-draft-pr",
      slug: "demo-env",
    });

    const operation = mocks.beginGitHubPublishOperation.mock.calls[0]?.[0];
    expect(result).toMatchObject({
      status: 503,
      body: { code: "github_publish_cleanup_pending" },
    });
    expect(mocks.markGitHubPublishCleanupPending).toHaveBeenCalledWith({
      operationId: operation.operationId,
      terminalError: "dispatch uncertain",
    });
    expect(mocks.finishGitHubPublishOperation).not.toHaveBeenCalled();
  });

  it("persists a cleanup retry when result handling cannot confirm runtime absence", async () => {
    const started = await startGitHubDraftPrPublish({
      env: {} as any,
      requestUrl:
        "https://hub.example.test/api/envs/demo-env/github/publish-draft-pr",
      slug: "demo-env",
    });
    expect(started.status).toBe(202);
    const operation = mocks.beginGitHubPublishOperation.mock.calls[0]?.[0];
    mocks.destroyJob.mockRejectedValueOnce(new Error("job service unavailable"));

    const result = await handleGitHubDraftPrPublishResult({
      env: {} as any,
      slug: "demo-env",
      operationId: operation.operationId,
      body: {
        status: "published",
        branchHeadSha: "published-head-sha",
        callbackToken: operation.callbackToken,
        workspaceHash: operation.workspaceHash,
      },
    });

    expect(result).toMatchObject({
      status: 503,
      body: { code: "github_publish_cleanup_pending" },
    });
    expect(mocks.markGitHubPublishCleanupPending).toHaveBeenCalledWith({
      operationId: operation.operationId,
      resultClaimId: expect.stringContaining("github-publish-result-"),
      terminalError: expect.stringContaining("cleanup was interrupted"),
    });
    expect(mocks.finishGitHubPublishOperation).not.toHaveBeenCalled();
  });

  it("rejects a late publish result after cleanup has taken durable ownership", async () => {
    mocks.claimGitHubPublishResult.mockResolvedValueOnce({ status: "cleanup_pending" });

    const result = await handleGitHubDraftPrPublishResult({
      env: {} as any,
      slug: "demo-env",
      operationId: "publish-1",
      body: {
        status: "published",
        branchHeadSha: "published-head-sha",
        callbackToken: "callback-token",
        workspaceHash: "workspace-hash",
      },
    });

    expect(result).toEqual({
      status: 409,
      body: {
        error: "Publish runtime cleanup is already pending.",
        code: "github_publish_cleanup_pending",
      },
    });
    expect(mocks.destroyJob).not.toHaveBeenCalled();
    expect(mocks.createPullRequest).not.toHaveBeenCalled();
    expect(mocks.finishGitHubPublishOperation).not.toHaveBeenCalled();
  });

  it("does not dispatch when another publish wins the durable claim", async () => {
    mocks.beginGitHubPublishOperation.mockResolvedValueOnce({
      claimed: false,
      state: {
        ...mocks.state.meta,
        githubPublishOperationId: "publish-existing",
        githubPublishStatus: "publishing",
      },
    });

    const result = await startGitHubDraftPrPublish({
      env: {} as any,
      requestUrl:
        "https://hub.example.test/api/envs/demo-env/github/publish-draft-pr",
      slug: "demo-env",
    });

    expect(result).toEqual({
      status: 409,
      body: {
        error: "A GitHub publish is already in progress.",
        code: "github_publish_in_progress",
      },
    });
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.createRunner).not.toHaveBeenCalled();
  });

  it("returns the selected-backend error without dispatch or fallback", async () => {
    mocks.resolveNewExecutionPlacement.mockRejectedValue(
      new Error("machine disconnected"),
    );

    const result = await startGitHubDraftPrPublish({
      env: {} as any,
      requestUrl:
        "https://hub.example.test/api/envs/demo-env/github/publish-draft-pr",
      slug: "demo-env",
    });

    expect(result).toEqual({
      status: 503,
      body: {
        error:
          "The selected execution backend is unavailable. Choose another backend in Settings.",
        code: "execution_backend_unavailable",
      },
    });
    expect(mocks.beginGitHubPublishOperation).not.toHaveBeenCalled();
    expect(mocks.startJob).not.toHaveBeenCalled();
    expect(mocks.createRunner).not.toHaveBeenCalled();
  });
});
