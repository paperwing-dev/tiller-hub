import { afterEach, describe, expect, it, vi } from "vitest";
import {
  envPath,
  planPath,
  projectGlobalSettingsPath,
  projectPath,
  repoSettingsPath,
  sessionPath,
  shipPath,
} from "../dashboard-paths";
import {
  legacyDashboardHashPath,
  migrateLegacyDashboardHash,
} from "../dashboard-legacy-routes";
import { routeTouchesDeletedEnv } from "../dashboard-route-scope";

describe("dashboard path helpers", () => {
  it("builds clean dashboard paths", () => {
    expect(projectPath("repo-1")).toBe("/projects/repo-1");
    expect(planPath("repo-1")).toBe("/projects/repo-1/plan");
    expect(planPath("repo-1", "plan-1")).toBe("/projects/repo-1/plan/plan-1");
    expect(projectGlobalSettingsPath("repo-1")).toBe("/projects/repo-1/global-settings");
    expect(repoSettingsPath("repo-1")).toBe("/projects/repo-1/settings");
    expect(envPath("checkout-polish")).toBe("/envs/checkout-polish");
    expect(shipPath("checkout-polish")).toBe("/envs/checkout-polish/ship");
    expect(sessionPath("session-1")).toBe("/sessions/session-1");
  });

  it("encodes path params safely", () => {
    expect(projectPath("owner/repo")).toBe("/projects/owner%2Frepo");
    expect(planPath("repo 1", "draft/a")).toBe("/projects/repo%201/plan/draft%2Fa");
  });
});

describe("dashboard deleted-env route matching", () => {
  it("matches env, Ship, legacy changes, and mapped session routes for the deleted environment", () => {
    const sessionEnvMap = new Map([["session-1", "env-1"]]);

    expect(routeTouchesDeletedEnv("/envs/env-1", "env-1", sessionEnvMap)).toBe(true);
    expect(routeTouchesDeletedEnv("/envs/env-1/ship", "env-1", sessionEnvMap)).toBe(true);
    expect(routeTouchesDeletedEnv("/envs/env-1/changes", "env-1", sessionEnvMap)).toBe(true);
    expect(routeTouchesDeletedEnv("/sessions/session-1", "env-1", sessionEnvMap)).toBe(true);
    expect(routeTouchesDeletedEnv("/projects/repo-1", "env-1", sessionEnvMap)).toBe(false);
    expect(routeTouchesDeletedEnv("/sessions/session-2", "env-1", sessionEnvMap)).toBe(false);
  });
});

describe("legacy dashboard hash migration", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: originalWindow,
    });
    vi.restoreAllMocks();
  });

  it("maps recognized legacy hashes to clean paths", () => {
    expect(legacyDashboardHashPath("#view=project&repoId=repo-1")).toBe("/projects/repo-1");
    expect(legacyDashboardHashPath("#view=plan&repoId=repo-1&planArtifactId=plan-1")).toBe("/projects/repo-1/plan/plan-1");
    expect(legacyDashboardHashPath("#view=plan&repoId=repo-1")).toBe("/projects/repo-1/plan");
    expect(legacyDashboardHashPath("#view=repo-settings&repoId=repo-1")).toBe("/projects/repo-1/settings");
    expect(legacyDashboardHashPath("#view=env&envSlug=env-1")).toBe("/envs/env-1");
    expect(legacyDashboardHashPath("#view=changes&envSlug=env-1")).toBe("/envs/env-1/ship");
    expect(legacyDashboardHashPath("#view=session&sessionId=session-1")).toBe("/sessions/session-1");
    expect(legacyDashboardHashPath("#view=settings")).toBe("/settings");
    expect(legacyDashboardHashPath("#view=update")).toBe("/update");
    expect(legacyDashboardHashPath("#repoId=repo-1&planArtifactId=plan-1")).toBe("/projects/repo-1/plan/plan-1");
    expect(legacyDashboardHashPath("#repoId=repo-1")).toBe("/projects/repo-1/plan");
  });

  it("preserves search while replacing the startup URL without a hash", () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          hash: "#view=session&sessionId=session-1",
          search: "?token=abc",
        },
        history: { replaceState },
      },
    });

    expect(migrateLegacyDashboardHash()).toBe("/sessions/session-1");
    expect(replaceState).toHaveBeenCalledWith(null, "", "/sessions/session-1?token=abc");
  });

  it("does not rewrite unrecognized hashes", () => {
    const replaceState = vi.fn();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          hash: "#unknown=true",
          search: "?token=abc",
        },
        history: { replaceState },
      },
    });

    expect(migrateLegacyDashboardHash()).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
