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

  it("does not expose Access service-token secrets for protected custom domains", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/bootstrap-config",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        CF_ACCESS_CLIENT_ID: "client-id.access",
        CF_ACCESS_CLIENT_SECRET: "client-secret",
      } as any,
    );

    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body).toMatchObject({
      code: "generic_secret_bootstrap_disabled",
      hubUrl: "https://tiller.example.com",
      protectionMode: "cf-access",
      gatewayHostname: "tiller-gateway.example.com",
    });
    expect(body).not.toHaveProperty("clientId");
    expect(body).not.toHaveProperty("clientSecret");
  });

  it("does not expose a generic secret bootstrap path even when the stored service token is missing", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/bootstrap-config",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      } as any,
    );

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({
      code: "generic_secret_bootstrap_disabled",
    });
  });

  it("does not re-expose service-token credentials after Self Host handoff consumption", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/bootstrap-config",
      {},
      {
        HUB_PUBLIC_URL: "https://tiller.example.com",
        CF_ACCESS_AUD: "aud",
        CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        CF_ACCESS_CLIENT_ID: "client-id.access",
        CF_ACCESS_CLIENT_SECRET: "client-secret",
      } as any,
    );

    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toMatchObject({
      code: "generic_secret_bootstrap_disabled",
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
  it("is removed", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/cli/host-bootstrap",
      {},
      {} as any,
    );

    expect(res.status).toBe(404);
  });
});
