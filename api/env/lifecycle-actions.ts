import { getArtifactStoreStub, getEnvLifecycleStub, getWorkspaceStub } from "../helpers";
import { buildEnvScmMetaPatch, isLifecycleStopInProgress } from "../env-lifecycle";
import { revokeCodexGatewaySessionsForEnv } from "../gateway-session";
import { revokeGitHubBridgesForInteractiveEnv } from "../github/bridge";
import { persistEnvDefinition } from "../plan/store";
import { isLocalDevRequest } from "../protection";
import { loadRepoForRequest, type RepoAccessResult, type RepoWorkspace } from "../repo/access";
import {
  createInitialEnvScmState,
  deriveBranchBackedEnvStatus,
  legacyPlanIdToSelection,
  normalizeStartupPlanSelection,
  withDerivedBranchBackedEnvStatus,
  type StartupPlanSelection,
} from "../scm/model";
import { resolveDeploymentModeForRuntime } from "../setup/config";
import { isHostRoutable, readRegisteredHostService, readRoutableHostService } from "../service-registry";
import { projectEnvSummary } from "../sync/projectors";
import type { ClaudeAuthMode, CodexAuthPreference, Env, EnvHarness, EnvMeta, HostServiceRegistration } from "../types";
import { resolveClaudeAuthMode } from "./container-auth";
import { isHarnessEnabled } from "./harness";
import {
  buildContainerLaunchConfig,
  materializeStartupPlan,
  resolveSelectedPlanId,
  TREE_HASH_EXCLUDES,
} from "./launch-config";
import type { RunnerBackend, RunnerBackendKind } from "./runner-backend";
import { getRunnerBackend } from "./runner-backends";
import {
  buildEnvDefinition,
  clearAuthWarning,
  clearEnvError,
  deleteEnvSnapshotArtifacts,
  destroyEnv,
  envExists,
  getHub,
  loadEnvView,
  projectAndPersistEnvSummary,
  projectEnvMetaForAction,
  reconcileEnvScmOperationState,
  readLifecycleState,
} from "./service";
import { deriveEnvSlugCandidate } from "./slug";

export type RouteResult = { status: number; body: unknown };

const HOST_OFFLINE_ERROR =
  "Tiller Self Host is offline. Start `tiller host` on your self-host machine to manage host environments.";

async function requireHostConnection(
  env: Env,
  backend: RunnerBackendKind,
  preferredMachineId?: string | null,
): Promise<string | null> {
  if (backend !== "host") return null;
  return (await isHostRoutable(env, preferredMachineId ?? null)) ? null : HOST_OFFLINE_ERROR;
}

function getStopFinalizationInProgressError(action: string): string {
  return `Environment is still saving changes from the previous stop. Wait for it to finish before ${action}.`;
}

async function requireRoutableHostService(args: {
  env: Env;
  backendKind: RunnerBackendKind;
  preferredMachineId?: string | null;
  isLocalDev: boolean;
  deploymentMode: Awaited<ReturnType<typeof resolveDeploymentModeForRuntime>>;
  hostedModeError: string;
}): Promise<
  | { ok: true; hostService: HostServiceRegistration | null }
  | { ok: false; result: RouteResult }
> {
  if (!args.isLocalDev && args.backendKind === "host" && args.deploymentMode === "hosted") {
    return { ok: false, result: { status: 400, body: { error: args.hostedModeError } } };
  }

  const hostUnavailable = await requireHostConnection(
    args.env,
    args.backendKind,
    args.preferredMachineId ?? null,
  );
  if (hostUnavailable) {
    return { ok: false, result: { status: 409, body: { error: hostUnavailable } } };
  }

  const hostService = args.backendKind === "host"
    ? await readRoutableHostService(args.env, args.preferredMachineId ?? null)
    : null;
  if (args.backendKind === "host" && !hostService) {
    return { ok: false, result: { status: 409, body: { error: HOST_OFFLINE_ERROR } } };
  }
  if (
    !args.isLocalDev
    && args.backendKind === "host"
    && args.deploymentMode === "self-host"
    && !hostService?.gatewayUrl?.trim()
  ) {
    return { ok: false, result: { status: 409, body: { error: HOST_OFFLINE_ERROR } } };
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
    if (!(await envExists(env, slug))) return slug;
  }

  throw new Error("Could not allocate unique environment slug");
}

async function readValidatedRepoContext(
  env: Env,
  args: {
    request: Request;
    repoId: string | null | undefined;
    requireGitReady?: boolean;
  },
): Promise<RepoAccessResult<RepoWorkspace>> {
  return await loadRepoForRequest(
    env,
    args.request,
    args.repoId,
    args.requireGitReady ? "selected-write-with-git" : "selected-write",
  );
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
}): Promise<void> {
  const stopDispatch = await args.backend.stop(args.meta, { stopOpId: args.stopOpId });
  if (!stopDispatch.callbackExpected) {
    const lifecycleStub = args.lifecycleStub ?? getEnvLifecycleStub(args.env, args.slug);
    await lifecycleStub.noteRunnerStopped(
      args.stopOpId,
      "exit",
    );
    await projectAndPersistEnvSummary(args.env, args.hub, args.slug);
    await lifecycleStub.clearStopWorkspaceSyncedMeta();
  }
}

export async function stopEnvAction(args: {
  env: Env;
  executionCtx: ExecutionContext;
  slug: string;
}): Promise<RouteResult> {
  const { env, slug } = args;
  const storedMeta = await loadEnvView(env, slug);
  if (!storedMeta) return { status: 404, body: { error: "Not found" } };
  const backendKind = storedMeta.backend;
  const hostUnavailable = await requireHostConnection(
    env,
    backendKind,
    storedMeta.runnerMachineId ?? null,
  );
  if (hostUnavailable) {
    return { status: 409, body: { error: hostUnavailable } };
  }
  const backend = await getRunnerBackend(env, backendKind);
  const { meta, liveStatus } = await projectEnvMetaForAction(env, storedMeta, backend);
  if (meta.scmOperationType) {
    return {
      status: 409,
      body: {
        error: `Environment has an active SCM operation (${meta.scmOperationType}). Wait for it to finish before stopping.`,
      },
    };
  }
  const hub = getHub(env);

  if (isLifecycleStopInProgress(meta)) {
    const lifecycle = await readLifecycleState(env, meta);
    if (liveStatus === "running" && lifecycle?.activeOpId) {
      args.executionCtx.waitUntil(
        (async () => {
          try {
            await dispatchStopAndFinalizeIfNoCallback({
              env,
              slug,
              backend,
              meta,
              hub,
              stopOpId: lifecycle.activeOpId,
            });
          } catch (err) {
            console.error(`[envs] Failed to retry stop for ${slug}:`, err);
          }
        })(),
      );
    }
    return { status: 200, body: { ok: true, slug, status: meta.status ?? "saving" } };
  }

  const canAttemptStop =
    liveStatus === "running" ||
    meta.status === "running" ||
    meta.status === "starting";

  if (!canAttemptStop) {
    return { status: 409, body: { error: "Environment is not currently running." } };
  }

  const lifecycleStub = getEnvLifecycleStub(env, slug);
  const lifecycle = await lifecycleStub.requestStop();
  await revokeCodexGatewaySessionsForEnv(env, slug);
  await revokeGitHubBridgesForInteractiveEnv(env, slug);
  const savingMeta = await projectAndPersistEnvSummary(env, hub, slug);
  if (!savingMeta) {
    return { status: 404, body: { error: "Environment state not found" } };
  }

  args.executionCtx.waitUntil(
    (async () => {
      try {
        await dispatchStopAndFinalizeIfNoCallback({
          env,
          slug,
          backend,
          meta: savingMeta,
          hub,
          stopOpId: lifecycle.activeOpId,
          lifecycleStub,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to stop runner for ${slug}:`, message);
        await lifecycleStub.noteStopDispatchFailed(
          lifecycle.activeOpId,
          message,
        );
        await projectAndPersistEnvSummary(env, hub, slug);
      }
    })(),
  );

  return { status: 200, body: { ok: true, slug, status: savingMeta.status ?? "saving" } };
}

export async function createEnvAction(args: {
  env: Env;
  executionCtx: ExecutionContext;
  request: Request;
  requestUrl: string;
  repoId: string;
  requestedSlug?: string;
  backendKind: RunnerBackendKind;
  harness: EnvHarness;
  requestedAuthMode?: ClaudeAuthMode;
  requestedCodexAuthPreference?: string;
  planId?: string | null;
  planSelection?: unknown;
}): Promise<RouteResult> {
  const {
    env,
    request,
    requestUrl,
    repoId,
    requestedSlug,
    backendKind,
    harness,
    requestedAuthMode,
    requestedCodexAuthPreference,
    planId,
    planSelection,
  } = args;
  const isLocalDev = isLocalDevRequest(env, request);
  const registeredHost = await readRegisteredHostService(env);
  const deploymentMode = await resolveDeploymentModeForRuntime(env, {
    hostRegistered: Boolean(registeredHost?.machineId?.trim()),
    hostGatewayConfigured: Boolean(registeredHost?.gatewayUrl?.trim()),
  });
  if (isLocalDev && backendKind === "cf") {
    return {
      status: 400,
      body: {
        error:
          "Cloudflare Containers are not available in local development. Localhost only supports the Tiller Self Host backend. Run `tiller host`, then create the environment again.",
      },
    };
  }
  const hostGate = await requireRoutableHostService({
    env,
    backendKind,
    isLocalDev,
    deploymentMode,
    hostedModeError: "Tiller Self Host mode is required before creating host environments.",
  });
  if (!hostGate.ok) return hostGate.result;
  const { hostService } = hostGate;
  if (!isHarnessEnabled(env, harness)) {
    return { status: 400, body: { error: `Harness not enabled: ${harness}` } };
  }
  if (harness !== "claude-code" && requestedAuthMode) {
    return { status: 400, body: { error: "authMode is only supported for the claude-code harness" } };
  }
  if (
    requestedCodexAuthPreference
    && requestedCodexAuthPreference !== "auto"
    && requestedCodexAuthPreference !== "subscription"
    && requestedCodexAuthPreference !== "api-key"
  ) {
    return { status: 400, body: { error: "codexAuthPreference must be 'auto', 'subscription', or 'api-key'" } };
  }
  if (harness !== "codex" && requestedCodexAuthPreference) {
    return { status: 400, body: { error: "codexAuthPreference is only supported for the codex harness" } };
  }
  const authMode: ClaudeAuthMode | undefined = harness === "claude-code"
    ? backendKind === "host"
      ? "auto"
      : resolveClaudeAuthMode({ requested: requestedAuthMode ?? null })
    : undefined;
  const codexAuthPreference: CodexAuthPreference | undefined = harness === "codex"
    ? backendKind === "host"
      ? "auto"
      : deploymentMode === "hosted"
      ? "api-key"
      : (requestedCodexAuthPreference === "subscription" || requestedCodexAuthPreference === "api-key" ? requestedCodexAuthPreference : "auto")
    : undefined;
  const loadedRepo = await readValidatedRepoContext(env, {
    request,
    repoId,
    requireGitReady: true,
  });
  if (!loadedRepo.ok) return { status: loadedRepo.status, body: loadedRepo.body };
  const repo = loadedRepo.repo;
  const slug = requestedSlug
    ? requestedSlug
    : await findAvailableSlug(env, repo.meta.repoUrl, backendKind);
  if (await envExists(env, slug)) {
    return { status: 409, body: { error: "Environment already exists", slug } };
  }
  const createdAt = new Date().toISOString();
  let meta: EnvMeta = {
    slug,
    repoUrl: repo.meta.repoUrl,
    repoId: repo.meta.repoId,
    backend: backendKind,
    runnerId: backendKind === "cf" ? slug : undefined,
    harness,
    ...(authMode ? { authMode } : {}),
    ...(codexAuthPreference ? { codexAuthPreference } : {}),
    createdAt,
    updatedAt: createdAt,
    status: "creating",
    ...createInitialEnvScmState({
      slug,
      mainCommit: repo.meta.mainCommit ?? null,
    }),
  };
  const artifactStore = getArtifactStoreStub(env, repo.meta.repoId);
  const startupPlanSelection = legacyPlanIdToSelection(
    planId,
    normalizeStartupPlanSelection(planSelection, { mode: "todo" }),
  );
  try {
    meta = {
      ...meta,
      startupPlanId: await resolveSelectedPlanId(
        repo,
        artifactStore,
        meta,
        repo.meta.mainCommit,
        startupPlanSelection,
      ),
    };
  } catch (error) {
    return {
      status: 409,
      body: { error: error instanceof Error ? error.message : "Failed to resolve startup plan artifact" },
    };
  }

  let launchConfig: Awaited<ReturnType<typeof buildContainerLaunchConfig>>;
  try {
    launchConfig = await buildContainerLaunchConfig(env, requestUrl, slug, repo.meta.repoUrl, repo.meta, meta, {
      hostMachineId: hostService?.machineId ?? null,
    });
    meta = { ...meta, ...clearAuthWarning(meta), ...launchConfig.meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, body: { error: message } };
  }
  const workspaceStub = getWorkspaceStub(env, slug);
  await workspaceStub.destroyWorkspace();

  try {
    const tarBuffer = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
    const result = await workspaceStub.restoreFromTar(tarBuffer, { clearFirst: true });
    meta = { ...meta, bootMessage: `Workspace: ${result.fileCount} files` };

    const startupPlanId = await materializeStartupPlan(
      repo,
      artifactStore,
      workspaceStub,
      meta,
      repo.meta.mainCommit,
      meta.startupPlanId ? { mode: "specific", artifactId: meta.startupPlanId } : { mode: "none" },
    );
    meta = { ...meta, startupPlanId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[envs] Workspace init failed for ${slug}:`, message);
    await workspaceStub.destroyWorkspace().catch(() => {});
    return { status: 502, body: { error: `Failed to initialize canonical repo workspace: ${message}` } };
  }

  const hub = getHub(env);
  const lifecycleStub = getEnvLifecycleStub(env, slug);
  await persistEnvDefinition(env, buildEnvDefinition(meta));
  await lifecycleStub.clearMutableState();
  await lifecycleStub.initializeMutableStateFromMeta(meta);
  await lifecycleStub.clearLeadHarnessState();
  const startLifecycle = await lifecycleStub.requestStart();
  await lifecycleStub.beginStartupDiagnostics({
    opId: startLifecycle.activeOpId,
    backend: backendKind,
    stepId: "workspace-sync",
    message: meta.bootMessage ?? "Workspace prepared",
  });
  const backend = await getRunnerBackend(env, backendKind);
  const persistedMeta = await projectAndPersistEnvSummary(env, hub, slug);
  if (!persistedMeta) {
    return { status: 500, body: { error: "Failed to initialize environment state" } };
  }
  args.executionCtx.waitUntil(
    (async () => {
      try {
        const updated = await backend.create({
          ...persistedMeta,
          ...(hostService?.machineId ? { runnerMachineId: hostService.machineId } : {}),
        }, launchConfig.envVars, {
          startOpId: startLifecycle?.activeOpId ?? null,
        });
        const stillExists = await envExists(env, slug);
        if (!stillExists) {
          try { await backend.destroy(updated); } catch { /* best effort */ }
          return;
        }
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          runnerMachineId: updated.runnerMachineId ?? null,
        });
        await projectAndPersistEnvSummary(env, hub, slug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to create runner for ${slug}:`, message);
        await getEnvLifecycleStub(env, slug).reportStartupFailure({
          opId: startLifecycle.activeOpId,
          stepId: "harness-launch",
          message,
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
  planId?: string | null;
  planSelection?: unknown;
}): Promise<RouteResult> {
  const { env, request, requestUrl, slug, planId, planSelection } = args;
  const cachedMeta = await loadEnvView(env, slug);
  if (!cachedMeta) return { status: 404, body: { error: "Not found" } };

  const storedMeta = cachedMeta;
  const projectedMeta = await reconcileEnvScmOperationState(env, storedMeta);
  if (isLifecycleStopInProgress(projectedMeta)) {
    return { status: 409, body: { error: getStopFinalizationInProgressError("starting") } };
  }
  if (projectedMeta.scmOperationType) {
    return {
      status: 409,
      body: {
        error: `Environment has an active SCM operation (${projectedMeta.scmOperationType}). Wait for it to finish before starting.`,
      },
    };
  }
  const backendKind = storedMeta.backend;
  const isLocalDev = isLocalDevRequest(env, request);
  const startDeploymentMode = await resolveDeploymentModeForRuntime(env);
  const hostGate = await requireRoutableHostService({
    env,
    backendKind,
    preferredMachineId: storedMeta.runnerMachineId ?? null,
    isLocalDev,
    deploymentMode: startDeploymentMode,
    hostedModeError: "Tiller Self Host mode is required before starting host environments.",
  });
  if (!hostGate.ok) return hostGate.result;
  const { hostService } = hostGate;
  const backend = await getRunnerBackend(env, backendKind);
  const { meta } = await projectEnvMetaForAction(env, projectedMeta, backend);
  const status = meta.status ?? "unknown";
  if (status !== "stopped" && status !== "failed" && status !== "unknown") {
    return { status: 409, body: { error: "Environment must be stopped before starting again." } };
  }
  if (!isHarnessEnabled(env, meta.harness)) {
    return { status: 400, body: { error: `Harness not enabled: ${meta.harness}` } };
  }
  let launchConfig: Awaited<ReturnType<typeof buildContainerLaunchConfig>>;
  const loadedRepo = await readValidatedRepoContext(env, {
    request,
    repoId: meta.repoId,
    requireGitReady: true,
  });
  if (!loadedRepo.ok) return { status: loadedRepo.status, body: loadedRepo.body };
  const repo = loadedRepo.repo;
  let syncedMeta = withDerivedBranchBackedEnvStatus(meta, repo.meta);
  const workspaceStub = getWorkspaceStub(env, slug);
  const artifactStore = getArtifactStoreStub(env, repo.meta.repoId);
  const lifecycleStub = getEnvLifecycleStub(env, slug);
  let startupPlanId: string | null;
  const startupPlanSelection: StartupPlanSelection = legacyPlanIdToSelection(
    planId,
    normalizeStartupPlanSelection(
      planSelection,
      syncedMeta.startupPlanId ? { mode: "specific", artifactId: syncedMeta.startupPlanId } : { mode: "none" },
    ),
  );
  const canonicalVisibleFileCount = await readCanonicalVisibleWorkspaceFileCount(workspaceStub);
  if (canonicalVisibleFileCount === 0) {
    try {
      const canonicalTar = await repo.workspace.downloadTar({ excludePrefixes: TREE_HASH_EXCLUDES });
      await workspaceStub.restoreFromTar(canonicalTar, {
        clearFirst: true,
        preservePrefixes: TREE_HASH_EXCLUDES,
      });
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
        { clearError: true },
      );
      await persistEnvDefinition(env, buildEnvDefinition(syncedMeta));
      console.info(`[envs] empty workspace bootstrapped from main for ${slug} at ${repo.meta.mainCommit ?? "unknown"}`);
      await deleteEnvSnapshotArtifacts(env.BUCKET, slug).catch((error) => {
        console.warn(`[envs] Failed to delete legacy snapshots for ${slug}:`, error);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[envs] Failed to bootstrap empty workspace for ${slug}:`, message);
      return { status: 502, body: { error: `Failed to bootstrap workspace from canonical main: ${message}` } };
    }
  }

  try {
    launchConfig = await buildContainerLaunchConfig(env, requestUrl, slug, repo.meta.repoUrl, repo.meta, syncedMeta, {
      hostMachineId: hostService?.machineId ?? null,
    });
    startupPlanId = await resolveSelectedPlanId(
      repo,
      artifactStore,
      syncedMeta,
      repo.meta.mainCommit,
      startupPlanSelection,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 400, body: { error: message } };
  }

  const planMeta: EnvMeta = {
    ...syncedMeta,
    startupPlanId,
    branchStatus: deriveBranchBackedEnvStatus(
      syncedMeta,
      repo.meta,
    ),
  };
  await materializeStartupPlan(
    repo,
    artifactStore,
    workspaceStub,
    planMeta,
    repo.meta.mainCommit,
    startupPlanId ? { mode: "specific", artifactId: startupPlanId } : { mode: "none" },
  );

  const hub = getHub(env);
  await persistEnvDefinition(env, buildEnvDefinition({
    ...clearEnvError(planMeta),
    ...launchConfig.meta,
  }));
  await lifecycleStub.setAuthWarning(launchConfig.meta.authWarning ?? null);
  await lifecycleStub.clearLeadHarnessState();
  const startLifecycle = await lifecycleStub.requestStart();
  await lifecycleStub.beginStartupDiagnostics({
    opId: startLifecycle.activeOpId,
    backend: backendKind,
    stepId: "workspace-sync",
    message: "Preparing workspace start...",
  });
  const startingMeta = await projectAndPersistEnvSummary(env, hub, slug);
  if (!startingMeta) {
    return { status: 404, body: { error: "Environment state not found" } };
  }

  args.executionCtx.waitUntil(
    (async () => {
      try {
        const updated = await backend.start({
          ...startingMeta,
          ...(hostService?.machineId ? { runnerMachineId: hostService.machineId } : {}),
        }, launchConfig.envVars, {
          startOpId: startLifecycle?.activeOpId ?? null,
        });
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          runnerMachineId: updated.runnerMachineId ?? null,
        });
        await projectAndPersistEnvSummary(env, hub, slug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to start runner for ${slug}:`, message);
        await getEnvLifecycleStub(env, slug).reportStartupFailure({
          opId: startLifecycle.activeOpId,
          stepId: "harness-launch",
          message,
        });
        await projectAndPersistEnvSummary(env, hub, slug);
      }
    })(),
  );

  return { status: 200, body: { ok: true, slug, status: "starting" } };
}

export async function deleteEnvAction(args: {
  env: Env;
  executionCtx: ExecutionContext;
  slug: string;
}): Promise<RouteResult> {
  const { env, slug } = args;
  const storedMeta = await loadEnvView(env, slug);
  if (!storedMeta) return { status: 404, body: { error: "Not found" } };
  const projectedMeta = storedMeta;
  if (isLifecycleStopInProgress(projectedMeta)) {
    return {
      status: 409,
      body: { error: getStopFinalizationInProgressError("deleting the environment") },
    };
  }
  const backendKind = storedMeta.backend;
  const hostUnavailable = await requireHostConnection(
    env,
    backendKind,
    storedMeta.runnerMachineId ?? null,
  );
  if (hostUnavailable) {
    return { status: 409, body: { error: hostUnavailable } };
  }
  const backend = await getRunnerBackend(env, backendKind);
  const { meta } = await projectEnvMetaForAction(env, projectedMeta, backend);
  const hub = getHub(env);
  const lifecycleStub = getEnvLifecycleStub(env, slug);
  await revokeCodexGatewaySessionsForEnv(env, slug);
  await revokeGitHubBridgesForInteractiveEnv(env, slug);
  await lifecycleStub.clearError();
  await lifecycleStub.setStatus("deleting", { clearLifecycle: true });
  const deletingMeta = await projectAndPersistEnvSummary(env, hub, slug);
  if (!deletingMeta) {
    return { status: 404, body: { error: "Environment state not found" } };
  }

  args.executionCtx.waitUntil(
    (async () => {
      try {
        await destroyEnv(env, meta, hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to delete runner for ${slug}:`, message);
        await lifecycleStub.setStatus("failed", { clearLifecycle: true });
        await lifecycleStub.setError(message);
        await projectAndPersistEnvSummary(env, hub, slug);
      }
    })(),
  );

  return {
    status: 200,
    body: { ok: true, slug, status: "deleting", message: "Environment deletion started" },
  };
}
