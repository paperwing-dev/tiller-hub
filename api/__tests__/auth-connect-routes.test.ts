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
    recordAuthConnectResult: vi.fn(async () => true),
    getAuthConnectStatus: vi.fn(async () => ({
      status: "pending" as const,
      providers: { codex: "pending" as const },
    })),
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

  it("redirects legacy approval links into Global Settings", async () => {
    const { env } = createEnv();
    const response = await createApp().request(
      "https://hub.example.test/cli/auth-connect?port=1455&state=state-1&key=public-key&providers=codex",
      undefined,
      env,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/settings?auth_connect=1&port=1455&state=state-1&key=public-key&providers=codex",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

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
    const approval = await response.json() as { envelope: string; connection_id: string };
    const envelope = approval.envelope;
    const decrypted = await compactDecrypt(envelope, privateKey);
    expect(decrypted.protectedHeader).toMatchObject({ typ: "tiller-auth-connect+jwe" });
    expect(JSON.parse(new TextDecoder().decode(decrypted.plaintext))).toMatchObject({
      version: 1,
      hubUrl: "https://hub.example.test",
      state: "state-1",
      grants: { codex: "codex-grant", claude: "claude-grant" },
    });
    expect(approval.connection_id).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(auth.issueAuthConnectGrants).toHaveBeenCalledWith(
      ["codex", "claude"],
      approval.connection_id,
    );
  });

  it("reports tracked connection progress to Settings", async () => {
    const { env, auth } = createEnv({
      auth: {
        getAuthConnectStatus: vi.fn(async () => ({
          status: "success",
          providers: { codex: "success" },
        })),
      },
    });
    const response = await createApp().request(
      "https://hub.example.test/api/cli/auth-connect-status?connection_id=connection-id-1234",
      undefined,
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "success", providers: { codex: "success" } });
    expect(auth.getAuthConnectStatus).toHaveBeenCalledWith("connection-id-1234");
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
    expect(auth.recordAuthConnectResult).toHaveBeenCalledWith("codex", "codex-grant", "success", undefined);
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
    expect(auth.recordAuthConnectResult).toHaveBeenCalledWith("claude", "claude-grant", "success", undefined);
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
    const { env, auth } = createEnv({
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
    expect(auth.recordAuthConnectResult).toHaveBeenCalledWith(
      "codex",
      "codex-grant",
      "error",
      "Codex rejected the subscription login. Run `tiller auth connect codex` again.",
    );
  });
});
