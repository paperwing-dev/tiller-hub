import { isLoopbackHostname } from "../../shared/local-dev";
import type { Env } from "../types";
import type { RunnerBackendKind } from "./runner-backend";
import { resolveCanonicalHubOrigin } from "../canonical-origin";

export function buildEnvWorkspaceApiBaseUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/workspace/${encodeURIComponent(slug)}`;
}

export async function resolveHubPublicUrl(env: Env, requestUrl: string): Promise<string> {
  const requested = new URL(requestUrl);
  if (isLoopbackHostname(requested.hostname)) {
    return requested.origin.replace(/\/+$/, "");
  }
  return resolveCanonicalHubOrigin(env);
}

export function rewriteLoopbackHubUrlForDocker(hubUrl: string): string {
  const parsed = new URL(hubUrl);
  if (!isLoopbackHostname(parsed.hostname)) {
    return parsed.origin.replace(/\/+$/, "");
  }

  parsed.hostname = "host.docker.internal";
  return parsed.origin.replace(/\/+$/, "");
}

export async function resolveContainerHubUrl(
  env: Env,
  requestUrl: string,
  backend: RunnerBackendKind,
): Promise<string> {
  const hubPublicUrl = await resolveHubPublicUrl(env, requestUrl);
  if (backend !== "host") {
    return hubPublicUrl;
  }

  return rewriteLoopbackHubUrlForDocker(hubPublicUrl);
}
