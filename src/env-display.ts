import type { EnvMeta } from "../api/types";

export function getEnvDisplayName(env: Pick<EnvMeta, "startupPlanId">): string {
  return env.startupPlanId ? "New Plan" : "No Plan";
}

export function getBackendBadgeLabel(backend: Pick<EnvMeta, "backend">["backend"]): string {
  return backend === "host" ? "Tiller Host" : "Cloudflare Containers";
}
