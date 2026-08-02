import React, { useState } from 'react';
import type { UpdateCheckResult } from './api';
import { formatUpdateName } from './update-display';
import { installerMaintenanceAction } from './installer-maintenance';

interface UpdateBadgeProps {
  status: UpdateCheckResult | null;
  issue: string | null;
  dismissed: boolean;
  isChecking: boolean;
  renewalRecommended: boolean;
  onOpen: () => void;
}

export function describeUpdateButtonState({
  status,
  issue,
  dismissed,
  isChecking,
  renewalRecommended = false,
}: {
  status: UpdateCheckResult | null;
  issue: string | null;
  dismissed: boolean;
  isChecking: boolean;
  renewalRecommended?: boolean;
}): {
  description: string;
  enabled: boolean;
} {
  if (isChecking) {
    return {
      description: 'Checking for updates',
      enabled: false,
    };
  }

  const maintenanceAction = status?.kind === 'installer-maintenance'
    ? installerMaintenanceAction({
        updateAvailable: status.updateAvailable,
        latestVersion: status.stableRelease?.version ?? '',
        renewAccess: renewalRecommended,
      })
    : null;

  if (issue && !maintenanceAction) {
    return {
      description: `Update unavailable: ${issue}`,
      enabled: false,
    };
  }

  if (!status) {
    return {
      description: 'No update available',
      enabled: false,
    };
  }

  if (status.buildDiagnostics.channel === 'development') {
    return {
      description: 'Development build',
      enabled: false,
    };
  }

  if (dismissed && maintenanceAction?.intent !== 'renew') {
    return {
      description: 'Update dismissed',
      enabled: false,
    };
  }

  if (maintenanceAction) {
    return {
      description: maintenanceAction.label,
      enabled: true,
    };
  }

  if (!status.updateAvailable) {
    return {
      description: `No update available\nCurrent version: ${formatUpdateName(status.currentUpdate)}`,
      enabled: false,
    };
  }

  if (status.kind === 'installer-maintenance') {
    return {
      description: 'Update unavailable',
      enabled: false,
    };
  }

  return {
    description: `Update available: ${formatUpdateName(status.currentUpdate)} -> ${formatUpdateName(status.latestUpdate)}`,
    enabled: true,
  };
}

export default function UpdateButton({
  status,
  issue,
  dismissed,
  isChecking,
  renewalRecommended,
  onOpen,
}: UpdateBadgeProps) {
  const state = describeUpdateButtonState({
    status,
    issue,
    dismissed,
    isChecking,
    renewalRecommended,
  });
  const [open, setOpen] = useState(false);

  return (
    <span
      className="relative z-[1000] inline-flex"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={state.enabled ? onOpen : undefined}
        disabled={!state.enabled}
        aria-label={state.description}
        className={`h-6 rounded border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors ${
          state.enabled
            ? 'border-kumo-focus bg-kumo-info-tint text-kumo-link hover:bg-kumo-tint'
            : 'border-kumo-line bg-kumo-base text-kumo-subtle disabled:cursor-default disabled:opacity-60'
        }`}
      >
        Update
      </button>
      {open && (
        <span className="pointer-events-none absolute right-0 top-full z-[1001] mt-1 w-max max-w-72 whitespace-pre-line rounded-md border border-kumo-line bg-kumo-elevated px-2 py-1 text-left text-xs font-medium normal-case tracking-normal text-kumo-default shadow-lg">
          {state.description}
        </span>
      )}
    </span>
  );
}

export { describeUpdateButtonState as describeUpdateBadgeState };
