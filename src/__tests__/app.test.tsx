import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

vi.mock("../SessionList", () => ({
  default: () => null,
}));

vi.mock("../SessionView", () => ({
  default: () => null,
}));

vi.mock("../EnvWaitingView", () => ({
  default: () => null,
}));

vi.mock("../PlanView", () => ({
  default: () => null,
}));

vi.mock("../ChangesView", () => ({
  default: () => null,
}));

vi.mock("../NewEnvDialog", () => ({
  NewRepoDialog: () => null,
  NewEnvDialog: () => null,
}));

vi.mock("../StartPlanDialog", () => ({
  default: () => null,
}));

vi.mock("../SettingsPage", () => ({
  default: () => null,
}));

vi.mock("../SetupWizard", () => ({
  default: () => null,
}));

vi.mock("../UpdateBadge", () => ({
  default: () => null,
}));

vi.mock("../UpdateDialog", () => ({
  default: () => null,
}));

vi.mock("../api", () => ({
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
  fetchSessions: vi.fn(async () => []),
  fetchMessages: vi.fn(async () => []),
  fetchPendingPermissions: vi.fn(async () => []),
  createReconnectingWebSocket: vi.fn(() => ({
    close() {},
    send() {},
    reconnect() {},
  })),
  fetchEnvs: vi.fn(async () => []),
  fetchRepos: vi.fn(async () => []),
  fetchEnv: vi.fn(async () => null),
  fetchRepo: vi.fn(async () => null),
  fetchSetupStatus: vi.fn(async () => ({
    needsSetup: false,
    isLocalDev: false,
    currentOrigin: "https://example.com",
  })),
  createEnv: vi.fn(),
  createRepo: vi.fn(),
  bootstrapRepoGitArtifact: vi.fn(),
  checkForUpdate: vi.fn(async () => null),
}));

describe("Dashboard", () => {
  const originalWindow = globalThis.window;
  const originalNotification = globalThis.Notification;
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://example.com" },
        localStorage: {
          getItem: () => null,
          setItem: () => undefined,
          removeItem: () => undefined,
        },
      },
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: {
        permission: "granted",
        requestPermission: vi.fn(),
      },
    });
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, "Notification", {
      configurable: true,
      value: originalNotification,
    });
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
    vi.resetModules();
  });

  it("renders without touching uninitialized callbacks", async () => {
    const { default: Dashboard } = await import("../App");
    expect(() => renderToString(React.createElement(Dashboard))).not.toThrow();
  });

  it("refreshes sessions alongside envs, repos, and setup status after hub reconnect", async () => {
    const { refreshDashboardStateAfterHubConnect } = await import("../App");
    const refreshSessions = vi.fn();
    const refreshEnvs = vi.fn();
    const refreshRepos = vi.fn();
    const refreshSetupStatus = vi.fn();

    refreshDashboardStateAfterHubConnect({
      refreshSessions,
      refreshEnvs,
      refreshRepos,
      refreshSetupStatus,
    });

    expect(refreshSessions).toHaveBeenCalledTimes(1);
    expect(refreshEnvs).toHaveBeenCalledTimes(1);
    expect(refreshRepos).toHaveBeenCalledTimes(1);
    expect(refreshSetupStatus).toHaveBeenCalledTimes(1);
  });

  it("surfaces update-check failures returned as typed update issues", async () => {
    const { getTopLevelUpdateIssue } = await import("../App");
    expect(getTopLevelUpdateIssue({
      updateAvailable: false,
      currentUpdate: {
        schemaVersion: 1,
        channel: "deploy-button",
        updateMode: "full-source",
        sourceRepo: "paperwing-dev/tiller-hub",
        sourceId: "current-source",
        version: "0.2.27",
        label: "Current",
        managedFiles: ["package.json"],
      },
      latestUpdate: {
        schemaVersion: 1,
        channel: "deploy-button",
        updateMode: "full-source",
        sourceRepo: "paperwing-dev/tiller-hub",
        sourceId: "current-source",
        version: "0.2.27",
        label: "Current",
        managedFiles: ["package.json"],
      },
      buildDiagnostics: {
        version: "0.1.0",
        workersCiCommitSha: null,
        workersCiBranch: null,
      },
      hubRepo: { status: "not_checked", lastDetectedAt: null },
      updateMethod: "advanced_repair",
      issue: {
        code: "update_check_failed",
        message: "Self-update check failed",
      },
      releaseNotesUrl: "https://github.com/paperwing-dev/tiller-hub",
    })).toBe("Self-update check failed");
  });

  it("preserves setup-protection update-check error codes", async () => {
    const { getUpdateCheckFailure } = await import("../App");
    const { ApiActionError } = await import("../api");
    const failure = getUpdateCheckFailure(new ApiActionError({
      error: "Protect this hub with Cloudflare Access before using the API.",
      code: "setup_protection_required",
    }, "Failed to check for updates"));

    expect(failure).toEqual({
      message: "Protect this hub with Cloudflare Access before using the API.",
      code: "setup_protection_required",
    });
  });
});
