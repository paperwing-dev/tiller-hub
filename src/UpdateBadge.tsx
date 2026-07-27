import { useState } from 'react';
import type { UpdateCheckResult } from './api';
import { formatUpdateName } from './update-display';

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
  title: string;
  tooltip: string;
  enabled: boolean;
} {
  if (isChecking) {
    return {
      title: 'Checking for updates',
      tooltip: 'Checking for updates',
      enabled: false,
    };
  }

  if (issue) {
    return {
      title: `Update unavailable: ${issue}`,
      tooltip: `Update unavailable: ${issue}`,
      enabled: false,
    };
  }

  if (!status) {
    return {
      title: 'No update available',
      tooltip: 'No update available',
      enabled: false,
    };
  }

  if (status.buildDiagnostics.channel === 'development') {
    return {
      title: 'Development build',
      tooltip: 'Development build',
      enabled: false,
    };
  }

  if (dismissed) {
    return {
      title: 'Update dismissed',
      tooltip: 'Update dismissed',
      enabled: false,
    };
  }

  if (!status.updateAvailable) {
    return {
      title: 'No update available',
      tooltip: 'No update available',
      enabled: false,
    };
  }

  return {
    title: `Update available: ${formatUpdateName(status.currentUpdate)} -> ${formatUpdateName(status.latestUpdate)}`,
    tooltip: 'Update available',
    enabled: true,
  };
}

export default function UpdateButton({ status, issue, dismissed, isChecking, onOpen }: UpdateBadgeProps) {
  const state = describeUpdateButtonState({ status, issue, dismissed, isChecking });
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
        title={state.title}
        aria-label={state.title}
        className={`h-6 rounded border px-2 text-[10px] font-medium uppercase tracking-wide transition-colors ${
          state.enabled
            ? 'border-kumo-focus bg-kumo-info-tint text-kumo-link hover:bg-kumo-tint'
            : 'border-kumo-line bg-kumo-base text-kumo-subtle disabled:cursor-default disabled:opacity-60'
        }`}
      >
        Update
      </button>
      {open && (
        <span className="pointer-events-none absolute right-0 top-full z-[1001] mt-1 w-max max-w-72 rounded-md border border-kumo-line bg-kumo-elevated px-2 py-1 text-xs font-medium normal-case tracking-normal text-kumo-default shadow-lg">
          {state.tooltip}
        </span>
      )}
    </span>
  );
}

export { describeUpdateButtonState as describeUpdateBadgeState };
