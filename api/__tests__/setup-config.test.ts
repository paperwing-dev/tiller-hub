import { beforeEach, describe, expect, it } from "vitest";
import { getCanonicalMainBootstrapDepth, invalidateConfigCache } from "../setup/config";

function createEnv(config: Record<string, string>) {
  return {
    HUB: {
      idFromName: () => "hub-id",
      get: () => ({
        getAllConfig: async () => config,
      }),
    },
  } as any;
}

describe("getCanonicalMainBootstrapDepth", () => {
  beforeEach(() => {
    invalidateConfigCache();
  });

  it("defaults to 0 (full history) when unset", async () => {
    await expect(getCanonicalMainBootstrapDepth(createEnv({}))).resolves.toBe(0);
  });

  it("falls back to 0 for invalid values", async () => {
    await expect(
      getCanonicalMainBootstrapDepth(createEnv({ CANONICAL_MAIN_BOOTSTRAP_DEPTH: "abc" })),
    ).resolves.toBe(0);
  });

  it("returns 0 when explicitly configured as 0", async () => {
    await expect(
      getCanonicalMainBootstrapDepth(createEnv({ CANONICAL_MAIN_BOOTSTRAP_DEPTH: "0" })),
    ).resolves.toBe(0);
  });

  it("normalizes negative values to 0", async () => {
    await expect(
      getCanonicalMainBootstrapDepth(createEnv({ CANONICAL_MAIN_BOOTSTRAP_DEPTH: "-5" })),
    ).resolves.toBe(0);
  });

  it("clamps values above 200", async () => {
    await expect(
      getCanonicalMainBootstrapDepth(createEnv({ CANONICAL_MAIN_BOOTSTRAP_DEPTH: "500" })),
    ).resolves.toBe(200);
  });

  it("returns configured positive values inside the allowed range", async () => {
    await expect(
      getCanonicalMainBootstrapDepth(createEnv({ CANONICAL_MAIN_BOOTSTRAP_DEPTH: "25" })),
    ).resolves.toBe(25);
  });
});
