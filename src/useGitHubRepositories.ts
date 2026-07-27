import { useEffect, useState } from "react";
import { ApiActionError, fetchGitHubRepositories, type GitHubRepositorySelection, type GitHubRepositoryWarning } from "./api";

export interface GitHubRepositoriesState {
  repositories: GitHubRepositorySelection[];
  warnings: GitHubRepositoryWarning[];
  repositorySelection: "all" | "selected" | "unknown";
  loading: boolean;
  error: string | null;
}

export function githubRepositoryKey(selection: Pick<GitHubRepositorySelection, "installationId" | "repositoryId">): string {
  return `${selection.installationId}:${selection.repositoryId}`;
}

export function formatGitHubRepositoryError(error: unknown): string {
  if (error instanceof ApiActionError) {
    if (error.code === "github_app_repository_list_failed" && /rate limit exceeded/i.test(error.message)) {
      return "GitHub's API rate limit is temporarily exhausted. Repositories will appear after GitHub resets it; reinstalling the App will not help.";
    }
    switch (error.code) {
      case "github_app_public_hub_disabled":
        return "Public workers.dev hubs cannot add repositories. Configure a protected hub or use localhost.";
      case "github_app_not_configured":
        return "GitHub App is not configured.";
      case "github_app_missing_installation":
        return "The GitHub App is not installed on any account.";
      case "github_app_repo_not_selected":
      case "github_app_no_usable_repositories":
        return "No repositories are selected in the configured GitHub App installation.";
      case "github_app_missing_permissions":
        return "The GitHub App installation is missing required write permissions.";
      case "github_app_repository_list_failed":
      case "github_app_installation_list_failed":
        return "GitHub repositories could not be loaded. Try again after GitHub access recovers.";
      default:
        return error.message;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export function useGitHubRepositories(
  hubUrl: string,
  options?: {
    enabled?: boolean;
  },
): GitHubRepositoriesState {
  const enabled = options?.enabled ?? true;
  const [state, setState] = useState<GitHubRepositoriesState>({
    repositories: [],
    warnings: [],
    repositorySelection: "unknown",
    loading: enabled,
    error: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState({ repositories: [], warnings: [], repositorySelection: "unknown", loading: false, error: null });
      return undefined;
    }

    let cancelled = false;
    setState((current) => ({ ...current, loading: true, error: null }));
    void fetchGitHubRepositories(hubUrl)
      .then((result) => {
        if (cancelled) return;
        setState({
          repositories: result.repositories,
          warnings: result.warnings,
          repositorySelection: result.repositorySelection,
          loading: false,
          error: null,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          repositories: [],
          warnings: [],
          repositorySelection: "unknown",
          loading: false,
          error: formatGitHubRepositoryError(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, hubUrl]);

  return state;
}
