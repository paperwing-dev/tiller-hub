import { getArtifactStoreStub, getEnvLifecycleStub, getGitHubJobStub, getWorkspaceStub } from "../helpers";
import type { Env, EnvMeta, ExecutionPlacement, RepoMeta } from "../types";
import { buildEnvWorkspaceApiBaseUrl, resolveContainerHubUrl } from "../env/hub-url";
import { getRunnerBackend } from "../env/runner-backends";
import { getHub, projectAndPersistEnvSummary, projectEnvMetaForAction } from "../env/service";
import { isLifecycleStopInProgress } from "../env-lifecycle";
import { loadRepo, type RepoWorkspace } from "../repo/access";
import {
  bridgeCredentialsToEnvVars,
  createGitHubBridgeRecord,
  revokeGitHubBridgesForEnvPublish,
} from "./bridge";
import { buildGitHubEnvBranchName, createGitHubPendingPublishProjection } from "../scm/model";
import {
  computeGitHubDraftChangeSetHash,
} from "./draft-overlay";
import { resolveProtectionState } from "../protection";
import { getSecret } from "../setup/config";
import { readAccessServiceCredential } from "../access/credentials";
import {
  createPullRequest,
  findOpenPullRequest,
  readCommitRef,
  readRepositoryDefaultBranch,
  updatePullRequest,
  type GitHubApiClient,
  type GitHubTreeSnapshot,
} from "./git-api";
import { projectEnvSummary } from "../sync/projectors";
import { adoptionPayload, hmacHex } from "./adoption";
import { assertSupportedGitHubBaseMetadata } from "./metadata-validation";
import { TREE_HASH_EXCLUDES } from "../env/launch-config";
import { GitHubAppError, mintGitHubInstallationToken, resolveGitHubAppBotCommitIdentity } from "./app";
import { canonicalizeGitHubRepo } from "./repo";
import { asPlanArtifact, renderArtifactBodyMarkdown } from "../coordination";
import {
  buildDraftPrContent,
  buildManagedPrSection,
  upsertManagedPrSection,
  type DraftPrChangedFile,
  type DraftPrContent,
} from "./pr-content";
import {
  EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
  NEW_EXECUTION_UNAVAILABLE_MESSAGE,
  resolveNewExecutionPlacement,
} from "../execution";
import type { GitHubPublishOperationRecord } from "../env-lifecycle-do";
import {
  buildGitHubPublishJobMeta,
  cleanupGitHubPublishRuntime,
} from "./publish-runtime";
import { broadcastPlanArtifactUpdatedHint } from "../plan-artifact-hints";

type RouteResult = { status: number; body: Record<string, unknown> };

function nowIso(): string {
  return new Date().toISOString();
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomSecret(bytes = 32): string {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return base64Url(value);
}

function createOperationId(): string {
  return `ghpub-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function publishFailureNeedsAttention(code: string | null, message: string): boolean {
  if (code === "unsupported_metadata" || code === "unsafe_path") return true;
  return code === "branch_changed_on_github"
    && /(?:moved from .+ to .+|already exists|no longer exists)/i.test(message);
}

function retryableBranchStatus(meta: EnvMeta): EnvMeta["branchStatus"] {
  return meta.branchStatus === "needs-attention" ? "ready-to-merge" : meta.branchStatus;
}

function withIncarnationPublishBranch(meta: EnvMeta): EnvMeta {
  const legacyBranch = buildGitHubEnvBranchName(meta.slug);
  if (
    meta.githubBranch !== legacyBranch
    || meta.githubHeadCommitSha
    || meta.githubPrNumber
  ) {
    return meta;
  }
  return {
    ...meta,
    githubBranch: buildGitHubEnvBranchName(meta.slug, meta.incarnationId),
  };
}

async function ensureDraftPullRequest(args: {
  env: Env;
  meta: EnvMeta;
  repo: RepoMeta;
  branchHeadSha: string;
  workspaceHash: string;
  content: DraftPrContent;
}): Promise<{ number: number; htmlUrl: string }> {
  const repo = canonicalizeGitHubRepo(args.repo.githubFullName, { allowOwnerRepo: true });
  const token = await mintGitHubInstallationToken(args.env, repo, { access: "write" });
  const client: GitHubApiClient = { token: token.token, repo };
  const defaultBranch = await readRepositoryDefaultBranch(client);
  const branch = args.meta.githubBranch ?? "";
  const section = buildManagedPrSection({
    content: args.content,
    envSlug: args.meta.slug,
    baseCommitSha: args.meta.githubBaseCommitSha,
    branchHeadSha: args.branchHeadSha,
    workspaceHash: args.workspaceHash,
    defaultBranch,
    updatedAt: nowIso(),
  });
  const existing = await findOpenPullRequest(client, branch);
  if (existing) {
    const updated = await updatePullRequest(client, existing.number, {
      title: args.content.title,
      body: upsertManagedPrSection(existing.body, section),
      base: defaultBranch,
    });
    return { number: updated.number, htmlUrl: updated.htmlUrl };
  }
  const created = await createPullRequest(client, {
    title: args.content.title,
    body: upsertManagedPrSection(null, section),
    head: branch,
    base: defaultBranch,
    draft: true,
  });
  return { number: created.number, htmlUrl: created.htmlUrl };
}

async function readExistingEnvBranchHead(args: {
  env: Env;
  meta: EnvMeta;
  repo: RepoMeta;
}): Promise<string | null> {
  const branch = args.meta.githubBranch;
  if (!branch || args.meta.githubHeadCommitSha) return null;
  const repo = canonicalizeGitHubRepo(args.repo.githubFullName, { allowOwnerRepo: true });
  const token = await mintGitHubInstallationToken(args.env, repo, { access: "write" });
  const client: GitHubApiClient = { token: token.token, repo };
  return await readCommitRef(client, "heads", branch);
}

async function buildPublishEnvVars(args: {
  env: Env;
  requestUrl: string;
  repo: RepoWorkspace;
  meta: EnvMeta;
  operationId: string;
  workspaceHash: string;
  expectedPriorHead: string | null;
  adoptionHmac: string;
  callbackToken: string;
  commitTitle: string;
  commitAuthorName: string;
  commitAuthorEmail: string;
  jobSlug: string;
  placement: ExecutionPlacement;
  githubTokenAccess: "write" | "publish";
}): Promise<Record<string, string>> {
  const hubPublicUrl = await resolveContainerHubUrl(
    args.env,
    args.requestUrl,
    args.placement.backend,
  );
  const protection = await resolveProtectionState(args.env, args.requestUrl);
  const githubBridge = await createGitHubBridgeRecord(args.env, {
    subject: {
      type: "github-env-publish",
      jobSlug: args.jobSlug,
      envSlug: args.meta.slug,
      repoId: args.repo.meta.repoId,
      operationId: args.operationId,
      tokenAccess: args.githubTokenAccess,
    },
    githubFullName: args.repo.meta.githubFullName,
  });
  const accessCredential = protection.protectionMode === "cf-access"
    ? await readAccessServiceCredential(args.env, hubPublicUrl)
    : null;
  const cfClientId = accessCredential?.clientId ?? "";
  const cfClientSecret = accessCredential?.clientSecret ?? "";

  return {
    TILLER_BOOTSTRAP_MODE: "github-env-publish",
    TILLER_ENV_SLUG: args.meta.slug,
    TILLER_REPO_ID: args.repo.meta.repoId,
    TILLER_GITHUB_PUBLISH_OPERATION_ID: args.operationId,
    TILLER_GITHUB_BASE_BRANCH: args.meta.githubBaseBranch ?? args.repo.meta.githubDefaultBranch ?? "",
    TILLER_GITHUB_BASE_COMMIT_SHA: args.meta.githubBaseCommitSha ?? "",
    TILLER_GITHUB_BRANCH: args.meta.githubBranch ?? "",
    TILLER_GITHUB_EXPECTED_HEAD: args.expectedPriorHead ?? "",
    TILLER_GITHUB_WORKSPACE_HASH: args.workspaceHash,
    TILLER_GITHUB_ADOPTION_HMAC: args.adoptionHmac,
    TILLER_GITHUB_CALLBACK_TOKEN: args.callbackToken,
    TILLER_GITHUB_COMMIT_TITLE: args.commitTitle,
    TILLER_GITHUB_COMMIT_AUTHOR_NAME: args.commitAuthorName,
    TILLER_GITHUB_COMMIT_AUTHOR_EMAIL: args.commitAuthorEmail,
    TILLER_GITHUB_PUBLISH_RESULT_URL: `${hubPublicUrl.replace(/\/+$/, "")}/api/envs/${encodeURIComponent(args.meta.slug)}/github/publish-draft-pr/${encodeURIComponent(args.operationId)}/result`,
    TILLER_ENV_WORKSPACE_API_BASE: buildEnvWorkspaceApiBaseUrl(hubPublicUrl, args.meta.slug),
    TILLER_ENV_ONLY_PATHS: TREE_HASH_EXCLUDES.join(","),
    HUB_URL: hubPublicUrl,
    REPO_URL: args.repo.meta.repoUrl,
    NODE_OPTIONS: "--dns-result-order=ipv4first",
    ...bridgeCredentialsToEnvVars(githubBridge),
    ...(cfClientId ? { CF_ACCESS_CLIENT_ID: cfClientId } : {}),
    ...(cfClientSecret ? { CF_ACCESS_CLIENT_SECRET: cfClientSecret } : {}),
  };
}

function publishCleanupFailure(
  operation: GitHubPublishOperationRecord,
  error: unknown,
): RouteResult {
  return {
    status: 503,
    body: {
      error: operation.executionPlacement.backend === "host"
        ? EXISTING_EXECUTION_UNAVAILABLE_MESSAGE
        : error instanceof Error
          ? error.message
          : String(error),
      code: "github_publish_cleanup_pending",
    },
  };
}

async function hasDraftDiffAgainstBase(args: {
  meta: EnvMeta;
  workspaceHash: string;
  hasDraftChanges: boolean;
}): Promise<boolean> {
  if (args.meta.githubLastPublishedWorkspaceHash === args.workspaceHash) {
    return false;
  }
  if (args.hasDraftChanges) return true;
  return Boolean(args.meta.githubHeadCommitSha);
}

async function readGitHubDraftChangeSet(args: {
  env: Env;
  meta: EnvMeta;
  baseTree: GitHubTreeSnapshot;
}): Promise<{
  workspaceHash: string;
  hasDraftChanges: boolean;
  changedFiles: DraftPrChangedFile[];
}> {
  const workspace = getWorkspaceStub(args.env, args.meta.slug);
  const [draftManifest, deletedPaths] = await Promise.all([
    workspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
    workspace.readGitHubDeletedWorkspacePaths(),
  ]);
  const workspaceHash = await computeGitHubDraftChangeSetHash({
    draftManifest,
    deletedPaths,
  });
  return {
    workspaceHash,
    hasDraftChanges: draftManifest.length > 0 || deletedPaths.length > 0,
    changedFiles: [
      ...draftManifest.map((entry) => ({
        path: entry.path,
        status: args.baseTree.entries.has(entry.path.replace(/^\/+/, ""))
          ? "modified" as const
          : "added" as const,
      })),
      ...deletedPaths
        .filter((path) => args.baseTree.entries.has(path.replace(/^\/+/, "")))
        .map((path) => ({
          path,
          status: "deleted" as const,
        })),
    ],
  };
}

function changesGitHubWorkflows(changedFiles: readonly DraftPrChangedFile[]): boolean {
  return changedFiles.some((file) => file.path.replace(/^\/+/, "").startsWith(".github/workflows/"));
}

async function readStartupPlanContext(
  env: Env,
  meta: Pick<EnvMeta, "repoId" | "startupPlanId">,
  repo: Pick<RepoMeta, "repoId" | "artifactStoreGeneration">,
): Promise<{ title: string; markdown: string } | null> {
  if (!meta.startupPlanId || repo.repoId !== meta.repoId) return null;
  try {
    const artifact = asPlanArtifact(
      await getArtifactStoreStub(
        env,
        meta.repoId,
        repo.artifactStoreGeneration,
      ).getArtifact(meta.startupPlanId),
    );
    if (!artifact || artifact.repoId !== meta.repoId) return null;
    return {
      title: artifact.title,
      markdown: renderArtifactBodyMarkdown(artifact.body),
    };
  } catch (error) {
    console.warn(
      `[github-publish] Failed to read startup plan ${meta.startupPlanId}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function completeStartupPlan(
  env: Env,
  meta: Pick<EnvMeta, "repoId" | "startupPlanId">,
  repo: Pick<RepoMeta, "repoId" | "artifactStoreGeneration">,
): Promise<void> {
  if (!meta.startupPlanId || repo.repoId !== meta.repoId) return;
  const artifactStore = getArtifactStoreStub(
    env,
    meta.repoId,
    repo.artifactStoreGeneration,
  );
  const plan = asPlanArtifact(await artifactStore.getArtifact(meta.startupPlanId));
  if (!plan || plan.repoId !== meta.repoId) return;
  const alreadyTerminal = plan.status === "completed" || plan.status === "archived";
  if (alreadyTerminal) {
    await artifactStore.getRetainedTerminalPlanCleanupWork(meta.repoId, meta.startupPlanId);
  } else {
    await artifactStore.updateArtifactStatus({
      repoId: meta.repoId,
      id: meta.startupPlanId,
      status: "completed",
    });
  }
  if (!alreadyTerminal) {
    await broadcastPlanArtifactUpdatedHint(env, meta.repoId, meta.startupPlanId);
  }
}

export async function startGitHubDraftPrPublish(args: {
  env: Env;
  requestUrl: string;
  slug: string;
}): Promise<RouteResult> {
  const storedMeta = await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug, { broadcast: false });
  if (!storedMeta) return { status: 404, body: { error: "Not found" } };
  if (storedMeta.scmModel !== "github") {
    return { status: 409, body: { error: "Environment is not GitHub-backed.", code: "env_not_github_backed" } };
  }
  if (isLifecycleStopInProgress(storedMeta)) {
    return { status: 409, body: { error: "Environment is still saving changes.", code: "env_stop_finalizing" } };
  }
  if (storedMeta.githubPublishOperationId || storedMeta.githubPublishStatus === "publishing") {
    return { status: 409, body: { error: "A GitHub publish is already in progress.", code: "github_publish_in_progress" } };
  }
  if ((storedMeta.workspaceNeedsAttention && storedMeta.githubPublishStatus !== "failed") || storedMeta.githubPublishStatus === "attention") {
    return { status: 409, body: { error: "GitHub branch needs attention before publishing.", code: "github_branch_needs_attention" } };
  }

  const backend = await getRunnerBackend(args.env, storedMeta.backend);
  const projected = await projectEnvMetaForAction(args.env, storedMeta, backend);
  const meta = withIncarnationPublishBranch(projected.meta);
  if (meta.status !== "stopped") {
    return { status: 409, body: { error: "Environment must be stopped before publishing a draft PR.", code: "env_not_stopped" } };
  }
  if (!meta.githubBaseCommitSha || !meta.githubBranch) {
    return { status: 409, body: { error: "Environment is missing GitHub base metadata.", code: "github_env_base_missing" } };
  }

  const loadedRepo = await loadRepo(args.env, meta.repoId);
  if (!loadedRepo.ok) return { status: loadedRepo.status, body: loadedRepo.body };
  const repo = loadedRepo.repo;
  let baseTree: GitHubTreeSnapshot;
  let installationToken: string;
  try {
    const validatedBase = await assertSupportedGitHubBaseMetadata({
      env: args.env,
      repo: repo.meta,
      baseCommitSha: meta.githubBaseCommitSha,
    });
    baseTree = validatedBase.tree;
    installationToken = validatedBase.installationToken;
  } catch (error) {
    return {
      status: 409,
      body: {
        error: error instanceof Error ? error.message : "Unsupported GitHub repository metadata.",
        code: "unsupported_github_metadata",
      },
    };
  }
  const draftChangeSet = await readGitHubDraftChangeSet({
    env: args.env,
    meta,
    baseTree,
  });
  const githubTokenAccess = changesGitHubWorkflows(draftChangeSet.changedFiles) ? "publish" : "write";
  if (githubTokenAccess === "publish") {
    try {
      const githubRepo = canonicalizeGitHubRepo(repo.meta.githubFullName, { allowOwnerRepo: true });
      installationToken = (await mintGitHubInstallationToken(args.env, githubRepo, { access: "publish" })).token;
    } catch (error) {
      return {
        status: error instanceof GitHubAppError ? error.status : 502,
        body: {
          error: error instanceof Error ? error.message : "GitHub workflow publishing permission is unavailable.",
          code: error instanceof GitHubAppError ? error.code : "github_app_token_create_failed",
        },
      };
    }
  }
  const workspaceHash = draftChangeSet.workspaceHash;
  const recoveredPriorHead = await readExistingEnvBranchHead({
    env: args.env,
    meta,
    repo: repo.meta,
  });

  if (!await hasDraftDiffAgainstBase({ meta, workspaceHash, hasDraftChanges: draftChangeSet.hasDraftChanges })) {
    const lifecycle = getEnvLifecycleStub(args.env, meta.slug);
    await lifecycle.recordStopWorkspaceSynced({
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: meta.workspaceLastSyncedAt,
      baseMainCommit: null,
      lastKnownMainCommit: null,
      branchStatus: "up-to-date",
      githubBaseBranch: meta.githubBaseBranch,
      githubBaseCommitSha: meta.githubBaseCommitSha,
      githubHeadCommitSha: meta.githubHeadCommitSha,
      githubPrNumber: meta.githubPrNumber,
      githubPrUrl: meta.githubPrUrl,
      githubPrState: meta.githubPrState,
      githubMergedAt: meta.githubMergedAt,
      githubPublishStatus: meta.githubHeadCommitSha ? "published" : "up-to-date",
      githubPublishOperationId: null,
      githubPublishError: null,
      githubLastPublishedAt: meta.githubHeadCommitSha ? nowIso() : meta.githubLastPublishedAt,
      githubLastPublishedWorkspaceHash: workspaceHash,
      githubPendingPublish: null,
    }, { clearError: true });
    const projected = await projectAndPersistEnvSummary(args.env, getHub(args.env), meta.slug);
    return {
      status: 200,
      body: {
        ok: true,
        slug: meta.slug,
        noChanges: true,
        env: projected ? projectEnvSummary(projected) : null,
      },
    };
  }

  const planContext = await readStartupPlanContext(args.env, meta, repo.meta);
  const pullRequestContent = buildDraftPrContent({
    envSlug: meta.slug,
    changedFiles: draftChangeSet.changedFiles,
    planTitle: planContext?.title,
    planMarkdown: planContext?.markdown,
  });
  let commitIdentity: Awaited<ReturnType<typeof resolveGitHubAppBotCommitIdentity>>;
  try {
    commitIdentity = await resolveGitHubAppBotCommitIdentity(args.env, installationToken);
  } catch (error) {
    return {
      status: 502,
      body: {
        error: error instanceof Error ? error.message : "Failed to resolve GitHub App commit identity.",
        code: "github_app_bot_identity_unavailable",
      },
    };
  }

  const operationId = createOperationId();
  const hmacKey = randomSecret();
  const callbackToken = randomSecret();
  const expectedPriorHead = meta.githubHeadCommitSha ?? recoveredPriorHead ?? null;
  const adoptionHmac = await hmacHex(hmacKey, adoptionPayload({
    envSlug: meta.slug,
    operationId,
    workspaceHash,
    expectedPriorHead,
    baseCommitSha: meta.githubBaseCommitSha,
  }));
  const startedAt = nowIso();
  let placement: ExecutionPlacement;
  try {
    placement = await resolveNewExecutionPlacement(args.env);
  } catch {
    return {
      status: 503,
      body: {
        error: NEW_EXECUTION_UNAVAILABLE_MESSAGE,
        code: "execution_backend_unavailable",
      },
    };
  }
  const jobSlug = `github-publish-${meta.slug}-${operationId.slice(-8)}`;
  const projection = createGitHubPendingPublishProjection({
    operationId,
    branch: meta.githubBranch,
    baseCommitSha: meta.githubBaseCommitSha,
    workspaceHash,
    expectedPriorHead,
    startedAt,
  });
  const lifecycle = getEnvLifecycleStub(args.env, meta.slug);
  const publishClaim = await lifecycle.beginGitHubPublishOperation({
    operationId,
    envSlug: meta.slug,
    repoId: repo.meta.repoId,
    repoUrl: repo.meta.repoUrl,
    jobSlug,
    executionPlacement: placement,
    branch: meta.githubBranch,
    baseCommitSha: meta.githubBaseCommitSha,
    workspaceHash,
    expectedPriorHead,
    hmacKey,
    callbackToken,
    pullRequestContent,
    startedAt,
    projection,
  });
  if (!publishClaim.claimed) {
    return {
      status: 409,
      body: {
        error: "A GitHub publish is already in progress.",
        code: "github_publish_in_progress",
      },
    };
  }
  const publishingMeta = await projectAndPersistEnvSummary(args.env, getHub(args.env), meta.slug);

  try {
    const envVars = await buildPublishEnvVars({
      env: args.env,
      requestUrl: args.requestUrl,
      repo,
      meta: {
        ...(publishingMeta ?? meta),
        githubBranch: meta.githubBranch,
      },
      operationId,
      workspaceHash,
      expectedPriorHead,
      adoptionHmac,
      callbackToken,
      commitTitle: pullRequestContent.title,
      commitAuthorName: commitIdentity.name,
      commitAuthorEmail: commitIdentity.email,
      jobSlug,
      placement,
      githubTokenAccess,
    });
    if (placement.backend === "host") {
      const jobBackend = await getRunnerBackend(args.env, "host");
      await jobBackend.create(buildGitHubPublishJobMeta({
        slug: jobSlug,
        repoUrl: repo.meta.repoUrl,
        repoId: repo.meta.repoId,
        placement,
      }), envVars, {
        runnerCommand: {
          commandGeneration: 1,
          operationId,
          desiredState: "running",
        },
      });
    } else {
      await getGitHubJobStub(args.env, jobSlug).startJob(envVars);
    }
  } catch (error) {
    const operation = await lifecycle.getGitHubPublishOperation();
    if (operation?.operationId === operationId) {
      try {
        await cleanupGitHubPublishRuntime(args.env, operation);
      } catch (cleanupError) {
        const message = error instanceof Error ? error.message : String(error);
        await lifecycle.markGitHubPublishCleanupPending({
          operationId,
          terminalError: message,
        });
        return publishCleanupFailure(operation, cleanupError);
      }
    }
    const message = error instanceof Error ? error.message : String(error);
    await lifecycle.finishGitHubPublishOperation({
      operationId,
      patch: {
        githubPublishStatus: "failed",
        githubPublishError: message,
        workspaceNeedsAttention: false,
        branchStatus: retryableBranchStatus(meta),
      },
    });
    await revokeGitHubBridgesForEnvPublish(args.env, { repoId: repo.meta.repoId, operationId }).catch(() => {});
    await projectAndPersistEnvSummary(args.env, getHub(args.env), meta.slug);
    return { status: 502, body: { error: message, code: "github_publish_start_failed" } };
  }

  return {
    status: 202,
    body: {
      ok: true,
      slug: meta.slug,
      operationId,
      pending: true,
      branch: meta.githubBranch,
    },
  };
}

export async function handleGitHubDraftPrPublishResult(args: {
  env: Env;
  slug: string;
  operationId: string;
  body: Record<string, unknown>;
}): Promise<RouteResult> {
  const lifecycle = getEnvLifecycleStub(args.env, args.slug);
  const resultClaimId = `github-publish-result-${crypto.randomUUID()}`;
  const resultClaim = await lifecycle.claimGitHubPublishResult({
    operationId: args.operationId,
    callbackToken: typeof args.body.callbackToken === "string" ? args.body.callbackToken : "",
    workspaceHash: typeof args.body.workspaceHash === "string" ? args.body.workspaceHash : "",
    claimId: resultClaimId,
  });
  switch (resultClaim.status) {
    case "invalid":
      return { status: 403, body: { error: "Publish callback did not match the active operation.", code: "github_publish_callback_invalid" } };
    case "cleanup_pending":
      return { status: 409, body: { error: "Publish runtime cleanup is already pending.", code: "github_publish_cleanup_pending" } };
    case "in_progress":
      return { status: 409, body: { error: "This publish result is already being processed.", code: "github_publish_result_in_progress" } };
    case "inactive":
      return { status: 409, body: { error: "Publish operation is no longer active.", code: "github_publish_not_active" } };
    case "claimed":
      break;
  }
  const operation = resultClaim.operation;
  const meta = await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug, { broadcast: false });
  if (!meta) {
    await lifecycle.markGitHubPublishCleanupPending({
      operationId: args.operationId,
      resultClaimId,
      terminalError: "The environment was removed while its GitHub publish result was being processed.",
    });
    return { status: 404, body: { error: "Not found" } };
  }
  try {
    await cleanupGitHubPublishRuntime(args.env, operation);
  } catch (error) {
    await lifecycle.markGitHubPublishCleanupPending({
      operationId: args.operationId,
      resultClaimId,
      terminalError: "GitHub publish runtime cleanup was interrupted after its result was received. Retry publishing.",
    });
    return publishCleanupFailure(operation, error);
  }

  const status = typeof args.body.status === "string" ? args.body.status : "";
  const branchHeadSha = typeof args.body.branchHeadSha === "string" && args.body.branchHeadSha.trim()
    ? args.body.branchHeadSha.trim()
    : null;
  const repo = await loadRepo(args.env, meta.repoId);
  const repoMeta = repo.ok ? repo.repo.meta : null;

  if (status === "failed") {
    const message = typeof args.body.error === "string" && args.body.error.trim()
      ? args.body.error.trim()
      : "GitHub publish failed.";
    const code = typeof args.body.code === "string" && args.body.code.trim()
      ? args.body.code.trim()
      : null;
    const needsAttention = publishFailureNeedsAttention(code, message);
    const finish = await lifecycle.finishGitHubPublishOperation({
      operationId: args.operationId,
      resultClaimId,
      patch: {
        githubPublishStatus: "failed",
        githubPublishError: message,
        workspaceNeedsAttention: needsAttention,
        branchStatus: needsAttention ? "needs-attention" : retryableBranchStatus(meta),
      },
    });
    if (!finish.applied) {
      return { status: 409, body: { error: "Publish operation is no longer active.", code: "github_publish_not_active" } };
    }
    await revokeGitHubBridgesForEnvPublish(args.env, { repoId: meta.repoId, operationId: args.operationId }).catch(() => {});
    const projected = await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
    return { status: 200, body: { ok: true, slug: args.slug, status: "failed", env: projected } };
  }

  const hasPublishedBranchHead = Boolean(branchHeadSha);
  if (hasPublishedBranchHead && branchHeadSha) {
    const update = await lifecycle.updateGitHubPublishOperation({
      operationId: args.operationId,
      resultClaimId,
      projection: createGitHubPendingPublishProjection({
        operationId: args.operationId,
        branch: operation.branch,
        baseCommitSha: operation.baseCommitSha,
        workspaceHash: operation.workspaceHash,
        expectedPriorHead: operation.expectedPriorHead,
        pushedCommitSha: branchHeadSha,
        status: "finalizing",
        startedAt: operation.startedAt,
      }),
      patch: {
        githubHeadCommitSha: branchHeadSha,
        githubPublishStatus: "publishing",
        githubPublishError: null,
      },
    });
    if (!update.applied) {
      return { status: 409, body: { error: "Publish operation is no longer active.", code: "github_publish_not_active" } };
    }
  }
  let pr: { number: number; htmlUrl: string } | null = null;
  if ((status === "published" || (status === "no_changes" && hasPublishedBranchHead)) && branchHeadSha && repoMeta) {
    pr = await ensureDraftPullRequest({
      env: args.env,
      meta,
      repo: repoMeta,
      branchHeadSha,
      workspaceHash: operation.workspaceHash,
      content: operation.pullRequestContent,
    });
    try {
      await completeStartupPlan(args.env, meta, repoMeta);
    } catch (error) {
      console.warn(
        `[github-publish] Failed to complete startup plan ${meta.startupPlanId ?? "(none)"}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  const publishedAt = nowIso();
  const finish = await lifecycle.finishGitHubPublishOperation({
    operationId: args.operationId,
    resultClaimId,
    patch: {
      githubHeadCommitSha: branchHeadSha ?? meta.githubHeadCommitSha,
      githubPrNumber: pr?.number ?? meta.githubPrNumber,
      githubPrUrl: pr?.htmlUrl ?? meta.githubPrUrl,
      githubPrState: pr ? "open" : meta.githubPrState,
      githubPublishStatus: status === "no_changes" && !hasPublishedBranchHead ? "up-to-date" : "published",
      githubPublishError: null,
      githubLastPublishedAt: publishedAt,
      githubLastPublishedWorkspaceHash: operation.workspaceHash,
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      branchStatus: status === "no_changes" && !branchHeadSha ? "up-to-date" : "ready-to-merge",
    },
  });
  if (!finish.applied) {
    return { status: 409, body: { error: "Publish operation is no longer active.", code: "github_publish_not_active" } };
  }
  await revokeGitHubBridgesForEnvPublish(args.env, { repoId: meta.repoId, operationId: args.operationId }).catch(() => {});
  const projected = await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
  return {
    status: 200,
    body: {
      ok: true,
      slug: args.slug,
      status,
      branchHeadSha,
      prNumber: pr?.number ?? meta.githubPrNumber ?? null,
      prUrl: pr?.htmlUrl ?? meta.githubPrUrl ?? null,
      env: projected,
    },
  };
}
