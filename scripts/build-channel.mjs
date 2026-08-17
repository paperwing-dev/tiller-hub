export const WORKERS_BUILDS_WORKER_NAME_VAR = "WRANGLER_CI_OVERRIDE_NAME";

export function resolveBuildChannel(env = process.env) {
  // Legacy Cloudflare Builds remain production-shaped so the Hub can identify
  // them as unmanaged and direct their owners to the clean installer path.
  if (env[WORKERS_BUILDS_WORKER_NAME_VAR]?.trim()) {
    return "release";
  }

  return env.TILLER_BUILD_CHANNEL?.trim() === "development"
    ? "development"
    : "release";
}
