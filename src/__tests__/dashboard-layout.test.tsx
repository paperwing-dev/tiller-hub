/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dashboardData: null as Record<string, unknown> | null,
  connectionsProps: null as null | {
    hubUrl: string;
    hubConnected: boolean;
    hostRefreshNonce: number;
    showHost: boolean;
  },
  updateProps: null as null | {
    status: unknown;
    issue: string | null;
    dismissed: boolean;
    isChecking: boolean;
  },
}));

vi.mock("../DashboardDataProvider", () => ({
  useDashboardData: () => mocks.dashboardData,
}));

vi.mock("../SessionList", () => ({
  default: () => <div data-testid="session-list" />,
}));

vi.mock("../ConnectionsBadge", () => ({
  default: (props: {
    hubUrl: string;
    hubConnected: boolean;
    hostRefreshNonce: number;
    showHost: boolean;
  }) => {
    mocks.connectionsProps = props;
    return null;
  },
}));

vi.mock("../UpdateBadge", () => ({
  default: (props: {
    status: unknown;
    issue: string | null;
    dismissed: boolean;
    isChecking: boolean;
  }) => {
    mocks.updateProps = props;
    return <button type="button">Update</button>;
  },
}));

import { HomeSettingsFrame, WorkspaceLayout } from "../DashboardLayout";

describe("WorkspaceLayout maintenance actions", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    mocks.updateProps = null;
    mocks.connectionsProps = null;
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
  });

  it("renders Update and Renew access independently when updates are dismissed and unavailable", async () => {
    const tokenExpiresAt = "2026-08-15T12:00:00.000Z";
    mocks.dashboardData = {
      hubUrl: "https://hub.example.com",
      repos: [{
        repoId: "repo-1",
        repoUrl: "https://github.com/example/repo",
        mainCommit: "main-sha",
        gitStatus: "ready",
      }],
      envs: [],
      sessions: [],
      sessionEnvMap: new Map(),
      setupStatus: {
        isLocalDev: false,
        protectionMode: "cf-access",
        tokenExpiresAt,
        renewalRecommended: true,
      },
      updateStatus: null,
      updateIssue: "Stable release check unavailable",
      updateDismissed: true,
      isCheckingUpdate: false,
      setShowUpdate: vi.fn(),
      connected: true,
      reconnectExhausted: false,
      hostRefreshNonce: 0,
      handleReconnect: vi.fn(),
      recoverEnv: vi.fn(),
      handleRetryRepoMain: vi.fn(),
      setStartDialogSlug: vi.fn(),
      setNewEnvTarget: vi.fn(),
    };

    render(
      <MemoryRouter initialEntries={["/projects/repo-1"]}>
        <Routes>
          <Route path="/projects/:repoId" element={<WorkspaceLayout />}>
            <Route index element={<div>Workspace</div>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Update" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Update" }).parentElement).toHaveClass("h-16", "top-0");
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute(
      "href",
      "/projects/repo-1/global-settings",
    );
    expect(mocks.updateProps).toMatchObject({
      status: null,
      issue: "Stable release check unavailable",
      dismissed: true,
      isChecking: false,
    });

    const renewalLink = screen.getByRole("link", { name: "Renew access" });
    expect(renewalLink).toHaveAttribute(
      "href",
      "https://install.paperwing.dev/maintenance?intent=renew",
    );

    fireEvent.focus(renewalLink);
    const expiration = new Intl.DateTimeFormat(undefined, { dateStyle: "long" })
      .format(new Date(tokenExpiresAt));
    expect(await screen.findByText(
      `Cloudflare Access expires ${expiration}. Renew to keep existing CLI, machine, and workload connections active. Updating Tiller also renews Access.`,
    )).toBeInTheDocument();
  });

  it("keeps renewal available before any repository exists", () => {
    mocks.dashboardData = {
      setupStatus: {
        tokenExpiresAt: "2026-08-15T12:00:00.000Z",
        renewalRecommended: true,
      },
      connected: true,
      hostRefreshNonce: 0,
    };

    render(
      <MemoryRouter>
        <HomeSettingsFrame>
          <div>Settings</div>
        </HomeSettingsFrame>
      </MemoryRouter>,
    );

    expect(screen.getByRole("link", { name: "Renew access" })).toHaveAttribute(
      "href",
      "https://install.paperwing.dev/maintenance?intent=renew",
    );
    expect(screen.getByTestId("settings-top-bar")).toHaveClass("h-16");
    expect(screen.getByRole("link", { name: "Settings" })).not.toHaveAttribute("title");
    expect(screen.getByRole("button", { name: "Tiller" })).not.toHaveAttribute("title");
  });

  it("shows machine status only after an execution machine has been added", () => {
    mocks.dashboardData = {
      hubUrl: "https://hub.example.com",
      setupStatus: {
        hostRegistered: false,
        renewalRecommended: false,
      },
      connected: true,
      hostRefreshNonce: 0,
    };

    const { rerender } = render(
      <MemoryRouter>
        <HomeSettingsFrame>
          <div>Settings</div>
        </HomeSettingsFrame>
      </MemoryRouter>,
    );

    expect(mocks.connectionsProps).toMatchObject({ showHost: false });

    mocks.dashboardData = {
      ...mocks.dashboardData,
      setupStatus: {
        hostRegistered: true,
        renewalRecommended: false,
      },
    };
    rerender(
      <MemoryRouter>
        <HomeSettingsFrame>
          <div>Settings</div>
        </HomeSettingsFrame>
      </MemoryRouter>,
    );

    expect(mocks.connectionsProps).toMatchObject({ showHost: true });
  });
});
