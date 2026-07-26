import { beforeEach, describe, expect, it } from "vitest";
import {
  mintImplementorCodexRuntimeCapability,
  resetCodexRuntimeCapabilityForTests,
  verifyImplementorCodexRuntimeCapability,
} from "../env/codex-runtime-capability";

const env = {
  TILLER_CODEX_RUNTIME_CAPABILITY_KEY: "test-secret",
} as any;

describe("implementor Codex runtime capability", () => {
  beforeEach(() => resetCodexRuntimeCapabilityForTests());

  it("binds slug, incarnation, and start operation", async () => {
    const subject = { envSlug: "demo", incarnationId: "inc-1", startOpId: "start-1" };
    const capability = await mintImplementorCodexRuntimeCapability(env, subject);
    await expect(verifyImplementorCodexRuntimeCapability(env, subject, capability)).resolves.toBe(true);
    await expect(verifyImplementorCodexRuntimeCapability(env, { ...subject, startOpId: "start-2" }, capability)).resolves.toBe(false);
    await expect(verifyImplementorCodexRuntimeCapability(env, { ...subject, incarnationId: "inc-2" }, capability)).resolves.toBe(false);
    await expect(verifyImplementorCodexRuntimeCapability(env, { ...subject, envSlug: "other" }, capability)).resolves.toBe(false);
  });
});
