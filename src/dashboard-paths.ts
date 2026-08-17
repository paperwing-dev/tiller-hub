import { generatePath } from "react-router";

export function projectPath(repoId: string): string {
  return generatePath("/projects/:repoId", {
    repoId,
  });
}

export function planPath(repoId: string, planArtifactId?: string | null): string {
  if (!planArtifactId) {
    return generatePath("/projects/:repoId/plan", {
      repoId,
    });
  }
  return generatePath("/projects/:repoId/plan/:planArtifactId", {
    repoId,
    planArtifactId,
  });
}

export function projectImplementationsPath(repoId: string): string {
  return generatePath("/projects/:repoId/implementations", {
    repoId,
  });
}

export function repoSettingsPath(repoId: string): string {
  return generatePath("/projects/:repoId/settings", {
    repoId,
  });
}

export function projectGlobalSettingsPath(repoId: string): string {
  return generatePath("/projects/:repoId/global-settings", {
    repoId,
  });
}

export function envPath(envSlug: string): string {
  return generatePath("/envs/:envSlug", {
    envSlug,
  });
}

export function shipPath(envSlug: string): string {
  return generatePath("/envs/:envSlug/ship", {
    envSlug,
  });
}

export function sessionPath(sessionId: string): string {
  return generatePath("/sessions/:sessionId", {
    sessionId,
  });
}
