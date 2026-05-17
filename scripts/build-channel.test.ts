import { describe, expect, it } from "vitest";
import { resolveBuildChannel } from "./build-channel.mjs";

describe("resolveBuildChannel", () => {
  it("keeps local deploys on the development channel", () => {
    expect(resolveBuildChannel({
      TILLER_BUILD_CHANNEL: "development",
    })).toBe("development");
  });

  it("treats Cloudflare Workers Builds as release builds", () => {
    expect(resolveBuildChannel({
      TILLER_BUILD_CHANNEL: "development",
      WRANGLER_CI_OVERRIDE_NAME: "tiller-hub-66",
    })).toBe("release");
  });

  it("defaults to release outside explicit local development builds", () => {
    expect(resolveBuildChannel({})).toBe("release");
    expect(resolveBuildChannel({ TILLER_BUILD_CHANNEL: "release" })).toBe("release");
  });
});
