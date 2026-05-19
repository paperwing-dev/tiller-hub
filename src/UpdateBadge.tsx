import type { UpdateCheckResult } from './api';

interface UpdateBadgeProps {
  status: UpdateCheckResult | null;
  issue: string | null;
  dismissed: boolean;
  onOpen: () => void;
}

export function describeUpdateBadgeState({
  status,
  issue,
  dismissed,
}: {
  status: UpdateCheckResult | null;
  issue: string | null;
  dismissed: boolean;
}): {
  title: string;
  accentClassName: string;
  icon: string;
} | null {
  if (issue) {
    return {
      title: `Self-update check unavailable: ${issue}`,
      accentClassName: 'text-[#cf222e] hover:text-[#a40e26]',
      icon: '!',
    };
  }

  if (!status?.updateAvailable || dismissed) {
    return null;
  }

  return {
    title: `Update available: ${status.currentVersion} -> ${status.latestVersion}`,
    accentClassName: 'text-[#57606a] hover:text-[#24292f]',
    icon: '↑',
  };
}

export default function UpdateBadge({ status, issue, dismissed, onOpen }: UpdateBadgeProps) {
  const badge = describeUpdateBadgeState({ status, issue, dismissed });
  if (!badge) return null;

  return (
    <button
      type="button"
      onClick={onOpen}
      className={`relative text-sm leading-none ${badge.accentClassName}`}
      title={badge.title}
      aria-label={badge.title}
    >
      <span className="inline-flex items-center font-semibold">{badge.icon}</span>
      <span
        className={`absolute -right-1 -top-0.5 h-2 w-2 rounded-full ${issue ? 'bg-[#cf222e]' : 'bg-[#d4a72c]'}`}
      />
    </button>
  );
}
