import {
  asPlanArtifact,
  renderArtifactBodyMarkdown,
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
import { mintCodexGatewaySessionToken } from "../gateway-session";
import {
  buildScmContainerEnvVars,
  type StartupPlanSelection,
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
import type { SelectedRepoWorkspace } from "../plan/store";
import type { RepoScmOperationType } from "../scm/repo-merge-lock-do";
import workspacePolicy from "./workspace-policy.json";
import { isGitHubAppAllowedForRequest } from "../github/app";
import {
  bridgeCredentialsToEnvVars,
  createGitHubBridgeRecord,
} from "../github/bridge";

export type RepoWorkspaceHandle = SelectedRepoWorkspace;

export const ENV_ONLY_CANONICAL_EXCLUDES = workspacePolicy.envOnlyCanonicalExcludes;
export const TREE_HASH_EXCLUDES = ENV_ONLY_CANONICAL_EXCLUDES;
export const STARTUP_PLAN_IMPLEMENTATION_PREAMBLE = [
  "A previous agent produced the plan below to accomplish the user's task. Implement the plan in a fresh context.",
  "Treat the plan as the source of user intent, re-read files as needed, and carry the work through implementation",
  "and verification.",
].join("\n");

interface RepoPlanSource {
  meta: Pick<RepoMeta, "repoId" | "mainCommit">;
}

type StartupArtifactStore = Pick<ArtifactStoreDO, "getArtifact" | "listLatestTodoPlansForMain">;

export function buildStartupPlanDocument(planText: string): string {
  const trimmed = planText.trim();
  if (!trimmed) {
    return STARTUP_PLAN_IMPLEMENTATION_PREAMBLE;
  }

  const normalized = trimmed.replace(/\r\n/g, "\n");
  if (normalized.startsWith(STARTUP_PLAN_IMPLEMENTATION_PREAMBLE)) {
    return trimmed;
  }

  return `${STARTUP_PLAN_IMPLEMENTATION_PREAMBLE}\n\n${trimmed}`;
}

async function resolveLatestTodoPlan(
  artifactStore: StartupArtifactStore,
  repoId: string,
  mainCommit: string | null,
): Promise<PlanArtifact | null> {
  if (!mainCommit) return null;
  return (await artifactStore.listLatestTodoPlansForMain(repoId, mainCommit, 1))[0] as PlanArtifact | undefined ?? null;
}

async function resolveSelectedPlanArtifact(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<PlanArtifact | null> {
  if (selection.mode === "none") {
    return null;
  }

  const selectedPlan = selection.mode === "specific"
    ? asPlanArtifact(await artifactStore.getArtifact(selection.artifactId))
    : await resolveLatestTodoPlan(
      artifactStore,
      repo.meta.repoId,
      currentMainCommit,
    );

  if (!selectedPlan) {
    if (selection.mode === "todo") return null;
    throw new Error(`Plan artifact not found: ${selection.artifactId}`);
  }

  if (
    selection.mode !== "specific" &&
    selectedPlan.basis.mainCommit !== currentMainCommit
  ) {
    throw new Error(
      `Plan artifact ${selectedPlan.id} belongs to ${selectedPlan.basis.mainCommit ?? "unknown main"}, expected ${currentMainCommit ?? "unknown main"}.`,
    );
  }

  return selectedPlan;
}

export async function resolveSelectedPlanId(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit, selection);
  return selectedPlan?.id ?? null;
}

export async function materializeStartupPlan(
  repo: RepoPlanSource,
  artifactStore: StartupArtifactStore,
  envWorkspace: ReturnType<typeof getWorkspaceStub>,
  meta: EnvMeta,
  currentMainCommit: string | null,
  selection: StartupPlanSelection,
): Promise<string | null> {
  const selectedPlan = await resolveSelectedPlanArtifact(repo, artifactStore, meta, currentMainCommit, selection);
  if (selectedPlan) {
    await envWorkspace.writeWorkspaceFile(
      "/.tiller/plan.md",
      buildStartupPlanDocument(renderArtifactBodyMarkdown(selectedPlan.body)),
    );
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
  repoMeta: Pick<RepoMeta, "repoId" | "gitArtifactId" | "githubFullName"> | null | undefined,
  meta: EnvMeta,
  options?: {
    hostMachineId?: string | null;
  },
): Promise<{
  envVars: Record<string, string>;
  meta: Pick<EnvMeta, "harness" | "authMode" | "resolvedAuthMode" | "codexAuthPreference" | "codexAuthMode" | "opencodeProvider" | "opencodeModel" | "modelRoute" | "authWarning">;
}> {
  const backend = meta.backend;
  const harness = meta.harness;
  const runnerId = meta.runnerId ?? slug;
  const hubPublicUrl = await resolveContainerHubUrl(env, requestUrl, backend);
  const protection = await resolveProtectionState(env, requestUrl);
  const githubBridge = repoMeta?.githubFullName && await isGitHubAppAllowedForRequest(env, new Request(requestUrl))
    ? await createGitHubBridgeRecord(env, {
        subject: { type: "interactive-env", envSlug: slug },
        githubFullName: repoMeta.githubFullName,
      })
    : null;
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
    NODE_OPTIONS: "--dns-result-order=ipv4first",
    TILLER_HARNESS: harness,
    ...buildScmContainerEnvVars(meta),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
    ...(githubBridge ? bridgeCredentialsToEnvVars(githubBridge) : {}),
  };

  if (harness === "codex") {
    const codexAuthPreference = backend === "host" ? "auto" : (meta.codexAuthPreference ?? "auto");
    const gatewayRoute = codexAuthPreference === "api-key"
      ? undefined
      : await resolveCodexModelRoute(env, {
        target: backend === "host" ? "host" : "hosted",
        machineId: backend === "host" ? (options?.hostMachineId ?? meta.runnerMachineId ?? null) : null,
        allowApiFallback: codexAuthPreference !== "subscription",
      });
    const gatewaySession = codexAuthPreference !== "api-key"
      && (gatewayRoute?.kind === "gateway-subscription" || gatewayRoute?.kind === "host-gateway")
      ? await mintCodexGatewaySessionToken(env, {
        envSlug: slug,
        routeKind: gatewayRoute.kind,
        machineId: gatewayRoute.machineId,
        gatewayUrl: gatewayRoute.kind === "gateway-subscription" ? gatewayRoute.gatewayUrl : null,
      })
      : null;
    const auth = await resolveCodexContainerAuth(env, {
      backend,
      gatewayRoute: gatewayRoute ?? undefined,
      authPreference: codexAuthPreference,
      gatewaySessionToken: gatewaySession?.token ?? null,
    });
    return {
      envVars: {
        ...commonEnvVars,
        TILLER_CODEX_AUTH_PREFERENCE: auth.authPreference,
        TILLER_CODEX_AUTH_MODE: auth.resolvedAuthMode,
        TILLER_CODEX_MODEL_ROUTE: auth.modelRoute,
        ...(auth.authWarning ? { TILLER_CODEX_AUTH_WARNING: auth.authWarning } : {}),
        ...auth.envVars,
      },
      meta: {
        harness,
        codexAuthPreference: auth.authPreference,
        codexAuthMode: auth.resolvedAuthMode,
        modelRoute: auth.modelRoute,
        ...(auth.authWarning ? { authWarning: auth.authWarning } : {}),
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
    stored: backend === "host" ? "auto" : (meta.authMode ?? null),
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
  const jobSlug = `scm-op-${meta.slug}-${options.operationId.slice(-8)}`;
  const githubBridge = await isGitHubAppAllowedForRequest(env, new Request(requestUrl))
    ? await createGitHubBridgeRecord(env, {
        subject: {
          type: "scm-operation",
          jobSlug,
          envSlug: meta.slug,
          repoId: repo.meta.repoId,
          operationId: options.operationId,
        },
        githubFullName: repo.meta.githubFullName,
      })
    : null;
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
    HUB_URL: hubPublicUrl,
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
    ...((options.operationType === "merge-into-main" || options.operationType === "update-from-main")
      ? {
          TILLER_SCM_HEARTBEAT_URL: buildEnvScmOperationHeartbeatUrl(hubPublicUrl, meta.slug, options.operationId),
          TILLER_SCM_CONFLICT_RESOLUTION_URL: buildEnvScmConflictResolutionUrl(
            hubPublicUrl,
            meta.slug,
            options.operationId,
          ),
          ...(options.mergeLockToken ? { TILLER_SCM_MERGE_LOCK_TOKEN: options.mergeLockToken } : {}),
        }
      : {}),
    ...(options.operationType === "merge-into-main" && options.stagedGitArtifactId
      ? {
          TILLER_REPO_GIT_STAGING_URL: buildRepoGitArtifactStagingUrl(hubPublicUrl, repo.meta.repoId, options.operationId),
          TILLER_REPO_GIT_ARTIFACT_ID: options.stagedGitArtifactId,
        }
      : {}),
    ...(githubBridge ? bridgeCredentialsToEnvVars(githubBridge) : {}),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
  };
}
