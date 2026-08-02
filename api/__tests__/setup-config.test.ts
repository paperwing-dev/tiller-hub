import { beforeEach, describe, expect, it } from "vitest";
import {
  getBillingSelections,
  getIdleTimeoutMinutes,
  invalidateConfigCache,
  loadConfig,
} from "../setup/config";
import {
  CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
} from "../../shared/cloudflare-timeout";

function createEnv(config: Record<string, string>) {
  return {
    HUB: {
      idFromName: () => "hub-id",
      get: () => ({
        getAllConfig: async () => config,
        getBillingSelections: async () => ({
          claudeBillingMode: config.claudeBillingMode ?? null,
          openaiBillingMode: config.openaiBillingMode ?? null,
        }),
        getConfig: async (key: string) => config[key],
        setConfig: async (key: string, value: string) => {
          config[key] = value;
        },
      }),
    },
  } as any;
}

describe("getBillingSelections", () => {
  beforeEach(() => {
    invalidateConfigCache();
  });

  it("bypasses the bulk config cache and normalizes each selection", async () => {
    const config = {
      claudeBillingMode: "subscription",
      openaiBillingMode: "invalid",
      ANTHROPIC_API_KEY: "must-not-leak",
    };
    const env = createEnv(config);
    await loadConfig(env);
    config.claudeBillingMode = "api";
    config.openaiBillingMode = "subscription";

    const selections = await getBillingSelections(env);
    expect(selections).toEqual({
      claudeBillingMode: "api",
      openaiBillingMode: "subscription",
    });
    expect(JSON.stringify(selections)).not.toContain("must-not-leak");
  });

  it("requires the HubDO settings authority instead of reading Worker environment properties", async () => {
    await expect(getBillingSelections({
      claudeBillingMode: "subscription",
      openaiBillingMode: "api",
    } as any)).rejects.toThrow("HubDO binding is required");
  });
});

describe("getIdleTimeoutMinutes", () => {
  beforeEach(() => {
    invalidateConfigCache();
  });

  it("uses the shared Cloudflare default when unset", async () => {
    await expect(getIdleTimeoutMinutes(createEnv({})))
      .resolves.toBe(CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES);
  });

  it.each(["0", "1441", "abc", "1.5"])("uses the shared default for invalid value %s", async (value) => {
    await expect(getIdleTimeoutMinutes(createEnv({ IDLE_TIMEOUT_MINUTES: value })))
      .resolves.toBe(CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES);
  });

  it.each([
    CLOUDFLARE_IDLE_TIMEOUT_MIN_MINUTES,
    CLOUDFLARE_IDLE_TIMEOUT_MAX_MINUTES,
  ])("accepts the shared bound %s", async (value) => {
    await expect(getIdleTimeoutMinutes(createEnv({ IDLE_TIMEOUT_MINUTES: String(value) })))
      .resolves.toBe(value);
  });
});
