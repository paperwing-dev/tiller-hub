import React from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SetupStatus } from '../api';

vi.mock('../Toast', () => ({
  useToast: () => vi.fn(),
}));

function baseStatus(overrides: Partial<SetupStatus> = {}): SetupStatus {
  const status: SetupStatus = {
    needsSetup: false,
    setupPhase: 'complete',
    isLocalDev: false,
    installerManaged: false,
    installationRegion: null,
    workersDevHubUrl: 'https://demo.preview.workers.dev',
    modelAuthConfigured: true,
    claudeBillingMode: 'subscription',
    openaiBillingMode: 'subscription',
    workersAiConfigured: false,
    hasClaudeSubscription: true,
    hasAnthropicKey: false,
    hasChatGPTAuth: false,
    chatgptAuthStatus: 'missing',
    hasOpenAIKey: false,
    codexRouteStatus: 'unavailable',
    openaiPlannerConfigured: false,
    openaiPlannerAvailable: false,
    openaiPlannerRoute: null,
    openaiPlannerReason: null,
    codexBackendReadiness: {
      cf: 'authentication_unavailable',
      host: 'backend_offline',
    },
    hostRegistered: false,
    enabledHarnesses: ['claude-code', 'codex', 'opencode'],
    protectionMode: 'cf-access',
    tokenExpiresAt: null,
    renewalRecommended: false,
    hostConnected: false,
    idleTimeoutMinutes: 10,
    githubAppAvailable: false,
    githubAppConfigured: false,
    githubAppReady: false,
    githubAppSlug: null,
    githubAppInstallUrl: null,
    githubAppManageUrl: 'https://github.com/settings/installations',
    githubAppPublicHubDisabled: false,
    buildDiagnostics: {
      channel: 'release',
      version: '0.1.0',
      workersCiCommitSha: null,
      workersCiBranch: null,
    },
    dashboardOnboarding: { dismissed: false, executionReady: false },
  };
  return Object.assign(status, overrides);
}

describe('Global Settings', () => {
  const originalWindow = globalThis.window;
  const originalReact = (
    globalThis as typeof globalThis & { React?: typeof React }
  ).React;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'https://hub.example.com' },
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        setInterval: globalThis.setInterval,
        clearInterval: globalThis.clearInterval,
      },
    });
    Object.defineProperty(globalThis, 'React', {
      configurable: true,
      value: React,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: originalWindow,
    });
    Object.defineProperty(globalThis, 'React', {
      configurable: true,
      value: originalReact,
    });
    vi.resetModules();
  });

  it('removes GitHub and Cloudflare Access cards from Global Settings', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          githubAppConfigured: true,
          githubAppReady: true,
          tokenExpiresAt: '2026-08-01T00:00:00.000Z',
          renewalRecommended: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).not.toContain('GitHub App');
    expect(html).not.toContain('Cloudflare Access');
    expect(html).not.toContain('Canonical main history depth');
  });

  it('offers only Paperwing Light and Classic Light in Global Settings', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Appearance');
    expect(html).toContain('Theme');
    expect(html).toContain('Paperwing Light');
    expect(html).toContain('Classic Light');
    expect(html).toContain('tiller-settings-select');
    expect(html).not.toContain('Current · System');
    expect(html).not.toContain('Current · Dark');
    expect(html).toContain('previous high-contrast palette');
  });

  it('exposes stable targets for exact model-access settings links', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    for (const target of [
      'execution-backend',
      'model-access',
      'claude-billing',
      'openai-billing',
      'claude-api-key',
      'openai-api-key',
      'claude-subscription',
      'codex-subscription',
    ]) {
      expect(html).toContain(`id="${target}"`);
      expect(html).toContain(`data-settings-target="${target}"`);
    }
  });

  it('keeps Cloudflare installation and idle-timeout details behind Advanced', async () => {
    const { default: SettingsPage, IdleTimeoutRow } =
      await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );
    const idleTimeoutHtml = renderToString(
      <IdleTimeoutRow currentMinutes={10} onSave={async () => undefined} />,
    );

    expect(html).toContain('Advanced');
    expect(html).toContain('Cloudflare environment lifecycle settings.');
    expect(html).toContain('Show advanced');
    expect(html).not.toContain('Session Env');
    expect(html).not.toContain('Idle timeout');
    expect(html).not.toContain('Canonical main history depth');
    expect(idleTimeoutHtml).toContain('Idle timeout');
    expect(idleTimeoutHtml).toContain(
      'Cloudflare environments and newly started Cloudflare Scribes',
    );
    expect(idleTimeoutHtml).toContain(
      'does not affect workloads on Your machine',
    );
    expect(idleTimeoutHtml).not.toContain('Canonical main history depth');
  });

  it('shows hosted regional placement without a change action', async () => {
    const { InstallationRegionRow, shouldShowInstallationRegion } =
      await import('../SettingsPage');
    const regional = renderToString(<InstallationRegionRow region="wnam" />);

    expect(regional).toContain('Cloudflare placement region');
    expect(regional).toContain('Western North America (WNAM)');
    expect(regional).toContain(
      'Used for Durable Object and Cloudflare Container placement in this deployment.',
    );
    expect(regional).not.toContain('<button');
    expect(regional).not.toContain('Automatic');
    expect(
      shouldShowInstallationRegion({
        isLocalDev: false,
        installationRegion: 'wnam',
      }),
    ).toBe(true);
    expect(
      shouldShowInstallationRegion({
        isLocalDev: false,
        installationRegion: 'wnam',
      }),
    ).toBe(true);
    expect(
      shouldShowInstallationRegion({
        isLocalDev: true,
        installationRegion: 'wnam',
      }),
    ).toBe(false);
    expect(
      shouldShowInstallationRegion({
        isLocalDev: false,
        installationRegion: null,
      }),
    ).toBe(false);
  });

  it('keeps Codex subscription actions on the subscription row', async () => {
    const { buildTillerNpxCommand, default: SettingsPage } =
      await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Codex subscription');
    expect(html).toContain(
      'npx -y @paperwing-dev/tiller@latest auth connect codex',
    );
    expect(html).toContain('Copy Codex setup command');
    expect(html).toContain('No Tiller install needed.');
    expect(html).toContain('View command');
    expect(
      buildTillerNpxCommand(
        'tiller auth connect codex --hub-url https://hub.example.com',
      ),
    ).toBe(
      'npx -y @paperwing-dev/tiller@latest auth connect codex --hub-url https://hub.example.com',
    );
    expect(html).not.toContain('Check status');
    expect(html).not.toContain('Refresh status');
    expect(html).not.toContain('Codex Subscription Login');
    expect(html).not.toContain('Import Codex Login');
  });

  it('leads Claude subscription setup with the Tiller CLI and keeps manual entry as a fallback', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain(
      'npx -y @paperwing-dev/tiller@latest auth connect claude',
    );
    expect(html).toContain('Copy Claude setup command');
    expect(html).toContain('No Tiller install needed.');
    expect(html).toContain('Enter token manually');
    expect(html).not.toContain('Recommended');
    expect(html).not.toContain('Manual fallback:');
    expect(html).not.toContain('claude setup-token');
  });

  it('shows independent unselected modes and configured inactive credentials', async () => {
    const { default: SettingsPage, getCredentialStatusChip } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          claudeBillingMode: null,
          openaiBillingMode: null,
          hasClaudeSubscription: true,
          hasAnthropicKey: true,
          hasChatGPTAuth: true,
          chatgptAuthStatus: 'connected',
          hasOpenAIKey: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Claude billing mode');
    expect(html).toContain('OpenAI billing mode');
    expect(html.match(/No mode selected yet\./g)).toHaveLength(2);
    expect(html).toContain('Claude subscription');
    expect(html).toContain('Connected · inactive');
    expect(html).toContain('Configured · not selected');
    expect(html).toContain('Test API key');
    expect(getCredentialStatusChip('configured', false, {
      key: 'ANTHROPIC_API_KEY',
      mode: 'api',
      ok: true,
    })).toEqual({
      label: 'Verified · not selected',
      variant: 'success',
    });
    expect(html).toContain('Saving a credential does not activate it');
    expect(html).toContain(
      'retained Scribe runtimes remain pinned until recreated',
    );
    expect(html).not.toContain('to choose a billing mode');
    expect(html).not.toContain('to enable Subscription');
    expect(html).not.toContain('to enable API');
  });

  it('disables unavailable billing modes and explains which credentials are needed', async () => {
    const { billingModeAvailability, default: SettingsPage } =
      await import('../SettingsPage');
    const missingStatus = baseStatus({
      claudeBillingMode: null,
      openaiBillingMode: null,
      hasClaudeSubscription: false,
      hasAnthropicKey: false,
      hasChatGPTAuth: false,
      chatgptAuthStatus: 'missing',
      hasOpenAIKey: false,
    });
    const html = renderToString(
      <SettingsPage
        status={missingStatus}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(billingModeAvailability('Claude', missingStatus)).toMatchObject({
      subscription: false,
      api: false,
    });
    expect(billingModeAvailability('OpenAI', missingStatus)).toMatchObject({
      subscription: false,
      api: false,
    });
    expect(html).toContain(
      'Add a Claude subscription token or Claude API key below to choose a billing mode.',
    );
    expect(html).toContain(
      'Connect a Codex subscription login or add an OpenAI API key below to choose a billing mode.',
    );
  });

  it('enables only billing modes with matching credentials', async () => {
    const { billingModeAvailability } = await import('../SettingsPage');
    const status = baseStatus({
      hasClaudeSubscription: true,
      hasAnthropicKey: false,
      hasChatGPTAuth: false,
      chatgptAuthStatus: 'needs_reconnect',
      hasOpenAIKey: true,
    });

    expect(billingModeAvailability('Claude', status)).toEqual({
      subscription: true,
      api: false,
      message: 'Add a Claude API key below to enable API.',
    });
    expect(billingModeAvailability('OpenAI', status)).toEqual({
      subscription: true,
      api: true,
      message: null,
    });
  });

  it('marks a configured OpenAI subscription as inactive when API mode is selected', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          openaiBillingMode: 'api',
          hasChatGPTAuth: true,
          chatgptAuthStatus: 'connected',
          hasOpenAIKey: true,
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Codex subscription');
    expect(html).toContain('Connected · inactive');
    expect(html).toContain('Configured · active');
  });

  it('shows both OpenAI credential routes even when OpenAI harnesses are disabled', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
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

    expect(html).toContain('OpenAI API key');
    expect(html).toContain('Use OpenAI-backed models with Codex or OpenCode.');
    expect(html).toContain('Claude API key');
    expect(html).toContain(
      'Use Anthropic-backed models with Claude Code or OpenCode.',
    );
    expect(html).toContain('Codex subscription');
  });

  it('describes the Cloudflare usage included with the built-in Kimi model', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Kimi K2.7 Code');
    expect(html).toContain(
      "runs through Tiller&#x27;s built-in Workers AI binding, using the Workers AI usage included with your Cloudflare account.",
    );
    expect(html).not.toContain('OpenAI- and Anthropic-backed OpenCode models');
  });

  it('shows the reconnection command when a subscription login is already present', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          hasChatGPTAuth: true,
          chatgptAuthStatus: 'connected',
          openaiPlannerAvailable: true,
          openaiPlannerRoute: 'subscription-app-server',
          hostRegistered: true,
          hostConnected: true,
          codexRouteStatus: 'available',
          codexBackendReadiness: { cf: 'available', host: 'available' },
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Connected · active');
    expect(html).toContain(
      'Connected to this Hub for Codex workloads and OpenAI planner runs on either execution backend.',
    );
    expect(html).toContain(
      'npx -y @paperwing-dev/tiller@latest auth connect codex',
    );
    expect(html).not.toContain('Import Codex Login');
  });

  it('keeps Hub-wide Codex authentication separate from execution-backend readiness', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const status = baseStatus({
      hasChatGPTAuth: true,
      chatgptAuthStatus: 'connected',
      codexRouteStatus: 'environment_not_connected',
      openaiPlannerReason:
        'The selected execution machine is registered but not connected.',
    });
    const html = renderToString(
      <SettingsPage
        status={status}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );
    expect(html).toContain('Connected · active');
    expect(html).toContain(
      'Connected to this Hub for Codex workloads and OpenAI planner runs on either execution backend.',
    );
    expect(html).not.toContain(
      'The selected execution machine is registered but not connected.',
    );
  });

  it('shows backend choices only in the execution settings card', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus({
          hasChatGPTAuth: true,
          chatgptAuthStatus: 'connected',
          openaiPlannerAvailable: true,
          openaiPlannerRoute: 'subscription-app-server',
          codexRouteStatus: 'available',
          codexBackendReadiness: {
            cf: 'available',
            host: 'environment_not_connected',
          },
        })}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );
    expect(html.match(/Cloudflare Containers/g)).toHaveLength(1);
    expect(html.match(/Your machine/g)).toHaveLength(1);
    expect(html).not.toContain('Environment not connected');
  });

  it('makes Settings the only execution-backend control and shows the canonical setup command', async () => {
    const { default: SettingsPage } = await import('../SettingsPage');
    const html = renderToString(
      <SettingsPage
        status={baseStatus()}
        onDone={() => undefined}
        onRefresh={async () => undefined}
      />,
    );

    expect(html).toContain('Execution backend');
    expect(html).toContain('Choose where new workloads run.');
    expect(html).toContain('Cloudflare Containers');
    expect(html).toContain(
      'Managed, with no machine to set up or keep online.',
    );
    expect(html).toContain('Your machine');
    expect(html).toContain('Can reduce compute costs, and will not shut down.');
    expect(html).toContain(
      'It installs Tiller CLI only if needed, then connects it.',
    );
    expect(html).toContain(
      '(command -v tiller &gt;/dev/null 2&gt;&amp;1 || npm install -g @paperwing-dev/tiller@latest) &amp;&amp; tiller host setup --hub-url https://demo.preview.workers.dev',
    );
    expect(html).toContain('Copy machine setup command');
    expect(html).toContain('View command');
    expect(
      html.match(/npm install -g @paperwing-dev\/tiller@latest/g),
    ).toHaveLength(1);
    expect(html.match(/npx -y @paperwing-dev\/tiller@latest/g)).toHaveLength(2);
    expect(html).not.toContain('Copy Tiller install command');
    expect(html).not.toContain('2. Connect machine');
    expect(html).toContain('Changes apply only to new workloads.');
    expect(html).not.toContain('Return to Hosted');
    expect(html).not.toContain('deployment mode');
  });
});
