import { getSecret } from "../setup/config";
import { isLoopbackHostname } from "../../shared/local-dev";
import type { Env } from "../types";
import type { RunnerBackendKind } from "./runner-backend";

export function buildEnvWorkspaceApiBaseUrl(baseUrl: string, slug: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/workspace/${encodeURIComponent(slug)}`;
}

export function buildEnvScmOperationResultUrl(baseUrl: string, slug: string, operationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/envs/${encodeURIComponent(slug)}/scm-operations/${encodeURIComponent(operationId)}/result`;
}

export function buildEnvScmOperationHeartbeatUrl(baseUrl: string, slug: string, operationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/envs/${encodeURIComponent(slug)}/scm-operations/${encodeURIComponent(operationId)}/heartbeat`;
}

export function buildEnvScmOperationFailedUrl(baseUrl: string, slug: string, operationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/envs/${encodeURIComponent(slug)}/scm-operations/${encodeURIComponent(operationId)}/failed`;
}

export function buildEnvScmConflictResolutionUrl(baseUrl: string, slug: string, operationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/envs/${encodeURIComponent(slug)}/scm-operations/${encodeURIComponent(operationId)}/resolve-conflicts`;
}

export function buildRepoGitArtifactUrl(baseUrl: string, repoId: string, artifactId?: string | null): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repoId)}/git-artifact`);
  if (artifactId) {
    url.searchParams.set("artifactId", artifactId);
  }
  return url.toString();
}

export function buildRepoGitArtifactStagingUrl(baseUrl: string, repoId: string, operationId: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/api/repos/${encodeURIComponent(repoId)}/scm-operations/${encodeURIComponent(operationId)}/git-artifact`;
}

export async function resolveHubPublicUrl(env: Env, requestUrl: string): Promise<string> {
  const configured = (await getSecret(env, "HUB_PUBLIC_URL"))?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return new URL(requestUrl).origin.replace(/\/+$/, "");
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
