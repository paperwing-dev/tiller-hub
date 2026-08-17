import { describe, expect, it } from "vitest";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "../repo-status";

type RepoStatusDetailInput = Parameters<typeof getRepoMainStatusDetail>[0];

function detailInput(overrides: Partial<RepoStatusDetailInput>): RepoStatusDetailInput {
  const repo: RepoStatusDetailInput = {
    scmModel: "github",
    gitStatus: "pending",
    githubDefaultBranch: null,
    githubDefaultBranchHeadSha: null,
    gitError: null,
    gitProgressPhase: null,
    gitLastBootstrapDurationMs: null,
  };
  return Object.assign(repo, overrides);
}

describe("repo-status helpers", () => {
  it("treats GitHub repos as ready only when the default branch head is known", () => {
    expect(
      isRepoMainReady({
        scmModel: "github",
        gitStatus: "ready",
        githubDefaultBranchHeadSha: "abc123",
      }),
    ).toBe(true);

    expect(
      isRepoMainReady({
        scmModel: "github",
        gitStatus: "ready",
        githubDefaultBranchHeadSha: null,
      }),
    ).toBe(false);
  });

  it("describes pending GitHub updates clearly", () => {
    expect(
      getRepoMainStatusLabel({
        scmModel: "github",
        gitStatus: "pending",
        githubDefaultBranchHeadSha: null,
      }),
    ).toBe("Pulling updates from GitHub");

    expect(
      getRepoMainStatusDetail(detailInput({
        scmModel: "github",
        gitStatus: "pending",
        githubDefaultBranchHeadSha: null,
        gitProgressPhase: "Reading GitHub default branch",
      })),
    ).toContain("Reading GitHub default branch");
  });

  it("describes repair-required GitHub repos distinctly", () => {
    expect(
      getRepoMainStatusLabel({
        scmModel: "github",
        gitStatus: "repair-required",
        githubDefaultBranchHeadSha: "abc123",
      }),
    ).toBe("GitHub access needs repair");

    expect(
      getRepoMainStatusDetail(detailInput({
        scmModel: "github",
        gitStatus: "repair-required",
        githubDefaultBranchHeadSha: "abc123",
        gitError: "git clone failed",
      })),
    ).toBe("git clone failed");
  });

  it("surfaces the default branch name once GitHub is ready", () => {
    expect(
      getRepoMainStatusDetail(detailInput({
        scmModel: "github",
        gitStatus: "ready",
        githubDefaultBranch: "main",
        githubDefaultBranchHeadSha: "abc123",
      })),
    ).toContain("main");
  });
});
