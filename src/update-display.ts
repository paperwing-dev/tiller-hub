import type { TillerUpdateMetadata } from './api';

export function formatUpdateVersion(version: string): string {
  const normalized = version.trim().replace(/^tiller-hub-v/i, '').replace(/^v/i, '');
  return `v${normalized}`;
}

export function formatUpdateName(update: TillerUpdateMetadata): string {
  return formatUpdateVersion(update.version);
}
