/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepoMeta } from "../../api/types";

vi.mock("../api", () => ({
  fetchRepoMcpServers: vi.fn(async () => []),
  putRepoMcpServers: vi.fn(async () => []),
}));

vi.mock("../RepoSessionEnvSettings", () => ({ default: () => null }));
vi.mock("../Toast", () => ({ useToast: () => vi.fn() }));

import RepoSettingsPage from "../RepoSettingsPage";

describe("project removal settings", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("confirms workspace deletion without implying that GitHub is deleted", async () => {
    const onRemoveProject = vi.fn(async () => undefined);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const repo = {
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo",
      githubFullName: "example/repo",
    } as RepoMeta;

    render(
      <RepoSettingsPage
        repo={repo}
        onDone={() => undefined}
        implementationCount={2}
        onRemoveProject={onRemoveProject}
      />,
    );

    expect(screen.getByText("The GitHub repository is not deleted.", { exact: false }))
      .toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove project" }));

    expect(confirmSpy).toHaveBeenCalledWith(
      'Remove project "example/repo" from Tiller?\n\nThis will also delete 2 implementations and their saved workspaces.',
    );
    await waitFor(() => expect(onRemoveProject).toHaveBeenCalledOnce());
  });
});
