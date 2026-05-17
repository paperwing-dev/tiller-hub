import { Hono } from "hono";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HonoEnv } from "../types";

const {
  readRegisteredHostService,
  readRoutableHostService,
} = vi.hoisted(() => ({
  readRegisteredHostService: vi.fn(),
  readRoutableHostService: vi.fn(),
}));

vi.mock("../service-registry", () => ({
  readRegisteredHostService,
  readRoutableHostService,
  isQuickTunnelUrl: (url: string) => url.includes("trycloudflare.com"),
}));

import hostRoutes from "../host/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", hostRoutes);
  return app;
}

describe("GET /api/host/status", () => {
  beforeEach(() => {
    readRegisteredHostService.mockReset();
    readRoutableHostService.mockReset();
  });

  it("returns disconnected when no host is registered", async () => {
    readRegisteredHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request("http://localhost/api/host/status", {}, {} as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      registered: false,
      connected: false,
      gatewayConfigured: false,
      gatewayAvailable: false,
      state: "not-registered",
      machine: null,
    });
    expect(readRoutableHostService).not.toHaveBeenCalled();
  });

  it("returns connected=false when host is registered but WS is not routable", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-123",
      connectedAt: "2026-04-07T00:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: false,
      gatewayPort: 8788,
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue(null);

    const app = createApp();
    const res = await app.request("http://localhost/api/host/status", {}, {} as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      registered: true,
      connected: false,
      gatewayConfigured: false,
      gatewayAvailable: false,
      state: "registered-offline",
      machine: {
        machineId: "host-123",
        connectedAt: "2026-04-07T00:00:00.000Z",
        codexSubscription: true,
        claudeSubscription: false,
      },
    });
    expect(readRoutableHostService).toHaveBeenCalledWith(expect.anything(), "host-123");
  });

  it("returns connected-no-gateway when the host is live without a published gateway", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-456",
      connectedAt: "2026-04-07T12:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue({
      machineId: "host-456",
      connectedAt: "2026-04-07T12:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      transport: "session",
    });

    const app = createApp();
    const res = await app.request("http://localhost/api/host/status", {}, {} as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      registered: true,
      connected: true,
      gatewayConfigured: false,
      gatewayAvailable: false,
      state: "connected-no-gateway",
      machine: {
        machineId: "host-456",
        connectedAt: "2026-04-07T12:00:00.000Z",
        codexSubscription: true,
        claudeSubscription: true,
      },
    });
  });

  it("returns gateway-unavailable when the host is live but the published gateway is not usable", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-456",
      connectedAt: "2026-04-07T12:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      gatewayUrl: "https://tiller-gateway.example.com",
      gatewayTunnelType: "named",
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue({
      machineId: "host-456",
      connectedAt: "2026-04-07T12:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      transport: "session",
    });

    const app = createApp();
    const res = await app.request("http://localhost/api/host/status", {}, {} as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      registered: true,
      connected: true,
      gatewayConfigured: true,
      gatewayAvailable: false,
      state: "gateway-unavailable",
      machine: {
        machineId: "host-456",
        connectedAt: "2026-04-07T12:00:00.000Z",
        gatewayUrl: "https://tiller-gateway.example.com",
        gatewayTunnelType: "named",
        codexSubscription: true,
        claudeSubscription: true,
      },
    });
  });

  it("returns gateway-available with full machine detail when host and gateway are live", async () => {
    readRegisteredHostService.mockResolvedValue({
      machineId: "host-456",
      connectedAt: "2026-04-07T12:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      gatewayUrl: "https://tiller-gateway.example.com",
      gatewayTunnelType: "named",
      transport: "session",
    });
    readRoutableHostService.mockResolvedValue({
      machineId: "host-456",
      connectedAt: "2026-04-07T12:00:00.000Z",
      dockerAvailable: true,
      codexSubscription: true,
      claudeSubscription: true,
      gatewayPort: 8788,
      gatewayUrl: "https://tiller-gateway.example.com",
      gatewayTunnelType: "named",
      transport: "session",
    });

    const app = createApp();
    const res = await app.request("http://localhost/api/host/status", {}, {} as any);

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      registered: true,
      connected: true,
      gatewayConfigured: true,
      gatewayAvailable: true,
      state: "gateway-available",
      machine: {
        machineId: "host-456",
        connectedAt: "2026-04-07T12:00:00.000Z",
        gatewayUrl: "https://tiller-gateway.example.com",
        gatewayTunnelType: "named",
        codexSubscription: true,
        claudeSubscription: true,
      },
    });
  });
});
