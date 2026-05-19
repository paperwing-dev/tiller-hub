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
});
