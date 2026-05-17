import { ENV_HARNESSES, isEnvHarness, type Env, type EnvHarness } from "../types";

export { isEnvHarness };

export const SUPPORTED_ENV_HARNESSES: EnvHarness[] = [...ENV_HARNESSES];
export const DEFAULT_ENABLED_ENV_HARNESSES: EnvHarness[] = ["claude-code", "codex", "opencode"];

export function resolveEnabledHarnesses(env: Pick<Env, "ENABLED_ENV_HARNESSES">): EnvHarness[] {
  const configured = env.ENABLED_ENV_HARNESSES?.trim();
  if (!configured) return [...DEFAULT_ENABLED_ENV_HARNESSES];

  const enabled = configured
    .split(",")
    .map((value) => value.trim())
    .filter(isEnvHarness);

  return enabled.length > 0 ? [...new Set(enabled)] : [...DEFAULT_ENABLED_ENV_HARNESSES];
}

export function isHarnessEnabled(env: Pick<Env, "ENABLED_ENV_HARNESSES">, harness: EnvHarness): boolean {
  return resolveEnabledHarnesses(env).includes(harness);
}
