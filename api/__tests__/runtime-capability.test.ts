import { beforeEach, describe, expect, it } from "vitest";
import {
  environmentRuntimeCapabilitySubject,
  mintEnvironmentRuntimeCapability,
  resetRuntimeCapabilityForTests,
  verifyEnvironmentRuntimeCapability,
} from "../env/runtime-capability";

const env = {
  TILLER_RUNTIME_CAPABILITY_KEY: "test-secret",
} as any;

describe("environment runtime capability", () => {
  beforeEach(() => resetRuntimeCapabilityForTests());

  it("uses the fixed environment-runtime domain and binds every workload fence", async () => {
    const subject = {
      envSlug: "demo",
      incarnationId: "inc-1",
      startOperationId: "start-1",
    };
    expect(environmentRuntimeCapabilitySubject(subject)).toBe(
      "v1 | environment-runtime | demo | inc-1 | start-1",
    );
    const capability = await mintEnvironmentRuntimeCapability(env, subject);
    await expect(verifyEnvironmentRuntimeCapability(env, subject, capability)).resolves.toBe(true);
    await expect(verifyEnvironmentRuntimeCapability(
      env,
      { ...subject, startOperationId: "start-2" },
      capability,
    )).resolves.toBe(false);
    await expect(verifyEnvironmentRuntimeCapability(
      env,
      { ...subject, incarnationId: "inc-2" },
      capability,
    )).resolves.toBe(false);
    await expect(verifyEnvironmentRuntimeCapability(
      env,
      { ...subject, envSlug: "other" },
      capability,
    )).resolves.toBe(false);
    await expect(verifyEnvironmentRuntimeCapability(env, subject, `${capability}0`)).resolves.toBe(false);
  });
});
