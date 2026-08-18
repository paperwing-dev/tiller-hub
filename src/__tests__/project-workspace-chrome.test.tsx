/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ setShowNewRepo: vi.fn() }));

vi.mock("../DashboardDataProvider", () => ({
  useDashboardData: () => ({
    repos: [{
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo",
      githubFullName: "example/repo",
    }],
    setShowNewRepo: mocks.setShowNewRepo,
  }),
}));

vi.mock("../WorkspaceMetadata", () => ({
  default: () => <span data-testid="workspace-metadata" />,
}));

import ProjectWorkspaceChrome from "../ProjectWorkspaceChrome";

describe("ProjectWorkspaceChrome", () => {
  afterEach(cleanup);

  it("keeps the project divider and adjacent view tabs flush", () => {
    render(
      <MemoryRouter>
        <ProjectWorkspaceChrome
          repoId="repo-1"
          activeView="plans"
          planCount={2}
          implementationCount={1}
        />
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Project views" });
    expect(nav).not.toHaveClass("-ml-px", "gap-1");
    expect(screen.getByRole("button", { name: "Plans" }).nextElementSibling)
      .toBe(screen.getByRole("button", { name: "Implementations" }));
  });

  it("shows the repository name without its owner in the project switcher", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProjectWorkspaceChrome
          repoId="repo-1"
          activeView="plans"
          planCount={0}
          implementationCount={0}
        />
      </MemoryRouter>,
    );

    const switcher = screen.getByRole("combobox", { name: "Switch project" });
    expect(switcher).toHaveTextContent("repo");
    expect(switcher).not.toHaveTextContent("example/repo");

    await user.click(switcher);
    expect(await screen.findByRole("option", { name: "repo" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "example/repo" })).not.toBeInTheDocument();
  });

  it("offers Add Project from the project switcher", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ProjectWorkspaceChrome
          repoId="repo-1"
          activeView="plans"
          planCount={0}
          implementationCount={0}
        />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("combobox", { name: "Switch project" }));
    await user.click(await screen.findByRole("option", { name: "Add project…" }));
    expect(mocks.setShowNewRepo).toHaveBeenCalledWith(true);
  });
});
