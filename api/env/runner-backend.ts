import type {
  Env,
  EnvMeta,
  RunnerCommandClaim,
  RunnerControlErrorCode,
} from "../types";
import { isEnabledFlag } from "../../shared/local-dev";

export type RunnerBackendKind = "cf" | "host";

export interface EnvironmentRuntimeScope {
  envSlug: string;
  incarnationId: string;
  startOperationId: string;
}

export interface EnvironmentStopScope extends EnvironmentRuntimeScope {
  stopOperationId: string;
}

export interface PreparedWorkspaceStopReceipt extends EnvironmentStopScope {
  workspaceLastSyncedAt: string;
}

/**
 * Fresh execution-owner inspection. `stopped` deliberately differs from
 * `absent`: a stopped host container can still contain an unacknowledged
 * writable layer and must not be replaced merely because it is not running.
 */
export type RunnerInspection =
  | { state: "live"; status: string }
  | {
      state: "stopped";
      status: string;
      safeReplacement?: {
        reason: "failed_before_harness";
        operationId: string;
        commandGeneration: number;
      };
    }
  | { state: "absent"; status: string }
  | { state: "unknown"; status: string };

export function classifyRunnerInspection(status?: string): RunnerInspection {
  const normalized = status?.trim().toLowerCase() || "unknown";
  switch (normalized) {
    case "running":
    case "healthy":
    case "paused":
    case "created":
    case "restarting":
    case "starting":
    case "removing":
      return { state: "live", status: normalized };
    case "stopped":
    case "exited":
    case "dead":
      return { state: "stopped", status: normalized };
    case "absent":
    case "not_found":
      return { state: "absent", status: normalized };
    default:
      return { state: "unknown", status: normalized };
  }
}

export interface RunnerStopDispatchResult {
  // `true` means the backend accepted a durable stop and will eventually
  // deliver the matching runner-stopped callback for this lifecycle op.
  // `false` means the runner was already gone, so the caller must finalize
  // lifecycle state synchronously.
  callbackExpected: boolean;
  /** Cloudflare's exact durable workspace receipt, applied by LifecycleDO before termination. */
  workspaceStopReceipt?: PreparedWorkspaceStopReceipt;
  /** The Cloudflare runner disappeared before producing any durable workspace receipt. */
  workspacePreparationUnavailable?: boolean;
  /** Exact machine-runner proof that the superseded Start exited before workspace effects. */
  startRejectedBeforeWorkspace?: boolean;
}

export interface RunnerStartOptions {
  /** Correlates asynchronous runner callbacks with the lifecycle start operation. */
  startOpId?: string | null;
  /** Mandatory at runtime for machine mutations; ignored by Cloudflare. */
  runnerCommand?: RunnerCommandClaim | null;
}

export interface RunnerStopOptions {
  /** Correlates asynchronous runner callbacks with the lifecycle stop operation. */
  stopOpId?: string | null;
  /** Exact runtime/Stop fence required by Cloudflare's two-phase stop. */
  stopScope?: EnvironmentStopScope | null;
  /** Optional exact idle claim carried by LifecycleDO's durable Stop retry. */
  idleClaimId?: string | null;
  /** Mandatory at runtime for machine mutations; ignored by Cloudflare. */
  runnerCommand?: RunnerCommandClaim | null;
}

export interface RunnerDestroyOptions {
  /** Mandatory at runtime for machine mutations; ignored by Cloudflare. */
  runnerCommand?: RunnerCommandClaim | null;
}

export class RunnerBackendControlError extends Error {
  readonly code: RunnerControlErrorCode;
  readonly currentCommandGeneration?: number;
  readonly currentCommandGenerationInvalid: boolean;

  constructor(
    message: string,
    code: RunnerControlErrorCode,
    cause?: unknown,
    currentCommandGeneration?: unknown,
  ) {
    super(message);
    this.name = "RunnerBackendControlError";
    this.code = code;
    this.currentCommandGenerationInvalid = currentCommandGeneration !== undefined
      && (!Number.isSafeInteger(currentCommandGeneration) || (currentCommandGeneration as number) <= 0);
    if (!this.currentCommandGenerationInvalid && currentCommandGeneration !== undefined) {
      this.currentCommandGeneration = currentCommandGeneration as number;
    }
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, configurable: true });
    }
  }
}

export function getRunnerControlErrorCode(error: unknown): RunnerControlErrorCode | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; message?: unknown };
  if (
    candidate.code === "runner_not_found"
    || candidate.code === "runner_command_superseded_before_mutation"
    || candidate.code === "runner_command_superseded"
    || candidate.code === "runner_command_conflict"
  ) {
    return candidate.code;
  }
  if (typeof candidate.message !== "string") return null;
  const match = /(?:^|:\s)\[(runner_not_found|runner_command_superseded_before_mutation|runner_command_superseded|runner_command_conflict)\]\s/.exec(candidate.message);
  return match ? match[1] as RunnerControlErrorCode : null;
}

/**
 * Reads the runner's durable generation from a structured error. During a
 * mixed-version rollout, older CLIs expose the same value only in the stable
 * pre-mutation rejection message.
 */
export function getRunnerCurrentCommandGeneration(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    currentCommandGeneration?: unknown;
    currentCommandGenerationInvalid?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  if (candidate.currentCommandGenerationInvalid === true) return null;
  if (
    "currentCommandGeneration" in candidate
    && candidate.currentCommandGeneration !== undefined
  ) {
    return Number.isSafeInteger(candidate.currentCommandGeneration)
      && (candidate.currentCommandGeneration as number) > 0
      ? candidate.currentCommandGeneration as number
      : null;
  }
  if (typeof candidate.message === "string") {
    const match = /\bRunner command generation \d+ was superseded by (\d+)\b/.exec(candidate.message);
    if (match) {
      const parsed = Number(match[1]);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
    }
  }
  return candidate.cause === error ? null : getRunnerCurrentCommandGeneration(candidate.cause);
}

export type RebaseRejectedRunnerCommand = (
  rejectedCommand: RunnerCommandClaim,
  currentCommandGeneration: number,
) => Promise<RunnerCommandClaim>;

/** Runs only the rejected runner mutation a second time after a safe rebase. */
export async function runRunnerMutationWithGenerationReconciliation<T>(
  runnerCommand: RunnerCommandClaim,
  rebase: RebaseRejectedRunnerCommand,
  mutation: (runnerCommand: RunnerCommandClaim) => Promise<T>,
): Promise<T> {
  try {
    return await mutation(runnerCommand);
  } catch (error) {
    if (getRunnerControlErrorCode(error) !== "runner_command_superseded_before_mutation") {
      throw error;
    }
    const currentCommandGeneration = getRunnerCurrentCommandGeneration(error);
    if (
      currentCommandGeneration === null
      || currentCommandGeneration <= runnerCommand.commandGeneration
    ) {
      throw error;
    }
    const rebased = await rebase(runnerCommand, currentCommandGeneration);
    if (
      !Number.isSafeInteger(rebased.commandGeneration)
      || rebased.commandGeneration <= currentCommandGeneration
      || rebased.operationId !== runnerCommand.operationId
      || rebased.desiredState !== runnerCommand.desiredState
    ) {
      throw new RunnerBackendControlError(
        "Runner command reconciliation returned an invalid command claim.",
        "runner_command_conflict",
      );
    }
    return mutation(rebased);
  }
}

export interface RunnerBackend {
  kind: RunnerBackendKind;
  create(meta: EnvMeta, envVars: Record<string, string>, options?: RunnerStartOptions): Promise<EnvMeta>;
  /** Optional only for mixed-version test doubles; production backends provide it. */
  inspect?(meta: EnvMeta): Promise<RunnerInspection>;
  getStatus(meta: EnvMeta): Promise<string>;
  start(meta: EnvMeta, envVars: Record<string, string>, options?: RunnerStartOptions): Promise<EnvMeta>;
  // Stop implementations must dispatch the durable-stop prepare step with the
  // provided stop op id before terminating the runner.
  stop(meta: EnvMeta, options?: RunnerStopOptions): Promise<RunnerStopDispatchResult>;
  /** Cloudflare-only second phase. It must return before the later stop signal runs. */
  schedulePreparedStop?(
    meta: EnvMeta,
    scope: EnvironmentStopScope,
  ): Promise<{ status: "scheduled" | "already-scheduled" | "already-stopped" }>;
  destroy(meta: EnvMeta, options?: RunnerDestroyOptions): Promise<void>;
}

export async function inspectRunnerBackend(
  backend: RunnerBackend,
  meta: EnvMeta,
): Promise<RunnerInspection> {
  if (backend.inspect) return backend.inspect(meta);
  try {
    const status = await backend.getStatus(meta);
    if (!status) {
      // Compatibility for mixed-version backends and lightweight test
      // doubles. Production backends implement `inspect` and never rely on
      // persisted metadata as an absence proof.
      return meta.status === "stopped" || meta.status === "failed" || meta.status === "unknown"
        ? { state: "absent", status: "absent" }
        : { state: "unknown", status: "unknown" };
    }
    return classifyRunnerInspection(status);
  } catch {
    return { state: "unknown", status: "unknown" };
  }
}

export function isLocalOnlyRunnerBackendMode(
  env: Pick<Env, "LOCAL_DEV_ONLY_BACKEND">,
): boolean {
  return isEnabledFlag(env.LOCAL_DEV_ONLY_BACKEND);
}
