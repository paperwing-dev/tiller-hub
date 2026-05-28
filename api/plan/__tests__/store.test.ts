import { describe, expect, it, vi } from "vitest";
import type { EnvDefinition } from "../../types";
import { createInitialRepoScmState } from "../../scm/model";
import {
  commitRepoMainState,
  createRepoWorkspaceFromGitHubAppSelection,
  getSelectedRepoWorkspaceForRepoId,
  listEnvDefinitionSlugs,
  listRepos,
  persistEnvDefinition,
  readEnvDefinition,
  readRepoMetaFromWorkspace,
} from "../store";

const githubAppMocks = vi.hoisted(() => ({
  mintGitHubInstallationToken: vi.fn(),
  resolveGitHubAppRepositorySelection: vi.fn(),
}));

vi.mock("../../github/app", async () => {
  const actual = await vi.importActual<typeof import("../../github/app")>("../../github/app");
  return {
    ...actual,
    mintGitHubInstallationToken: githubAppMocks.mintGitHubInstallationToken,
    resolveGitHubAppRepositorySelection: githubAppMocks.resolveGitHubAppRepositorySelection,
  };
});

function makeEnvDefinition(overrides: Partial<EnvDefinition> = {}): EnvDefinition {
  return {
    slug: "env-1",
    repoId: "123456",
    backend: "cf",
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

describe("repo store env metadata helpers", () => {
  it("persists canonical main commit updates to repo metadata", async () => {
    const writeWorkspaceFile = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: {
        put: vi.fn().mockResolvedValue(undefined),
      },
    } as any;
    const workspace = {
      writeWorkspaceFile,
    } as any;

    const nextMeta = await commitRepoMainState({
      env,
      workspace,
      meta: {
        repoId: "repo-123",
        repoUrl: "https://github.com/paperwing-dev/example",
        githubInstallationId: 98765,
        githubFullName: "paperwing-dev/example",
        ...createInitialRepoScmState(),
        mainCommit: "abc123",
        gitArtifactId: "g-old",
        gitStatus: "ready",
        createdAt: "2026-03-30T00:00:00.000Z",
        updatedAt: "2026-03-30T00:00:00.000Z",
        bootstrappedFromRef: "HEAD",
      },
      mainCommit: "def456",
      sourceEnvSlug: "env-1",
    });

    expect(nextMeta).toMatchObject({
      repoId: "repo-123",
      mainCommit: "def456",
      lastCommittedFromEnvSlug: "env-1",
    });
    expect(writeWorkspaceFile).toHaveBeenCalledWith(
      "/.tiller/repo/meta.json",
      expect.stringContaining("\"mainCommit\": \"def456\""),
    );
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "repo:repo-123",
      expect.stringContaining("\"repoId\":\"repo-123\""),
    );
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
      bootstrappedFromRef: "main",
    });
    expect(result.created).toBe(true);
    expect(workspace.initFromTarball).toHaveBeenCalledWith(
      "https://api.github.com/repos/paperwing-dev/example/tarball/main",
      expect.objectContaining({ Authorization: "Bearer installation-token" }),
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
  });
});
