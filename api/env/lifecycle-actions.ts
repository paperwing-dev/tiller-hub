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
  renderResolvedStartupPlanDocument,
  resolveSpecificStartupPlanArtifact,
  resolveStartupPlanDocument,
  resolveSelectedPlanId,
  TREE_HASH_EXCLUDES,
  withStartCausePreamble,
  type EnvStartCause,
} from "./launch-config";
import { getRunnerControlErrorCode, type RunnerBackend, type RunnerBackendKind } from "./runner-backend";
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
  revokeCloudflareMcpProxyTokensForEnvBestEffort,
  revokeCloudflareMcpProxyTokensForStartBestEffort,
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

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function actionErrorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function isAmbiguousHostRunnerResponse(error: unknown): boolean {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const message = current instanceof Error ? current.message : "";
    if (/timed out waiting for the execution machine/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function withStartupPlanDocumentEnvVar(
  envVars: Record<string, string>,
  document: string | null,
): Record<string, string> {
  if (!document) return envVars;
  return {
    ...envVars,
    TILLER_STARTUP_PLAN_DOCUMENT_B64: base64Utf8(document),
  };
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
  hub = getHub(env),
  scheduled?: { scope: ScheduledRunCredentialScope; ids: ScheduledRunCredentialIds },
): Promise<{ complete: boolean }> {
  if (scheduled) {
    const exact = {
      envSlug: slug,
      incarnationId: scheduled.scope.incarnationId,
      startOpId: scheduled.scope.startOpId,
    };
    const results = await Promise.all([
      revokeGitHubBridgesForEnvironmentStart(env, exact).then(() => true).catch(() => false),
      revokeCloudflareMcpProxyTokensForStartBestEffort(hub, exact),
    ]);
    return { complete: results.every(Boolean) };
  }
  const results = await Promise.all([
    revokeGitHubBridgesForInteractiveEnv(env, slug).then(() => true).catch((error) => {
      console.error(`[envs] Failed to revoke GitHub launch credentials for ${slug}:`, error);
      return false;
    }),
    revokeCloudflareMcpProxyTokensForEnvBestEffort(hub, slug),
  ]);
  return { complete: results.every(Boolean) };
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
  lifecycleStub?: ReturnType<typeof getEnvLifecycleStub>;
  projectSummary?: () => Promise<EnvMeta | null>;
}): Promise<void> {
  const lifecycleStub = args.lifecycleStub ?? getEnvLifecycleStub(args.env, args.slug);
  const runnerCommand = args.meta.backend === "host"
    ? await lifecycleStub.claimRunnerCommand(args.stopOpId, "stopped")
    : undefined;
  let stopDispatch: Awaited<ReturnType<RunnerBackend["stop"]>>;
  try {
    stopDispatch = await args.backend.stop(args.meta, {
      stopOpId: args.stopOpId,
      ...(runnerCommand ? { runnerCommand } : {}),
    });
  } catch (error) {
    const controlErrorCode = getRunnerControlErrorCode(error);
    if (
      controlErrorCode === "runner_command_superseded"
      || controlErrorCode === "runner_command_superseded_before_mutation"
    ) return;
    throw error;
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

export async function stopEnvAction(args: {
  env: Env;
  executionCtx: ExecutionContext;
  slug: string;
  intent?: "ordinary" | "scheduled";
  requestedOutcome?: "completed" | "interrupted";
  expectedStartOpId?: string;
  lifecycleStub?: ReturnType<typeof getEnvLifecycleStub>;
  cachedMeta?: EnvMeta;
  expectedIncarnationId?: string;
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
  const hostUnavailable = await requireHostConnection(
    env,
    backendKind,
    storedMeta.executionPlacement?.backend === "host"
      ? storedMeta.executionPlacement.machineId
      : null,
  );
  if (hostUnavailable) {
    const stopOpId = scheduledClaim?.lifecycle?.activeOpId;
    if (scheduledStop && stopOpId) {
      await lifecycleStub.recordScheduledRunnerUncertainty({ stopOpId, error: hostUnavailable });
    }
    return {
      status: 409,
      body: { error: hostUnavailable },
      ...(scheduledStop ? { scheduledRunTransitionApplied: true, runnerUncertain: true } : {}),
    };
  }
  const backend = await getRunnerBackend(env, backendKind);
  const { meta, liveStatus } = args.lifecycleStub
    ? {
        meta: (await lifecycleStub.getOwnedEnvView()) ?? storedMeta,
        liveStatus: normalizeRunnerStatus(await backend.getStatus(storedMeta).catch(() => "unknown")),
      }
    : await projectEnvMetaForAction(env, storedMeta, backend);
  if (meta.scmOperationType) {
    return {
      status: 409,
      body: { error: `Environment has an active SCM operation (${meta.scmOperationType}). Wait for it to finish before stopping.` },
      ...(scheduledStop ? { scheduledRunTransitionApplied: true } : {}),
    };
  }

  const existingLifecycle = scheduledClaim?.lifecycle
    ?? (isLifecycleStopInProgress(meta)
      ? args.lifecycleStub ? await lifecycleStub.getState() : await readLifecycleState(env, meta)
      : null);
  const canAttemptStop = scheduledStop
    || liveStatus === "running"
    || meta.status === "running"
    || meta.status === "starting";
  if (!canAttemptStop && !existingLifecycle?.activeOpId) {
    return { status: 409, body: { error: "Environment is not currently running." } };
  }

  const lifecycle = existingLifecycle ?? await lifecycleStub.requestStop();
  const stopOpId = lifecycle.activeOpId;
  if (!stopOpId) return { status: 500, body: { error: "Stop operation did not return an operation id." } };
  let credentialCleanupComplete: boolean | undefined;
  if (!scheduledStop) {
    credentialCleanupComplete = (await cleanupLaunchCredentialsBestEffort(env, slug, hub)).complete;
  }
  const savingMeta = await projectSummary();
  if (!savingMeta) return { status: 404, body: { error: "Environment state not found" } };

  args.executionCtx.waitUntil((async () => {
    try {
      await dispatchStopAndFinalizeIfNoCallback({
        env,
        slug,
        backend,
        meta: savingMeta,
        hub,
        stopOpId,
        lifecycleStub,
        projectSummary,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[envs] Failed to stop runner for ${slug}:`, message);
      if (scheduledStop) {
        await lifecycleStub.recordScheduledRunnerUncertainty({ stopOpId, error: message });
        await projectSummary().catch(() => null);
        return;
      }
      if (backendKind === "host" && isAmbiguousHostRunnerResponse(err)) return;
      await lifecycleStub.noteStopDispatchFailed(stopOpId, message);
      await projectSummary();
    }
  })());

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
  executionCtx: ExecutionContext;
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
  let meta: EnvMeta = {
    slug,
    incarnationId: `env-${crypto.randomUUID()}`,
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
    ...createInitialEnvScmState({
      slug,
      githubBaseBranch: repo.meta.githubDefaultBranch ?? null,
      githubBaseCommitSha: repo.meta.githubDefaultBranchHeadSha ?? null,
    }),
  };
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
  try {
    meta = {
      ...meta,
      startupPlanId: await resolveSelectedPlanId(
        repo,
        artifactStore,
        meta,
        meta.githubBaseCommitSha,
        startupPlanSelection,
      ),
    };
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

  if (schedule) {
    let selectedPlan: Awaited<ReturnType<typeof resolveSpecificStartupPlanArtifact>>;
    let renderedPlanDocument: string | null;
    try {
      selectedPlan = await resolveSpecificStartupPlanArtifact(
        artifactStore,
        meta.startupPlanId!,
      );
      renderedPlanDocument = renderResolvedStartupPlanDocument(selectedPlan);
    } catch (error) {
      return {
        status: 409,
        body: { error: error instanceof Error ? error.message : "Failed to capture the selected startup plan." },
      };
    }
    if (!renderedPlanDocument) {
      return { status: 409, body: { error: "The selected startup plan could not be rendered." } };
    }
    let sidebarSlotClaimId: string | null;
    try {
      sidebarSlotClaimId = await claimSidebarSlot();
    } catch (error) {
      return { status: 502, body: { error: `Failed to allocate environment sidebar slot: ${actionErrorMessage(error)}` } };
    }
    if (!sidebarSlotClaimId) {
      return { status: 409, body: { error: "Environment already exists", slug } };
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
            version: selectedPlan.version ?? 1,
            renderedPlanDocument,
          },
        },
      );
    } catch (error) {
      await releaseSidebarSlotClaim(sidebarSlotClaimId);
      return {
        status: 502,
        body: { error: `Failed to initialize scheduled environment: ${actionErrorMessage(error)}` },
      };
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
      return {
        status: 502,
        body: { error: `Failed to publish scheduled environment: ${actionErrorMessage(error)}` },
      };
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
      return {
        status: 502,
        body: { error: `Failed to confirm scheduled environment creation: ${actionErrorMessage(commitError)}` },
      };
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

  let sidebarSlotClaimId: string | null;
  try {
    sidebarSlotClaimId = await claimSidebarSlot();
  } catch (error) {
    return { status: 502, body: { error: `Failed to allocate environment sidebar slot: ${actionErrorMessage(error)}` } };
  }
  if (!sidebarSlotClaimId) {
    return { status: 409, body: { error: "Environment already exists", slug } };
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
    const message = err instanceof Error ? err.message : String(err);
    return { status: 502, body: { error: `Failed to initialize environment state: ${message}` } };
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
  let backend: RunnerBackend;
  let persistedMeta: Awaited<ReturnType<typeof projectAndPersistEnvSummary>>;
  try {
    await lifecycleStub.beginStartupDiagnostics({
      opId: startOpId,
      backend: backendKind,
      stepId: "workspace-sync",
      message: "Preparing workspace start...",
    });
    await workspaceStub.destroyWorkspace();
  } catch (err) {
    const message = actionErrorMessage(err);
    await lifecycleStub.reportStartupFailure({ opId: startOpId, stepId: "workspace-sync", message });
    await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);
    return { status: 502, body: { error: message } };
  }
  try {
    launchConfig = await buildContainerLaunchConfig(env, requestUrl, slug, repo.meta.repoUrl, repo.meta, meta, {
      startOpId,
      startAuthClaim: claimedStart.authClaim,
    });
  } catch (err) {
    await cleanupLaunchCredentialsBestEffort(env, slug, hub);
    const message = actionErrorMessage(err);
    await lifecycleStub.reportStartupFailure({ opId: startOpId, stepId: "harness-launch", message });
    await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);
    return { status: 400, body: { error: message } };
  }
  try {
    meta = { ...meta, ...launchConfig.meta };
    const startupPlanDocument = await resolveStartupPlanDocument(
      repo,
      artifactStore,
      meta,
      meta.githubBaseCommitSha,
      meta.startupPlanId ? { mode: "specific", artifactId: meta.startupPlanId } : { mode: "none" },
    );
    launchConfig = {
      ...launchConfig,
      envVars: withStartupPlanDocumentEnvVar(launchConfig.envVars, startupPlanDocument),
    };
    meta = {
      ...meta,
      bootMessage: `GitHub base ${meta.githubBaseCommitSha?.slice(0, 12) ?? "unknown"}`,
    };
    await persistEnvDefinition(env, buildEnvDefinition(meta));
    await lifecycleStub.clearLeadHarnessState({ opId: startOpId });
    backend = await getRunnerBackend(env, backendKind);
    persistedMeta = await projectAndPersistEnvSummary(env, hub, slug);
  } catch (err) {
    await cleanupLaunchCredentialsBestEffort(env, slug, hub);
    const message = err instanceof Error ? err.message : String(err);
    await workspaceStub.destroyWorkspace().catch(() => {});
    await lifecycleStub.reportStartupFailure({ opId: startOpId, stepId: "workspace-sync", message });
    await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);
    return { status: 502, body: { error: message } };
  }
  if (!persistedMeta) {
    await cleanupLaunchCredentialsBestEffort(env, slug, hub);
    await lifecycleStub.reportStartupFailure({
      opId: startOpId,
      stepId: "workspace-sync",
      message: "Failed to project initialized environment state",
    });
    return { status: 500, body: { error: "Failed to initialize environment state" } };
  }

  let createRunnerCommand: Awaited<ReturnType<typeof lifecycleStub.claimRunnerCommand>> | undefined;
  try {
    if (backendKind === "host") {
      createRunnerCommand = await lifecycleStub.claimRunnerCommand(startOpId, "running");
    }
  } catch (error) {
    const message = `Failed to claim runner create command: ${actionErrorMessage(error)}`;
    await cleanupLaunchCredentialsBestEffort(env, slug, hub);
    await lifecycleStub.reportStartupFailure({ opId: startOpId, stepId: "harness-launch", message });
    return { status: 502, body: { error: message } };
  }

  args.executionCtx.waitUntil(
    (async () => {
      try {
        const updated = await backend.create({
          ...persistedMeta,
          harnessSettings: claimedStart.harnessSettings,
        }, launchConfig.envVars, {
          startOpId,
          ...(createRunnerCommand ? { runnerCommand: createRunnerCommand } : {}),
        });
        const stillExists = await envExists(env, slug);
        if (!stillExists) {
          try {
            const deletion = await lifecycleStub.beginDelete();
            if (deletion.allowed) {
              await backend.destroy(updated, updated.backend === "host"
                ? { runnerCommand: deletion.runnerCommand }
                : undefined);
              await lifecycleStub.finalizeDeletion();
            }
          } catch { /* best effort */ }
          await cleanupLaunchCredentialsBestEffort(env, slug, hub);
          return;
        }
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          opId: startOpId,
        });
        await projectAndPersistEnvSummary(env, hub, slug);
      } catch (err) {
        const message = redactEnvValues(err instanceof Error ? err.message : String(err), launchConfig.envVars);
        console.error(`[envs] Failed to create runner for ${slug}:`, message);
        await cleanupLaunchCredentialsBestEffort(env, slug, hub);
        await getEnvLifecycleStub(env, slug).reportStartupFailure({
          opId: startOpId,
          stepId: "harness-launch",
          message,
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
  executionCtx: ExecutionContext;
  request: Request;
  requestUrl: string;
  slug: string;
  harnessSettings?: unknown;
  intent?: EnvStartCause;
  schedulerDeadlineAtMs?: number;
  expectedIncarnationId?: string;
  lifecycleStub?: ReturnType<typeof getEnvLifecycleStub>;
  cachedMeta?: EnvMeta;
}): Promise<RouteResult> {
  const { env, request, requestUrl, slug, harnessSettings: submittedHarnessSettings } = args;
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
  const projectedMeta = storedMeta;
  if (!storedMeta.executionPlacement) {
    const body = {
      error: "This workload was created by an unsupported version and cannot be run. Delete and recreate it.",
      code: "legacy_workload_record",
    };
    return startIntent === "scheduled"
      ? failScheduledPreStart(409, body, false)
      : { status: 409, body };
  }
  if (isLifecycleStopInProgress(projectedMeta)) {
    const body = { error: getStopFinalizationInProgressError("starting") };
    return startIntent === "scheduled"
      ? failScheduledPreStart(409, body, true)
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
  const startupPlanSelection: StartupPlanSelection = startIntent === "scheduled"
    ? { mode: "specific", artifactId: scheduledPlan!.artifactId }
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
    if (!scheduledScope) return cleanupLaunchCredentialsBestEffort(env, slug, hub);
    const record = await lifecycleStub.getScheduledRun();
    const ids = record?.kind === "active" && record.startOpId === claimedStart.opId
      ? record.credentialIds
      : {};
    return cleanupLaunchCredentialsBestEffort(env, slug, hub, { scope: scheduledScope, ids });
  };
  const failClaimedStart = async (
    responseStatus: number,
    body: Record<string, unknown>,
    stepId: "workspace-sync" | "harness-launch" = "workspace-sync",
    credentialCleanupComplete?: boolean,
  ): Promise<RouteResult> => {
    const message = typeof body.error === "string" ? body.error : "Environment startup failed";
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
      body,
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

  let backend: RunnerBackend;
  let meta: EnvMeta;
  try {
    backend = await getRunnerBackend(env, backendKind);
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
  let startupPlanId: string | null;
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
    startupPlanId = scheduledPlan?.artifactId ?? await resolveSelectedPlanId(
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
    startupPlanId,
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
            startupPlanId ? { mode: "specific", artifactId: startupPlanId } : { mode: "none" },
          );
      {
        const superseded = await abortIfClaimWasSuperseded();
        if (superseded) return superseded;
      }
      launchConfig = {
        ...launchConfig,
        envVars: withStartupPlanDocumentEnvVar(
          launchConfig.envVars,
          withStartCausePreamble(startupPlanDocument, startIntent),
        ),
      };
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
          startupPlanId ? { mode: "specific", artifactId: startupPlanId } : { mode: "none" },
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
        const updated = await backend.start({
          ...startingMeta,
        }, launchConfig.envVars, {
          startOpId: claimedStartOpId,
          ...(runnerCommand ? { runnerCommand } : {}),
        });
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          opId: claimedStartOpId,
        });
        await projectSummary();
      } catch (err) {
        const message = redactEnvValues(err instanceof Error ? err.message : String(err), launchConfig.envVars);
        const controlErrorCode = getRunnerControlErrorCode(err);
        const rejectedBeforeMutation = controlErrorCode === "runner_command_superseded_before_mutation";
        console.error(`[envs] Failed to start runner for ${slug}:`, message);
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
          message,
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
  executionCtx: ExecutionContext;
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
  const reviewWorkloads = await getEnvReviewStub(env, slug).listWorkloadStateForPredeploy();
  const blockingReview = reviewWorkloads.find((run) =>
    run.hasRuntime
    || run.status === "syncing"
    || run.status === "preparing"
    || run.status === "queued"
    || run.status === "running"
    || run.status === "saving");
  if (blockingReview) {
    return {
      status: 409,
      body: {
        error: blockingReview.hasRuntime
          ? "Environment review cleanup must finish before deleting the environment."
          : "Environment has an active review. Cancel or finish it before deleting the environment.",
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
  await cleanupLaunchCredentialsBestEffort(env, slug, hub);
  await projectAndPersistEnvSummary(env, hub, slug).catch(() => null);

  args.executionCtx.waitUntil(
    (async () => {
      try {
        await destroyEnv(env, meta, hub, {
          runnerCommand: deleteClaim.runnerCommand,
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
