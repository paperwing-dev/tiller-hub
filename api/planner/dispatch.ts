import { getLocationHintOptions, getPlannerRunStub } from "../helpers";
import { isLocalOnlyRunnerBackendMode } from "../env/runner-backend";
import { resolveContainerHubUrl } from "../env/hub-url";
import { redactEnvValues } from "../redaction";
import { resolveCodexContainerAuth, resolveContainerAuth, resolveOpenCodeContainerAuth } from "../env/container-auth";
import { readRoutableHostService } from "../service-registry";
import { resolveProtectionState } from "../protection";
import { getBillingSelections, getIdleTimeoutMinutes, getSecret } from "../setup/config";
import { readAccessServiceCredential } from "../access/credentials";
import { mintPlanWriterRuntimeToken, mintPlannerRunToken } from "./runtime-token";
import type {
  Env,
  ExecutionPlacement,
  RunnerCommandClaim,
  RunnerControlAction,
} from "../types";
import type {
  ArtifactStoreDO,
  PlannerRun,
  PlannerRunRuntimeProvenance,
  PlanWriterRuntimeProvenance,
  ReviewerRegistryEntry,
} from "../coordination";
import { bridgeCredentialsToEnvVars, createGitHubBridgeRecord } from "../github/bridge";
import { canonicalizeGitHubRepo } from "../github/repo";
import { PLANNER_OPENCODE_MODEL } from "./opencode-model";
import { buildOpenCodeRuntimeEnv } from "../opencode/runtime-env";
import { planWriterTerminalId } from "./plan-writer-contract";
import {
  codexExecutionAuthMode,
  codexExecutionRuntimeMode,
  codexUnavailableReasonMessage,
  resolveCodexExecutionForEnv,
} from "../codex-execution";
import type { CodexExecutionProfile, CodexSurface } from "../types";
import { classifyHostRuntimeCompatibility } from "../setup/runtime-compatibility";
import { BillingResolutionError } from "../billing-resolution";
import {
  getPlannerModelCredentialRequirement,
} from "../../shared/harness-catalog";
import {
  resolveBillingCompatibility,
  type BillingMode,
  type BillingSelections,
  type ProviderControlledCredentialClass,
} from "../../shared/billing";
import {
  NEW_EXECUTION_UNAVAILABLE_MESSAGE,
  readExecutionStatus,
  resolveNewExecutionPlacement,
  selectionToPlacement,
} from "../execution";

// Dispatches one-shot reviewer runs to disposable containers. The run row is the
// complete job record before dispatch; the container reports back through the
// one-shot callback routes, which own all durable state transitions.

export type PlannerExecution =
  | { kind: "in-process" }
  | (ExecutionPlacement & {
      kind: "dispatched";
      claudeAuthMode?: BillingMode;
      codexExecutionProfile?: CodexExecutionProfile;
    })
  | { kind: "unavailable"; reason: string };

export type PlannerDispatchTarget = ExecutionPlacement & {
  claudeAuthMode?: BillingMode;
  codexExecutionProfile?: CodexExecutionProfile;
};

interface HubRunnerControl {
  requestLocalRunner(
    machineId: string | null,
    action: RunnerControlAction,
    slug: string,
    options: {
      repoUrl?: string;
      envVars?: Record<string, string>;
      commandGeneration?: number;
      operationId?: string;
      desiredState?: RunnerCommandClaim["desiredState"];
    },
  ): Promise<{ machineId: string; result: unknown }>;
}

function runtimeStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

function getHub(env: Env): HubRunnerControl {
  const hubId = env.HUB.idFromName("hub");
  return env.HUB.get(hubId, getLocationHintOptions(env)) as unknown as HubRunnerControl;
}

export function plannerJobSlug(runId: string): string {
  // Full sanitized run id — a truncated tail could collide, and the machine
  // runner removes any same-slug container before creating a new one.
  const sanitized = runId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `planner-${sanitized}`;
}

export function runnerJobCommand(
  jobSlug: string,
  desiredState: "running" | "absent",
): RunnerCommandClaim {
  const commandGeneration = desiredState === "running" ? 1 : 2;
  return {
    commandGeneration,
    operationId: `runner-job:${jobSlug}:${commandGeneration}:${desiredState}`,
    desiredState,
  };
}

async function hasSecret(env: Env, key: string): Promise<boolean> {
  const direct = (env as unknown as Record<string, unknown>)[key];
  if (typeof direct === "string" && direct.trim()) return true;
  return Boolean((await getSecret(env, key, { fresh: true }))?.trim());
}

async function hasWorkersAiCredentials(env: Env): Promise<boolean> {
  if (env.AI) return true;
  const [accountId, token] = await Promise.all([
    hasSecret(env, "TILLER_WORKERS_AI_ACCOUNT_ID"),
    hasSecret(env, "TILLER_WORKERS_AI_API_TOKEN"),
  ]);
  return accountId && token;
}

function developmentInProcessEnabled(env: Env): boolean {
  const enabled = (value: unknown) => value === "1" || value === "true";
  return enabled(env.LOCAL_DEV_ONLY_BACKEND) || enabled(env.TILLER_ENABLE_FAKE_PLANNER_PROVIDER);
}

async function providerTargetCompatibility(
  env: Env,
  providerId: string,
  target: ExecutionPlacement,
  codexSurface: Extract<CodexSurface, "plan-writer" | "plan-reviewer" | "environment-reviewer">,
  billingSelections: BillingSelections,
): Promise<
  | { compatible: true; claudeAuthMode?: BillingMode; codexExecutionProfile?: CodexExecutionProfile }
  | { compatible: false; reason: string }
> {
  if (providerId === "codex") {
    const selectedMode = billingSelections.openaiBillingMode;
    if (!selectedMode) {
      return { compatible: false, reason: "Select an OpenAI billing mode in Global Settings." };
    }
    if (target.backend === "host" && !isLocalOnlyRunnerBackendMode(env)) {
      const host = await readRoutableHostService(env, target.machineId).catch(() => null);
      if (!host) return { compatible: false, reason: NEW_EXECUTION_UNAVAILABLE_MESSAGE };
      if (
        host.runnerCommandProtocol !== 1
        || host.codexRuntimeAuthProtocol !== 1
        || !classifyHostRuntimeCompatibility(host).compatible
      ) {
        return {
          compatible: false,
          reason: NEW_EXECUTION_UNAVAILABLE_MESSAGE,
        };
      }
    }
    const resolution = await resolveCodexExecutionForEnv(env, {
      surface: codexSurface,
      backend: target.backend,
      authPreference: selectedMode === "subscription" ? "subscription" : "api-key",
    });
    return resolution.kind === "ready"
      ? { compatible: true, codexExecutionProfile: resolution.profile }
      : { compatible: false, reason: codexUnavailableReasonMessage(resolution) };
  }

  if (providerId === "claude-code") {
    const selectedMode = billingSelections.claudeBillingMode;
    if (!selectedMode) {
      return { compatible: false, reason: "Select a Claude billing mode in Global Settings." };
    }
    const configured = await hasSecret(
      env,
      selectedMode === "subscription" ? "CLAUDE_CODE_OAUTH_TOKEN" : "ANTHROPIC_API_KEY",
    );
    return configured
      ? { compatible: true, claudeAuthMode: selectedMode }
      : {
          compatible: false,
          reason: selectedMode === "subscription"
            ? "Configure the active Claude subscription token in Global Settings."
            : "Configure the active Claude API key in Global Settings.",
        };
  }

  if (providerId === "opencode") {
    return await hasWorkersAiCredentials(env)
      ? { compatible: true }
      : { compatible: false, reason: "OpenCode requires Workers AI credentials." };
  }

  return { compatible: false, reason: `Planner provider ${providerId} is not dispatchable.` };
}

// New workloads have exactly one selected placement. Compatibility failures
// are final and never cause a dispatch to the other backend.
async function resolvePlannerExecutionUsing(
  env: Env,
  providerId: string,
  options: {
    codexSurface?: Extract<CodexSurface, "plan-writer" | "plan-reviewer" | "environment-reviewer">;
    billingSelections?: BillingSelections;
  },
  readPlacement: () => Promise<ExecutionPlacement>,
): Promise<PlannerExecution> {
  if (providerId === "codex-api" || providerId === "fake") {
    return developmentInProcessEnabled(env)
      ? { kind: "in-process" }
      : { kind: "unavailable", reason: `${providerId} is only available in contributor development.` };
  }
  if (providerId !== "codex" && providerId !== "claude-code" && providerId !== "opencode") {
    return { kind: "unavailable", reason: `Planner provider ${providerId} is unavailable.` };
  }

  const billingSelections = providerId === "opencode"
    ? { claudeBillingMode: null, openaiBillingMode: null }
    : options.billingSelections ?? await getBillingSelections(env);
  let placement;
  try {
    placement = await readPlacement();
  } catch {
    return { kind: "unavailable", reason: NEW_EXECUTION_UNAVAILABLE_MESSAGE };
  }
  if (placement.backend === "cf" && !env.PLANNER_RUN) {
    return { kind: "unavailable", reason: NEW_EXECUTION_UNAVAILABLE_MESSAGE };
  }
  const target = placement;
  const compatibility = await providerTargetCompatibility(
    env,
    providerId,
    target,
    options.codexSurface ?? "plan-reviewer",
    billingSelections,
  );
  if (!compatibility.compatible) {
    return { kind: "unavailable", reason: compatibility.reason };
  }
  return {
    kind: "dispatched",
    ...target,
    ...(compatibility.claudeAuthMode
      ? { claudeAuthMode: compatibility.claudeAuthMode }
      : {}),
    ...(compatibility.codexExecutionProfile
      ? { codexExecutionProfile: compatibility.codexExecutionProfile }
      : {}),
  };
}

// This is a read-only projection for provider catalogs. It deliberately avoids
// the linearizable new-workload choice point.
export function inspectPlannerExecution(
  env: Env,
  providerId: string,
  options: {
    codexSurface?: Extract<CodexSurface, "plan-writer" | "plan-reviewer" | "environment-reviewer">;
    billingSelections?: BillingSelections;
  } = {},
): Promise<PlannerExecution> {
  return resolvePlannerExecutionUsing(env, providerId, options, async () => {
    const status = await readExecutionStatus(env);
    if (!status.executionReady) throw new Error(NEW_EXECUTION_UNAVAILABLE_MESSAGE);
    return selectionToPlacement(status.selected);
  });
}

// Only call this while creating a durable workload or dispatching a new
// standalone runtime.
export function resolvePlannerExecution(
  env: Env,
  providerId: string,
  options: {
    codexSurface?: Extract<CodexSurface, "plan-writer" | "plan-reviewer" | "environment-reviewer">;
    billingSelections?: BillingSelections;
  } = {},
): Promise<PlannerExecution> {
  return resolvePlannerExecutionUsing(
    env,
    providerId,
    options,
    () => resolveNewExecutionPlacement(env),
  );
}

export async function buildCfAccessEnvVars(env: Env, requestUrl: string): Promise<Record<string, string>> {
  const protection = await resolveProtectionState(env, requestUrl);
  if (protection.protectionMode !== "cf-access") return {};
  const credential = await readAccessServiceCredential(env, protection.hubUrl);
  const clientId = credential?.clientId ?? "";
  const clientSecret = credential?.clientSecret ?? "";
  return {
    ...(clientId ? { CF_ACCESS_CLIENT_ID: clientId } : {}),
    ...(clientSecret ? { CF_ACCESS_CLIENT_SECRET: clientSecret } : {}),
  };
}

export async function buildProviderAuthEnvVars(
  env: Env,
  selection: Pick<PlannerRun, "provider" | "model">,
  target: PlannerDispatchTarget,
  hubUrl: string,
): Promise<Record<string, string>> {
  if (selection.provider === "opencode" && selection.model !== PLANNER_OPENCODE_MODEL.binding.model) {
    throw new Error(`Unsupported planner OpenCode model: ${selection.model}`);
  }
  const requirement = getPlannerModelCredentialRequirement(selection.provider, selection.model);
  if (!requirement) {
    throw new Error(`Unknown ${selection.provider} planner model: ${selection.model}`);
  }
  let resolvedMode: BillingMode | null = null;
  if (requirement !== "workers-ai") {
    const credential = requirement as ProviderControlledCredentialClass;
    const pinnedMode = selection.provider === "claude-code"
      ? target.claudeAuthMode ?? null
      : target.codexExecutionProfile
        ? codexExecutionAuthMode(target.codexExecutionProfile) === "subscription" ? "subscription" : "api"
        : null;
    if (!pinnedMode) {
      throw new Error("Planner launch billing provenance is missing.");
    }
    const compatibility = resolveBillingCompatibility(
      credential,
      pinnedMode,
    );
    if (compatibility.kind === "billing-mode-unselected") {
      throw new BillingResolutionError(
        "billing-mode-unselected",
        `Select a billing mode for ${selection.provider === "claude-code" ? "Claude" : "OpenAI"} in Global Settings.`,
      );
    }
    if (compatibility.kind === "incompatible-billing-mode") {
      throw new BillingResolutionError(
        "incompatible-billing-mode",
        `${selection.model} requires ${selection.provider === "claude-code" ? "Claude" : "OpenAI"} API mode.`,
      );
    }
    resolvedMode = compatibility.mode;
  }
  if (selection.provider === "codex") {
    const profile = target.codexExecutionProfile;
    if (!profile) throw new Error("Codex planner launch profile is missing.");
    const authMode = codexExecutionAuthMode(profile);
    const runtimeMode = codexExecutionRuntimeMode(profile);
    if (profile.kind === "subscription-app-server") {
      return {
        TILLER_CODEX_RUNTIME_MODE: runtimeMode,
        TILLER_CODEX_AUTH_MODE: authMode,
      };
    }
    const auth = await resolveCodexContainerAuth(env, {
      authPreference: "api-key",
    });
    return {
      ...auth.envVars,
      TILLER_CODEX_AUTH_MODE: authMode,
      TILLER_CODEX_RUNTIME_MODE: runtimeMode,
    };
  }
  if (selection.provider === "claude-code") {
    if (!resolvedMode) throw new Error("Claude planner launch is missing its claimed billing mode.");
    const auth = await resolveContainerAuth(env, { backend: target.backend, requested: resolvedMode });
    return {
      ...auth.envVars,
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      TILLER_CLAUDE_AUTH_RESOLVED_MODE: auth.resolvedAuthMode,
    };
  }
  if (selection.provider === "opencode") {
    // OpenCode authenticates through the hub's model proxy; the container
    // builds its provider config from these (entrypoint's interactive block
    // does not run for planner containers).
    const model = PLANNER_OPENCODE_MODEL;
    const auth = await resolveOpenCodeContainerAuth(env, model);
    return buildOpenCodeRuntimeEnv({
      model,
      auth,
      proxyBaseUrl: `${hubUrl}/api/opencode/v1`,
    });
  }
  throw new Error(`Planner provider is not dispatchable yet: ${selection.provider}`);
}

export interface PlannerRepoRuntimeSource {
  repoId: string;
  repoUrl: string;
  githubFullName?: string | null;
  githubBaseCommitSha: string | null;
}

async function buildPlannerGitHubEnvVars(
  env: Env,
  repo: PlannerRepoRuntimeSource,
  jobSlug: string,
): Promise<Record<string, string>> {
  if (!repo.githubBaseCommitSha) {
    throw new Error("Repository default branch head is unavailable.");
  }
  const githubFullName = repo.githubFullName?.trim()
    || canonicalizeGitHubRepo(repo.repoUrl).fullName;
  const githubBridge = await createGitHubBridgeRecord(env, {
    subject: {
      type: "github-planner",
      jobSlug,
      repoId: repo.repoId,
    },
    githubFullName,
  });
  return {
    REPO_URL: repo.repoUrl,
    TILLER_GITHUB_BASE_COMMIT_SHA: repo.githubBaseCommitSha,
    ...bridgeCredentialsToEnvVars(githubBridge),
  };
}

export interface DispatchPlannerRunOptions {
  env: Env;
  requestUrl: string;
  artifactStore: ArtifactStoreDO;
  run: PlannerRun;
  repo: PlannerRepoRuntimeSource;
}

// Starts the container for a queued run. Public status stays `queued` until
// the container posts runtime_startup. Any failure here must fully clean up:
// a run stuck `queued` would otherwise wait for the watchdog and block the
// one-active-run rule for its whole timeout.
export async function dispatchPlannerRun(options: DispatchPlannerRunOptions): Promise<void> {
  const { env, artifactStore, run } = options;
  const jobSlug = plannerJobSlug(run.runId);
  let runtime: PlannerRunRuntimeProvenance | null = null;
  let launchEnvVars: Record<string, string> = {};
  try {
    const launch = run.launchProvenance;
    if (!launch) throw new Error("Planner run launch provenance is missing.");
    const target: PlannerDispatchTarget = {
      backend: launch.backend,
      machineId: launch.machineId,
      ...(launch.claudeAuthMode ? { claudeAuthMode: launch.claudeAuthMode } : {}),
      ...(launch.codexExecution ? { codexExecutionProfile: launch.codexExecution } : {}),
    };
    runtime = { jobSlug };
    if (run.role !== "reviewer") {
      throw new Error("Only one-shot reviewer runs use the planner-run dispatcher.");
    }
    const hubUrl = await resolveContainerHubUrl(env, options.requestUrl, target.backend);
    const runToken = await mintPlannerRunToken(env, run.runId);
    const authEnvVars = await buildProviderAuthEnvVars(
      env,
      run,
      target,
      hubUrl,
    );
    const gitHubEnvVars = await buildPlannerGitHubEnvVars(
      env,
      {
        ...options.repo,
        githubBaseCommitSha: run.input?.githubBaseCommitSha ?? options.repo.githubBaseCommitSha ?? null,
      },
      jobSlug,
    );
    launchEnvVars = {
      TILLER_BOOTSTRAP_MODE: "planner-run",
      TILLER_HARNESS: run.provider,
      HUB_URL: hubUrl,
      TILLER_PLANNER_CALLBACK_BASE:
        `${hubUrl}/api/planner-runtime/repos/${encodeURIComponent(run.repoId)}/runs/${encodeURIComponent(run.runId)}`,
      TILLER_PLANNER_RUN_TOKEN: runToken,
      ...gitHubEnvVars,
      ...authEnvVars,
      ...(await buildCfAccessEnvVars(env, options.requestUrl)),
    };

    const claimed = await artifactStore.claimPlannerRunRuntime(run.runId, runtime);
    if (!claimed) {
      const current = await artifactStore.getPlannerRun(run.runId);
      if (!current || (current.status !== "queued" && current.status !== "running" && current.status !== "saving")) {
        await destroyPlannerJob(env, runtime, launch).catch(() => undefined);
      }
      return;
    }
    if (target.backend === "cf") {
      await getPlannerRunStub(env, jobSlug).startPlannerJob(launchEnvVars);
    } else {
      const created = await getHub(env).requestLocalRunner(target.machineId, "create", jobSlug, {
        repoUrl: options.repo.repoUrl,
        envVars: launchEnvVars,
        ...runnerJobCommand(jobSlug, "running"),
      });
      if (created.machineId !== target.machineId) {
        throw new Error("The execution machine did not match the run’s stored placement.");
      }
    }
    const current = await artifactStore.getPlannerRun(run.runId);
    if (!current || (current.status !== "queued" && current.status !== "running" && current.status !== "saving")) {
      if (current?.runtime) {
        await cleanupPlannerRunRuntime(env, artifactStore, current).catch(() => undefined);
      } else {
        await destroyPlannerJob(env, runtime, launch).catch(() => undefined);
      }
    }
  } catch (error) {
    const message = redactEnvValues(
      error instanceof Error ? error.message : String(error),
      launchEnvVars,
    );
    console.error(`[planner] dispatch failed for run ${run.runId}: ${message}`);
    let failed: PlannerRun | null = null;
    try {
      failed = await artifactStore.updateActivePlannerRun({
        runId: run.runId,
        status: "failed",
        completedAt: new Date().toISOString(),
        error: message,
      });
    } catch {
      // Best effort: the watchdog remains the backstop.
    }
    if (failed?.status === "failed") {
      try {
        await artifactStore.appendPlannerRunEvent({
          runId: run.runId,
          repoId: run.repoId,
          planArtifactId: run.planArtifactId,
          type: "run_failed",
          message,
        });
      } catch {
        // The failed run row is authoritative.
      }
    }
    if (run.threadId && failed?.status === "failed") {
      try {
        await artifactStore.updateReviewerRunStateIfCurrent({
          repoId: run.repoId,
          planArtifactId: run.planArtifactId,
          threadId: run.threadId,
          runId: run.runId,
          status: "failed",
          error: message,
        });
      } catch {
        // Best effort: the reviewer tab may have been removed.
      }
    }
    if (runtime) {
      let cleanupRun = failed;
      if (!cleanupRun) {
        try {
          cleanupRun = await artifactStore.getPlannerRun(run.runId);
        } catch {
          cleanupRun = null;
        }
      }
      if (cleanupRun?.runtime) {
        await cleanupPlannerRunRuntime(env, artifactStore, cleanupRun).catch(() => undefined);
      } else {
        await destroyPlannerJob(env, runtime, run.launchProvenance!).catch(() => undefined);
      }
    }
  }
}

export async function destroyPlannerJob(
  env: Env,
  runtime: PlannerRunRuntimeProvenance,
  placement: ExecutionPlacement,
): Promise<void> {
  try {
    if (placement.backend === "host") {
      await getHub(env).requestLocalRunner(placement.machineId, "destroy", runtime.jobSlug, {
        ...runnerJobCommand(runtime.jobSlug, "absent"),
      });
    } else {
      await getPlannerRunStub(env, runtime.jobSlug).destroyPlannerJob();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/404|not found/i.test(message)) throw error;
  }
}

/** Destroys only the exact retained generation-scoped Plan Writer runtime. */
export async function destroyPlanWriterRuntime(
  env: Env,
  runtime: PlanWriterRuntimeProvenance,
  placement: ExecutionPlacement,
): Promise<void> {
  try {
    if (placement.backend === "host") {
      await getHub(env).requestLocalRunner(placement.machineId, "destroy", runtime.jobSlug, {
        ...runnerJobCommand(runtime.jobSlug, "absent"),
      });
    } else {
      await getPlannerRunStub(env, runtime.jobSlug).destroyPlanWriterRuntime(runtime.jobSlug);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/404|not found/i.test(message)) throw error;
  }
}

/** Read-only exact-generation liveness check used only by explicit Start. */
export async function inspectPlanWriterRuntime(
  env: Env,
  runtime: PlanWriterRuntimeProvenance,
  placement: ExecutionPlacement,
): Promise<boolean> {
  if (placement.backend === "cf") {
    const inspected = await getPlannerRunStub(env, runtime.jobSlug).inspectPlanWriterRuntime(runtime.jobSlug);
    return inspected.registered === true && inspected.live === true && inspected.jobSlug === runtime.jobSlug;
  }
  try {
    const inspected = await getHub(env).requestLocalRunner(
      placement.machineId,
      "status",
      runtime.jobSlug,
      {},
    );
    return runtimeStatus(inspected.result) === "running";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/404|not found|runner_not_found/i.test(message)) return false;
    throw error;
  }
}

export async function cleanupPlanWriterRuntime(
  env: Env,
  artifactStore: ArtifactStoreDO,
  writer: ReviewerRegistryEntry,
): Promise<ReviewerRegistryEntry | null> {
  if (!writer.runtime) return writer;
  if (writer.provider !== "claude-code" && writer.provider !== "codex") {
    throw new Error(`Invalid Plan Writer provider: ${writer.provider}`);
  }
  if (!writer.launchProvenance) {
    throw new Error("Plan Writer launch provenance is missing.");
  }
  await destroyPlanWriterRuntime(env, writer.runtime, writer.launchProvenance);
  return await artifactStore.clearPlanWriterRuntimeIfCurrent(writer.threadId, writer.runtime);
}

// Cleanup for cancel, terminal results, and the watchdog. Best-effort: a
// missing container is success, and `docker run` without --rm means success
// paths must call this too or exited containers accumulate on the runner.
// One-shot reviewer runs only. Plan Writer runtime cleanup has its own path.
export async function cleanupPlannerRunRuntime(
  env: Env,
  artifactStore: ArtifactStoreDO,
  run: PlannerRun,
): Promise<PlannerRun | null> {
  const runtime = run.runtime;
  if (!runtime) return run;
  if (!run.launchProvenance) {
    throw new Error("Planner run launch provenance is missing.");
  }
  await destroyPlannerJob(env, runtime, run.launchProvenance);
  return await artifactStore.clearPlannerRunRuntimeIfCurrent(run.runId, runtime);
}

export interface EnsurePlanWriterRuntimeOptions {
  env: Env;
  requestUrl: string;
  artifactStore: ArtifactStoreDO;
  writer: ReviewerRegistryEntry;
  repo: PlannerRepoRuntimeSource;
}

function planWriterStartupDeadlineMs(env: Env): number {
  const configured = Number(env.TILLER_PLAN_WRITER_WATCHDOG_MS);
  return Number.isFinite(configured) && configured >= 60_000
    ? Math.floor(configured)
    : 28_800_000;
}

/**
 * Launches the generation-scoped Plan Writer supervisor. Runtime provenance
 * is persisted before the external create so Stop can always target the exact
 * placement, including while the provider is still starting.
 */
export async function ensurePlanWriterRuntime(
  options: EnsurePlanWriterRuntimeOptions,
): Promise<ReviewerRegistryEntry> {
  const { env, artifactStore, writer } = options;
  if (writer.role !== "writer" || writer.stoppedAt || !writer.generation || !writer.basisCommit) {
    throw new Error("The plan writer generation is not startable.");
  }
  if (writer.provider !== "claude-code" && writer.provider !== "codex") {
    throw new Error("Plan Writer supports only the Claude Code and Codex native TUI adapters.");
  }
  if (writer.runtime) return writer;
  const launch = writer.launchProvenance;
  if (!launch) {
    throw new Error("Plan Writer launch provenance is missing.");
  }
  const execution: PlannerDispatchTarget = {
    backend: launch.backend,
    machineId: launch.machineId,
    ...(launch.claudeAuthMode ? { claudeAuthMode: launch.claudeAuthMode } : {}),
    ...(launch.codexExecution ? { codexExecutionProfile: launch.codexExecution } : {}),
  };
  const generation = writer.generation;
  const terminalId = planWriterTerminalId(writer.repoId, writer.planArtifactId, generation);
  const jobSlug = terminalId;
  const hubUrl = await resolveContainerHubUrl(env, options.requestUrl, execution.backend);
  const providerSelection = {
    provider: writer.provider,
    model: writer.model,
  };
  const idleMs = execution.backend === "cf"
    ? (await getIdleTimeoutMinutes(env)) * 60_000
    : 0;
  const envVars: Record<string, string> = {
    TILLER_BOOTSTRAP_MODE: "plan-writer",
    TILLER_HARNESS: writer.provider,
    TILLER_PLAN_WRITER_REPO_ID: writer.repoId,
    TILLER_PLAN_WRITER_ARTIFACT_ID: writer.planArtifactId,
    TILLER_PLAN_WRITER_GENERATION: String(generation),
    TILLER_PLAN_WRITER_BASIS_COMMIT: writer.basisCommit,
    TILLER_PLAN_WRITER_TERMINAL_ID: terminalId,
    TILLER_PLAN_WRITER_CALLBACK_BASE:
      `${hubUrl}/api/planner-runtime/repos/${encodeURIComponent(writer.repoId)}/plans/${encodeURIComponent(writer.planArtifactId)}/writers/${generation}`,
    TILLER_PLAN_WRITER_TOKEN: await mintPlanWriterRuntimeToken(
      env,
      writer.repoId,
      writer.planArtifactId,
      generation,
    ),
    TILLER_PLAN_WRITER_IDLE_MS: String(idleMs),
    TILLER_PLAN_WRITER_WATCHDOG_MS: String(planWriterStartupDeadlineMs(env)),
    HUB_URL: hubUrl,
    NAMESPACE: "hub",
    ...(await buildPlannerGitHubEnvVars(env, {
      ...options.repo,
      githubBaseCommitSha: writer.basisCommit,
    }, jobSlug)),
    ...(await buildProviderAuthEnvVars(env, providerSelection, execution, hubUrl)),
    ...(await buildCfAccessEnvVars(env, options.requestUrl)),
  };
  const runtime: PlanWriterRuntimeProvenance = {
    jobSlug,
    generation: generation,
  };
  const claimed = await artifactStore.setPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
  if (!claimed) {
    const current = await artifactStore.getPlanWriter(writer.repoId, writer.planArtifactId);
    if (current && current.generation === generation && current.runtime) return current;
    throw new Error("The writer generation changed before runtime launch.");
  }
  try {
    if (execution.backend === "cf") {
      await getPlannerRunStub(env, jobSlug).ensurePlanWriterRuntime(jobSlug, envVars);
    } else {
      const created = await getHub(env).requestLocalRunner(execution.machineId, "create", jobSlug, {
        repoUrl: options.repo.repoUrl,
        envVars,
        ...runnerJobCommand(jobSlug, "running"),
      });
      if (created.machineId !== execution.machineId) {
        throw new Error("The execution machine did not match the writer’s stored placement.");
      }
    }
  } catch (error) {
    const launchMessage = redactEnvValues(
      error instanceof Error ? error.message : String(error),
      envVars,
    );
    try {
      await destroyPlanWriterRuntime(env, runtime, launch);
      await artifactStore.clearPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    } catch (cleanupError) {
      const cleanupMessage = redactEnvValues(
        cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
        envVars,
      );
      await artifactStore.setPlanWriterError({
        repoId: writer.repoId,
        planArtifactId: writer.planArtifactId,
        generation,
        kind: "cleanup",
        error: cleanupMessage,
      });
      throw new Error(
        `${launchMessage} Cleanup failed: ${cleanupMessage}`,
      );
    }
    throw new Error(launchMessage);
  }
  const current = await artifactStore.getPlanWriter(writer.repoId, writer.planArtifactId);
  const currentRuntime = current?.runtime;
  if (
    !current
    || current.stoppedAt
    || current.generation !== generation
    || currentRuntime?.jobSlug !== runtime.jobSlug
    || currentRuntime?.generation !== runtime.generation
  ) {
    try {
      await destroyPlanWriterRuntime(env, runtime, launch);
      await artifactStore.clearPlanWriterRuntimeIfCurrent(writer.threadId, runtime);
    } catch (cleanupError) {
      const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      await artifactStore.setPlanWriterError({
        repoId: writer.repoId,
        planArtifactId: writer.planArtifactId,
        generation,
        kind: "cleanup",
        error: cleanupMessage,
      });
      throw new Error(`Late Plan Writer runtime cleanup failed: ${cleanupMessage}`);
    }
    throw new Error("The writer generation changed during runtime launch; the late runtime was destroyed.");
  }
  return current;
}
