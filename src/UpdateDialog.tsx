import React, { useEffect, useRef, useState } from 'react';
import { applyCloudflareRepairUpdate, applyUpdate, checkForUpdate, detectSelfUpdateRepo, selectSelfUpdateRepo } from './api';
import type { HubUpdateRepoCandidate, UpdateCheckResult } from './api';
import { useToast } from './Toast';
import { formatUpdateName } from './update-display';

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
  issueCode?: string | null;
  isChecking: boolean;
  onDismiss: () => void;
  onOpenSettings: () => void;
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
  issueCode,
  isChecking,
  onDismiss,
  onOpenSettings,
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
  }, [status?.latestUpdate.sourceId]);

  useEffect(() => () => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
    }
  }, []);

  async function waitForDeployment(expectedSourceId: string) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 3000));
      const next = await checkForUpdate(hubUrl);
      if (next.currentUpdate.sourceId === expectedSourceId) {
        return true;
      }
    }
    return false;
  }

  async function handleDetectRepo() {
    setIsApplying(true);
    setError(null);
    try {
      const result = await detectSelfUpdateRepo(hubUrl);
      addToast({
        title: result.status === 'detected'
          ? 'Self-update repo connected'
          : result.status === 'ambiguous'
            ? 'Choose self-update repo'
            : 'Self-update repo not found',
        body: result.status === 'detected'
          ? result.fullName
          : result.status === 'ambiguous'
            ? 'Multiple selected repositories contain Tiller update metadata.'
            : 'No selected GitHub App repository contains Tiller deploy-button metadata.',
        variant: result.status === 'detected' ? 'success' : 'warning',
      });
      onRetryCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Self-update repo detection failed';
      setError(message);
      addToast({ title: 'Detection failed', body: message, variant: 'error' });
    } finally {
      setIsApplying(false);
    }
  }

  async function handleSelectCandidate(candidate: HubUpdateRepoCandidate) {
    setIsApplying(true);
    setError(null);
    try {
      const result = await selectSelfUpdateRepo(hubUrl, candidate);
      if (result.status !== 'detected') {
        throw new Error('Self-update repo selection did not persist.');
      }
      addToast({
        title: 'Self-update repo connected',
        body: result.fullName,
        variant: 'success',
      });
      onRetryCheck();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Self-update repo selection failed';
      setError(message);
      addToast({ title: 'Selection failed', body: message, variant: 'error' });
    } finally {
      setIsApplying(false);
    }
  }

  async function handleUpdateNow() {
    if (!status) {
      return;
    }

    if (status.updateMethod !== 'github_repo') {
      setError(status.issue?.message ?? 'Connect the self-update repo before applying a normal update.');
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
      const result = await applyUpdate(hubUrl);
      if (intervalRef.current != null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (result.status === 'queued') {
        setStage('deploying');
        addToast({
          title: 'Update queued',
          body: 'Cloudflare is deploying the committed hub update.',
          variant: 'success',
        });
        const deployed = await waitForDeployment(result.expectedSourceId);
        if (!deployed) {
          throw new Error('Update was committed, but this Worker has not reported the new source id yet.');
        }
      }
      setStage('complete');
      setIsApplying(false);
      addToast({
        title: result.status === 'noop' ? 'No update needed' : 'Update deployed',
        body: result.status === 'noop'
          ? 'The configured hub repo already matches upstream.'
          : 'Reload to use the new Tiller Hub build.',
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

  async function handleAdvancedRepair() {
    if (!apiToken.trim()) {
      setError('Cloudflare API token is required for Advanced Repair.');
      setStage('error');
      return;
    }
    setIsApplying(true);
    setError(null);
    setStage(PROGRESS_STAGES[0]);
    try {
      await applyCloudflareRepairUpdate(hubUrl, apiToken.trim());
      setStage('complete');
      setIsApplying(false);
      addToast({
        title: 'Repair deployed',
        body: 'Reload to use the repaired Tiller Hub build.',
        variant: 'success',
      });
      onUpdated();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Advanced Repair failed';
      setStage('error');
      setIsApplying(false);
      setError(message);
      addToast({
        title: 'Repair failed',
        body: message,
        variant: 'error',
      });
    }
  }

  if (!status) {
    const accessRequired = issueCode === 'setup_protection_required';
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
                  {accessRequired ? 'Access verification required' : 'Update check unavailable'}
                </h1>
                <p className="mt-2 text-sm text-[#57606a]">
                  {accessRequired
                    ? 'Tiller Hub blocked the self-update check because this workers.dev deployment has not saved its Cloudflare Access configuration yet.'
                    : 'Tiller Hub could not determine the latest upstream update metadata, so the update prompt is unavailable. This does not block normal hub usage.'}
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
              <p className="text-sm font-semibold text-[#24292f]">
                {accessRequired ? 'What to do' : 'Likely cause'}
              </p>
              <p className="mt-1 text-sm text-[#57606a]">
                {accessRequired
                  ? 'Open Settings, reload through Cloudflare Access, then verify Access. After Tiller saves the Access JWT metadata, retry the update check.'
                  : 'If the public deploy-button repo is temporarily unavailable, this warning is expected.'}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {accessRequired && (
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="rounded-lg bg-[#24292f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-black"
                >
                  Open Settings
                </button>
              )}
              <button
                type="button"
                onClick={onRetryCheck}
                disabled={isChecking}
                className={`${accessRequired ? 'border border-[#d0d7de] bg-white text-[#24292f] hover:bg-[#f6f8fa]' : 'bg-[#24292f] text-white hover:bg-black'} rounded-lg px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50`}
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

  const currentUpdateName = formatUpdateName(status.currentUpdate);
  const latestUpdateName = formatUpdateName(status.latestUpdate);

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
                This deployment is currently running <strong>{currentUpdateName}</strong>.
                {' '}The latest available version is <strong>{latestUpdateName}</strong>.
              </p>
            </div>
            <a
              href={status.releaseNotesUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa]"
            >
              Source repo
            </a>
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] p-4">
              <p className="text-sm font-semibold text-[#24292f]">Self-update repository</p>
              <p className="mt-1 text-xs text-[#57606a]">
                {status.hubRepo.status === 'detected'
                  ? `${status.hubRepo.fullName} · ${status.hubRepo.branch}`
                  : status.hubRepo.status === 'ambiguous'
                    ? 'Multiple selected repositories contain Tiller update metadata.'
                    : 'Connect the generated deploy-button repo to update through GitHub.'}
              </p>
              {status.hubRepo.status === 'ambiguous' && (
                <div className="mt-3 grid gap-2">
                  {status.hubRepo.candidates.map((candidate) => (
                    <button
                      key={`${candidate.repoId}:${candidate.branch}`}
                      type="button"
                      onClick={() => void handleSelectCandidate(candidate)}
                      disabled={isApplying}
                      className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-left text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
                    >
                      {candidate.label}
                    </button>
                  ))}
                </div>
              )}
              {status.hubRepo.status !== 'detected' && (
                <button
                  type="button"
                  onClick={() => void handleDetectRepo()}
                  disabled={isApplying}
                  className="mt-3 rounded border border-[#0969da] bg-white px-3 py-1.5 text-xs font-medium text-[#0969da] transition-colors hover:bg-[#ddf4ff] disabled:opacity-50"
                >
                  Connect self-update repo
                </button>
              )}
            </div>

            <div className="rounded-xl border border-[#d0d7de] bg-[#f6f8fa] p-4">
              <p className="text-sm font-semibold text-[#24292f]">Advanced Repair</p>
              <p className="mt-1 text-xs text-[#57606a]">
                Repair by redeploying with a temporary Cloudflare API token.
              </p>
              <input
                id="cf-api-token"
                type="password"
                value={apiToken}
                onChange={(event) => setApiToken(event.target.value)}
                placeholder="Paste Cloudflare token"
                className="mt-3 w-full rounded-lg border border-[#d0d7de] bg-white px-3 py-2 text-sm text-[#24292f] outline-none transition-colors focus:border-[#0969da]"
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void handleAdvancedRepair()}
                  disabled={isApplying || !apiToken.trim()}
                  className="rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#24292f] transition-colors hover:bg-[#f6f8fa] disabled:opacity-50"
                >
                  Advanced Repair
                </button>
                <a
                  href={CLOUDFLARE_TOKEN_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex rounded border border-[#d0d7de] bg-white px-3 py-1.5 text-xs font-medium text-[#0969da] transition-colors hover:bg-[#f6f8fa]"
                >
                  Token settings
                </a>
              </div>
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
              disabled={isApplying || stage === 'complete' || status.updateMethod !== 'github_repo'}
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
