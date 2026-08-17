/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  LAST_PROJECT_STORAGE_KEY,
  rememberLastProjectId,
  resolveLastProjectId,
} from "../project-selection-storage";

describe("last project selection", () => {
  beforeEach(() => window.localStorage.clear());

  it("restores a valid remembered project", () => {
    rememberLastProjectId("repo-2");
    expect(resolveLastProjectId(["repo-1", "repo-2"])).toBe("repo-2");
  });

  it("falls back to the first project when the remembered project is stale", () => {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, "deleted-repo");
    expect(resolveLastProjectId(["repo-1", "repo-2"])).toBe("repo-1");
  });

  it("returns null when there are no projects", () => {
    expect(resolveLastProjectId([])).toBeNull();
  });
});
