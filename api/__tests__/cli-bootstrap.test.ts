import { Hono } from "hono";
import { compactDecrypt, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { HonoEnv } from "../types";
import { installedAccessBindings } from "./access-binding-fixture";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
  getOrCreateSecret: async (
    env: Record<string, unknown>,
    key: string,
    createValue: () => string,
  ) => {
    const existing = env[key];
    if (typeof existing === "string" && existing) return existing;
    const generated = createValue();
    env[key] = generated;
    return generated;
  },
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
      "https://tiller.preview.workers.dev/api/cli/bootstrap-config",
      {},
      {} as any,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    await expect(res.json()).resolves.toEqual({
      hubUrl: "https://tiller.preview.workers.dev",
      protectionMode: "public",
    });
  });

});

describe("GET /cli/bootstrap", () => {
  it("renders neutral connection copy for tiller commands", async () => {
    const app = createApp();
    const res = await app.request(
      "https://tiller.preview.workers.dev/cli/bootstrap?port=8788&state=test",
      {},
      {} as any,
    );

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Connect Tiller");
    expect(html).toContain("Connection complete");
    expect(html).toContain("Connection code");
    expect(html).toContain("Copy code");
    expect(html).toContain("hideConnectionCode();");
    expect(html).toContain("This Hub needs Access repair");
    expect(html).toContain("documented maintainer Access repair procedure");
    expect(html).not.toContain("/api/setup/workers-dev-access/oauth/start");
    expect(html).not.toContain("install.paperwing.dev/maintenance");
    expect(html).toContain("CONNECTION_REQUEST_TTL_MS");
    expect(html).toContain("createdAt: Date.now()");
    expect(html).not.toContain("Complete local bootstrap");
    expect(html).not.toContain("Tiller is connected");
  });
});

describe("POST /api/cli/connect-package", () => {
  it("returns an owner package encrypted to the supplied ephemeral P-256 key", async () => {
    const app = createApp();
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const publicKeyJwk = await exportJWK(publicKey);
    const trust = {
      version: 1,
      ownerEmail: "owner@example.com",
      accountId: "",
      workerName: "tiller",
      workersDevHostname: "tiller.preview.workers.dev",
      issuer: "https://team.cloudflareaccess.com",
      audience: "audience-1",
      serviceTokenId: "token-1",
      serviceClientId: "client-id.access",
      configuredAt: "2026-07-16T00:00:00.000Z",
    };
    const credential = {
      version: 1,
      currentSecret: "client-secret",
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
      updatedAt: "2026-07-16T00:00:00.000Z",
    };
    const env = {
      ...installedAccessBindings({
        hostname: trust.workersDevHostname,
        issuer: trust.issuer,
        audience: trust.audience,
        serviceClientId: trust.serviceClientId,
        serviceClientSecret: credential.currentSecret,
        ownerEmail: trust.ownerEmail,
        tokenExpiresAt: credential.tokenExpiresAt,
      }),
    } as any;
    const res = await app.request(
      "https://tiller.preview.workers.dev/api/cli/connect-package",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyJwk, state: "state-1" }),
      },
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as { envelope: string };
    expect(body.envelope).not.toContain("client-secret");
    const decrypted = await compactDecrypt(body.envelope, privateKey);
    expect(decrypted.protectedHeader).toMatchObject({
      alg: "ECDH-ES",
      enc: "A256GCM",
      typ: "tiller-connect+jwe",
    });
    const connection = JSON.parse(new TextDecoder().decode(decrypted.plaintext));
    expect(connection).toMatchObject({
      hubUrl: "https://tiller.preview.workers.dev",
      clientId: "client-id.access",
      clientSecret: "client-secret",
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
      state: "state-1",
    });
    expect(connection.controlSecret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(body.envelope).not.toContain(connection.controlSecret);

    const nextKeys = await generateKeyPair("ECDH-ES", { crv: "P-256" });
    const nextResponse = await app.request(
      "https://tiller.preview.workers.dev/api/cli/connect-package",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyJwk: await exportJWK(nextKeys.publicKey), state: "state-2" }),
      },
      env,
    );
    const nextBody = await nextResponse.json() as { envelope: string };
    const nextDecrypted = await compactDecrypt(nextBody.envelope, nextKeys.privateKey);
    const nextConnection = JSON.parse(new TextDecoder().decode(nextDecrypted.plaintext));
    expect(nextConnection.controlSecret).toBe(connection.controlSecret);
  });

  it("rejects an oversized streamed package request before reading credentials", async () => {
    const get = vi.fn();
    const res = await createApp().request(
      "https://tiller.preview.workers.dev/api/cli/connect-package",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "x".repeat(8 * 1_024 + 1),
      },
      {
        HUB: {
          idFromName: vi.fn(),
          get,
        },
      } as any,
    );

    expect(res.status).toBe(400);
    expect(get).not.toHaveBeenCalled();
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
