import { describe, expect, it } from "vitest";
import { ApiActionError } from "../api";
import { formatGitHubRepositoryError } from "../useGitHubRepositories";

describe("formatGitHubRepositoryError", () => {
  it("explains that a GitHub rate limit is temporary and reinstalling will not help", () => {
    const message = formatGitHubRepositoryError(new ApiActionError({
      code: "github_app_repository_list_failed",
      error: "API rate limit exceeded for installation ID 123.",
    }, "GitHub repositories could not be loaded."));

    expect(message).toContain("temporarily exhausted");
    expect(message).toContain("reinstalling the App will not help");
  });
});
