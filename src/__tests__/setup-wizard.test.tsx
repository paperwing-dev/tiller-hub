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
    protectionMode: "public",
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
    githubAppPublicHubDisabled: true,
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

    expect(html).toContain("Connect Cloudflare and protect Tiller");
    expect(html).toContain("Tiller uses Cloudflare OAuth");
    expect(html).not.toContain("Paperwing uses Cloudflare OAuth");
    expect(html).toContain("Step <!-- -->1<!-- --> of 2");
    expect(html).toContain("Connect GitHub");
    expect(html).toContain("demo.preview.workers.dev");
    expect(html).toContain("Tiller callbacks");
    expect(html).toContain("Tiller Hub");
    expect(html).toContain("Owner sign-in");
    expect(html).toContain("Tiller owner sign-in");
    expect(html).toContain("attaches it only to Tiller Hub");
    expect(html).toContain("Existing identity providers");
    expect(html).toContain("/api/github/webhook");
    expect(html).toContain("/api/setup/workers-dev-access/broker/proof");
    expect(html).toContain("/api/setup/workers-dev-access/broker/complete");
    expect(html).not.toContain("Open Domains");
    expect(html).not.toContain("Reload now");
    expect(html).not.toContain("Verify Access");
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

  it("offers an OpenAI API key for OpenAI-backed OpenCode models", async () => {
    const { default: SetupWizard } = await import("../SetupWizard");
    const html = renderToString(
      <SetupWizard
        status={baseStatus({
          setupPhase: "model-access",
          enabledHarnesses: ["opencode"],
          protectionMode: "cf-access",
        })}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain("OpenAI API key");
    expect(html).toContain("For Codex and OpenAI-backed OpenCode models.");
    expect(html).toContain("Add a key for Claude, Codex, or OpenAI-backed OpenCode models.");
  });
});
