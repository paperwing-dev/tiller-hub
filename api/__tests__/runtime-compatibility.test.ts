import { afterEach, describe, expect, it } from "vitest";
import {
  classifyHostRuntimeCompatibility,
  classifyHostRuntimeCompatibilityForExpectedRuntime,
  type ExpectedHostRuntime,
} from "../setup/runtime-compatibility";

const SOURCE = "0123456789abcdef0123456789abcdef01234567";
const STALE_SOURCE = "a".repeat(40);

const expectedRuntime = (sourceId = SOURCE): ExpectedHostRuntime => ({
  image: `docker.io/jamieatlason/tiller-sandbox:${sourceId}`,
  sourceId,
});

function hostRuntime(
  image: string,
  sourceId?: string,
) {
  return {
    machineId: "host-1",
    connectedAt: new Date().toISOString(),
    dockerAvailable: true,
    claudeSubscription: true,
    localRunnerImage: image,
    ...(sourceId ? { localRunnerImageSourceId: sourceId } : {}),
    transport: "session" as const,
  };
}

function setExpectedRuntime(sourceId: string | null) {
  (globalThis as typeof globalThis & { __TILLER_CURRENT_UPDATE__?: unknown }).__TILLER_CURRENT_UPDATE__ = {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId: "source",
    version: "test",
    label: "test",
    managedFiles: ["package.json"],
    ...(sourceId
      ? { selfHostRuntime: { imageSourceId: sourceId, sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${sourceId}` } }
      : {}),
  };
}

describe("host runtime compatibility", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __TILLER_CURRENT_UPDATE__?: unknown }).__TILLER_CURRENT_UPDATE__;
  });

  it("accepts a managed current image with a matching reported source", () => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(`docker.io/jamieatlason/tiller-sandbox:${SOURCE}`, SOURCE),
      expectedRuntime(),
    )).toMatchObject({
      compatible: true,
      hostRuntimeImageSourceId: SOURCE,
      hostRuntimeImageStatus: "current",
    });
  });

  it("rejects a managed image when its source id was not reported", () => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(`docker.io/jamieatlason/tiller-sandbox:${SOURCE}`),
      expectedRuntime(),
    )).toMatchObject({
      compatible: false,
      hostRuntimeImageSourceId: SOURCE,
      hostRuntimeImageStatus: "unknown",
    });
  });

  it.each([
    ["stale", hostRuntime(`docker.io/jamieatlason/tiller-sandbox:${STALE_SOURCE}`, STALE_SOURCE), "behind", STALE_SOURCE],
    ["missing host", null, "unknown", null],
    ["custom", hostRuntime("example.com/custom/runtime:latest"), "custom", null],
  ] as const)("rejects a %s runtime", (_label, host, status, sourceId) => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(host, expectedRuntime())).toMatchObject({
      compatible: false,
      hostRuntimeImageSourceId: sourceId,
      hostRuntimeImageStatus: status,
    });
  });

  it.each([
    ["stable tag without source", "docker.io/jamieatlason/tiller-sandbox:stable", undefined],
    ["stable tag with a spoofed current source", "docker.io/jamieatlason/tiller-sandbox:stable", SOURCE],
    ["short SHA tag", "docker.io/jamieatlason/tiller-sandbox:abc123", "abc123"],
  ] as const)("rejects an official managed image with an invalid SHA tag: %s", (_label, image, reportedSourceId) => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(image, reportedSourceId),
      expectedRuntime(),
    )).toMatchObject({
      compatible: false,
      hostRuntimeImageSourceId: null,
      hostRuntimeImageStatus: "unknown",
    });
  });

  it("rejects a reported source that disagrees with the concrete image tag", () => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(`docker.io/jamieatlason/tiller-sandbox:${SOURCE}`, STALE_SOURCE),
      expectedRuntime(),
    )).toMatchObject({
      compatible: false,
      hostRuntimeImageSourceId: SOURCE,
      hostRuntimeImageStatus: "unknown",
    });
  });

  it.each([
    ["missing expected runtime", { image: null, sourceId: null }],
    ["inconsistent expected runtime", { image: expectedRuntime(STALE_SOURCE).image, sourceId: SOURCE }],
  ] as const)("rejects a managed host when release metadata is %s", (_label, expected) => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(`docker.io/jamieatlason/tiller-sandbox:${SOURCE}`, SOURCE),
      expected,
    )).toMatchObject({ compatible: false, hostRuntimeImageStatus: "unknown" });
  });

  it("keeps the metadata-resolving compatibility bridge for lifecycle callers", () => {
    setExpectedRuntime(SOURCE);
    expect(classifyHostRuntimeCompatibility(
      hostRuntime(`docker.io/jamieatlason/tiller-sandbox:${SOURCE}`, SOURCE),
    )).toMatchObject({ compatible: true, hostRuntimeImageStatus: "current" });
  });
});
