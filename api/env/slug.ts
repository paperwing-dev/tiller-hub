import type { RunnerBackendKind } from "./runner-backend";

export function deriveRepoSlug(repoUrl: string): string {
  const parts = repoUrl.replace(/\.git$/, "").split("/");
  return parts[parts.length - 1] || "unnamed";
}

export function deriveEnvSlugCandidate(
  repoUrl: string,
  backend: RunnerBackendKind,
  attempt: number,
): string {
  const base = deriveRepoSlug(repoUrl);

  if (attempt <= 0) {
    return base;
  }

  const backendBase = `${base}-${backend}`;
  if (attempt === 1) {
    return backendBase;
  }

  return `${backendBase}-${attempt}`;
}
