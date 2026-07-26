import {
  envPath,
  planPath,
  projectPath,
  repoSettingsPath,
  sessionPath,
  shipPath,
} from "./dashboard-paths";

export function legacyDashboardHashPath(hash: string): string | null {
  const rawHash = hash.replace(/^#/, "");
  if (!rawHash) return null;

  const params = new URLSearchParams(rawHash);
  const view = params.get("view");
  const repoId = params.get("repoId");
  const envSlug = params.get("envSlug");
  const sessionId = params.get("sessionId");
  const planArtifactId = params.get("planArtifactId");

  if (view === "project" && repoId) return projectPath(repoId);
  if (view === "plan" && repoId) return planPath(repoId, planArtifactId);
  if (view === "repo-settings" && repoId) return repoSettingsPath(repoId);
  if (view === "env" && envSlug) return envPath(envSlug);
  if (view === "changes" && envSlug) return shipPath(envSlug);
  if (view === "session" && sessionId) return sessionPath(sessionId);
  if (view === "settings") return "/settings";
  if (view === "update") return "/update";
  if (!view && repoId) return planPath(repoId, planArtifactId);

  return null;
}

export function migrateLegacyDashboardHash(): string | null {
  if (typeof window === "undefined") return null;
  const path = legacyDashboardHashPath(window.location.hash || "");
  if (!path) return null;

  const search = window.location.search || "";
  window.history.replaceState(null, "", `${path}${search}`);
  return path;
}
