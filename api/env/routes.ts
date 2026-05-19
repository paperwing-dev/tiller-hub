// Environment CRUD and container lifecycle.
// Workspace state stays hosted in WorkspaceDO; environments run on Cloudflare Containers or Tiller Host.

import { Hono } from "hono";
import type { MergeConflictPayload } from "../scm/conflict-resolution";
import { getArtifactStoreStub, getEnvLifecycleStub, getWorkspaceStub } from "../helpers";
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
import {
  ensureRepoWorkspaceFromRepoUrl,
  listEnvDefinitionSlugs,
  listEnvMetas,
  persistEnvDefinition,
  readEnvDefinition,
  readEnvSummary,
} from "../plan/store";
import { isEnvHarness, isHarnessEnabled } from "./harness";
import { resolveClaudeAuthMode } from "./container-auth";
import { isLocalDevRequest } from "../protection";
import { deriveEnvSlugCandidate } from "./slug";
import type { RunnerBackendKind } from "./runner-backend";
import { getRunnerBackend } from "./runner-backends";
import { isHostRoutable, readRoutableHostService } from "../service-registry";
import {
  createInitialEnvScmState,
  deriveBranchBackedEnvStatus,
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
} from "../scm/workflows";
import {
  projectEnvSummary,
  projectRepoSummary,
} from "../sync/projectors";
import {
  applyLifecycleProjectionToMeta,
  buildEnvScmMetaPatch,
  isLifecycleStopInProgress,
} from "../env-lifecycle";
import {
  getHub,
  buildEnvDefinition,
  clearEnvError,
  clearAuthWarning,
  parseEnvMeta,
  projectAndPersistEnvSummary,
  projectEnvMetaWithLifecycle,
  projectEnvMetaForAction,
  projectEnvMetaForRead,
  reconcileEnvScmOperationState,
  deleteEnvSnapshotArtifacts,
  destroyEnv,
  readLifecycleState,
} from "./service";
import {
  getRepoGitNotReadyError,
  readScmOperationHeader,
  readScmOperationIntHeader,
  readScmOperationDurationHeader,
} from "./scm-operations";
import {
  TREE_HASH_EXCLUDES,
  resolveSelectedPlanId,
  materializeStartupPlan,
  buildContainerLaunchConfig,
} from "./launch-config";

async function findAvailableSlug(
  env: Pick<Env, "ENVS_KV">,
  repoUrl: string,
  backend: RunnerBackendKind,
): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const slug = deriveEnvSlugCandidate(repoUrl, backend, attempt);
    const existing = await env.ENVS_KV.get(slug);
    if (!existing && !(await readEnvDefinition(env, slug))) return slug;
  }

  throw new Error("Could not allocate unique environment slug");
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

const HOST_OFFLINE_ERROR =
  "Tiller Host is offline. Start `tiller host` on your host machine to manage host environments.";

async function requireHostConnection(
  env: Env,
  backend: RunnerBackendKind,
  preferredMachineId?: string | null,
): Promise<string | null> {
  if (backend !== "host") return null;
  return (await isHostRoutable(env, preferredMachineId ?? null)) ? null : HOST_OFFLINE_ERROR;
}

function isLocalRunnerOfflineError(message: string): boolean {
  return (
    message.includes(HOST_OFFLINE_ERROR) ||
    message.includes("Tiller Host is offline") ||
    message.includes("Timed out waiting for Tiller Host.")
  );
}

async function readProjectedEnvMeta(
  env: Env,
  slug: string,
): Promise<EnvMeta | null> {
  return await projectAndPersistEnvSummary(env, getHub(env), slug, {
    broadcast: false,
  });
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

function readLifecycleOpIdHeader(request: Request): string | null {
  const opId = request.headers.get("X-Tiller-Lifecycle-Op-Id")?.trim();
  return opId || null;
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
  const entries = await listEnvMetas(c.env);
  const metasBySlug = new Map(entries.map((meta) => [meta.slug, meta] as const));
  const definitionSlugs = await listEnvDefinitionSlugs(c.env);
  const missingDefinitionSlugs = definitionSlugs.filter((slug) => !metasBySlug.has(slug));

  const recoveredDefinitions = await Promise.all(
    missingDefinitionSlugs.map(async (slug) => {
      try {
        return await readProjectedEnvMeta(c.env, slug);
      } catch (error) {
        console.warn(
          `[envs] Skipping env ${slug} during backfill:`,
          error instanceof Error ? error.message : String(error),
        );
        return null;
      }
    }),
  );

  for (const recovered of recoveredDefinitions) {
    if (recovered) {
      metasBySlug.set(recovered.slug, recovered);
    }
  }

  const projected = await Promise.all(
    Array.from(metasBySlug.values()).map(async (meta) => {
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
  const body = await c.req.json<{
    repoUrl: string;
    slug?: string;
    backend?: string;
    harness?: string;
    authMode?: string;
    planId?: string | null;
  }>();
  if (!body.repoUrl) return c.json({ error: "repoUrl is required" }, 400);
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
  const requestedHarness = body.harness;

  const isLocalDev = isLocalDevRequest(c.env, c.req.raw);
  if (isLocalDev && body.backend === "cf") {
    return c.json({
      error:
        "Cloudflare Containers are not available in local development. Localhost only supports the Tiller Host backend. Run `tiller host`, then create the environment again.",
    }, 400);
  }

  const backendKind = body.backend;
  const harness = requestedHarness;
  const hostUnavailable = await requireHostConnection(c.env, backendKind);
  if (hostUnavailable) {
    return c.json({ error: hostUnavailable }, 409);
  }
  const hostService = backendKind === "host" ? await readRoutableHostService(c.env) : null;
  if (backendKind === "host" && !hostService) {
    return c.json({ error: HOST_OFFLINE_ERROR }, 409);
  }
  if (!isHarnessEnabled(c.env, harness)) {
    return c.json({ error: `Harness not enabled: ${harness}` }, 400);
  }
  if (harness !== "claude-code" && body.authMode) {
    return c.json({ error: "authMode is only supported for the claude-code harness" }, 400);
  }
  const authMode = harness === "claude-code"
    ? resolveClaudeAuthMode({ requested: body.authMode ?? null })
    : undefined;
  const requestedSlug = body.slug?.trim();
  const slug = requestedSlug
    ? requestedSlug
    : await findAvailableSlug(c.env, body.repoUrl, backendKind);
  if ((await readEnvDefinition(c.env, slug)) || (await readEnvSummary(c.env, slug))) {
    return c.json({ error: "Environment already exists", slug }, 409);
  }
  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, body.repoUrl);
  const repoGitNotReadyError = getRepoGitNotReadyError(repo.meta);
  if (repoGitNotReadyError) {
    return c.json({ error: repoGitNotReadyError }, 409);
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
    createdAt,
    updatedAt: createdAt,
    status: "creating",
    ...createInitialEnvScmState({
      slug,
      mainCommit: repo.meta.mainCommit ?? null,
    }),
  };
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  try {
    meta = {
      ...meta,
      startupPlanId: await resolveSelectedPlanId(
        repo,
        artifactStore,
        meta,
        repo.meta.mainCommit,
        body.planId,
      ),
    };
  } catch (error) {
    return c.json(
      { error: error instanceof Error ? error.message : "Failed to resolve startup plan artifact" },
      409,
    );
  }

  let launchConfig: Awaited<ReturnType<typeof buildContainerLaunchConfig>>;
  try {
    launchConfig = await buildContainerLaunchConfig(c.env, c.req.url, slug, body.repoUrl, repo.meta, meta, {
      hostMachineId: hostService?.machineId ?? null,
    });
    meta = { ...meta, ...clearAuthWarning(meta), ...launchConfig.meta };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }
  const workspaceStub = getWorkspaceStub(c.env, slug);
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
    );
    meta = { ...meta, startupPlanId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[envs] Workspace init failed for ${slug}:`, message);
    await workspaceStub.destroyWorkspace().catch(() => {});
    return c.json({ error: `Failed to initialize canonical repo workspace: ${message}` }, 502);
  }

  const hub = getHub(c.env);
  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  await persistEnvDefinition(c.env, buildEnvDefinition(meta));
  await lifecycleStub.clearMutableState();
  await lifecycleStub.hydrateFromSummary(meta);
  await lifecycleStub.clearLeadHarnessState();
  const startLifecycle = await lifecycleStub.requestStart();
  await lifecycleStub.beginStartupDiagnostics({
    opId: startLifecycle.activeOpId,
    backend: backendKind,
    stepId: "workspace-sync",
    message: meta.bootMessage ?? "Workspace prepared",
  });
  const backend = await getRunnerBackend(c.env, backendKind);
  const persistedMeta = await projectAndPersistEnvSummary(c.env, hub, slug);
  if (!persistedMeta) {
    return c.json({ error: "Failed to initialize environment state" }, 500);
  }
  c.executionCtx.waitUntil(
    (async () => {
      try {
        const updated = await backend.create({
          ...persistedMeta,
          ...(hostService?.machineId ? { runnerMachineId: hostService.machineId } : {}),
        }, launchConfig.envVars, {
          startOpId: startLifecycle?.activeOpId ?? null,
        });
        const stillExists = (await readEnvDefinition(c.env, slug)) || (await readEnvSummary(c.env, slug));
        if (!stillExists) {
          try { await backend.destroy(updated); } catch { /* best effort */ }
          return;
        }
        await lifecycleStub.setRunnerBinding({
          runnerId: updated.runnerId ?? null,
          runnerMachineId: updated.runnerMachineId ?? null,
        });
        await projectAndPersistEnvSummary(c.env, hub, slug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to create runner for ${slug}:`, message);
        await getEnvLifecycleStub(c.env, slug).reportStartupFailure({
          opId: startLifecycle.activeOpId,
          stepId: "harness-launch",
          message,
        });
        await projectAndPersistEnvSummary(c.env, hub, slug);
      }
    })(),
  );

  return c.json(projectEnvSummary(persistedMeta), 201);
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
  const cachedMeta = await readProjectedEnvMeta(c.env, slug);
  if (!cachedMeta) return c.json({ error: "Not found" }, 404);

  const body: { planId?: string | null } = c.req.header("Content-Type")?.includes("application/json")
    ? await c.req.json<{ planId?: string | null }>().catch(() => ({}))
    : {};

  const storedMeta = cachedMeta;
  const projectedMeta = await reconcileEnvScmOperationState(c.env, storedMeta);
  if (isLifecycleStopInProgress(projectedMeta)) {
    return c.json({ error: getStopFinalizationInProgressError("starting") }, 409);
  }
  if (projectedMeta.scmOperationType) {
    return c.json({ error: `Environment has an active SCM operation (${projectedMeta.scmOperationType}). Wait for it to finish before starting.` }, 409);
  }
  const backendKind = storedMeta.backend;
  const hostUnavailable = await requireHostConnection(
    c.env,
    backendKind,
    storedMeta.runnerMachineId ?? null,
  );
  if (hostUnavailable) {
    return c.json({ error: hostUnavailable }, 409);
  }
  const hostService = backendKind === "host"
    ? await readRoutableHostService(c.env, storedMeta.runnerMachineId ?? null)
    : null;
  if (backendKind === "host" && !hostService) {
    return c.json({ error: HOST_OFFLINE_ERROR }, 409);
  }
  const backend = await getRunnerBackend(c.env, backendKind);
  const { meta } = await projectEnvMetaForAction(c.env, projectedMeta, backend);
  const status = meta.status ?? "unknown";
  if (status !== "stopped" && status !== "failed" && status !== "unknown") {
    return c.json({ error: "Environment must be stopped before starting again." }, 409);
  }
  if (!isHarnessEnabled(c.env, meta.harness)) {
    return c.json({ error: `Harness not enabled: ${meta.harness}` }, 400);
  }
  let launchConfig: Awaited<ReturnType<typeof buildContainerLaunchConfig>>;
  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
  let syncedMeta = withDerivedBranchBackedEnvStatus(meta, repo.meta);
  const workspaceStub = getWorkspaceStub(c.env, slug);
  const artifactStore = getArtifactStoreStub(c.env, repo.meta.repoId);
  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  let startupPlanId: string | null;
  const repoGitNotReadyError = getRepoGitNotReadyError(repo.meta);
  if (repoGitNotReadyError) {
    return c.json({ error: repoGitNotReadyError }, 409);
  }

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
      await persistEnvDefinition(c.env, buildEnvDefinition(syncedMeta));
      console.info(`[envs] empty workspace bootstrapped from main for ${slug} at ${repo.meta.mainCommit ?? "unknown"}`);
      await deleteEnvSnapshotArtifacts(c.env.BUCKET, slug).catch((error) => {
        console.warn(`[envs] Failed to delete legacy snapshots for ${slug}:`, error);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[envs] Failed to bootstrap empty workspace for ${slug}:`, message);
      return c.json({ error: `Failed to bootstrap workspace from canonical main: ${message}` }, 502);
    }
  }

  try {
    launchConfig = await buildContainerLaunchConfig(c.env, c.req.url, slug, syncedMeta.repoUrl, repo.meta, syncedMeta, {
      hostMachineId: hostService?.machineId ?? null,
    });
    startupPlanId = await resolveSelectedPlanId(
      repo,
      artifactStore,
      syncedMeta,
      repo.meta.mainCommit,
      body.planId,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
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
  );

  const hub = getHub(c.env);
  await persistEnvDefinition(c.env, buildEnvDefinition({
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
  const startingMeta = await projectAndPersistEnvSummary(c.env, hub, slug);
  if (!startingMeta) {
    return c.json({ error: "Environment state not found" }, 404);
  }

  c.executionCtx.waitUntil(
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
        await projectAndPersistEnvSummary(c.env, hub, slug);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to start runner for ${slug}:`, message);
        await getEnvLifecycleStub(c.env, slug).reportStartupFailure({
          opId: startLifecycle.activeOpId,
          stepId: "harness-launch",
          message,
        });
        await projectAndPersistEnvSummary(c.env, hub, slug);
      }
    })(),
  );

  return c.json({ ok: true, slug, status: "starting" });
});

envRoutes.post("/api/envs/:slug/stop", async (c) => {
  const slug = c.req.param("slug");
  const storedMeta = await readProjectedEnvMeta(c.env, slug);
  if (!storedMeta) return c.json({ error: "Not found" }, 404);
  const backendKind = storedMeta.backend;
  const hostUnavailable = await requireHostConnection(
    c.env,
    backendKind,
    storedMeta.runnerMachineId ?? null,
  );
  if (hostUnavailable) {
    return c.json({ error: hostUnavailable }, 409);
  }
  const backend = await getRunnerBackend(c.env, backendKind);
  const { meta, liveStatus } = await projectEnvMetaForAction(c.env, storedMeta, backend);
  if (meta.scmOperationType) {
    return c.json({ error: `Environment has an active SCM operation (${meta.scmOperationType}). Wait for it to finish before stopping.` }, 409);
  }
  const hub = getHub(c.env);

  if (isLifecycleStopInProgress(meta)) {
    const lifecycle = await readLifecycleState(c.env, meta);
    if (liveStatus === "running" && lifecycle?.activeOpId) {
      c.executionCtx.waitUntil(
        (async () => {
          try {
            const stopDispatch = await backend.stop(meta, { stopOpId: lifecycle.activeOpId });
            if (!stopDispatch.callbackExpected) {
              const lifecycleStubRetry = getEnvLifecycleStub(c.env, slug);
              await lifecycleStubRetry.noteRunnerStopped(
                lifecycle.activeOpId,
                "exit",
              );
              await projectAndPersistEnvSummary(c.env, hub, slug);
              await lifecycleStubRetry.clearStopWorkspaceSyncedMeta();
            }
          } catch (err) {
            console.error(`[envs] Failed to retry stop for ${slug}:`, err);
          }
        })(),
      );
    }
    return c.json({ ok: true, slug, status: meta.status ?? "saving" });
  }

  const canAttemptStop =
    liveStatus === "running" ||
    meta.status === "running" ||
    meta.status === "starting";

  if (!canAttemptStop) {
    return c.json({ error: "Environment is not currently running." }, 409);
  }

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const lifecycle = await lifecycleStub.requestStop();
  const savingMeta = await projectAndPersistEnvSummary(c.env, hub, slug);
  if (!savingMeta) {
    return c.json({ error: "Environment state not found" }, 404);
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        const stopDispatch = await backend.stop(savingMeta, { stopOpId: lifecycle.activeOpId });
        if (!stopDispatch.callbackExpected) {
          await lifecycleStub.noteRunnerStopped(
            lifecycle.activeOpId,
            "exit",
          );
          await projectAndPersistEnvSummary(c.env, hub, slug);
          await lifecycleStub.clearStopWorkspaceSyncedMeta();
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to stop runner for ${slug}:`, message);
        await lifecycleStub.noteStopDispatchFailed(
          lifecycle.activeOpId,
          message,
        );
        await projectAndPersistEnvSummary(c.env, hub, slug);
      }
    })(),
  );

  return c.json({ ok: true, slug, status: savingMeta.status ?? "saving" });
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

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const logTails = readStartupDiagnosticLogTails(body.logTails);
  const hub = getHub(c.env);

  if (body.type === "failure") {
    if (body.stepId !== undefined && !isStartupDiagnosticStepId(body.stepId)) {
      return c.json({ error: "Invalid stepId" }, 400);
    }
    await lifecycleStub.reportStartupFailure({
      opId,
      stepId: isStartupDiagnosticStepId(body.stepId) ? body.stepId : undefined,
      message: body.message,
      detail: typeof body.detail === "string" ? body.detail : null,
      at: typeof body.at === "string" ? body.at : null,
      exitCode: typeof body.exitCode === "number" ? body.exitCode : null,
      signal: typeof body.signal === "string" ? body.signal : null,
      logTails,
    });
    const projected = await tryProjectAndPersistEnvSummary(c.env, hub, slug);
    return c.json({
      ok: true,
      slug,
      status: projected?.status ?? meta.status ?? null,
      error: projected?.error ?? body.message.trim(),
    });
  }

  if (!isStartupDiagnosticStepId(body.stepId)) {
    return c.json({ error: "stepId is required" }, 400);
  }

  await lifecycleStub.reportStartupEvent({
    opId,
    stepId: body.stepId,
    severity: readStartupDiagnosticSeverity(body.severity),
    message: body.message,
    detail: typeof body.detail === "string" ? body.detail : null,
    at: typeof body.at === "string" ? body.at : null,
    logTails,
  });
  const projected = await tryProjectAndPersistEnvSummary(c.env, hub, slug);
  return c.json({
    ok: true,
    slug,
    status: projected?.status ?? meta.status ?? null,
  });
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
  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const lifecycleBefore = await lifecycleStub.getState();
  console.info(
    `[envs] runner-stopped received for ${slug}: ${JSON.stringify({
      opId,
      detail: detail || null,
      lifecycleBefore: formatLifecycleDebug(lifecycleBefore),
    })}`,
  );
  const lifecycleAfter = await lifecycleStub.noteRunnerStopped(
    opId,
    detail || null,
  );
  console.info(
    `[envs] runner-stopped applied for ${slug}: ${JSON.stringify({
      opId,
      lifecycleAfter: formatLifecycleDebug(lifecycleAfter),
    })}`,
  );

  const hub = getHub(c.env);
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug);
  if (projected?.status === "stopped") {
    await lifecycleStub.clearStopWorkspaceSyncedMeta().catch(() => {});
  }
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

  const workspacePatch = readWorkspaceSyncedPatchFromHeaders(c.req.raw);

  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const lifecycleBefore = await lifecycleStub.getState();
  console.info(
    `[envs] workspace-synced ack received for ${slug}: ${JSON.stringify({
      opId,
      lifecycleBefore: formatLifecycleDebug(lifecycleBefore),
      workspacePatch,
    })}`,
  );

  await lifecycleStub.noteStopWorkspaceSynced(opId, workspacePatch);
  const lifecycleAfter = await lifecycleStub.getState();
  console.info(
    `[envs] workspace-synced ack applied for ${slug}: ${JSON.stringify({
      opId,
      lifecycleAfter: formatLifecycleDebug(lifecycleAfter),
    })}`,
  );

  const hub = getHub(c.env);
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug);
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

  const hub = getHub(c.env);
  console.warn(
    `[envs] stop-failed received for ${slug}: ${JSON.stringify({
      opId: stopOpId,
      message,
    })}`,
  );
  await getEnvLifecycleStub(c.env, slug).recordWorkspaceSyncFailed(
    stopOpId,
    message,
  );
  const projected = await projectAndPersistEnvSummary(c.env, hub, slug);
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
  const hub = getHub(c.env);
  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  const opId = readLifecycleOpIdHeader(c.req.raw) || meta.lifecycleOpId || null;

  await lifecycleStub.setLeadHarnessFailed(errorMessage);
  if (meta.status === "starting") {
    await lifecycleStub.noteRunnerStartFailed(opId, errorMessage);
    // Reconcile may have already turned startup into a generic failure before this
    // report arrives. Preserve the more specific harness error for the UI.
    await lifecycleStub.setError(errorMessage);
    const failedMeta = await projectAndPersistEnvSummary(c.env, hub, slug);
    return c.json({
      ok: true,
      slug,
      status: failedMeta?.status ?? "failed",
      leadHarnessStatus: "failed",
    });
  }

  if (startupFailureAlreadyRecorded) {
    await lifecycleStub.setError(errorMessage);
    const failedMeta = await projectAndPersistEnvSummary(c.env, hub, slug);
    return c.json({
      ok: true,
      slug,
      status: failedMeta?.status ?? "failed",
      leadHarnessStatus: "failed",
    });
  }

  await projectAndPersistEnvSummary(c.env, hub, slug);
  return c.json({ ok: true, slug, leadHarnessStatus: "failed" });
});

envRoutes.post("/api/envs/:slug/merge-into-main", async (c) => {
  const result = await startMergeIntoMainWorkflow(c.env, c.req.url, c.req.param("slug"));
  return c.json(result.body, result.status as any);
});

envRoutes.post("/api/envs/:slug/scm-operations/:operationId/progress", async (c) => {
  const body = await c.req.json<{ phase?: string }>().catch(() => ({}));
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

  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
  const store = getScmOperationStore(c.env, repo.meta.repoId);
  const operation = await store.getOperation(operationId);
  if (!operation || operation.envSlug !== slug || operation.type !== "merge-into-main") {
    return c.json({ error: "SCM operation not found" }, 404);
  }
  if (operation.status !== "pending") {
    return c.json({ error: "SCM operation is no longer pending" }, 409);
  }

  const body = await c.req.json<{ conflicts?: MergeConflictPayload[] }>().catch(() => ({}));
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

  const repo = await ensureRepoWorkspaceFromRepoUrl(c.env, meta.repoUrl);
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
  const slug = c.req.param("slug");
  const storedMeta = await readProjectedEnvMeta(c.env, slug);
  if (!storedMeta) return c.json({ error: "Not found" }, 404);
  const projectedMeta = storedMeta;
  if (isLifecycleStopInProgress(projectedMeta)) {
    return c.json({ error: getStopFinalizationInProgressError("deleting the environment") }, 409);
  }
  const backendKind = storedMeta.backend;
  const hostUnavailable = await requireHostConnection(
    c.env,
    backendKind,
    storedMeta.runnerMachineId ?? null,
  );
  if (hostUnavailable) {
    return c.json({ error: hostUnavailable }, 409);
  }
  const backend = await getRunnerBackend(c.env, backendKind);
  const { meta } = await projectEnvMetaForAction(c.env, projectedMeta, backend);
  const hub = getHub(c.env);
  const lifecycleStub = getEnvLifecycleStub(c.env, slug);
  await lifecycleStub.clearError();
  await lifecycleStub.setStatus("deleting", { clearLifecycle: true });
  const deletingMeta = await projectAndPersistEnvSummary(c.env, hub, slug);
  if (!deletingMeta) {
    return c.json({ error: "Environment state not found" }, 404);
  }

  c.executionCtx.waitUntil(
    (async () => {
      try {
        await destroyEnv(c.env, meta, hub);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[envs] Failed to delete runner for ${slug}:`, message);
        await lifecycleStub.setStatus("failed", { clearLifecycle: true });
        await lifecycleStub.setError(message);
        await projectAndPersistEnvSummary(c.env, hub, slug);
      }
    })(),
  );

  return c.json({ ok: true, slug, status: "deleting", message: "Environment deletion started" });
});

export default envRoutes;
