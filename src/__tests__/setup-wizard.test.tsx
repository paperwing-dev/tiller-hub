import React from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupStatus } from "../api";

vi.mock("../Toast", () => ({
  useToast: () => vi.fn(),
}));

function baseStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  return {
    needsSetup: true,
    setupPhase: "protect-hub",
    isLocalDev: false,
    currentOrigin: "https://demo.preview.workers.dev",
    hubUrl: "https://tiller.example.com",
    deploymentMode: "hosted",
    selfHostStatus: "not-enabled",
    selfHostSetupAttemptId: null,
    workersDevHubUrl: "https://demo.preview.workers.dev",
    routeKind: "custom-domain",
    workerServiceName: "tiller-hub",
    modelAuthConfigured: false,
    modelAuthMode: null,
    hostedInfrastructureReady: false,
    hostedBlockingReasons: ["Protect this hub with Cloudflare Access."],
    hostedModelReady: false,
    hostedModelBlockingReasons: ["Configure model credentials for Hosted Tiller models."],
    selfHostReady: false,
    selfHostBlockingReasons: [],
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
    hostRegistered: false,
    hostRegisteredMode: "none",
    hostGatewayAvailable: false,
    hostGatewayConfigured: false,
    hostGatewayMode: "none",
    enabledHarnesses: ["claude-code"],
    protectionMode: "public",
    protectionCanAutomate: false,
    serviceTokenConfigured: false,
    gatewayHostname: null,
    browserProtected: false,
    gatewayProvisioned: false,
    gatewayTunnelConfigured: false,
    gatewaySupportAvailable: false,
    gatewaySupportReason: null,
    workersDevCutoverPending: false,
    unsupportedProtectionConfig: false,
    workersDevAliasDisabled: false,
    protectionAppDomain: null,
    accessConfigured: false,
    accessIssuer: null,
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
    githubAppPublicHubDisabled: true,
    ...overrides,
  };
}

describe("SetupWizard protect-hub", () => {
  const originalWindow = globalThis.window;
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "https://demo.preview.workers.dev" },
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

  it("renders the current workers.dev route when the configured hub URL differs", async () => {
    const { default: SetupWizard } = await import("../SetupWizard");
    const html = renderToString(
      <SetupWizard status={baseStatus()} onRefresh={async () => undefined} />,
    );

    expect(html).toContain("Protect this hub");
    expect(html).toContain("Step <!-- -->1<!-- --> of 2");
    expect(html).toContain("Connect GitHub");
    expect(html).toContain("demo.preview.workers.dev");
    expect(html).toContain("Enable Access in Cloudflare");
    expect(html).toContain("Domains");
    expect(html).toContain("Open Domains");
    expect(html).toContain("Cloudflare Access can take about <!-- -->15<!-- --> seconds");
    expect(html).toContain("automatic reload");
    expect(html).toContain("Reload automatically, then verify");
    expect(html).toContain("Reload now");
    expect(html).toContain("Verify Access");
    expect(html).toContain("workers/services/view/tiller-hub/production/domains");
    expect(html).not.toContain("Manage Cloudflare Access");
    expect(html).not.toContain("Open Workers");
    expect(html).not.toContain("Automatic setup");
    expect(html).not.toContain("Cloudflare API token");
    expect(html).not.toContain("Create token");
    expect(html).not.toContain("tiller.example.com");
    expect(html).not.toContain("Cloudflare steps");
  });

  it("renders GitHub setup as the second required step", async () => {
    const { default: SetupWizard } = await import("../SetupWizard");
    const html = renderToString(
      <SetupWizard
        status={baseStatus({
          setupPhase: "github-app",
          accessConfigured: true,
          protectionMode: "cf-access",
          githubAppPublicHubDisabled: false,
        })}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("Step <!-- -->2<!-- --> of 2");
    expect(html).toContain("Connect GitHub");
    expect(html).toContain("Tiller needs a GitHub App");
    expect(html).toContain("Create GitHub App");
    expect(html).toContain("/api/github/manifest/setup");
    expect(html).not.toContain("Add model keys");
  });
});
