import type {
  Env,
  EnvMeta,
  RunnerCommandClaim,
  RunnerControlErrorCode,
} from "../types";
import { isEnabledFlag } from "../../shared/local-dev";

export type RunnerBackendKind = "cf" | "host";

export interface RunnerStopDispatchResult {
  // `true` means the backend accepted a durable stop and will eventually
  // deliver the matching runner-stopped callback for this lifecycle op.
  // `false` means the runner was already gone, so the caller must finalize
  // lifecycle state synchronously.
  callbackExpected: boolean;
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
  /** Mandatory at runtime for machine mutations; ignored by Cloudflare. */
  runnerCommand?: RunnerCommandClaim | null;
}

export interface RunnerDestroyOptions {
  /** Mandatory at runtime for machine mutations; ignored by Cloudflare. */
  runnerCommand?: RunnerCommandClaim | null;
}

export class RunnerBackendControlError extends Error {
  readonly code: RunnerControlErrorCode;

  constructor(message: string, code: RunnerControlErrorCode, cause?: unknown) {
    super(message);
    this.name = "RunnerBackendControlError";
    this.code = code;
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

export interface RunnerBackend {
  kind: RunnerBackendKind;
  create(meta: EnvMeta, envVars: Record<string, string>, options?: RunnerStartOptions): Promise<EnvMeta>;
  getStatus(meta: EnvMeta): Promise<string>;
  start(meta: EnvMeta, envVars: Record<string, string>, options?: RunnerStartOptions): Promise<EnvMeta>;
  // Stop implementations must dispatch the durable-stop prepare step with the
  // provided stop op id before terminating the runner.
  stop(meta: EnvMeta, options?: RunnerStopOptions): Promise<RunnerStopDispatchResult>;
  destroy(meta: EnvMeta, options?: RunnerDestroyOptions): Promise<void>;
}

export function isLocalOnlyRunnerBackendMode(
  env: Pick<Env, "LOCAL_DEV_ONLY_BACKEND">,
): boolean {
  return isEnabledFlag(env.LOCAL_DEV_ONLY_BACKEND);
}
