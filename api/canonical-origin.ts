import type { Env } from "./types";
import { isLocalDevRequest } from "./protection";
import { readCanonicalWorkersDevAccessTrust } from "./workers-dev-access/records";
import {
  parseCanonicalWorkersDevHostname,
  type CanonicalWorkersDevRoute,
} from "./canonical-workers-dev";

export {
  parseCanonicalWorkersDevHostname,
  type CanonicalWorkersDevRoute,
} from "./canonical-workers-dev";

const ACCESS_ONBOARDING_PATHS = new Set([
  "/health",
]);

export function workersDevOrigin(hostname: string): string {
  try {
    return parseCanonicalWorkersDevHostname(hostname).origin;
  } catch {
    throw new Error("Canonical Hub trust must use an exact workers.dev hostname.");
  }
}

export async function resolveCanonicalHubOrigin(env: Env): Promise<string> {
  const trust = await readCanonicalWorkersDevAccessTrust(env);
  if (!trust) throw new Error("Canonical workers.dev Access trust is not configured.");
  return workersDevOrigin(trust.workersDevHostname);
}

export async function resolveCanonicalRequestOrigin(
  env: Env,
  request: Request,
): Promise<string> {
  if (isLocalDevRequest(env, request)) return resolveLocalDevOrigin(env, request);
  return resolveCanonicalHubOrigin(env);
}

function resolveLocalDevOrigin(env: Env, request?: Request): string {
  const configured = env.TILLER_LOCAL_DEV_ORIGIN?.trim()
    || (request ? new URL(request.url).origin : "");
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("Local development requires an exact HTTP origin.");
  }
  if (
    parsed.protocol !== "http:"
    || parsed.origin !== configured
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
    || !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
  ) {
    throw new Error("Local development requires an exact loopback HTTP origin.");
  }
  return configured;
}

export async function canonicalIngressResponse(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (isLocalDevRequest(env, request)) return null;
  const url = new URL(request.url);
  const trust = await readCanonicalWorkersDevAccessTrust(env);
  if (!trust) {
    let workersDevRoute: CanonicalWorkersDevRoute | null = null;
    try {
      workersDevRoute = parseCanonicalWorkersDevHostname(url.hostname);
    } catch {
      // Only an exact workers.dev Worker route may enter onboarding.
    }
    if (
      workersDevRoute
      && ACCESS_ONBOARDING_PATHS.has(url.pathname)
    ) {
      return null;
    }
    return Response.json(
      { error: "Canonical workers.dev Access trust is not configured." },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const expected = workersDevOrigin(trust.workersDevHostname);
  if (url.origin !== expected) {
    return Response.json(
      { error: "Not found" },
      { status: 404, headers: { "Cache-Control": "no-store" } },
    );
  }
  return null;
}
