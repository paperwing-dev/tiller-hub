import { describe, expect, it } from "vitest";
import { getRepoMainStatusDetail, getRepoMainStatusLabel, isRepoMainReady } from "../repo-status";

describe("repo-status helpers", () => {
  it("treats ready repos as ready only when all main git fields exist", () => {
    expect(
      isRepoMainReady({
        gitStatus: "ready",
        gitArtifactId: "g-current",
        mainCommit: "abc123",
      }),
    ).toBe(true);

    expect(
      isRepoMainReady({
        gitStatus: "ready",
        gitArtifactId: null,
        mainCommit: "abc123",
      }),
    ).toBe(false);
  });

  it("describes pending repo bootstrap clearly", () => {
    expect(
      getRepoMainStatusLabel({
        gitStatus: "pending",
        gitArtifactId: null,
        mainCommit: null,
      }),
    ).toBe("Preparing main");

    expect(
      getRepoMainStatusDetail({
        gitStatus: "pending",
        gitArtifactId: null,
        mainCommit: null,
        gitProgressPhase: "Cloning canonical main",
      }),
    ).toContain("Cloning canonical main");
  });

  it("describes repair-required repos distinctly", () => {
    expect(
      getRepoMainStatusLabel({
        gitStatus: "repair-required",
        gitArtifactId: "g-bad",
        mainCommit: "abc123",
      }),
    ).toBe("Main needs repair");

    expect(
      getRepoMainStatusDetail({
        gitStatus: "repair-required",
        gitArtifactId: "g-bad",
        mainCommit: "abc123",
        gitError: "git clone failed",
      }),
    ).toBe("git clone failed");
  });

  it("surfaces bootstrap timing once canonical main is ready", () => {
    expect(
      getRepoMainStatusDetail({
        gitStatus: "ready",
        gitArtifactId: "g-current",
        mainCommit: "abc123",
        gitLastBootstrapDurationMs: 1425,
      }),
    ).toContain("1.4s");
  });
});
