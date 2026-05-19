import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HostServiceRegistration } from "../types";

const {
  getValidOpenAIAuth,
  getSecret,
  readRegisteredHostService,
  readRoutableHostService,
} = vi.hoisted(() => ({
  getValidOpenAIAuth: vi.fn(),
  getSecret: vi.fn(),
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
}));

vi.mock("../openai-auth", () => ({
  getValidOpenAIAuth,
}));

vi.mock("../setup/config", () => ({
  getSecret,
}));

vi.mock("../service-registry", () => ({
  readRegisteredHostService,
  readRoutableHostService,
}));

import { resolveCodexModelRoute } from "../model-route";

function mockEnv(overrides: Record<string, unknown> = {}): Env {
  return overrides as unknown as Env;
}

function buildHost(overrides: Partial<HostServiceRegistration>): HostServiceRegistration {
  return {
    machineId: "host-1",
    connectedAt: "2026-04-13T00:00:00.000Z",
    dockerAvailable: true,
    codexSubscription: true,
    claudeSubscription: true,
    transport: "session",
    ...overrides,
  };
}

describe("resolveCodexModelRoute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getValidOpenAIAuth.mockResolvedValue({
      access_token: "access-token",
      account_id: "acct-123",
    });
    getSecret.mockResolvedValue(undefined);
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);
    global.fetch = vi.fn(async () => new Response("ok", { status: 200 })) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the selected host machine for host-gateway routing", async () => {
    readRoutableHostService.mockImplementation(async (_env: Env, machineId?: string | null) => {
      if (machineId === "host-1") {
        return buildHost({ machineId: "host-1", gatewayPort: 8788 });
      }
      return buildHost({ machineId: "host-2", gatewayPort: 9898 });
    });

    await expect(
      resolveCodexModelRoute(mockEnv(), { target: "host", machineId: "host-1" }),
    ).resolves.toEqual({
      kind: "host-gateway",
      providerBaseUrl: "http://host.docker.internal:8788/v1",
      responsesUrl: "http://host.docker.internal:8788/codex/responses",
      accessToken: "access-token",
      accountId: "acct-123",
    });
    expect(readRoutableHostService).toHaveBeenCalledWith(expect.anything(), "host-1");
  });

  it("reports a selected host as unavailable when that machine is not routable", async () => {
    readRegisteredHostService.mockResolvedValue(buildHost({
      machineId: "host-1",
      gatewayPort: 8788,
    }));

    await expect(
      resolveCodexModelRoute(mockEnv(), { target: "host", machineId: "host-1" }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "Codex requires the selected Tiller Host to be connected or an OpenAI API key.",
    });
  });

  it("does not treat durable-only hosted gateway registration as an available hosted route", async () => {
    readRegisteredHostService.mockResolvedValue(buildHost({
      machineId: "host-1",
      gatewayUrl: "https://tiller-gateway.example.com",
    }));

    await expect(
      resolveCodexModelRoute(mockEnv(), { target: "hosted" }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "Codex requires a running Tiller Host gateway or an OpenAI API key.",
    });
  });
});
