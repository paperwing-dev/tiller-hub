import { afterEach, describe, expect, it } from "vitest";
import {
  classifyHostRuntimeCompatibility,
  classifyHostRuntimeCompatibilityForExpectedRuntime,
  type ExpectedHostRuntime,
} from "../setup/runtime-compatibility";

const SOURCE = `sha256:${"1".repeat(64)}`;
const STALE_SOURCE = `sha256:${"2".repeat(64)}`;
const image = (sourceId = SOURCE) => `docker.io/jamieatlason/tiller-sandbox@${sourceId}`;
const expectedRuntime = (sourceId = SOURCE): ExpectedHostRuntime => ({ image: image(sourceId), sourceId });

function hostRuntime(runtimeImage: string, sourceId?: string) {
  return {
    machineId: "host-1",
    connectedAt: new Date().toISOString(),
    dockerAvailable: true,
    claudeSubscription: true,
    localRunnerImage: runtimeImage,
    ...(sourceId ? { localRunnerImageSourceId: sourceId } : {}),
    transport: "session" as const,
  };
}

function setExpectedRuntime(sourceId: string | null) {
  (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__ = {
    schemaVersion: 1,
    channel: "release",
    hubVersion: "0.2.54",
    releaseId: "a".repeat(40),
    ...(sourceId ? { selfHostRuntimeImage: image(sourceId) } : {}),
  };
}

describe("host runtime compatibility", () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { __TILLER_RELEASE_INFO__?: unknown }).__TILLER_RELEASE_INFO__;
  });

  it("accepts a digest-pinned current image with a matching reported digest", () => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(image(), SOURCE),
      expectedRuntime(),
    )).toMatchObject({ compatible: true, hostRuntimeImageSourceId: SOURCE, hostRuntimeImageStatus: "current" });
  });

  it("rejects a managed image when its digest was not reported", () => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(image()),
      expectedRuntime(),
    )).toMatchObject({ compatible: false, hostRuntimeImageSourceId: SOURCE, hostRuntimeImageStatus: "unknown" });
  });

  it.each([
    ["stale", hostRuntime(image(STALE_SOURCE), STALE_SOURCE), "behind", STALE_SOURCE],
    ["missing host", null, "unknown", null],
    ["custom", hostRuntime("example.com/custom/runtime:latest"), "custom", null],
  ] as const)("rejects a %s runtime", (_label, host, status, sourceId) => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(host, expectedRuntime())).toMatchObject({
      compatible: false,
      hostRuntimeImageSourceId: sourceId,
      hostRuntimeImageStatus: status,
    });
  });

  it("rejects a reported digest that disagrees with the image", () => {
    expect(classifyHostRuntimeCompatibilityForExpectedRuntime(
      hostRuntime(image(), STALE_SOURCE),
      expectedRuntime(),
    )).toMatchObject({ compatible: false, hostRuntimeImageSourceId: SOURCE, hostRuntimeImageStatus: "unknown" });
  });

  it("keeps the release-info compatibility bridge for lifecycle callers", () => {
    setExpectedRuntime(SOURCE);
    expect(classifyHostRuntimeCompatibility(hostRuntime(image(), SOURCE)))
      .toMatchObject({ compatible: true, hostRuntimeImageStatus: "current" });
  });
});
