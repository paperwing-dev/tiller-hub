import { describe, expect, it } from "vitest";
import {
  canonicalizeGitHubRepo,
  GitHubRepoParseError,
  normalizeGitHubRepoUrl,
} from "../github/repo";

describe("GitHub repo canonicalization", () => {
  it("normalizes GitHub HTTPS repository URLs", () => {
    expect(normalizeGitHubRepoUrl("https://github.com/OWNER/Repo.git/")).toBe("https://github.com/owner/repo");
    expect(canonicalizeGitHubRepo("https://github.com/Owner/repo_name.git").fullName).toBe("owner/repo_name");
  });

  it("accepts owner/repo only when explicitly allowed", () => {
    expect(canonicalizeGitHubRepo("Owner/Repo.git", { allowOwnerRepo: true }).fullName).toBe("owner/repo");
    expect(() => canonicalizeGitHubRepo("Owner/Repo.git")).toThrow(GitHubRepoParseError);
  });

  it.each([
    "http://github.com/owner/repo",
    "https://github.example.com/owner/repo",
    "https://token@github.com/owner/repo",
    "https://github.com/owner/repo?tab=readme",
    "https://github.com/owner/repo#readme",
    "https://github.com/owner/repo/pulls",
    "https://github.com/owner/repo.git/branches/main",
    "https://github.com/owner/repo/../other",
    "https://github.com/owner/%2e%2e/repo",
    "https://github.com/owner%2frepo/name",
    "https://github.com/owner/..",
    "owner/repo/extra",
  ])("rejects malformed or non-canonical repos: %s", (repoUrl) => {
    expect(() => canonicalizeGitHubRepo(repoUrl, { allowOwnerRepo: true })).toThrow(GitHubRepoParseError);
  });
});
