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
    currentOrigin: "https://hub.example.com",
    hubUrl: "https://hub.example.com",
    deploymentMode: "self-host",
    selfHostStatus: "ready",
    selfHostSetupAttemptId: null,
    workersDevHubUrl: "https://demo.preview.workers.dev",
    routeKind: "custom-domain",
    workerServiceName: null,
    modelAuthConfigured: true,
    modelAuthMode: "subscription",
    hostedInfrastructureReady: true,
    hostedBlockingReasons: [],
    hostedModelReady: true,
    hostedModelBlockingReasons: [],
    selfHostReady: true,
    selfHostBlockingReasons: [],
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
    hostRegistered: false,
    hostRegisteredMode: "none",
    hostGatewayAvailable: false,
    hostGatewayConfigured: false,
    hostGatewayMode: "none",
    enabledHarnesses: ["claude-code", "codex", "opencode"],
    protectionMode: "cf-access",
    protectionCanAutomate: true,
    serviceTokenConfigured: true,
    gatewayHostname: null,
    browserProtected: true,
    gatewayProvisioned: true,
    gatewayTunnelConfigured: false,
    gatewaySupportAvailable: false,
    gatewaySupportReason: null,
    workersDevCutoverPending: false,
    unsupportedProtectionConfig: false,
    workersDevAliasDisabled: false,
    protectionAppDomain: null,
    accessConfigured: true,
    accessIssuer: "https://team.cloudflareaccess.com",
    accessJwksUrl: null,
    hostConnected: false,
    hostConnectionMode: "none",
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

  it("renders configured app install and manage links as new-tab links", async () => {
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

    expect(html).toContain('href="https://github.com/apps/tiller-test/installations/new"');
    expect(html).toContain('href="https://github.com/settings/installations"');
    expect(html.match(/target="_blank"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toContain("Test access");
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

  it("hides Self Host internals in Hosted mode and shows the setup action", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          deploymentMode: "hosted",
          selfHostStatus: "not-enabled",
          selfHostReady: false,
          hostConnected: false,
          hostGatewayAvailable: false,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Hosted Tiller is active");
    expect(html).toContain("Set up Self Host");
    expect(html).not.toContain("Host runtime");
    expect(html).not.toContain("Subscription Gateway");
    expect(html).not.toContain("tiller host setup --hub-url");
    expect(html).not.toContain("Active rollback hub");
  });

  it("uses Return to Hosted Tiller destructive confirmation language", async () => {
    const { default: SettingsPage } = await import("../SettingsPage");
    const html = renderToString(
      <SettingsPage status={baseStatus()} onDone={() => undefined} onRefresh={async () => undefined} />,
    );

    expect(html).toContain("Tiller Self Host is active");
    expect(html).toContain("Healthy");
    expect(html).toContain("Return to Hosted Tiller");
    expect(html).toContain("return to hosted");
  });
});
