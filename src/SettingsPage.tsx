import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Badge } from '@cloudflare/kumo/components/badge';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { Input } from '@cloudflare/kumo/components/input';
import { LayerCard } from '@cloudflare/kumo/components/layer-card';
import { Select } from '@cloudflare/kumo/components/select';
import { Tooltip } from '@cloudflare/kumo/components/tooltip';
import { CodeIcon } from '@phosphor-icons/react';
import { useToast } from './Toast';
import {
  focusSettingsTarget,
  parseSettingsTargetHash,
  SETTINGS_TARGET_IDS,
  type SettingsTargetId,
} from './settings-targets';
import {
  getStoredThemePreference,
  setThemePreference,
  type ThemePreference,
} from './theme';
import type {
  AuthConnectProvider,
  ExecutionStatus,
  SetupStatus,
  VerifyModelAuthResult,
} from './api';
import {
  approveAuthConnect,
  fetchAuthConnectStatus,
  fetchExecutionStatus,
  saveBillingMode,
  setExecutionBackend,
  submitSetup,
  verifyModelAuth,
} from './api';
import type { BillingMode } from '../shared/billing';
import { KIMI_K2_7_CODE } from '../shared/harness-catalog';
import {
  CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
  isCloudflareIdleTimeoutMinutes,
} from '../shared/cloudflare-timeout';
import { placementRegionDefinition } from '../shared/placement';

const HUB_URL = window.location.origin;
const TILLER_CLI_PACKAGE = '@paperwing-dev/tiller@latest';
const TILLER_CLI_INSTALL_COMMAND = `npm install -g ${TILLER_CLI_PACKAGE}`;

export function buildTillerNpxCommand(command: string): string {
  const normalized = command.trim();
  if (!normalized.startsWith('tiller ')) {
    throw new Error('Tiller CLI commands must start with `tiller `.');
  }
  return `npx -y ${TILLER_CLI_PACKAGE} ${normalized.slice('tiller '.length)}`;
}

interface SettingsPageProps {
  status: SetupStatus;
  onDone: () => void;
  onRefresh: () => Promise<void>;
  authConnectIntent?: AuthConnectIntent;
}

export interface AuthConnectRequest {
  port: number;
  state: string;
  publicKeyJwk: Record<string, unknown>;
  providers: AuthConnectProvider[];
}

export type AuthConnectIntent =
  { kind: 'request'; request: AuthConnectRequest } | { kind: 'invalid' } | null;

function decodeBase64UrlJson(value: string): unknown {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(
    globalThis.atob(normalized + '='.repeat((4 - (normalized.length % 4)) % 4)),
    (character) => character.charCodeAt(0),
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

export function parseAuthConnectIntent(search: string): AuthConnectIntent {
  const params = new URLSearchParams(search);
  if (params.get('auth_connect') !== '1') return null;
  const portValue = params.get('port') ?? '';
  const state = params.get('state')?.trim() ?? '';
  const key = params.get('key') ?? '';
  const providerValues = (params.get('providers') ?? '')
    .split(',')
    .filter(Boolean);
  if (
    !/^\d{1,5}$/.test(portValue) ||
    !state ||
    state.length > 512 ||
    !key ||
    key.length > 4_096 ||
    providerValues.length < 1 ||
    providerValues.length > 2 ||
    new Set(providerValues).size !== providerValues.length ||
    providerValues.some(
      (provider) => provider !== 'codex' && provider !== 'claude',
    )
  )
    return { kind: 'invalid' };
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    return { kind: 'invalid' };
  try {
    const publicKeyJwk = decodeBase64UrlJson(key);
    if (
      !publicKeyJwk ||
      typeof publicKeyJwk !== 'object' ||
      Array.isArray(publicKeyJwk)
    ) {
      return { kind: 'invalid' };
    }
    return {
      kind: 'request',
      request: {
        port,
        state,
        publicKeyJwk: publicKeyJwk as Record<string, unknown>,
        providers: providerValues as AuthConnectProvider[],
      },
    };
  } catch {
    return { kind: 'invalid' };
  }
}

export function shouldShowInstallationRegion(
  status: Pick<SetupStatus, 'installerManaged' | 'isLocalDev'>,
): boolean {
  return status.installerManaged && !status.isLocalDev;
}

function Card({
  title,
  description,
  children,
  tone = 'default',
}: {
  title: string;
  description: string;
  children: ReactNode;
  tone?: 'default' | 'success' | 'warning';
}) {
  const toneClasses =
    tone === 'success'
      ? 'ring-kumo-success/25 bg-kumo-success-tint'
      : tone === 'warning'
        ? 'ring-kumo-warning/30 bg-kumo-warning-tint'
        : '';

  return (
    <LayerCard render={<section />} className={`p-5 ${toneClasses}`}>
      <h3 className="text-base font-semibold text-kumo-strong">{title}</h3>
      <p className="mt-1 text-sm text-kumo-subtle">{description}</p>
      <div className="mt-4">{children}</div>
    </LayerCard>
  );
}

function useSettingsHashTarget(): SettingsTargetId | null {
  const [activeTarget, setActiveTarget] = useState<SettingsTargetId | null>(
    null,
  );

  useEffect(() => {
    let timerId: number | null = null;
    const syncTarget = () => {
      const nextTarget = parseSettingsTargetHash(window.location.hash);
      setActiveTarget(nextTarget);
      if (timerId !== null) window.clearTimeout(timerId);
      if (!nextTarget) return;
      timerId = window.setTimeout(() => {
        focusSettingsTarget(nextTarget);
      }, 0);
    };

    syncTarget();
    window.addEventListener('hashchange', syncTarget);
    return () => {
      if (timerId !== null) window.clearTimeout(timerId);
      window.removeEventListener('hashchange', syncTarget);
    };
  }, []);

  return activeTarget;
}

function SettingsTargetRegion({
  target,
  label,
  activeTarget,
  children,
}: {
  target: SettingsTargetId;
  label: string;
  activeTarget: SettingsTargetId | null;
  children: ReactNode;
}) {
  const active = target === activeTarget;
  return (
    <div
      id={target}
      role="region"
      aria-label={label}
      tabIndex={-1}
      data-settings-target={target}
      data-settings-target-active={active ? 'true' : undefined}
      className={`scroll-mt-8 rounded-xl outline-none transition-shadow ${
        active
          ? 'ring-2 ring-kumo-focus ring-offset-2 ring-offset-kumo-recessed'
          : ''
      }`}
    >
      {children}
    </div>
  );
}

type AuthConnectPhase =
  'approving' | 'sending' | 'finishing' | 'manual' | 'success' | 'error';
interface AuthConnectView {
  phase: AuthConnectPhase;
  title: string;
  detail: string;
  envelope?: string;
  failedStep?: 'approval' | 'save';
}

const authConnectApprovalCache = new Map<
  string,
  Promise<{ envelope: string; connectionId: string }>
>();

function providerList(providers: AuthConnectProvider[]): string {
  const labels = providers.map((provider) =>
    provider === 'codex' ? 'Codex' : 'Claude',
  );
  return labels.length === 2
    ? `${labels[0]} and ${labels[1]}`
    : (labels[0] ?? 'subscription');
}

function cachedAuthConnectApproval(request: AuthConnectRequest) {
  const cacheKey = JSON.stringify([
    HUB_URL,
    request.state,
    request.providers,
    request.publicKeyJwk,
  ]);
  const cached = authConnectApprovalCache.get(cacheKey);
  if (cached) return cached;
  const approval = approveAuthConnect(HUB_URL, {
    publicKeyJwk: request.publicKeyJwk,
    state: request.state,
    providers: request.providers,
  }).catch((error) => {
    authConnectApprovalCache.delete(cacheKey);
    throw error;
  });
  authConnectApprovalCache.set(cacheKey, approval);
  return approval;
}

function AuthConnectStep({
  label,
  state,
}: {
  label: string;
  state: 'complete' | 'current' | 'waiting' | 'error';
}) {
  const marker = state === 'complete' ? '✓' : state === 'error' ? '!' : '';
  const markerClasses =
    state === 'complete'
      ? 'border-kumo-success bg-kumo-success text-white'
      : state === 'error'
        ? 'border-kumo-danger bg-kumo-danger text-white'
        : state === 'current'
          ? 'border-kumo-accent bg-kumo-accent/10 text-kumo-accent'
          : 'border-kumo-line bg-kumo-base text-kumo-subtle';
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={`flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold ${markerClasses}`}
      >
        {marker}
      </span>
      <span
        className={`text-xs font-medium ${state === 'waiting' ? 'text-kumo-subtle' : 'text-kumo-default'}`}
      >
        {label}
      </span>
    </div>
  );
}

export function AuthConnectPanel({
  intent,
  onRefresh,
}: {
  intent: Exclude<AuthConnectIntent, null>;
  onRefresh: () => Promise<void>;
}) {
  const request = intent.kind === 'request' ? intent.request : null;
  const requestKey = request
    ? JSON.stringify([
        request.port,
        request.state,
        request.providers,
        request.publicKeyJwk,
      ])
    : 'invalid';
  const providers = request?.providers ?? [];
  const providersLabel = providerList(providers);
  const [view, setView] = useState<AuthConnectView>(() =>
    intent.kind === 'invalid'
      ? {
          phase: 'error',
          title: 'Invalid connection link',
          detail:
            'Run the connection command from Settings again to create a fresh approval link.',
          failedStep: 'approval',
        }
      : {
          phase: 'approving',
          title: `Approving ${providersLabel}`,
          detail:
            'Settings is creating a five-minute, single-use approval for this Tiller Hub.',
        },
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const onRefreshRef = useRef(onRefresh);

  useEffect(() => {
    onRefreshRef.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    let callbackController: AbortController | null = null;
    let approvalCreated = false;
    setView({
      phase: 'approving',
      title: `Approving ${providersLabel}`,
      detail:
        'Settings is creating a five-minute, single-use approval for this Tiller Hub.',
    });

    async function run() {
      try {
        const approval = await cachedAuthConnectApproval(request);
        if (cancelled) return;
        approvalCreated = true;
        setView({
          phase: 'sending',
          title: 'Approval created',
          detail:
            'Settings is securely handing the one-time approval back to the Tiller CLI.',
        });

        let deliveredLocally = false;
        callbackController = new AbortController();
        const callbackTimeout = window.setTimeout(
          () => callbackController?.abort(),
          3_000,
        );
        try {
          const callback = await fetch(
            `http://127.0.0.1:${request.port}/auth-connect-callback`,
            {
              method: 'POST',
              mode: 'cors',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ envelope: approval.envelope }),
              signal: callbackController.signal,
            },
          );
          deliveredLocally = callback.ok;
        } catch {
          deliveredLocally = false;
        } finally {
          window.clearTimeout(callbackTimeout);
        }
        if (cancelled) return;
        setView(
          deliveredLocally
            ? {
                phase: 'finishing',
                title: `Saving ${providersLabel} in Tiller`,
                detail:
                  'Keep this Settings page open. It will confirm when the subscription is saved and active.',
              }
            : {
                phase: 'manual',
                title: 'Connection code ready',
                detail:
                  'The CLI could not be reached on this device. Paste this one-time code into the terminal running Tiller; Settings will confirm the result here.',
                envelope: approval.envelope,
              },
        );

        const deadline = Date.now() + 5 * 60_000;
        while (!cancelled && Date.now() < deadline) {
          const status = await fetchAuthConnectStatus(
            HUB_URL,
            approval.connectionId,
          );
          if (cancelled) return;
          if (status.status === 'success') {
            setView({
              phase: 'success',
              title: `${providersLabel} connected`,
              detail:
                'The subscription was saved in Tiller Settings and selected for new workloads.',
            });
            await onRefreshRef.current().catch(() => undefined);
            return;
          }
          if (status.status === 'error') {
            setView({
              phase: 'error',
              title: `${providersLabel} could not be connected`,
              detail:
                status.error ??
                'Tiller could not save the subscription. Run the connection command again.',
              failedStep: 'save',
            });
            return;
          }
          if (status.status === 'expired') break;
          await new Promise<void>((resolve) => window.setTimeout(resolve, 750));
        }
        if (!cancelled) {
          setView({
            phase: 'error',
            title: 'Connection approval expired',
            detail:
              'Run the connection command from Settings again to create a fresh approval.',
            failedStep: 'save',
          });
        }
      } catch (error) {
        if (!cancelled) {
          setView({
            phase: 'error',
            title: approvalCreated
              ? 'Could not confirm the connection'
              : 'Connection approval failed',
            detail:
              error instanceof Error
                ? error.message
                : 'Run the connection command from Settings again.',
            failedStep: approvalCreated ? 'save' : 'approval',
          });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      callbackController?.abort();
    };
  }, [requestKey]);

  async function copyConnectionCode() {
    if (!view.envelope) return;
    try {
      await globalThis.navigator.clipboard.writeText(view.envelope);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1_500);
    } catch {
      setCopyState('failed');
    }
  }

  const approvalStep =
    view.phase === 'approving' || view.phase === 'sending'
      ? 'current'
      : view.phase === 'error' && view.failedStep === 'approval'
        ? 'error'
        : 'complete';
  const saveStep =
    view.phase === 'success'
      ? 'complete'
      : view.phase === 'finishing' || view.phase === 'manual'
        ? 'current'
        : view.phase === 'error' && view.failedStep === 'save'
          ? 'error'
          : 'waiting';
  const toneClasses =
    view.phase === 'success'
      ? 'ring-kumo-success/30 bg-kumo-success-tint'
      : view.phase === 'error'
        ? 'ring-kumo-danger/30 bg-kumo-danger-tint'
        : 'ring-kumo-accent/25 bg-kumo-base';

  return (
    <LayerCard
      render={<section aria-labelledby="auth-connect-title" />}
      className={`p-5 ring-1 ${toneClasses}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">
            Subscription connection
          </p>
          <h3
            id="auth-connect-title"
            className="mt-1 text-base font-semibold text-kumo-strong"
          >
            {view.title}
          </h3>
        </div>
        <Badge
          variant={
            view.phase === 'success'
              ? 'success'
              : view.phase === 'error'
                ? 'error'
                : view.phase === 'manual'
                  ? 'warning'
                  : 'info'
          }
          appearance="dot"
        >
          {view.phase === 'success'
            ? 'Connected'
            : view.phase === 'error'
              ? 'Action needed'
              : view.phase === 'manual'
                ? 'Code needed'
                : 'In progress'}
        </Badge>
      </div>
      <p aria-live="polite" className="mt-2 text-sm text-kumo-subtle">
        {view.detail}
      </p>
      <div className="mt-4 grid gap-3 rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3 sm:grid-cols-3">
        <AuthConnectStep label="Subscription sign-in" state="complete" />
        <AuthConnectStep label="Owner approval" state={approvalStep} />
        <AuthConnectStep label="Save in Tiller" state={saveStep} />
      </div>
      {view.envelope && (
        <div className="mt-4 rounded-xl border border-kumo-line bg-kumo-recessed p-3">
          <code className="block max-h-24 overflow-auto break-all text-xs text-kumo-default">
            {view.envelope}
          </code>
          <Button
            className="mt-3"
            variant="secondary"
            size="sm"
            onClick={() => void copyConnectionCode()}
          >
            {copyState === 'copied'
              ? 'Copied'
              : copyState === 'failed'
                ? 'Copy failed'
                : 'Copy connection code'}
          </Button>
        </div>
      )}
    </LayerCard>
  );
}

function AppearanceRow() {
  const [preference, setPreference] = useState<ThemePreference>(() =>
    getStoredThemePreference(),
  );

  return (
    <Select
      label="Theme"
      className="w-[200px]"
      value={preference}
      onValueChange={(value) => {
        const next = (value ?? 'system') as ThemePreference;
        setPreference(next);
        setThemePreference(next);
      }}
      items={{ system: 'System', light: 'Light', dark: 'Dark' }}
    />
  );
}

export function CopyableTerminalCommand({
  command,
  label,
  buttonLabel,
  viewLabel,
  helper,
  leading,
  trailing,
}: {
  command: string;
  label: string;
  buttonLabel: string;
  viewLabel: string;
  helper?: string;
  leading?: ReactNode;
  trailing?: ReactNode;
}) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>(
    'idle',
  );
  const [commandVisible, setCommandVisible] = useState(false);

  async function handleCopy() {
    try {
      if (!globalThis.navigator?.clipboard?.writeText) {
        throw new Error('Clipboard access is unavailable.');
      }
      await globalThis.navigator.clipboard.writeText(command);
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 1500);
    } catch {
      setCopyState('failed');
    }
  }

  return (
    <div className="mt-2 min-w-0 max-w-full">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {leading}
        <Button
          variant="secondary"
          size="sm"
          aria-label={`Copy ${label} command`}
          onClick={() => void handleCopy()}
        >
          {copyState === 'copied'
            ? 'Copied'
            : copyState === 'failed'
              ? 'Try again'
              : buttonLabel}
        </Button>
        <Tooltip
          content={commandVisible ? 'Hide command' : viewLabel}
          side="top"
          delay={250}
          render={
            <button
              type="button"
              className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default"
              aria-label={commandVisible ? 'Hide command' : viewLabel}
              aria-expanded={commandVisible}
              onClick={() => setCommandVisible((visible) => !visible)}
            />
          }
        >
          <CodeIcon className="h-3.5 w-3.5" aria-hidden="true" />
        </Tooltip>
        {helper && <span className="text-xs text-kumo-subtle">{helper}</span>}
        {trailing}
      </div>
      <code
        hidden={!commandVisible}
        className="mt-2 block w-full max-w-full overflow-x-auto whitespace-nowrap rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-xs text-kumo-default"
      >
        {command}
      </code>
    </div>
  );
}

function CopyableTillerCliCommand({
  command,
  label,
  trailing,
}: {
  command: string;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <CopyableTerminalCommand
      command={buildTillerNpxCommand(command)}
      label={`${label} setup`}
      buttonLabel="Copy setup command"
      viewLabel="View command"
      trailing={trailing}
    />
  );
}

function codexSubscriptionStatus(status: SetupStatus): {
  title: string;
  detail: string;
  tone: 'success' | 'warning' | 'neutral';
} {
  if (status.openaiBillingMode !== 'subscription') {
    return {
      title: status.hasChatGPTAuth ? 'Connected · inactive' : 'Not connected',
      detail:
        status.openaiBillingMode === 'api'
          ? 'OpenAI API mode is active. The connected Codex subscription is not used by new launches.'
          : 'Select OpenAI Subscription to activate this route for new launches.',
      tone: 'neutral',
    };
  }
  if (status.chatgptAuthStatus === 'needs_reconnect') {
    return {
      title: 'Needs reconnection',
      detail:
        'Tiller can no longer refresh this Codex subscription. Re-run the CLI connection command.',
      tone: 'warning',
    };
  }

  if (status.chatgptAuthStatus === 'temporarily_unavailable') {
    return {
      title: 'Temporarily unavailable',
      detail:
        'Tiller preserved the managed login and will retry without switching an active runtime to API billing.',
      tone: 'warning',
    };
  }

  if (status.chatgptAuthStatus === 'refreshing') {
    return {
      title: 'Refreshing',
      detail: "Tiller is refreshing this Hub's Codex subscription connection.",
      tone: 'warning',
    };
  }

  if (status.hasChatGPTAuth || status.chatgptAuthStatus === 'connected') {
    return {
      title: 'Connected · active',
      detail:
        'Connected to this Hub for Codex workloads and OpenAI planner runs on either execution backend.',
      tone: 'success',
    };
  }

  if (status.hasOpenAIKey) {
    return {
      title: 'Not connected',
      detail:
        'The configured OpenAI API key is inactive while OpenAI Subscription mode is selected.',
      tone: 'warning',
    };
  }

  return {
    title: 'Not connected',
    detail: 'Run setup on the computer where Codex is installed.',
    tone: 'neutral',
  };
}

// ── Credential row ───────────────────────────────────────────────

interface CredentialDef {
  label: string;
  description?: string;
  secretKey: string;
  configured: boolean;
  active: boolean;
  testable: boolean;
  partial?: boolean;
  help?: ReactNode;
  settingsTarget: SettingsTargetId;
}

function getCredentialStatusChip(
  state: 'configured' | 'partial' | 'missing',
  active: boolean,
): {
  label: string;
  variant: 'success' | 'warning' | 'neutral';
} {
  if (state === 'configured') {
    return {
      label: `Configured · ${active ? 'active' : 'inactive'}`,
      variant: active ? 'success' : 'neutral',
    };
  }

  if (state === 'partial') {
    return {
      label: `Incomplete · ${active ? 'active' : 'inactive'}`,
      variant: 'warning',
    };
  }

  return {
    label: `Not configured · ${active ? 'active' : 'inactive'}`,
    variant: active ? 'warning' : 'neutral',
  };
}

function getCredentialTestResultText(
  testResult: VerifyModelAuthResult | null,
  fallbackOkText: string,
): {
  text: string;
  className: string;
} | null {
  if (!testResult) {
    return null;
  }

  if (!testResult.ok) {
    return {
      text: `— ${testResult.error || 'Invalid'}`,
      className: 'text-kumo-danger',
    };
  }

  if (testResult.warning) {
    return {
      text: `— ${testResult.warning}`,
      className: 'text-kumo-warning',
    };
  }

  return {
    text: testResult.note ? `— ${testResult.note}` : fallbackOkText,
    className: 'text-kumo-success',
  };
}

function CredentialRowFrame({
  label,
  description,
  status,
  active,
  testResult,
  okText,
  canTest,
  editing,
  testing,
  onStartEdit,
  onTest,
  actionLabel,
  error,
  children,
}: {
  label: string;
  description?: string;
  status: 'configured' | 'partial' | 'missing';
  active: boolean;
  testResult: VerifyModelAuthResult | null;
  okText: string;
  canTest: boolean;
  editing: boolean;
  testing: boolean;
  onStartEdit: () => void;
  onTest: () => Promise<void>;
  actionLabel: string;
  error: string | null;
  children?: ReactNode;
}) {
  const statusChip = getCredentialStatusChip(status, active);
  const testResultText = getCredentialTestResultText(testResult, okText);

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">{label}</p>
          {description && (
            <p className="mt-0.5 text-xs text-kumo-subtle">{description}</p>
          )}
          <div className="mt-2 flex items-center gap-2">
            <Badge variant={statusChip.variant} appearance="dot">
              {statusChip.label}
            </Badge>

            {testResultText && (
              <span className={`text-xs ${testResultText.className}`}>
                {testResultText.text}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          {canTest && !editing && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void onTest()}
              loading={testing}
            >
              {testing ? 'Testing...' : 'Test'}
            </Button>
          )}
          {!editing && (
            <Button variant="secondary" size="sm" onClick={onStartEdit}>
              {actionLabel}
            </Button>
          )}
        </div>
      </div>

      {children}

      {error && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

function CredentialRow({
  def,
  testResult,
  onSave,
  onTest,
}: {
  def: CredentialDef;
  testResult: VerifyModelAuthResult | null;
  onSave: (payload: Record<string, string>) => Promise<void>;
  onTest: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ [def.secretKey]: value.trim() });
      setValue('');
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setError(null);
    try {
      await onTest();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTesting(false);
    }
  }

  return (
    <CredentialRowFrame
      label={def.label}
      description={def.description}
      status={
        def.configured ? 'configured' : def.partial ? 'partial' : 'missing'
      }
      active={def.active}
      testResult={testResult}
      okText="— Key is valid"
      canTest={def.configured && def.testable}
      editing={editing}
      testing={testing}
      onStartEdit={() => {
        setEditing(true);
        setError(null);
      }}
      onTest={handleTest}
      actionLabel={def.configured || def.partial ? 'Replace' : 'Add'}
      error={error}
    >
      {def.help}
      {editing && (
        <div className="mt-3 flex gap-2">
          <Input
            type="password"
            size="sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={`Paste ${def.label.toLowerCase()}`}
            aria-label={`Paste ${def.label.toLowerCase()}`}
            autoFocus
            disabled={saving}
            className="flex-1"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
            disabled={saving || !value.trim()}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setValue('');
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}
    </CredentialRowFrame>
  );
}

export function ClaudeSubscriptionRow({
  status,
  canonicalHubUrl,
  onSave,
}: {
  status: Pick<SetupStatus, 'hasClaudeSubscription' | 'claudeBillingMode'>;
  canonicalHubUrl: string;
  onSave: (payload: Record<string, string>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const claudeActive = status.claudeBillingMode === 'subscription';
  const credentialStatus = status.hasClaudeSubscription
    ? {
        label: `Connected · ${claudeActive ? 'active' : 'inactive'}`,
        variant: claudeActive ? ('success' as const) : ('neutral' as const),
      }
    : {
        label: 'Not connected',
        variant: claudeActive ? ('warning' as const) : ('neutral' as const),
      };

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ CLAUDE_CODE_OAUTH_TOKEN: value.trim() });
      setValue('');
      setEditing(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-kumo-default">
          Claude subscription
        </p>
        <Badge variant={credentialStatus.variant} appearance="dot">
          {credentialStatus.label}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-kumo-subtle">
        {status.hasClaudeSubscription
          ? 'Run setup again to replace the saved subscription.'
          : 'Run setup on the computer where Claude is installed.'}
      </p>
      <CopyableTillerCliCommand
        command={`tiller auth connect claude --hub-url ${canonicalHubUrl}`}
        label="Claude"
        trailing={
          <button
            type="button"
            className="text-xs font-medium text-kumo-default hover:underline"
            onClick={() => {
              setEditing(true);
              setError(null);
            }}
          >
            Enter token manually
          </button>
        }
      />
      {editing && (
        <div className="mt-3">
          <p className="mb-2 text-xs text-kumo-subtle">
            Run <code>claude setup-token</code>, then paste the token here.
          </p>
          <div className="flex flex-wrap gap-2">
            <Input
              type="password"
              size="sm"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="Paste Claude subscription token"
              aria-label="Paste Claude subscription token"
              autoFocus
              disabled={saving}
              className="min-w-60 flex-1"
            />
            <Button
              variant="primary"
              size="sm"
              onClick={() => void handleSave()}
              loading={saving}
              disabled={saving || !value.trim()}
            >
              {saving ? 'Saving...' : 'Save'}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing(false);
                setValue('');
                setError(null);
              }}
              disabled={saving}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {error && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

export function billingModeAvailability(
  provider: 'Claude' | 'OpenAI',
  status: Pick<
    SetupStatus,
    | 'hasClaudeSubscription'
    | 'hasAnthropicKey'
    | 'hasChatGPTAuth'
    | 'chatgptAuthStatus'
    | 'hasOpenAIKey'
  >,
): {
  subscription: boolean;
  api: boolean;
  message: string | null;
} {
  const subscription =
    provider === 'Claude'
      ? status.hasClaudeSubscription
      : status.hasChatGPTAuth || status.chatgptAuthStatus !== 'missing';
  const api =
    provider === 'Claude' ? status.hasAnthropicKey : status.hasOpenAIKey;

  if (subscription && api) return { subscription, api, message: null };

  if (!subscription && !api) {
    return {
      subscription,
      api,
      message:
        provider === 'Claude'
          ? 'Add a Claude subscription token or Claude API key below to choose a billing mode.'
          : 'Connect a Codex subscription login or add an OpenAI API key below to choose a billing mode.',
    };
  }

  if (!subscription) {
    return {
      subscription,
      api,
      message:
        provider === 'Claude'
          ? 'Add a Claude subscription token below to enable Subscription.'
          : 'Connect a Codex subscription login below to enable Subscription.',
    };
  }

  return {
    subscription,
    api,
    message: `Add ${provider === 'Claude' ? 'a Claude' : 'an OpenAI'} API key below to enable API.`,
  };
}

function BillingModeSelector({
  provider,
  current,
  availability,
  saving,
  onChange,
}: {
  provider: 'Claude' | 'OpenAI';
  current: BillingMode | null;
  availability: ReturnType<typeof billingModeAvailability>;
  saving: boolean;
  onChange: (mode: BillingMode) => Promise<void>;
}) {
  const currentAvailable =
    current === 'subscription'
      ? availability.subscription
      : current === 'api'
        ? availability.api
        : false;
  const requirementId = `${provider.toLowerCase()}-billing-mode-requirement`;

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-kumo-default">
            {provider} billing mode
          </p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            {current
              ? currentAvailable
                ? `${current === 'subscription' ? 'Subscription' : 'API'} is active for new launch claims.`
                : `${current === 'subscription' ? 'Subscription' : 'API'} is selected, but its credential is missing.`
              : 'No mode selected yet.'}
          </p>
        </div>
        <Select
          aria-label={`${provider} billing mode`}
          aria-describedby={availability.message ? requirementId : undefined}
          className="w-[180px]"
          value={current ?? 'unselected'}
          onValueChange={(value) => {
            if (value === 'subscription' && availability.subscription)
              void onChange(value);
            if (value === 'api' && availability.api) void onChange(value);
          }}
          disabled={saving || (!availability.subscription && !availability.api)}
          renderValue={(value) =>
            value === 'subscription'
              ? 'Subscription'
              : value === 'api'
                ? 'API'
                : 'Not selected'
          }
        >
          <Select.Option value="unselected" disabled={current !== null}>
            Not selected
          </Select.Option>
          <Select.Option
            value="subscription"
            disabled={!availability.subscription}
          >
            Subscription
          </Select.Option>
          <Select.Option value="api" disabled={!availability.api}>
            API
          </Select.Option>
        </Select>
      </div>
      {availability.message && (
        <p id={requirementId} className="mt-2 text-xs text-kumo-subtle">
          {availability.message}
        </p>
      )}
    </div>
  );
}

function CodexSubscriptionRow({
  codexStatus,
  canonicalHubUrl,
}: {
  codexStatus: ReturnType<typeof codexSubscriptionStatus>;
  canonicalHubUrl: string;
}) {
  const badgeVariant =
    codexStatus.tone === 'success'
      ? 'success'
      : codexStatus.tone === 'warning'
        ? 'warning'
        : 'neutral';
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold text-kumo-default">
          Codex subscription
        </p>
        <Badge variant={badgeVariant} appearance="dot">
          {codexStatus.title}
        </Badge>
      </div>
      <p className="mt-1 text-xs text-kumo-subtle">{codexStatus.detail}</p>
      <CopyableTillerCliCommand
        command={`tiller auth connect codex --hub-url ${canonicalHubUrl}`}
        label="Codex"
      />
    </div>
  );
}

function OpenCodeInfoRow() {
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">
            Built-in OpenCode model
          </p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            {KIMI_K2_7_CODE.label} uses Tiller&apos;s built-in Workers AI
            binding through the hub proxy. OpenAI-backed OpenCode models use the
            OpenAI API key below.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="success" appearance="dot">
              Built in
            </Badge>
            <span className="text-xs text-kumo-subtle">
              Pinned to {KIMI_K2_7_CODE.label}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Idle timeout row ────────────────────────────────────────────

export function IdleTimeoutRow({
  currentMinutes,
  onSave,
}: {
  currentMinutes: number;
  onSave: (minutes: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(currentMinutes));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    const parsed = Number(value);
    if (!isCloudflareIdleTimeoutMinutes(parsed)) {
      setError(
        `Enter a value between ${CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES} and ${CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES} minutes.`,
      );
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed);
      setEditing(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-kumo-default">
            Idle timeout
          </p>
          <p className="mt-0.5 text-xs text-kumo-subtle">
            Minutes of inactivity before Cloudflare environments and newly
            started Cloudflare Scribes are stopped. This does not affect
            workloads on Your machine. Default:{' '}
            {CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES}.
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Badge variant="success" appearance="dot">
              {currentMinutes} {currentMinutes === 1 ? 'minute' : 'minutes'}
            </Badge>
          </div>
        </div>
        {!editing && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setValue(String(currentMinutes));
              setEditing(true);
              setError(null);
            }}
          >
            Change
          </Button>
        )}
      </div>

      {editing && (
        <div className="mt-3 flex gap-2">
          <Input
            type="number"
            size="sm"
            min={CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES}
            max={CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="Idle timeout in minutes"
            autoFocus
            disabled={saving}
            className="w-24"
          />
          <span className="self-center text-xs text-kumo-subtle">minutes</span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void handleSave()}
            loading={saving}
          >
            {saving ? 'Saving...' : 'Save'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            disabled={saving}
          >
            Cancel
          </Button>
        </div>
      )}

      {error && <p className="mt-2 text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

export function InstallationRegionRow({
  region,
}: {
  region: SetupStatus['installationRegion'];
}) {
  const definition = region ? placementRegionDefinition(region) : null;
  return (
    <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
      <p className="text-sm font-semibold text-kumo-default">
        Installation region
      </p>
      <p className="mt-2 text-sm text-kumo-strong">
        {definition
          ? `${definition.label} (${definition.code})`
          : 'Automatic (Cloudflare-managed)'}
      </p>
      <p className="mt-1 text-xs text-kumo-subtle">
        {definition
          ? 'Chosen during installation. Reinstall Tiller to change it.'
          : 'This legacy installation uses Cloudflare-managed placement. Reinstall Tiller to select a region.'}
      </p>
    </div>
  );
}

function ExecutionBackendCard({
  canonicalHubUrl,
}: {
  canonicalHubUrl: string;
}) {
  const [execution, setExecution] = useState<ExecutionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<'cf' | 'host' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const setupCommand = `(command -v tiller >/dev/null 2>&1 || ${TILLER_CLI_INSTALL_COMMAND}) && tiller host setup --hub-url ${canonicalHubUrl}`;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setExecution(await fetchExecutionStatus(HUB_URL));
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError),
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    const handleFocus = () => void refresh();
    window.addEventListener('focus', handleFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', handleFocus);
    };
  }, []);

  const select = async (target: 'cf' | 'host') => {
    if (!execution) return;
    setSaving(target);
    setError(null);
    try {
      const next =
        target === 'cf'
          ? await setExecutionBackend(HUB_URL, { target: 'cf' })
          : execution.candidate.state === 'ready'
            ? await setExecutionBackend(HUB_URL, {
                target: 'host',
                expectedMachineId: execution.candidate.machineId,
              })
            : null;
      if (next) setExecution(next);
    } catch (saveError) {
      setError(
        saveError instanceof Error ? saveError.message : String(saveError),
      );
      await refresh();
    } finally {
      setSaving(null);
    }
  };

  const candidateCopy =
    !execution || execution.candidate.state === 'not_connected'
      ? 'No compatible machine is connected.'
      : execution.candidate.state === 'ready'
        ? `${execution.candidate.displayName} is ready.`
        : `${execution.candidate.displayName} needs an update (${execution.candidate.code.replaceAll('_', ' ')}).`;
  const selectedHostCopy =
    execution?.selectedHost?.state === 'offline'
      ? `${execution.selectedHost.displayName} is selected but offline.`
      : execution?.selectedHost?.state === 'incompatible'
        ? `${execution.selectedHost.displayName} is selected but needs an update.`
        : execution?.selectedHost?.state === 'ready'
          ? `${execution.selectedHost.displayName} is selected and ready.`
          : null;
  const selectedMachineId =
    execution?.selected.target === 'host' ? execution.selected.machineId : null;
  const candidateSelected =
    execution?.candidate.state === 'ready' &&
    execution.candidate.machineId === selectedMachineId;

  return (
    <div className="grid gap-4">
      <div className="grid gap-3 md:grid-cols-2">
        <div
          className={`rounded-xl border px-4 py-3 ${
            execution?.selected.target === 'cf'
              ? 'border-kumo-success/40 bg-kumo-success-tint'
              : 'border-kumo-line bg-kumo-base'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-kumo-default">
                Cloudflare Containers
              </p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                Managed, with no machine to set up or keep online.
              </p>
            </div>
            {execution?.selected.target === 'cf' && (
              <Badge variant="success" appearance="dot">
                Selected
              </Badge>
            )}
          </div>
          {execution?.selected.target !== 'cf' && (
            <Button
              className="mt-3"
              variant="secondary"
              size="sm"
              loading={saving === 'cf'}
              disabled={loading || saving !== null}
              onClick={() => void select('cf')}
            >
              Use Cloudflare
            </Button>
          )}
        </div>

        <div
          className={`rounded-xl border px-4 py-3 ${
            execution?.selected.target === 'host'
              ? 'border-kumo-success/40 bg-kumo-success-tint'
              : 'border-kumo-line bg-kumo-base'
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-kumo-default">
                Your machine
              </p>
              <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                Can reduce compute costs, and will not shut down.
              </p>
            </div>
            {execution?.selected.target === 'host' && (
              <Badge
                variant={execution.executionReady ? 'success' : 'warning'}
                appearance="dot"
              >
                Selected
              </Badge>
            )}
          </div>
          <p className="mt-2 text-xs text-kumo-subtle">
            {selectedHostCopy ?? candidateCopy}
          </p>
          {selectedHostCopy &&
            execution?.candidate.state === 'ready' &&
            execution.candidate.machineId !== selectedMachineId && (
              <p className="mt-1 text-xs text-kumo-subtle">{candidateCopy}</p>
            )}
          {execution?.candidate.state === 'ready' && !candidateSelected && (
            <Button
              className="mt-3"
              variant="primary"
              size="sm"
              loading={saving === 'host'}
              disabled={loading || saving !== null}
              onClick={() => void select('host')}
            >
              Use this machine
            </Button>
          )}
        </div>
      </div>

      <div className="min-w-0 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-3">
        <p className="text-xs font-medium text-kumo-default">
          Connect a machine
        </p>
        <p className="mt-1 text-xs text-kumo-subtle">
          Run this in a terminal on that machine. It installs Tiller only if
          needed, then connects it.
        </p>
        <CopyableTerminalCommand
          command={setupCommand}
          label="machine setup"
          buttonLabel="Copy"
          viewLabel="View command"
        />
      </div>

      <p className="text-xs text-kumo-subtle">
        Changes apply only to new workloads. Delete and recreate a workload to
        use a different backend.
      </p>
      {loading && (
        <p className="text-xs text-kumo-subtle">
          Checking execution readiness...
        </p>
      )}
      {error && <p className="text-xs text-kumo-danger">{error}</p>}
    </div>
  );
}

// ── Settings page ────────────────────────────────────────────────

export default function SettingsPage({
  status,
  onDone,
  onRefresh,
  authConnectIntent = null,
}: SettingsPageProps) {
  const [testResults, setTestResults] = useState<
    Map<string, VerifyModelAuthResult>
  >(new Map());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [billingSaving, setBillingSaving] = useState<
    'claude' | 'openai' | null
  >(null);
  const activeSettingsTarget = useSettingsHashTarget();
  const addToast = useToast();
  const codexStatus = codexSubscriptionStatus(status);
  const opencodeVisible = status.enabledHarnesses.includes('opencode');
  const canonicalHubUrl = status.workersDevHubUrl ?? HUB_URL;
  const claudeBillingAvailability = billingModeAvailability('Claude', status);
  const openaiBillingAvailability = billingModeAvailability('OpenAI', status);

  const apiCredentials: CredentialDef[] = [
    {
      label: 'Claude API key',
      secretKey: 'ANTHROPIC_API_KEY',
      configured: status.hasAnthropicKey,
      active: status.claudeBillingMode === 'api',
      testable: false,
      settingsTarget: SETTINGS_TARGET_IDS.claudeApiKey,
    },
    {
      label: 'OpenAI API key',
      description: 'Use OpenAI-backed models with Codex or OpenCode.',
      secretKey: 'OPENAI_API_KEY',
      configured: status.hasOpenAIKey,
      active: status.openaiBillingMode === 'api',
      testable: false,
      settingsTarget: SETTINGS_TARGET_IDS.openaiApiKey,
    },
  ];

  async function handleSave(payload: Record<string, string>) {
    await submitSetup(HUB_URL, payload);
    await onRefresh();
    setTestResults((prev) => {
      const next = new Map(prev);
      for (const key of Object.keys(payload)) {
        next.delete(key);
      }
      return next;
    });
    addToast({ title: 'Credential saved', variant: 'success' });
  }

  async function handleBillingMode(
    provider: 'claude' | 'openai',
    mode: BillingMode,
  ) {
    setBillingSaving(provider);
    try {
      await saveBillingMode(HUB_URL, provider, mode);
      await onRefresh();
      addToast({
        title: `${provider === 'claude' ? 'Claude' : 'OpenAI'} ${mode === 'subscription' ? 'Subscription' : 'API'} mode active`,
        body: 'New launch profiles use this route. Running containers and retained Scribes stay pinned until recreated.',
        variant: 'success',
      });
    } catch (error) {
      addToast({
        title: `Could not change ${provider === 'claude' ? 'Claude' : 'OpenAI'} billing mode`,
        body: error instanceof Error ? error.message : String(error),
        variant: 'error',
      });
    } finally {
      setBillingSaving(null);
    }
  }

  async function handleTest() {
    const response = await verifyModelAuth(HUB_URL);
    const next = new Map<string, VerifyModelAuthResult>();
    for (const result of response.results) {
      next.set(result.key, result);
    }
    setTestResults(next);

    if (response.ok) {
      addToast({ title: 'All credentials valid', variant: 'success' });
    } else {
      const failed = response.results.filter((r) => !r.ok);
      addToast({
        title:
          failed.length > 0
            ? `${failed.length} credential(s) failed verification`
            : 'Verification failed',
        variant: 'error',
      });
    }
  }

  return (
    <div className="flex-1 overflow-y-auto bg-kumo-recessed">
      <div className="border-b border-kumo-line bg-kumo-base px-6 py-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-kumo-strong">
              Global Settings
            </h2>
            <p className="mt-1 text-sm text-kumo-subtle">
              {status.isLocalDev
                ? 'Manage model access for workloads on Your machine in this localhost Hub. Keep `tiller host` running when you want workloads to start.'
                : 'Manage model access and the execution backend for new workloads.'}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 px-6 py-8">
        {authConnectIntent && (
          <AuthConnectPanel intent={authConnectIntent} onRefresh={onRefresh} />
        )}
        {/*
        <Card
          title="Appearance"
          description="Choose how Tiller looks on this device. System follows your OS preference."
        >
          <AppearanceRow />
        </Card>
        */}

        <SettingsTargetRegion
          target={SETTINGS_TARGET_IDS.executionBackend}
          label="Execution backend settings"
          activeTarget={activeSettingsTarget}
        >
          <Card
            title="Execution backend"
            description="Choose where new workloads run."
            tone="default"
          >
            <ExecutionBackendCard canonicalHubUrl={canonicalHubUrl} />
          </Card>
        </SettingsTargetRegion>

        <SettingsTargetRegion
          target={SETTINGS_TARGET_IDS.modelAccess}
          label="Model access settings"
          activeTarget={activeSettingsTarget}
        >
          <Card
            title="Model access"
            description={
              status.modelAuthConfigured
                ? 'Manage model credentials. OpenCode includes Kimi through Workers AI and can also use OpenAI-backed models.'
                : 'Add credentials for Claude, Codex, or OpenAI-backed OpenCode models. Kimi uses the built-in Workers AI proxy.'
            }
            tone={status.modelAuthConfigured ? 'success' : 'warning'}
          >
            <div className="grid gap-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <SettingsTargetRegion
                  target={SETTINGS_TARGET_IDS.claudeBilling}
                  label="Claude billing settings"
                  activeTarget={activeSettingsTarget}
                >
                  <BillingModeSelector
                    provider="Claude"
                    current={status.claudeBillingMode}
                    availability={claudeBillingAvailability}
                    saving={billingSaving === 'claude'}
                    onChange={(mode) => handleBillingMode('claude', mode)}
                  />
                </SettingsTargetRegion>
                <SettingsTargetRegion
                  target={SETTINGS_TARGET_IDS.openaiBilling}
                  label="OpenAI billing settings"
                  activeTarget={activeSettingsTarget}
                >
                  <BillingModeSelector
                    provider="OpenAI"
                    current={status.openaiBillingMode}
                    availability={openaiBillingAvailability}
                    saving={billingSaving === 'openai'}
                    onChange={(mode) => handleBillingMode('openai', mode)}
                  />
                </SettingsTargetRegion>
              </div>
              <p className="text-xs text-kumo-subtle">
                Saving a credential does not activate it. Mode changes apply to
                newly claimed launch profiles; running containers and retained
                Scribe runtimes remain pinned until recreated.
              </p>
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">
                  API Keys
                </p>
                <div className="mt-3 grid gap-3">
                  {opencodeVisible && <OpenCodeInfoRow />}
                  {apiCredentials.map((def) => (
                    <SettingsTargetRegion
                      key={def.secretKey}
                      target={def.settingsTarget}
                      label={`${def.label} settings`}
                      activeTarget={activeSettingsTarget}
                    >
                      <CredentialRow
                        def={def}
                        testResult={testResults.get(def.secretKey) ?? null}
                        onSave={handleSave}
                        onTest={handleTest}
                      />
                    </SettingsTargetRegion>
                  ))}
                </div>
              </div>

              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">
                    Subscriptions
                  </p>
                  <span className="text-xs text-kumo-subtle">
                    No Tiller install needed.
                  </span>
                </div>
                <div className="mt-3 grid gap-3">
                  <SettingsTargetRegion
                    target={SETTINGS_TARGET_IDS.claudeSubscription}
                    label="Claude subscription settings"
                    activeTarget={activeSettingsTarget}
                  >
                    <ClaudeSubscriptionRow
                      status={status}
                      canonicalHubUrl={canonicalHubUrl}
                      onSave={handleSave}
                    />
                  </SettingsTargetRegion>
                  <SettingsTargetRegion
                    target={SETTINGS_TARGET_IDS.codexSubscription}
                    label="Codex subscription settings"
                    activeTarget={activeSettingsTarget}
                  >
                    <CodexSubscriptionRow
                      codexStatus={codexStatus}
                      canonicalHubUrl={canonicalHubUrl}
                    />
                  </SettingsTargetRegion>
                </div>
              </div>
            </div>
          </Card>
        </SettingsTargetRegion>

        <LayerCard render={<section />} className="p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-kumo-strong">
                Advanced
              </h3>
              <p className="mt-1 text-sm text-kumo-subtle">
                Cloudflare environment lifecycle settings.
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={advancedOpen}
              onClick={() => setAdvancedOpen((value) => !value)}
            >
              {advancedOpen ? 'Hide advanced' : 'Show advanced'}
            </Button>
          </div>
          {advancedOpen && (
            <div className="mt-4 grid gap-3">
              {shouldShowInstallationRegion(status) && (
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">
                    Installation
                  </p>
                  <div className="mt-3 grid gap-3">
                    <InstallationRegionRow region={status.installationRegion} />
                  </div>
                </div>
              )}
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">
                  Cloudflare auto-stop
                </p>
                <div className="mt-3 grid gap-3">
                  <IdleTimeoutRow
                    currentMinutes={status.idleTimeoutMinutes}
                    onSave={async (minutes) => {
                      await submitSetup(HUB_URL, {
                        IDLE_TIMEOUT_MINUTES: String(minutes),
                      });
                      await onRefresh();
                      addToast({
                        title: 'Idle timeout updated',
                        variant: 'success',
                      });
                    }}
                  />
                </div>
              </div>
            </div>
          )}
        </LayerCard>

        {status.isLocalDev && (
          <Card
            title="Localhost hub"
            description="This localhost Hub is contributor-only and supports Your machine for local development."
            tone="default"
          >
            <div className="rounded-xl border border-kumo-line bg-kumo-base px-4 py-4">
              <p className="text-sm font-semibold text-kumo-default">
                Browser-first host flow
              </p>
              <p className="mt-2 text-xs text-kumo-subtle">
                Keep <code>npm run dev</code> running here, then start{' '}
                <code>tiller host</code> in a second terminal when you want
                environments to boot. Host Docker containers call back to this
                hub through
                <code>host.docker.internal</code>.
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
