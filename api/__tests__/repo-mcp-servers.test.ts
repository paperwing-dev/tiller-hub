import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

vi.mock("partyserver", () => ({
  Server: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { HubDO } from "../hub";
import {
  McpServersValidationError,
  REPO_MCP_MAX_SERVERS,
  normalizeRepoMcpServersRequest,
} from "../mcp-servers";
import { CLOUDFLARE_API_MCP_SERVER_ID } from "../cloudflare-mcp";

type SqlResultRow = Record<string, unknown>;

function createSqlResult<T extends SqlResultRow>(rows: T[], rowsWritten = 0) {
  return {
    rowsWritten,
    toArray(): T[] {
      return rows;
    },
    *[Symbol.iterator](): IterableIterator<T> {
      yield* rows;
    },
  };
}

class FakeSqlStorage {
  private readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...params: SQLInputValue[]) {
    if (/^\s*(select|pragma)\b/i.test(query)) {
      const rows = this.db.prepare(query).all(...params) as SqlResultRow[];
      return createSqlResult(rows);
    }

    if (params.length > 0) {
      const result = this.db.prepare(query).run(...params);
      return createSqlResult([], Number(result.changes ?? 0));
    }

    this.db.exec(query);
    return createSqlResult([]);
  }

  close(): void {
    this.db.close();
  }
}

class FakeStorage {
  readonly sql = new FakeSqlStorage();
  private readonly kv = new Map<string, unknown>();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.kv.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }

  async transaction<T>(callback: (txn: FakeStorage) => Promise<T>): Promise<T> {
    return await callback(this);
  }

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  close(): void {
    this.sql.close();
  }
}

function createSubject(env: Record<string, unknown> = {}) {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(ctx as any, env as any);
  return { subject, storage };
}

function unwrapPutResult(result: ReturnType<HubDO["putRepoMcpServers"]>) {
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.servers;
}

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("repo MCP server storage", () => {
  it("generates IDs, trims labels, canonicalizes URLs, and lists enabled servers", async () => {
    const { subject, storage } = createSubject();

    const servers = unwrapPutResult(subject.putRepoMcpServers("repo-1", {
      servers: [
        {
          label: "  Cloudflare Docs  ",
          url: "https://DOCS.MCP.CLOUDFLARE.COM:443/mcp",
          enabled: true,
        },
        {
          label: "Disabled",
          url: "https://example.com/mcp",
          enabled: false,
        },
      ],
    }));

    expect(servers).toEqual([
      {
        id: expect.stringMatching(/^tiller_[a-z2-7]+$/),
        label: "Cloudflare Docs",
        url: "https://docs.mcp.cloudflare.com/mcp",
        enabled: true,
      },
      {
        id: expect.stringMatching(/^tiller_[a-z2-7]+$/),
        label: "Disabled",
        url: "https://example.com/mcp",
        enabled: false,
      },
    ]);
    expect(subject.listEnabledRepoMcpServers("repo-1")).toEqual([servers[0]]);

    storage.close();
  });

  it("does full-list replacement and rejects unknown client-provided IDs", async () => {
    const { subject, storage } = createSubject();
    const [server] = unwrapPutResult(subject.putRepoMcpServers("repo-1", {
      servers: [{ label: "One", url: "https://one.example.com/mcp", enabled: true }],
    }));

    const rejected = subject.putRepoMcpServers("repo-1", {
      servers: [{ id: "tiller_client", label: "Client", url: "https://two.example.com/mcp", enabled: true }],
    });
    expect(rejected).toEqual({ ok: false, error: "Unknown MCP server id." });

    const updated = unwrapPutResult(subject.putRepoMcpServers("repo-1", {
      servers: [{ id: server.id, label: "Updated", url: "https://updated.example.com/mcp", enabled: false }],
    }));
    expect(updated).toEqual([{
      id: server.id,
      label: "Updated",
      url: "https://updated.example.com/mcp",
      enabled: false,
    }]);

    storage.close();
  });

  it("rejects duplicate IDs and duplicate enabled canonical URLs", () => {
    expect(() => normalizeRepoMcpServersRequest({
      servers: [
        { id: "tiller_a", label: "A", url: "https://a.example.com/mcp", enabled: true },
        { id: "tiller_a", label: "B", url: "https://b.example.com/mcp", enabled: true },
      ],
    }, { existingIds: ["tiller_a"] })).toThrow(McpServersValidationError);

    expect(() => normalizeRepoMcpServersRequest({
      servers: [
        { label: "A", url: "https://EXAMPLE.com:443/mcp", enabled: true },
        { label: "B", url: "https://example.com/mcp", enabled: true },
      ],
    }, {
      existingIds: [],
      generateId: (existingIds) => `tiller_${Array.from(existingIds).length}`,
    })).toThrow(McpServersValidationError);

    expect(normalizeRepoMcpServersRequest({
      servers: [
        { label: "A", url: "https://example.com/mcp", enabled: true },
        { label: "B", url: "https://example.com/mcp", enabled: false },
      ],
    }, {
      existingIds: [],
      generateId: (existingIds) => `tiller_${Array.from(existingIds).length}`,
    })).toHaveLength(2);
  });

  it("rejects the managed Cloudflare API MCP id in generic MCP settings", () => {
    expect(() => normalizeRepoMcpServersRequest({
      servers: [
        {
          id: "tiller_cloudflare_api",
          label: "Cloudflare API",
          url: "https://mcp.cloudflare.com/mcp",
          enabled: true,
        },
      ],
    }, { existingIds: ["tiller_cloudflare_api"] })).toThrow("MCP server id is reserved by Tiller.");

    expect(() => normalizeRepoMcpServersRequest({
      servers: [
        {
          label: "Cloudflare API",
          url: "https://mcp.cloudflare.com/mcp",
          enabled: true,
        },
      ],
    }, {
      existingIds: [],
      generateId: () => "tiller_cloudflare_api",
    })).toThrow("MCP server id is reserved by Tiller.");
  });

  it("rejects invalid public HTTPS URLs and limits", () => {
    const invalidUrls = [
      "http://example.com/mcp",
      "https://user:pass@example.com/mcp",
      "https://example.com/mcp?token=1",
      "https://example.com/mcp?",
      "https://example.com/mcp#frag",
      "https://example.com/mcp#",
      "https://127.0.0.1/mcp",
      "https://[::1]/mcp",
      "https://localhost/mcp",
      "https://repo-internal/mcp",
      "https://service.local/mcp",
      "https://service.test/mcp",
      "https://service.onion/mcp",
      "https://router.home.arpa/mcp",
    ];

    for (const url of invalidUrls) {
      expect(() => normalizeRepoMcpServersRequest({
        servers: [{ label: "Bad", url, enabled: true }],
      }, { existingIds: [], generateId: () => "tiller_a" })).toThrow(McpServersValidationError);
    }

    expect(() => normalizeRepoMcpServersRequest({
      servers: Array.from({ length: REPO_MCP_MAX_SERVERS + 1 }, (_, index) => ({
        label: `Server ${index}`,
        url: `https://server-${index}.example.com/mcp`,
        enabled: false,
      })),
    }, { existingIds: [], generateId: (existingIds) => `tiller_${Array.from(existingIds).length}` })).toThrow(McpServersValidationError);
  });

  it("deletes all MCP server rows for a repo", async () => {
    const { subject, storage } = createSubject();

    unwrapPutResult(subject.putRepoMcpServers("repo-1", {
      servers: [{ label: "One", url: "https://one.example.com/mcp", enabled: true }],
    }));
    unwrapPutResult(subject.putRepoMcpServers("repo-2", {
      servers: [{ label: "Two", url: "https://two.example.com/mcp", enabled: true }],
    }));
    subject.deleteRepoMcpServers("repo-1");

    expect(subject.listRepoMcpServers("repo-1")).toEqual([]);
    expect(subject.listRepoMcpServers("repo-2")).toHaveLength(1);

    storage.close();
  });

  it("sanitizes dynamic Cloudflare MCP OAuth client registration network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network secret")));
    const { subject, storage } = createSubject();

    await expect(subject.startRepoCloudflareMcpOAuth("repo-1", {
      redirectUri: "https://hub.example.com/api/repos/repo-1/cloudflare-mcp/callback",
      hubOrigin: "https://hub.example.com",
    })).rejects.toMatchObject({
      status: 502,
      code: "cloudflare_oauth_registration_failed",
      message: "Cloudflare OAuth client registration failed.",
    });

    storage.close();
  });

  it("stores Cloudflare MCP OAuth credentials encrypted and revokes launch tokens", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href === "https://mcp.cloudflare.com/token") {
        return new Response(JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 3600,
          scope: "accounts:read",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (href.startsWith("https://api.cloudflare.com/client/v4/accounts")) {
        return new Response(JSON.stringify({
          result: [{ id: "account-1", name: "Paperwing" }],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { subject, storage } = createSubject({
      CLOUDFLARE_MCP_OAUTH_CLIENT_ID: "client-1",
      CLOUDFLARE_MCP_OAUTH_CLIENT_SECRET: "client-secret",
    });
    const redirectUri = "https://hub.example.com/api/repos/repo-1/cloudflare-mcp/callback";

    const started = await subject.startRepoCloudflareMcpOAuth("repo-1", {
      redirectUri,
      hubOrigin: "https://hub.example.com",
      requestIdentity: "cf-access-email:user@example.com",
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const connected = await subject.completeRepoCloudflareMcpOAuth("repo-1", {
      state,
      code: "oauth-code",
      redirectUri,
      requestIdentity: "cf-access-email:user@example.com",
    });

    expect(connected).toMatchObject({
      status: "connected",
      connected: true,
      enabled: false,
      account: { id: "account-1", name: "Paperwing" },
    });
    const credentialRow = storage.sql.exec(
      `SELECT encrypted_access_token, encrypted_refresh_token, client_id FROM repo_cloudflare_mcp_credentials WHERE repo_id = ?`,
      "repo-1",
    ).toArray()[0];
    expect(JSON.stringify(credentialRow)).not.toContain("access-secret");
    expect(JSON.stringify(credentialRow)).not.toContain("refresh-secret");
    expect(JSON.stringify(credentialRow)).not.toContain("client-secret");
    await expect(subject.getValidCloudflareMcpAccessToken("repo-1")).resolves.toEqual({
      accessToken: "access-secret",
    });

    expect(subject.enableRepoCloudflareMcp("repo-1")).toMatchObject({ enabled: true });
    const token = await subject.mintCloudflareMcpProxyToken("repo-1", "env-1");
    expect(token).toMatch(/^tcmpt_/);
    await expect(subject.validateCloudflareMcpProxyToken(token!)).resolves.toEqual({
      ok: true,
      repoId: "repo-1",
      envSlug: "env-1",
      serverId: CLOUDFLARE_API_MCP_SERVER_ID,
    });
    subject.revokeCloudflareMcpProxyTokensForEnv("env-1");
    await expect(subject.validateCloudflareMcpProxyToken(token!)).resolves.toEqual({
      ok: false,
      code: "cloudflare_proxy_auth_failed",
    });

    storage.close();
  });

  it("keeps Cloudflare MCP audit events when disconnecting", async () => {
    const { subject, storage } = createSubject();

    subject.recordCloudflareMcpAuditEvent({
      repoId: "repo-1",
      envSlug: "env-1",
      serverId: CLOUDFLARE_API_MCP_SERVER_ID,
      httpMethod: "POST",
      jsonRpcMethod: "tools/list",
      responseStatus: 200,
      errorCode: null,
    });
    subject.disconnectRepoCloudflareMcp("repo-1");

    expect(storage.sql.exec(
      `SELECT COUNT(*) AS count FROM repo_cloudflare_mcp_audit_events WHERE repo_id = ?`,
      "repo-1",
    ).toArray()[0]).toEqual({ count: 1 });

    storage.close();
  });

  it("does not mark reauth required for transient Cloudflare token refresh failures", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      const body = typeof init?.body === "string" ? init.body : "";
      if (href === "https://mcp.cloudflare.com/token" && body.includes("grant_type=authorization_code")) {
        return new Response(JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          expires_in: 1,
          scope: "accounts:read",
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (href === "https://mcp.cloudflare.com/token" && body.includes("grant_type=refresh_token")) {
        return new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("not found", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { subject, storage } = createSubject({
      CLOUDFLARE_MCP_OAUTH_CLIENT_ID: "client-1",
    });
    const redirectUri = "https://hub.example.com/api/repos/repo-1/cloudflare-mcp/callback";
    const started = await subject.startRepoCloudflareMcpOAuth("repo-1", {
      redirectUri,
      hubOrigin: "https://hub.example.com",
    });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    await subject.completeRepoCloudflareMcpOAuth("repo-1", {
      state,
      code: "oauth-code",
      redirectUri,
    });
    subject.enableRepoCloudflareMcp("repo-1");
    storage.sql.exec(
      `UPDATE repo_cloudflare_mcp_credentials SET expires_at = ? WHERE repo_id = ?`,
      Date.now() - 1000,
      "repo-1",
    );

    await expect(subject.getValidCloudflareMcpAccessToken("repo-1")).rejects.toMatchObject({
      code: "cloudflare_upstream_error",
    });
    expect(subject.getRepoCloudflareMcpStatus("repo-1")).toMatchObject({
      status: "connected",
      enabled: true,
      lastAuthError: null,
    });

    storage.close();
  });
});
