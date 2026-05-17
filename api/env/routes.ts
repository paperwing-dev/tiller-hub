// Environment CRUD and container lifecycle.
// Workspace state stays hosted in WorkspaceDO; environments run on Cloudflare Containers or Tiller Self Host.

import { Hono } from "hono";
import type { MergeConflictPayload } from "../scm/conflict-resolution";
import { getEnvLifecycleStub, getWorkspaceStub } from "../helpers";
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
} from "../types";
import { isGitHubAppAllowedForRequest } from "../github/app";
import {
  githubAppPublicHubDisabledBody,
  loadRepoForRequest,
  type RepoAccessFailure,
  type RepoAccessResult,
  type RepoWorkspace,
} from "../repo/access";
import { isEnvHarness } from "./harness";
import { getRunnerBackend } from "./runner-backends";
import {
  deriveBranchBackedEnvStatus,
  hasCurrentMainBase,
  withDerivedBranchBackedEnvStatus,
} from "../scm/model";
import { SCM_ARTIFACT_CONTENT_TYPE } from "../scm/constants";
import {
  handleScmFailedCallback,
  handleScmHeartbeatCallback,
  handleScmProgressCallback,
  handleScmResultCallback,
} from "../scm/callbacks";
import { resolveMergeConflictsWithAi } from "../scm/conflict-resolution";
import { getScmOperationStore } from "../scm/operation-store";
import {
  startMergeIntoMainWorkflow,
  startUpdateFromMainWorkflow,
} from "../scm/workflows";
import {
  projectEnvSummary,
  projectRepoSummary,
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
  readScmOperationHeader,
  readScmOperationIntHeader,
  readScmOperationDurationHeader,
} from "./scm-operations";
import {
  TREE_HASH_EXCLUDES,
} from "./launch-config";
import { createEnvAction, deleteEnvAction, startEnvAction, stopEnvAction } from "./lifecycle-actions";
import { revokeCodexGatewaySessionsForEnv } from "../gateway-session";
import { isSafePath } from "../workspace/validate";
import { revokeGitHubBridgesForInteractiveEnv } from "../github/bridge";

const MAX_CHANGE_PREVIEW_BYTES = 400_000;

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

type PromotePreviewRoute = "changes" | "changes/file";
type PromotePreviewTimings = Record<string, number>;

function nowForTimingMs(): number {
  return Date.now();
}

function recordPromotePreviewTiming(timings: PromotePreviewTimings | undefined, key: string, startedAt: number): void {
  if (!timings) return;
  timings[key] = Math.max(0, nowForTimingMs() - startedAt);
}

async function timePromotePreviewStep<T>(
  timings: PromotePreviewTimings | undefined,
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!timings) return fn();
  const startedAt = nowForTimingMs();
  try {
    return await fn();
  } finally {
    recordPromotePreviewTiming(timings, key, startedAt);
  }
}

function logPromotePreviewTiming(details: {
  route: PromotePreviewRoute;
  slug: string;
  path?: string;
  statusCode: number;
  outcome: string;
  branchStatus?: string | null;
  fileCount?: number | null;
  previewable?: boolean | null;
  reason?: string | null;
  timings: PromotePreviewTimings;
}): void {
  console.info(`[envs] promote-preview timing ${JSON.stringify(details)}`);
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
  meta: EnvMeta;
  opId: string;
  stepId?: StartupDiagnosticStepId;
  message: string;
  detail: string | null;
  at: string | null;
  exitCode: number | null;
  signal: string | null;
  logTails: Partial<StartupDiagnosticLogTails> | null;
}): Promise<Record<string, unknown>> {
  await getEnvLifecycleStub(args.env, args.slug).reportStartupFailure({
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
    status: projected?.status ?? args.meta.status ?? null,
    error: projected?.error ?? args.message.trim(),
  };
}

async function recordStartupDiagnosticEvent(args: {
  env: Env;
  slug: string;
  meta: EnvMeta;
  opId: string;
  stepId: StartupDiagnosticStepId;
  severity: StartupDiagnosticSeverity | null;
  message: string;
  detail: string | null;
  at: string | null;
  logTails: Partial<StartupDiagnosticLogTails> | null;
}): Promise<Record<string, unknown>> {
  await getEnvLifecycleStub(args.env, args.slug).reportStartupEvent({
    opId: args.opId,
    stepId: args.stepId,
    severity: args.severity,
    message: args.message,
    detail: args.detail,
    at: args.at,
    logTails: args.logTails,
  });
  const projected = await tryProjectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
  return {
    ok: true,
    slug: args.slug,
    status: projected?.status ?? args.meta.status ?? null,
  };
}

async function finalizeRunnerStoppedCallback(args: {
  env: Env;
  slug: string;
  opId: string;
  detail: string;
}): Promise<EnvMeta | null> {
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);
  const lifecycleBefore = await lifecycleStub.getState();
  console.info(
    `[envs] runner-stopped received for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      detail: args.detail || null,
      lifecycleBefore: formatLifecycleDebug(lifecycleBefore),
    })}`,
  );
  const lifecycleAfter = await lifecycleStub.noteRunnerStopped(
    args.opId,
    args.detail || null,
  );
  console.info(
    `[envs] runner-stopped applied for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      lifecycleAfter: formatLifecycleDebug(lifecycleAfter),
    })}`,
  );

  const projected = await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
  if (projected?.status === "stopped") {
    await revokeCodexGatewaySessionsForEnv(args.env, args.slug);
    await revokeGitHubBridgesForInteractiveEnv(args.env, args.slug);
    await lifecycleStub.clearStopWorkspaceSyncedMeta().catch(() => {});
  }
  return projected;
}

async function applyWorkspaceSyncedCallback(args: {
  env: Env;
  slug: string;
  opId: string;
  workspacePatch: Partial<StopWorkspaceSyncedMetaPatch>;
}): Promise<EnvMeta | null> {
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);
  const lifecycleBefore = await lifecycleStub.getState();
  console.info(
    `[envs] workspace-synced ack received for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      lifecycleBefore: formatLifecycleDebug(lifecycleBefore),
      workspacePatch: args.workspacePatch,
    })}`,
  );

  await lifecycleStub.noteStopWorkspaceSynced(args.opId, args.workspacePatch);
  const lifecycleAfter = await lifecycleStub.getState();
  console.info(
    `[envs] workspace-synced ack applied for ${args.slug}: ${JSON.stringify({
      opId: args.opId,
      lifecycleAfter: formatLifecycleDebug(lifecycleAfter),
    })}`,
  );

  return await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
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
  return await projectAndPersistEnvSummary(args.env, getHub(args.env), args.slug);
}

async function applyHarnessFailedCallback(args: {
  env: Env;
  slug: string;
  meta: EnvMeta;
  opId: string | null;
  errorMessage: string;
  startupFailureAlreadyRecorded: boolean;
}): Promise<Record<string, unknown>> {
  const hub = getHub(args.env);
  const lifecycleStub = getEnvLifecycleStub(args.env, args.slug);

  await lifecycleStub.setLeadHarnessFailed(args.errorMessage);
  if (args.meta.status === "starting") {
    await lifecycleStub.noteRunnerStartFailed(args.opId, args.errorMessage);
    // Reconcile may have already turned startup into a generic failure before this
    // report arrives. Preserve the more specific harness error for the UI.
    await lifecycleStub.setError(args.errorMessage);
    const failedMeta = await projectAndPersistEnvSummary(args.env, hub, args.slug);
    return {
      ok: true,
      slug: args.slug,
      status: failedMeta?.status ?? "failed",
      leadHarnessStatus: "failed",
    };
  }

  if (args.startupFailureAlreadyRecorded) {
    await lifecycleStub.setError(args.errorMessage);
    const failedMeta = await projectAndPersistEnvSummary(args.env, hub, args.slug);
    return {
      ok: true,
      slug: args.slug,
      status: failedMeta?.status ?? "failed",
      leadHarnessStatus: "failed",
    };
  }

  await projectAndPersistEnvSummary(args.env, hub, args.slug);
  return { ok: true, slug: args.slug, leadHarnessStatus: "failed" };
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
type WorkspaceSyncedPatchResult =
  | { ok: true; patch: Partial<StopWorkspaceSyncedMetaPatch> }
  | RepoAccessFailure;

function hasActiveScmOperationFields(
  meta: Pick<
    EnvMeta,
    | "scmOperationType"
    | "scmOperationId"
    | "scmOperationPhase"
    | "scmOperationStartedAt"
    | "scmOperationUpdatedAt"
  >,
): boolean {
  return !!(
    meta.scmOperationType
    || meta.scmOperationId
    || meta.scmOperationPhase
    || meta.scmOperationStartedAt
    || meta.scmOperationUpdatedAt
  );
}

function getScmPendingBody(meta: Pick<EnvMeta, "scmOperationType">, action: string): Record<string, unknown> {
  const operation = meta.scmOperationType ?? "unknown";
  return {
    error: `Environment has an active SCM operation (${operation}). Wait for it to finish before ${action}.`,
    code: "env_scm_pending",
  };
}

function getRepoGitMetadataNotReadyBody(): Record<string, unknown> {
  return {
    error: "Canonical main is not ready yet for this repository. Wait for repo git bootstrap to finish.",
    code: "repo_git_not_ready",
  };
}

async function readValidatedRepoContext(
  env: Env,
  args: {
    request: Request;
    repoId: string | null | undefined;
    requireGitReady?: boolean;
    timings?: PromotePreviewTimings;
    timingKey?: string;
    logPrefix?: string;
    mapUnavailableToGitNotReady?: boolean;
  },
): Promise<RepoAccessResult<RepoWorkspace>> {
  const loadedRepo = await timePromotePreviewStep(
    args.timings,
    args.timingKey ?? "repoContextMs",
    () => loadRepoForRequest(
      env,
      args.request,
      args.repoId,
      args.requireGitReady ? "selected-write-with-git" : "selected-write",
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

async function readReadonlyRepoContext(
  env: Env,
  request: Request,
  meta: Pick<EnvMeta, "repoId">,
  timings?: PromotePreviewTimings,
): Promise<RepoAccessResult<RepoWorkspace>> {
  return readValidatedRepoContext(env, {
    request,
    repoId: meta.repoId,
    requireGitReady: true,
    timings,
    logPrefix: "[envs] Failed to read canonical repo metadata for promote preview:",
    mapUnavailableToGitNotReady: true,
  });
}

async function readStoppedEnvPreviewContext(
  env: Env,
  request: Request,
  slug: string,
  action: string,
  timings?: PromotePreviewTimings,
): Promise<StoppedEnvRepoContext> {
  const loadedMeta = await timePromotePreviewStep(timings, "readMetaMs", () =>
    readProjectedEnvMeta(env, slug).catch((error) => {
      console.warn(
        "[envs] Failed to read env metadata for promote preview:",
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

  const meta = await timePromotePreviewStep(
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
  if (hasActiveScmOperationFields(meta)) {
    return {
      ok: false,
      status: 409,
      body: getScmPendingBody(meta, action),
    };
  }

  const loadedRepo = await readReadonlyRepoContext(env, request, meta, timings);
  if (!loadedRepo.ok) {
    return loadedRepo;
  }

  const deriveStartedAt = nowForTimingMs();
  const syncedMeta = withDerivedBranchBackedEnvStatus(meta, loadedRepo.repo.meta);
  recordPromotePreviewTiming(timings, "deriveBranchStatusMs", deriveStartedAt);
  return {
    ok: true,
    meta: syncedMeta,
    repo: loadedRepo.repo,
    branchStatus: syncedMeta.branchStatus ?? "up-to-date",
  };
}

async function buildEnvChanges(
  env: Env,
  repo: RepoWorkspaceHandle,
  slug: string,
  timings?: PromotePreviewTimings,
): Promise<EnvChangeEntry[]> {
  const envWorkspace = getWorkspaceStub(env, slug);
  const [oldManifest, newManifest] = await Promise.all([
    timePromotePreviewStep(timings, "repoManifestMs", () =>
      repo.workspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
    ),
    timePromotePreviewStep(timings, "envManifestMs", () =>
      envWorkspace.getHashedManifest({ excludePrefixes: TREE_HASH_EXCLUDES }),
    ),
  ]);
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
  recordPromotePreviewTiming(timings, "manifestCompareMs", compareStartedAt);
  return changes;
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
  timings?: PromotePreviewTimings,
): Promise<EnvChangeFileData | null> {
  const [oldStat, newStat] = await Promise.all([
    timePromotePreviewStep(timings, "repoFileStatMs", async () => repoWorkspace.statWorkspaceFile(path)),
    timePromotePreviewStep(timings, "envFileStatMs", async () => envWorkspace.statWorkspaceFile(path)),
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
    timePromotePreviewStep(timings, "repoEqualityReadMs", () => repoWorkspace.readWorkspaceFileBytes(path)),
    timePromotePreviewStep(timings, "envEqualityReadMs", () => envWorkspace.readWorkspaceFileBytes(path)),
  ]);
  if (!oldBytes || !newBytes) return null;
  const compareStartedAt = nowForTimingMs();
  const equal = bytesEqual(oldBytes, newBytes);
  recordPromotePreviewTiming(timings, "fileEqualityCompareMs", compareStartedAt);
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

function getPromoteBaseError(
  meta: Pick<EnvMeta, "baseMainCommit">,
  repo: { meta: { mainCommit: string | null } },
): Record<string, unknown> | null {
  if (hasCurrentMainBase(meta, repo.meta)) {
    return null;
  }
  return {
    error: "Environment must be updated from current main before previewing or promoting.",
    code: "env_base_not_current",
    hint: "Run Update from Main if the environment is behind, or reset it to main if its base commit is missing.",
  };
}

function readBooleanHeader(request: Request, name: string): boolean | undefined {
  const value = request.headers.get(name)?.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
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

async function buildWorkspaceSyncedPatch(
  env: Env,
  meta: EnvMeta,
  request: Request,
): Promise<WorkspaceSyncedPatchResult> {
  const headerPatch = readWorkspaceSyncedPatchFromHeaders(request);
  try {
    const loadedRepo = await loadRepoForRequest(env, request, meta.repoId, "selected-write-with-git");
    if (!loadedRepo.ok) {
      if (loadedRepo.body.code === "github_app_public_hub_disabled") {
        return loadedRepo;
      }
      throw new Error(typeof loadedRepo.body.error === "string" ? loadedRepo.body.error : "Repository metadata is not available.");
    }
    const repo = loadedRepo.repo;

    const envWorkspace = getWorkspaceStub(env, meta.slug);
    const [repoTreeHash, envTreeHash] = await Promise.all([
      repo.workspace.computeWorkspaceTreeHash({ excludePrefixes: TREE_HASH_EXCLUDES }),
      envWorkspace.computeWorkspaceTreeHash({ excludePrefixes: TREE_HASH_EXCLUDES }),
    ]);
    const workspaceDirty = repoTreeHash !== envTreeHash;
    const currentMainCommit = repo.meta.mainCommit ?? null;
    const baseMainCommit = workspaceDirty
      ? meta.baseMainCommit ?? meta.lastKnownMainCommit ?? null
      : currentMainCommit;
    const nextMeta = {
      ...meta,
      workspaceDirty,
      workspaceNeedsAttention: false,
      baseMainCommit,
      lastKnownMainCommit: currentMainCommit,
    };

    return {
      ok: true,
      patch: {
        ...headerPatch,
        workspaceDirty,
        workspaceNeedsAttention: false,
        baseMainCommit,
        lastKnownMainCommit: currentMainCommit,
        branchStatus: deriveBranchBackedEnvStatus(nextMeta, repo.meta),
      },
    };
  } catch (error) {
    console.warn(
      `[envs] Failed to classify saved workspace for ${meta.slug}:`,
      error instanceof Error ? error.message : String(error),
    );
    return {
      ok: true,
      patch: {
        ...headerPatch,
        workspaceNeedsAttention: true,
        branchStatus: "needs-attention",
      },
    };
  }
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
  const projected = await Promise.all(
    (await listEnvViews(c.env)).map(async (meta) => {
      try {
        return await projectEnvMetaForRead(c.env, meta);
      } catch (error) {
        console.warn(
          `[envs] Skipping env ${meta.slug} during projection:`,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
    }),
  );
  return c.json(
    projected
      .filter((meta): meta is EnvMeta => meta !== null)
      .map((meta) => projectEnvSummary(meta)),
  );
});

envRoutes.post("/api/envs", async (c) => {
  const body: {
    repoId?: string;
    slug?: string;
    backend?: string;
    harness?: string;
    authMode?: string;
    codexAuthPreference?: string;
    planId?: string | null;
    planSelection?: unknown;
  } = await c.req.json<{
    repoId?: string;
    slug?: string;
    backend?: string;
    harness?: string;
    authMode?: string;
    codexAuthPreference?: string;
    planId?: string | null;
    planSelection?: unknown;
  }>().catch(() => ({}));
  const requestedRepoId = typeof body.repoId === "string" ? body.repoId.trim() : "";
  if (!requestedRepoId) return c.json({ error: "repoId is required", code: "repo_id_required" }, 400);
  if (body.backend !== "cf" && body.backend !== "host") {
    return c.json({ error: "backend is required and must be 'cf' or 'host'" }, 400);
  }
  if (!body.harness) {
    return c.json({ error: "harness is required and must be 'claude-code', 'codex', or 'opencode'" }, 400);
  }
  if (!isEnvHarness(body.harness)) {
    return c.json({ error: "harness must be 'claude-code', 'codex', or 'opencode'" }, 400);
  }
  if (body.authMode && body.authMode !== "auto" && body.authMode !== "subscription" && body.authMode !== "api") {
    return c.json({ error: "authMode must be 'auto', 'subscription', or 'api'" }, 400);
  }

  const result = await createEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    request: c.req.raw,
    requestUrl: c.req.url,
    repoId: requestedRepoId,
    requestedSlug: body.slug?.trim(),
    backendKind: body.backend,
    harness: body.harness,
    requestedAuthMode: body.authMode as "auto" | "subscription" | "api" | undefined,
    requestedCodexAuthPreference: body.codexAuthPreference,
    planId: body.planId,
    planSelection: body.planSelection,
  });
  return c.json(result.body, result.status as any);
});

envRoutes.get("/api/envs/:slug", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const projected = await projectEnvMetaForRead(c.env, meta);
  return c.json(projectEnvSummary(projected));
});

envRoutes.post("/api/envs/:slug/start", async (c) => {
  const slug = c.req.param("slug");
  const body: { planId?: string | null; planSelection?: unknown } = c.req.header("Content-Type")?.includes("application/json")
    ? await c.req.json<{ planId?: string | null; planSelection?: unknown }>().catch(() => ({}))
    : {};
  const result = await startEnvAction({
    env: c.env,
    get executionCtx() {
      return c.executionCtx;
    },
    request: c.req.raw,
    requestUrl: c.req.url,
    slug,
    planId: body.planId,
    planSelection: body.planSelection,
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

envRoutes.get("/api/envs/:slug/startup-diagnostics", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const diagnostics = await getEnvLifecycleStub(c.env, slug).getStartupDiagnostics();
  return c.json(diagnostics);
});

envRoutes.post("/api/envs/:slug/startup-diagnostics", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);
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
    const result = await recordStartupDiagnosticFailure({
      env: c.env,
      slug,
      meta,
      opId,
      stepId: isStartupDiagnosticStepId(body.stepId) ? body.stepId : undefined,
      message: body.message,
      detail: typeof body.detail === "string" ? body.detail : null,
      at: typeof body.at === "string" ? body.at : null,
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      signal: typeof body.signal === "string" ? body.signal : null,
      logTails,
    });
    return c.json(result);
  }

  if (!isStartupDiagnosticStepId(body.stepId)) {
    return c.json({ error: "stepId is required" }, 400);
  }

  const result = await recordStartupDiagnosticEvent({
    env: c.env,
    slug,
    meta,
    opId,
    stepId: body.stepId,
    severity: readStartupDiagnosticSeverity(body.severity),
    message: body.message,
    detail: typeof body.detail === "string" ? body.detail : null,
    at: typeof body.at === "string" ? body.at : null,
    logTails,
  });
  return c.json(result);
});

envRoutes.post("/api/envs/:slug/boot-progress", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const body = await c.req.json<{ message: string; stepId?: string }>();
  if (!body.message) return c.json({ error: "message is required" }, 400);
  if (body.stepId !== undefined && !isStartupDiagnosticStepId(body.stepId)) {
    return c.json({ error: "Invalid stepId" }, 400);
  }

  const hub = getHub(c.env);
  await getEnvLifecycleStub(c.env, slug).setBootProgress(
    body.message,
    isStartupDiagnosticStepId(body.stepId) ? body.stepId : undefined,
  );
  await projectAndPersistEnvSummary(c.env, hub, slug);
  return c.json({ ok: true });
});

envRoutes.post("/api/envs/:slug/infra-ready", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  await lifecycleStub.noteInfraReady(opId);

  const hub = getHub(c.env);
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug);
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? meta.status ?? null,
  });
});

envRoutes.post("/api/envs/:slug/runner-ready", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  await lifecycleStub.noteRunnerStarted(opId);

  const hub = getHub(c.env);
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug);
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? meta.status ?? null,
  });
});

envRoutes.post("/api/envs/:slug/runner-stopped", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);
  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const detail = (await c.req.text().catch(() => "")).trim();
  const projected = await finalizeRunnerStoppedCallback({ env: c.env, slug, opId, detail });
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? meta.status ?? null,
    error: projected?.error ?? (detail || null),
  });
});

envRoutes.post("/api/envs/:slug/workspace-synced", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const opId = readLifecycleOpIdHeader(c.req.raw);
  if (!opId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const workspacePatchResult = await buildWorkspaceSyncedPatch(c.env, meta, c.req.raw);
  if (!workspacePatchResult.ok) {
    return c.json(workspacePatchResult.body, workspacePatchResult.status as any);
  }
  const workspacePatch = workspacePatchResult.patch;

  const projected = await applyWorkspaceSyncedCallback({ env: c.env, slug, opId, workspacePatch });
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? meta.status ?? null,
  });
});

envRoutes.post("/api/envs/:slug/stop-failed", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);
  if (!isLifecycleStopInProgress(meta)) {
    return c.json({ ok: true, slug, status: meta.status ?? null });
  }

  const bodyText = (await c.req.text().catch(() => "")).trim();
  const message = bodyText || "Stop failed before workspace persistence completed; recent workspace changes were not saved.";
  const stopOpId = readLifecycleOpIdHeader(c.req.raw);
  if (!stopOpId) return c.json({ error: "Missing X-Tiller-Lifecycle-Op-Id header" }, 400);

  const projected = await recordStopFailedCallback({ env: c.env, slug, opId: stopOpId, message });
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? meta.status ?? null,
    error: message,
  });
});

envRoutes.post("/api/envs/:slug/harness-failed", async (c) => {
  const slug = c.req.param("slug");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const startupFailureAlreadyRecorded =
    meta.status === "failed" &&
    meta.lifecycleDesiredState === "running" &&
    typeof meta.error === "string" &&
    meta.error.startsWith("Container exited before the environment finished starting");

  // A harness crash during startup should fail the start operation directly.
  // Once the env is already running, keep the env alive for debugging and
  // surface the harness failure as a separate status.
  if (meta.status !== "starting" && meta.status !== "running" && !startupFailureAlreadyRecorded) {
    return c.json({ ok: true, slug, status: meta.status ?? null, ignored: true });
  }

  const bodyText = (await c.req.text().catch(() => "")).trim();
  const errorMessage = bodyText || "Lead harness exited unexpectedly";
  const opId = readLifecycleOpIdHeader(c.req.raw) || meta.lifecycleOpId || null;

  const result = await applyHarnessFailedCallback({
    env: c.env,
    slug,
    meta,
    opId,
    errorMessage,
    startupFailureAlreadyRecorded,
  });
  return c.json(result);
});

envRoutes.get("/api/envs/:slug/changes", async (c) => {
  const slug = c.req.param("slug");
  const timings: PromotePreviewTimings = {};
  const requestStartedAt = nowForTimingMs();
  let statusCode = 200;
  let outcome = "ok";
  let branchStatus: string | null = null;
  let fileCount: number | null = null;
  try {
    const contextStartedAt = nowForTimingMs();
    const loaded = await readStoppedEnvPreviewContext(c.env, c.req.raw, slug, "showing promote preview", timings);
    recordPromotePreviewTiming(timings, "contextMs", contextStartedAt);
    if (!loaded.ok) {
      statusCode = loaded.status;
      outcome = String(loaded.body.code ?? "error");
      return c.json(loaded.body, loaded.status as any);
    }

    branchStatus = loaded.branchStatus;
    if (loaded.branchStatus === "behind-main") {
      statusCode = 409;
      outcome = "env_behind_main";
      return c.json(
        {
          error: "Environment is behind main. Update from Main before previewing or promoting.",
          code: "env_behind_main",
          hint: "Run Update from Main to merge current main into this environment.",
        },
        409,
      );
    }
    if (loaded.branchStatus === "needs-attention") {
      statusCode = 409;
      outcome = "env_needs_attention";
      return c.json(
        {
          error: "Environment needs attention before it can be promoted.",
          code: "env_needs_attention",
          hint: "Reset the environment to main or resolve the conflicting state.",
        },
        409,
      );
    }
    const baseError = getPromoteBaseError(loaded.meta, loaded.repo);
    if (baseError) {
      statusCode = 409;
      outcome = String(baseError.code ?? "env_base_not_current");
      return c.json(baseError, 409);
    }

    const files = await buildEnvChanges(c.env, loaded.repo, slug, timings);
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
    recordPromotePreviewTiming(timings, "summaryMs", summaryStartedAt);

    const responseStartedAt = nowForTimingMs();
    const response = c.json({
      slug,
      repoId: loaded.repo.meta.repoId,
      repoUrl: loaded.repo.meta.repoUrl,
      comparisonBasis: "promote-preview",
      oldCommit: loaded.repo.meta.mainCommit ?? null,
      newBaseCommit: loaded.meta.baseMainCommit ?? null,
      branchStatus: loaded.branchStatus,
      summary,
      files,
    });
    recordPromotePreviewTiming(timings, "responseMs", responseStartedAt);
    return response;
  } finally {
    recordPromotePreviewTiming(timings, "totalMs", requestStartedAt);
    logPromotePreviewTiming({
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

  const timings: PromotePreviewTimings = {};
  const requestStartedAt = nowForTimingMs();
  let statusCode = 200;
  let outcome = "ok";
  let branchStatus: string | null = null;
  let previewable: boolean | null = null;
  let reason: string | null = null;
  try {
    const contextStartedAt = nowForTimingMs();
    const loaded = await readStoppedEnvPreviewContext(c.env, c.req.raw, slug, "showing promote preview", timings);
    recordPromotePreviewTiming(timings, "contextMs", contextStartedAt);
    if (!loaded.ok) {
      statusCode = loaded.status;
      outcome = String(loaded.body.code ?? "error");
      return c.json(loaded.body, loaded.status as any);
    }

    branchStatus = loaded.branchStatus;
    if (loaded.branchStatus === "behind-main") {
      statusCode = 409;
      outcome = "env_behind_main";
      return c.json(
        {
          error: "Environment is behind main. Update from Main before previewing or promoting.",
          code: "env_behind_main",
          hint: "Run Update from Main to merge current main into this environment.",
        },
        409,
      );
    }
    if (loaded.branchStatus === "needs-attention") {
      statusCode = 409;
      outcome = "env_needs_attention";
      return c.json(
        {
          error: "Environment needs attention before it can be promoted.",
          code: "env_needs_attention",
          hint: "Reset the environment to main or resolve the conflicting state.",
        },
        409,
      );
    }
    const baseError = getPromoteBaseError(loaded.meta, loaded.repo);
    if (baseError) {
      statusCode = 409;
      outcome = String(baseError.code ?? "env_base_not_current");
      return c.json(baseError, 409);
    }

    const envWorkspace = getWorkspaceStub(c.env, slug);
    const fileChange = await timePromotePreviewStep(
      timings,
      "fileChangeMs",
      () => buildEnvChangeFileData(loaded.repo.workspace, envWorkspace, path, timings),
    );
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
      recordPromotePreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    const [oldBytes, newBytes] = await Promise.all([
      preloadedOldBytes
        ? Promise.resolve(preloadedOldBytes)
        : entry.status === "added"
          ? Promise.resolve(new Uint8Array())
          : timePromotePreviewStep(timings, "repoFileReadMs", () => loaded.repo.workspace.readWorkspaceFileBytes(path)),
      preloadedNewBytes
        ? Promise.resolve(preloadedNewBytes)
        : entry.status === "deleted"
          ? Promise.resolve(new Uint8Array())
          : timePromotePreviewStep(timings, "envFileReadMs", () => envWorkspace.readWorkspaceFileBytes(path)),
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
      recordPromotePreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    const binaryCheckStartedAt = nowForTimingMs();
    const hasBinaryContent = hasBinaryBytes(oldBytes) || hasBinaryBytes(newBytes);
    recordPromotePreviewTiming(timings, "binaryCheckMs", binaryCheckStartedAt);
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
      recordPromotePreviewTiming(timings, "responseMs", responseStartedAt);
      return response;
    }

    const decodeStartedAt = nowForTimingMs();
    const oldString = decodeUtf8(oldBytes);
    const newString = decodeUtf8(newBytes);
    recordPromotePreviewTiming(timings, "decodeMs", decodeStartedAt);
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
      recordPromotePreviewTiming(timings, "responseMs", responseStartedAt);
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
    recordPromotePreviewTiming(timings, "responseMs", responseStartedAt);
    return response;
  } finally {
    recordPromotePreviewTiming(timings, "totalMs", requestStartedAt);
    logPromotePreviewTiming({
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

envRoutes.post("/api/envs/:slug/merge-into-main", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json(githubAppPublicHubDisabledBody(), 403);
  }
  const result = await startMergeIntoMainWorkflow(c.env, c.req.url, c.req.param("slug"));
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/update-from-main", async (c) => {
  if (!(await isGitHubAppAllowedForRequest(c.env, c.req.raw))) {
    return c.json(githubAppPublicHubDisabledBody(), 403);
  }
  const result = await startUpdateFromMainWorkflow(c.env, c.req.url, c.req.param("slug"));
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/scm-operations/:operationId/progress", async (c) => {
  const body = await c.req.json<{ phase?: string }>().catch((): { phase?: string } => ({}));
  const phase = body.phase?.trim();
  if (!phase) {
    return c.json({ error: "phase is required" }, 400);
  }

  const result = await handleScmProgressCallback(c.env, c.req.param("slug"), c.req.param("operationId"), phase);
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/scm-operations/:operationId/failed", async (c) => {
  const messageHeader = readScmOperationHeader(c.req.header("X-Tiller-Scm-Error"));
  const messageBody = (await c.req.text().catch(() => "")).trim();
  const message = messageHeader || messageBody || "SCM operation failed before reporting a result.";
  const durationMs = readScmOperationDurationHeader(c.req.header("X-Tiller-Scm-Duration-Ms"));
  const timings = readScmOperationHeader(c.req.header("X-Tiller-Scm-Timings"));

  const result = await handleScmFailedCallback(c.env, c.req.param("slug"), c.req.param("operationId"), {
    message,
    durationMs,
    timings,
  });
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/scm-operations/:operationId/result", async (c) => {
  const action = readScmOperationHeader(c.req.header("X-Tiller-Scm-Action"));
  const message = readScmOperationHeader(c.req.header("X-Tiller-Scm-Message"));
  const conflictCount = readScmOperationIntHeader(c.req.header("X-Tiller-Conflict-Count"));
  const gitHead = readScmOperationHeader(c.req.header("X-Tiller-Git-Head"));
  const durationMs = readScmOperationDurationHeader(c.req.header("X-Tiller-Scm-Duration-Ms"));
  const timings = readScmOperationHeader(c.req.header("X-Tiller-Scm-Timings"));
  const sourceEnvMatchesMain = readBooleanHeader(c.req.raw, "X-Tiller-Source-Env-Matches-Main");
  const result = await handleScmResultCallback(c.env, c.req.param("slug"), c.req.param("operationId"), {
    action,
    message,
    conflictCount,
    gitHead,
    durationMs,
    timings,
    mergedTar: new Uint8Array(await c.req.arrayBuffer()),
    sourceEnvMatchesMain: sourceEnvMatchesMain ?? null,
  });

  if (result.mergedRepoBroadcast) {
    const { nextRepoMeta, previousMainCommit, slug } = result.mergedRepoBroadcast;
    c.executionCtx.waitUntil((async () => {
      try {
        const hub = getHub(c.env);
        await hub.broadcastRepoUpsert(projectRepoSummary(nextRepoMeta));
        await hub.broadcastRepoMainChange(
          nextRepoMeta.repoId,
          nextRepoMeta.repoUrl,
          previousMainCommit,
          nextRepoMeta.mainCommit,
          slug,
        );
      } catch (error) {
        console.error(`[envs] Failed to broadcast merged repo state for ${slug}:`, error);
      }
    })());
  }

  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/scm-operations/:operationId/resolve-conflicts", async (c) => {
  const slug = c.req.param("slug");
  const operationId = c.req.param("operationId");
  const meta = await readProjectedEnvMeta(c.env, slug);
  if (!meta) return c.json({ error: "Not found" }, 404);

  const loadedRepo = await readValidatedRepoContext(c.env, {
    request: c.req.raw,
    repoId: meta.repoId,
  });
  if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
  const repo = loadedRepo.repo;
  const store = getScmOperationStore(c.env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (
    !operation ||
    operation.envSlug !== slug ||
    (operation.type !== "merge-into-main" && operation.type !== "update-from-main")
  ) {
    return c.json({ error: "SCM operation not found" }, 404);
  }
  if (operation.status !== "pending") {
    return c.json({ error: "SCM operation is no longer pending" }, 409);
  }

  const body = await c.req.json<{ conflicts?: MergeConflictPayload[] }>().catch((): { conflicts?: MergeConflictPayload[] } => ({}));
  const conflicts = Array.isArray(body.conflicts) ? body.conflicts : null;
  if (!conflicts) {
    return c.json({ error: "conflicts is required" }, 400);
  }

  try {
    const resolved = await resolveMergeConflictsWithAi(c.env, conflicts);
    return c.json({
      ok: true,
      operationId,
      model: resolved.model,
      resolutions: resolved.resolutions,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI merge resolution failed.";
    return c.json({ error: message }, 502);
  }
});

envRoutes.post("/api/envs/:slug/scm-operations/:operationId/heartbeat", async (c) => {
  const result = await handleScmHeartbeatCallback(
    c.env,
    c.req.param("slug"),
    c.req.param("operationId"),
    readScmOperationHeader(c.req.header("X-Tiller-Merge-Lock-Token")),
  );
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

  const loadedRepo = await readValidatedRepoContext(c.env, {
    request: c.req.raw,
    repoId: meta.repoId,
    requireGitReady: true,
  });
  if (!loadedRepo.ok) return c.json(loadedRepo.body, loadedRepo.status as any);
  const repo = loadedRepo.repo;
  const workspaceStub = getWorkspaceStub(c.env, slug);
  const repoTar = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
  await workspaceStub.restoreFromTar(repoTar, {
    clearFirst: true,
    preservePrefixes: TREE_HASH_EXCLUDES,
  });

  await deleteEnvSnapshotArtifacts(c.env.BUCKET, slug);

  const nextMeta = withDerivedBranchBackedEnvStatus(
    {
      ...clearEnvError(meta),
      workspaceDirty: false,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: new Date().toISOString(),
      baseMainCommit: repo.meta.mainCommit ?? null,
      lastKnownMainCommit: repo.meta.mainCommit ?? null,
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
    currentMainCommit: repo.meta.mainCommit,
  });
});

envRoutes.post("/api/envs/:slug/sync", async (c) => {
  const slug = c.req.param("slug");
  if (!(await readProjectedEnvMeta(c.env, slug))) return c.json({ error: "Not found" }, 404);

  const hub = getHub(c.env);
  await hub.addMessage(crypto.randomUUID(), slug, { type: "sync" }, null);
  return c.json({ ok: true, slug, message: "Sync triggered" });
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
