// Environment CRUD and container lifecycle.
// Workspace state stays in WorkspaceDO; environments run on Cloudflare Containers or Your machine.

import { Hono, type Context } from "hono";
import { getEnvLifecycleStub, getWorkspaceStub } from "../helpers";
import { recordApiTimingPhase } from "../request-timing";
import {
  STARTUP_DIAGNOSTIC_STEP_IDS,
} from "../types";
import type {
  EnvLifecycleState,
  HonoEnv,
  Env,
  EnvMeta,
  StartupDiagnosticLogTails,
  StartupDiagnosticSeverity,
  StartupDiagnosticStepId,
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
} from "../types";
import { isGitHubAppAllowedForRequest, mintGitHubInstallationToken } from "../github/app";
import {
  githubAppPublicHubDisabledBody,
  loadRepoForRequest,
  type RepoAccessResult,
  type RepoWorkspace,
} from "../repo/access";
import {
  refreshGitHubDefaultBranchHeadForRequest,
  type GitHubDefaultBranchRefreshResult,
} from "../repo/refresh";
import { isEnvHarness } from "./harness";
import { getRunnerBackend } from "./runner-backends";
import {
  deriveGitHubEnvBranchStatus,
  hasCurrentMainBase,
  withDerivedBranchBackedEnvStatus,
} from "../scm/model";
import {
  projectEnvSummary,
} from "../sync/projectors";
import {
  buildEnvScmMetaPatch,
  isLifecycleStopInProgress,
  type StopWorkspaceSyncedMetaPatch,
} from "../env-lifecycle";
import {
  getHub,
  clearEnvError,
  listEnvViews,
  loadEnvView,
  projectAndPersistEnvSummary,
  projectEnvMetaForAction,
  projectEnvMetaForRead,
  deleteEnvSnapshotArtifacts,
} from "./service";
import {
  isProjectedRuntimeFailure,
  projectRuntimeFailure,
  runtimeFailureCodeForStartupStep,
} from "./runtime-failure";
import {
  handleGitHubDraftPrPublishResult,
  startGitHubDraftPrPublish,
} from "../github/env-publish-service";
import {
  backendSelectionRemovedError,
} from "../execution";
import {
  TREE_HASH_EXCLUDES,
} from "./launch-config";
import { createEnvAction, deleteEnvAction, startEnvAction, stopEnvAction } from "./lifecycle-actions";
import { isSafePath } from "../workspace/validate";
import { revokeGitHubBridgesForInteractiveEnv } from "../github/bridge";
import { canonicalizeGitHubRepo } from "../github/repo";
import {
  readBlobBytes,
  readCommitTree,
  type GitHubApiClient,
  type GitHubTreeEntry,
  type GitHubTreeSnapshot,
} from "../github/git-api";
import {
  GITHUB_DELETED_PATHS_WORKSPACE_PATH,
  normalizeGitHubDeletedPaths,
} from "../github/draft-overlay";
import {
  codexRuntimeAuthAccountChangedResponse,
  codexRuntimeAuthExchangeErrorResponse,
  codexRuntimeAuthInactiveResponse,
  codexRuntimeAuthSuccessResponse,
  exchangeCodexRuntimeAuth,
  parseCodexRuntimeAuthRequest,
} from "../codex-runtime-auth";
import { ensureEnvironmentSidebarSlots } from "./sidebar-slots";
import { buildWorkspaceSyncedPatch } from "./workspace-synced";
import {
  readManagedEnvSlugFromStoredSession,
  readManagedRoleFromStoredSession,
} from "../session-attachment";

const MAX_CHANGE_PREVIEW_BYTES = 400_000;

type OptionalJsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false };

async function readOptionalJsonObjectBody(request: Request): Promise<OptionalJsonObjectResult> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false };
  }
  if (!text.trim()) return { ok: true, body: {} };

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { ok: true, body: parsed as Record<string, unknown> }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

type EnvChangeStatus = "added" | "modified" | "deleted";
type RepoWorkspaceHandle = RepoWorkspace;

interface EnvChangeEntry {
  path: string;
  status: EnvChangeStatus;
  oldSize: number | null;
  newSize: number | null;
  oldHash: string | null;
  newHash: string | null;
  previewableHint?: "unknown" | "text" | "binary" | "too-large";
}

interface WorkspaceFileStat {
  path: string;
  size: number;
}

interface WorkspacePreviewSource {
  statWorkspaceFile(path: string): WorkspaceFileStat | null | Promise<WorkspaceFileStat | null>;
  readWorkspaceFileBytes(path: string): Promise<Uint8Array | null>;
}

interface EnvChangeFileData {
  entry: EnvChangeEntry;
  oldBytes?: Uint8Array;
  newBytes?: Uint8Array;
}

interface GitHubBasePreviewContext {
  client: GitHubApiClient;
  tree: GitHubTreeSnapshot;
}

type DraftDiffPreviewRoute = "changes" | "changes/file";
type DraftDiffPreviewTimings = Record<string, number>;

function nowForTimingMs(): number {
  return Date.now();
}

function recordDraftDiffPreviewTiming(timings: DraftDiffPreviewTimings | undefined, key: string, startedAt: number): void {
  if (!timings) return;
  timings[key] = Math.max(0, nowForTimingMs() - startedAt);
}

async function timeDraftDiffPreviewStep<T>(
  timings: DraftDiffPreviewTimings | undefined,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!timings) return fn();
  const startedAt = nowForTimingMs();
  try {
    return await fn();
  } finally {
    recordDraftDiffPreviewTiming(timings, key, startedAt);
  }
}

function logDraftDiffPreviewTiming(details: {
  route: DraftDiffPreviewRoute;
  slug: string;
  path?: string;
  statusCode: number;
  outcome: string;
  branchStatus?: string | null;
  fileCount?: number | null;
  previewable?: boolean | null;
  reason?: string | null;
  timings: DraftDiffPreviewTimings;
}): void {
  console.info(`[envs] draft-diff timing ${JSON.stringify(details)}`);
}

function getStopFinalizationInProgressError(action: string): string {
  return `Environment is still saving changes from the previous stop. Wait for it to finish before ${action}.`;
}

function formatLifecycleDebug(lifecycle: EnvLifecycleState | null): Record<string, unknown> | null {
  if (!lifecycle) {
    return null;
  }
  return {
    phase: lifecycle.phase,
    activeOpId: lifecycle.activeOpId,
    activeOperation: lifecycle.activeOperation,
    desiredState: lifecycle.desiredState,
    lastRunnerState: lifecycle.lastRunnerState,
    lastWorkspaceSyncedAckOpId: lifecycle.lastWorkspaceSyncedAckOpId,
    infraState: lifecycle.infraState,
    runtimeReady: lifecycle.runtimeReady,
  };
}

function publicStartupDiagnostics(
  diagnostics: StartupDiagnosticsState,
  slug: string,
): StartupDiagnosticsState {
  const sanitize = (snapshot: StartupDiagnosticsSnapshot | null): StartupDiagnosticsSnapshot | null => {
    if (!snapshot) return null;
    let failureMessage = snapshot.failure?.message ?? null;
    if (failureMessage && !isProjectedRuntimeFailure(failureMessage)) {
      failureMessage = projectRuntimeFailure(
        runtimeFailureCodeForStartupStep(snapshot.failure?.lastStepId ?? snapshot.currentStepId),
        failureMessage,
        { slug, opId: snapshot.opId, source: "legacy-startup-diagnostics" },
      ).message;
    }
    const exposesHarnessOutput = (message?: string | null): boolean =>
      Boolean(message && /tiller-harness last output:/i.test(message));
    const rawHarnessOutputEvent = snapshot.events.find((event) => exposesHarnessOutput(event.message));
    const rawHarnessOutputMessage = rawHarnessOutputEvent?.message
      ?? (exposesHarnessOutput(snapshot.currentStepMessage) ? snapshot.currentStepMessage : null);
    const harnessOutputFailureMessage = rawHarnessOutputMessage
      ? failureMessage ?? projectRuntimeFailure(
          runtimeFailureCodeForStartupStep(rawHarnessOutputEvent?.stepId ?? snapshot.currentStepId),
          rawHarnessOutputMessage,
          { slug, opId: snapshot.opId, source: "legacy-startup-output" },
        ).message
      : null;
    return {
      ...snapshot,
      events: snapshot.events.map((event) => ({
        ...event,
        message: event.severity === "error" && failureMessage
          ? failureMessage
          : exposesHarnessOutput(event.message) && harnessOutputFailureMessage
            ? harnessOutputFailureMessage
            : event.message,
        detail: null,
      })),
      currentStepMessage: failureMessage
        ?? (exposesHarnessOutput(snapshot.currentStepMessage)
          ? harnessOutputFailureMessage
          : snapshot.currentStepMessage),
      failure: snapshot.failure
        ? {
            ...snapshot.failure,
            message: failureMessage!,
            exitCode: null,
            signal: null,
          }
        : null,
      logTails: { harness: null, stopControl: null, bootstrap: null },
    };
  };
  return {
    active: sanitize(diagnostics.active),
    lastFailed: sanitize(diagnostics.lastFailed),
  };
}

async function readProjectedEnvMeta(
  env: Env,
  slug: string,
): Promise<EnvMeta | null> {
  return await loadEnvView(env, slug);
}

async function tryProjectAndPersistEnvSummary(
  env: Env,
  hub: ReturnType<typeof getHub>,
  slug: string,
): Promise<EnvMeta | null> {
  try {
    return await projectAndPersistEnvSummary(env, hub, slug);
  } catch (error) {
    console.warn(
      `[envs] Failed to project env summary after startup diagnostics for ${slug}:`,
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

async function recordStartupDiagnosticFailure(args: {
  env: Env;
  slug: string;
  meta?: EnvMeta | null;
  opId: string;
  stepId?: StartupDiagnosticStepId;
  message: string;
  detail: string | null;
  at: string | null;
  exitCode: number | null;
  signal: string | null;
  logTails: Partial<StartupDiagnosticLogTails> | null;
}): Promise<Record<string, unknown>> {
  const lifecycle = await getEnvLifecycleStub(args.env, args.slug).reportStartupFailure({
    opId: args.opId,
    stepId: args.stepId,
    message: args.message,
    detail: args.detail,
    at: args.at,
    exitCode: args.exitCode,
    signal: args.signal,
    logTails: args.logTails,
  });
  const projected = await tryProjectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
  return {
    ok: true,
    slug: args.slug,
    status: projected?.status ?? lifecycle?.phase ?? args.meta?.status ?? null,
    error: projected?.error ?? args.message.trim(),
  };
}

async function recordStartupDiagnosticEvent(args: {
  env: Env;
  slug: string;
  meta?: EnvMeta | null;
  opId: string;
  stepId: StartupDiagnosticStepId;
  severity: StartupDiagnosticSeverity | null;
  message: string;
  detail: string | null;
  at: string | null;
  logTails: Partial<StartupDiagnosticLogTails> | null;
}): Promise<Record<string, unknown>> {
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);
  await lifecycleStub.reportStartupEvent({
    opId: args.opId,
    stepId: args.stepId,
    severity: args.severity,
    message: args.message,
    detail: args.detail,
    at: args.at,
    logTails: args.logTails,
  });
  const lifecycle = await lifecycleStub.getState();
  const projected = await tryProjectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
  return {
    ok: true,
    slug: args.slug,
    status: projected?.status ?? lifecycle?.phase ?? args.meta?.status ?? null,
  };
}

async function finalizeRunnerStoppedCallback(args: {
  env: Env;
  slug: string;
  opId: string;
  detail: string;
}): Promise<{
  projected: EnvMeta | null;
  failure: ReturnType<typeof projectRuntimeFailure> | null;
}> {
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);
  const lifecycleBefore = await lifecycleStub.getState();
  console.info(
    `[envs] runner-stopped received for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      detail: args.detail || null,
      lifecycleBefore: formatLifecycleDebug(lifecycleBefore),
    })}`,
  );
  const failure = lifecycleBefore?.phase === "starting" || lifecycleBefore?.phase === "running"
    ? projectRuntimeFailure(
        "runtime_stopped_unexpectedly",
        args.detail || "Runner stopped without a detail.",
        { slug: args.slug, opId: args.opId, source: "runner-stopped-callback" },
      )
    : null;
  const lifecycleAfter = await lifecycleStub.noteRunnerStopped(
    args.opId,
    failure?.message ?? null,
  );
  console.info(
    `[envs] runner-stopped applied for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      lifecycleAfter: formatLifecycleDebug(lifecycleAfter),
    })}`,
  );

  const projected = await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug)
    .catch(() => null);
  if (lifecycleAfter?.phase === "stopped") {
    await revokeGitHubBridgesForInteractiveEnv(args.env, args.slug);
    await lifecycleStub.clearStopWorkspaceSyncedMeta().catch(() => {});
  }
  return { projected, failure };
}

async function applyWorkspaceSyncedCallback(args: {
  env: Env;
  slug: string;
  opId: string;
  workspacePatch: Partial<StopWorkspaceSyncedMetaPatch>;
}): Promise<{ accepted: boolean; projected: EnvMeta | null }> {
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);
  const lifecycleBefore = await lifecycleStub.getState();
  console.info(
    `[envs] workspace-synced ack received for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      lifecycleBefore: formatLifecycleDebug(lifecycleBefore),
      workspacePatch: args.workspacePatch,
    })}`,
  );

  const acknowledgement = await lifecycleStub.acceptStopWorkspaceSynced(args.opId, args.workspacePatch);
  const lifecycleAfter = acknowledgement.state;
  console.info(
    `[envs] workspace-synced ack applied for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      lifecycleAfter: formatLifecycleDebug(lifecycleAfter),
    })}`,
  );

  if (!acknowledgement.accepted) {
    return { accepted: false, projected: null };
  }
  return {
    accepted: true,
    projected: await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug).catch(() => null),
  };
}

async function recordStopFailedCallback(args: {
  env: Env;
  slug: string;
  opId: string;
  message: string;
}): Promise<EnvMeta | null> {
  console.warn(
    `[envs] stop-failed received for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      message: args.message,
    })}`,
  );
  await getEnvLifecycleStub(args.env, args.slug).recordWorkspaceSyncFailed(
    args.opId,
    args.message,
  );
  return await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug).catch(() => null);
}

async function applyHarnessFailedCallback(args: {
  env: Env;
  slug: string;
  opId: string;
  errorMessage: string;
}): Promise<{ accepted: boolean; body: Record<string, unknown> }> {
  const hub = getHub(args.env);
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);

  const lifecycle = await lifecycleStub.reportStartupFailure({
    opId: args.opId,
    message: args.errorMessage,
    // A harness process exit does not prove that its container or host runner
    // stopped. Scheduled Runs therefore retain their cleanup guard until the exact
    // Stop operation confirms it.
    runnerMayExist: true,
    leadHarnessFailure: true,
  });
  const accepted = lifecycle?.activeOpId === args.opId
    && lifecycle.activeOperation === "start"
    && lifecycle.desiredState === "running"
    && (lifecycle.phase === "running" || lifecycle.phase === "failed");
  if (!accepted) {
    return {
      accepted: false,
      body: { error: "Harness failure belongs to a stale lifecycle operation." },
    };
  }

  const projected = await projectAndPersistEnvSummary(args.env, hub, args.slug).catch(() => null);
  return {
    accepted: true,
    body: {
      ok: true,
      slug: args.slug,
      status: projected?.status ?? lifecycle.phase,
      leadHarnessStatus: "failed",
    },
  };
}

function readLifecycleOpIdHeader(request: Request): string | null {
  const opId = request.headers.get("X-Tiller-Lifecycle-Op-Id")?.trim();
  return opId || null;
}

function matchesWorkspacePrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

type StoppedEnvRepoContext =
  | { ok: false; status: number; body: Record<string, unknown> }
  | {
      ok: true;
      meta: EnvMeta;
      repo: RepoWorkspaceHandle;
      branchStatus: NonNullable<EnvMeta["branchStatus"]>;
    };
function getRepoGitMetadataNotReadyBody(): { error: string; code: string } & Record<string, unknown> {
  return {
    error: "GitHub default branch metadata is not ready yet for this repository.",
    code: "github_repo_default_branch_not_ready",
  };
}

async function readValidatedRepoContext(
  env: Env,
  args: {
    request: Request;
    repoId: string | null | undefined;
    timings?: DraftDiffPreviewTimings;
    timingKey?: string;
    logPrefix?: string;
    mapUnavailableToGitNotReady?: boolean;
  },
): Promise<RepoAccessResult<RepoWorkspace>> {
  const loadedRepo = await timeDraftDiffPreviewStep(
    args.timings,
    args.timingKey ?? "repoContextMs",
    () => loadRepoForRequest(
      env,
      args.request,
      args.repoId,
    ),
  );
  if (
    !loadedRepo.ok &&
    args.mapUnavailableToGitNotReady &&
    (loadedRepo.body.code === "repo_metadata_unavailable" || loadedRepo.body.code === "repo_not_found")
  ) {
    if (args.logPrefix) {
      console.warn(args.logPrefix, loadedRepo.body.error);
    }
    return {
      ok: false,
      status: 409,
      body: getRepoGitMetadataNotReadyBody(),
    };
  }
  return loadedRepo;
}

function requiredGitHubRepoRefreshResponse(
  refresh: GitHubDefaultBranchRefreshResult,
): { status: number; body: Record<string, unknown> } {
  if (refresh.accessFailure) {
    return { status: refresh.accessFailure.status, body: refresh.accessFailure.body };
  }
  const status = refresh.status ?? (
    refresh.failureKind === "access_error" ? 403 : refresh.failureKind === "not_ready" ? 409 : 502
  );
  return {
    status,
    body: {
      error: refresh.error || "GitHub default branch metadata is unavailable for this repository.",
      code: refresh.code || "github_default_branch_refresh_failed",
    },
  };
}

async function readReadonlyRepoContext(
  env: Env,
  request: Request,
  meta: Pick<EnvMeta, "repoId">,
  timings?: DraftDiffPreviewTimings,
): Promise<RepoAccessResult<RepoWorkspace>> {
  return readValidatedRepoContext(env, {
    request,
    repoId: meta.repoId,
    timings,
    logPrefix: "[envs] Failed to read canonical repo metadata for draft diff:",
    mapUnavailableToGitNotReady: true,
  });
}

async function readStoppedEnvPreviewContext(
  env: Env,
  request: Request,
  slug: string,
  action: string,
  timings?: DraftDiffPreviewTimings,
): Promise<StoppedEnvRepoContext> {
  const loadedMeta = await timeDraftDiffPreviewStep(timings, "readMetaMs", () =>
    readProjectedEnvMeta(env, slug).catch((error) => {
      console.warn(
        "[envs] Failed to read env metadata for draft diff:",
        error instanceof Error ? error.message : String(error),
      );
      return "repo-unavailable" as const;
    })
  );
  if (loadedMeta === "repo-unavailable") {
    return { ok: false, status: 409, body: getRepoGitMetadataNotReadyBody() };
  }
  if (!loadedMeta) {
    return { ok: false, status: 404, body: { error: "Not found" } };
  }

  const meta = await timeDraftDiffPreviewStep(
    timings,
    "reconcileScmMs",
    () => projectEnvMetaForRead(env, loadedMeta),
  );
  if (isLifecycleStopInProgress(meta)) {
    return {
      ok: false,
      status: 409,
      body: {
        error: getStopFinalizationInProgressError(action),
        code: "env_stop_finalizing",
      },
    };
  }
  if ((meta.status ?? "unknown") !== "stopped") {
    return {
      ok: false,
      status: 409,
      body: {
        error: `Environment must be stopped before ${action}.`,
        code: "env_not_stopped",
      },
    };
  }
  const loadedRepo = await readReadonlyRepoContext(env, request, meta, timings);
  if (!loadedRepo.ok) {
    return loadedRepo;
  }

  const deriveStartedAt = nowForTimingMs();
  const syncedMeta = meta.scmModel === "github"
    ? {
        ...meta,
        branchStatus: deriveGitHubEnvBranchStatus(meta, loadedRepo.repo.meta),
      }
    : withDerivedBranchBackedEnvStatus(meta, loadedRepo.repo.meta);
  recordDraftDiffPreviewTiming(timings, "deriveBranchStatusMs", deriveStartedAt);
  return {
    ok: true,
    meta: syncedMeta,
    repo: loadedRepo.repo,
    branchStatus: syncedMeta.branchStatus ?? "up-to-date",
  };
}

function githubTreePath(path: string): string {
  return normalizeWorkspacePath(path).replace(/^\/+/, "");
}

function githubBaseEntry(tree: GitHubTreeSnapshot, path: string): GitHubTreeEntry | null {
  const entry = tree.entries.get(githubTreePath(path));
  return entry?.type === "blob" ? entry : null;
}

async function readGitHubBasePreviewContext(
  env: Env,
  repo: RepoWorkspaceHandle,
  meta: EnvMeta,
  timings?: DraftDiffPreviewTimings,
): Promise<GitHubBasePreviewContext> {
  if (!meta.githubBaseCommitSha) {
    throw new Error("Environment is missing its GitHub base commit.");
  }
  const githubRepo = canonicalizeGitHubRepo(repo.meta.githubFullName, { allowOwnerRepo: true });
  const token = await timeDraftDiffPreviewStep(timings, "githubTokenMs", async () =>
    (await mintGitHubInstallationToken(env, githubRepo, { access: "read" })).token
  );
  const client: GitHubApiClient = { token, repo: githubRepo };
  const tree = await timeDraftDiffPreviewStep(timings, "githubBaseTreeMs", () =>
    readCommitTree(client, meta.githubBaseCommitSha ?? "")
  );
  return { client, tree };
}

function buildGitHubSparseEnvChanges(
  baseTree: GitHubTreeSnapshot,
  draftManifest: Array<{ path: string; size: number; sha256: string }>,
  deletedPathsInput: readonly string[],
): EnvChangeEntry[] {
  const changes = new Map<string, EnvChangeEntry>();
  const deletedPaths = new Set(normalizeGitHubDeletedPaths(deletedPathsInput));

  for (const entry of draftManifest) {
    const path = normalizeWorkspacePath(entry.path);
    if (matchesWorkspacePrefix(path, TREE_HASH_EXCLUDES)) continue;
    const baseEntry = githubBaseEntry(baseTree, path);
    changes.set(path, {
      path,
      status: baseEntry ? "modified" : "added",
      oldSize: baseEntry?.size ?? null,
      newSize: entry.size,
      oldHash: baseEntry?.sha ?? null,
      newHash: entry.sha256,
      previewableHint:
        (baseEntry?.size ?? 0) > MAX_CHANGE_PREVIEW_BYTES || entry.size > MAX_CHANGE_PREVIEW_BYTES
          ? "too-large"
          : "unknown",
    });
  }

  for (const path of deletedPaths) {
    if (matchesWorkspacePrefix(path, TREE_HASH_EXCLUDES)) continue;
    const baseEntry = githubBaseEntry(baseTree, path);
    if (!baseEntry) continue;
    changes.set(path, {
      path,
      status: "deleted",
      oldSize: baseEntry.size,
      newSize: null,
      oldHash: baseEntry.sha,
      newHash: null,
      previewableHint: (baseEntry.size ?? 0) > MAX_CHANGE_PREVIEW_BYTES ? "too-large" : "unknown",
    });
  }

  return Array.from(changes.values()).sort((left, right) => left.path.localeCompare(right.path));
}

async function buildEnvChanges(
  env: Env,
  repo: RepoWorkspaceHandle,
  meta: EnvMeta,
  slug: string,
  timings?: DraftDiffPreviewTimings,
): Promise<EnvChangeEntry[]> {
  const envWorkspace = getWorkspaceStub(env, slug);
  let oldManifest;
  let newManifest;
  if (meta.scmModel === "github") {
    const [base, draftManifest, deletedPaths] = await Promise.all([
      readGitHubBasePreviewContext(env, repo, meta, timings),
      timeDraftDiffPreviewStep(timings, "envManifestMs", () =>
        envWorkspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
      ),
      timeDraftDiffPreviewStep(timings, "deletedPathsMs", () =>
        envWorkspace.readGitHubDeletedWorkspacePaths(),
      ),
    ]);
    return buildGitHubSparseEnvChanges(base.tree, draftManifest, deletedPaths);
  } else {
    oldManifest = await timeDraftDiffPreviewStep(timings, "repoManifestMs", () =>
      repo.workspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
    );
    newManifest = await timeDraftDiffPreviewStep(timings, "envManifestMs", () =>
      envWorkspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
    );
  }
  const compareStartedAt = nowForTimingMs();
  const oldByPath = new Map(oldManifest.map((entry) => [entry.path, entry]));
  const newByPath = new Map(newManifest.map((entry) => [entry.path, entry]));
  const paths = Array.from(new Set([...oldByPath.keys(), ...newByPath.keys()])).sort((left, right) =>
    left.localeCompare(right),
  );

  const changes: EnvChangeEntry[] = [];
  for (const path of paths) {
    const oldEntry = oldByPath.get(path) ?? null;
    const newEntry = newByPath.get(path) ?? null;
    if (oldEntry && newEntry && oldEntry.sha256 === newEntry.sha256) {
      continue;
    }
    const status: EnvChangeStatus = oldEntry && newEntry ? "modified" : oldEntry ? "deleted" : "added";
    const oldSize = oldEntry?.size ?? null;
    const newSize = newEntry?.size ?? null;
    changes.push({
      path,
      status,
      oldSize,
      newSize,
      oldHash: oldEntry?.sha256 ?? null,
      newHash: newEntry?.sha256 ?? null,
      previewableHint:
        (oldSize ?? 0) > MAX_CHANGE_PREVIEW_BYTES || (newSize ?? 0) > MAX_CHANGE_PREVIEW_BYTES
          ? "too-large"
          : "unknown",
    });
  }
  recordDraftDiffPreviewTiming(timings, "manifestCompareMs", compareStartedAt);
  return changes;
}

function githubBasePreviewSource(base: GitHubBasePreviewContext): WorkspacePreviewSource {
  return {
    async statWorkspaceFile(path: string): Promise<WorkspaceFileStat | null> {
      const entry = githubBaseEntry(base.tree, path);
      if (!entry) return null;
      if (entry.size !== null) return { path: normalizeWorkspacePath(path), size: entry.size };
      const bytes = await readBlobBytes(base.client, entry.sha);
      return { path: normalizeWorkspacePath(path), size: bytes.byteLength };
    },
    async readWorkspaceFileBytes(path: string): Promise<Uint8Array | null> {
      const entry = githubBaseEntry(base.tree, path);
      return entry ? readBlobBytes(base.client, entry.sha) : null;
    },
  };
}

async function buildGitHubSparseEnvChangeFileData(
  base: GitHubBasePreviewContext,
  envWorkspace: WorkspacePreviewSource,
  path: string,
  deletedPathsInput: readonly string[],
  timings?: DraftDiffPreviewTimings,
): Promise<EnvChangeFileData | null> {
  const normalized = normalizeWorkspacePath(path);
  const deletedPaths = new Set(normalizeGitHubDeletedPaths(deletedPathsInput));
  const baseSource = githubBasePreviewSource(base);

  if (deletedPaths.has(normalized)) {
    const oldStat = await timeDraftDiffPreviewStep(timings, "repoFileStatMs", async () =>
      baseSource.statWorkspaceFile(normalized)
    );
    if (!oldStat) return null;
    return {
      entry: {
        path: normalized,
        status: "deleted",
        oldSize: oldStat.size,
        newSize: null,
        oldHash: githubBaseEntry(base.tree, normalized)?.sha ?? null,
        newHash: null,
        previewableHint: oldStat.size > MAX_CHANGE_PREVIEW_BYTES ? "too-large" : "unknown",
      },
    };
  }

  const draftStat = await timeDraftDiffPreviewStep(timings, "envFileStatMs", async () =>
    envWorkspace.statWorkspaceFile(normalized)
  );
  if (!draftStat) return null;

  const oldStat = await timeDraftDiffPreviewStep(timings, "repoFileStatMs", async () =>
    baseSource.statWorkspaceFile(normalized)
  );
  const previewableHint =
    (oldStat?.size ?? 0) > MAX_CHANGE_PREVIEW_BYTES || draftStat.size > MAX_CHANGE_PREVIEW_BYTES
      ? "too-large"
      : "unknown";

  const entry: EnvChangeEntry = {
    path: normalized,
    status: oldStat ? "modified" : "added",
    oldSize: oldStat?.size ?? null,
    newSize: draftStat.size,
    oldHash: githubBaseEntry(base.tree, normalized)?.sha ?? null,
    newHash: null,
    previewableHint,
  };

  if (!oldStat || oldStat.size !== draftStat.size || previewableHint === "too-large") {
    return { entry };
  }

  const [oldBytes, newBytes] = await Promise.all([
    timeDraftDiffPreviewStep(timings, "repoEqualityReadMs", () => baseSource.readWorkspaceFileBytes(normalized)),
    timeDraftDiffPreviewStep(timings, "envEqualityReadMs", () => envWorkspace.readWorkspaceFileBytes(normalized)),
  ]);
  if (!oldBytes || !newBytes) return null;
  const compareStartedAt = nowForTimingMs();
  const equal = bytesEqual(oldBytes, newBytes);
  recordDraftDiffPreviewTiming(timings, "fileEqualityCompareMs", compareStartedAt);
  if (equal) return null;
  return { entry, oldBytes, newBytes };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function buildEnvChangeFileData(
  repoWorkspace: WorkspacePreviewSource,
  envWorkspace: WorkspacePreviewSource,
  path: string,
  timings?: DraftDiffPreviewTimings,
): Promise<EnvChangeFileData | null> {
  const [oldStat, newStat] = await Promise.all([
    timeDraftDiffPreviewStep(timings, "repoFileStatMs", async () => repoWorkspace.statWorkspaceFile(path)),
    timeDraftDiffPreviewStep(timings, "envFileStatMs", async () => envWorkspace.statWorkspaceFile(path)),
  ]);
  if (!oldStat && !newStat) return null;

  const oldSize = oldStat?.size ?? null;
  const newSize = newStat?.size ?? null;
  const previewableHint =
    (oldSize ?? 0) > MAX_CHANGE_PREVIEW_BYTES || (newSize ?? 0) > MAX_CHANGE_PREVIEW_BYTES
      ? "too-large"
      : "unknown";

  if (!oldStat || !newStat) {
    return {
      entry: {
        path,
        status: oldStat ? "deleted" : "added",
        oldSize,
        newSize,
        oldHash: null,
        newHash: null,
        previewableHint,
      },
    };
  }

  const entry: EnvChangeEntry = {
    path,
    status: "modified",
    oldSize,
    newSize,
    oldHash: null,
    newHash: null,
    previewableHint,
  };

  if (oldStat.size !== newStat.size || previewableHint === "too-large") {
    return { entry };
  }

  const [oldBytes, newBytes] = await Promise.all([
    timeDraftDiffPreviewStep(timings, "repoEqualityReadMs", () => repoWorkspace.readWorkspaceFileBytes(path)),
    timeDraftDiffPreviewStep(timings, "envEqualityReadMs", () => envWorkspace.readWorkspaceFileBytes(path)),
  ]);
  if (!oldBytes || !newBytes) return null;
  const compareStartedAt = nowForTimingMs();
  const equal = bytesEqual(oldBytes, newBytes);
  recordDraftDiffPreviewTiming(timings, "fileEqualityCompareMs", compareStartedAt);
  if (equal) return null;
  return { entry, oldBytes, newBytes };
}

function normalizeWorkspacePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function hasBinaryBytes(bytes: Uint8Array): boolean {
  return bytes.includes(0);
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return null;
  }
}

function getDraftDiffBaseError(
  meta: Pick<EnvMeta, "baseMainCommit">,
  repo: { meta: { mainCommit: string | null } },
): Record<string, unknown> | null {
  if (hasCurrentMainBase(meta, repo.meta)) {
    return null;
  }
  return {
    error: "Environment must have a current base before previewing draft changes.",
    code: "env_base_not_current",
    hint: "Publish a draft PR to use GitHub mergeability, or reset this environment if its base commit is missing.",
  };
}

function getGitHubBaseError(
  meta: Pick<EnvMeta, "githubBaseCommitSha">,
): Record<string, unknown> | null {
  if (meta.githubBaseCommitSha) {
    return null;
  }
  return {
    error: "Environment is missing its GitHub base commit.",
    code: "github_env_base_missing",
    hint: "Reset or recreate the environment before viewing draft changes.",
  };
}

function readIsoHeader(request: Request, name: string): string | undefined {
  const raw = request.headers.get(name)?.trim();
  if (!raw) return undefined;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
}

function readWorkspaceSyncedPatchFromHeaders(request: Request): {
  workspaceLastSyncedAt?: string;
} {
  const patch: { workspaceLastSyncedAt?: string } = {};
  const lastSynced = readIsoHeader(request, "X-Tiller-Workspace-Last-Synced-At");
  if (lastSynced) {
    patch.workspaceLastSyncedAt = lastSynced;
  }
  return patch;
}

function isStartupDiagnosticStepId(value: unknown): value is StartupDiagnosticStepId {
  return typeof value === "string" && STARTUP_DIAGNOSTIC_STEP_IDS.includes(value as StartupDiagnosticStepId);
}

function readStartupDiagnosticSeverity(value: unknown): StartupDiagnosticSeverity | null {
  if (value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return null;
}

function readStartupDiagnosticLogTails(value: unknown): Partial<StartupDiagnosticLogTails> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const result: Partial<StartupDiagnosticLogTails> = {};
  if (typeof record.harness === "string") {
    result.harness = record.harness;
  }
  if (typeof record.stopControl === "string") {
    result.stopControl = record.stopControl;
  }
  if (typeof record.bootstrap === "string") {
    result.bootstrap = record.bootstrap;
  }
  return Object.keys(result).length > 0 ? result : null;
}

const envRoutes = new Hono<HonoEnv>();

envRoutes.get("/api/envs", async (c) => {
  let phaseStartedAt = performance.now();
  await ensureEnvironmentSidebarSlots(c.env).catch((error) => {
    console.warn(
      "[envs] Failed to reconcile implementor sidebar slots:",
      error instanceof Error ? error.message : String(error),
    );
  });
  recordApiTimingPhase(c, "envs_reconcile", phaseStartedAt);

  phaseStartedAt = performance.now();
  const envViews = await listEnvViews(c.env);
  recordApiTimingPhase(c, "envs_list", phaseStartedAt);

  phaseStartedAt = performance.now();
  const projected = await Promise.all(envViews.map(async (meta) => {
    try {
      return await projectEnvMetaForRead(c.env, meta);
    } catch (error) {
      console.warn(
        `[envs] Skipping env ${meta.slug} during projection:`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }));
  recordApiTimingPhase(c, "envs_project", phaseStartedAt);
  return c.json(
    projected
      .filter((meta): meta is EnvMeta => meta !== null)
      .map((meta) => projectEnvSummary(meta)),
  );
});

envRoutes.post("/api/envs", async (c) => {
  const parsedBody = await readOptionalJsonObjectBody(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({
      error: "Request body must be a valid JSON object.",
      code: "invalid_json_body",
    }, 400);
  }
  const body = parsedBody.body;
  const removedBackendSelection = backendSelectionRemovedError(body);
  if (removedBackendSelection) return c.json(removedBackendSelection, 400);
  const requestedRepoId = typeof body.repoId === "string" ? body.repoId.trim() : "";
  if (!requestedRepoId) return c.json({ error: "repoId is required", code: "repo_id_required" }, 400);
  if (!body.harness) {
    return c.json({ error: "harness is required and must be 'claude-code', 'codex', or 'opencode'" }, 400);
  }
  if (typeof body.harness !== "string" || !isEnvHarness(body.harness)) {
    return c.json({ error: "harness must be 'claude-code', 'codex', or 'opencode'" }, 400);
  }
  if (body.authMode !== undefined || body.codexAuthPreference !== undefined) {
    return c.json({ error: "Environment auth preferences are no longer accepted; use Global Settings billing modes." }, 400);
  }
  if (body.displayName !== undefined) {
    return c.json({
      error: "Environment display names are assigned by the server.",
      code: "display_name_server_generated",
    }, 400);
  }
  if (body.slug !== undefined && typeof body.slug !== "string") {
    return c.json({ error: "slug must be a string", code: "invalid_slug" }, 400);
  }
  if (body.planId !== undefined) {
    return c.json({
      error: "planId is no longer accepted. Refresh or update the client.",
      code: "plan_id_removed",
    }, 400);
  }
  if (
    body.schedule !== undefined
    && (!body.schedule || typeof body.schedule !== "object" || Array.isArray(body.schedule))
  ) {
    return c.json({ error: "schedule must be an object", code: "invalid_schedule" }, 400);
  }
  const schedule = body.schedule as Record<string, unknown> | undefined;
  const result = await createEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    request: c.req.raw,
    requestUrl: c.req.url,
    repoId: requestedRepoId,
    requestedSlug: typeof body.slug === "string" ? body.slug.trim() : undefined,
    harness: body.harness,
    planSelection: body.planSelection,
    schedule: schedule ? {
      runAtMs: schedule.runAtMs as number,
      timeZone: schedule.timeZone as string,
    } : undefined,
    harnessSettings: body.harnessSettings,
  });
  return c.json(result.body, result.status as any);
});

envRoutes.get("/api/envs/:slug", async (c) => {
  const slug = c.req.param("slug") ?? "";
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const projected = await projectEnvMetaForRead(c.env, meta);
  return c.json(projectEnvSummary(projected));
});

envRoutes.post("/api/envs/:slug/codex/runtime-auth", async (c) => {
  const slug = c.req.param("slug") ?? "";
  const authorization = c.get("authorization");
  if (authorization.kind !== "environment" || authorization.envSlug !== slug) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const lifecycle = getEnvLifecycleStub(c.env, slug);
  const subject = await lifecycle.getActiveImplementorCodexRuntimeSubject();
  if (
    !subject
    || subject.envSlug !== slug
    || subject.incarnationId !== authorization.incarnationId
    || subject.startOpId !== authorization.startOperationId
  ) {
    return codexRuntimeAuthInactiveResponse();
  }
  if (
    subject.profile.kind !== "subscription-app-server"
    || subject.profile.surface !== "implementor"
  ) {
    return codexRuntimeAuthInactiveResponse();
  }
  const request = await parseCodexRuntimeAuthRequest(c.req.raw);
  if (!request.ok) return request.response;
  const result = await exchangeCodexRuntimeAuth(c.env, request.rejectedAccessTokenSha256);
  if (!result.ok) return codexRuntimeAuthExchangeErrorResponse(result);
  const acceptance = await lifecycle.acceptImplementorCodexRuntimeAuth(
    subject.startOpId,
    result.account_id,
  );
  if (acceptance === "inactive") {
    return codexRuntimeAuthInactiveResponse();
  }
  if (acceptance === "account_changed") {
    return codexRuntimeAuthAccountChangedResponse();
  }
  return codexRuntimeAuthSuccessResponse(result);
});

envRoutes.post("/api/envs/:slug/start", async (c) => {
  const slug = c.req.param("slug");
  const parsedBody = await readOptionalJsonObjectBody(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({
      error: "Request body must be a valid JSON object.",
      code: "invalid_json_body",
    }, 400);
  }
  const body = parsedBody.body;
  if (body.planId !== undefined || body.planSelection !== undefined) {
    return c.json({
      error: "Startup plan selection is fixed when the workload is created. Refresh or update the client.",
      code: "startup_plan_selection_removed",
    }, 400);
  }
  if (
    body.implementationMode !== undefined
    && body.implementationMode !== "fresh"
    && body.implementationMode !== "plan"
  ) {
    return c.json({
      error: "implementationMode must be fresh or plan.",
      code: "invalid_implementation_mode",
    }, 400);
  }
  const result = await startEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    request: c.req.raw,
    requestUrl: c.req.url,
    slug,
    harnessSettings: body.harnessSettings,
    implementationMode: body.implementationMode,
  });
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/stop", async (c) => {
  const result = await stopEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    slug: c.req.param("slug"),
  });
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/implementor-attention/completions", async (c) => {
  const slug = c.req.param("slug") ?? "";
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);
  const parsedBody = await readOptionalJsonObjectBody(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({ error: "Request body must be a valid JSON object." }, 400);
  }
  const sequence = parsedBody.body.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence <= 0) {
    return c.json({ error: "sequence must be a positive safe integer" }, 400);
  }

  const lifecycle = getEnvLifecycleStub(c.env, slug);
  const result = await lifecycle.reportImplementorCompletion(opId, sequence);
  if (!result.accepted) {
    return c.json({ error: "Completion belongs to a stale environment runtime." }, 409);
  }
  await lifecycle.persistOwnedProjection();
  return c.body(null, 204);
});

envRoutes.post("/api/envs/:slug/implementor-attention/acknowledge", async (c) => {
  const slug = c.req.param("slug") ?? "";
  const parsedBody = await readOptionalJsonObjectBody(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({ error: "Request body must be a valid JSON object." }, 400);
  }
  const token = typeof parsedBody.body.token === "string"
    ? parsedBody.body.token.trim()
    : "";
  if (!token) return c.json({ error: "token is required" }, 400);

  const lifecycle = getEnvLifecycleStub(c.env, slug);
  const result = await lifecycle.acknowledgeImplementorAttention(token);
  if (result === "missing") return c.json({ error: "Not found" }, 404);
  if (result === "conflict") {
    return c.json({ error: "A newer implementor completion needs attention." }, 409);
  }
  await lifecycle.persistOwnedProjection();
  return c.body(null, 204);
});

envRoutes.post("/api/envs/:slug/scheduled-run/cancel", async (c) => {
  const slug = c.req.param("slug");
  const lifecycle = getEnvLifecycleStub(c.env, slug);
  if (await lifecycle.isInitialCreationPending()) return c.json({ error: "Not found" }, 404);
  if (!(await lifecycle.peekMutableState())) return c.json({ error: "Not found" }, 404);
  const result = await lifecycle.cancelScheduledRun();
  if (!result.cancelled) return c.json({ error: result.error ?? "The Scheduled Run cannot be cancelled." }, 409);
  return c.json({ ok: true, slug, cancelled: true, finalizing: result.finalizing === true });
});

async function requestScheduledOutcome(
  c: Context<HonoEnv>,
  outcome: "completed" | "interrupted",
) {
  const slug = c.req.param("slug") ?? "";
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);
  const result = await stopEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    slug,
    intent: "scheduled",
    requestedOutcome: outcome,
    expectedStartOpId: opId,
  });
  return c.json(result.body, result.status as any);
}

envRoutes.post("/api/envs/:slug/scheduled-run/idle", async (c) => {
  return requestScheduledOutcome(c, "interrupted");
});

envRoutes.post("/api/envs/:slug/plan-execution/complete", async (c) => {
  return requestScheduledOutcome(c, "completed");
});

envRoutes.get("/api/envs/:slug/startup-diagnostics", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const diagnostics = await getEnvLifecycleStub(c.env, slug).getStartupDiagnostics();
  return c.json(publicStartupDiagnostics(diagnostics, slug));
});

envRoutes.post("/api/envs/:slug/startup-diagnostics", async (c) => {
  const slug = c.req.param("slug");
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const rawBody = await c.req.json<{
    type?: string;
    stepId?: string;
    severity?: string;
    message?: string;
    detail?: string | null;
    at?: string | null;
    exitCode?: number | null;
    signal?: string | null;
    logTails?: Partial<StartupDiagnosticLogTails>;
  }>().catch(() => null);
  const body = (rawBody ?? {}) as {
    type?: string;
    stepId?: string;
    severity?: string;
    message?: string;
    detail?: string | null;
    at?: string | null;
    exitCode?: number | null;
    signal?: string | null;
    logTails?: Partial<StartupDiagnosticLogTails>;
  };

  if (typeof body.message !== "string" || !body.message.trim()) {
    return c.json({ error: "message is required" }, 400);
  }

  const logTails = readStartupDiagnosticLogTails(body.logTails);

  if (body.type === "failure") {
    if (body.stepId !== undefined && !isStartupDiagnosticStepId(body.stepId)) {
      return c.json({ error: "Invalid stepId" }, 400);
    }
    const failure = projectRuntimeFailure(
      runtimeFailureCodeForStartupStep(isStartupDiagnosticStepId(body.stepId) ? body.stepId : null),
      {
        message: body.message,
        detail: body.detail,
        exitCode: body.exitCode,
        signal: body.signal,
        logTails,
      },
      { slug, opId, source: "startup-diagnostics-callback" },
    );
    const result = await recordStartupDiagnosticFailure({
      env: c.env,
      slug,
      opId,
      stepId: isStartupDiagnosticStepId(body.stepId) ? body.stepId : undefined,
      message: failure.message,
      detail: typeof body.detail === "string" ? body.detail : null,
      at: typeof body.at === "string" ? body.at : null,
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      signal: typeof body.signal === "string" ? body.signal : null,
      logTails,
    });
    return c.json({ ...result, code: failure.code, referenceId: failure.referenceId });
  }

  if (!isStartupDiagnosticStepId(body.stepId)) {
    return c.json({ error: "stepId is required" }, 400);
  }

  const severity = readStartupDiagnosticSeverity(body.severity);
  const eventFailure = severity === "error"
    ? projectRuntimeFailure(
        runtimeFailureCodeForStartupStep(body.stepId),
        { message: body.message, detail: body.detail, logTails },
        { slug, opId, source: "startup-diagnostics-event" },
      )
    : null;
  const result = await recordStartupDiagnosticEvent({
    env: c.env,
    slug,
    opId,
    stepId: body.stepId,
    severity,
    message: eventFailure?.message ?? body.message,
    detail: typeof body.detail === "string" ? body.detail : null,
    at: typeof body.at === "string" ? body.at : null,
    logTails,
  });
  return c.json(eventFailure
    ? { ...result, code: eventFailure.code, referenceId: eventFailure.referenceId }
    : result);
});

envRoutes.post("/api/envs/:slug/boot-progress", async (c) => {
  const slug = c.req.param("slug");
  const body = await c.req.json<{ message: string; stepId?: string }>();
  if (!body.message) return c.json({ error: "message is required" }, 400);
  if (body.stepId !== undefined && !isStartupDiagnosticStepId(body.stepId)) {
    return c.json({ error: "Invalid stepId" }, 400);
  }

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  if (!(await readProjectedEnvMeta(c.env, slug).catch(() => null))) {
    return c.json({ error: "Not found" }, 404);
  }
  const hub = getHub(c.env);
  const stepId = isStartupDiagnosticStepId(body.stepId) ? body.stepId : undefined;
  const failure = /\b(?:failed|fatal|error)\b/i.test(body.message)
    ? projectRuntimeFailure(
        runtimeFailureCodeForStartupStep(stepId),
        body.message,
        { slug, source: "boot-progress-callback" },
      )
    : null;
  await lifecycleStub.setBootProgress(failure?.message ?? body.message, stepId);
  await projectAndPersistEnvSummary(c.env, hub, slug).catch(() => null);
  return c.json(failure
    ? { ok: true, code: failure.code, referenceId: failure.referenceId }
    : { ok: true });
});

envRoutes.post("/api/envs/:slug/infra-ready", async (c) => {
  const slug = c.req.param("slug");
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const lifecycle = await lifecycleStub.noteInfraReady(opId);

  const hub = getHub(c.env);
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug).catch(() => null);
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? lifecycle?.phase ?? null,
  });
});

envRoutes.post("/api/envs/:slug/runner-ready", async (c) => {
  const slug = c.req.param("slug");
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const lifecycle = await lifecycleStub.noteRunnerStarted(opId);

  const hub = getHub(c.env);
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug).catch(() => null);
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? lifecycle?.phase ?? null,
  });
});

envRoutes.post("/api/envs/:slug/runner-stopped", async (c) => {
  const slug = c.req.param("slug");
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const detail = (await c.req.text().catch(() => "")).trim();
  const result = await finalizeRunnerStoppedCallback({ env: c.env, slug, opId, detail });
  return c.json({
    ok: true,
    slug,
    status: result.projected?.status ?? (await getEnvLifecycleStub(c.env, slug).getState())?.phase ?? null,
    error: result.projected?.error ?? result.failure?.message ?? null,
    ...(result.failure
      ? { code: result.failure.code, referenceId: result.failure.referenceId }
      : {}),
  });
});

envRoutes.post("/api/envs/:slug/workspace-synced", async (c) => {
  const slug = c.req.param("slug");
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  // Persist the exact operation acknowledgement before consulting the KV/repo
  // read model. The container does not durably retry this callback, so a
  // transient projection failure must not discard the lifecycle fact.
  let acknowledgement = await applyWorkspaceSyncedCallback({
    env: c.env,
    slug,
    opId,
    workspacePatch: readWorkspaceSyncedPatchFromHeaders(c.req.raw),
  });
  if (!acknowledgement.accepted) {
    return c.json({ error: "Workspace acknowledgement does not match the active Stop operation." }, 409);
  }
  const meta = await readProjectedEnvMeta(c.env, slug).catch(() => null);
  if (meta) {
    const workspacePatchResult = await buildWorkspaceSyncedPatch(
      c.env,
      meta,
      readWorkspaceSyncedPatchFromHeaders(c.req.raw),
      () => loadRepoForRequest(c.env, c.req.raw, meta.repoId),
    );
    if (workspacePatchResult.ok) {
      acknowledgement = await applyWorkspaceSyncedCallback({
        env: c.env,
        slug,
        opId,
        workspacePatch: workspacePatchResult.patch,
      });
      if (!acknowledgement.accepted) {
        return c.json({ error: "Workspace acknowledgement does not match the active Stop operation." }, 409);
      }
    }
  }
  return c.json({ accepted: true, opId });
});

envRoutes.post("/api/envs/:slug/stop-failed", async (c) => {
  const slug = c.req.param("slug");
  const bodyText = (await c.req.text().catch(() => "")).trim();
  const message = bodyText || "Stop failed before workspace persistence completed.";
  const stopOpId = readLifecycleOpIdHeader(c.req.raw);
  if (!stopOpId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const failure = projectRuntimeFailure(
    "workspace_persistence_failed",
    message,
    { slug, opId: stopOpId, source: "stop-failed-callback" },
  );
  const projected = await recordStopFailedCallback({
    env: c.env,
    slug,
    opId: stopOpId,
    message: failure.message,
  });
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? (await getEnvLifecycleStub(c.env, slug).getState())?.phase ?? null,
    error: failure.message,
    code: failure.code,
    referenceId: failure.referenceId,
  });
});

envRoutes.post("/api/envs/:slug/harness-failed", async (c) => {
  const slug = c.req.param("slug");
  const bodyText = (await c.req.text().catch(() => "")).trim();
  const errorMessage = bodyText || "Lead harness exited unexpectedly";
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const failure = projectRuntimeFailure(
    "runtime_start_failed",
    errorMessage,
    { slug, opId, source: "harness-failed-callback" },
  );
  const result = await applyHarnessFailedCallback({
    env: c.env,
    slug,
    opId,
    errorMessage: failure.message,
  });
  if (result.accepted) {
    result.body.code = failure.code;
    result.body.referenceId = failure.referenceId;
  }
  return result.accepted
    ? c.json(result.body)
    : c.json(result.body, 409);
});

envRoutes.get("/api/envs/:slug/changes", async (c) => {
  const slug = c.req.param("slug");
  const timings: DraftDiffPreviewTimings = {};
  const requestStartedAt = nowForTimingMs();
  let statusCode = 200;
  let outcome = "ok";
  let branchStatus: string | null = null;
  let fileCount: number | null = null;
  try {
    const contextStartedAt = nowForTimingMs();
    const loaded = await readStoppedEnvPreviewContext(c.env, c.req.raw, slug, "showing draft diff", timings);
    recordDraftDiffPreviewTiming(timings, "contextMs", contextStartedAt);
    if (!loaded.ok) {
      statusCode = loaded.status;
      outcome = String(loaded.body.code ?? "error");
      return c.json(loaded.body, loaded.status as any);
    }

    branchStatus = loaded.branchStatus;
    if (loaded.branchStatus === "needs-attention") {
      statusCode = 409;
      outcome = "env_needs_attention";
      return c.json(
        {
          error: "Environment needs attention before draft changes can be previewed.",
          code: "env_needs_attention",
          hint: "Reset the environment to main or resolve the conflicting state.",
        },
        409,
      );
    }
    const baseError = loaded.meta.scmModel === "github"
      ? getGitHubBaseError(loaded.meta)
      : getDraftDiffBaseError(loaded.meta, loaded.repo);
    if (baseError) {
      statusCode = 409;
      outcome = String(baseError.code ?? "env_base_not_current");
      return c.json(baseError, 409);
    }

    const files = await buildEnvChanges(c.env, loaded.repo, loaded.meta, slug, timings);
    fileCount = files.length;
    const summaryStartedAt = nowForTimingMs();
    const summary = files.reduce(
      (counts, file) => {
        counts.total += 1;
        counts[file.status] += 1;
        return counts;
      },
      { total: 0, added: 0, modified: 0, deleted: 0 },
    );
    recordDraftDiffPreviewTiming(timings, "summaryMs", summaryStartedAt);

    const responseStartedAt = nowForTimingMs();
    const response = c.json({
      slug,
      repoId: loaded.repo.meta.repoId,
      repoUrl: loaded.repo.meta.repoUrl,
      comparisonBasis: "draft-pr-diff",
      oldCommit: loaded.meta.scmModel === "github"
        ? loaded.meta.githubBaseCommitSha ?? null
        : loaded.repo.meta.mainCommit ?? null,
      newBaseCommit: loaded.meta.scmModel === "github"
        ? loaded.meta.githubBaseCommitSha ?? null
        : loaded.meta.baseMainCommit ?? null,
      branchStatus: loaded.branchStatus,
      summary,
      files,
    });
    recordDraftDiffPreviewTiming(timings, "responseMs", responseStartedAt);
    return response;
  } finally {
    recordDraftDiffPreviewTiming(timings, "totalMs", requestStartedAt);
    logDraftDiffPreviewTiming({
      route: "changes",
      slug,
      statusCode,
      outcome,
      branchStatus,
      fileCount,
      timings,
    });
  }
});

envRoutes.get("/api/envs/:slug/changes/file", async (c) => {
  const slug = c.req.param("slug");
  const rawPath = c.req.query("path");
  if (!rawPath) {
    return c.json({ error: "path query parameter is required" }, 400);
  }
  const path = normalizeWorkspacePath(rawPath);
  if (!isSafePath(path)) {
    return c.json({ error: "Path traversal not allowed" }, 400);
  }
  if (matchesWorkspacePrefix(path, TREE_HASH_EXCLUDES)) {
    return c.json({ error: "File not found", code: "excluded_path" }, 404);
  }

  const timings: DraftDiffPreviewTimings = {};
  const requestStartedAt = nowForTimingMs();
  let statusCode = 200;
  let outcome = "ok";
  let branchStatus: string | null = null;
  let previewable: boolean | null = null;
  let reason: string | null = null;
  try {
    const contextStartedAt = nowForTimingMs();
    const loaded = await readStoppedEnvPreviewContext(c.env, c.req.raw, slug, "showing draft diff", timings);
    recordDraftDiffPreviewTiming(timings, "contextMs", contextStartedAt);
    if (!loaded.ok) {
      statusCode = loaded.status;
      outcome = String(loaded.body.code ?? "error");
      return c.json(loaded.body, loaded.status as any);
    }

    branchStatus = loaded.branchStatus;
    if (loaded.branchStatus === "needs-attention") {
      statusCode = 409;
      outcome = "env_needs_attention";
      return c.json(
        {
          error: "Environment needs attention before draft changes can be previewed.",
          code: "env_needs_attention",
          hint: "Reset the environment to main or resolve the conflicting state.",
        },
        409,
      );
    }
    const baseError = loaded.meta.scmModel === "github"
      ? getGitHubBaseError(loaded.meta)
      : getDraftDiffBaseError(loaded.meta, loaded.repo);
    if (baseError) {
      statusCode = 409;
      outcome = String(baseError.code ?? "env_base_not_current");
      return c.json(baseError, 409);
    }

    const envWorkspace = getWorkspaceStub(c.env, slug);
    let baseSource: WorkspacePreviewSource;
    let fileChange: EnvChangeFileData | null;
    if (loaded.meta.scmModel === "github") {
      const [base, deletedPaths] = await Promise.all([
        readGitHubBasePreviewContext(c.env, loaded.repo, loaded.meta, timings),
        timeDraftDiffPreviewStep(timings, "deletedPathsMs", () =>
          envWorkspace.readGitHubDeletedWorkspacePaths(),
        ),
      ]);
      baseSource = githubBasePreviewSource(base);
      fileChange = await timeDraftDiffPreviewStep(
        timings,
        "fileChangeMs",
        () => buildGitHubSparseEnvChangeFileData(base, envWorkspace, path, deletedPaths, timings),
      );
    } else {
      baseSource = loaded.repo.workspace;
      fileChange = await timeDraftDiffPreviewStep(
        timings,
        "fileChangeMs",
        () => buildEnvChangeFileData(baseSource, envWorkspace, path, timings),
      );
    }
    if (!fileChange) {
      statusCode = 404;
      outcome = "not_changed";
      return c.json({ error: "File not found", code: "not_changed" }, 404);
    }
    const { entry, oldBytes: preloadedOldBytes, newBytes: preloadedNewBytes } = fileChange;

    if ((entry.oldSize ?? 0) > MAX_CHANGE_PREVIEW_BYTES || (entry.newSize ?? 0) > MAX_CHANGE_PREVIEW_BYTES) {
      previewable = false;
      reason = "too-large";
      const responseStartedAt = nowForTimingMs();
      const response = c.json({
        path,
        status: entry.status,
        previewable: false,
        reason: "too-large",
        maxPreviewBytes: MAX_CHANGE_PREVIEW_BYTES,
        oldString: "",
        newString: "",
        oldSize: entry.oldSize,
        newSize: entry.newSize,
      });
      recordDraftDiffPreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    const [oldBytes, newBytes] = await Promise.all([
      preloadedOldBytes
        ? Promise.resolve(preloadedOldBytes)
          : entry.status === "added"
            ? Promise.resolve(new Uint8Array())
            : timeDraftDiffPreviewStep(timings, "repoFileReadMs", () => baseSource.readWorkspaceFileBytes(path)),
      preloadedNewBytes
        ? Promise.resolve(preloadedNewBytes)
        : entry.status === "deleted"
          ? Promise.resolve(new Uint8Array())
          : timeDraftDiffPreviewStep(timings, "envFileReadMs", () => envWorkspace.readWorkspaceFileBytes(path)),
    ]);
    if (oldBytes === null || newBytes === null) {
      previewable = false;
      reason = "not-found";
      const responseStartedAt = nowForTimingMs();
      const response = c.json({
        path,
        status: entry.status,
        previewable: false,
        reason: "not-found",
        maxPreviewBytes: MAX_CHANGE_PREVIEW_BYTES,
        oldString: "",
        newString: "",
        oldSize: entry.oldSize,
        newSize: entry.newSize,
      });
      recordDraftDiffPreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    const binaryCheckStartedAt = nowForTimingMs();
    const hasBinaryContent = hasBinaryBytes(oldBytes) || hasBinaryBytes(newBytes);
    recordDraftDiffPreviewTiming(timings, "binaryCheckMs", binaryCheckStartedAt);
    if (hasBinaryContent) {
      previewable = false;
      reason = "binary";
      const responseStartedAt = nowForTimingMs();
      const response = c.json({
        path,
        status: entry.status,
        previewable: false,
        reason: "binary",
        maxPreviewBytes: MAX_CHANGE_PREVIEW_BYTES,
        oldString: "",
        newString: "",
        oldSize: entry.oldSize,
        newSize: entry.newSize,
      });
      recordDraftDiffPreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    const decodeStartedAt = nowForTimingMs();
    const oldString = decodeUtf8(oldBytes);
    const newString = decodeUtf8(newBytes);
    recordDraftDiffPreviewTiming(timings, "decodeMs", decodeStartedAt);
    if (oldString === null || newString === null) {
      previewable = false;
      reason = "binary";
      const responseStartedAt = nowForTimingMs();
      const response = c.json({
        path,
        status: entry.status,
        previewable: false,
        reason: "binary",
        maxPreviewBytes: MAX_CHANGE_PREVIEW_BYTES,
        oldString: "",
        newString: "",
        oldSize: entry.oldSize,
        newSize: entry.newSize,
      });
      recordDraftDiffPreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    previewable = true;
    const responseStartedAt = nowForTimingMs();
    const response = c.json({
      path,
      status: entry.status,
      previewable: true,
      maxPreviewBytes: MAX_CHANGE_PREVIEW_BYTES,
      oldString,
      newString,
      oldSize: entry.oldSize,
      newSize: entry.newSize,
    });
    recordDraftDiffPreviewTiming(timings, "responseMs", responseStartedAt);
    return response;
  } finally {
    recordDraftDiffPreviewTiming(timings, "totalMs", requestStartedAt);
    logDraftDiffPreviewTiming({
      route: "changes/file",
      slug,
      path,
      statusCode,
      outcome,
      branchStatus,
      previewable,
      reason,
      timings,
    });
  }
});

envRoutes.post("/api/envs/:slug/github/publish-draft-pr", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json(githubAppPublicHubDisabledBody(), 403);
  }
  const parsedBody = await readOptionalJsonObjectBody(c.req.raw);
  if (!parsedBody.ok) {
    return c.json({
      error: "Request body must be a valid JSON object.",
      code: "invalid_json_body",
    }, 400);
  }
  const removedBackendSelection = backendSelectionRemovedError(parsedBody.body);
  if (removedBackendSelection) return c.json(removedBackendSelection, 400);
  const result = await startGitHubDraftPrPublish({
    env: c.env,
    requestUrl: c.req.url,
    slug: c.req.param("slug"),
  });
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/github/publish-draft-pr/:operationId/result", async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
  const slug = c.req.param("slug");
  const operationId = c.req.param("operationId");
  const resultTask = handleGitHubDraftPrPublishResult({
    env: c.env,
    slug,
    operationId,
    body,
  });

  if (c.executionCtx?.waitUntil) {
    c.executionCtx.waitUntil(resultTask.then((result) => {
      if (result.status >= 400) {
        console.warn(`[github-publish] Result callback was rejected: ${JSON.stringify({
          slug,
          operationId,
          status: result.status,
          code: typeof result.body.code === "string" ? result.body.code : null,
        })}`);
      }
    }).catch((error) => {
      console.error(`[github-publish] Result callback processing failed for ${slug}:`, error);
    }));
    // The publishing runtime is the caller and result processing destroys it.
    // Acknowledge first so cleanup cannot cancel its own request mid-handler.
    return c.json({ ok: true, accepted: true }, 202);
  }

  const result = await resultTask;
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/reset-to-repo", async (c) => {
  const slug = c.req.param("slug");
  const storedMeta = await readProjectedEnvMeta(c.env, slug);
  if (!storedMeta) return c.json({ error: "Not found" }, 404);
  const projectedMeta = storedMeta;
  if (isLifecycleStopInProgress(projectedMeta)) {
    return c.json({ error: getStopFinalizationInProgressError("discarding changes") }, 409);
  }
  const backendKind = storedMeta.backend;
  const backend = await getRunnerBackend(c.env, backendKind);
  const { meta } = await projectEnvMetaForAction(c.env, projectedMeta, backend);
  const status = meta.status ?? "unknown";
  if (status !== "stopped") {
    return c.json({ error: "Environment must be stopped before resetting to main" }, 409);
  }

  let repo: RepoWorkspaceHandle;
  if (meta.scmModel === "github") {
    const refreshedRepo = await refreshGitHubDefaultBranchHeadForRequest(c.env, c.req.raw, meta.repoId);
    if (refreshedRepo.failureKind || !refreshedRepo.repo) {
      const failure = requiredGitHubRepoRefreshResponse(refreshedRepo);
      return c.json(failure.body, failure.status as any);
    }
    repo = refreshedRepo.repo;
  } else {
    const loadedRepo = await readValidatedRepoContext(c.env, {
      request: c.req.raw,
      repoId: meta.repoId,
    });
    if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
    repo = loadedRepo.repo;
  }
  const workspaceStub = getWorkspaceStub(c.env, slug);
  if (meta.scmModel === "github") {
    const currentManifest = await workspaceStub.getManifest();
    await workspaceStub.deleteWorkspaceFiles(
      currentManifest
        .map((entry) => entry.path)
        .filter((path) => !matchesWorkspacePrefix(path, TREE_HASH_EXCLUDES)),
    );
    await workspaceStub.deleteWorkspaceFile(GITHUB_DELETED_PATHS_WORKSPACE_PATH);
  } else {
    const repoTar = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
    await workspaceStub.restoreFromTar(repoTar, {
      clearFirst: true,
      preservePrefixes: TREE_HASH_EXCLUDES,
    });
  }

  await deleteEnvSnapshotArtifacts(c.env.BUCKET, slug);

  const nextMeta = withDerivedBranchBackedEnvStatus(
    {
      ...clearEnvError(meta),
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: new Date().toISOString(),
      baseMainCommit: meta.scmModel === "github"
        ? repo.meta.githubDefaultBranchHeadSha ?? null
        : repo.meta.mainCommit ?? null,
      lastKnownMainCommit: meta.scmModel === "github"
        ? repo.meta.githubDefaultBranchHeadSha ?? null
        : repo.meta.mainCommit ?? null,
      githubBaseBranch: meta.scmModel === "github" ? repo.meta.githubDefaultBranch ?? null : meta.githubBaseBranch,
      githubBaseCommitSha: meta.scmModel === "github" ? repo.meta.githubDefaultBranchHeadSha ?? null : meta.githubBaseCommitSha,
      githubHeadCommitSha: meta.scmModel === "github" ? null : meta.githubHeadCommitSha,
      githubPrNumber: meta.scmModel === "github" ? null : meta.githubPrNumber,
      githubPrUrl: meta.scmModel === "github" ? null : meta.githubPrUrl,
      githubPrState: meta.scmModel === "github" ? null : meta.githubPrState,
      githubMergedAt: meta.scmModel === "github" ? null : meta.githubMergedAt,
      githubPublishStatus: meta.scmModel === "github" ? "idle" : meta.githubPublishStatus,
      githubPublishOperationId: meta.scmModel === "github" ? null : meta.githubPublishOperationId,
      githubPublishError: meta.scmModel === "github" ? null : meta.githubPublishError,
      githubLastPublishedAt: meta.scmModel === "github" ? null : meta.githubLastPublishedAt,
      githubLastPublishedWorkspaceHash: meta.scmModel === "github" ? null : meta.githubLastPublishedWorkspaceHash,
      githubPendingPublish: meta.scmModel === "github" ? null : meta.githubPendingPublish,
      branchStatus: "up-to-date",
    },
    repo.meta,
  );
  const hub = getHub(c.env);
  await getEnvLifecycleStub(c.env, slug).recordStopWorkspaceSynced(
    buildEnvScmMetaPatch(nextMeta),
    {
      clearError: true,
    },
  );
  await projectAndPersistEnvSummary(c.env, hub, slug);

  return c.json({
    ok: true,
    slug,
    repoId: repo.meta.repoId,
    currentMainCommit: meta.scmModel === "github"
      ? repo.meta.githubDefaultBranchHeadSha ?? null
      : repo.meta.mainCommit,
  });
});

envRoutes.post("/api/envs/:slug/sync", async (c) => {
  const slug = c.req.param("slug");
  if (!(await readProjectedEnvMeta(c.env, slug))) return c.json({ error: "Not found" }, 404);

  const hub = getHub(c.env);
  const [sessions, routableSessionIds] = await Promise.all([
    hub.getAllSessions(),
    hub.getRoutableSessionIds(),
  ]);
  const routable = new Set(routableSessionIds);
  const leadSessionIds = sessions
    .filter((session) => (
      session.active === 1
      && session.ended_at === null
      && routable.has(session.id)
      && readManagedEnvSlugFromStoredSession(session) === slug
      && readManagedRoleFromStoredSession(session) === "lead"
    ))
    .map((session) => session.id);
  if (leadSessionIds.length === 0) {
    return c.json({ error: "No active implementor session is connected." }, 409);
  }

  await Promise.all(leadSessionIds.map((sessionId) => (
    hub.addMessage(crypto.randomUUID(), sessionId, { type: "sync" }, null)
  )));
  return c.json({
    ok: true,
    slug,
    message: "Sync triggered",
    sessionCount: leadSessionIds.length,
  });
});

envRoutes.delete("/api/envs/:slug", async (c) => {
  const result = await deleteEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    slug: c.req.param("slug"),
  });
  return c.json(result.body, result.status as any);
});

export default envRoutes;
