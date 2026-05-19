import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

import cliRoutes from "../cli/routes";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", cliRoutes);
  return app;
}

describe("GET /api/cli/bootstrap-config", () => {
  it("returns public bootstrap config for workers.dev hubs", async () => {
    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/cli/bootstrap-config",
      {},
      {} as any,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      hubUrl: "https://demo.preview.workers.dev",
      protectionMode: "public",
      gatewayHostname: null,
    });
  });

  it("returns public bootstrap config for custom domains without Access", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/bootstrap-config",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      hubUrl: "https://tiller.example.com",
      protectionMode: "public",
      gatewayHostname: "tiller-gateway.example.com",
    });
  });

  it("returns Access credentials for protected custom domains with a stored service token", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/bootstrap-config",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_CLIENT_ID: "client-id.access",
        CF_ACCESS_CLIENT_SECRET: "client-secret",
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      hubUrl: "https://tiller.example.com",
      protectionMode: "cf-access",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      gatewayHostname: "tiller-gateway.example.com",
    });
  });

  it("returns a structured error when a protected hub is missing the stored service token", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/bootstrap-config",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "missing_service_token",
    });
  });
});

describe("GET /cli/bootstrap", () => {
  it("renders neutral connection copy for tiller commands", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/cli/bootstrap?port=8788&state=test",
      {},
      {} as any,
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connect Tiller");
    expect(html).toContain("Connection complete");
    expect(html).toContain("Connection code");
    expect(html).toContain("Copy code");
    expect(html).not.toContain("Complete local bootstrap");
    expect(html).not.toContain("Tiller is connected");
  });
});

describe("GET /api/cli/host-bootstrap", () => {
  it("returns the stored managed gateway tunnel bootstrap", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/host-bootstrap",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_APP_ID: "hub-app",
        CF_ACCESS_BROWSER_POLICY_ID: "browser-policy",
        CF_ACCESS_CLIENT_ID: "client-id.access",
        CF_ACCESS_CLIENT_SECRET: "client-secret",
        CF_ACCESS_SERVICE_TOKEN_ID: "service-token",
        CF_ACCESS_GATEWAY_APP_ID: "gateway-app",
        CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: "gateway-policy",
        TILLER_GATEWAY_HOSTNAME: "tiller-gateway.example.com",
        TILLER_GATEWAY_TUNNEL_ID: "tunnel-123",
        TILLER_GATEWAY_TUNNEL_TOKEN: "token-123",
        TILLER_GATEWAY_TUNNEL_TARGET_PORT: "8788",
      } as any,
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      gatewayHostname: "tiller-gateway.example.com",
      gatewayTunnelId: "tunnel-123",
      gatewayTunnelName: "tiller-gateway",
      gatewayTunnelToken: "token-123",
      gatewayTargetPort: 8788,
    });
  });

  it("returns a structured error when the gateway tunnel bootstrap is missing", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/host-bootstrap",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_APP_ID: "hub-app",
        CF_ACCESS_BROWSER_POLICY_ID: "browser-policy",
        CF_ACCESS_CLIENT_ID: "client-id.access",
        CF_ACCESS_CLIENT_SECRET: "client-secret",
        CF_ACCESS_SERVICE_TOKEN_ID: "service-token",
        CF_ACCESS_GATEWAY_APP_ID: "gateway-app",
        CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: "gateway-policy",
        TILLER_GATEWAY_HOSTNAME: "tiller-gateway.example.com",
      } as any,
    );

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({
      code: "gateway_unavailable",
    });
  });
});
