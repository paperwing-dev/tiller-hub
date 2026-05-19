import { useEffect, useRef, useState } from 'react';
import { applyUpdate } from './api';
import type { UpdateCheckResult } from './api';
import { useToast } from './Toast';

const CLOUDFLARE_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';
const REQUIRED_PERMISSIONS = [
  'Workers Scripts:Edit',
  'Account Settings:Read',
  'Zone:Read',
  'Workers KV Storage:Edit',
  'Workers R2 Storage:Edit',
] as const;
const PROGRESS_STAGES = [
  'resolving-account',
  'checking-bindings',
  'creating-resources',
  'updating-containers',
  'uploading-assets',
  'deploying',
] as const;

type ProgressStage =
  | 'idle'
  | (typeof PROGRESS_STAGES)[number]
  | 'complete'
  | 'error';

interface UpdateDialogProps {
  hubUrl: string;
  status: UpdateCheckResult | null;
  issue: string | null;
  isChecking: boolean;
  onDismiss: () => void;
  onRetryCheck: () => void;
  onUpdated: () => void;
}

function formatStage(stage: ProgressStage): string {
  switch (stage) {
    case 'idle':
      return 'Ready to apply the latest release.';
    case 'resolving-account':
      return 'Resolving Cloudflare account and Worker ownership.';
    case 'checking-bindings':
      return 'Checking current bindings and compatibility.';
    case 'creating-resources':
      return 'Creating any missing KV namespaces or R2 buckets.';
    case 'updating-containers':
      return 'Reconciling the SandboxDO container application.';
    case 'uploading-assets':
      return 'Uploading static assets for the new release.';
    case 'deploying':
      return 'Deploying the updated Worker bundle.';
    case 'complete':
      return 'Update complete. Reload to start serving the new build.';
    case 'error':
      return 'Update failed. Review the error details below.';
    default:
      return stage;
  }
}

export default function UpdateDialog({
  hubUrl,
  status,
  issue,
  isChecking,
  onDismiss,
  onRetryCheck,
  onUpdated,
}: UpdateDialogProps) {
  const addToast = useToast();
  const [apiToken, setApiToken] = useState('');
  const [stage, setStage] = useState<ProgressStage>('idle');
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (!status) {
      setApiToken('');
      setStage('idle');
      setIsApplying(false);
      setError(null);
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    setApiToken('');
    setStage('idle');
    setIsApplying(false);
    setError(null);
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, [status?.latestVersion]);

  useEffect(() => () => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
    }
  }, []);

  async function handleUpdateNow() {
    if (!status) {
      return;
    }

    if (!apiToken.trim()) {
      setError('Cloudflare API token is required.');
      setStage('error');
      return;
    }

    setIsApplying(true);
    setError(null);
    setStage(PROGRESS_STAGES[0]);
    intervalRef.current = window.setInterval(() => {
      setStage((current) => {
        const currentIndex = PROGRESS_STAGES.indexOf(current as (typeof PROGRESS_STAGES)[number]);
        if (currentIndex < 0) return PROGRESS_STAGES[0];
        if (currentIndex >= PROGRESS_STAGES.length - 1) return current;
        return PROGRESS_STAGES[currentIndex + 1];
      });
    }, 1400);

    try {
      await applyUpdate(hubUrl, apiToken.trim());
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setStage('complete');
      setIsApplying(false);
      addToast({
        title: 'Hub updated',
        body: `Tiller Hub ${status.latestVersion} is ready to reload.`,
        variant: 'success',
      });
      onUpdated();
    } catch (err) {
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      const message = err instanceof Error ? err.message : 'Update failed';
      setStage('error');
      setIsApplying(false);
      setError(message);
      addToast({
        title: 'Update failed',
        body: message,
        variant: 'error',
      });
    }
  }

  if (!status) {
    return (
      <div className="flex-1 overflow-auto bg-[#f6f8fa]">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
          <section className="rounded-2xl border border-[#d0d7de] bg-white p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#57606a]">
                  Self-Update
                </p>
                <h1 className="mt-2 text-2xl font-semibold text-[#24292f]">
                  Update check unavailable
                </h1>
                <p className="mt-2 text-sm text-[#57606a]">
                  Tiller Hub could not determine the latest upstream release, so the update prompt is unavailable.
                  This does not block normal hub usage.
                </p>
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-[#cf222e]/20 bg-[#ffebe9] px-4 py-3">
              <p className="text-sm font-semibold text-[#24292f]">Issue</p>
              <p className="mt-1 text-sm text-[#cf222e]">
                {issue ?? 'Self-update check failed.'}
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-[#d0d7de] bg-[#f6f8fa] px-4 py-3">
              <p className="text-sm font-semibold text-[#24292f]">Likely cause</p>
              <p className="mt-1 text-sm text-[#57606a]">
                If <code>paperwing-dev/tiller-hub</code> is private or does not have a published GitHub release yet,
                this warning is expected.
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={onRetryCheck}
                disabled={isChecking}
                className="rounded-lg bg-[#24292f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isChecking ? 'Checking...' : 'Retry check'}
              </button>
              <button
                type="button"
                onClick={onDismiss}
                className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
              >
                Close
              </button>
            </div>
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto bg-[#f6f8fa]">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
        <section className="rounded-2xl border border-[#d0d7de] bg-white p-6 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#57606a]">
                Self-Update
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-[#24292f]">
                Upgrade Tiller Hub
              </h1>
              <p className="mt-2 text-sm text-[#57606a]">
                This deployment is currently running <strong>{status.currentVersion}</strong>.
                {' '}The latest upstream release is <strong>{status.latestVersion}</strong>.
              </p>
            </div>
            <a
              href={status.releaseNotesUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              Release notes
            </a>
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] p-4">
              <label htmlFor="cf-api-token" className="text-sm font-semibold text-[#24292f]">
                Cloudflare API token
              </label>
              <p className="mt-1 text-xs text-[#57606a]">
                The token is used once for this update and is not stored by Tiller.
              </p>
              <input
                id="cf-api-token"
                type="password"
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                placeholder="Paste token"
                autoFocus
                className="mt-3 w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] outline-none transition-colors focus:border-[#0969da]"
              />
              <a
                href={CLOUDFLARE_TOKEN_URL}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex text-xs font-medium text-[#0969da] hover:underline"
              >
                Open Cloudflare API token settings
              </a>
            </div>

            <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] p-4">
              <p className="text-sm font-semibold text-[#24292f]">Required permissions</p>
              <ul className="mt-3 space-y-2 text-xs text-[#57606a]">
                {REQUIRED_PERMISSIONS.map((permission) => (
                  <li key={permission} className="flex items-start gap-2">
                    <span className="mt-1 h-1.5 w-1.5 rounded-full bg-[#d4a72c]" />
                    <span>{permission}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <div className="mt-5 rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
            <p className="text-sm font-semibold text-[#24292f]">Progress</p>
            <p className="mt-1 text-sm text-[#57606a]">{formatStage(stage)}</p>
            {error && (
              <p className="mt-3 rounded-lg border border-[#cf222e]/20 bg-[#ffebe9] px-3 py-2 text-sm text-[#cf222e]">
                {error}
              </p>
            )}
          </div>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void handleUpdateNow()}
              disabled={isApplying || stage === 'complete'}
              className="rounded-lg bg-[#24292f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isApplying ? 'Updating...' : 'Update Now'}
            </button>
            {stage === 'complete' && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
              >
                Reload
              </button>
            )}
            <button
              type="button"
              onClick={onDismiss}
              className="rounded-lg border border-[#d0d7de] bg-white px-4 py-2 text-sm font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              Dismiss
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
