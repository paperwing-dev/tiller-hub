import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPENCODE_PROXY_TOKEN_KEY,
  resolveCodexContainerAuth,
  resolveContainerAuth,
  resolveOpenCodeContainerAuth,
} from "../env/container-auth";
import type { Env } from "../types";
import { getHarnessModel } from "../../shared/harness-catalog";

const KIMI_K2_7_MODEL = getHarnessModel("opencode", "kimi-k2.7-code")!;
const OPENAI_OPENCODE_MODEL = getHarnessModel("opencode", "gpt-5.6-sol")!;
const ANTHROPIC_OPENCODE_MODEL = getHarnessModel("opencode", "claude-opus-5")!;

const { getOrCreateSecret, getSecret } = vi.hoisted(() => ({
  getOrCreateSecret: vi.fn(async (env: Record<string, unknown>, key: string, createValue: () => string) => {
    return env[key] || createValue();
  }),
  getSecret: vi.fn(async (env: Record<string, unknown>, key: string) => env[key] || undefined),
}));

// Mock the config module so getSecret falls through to env values
// (no DO available in unit tests)
vi.mock("../setup/config", () => ({
  getSecret,
  getOrCreateSecret,
}));

function mockEnv(overrides: Record<string, unknown>): Env {
  return overrides as unknown as Env;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveContainerAuth", () => {
  it("reads and materializes only the selected subscription credential", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token", ANTHROPIC_API_KEY: "inactive-api-key" }),
      { requested: "subscription" },
    );

    expect(result).toEqual({
      resolvedAuthMode: "subscription",
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" },
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "CLAUDE_CODE_OAUTH_TOKEN", { fresh: true });
  });

  it("reads and materializes only the selected API credential", async () => {
    const result = await resolveContainerAuth(
      mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "inactive-oauth", ANTHROPIC_API_KEY: "api-key" }),
      { backend: "host", requested: "api" },
    );

    expect(result).toEqual({
      resolvedAuthMode: "api",
      envVars: { ANTHROPIC_API_KEY: "api-key" },
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "ANTHROPIC_API_KEY", { fresh: true });
  });

  it("fails the selected subscription route without reading or falling back to API", async () => {
    await expect(
      resolveContainerAuth(
        mockEnv({ ANTHROPIC_API_KEY: "api-key" }),
        { requested: "subscription" },
      ),
    ).rejects.toMatchObject({
      reason: "credential-not-configured",
      message: expect.stringContaining("active Claude Subscription credential is not configured"),
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "CLAUDE_CODE_OAUTH_TOKEN", { fresh: true });
  });

  it("fails the selected API route without reading or falling back to subscription", async () => {
    await expect(
      resolveContainerAuth(
        mockEnv({ CLAUDE_CODE_OAUTH_TOKEN: "oauth-token" }),
        { requested: "api" },
      ),
    ).rejects.toThrow("active Claude API credential is not configured");
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "ANTHROPIC_API_KEY", { fresh: true });
  });

});

describe("resolveCodexContainerAuth", () => {
  it("rejects subscription auth because app-server owns runtime auth", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({ OPENAI_API_KEY: "inactive-key" }), {
        authPreference: "subscription",
      }),
    ).rejects.toThrow("app-server runtime auth");
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("allows explicit API key auth for host-backed Codex envs", async () => {
    await expect(
      resolveCodexContainerAuth(mockEnv({ OPENAI_API_KEY: "openai-key" }), {
        authPreference: "api-key",
      }),
    ).resolves.toEqual({
      resolvedAuthMode: "api-key",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
  });

  it("reads only OPENAI_API_KEY for an explicit API route", async () => {
    await expect(resolveCodexContainerAuth(mockEnv({ OPENAI_API_KEY: "openai-key" }), {
      authPreference: "api-key",
    })).resolves.toEqual({
      resolvedAuthMode: "api-key",
      envVars: { OPENAI_API_KEY: "openai-key" },
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "OPENAI_API_KEY", { fresh: true });
  });

  it("does not fall back to an API key for subscription preference", async () => {
    await expect(
      resolveCodexContainerAuth(
        mockEnv({ OPENAI_API_KEY: "openai-key" }),
        {
          authPreference: "subscription",
        },
      ),
    ).rejects.toThrow("app-server runtime auth");
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("fails explicit API key auth when the key is unavailable", async () => {
    await expect(
      resolveCodexContainerAuth(
        mockEnv({}),
        {
          authPreference: "api-key",
        },
      ),
    ).rejects.toThrow("OPENAI_API_KEY is not configured");
  });
});

describe("resolveOpenCodeContainerAuth", () => {
  it("reads only the OpenAI key for an OpenCode GPT model", async () => {
    await expect(resolveOpenCodeContainerAuth(
      mockEnv({ OPENAI_API_KEY: "openai-key", CLAUDE_CODE_OAUTH_TOKEN: "inactive" }),
      OPENAI_OPENCODE_MODEL,
    )).resolves.toEqual({
      model: "gpt-5.6-sol",
      baseUrl: "https://api.openai.com/v1",
      token: "openai-key",
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "OPENAI_API_KEY", { fresh: true });
  });

  it("uses the internal credential-not-configured reason for a missing OpenCode GPT key", async () => {
    await expect(resolveOpenCodeContainerAuth(mockEnv({}), OPENAI_OPENCODE_MODEL)).rejects.toMatchObject({
      reason: "credential-not-configured",
      message: expect.stringContaining("requires OPENAI_API_KEY"),
    });
  });

  it("reads only the Anthropic key for an OpenCode Claude model", async () => {
    await expect(resolveOpenCodeContainerAuth(
      mockEnv({
        ANTHROPIC_API_KEY: "anthropic-key",
        OPENAI_API_KEY: "inactive-openai-key",
        CLAUDE_CODE_OAUTH_TOKEN: "inactive-subscription-token",
        [OPENCODE_PROXY_TOKEN_KEY]: "inactive-proxy-token",
      }),
      ANTHROPIC_OPENCODE_MODEL,
    )).resolves.toEqual({
      model: "claude-opus-5",
      baseUrl: "https://api.anthropic.com/v1",
      token: "anthropic-key",
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "ANTHROPIC_API_KEY", { fresh: true });
    expect(getOrCreateSecret).not.toHaveBeenCalled();
  });

  it("does not fall back when an OpenCode Claude model is missing its Anthropic key", async () => {
    await expect(resolveOpenCodeContainerAuth(
      mockEnv({
        OPENAI_API_KEY: "inactive-openai-key",
        CLAUDE_CODE_OAUTH_TOKEN: "inactive-subscription-token",
        [OPENCODE_PROXY_TOKEN_KEY]: "inactive-proxy-token",
      }),
      ANTHROPIC_OPENCODE_MODEL,
    )).rejects.toMatchObject({
      reason: "credential-not-configured",
      message: expect.stringContaining("requires ANTHROPIC_API_KEY"),
    });
    expect(getSecret).toHaveBeenCalledTimes(1);
    expect(getSecret).toHaveBeenCalledWith(expect.anything(), "ANTHROPIC_API_KEY", { fresh: true });
    expect(getOrCreateSecret).not.toHaveBeenCalled();
  });

  it("returns a hub-managed proxy token when configured", async () => {
    await expect(
      resolveOpenCodeContainerAuth(
        mockEnv({
          [OPENCODE_PROXY_TOKEN_KEY]: "proxy-token-123",
        }),
        KIMI_K2_7_MODEL,
      ),
    ).resolves.toEqual({
      model: "@cf/moonshotai/kimi-k2.7-code",
      baseUrl: null,
      token: "proxy-token-123",
    });
    expect(getSecret).not.toHaveBeenCalled();
  });

  it("creates a proxy token when one is missing", async () => {
    getOrCreateSecret.mockResolvedValueOnce("generated-proxy-token");
    await expect(resolveOpenCodeContainerAuth(mockEnv({}), KIMI_K2_7_MODEL)).resolves.toEqual({
      model: "@cf/moonshotai/kimi-k2.7-code",
      baseUrl: null,
      token: "generated-proxy-token",
    });
  });
});
