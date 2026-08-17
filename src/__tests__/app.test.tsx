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

vi.mock("../ShipView", () => ({
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

vi.mock("../RepoSettingsPage", () => ({
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
  fetchSessions: vi.fn(async () => []),
  fetchMessages: vi.fn(async () => []),
  fetchPendingPermissions: vi.fn(async () => []),
  createReconnectingWebSocket: vi.fn(() => ({
    close() {},
    send() { return true; },
    reconnect() {},
  })),
  fetchEnvs: vi.fn(async () => []),
  fetchRepos: vi.fn(async () => []),
  fetchEnv: vi.fn(async () => null),
  fetchRepo: vi.fn(async () => null),
  fetchSetupStatus: vi.fn(async () => ({
    needsSetup: false,
    isLocalDev: false,
  })),
  createEnv: vi.fn(),
  createRepo: vi.fn(),
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
    const { createMemoryRouter } = await import("react-router");
    const { RouterProvider } = await import("react-router/dom");
    const { dashboardRoutes } = await import("../App");
    const router = createMemoryRouter(dashboardRoutes, { initialEntries: ["/"] });
    expect(() => renderToString(React.createElement(RouterProvider, { router }))).not.toThrow();
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

  it("keeps an accepted dashboard snapshot visible after a background read failure", async () => {
    const { settleDashboardReadState } = await import("../DashboardDataProvider");

    expect(settleDashboardReadState("loaded", false)).toBe("loaded");
    expect(settleDashboardReadState("loading", false)).toBe("error");
    expect(settleDashboardReadState("idle", true)).toBe("loaded");
  });

  it("reloads once to renew expired browser authentication", async () => {
    const { recoverBrowserAuthentication } = await import("../App");
    const { ApiAuthenticationError } = await import("../api");
    const stored = new Map<string, string>();
    const reload = vi.fn();
    const target = {
      location: { reload },
      sessionStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    };
    const error = new ApiAuthenticationError("expired");

    expect(recoverBrowserAuthentication(error, target, 100_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(recoverBrowserAuthentication(error, target, 105_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    expect(recoverBrowserAuthentication(error, target, 110_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
    expect(recoverBrowserAuthentication(new Error("offline"), target, 120_000)).toBe(false);
  });

  it("surfaces update-check failures returned as typed update issues", async () => {
    const { getTopLevelUpdateIssue } = await import("../App");
    expect(getTopLevelUpdateIssue({
      kind: "unmanaged",
      updateAvailable: false,
      currentRelease: {
        schemaVersion: 1,
        channel: "release",
        hubVersion: "0.2.54",
        releaseId: "a".repeat(40),
      },
      stableRelease: null,
      buildDiagnostics: {
        channel: "release",
        version: "0.2.54",
        workersCiCommitSha: null,
        workersCiBranch: null,
      },
      errors: [{
        code: "stable_release_unavailable",
        message: "Self-update check failed",
        retryable: true,
      }],
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
