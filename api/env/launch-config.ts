import {
  getApprovedPlanArtifact,
  getPlanArtifactById,
  loadRepoArtifacts,
  renderArtifactPlanMarkdown,
  type ArtifactStoreDO,
  type PlanArtifact,
} from "../coordination";
import { getWorkspaceStub } from "../helpers";
import type { Env, EnvMeta, RepoMeta } from "../types";
import {
  resolveCodexContainerAuth,
  resolveContainerAuth,
  resolveOpenCodeContainerAuth,
} from "./container-auth";
import { getSecret } from "../setup/config";
import { resolveProtectionState } from "../protection";
import { resolveScmRunnerBackendKind } from "./runner-backend";
import { resolveCodexModelRoute } from "../model-route";
import {
  buildScmContainerEnvVars,
  resolveRequestedStartupPlanId,
} from "../scm/model";
import {
  resolveContainerHubUrl,
  buildEnvWorkspaceApiBaseUrl,
  buildRepoGitArtifactUrl,
  buildEnvScmOperationResultUrl,
  buildEnvScmOperationHeartbeatUrl,
  buildEnvScmOperationFailedUrl,
  buildEnvScmConflictResolutionUrl,
  buildRepoGitArtifactStagingUrl,
} from "./hub-url";
import { ensureRepoWorkspaceFromRepoUrl } from "../plan/store";
import type { RepoScmOperationType } from "../scm/repo-merge-lock-do";
import workspacePolicy from "../../../containers/workspace-policy.json";

export type RepoWorkspaceHandle = Awaited<ReturnType<typeof ensureRepoWorkspaceFromRepoUrl>>;

export const ENV_ONLY_CANONICAL_EXCLUDES = workspacePolicy.envOnlyCanonicalExcludes;
export const TREE_HASH_EXCLUDES = ENV_ONLY_CANONICAL_EXCLUDES;

interface RepoPlanSource {
  meta: Pick<RepoMeta, "repoId" | "mainCommit">;
}

async function resolveSelectedPlanArtifact(
  repo: RepoPlanSource,
  artifactStore: Pick<ArtifactStoreDO, "listArtifacts" | "listRefs">,
  meta: EnvMeta,
  currentMainCommit: string | null,
  requestedPlanId?: string | null,
): Promise<PlanArtifact | null> {
  const { artifacts, refs } = await loadRepoArtifacts(repo.meta, artifactStore);
  const preferredPlanId = resolveRequestedStartupPlanId(meta, requestedPlanId);
  const selectedPlan = preferredPlanId
    ? getPlanArtifactById(artifacts, preferredPlanId)
    : getApprovedPlanArtifact(artifacts, refs);

  if (!selectedPlan) {
    if (!preferredPlanId) return null;
    throw new Error(`Plan artifact not found: ${preferredPlanId}`);
  }

  if (selectedPlan.basis.mainCommit !== (meta.baseMainCommit ?? currentMainCommit)) {
    throw new Error(
      `Plan artifact ${selectedPlan.id} belongs to ${selectedPlan.basis.mainCommit ?? "unknown main"}, expected ${meta.baseMainCommit ?? currentMainCommit ?? "unknown main"}.`,
    );
  }

  return selectedPlan;
}

export async function resolveSelectedPlanId(
  repo: RepoPlanSource,
  artifactStore: Pick<ArtifactStoreDO, "listArtifacts" | "listRefs">,
  meta: EnvMeta,
  currentMainCommit: string | null,
  requestedPlanId?: string | null,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit, requestedPlanId);
  return selectedPlan?.id ?? null;
}

export async function materializeStartupPlan(
  repo: RepoPlanSource,
  artifactStore: Pick<ArtifactStoreDO, "listArtifacts" | "listRefs">,
  envWorkspace: ReturnType<typeof getWorkspaceStub>,
  meta: EnvMeta,
  currentMainCommit: string | null,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit);
  if (selectedPlan) {
    await envWorkspace.writeWorkspaceFile("/.tiller/plan.md", renderArtifactPlanMarkdown(selectedPlan));
  } else {
    await envWorkspace.clearWorkspacePlanFile();
  }
  return selectedPlan?.id ?? null;
}

export async function buildContainerLaunchConfig(
  env: Env,
  requestUrl: string,
  slug: string,
  repoUrl: string,
  repoMeta?: Pick<RepoMeta, "repoId" | "gitArtifactId"> | null,
  meta: EnvMeta,
  options?: {
    hostMachineId?: string | null;
  },
): Promise<{
  envVars: Record<string, string>;
  meta: Pick<EnvMeta, "harness" | "authMode" | "resolvedAuthMode" | "codexAuthMode" | "opencodeProvider" | "opencodeModel" | "modelRoute" | "authWarning">;
}> {
  const backend = meta.backend;
  const harness = meta.harness;
  const runnerId = meta.runnerId ?? slug;
  const hubPublicUrl = await resolveContainerHubUrl(env, requestUrl, backend);
  const githubToken = await getSecret(env, "GITHUB_TOKEN");
  const protection = await resolveProtectionState(env, requestUrl);
  const cfClientId =
    protection.protectionMode === "cf-access"
      ? (await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim() ?? ""
      : "";
  const cfClientSecret =
    protection.protectionMode === "cf-access"
      ? (await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim() ?? ""
      : "";

  const commonEnvVars = {
    NAMESPACE: "hub",
    REPO_SLUG: slug,
    REPO_URL: repoUrl,
    RUNNER_BACKEND: backend,
    RUNNER_ID: runnerId,
    HUB_URL: hubPublicUrl,
    ...(repoMeta?.repoId && repoMeta.gitArtifactId
      ? {
          TILLER_REPO_GIT_ARTIFACT_URL: buildRepoGitArtifactUrl(
            hubPublicUrl,
            repoMeta.repoId,
            repoMeta.gitArtifactId,
          ),
        }
      : {}),
    NODE_OPTIONS: "--dns-result-order=ipv4first --no-network-family-autoselection",
    TILLER_HARNESS: harness,
    ...buildScmContainerEnvVars(meta),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
    ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
  };

  if (harness === "codex") {
    const gatewayRoute = await resolveCodexModelRoute(env, {
      target: backend === "host" ? "host" : "hosted",
      machineId: backend === "host" ? (options?.hostMachineId ?? meta.runnerMachineId ?? null) : null,
    });
    const auth = await resolveCodexContainerAuth(env, {
      backend,
      gatewayRoute: gatewayRoute ?? undefined,
    });
    return {
      envVars: {
        ...commonEnvVars,
        TILLER_CODEX_AUTH_MODE: auth.resolvedAuthMode,
        TILLER_CODEX_MODEL_ROUTE: auth.modelRoute,
        ...auth.envVars,
      },
      meta: {
        harness,
        codexAuthMode: auth.resolvedAuthMode,
        modelRoute: auth.modelRoute,
      },
    };
  }

  if (harness === "opencode") {
    const auth = await resolveOpenCodeContainerAuth(env);
    return {
      envVars: {
        ...commonEnvVars,
        TILLER_OPENCODE_BASE_URL: `${hubPublicUrl}/api/opencode/v1`,
        TILLER_OPENCODE_AUTH_TOKEN: auth.proxyToken,
        TILLER_OPENCODE_MODEL_ID: auth.model,
      },
      meta: {
        harness,
        opencodeProvider: auth.provider,
        opencodeModel: auth.model,
      },
    };
  }

  const auth = await resolveContainerAuth(env, {
    stored: meta.authMode ?? null,
    backend,
  });

  return {
    envVars: {
      ...commonEnvVars,
      TILLER_CLAUDE_AUTH_MODE: auth.authMode,
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: auth.resolvedAuthMode,
      ...(auth.authWarning ? { TILLER_CLAUDE_AUTH_WARNING: auth.authWarning } : {}),
      ...auth.envVars,
    },
    meta: {
      harness,
      authMode: auth.authMode,
      resolvedAuthMode: auth.resolvedAuthMode,
      ...(auth.authWarning ? { authWarning: auth.authWarning } : {}),
    },
  };
}

export async function buildGitOperationEnvVars(
  env: Env,
  requestUrl: string,
  repo: RepoWorkspaceHandle,
  meta: EnvMeta,
  options: {
    operationId: string;
    operationType: RepoScmOperationType;
    sourceGitArtifactId?: string | null;
    stagedGitArtifactId?: string | null;
    mergeLockToken?: string | null;
  },
): Promise<Record<string, string>> {
  const backend = resolveScmRunnerBackendKind(env);
  const hubPublicUrl = await resolveContainerHubUrl(env, requestUrl, backend);
  const protection = await resolveProtectionState(env, requestUrl);
  const githubToken = await getSecret(env, "GITHUB_TOKEN");
  const cfClientId =
    protection.protectionMode === "cf-access"
      ? (await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim() ?? ""
      : "";
  const cfClientSecret =
    protection.protectionMode === "cf-access"
      ? (await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim() ?? ""
      : "";

  return {
    TILLER_BOOTSTRAP_MODE: "scm-operation",
    TILLER_SCM_OPERATION: options.operationType,
    TILLER_SCM_OPERATION_ID: options.operationId,
    TILLER_REPO_ID: repo.meta.repoId,
    TILLER_BRANCH_NAME: meta.branchName ?? "",
    TILLER_BASE_MAIN_COMMIT: meta.baseMainCommit ?? "",
    TILLER_ENV_WORKSPACE_API_BASE: buildEnvWorkspaceApiBaseUrl(hubPublicUrl, meta.slug),
    TILLER_REPO_GIT_ARTIFACT_URL: buildRepoGitArtifactUrl(
      hubPublicUrl,
      repo.meta.repoId,
      options.sourceGitArtifactId ?? repo.meta.gitArtifactId ?? null,
    ),
    TILLER_SCM_RESULT_URL: buildEnvScmOperationResultUrl(hubPublicUrl, meta.slug, options.operationId),
    TILLER_SCM_PROGRESS_URL: `${hubPublicUrl.replace(/\/+$/, "")}/api/envs/${encodeURIComponent(meta.slug)}/scm-operations/${encodeURIComponent(options.operationId)}/progress`,
    TILLER_SCM_FAILURE_URL: buildEnvScmOperationFailedUrl(hubPublicUrl, meta.slug, options.operationId),
    TILLER_ENV_ONLY_PATHS: ENV_ONLY_CANONICAL_EXCLUDES.join(","),
    ...(options.operationType === "merge-into-main" && options.stagedGitArtifactId
      ? {
          TILLER_SCM_HEARTBEAT_URL: buildEnvScmOperationHeartbeatUrl(hubPublicUrl, meta.slug, options.operationId),
          TILLER_SCM_CONFLICT_RESOLUTION_URL: buildEnvScmConflictResolutionUrl(
            hubPublicUrl,
            meta.slug,
            options.operationId,
          ),
          ...(options.mergeLockToken ? { TILLER_SCM_MERGE_LOCK_TOKEN: options.mergeLockToken } : {}),
          TILLER_REPO_GIT_STAGING_URL: buildRepoGitArtifactStagingUrl(hubPublicUrl, repo.meta.repoId, options.operationId),
          TILLER_REPO_GIT_ARTIFACT_ID: options.stagedGitArtifactId,
        }
      : {}),
    ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
  };
}
