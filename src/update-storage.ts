const UPDATE_DISMISS_PREFIX = 'tiller:update-dismissed:';

function getDismissKey(version: string): string {
  return `${UPDATE_DISMISS_PREFIX}${version}`;
}

export function isUpdateDismissed(version: string): boolean {
  return window.localStorage.getItem(getDismissKey(version)) === 'true';
}

export function dismissUpdate(version: string): void {
  window.localStorage.setItem(getDismissKey(version), 'true');
}
