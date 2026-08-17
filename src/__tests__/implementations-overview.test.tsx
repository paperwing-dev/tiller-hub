/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvMeta, RepoMeta } from "../../api/types";

const mocks = vi.hoisted(() => ({
  dashboardData: {
    repos: [] as RepoMeta[],
    envs: [] as EnvMeta[],
    setNewEnvTarget: vi.fn(),
  },
}));

vi.mock("../DashboardDataProvider", () => ({
  useDashboardData: () => mocks.dashboardData,
}));

vi.mock("../ImplementationWorkspaceFrame", () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import ImplementationsSidebar from "../ImplementationsSidebar";
import ProjectImplementationsRoute from "../dashboard-implementations-route";

function implementation(overrides: Partial<EnvMeta> = {}): EnvMeta {
  return {
    slug: "implementation-1",
    repoId: "repo-1",
    status: "running",
    backend: "cf",
    harness: "codex",
    harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    updatedAt: "2026-08-13T12:00:00.000Z",
    githubBranch: "tiller/implementation-1",
    startupPlanId: null,
    ...overrides,
  } as EnvMeta;
}

describe("implementation overview", () => {
  beforeEach(() => {
    mocks.dashboardData = { repos: [], envs: [], setNewEnvTarget: vi.fn() };
  });

  afterEach(cleanup);

  it("orders runtime, execution location, and Git branch in the hover card", () => {
    const env = implementation();
    render(
      <ImplementationsSidebar
        repoId="repo-1"
        envs={[env]}
        plan={null}
        plans={[]}
        onSelect={vi.fn()}
        onStartFresh={vi.fn()}
        onStartWithPlan={vi.fn()}
      />,
    );

    fireEvent.mouseEnter(screen.getByRole("button", {
      name: "Fresh implementation, Running",
    }));

    const rows = screen.getByTestId("implementation-hover-card")
      .querySelectorAll("[data-implementation-hover-detail]");
    expect([...rows].map((row) => row.textContent)).toEqual([
      "Codex · GPT-5.6 Sol · Extra High effort",
      "Cloudflare Containers",
      "tiller/implementation-1",
    ]);
  });

  it("renders an unread completion as a blue diamond waiting for the user", () => {
    render(
      <ImplementationsSidebar
        repoId="repo-1"
        envs={[implementation({ implementorAttentionToken: "attention-1" })]}
        plan={null}
        plans={[]}
        onSelect={vi.fn()}
        onStartFresh={vi.fn()}
        onStartWithPlan={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Fresh implementation, Waiting for you" }))
      .toBeInTheDocument();
    const updateMarker = document.querySelector('[data-implementation-update="unread"]');
    expect(updateMarker?.tagName).toBe("svg");
    expect(updateMarker).toHaveAttribute("data-implementation-card-tone", "update");
    expect(screen.getByLabelText("1 implementation is waiting for you"))
      .toHaveAttribute("data-workspace-signal", "update");
  });

  it("marks live and attention dots with their semantic card tones", () => {
    render(
      <ImplementationsSidebar
        repoId="repo-1"
        envs={[
          implementation({ slug: "live", status: "running" }),
          implementation({ slug: "failed", status: "failed" }),
        ]}
        plan={null}
        plans={[]}
        onSelect={vi.fn()}
        onStartFresh={vi.fn()}
        onStartWithPlan={vi.fn()}
      />,
    );

    expect(document.querySelector('[data-implementation-status="running"]'))
      .toHaveAttribute("data-implementation-card-tone", "live");
    expect(document.querySelector('[data-implementation-status="failed"]'))
      .toHaveAttribute("data-implementation-card-tone", "attention");
  });

  it("shows the visible needs-attention count when nothing is selected", () => {
    mocks.dashboardData = {
      repos: [{
        repoId: "repo-1",
        repoUrl: "https://github.com/example/repo",
      } as RepoMeta],
      envs: [
        implementation({ slug: "failed", status: "failed" }),
        implementation({ slug: "branch", status: "stopped", branchStatus: "needs-attention" }),
        implementation({ slug: "saved-1", status: "stopped" }),
        implementation({ slug: "saved-2", status: "stopped" }),
      ],
      setNewEnvTarget: vi.fn(),
    };

    render(
      <MemoryRouter initialEntries={["/projects/repo-1/implementations"]}>
        <Routes>
          <Route path="/projects/:repoId/implementations" element={<ProjectImplementationsRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("4 total")).toBeInTheDocument();
    expect(screen.getByText("0 running")).toBeInTheDocument();
    expect(screen.getByText("2 needs attention")).toBeInTheDocument();
    expect(document.querySelector('[data-workspace-signal="warning"]'))
      .toHaveAttribute("aria-label", "2 implementations need attention");
  });

  it("starts the first implementation from the zero-data state", () => {
    const setNewEnvTarget = vi.fn();
    mocks.dashboardData = {
      repos: [{
        repoId: "repo-1",
        repoUrl: "https://github.com/example/repo",
      } as RepoMeta],
      envs: [],
      setNewEnvTarget,
    };

    render(
      <MemoryRouter initialEntries={["/projects/repo-1/implementations"]}>
        <Routes>
          <Route path="/projects/:repoId/implementations" element={<ProjectImplementationsRoute />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText("Start your first implementation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start implementation" }));
    expect(setNewEnvTarget).toHaveBeenCalledWith({ repoId: "repo-1", planChoice: "none" });
  });
});
