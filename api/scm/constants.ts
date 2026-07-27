export const SCM_FORMAT_VERSION = 1;
export const SCM_ARTIFACT_SUFFIX = ".tar.zst";
export const SCM_ARTIFACT_CONTENT_TYPE = "application/zstd";

export const ENV_SNAPSHOTS_PREFIX = "envs";

export const ENV_SNAPSHOT_DURABILITY_EXCLUDES = [
  "/node_modules",
  "/.next",
  "/dist",
  "/build",
  "/vendor",
  "/.terraform",
  "/.claude/settings.local.json",
] as const;

function normalizeSnapshotPath(path: string): string {
  if (!path) return "/";
  if (path.startsWith("/")) return path;
  return `/${path}`;
}

export function matchesSnapshotExcludePrefix(path: string, prefix: string): boolean {
  const normalizedPath = normalizeSnapshotPath(path);
  const normalizedPrefix = normalizeSnapshotPath(prefix).replace(/\/+$/, "");
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

export function shouldExcludeFromEnvSnapshot(path: string): boolean {
  return ENV_SNAPSHOT_DURABILITY_EXCLUDES.some((prefix) => matchesSnapshotExcludePrefix(path, prefix));
}
