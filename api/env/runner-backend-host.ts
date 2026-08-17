import {
  getRunnerCurrentCommandGeneration,
  getRunnerControlErrorCode,
  RunnerBackendControlError,
  classifyRunnerInspection,
  type RunnerBackend,
  type RunnerDestroyOptions,
  type RunnerStartOptions,
  type RunnerStopOptions,
} from "./runner-backend";
import type {
  Env,
  EnvMeta,
  RunnerCommandClaim,
  RunnerCommandDesiredState,
  RunnerControlAction,
} from "../types";
import { EXISTING_EXECUTION_UNAVAILABLE_MESSAGE } from "../execution";
import { getDurableObjectStub } from "../durable-object";

interface HostRunnerStatus {
  runnerId?: string;
  status?: string;
  callbackExpected?: boolean;
  startRejectedBeforeWorkspace?: boolean;
  failedStartBeforeHarness?: boolean;
  commandGeneration?: number;
  operationId?: string;
  desiredState?: RunnerCommandDesiredState;
}

interface HubRunnerControl {
  requestLocalRunner(
    machineId: string | null,
    action: RunnerControlAction,
    slug: string,
    options?: {
      repoUrl?: string;
      envVars?: Record<string, string>;
      commandGeneration?: number;
      operationId?: string;
      desiredState?: RunnerCommandDesiredState;
    },
  ): Promise<{ machineId: string; result: unknown }>;
}

function getHub(env: Env): HubRunnerControl {
  return getDurableObjectStub<HubRunnerControl>(env, env.HUB, "hub");
}

function parseHostRunnerStatus(value: unknown): HostRunnerStatus {
  if (!value || typeof value !== "object") return {};
  const result = value as Record<string, unknown>;
  return {
    ...(typeof result.runnerId === "string" ? { runnerId: result.runnerId } : {}),
    ...(typeof result.status === "string" ? { status: result.status } : {}),
    ...(typeof result.callbackExpected === "boolean" ? { callbackExpected: result.callbackExpected } : {}),
    ...(result.startRejectedBeforeWorkspace === true ? { startRejectedBeforeWorkspace: true } : {}),
    ...(result.failedStartBeforeHarness === true ? { failedStartBeforeHarness: true } : {}),
    ...(Number.isSafeInteger(result.commandGeneration) ? { commandGeneration: result.commandGeneration as number } : {}),
    ...(typeof result.operationId === "string" ? { operationId: result.operationId.trim() } : {}),
    ...(result.desiredState === "running" || result.desiredState === "stopped" || result.desiredState === "absent"
      ? { desiredState: result.desiredState }
      : {}),
  };
}

function requireRunnerCommandAcknowledgement(
  result: HostRunnerStatus,
  expected: RunnerCommandClaim,
): void {
  if (
    result.commandGeneration !== expected.commandGeneration
    || result.operationId !== expected.operationId
    || result.desiredState !== expected.desiredState
  ) {
    throw new RunnerBackendControlError(
      EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
      "runner_command_conflict",
    );
  }
}

function resolveRunnerMachineId(meta: Pick<EnvMeta, "executionPlacement">): string {
  if (meta.executionPlacement.backend !== "host") {
    throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
  }
  return meta.executionPlacement.machineId;
}

function isConfirmedRunnerNotFound(error: unknown): boolean {
  return getRunnerControlErrorCode(error) === "runner_not_found";
}

function normalizeRunnerCommand(
  command: RunnerCommandClaim | null | undefined,
  expectedDesiredState: RunnerCommandDesiredState,
  lifecycleOpId?: string | null,
): RunnerCommandClaim {
  const operationId = command?.operationId?.trim();
  if (
    !command
    || !Number.isSafeInteger(command.commandGeneration)
    || command.commandGeneration <= 0
    || !operationId
    || command.desiredState !== expectedDesiredState
  ) {
    throw new Error(
      `Your machine ${expectedDesiredState} mutation requires a positive command generation, operation ID, and desired state.`,
    );
  }
  const normalizedLifecycleOpId = lifecycleOpId?.trim();
  if (normalizedLifecycleOpId && normalizedLifecycleOpId !== operationId) {
    throw new Error("Your machine lifecycle operation ID must match the runner command operation ID.");
  }
  return {
    commandGeneration: command.commandGeneration,
    operationId,
    desiredState: expectedDesiredState,
  };
}

function wrapHostRunnerError(prefix: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const code = getRunnerControlErrorCode(error);
  if (code) {
    const candidate = error && typeof error === "object"
      ? error as { currentCommandGeneration?: unknown; currentCommandGenerationInvalid?: unknown }
      : null;
    const typedGeneration = candidate?.currentCommandGenerationInvalid === true
      ? null
      : candidate
        && "currentCommandGeneration" in candidate
        && candidate.currentCommandGeneration !== undefined
        ? candidate.currentCommandGeneration
        : getRunnerCurrentCommandGeneration(error) ?? undefined;
    return new RunnerBackendControlError(
      `${prefix}: ${message}`,
      code,
      error,
      typedGeneration,
    );
  }
  if (message === EXISTING_EXECUTION_UNAVAILABLE_MESSAGE) {
    const unavailable = new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    Object.defineProperty(unavailable, "cause", { value: error, configurable: true });
    return unavailable;
  }
  const wrapped = new Error(`${prefix}: ${message}`);
  Object.defineProperty(wrapped, "cause", { value: error, configurable: true });
  return wrapped;
}

async function requestHostRunner(
  env: Env,
  action: RunnerControlAction,
  meta: Pick<EnvMeta, "slug" | "repoUrl" | "executionPlacement">,
  options?: {
    envVars?: Record<string, string>;
    runnerCommand?: RunnerCommandClaim;
  },
): Promise<{ machineId: string; result: unknown }> {
  return getHub(env).requestLocalRunner(resolveRunnerMachineId(meta), action, meta.slug, {
    ...(options?.envVars ? { envVars: options.envVars } : {}),
    ...(action === "create" || action === "start" ? { repoUrl: meta.repoUrl } : {}),
    ...(options?.runnerCommand ? options.runnerCommand : {}),
  });
}

export async function createHostRunnerBackend(env: Env): Promise<RunnerBackend> {
  const inspect = async (meta: EnvMeta) => {
    try {
      const response = await requestHostRunner(env, "status", meta);
      const result = parseHostRunnerStatus(response.result);
      const inspection = classifyRunnerInspection(result.status);
      if (
        inspection.state === "stopped"
        && result.failedStartBeforeHarness
        && Number.isSafeInteger(result.commandGeneration)
        && (result.commandGeneration ?? 0) > 0
        && result.operationId
      ) {
        return {
          ...inspection,
          safeReplacement: {
            reason: "failed_before_harness" as const,
            operationId: result.operationId,
            commandGeneration: result.commandGeneration!,
          },
        };
      }
      return inspection;
    } catch (error) {
      if (isConfirmedRunnerNotFound(error)) {
        return { state: "absent" as const, status: "absent" };
      }
      return { state: "unknown" as const, status: "unknown" };
    }
  };

  return {
    kind: "host",

    async create(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: RunnerStartOptions,
    ): Promise<EnvMeta> {
      const runnerCommand = normalizeRunnerCommand(options?.runnerCommand, "running", options?.startOpId);
      try {
        const response = await requestHostRunner(env, "create", meta, {
          envVars,
          runnerCommand,
        });
        const result = parseHostRunnerStatus(response.result);
        requireRunnerCommandAcknowledgement(result, runnerCommand);
        if (response.machineId !== meta.executionPlacement.machineId) {
          throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
        }
        const runnerId = result.runnerId ?? meta.runnerId ?? meta.slug;
        return {
          ...meta,
          backend: "host",
          runnerId,
        };
      } catch (error) {
        throw wrapHostRunnerError("Your machine create failed", error);
      }
    },

    async getStatus(meta: EnvMeta): Promise<string> {
      return (await inspect(meta)).status;
    },

    inspect,

    async start(
      meta: EnvMeta,
      envVars: Record<string, string>,
      options?: RunnerStartOptions,
    ): Promise<EnvMeta> {
      const runnerCommand = normalizeRunnerCommand(options?.runnerCommand, "running", options?.startOpId);
      try {
        const response = await requestHostRunner(env, "start", meta, {
          envVars,
          runnerCommand,
        });
        const result = parseHostRunnerStatus(response.result);
        requireRunnerCommandAcknowledgement(result, runnerCommand);
        if (response.machineId !== meta.executionPlacement.machineId) {
          throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
        }
        const runnerId = result.runnerId ?? meta.runnerId ?? meta.slug;
        return {
          ...meta,
          backend: "host",
          runnerId,
        };
      } catch (error) {
        throw wrapHostRunnerError("Your machine start failed", error);
      }
    },

    async stop(meta: EnvMeta, options?: RunnerStopOptions) {
      const runnerCommand = normalizeRunnerCommand(options?.runnerCommand, "stopped", options?.stopOpId);
      try {
        const response = await requestHostRunner(env, "stop", meta, {
          runnerCommand,
        });
        const result = parseHostRunnerStatus(response.result);
        requireRunnerCommandAcknowledgement(result, runnerCommand);
        return {
          callbackExpected: result.callbackExpected ?? true,
          ...(result.startRejectedBeforeWorkspace ? { startRejectedBeforeWorkspace: true } : {}),
        };
      } catch (error) {
        if (isConfirmedRunnerNotFound(error)) {
          return { callbackExpected: false };
        }
        throw wrapHostRunnerError("Your machine stop failed", error);
      }
    },

    async destroy(meta: EnvMeta, options?: RunnerDestroyOptions): Promise<void> {
      const runnerCommand = normalizeRunnerCommand(options?.runnerCommand, "absent");
      try {
        const response = await requestHostRunner(env, "destroy", meta, { runnerCommand });
        requireRunnerCommandAcknowledgement(parseHostRunnerStatus(response.result), runnerCommand);
      } catch (error) {
        if (isConfirmedRunnerNotFound(error)) {
          return;
        }
        throw wrapHostRunnerError("Your machine destroy failed", error);
      }
    },
  };
}
