const LAST_PROJECT_STORAGE_KEY = "tiller:last-project";

export function rememberLastProjectId(repoId: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_STORAGE_KEY, repoId);
  } catch {
    // The route remains authoritative when storage is unavailable.
  }
}

export function resolveLastProjectId(repoIds: readonly string[]): string | null {
  if (repoIds.length === 0) return null;
  try {
    const remembered = window.localStorage.getItem(LAST_PROJECT_STORAGE_KEY);
    if (remembered && repoIds.includes(remembered)) return remembered;
  } catch {
    // Fall through to the deterministic first project.
  }
  return repoIds[0] ?? null;
}

export { LAST_PROJECT_STORAGE_KEY };
