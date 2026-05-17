import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, HostServiceRegistration } from "../types";

const {
  getSecret,
  resolveDeploymentModeForRuntime,
  readRegisteredHostService,
  readRoutableHostService,
} = vi.hoisted(() => ({
  getSecret: vi.fn(),
  resolveDeploymentModeForRuntime: vi.fn(),
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
}));

vi.mock("../setup/config", () => ({
  getSecret,
  resolveDeploymentModeForRuntime,
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
    codexGatewayAuth: "session-token",
    claudeSubscription: true,
    transport: "session",
    ...overrides,
  };
}

function buildLegacyHost(overrides: Partial<HostServiceRegistration>): HostServiceRegistration {
  const host = buildHost(overrides);
  delete host.codexGatewayAuth;
  return host;
}

describe("resolveCodexModelRoute", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getSecret.mockImplementation(async (_env: Env, key: string) => (
      key === "TILLER_DEPLOYMENT_MODE" ? "self-host" : undefined
    ));
    resolveDeploymentModeForRuntime.mockResolvedValue("self-host");
    readRegisteredHostService.mockResolvedValue(null);
    readRoutableHostService.mockResolvedValue(null);
    global.fetch = vi.fn(async () => Response.json({
      ok: true,
      capabilities: {
        codexSubscription: true,
        codexGatewayAuth: "session-token",
      },
    })) as typeof fetch;
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
      machineId: "host-1",
      providerBaseUrl: "http://host.docker.internal:8788/v1",
      responsesUrl: "http://host.docker.internal:8788/codex/responses",
      codexRouteStatus: "available",
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
      reason: "Codex requires the selected Tiller Self Host to be connected or an API key.",
      codexRouteStatus: "host_offline",
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
      reason: "Codex requires a connected Tiller Self Host or an API key.",
      codexRouteStatus: "host_offline",
    });
  });

  it("rejects hosted gateways that do not advertise session-token Codex auth", async () => {
    readRegisteredHostService.mockResolvedValue(buildHost({
      machineId: "host-1",
      gatewayUrl: "https://tiller-gateway.example.com",
    }));
    readRoutableHostService.mockResolvedValue(buildLegacyHost({
      machineId: "host-1",
      gatewayUrl: "https://tiller-gateway.example.com",
    }));

    await expect(
      resolveCodexModelRoute(mockEnv(), { target: "hosted" }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "Codex requires an updated Subscription Gateway with subscription session-token support.",
      codexRouteStatus: "unavailable",
    });
  });

  it("rejects healthy hosted gateways whose health check lacks session-token Codex auth", async () => {
    readRegisteredHostService.mockResolvedValue(buildHost({
      machineId: "host-1",
      gatewayUrl: "https://tiller-gateway.example.com",
    }));
    readRoutableHostService.mockResolvedValue(buildHost({
      machineId: "host-1",
      gatewayUrl: "https://tiller-gateway.example.com",
    }));
    global.fetch = vi.fn(async () => Response.json({
      ok: true,
      capabilities: {
        codexSubscription: true,
      },
    })) as typeof fetch;

    await expect(
      resolveCodexModelRoute(mockEnv(), { target: "hosted" }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "Codex requires an updated Subscription Gateway with subscription session-token support.",
      codexRouteStatus: "unavailable",
    });
  });

  it("can resolve subscription route status without API key fallback", async () => {
    getSecret.mockImplementation(async (_env: Env, key: string) => (
      key === "TILLER_DEPLOYMENT_MODE" ? "self-host" : key === "OPENAI_API_KEY" ? "sk-api-key" : undefined
    ));

    await expect(
      resolveCodexModelRoute(mockEnv(), { target: "hosted", allowApiFallback: false }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "Codex requires a running Subscription Gateway.",
      codexRouteStatus: "host_offline",
    });
  });
});
