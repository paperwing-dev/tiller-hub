import { describe, expect, it, vi } from "vitest";
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

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  close(): void {
    this.sql.close();
  }
}

import { HubDO } from "../hub";

function createSubject() {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(ctx as any, {} as any);
  return { subject, storage };
}

describe("HubDO workers.dev Access claim", () => {
  it("atomically claims an empty Access config", () => {
    const { subject, storage } = createSubject();

    const result = subject.claimWorkersDevAccessConfig({
      audience: "aud-123",
      teamDomain: "https://team.cloudflareaccess.com",
    });

    expect(result).toEqual({
      claimed: true,
      audience: "aud-123",
      teamDomain: "https://team.cloudflareaccess.com",
    });
    expect(subject.getConfig("CF_ACCESS_CONFIGURED")).toBe("true");
    expect(subject.getConfig("CF_ACCESS_AUD")).toBe("aud-123");
    expect(subject.getConfig("CF_ACCESS_TEAM_DOMAIN")).toBe("https://team.cloudflareaccess.com");

    storage.close();
  });

  it("does not overwrite existing hub Access metadata", () => {
    const { subject, storage } = createSubject();
    subject.setConfig("CF_ACCESS_APP_ID", "existing-app");

    const result = subject.claimWorkersDevAccessConfig({
      audience: "aud-123",
      teamDomain: "https://team.cloudflareaccess.com",
    });

    expect(result).toEqual({
      claimed: false,
      audience: null,
      teamDomain: null,
    });
    expect(subject.getConfig("CF_ACCESS_APP_ID")).toBe("existing-app");
    expect(subject.getConfig("CF_ACCESS_AUD")).toBeUndefined();

    storage.close();
  });

  it("does not block claim on unrelated gateway metadata", () => {
    const { subject, storage } = createSubject();
    subject.setConfig("TILLER_GATEWAY_TUNNEL_ID", "leftover-tunnel");

    const result = subject.claimWorkersDevAccessConfig({
      audience: "aud-123",
      teamDomain: "https://team.cloudflareaccess.com",
    });

    expect(result.claimed).toBe(true);
    expect(subject.getConfig("TILLER_GATEWAY_TUNNEL_ID")).toBe("leftover-tunnel");
    expect(subject.getConfig("CF_ACCESS_AUD")).toBe("aud-123");

    storage.close();
  });
});
