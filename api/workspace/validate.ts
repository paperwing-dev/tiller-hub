/** Returns true if the path has no ".." traversal components. */
export function isSafePath(path: string): boolean {
  return !path.split(/[/\\]/).includes("..");
}

/** Returns true if all paths are safe. */
export function areSafePaths(paths: string[]): boolean {
  return paths.every(isSafePath);
}
