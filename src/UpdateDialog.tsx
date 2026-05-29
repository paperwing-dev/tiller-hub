import React, { useEffect, useRef, useState } from 'react';
import { applyUpdate, checkForUpdate, detectSelfUpdateRepo, selectSelfUpdateRepo } from './api';
import type { HubUpdateRepoCandidate, UpdateCheckResult } from './api';
import { useToast } from './Toast';
import { formatUpdateName } from './update-display';

const PROGRESS_STAGES = [
  'resolving-account',
  'checking-bindings',
  'creating-resources',
  'updating-containers',
  'uploading-assets',
  'deploying',
] as const;

const AUTO_RELOAD_DELAY_MS = 1200;

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
      return 'Update complete.';
    case 'error':
      return 'Update failed. Review the error details below.';
    default:
      return stage;
  }
}

function visibleGitHubOwnersForUpdateRepo(status: UpdateCheckResult['hubRepo']): string[] {
  return status.status === 'missing' ? status.visibleGitHubOwners : [];
}

function formatVisibleGitHubOwners(owners: string[]): string {
  if (owners.length === 0) return 'no GitHub owners';
  if (owners.length === 1) return owners[0];
  return owners.join(', ');
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
  const [stage, setStage] = useState<ProgressStage>('idle');
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoReloadScheduled, setAutoReloadScheduled] = useState(false);
  const intervalRef = useRef<number | null>(null);
  const reloadTimeoutRef = useRef<number | null>(null);

  function clearProgressTimer() {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }

  function clearReloadTimer() {
    if (reloadTimeoutRef.current != null) {
      window.clearTimeout(reloadTimeoutRef.current);
      reloadTimeoutRef.current = null;
    }
  }

  useEffect(() => {
    if (!status) {
      setStage('idle');
      setIsApplying(false);
      setError(null);
      setAutoReloadScheduled(false);
      clearProgressTimer();
      clearReloadTimer();
      return;
    }

    setStage('idle');
    setIsApplying(false);
    setError(null);
    setAutoReloadScheduled(false);
    clearProgressTimer();
    clearReloadTimer();
  }, [status?.latestUpdate.sourceId]);

  useEffect(() => () => {
    clearProgressTimer();
    clearReloadTimer();
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

  async function handleGitHubRepoUpdate() {
    if (!status) {
      return;
    }

    if (status.updateMethod !== 'github_repo') {
      const message = status.hubRepo.status === 'ambiguous'
        ? 'Choose the self-update repository before updating.'
        : 'Connect the generated deploy-button repo before updating. If Cloudflare is using a different GitHub account, install the Tiller GitHub App on that same account or repo.';
      setError(message);
      addToast({
        title: 'Self-update repo not connected',
        body: message,
        variant: 'warning',
      });
      return;
    }

    setIsApplying(true);
    setError(null);
    setAutoReloadScheduled(false);
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
      clearProgressTimer();
      if (!result.ok) {
        throw new Error(result.error);
      }
      let shouldReload = false;
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
        shouldReload = true;
      }
      setStage('complete');
      setIsApplying(false);
      setAutoReloadScheduled(shouldReload);
      addToast({
        title: result.status === 'noop' ? 'No update needed' : 'Update deployed',
        body: result.status === 'noop'
          ? 'The configured hub repo already matches upstream.'
          : 'Reloading to use the new Tiller Hub build.',
        variant: 'success',
      });
      onUpdated();
      if (shouldReload) {
        clearReloadTimer();
        reloadTimeoutRef.current = window.setTimeout(() => {
          window.location.reload();
        }, AUTO_RELOAD_DELAY_MS);
      }
    } catch (err) {
      clearProgressTimer();
      clearReloadTimer();
      const message = err instanceof Error ? err.message : 'Update failed';
      setStage('error');
      setIsApplying(false);
      setAutoReloadScheduled(false);
      setError(message);
      addToast({
        title: 'Update failed',
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
  const visibleUpdateRepoOwners = visibleGitHubOwnersForUpdateRepo(status.hubRepo);
  const showProgress = stage !== 'idle';
  const sameUpdateName = currentUpdateName === latestUpdateName;
  const isDevelopmentBuild = status.buildDiagnostics.channel === 'development';

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
                {status.updateAvailable && sameUpdateName ? (
                  <>
                    This deployment is running <strong>{currentUpdateName}</strong>.
                    {' '}A newer source build is available for the same version.
                  </>
                ) : isDevelopmentBuild ? (
                  <>
                    This deployment is running a development build from <strong>{currentUpdateName}</strong>.
                  </>
                ) : (
                  <>
                    This deployment is currently running <strong>{currentUpdateName}</strong>.
                    {' '}The latest available version is <strong>{latestUpdateName}</strong>.
                  </>
                )}
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

          {isDevelopmentBuild && (
            <div className="mt-6 rounded-xl border border-[#d0d7de] bg-[#f6f8fa] px-4 py-3">
              <p className="text-sm font-semibold text-[#24292f]">Development build</p>
              <p className="mt-1 text-sm text-[#57606a]">
                Dogfood deployments use the development deploy path. Release self-update is disabled for this build.
              </p>
            </div>
          )}

          {!isDevelopmentBuild && (
            <div className="mt-6 rounded-xl border border-[#d0d7de] bg-[#f6f8fa] p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-[#24292f]">Update source</p>
                  <p className="mt-1 text-xs leading-5 text-[#57606a]">
                    Tiller updates by committing the latest hub source into the deploy-button repo connected to Cloudflare Builds.
                  </p>
                </div>
                {status.hubRepo.status === 'detected' && (
                  <span className="w-fit rounded-full border border-[#1a7f37]/20 bg-[#dafbe1] px-2 py-0.5 text-xs font-medium text-[#1a7f37]">
                    Connected
                  </span>
                )}
              </div>

              <div className="mt-4 border-t border-[#d0d7de] pt-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#57606a]">Repository</p>
                <p className="mt-1 text-xs leading-5 text-[#57606a]">
                  {status.hubRepo.status === 'detected'
                    ? `${status.hubRepo.fullName} · ${status.hubRepo.branch}`
                    : status.hubRepo.status === 'ambiguous'
                      ? 'Multiple selected repositories contain Tiller update metadata.'
                      : 'No generated deploy-button repo is connected yet.'}
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
                {status.hubRepo.status === 'missing' && (
                  <div className="mt-3 rounded-lg border border-[#d4a72c]/30 bg-[#fff8c5] px-3 py-2">
                    <p className="text-xs font-semibold text-[#9a6700]">Check the GitHub account</p>
                    <p className="mt-1 text-xs leading-5 text-[#57606a]">
                      Cloudflare must deploy this Worker from a repo under the same GitHub user or org selected for the Tiller GitHub App.
                      {visibleUpdateRepoOwners.length > 0
                        ? ` Tiller can currently see ${formatVisibleGitHubOwners(visibleUpdateRepoOwners)}.`
                        : ' Tiller cannot currently see any selected GitHub App repositories.'}
                      {' '}Open Cloudflare Worker Settings &gt; Builds and compare the connected repo owner.
                    </p>
                  </div>
                )}
                {status.hubRepo.status !== 'detected' && (
                  <button
                    type="button"
                    onClick={() => void handleDetectRepo()}
                    disabled={isApplying}
                    className="mt-3 rounded border border-[#0969da] bg-white px-3 py-1.5 text-xs font-medium text-[#0969da] transition-colors hover:bg-[#ddf4ff] disabled:opacity-50"
                  >
                    Check GitHub repos
                  </button>
                )}
              </div>
            </div>
          )}

          {showProgress && (
            <div className="mt-5 rounded-xl border border-[#d0d7de] bg-white px-4 py-3">
              <p className="text-sm font-semibold text-[#24292f]">Progress</p>
              <p className="mt-1 text-sm text-[#57606a]">
                {stage === 'complete' && autoReloadScheduled
                  ? 'Update complete. Reloading to start serving the new build.'
                  : formatStage(stage)}
              </p>
              {error && (
                <p className="mt-3 rounded-lg border border-[#cf222e]/20 bg-[#ffebe9] px-3 py-2 text-sm text-[#cf222e]">
                  {error}
                </p>
              )}
            </div>
          )}

          {error && !showProgress && (
            <p className="mt-5 rounded-lg border border-[#cf222e]/20 bg-[#ffebe9] px-3 py-2 text-sm text-[#cf222e]">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {!isDevelopmentBuild && (
              <button
                type="button"
                onClick={() => void handleGitHubRepoUpdate()}
                disabled={isApplying || stage === 'complete'}
                className="rounded-lg bg-[#24292f] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-black disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isApplying ? 'Updating...' : 'Update'}
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
