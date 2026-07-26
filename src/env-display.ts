import type { EnvMeta } from "../api/types";

export const NEW_EXECUTION_UNAVAILABLE_MESSAGE =
  "The selected execution backend is unavailable. Choose another backend in Settings.";

export const EXISTING_EXECUTION_UNAVAILABLE_MESSAGE =
  "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.";

export function getEnvDisplayName(env: Pick<EnvMeta, "slug" | "startupPlanId">): string {
  return env.slug;
}

export function getBackendBadgeLabel(backend: Pick<EnvMeta, "backend">["backend"]): string {
  return backend === "host" ? "Your machine" : "Cloudflare";
}
