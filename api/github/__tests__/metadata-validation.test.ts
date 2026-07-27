import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readCommitTree: vi.fn(),
}));

vi.mock("../git-api", () => ({
  readCommitTree: mocks.readCommitTree,
}));

const {
  UnsupportedGitHubRepoMetadataError,
  validateGitHubManagedTree,
} = await import("../metadata-validation");

function gitTree(entries: Array<{ path: string; mode: string; type: string }>) {
  return {
    treeSha: "tree-sha",
    entries: new Map(entries.map((entry) => [
      entry.path,
      {
        ...entry,
        sha: `${entry.path}-sha`,
      },
    ])),
  };
}

describe("GitHub metadata validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows regular executable files in managed paths", async () => {
    mocks.readCommitTree.mockResolvedValue(gitTree([
      { path: "scripts/install.sh", mode: "100755", type: "blob" },
      { path: "src/index.ts", mode: "100644", type: "blob" },
    ]));

    await expect(validateGitHubManagedTree({
      client: { token: "token", repo: { owner: "owner", repo: "repo" } },
      commitSha: "commit-sha",
    })).resolves.toBeUndefined();
  });

  it("rejects symlinks in managed paths", async () => {
    mocks.readCommitTree.mockResolvedValue(gitTree([
      { path: "linked", mode: "120000", type: "blob" },
    ]));

    await expect(validateGitHubManagedTree({
      client: { token: "token", repo: { owner: "owner", repo: "repo" } },
      commitSha: "commit-sha",
    })).rejects.toThrow(UnsupportedGitHubRepoMetadataError);
  });

  it("ignores unsupported metadata under excluded paths", async () => {
    mocks.readCommitTree.mockResolvedValue(gitTree([
      { path: ".tiller/cache/link", mode: "120000", type: "blob" },
    ]));

    await expect(validateGitHubManagedTree({
      client: { token: "token", repo: { owner: "owner", repo: "repo" } },
      commitSha: "commit-sha",
      excludePrefixes: ["/.tiller/cache"],
    })).resolves.toBeUndefined();
  });
});
