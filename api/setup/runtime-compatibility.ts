import type { HostServiceRegistration } from "../types";
import { getCurrentReleaseInfo } from "../update/release-info";

const MANAGED_SELF_HOST_RUNTIME_REPOSITORY_RE = /^docker\.io\/jamieatlason\/tiller-sandbox(?:[:@])/;
const TAGGED_RUNTIME_RE = /^docker\.io\/jamieatlason\/tiller-sandbox:([0-9a-f]{40})$/;
const DIGEST_RUNTIME_RE = /^docker\.io\/jamieatlason\/tiller-sandbox@(sha256:[0-9a-f]{64})$/;

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

export function parseManagedSelfHostRuntimeSourceId(image: string): string | null {
  const normalized = image.trim();
  return normalized.match(DIGEST_RUNTIME_RE)?.[1]
    ?? normalized.match(TAGGED_RUNTIME_RE)?.[1]
    ?? null;
}

export function resolveExpectedHostRuntime(): ExpectedHostRuntime {
  try {
    const release = getCurrentReleaseInfo();
    if (release.selfHostRuntimeImage) {
      return {
        image: release.selfHostRuntimeImage,
        sourceId: parseManagedSelfHostRuntimeSourceId(release.selfHostRuntimeImage),
      };
    }
    const developmentRuntime = typeof __TILLER_DEVELOPMENT_RUNTIME__ === "undefined"
      ? (globalThis as typeof globalThis & { __TILLER_DEVELOPMENT_RUNTIME__?: unknown }).__TILLER_DEVELOPMENT_RUNTIME__
      : __TILLER_DEVELOPMENT_RUNTIME__;
    if (release.channel === "development" && developmentRuntime && typeof developmentRuntime === "object") {
      const image = "sandboxImage" in developmentRuntime && typeof developmentRuntime.sandboxImage === "string"
        ? developmentRuntime.sandboxImage.trim()
        : "";
      const sourceId = parseManagedSelfHostRuntimeSourceId(image);
      return sourceId ? { image, sourceId } : { image: null, sourceId: null };
    }
    return { image: null, sourceId: null };
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

  const hostRuntimeImageSourceId = parseManagedSelfHostRuntimeSourceId(hostRuntimeImage);
  if (!hostRuntimeImageSourceId) {
    return { ...base, hostRuntimeImageSourceId: null, hostRuntimeImageStatus: "unknown", compatible: false };
  }
  if (!registeredSourceId || registeredSourceId !== hostRuntimeImageSourceId) {
    return { ...base, hostRuntimeImageSourceId, hostRuntimeImageStatus: "unknown", compatible: false };
  }

  const expectedSourceId = expected.sourceId?.trim() || null;
  const expectedImageSourceId = expected.image
    ? parseManagedSelfHostRuntimeSourceId(expected.image)
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
