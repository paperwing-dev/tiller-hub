import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { SELF_HOST_STATE_KEY, type PromotedSelfHostState } from "../self-host/state";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  invalidateConfigCache: vi.fn(),
}));

import { authMiddleware } from "../auth";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.use("/api/*", authMiddleware);
  app.get("/api/setup/status", (c) => c.json({ ok: true }));
  app.post("/api/setup/self-host/prepare", (c) => c.json({ ok: true }));
  app.post("/api/setup/self-host/progress", (c) => c.json({ ok: true }));
  app.get("/api/setup/self-host/lifecycle", (c) => c.json({ ok: true }));
  app.post("/api/setup/self-host/return-to-hosted", (c) => c.json({ ok: true }));
  return app;
}

function promotedState(): PromotedSelfHostState {
  return {
    schemaVersion: 2,
    phase: "promoted",
    attemptId: "attempt-1",
    expiresAt: "2999-01-01T00:00:00.000Z",
    rollback: {
      workersDevHubUrl: "https://demo.preview.workers.dev",
      workerServiceName: "tiller",
      workersDevAliasDisabled: "false",
      cfAccessConfigured: "true",
      browserAccess: {
        appId: "workers-app",
        aud: "workers-aud",
        issuer: "https://workers.cloudflareaccess.com",
        jwksUrl: "https://workers.cloudflareaccess.com/cdn-cgi/access/certs",
        appDomain: "demo.preview.workers.dev",
        appType: null,
        overlappingWildcardAppDomain: null,
        browserPolicyId: "workers-browser-policy",
      },
    },
    resources: {
      workerCustomDomain: {
        hostname: "tiller.example.com",
        hubUrl: "https://tiller.example.com",
        service: "tiller",
        zoneName: "example.com",
        accountId: "acc-1",
        zoneId: "zone-1",
        domainId: "domain-1",
      },
      hubAccess: {
        appId: "hub-app",
        aud: "hub-aud",
        appDomain: "tiller.example.com",
        issuer: "https://team.cloudflareaccess.com",
        jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
        accessTeamDomain: "team.cloudflareaccess.com",
        browserPolicyId: "browser-policy",
        serviceTokenId: "service-token",
        serviceTokenPolicyId: "service-policy",
        clientId: "client-id.access",
      },
      gateway: {
        hostname: "tiller-gateway.example.com",
        appId: "gateway-app",
        appDomain: "tiller-gateway.example.com",
        serviceTokenPolicyId: "gateway-policy",
        tunnelId: "tunnel-1",
        tunnelName: "tiller-gateway-abcd1234",
        tunnelTargetPort: 8788,
      },
    },
    secretMaterial: { enableToken: "enable-token" },
  };
}

function envWithState() {
  const config = {
    [SELF_HOST_STATE_KEY]: JSON.stringify(promotedState()),
  };
  const store = {
    getConfig: vi.fn((key: string) => config[key as keyof typeof config]),
  };
  return {
    HUB_PUBLIC_URL: "https://tiller.example.com",
    CF_ACCESS_AUD: "hub-aud",
    CF_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    CF_ACCESS_CLIENT_ID: "client-id.access",
    CF_ACCESS_CLIENT_SECRET: "client-secret",
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => store),
    },
  } as unknown as HonoEnv["Bindings"];
}

describe("Self Host auth policy", () => {
  it("rejects service-token-only workers.dev prepare requests", async () => {
    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/self-host/prepare",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      {
        HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
        CF_ACCESS_CONFIGURED: "true",
        CF_ACCESS_AUD: "workers-aud",
        CF_ACCESS_TEAM_DOMAIN: "https://workers.cloudflareaccess.com",
        CF_ACCESS_CLIENT_ID: "client-id.access",
        CF_ACCESS_CLIENT_SECRET: "client-secret",
      } as unknown as HonoEnv["Bindings"],
    );

    expect(res.status).toBe(401);
  });

  it("rejects service-token-only workers.dev recovery status requests", async () => {
    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/status",
      {
        method: "GET",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      envWithState(),
    );

    expect(res.status).toBe(401);
  });

  it("rejects service-token-only workers.dev recovery return-to-hosted requests", async () => {
    const app = createApp();
    const res = await app.request(
      "https://demo.preview.workers.dev/api/setup/self-host/return-to-hosted",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      envWithState(),
    );

    expect(res.status).toBe(401);
  });

  it("allows progress only with the active Access service token", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/progress",
      {
        method: "POST",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      envWithState(),
    );

    expect(res.status).toBe(200);
  });

  it("rejects service-token-only lifecycle polling", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.example.com/api/setup/self-host/lifecycle?attemptId=attempt-1",
      {
        method: "GET",
        headers: {
          "CF-Access-Client-Id": "client-id.access",
          "CF-Access-Client-Secret": "client-secret",
        },
      },
      envWithState(),
    );

    expect(res.status).toBe(401);
  });
});
