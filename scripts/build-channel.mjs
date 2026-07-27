export const WORKERS_BUILDS_WORKER_NAME_VAR = "WRANGLER_CI_OVERRIDE_NAME";

export function resolveBuildChannel(env = process.env) {
  // Deploy-button and self-update builds run inside Cloudflare Workers Builds.
  // They reuse the deploy script, but should remain eligible for release self-update.
  if (env[WORKERS_BUILDS_WORKER_NAME_VAR]?.trim()) {
    return "release";
  }

  return env.TILLER_BUILD_CHANNEL?.trim() === "development"
    ? "development"
    : "release";
}
