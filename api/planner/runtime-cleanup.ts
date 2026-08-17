import { getPlannerRunStub } from "../helpers";
import type {
  Env,
  ExecutionPlacement,
  RunnerCommandClaim,
  RunnerControlAction,
} from "../types";
import type { ArtifactStoreDO } from "../coordination/artifact-store-do";
import type {
  PlannerRun,
  PlanRuntimeCleanupTarget,
  PlannerRunRuntimeProvenance,
  PlanWriterRuntimeProvenance,
} from "../coordination/types";
import { getDurableObjectStub } from "../durable-object";
import { getRunnerControlErrorCode } from "../env/runner-backend";
import { planWriterTerminalId } from "./plan-writer-contract";

interface HubRunnerCleanupControl {
  requestLocalRunner(
    machineId: string | null,
    action: RunnerControlAction,
    slug: string,
    options: {
      commandGeneration?: number;
      operationId?: string;
      desiredState?: RunnerCommandClaim["desiredState"];
    },
  ): Promise<{ machineId: string; result: unknown }>;
  revokePlanWriterTerminal(
    sessionId: string,
    repoId: string,
    planArtifactId: string,
    generation: number,
  ): void | Promise<void>;
  broadcastPlanWriterState(repoId: string, planArtifactId: string): void | Promise<void>;
}

function getHub(env: Env): HubRunnerCleanupControl {
  return getDurableObjectStub<HubRunnerCleanupControl>(env, env.HUB, "hub");
}

function runtimeStatus(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
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

function requireRunnerJobDestroyAcknowledgement(
  result: unknown,
  expected: RunnerCommandClaim,
): void {
  if (!result || typeof result !== "object") {
    throw new Error("Your machine returned an invalid workload cleanup acknowledgement.");
  }
  const acknowledgement = result as Record<string, unknown>;
  if (
    acknowledgement.commandGeneration !== expected.commandGeneration
    || acknowledgement.operationId !== expected.operationId
    || acknowledgement.desiredState !== expected.desiredState
  ) {
    throw new Error("Your machine did not confirm the exact workload cleanup command.");
  }
}

async function destroyHostRunnerJob(
  env: Env,
  placement: Extract<ExecutionPlacement, { backend: "host" }>,
  jobSlug: string,
): Promise<void> {
  const command = runnerJobCommand(jobSlug, "absent");
  try {
    const response = await getHub(env).requestLocalRunner(
      placement.machineId,
      "destroy",
      jobSlug,
      command,
    );
    if (response.machineId !== placement.machineId) {
      throw new Error("Your machine did not match the workload cleanup target.");
    }
    requireRunnerJobDestroyAcknowledgement(response.result, command);
  } catch (error) {
    if (getRunnerControlErrorCode(error) === "runner_not_found") return;
    throw error;
  }
}

export async function destroyPlannerJob(
  env: Env,
  runtime: PlannerRunRuntimeProvenance,
  placement: ExecutionPlacement,
): Promise<void> {
  if (placement.backend === "host") {
    await destroyHostRunnerJob(env, placement, runtime.jobSlug);
    return;
  }
  await getPlannerRunStub(env, runtime.jobSlug).destroyPlannerJob();
}

/** Destroys only the exact retained generation-scoped Plan Writer runtime. */
export async function destroyPlanWriterRuntime(
  env: Env,
  runtime: PlanWriterRuntimeProvenance,
  placement: ExecutionPlacement,
): Promise<void> {
  if (placement.backend === "host") {
    await destroyHostRunnerJob(env, placement, runtime.jobSlug);
    return;
  }
  await getPlannerRunStub(env, runtime.jobSlug).destroyPlanWriterRuntime(runtime.jobSlug);
}

/** Performs only the external side of an immutable cleanup intent. */
export async function executePlanRuntimeCleanupTarget(
  env: Env,
  target: PlanRuntimeCleanupTarget,
): Promise<void> {
  const placement =
    target.schemaVersion === 2 ? target.placement : target.launchProvenance;
  if (target.kind === "reviewer") {
    await destroyPlannerJob(env, target.runtime, placement!);
    return;
  }

  const hub = getHub(env);
  const terminalId = planWriterTerminalId(
    target.repoId,
    target.planArtifactId,
    target.generation,
  );
  await hub.revokePlanWriterTerminal(
    terminalId,
    target.repoId,
    target.planArtifactId,
    target.generation,
  );
  if (target.runtime && placement) {
    await destroyPlanWriterRuntime(env, target.runtime, placement);
  }
}

/** Executes and acknowledges one persisted cleanup intent. */
export async function cleanupPlanRuntimeTarget(
  env: Env,
  artifactStore: ArtifactStoreDO,
  target: PlanRuntimeCleanupTarget,
): Promise<void> {
  try {
    await executePlanRuntimeCleanupTarget(env, target);
    await artifactStore.completePlanRuntimeCleanup(target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await artifactStore.recordPlanRuntimeCleanupFailure(target, message);
    if (target.kind === "writer") {
      await Promise.resolve(getHub(env).broadcastPlanWriterState(
        target.repoId,
        target.planArtifactId,
      )).catch(() => undefined);
    }
    throw error;
  }
  if (target.kind === "writer") {
    await Promise.resolve(getHub(env).broadcastPlanWriterState(
      target.repoId,
      target.planArtifactId,
    )).catch(() => undefined);
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
    if (getRunnerControlErrorCode(error) === "runner_not_found") return false;
    throw error;
  }
}

// Cleanup for cancel, terminal results, and the watchdog. Best-effort: a
// missing container is success, and `docker run` without --rm means success
// paths must call this too or exited containers accumulate on the runner.
// One-shot reviewer runs only. Plan Writer cleanup is owned by durable targets.
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
