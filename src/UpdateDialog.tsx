import { useState, type ReactNode } from 'react';
import { Button } from '@cloudflare/kumo/components/button';
import {
  checkPredeployCleanSlate,
  type UpdateCheckResult,
} from './api';
import {
  INSTALLER_REINSTALL_URL,
  installerMaintenanceAction,
} from './installer-maintenance';
import { formatUpdateName, formatUpdateVersion } from './update-display';

interface UpdateDialogProps {
  hubUrl: string;
  status: UpdateCheckResult | null;
  issue: string | null;
  issueCode: string | null;
  isChecking: boolean;
  hasExecutionMachine: boolean;
  onDismiss: () => void;
  onIgnore: () => void;
  onOpenSettings: () => void;
  onCheckNow: () => void;
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/35 p-4" role="presentation">
      <section
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-kumo-line bg-kumo-base shadow-2xl"
      >
        <div className="border-b border-kumo-line px-6 py-4">
          <div className="flex items-center justify-between gap-4">
            <h1 className="text-lg font-semibold text-kumo-strong">{title}</h1>
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </div>
        </div>
        {children}
      </section>
    </div>
  );
}

export default function UpdateDialog({
  hubUrl,
  status,
  issue,
  issueCode,
  isChecking,
  hasExecutionMachine,
  onDismiss,
  onIgnore,
  onOpenSettings,
  onCheckNow,
}: UpdateDialogProps) {
  const [isStarting, setIsStarting] = useState(false);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);

  if (!status) {
    const accessRequired = issueCode === 'setup_protection_required';
    return (
      <Modal title={isChecking ? 'Checking for updates' : 'Update check unavailable'} onClose={onDismiss}>
        <div className="p-6">
          <p className="text-sm text-kumo-subtle">
            {isChecking ? 'Tiller is checking the current deployment against the stable release.' : issue ?? 'Tiller could not check the stable release.'}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            {accessRequired && <Button type="button" variant="primary" onClick={onOpenSettings}>Open Settings</Button>}
            <Button type="button" variant={accessRequired ? 'secondary' : 'primary'} onClick={onCheckNow} loading={isChecking}>
              Check now
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  const currentName = formatUpdateName(status.currentRelease);
  const stableName = status.stableRelease ? formatUpdateVersion(status.stableRelease.version) : null;
  const development = status.currentRelease.channel === 'development';
  const managed = status.kind === 'installer-managed';
  const maintenanceAction = managed && !development
    ? installerMaintenanceAction({
        updateAvailable: status.updateAvailable,
        latestVersion: status.stableRelease?.version ?? '',
      })
    : null;

  async function startMaintenance() {
    if (!maintenanceAction) return;
    setIsStarting(true);
    setMaintenanceError(null);
    try {
      const readiness = await checkPredeployCleanSlate(hubUrl);
      if (!readiness.ok) {
        const resources = readiness.blockers.map((blocker) => blocker.resourceId).join(', ');
        setMaintenanceError(`Stop active work before maintenance${resources ? `: ${resources}` : '.'}`);
        return;
      }
      window.location.assign(maintenanceAction.url);
    } catch (error) {
      setMaintenanceError(error instanceof Error ? error.message : 'Maintenance readiness check failed.');
    } finally {
      setIsStarting(false);
    }
  }

  const title = development
    ? 'Development build'
    : managed
      ? maintenanceAction?.label ?? 'Tiller is up to date'
      : status.updateAvailable
        ? 'Reinstall to update Tiller'
        : 'Unmanaged installation';

  return (
    <Modal title={title} onClose={onDismiss}>
      <div className="p-6">
        <p className="text-sm leading-6 text-kumo-subtle">
          {development
            ? <>This Hub is running development build <strong>{currentName}</strong>. Stable maintenance is disabled.</>
            : status.stableRelease
              ? <>This Hub is running <strong>{currentName}</strong>. The stable release is <strong>{stableName}</strong>.</>
              : <>This Hub is running <strong>{currentName}</strong>. The stable release is temporarily unavailable.</>}
        </p>

        {!managed && !development && (
          <div className="mt-5 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-4 py-3">
            <p className="text-sm font-semibold text-kumo-default">Clean reinstall required</p>
            <p className="mt-1 text-sm leading-5 text-kumo-subtle">
              This Hub was not created by the Tiller installer. In-place repository updates are no longer supported. Install a clean managed Hub to receive future maintenance updates.
            </p>
          </div>
        )}

        {(issue || status.errors.length > 0) && (
          <div className="mt-5 rounded-lg border border-kumo-warning/30 bg-kumo-warning-tint px-4 py-3">
            <p className="text-sm font-semibold text-kumo-default">Stable release check unavailable</p>
            <p className="mt-1 text-sm text-kumo-subtle">{issue ?? status.errors[0]?.message}</p>
          </div>
        )}

        {maintenanceError && (
          <div className="mt-5 rounded-lg border border-kumo-danger/20 bg-kumo-danger-tint px-4 py-3 text-sm text-kumo-danger">
            {maintenanceError}
          </div>
        )}

        {hasExecutionMachine && status.updateAvailable && managed && (
          <p className="mt-5 text-xs leading-5 text-kumo-subtle">
            After Hub maintenance, run <code>tiller host update</code> to pin this machine to the release runtime digest.
          </p>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          {maintenanceAction && (
            <Button type="button" variant="primary" onClick={() => void startMaintenance()} loading={isStarting} disabled={isStarting}>
              {maintenanceAction.label}
            </Button>
          )}
          {!managed && !development && (
            <a
              href={INSTALLER_REINSTALL_URL}
              target="_blank"
              rel="noreferrer"
              className="rounded bg-kumo-brand px-3 py-2 text-sm font-medium text-white hover:opacity-90"
            >
              Clean reinstall
            </a>
          )}
          <Button
            type="button"
            variant={maintenanceAction || (!managed && !development) ? 'secondary' : 'primary'}
            onClick={onCheckNow}
            loading={isChecking}
          >
            Check now
          </Button>
          {status.stableRelease && (
            <a href={status.stableRelease.releaseNotesUrl} target="_blank" rel="noreferrer" className="rounded border border-kumo-line px-3 py-2 text-sm text-kumo-default hover:bg-kumo-tint">
              Release notes
            </a>
          )}
          {status.updateAvailable && !development && <Button type="button" variant="ghost" onClick={onIgnore}>Ignore until next update</Button>}
        </div>
      </div>
    </Modal>
  );
}
