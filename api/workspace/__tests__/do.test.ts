import { describe, expect, it, vi } from "vitest";
import { createInitialRepoScmState } from "../../scm/model";
import { WorkspaceDO, type RepoDefaultHeadIdentity } from "../do";

function storedRepo(artifactStoreGeneration?: string) {
  return {
    repoId: "repo-1",
    ...(artifactStoreGeneration === undefined ? {} : { artifactStoreGeneration }),
    githubInstallationId: 98765,
    githubFullName: "test/repo",
    ...createInitialRepoScmState(),
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-sha",
    gitStatus: "ready" as const,
    gitError: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    bootstrappedFromRef: "main",
  };
}

function repoIdentity(): RepoDefaultHeadIdentity {
  return {
    githubFullName: "test/repo",
    repoUrl: "https://github.com/test/repo",
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-sha",
    gitStatus: "ready",
    gitError: null,
  };
}

function workspaceDoForStoredRepo(meta: ReturnType<typeof storedRepo>): WorkspaceDO {
  const subject = new WorkspaceDO({} as DurableObjectState, {} as never);
  Object.defineProperty(subject, "_workspace", {
    configurable: true,
    value: {
      readFile: vi.fn().mockResolvedValue(JSON.stringify(meta)),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  });
  return subject;
}

describe("WorkspaceDO repository metadata patches", () => {
  it.each([
    ["preserves a repository lifecycle generation", "generation-1", "generation-1"],
    ["normalizes pre-generation repository metadata", undefined, null],
  ])("%s", async (_label, storedGeneration, expectedGeneration) => {
    const subject = workspaceDoForStoredRepo(storedRepo(storedGeneration));
    const identity = repoIdentity();

    const result = await subject.patchRepoDefaultHeadIfCurrent({
      expected: identity,
      next: identity,
    });

    expect(result).toMatchObject({
      changed: false,
      mainChanged: false,
      conflict: false,
      repo: {
        repoId: "repo-1",
        artifactStoreGeneration: expectedGeneration,
      },
    });
  });
});
