import type { HubDO } from "../hub";
import { getDurableObjectStub } from "../durable-object";
import {
  patchRepoDefaultHeadIfCurrent,
  readGitHubDefaultBranchState,
  repoDefaultHeadIdentityFromMeta,
} from "../plan/store";
import { projectRepoSummary } from "../sync/projectors";
import type { Env, RepoMeta } from "../types";
import { GitHubAppError, isGitHubAppAllowedForRequest, resolveGitHubAppRepositorySelectionById } from "../github/app";
import { loadTrackedRepo, type RepoAccessFailure, type RepoWorkspace } from "./access";

export type GitHubDefaultBranchRefreshFailureKind = "access_error" | "not_ready" | "transient_error";

export interface GitHubDefaultBranchRefreshResult {
  repo: RepoWorkspace | null;
  changed: boolean;
  mainChanged: boolean;
  failureKind: GitHubDefaultBranchRefreshFailureKind | null;
  error: string | null;
  code: string | null;
  status: number | null;
  accessFailure?: RepoAccessFailure;
}

type RepoRefreshHub = Pick<HubDO, "broadcastRepoUpsert" | "broadcastRepoMainChange">;

function getHub(env: Env): RepoRefreshHub {
  return getDurableObjectStub<RepoRefreshHub>(env, env.HUB, "hub");
}

function successResult(args: {
  repo: RepoWorkspace;
  changed?: boolean;
  mainChanged?: boolean;
}): GitHubDefaultBranchRefreshResult {
  return {
    repo: args.repo,
    changed: args.changed ?? false,
    mainChanged: args.mainChanged ?? false,
    failureKind: null,
    error: null,
    code: null,
    status: null,
  };
}

function failureResult(args: {
  repo: RepoWorkspace | null;
  failureKind: GitHubDefaultBranchRefreshFailureKind;
  error: string;
  code: string;
  status?: number | null;
}): GitHubDefaultBranchRefreshResult {
  return {
    repo: args.repo,
    changed: false,
    mainChanged: false,
    failureKind: args.failureKind,
    error: args.error,
    code: args.code,
    status: args.status ?? null,
  };
}

function accessFailureResult(failure: RepoAccessFailure): GitHubDefaultBranchRefreshResult {
  return {
    repo: null,
    changed: false,
    mainChanged: false,
    failureKind: "access_error",
    error: failure.body.error,
    code: failure.body.code,
    status: failure.status,
    accessFailure: failure,
  };
}

function classifyGitHubAppError(error: GitHubAppError): GitHubDefaultBranchRefreshFailureKind {
  return (
    error.code === "github_app_repo_not_selected" ||
    error.code === "github_app_missing_installation" ||
    error.code === "github_app_missing_permissions" ||
    error.code === "github_app_not_configured" ||
    error.code === "github_app_repo_claim_invalid"
  )
    ? "access_error"
    : "transient_error";
}

function repoMatchesDefaultHeadIdentity(
  meta: RepoMeta,
  identity: {
    githubFullName: string;
    repoUrl: string;
    githubDefaultBranch: string | null;
    githubDefaultBranchHeadSha: string | null;
    gitStatus: RepoMeta["gitStatus"];
    gitError: string | null;
  },
): boolean {
  return (
    meta.githubFullName === identity.githubFullName &&
    meta.repoUrl === identity.repoUrl &&
    (meta.githubDefaultBranch ?? null) === identity.githubDefaultBranch &&
    (meta.githubDefaultBranchHeadSha ?? null) === identity.githubDefaultBranchHeadSha &&
    meta.gitStatus === identity.gitStatus &&
    meta.gitError === identity.gitError
  );
}

async function broadcastRepoRefresh(args: {
  env: Env;
  repo: RepoMeta;
  changed: boolean;
  mainChanged: boolean;
  previousMainCommit: string | null;
}): Promise<void> {
  if (!args.changed) return;
  const hub = getHub(args.env);
  await hub.broadcastRepoUpsert(projectRepoSummary(args.repo));
  if (args.mainChanged) {
    await hub.broadcastRepoMainChange(
      args.repo.repoId,
      args.repo.repoUrl,
      args.previousMainCommit,
      args.repo.githubDefaultBranchHeadSha,
      null,
    );
  }
}

export async function refreshGitHubDefaultBranchHead(
  env: Env,
  repoId: string | null | undefined,
): Promise<GitHubDefaultBranchRefreshResult> {
  const loaded = await loadTrackedRepo(env, repoId);
  if (!loaded.ok) return accessFailureResult(loaded);
  return await refreshLoadedGitHubDefaultBranchHead(env, loaded.repo, 0);
}

export async function refreshGitHubDefaultBranchHeadForRequest(
  env: Env,
  request: Request,
  repoId: string | null | undefined,
): Promise<GitHubDefaultBranchRefreshResult> {
  if (!(await isGitHubAppAllowedForRequest(env, request))) {
    return accessFailureResult({
      ok: false,
      status: 403,
      body: {
        error: "Repository-backed flows are only available on protected hubs and localhost.",
        code: "github_app_public_hub_disabled",
      },
    });
  }
  return await refreshGitHubDefaultBranchHead(env, repoId);
}

async function refreshLoadedGitHubDefaultBranchHead(
  env: Env,
  repo: RepoWorkspace,
  attempt: number,
): Promise<GitHubDefaultBranchRefreshResult> {
  const repositoryId = Number(repo.meta.repoId);
  if (!Number.isSafeInteger(repositoryId) || !Number.isSafeInteger(repo.meta.githubInstallationId)) {
    return failureResult({
      repo,
      failureKind: "not_ready",
      error: "Stored GitHub repository selection is invalid.",
      code: "github_repo_selection_invalid",
      status: 409,
    });
  }

  let selection: Awaited<ReturnType<typeof resolveGitHubAppRepositorySelectionById>>;
  try {
    selection = await resolveGitHubAppRepositorySelectionById(env, {
      repositoryId,
      installationId: repo.meta.githubInstallationId,
    });
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return failureResult({
        repo,
        failureKind: classifyGitHubAppError(error),
        error: error.message,
        code: error.code,
        status: error.status,
      });
    }
    return failureResult({
      repo,
      failureKind: "transient_error",
      error: error instanceof Error ? error.message : String(error),
      code: "github_repo_refresh_failed",
      status: 502,
    });
  }

  let defaultBranchState: Awaited<ReturnType<typeof readGitHubDefaultBranchState>>;
  try {
    defaultBranchState = await readGitHubDefaultBranchState(env, selection);
  } catch (error) {
    if (error instanceof GitHubAppError) {
      return failureResult({
        repo,
        failureKind: classifyGitHubAppError(error),
        error: error.message,
        code: error.code,
        status: error.status,
      });
    }
    return failureResult({
      repo,
      failureKind: "transient_error",
      error: error instanceof Error ? error.message : String(error),
      code: "github_repo_refresh_failed",
      status: 502,
    });
  }

  const nextHead = defaultBranchState.headSha;
  const readinessError = defaultBranchState.error;
  const expected = repoDefaultHeadIdentityFromMeta(repo.meta);
  const next = {
    githubFullName: selection.fullName,
    repoUrl: selection.repoUrl,
    githubDefaultBranch: selection.defaultBranch,
    githubDefaultBranchHeadSha: nextHead,
    gitStatus: nextHead && !readinessError ? "ready" as const : "repair-required" as const,
    gitError: readinessError,
  };
  const patch = await patchRepoDefaultHeadIfCurrent({
    env,
    workspace: repo.workspace,
    expected,
    next,
  });

  if (patch.conflict) {
    const reloaded = await loadTrackedRepo(env, repo.meta.repoId);
    if (reloaded.ok && repoMatchesDefaultHeadIdentity(reloaded.repo.meta, next)) {
      if (readinessError || !nextHead) {
        return {
          repo: reloaded.repo,
          changed: false,
          mainChanged: false,
          failureKind: "not_ready",
          error: readinessError || "GitHub default branch head is unavailable.",
          code: "github_default_branch_not_ready",
          status: 409,
        };
      }
      return successResult({ repo: reloaded.repo });
    }
    if (reloaded.ok && attempt === 0) {
      return await refreshLoadedGitHubDefaultBranchHead(env, reloaded.repo, attempt + 1);
    }
    return failureResult({
      repo: reloaded.ok ? reloaded.repo : repo,
      failureKind: "transient_error",
      error: "Repository metadata changed during refresh.",
      code: "github_repo_refresh_conflict",
      status: 409,
    });
  }

  const nextRepo = patch.repo ? { workspace: repo.workspace, meta: patch.repo } : repo;
  await broadcastRepoRefresh({
    env,
    repo: nextRepo.meta,
    changed: patch.changed,
    mainChanged: patch.mainChanged,
    previousMainCommit: expected.githubDefaultBranchHeadSha,
  });

  if (readinessError || !nextHead) {
    return {
      repo: nextRepo,
      changed: patch.changed,
      mainChanged: patch.mainChanged,
      failureKind: "not_ready",
      error: readinessError || "GitHub default branch head is unavailable.",
      code: "github_default_branch_not_ready",
      status: 409,
    };
  }

  return successResult({
    repo: nextRepo,
    changed: patch.changed,
    mainChanged: patch.mainChanged,
  });
}
