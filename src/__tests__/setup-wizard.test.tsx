import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../api";

function baseStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    needsSetup: true,
    setupPhase: "github-app",
    isLocalDev: false,
    installerManaged: false,
    installationRegion: null,
    workersDevHubUrl: "https://demo.preview.workers.dev",
    modelAuthConfigured: false,
    claudeBillingMode: null,
    openaiBillingMode: null,
    workersAiConfigured: false,
    hasClaudeSubscription: false,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    chatgptAuthStatus: "missing",
    hasOpenAIKey: false,
    codexRouteStatus: "unavailable",
    openaiPlannerConfigured: false,
    openaiPlannerAvailable: false,
    openaiPlannerRoute: null,
    openaiPlannerReason: null,
    codexBackendReadiness: { cf: "unavailable", host: "environment_not_connected" },
    hostRegistered: false,
    enabledHarnesses: ["claude-code"],
    protectionMode: "cf-access",
    tokenExpiresAt: "2027-07-30T00:00:00.000Z",
    renewalRecommended: false,
    hostConnected: false,
    idleTimeoutMinutes: 10,
    githubAppAvailable: false,
    githubAppConfigured: false,
    githubAppReady: false,
    githubAppSlug: null,
    githubAppInstallUrl: null,
    githubAppManageUrl: "https://github.com/settings/installations",
    githubAppPublicHubDisabled: false,
    buildDiagnostics: {
      channel: "release",
      version: "0.1.0",
      workersCiCommitSha: null,
      workersCiBranch: null,
    },
    dashboardOnboarding: {
      dismissed: false,
      executionReady: true,
    },
    ...overrides,
  };
}

describe("SetupWizard", () => {
  const originalWindow = globalThis.window;
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://demo.preview.workers.dev" },
      },
    });
    Object.defineProperty(globalThis, "React", { configurable: true, value: React });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, "React", { configurable: true, value: originalReact });
    vi.resetModules();
  });

  it("blocks dashboard entry on required GitHub App creation", async () => {
    const { default: SetupWizard } = await import("../SetupWizard");
    const html = renderToString(
      <SetupWizard status={baseStatus()} onRefresh={async () => undefined} />,
    );

    expect(html).toContain("Required setup");
    expect(html).toContain("Connect GitHub");
    expect(html).toContain("One guided connection");
    expect(html).toContain("/api/github/manifest/setup");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("Check again");
    expect(html).not.toContain("Cloudflare API token");
    expect(html).not.toContain("Add model keys");
  });

  it("offers simple recovery when the App exists without a usable installation", async () => {
    const { default: SetupWizard } = await import("../SetupWizard");
    const html = renderToString(
      <SetupWizard
        status={baseStatus({
          githubAppAvailable: true,
          githubAppConfigured: true,
          githubAppSlug: "tiller-test",
          githubAppInstallUrl: "https://github.com/apps/tiller-test/installations/new",
        })}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Finish connecting GitHub");
    expect(html).toContain("GitHub App created");
    expect(html).toContain("tiller-test");
    expect(html).toContain("https://github.com/apps/tiller-test/installations/new");
    expect(html).toContain("Continue on GitHub");
    expect(html).toContain("Check again");
    expect(html).not.toContain('target="_blank"');
    expect(html).not.toContain("Verify repository");
    expect(html).not.toContain("Select repository");
  });

  it("renders nothing after required GitHub setup completes", async () => {
    const { default: SetupWizard } = await import("../SetupWizard");
    const html = renderToString(
      <SetupWizard
        status={baseStatus({ needsSetup: false, setupPhase: "complete", githubAppReady: true })}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toBe("");
  });
});
