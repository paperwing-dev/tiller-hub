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
  enabled: boolean;
} {
  if (isChecking) {
    return {
      title: 'Checking for updates',
      enabled: false,
    };
  }

  if (issue || !status) {
    return {
      title: issue ? `Update unavailable: ${issue}` : 'Update unavailable',
      enabled: false,
    };
  }

  if (status.buildDiagnostics.channel === 'development') {
    return {
      title: 'Development build',
      enabled: false,
    };
  }

  if (dismissed) {
    return {
      title: 'Update dismissed',
      enabled: false,
    };
  }

  if (!status.updateAvailable) {
    return {
      title: 'No update available',
      enabled: false,
    };
  }

  return {
    title: `Update available: ${formatUpdateName(status.currentUpdate)} -> ${formatUpdateName(status.latestUpdate)}`,
    enabled: true,
  };
}

export default function UpdateButton({ status, issue, dismissed, isChecking, onOpen }: UpdateBadgeProps) {
  const state = describeUpdateButtonState({ status, issue, dismissed, isChecking });
  const className = state.enabled
    ? 'border-[#0969da] bg-[#0969da] text-white shadow-sm hover:bg-[#0858c3]'
    : 'cursor-not-allowed border-[#d0d7de] bg-[#f6f8fa] text-[#8c959f]';

  return (
    <button
      type="button"
      onClick={state.enabled ? onOpen : undefined}
      disabled={!state.enabled}
      className={`absolute right-4 top-3 z-20 rounded-md border px-3 py-1.5 text-xs font-semibold transition-colors ${className}`}
      title={state.title}
      aria-label={state.title}
    >
      Update
    </button>
  );
}

export { describeUpdateButtonState as describeUpdateBadgeState };
