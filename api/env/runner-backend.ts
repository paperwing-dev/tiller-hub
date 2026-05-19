import type { Env, EnvMeta } from "../types";
import { isEnabledFlag } from "../../shared/local-dev";

export type RunnerBackendKind = "cf" | "host";

export interface RunnerStopDispatchResult {
  // `true` means the backend accepted a durable stop and will eventually
  // deliver the matching runner-stopped callback for this lifecycle op.
  // `false` means the runner was already gone, so the caller must finalize
  // lifecycle state synchronously.
  callbackExpected: boolean;
}

export interface RunnerBackend {
  kind: RunnerBackendKind;
  create(meta: EnvMeta, envVars: Record<string, string>, options?: { startOpId?: string | null }): Promise<EnvMeta>;
  getStatus(meta: EnvMeta): Promise<string>;
  start(meta: EnvMeta, envVars: Record<string, string>, options?: { startOpId?: string | null }): Promise<EnvMeta>;
  // Stop implementations must dispatch the durable-stop prepare step with the
  // provided stop op id before terminating the runner.
  stop(meta: EnvMeta, options?: { stopOpId?: string | null }): Promise<RunnerStopDispatchResult>;
  destroy(meta: EnvMeta): Promise<void>;
}

export function isLocalOnlyRunnerBackendMode(
  env: Pick<Env, "LOCAL_DEV_ONLY_BACKEND">,
): boolean {
  return isEnabledFlag(env.LOCAL_DEV_ONLY_BACKEND);
}

export function resolveScmRunnerBackendKind(
  env: Pick<Env, "LOCAL_DEV_ONLY_BACKEND">,
): RunnerBackendKind {
  return isLocalOnlyRunnerBackendMode(env) ? "host" : "cf";
}
