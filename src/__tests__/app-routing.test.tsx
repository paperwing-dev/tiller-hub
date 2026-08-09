/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryRouter } from "react-router";
import { RouterProvider } from "react-router/dom";
import type { EnvMeta, RepoMeta, UpdateCheckResult } from "../api";
import { createInitialEnvScmState, createInitialRepoScmState } from "../../api/scm/model";
import type { StoredSession } from "../../api/types";

const apiMocks = vi.hoisted(() => ({
  fetchSessions: vi.fn(),
  fetchMessages: vi.fn(),
  fetchPendingPermissions: vi.fn(),
  createReconnectingWebSocket: vi.fn(),
  fetchSetupStatus: vi.fn(),
  createEnv: vi.fn(),
  createRepo: vi.fn(),
  checkForUpdate: vi.fn(),
  fetchEnvs: vi.fn(),
  fetchRepos: vi.fn(),
  fetchEnv: vi.fn(),
  fetchRepo: vi.fn(),
  updateButtonOnOpen: null as (() => void) | null,
  wsHandlers: null as null | {
    onEnvRemove?: (slug: string) => void;
  },
}));

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

vi.mock("../SessionList", () => ({
  default: () => <div data-testid="session-list" />,
}));

vi.mock("../SessionView", () => ({
  default: () => <div data-testid="session-view" />,
}));

vi.mock("../EnvWaitingView", () => ({
  default: () => <div data-testid="env-waiting-view" />,
}));

vi.mock("../PlanView", () => ({
  default: () => <div data-testid="plan-view" />,
}));

vi.mock("../ShipView", () => ({
  default: () => <div data-testid="ship-view" />,
}));

vi.mock("../NewEnvDialog", () => ({
  NewRepoDialog: () => null,
  NewEnvDialog: () => null,
}));

vi.mock("../StartPlanDialog", () => ({
  default: () => null,
}));

vi.mock("../SettingsPage", () => ({
  default: () => <div data-testid="settings-page" />,
  parseAuthConnectIntent: () => null,
}));

vi.mock("../RepoSettingsPage", () => ({
  default: () => <div data-testid="repo-settings-page" />,
}));

vi.mock("../SetupWizard", () => ({
  default: () => <div data-testid="setup-wizard" />,
}));

vi.mock("../UpdateBadge", () => ({
  default: ({ onOpen }: { onOpen: () => void }) => {
    apiMocks.updateButtonOnOpen = onOpen;
    return <button data-testid="update-button" type="button">Update</button>;
  },
}));

vi.mock("../UpdateDialog", () => ({
  default: () => <div data-testid="update-dialog" />,
}));

vi.mock("../ConnectionsBadge", () => ({
  default: () => null,
}));

vi.mock("../api", () => ({
  ApiAuthenticationError: class ApiAuthenticationError extends Error {
    constructor(message = "Browser authentication is required.") {
      super(message);
      this.name = "ApiAuthenticationError";
    }
  },
  isApiAuthenticationError: (error: unknown) => (
    error instanceof Error && error.name === "ApiAuthenticationError"
  ),
  ApiActionError: class ApiActionError extends Error {
    readonly code?: string;
    readonly hint?: string;
    readonly missingPermissions: string[];

    constructor(
      body: { error?: string; code?: string; hint?: string; missingPermissions?: string[] },
      fallback: string,
    ) {
      super(body.error || fallback);
      this.name = "ApiActionError";
      this.code = body.code;
      this.hint = body.hint;
      this.missingPermissions = Array.isArray(body.missingPermissions) ? body.missingPermissions : [];
    }
  },
  fetchSessions: apiMocks.fetchSessions,
  fetchMessages: apiMocks.fetchMessages,
  fetchPendingPermissions: apiMocks.fetchPendingPermissions,
  createReconnectingWebSocket: apiMocks.createReconnectingWebSocket,
  fetchSetupStatus: apiMocks.fetchSetupStatus,
  createEnv: apiMocks.createEnv,
  createRepo: apiMocks.createRepo,
  checkForUpdate: apiMocks.checkForUpdate,
  fetchEnvs: apiMocks.fetchEnvs,
  fetchRepos: apiMocks.fetchRepos,
  fetchEnv: apiMocks.fetchEnv,
  fetchRepo: apiMocks.fetchRepo,
}));

const now = "2026-06-14T00:00:00.000Z";

function repoFixture(overrides: Partial<RepoMeta> = {}): RepoMeta {
  const repo: RepoMeta = {
    repoId: "repo-1",
    artifactStoreGeneration: null,
    repoUrl: "https://github.com/example/repo-1",
    githubInstallationId: 123,
    githubFullName: "example/repo-1",
    ...createInitialRepoScmState(),
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-sha",
    githubWebhookConfigured: true,
    mainCommit: "main-sha",
    gitArtifactId: "git-artifact-1",
    gitStatus: "ready",
    gitError: null,
    gitFormatVersion: 1,
    gitProgressPhase: null,
    gitProgressStartedAt: null,
    gitProgressUpdatedAt: null,
    gitLastBootstrapDurationMs: null,
    gitLastBootstrapTimings: null,
    createdAt: now,
    updatedAt: now,
    bootstrappedFromRef: "main",
    githubPublish: null,
  };
  return Object.assign(repo, overrides);
}

function envFixture(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const env: EnvMeta = {
    slug: "env-1",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/example/repo-1",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "codex",
    harnessSettings: null,
    createdAt: now,
    updatedAt: now,
    status: "running",
    ...createInitialEnvScmState({ slug: "env-1", branchName: "env-1" }),
  };
  return Object.assign(env, overrides);
}

function sessionFixture(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    tag: "env-1",
    machine_id: null,
    metadata: JSON.stringify({ envSlug: "env-1", role: "lead" }),
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 0,
    ended_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function updateStatus(): UpdateCheckResult {
  const currentUpdate: UpdateCheckResult["currentUpdate"] = {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId: "current-source",
    version: "0.2.36",
    label: "Current",
    managedFiles: ["package.json"],
  };
  return {
    kind: "legacy",
    updateAvailable: false,
    currentUpdate,
    latestUpdate: currentUpdate,
    buildDiagnostics: {
      channel: "release",
      version: "0.2.36",
      workersCiCommitSha: null,
      workersCiBranch: null,
    },
    hubRepo: { status: "not_checked", lastDetectedAt: null },
    updateMethod: "github_repo",
    releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub",
  };
}

async function renderDashboardAt(path: string) {
  const { dashboardRoutes } = await import("../App");
  const router = createMemoryRouter(dashboardRoutes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe("dashboard route guards", () => {
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
    apiMocks.fetchSessions.mockResolvedValue([sessionFixture()]);
    apiMocks.updateButtonOnOpen = null;
    apiMocks.fetchMessages.mockResolvedValue([]);
    apiMocks.fetchPendingPermissions.mockResolvedValue([]);
    apiMocks.wsHandlers = null;
    apiMocks.createReconnectingWebSocket.mockImplementation((_hubUrl, handlers) => {
      apiMocks.wsHandlers = handlers;
      return {
      close() {},
      send() { return true; },
      reconnect() {},
      };
    });
    apiMocks.fetchSetupStatus.mockResolvedValue({
      needsSetup: false,
      isLocalDev: false,
      protectionMode: "cf-access",
    });
    apiMocks.checkForUpdate.mockResolvedValue(updateStatus());
    apiMocks.fetchEnvs.mockResolvedValue([envFixture()]);
    apiMocks.fetchRepos.mockResolvedValue([repoFixture()]);
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
    vi.resetAllMocks();
    vi.resetModules();
  });

  it("does not promote a running environment Ship route to its live session", async () => {
    const router = await renderDashboardAt("/envs/env-1/ship");

    await waitFor(() => {
      expect(screen.getByTestId("ship-view")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("session-view")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/envs/env-1/ship");
  });

  it("redirects the legacy changes route to Ship", async () => {
    const router = await renderDashboardAt("/envs/env-1/changes");

    await waitFor(() => {
      expect(screen.getByTestId("ship-view")).toBeInTheDocument();
      expect(router.state.location.pathname).toBe("/envs/env-1/ship");
    });
  });

  it("promotes only the exact running environment route to its live session", async () => {
    const router = await renderDashboardAt("/envs/env-1");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/sessions/session-1");
      expect(screen.getByTestId("session-view")).toBeInTheDocument();
    });
  });

  it("does not promote an explicitly non-lead attached session", async () => {
    apiMocks.fetchSessions.mockResolvedValue([
      sessionFixture({ metadata: JSON.stringify({ envSlug: "env-1", role: "worker" }) }),
    ]);
    const router = await renderDashboardAt("/envs/env-1");

    await waitFor(() => expect(router.state.location.pathname).toBe("/envs/env-1"));
    expect(screen.queryByTestId("session-view")).not.toBeInTheDocument();
  });

  it("waits for the live session before showing a running environment route", async () => {
    let resolveSessions!: (sessions: StoredSession[]) => void;
    apiMocks.fetchSessions.mockReturnValue(new Promise<StoredSession[]>((resolve) => {
      resolveSessions = resolve;
    }));

    const router = await renderDashboardAt("/envs/env-1");

    expect(await screen.findByRole("status", { name: "Loading workspace" })).toBeInTheDocument();
    expect(screen.queryByTestId("env-waiting-view")).not.toBeInTheDocument();

    act(() => {
      resolveSessions([sessionFixture()]);
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/sessions/session-1");
      expect(screen.getByTestId("session-view")).toBeInTheDocument();
    });
  });

  it("renders a repo load failure for environment workspace routes instead of hanging", async () => {
    apiMocks.fetchRepos.mockRejectedValue(new Error("repo fetch failed"));
    const router = await renderDashboardAt("/envs/env-1/ship");

    expect(await screen.findByText("Repository load failed")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/envs/env-1/ship");
  });

  it("renders a repo load failure for session workspace routes instead of hanging", async () => {
    apiMocks.fetchRepos.mockRejectedValue(new Error("repo fetch failed"));
    const router = await renderDashboardAt("/sessions/session-1");

    expect(await screen.findByText("Repository load failed")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/sessions/session-1");
  });

  it("renders setup status failures explicitly instead of inventing setup data", async () => {
    apiMocks.fetchSetupStatus.mockRejectedValue(new Error("setup fetch failed"));
    await renderDashboardAt("/");

    expect(await screen.findByText("Setup status load failed")).toBeInTheDocument();
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchEnvs).not.toHaveBeenCalled();
    expect(apiMocks.fetchRepos).not.toHaveBeenCalled();
  });

  it("does not check for updates while required setup is incomplete", async () => {
    apiMocks.fetchSetupStatus.mockResolvedValue({
      needsSetup: true,
      isLocalDev: false,
      protectionMode: "public",
    });

    await renderDashboardAt("/");

    expect(await screen.findByTestId("setup-wizard")).toBeInTheDocument();
    expect(apiMocks.checkForUpdate).not.toHaveBeenCalled();
    expect(apiMocks.fetchSessions).not.toHaveBeenCalled();
    expect(apiMocks.fetchEnvs).not.toHaveBeenCalled();
    expect(apiMocks.fetchRepos).not.toHaveBeenCalled();
  });

  it("renders project global settings inside the workspace shell", async () => {
    const router = await renderDashboardAt("/projects/repo-1/global-settings");

    await waitFor(() => {
      expect(screen.getByTestId("settings-page")).toBeInTheDocument();
      expect(screen.getByTestId("session-list")).toBeInTheDocument();
      expect(screen.getAllByTestId("update-button")).toHaveLength(1);
    });
    expect(router.state.location.pathname).toBe("/projects/repo-1/global-settings");
  });

  it("opens update maintenance as a modal without leaving the workspace route", async () => {
    const router = await renderDashboardAt("/projects/repo-1");

    await screen.findByTestId("update-button");
    act(() => {
      apiMocks.updateButtonOnOpen?.();
    });

    expect(await screen.findByTestId("update-dialog")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/repo-1");
    expect(screen.getByTestId("session-list")).toBeInTheDocument();
  });

  it("keeps the direct update URL as a modal compatibility route", async () => {
    const router = await renderDashboardAt("/update");

    expect(await screen.findByTestId("update-dialog")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/update");
    expect(screen.queryByTestId("session-list")).not.toBeInTheDocument();
  });

  it("returns to the repo workspace when the selected environment is deleted", async () => {
    const router = await renderDashboardAt("/envs/env-1/ship");

    await waitFor(() => {
      expect(screen.getByTestId("ship-view")).toBeInTheDocument();
      expect(apiMocks.wsHandlers).not.toBeNull();
    });

    act(() => {
      apiMocks.wsHandlers?.onEnvRemove?.("env-1");
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/repo-1");
      expect(screen.getByTestId("session-list")).toBeInTheDocument();
    });
  });

  it("renders home global settings without the workspace shell or extra update action", async () => {
    const router = await renderDashboardAt("/settings");

    expect(await screen.findByTestId("settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("session-list")).not.toBeInTheDocument();
    expect(screen.queryByTestId("update-button")).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
  });
});
