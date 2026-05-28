import { beforeEach, describe, expect, it } from "vitest";
import { getCanonicalMainBootstrapDepth, invalidateConfigCache, resolveDeploymentModeForRuntime } from "../setup/config";

function createEnv(config: Record<string, string>) {
  return {
    HUB: {
      idFromName: () => "hub-id",
      get: () => ({
        getAllConfig: async () => config,
        getConfig: async (key: string) => config[key],
        setConfig: async (key: string, value: string) => {
          config[key] = value;
        },
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

describe("resolveDeploymentModeForRuntime", () => {
  beforeEach(() => {
    invalidateConfigCache();
  });

  it("defaults to hosted even when custom-domain gateway remnants exist", async () => {
    await expect(
      resolveDeploymentModeForRuntime(createEnv({
        HUB_PUBLIC_URL: "https://tiller.example.com",
        TILLER_GATEWAY_HOSTNAME: "tiller-gateway.example.com",
        TILLER_GATEWAY_TUNNEL_ID: "tunnel-id",
      })),
    ).resolves.toBe("hosted");
  });

  it("uses the persisted lifecycle mode when set", async () => {
    await expect(
      resolveDeploymentModeForRuntime(createEnv({
        HUB_PUBLIC_URL: "https://tiller.example.com",
        TILLER_DEPLOYMENT_MODE: "self-host",
      })),
    ).resolves.toBe("self-host");
  });
});
