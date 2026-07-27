import { describe, expect, it } from "vitest";
import { buildGitHubBranchUrl } from "../github-links";

describe("github link helpers", () => {
  it("preserves branch path slashes while encoding each segment", () => {
    expect(buildGitHubBranchUrl("test/repo", "tiller/env/demo env")).toBe(
      "https://github.com/test/repo/tree/tiller/env/demo%20env",
    );
  });
});
