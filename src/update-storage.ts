const UPDATE_DISMISS_PREFIX = 'tiller:update-dismissed:';

function getDismissKey(sourceId: string): string {
  return `${UPDATE_DISMISS_PREFIX}${sourceId}`;
}

export function isUpdateDismissed(sourceId: string): boolean {
  return window.localStorage.getItem(getDismissKey(sourceId)) === 'true';
}

export function ignoreUpdateUntilNext(sourceId: string): void {
  window.localStorage.setItem(getDismissKey(sourceId), 'true');
}
