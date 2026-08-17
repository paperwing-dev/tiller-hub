import { describe, expect, it } from "vitest";
import {
  parseDevelopmentSelfHostDeployRecord,
  replaceSelfHostRuntimeMetadata,
  resolveSelfHostRuntimeBuildInput,
  resolveSelfHostRuntimeChannel,
} from "./self-host-runtime-build.mjs";

const SOURCE_A = "a".repeat(40);
const SOURCE_B = "b".repeat(40);
const runtime = (imageSourceId: string) => ({
  imageSourceId,
  sandboxImage: `docker.io/jamieatlason/tiller-sandbox:${imageSourceId}`,
});
const deployRecord = (imageSourceId: string, reviewerIsolationProtocol?: 1) => ({
  schemaVersion: 2,
  hubCommitSha: imageSourceId,
  imageCommitSha: imageSourceId,
  sandboxImage: runtime(imageSourceId).sandboxImage,
  scmImage: `docker.io/jamieatlason/tiller-scm:${imageSourceId}`,
  ...(reviewerIsolationProtocol === 1 ? { reviewerIsolationProtocol } : {}),
  recordedAt: "2026-07-09T00:00:00.000Z",
});

describe("machine runtime build metadata", () => {
  it("keeps valid explicit overrides authoritative", () => {
    expect(resolveSelfHostRuntimeBuildInput({
      env: {
        TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID: SOURCE_A,
        TILLER_SELF_HOST_RUNTIME_SANDBOX_IMAGE: runtime(SOURCE_A).sandboxImage,
      },
      buildChannel: "development",
      developmentRuntime: runtime(SOURCE_B),
    })).toEqual(runtime(SOURCE_A));
  });

  it("uses the validation deploy record for development builds", () => {
    expect(resolveSelfHostRuntimeBuildInput({
      env: {},
      buildChannel: "development",
      developmentRuntime: runtime(SOURCE_B),
    })).toEqual(runtime(SOURCE_B));
  });

  it("does not use development deploy metadata for release builds", () => {
    expect(resolveSelfHostRuntimeBuildInput({
      env: {},
      buildChannel: "release",
      developmentRuntime: runtime(SOURCE_B),
    })).toBeNull();
  });

  it("uses embedded runtime metadata only for release builds", () => {
    expect(resolveSelfHostRuntimeBuildInput({
      env: {},
      buildChannel: "release",
      embeddedRuntime: runtime(SOURCE_A),
    })).toEqual(runtime(SOURCE_A));
    expect(resolveSelfHostRuntimeBuildInput({
      env: {},
      buildChannel: "development",
      embeddedRuntime: runtime(SOURCE_A),
    })).toBeNull();
  });

  it("rejects development overrides in release builds", () => {
    expect(() => resolveSelfHostRuntimeBuildInput({
      env: {
        TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID: SOURCE_B,
        TILLER_SELF_HOST_RUNTIME_SANDBOX_IMAGE: runtime(SOURCE_B).sandboxImage,
      },
      buildChannel: "release",
      embeddedRuntime: runtime(SOURCE_A),
    })).toThrow(/only supported for development builds/i);
  });

  it("accepts only complete validation deploy records with a matching runtime", () => {
    expect(parseDevelopmentSelfHostDeployRecord(deployRecord(SOURCE_A))).toEqual(runtime(SOURCE_A));
    expect(parseDevelopmentSelfHostDeployRecord(deployRecord(SOURCE_A, 1))).toEqual(runtime(SOURCE_A));
    expect(parseDevelopmentSelfHostDeployRecord({
      imageCommitSha: SOURCE_A,
      sandboxImage: runtime(SOURCE_A).sandboxImage,
    })).toBeNull();
    expect(parseDevelopmentSelfHostDeployRecord({
      ...deployRecord(SOURCE_A),
      sandboxImage: runtime(SOURCE_B).sandboxImage,
    })).toBeNull();
    expect(parseDevelopmentSelfHostDeployRecord({
      ...deployRecord(SOURCE_A),
      scmImage: "docker.io/example/custom:latest",
    })).toBeNull();
  });

  it("removes embedded release runtime metadata when development resolves no runtime", () => {
    const metadata = {
      version: "1.2.3",
      selfHostRuntime: runtime(SOURCE_A),
    };

    expect(replaceSelfHostRuntimeMetadata(metadata, null)).toEqual({ version: "1.2.3" });
    expect(replaceSelfHostRuntimeMetadata(metadata, runtime(SOURCE_B))).toEqual({
      version: "1.2.3",
      selfHostRuntime: runtime(SOURCE_B),
    });
  });

  it("treats ordinary Vite serve as development regardless of release channel defaults", () => {
    expect(resolveSelfHostRuntimeChannel("serve", "release")).toBe("development");
    expect(resolveSelfHostRuntimeChannel("build", "development")).toBe("development");
    expect(resolveSelfHostRuntimeChannel("build", "release")).toBe("release");
  });

  it("fails deployment builds without a valid expected runtime", () => {
    expect(() => resolveSelfHostRuntimeBuildInput({
      env: {},
      buildChannel: "development",
      required: true,
    })).toThrow(/runtime metadata is required for deployment/i);
  });

  it("does not let embedded release metadata satisfy a required development deploy", () => {
    expect(() => resolveSelfHostRuntimeBuildInput({
      env: {},
      buildChannel: "development",
      embeddedRuntime: runtime(SOURCE_A),
      required: true,
    })).toThrow(/runtime metadata is required for deployment/i);
  });

  it("rejects partial or mismatched explicit overrides instead of falling back", () => {
    expect(() => resolveSelfHostRuntimeBuildInput({
      env: { TILLER_SELF_HOST_RUNTIME_IMAGE_SOURCE_ID: SOURCE_A },
      buildChannel: "development",
      developmentRuntime: runtime(SOURCE_B),
    })).toThrow(/metadata override/);
  });
});
