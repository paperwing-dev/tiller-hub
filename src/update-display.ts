import type { ReleaseInfo } from './api';

export function formatUpdateVersion(version: string): string {
  const normalized = version.trim().replace(/^tiller-hub-v/i, '').replace(/^v/i, '');
  return `v${normalized}`;
}

export function formatUpdateName(release: ReleaseInfo): string {
  return formatUpdateVersion(release.hubVersion);
}
