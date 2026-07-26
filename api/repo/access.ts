import type { Env } from "../types";
import { GitHubAppError, isGitHubAppAllowedForRequest } from "../github/app";
import {
  createRepoWorkspaceFromGitHubAppSelection,
  getRepoWorkspaceForRepoId,
  getSelectedRepoWorkspaceForRepoId,
  type SelectedRepoWorkspace,
} from "../plan/store";
import type { RepoMeta } from "../types";

export type RepoWorkspace = SelectedRepoWorkspace;
export type RepoProjection = RepoMeta;

export type RepoAccessFailure = {
  ok: false;
  status: number;
  body: {
    error: string;
    code: string;
  } & Record<string, unknown>;
};

export type RepoAccessResult<T> = { ok: true; repo: T } | RepoAccessFailure;
export type RepoCreateOrRefreshResult =
  | { ok: true; repo: RepoWorkspace & { created: boolean } }
  | RepoAccessFailure;

export function githubAppPublicHubDisabledBody(): RepoAccessFailure["body"] {
  return {
    error: "Repository-backed flows are only available on protected hubs and localhost.",
    code: "github_app_public_hub_disabled",
  };
}

function githubAppUnavailableBody(error: GitHubAppError): RepoAccessFailure["body"] {
  return {
    error: error.message,
    code: error.code,
  };
}

function repoIdRequiredFailure(): RepoAccessFailure {
  return {
    ok: false,
    status: 400,
    body: {
      error: "repoId is required",
      code: "repo_id_required",
    },
  };
}

function repoNotFoundFailure(): RepoAccessFailure {
  return {
    ok: false,
    status: 404,
    body: {
      error: "Repo not found",
      code: "repo_not_found",
    },
  };
}

function repoMetadataUnavailableFailure(error: unknown): RepoAccessFailure {
  return {
    ok: false,
    status: 409,
    body: {
      error: error instanceof Error ? error.message : "Repository metadata is unavailable.",
      code: "repo_metadata_unavailable",
    },
  };
}

function githubAppFailure(error: GitHubAppError): RepoAccessFailure {
  return {
    ok: false,
    status: error.status,
    body: githubAppUnavailableBody(error),
  };
}

function trimRepoId(repoId: string | null | undefined): string {
  return repoId?.trim() ?? "";
}

export function shouldFailPendingOperationForRepoAccessCode(code: string): boolean {
  return (
    code === "github_app_repo_not_selected" ||
    code === "github_app_missing_installation" ||
    code === "github_app_missing_permissions" ||
    code === "repo_not_found"
  );
}

export async function loadRepoProjection(
  env: Env,
  repoId: string | null | undefined,
): Promise<RepoAccessResult<RepoProjection>> {
  const selectedRepoId = trimRepoId(repoId);
  if (!selectedRepoId) return repoIdRequiredFailure();

  let repo: RepoWorkspace | null;
  try {
    repo = await getRepoWorkspaceForRepoId(env, selectedRepoId);
  } catch (error) {
    return repoMetadataUnavailableFailure(error);
  }

  if (!repo) return repoNotFoundFailure();
  return { ok: true, repo: repo.meta };
}

export async function loadTrackedRepo(
  env: Env,
  repoId: string | null | undefined,
): Promise<RepoAccessResult<RepoWorkspace>> {
  const selectedRepoId = trimRepoId(repoId);
  if (!selectedRepoId) return repoIdRequiredFailure();

  let repo: RepoWorkspace | null;
  try {
    repo = await getRepoWorkspaceForRepoId(env, selectedRepoId);
  } catch (error) {
    return repoMetadataUnavailableFailure(error);
  }

  if (!repo) return repoNotFoundFailure();
  return { ok: true, repo };
}

export async function loadRepo(
  env: Env,
  repoId: string | null | undefined,
): Promise<RepoAccessResult<RepoWorkspace>> {
  const selectedRepoId = trimRepoId(repoId);
  if (!selectedRepoId) return repoIdRequiredFailure();

  let repo: RepoWorkspace | null;
  try {
    repo = await getSelectedRepoWorkspaceForRepoId(env, selectedRepoId);
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return githubAppFailure(error);
    }
    return repoMetadataUnavailableFailure(error);
  }

  if (!repo) return repoNotFoundFailure();
  return { ok: true, repo };
}

export async function loadRepoForRequest(
  env: Env,
  request: Request,
  repoId: string | null | undefined,
): Promise<RepoAccessResult<RepoWorkspace>> {
  if (!(await isGitHubAppAllowedForRequest(env, request))) {
    return { ok: false, status: 403, body: githubAppPublicHubDisabledBody() };
  }
  return await loadRepo(env, repoId);
}

export async function loadTrackedRepoForRequest(
  env: Env,
  request: Request,
  repoId: string | null | undefined,
): Promise<RepoAccessResult<RepoWorkspace>> {
  if (!(await isGitHubAppAllowedForRequest(env, request))) {
    return { ok: false, status: 403, body: githubAppPublicHubDisabledBody() };
  }
  return await loadTrackedRepo(env, repoId);
}

export async function createOrRefreshRepoFromSelectionClaimForRequest(
  env: Env,
  request: Request,
  claim: {
    repositoryId: number;
    installationId: number;
    fullName: string;
  },
): Promise<RepoCreateOrRefreshResult> {
  if (!(await isGitHubAppAllowedForRequest(env, request))) {
    return { ok: false, status: 403, body: githubAppPublicHubDisabledBody() };
  }

  try {
    const repo = await createRepoWorkspaceFromGitHubAppSelection(env, claim);
    return { ok: true, repo };
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return githubAppFailure(error);
    }
    return {
      ok: false,
      status: 502,
      body: {
        error: error instanceof Error ? error.message : String(error),
        code: "repo_create_or_refresh_failed",
      },
    };
  }
}
