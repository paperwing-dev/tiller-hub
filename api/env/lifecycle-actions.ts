import { getArtifactStoreStub, getEnvLifecycleStub, getEnvReviewStub, getScheduledRunCapacityStub, getWorkspaceStub } from "../helpers";
import { buildEnvScmMetaPatch, isLifecycleStopInProgress } from "../env-lifecycle";
import { revokeGitHubBridgesForEnvironmentStart, revokeGitHubBridgesForInteractiveEnv } from "../github/bridge";
import { getEnvDefinitionKey, persistEnvDefinition } from "../plan/store";
import {
  loadRepoForRequest,
  loadTrackedRepo,
  type RepoAccessResult,
  type RepoWorkspace,
} from "../repo/access";
import {
  refreshGitHubDefaultBranchHeadForRequest,
  type GitHubDefaultBranchRefreshResult,
} from "../repo/refresh";
import {
  createInitialEnvScmState,
  deriveBranchBackedEnvStatus,
  parseStartupPlanSelection,
  withDerivedBranchBackedEnvStatus,
  type StartupPlanSelection,
} from "../scm/model";
import { getBillingSelections } from "../setup/config";
import { classifyHostRuntimeCompatibility } from "../setup/runtime-compatibility";
import { redactEnvValues } from "../redaction";
import { isHostRoutable, readRoutableHostService } from "../service-registry";
import { projectEnvSummary } from "../sync/projectors";
import type {
  CodexAuthPreference,
  Env,
  EnvHarness,
  EnvMeta,
  EnvMutableState,
  HarnessSettings,
  HostServiceRegistration,
  ResolvedClaudeAuthMode,
} from "../types";
import { getHarnessModel, resolveHarnessSettings } from "../../shared/harness-catalog";
import { createBillingResolutionError } from "../billing-resolution";
import {
  billingSelectionForCredential,
  resolveBillingCompatibility,
  type ProviderControlledCredentialClass,
} from "../../shared/billing";
import { buildMutableStateFromMeta } from "./state";
import {
  getGitHubStartBaseAdvanceDecision,
  isGitHubDraftOverlayEmpty,
} from "./github-start";
import { isHarnessEnabled } from "./harness";
import {
  buildContainerLaunchConfig,
  materializeResolvedStartupPlan,
  materializeStartupPlan,
  materializeStartupPlanDocument,
  renderResolvedStartupPlanDocument,
  resolveSelectedPlanArtifact,
  resolveStartupPlanDocument,
  resolveSelectedPlanId,
  TREE_HASH_EXCLUDES,
  withStartCausePreamble,
  type EnvStartCause,
} from "./launch-config";
import { deriveEnvDisplayName } from "../../shared/env-display-name";
import {
  getRunnerControlErrorCode,
  inspectRunnerBackend,
  runRunnerMutationWithGenerationReconciliation,
  type EnvironmentStopScope,
  type RunnerBackend,
  type RunnerBackendKind,
} from "./runner-backend";
import { buildWorkspaceSyncedPatch } from "./workspace-synced";
import { getRunnerBackend } from "./runner-backends";
import { normalizeRunnerStatus } from "./status";
import {
  buildEnvDefinition,
  clearEnvError,
  destroyEnv,
  envExists,
  envSlugReserved,
  getHub,
  loadEnvView,
  projectAndPersistEnvSummary,
  projectEnvMetaForAction,
  readLifecycleState,
} from "./service";
import type {
  ScheduledRunCredentialIds,
  ScheduledRunCredentialScope,
} from "./scheduled-run-state";
import { deriveEnvSlugCandidate } from "./slug";
import { ensureRepoEnvironmentSidebarSlots } from "./sidebar-slots";
import {
  NEW_EXECUTION_UNAVAILABLE_MESSAGE,
  EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
  resolveNewExecutionPlacement,
} from "../execution";
import { isLocalDevRequest } from "../protection";
import { cleanupEnvReviewRunRuntime } from "../env-review/dispatch";
import {
  isProjectedRuntimeFailure,
  projectRuntimeFailure,
  type RuntimeFailureCode,
} from "./runtime-failure";

type WaitUntilExecutionContext = Pick<ExecutionContext, "waitUntil">;

function actionErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isCloudflareContainerAllocationTimeout(value: unknown): boolean {
  return actionErrorMessage(value).includes(
    "there is no container instance that can be provided to this durable object",
  );
}

export type RouteResult = {
  status: number;
  body: unknown;
  operationId?: string;
  credentialCleanupComplete?: boolean;
  retryDisposition?: "retry-pre-start" | "terminal";
  /** The injected lifecycle owner already applied the Scheduled Run transition. */
  scheduledRunTransitionApplied?: boolean;
  runnerUncertain?: boolean;
};

function projectedRuntimeFailureResult(
  code: RuntimeFailureCode,
  detail: unknown,
  context: Record<string, unknown>,
  status = 502,
): { failure: ReturnType<typeof projectRuntimeFailure>; result: RouteResult } {
  const failure = projectRuntimeFailure(code, detail, context);
  return {
    failure,
    result: {
      status,
      body: {
        error: failure.message,
        code: failure.code,
        referenceId: failure.referenceId,
      },
    },
  };
}

type ClaimedStartContext = Readonly<{
  opId: string;
  harnessSettings: HarnessSettings;
  authClaim: EnvironmentStartAuthClaim;
}>;

type EnvironmentStartAuthClaim = Readonly<{
  claudeAuthMode: ResolvedClaudeAuthMode | null;
  codexAuthPreference: CodexAuthPreference | null;
}>;

const EMPTY_START_AUTH_CLAIM: EnvironmentStartAuthClaim = {
  claudeAuthMode: null,
  codexAuthPreference: null,
};

async function resolveOrdinaryStartAuthClaim(
  env: Env,
  harness: EnvHarness,
  settings: HarnessSettings,
): Promise<EnvironmentStartAuthClaim> {
  const model = getHarnessModel(harness, settings.model);
  if (!model) throw new Error(`Model ${settings.model} is not supported by ${harness}.`);
  if (model.credential === "workers-ai") return EMPTY_START_AUTH_CLAIM;

  const credential = model.credential as ProviderControlledCredentialClass;
  const selections = await getBillingSelections(env);
  const compatibility = resolveBillingCompatibility(
    credential,
    billingSelectionForCredential(credential, selections),
  );
  if (compatibility.kind !== "compatible") {
    throw createBillingResolutionError(model, compatibility.kind);
  }
  const mode = compatibility.mode;
  return {
    claudeAuthMode: harness === "claude-code" ? mode : null,
    codexAuthPreference: harness === "codex"
      ? mode === "subscription" ? "subscription" : "api-key"
      : null,
  };
}

const SCHEDULED_RUN_PREPARATION_HEARTBEAT_MS = 20_000;

export async function cleanupLaunchCredentialsBestEffort(
  env: Env,
  slug: string,
  scheduled?: { scope: ScheduledRunCredentialScope; ids: ScheduledRunCredentialIds },
): Promise<{ complete: boolean }> {
  if (scheduled) {
    const exact = {
      envSlug: slug,
      incarnationId: scheduled.scope.incarnationId,
      startOpId: scheduled.scope.startOpId,
    };
    const complete = await revokeGitHubBridgesForEnvironmentStart(env, exact)
      .then(() => true)
      .catch(() => false);
    return { complete };
  }
  const complete = await revokeGitHubBridgesForInteractiveEnv(env, slug)
    .then(() => true)
    .catch((error) => {
      console.error(`[envs] Failed to revoke GitHub launch credentials for ${slug}:`, error);
      return false;
    });
  return { complete };
}

function isDispatchableMutableStart(
  state: EnvMutableState | null,
  opId: string,
): boolean {
  return state?.lifecycleOpId === opId
    && state.lifecycleOperation === "start"
    && state.lifecycleDesiredState === "running"
    && state.lifecyclePhase === "starting";
}

export function isValidIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function storedStartupPlanSelection(
  storedPlanId: string | null | undefined,
): StartupPlanSelection {
  return storedPlanId
    ? { mode: "specific", artifactId: storedPlanId }
    : { mode: "none" };
}

async function requireHostConnection(
  env: Env,
  backend: RunnerBackendKind,
  preferredMachineId?: string | null,
): Promise<string | null> {
  if (backend !== "host") return null;
  const machineId = preferredMachineId?.trim();
  if (!machineId) return EXISTING_EXECUTION_UNAVAILABLE_MESSAGE;
  return (await isHostRoutable(env, machineId))
    ? null
    : EXISTING_EXECUTION_UNAVAILABLE_MESSAGE;
}

function getStopFinalizationInProgressError(action: string): string {
  return `Environment is still saving changes from the previous stop. Wait for it to finish before ${action}.`;
}

async function requireRoutableHostService(args: {
  env: Env;
  backendKind: RunnerBackendKind;
  preferredMachineId?: string | null;
}): Promise<
  | { ok: true; hostService: HostServiceRegistration | null }
  | { ok: false; result: RouteResult }
> {
  const hostService = args.backendKind === "host"
    ? await readRoutableHostService(args.env, args.preferredMachineId ?? null)
    : null;
  if (args.backendKind === "host" && !hostService) {
    return {
      ok: false,
      result: {
        status: 409,
        body: {
          error: EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
          code: "workload_execution_backend_unavailable",
        },
      },
    };
  }
  if (args.backendKind === "host") {
    if (hostService?.runnerCommandProtocol !== 1 || hostService.codexRuntimeAuthProtocol !== 1) {
      return {
        ok: false,
        result: {
          status: 409,
          body: {
            error: EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
            code: "workload_execution_backend_unavailable",
          },
        },
      };
    }
    const runtime = classifyHostRuntimeCompatibility(hostService);
    if (!runtime.compatible) {
      return {
        ok: false,
        result: {
          status: 409,
          body: {
            error: EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
            code: "workload_execution_backend_unavailable",
          },
        },
      };
    }
  }

  return { ok: true, hostService };
}

async function findAvailableSlug(
  env: Env,
  repoUrl: string,
  backend: RunnerBackendKind,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slug = deriveEnvSlugCandidate(repoUrl, backend, attempt);
    if (!(await envSlugReserved(env, slug))) return slug;
  }

  throw new Error("Could not allocate unique environment slug");
}

async function readValidatedRepoContext(
  env: Env,
  args: {
    request: Request;
    repoId: string | null | undefined;
  },
): Promise<RepoAccessResult<RepoWorkspace>> {
  return await loadRepoForRequest(
    env,
    args.request,
    args.repoId,
  );
}

function requiredGitHubRepoRefreshFailureResult(
  refresh: GitHubDefaultBranchRefreshResult,
): RouteResult {
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

function matchesWorkspacePrefix(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

async function readCanonicalVisibleWorkspaceFileCount(
  workspaceStub: ReturnType<typeof getWorkspaceStub>,
): Promise<number | null> {
  if (typeof workspaceStub.getManifest !== "function") {
    return null;
  }
  const manifest = await workspaceStub.getManifest();
  return manifest.filter((entry) => !matchesWorkspacePrefix(entry.path, TREE_HASH_EXCLUDES)).length;
}

async function dispatchStopAndFinalizeIfNoCallback(args: {
  env: Env;
  slug: string;
  backend: RunnerBackend;
  meta: EnvMeta;
  hub: ReturnType<typeof getHub>;
  stopOpId: string;
  idleClaimId?: string | null;
  lifecycleStub?: ReturnType<typeof getEnvLifecycleStub>;
  projectSummary?: () => Promise<EnvMeta | null>;
}): Promise<void> {
  const lifecycleStub = args.lifecycleStub ?? getEnvLifecycleStub(args.env, args.slug);
  let stopScope: EnvironmentStopScope | null = null;
  if (args.backend.kind === "cf") {
    const runtimeSubject = await lifecycleStub.getEnvironmentRuntimeSubject();
    if (
      !runtimeSubject
      || runtimeSubject.envSlug !== args.slug
      || runtimeSubject.incarnationId !== args.meta.incarnationId
    ) {
      throw new Error("Cloudflare Stop no longer matches the active environment runtime.");
    }
    stopScope = {
      envSlug: runtimeSubject.envSlug,
      incarnationId: runtimeSubject.incarnationId,
      startOperationId: runtimeSubject.startOperationId,
      stopOperationId: args.stopOpId,
    };
  }

  const scheduleCloudflareTermination = async (scope: EnvironmentStopScope) => {
    if (!args.backend.schedulePreparedStop) {
      throw new Error("Cloudflare runner backend cannot schedule prepared termination.");
    }
    const termination = await args.backend.schedulePreparedStop(args.meta, scope);
    if (termination.status === "already-stopped") {
      await lifecycleStub.noteRunnerStopped(args.stopOpId, null);
    }
    await (args.projectSummary?.() ?? projectAndPersistEnvSummary(args.env, args.hub, args.slug))
      .catch((error) => {
        console.warn(
          `[envs] Failed to project prepared Stop for ${args.slug}; lifecycle remains authoritative:`,
          error,
        );
      });
  };

  if (stopScope) {
    const lifecycle = await lifecycleStub.getState();
    if (
      lifecycle?.activeOpId === args.stopOpId
      && lifecycle.activeOperation === "stop"
      && lifecycle.desiredState === "stopped"
      && lifecycle.lastWorkspaceSyncedAckOpId === args.stopOpId
    ) {
      await scheduleCloudflareTermination(stopScope);
      return;
    }
  }

  const runnerCommand = args.meta.backend === "host"
    ? await lifecycleStub.claimRunnerCommand(args.stopOpId, "stopped")
    : undefined;
  let stopDispatch: Awaited<ReturnType<RunnerBackend["stop"]>>;
  try {
    const dispatch = (command = runnerCommand) => args.backend.stop(args.meta, {
      stopOpId: args.stopOpId,
      ...(stopScope ? { stopScope } : {}),
      ...(args.idleClaimId ? { idleClaimId: args.idleClaimId } : {}),
      ...(command ? { runnerCommand: command } : {}),
    });
    stopDispatch = runnerCommand
      ? await runRunnerMutationWithGenerationReconciliation(
          runnerCommand,
          (rejectedCommand, currentCommandGeneration) => lifecycleStub.rebaseRejectedRunnerCommand({
            rejectedCommand,
            currentCommandGeneration,
          }),
          dispatch,
        )
      : await dispatch();
  } catch (error) {
    const controlErrorCode = getRunnerControlErrorCode(error);
    if (
      controlErrorCode === "runner_command_superseded"
      || controlErrorCode === "runner_command_superseded_before_mutation"
    ) return;
    throw error;
  }
  if (stopScope) {
    if (stopDispatch.workspacePreparationUnavailable) {
      await lifecycleStub.noteWorkspacePreparationUnavailable(
        args.stopOpId,
        "Cloudflare runner stopped before producing a durable workspace receipt.",
      );
      await (args.projectSummary?.() ?? projectAndPersistEnvSummary(args.env, args.hub, args.slug))
        .catch((error) => {
          console.warn(
            `[envs] Failed to project unavailable workspace preparation for ${args.slug}; lifecycle remains authoritative:`,
            error,
          );
        });
      return;
    }
    const receipt = stopDispatch.workspaceStopReceipt;
    if (
      !receipt
      || receipt.envSlug !== stopScope.envSlug
      || receipt.incarnationId !== stopScope.incarnationId
      || receipt.startOperationId !== stopScope.startOperationId
      || receipt.stopOperationId !== stopScope.stopOperationId
      || Number.isNaN(new Date(receipt.workspaceLastSyncedAt).getTime())
    ) {
      throw new Error("Cloudflare runner returned a malformed or mismatched workspace receipt.");
    }
    // This is a lifecycle-owned continuation of a previously authorized Stop,
    // so classify against Tiller's tracked repository snapshot. Rechecking the
    // live GitHub App selection here would turn a transient GitHub outage into
    // a workspace-save failure after the sandbox has already produced proof.
    const loadedRepo = await loadTrackedRepo(args.env, args.meta.repoId);
    if (!loadedRepo.ok) {
      throw new Error(
        typeof loadedRepo.body.error === "string"
          ? loadedRepo.body.error
          : "Repository metadata is unavailable for workspace finalization.",
      );
    }
    const classified = await buildWorkspaceSyncedPatch(
      args.env,
      args.meta,
      { workspaceLastSyncedAt: receipt.workspaceLastSyncedAt },
      async () => loadedRepo,
    );
    if (!classified.ok) {
      throw new Error(
        typeof classified.body.error === "string"
          ? classified.body.error
          : "Workspace finalization metadata is unavailable.",
      );
    }
    const acknowledgement = await lifecycleStub.acceptStopWorkspaceSynced(
      args.stopOpId,
      buildEnvScmMetaPatch(args.meta, classified.patch),
    );
    if (!acknowledgement.accepted) {
      throw new Error("Workspace receipt no longer matches the active Stop operation.");
    }
    await scheduleCloudflareTermination(stopScope);
    return;
  }
  if (!stopDispatch.callbackExpected) {
    // The owner can also prove no workspace effect when lifecycle Start never
    // reached runner dispatch. Post-dispatch absence remains unsafe unless
    // The machine runner supplies its exact entrypoint-fence proof.
    const finalizedAbsentScheduledStart = await lifecycleStub.noteFencedRunnerAbsentBeforeScheduledStart(
      args.stopOpId,
      stopDispatch.startRejectedBeforeWorkspace === true,
    );
    if (!finalizedAbsentScheduledStart) {
      await lifecycleStub.noteRunnerStopped(
        args.stopOpId,
        "exit",
      );
    }
    await (args.projectSummary?.() ?? projectAndPersistEnvSummary(args.env, args.hub, args.slug));
    await lifecycleStub.clearStopWorkspaceSyncedMeta();
  }
}

const ACTIVE_ENV_REVIEW_STATUSES = new Set([
  "syncing",
  "preparing",
  "queued",
  "running",
  "saving",
]);

async function stopEnvReviewWorkloads(
  env: Env,
  slug: string,
  message: string,
): Promise<void> {
  const review = getEnvReviewStub(env, slug);

  // A workload can become terminal between the summary read and getRun, and
  // cancellation can race a runtime callback. Re-read once so either owner can
  // finish exact-runtime cleanup without leaving Stop/Delete permanently
  // blocked on retained provenance.
  for (let pass = 0; pass < 2; pass += 1) {
    const workloads = await review.listWorkloadStateForPredeploy();
    const blocking = workloads.filter(
      (workload) =>
        workload.hasRuntime || ACTIVE_ENV_REVIEW_STATUSES.has(workload.status),
    );
    if (blocking.length === 0) return;

    const runs = await Promise.all(
      blocking.map(async (workload) => {
        const run = await review.getRun(workload.runId);
        if (!run || run.envSlug !== slug) {
          throw new Error(
            `Environment review ${workload.runId} could not be stopped.`,
          );
        }
        return run;
      }),
    );
    const activeRuns = runs.filter((run) =>
      ACTIVE_ENV_REVIEW_STATUSES.has(run.status),
    );
    const skillInvocationIds = new Set(
      activeRuns
        .map((run) => run.skillInvocationId)
        .filter((invocationId): invocationId is string => Boolean(invocationId)),
    );
    await Promise.all([
      ...[...skillInvocationIds].map((invocationId) =>
        review.cancelSkillInvocation(invocationId),
      ),
      ...activeRuns
        .filter((run) => !run.skillInvocationId)
        .map((run) => review.cancelRun(run.runId, message)),
    ]);

    const currentRuns = await Promise.all(
      runs.map(async (run) => {
        if (!ACTIVE_ENV_REVIEW_STATUSES.has(run.status)) return run;
        const cancelled = await review.getRun(run.runId);
        if (!cancelled || cancelled.envSlug !== slug) {
          throw new Error(
            `Environment review ${run.runId} could not be cancelled.`,
          );
        }
        return cancelled;
      }),
    );
    await Promise.all(
      currentRuns.map((run) => run.runtime
        ? cleanupEnvReviewRunRuntime(env, review, run)
        : Promise.resolve()),
    );
  }

  const retained = (await review.listWorkloadStateForPredeploy()).find(
    (workload) =>
      workload.hasRuntime || ACTIVE_ENV_REVIEW_STATUSES.has(workload.status),
  );
  if (retained) {
    throw new Error(`Environment review ${retained.runId} is still stopping.`);
  }
}

export async function stopEnvAction(args: {
  env: Env;
  executionCtx: WaitUntilExecutionContext;
  slug: string;
  intent?: "ordinary" | "scheduled";
  requestedOutcome?: "completed" | "interrupted";
  expectedStartOpId?: string;
  expectedStopOpId?: string;
  idleClaimId?: string | null;
  lifecycleStub?: ReturnType<typeof getEnvLifecycleStub>;
  cachedMeta?: EnvMeta;
  expectedIncarnationId?: string;
  /** Alarm-owned effects await Cloudflare's full durable-stop handshake. */
  awaitRunnerDispatch?: boolean;
}): Promise<RouteResult> {
  const { env, slug } = args;
  const storedMeta = args.cachedMeta ?? await loadEnvView(env, slug);
  if (!storedMeta) return { status: 404, body: { error: "Not found" } };
  const lifecycleStub = args.lifecycleStub ?? getEnvLifecycleStub(env, slug);
  const projectSummary = () => args.lifecycleStub
    ? lifecycleStub.persistOwnedProjection()
    : projectAndPersistEnvSummary(env, getHub(env), slug);
  if (await lifecycleStub.isInitialCreationPending()) {
    return { status: 409, body: { error: "Environment creation is still in progress.", code: "environment_creation_in_progress" } };
  }
  if (storedMeta.scmOperationType) {
    return {
      status: 409,
      body: { error: `Environment has an active SCM operation (${storedMeta.scmOperationType}). Wait for it to finish before stopping.` },
    };
  }
  const stopReviewWorkloadsForCurrentEnv = async (): Promise<RouteResult | null> => {
    try {
      await stopEnvReviewWorkloads(
        env,
        slug,
        "Reviewer run cancelled because the environment was stopped.",
      );
      return null;
    } catch (error) {
      console.warn(
        `[envs] Failed to stop environment review workloads before stopping ${slug}:`,
        actionErrorMessage(error),
      );
      return {
        status: 409,
        body: {
          error: "Environment review cleanup must finish before stopping the environment.",
          code: "environment_stop_blocked",
        },
      };
    }
  };

  const resumedStopLifecycle = args.expectedStopOpId
    ? await lifecycleStub.resumeStopRetry(args.expectedStopOpId)
    : null;
  if (args.expectedStopOpId && !resumedStopLifecycle) {
    return {
      status: 409,
      body: {
        error: "The Stop retry no longer matches the active persistence operation.",
        code: "stale_stop_operation",
      },
    };
  }

  const scheduledRecord = await lifecycleStub.getScheduledRun();
  if (args.intent === "scheduled" && scheduledRecord?.kind === "finished") {
    if (
      args.expectedIncarnationId
      && scheduledRecord.incarnationId !== args.expectedIncarnationId
    ) {
      return {
        status: 409,
        body: { error: "The Scheduled Run belongs to a replaced environment incarnation." },
        scheduledRunTransitionApplied: true,
      };
    }
    const completed = await lifecycleStub.requestScheduledRunOutcome({
      ...(args.expectedStartOpId ? { opId: args.expectedStartOpId } : {}),
      outcome: args.requestedOutcome ?? "interrupted",
    });
    if (completed.status === "rejected") {
      return {
        status: 409,
        body: { error: completed.error },
        scheduledRunTransitionApplied: true,
      };
    }
    return {
      status: 200,
      body: { ok: true, slug, status: "stopped" },
      scheduledRunTransitionApplied: true,
    };
  }
  if (args.intent === "scheduled" && scheduledRecord?.kind !== "active") {
    return {
      status: 409,
      body: { error: "No active Scheduled Run was found." },
      scheduledRunTransitionApplied: true,
    };
  }
  const scheduledStop = scheduledRecord?.kind === "active";
  if (
    args.expectedIncarnationId
    && (!scheduledStop || scheduledRecord.incarnationId !== args.expectedIncarnationId)
  ) {
    return {
      status: 409,
      body: { error: "The Scheduled Run belongs to a replaced environment incarnation." },
      scheduledRunTransitionApplied: true,
    };
  }
  let scheduledClaim: Awaited<ReturnType<typeof lifecycleStub.requestScheduledRunOutcome>> | null = null;
  if (scheduledStop) {
    const requestedOutcome = args.intent === "scheduled"
      ? (args.requestedOutcome ?? "interrupted")
      : (scheduledRecord.requestedOutcome ?? "interrupted");
    scheduledClaim = await lifecycleStub.requestScheduledRunOutcome({
      ...(args.expectedStartOpId ? { opId: args.expectedStartOpId } : {}),
      outcome: requestedOutcome,
    });
    if (scheduledClaim.status === "rejected") {
      return {
        status: 409,
        body: { error: scheduledClaim.error },
        scheduledRunTransitionApplied: true,
      };
    }
    if (scheduledClaim.preparationInFlight) {
      await projectSummary().catch(() => null);
      return {
        status: 200,
        body: { ok: true, slug, status: "stopping" },
        ...(scheduledClaim.lifecycle?.activeOpId
          ? { operationId: scheduledClaim.lifecycle.activeOpId }
          : {}),
        scheduledRunTransitionApplied: true,
      };
    }
  }

  const hub = getHub(env);
  const backendKind = storedMeta.backend;
  const ownedMeta = (await lifecycleStub.getOwnedEnvView()) ?? storedMeta;
  if (ownedMeta.scmOperationType) {
    return {
      status: 409,
      body: { error: `Environment has an active SCM operation (${ownedMeta.scmOperationType}). Wait for it to finish before stopping.` },
      ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
    };
  }
  let currentLifecycle = resumedStopLifecycle ?? await lifecycleStub.getState();
  let existingLifecycle = scheduledClaim?.lifecycle
    ?? resumedStopLifecycle
    ?? (currentLifecycle && isLifecycleStopInProgress(currentLifecycle) ? currentLifecycle : null);
  if (
    !existingLifecycle
    && currentLifecycle?.phase === "failed"
    && currentLifecycle.activeOperation === "stop"
    && currentLifecycle.desiredState === "stopped"
    && currentLifecycle.activeOpId
  ) {
    currentLifecycle = await lifecycleStub.resumeStopRetry(currentLifecycle.activeOpId);
    existingLifecycle = currentLifecycle;
  }
  const hostUnavailable = await requireHostConnection(
    env,
    backendKind,
    ownedMeta.executionPlacement?.backend === "host"
      ? ownedMeta.executionPlacement.machineId
      : null,
  );
  if (hostUnavailable) {
    const canClaimStop = scheduledStop
      || ownedMeta.status === "running"
      || ownedMeta.status === "starting";
    if (!canClaimStop && !existingLifecycle?.activeOpId) {
      return {
        status: 409,
        body: { error: "Environment is not currently running." },
        ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
      };
    }
    const reviewStopFailure = await stopReviewWorkloadsForCurrentEnv();
    if (reviewStopFailure) {
      return {
        ...reviewStopFailure,
        ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
      };
    }
    const lifecycle = existingLifecycle ?? await lifecycleStub.requestStop();
    const stopOpId = lifecycle?.activeOpId;
    if (!stopOpId) return { status: 500, body: { error: "Stop operation did not return an operation id." } };
    let credentialCleanupComplete: boolean | undefined;
    if (!scheduledStop) {
      credentialCleanupComplete = (await cleanupLaunchCredentialsBestEffort(env, slug)).complete;
    }
    const failure = projectRuntimeFailure(
      "runner_control_failed",
      hostUnavailable,
      { slug, opId: stopOpId, source: "stop-host-unavailable" },
    );
    await lifecycleStub.noteStopDispatchFailed(stopOpId, failure.message);
    if (scheduledStop) {
      await lifecycleStub.recordScheduledRunnerUncertainty({ stopOpId, error: failure.message });
    }
    await projectSummary().catch((error) => {
      console.error(`[envs] Failed to project unavailable-runner Stop for ${slug}:`, error);
      return null;
    });
    return {
      status: 200,
      body: { ok: true, slug, status: "saving" },
      operationId: stopOpId,
      ...(credentialCleanupComplete == null ? {} : { credentialCleanupComplete }),
      ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
      runnerUncertain: true,
    };
  }
  const backend = await getRunnerBackend(env, backendKind);
  const { meta, liveStatus } = args.lifecycleStub
    ? {
        meta: ownedMeta,
        liveStatus: normalizeRunnerStatus((await inspectRunnerBackend(backend, ownedMeta)).status),
      }
    : await projectEnvMetaForAction(env, ownedMeta, backend);

  if (!existingLifecycle && isLifecycleStopInProgress(meta)) {
    existingLifecycle = args.lifecycleStub ? await lifecycleStub.getState() : await readLifecycleState(env, meta);
  }
  const canAttemptStop = scheduledStop
    || liveStatus === "running"
    || meta.status === "running"
    || meta.status === "starting";
  if (!canAttemptStop && !existingLifecycle?.activeOpId) {
    return { status: 409, body: { error: "Environment is not currently running." } };
  }
  const reviewStopFailure = await stopReviewWorkloadsForCurrentEnv();
  if (reviewStopFailure) {
    return {
      ...reviewStopFailure,
      ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
    };
  }

  const lifecycle = existingLifecycle ?? await lifecycleStub.requestStop();
  const stopOpId = lifecycle.activeOpId;
  if (!stopOpId) return { status: 500, body: { error: "Stop operation did not return an operation id." } };
  let credentialCleanupComplete: boolean | undefined;
  if (!scheduledStop) {
    credentialCleanupComplete = (await cleanupLaunchCredentialsBestEffort(env, slug)).complete;
  }
  const savingMeta = await projectSummary();
  if (!savingMeta) return { status: 404, body: { error: "Environment state not found" } };

  const dispatchStop = async () => {
    try {
      await dispatchStopAndFinalizeIfNoCallback({
        env,
        slug,
        backend,
        meta: savingMeta,
        hub,
        stopOpId,
        idleClaimId: args.idleClaimId,
        lifecycleStub,
        projectSummary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[envs] Failed to stop runner for ${slug}:`, message);
      const failure = projectRuntimeFailure(
        "runner_control_failed",
        message,
        { slug, opId: stopOpId, source: "stop-dispatch" },
      );
      if (scheduledStop) {
        await lifecycleStub.recordScheduledRunnerUncertainty({ stopOpId, error: failure.message });
      }
      await lifecycleStub.noteStopDispatchFailed(stopOpId, failure.message);
      await projectSummary().catch(() => null);
    }
  };

  if (backendKind === "cf" && !args.awaitRunnerDispatch) {
    const queued = await lifecycleStub.ensureStopDispatchScheduled(stopOpId);
    if (!queued) {
      console.warn(`[envs] Cloudflare Stop dispatch was superseded before it could be queued: ${JSON.stringify({
        slug,
        stopOpId,
      })}`);
    }
  } else if (args.awaitRunnerDispatch) {
    await dispatchStop();
  } else {
    args.executionCtx.waitUntil(dispatchStop());
  }

  return {
    status: 200,
    body: { ok: true, slug, status: savingMeta.status ?? "saving" },
    operationId: stopOpId,
    ...(credentialCleanupComplete == null ? {} : { credentialCleanupComplete }),
    ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
  };
}

export async function createEnvAction(args: {
  env: Env;
  executionCtx: WaitUntilExecutionContext;
  request: Request;
  requestUrl: string;
  repoId: string;
  requestedSlug?: string;
  harness: EnvHarness;
  harnessSettings?: unknown;
  planSelection?: unknown;
  schedule?: { runAtMs: number; timeZone: string };
}): Promise<RouteResult> {
  const {
    env,
    request,
    requestUrl,
    repoId,
    requestedSlug,
    harness,
    harnessSettings: submittedHarnessSettings,
    planSelection,
    schedule,
  } = args;
  let placement;
  try {
    placement = await resolveNewExecutionPlacement(env);
  } catch {
    return {
      status: 409,
      body: {
        error: NEW_EXECUTION_UNAVAILABLE_MESSAGE,
        code: "selected_execution_backend_unavailable",
      },
    };
  }
  const backendKind = placement.backend;
  const hostService = backendKind === "host"
    ? await readRoutableHostService(env, placement.machineId)
    : null;
  if (
    backendKind === "host"
    && (!hostService || hostService.machineId !== placement.machineId)
  ) {
    return {
      status: 409,
      body: {
        error: NEW_EXECUTION_UNAVAILABLE_MESSAGE,
        code: "selected_execution_backend_unavailable",
      },
    };
  }
  if (!isHarnessEnabled(env, harness)) {
    return { status: 400, body: { error: `Harness not enabled: ${harness}` } };
  }
  let harnessSettings: HarnessSettings;
  try {
    harnessSettings = resolveHarnessSettings(harness, submittedHarnessSettings);
  } catch (error) {
    return { status: 400, body: { error: error instanceof Error ? error.message : "Invalid harnessSettings" } };
  }
  if (schedule) {
    if (harness !== "codex") {
      return {
        status: 400,
        body: { error: "Scheduled Runs require the Codex harness." },
      };
    }
    try {
      await resolveOrdinaryStartAuthClaim(env, harness, harnessSettings);
    } catch (error) {
      return { status: 400, body: { error: actionErrorMessage(error) } };
    }
  }
  const refreshedRepo = await refreshGitHubDefaultBranchHeadForRequest(env, request, repoId);
  if (refreshedRepo.failureKind || !refreshedRepo.repo) {
    return requiredGitHubRepoRefreshFailureResult(refreshedRepo);
  }
  const repo = refreshedRepo.repo;
  const slug = requestedSlug
    ? requestedSlug
    : await findAvailableSlug(env, repo.meta.repoUrl, backendKind);
  if (await envSlugReserved(env, slug)) {
    return { status: 409, body: { error: "Environment already exists", slug } };
  }
  const createdAt = new Date().toISOString();
  const incarnationId = `env-${crypto.randomUUID()}`;
  let meta: EnvMeta = {
    slug,
    incarnationId,
    repoUrl: repo.meta.repoUrl,
    repoId: repo.meta.repoId,
    backend: backendKind,
    executionPlacement: placement,
    runnerId: backendKind === "cf" ? slug : undefined,
    harness,
    harnessSettings,
    createdAt,
    updatedAt: createdAt,
    status: "creating",
    implementorAttentionToken: null,
    ...createInitialEnvScmState({
      slug,
      incarnationId,
      githubBaseBranch: repo.meta.githubDefaultBranch ?? null,
      githubBaseCommitSha: repo.meta.githubDefaultBranchHeadSha ?? null,
    }),
  };
  let backend: RunnerBackend;
  try {
    backend = await getRunnerBackend(env, backendKind);
    if (backend.inspect) {
      const inspection = await backend.inspect(meta);
      if (inspection.state !== "absent") {
        return {
          status: inspection.state === "unknown" ? 503 : 409,
          body: {
            error: inspection.state === "unknown"
              ? "The environment runtime state could not be confirmed. The existing runner was left untouched."
              : "A runner with this environment name still exists. It was left untouched.",
            code: inspection.state === "unknown"
              ? "runtime_state_unknown"
              : "runtime_already_exists",
          },
        };
      }
    }
  } catch (error) {
    console.error(`[envs] Failed to inspect runner before Create for ${slug}:`, actionErrorMessage(error));
    return {
      status: 503,
      body: {
        error: "The environment runtime state could not be confirmed. The existing runner was left untouched.",
        code: "runtime_state_unknown",
      },
    };
  }
  const artifactStore = getArtifactStoreStub(
    env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  const startupPlanSelection = planSelection === undefined
    ? { mode: "none" } as const
    : parseStartupPlanSelection(planSelection);
  if (!startupPlanSelection) {
    return {
      status: 400,
      body: {
        error: "planSelection must select todo, none, or a specific plan artifact.",
        code: "invalid_plan_selection",
      },
    };
  }
  if (schedule && startupPlanSelection.mode !== "specific") {
    return { status: 400, body: { error: "Scheduled Runs require a specific startup plan." } };
  }
  let selectedPlan: Awaited<ReturnType<typeof resolveSelectedPlanArtifact>>;
  try {
    selectedPlan = await resolveSelectedPlanArtifact(
      repo,
      artifactStore,
      meta,
      meta.githubBaseCommitSha,
      startupPlanSelection,
    );
  } catch (error) {
    return {
      status: 409,
      body: { error: error instanceof Error ? error.message : "Failed to resolve startup plan artifact" },
    };
  }

  const claimSidebarSlot = async (): Promise<string | null> => {
    await ensureRepoEnvironmentSidebarSlots(env, repo.meta.repoId);
    const claimId = `sidebar-slot-${crypto.randomUUID()}`;
    const claim = await artifactStore.claimEnvironmentSidebarSlot({
      slug,
      claimId,
      createdAt,
    });
    if (claim.status === "conflict") return null;
    meta = { ...meta, sidebarSlot: claim.slot };
    return claimId;
  };

  const releaseSidebarSlotClaim = async (claimId: string) => {
    try {
      await artifactStore.releaseEnvironmentSidebarSlotClaim(slug, claimId);
    } catch (error) {
      console.warn(`[envs] Failed to release sidebar slot claim for ${slug}:`, error);
    }
  };

  const commitSidebarSlotClaim = async (claimId: string) => {
    let committed = false;
    try {
      committed = await artifactStore.commitEnvironmentSidebarSlot(slug, claimId);
    } catch (error) {
      console.warn(`[envs] Failed to commit sidebar slot claim for ${slug}:`, error);
    }
    if (!committed) {
      console.warn(`[envs] Sidebar slot claim was not committed for ${slug}; reconciliation will retry.`);
    }
  };

  let sidebarSlotClaimId: string | null;
  try {
    sidebarSlotClaimId = await claimSidebarSlot();
  } catch (error) {
    return projectedRuntimeFailureResult(
      "runtime_start_failed",
      error,
      { slug, source: schedule ? "scheduled-create-sidebar-slot" : "create-sidebar-slot" },
    ).result;
  }
  if (!sidebarSlotClaimId) {
    return { status: 409, body: { error: "Environment already exists", slug } };
  }

  const sidebarSlot = meta.sidebarSlot!;
  const renderedPlanDocument = renderResolvedStartupPlanDocument(selectedPlan);
  const startupPlanVersion = selectedPlan?.version ?? 1;
  meta = {
    ...meta,
    startupPlanId: selectedPlan?.id ?? null,
    displayName: deriveEnvDisplayName(selectedPlan, sidebarSlot),
  };

  if (schedule) {
    if (!selectedPlan || !renderedPlanDocument) {
      await releaseSidebarSlotClaim(sidebarSlotClaimId);
      return { status: 409, body: { error: "The selected startup plan could not be rendered." } };
    }
    meta = { ...meta, status: "stopped", updatedAt: new Date().toISOString() };
    const incarnationId = meta.incarnationId!;
    const definition = { ...buildEnvDefinition(meta), incarnationId };
    const lifecycleStub = getEnvLifecycleStub(env, slug);
    let initialization: Awaited<ReturnType<typeof lifecycleStub.initializeStoppedEnvironment>>;
    try {
      initialization = await lifecycleStub.initializeStoppedEnvironment(
        definition,
        buildMutableStateFromMeta(meta),
        {
          incarnationId,
          schedule: {
            runAtMs: schedule.runAtMs,
            timeZone: schedule.timeZone,
            localDevOrigin: isLocalDevRequest(env, request)
              ? new URL(requestUrl).origin
              : null,
          },
          plan: {
            artifactId: selectedPlan.id,
            version: startupPlanVersion,
            renderedPlanDocument,
          },
        },
      );
    } catch (error) {
      await releaseSidebarSlotClaim(sidebarSlotClaimId);
      return projectedRuntimeFailureResult(
        "runtime_start_failed",
        error,
        { slug, source: "scheduled-create-initialize" },
      ).result;
    }
    if (!initialization.created) {
      await releaseSidebarSlotClaim(sidebarSlotClaimId);
      return { status: 409, body: { error: "Environment already exists", slug } };
    }
    try {
      if (!(await lifecycleStub.publishStoppedInitialization(initialization.claimId, definition))) {
        throw new Error("Scheduled environment creation ownership was lost before publish.");
      }
    } catch (error) {
      await lifecycleStub.rollbackStoppedInitialization(initialization.claimId).catch((rollbackError) => {
        // Rollback retains its lifecycle-owned incarnation fence until the
        // unconditional KV deletes settle, then clears canonical DO state even
        // when best-effort cleanup reports a failure.
        console.error(`[envs] Scheduled environment KV rollback was incomplete for ${slug}:`, rollbackError);
        return false;
      });
      await releaseSidebarSlotClaim(sidebarSlotClaimId);
      return projectedRuntimeFailureResult(
        "runtime_start_failed",
        error,
        { slug, source: "scheduled-create-publish" },
      ).result;
    }

    let commitError: unknown = null;
    try {
      if (!(await lifecycleStub.commitStoppedInitialization(initialization.claimId))) {
        throw new Error("Scheduled environment creation ownership was lost before commit.");
      }
    } catch (error) {
      commitError = error;
      try {
        // The commit RPC is idempotent. A retry reconciles the important case
        // where Durable Object storage committed but the first response was lost.
        if (await lifecycleStub.commitStoppedInitialization(initialization.claimId)) {
          commitError = null;
        }
      } catch (retryError) {
        console.error(`[envs] Failed to reconcile scheduled creation commit for ${slug}:`, retryError);
      }
    }
    if (commitError) {
      console.error(`[envs] Scheduled environment ${slug} publication commit was not confirmed:`, commitError);
      return projectedRuntimeFailureResult(
        "runtime_start_failed",
        commitError,
        { slug, source: "scheduled-create-commit" },
      ).result;
    }
    await commitSidebarSlotClaim(sidebarSlotClaimId);
    await lifecycleStub.persistOwnedProjection().catch((error) => {
      console.error(`[envs] Failed to publish scheduled environment projection for ${slug}:`, error);
    });
    return {
      status: 201,
      body: projectEnvSummary({
        ...meta,
        scheduledRun: {
          state: "scheduled",
          runAtMs: schedule.runAtMs,
          timeZone: schedule.timeZone,
        },
      }),
    };
  }

  const lifecycleStub = getEnvLifecycleStub(env, slug);
  let ordinaryStartAuthClaim: EnvironmentStartAuthClaim;
  try {
    ordinaryStartAuthClaim = await resolveOrdinaryStartAuthClaim(env, harness, harnessSettings);
  } catch (error) {
    await releaseSidebarSlotClaim(sidebarSlotClaimId);
    return { status: 400, body: { error: actionErrorMessage(error) } };
  }
  let startClaim: Awaited<ReturnType<typeof lifecycleStub.initializeAndBeginStart>>;
  try {
    startClaim = await lifecycleStub.initializeAndBeginStart(
      buildEnvDefinition(meta),
      buildMutableStateFromMeta(meta),
      harnessSettings,
      ordinaryStartAuthClaim,
    );
  } catch (err) {
    await releaseSidebarSlotClaim(sidebarSlotClaimId);
    return projectedRuntimeFailureResult(
      "runtime_start_failed",
      err,
      { slug, source: "create-initialize" },
    ).result;
  }
  if (!startClaim.dispatchGranted || !startClaim.lifecycle?.activeOpId || !startClaim.harnessSettings) {
    await releaseSidebarSlotClaim(sidebarSlotClaimId);
    return { status: 409, body: { error: "Environment already exists", slug } };
  }
  await commitSidebarSlotClaim(sidebarSlotClaimId);

  const claimedStart: ClaimedStartContext = {
    opId: startClaim.lifecycle.activeOpId,
    harnessSettings: startClaim.harnessSettings,
    authClaim: {
      claudeAuthMode: startClaim.claudeAuthMode ?? null,
      codexAuthPreference: startClaim.codexAuthPreference ?? null,
    },
  };
  const startOpId = claimedStart.opId;
  meta = { ...meta, harnessSettings: claimedStart.harnessSettings };
  const hub = getHub(env);
  const workspaceStub = getWorkspaceStub(env, slug);
  let launchConfig: Awaited<ReturnType<typeof buildContainerLaunchConfig>>;
  let persistedMeta: Awaited<ReturnType<typeof projectAndPersistEnvSummary>>;
  try {
    await lifecycleStub.beginStartupDiagnostics({
      opId: startOpId,
      backend: backendKind,
      implementationMode: selectedPlan ? "plan" : "fresh",
      stepId: "workspace-sync",
      message: "Preparing workspace start...",
    });
    await workspaceStub.destroyWorkspace();
  } catch (err) {
    const message = actionErrorMessage(err);
    const projected = projectedRuntimeFailureResult(
      "workspace_hydration_failed",
      message,
      { slug, opId: startOpId, source: "create-workspace-reset" },
    );
    await lifecycleStub.reportStartupFailure({
      opId: startOpId,
      stepId: "workspace-sync",
      message: projected.failure.message,
    });
    await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);
    return projected.result;
  }
  try {
    launchConfig = await buildContainerLaunchConfig(env, requestUrl, slug, repo.meta.repoUrl, repo.meta, meta, {
      startOpId,
      startAuthClaim: claimedStart.authClaim,
    });
  } catch (err) {
    await cleanupLaunchCredentialsBestEffort(env, slug);
    const message = actionErrorMessage(err);
    await lifecycleStub.reportStartupFailure({ opId: startOpId, stepId: "harness-launch", message });
    await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);
    return { status: 400, body: { error: message } };
  }
  try {
    meta = { ...meta, ...launchConfig.meta };
    await materializeStartupPlanDocument(workspaceStub, renderedPlanDocument);
    meta = {
      ...meta,
      bootMessage: `GitHub base ${meta.githubBaseCommitSha?.slice(0, 12) ?? "unknown"}`,
    };
    await persistEnvDefinition(env, buildEnvDefinition(meta));
    await lifecycleStub.clearLeadHarnessState({ opId: startOpId });
    persistedMeta = await projectAndPersistEnvSummary(env, hub, slug);
  } catch (err) {
    await cleanupLaunchCredentialsBestEffort(env, slug);
    const message = err instanceof Error ? err.message : String(err);
    await workspaceStub.destroyWorkspace().catch(() => {});
    const projected = projectedRuntimeFailureResult(
      "workspace_hydration_failed",
      message,
      { slug, opId: startOpId, source: "create-workspace-state" },
    );
    await lifecycleStub.reportStartupFailure({
      opId: startOpId,
      stepId: "workspace-sync",
      message: projected.failure.message,
    });
    await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);
    return projected.result;
  }
  if (!persistedMeta) {
    await cleanupLaunchCredentialsBestEffort(env, slug);
    const projected = projectedRuntimeFailureResult(
      "workspace_hydration_failed",
      "Failed to project initialized environment state",
      { slug, opId: startOpId, source: "create-project-state" },
      500,
    );
    await lifecycleStub.reportStartupFailure({
      opId: startOpId,
      stepId: "workspace-sync",
      message: projected.failure.message,
    });
    return projected.result;
  }

  let createRunnerCommand: Awaited<ReturnType<typeof lifecycleStub.claimRunnerCommand>> | undefined;
  try {
    if (backendKind === "host") {
      createRunnerCommand = await lifecycleStub.claimRunnerCommand(startOpId, "running");
    }
  } catch (error) {
    const message = `Failed to claim runner create command: ${actionErrorMessage(error)}`;
    const projected = projectedRuntimeFailureResult(
      "runner_control_failed",
      message,
      { slug, opId: startOpId, source: "create-runner-command" },
    );
    await cleanupLaunchCredentialsBestEffort(env, slug);
    await lifecycleStub.reportStartupFailure({
      opId: startOpId,
      stepId: "harness-launch",
      message: projected.failure.message,
    });
    return projected.result;
  }

  args.executionCtx.waitUntil(
    (async () => {
      try {
        const create = (command = createRunnerCommand) => backend.create({
          ...persistedMeta,
          harnessSettings: claimedStart.harnessSettings,
        }, launchConfig.envVars, {
          startOpId,
          ...(command ? { runnerCommand: command } : {}),
        });
        const updated = createRunnerCommand
          ? await runRunnerMutationWithGenerationReconciliation(
              createRunnerCommand,
              (rejectedCommand, currentCommandGeneration) => lifecycleStub.rebaseRejectedRunnerCommand({
                rejectedCommand,
                currentCommandGeneration,
              }),
              create,
            )
          : await create();
        const stillExists = await envExists(env, slug);
        if (!stillExists) {
          try {
            const deletion = await lifecycleStub.beginDelete();
            if (deletion.allowed) {
              if (updated.backend === "host") {
                await runRunnerMutationWithGenerationReconciliation(
                  deletion.runnerCommand,
                  (rejectedCommand, currentCommandGeneration) => lifecycleStub.rebaseRejectedRunnerCommand({
                    rejectedCommand,
                    currentCommandGeneration,
                  }),
                  (runnerCommand) => backend.destroy(updated, { runnerCommand }),
                );
              } else {
                await backend.destroy(updated);
              }
              await lifecycleStub.finalizeDeletion();
            }
          } catch { /* best effort */ }
          await cleanupLaunchCredentialsBestEffort(env, slug);
          return;
        }
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          opId: startOpId,
        });
        await projectAndPersistEnvSummary(env, hub, slug);
      } catch (err) {
        const detail = redactEnvValues(err instanceof Error ? err.message : String(err), launchConfig.envVars);
        console.error(`[envs] Failed to create runner for ${slug}:`, detail);
        const failure = projectRuntimeFailure(
          backendKind === "cf" && isCloudflareContainerAllocationTimeout(err)
            ? "runtime_start_failed"
            : "runner_control_failed",
          detail,
          { slug, opId: startOpId, source: "runner-create" },
        );
        await cleanupLaunchCredentialsBestEffort(env, slug);
        await getEnvLifecycleStub(env, slug).reportStartupFailure({
          opId: startOpId,
          stepId: "harness-launch",
          message: failure.message,
          runnerMayExist: true,
        });
        await projectAndPersistEnvSummary(env, hub, slug);
      }
    })(),
  );

  return { status: 201, body: projectEnvSummary(persistedMeta) };
}

export async function startEnvAction(args: {
  env: Env;
  executionCtx: WaitUntilExecutionContext;
  request: Request;
  requestUrl: string;
  slug: string;
  harnessSettings?: unknown;
  implementationMode?: "fresh" | "plan";
  intent?: EnvStartCause;
  schedulerDeadlineAtMs?: number;
  expectedIncarnationId?: string;
  lifecycleStub?: ReturnType<typeof getEnvLifecycleStub>;
  cachedMeta?: EnvMeta;
}): Promise<RouteResult> {
  const {
    env,
    request,
    requestUrl,
    slug,
    harnessSettings: submittedHarnessSettings,
    implementationMode,
  } = args;
  const lifecycleStub = args.lifecycleStub ?? getEnvLifecycleStub(env, slug);
  const projectSummary = () => args.lifecycleStub
    ? lifecycleStub.persistOwnedProjection()
    : projectAndPersistEnvSummary(env, getHub(env), slug);
  const startIntent: EnvStartCause = args.intent ?? "ordinary";
  if (await lifecycleStub.isInitialCreationPending()) {
    return {
      status: 409,
      body: { error: "Environment creation is still in progress.", code: "environment_creation_in_progress" },
      ...(startIntent === "scheduled" ? { retryDisposition: "retry-pre-start" as const } : {}),
    };
  }
  const cachedMeta = args.cachedMeta ?? await loadEnvView(env, slug);
  if (!cachedMeta) return { status: 404, body: { error: "Not found" } };
  if (startIntent === "ordinary") {
    const guard = await lifecycleStub.preparePublicStart();
    if (guard.action === "blocked") {
      return { status: 409, body: { error: guard.error, code: "scheduled_run_active" } };
    }
  }

  let scheduledAttempt = startIntent === "scheduled"
    ? await lifecycleStub.beginScheduledRunAttempt(args.expectedIncarnationId)
    : null;
  const scheduledPlan = scheduledAttempt?.plan
    ?? (startIntent === "ordinary" ? await lifecycleStub.getImmutablePlan() : null);
  const schedulerDeadlineAtMs = args.schedulerDeadlineAtMs
    ?? scheduledAttempt?.schedule.deadlineAtMs
    ?? null;
  const failScheduledPreStart = async (
    status: number,
    body: Record<string, unknown>,
    retryable: boolean,
    capacityDenied = false,
  ): Promise<RouteResult> => {
    if (scheduledAttempt) {
      await lifecycleStub.recordScheduledPreStartFailure({
        attemptId: scheduledAttempt.attemptId,
        error: typeof body.error === "string" ? body.error : "Scheduled Run preparation failed.",
        retryable,
        capacityDenied,
      });
    }
    return {
      status,
      body,
      retryDisposition: retryable ? "retry-pre-start" : "terminal",
      scheduledRunTransitionApplied: true,
    };
  };
  const storedMeta = cachedMeta;
  let projectedMeta = storedMeta;
  if (!storedMeta.executionPlacement) {
    const body = {
      error: "This workload was created by an unsupported version and cannot be run. Delete and recreate it.",
      code: "legacy_workload_record",
    };
    return startIntent === "scheduled"
      ? failScheduledPreStart(409, body, false)
      : { status: 409, body };
  }
  const backendKind = storedMeta.backend;
  const hostGate = await requireRoutableHostService({
    env,
    backendKind,
    preferredMachineId: storedMeta.executionPlacement.machineId,
  });
  if (!hostGate.ok) {
    const code = typeof (hostGate.result.body as { code?: unknown } | null)?.code === "string"
      ? (hostGate.result.body as { code: string }).code
      : null;
    return startIntent === "scheduled"
      ? failScheduledPreStart(
          hostGate.result.status,
          hostGate.result.body as Record<string, unknown>,
          code !== "host_runtime_update_required",
        )
      : hostGate.result;
  }
  let backend: RunnerBackend;
  try {
    backend = await getRunnerBackend(env, backendKind);
  } catch (error) {
    const body = {
      error: "The environment runtime could not be inspected. The existing runner was left untouched.",
      code: "runtime_inspection_failed",
    };
    console.error(`[envs] Failed to construct runner backend for ${slug}:`, actionErrorMessage(error));
    return startIntent === "scheduled"
      ? failScheduledPreStart(503, body, true)
      : { status: 503, body };
  }
  const inspection = await inspectRunnerBackend(backend, storedMeta);
  const [initialLifecycleBeforeStart, runnerCommandBeforeStart] = await Promise.all([
    lifecycleStub.getState().catch((error) => {
      console.error(`[envs] Failed to read lifecycle before Start for ${slug}:`, actionErrorMessage(error));
      return null;
    }),
    lifecycleStub.getRunnerCommandClaim().catch((error) => {
      console.error(`[envs] Failed to read runner command before Start for ${slug}:`, actionErrorMessage(error));
      return null;
    }),
  ]);
  let lifecycleBeforeStart = initialLifecycleBeforeStart;
  const rejectUnsafeInspection = (
    error: string,
    code: string,
  ): Promise<RouteResult> | RouteResult => {
    const body = { error, code };
    return startIntent === "scheduled"
      ? failScheduledPreStart(409, body, true)
      : { status: 409, body };
  };
  if (inspection.state === "live") {
    return rejectUnsafeInspection(
      "An existing runner is still active. Stop it and wait for workspace saving to finish before starting again.",
      "runtime_still_active",
    );
  }
  if (inspection.state === "unknown" || (!lifecycleBeforeStart && backend.inspect)) {
    return rejectUnsafeInspection(
      "The environment runtime state could not be confirmed. The existing runner was left untouched.",
      "runtime_state_unknown",
    );
  }
  if (inspection.state === "stopped") {
    const safeFailedStart = Boolean(
      inspection.safeReplacement?.reason === "failed_before_harness"
      && lifecycleBeforeStart?.phase === "failed"
      && lifecycleBeforeStart.activeOperation === "start"
      && lifecycleBeforeStart.desiredState === "running"
      && lifecycleBeforeStart.activeOpId === inspection.safeReplacement.operationId
      && runnerCommandBeforeStart?.operationId === inspection.safeReplacement.operationId
      && runnerCommandBeforeStart.commandGeneration === inspection.safeReplacement.commandGeneration
      && runnerCommandBeforeStart.desiredState === "running",
    );
    const acknowledgedStop = lifecycleBeforeStart?.activeOperation === "stop"
      && lifecycleBeforeStart.activeOpId != null
      && lifecycleBeforeStart.lastWorkspaceSyncedAckOpId === lifecycleBeforeStart.activeOpId;
    const safeStoppedRunner = lifecycleBeforeStart == null
      ? !backend.inspect
      : lifecycleBeforeStart.phase === "stopped" || acknowledgedStop || safeFailedStart;
    if (!safeStoppedRunner) {
      return rejectUnsafeInspection(
        "The previous runner is stopped, but its workspace save was not acknowledged. It was left untouched.",
        "runtime_persistence_unconfirmed",
      );
    }
    if (!safeFailedStart && lifecycleBeforeStart?.phase !== "stopped" && lifecycleBeforeStart?.activeOpId) {
      await lifecycleStub.noteRunnerStopped(
        lifecycleBeforeStart.activeOpId,
        "confirmed stopped during Start inspection",
      );
      projectedMeta = (await projectSummary()) ?? projectedMeta;
    }
  } else if (inspection.state === "absent") {
    if (
      lifecycleBeforeStart
      && (lifecycleBeforeStart.phase === "starting" || lifecycleBeforeStart.phase === "running")
      && lifecycleBeforeStart.activeOpId
    ) {
      await lifecycleStub.noteRunnerStopped(
        lifecycleBeforeStart.activeOpId,
        "confirmed absent during Start inspection",
      );
      lifecycleBeforeStart = await lifecycleStub.getState();
      projectedMeta = (await projectSummary()) ?? projectedMeta;
    }
    if (
      lifecycleBeforeStart
      && (
        isLifecycleStopInProgress(lifecycleBeforeStart)
        || lifecycleBeforeStart.phase === "failed"
      )
    ) {
      const reconciled = await lifecycleStub.confirmRunnerAbsentForRestart(
        lifecycleBeforeStart.activeOpId,
      );
      if (!reconciled) {
        return rejectUnsafeInspection(
          "The previous lifecycle operation changed during runtime inspection. Start was not dispatched.",
          "runtime_state_changed",
        );
      }
      projectedMeta = (await projectSummary()) ?? projectedMeta;
    }
  }
  if (isLifecycleStopInProgress(projectedMeta)) {
    const body = { error: getStopFinalizationInProgressError("starting") };
    return startIntent === "scheduled"
      ? failScheduledPreStart(409, body, true)
      : { status: 409, body };
  }
  const metaBeforeClaim = projectedMeta;
  const status = metaBeforeClaim.status ?? "unknown";
  if (status !== "stopped" && status !== "failed" && status !== "unknown") {
    const body = { error: "Environment must be stopped before starting again." };
    return startIntent === "scheduled"
      ? failScheduledPreStart(409, body, true)
      : { status: 409, body };
  }
  if (!isHarnessEnabled(env, metaBeforeClaim.harness)) {
    const body = { error: `Harness not enabled: ${metaBeforeClaim.harness}` };
    return startIntent === "scheduled"
      ? failScheduledPreStart(400, body, false)
      : { status: 400, body };
  }
  let harnessSettings: HarnessSettings;
  try {
    harnessSettings = resolveHarnessSettings(
      metaBeforeClaim.harness,
      submittedHarnessSettings,
      metaBeforeClaim.harnessSettings,
    );
  } catch (error) {
    const body = { error: error instanceof Error ? error.message : "Invalid harnessSettings" };
    return startIntent === "scheduled"
      ? failScheduledPreStart(400, body, false)
      : { status: 400, body };
  }
  if (startIntent === "ordinary" && implementationMode === "plan" && !metaBeforeClaim.startupPlanId) {
    return {
      status: 400,
      body: {
        error: "This environment does not have a saved plan to implement.",
        code: "startup_plan_missing",
      },
    };
  }
  const startupPlanSelection: StartupPlanSelection = startIntent === "scheduled"
    ? { mode: "specific", artifactId: scheduledPlan!.artifactId }
    : implementationMode === "fresh"
      ? { mode: "none" }
      : storedStartupPlanSelection(metaBeforeClaim.startupPlanId);
  if (startIntent === "scheduled" && schedulerDeadlineAtMs != null && Date.now() >= schedulerDeadlineAtMs) {
    return failScheduledPreStart(409, {
      error: "The Scheduled Run deadline passed before a runner could start.",
    }, false);
  }

  let startAuthClaim = EMPTY_START_AUTH_CLAIM;
  try {
    startAuthClaim = await resolveOrdinaryStartAuthClaim(
      env,
      metaBeforeClaim.harness,
      harnessSettings,
    );
  } catch (error) {
    const body = { error: actionErrorMessage(error) };
    return startIntent === "scheduled"
      ? failScheduledPreStart(400, body, false)
      : { status: 400, body };
  }
  let lifecycleStartClaim: Awaited<ReturnType<typeof lifecycleStub.beginStart>>;
  if (startIntent === "scheduled") {
    const pinnedHostMachineId = storedMeta.executionPlacement.machineId;
    if (backendKind === "host" && !pinnedHostMachineId) {
      return failScheduledPreStart(503, { error: EXISTING_EXECUTION_UNAVAILABLE_MESSAGE }, true);
    }
    await lifecycleStub.markScheduledCapacityAcquireUncertain(
      scheduledAttempt!.attemptId,
      "Scheduled Run capacity acquisition is being reconciled.",
    );
    let capacity: Awaited<ReturnType<ReturnType<typeof getScheduledRunCapacityStub>["acquire"]>>;
    try {
      capacity = await getScheduledRunCapacityStub(env).acquire({
        slug,
        attemptId: scheduledAttempt!.attemptId,
      });
    } catch (error) {
      await lifecycleStub.markScheduledCapacityAcquireUncertain(
        scheduledAttempt!.attemptId,
        actionErrorMessage(error),
      );
      return {
        status: 503,
        body: { error: "Scheduled Run capacity acquisition is being reconciled." },
        retryDisposition: "retry-pre-start",
        scheduledRunTransitionApplied: true,
      };
    }
    if (!capacity.acquired) {
      const error = capacity.reason === "capacity"
        ? "Scheduled Run capacity is full; this run will retry shortly."
        : "Scheduled Run capacity ownership conflicted with this attempt.";
      await lifecycleStub.recordScheduledPreStartFailure({
        attemptId: scheduledAttempt!.attemptId,
        error,
        retryable: capacity.reason === "capacity" || capacity.reason === "released",
        capacityDenied: capacity.reason === "capacity",
      });
      return {
        status: 409,
        body: { error, code: "scheduled_run_capacity" },
        retryDisposition: capacity.reason === "attempt-conflict" ? "terminal" : "retry-pre-start",
        scheduledRunTransitionApplied: true,
      };
    }
    if (!(await lifecycleStub.recordScheduledCapacityAcquired(scheduledAttempt!.attemptId))) {
      return {
        status: 409,
        body: { error: "Scheduled Run ownership changed while capacity was being acquired." },
        retryDisposition: "terminal",
        scheduledRunTransitionApplied: true,
      };
    }
    const revalidatedHost = await requireRoutableHostService({
      env,
      backendKind,
      preferredMachineId: pinnedHostMachineId,
    });
    if (
      !revalidatedHost.ok
      || (
        backendKind === "host"
        && revalidatedHost.hostService?.machineId !== pinnedHostMachineId
      )
    ) {
      return failScheduledPreStart(503, {
        error: "Scheduled Run eligibility changed while capacity was being acquired.",
      }, true);
    }
    const claimInput = {
      attemptId: scheduledAttempt!.attemptId,
      harnessSettings,
      hostMachineId: pinnedHostMachineId,
      authClaim: startAuthClaim,
    };
    try {
      lifecycleStartClaim = await lifecycleStub.claimScheduledRunStart(claimInput);
    } catch {
      lifecycleStartClaim = await lifecycleStub.claimScheduledRunStart(claimInput);
    }
  } else {
    lifecycleStartClaim = await lifecycleStub.beginStart(harnessSettings, startAuthClaim);
  }
  if (
    !lifecycleStartClaim.dispatchGranted
    || !lifecycleStartClaim.lifecycle?.activeOpId
    || !lifecycleStartClaim.harnessSettings
  ) {
    return {
      status: 409,
      body: { error: "Environment is not startable or another start already won ownership." },
      retryDisposition: startIntent === "ordinary" ? undefined : "terminal",
      ...(startIntent === "scheduled" ? { scheduledRunTransitionApplied: true } : {}),
    };
  }
  const claimedStart: ClaimedStartContext = {
    opId: lifecycleStartClaim.lifecycle.activeOpId,
    harnessSettings: lifecycleStartClaim.harnessSettings,
    authClaim: {
      claudeAuthMode: lifecycleStartClaim.claudeAuthMode ?? null,
      codexAuthPreference: lifecycleStartClaim.codexAuthPreference ?? null,
    },
  };
  const scheduledScope: ScheduledRunCredentialScope | null = startIntent === "scheduled"
    ? { incarnationId: scheduledAttempt!.schedule.incarnationId, startOpId: claimedStart.opId }
    : null;
  const hub = getHub(env);
  let preparationClaimedAtMs = startIntent === "ordinary"
    ? null
    : await lifecycleStub.beginScheduledRunPreparation(claimedStart.opId);
  if (startIntent === "scheduled" && preparationClaimedAtMs == null) {
    return {
      status: 202,
      body: { ok: true, slug, status: "starting" },
      operationId: claimedStart.opId,
      scheduledRunTransitionApplied: true,
    };
  }
  let preparationHeartbeat: ReturnType<typeof setInterval> | null = null;
  let preparationHeartbeatLost = false;
  let preparationEffectUnresolved = false;
  const stopPreparationHeartbeat = (): void => {
    if (preparationHeartbeat == null) return;
    clearInterval(preparationHeartbeat);
    preparationHeartbeat = null;
  };
  const renewPreparation = async (): Promise<boolean> => {
    if (startIntent === "ordinary") return true;
    if (preparationHeartbeatLost || preparationEffectUnresolved) return false;
    const claimedAtMs = preparationClaimedAtMs;
    if (claimedAtMs == null) return false;
    try {
      const renewed = await lifecycleStub.renewScheduledRunPreparation({
        opId: claimedStart.opId,
        claimedAtMs,
      });
      if (!renewed) {
        preparationClaimedAtMs = null;
        stopPreparationHeartbeat();
      }
      return renewed;
    } catch (error) {
      console.warn(`[envs] Failed to renew Scheduled Run preparation for ${slug}:`, actionErrorMessage(error));
      preparationHeartbeatLost = true;
      stopPreparationHeartbeat();
      return false;
    }
  };
  if (preparationClaimedAtMs != null) {
    preparationHeartbeat = setInterval(() => { void renewPreparation(); }, SCHEDULED_RUN_PREPARATION_HEARTBEAT_MS);
  }
  const runPreparationEffect = async <T>(effect: () => Promise<T>): Promise<T> => {
    if (startIntent === "ordinary") return effect();
    const claimedAtMs = preparationClaimedAtMs;
    if (claimedAtMs == null || !(await renewPreparation())) {
      throw new Error("Scheduled Run preparation ownership was superseded before an external effect.");
    }
    const effectClaim = { opId: claimedStart.opId, claimedAtMs };
    let effectOwned: boolean;
    try {
      effectOwned = await lifecycleStub.beginScheduledRunPreparationEffect(effectClaim);
    } catch {
      effectOwned = await lifecycleStub.beginScheduledRunPreparationEffect(effectClaim);
    }
    if (!effectOwned) throw new Error("Scheduled Run preparation ownership was superseded before an external effect.");
    let value: T | undefined;
    let effectError: unknown;
    try { value = await effect(); } catch (error) { effectError = error; }
    let settled: boolean;
    try {
      settled = await lifecycleStub.finishScheduledRunPreparationEffect(effectClaim);
    } catch {
      settled = await lifecycleStub.finishScheduledRunPreparationEffect(effectClaim);
    }
    if (!settled) {
      preparationEffectUnresolved = true;
      effectError ??= new Error("Scheduled Run preparation effect acknowledgement was lost.");
    }
    if (effectError != null) throw effectError;
    return value as T;
  };
  const finishPreparation = async (): Promise<void> => {
    stopPreparationHeartbeat();
    const claimedAtMs = preparationClaimedAtMs;
    if (claimedAtMs == null || preparationEffectUnresolved) return;
    if (await lifecycleStub.finishScheduledRunPreparation({ opId: claimedStart.opId, claimedAtMs })) {
      preparationClaimedAtMs = null;
    }
  };
  const finishPreparationBestEffort = async (): Promise<void> => {
    try { await finishPreparation(); }
    catch (error) { console.error(`[envs] Failed to release Scheduled Run preparation for ${slug}:`, actionErrorMessage(error)); }
  };
  let claimedStartCredentialsMayExist = false;
  const cleanupScheduledCredentials = async (): Promise<{ complete: boolean }> => {
    if (!scheduledScope) return cleanupLaunchCredentialsBestEffort(env, slug);
    const record = await lifecycleStub.getScheduledRun();
    const ids = record?.kind === "active" && record.startOpId === claimedStart.opId
      ? record.credentialIds
      : {};
    return cleanupLaunchCredentialsBestEffort(env, slug, { scope: scheduledScope, ids });
  };
  const failClaimedStart = async (
    responseStatus: number,
    body: Record<string, unknown>,
    stepId: "workspace-sync" | "harness-launch" = "workspace-sync",
    credentialCleanupComplete?: boolean,
  ): Promise<RouteResult> => {
    const rawMessage = typeof body.error === "string" ? body.error : "Environment startup failed";
    const failure = responseStatus >= 500 && !isProjectedRuntimeFailure(rawMessage)
      ? projectRuntimeFailure(
          stepId === "workspace-sync" ? "workspace_hydration_failed" : "runtime_start_failed",
          rawMessage,
          { slug, opId: claimedStart.opId, source: "start-preparation" },
        )
      : null;
    const message = failure?.message ?? rawMessage;
    const publicBody = failure
      ? { ...body, error: failure.message, code: failure.code, referenceId: failure.referenceId }
      : body;
    stopPreparationHeartbeat();
    await lifecycleStub.reportStartupFailure({ opId: claimedStart.opId, stepId, message });
    await finishPreparationBestEffort();
    await projectSummary().catch(() => null);
    if (startIntent === "scheduled" && credentialCleanupComplete != null) {
      if (credentialCleanupComplete) await lifecycleStub.recordScheduledRunCredentialsCleaned(claimedStart.opId);
      else await lifecycleStub.recordScheduledRunCredentialCleanupPending(claimedStart.opId);
    }
    return {
      status: responseStatus,
      body: publicBody,
      operationId: claimedStart.opId,
      ...(credentialCleanupComplete == null ? {} : { credentialCleanupComplete }),
      retryDisposition: "terminal",
      ...(startIntent === "scheduled" ? { scheduledRunTransitionApplied: true } : {}),
    };
  };
  const abortSupersededStart = async (): Promise<RouteResult> => {
    const cleanup = claimedStartCredentialsMayExist ? await cleanupScheduledCredentials() : null;
    if (startIntent === "scheduled" && cleanup) {
      if (cleanup.complete) await lifecycleStub.recordScheduledRunCredentialsCleaned(claimedStart.opId);
      else await lifecycleStub.recordScheduledRunCredentialCleanupPending(claimedStart.opId);
    }
    await finishPreparationBestEffort();
    return {
      status: 409,
      body: { error: "The environment start was superseded before runner dispatch." },
      operationId: claimedStart.opId,
      ...(cleanup ? { credentialCleanupComplete: cleanup.complete } : {}),
      retryDisposition: "terminal",
      ...(startIntent === "scheduled" ? { scheduledRunTransitionApplied: true } : {}),
    };
  };
  const abortIfClaimWasSuperseded = async (): Promise<RouteResult | null> => {
    if (!(await renewPreparation())) return abortSupersededStart();
    const mutable = await lifecycleStub.getMutableState();
    return isDispatchableMutableStart(mutable, claimedStart.opId) ? null : abortSupersededStart();
  };
  try {
    await lifecycleStub.beginStartupDiagnostics({
      opId: claimedStart.opId,
      backend: backendKind,
      implementationMode: startupPlanSelection.mode === "none" ? "fresh" : "plan",
      stepId: "workspace-sync",
      message: "Preparing workspace start...",
    });
  } catch (error) {
    return failClaimedStart(502, { error: `Failed to initialize startup diagnostics: ${actionErrorMessage(error)}` });
  }
  {
    const superseded = await abortIfClaimWasSuperseded();
    if (superseded) return superseded;
  }

  let meta: EnvMeta;
  try {
    ({ meta } = args.lifecycleStub
      ? {
          meta: (await lifecycleStub.getOwnedEnvView()) ?? metaBeforeClaim,
        }
      : await projectEnvMetaForAction(env, metaBeforeClaim, backend));
    meta = { ...meta, harnessSettings: claimedStart.harnessSettings };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failClaimedStart(
      502,
      { error: `Failed to inspect environment runtime: ${message}` },
      "workspace-sync",
    );
  }
  {
    const superseded = await abortIfClaimWasSuperseded();
    if (superseded) return superseded;
  }
  let launchConfig: Awaited<ReturnType<typeof buildContainerLaunchConfig>>;
  let repo: RepoWorkspace;
  let repoRefresh: GitHubDefaultBranchRefreshResult | null = null;
  try {
    if (meta.scmModel === "github") {
      repoRefresh = await refreshGitHubDefaultBranchHeadForRequest(env, request, meta.repoId);
      if (!repoRefresh.repo) {
        const failure = requiredGitHubRepoRefreshFailureResult(repoRefresh);
        return failClaimedStart(failure.status, failure.body as Record<string, unknown>);
      }
      repo = repoRefresh.repo;
    } else {
      const loadedRepo = await readValidatedRepoContext(env, {
        request,
        repoId: meta.repoId,
      });
      if (!loadedRepo.ok) return failClaimedStart(loadedRepo.status, loadedRepo.body as Record<string, unknown>);
      repo = loadedRepo.repo;
    }
  } catch (error) {
    return failClaimedStart(502, { error: `Failed to load repository state: ${actionErrorMessage(error)}` });
  }
  {
    const superseded = await abortIfClaimWasSuperseded();
    if (superseded) return superseded;
  }
  if (meta.scmModel === "github" && !meta.githubBaseCommitSha) {
    return failClaimedStart(409, {
        error: "Environment is missing its GitHub base commit. Reset or recreate the environment.",
        code: "github_env_base_missing",
      });
  }
  let syncedMeta = withDerivedBranchBackedEnvStatus(meta, repo.meta);
  const workspaceStub = getWorkspaceStub(env, slug);
  const artifactStore = getArtifactStoreStub(
    env,
    repo.meta.repoId,
    repo.meta.artifactStoreGeneration,
  );
  let implementationPlanId: string | null;
  if (meta.scmModel === "github") {
    let overlayEmpty = false;
    try {
      overlayEmpty = await isGitHubDraftOverlayEmpty(workspaceStub, {
        excludePrefixes: TREE_HASH_EXCLUDES,
      });
    } catch (error) {
      console.warn(
        `[envs] Failed to inspect GitHub draft overlay for ${slug}; launching from stored base:`,
        error instanceof Error ? error.message : String(error),
      );
    }
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    const advanceDecision = getGitHubStartBaseAdvanceDecision({
      meta,
      repo: repo.meta,
      startable: status === "stopped" || status === "failed" || status === "unknown",
      overlayEmpty,
      refreshFailureKind: repoRefresh?.failureKind ?? null,
      refreshError: repoRefresh?.error,
      refreshCode: repoRefresh?.code,
      refreshStatus: repoRefresh?.status,
    });
    if (advanceDecision.action === "block") {
      return failClaimedStart(advanceDecision.status, {
          error: advanceDecision.error,
          code: advanceDecision.code,
        });
    }
    if (advanceDecision.action === "advance") {
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      const advancedAt = new Date().toISOString();
      syncedMeta = withDerivedBranchBackedEnvStatus(
        {
          ...clearEnvError(syncedMeta),
          workspaceDirty: false,
          workspaceNeedsAttention: false,
          workspaceLastSyncedAt: advancedAt,
          baseMainCommit: advanceDecision.baseCommitSha,
          lastKnownMainCommit: advanceDecision.baseCommitSha,
          githubBaseBranch: advanceDecision.baseBranch,
          githubBaseCommitSha: advanceDecision.baseCommitSha,
          githubHeadCommitSha: null,
          branchStatus: "up-to-date",
        },
        repo.meta,
      );
      try {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
        await lifecycleStub.recordStopWorkspaceSynced(
          buildEnvScmMetaPatch(syncedMeta),
          { clearError: true, opId: claimedStart.opId },
        );
      } catch (error) {
        return failClaimedStart(502, { error: `Failed to advance the workspace base: ${actionErrorMessage(error)}` });
      }
    }
  }
  let canonicalVisibleFileCount: number | null;
  try {
    canonicalVisibleFileCount = await readCanonicalVisibleWorkspaceFileCount(workspaceStub);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failClaimedStart(502, { error: `Failed to inspect workspace: ${message}` });
  }
  {
    const superseded = await abortIfClaimWasSuperseded();
    if (superseded) return superseded;
  }
  if (canonicalVisibleFileCount === 0 && meta.scmModel !== "github") {
    try {
      const canonicalTar = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      await runPreparationEffect(() => workspaceStub.restoreFromTar(canonicalTar, {
        clearFirst: true,
        preservePrefixes: TREE_HASH_EXCLUDES,
      }));
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      const bootstrappedAt = new Date().toISOString();
      syncedMeta = withDerivedBranchBackedEnvStatus(
        {
          ...clearEnvError(syncedMeta),
          workspaceDirty: false,
          workspaceNeedsAttention: false,
          workspaceLastSyncedAt: bootstrappedAt,
          baseMainCommit: repo.meta.mainCommit ?? null,
          lastKnownMainCommit: repo.meta.mainCommit ?? null,
          branchStatus: "up-to-date",
        },
        repo.meta,
      );
      await lifecycleStub.recordStopWorkspaceSynced(
        buildEnvScmMetaPatch(syncedMeta),
        { clearError: true, opId: claimedStart.opId },
      );
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      await runPreparationEffect(() => persistEnvDefinition(env, buildEnvDefinition(syncedMeta)));
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      console.info(`[envs] empty workspace bootstrapped from main for ${slug} at ${repo.meta.mainCommit ?? "unknown"}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[envs] Failed to bootstrap empty workspace for ${slug}:`, message);
      return failClaimedStart(502, { error: `Failed to bootstrap workspace from canonical main: ${message}` });
    }
  }

  try {
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    if (startIntent === "scheduled") {
      if (
        preparationClaimedAtMs == null
        || !(await lifecycleStub.markScheduledRunCredentialsMayExist(
          claimedStart.opId,
          preparationClaimedAtMs,
        ))
      ) {
        return abortSupersededStart();
      }
      claimedStartCredentialsMayExist = true;
    } else {
      // Launch-config construction may mint credentials before it returns or
      // throws, so cleanup owns the whole interval rather than only success.
      claimedStartCredentialsMayExist = true;
    }
    launchConfig = await runPreparationEffect(() => buildContainerLaunchConfig(env, requestUrl, slug, repo.meta.repoUrl, repo.meta, syncedMeta, {
      startCause: startIntent,
      startOpId: claimedStart.opId,
      startAuthClaim: claimedStart.authClaim,
      ...(scheduledScope ? { credentialScope: scheduledScope } : {}),
    }));
    if (startIntent === "scheduled") {
      await lifecycleStub.recordScheduledRunCredentialIds(
        claimedStart.opId,
        launchConfig.credentials,
      );
    }
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    implementationPlanId = scheduledPlan?.artifactId ?? await resolveSelectedPlanId(
        repo,
        artifactStore,
        syncedMeta,
        syncedMeta.githubBaseCommitSha,
        startupPlanSelection,
      );
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
  } catch (err) {
    const cleanup = await cleanupScheduledCredentials();
    const message = err instanceof Error ? err.message : String(err);
    return failClaimedStart(
      400,
      { error: message },
      "harness-launch",
      cleanup.complete,
    );
  }

  const planMeta: EnvMeta = {
    ...syncedMeta,
    // The plan association belongs to the environment and survives a fresh
    // interactive start. implementationPlanId only controls whether this run
    // receives the automatic implementation prompt.
    startupPlanId: scheduledPlan?.artifactId
      ?? metaBeforeClaim.startupPlanId
      ?? syncedMeta.startupPlanId
      ?? null,
    branchStatus: deriveBranchBackedEnvStatus(
      syncedMeta,
      repo.meta,
    ),
  };
  try {
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    if (planMeta.scmModel === "github") {
      const startupPlanDocument = scheduledPlan
        ? scheduledPlan.renderedPlanDocument
        : await resolveStartupPlanDocument(
            repo,
            artifactStore,
            planMeta,
            planMeta.githubBaseCommitSha,
            implementationPlanId
              ? { mode: "specific", artifactId: implementationPlanId }
              : { mode: "none" },
          );
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      await runPreparationEffect(() => materializeStartupPlanDocument(
        workspaceStub,
        withStartCausePreamble(startupPlanDocument, startIntent),
      ));
    } else {
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      if (scheduledPlan) {
        await runPreparationEffect(() => workspaceStub.writeWorkspaceFile(
          "/.tiller/plan.md",
          withStartCausePreamble(scheduledPlan.renderedPlanDocument, startIntent)!,
        ));
      } else {
        await runPreparationEffect(() => materializeStartupPlan(
          repo,
          artifactStore,
          workspaceStub,
          planMeta,
          repo.meta.mainCommit,
          implementationPlanId
            ? { mode: "specific", artifactId: implementationPlanId }
            : { mode: "none" },
        ));
      }
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
    }
  } catch (err) {
    const cleanup = await cleanupScheduledCredentials();
    const message = err instanceof Error ? err.message : String(err);
    return failClaimedStart(
      502,
      { error: `Failed to initialize startup plan: ${message}` },
      "workspace-sync",
      cleanup.complete,
    );
  }

  const claimedStartOpId = claimedStart.opId;

  let startingMeta: Awaited<ReturnType<typeof projectAndPersistEnvSummary>>;
  try {
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    await runPreparationEffect(() => persistEnvDefinition(env, buildEnvDefinition({
      ...clearEnvError(planMeta),
      ...launchConfig.meta,
    })));
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    await lifecycleStub.clearLeadHarnessState({ opId: claimedStartOpId });
    {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    }
    startingMeta = await projectSummary();
  } catch (err) {
    const cleanup = await cleanupScheduledCredentials();
    const message = err instanceof Error ? err.message : String(err);
    return failClaimedStart(
      502,
      { error: `Failed to prepare environment start: ${message}` },
      "workspace-sync",
      cleanup.complete,
    );
  }
  if (!startingMeta) {
    const cleanup = await cleanupScheduledCredentials();
    return failClaimedStart(
      404,
      { error: "Environment state not found" },
      "workspace-sync",
      cleanup.complete,
    );
  }

  let dispatchState: EnvMutableState | null;
  try {
    dispatchState = await lifecycleStub.getMutableState();
  } catch (error) {
    const cleanup = await cleanupScheduledCredentials();
    return failClaimedStart(
      502,
      { error: `Failed to confirm environment start ownership: ${actionErrorMessage(error)}` },
      "harness-launch",
      cleanup.complete,
    );
  }
  if (
    startIntent === "scheduled"
    && schedulerDeadlineAtMs != null
    && Date.now() >= schedulerDeadlineAtMs
  ) {
    // The lifecycle Start already exists, so the hard cap is an interruption,
    // not a startup failure. Lock the outcome first, then let the owner alarm
    // drive the normal fenced save-and-Stop path. Superseded-start cleanup
    // revokes any credentials without overwriting that locked outcome.
    await lifecycleStub.requestScheduledRunOutcome({
      opId: claimedStartOpId,
      outcome: "interrupted",
    });
    const interrupted = await abortSupersededStart();
    return {
      ...interrupted,
      body: { error: "The Scheduled Run deadline passed after launch ownership was claimed; partial work will be saved." },
    };
  }
  if (!isDispatchableMutableStart(dispatchState, claimedStartOpId)) {
    return abortSupersededStart();
  }

  let runnerCommand: Awaited<ReturnType<typeof lifecycleStub.claimRunnerCommand>> | undefined;
  try {
    if (backendKind === "host") {
      runnerCommand = await lifecycleStub.claimRunnerCommand(claimedStartOpId, "running");
    }
    if (startIntent === "scheduled") {
      const preparationOwned = preparationClaimedAtMs != null
        && await renewPreparation();
      if (!preparationOwned || preparationClaimedAtMs == null) {
        return abortSupersededStart();
      }
      const dispatchOwned = await lifecycleStub.markScheduledRunRunnerDispatch(
        claimedStartOpId,
        preparationClaimedAtMs,
      );
      if (!dispatchOwned) return abortSupersededStart();
      // Runner dispatch now owns the active Start fence. Workspace and
      // credential preparation is quiescent, so the broader lease can end.
      await finishPreparationBestEffort();
    }
  } catch (error) {
    try {
      const superseded = await abortIfClaimWasSuperseded();
      if (superseded) return superseded;
    } catch {
      // Preserve the original command-claim error when ownership cannot be
      // re-read. The owner alarm will reconcile an ambiguous response.
    }
    const cleanup = await cleanupScheduledCredentials();
    return failClaimedStart(
      502,
      { error: `Failed to claim runner command: ${actionErrorMessage(error)}` },
      "harness-launch",
      cleanup.complete,
    );
  }

  args.executionCtx.waitUntil(
    (async () => {
      try {
        const start = (command = runnerCommand) => backend.start({
          ...startingMeta,
        }, launchConfig.envVars, {
          startOpId: claimedStartOpId,
          ...(command ? { runnerCommand: command } : {}),
        });
        const updated = runnerCommand
          ? await runRunnerMutationWithGenerationReconciliation(
              runnerCommand,
              (rejectedCommand, currentCommandGeneration) => lifecycleStub.rebaseRejectedRunnerCommand({
                rejectedCommand,
                currentCommandGeneration,
              }),
              start,
            )
          : await start();
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          opId: claimedStartOpId,
        });
        await projectSummary();
      } catch (err) {
        const detail = redactEnvValues(err instanceof Error ? err.message : String(err), launchConfig.envVars);
        const controlErrorCode = getRunnerControlErrorCode(err);
        const rejectedBeforeMutation = controlErrorCode === "runner_command_superseded_before_mutation";
        console.error(`[envs] Failed to start runner for ${slug}:`, detail);
        if (
          rejectedBeforeMutation
          && startIntent === "scheduled"
          && await lifecycleStub.noteFencedScheduledStartRejectedBeforeMutation(claimedStartOpId)
        ) {
          await projectSummary().catch((projectionError) => {
            console.error(`[envs] Failed to project fenced Scheduled Run Start rejection for ${slug}:`, projectionError);
          });
          return;
        }
        const failureInput = {
          opId: claimedStartOpId,
          stepId: "harness-launch" as const,
          message: projectRuntimeFailure(
            backendKind === "cf" && isCloudflareContainerAllocationTimeout(err)
              ? "runtime_start_failed"
              : "runner_control_failed",
            detail,
            { slug, opId: claimedStartOpId, source: "runner-start" },
          ).message,
          runnerMayExist: !rejectedBeforeMutation,
        };
        let failedLifecycle: Awaited<ReturnType<typeof lifecycleStub.reportStartupFailure>>;
        try {
          failedLifecycle = await lifecycleStub.reportStartupFailure(failureInput);
        } catch (firstError) {
          try {
            // The exact-operation write is idempotent. Retry once so a lost
            // response cannot strand capacity and scoped credentials until
            // the hard cap even when the first transaction committed.
            failedLifecycle = await lifecycleStub.reportStartupFailure(failureInput);
          } catch (retryError) {
            console.error(
              `[envs] Failed to report runner start failure for ${slug}:`,
              retryError instanceof Error ? retryError.message : String(retryError),
              firstError,
            );
            return;
          }
        }
        if (
          failedLifecycle?.phase !== "failed"
          || failedLifecycle.activeOpId !== claimedStartOpId
          || failedLifecycle.desiredState !== "running"
        ) {
          // Matching runner readiness or a newer Stop/Delete won before the
          // delayed dispatch error. Never revoke slug-wide credentials from
          // the stale Start in that case.
          return;
        }
        const cleanup = await cleanupScheduledCredentials();
        if (startIntent === "scheduled") {
          if (cleanup.complete) await lifecycleStub.recordScheduledRunCredentialsCleaned(claimedStartOpId);
          else await lifecycleStub.recordScheduledRunCredentialCleanupPending(claimedStartOpId);
        }
        await projectSummary().catch((projectionError) => {
          console.error(`[envs] Failed to project runner start failure for ${slug}:`, projectionError);
        });
      } finally {
        await finishPreparationBestEffort();
      }
    })(),
  );

  return {
    status: 200,
    body: { ok: true, slug, status: "starting" },
    operationId: claimedStartOpId,
  };
}

export async function deleteEnvAction(args: {
  env: Env;
  executionCtx: WaitUntilExecutionContext;
  slug: string;
}): Promise<RouteResult> {
  const { env, slug } = args;
  const storedMeta = await loadEnvView(env, slug);
  if (!storedMeta) return { status: 404, body: { error: "Not found" } };
  const lifecycleStub = getEnvLifecycleStub(env, slug);
  if (await lifecycleStub.isInitialCreationPending()) {
    return { status: 409, body: { error: "Environment creation is still in progress.", code: "environment_creation_in_progress" } };
  }
  const projectedMeta = storedMeta;
  if (isLifecycleStopInProgress(projectedMeta)) {
    return {
      status: 409,
      body: { error: getStopFinalizationInProgressError("deleting the environment") },
    };
  }
  try {
    await stopEnvReviewWorkloads(
      env,
      slug,
      "Reviewer run cancelled because the environment was deleted.",
    );
  } catch (error) {
    console.warn(
      `[envs] Failed to stop environment review workloads before deleting ${slug}:`,
      actionErrorMessage(error),
    );
    return {
      status: 409,
      body: {
        error: "Environment review cleanup must finish before deleting the environment.",
        code: "environment_delete_blocked",
      },
    };
  }
  const activePublish = await lifecycleStub.getGitHubPublishOperation();
  if (activePublish || storedMeta.githubPublishStatus === "publishing" || storedMeta.githubPublishOperationId) {
    return {
      status: 409,
      body: {
        error: "Environment has an active GitHub publish. Wait for it to finish before deleting the environment.",
        code: "environment_delete_blocked",
      },
    };
  }
  const scheduledRun = await lifecycleStub.getScheduledRun();
  let deletingUnstartedSchedule = scheduledRun?.kind === "finished"
    && !scheduledRun.started
    && !scheduledRun.cleanupRequired;
  if (scheduledRun?.kind === "schedule") {
    const cancellation = await lifecycleStub.cancelScheduledRun();
    if (!cancellation.cancelled || cancellation.finalizing) {
      return {
        status: 409,
        body: {
          error: cancellation.error ?? "The Scheduled Run cancellation is still finalizing.",
          code: "scheduled_run_finalizing",
        },
      };
    }
    deletingUnstartedSchedule = true;
  } else if (
    !scheduledRun
    && storedMeta.status === "stopped"
    && !storedMeta.runnerId
    && storedMeta.executionPlacement.backend === "cf"
    && await lifecycleStub.getImmutablePlan()
  ) {
    // An uncertain pre-Start cancellation removes its public schedule only
    // after exact capacity release. Machine-backed deletion still requires
    // the assigned runner to confirm absence.
    deletingUnstartedSchedule = true;
  }
  const backendKind = storedMeta.backend;
  if (!deletingUnstartedSchedule || backendKind === "host") {
    const hostUnavailable = await requireHostConnection(
      env,
      backendKind,
      storedMeta.executionPlacement?.backend === "host"
        ? storedMeta.executionPlacement.machineId
        : null,
    );
    if (hostUnavailable) {
      return { status: 409, body: { error: hostUnavailable } };
    }
  }
  const meta = deletingUnstartedSchedule
    ? projectedMeta
    : (await projectEnvMetaForAction(
        env,
        projectedMeta,
        await getRunnerBackend(env, backendKind),
      )).meta;
  const loadedRepo = await loadTrackedRepo(env, meta.repoId);
  if (!loadedRepo.ok) {
    return { status: loadedRepo.status, body: loadedRepo.body };
  }
  const artifactStore = getArtifactStoreStub(
    env,
    meta.repoId,
    loadedRepo.repo.meta.artifactStoreGeneration,
  );
  const deleteClaim = await lifecycleStub.beginDelete();
  if (!deleteClaim.allowed) {
    return { status: 409, body: { error: deleteClaim.error, code: "scheduled_run_active" } };
  }
  const hub = getHub(env);
  await cleanupLaunchCredentialsBestEffort(env, slug);
  await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);

  args.executionCtx.waitUntil(
    (async () => {
      try {
        await destroyEnv(env, meta, hub, {
          runnerCommand: deleteClaim.runnerCommand,
          rebaseRunnerCommand: (rejectedCommand, currentCommandGeneration) =>
            lifecycleStub.rebaseRejectedRunnerCommand({
              rejectedCommand,
              currentCommandGeneration,
            }),
          skipRunnerDestroy: deletingUnstartedSchedule && backendKind !== "host",
        });
        try {
          await artifactStore.releaseEnvironmentSidebarSlot(slug);
        } catch (error) {
          console.warn(`[envs] Failed to release sidebar slot for deleted environment ${slug}:`, error);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to delete runner for ${slug}:`, message);
        await lifecycleStub.abortDelete(message);
        await projectAndPersistEnvSummary(env, hub, slug);
      }
    })(),
  );

  return {
    status: 200,
    body: { ok: true, slug, status: "deleting", message: "Environment deletion started" },
  };
}
