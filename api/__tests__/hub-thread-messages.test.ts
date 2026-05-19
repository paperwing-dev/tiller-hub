import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";

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

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { HubDO } from "../hub";
import { ThreadDO } from "../coordination";
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

  exec(query: string, ...params: unknown[]) {
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

  close(): void {
    this.sql.close();
  }
}

class FakeThreadNamespace {
  private readonly instances = new Map<string, { storage: FakeStorage; thread: ThreadDO }>();

  idFromName(name: string): string {
    return name;
  }

  // Mirrors CF Workers' DO stub behavior: method calls are wrapped in Promises.
  // Tests that need to inspect the underlying storage should use getRaw().
  get(id: string): ThreadDO {
    const real = this.getRaw(id);
    return new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) =>
          Promise.resolve((value as (...a: unknown[]) => unknown).apply(target, args));
      },
    }) as unknown as ThreadDO;
  }

  getRaw(id: string): ThreadDO {
    const existing = this.instances.get(id);
    if (existing) return existing.thread;

    const storage = new FakeStorage();
    const ctx = { storage };
    const thread = new ThreadDO(ctx as any, {} as any);
    this.instances.set(id, { storage, thread });
    return thread;
  }

  close(): void {
    for (const { storage } of this.instances.values()) {
      storage.close();
    }
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
  const threadNamespace = new FakeThreadNamespace();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(ctx as any, { THREAD: threadNamespace } as any);
  const connections = new Map<string, FakeConnection>();

  (subject as any).getConnections = () => connections.values();

  return { subject, storage, threadNamespace, connections };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HubDO thread-backed messages", () => {
  it("broadcasts session-updated when a managed session is created", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    const observer = createConnection("conn-1");
    connections.set(observer.id, observer);

    const session = subject.createSession(
      "session-1",
      "demo-env",
      null,
      { envSlug: "demo-env", role: "lead" },
    );

    expect(session).toMatchObject({
      id: "session-1",
      tag: "demo-env",
      active: 1,
    });
    expect(observer.sent).toHaveLength(1);
    expect(JSON.parse(observer.sent[0])).toMatchObject({
      type: "session-updated",
      session: expect.objectContaining({
        id: "session-1",
        tag: "demo-env",
        active: 1,
      }),
    });

    threadNamespace.close();
    storage.close();
  });

  it("writes new session messages to ThreadDO while preserving the session message surface", async () => {
    const { subject, storage, threadNamespace } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const result = await subject.addMessage("msg-1", "session-1", { type: "sync" }, "local-1");

    expect(result.sessionSeq).toBe(1);
    expect(result.message).toMatchObject({
      id: "msg-1",
      session_id: "session-1",
      seq: 1,
      local_id: "local-1",
    });

    const messages = await subject.getMessages("session-1", { limit: 10 });
    expect(messages).toHaveLength(1);
    expect(JSON.parse(messages[0].content)).toEqual({ type: "sync" });

    const thread = threadNamespace.getRaw("session:session-1");
    expect(thread.getThread()).toMatchObject({
      id: "session:session-1",
      scope: { type: "session", sessionId: "session-1" },
      kind: "chat",
    });
    expect(thread.listMessages({ limit: 10 })).toMatchObject([
      {
        id: "msg-1",
        seq: 1,
        senderSessionId: "session-1",
        kind: "chat",
        body: { type: "sync" },
        localId: "local-1",
      },
    ]);

    threadNamespace.close();
    storage.close();
  });

  it("replays thread-backed session messages on reconnect", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage("msg-1", "session-1", { type: "first" }, null);
    await subject.addMessage("msg-2", "session-1", { type: "threaded" }, null);

    const latest = await subject.getMessages("session-1", { limit: 10 });
    expect(latest.map((message) => message.id)).toEqual(["msg-2", "msg-1"]);

    const connection = createConnection("conn-1", { sessionId: "session-1" });
    connections.set(connection.id, connection);

    await (subject as any).handleReconnect(connection, { type: "reconnect", lastSeq: 0 });

    expect(connection.sent).toHaveLength(2);
    expect(JSON.parse(connection.sent[0])).toMatchObject({
      type: "session-updated",
      session: expect.objectContaining({ id: "session-1", active: 1 }),
    });
    expect(JSON.parse(connection.sent[1])).toMatchObject({
      type: "replay",
      events: [
        { id: "msg-1", sessionId: "session-1", content: { type: "first" }, seq: 1 },
        { id: "msg-2", sessionId: "session-1", content: { type: "threaded" }, seq: 2 },
      ],
    });

    threadNamespace.close();
    storage.close();
  });

  it("binds sessionId from reconnect payload, revives the session, and replays missed messages", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage("msg-1", "session-1", { type: "first" }, null);
    await subject.addMessage("msg-2", "session-1", { type: "second" }, null);
    subject.setSessionActive("session-1", false);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    await (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 1,
    });

    expect(connection.state).toMatchObject({ sessionId: "session-1" });
    expect(subject.getSession("session-1")).toMatchObject({
      id: "session-1",
      active: 1,
      ended_at: null,
    });
    expect(connection.sent).toHaveLength(2);
    expect(JSON.parse(connection.sent[0])).toMatchObject({
      type: "session-updated",
      session: expect.objectContaining({ id: "session-1", active: 1 }),
    });
    expect(JSON.parse(connection.sent[1])).toMatchObject({
      type: "replay",
      events: [
        { id: "msg-2", sessionId: "session-1", content: { type: "second" }, seq: 2 },
      ],
    });

    threadNamespace.close();
    storage.close();
  });

  it("broadcasts session-updated when session active state changes", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    const observer = createConnection("conn-1");
    connections.set(observer.id, observer);

    subject.createSession("session-1", "demo-env", null, { envSlug: "demo-env", role: "lead" });
    observer.sent.length = 0;

    subject.setSessionActive("session-1", false);

    expect(observer.sent).toHaveLength(1);
    expect(JSON.parse(observer.sent[0])).toMatchObject({
      type: "session-updated",
      session: expect.objectContaining({
        id: "session-1",
        active: 0,
      }),
    });

    threadNamespace.close();
    storage.close();
  });
});
