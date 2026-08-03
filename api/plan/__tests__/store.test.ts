import { describe, expect, it, vi } from "vitest";
import type { EnvDefinition, EnvMeta, RepoMeta } from "../../types";
import { createInitialEnvScmState, createInitialRepoScmState } from "../../scm/model";
import { UnsupportedGitHubRepoMetadataError } from "../../github/metadata-validation";
import { getArtifactStoreStub } from "../../helpers";
import {
  createRepoWorkspaceFromGitHubAppSelection,
  getSelectedRepoWorkspaceForRepoId,
  listEnvDefinitionSlugs,
  listRepos,
  patchRepoDefaultHeadIfCurrent,
  persistEnvDefinition,
  persistEnvSummary,
  readEnvDefinition,
  readRepoMetaFromWorkspace,
  repoDefaultHeadIdentityFromMeta,
} from "../store";

const githubAppMocks = vi.hoisted(() => ({
  mintGitHubInstallationToken: vi.fn(),
  resolveGitHubAppRepositorySelection: vi.fn(),
  readCommitRef: vi.fn(),
  validateGitHubManagedTree: vi.fn(),
}));

vi.mock("../../github/app", async () => {
  const actual = await vi.importActual<typeof import("../../github/app")>("../../github/app");
  return {
    ...actual,
    mintGitHubInstallationToken: githubAppMocks.mintGitHubInstallationToken,
    resolveGitHubAppRepositorySelection: githubAppMocks.resolveGitHubAppRepositorySelection,
  };
});

vi.mock("../../github/git-api", async () => {
  const actual = await vi.importActual<typeof import("../../github/git-api")>("../../github/git-api");
  return {
    ...actual,
    readCommitRef: githubAppMocks.readCommitRef,
  };
});

vi.mock("../../github/metadata-validation", async () => {
  const actual = await vi.importActual<typeof import("../../github/metadata-validation")>("../../github/metadata-validation");
  return {
    ...actual,
    validateGitHubManagedTree: githubAppMocks.validateGitHubManagedTree,
  };
});

function makeEnvDefinition(overrides: Partial<EnvDefinition> = {}): EnvDefinition {
  return {
    slug: "env-1",
    incarnationId: "incarnation-1",
    repoId: "123456",
    scmModel: "github",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    startupPlanId: null,
    branchName: "env/env-1",
    createdAt: "2026-03-30T00:00:00.000Z",
    ...overrides,
  };
}

function makeStoredEnvDefinition(overrides: Partial<EnvDefinition> = {}) {
  return makeEnvDefinition(overrides);
}

function makeEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "env-1",
    incarnationId: "incarnation-1",
    repoId: "123456",
    repoUrl: "https://github.com/paperwing-dev/example",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    createdAt: "2026-03-30T00:00:00.000Z",
    updatedAt: "2026-03-30T00:05:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "env-1",
      mainCommit: "main-sha",
    }),
    ...overrides,
  };
}

function makeRepoMeta(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const now = "2026-03-30T00:00:00.000Z";
  return {
    repoId: "123456",
    artifactStoreGeneration: "generation-1",
    repoUrl: "https://github.com/paperwing-dev/example",
    githubInstallationId: 98765,
    githubFullName: "paperwing-dev/example",
    ...createInitialRepoScmState(),
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

function stringifyStoredRepoMeta(meta: RepoMeta): string {
  const { repoUrl: _repoUrl, ...stored } = meta;
  return JSON.stringify(stored);
}

describe("repo store env metadata helpers", () => {
  it("routes legacy and generated repository lifecycles to distinct artifact stores", () => {
    const idFromName = vi.fn((name: string) => name);
    const env = {
      ARTIFACT_STORE: {
        idFromName,
        get: vi.fn((id: string) => ({ id })),
      },
    } as any;

    getArtifactStoreStub(env, "123456", null);
    getArtifactStoreStub(env, "123456", "generation-1");

    expect(idFromName).toHaveBeenNthCalledWith(1, "123456");
    expect(idFromName).toHaveBeenNthCalledWith(
      2,
      "123456:generation:generation-1",
    );
    expect(env.ARTIFACT_STORE.get).toHaveBeenNthCalledWith(1, "123456", {});
    expect(env.ARTIFACT_STORE.get).toHaveBeenNthCalledWith(
      2,
      "123456:generation:generation-1",
      {},
    );
  });

  it("patches GitHub default head metadata atomically and updates the repo index", async () => {
    let stored = "";
    const initial = makeRepoMeta();
    const workspace = {
      readWorkspaceFile: vi.fn().mockImplementation(async () => stored),
      writeWorkspaceFile: vi.fn().mockImplementation(async (_path: string, content: string) => {
        stored = content;
      }),
    } as any;
    stored = stringifyStoredRepoMeta(initial);
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const result = await patchRepoDefaultHeadIfCurrent({
      env,
      workspace,
      expected: repoDefaultHeadIdentityFromMeta(initial),
      next: {
        githubFullName: "paperwing-dev/renamed",
        repoUrl: "https://github.com/paperwing-dev/renamed",
        githubDefaultBranch: "trunk",
        githubDefaultBranchHeadSha: "main-new",
        gitStatus: "ready",
        gitError: null,
      },
    });

    expect(result).toMatchObject({
      changed: true,
      mainChanged: true,
      conflict: false,
      repo: {
        githubFullName: "paperwing-dev/renamed",
        repoUrl: "https://github.com/paperwing-dev/renamed",
        githubDefaultBranch: "trunk",
        githubDefaultBranchHeadSha: "main-new",
      },
    });
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "repo:123456",
      expect.stringContaining("\"repoId\":\"123456\""),
    );
  });

  it("detects no-op GitHub default head patches without changing updatedAt", async () => {
    let stored = "";
    const initial = makeRepoMeta({ updatedAt: "2026-03-30T00:00:00.000Z" });
    const workspace = {
      readWorkspaceFile: vi.fn().mockImplementation(async () => stored),
      writeWorkspaceFile: vi.fn().mockImplementation(async (_path: string, content: string) => {
        stored = content;
      }),
    } as any;
    stored = stringifyStoredRepoMeta(initial);
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const result = await patchRepoDefaultHeadIfCurrent({
      env,
      workspace,
      expected: repoDefaultHeadIdentityFromMeta(initial),
      next: repoDefaultHeadIdentityFromMeta(initial),
    });

    expect(result).toMatchObject({ changed: false, mainChanged: false, conflict: false });
    expect(workspace.writeWorkspaceFile).not.toHaveBeenCalled();
    expect(result.repo?.updatedAt).toBe("2026-03-30T00:00:00.000Z");
  });

  it("does not write stale GitHub default head metadata on CAS conflict", async () => {
    let stored = "";
    const expected = makeRepoMeta({ githubDefaultBranchHeadSha: "main-old" });
    const current = makeRepoMeta({ githubDefaultBranchHeadSha: "main-webhook" });
    const workspace = {
      readWorkspaceFile: vi.fn().mockImplementation(async () => stored),
      writeWorkspaceFile: vi.fn().mockImplementation(async (_path: string, content: string) => {
        stored = content;
      }),
    } as any;
    stored = stringifyStoredRepoMeta(current);
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;

    const result = await patchRepoDefaultHeadIfCurrent({
      env,
      workspace,
      expected: repoDefaultHeadIdentityFromMeta(expected),
      next: {
        ...repoDefaultHeadIdentityFromMeta(expected),
        githubDefaultBranchHeadSha: "main-stale-refresh",
      },
    });

    expect(result).toMatchObject({
      changed: false,
      mainChanged: false,
      conflict: true,
      repo: {
        githubDefaultBranchHeadSha: "main-webhook",
      },
    });
    expect(workspace.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("persists env definitions separately from summary cache rows", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn().mockResolvedValue(JSON.stringify(makeStoredEnvDefinition()));
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

  it("rejects projected fields in env definitions and strips repoUrl from summary cache storage", async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: { put },
    } as any;

    await expect(persistEnvDefinition(env, {
      ...makeEnvDefinition(),
      repoUrl: "https://github.com/paperwing-dev/example",
    } as EnvDefinition & { repoUrl: string })).rejects.toThrow(
      "missing immutable workload identity or execution placement",
    );
    await persistEnvSummary(env, makeEnvMeta());

    expect(put).toHaveBeenNthCalledWith(
      1,
      "env-1",
      expect.not.stringContaining("repoUrl"),
    );
    expect(JSON.parse(put.mock.calls[0][1])).not.toHaveProperty("repoUrl");
  });

  it("rejects unknown fields in env definitions", async () => {
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          ...makeEnvDefinition(),
          legacyMachineName: "old-host",
        })),
      },
    } as any;

    await expect(readEnvDefinition(env, "env-1")).rejects.toThrow(
      "missing explicit environment schema fields",
    );
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

  it("rejects repo workspace metadata that omit GitHub App selection fields", async () => {
    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(JSON.stringify({
        repoId: "repo-123",
        ...createInitialRepoScmState(),
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      })),
    } as any;

    await expect(readRepoMetaFromWorkspace(workspace)).rejects.toThrow("missing explicit repository schema fields");
  });

  it("rejects repo workspace metadata that omit gitStatus", async () => {
    const { gitStatus: _gitStatus, ...repoScmWithoutStatus } = createInitialRepoScmState();
    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(JSON.stringify({
        repoId: "repo-123",
        githubInstallationId: 98765,
        githubFullName: "paperwing-dev/example",
        ...repoScmWithoutStatus,
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      })),
    } as any;

    await expect(readRepoMetaFromWorkspace(workspace)).rejects.toThrow("missing explicit repository schema fields");
  });

  it("retains the original artifact store for pre-generation metadata", async () => {
    const { artifactStoreGeneration: _generation, repoUrl: _repoUrl, ...stored } = makeRepoMeta();
    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(JSON.stringify(stored)),
    } as any;

    await expect(readRepoMetaFromWorkspace(workspace)).resolves.toMatchObject({
      repoId: "123456",
      artifactStoreGeneration: null,
    });
  });

  it("does not repair or create repo workspaces during repoId lookup", async () => {
    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      readWorkspaceDir: vi.fn(),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
      initFromTarball: vi.fn(),
    };
    const env = {
      ENVS_KV: {
        list: vi.fn().mockResolvedValue({
          keys: [{ name: "repo:123456" }],
          list_complete: true,
          cursor: undefined,
        }),
        get: vi.fn().mockResolvedValue(JSON.stringify({
          repoId: "123456",
          repoUrl: "https://github.com/paperwing-dev/example",
          updatedAt: "2026-03-30T00:00:00.000Z",
        })),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspace),
      },
    } as any;

    const result = await listRepos(env);

    expect(result).toEqual([]);
    expect(env.WORKSPACE.idFromName).toHaveBeenCalledWith("plan-store:123456");
    expect(workspace.readWorkspaceDir).not.toHaveBeenCalled();
    expect(workspace.initFromTarball).not.toHaveBeenCalled();
    expect(workspace.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("revalidates persisted GitHub App selection during selected repo lookup", async () => {
    githubAppMocks.resolveGitHubAppRepositorySelection.mockReset();
    githubAppMocks.resolveGitHubAppRepositorySelection.mockResolvedValue({
      repositoryId: 123456,
      installationId: 98765,
      fullName: "paperwing-dev/example",
      repoUrl: "https://github.com/paperwing-dev/example",
      private: true,
      defaultBranch: "main",
    });
    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(JSON.stringify({
        repoId: "123456",
        githubInstallationId: 98765,
        githubFullName: "paperwing-dev/example",
        ...createInitialRepoScmState(),
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "main",
      })),
    };
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({
          repoId: "123456",
          repoUrl: "https://github.com/paperwing-dev/example",
          updatedAt: "2026-03-30T00:00:00.000Z",
        })),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspace),
      },
    } as any;

    await expect(getSelectedRepoWorkspaceForRepoId(env, "123456")).resolves.toMatchObject({
      meta: {
        repoId: "123456",
        githubInstallationId: 98765,
        githubFullName: "paperwing-dev/example",
      },
    });
    expect(githubAppMocks.resolveGitHubAppRepositorySelection).toHaveBeenCalledWith(env, {
      repositoryId: 123456,
      installationId: 98765,
      fullName: "paperwing-dev/example",
    });
  });

  it("persists the GitHub App selection when creating repo metadata", async () => {
    githubAppMocks.resolveGitHubAppRepositorySelection.mockReset();
    githubAppMocks.mintGitHubInstallationToken.mockReset();
    githubAppMocks.readCommitRef.mockReset();
    githubAppMocks.validateGitHubManagedTree.mockReset();
    githubAppMocks.resolveGitHubAppRepositorySelection.mockResolvedValue({
      repositoryId: 123456,
      installationId: 98765,
      fullName: "paperwing-dev/example",
      repoUrl: "https://github.com/paperwing-dev/example",
      private: true,
      defaultBranch: "main",
    });
    githubAppMocks.mintGitHubInstallationToken.mockResolvedValue({
      token: "installation-token",
      expiresAt: "2026-03-30T01:00:00.000Z",
      installationId: 98765,
      repository: "paperwing-dev/example",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
      },
    });
    githubAppMocks.readCommitRef.mockResolvedValue("main-head-sha");
    githubAppMocks.validateGitHubManagedTree.mockResolvedValue(undefined);

    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      initFromTarball: vi.fn().mockResolvedValue(undefined),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspace),
      },
    } as any;

    const result = await createRepoWorkspaceFromGitHubAppSelection(env, {
      repositoryId: 123456,
      installationId: 98765,
      fullName: "Paperwing-Dev/Example",
    });

    expect(result.meta).toMatchObject({
      repoId: "123456",
      repoUrl: "https://github.com/paperwing-dev/example",
      githubInstallationId: 98765,
      githubFullName: "paperwing-dev/example",
      githubDefaultBranch: "main",
      githubDefaultBranchHeadSha: "main-head-sha",
      mainCommit: null,
      gitArtifactId: null,
      gitStatus: "ready",
      bootstrappedFromRef: "main",
    });
    expect(result.created).toBe(true);
    expect(result.meta.artifactStoreGeneration).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(workspace.initFromTarball).not.toHaveBeenCalled();
    expect(githubAppMocks.readCommitRef).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "installation-token",
      }),
      "heads",
      "main",
    );
    expect(githubAppMocks.validateGitHubManagedTree).toHaveBeenCalledWith(
      expect.objectContaining({
        commitSha: "main-head-sha",
      }),
    );
    const [, writtenMeta] = workspace.writeWorkspaceFile.mock.calls[0];
    expect(JSON.parse(writtenMeta)).toMatchObject({
      repoId: "123456",
      githubInstallationId: 98765,
      githubFullName: "paperwing-dev/example",
    });
    expect(JSON.parse(writtenMeta)).not.toHaveProperty("repoUrl");
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "repo:123456",
      expect.stringContaining("\"repoId\":\"123456\""),
    );
    expect(env.ENVS_KV.put.mock.calls[0][1]).not.toContain("repoUrl");

    // An empty workspace represents the same GitHub repository after normal
    // deletion. Its new lifecycle must route to a different durable store.
    const recreated = await createRepoWorkspaceFromGitHubAppSelection(env, {
      repositoryId: 123456,
      installationId: 98765,
      fullName: "Paperwing-Dev/Example",
    });
    expect(recreated.meta.artifactStoreGeneration).not.toBe(
      result.meta.artifactStoreGeneration,
    );
  });

  it("does not overwrite a newer default head when refreshing existing repo selection", async () => {
    githubAppMocks.resolveGitHubAppRepositorySelection.mockReset();
    githubAppMocks.mintGitHubInstallationToken.mockReset();
    githubAppMocks.readCommitRef.mockReset();
    githubAppMocks.validateGitHubManagedTree.mockReset();
    githubAppMocks.resolveGitHubAppRepositorySelection.mockResolvedValue({
      repositoryId: 123456,
      installationId: 98765,
      fullName: "paperwing-dev/example",
      repoUrl: "https://github.com/paperwing-dev/example",
      private: true,
      defaultBranch: "main",
    });
    githubAppMocks.mintGitHubInstallationToken.mockResolvedValue({
      token: "installation-token",
      expiresAt: "2026-03-30T01:00:00.000Z",
      installationId: 98765,
      repository: "paperwing-dev/example",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
      },
    });
    githubAppMocks.readCommitRef
      .mockResolvedValueOnce("main-stale-refresh")
      .mockResolvedValueOnce("main-webhook");
    githubAppMocks.validateGitHubManagedTree.mockResolvedValue(undefined);

    const initial = makeRepoMeta({ githubDefaultBranchHeadSha: "main-old" });
    const concurrent = makeRepoMeta({ githubDefaultBranchHeadSha: "main-webhook" });
    const workspace = {
      readWorkspaceFile: vi.fn()
        .mockResolvedValueOnce(stringifyStoredRepoMeta(initial))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(concurrent))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(concurrent))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(concurrent)),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspace),
      },
    } as any;

    const result = await createRepoWorkspaceFromGitHubAppSelection(env, {
      repositoryId: 123456,
      installationId: 98765,
      fullName: "Paperwing-Dev/Example",
    });

    expect(result.created).toBe(false);
    expect(result.meta.githubDefaultBranchHeadSha).toBe("main-webhook");
    expect(githubAppMocks.readCommitRef).toHaveBeenCalledTimes(2);
    expect(workspace.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("does not report existing repo selection refresh success after a second CAS conflict", async () => {
    githubAppMocks.resolveGitHubAppRepositorySelection.mockReset();
    githubAppMocks.mintGitHubInstallationToken.mockReset();
    githubAppMocks.readCommitRef.mockReset();
    githubAppMocks.validateGitHubManagedTree.mockReset();
    githubAppMocks.resolveGitHubAppRepositorySelection.mockResolvedValue({
      repositoryId: 123456,
      installationId: 98765,
      fullName: "paperwing-dev/example",
      repoUrl: "https://github.com/paperwing-dev/example",
      private: true,
      defaultBranch: "main",
    });
    githubAppMocks.mintGitHubInstallationToken.mockResolvedValue({
      token: "installation-token",
      expiresAt: "2026-03-30T01:00:00.000Z",
      installationId: 98765,
      repository: "paperwing-dev/example",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
      },
    });
    githubAppMocks.readCommitRef
      .mockResolvedValueOnce("main-stale-refresh")
      .mockResolvedValueOnce("main-latest-refresh");
    githubAppMocks.validateGitHubManagedTree.mockResolvedValue(undefined);

    const initial = makeRepoMeta({ githubDefaultBranchHeadSha: "main-old" });
    const firstConcurrent = makeRepoMeta({ githubDefaultBranchHeadSha: "main-webhook-1" });
    const secondConcurrent = makeRepoMeta({ githubDefaultBranchHeadSha: "main-webhook-2" });
    const workspace = {
      readWorkspaceFile: vi.fn()
        .mockResolvedValueOnce(stringifyStoredRepoMeta(initial))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(firstConcurrent))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(firstConcurrent))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(secondConcurrent))
        .mockResolvedValueOnce(stringifyStoredRepoMeta(secondConcurrent)),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspace),
      },
    } as any;

    await expect(createRepoWorkspaceFromGitHubAppSelection(env, {
      repositoryId: 123456,
      installationId: 98765,
      fullName: "Paperwing-Dev/Example",
    })).rejects.toThrow("Repository metadata changed during GitHub App selection refresh.");
    expect(githubAppMocks.readCommitRef).toHaveBeenCalledTimes(2);
    expect(workspace.writeWorkspaceFile).not.toHaveBeenCalled();
  });

  it("marks GitHub repo metadata repair-required when managed paths contain unsupported metadata", async () => {
    githubAppMocks.resolveGitHubAppRepositorySelection.mockReset();
    githubAppMocks.mintGitHubInstallationToken.mockReset();
    githubAppMocks.readCommitRef.mockReset();
    githubAppMocks.validateGitHubManagedTree.mockReset();
    githubAppMocks.resolveGitHubAppRepositorySelection.mockResolvedValue({
      repositoryId: 123456,
      installationId: 98765,
      fullName: "paperwing-dev/example",
      repoUrl: "https://github.com/paperwing-dev/example",
      private: true,
      defaultBranch: "main",
    });
    githubAppMocks.mintGitHubInstallationToken.mockResolvedValue({
      token: "installation-token",
      expiresAt: "2026-03-30T01:00:00.000Z",
      installationId: 98765,
      repository: "paperwing-dev/example",
      permissions: {
        metadata: "read",
        contents: "write",
        pull_requests: "write",
      },
    });
    githubAppMocks.readCommitRef.mockResolvedValue("main-head-sha");
    githubAppMocks.validateGitHubManagedTree.mockRejectedValue(
      new UnsupportedGitHubRepoMetadataError("Repository contains unsupported metadata at linked: symlinks are not supported."),
    );

    const workspace = {
      readWorkspaceFile: vi.fn().mockResolvedValue(null),
      writeWorkspaceFile: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => workspace),
      },
    } as any;

    const result = await createRepoWorkspaceFromGitHubAppSelection(env, {
      repositoryId: 123456,
      installationId: 98765,
      fullName: "Paperwing-Dev/Example",
    });

    expect(result.meta).toMatchObject({
      githubDefaultBranchHeadSha: "main-head-sha",
      gitStatus: "repair-required",
      gitError: expect.stringContaining("unsupported metadata at linked"),
    });
  });
});
