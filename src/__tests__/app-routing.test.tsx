/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  fetchRepoArtifacts: vi.fn(),
  stopEnv: vi.fn(),
  deleteEnv: vi.fn(),
  deleteRepo: vi.fn(),
  addToast: vi.fn(),
  updateButtonOnOpen: null as (() => void) | null,
  wsHandlers: null as null | {
    onEnvRemove?: (slug: string) => void;
    onRepoMainChanged?: (
      repoId: string,
      repoUrl: string,
      previousMainCommit: string | null,
      currentMainCommit: string | null,
      sourceEnvSlug?: string | null,
    ) => void;
  },
}));

vi.mock("../Toast", () => ({
  useToast: () => apiMocks.addToast,
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
  NewRepoDialog: () => <div data-testid="new-repo-dialog" />,
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
  default: ({
    onDismiss,
    onIgnore,
    onCheckNow,
  }: {
    onDismiss: () => void;
    onIgnore: () => void;
    onCheckNow: () => void;
  }) => (
    <div data-testid="update-dialog">
      <button type="button" data-testid="dismiss-update" onClick={onDismiss}>
        Dismiss
      </button>
      <button type="button" data-testid="ignore-update" onClick={onIgnore}>
        Ignore until next update
      </button>
      <button type="button" data-testid="check-update-now" onClick={onCheckNow}>
        Check now
      </button>
    </div>
  ),
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
  fetchRepoArtifacts: apiMocks.fetchRepoArtifacts,
  stopEnv: apiMocks.stopEnv,
  deleteEnv: apiMocks.deleteEnv,
  deleteRepo: apiMocks.deleteRepo,
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
  const currentRelease: UpdateCheckResult["currentRelease"] = {
    schemaVersion: 1,
    channel: "release",
    hubVersion: "0.2.54",
    releaseId: "a".repeat(40),
  };
  return {
    kind: "installer-managed",
    updateAvailable: false,
    currentRelease,
    stableRelease: {
      releaseId: "a".repeat(40),
      version: "0.2.54",
      releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub/releases/tag/tiller-hub-v0.2.54",
    },
    buildDiagnostics: {
      channel: "release",
      version: "0.2.54",
      workersCiCommitSha: null,
      workersCiBranch: null,
    },
    errors: [],
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
    window.localStorage.clear();
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
    apiMocks.fetchRepoArtifacts.mockResolvedValue({ artifacts: [] });
    apiMocks.stopEnv.mockResolvedValue({ status: "saving" });
    apiMocks.deleteEnv.mockResolvedValue(undefined);
    apiMocks.deleteRepo.mockResolvedValue({ ok: true, repoId: "repo-1", deletedEnvSlugs: [] });
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

  it("opens the last valid project Plan workspace from the root route", async () => {
    apiMocks.fetchRepos.mockResolvedValue([
      repoFixture(),
      repoFixture({ repoId: "repo-2", githubFullName: "example/repo-2" }),
    ]);
    window.localStorage.setItem("tiller:last-project", "repo-2");

    const router = await renderDashboardAt("/");

    await waitFor(() => expect(router.state.location.pathname).toBe("/projects/repo-2/plan"));
    expect(await screen.findByTestId("plan-view")).toBeInTheDocument();
  });

  it("shows the workspace shell and Add Project action when no repositories exist", async () => {
    apiMocks.fetchSessions.mockResolvedValue([]);
    apiMocks.fetchEnvs.mockResolvedValue([]);
    apiMocks.fetchRepos.mockResolvedValue([]);

    const router = await renderDashboardAt("/");

    expect(await screen.findByText("Add a GitHub repository to get started")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
    fireEvent.click(screen.getByRole("button", { name: "Add project" }));
    expect(await screen.findByTestId("new-repo-dialog")).toBeInTheDocument();
  });

  it("keeps plan attention visible while viewing implementations", async () => {
    apiMocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [{
        id: "plan-1",
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-sha" },
        title: "Waiting plan",
        body: { markdown: "# Waiting plan" },
        status: "todo",
        createdAt: now,
        updatedAt: now,
        version: 1,
      }],
      refs: [],
      attention: [{
        planArtifactId: "plan-1",
        sourceKind: "scribe",
        sourceId: "scribe-1",
        token: "attention-1",
      }],
    });

    await renderDashboardAt("/projects/repo-1/implementations");

    const plansTab = await screen.findByRole("button", { name: /Plans/ });
    await waitFor(() => expect(within(plansTab).getByLabelText("1 plan has new updates"))
      .toHaveAttribute("data-workspace-signal", "update"));
  });

  it("shows implementor completion as an update on the Implementations tab", async () => {
    apiMocks.fetchEnvs.mockResolvedValue([
      envFixture({ implementorAttentionToken: "attention-1" }),
    ]);

    await renderDashboardAt("/projects/repo-1/implementations");

    const implementationsTab = await screen.findByRole("button", { name: /Implementations/ });
    await waitFor(() => expect(within(implementationsTab).getByLabelText("1 implementation is waiting for you"))
      .toHaveAttribute("data-workspace-signal", "update"));
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

  it("promotes a starting environment route once its lead session exists", async () => {
    apiMocks.fetchEnvs.mockResolvedValue([envFixture({ status: "starting" })]);
    const router = await renderDashboardAt("/envs/env-1");

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/sessions/session-1");
      expect(screen.getByTestId("session-view")).toBeInTheDocument();
    });
  });

  it("uses the plan title and wires the existing Stop action", async () => {
    const planTitle = "A deliberately long implementation plan title that truncates cleanly";
    apiMocks.fetchEnvs.mockResolvedValue([envFixture({
      startupPlanId: "plan-1",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    })]);
    apiMocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [{
        id: "plan-1",
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-sha" },
        title: planTitle,
        body: { markdown: `# ${planTitle}` },
        status: "todo",
        createdAt: now,
        updatedAt: now,
        version: 1,
      }],
    });
    const router = await renderDashboardAt("/envs/env-1");
    const header = await screen.findByTestId("implementation-workspace-header");

    await waitFor(() => expect(within(header).getByText(planTitle)).toBeInTheDocument());
    expect(header).not.toHaveTextContent("env-1");

    fireEvent.click(within(header).getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(apiMocks.stopEnv).toHaveBeenCalledWith(
      "http://localhost:3000",
      "env-1",
    ));
  });

  it("opens the existing Ship route from the implementation header", async () => {
    apiMocks.fetchEnvs.mockResolvedValue([envFixture({
      status: "stopped",
      startupPlanId: "plan-1",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    })]);
    apiMocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [{
        id: "plan-1",
        repoId: "repo-1",
        type: "plan",
        basis: { repoId: "repo-1", mainCommit: "main-sha" },
        title: "Ship-ready plan",
        body: { markdown: "# Ship-ready plan" },
        status: "todo",
        createdAt: now,
        updatedAt: now,
        version: 1,
      }],
    });
    const router = await renderDashboardAt("/envs/env-1");
    const header = await screen.findByTestId("implementation-workspace-header");

    fireEvent.click(within(header).getByRole("button", { name: "Ship" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/envs/env-1/ship");
      expect(screen.queryByTestId("implementation-workspace-header")).not.toBeInTheDocument();
      expect(screen.getByTestId("ship-view")).toBeInTheDocument();
    });
  });

  it("requires a running implementation to be stopped before shipping", async () => {
    apiMocks.fetchEnvs.mockResolvedValue([envFixture({
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    })]);
    await renderDashboardAt("/envs/env-1");
    const header = await screen.findByTestId("implementation-workspace-header");
    const shipButton = within(header).getByRole("button", { name: "Ship" });
    const tooltipTrigger = shipButton.parentElement;

    expect(shipButton).toBeDisabled();
    expect(shipButton).not.toHaveAttribute("title");
    expect(tooltipTrigger).toHaveAttribute(
      "aria-label",
      "Stop this environment before shipping.",
    );

    fireEvent.click(shipButton);
    expect(screen.queryByTestId("ship-view")).not.toBeInTheDocument();

    fireEvent.focus(tooltipTrigger!);
    expect(await screen.findByText("Stop this environment before shipping.")).toBeInTheDocument();
  });

  it("deletes a stopped implementation from the implementation header after confirmation", async () => {
    apiMocks.fetchEnvs.mockResolvedValue([envFixture({
      status: "stopped",
      displayName: "Saved implementation",
      workspaceDirty: true,
      branchStatus: "ready-to-merge",
    })]);
    const router = await renderDashboardAt("/envs/env-1");
    const header = await screen.findByTestId("implementation-workspace-header");
    const shipButton = within(header).getByRole("button", { name: "Ship" });
    const deleteButton = within(header).getByRole("button", { name: "Delete" });

    expect(shipButton.parentElement?.nextElementSibling).toBe(deleteButton);
    fireEvent.click(deleteButton);

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Delete implementation?")).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      '"Saved implementation" and its container and R2 storage will be permanently deleted.',
    );
    expect(dialog).not.toHaveTextContent("slug:");
    expect(apiMocks.deleteEnv).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete implementation" }));

    await waitFor(() => expect(apiMocks.deleteEnv).toHaveBeenCalledWith(
      "http://localhost:3000",
      "env-1",
    ));
    await waitFor(() => expect(within(header).getByText("Deleting")).toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/envs/env-1");

    act(() => {
      apiMocks.wsHandlers?.onEnvRemove?.("env-1");
    });
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/repo-1/implementations");
      expect(screen.getByText("Start your first implementation")).toBeInTheDocument();
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

  it("keeps startup progress visible while waiting for the live session", async () => {
    apiMocks.fetchSessions.mockResolvedValue([]);

    const router = await renderDashboardAt("/envs/env-1");

    expect(await screen.findByTestId("env-waiting-view")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/envs/env-1");
    expect(screen.queryByTestId("session-view")).not.toBeInTheDocument();
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
      expect(screen.getByTestId("workspace-settings-view")).toBeInTheDocument();
      expect(screen.queryByTestId("session-list")).not.toBeInTheDocument();
      expect(screen.getAllByTestId("update-button")).toHaveLength(1);
    });
    expect(router.state.location.pathname).toBe("/projects/repo-1/global-settings");
  });

  it("returns from workspace settings to the screen that opened them", async () => {
    const router = await renderDashboardAt("/sessions/session-1");
    expect(await screen.findByTestId("session-view")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: "Settings" }));
    await waitFor(() => expect(router.state.location.pathname)
      .toBe("/projects/repo-1/global-settings"));

    fireEvent.click(await screen.findByRole("button", { name: "Done" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/sessions/session-1"));
    expect(await screen.findByTestId("session-view")).toBeInTheDocument();
  });

  it("opens update maintenance as a modal without leaving the workspace route", async () => {
    const router = await renderDashboardAt("/projects/repo-1");

    await screen.findByTestId("update-button");
    act(() => {
      apiMocks.updateButtonOnOpen?.();
    });

    expect(await screen.findByTestId("update-dialog")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/repo-1");
    expect(screen.getByTestId("plan-view")).toBeInTheDocument();
  });

  it("bypasses the update cache when Check now is selected", async () => {
    await renderDashboardAt("/projects/repo-1");

    await screen.findByTestId("update-button");
    act(() => {
      apiMocks.updateButtonOnOpen?.();
    });
    const checkNow = await screen.findByTestId("check-update-now");
    act(() => {
      checkNow.click();
    });

    await waitFor(() => {
      expect(apiMocks.checkForUpdate).toHaveBeenLastCalledWith(
        expect.any(String),
        { forceRefresh: true },
      );
    });
  });

  it("closes on dismiss but persists ignore only for the current update", async () => {
    await renderDashboardAt("/projects/repo-1");

    await screen.findByTestId("update-button");
    act(() => {
      apiMocks.updateButtonOnOpen?.();
    });
    const dismiss = await screen.findByTestId("dismiss-update");
    act(() => {
      dismiss.click();
    });
    expect(window.localStorage.getItem(`tiller:update-dismissed:${"a".repeat(40)}`))
      .toBeNull();

    act(() => {
      apiMocks.updateButtonOnOpen?.();
    });
    const ignore = await screen.findByTestId("ignore-update");
    act(() => {
      ignore.click();
    });
    expect(window.localStorage.getItem(`tiller:update-dismissed:${"a".repeat(40)}`))
      .toBe("true");
    expect(window.localStorage.getItem(`tiller:update-dismissed:${"b".repeat(40)}`))
      .toBeNull();
  });

  it("keeps the direct update URL as a modal compatibility route", async () => {
    const router = await renderDashboardAt("/update");

    expect(await screen.findByTestId("update-dialog")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/projects/repo-1/plan");
    expect(screen.queryByTestId("session-list")).not.toBeInTheDocument();
  });

  it("returns to the implementations workspace when the selected environment is deleted", async () => {
    const router = await renderDashboardAt("/envs/env-1/ship");

    await waitFor(() => {
      expect(screen.getByTestId("ship-view")).toBeInTheDocument();
      expect(apiMocks.wsHandlers).not.toBeNull();
    });

    act(() => {
      apiMocks.wsHandlers?.onEnvRemove?.("env-1");
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/projects/repo-1/implementations");
      expect(screen.getByText("Start your first implementation")).toBeInTheDocument();
      expect(screen.queryByTestId("plan-view")).not.toBeInTheDocument();
    });
  });

  it("shows a temporary generic toast when GitHub repository changes arrive", async () => {
    await renderDashboardAt("/projects/repo-1");

    await waitFor(() => {
      expect(apiMocks.wsHandlers).not.toBeNull();
    });

    act(() => {
      apiMocks.wsHandlers?.onRepoMainChanged?.(
        "repo-1",
        "https://github.com/example/repo-1",
        "old-sha",
        "new-sha",
        null,
      );
    });

    expect(apiMocks.addToast).toHaveBeenCalledWith({
      title: "Repository updated",
      body: "Tiller merged new changes from GitHub.",
      variant: "info",
      duration: 5000,
    });
  });

  it("shows a temporary generic toast when GitHub repository changes arrive", async () => {
    await renderDashboardAt("/projects/repo-1");

    await waitFor(() => {
      expect(apiMocks.wsHandlers).not.toBeNull();
    });

    act(() => {
      apiMocks.wsHandlers?.onRepoMainChanged?.(
        "repo-1",
        "https://github.com/example/repo-1",
        "old-sha",
        "new-sha",
        null,
      );
    });

    expect(apiMocks.addToast).toHaveBeenCalledWith({
      title: "Repository updated",
      body: "Tiller merged new changes from GitHub.",
      variant: "info",
      duration: 5000,
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
