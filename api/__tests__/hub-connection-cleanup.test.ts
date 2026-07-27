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

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
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
    state: initialState,
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

describe("HubDO connection cleanup", () => {
  it("does not deactivate a session or broadcast deletion on websocket close", () => {
    const { subject, storage, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const connection = createConnection("conn-1", { sessionId: "session-1" });
    connections.set(connection.id, connection);

    (subject as any).cleanupConnection(connection);

    expect(subject.getSession("session-1")).toMatchObject({
      id: "session-1",
      active: 1,
      ended_at: null,
    });
    expect(connection.sent).toEqual([]);

    storage.close();
  });
});
