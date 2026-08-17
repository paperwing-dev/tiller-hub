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
          label: "  Documentation  ",
          url: "https://DOCS.EXAMPLE.COM:443/mcp",
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
        label: "Disabled",
        url: "https://example.com/mcp",
        enabled: false,
      },
      {
        id: expect.stringMatching(/^tiller_[a-z2-7]+$/),
        label: "Documentation",
        url: "https://docs.example.com/mcp",
        enabled: true,
      },
    ]);
    expect(subject.listEnabledRepoMcpServers("repo-1")).toEqual([servers[1]]);

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

  it("does not reserve provider-specific MCP server IDs", () => {
    expect(normalizeRepoMcpServersRequest({
      servers: [
        {
          id: "tiller_cloudflare_api",
          label: "Provider API",
          url: "https://api.example.com/mcp",
          enabled: true,
        },
      ],
    }, { existingIds: ["tiller_cloudflare_api"] })).toEqual([{
      id: "tiller_cloudflare_api",
      label: "Provider API",
      url: "https://api.example.com/mcp",
      enabled: true,
    }]);

    expect(normalizeRepoMcpServersRequest({
      servers: [
        {
          label: "Provider API",
          url: "https://api.example.com/mcp",
          enabled: true,
        },
      ],
    }, {
      existingIds: [],
      generateId: () => "tiller_cloudflare_api",
    })).toEqual([{
      id: "tiller_cloudflare_api",
      label: "Provider API",
      url: "https://api.example.com/mcp",
      enabled: true,
    }]);
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

});
