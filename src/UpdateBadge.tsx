import React, { useState } from 'react';
import type { UpdateCheckResult } from './api';
import { formatUpdateName } from './update-display';
import { installerMaintenanceAction } from './installer-maintenance';

interface UpdateBadgeProps {
  status: UpdateCheckResult | null;
  issue: string | null;
  dismissed: boolean;
  isChecking: boolean;
  onOpen: () => void;
}

export function describeUpdateButtonState({
  status,
  issue,
  dismissed,
  isChecking,
}: {
  status: UpdateCheckResult | null;
  issue: string | null;
  dismissed: boolean;
  isChecking: boolean;
}): {
  description: string;
  enabled: boolean;
  highlighted: boolean;
} {
  if (isChecking) {
    return {
      description: 'Checking for updates',
      enabled: false,
      highlighted: false,
    };
  }

  const maintenanceAction = status?.kind === 'installer-managed'
    ? installerMaintenanceAction({
        updateAvailable: status.updateAvailable,
        latestVersion: status.stableRelease?.version ?? '',
      })
    : null;

  if (issue && !maintenanceAction && status?.kind !== 'unmanaged') {
    return {
      description: `Update unavailable: ${issue}`,
      enabled: true,
      highlighted: false,
    };
  }

  if (!status) {
    return {
      description: 'No update available',
      enabled: true,
      highlighted: false,
    };
  }

  if (status.currentRelease.channel === 'development') {
    return {
      description: 'Development build',
      enabled: true,
      highlighted: false,
    };
  }

  if (dismissed) {
    return {
      description: 'Ignored until next update',
      enabled: true,
      highlighted: false,
    };
  }

  if (maintenanceAction) {
    return {
      description: maintenanceAction.label,
      enabled: true,
      highlighted: true,
    };
  }

  if (status.kind === 'unmanaged') {
    return {
      description: status.updateAvailable
        ? `Update requires a clean reinstall\nCurrent version: ${formatUpdateName(status.currentRelease)}`
        : `Unmanaged installation\nCurrent version: ${formatUpdateName(status.currentRelease)}`,
      enabled: true,
      highlighted: true,
    };
  }

  if (!status.updateAvailable) {
    return {
      description: `No update available\nCurrent version: ${formatUpdateName(status.currentRelease)}`,
      enabled: true,
      highlighted: false,
    };
  }

  return {
    description: 'Update unavailable',
    enabled: true,
    highlighted: false,
  };
}

export default function UpdateButton({
  status,
  issue,
  dismissed,
  isChecking,
  onOpen,
}: UpdateBadgeProps) {
  const state = describeUpdateButtonState({
    status,
    issue,
    dismissed,
    isChecking,
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
        data-highlighted={state.highlighted}
        className={`tiller-update-button inline-flex h-7 items-center rounded border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors ${
          state.highlighted
            ? 'border-kumo-focus bg-kumo-info-tint text-kumo-link hover:bg-kumo-tint'
            : 'border-kumo-line bg-kumo-base text-kumo-subtle hover:bg-kumo-tint disabled:cursor-default disabled:opacity-60 disabled:hover:bg-kumo-base'
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
