import React, { useEffect, useRef, useState } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import { Dialog } from '@cloudflare/kumo/components/dialog';
import { applyUpdate, checkForUpdate, detectSelfUpdateRepo, selectSelfUpdateRepo } from './api';
import type { HubUpdateRepoCandidate, LegacyUpdateCheckResult, UpdateCheckResult } from './api';
import { useToast } from './Toast';
import { formatUpdateName, formatUpdateVersion } from './update-display';
import { installerMaintenanceAction } from './installer-maintenance';

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
  hasExecutionMachine: boolean;
  renewalRecommended?: boolean;
  onDismiss: () => void;
  onOpenSettings: () => void;
  onRetryCheck: () => void;
  onUpdated: () => void;
}

function UpdateModal({
  title,
  description,
  onClose,
  children,
}: {
  title: string;
  description: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog
        size="lg"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-3xl flex-col overflow-hidden p-0"
      >
        <Dialog.Title className="sr-only">{title}</Dialog.Title>
        <Dialog.Description className="sr-only">{description}</Dialog.Description>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </Dialog>
    </Dialog.Root>
  );
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

function visibleGitHubOwnersForUpdateRepo(status: LegacyUpdateCheckResult['hubRepo']): string[] {
  return status.status === 'missing' ? status.visibleGitHubOwners : [];
}

function formatVisibleGitHubOwners(owners: string[]): string {
  if (owners.length === 0) return 'no GitHub owners';
  if (owners.length === 1) return owners[0];
  return owners.join(', ');
}

function updateResultIdentity(status: UpdateCheckResult | null): string | null {
  if (!status) return null;
  return status.kind === 'installer-maintenance'
    ? status.stableRelease?.releaseId ?? status.installedReleaseId
    : status.latestUpdate.sourceId;
}

export default function UpdateDialog({
  hubUrl,
  status,
  issue,
  issueCode,
  isChecking,
  hasExecutionMachine,
  renewalRecommended = false,
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
  }, [updateResultIdentity(status)]);

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
    if (!status || status.kind !== 'legacy') {
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

  if (!status && isChecking && !issue) {
    return (
      <UpdateModal
        title="Checking for updates"
        description="Tiller Hub is checking for a stable release."
        onClose={onDismiss}
      >
        <section className="p-6">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-kumo-subtle">
            Tiller maintenance
          </p>
          <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">
            Checking for updates
          </h1>
          <p className="mt-2 text-sm text-kumo-subtle">
            Tiller Hub is checking the current deployment against the latest stable release.
          </p>
        </section>
      </UpdateModal>
    );
  }

  if (!status) {
    const accessRequired = issueCode === 'setup_protection_required';
    const heading = accessRequired ? 'Access verification required' : 'Update check unavailable';
    return (
      <UpdateModal
        title={heading}
        description={issue ?? 'Tiller could not check for updates.'}
        onClose={onDismiss}
      >
          <section className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-kumo-subtle">
                  Self-Update
                </p>
                <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">
                  {heading}
                </h1>
                <p className="mt-2 text-sm text-kumo-subtle">
                  {accessRequired
                    ? 'Tiller Hub blocked the self-update check because this workers.dev deployment has not saved its Cloudflare Access configuration yet.'
                    : 'Tiller Hub could not determine the latest upstream update metadata, so the update prompt is unavailable. This does not block normal hub usage.'}
                </p>
              </div>
            </div>

            <div className="mt-6 rounded-xl border border-kumo-danger/20 bg-kumo-danger-tint px-4 py-3">
              <p className="text-sm font-semibold text-kumo-default">Issue</p>
              <p className="mt-1 text-sm text-kumo-danger">
                {issue ?? 'Self-update check failed.'}
              </p>
            </div>

            <div className="mt-4 rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3">
              <p className="text-sm font-semibold text-kumo-default">
                {accessRequired ? 'What to do' : 'Likely cause'}
              </p>
              <p className="mt-1 text-sm text-kumo-subtle">
                {accessRequired
                  ? 'Open Settings, reload through Cloudflare Access, then verify Access. After Tiller saves the Access JWT metadata, retry the update check.'
                  : 'If the public deploy-button repo is temporarily unavailable, this warning is expected.'}
              </p>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {accessRequired && (
                <Button type="button" variant="primary" onClick={onOpenSettings}>
                  Open Settings
                </Button>
              )}
              <Button
                type="button"
                variant={accessRequired ? 'secondary' : 'primary'}
                onClick={onRetryCheck}
                loading={isChecking}
              >
                {isChecking ? 'Checking...' : 'Retry check'}
              </Button>
              <Button type="button" variant="secondary" onClick={onDismiss}>
                Close
              </Button>
            </div>
          </section>
      </UpdateModal>
    );
  }

  const currentUpdateName = formatUpdateName(status.currentUpdate);
  const isDevelopmentBuild = status.buildDiagnostics.channel === 'development';
  if (status.kind === 'installer-maintenance') {
    const stableUpdateName = status.stableRelease
      ? formatUpdateVersion(status.stableRelease.version)
      : null;
    const action = isDevelopmentBuild ? null : installerMaintenanceAction({
      updateAvailable: status.updateAvailable,
      latestVersion: status.stableRelease?.version ?? '',
      renewAccess: renewalRecommended,
    });
    const heading = isDevelopmentBuild
      ? 'Development build'
      : action?.label ?? (status.stableRelease ? 'Tiller is up to date' : 'Stable release check unavailable');
    return (
      <UpdateModal
        title={heading}
        description="Review and start Tiller maintenance."
        onClose={onDismiss}
      >
          <section className="p-6">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-kumo-subtle">
              Tiller maintenance
            </p>
            <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">
              {heading}
            </h1>
            <p className="mt-2 text-sm text-kumo-subtle">
              {isDevelopmentBuild
                ? <>This Hub is running a development build from <strong>{currentUpdateName}</strong>.</>
                : status.updateAvailable && stableUpdateName
                  ? <>This Hub is running <strong>{currentUpdateName}</strong>. The stable release is <strong>{stableUpdateName}</strong>.</>
                  : status.stableRelease
                    ? <>This Hub is running the current stable release, <strong>{currentUpdateName}</strong>.</>
                    : <>Tiller could not load the current stable release. The deployed Hub remains on <strong>{currentUpdateName}</strong>.</>}
            </p>

            {renewalRecommended && (
              <div className="mt-5 rounded-xl border border-kumo-warning/30 bg-kumo-warning-tint px-4 py-3">
                <p className="text-sm font-semibold text-kumo-default">Access renewal recommended</p>
                <p className="mt-1 text-sm text-kumo-subtle">
                  Renew Access to keep CLI, execution-machine, and workload connections active.
                </p>
              </div>
            )}

            {issue && (
              <div className="mt-5 rounded-xl border border-kumo-warning/30 bg-kumo-warning-tint px-4 py-3">
                <p className="text-sm font-semibold text-kumo-default">Stable release check unavailable</p>
                <p className="mt-1 text-sm text-kumo-subtle">{issue}</p>
              </div>
            )}

            {hasExecutionMachine && status.updateAvailable && (
              <div className="mt-5 rounded-xl border border-kumo-warning/30 bg-kumo-warning-tint px-4 py-3">
                <p className="text-sm font-semibold text-kumo-default">Execution machine</p>
                <p className="mt-1 text-sm leading-5 text-kumo-subtle">
                  After the Hub update, run tiller host update if you also want to refresh the execution-machine runtime.
                </p>
              </div>
            )}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              {action && (
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => window.location.assign(action.url)}
                >
                  {action.label}
                </Button>
              )}
              {status.stableRelease && (
                <a
                  href={status.stableRelease.releaseNotesUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
                >
                  Release notes
                </a>
              )}
              <Button type="button" variant="secondary" onClick={onDismiss}>
                {action ? 'Dismiss' : 'Close'}
              </Button>
            </div>
          </section>
      </UpdateModal>
    );
  }

  const latestUpdateName = formatUpdateName(status.latestUpdate);
  const visibleUpdateRepoOwners = visibleGitHubOwnersForUpdateRepo(status.hubRepo);
  const showProgress = stage !== 'idle';
  const sameUpdateName = currentUpdateName === latestUpdateName;
  return (
    <UpdateModal
      title="Upgrade Tiller Hub"
      description="Review and start the available Tiller Hub update."
      onClose={onDismiss}
    >
        <section className="p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-kumo-subtle">
                Self-Update
              </p>
              <h1 className="mt-2 text-2xl font-semibold text-kumo-strong">
                Upgrade Tiller Hub
              </h1>
              <p className="mt-2 text-sm text-kumo-subtle">
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
              className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint"
            >
              Source repo
            </a>
          </div>

          {isDevelopmentBuild && (
            <div className="mt-6 rounded-xl border border-kumo-line bg-kumo-recessed px-4 py-3">
              <p className="text-sm font-semibold text-kumo-default">Development build</p>
              <p className="mt-1 text-sm text-kumo-subtle">
                Dogfood deployments use the development deploy path. Release self-update is disabled for this build.
              </p>
            </div>
          )}

          {!isDevelopmentBuild && (
            <div className="mt-6 rounded-xl border border-kumo-line bg-kumo-recessed p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-sm font-semibold text-kumo-default">Update source</p>
                  <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                    Tiller updates by committing the latest hub source into the deploy-button repo connected to Cloudflare Builds.
                  </p>
                </div>
                {status.hubRepo.status === 'detected' && (
                  <span className="w-fit rounded-full border border-kumo-success/20 bg-kumo-success-tint px-2 py-0.5 text-xs font-medium text-kumo-success">
                    Connected
                  </span>
                )}
              </div>

              <div className="mt-4 border-t border-kumo-line pt-3">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-kumo-subtle">Repository</p>
                <p className="mt-1 text-xs leading-5 text-kumo-subtle">
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
                        className="rounded border border-kumo-line bg-kumo-base px-3 py-1.5 text-left text-xs font-medium text-kumo-default transition-colors hover:bg-kumo-tint disabled:opacity-50"
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                )}
                {status.hubRepo.status === 'missing' && (
                  <div className="mt-3 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-3 py-2">
                    <p className="text-xs font-semibold text-kumo-warning">Check the GitHub account</p>
                    <p className="mt-1 text-xs leading-5 text-kumo-subtle">
                      Cloudflare must deploy this Worker from a repo under the same GitHub user or org selected for the Tiller GitHub App.
                      {visibleUpdateRepoOwners.length > 0
                        ? ` Tiller can currently see ${formatVisibleGitHubOwners(visibleUpdateRepoOwners)}.`
                        : ' Tiller cannot currently see any selected GitHub App repositories.'}
                      {' '}Open Cloudflare Worker Settings &gt; Builds and compare the connected repo owner.
                    </p>
                  </div>
                )}
                {status.hubRepo.status !== 'detected' && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="mt-3"
                    onClick={() => void handleDetectRepo()}
                    disabled={isApplying}
                  >
                    Check GitHub repos
                  </Button>
                )}
              </div>
            </div>
          )}

          {hasExecutionMachine && !isDevelopmentBuild && (
            <div className="mt-5 rounded-xl border border-kumo-warning/30 bg-kumo-warning-tint px-4 py-3">
              <p className="text-sm font-semibold text-kumo-default">Execution machine</p>
              <p className="mt-1 text-sm leading-5 text-kumo-subtle">
                Update the Tiller CLI on your machine if needed, then run tiller host update.
              </p>
            </div>
          )}

          {showProgress && (
            <div className="mt-5 rounded-xl border border-kumo-line bg-kumo-base px-4 py-3">
              <p className="text-sm font-semibold text-kumo-default">Progress</p>
              <p className="mt-1 text-sm text-kumo-subtle">
                {stage === 'complete' && autoReloadScheduled
                  ? 'Update complete. Reloading to start serving the new build.'
                  : formatStage(stage)}
              </p>
              {error && (
                <p className="mt-3 rounded-lg border border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
                  {error}
                </p>
              )}
            </div>
          )}

          {error && !showProgress && (
            <p className="mt-5 rounded-lg border border-kumo-danger/20 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
              {error}
            </p>
          )}

          <div className="mt-6 flex flex-wrap items-center gap-3">
            {!isDevelopmentBuild && (
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleGitHubRepoUpdate()}
                loading={isApplying}
                disabled={isApplying || stage === 'complete'}
              >
                {isApplying ? 'Updating...' : 'Update'}
              </Button>
            )}
            <Button type="button" variant="secondary" onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        </section>
    </UpdateModal>
  );
}
