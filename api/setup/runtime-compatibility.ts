import type { HostServiceRegistration } from "../types";
import {
  getCurrentUpdateMetadata,
  parseManagedSelfHostSandboxImageSourceId,
} from "../update/metadata";

const MANAGED_SELF_HOST_RUNTIME_REPOSITORY_RE = /^(?:docker\.io\/)?jamieatlason\/tiller-sandbox:/;

export type HostRuntimeImageStatus = "unknown" | "custom" | "current" | "behind";

export interface HostRuntimeCompatibility {
  hostRuntimeImage: string | null;
  hostRuntimeImageSourceId: string | null;
  expectedHostRuntimeImage: string | null;
  expectedHostRuntimeImageSourceId: string | null;
  hostRuntimeImageStatus: HostRuntimeImageStatus;
  compatible: boolean;
}

export interface ExpectedHostRuntime {
  image: string | null;
  sourceId: string | null;
}

export function resolveExpectedHostRuntime(): ExpectedHostRuntime {
  try {
    const runtime = getCurrentUpdateMetadata().selfHostRuntime;
    return runtime
      ? { image: runtime.sandboxImage, sourceId: runtime.imageSourceId }
      : { image: null, sourceId: null };
  } catch {
    return { image: null, sourceId: null };
  }
}

/**
 * Classify a registered host against an explicit expected runtime.
 *
 * Keep this function free of release-metadata reads so callers that already
 * own that policy input can test and reuse the exact same classification.
 */
export function classifyHostRuntimeCompatibilityForExpectedRuntime(
  registeredHost: HostServiceRegistration | null,
  expected: ExpectedHostRuntime,
): HostRuntimeCompatibility {
  const hostRuntimeImage = registeredHost?.localRunnerImage?.trim() || null;
  const registeredSourceId = registeredHost?.localRunnerImageSourceId?.trim() || null;
  const base = {
    hostRuntimeImage,
    expectedHostRuntimeImage: expected.image,
    expectedHostRuntimeImageSourceId: expected.sourceId,
  };
  if (!hostRuntimeImage) {
    return { ...base, hostRuntimeImageSourceId: null, hostRuntimeImageStatus: "unknown", compatible: false };
  }
  if (!MANAGED_SELF_HOST_RUNTIME_REPOSITORY_RE.test(hostRuntimeImage)) {
    return { ...base, hostRuntimeImageSourceId: null, hostRuntimeImageStatus: "custom", compatible: false };
  }

  const hostRuntimeImageSourceId = parseManagedSelfHostSandboxImageSourceId(hostRuntimeImage);
  if (!hostRuntimeImageSourceId) {
    return { ...base, hostRuntimeImageSourceId: null, hostRuntimeImageStatus: "unknown", compatible: false };
  }
  if (!registeredSourceId || registeredSourceId !== hostRuntimeImageSourceId) {
    return { ...base, hostRuntimeImageSourceId, hostRuntimeImageStatus: "unknown", compatible: false };
  }

  const expectedSourceId = expected.sourceId?.trim() || null;
  const expectedImageSourceId = expected.image
    ? parseManagedSelfHostSandboxImageSourceId(expected.image)
    : null;
  if (!expectedSourceId || expectedImageSourceId !== expectedSourceId) {
    return { ...base, hostRuntimeImageSourceId, hostRuntimeImageStatus: "unknown", compatible: false };
  }
  const compatible = hostRuntimeImageSourceId === expectedSourceId;
  return {
    ...base,
    hostRuntimeImageSourceId,
    hostRuntimeImageStatus: compatible ? "current" : "behind",
    compatible,
  };
}

/**
 * Compatibility bridge for callers that do not yet resolve release metadata
 * themselves.
 */
export function classifyHostRuntimeCompatibility(
  registeredHost: HostServiceRegistration | null,
): HostRuntimeCompatibility {
  return classifyHostRuntimeCompatibilityForExpectedRuntime(
    registeredHost,
    resolveExpectedHostRuntime(),
  );
}
