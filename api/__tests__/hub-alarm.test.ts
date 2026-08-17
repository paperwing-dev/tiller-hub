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

    getConnections(): Iterable<{ id: string; readyState: number; send: (payload: string) => void }> {
      return [];
    }

    send(connection: { send: (payload: string) => void }, payload: unknown): void {
      connection.send(JSON.stringify(payload));
    }

    broadcastToAll(payload: unknown, excludeConnectionId?: string): void {
      for (const connection of this.getConnections()) {
        if (excludeConnectionId && connection.id === excludeConnectionId) continue;
        if (connection.readyState !== 1) continue;
        connection.send(JSON.stringify(payload));
      }
    }
  },
}));

import { HubDO } from "../hub";
import type { WsConnectionState } from "../types";

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
  private alarm: number | null = null;

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  close(): void {
    this.sql.close();
  }
}

type FakeConnection = {
  id: string;
  readyState: number;
  sent: string[];
  state: WsConnectionState;
  setState: (next: WsConnectionState | ((state: WsConnectionState) => WsConnectionState)) => WsConnectionState;
  send: (payload: string) => void;
};

function createConnection(id: string, initialState: WsConnectionState = {}): FakeConnection {
  return {
    id,
    readyState: 1,
    sent: [],
    state: {
      authorization: { kind: "global", source: "local-dev" },
      ...initialState,
    },
    setState(next) {
      this.state = typeof next === "function" ? next(this.state) : next;
      return this.state;
    },
    send(payload) {
      this.sent.push(payload);
    },
  };
}

function createSubject() {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(ctx as any, {} as any);
  const connections = new Map<string, FakeConnection>();

  (subject as any).getConnections = () => connections.values();

  return { subject, storage, connections };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HubDO alarm cleanup", () => {
  it("keeps active unattached sessions alive while still cleaning inactive and stale ended sessions", async () => {
    const { subject, storage, connections } = createSubject();

    subject.createSession("active-session", "demo-env", null, {});
    subject.createSession("inactive-session", "demo-env", null, {});
    subject.setSessionActive("inactive-session", false);
    subject.createSession("stale-session", "demo-env", null, {});

    (subject as any).db.exec(
      "UPDATE sessions SET active = 0, ended_at = datetime('now', '-25 hours') WHERE id = ?",
      "stale-session",
    );

    const observer = createConnection("observer");
    connections.set(observer.id, observer);

    await subject.onAlarm();

    expect(subject.getSession("active-session")).toMatchObject({
      id: "active-session",
      active: 1,
      ended_at: null,
    });
    expect(subject.getSession("inactive-session")).toMatchObject({
      id: "inactive-session",
      active: 0,
    });
    expect(subject.getSession("inactive-session")?.ended_at).not.toBeNull();
    expect(subject.getSession("stale-session")).toBeNull();
    expect(observer.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "session-deleted", sessionId: "inactive-session" },
    ]);

    storage.close();
  });

  it("does not count explicit viewer session connections as live session references", async () => {
    const { subject, storage, connections } = createSubject();

    subject.createSession("viewer-session", "demo-env", null, {});
    subject.setSessionActive("viewer-session", false);

    const viewer = createConnection("viewer", {
      sessionId: "viewer-session",
      sessionLifecycle: "viewer",
    });
    const observer = createConnection("observer");
    connections.set(viewer.id, viewer);
    connections.set(observer.id, observer);

    await subject.onAlarm();

    expect(subject.getSession("viewer-session")).toMatchObject({
      id: "viewer-session",
      active: 0,
    });
    expect(subject.getSession("viewer-session")?.ended_at).not.toBeNull();
    expect(observer.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: "session-deleted", sessionId: "viewer-session" },
    ]);

    storage.close();
  });
});
