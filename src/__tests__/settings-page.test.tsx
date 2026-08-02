import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../api";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

function baseStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    needsSetup: false,
    setupPhase: "complete",
    isLocalDev: false,
    installerManaged: false,
    workersDevHubUrl: "https://demo.preview.workers.dev",
    modelAuthConfigured: true,
    claudeBillingMode: "subscription",
    openaiBillingMode: "subscription",
    workersAiConfigured: false,
    hasClaudeSubscription: true,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    chatgptAuthStatus: "missing",
    hasOpenAIKey: false,
    codexRouteStatus: "unavailable",
    openaiPlannerConfigured: false,
    openaiPlannerAvailable: false,
    openaiPlannerRoute: null,
    openaiPlannerReason: null,
    codexBackendReadiness: { cf: "authentication_unavailable", host: "backend_offline" },
    hostRegistered: false,
    enabledHarnesses: ["claude-code", "codex", "opencode"],
    protectionMode: "cf-access",
    tokenExpiresAt: null,
    renewalRecommended: false,
    hostConnected: false,
    idleTimeoutMinutes: 10,
    canonicalMainBootstrapDepth: 0,
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
    selfUpdateRepo: { status: "not_checked", lastDetectedAt: null },
    ...overrides,
  };
}

describe("SettingsPage GitHub App wizard", () => {
  const originalWindow = globalThis.window;
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://hub.example.com" },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
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
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
    vi.resetModules();
  });

  it("renders GitHub setup as a new-tab link without showing manual fields", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage status={baseStatus()} onDone={() => undefined} onRefresh={async () => undefined} />,
    );

    expect(html).toContain('href="https://hub.example.com/api/github/manifest/setup"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toContain("App ID");
    expect(html).not.toContain("Private key PEM");
  });

  it("renders configured GitHub App status without extra management controls", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          githubAppAvailable: true,
          githubAppConfigured: true,
          githubAppReady: true,
          githubAppSlug: "tiller-test",
          githubAppInstallUrl: "https://github.com/apps/tiller-test/installations/new",
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("GitHub App configured");
    expect(html).toContain("GitHub App URL");
    expect(html).toContain("https://github.com/apps/tiller-test");
    expect(html).toContain("It is not a repository URL");
    expect(html).not.toContain("1. Create GitHub App");
    expect(html).not.toContain("2. Install repositories");
    expect(html).not.toContain("3. Use in Tiller");
    expect(html).not.toContain("Checking repositories");
    expect(html).not.toContain("Install more repos");
    expect(html).not.toContain("Manage GitHub Apps");
    expect(html).not.toContain("Test access");
  });

  it("keeps environment lifecycle settings behind Advanced by default", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage status={baseStatus()} onDone={() => undefined} onRefresh={async () => undefined} />,
    );

    expect(html).toContain("Advanced");
    expect(html).toContain("Show advanced");
    expect(html).not.toContain("Session Env");
    expect(html).not.toContain("Environment auto-stop");
    expect(html).not.toContain("Idle timeout");
    expect(html).not.toContain("Canonical main history depth");
  });

  it("keeps Codex subscription actions on the subscription row", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage status={baseStatus()} onDone={() => undefined} onRefresh={async () => undefined} />,
    );

    expect(html).toContain("Codex Subscription Login");
    expect(html).toContain("Check status");
    expect(html).toContain("tiller auth connect codex");
    expect(html).not.toContain("Import Codex Login");
  });

  it("shows independent unselected modes and configured inactive credentials", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          claudeBillingMode: null,
          openaiBillingMode: null,
          hasClaudeSubscription: true,
          hasAnthropicKey: true,
          hasChatGPTAuth: true,
          chatgptAuthStatus: "connected",
          hasOpenAIKey: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Claude billing mode");
    expect(html).toContain("OpenAI billing mode");
    expect(html.match(/No mode selected yet\./g)).toHaveLength(2);
    expect(html).toContain("Claude subscription token");
    expect(html).toContain("Configured · inactive");
    expect(html).toContain("Saving a credential does not activate it");
    expect(html).toContain("retained Plan Writer runtimes remain pinned until recreated");
  });

  it("marks a configured OpenAI subscription as inactive when API mode is selected", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          openaiBillingMode: "api",
          hasChatGPTAuth: true,
          chatgptAuthStatus: "connected",
          hasOpenAIKey: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Codex Subscription Login");
    expect(html).toContain("Configured · inactive");
    expect(html).toContain("Configured · active");
  });

  it("shows both OpenAI credential routes even when OpenAI harnesses are disabled", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          enabledHarnesses: [],
          modelAuthConfigured: false,
          hasClaudeSubscription: false,
          workersAiConfigured: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("OpenAI API key");
    expect(html).toContain("Use OpenAI-backed models with Codex or OpenCode.");
    expect(html).toContain("Codex Subscription Login");
  });

  it("shows the reconnection command when a subscription login is already present", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          hasChatGPTAuth: true,
          chatgptAuthStatus: "connected",
          openaiPlannerAvailable: true,
          openaiPlannerRoute: "subscription-app-server",
          hostRegistered: true,
          hostConnected: true,
          codexRouteStatus: "available",
          codexBackendReadiness: { cf: "available", host: "available" },
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Subscription active");
    expect(html).toContain("Reconnect at any time with");
    expect(html).toContain("tiller auth connect codex");
    expect(html).not.toContain("Import Codex Login");
  });

  it("distinguishes a disconnected execution machine from unavailable authentication", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const disconnected = renderToString(
      <SettingsPage
        status={baseStatus({
          hasChatGPTAuth: true,
          chatgptAuthStatus: "connected",
          codexRouteStatus: "environment_not_connected",
          openaiPlannerReason: "The selected execution machine is registered but not connected.",
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );
    expect(disconnected).toContain("The selected execution machine is registered but not connected.");

    const unavailable = renderToString(
      <SettingsPage
        status={baseStatus({
          hasChatGPTAuth: true,
          chatgptAuthStatus: "connected",
          codexRouteStatus: "authentication_unavailable",
          openaiPlannerReason: "The selected OpenAI authentication route is unavailable.",
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );
    expect(unavailable).toContain("Authentication unavailable");
    expect(unavailable).toContain("The selected OpenAI authentication route is unavailable.");
  });

  it("shows backend readiness independently when Cloudflare is ready but the machine is disconnected", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          hasChatGPTAuth: true,
          chatgptAuthStatus: "connected",
          openaiPlannerAvailable: true,
          openaiPlannerRoute: "subscription-app-server",
          codexRouteStatus: "available",
          codexBackendReadiness: { cf: "available", host: "environment_not_connected" },
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );
    expect(html).toContain("Cloudflare Containers");
    expect(html).toContain("Ready");
    expect(html).toContain("Your machine");
    expect(html).toContain("Environment not connected");
  });

  it("warns when the self-update repo is not visible to the GitHub App", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          githubAppAvailable: true,
          githubAppConfigured: true,
          githubAppReady: true,
          githubAppInstallUrl: "https://github.com/apps/tiller-test/installations/new",
          selfUpdateRepo: {
            status: "missing",
            lastDetectedAt: "2026-05-28T00:00:00.000Z",
            visibleGitHubOwners: ["adam", "paperwing-dev"],
          },
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Check the GitHub account");
    expect(html).toContain("Tiller can currently see adam, paperwing-dev.");
    expect(html).toContain("Cloudflare Worker Settings");
  });

  it("hides release self-update setup for development builds", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          githubAppAvailable: true,
          githubAppConfigured: true,
          githubAppReady: true,
          githubAppInstallUrl: "https://github.com/apps/tiller-test/installations/new",
          buildDiagnostics: {
            channel: "development",
            version: "0.1.0",
            workersCiCommitSha: null,
            workersCiBranch: null,
          },
          selfUpdateRepo: {
            status: "missing",
            lastDetectedAt: "2026-05-28T00:00:00.000Z",
            visibleGitHubOwners: ["adam"],
          },
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).not.toContain("Self-update repo");
    expect(html).not.toContain("Connect self-update repo");
    expect(html).not.toContain("Check the GitHub account");
  });

  it("makes Settings the only execution-backend control and shows the canonical setup command", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage status={baseStatus()} onDone={() => undefined} onRefresh={async () => undefined} />,
    );

    expect(html).toContain("Execution backend");
    expect(html).toContain("Choose where new workloads run.");
    expect(html).toContain("Cloudflare Containers");
    expect(html).toContain("Managed, with no machine to set up or keep online.");
    expect(html).toContain("Your machine");
    expect(html).toContain("Can reduce compute costs and may run faster.");
    expect(html).toContain("tiller host setup --hub-url https://demo.preview.workers.dev");
    expect(html).toContain("Changes apply only to new workloads.");
    expect(html).not.toContain("Return to Hosted");
    expect(html).not.toContain("deployment mode");
  });

  it("shows the Access expiration, 30-day warning, and single renewal action", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          tokenExpiresAt: "2026-08-01T00:00:00.000Z",
          renewalRecommended: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("CLI and agent access valid until");
    expect(html).toContain("Renew within 30 days");
    expect(html.match(/Renew with Cloudflare/g)).toHaveLength(1);
    expect(html).toContain("existing CLI, machine, and workload connections");
  });

  it("uses installer maintenance for binding-based Access renewal", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const update = {
      schemaVersion: 1 as const,
      channel: "deploy-button" as const,
      updateMode: "full-source" as const,
      sourceRepo: "paperwing-dev/tiller-hub" as const,
      sourceId: "a".repeat(40),
      version: "0.3.0",
      label: "Tiller Hub v0.3.0",
      managedFiles: ["package.json"],
    };
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          installerManaged: true,
          tokenExpiresAt: "2026-08-01T00:00:00.000Z",
          renewalRecommended: true,
        })}
        updateStatus={{
          kind: "installer-maintenance",
          updateAvailable: true,
          installedReleaseId: "b".repeat(40),
          currentUpdate: { ...update, sourceId: "b".repeat(40), version: "0.2.0" },
          stableRelease: {
            releaseId: update.sourceId,
            version: update.version,
            releaseNotesUrl: "https://example.com/release",
          },
          buildDiagnostics: baseStatus().buildDiagnostics,
        }}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Renew and update to v0.3.0");
    expect(html).not.toContain("Renew with Cloudflare");
  });

});
