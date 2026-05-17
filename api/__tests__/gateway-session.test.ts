import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import type { Env } from "../types";

const { getValidOpenAIAuth, readRoutableHostService } = vi.hoisted(() => ({
  getValidOpenAIAuth: vi.fn(),
  readRoutableHostService: vi.fn(),
}));

vi.mock("../openai-auth", () => ({
  getValidOpenAIAuth,
}));

vi.mock("../service-registry", () => ({
  readRoutableHostService,
}));

import {
  exchangeCodexGatewaySessionToken,
  mintCodexGatewaySessionToken,
  revokeCodexGatewaySessionsForEnv,
} from "../gateway-session";

function createKv() {
  const store = new Map<string, string>();
  return {
    store,
    kv: {
      get: vi.fn(async (key: string, type?: "json") => {
        const value = store.get(key) ?? null;
        return type === "json" && value ? JSON.parse(value) : value;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
      list: vi.fn(async ({ prefix }: { prefix?: string }) => ({
        keys: Array.from(store.keys())
          .filter((name) => !prefix || name.startsWith(prefix))
          .map((name) => ({ name })),
        list_complete: true,
      })),
    },
  };
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mockEnv(): Env {
  const { kv } = createKv();
  return { ENVS_KV: kv } as unknown as Env;
}

describe("Codex gateway session tokens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getValidOpenAIAuth.mockResolvedValue({
      access_token: "chatgpt-access",
      account_id: "acct-123",
      expires_at: Date.now() + 3600_000,
    });
    readRoutableHostService.mockResolvedValue({
      machineId: "machine-123",
      connectedAt: "2026-05-01T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: false,
      gatewayPort: 8788,
      gatewayUrl: "https://gateway.example.com",
      gatewayServiceTokenHash: sha256Hex("gateway-secret"),
      transport: "session",
    });
  });

  it("exchanges a scoped gateway session token for short-lived ChatGPT access", async () => {
    const env = mockEnv();
    const minted = await mintCodexGatewaySessionToken(env, {
      envSlug: "env-1",
      routeKind: "gateway-subscription",
      machineId: "machine-123",
      gatewayUrl: "https://gateway.example.com",
    });

    await expect(
      exchangeCodexGatewaySessionToken(env, {
        token: minted.token,
        gatewayMachineId: "machine-123",
        gatewayServiceToken: "gateway-secret",
      }),
    ).resolves.toEqual({
      accessToken: "chatgpt-access",
      accountId: "acct-123",
      expiresAt: expect.any(Number),
    });
    expect(readRoutableHostService).toHaveBeenCalledWith(expect.anything(), "machine-123");
  });

  it("rejects a token after the env sessions are revoked", async () => {
    const env = mockEnv();
    const minted = await mintCodexGatewaySessionToken(env, {
      envSlug: "env-1",
      routeKind: "host-gateway",
      machineId: "machine-123",
    });

    await expect(revokeCodexGatewaySessionsForEnv(env, "env-1")).resolves.toBe(1);
    await expect(
      exchangeCodexGatewaySessionToken(env, {
        token: minted.token,
        gatewayMachineId: "machine-123",
        gatewayServiceToken: "gateway-secret",
      }),
    ).rejects.toThrow("invalid or expired");
  });

  it("rejects direct container exchange without the registered gateway credential", async () => {
    const env = mockEnv();
    const minted = await mintCodexGatewaySessionToken(env, {
      envSlug: "env-1",
      routeKind: "gateway-subscription",
      machineId: "machine-123",
      gatewayUrl: "https://gateway.example.com",
    });

    await expect(
      exchangeCodexGatewaySessionToken(env, {
        token: minted.token,
        gatewayMachineId: "machine-123",
      }),
    ).rejects.toThrow("Gateway service credential is required");
  });
});
