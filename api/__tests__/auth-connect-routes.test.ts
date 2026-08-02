import { Hono } from "hono";
import { compactDecrypt, exportJWK, generateKeyPair } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import authConnectRoutes from "../cli/auth-connect-routes";
import type { HonoEnv } from "../types";

function createApp() {
  const app = new Hono<HonoEnv>();
  app.route("/", authConnectRoutes);
  return app;
}

function createEnv(overrides: Record<string, unknown> = {}) {
  const auth = {
    issueAuthConnectGrants: vi.fn(async () => ({ codex: "codex-grant", claude: "claude-grant" })),
    consumeAuthConnectGrant: vi.fn(async () => true),
    connectCodexAuth: vi.fn(async () => ({
      ok: true,
      credential: {
        accessToken: "projected-access-token",
        accountId: "acct-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      },
    })),
    ...(overrides.auth as Record<string, unknown> ?? {}),
  };
  const hub = {
    setConfig: vi.fn(async () => undefined),
    ...(overrides.hub as Record<string, unknown> ?? {}),
  };
  return {
    env: {
      CODEX_AUTH: { idFromName: () => "codex-auth-id", get: () => auth },
      HUB: { idFromName: () => "hub-id", get: () => hub },
    } as unknown as HonoEnv["Bindings"],
    auth,
    hub,
  };
}

describe("subscription authentication connection routes", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("issues one encrypted owner package with provider-scoped grants", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ECDH-ES", { crv: "P-256", extractable: true });
    const publicKeyJwk = await exportJWK(publicKey);
    const { env, auth } = createEnv();
    const response = await createApp().request(
      "https://hub.example.test/api/cli/auth-connect-package",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicKeyJwk, state: "state-1", providers: ["codex", "claude"] }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const envelope = (await response.json() as { envelope: string }).envelope;
    const decrypted = await compactDecrypt(envelope, privateKey);
    expect(decrypted.protectedHeader).toMatchObject({ typ: "tiller-auth-connect+jwe" });
    expect(JSON.parse(new TextDecoder().decode(decrypted.plaintext))).toMatchObject({
      version: 1,
      hubUrl: "https://hub.example.test",
      state: "state-1",
      grants: { codex: "codex-grant", claude: "claude-grant" },
    });
    expect(auth.issueAuthConnectGrants).toHaveBeenCalledWith(["codex", "claude"]);
  });

  it("rejects credential uploads when only normal service authentication is present", async () => {
    const { env, auth } = createEnv();
    const response = await createApp().request(
      "https://hub.example.test/api/auth/subscriptions/codex/connect",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: 1, auth_json: "opaque-auth" }),
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(auth.connectCodexAuth).not.toHaveBeenCalled();
  });

  it("consumes the Codex grant before connecting and activates subscription billing", async () => {
    const { env, auth, hub } = createEnv();
    const response = await createApp().request(
      "https://hub.example.test/api/auth/subscriptions/codex/connect",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Auth-Grant": "codex-grant",
        },
        body: JSON.stringify({ version: 1, auth_json: "opaque-auth" }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(auth.consumeAuthConnectGrant).toHaveBeenCalledWith("codex", "codex-grant");
    expect(auth.consumeAuthConnectGrant.mock.invocationCallOrder[0]).toBeLessThan(
      auth.connectCodexAuth.mock.invocationCallOrder[0],
    );
    expect(auth.connectCodexAuth).toHaveBeenCalledWith("opaque-auth");
    expect(hub.setConfig).toHaveBeenCalledWith("openaiBillingMode", "subscription");
  });

  it("stores a Claude setup token as the existing runtime secret and activates billing", async () => {
    const { env, auth, hub } = createEnv();
    const response = await createApp().request(
      "https://hub.example.test/api/auth/subscriptions/claude/connect",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Auth-Grant": "claude-grant",
        },
        body: JSON.stringify({ version: 1, oauth_token: "claude-oauth-secret" }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(auth.consumeAuthConnectGrant).toHaveBeenCalledWith("claude", "claude-grant");
    expect(hub.setConfig).toHaveBeenNthCalledWith(1, "CLAUDE_CODE_OAUTH_TOKEN", "claude-oauth-secret");
    expect(hub.setConfig).toHaveBeenNthCalledWith(2, "claudeBillingMode", "subscription");
  });

  it("enforces the 64 KiB upload boundary before consuming a grant", async () => {
    const { env, auth } = createEnv();
    const response = await createApp().request(
      "https://hub.example.test/api/auth/subscriptions/codex/connect",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Auth-Grant": "codex-grant",
        },
        body: JSON.stringify({ version: 1, auth_json: "x".repeat(64 * 1_024) }),
      },
      env,
    );
    expect(response.status).toBe(413);
    expect(auth.consumeAuthConnectGrant).not.toHaveBeenCalled();
  });

  it("returns only sanitized provider failures after consuming the grant", async () => {
    const { env } = createEnv({
      auth: {
        connectCodexAuth: vi.fn(async () => ({
          ok: false,
          reason: "needs_reconnect",
          message: "provider detail containing secret-sentinel",
        })),
      },
    });
    const response = await createApp().request(
      "https://hub.example.test/api/auth/subscriptions/codex/connect",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Tiller-Auth-Grant": "codex-grant",
        },
        body: JSON.stringify({ version: 1, auth_json: "opaque-auth" }),
      },
      env,
    );
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("secret-sentinel");
  });
});
