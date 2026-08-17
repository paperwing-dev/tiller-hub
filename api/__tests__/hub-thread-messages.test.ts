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

    getConnections(): Iterable<{
      id: string;
      readyState: number;
      send: (payload: string) => void;
    }> {
      return [];
    }

    send(
      connection: { send: (payload: string) => void },
      payload: unknown,
    ): void {
      connection.send(JSON.stringify(payload));
    }

    broadcastToAll(payload: unknown, excludeConnectionId?: string): void {
      for (const connection of this.getConnections()) {
        if (excludeConnectionId && connection.id === excludeConnectionId)
          continue;
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

vi.mock("../auth", () => ({
  authenticateWebSocketAuthorization: vi.fn(async () => ({
    kind: "global",
    source: "local-dev",
  })),
}));

import { HubDO } from "../hub";
import { ThreadDO } from "../coordination";
import type { WsClientMessage, WsConnectionState, WsServerMessage } from "../types";
import { planWriterTerminalId } from "../planner/runtime-identity";
import { authenticateWebSocketAuthorization } from "../auth";

type SqlResultRow = Record<string, unknown>;

const WS_CLIENT_AUTHORIZATION_CASES: ReadonlyArray<{
  type: WsClientMessage["type"];
  scoped: boolean;
  message: (sessionId: string) => WsClientMessage;
}> = [
  { type: "ping", scoped: true, message: () => ({ type: "ping" }) },
  {
    type: "reconnect",
    scoped: true,
    message: (sessionId) => ({ type: "reconnect", lastSeq: 0, sessionId }),
  },
  {
    type: "terminal-input",
    scoped: false,
    message: (sessionId) => ({
      type: "terminal-input",
      sessionId,
      clientId: "client-1",
      inputSeq: 1,
      data: "whoami",
    }),
  },
  {
    type: "terminal-control",
    scoped: false,
    message: (sessionId) => ({
      type: "terminal-control",
      sessionId,
      clientId: "client-1",
      controlSeq: 1,
      action: "abort",
    }),
  },
  {
    type: "terminal-input-ack",
    scoped: true,
    message: (sessionId) => ({
      type: "terminal-input-ack",
      sessionId,
      clientId: "client-1",
      inputSeq: 1,
      ok: true,
    }),
  },
  {
    type: "terminal-control-ack",
    scoped: true,
    message: (sessionId) => ({
      type: "terminal-control-ack",
      sessionId,
      clientId: "client-1",
      controlSeq: 1,
      ok: true,
    }),
  },
  {
    type: "message",
    scoped: true,
    message: (sessionId) => ({
      type: "message",
      id: "message-1",
      sessionId,
      content: { type: "terminal-output", data: "ok" },
    }),
  },
  {
    type: "session-alive",
    scoped: true,
    message: (sessionId) => ({ type: "session-alive", sessionId }),
  },
  {
    type: "terminal-detach",
    scoped: false,
    message: (sessionId) => ({
      type: "terminal-detach",
      sessionId,
      clientId: "client-1",
    }),
  },
  {
    type: "session-end",
    scoped: true,
    message: (sessionId) => ({ type: "session-end", sessionId }),
  },
  {
    type: "update-metadata",
    scoped: false,
    message: (sessionId) => ({
      type: "update-metadata",
      sessionId,
      metadata: {},
      expectedVersion: 1,
    }),
  },
  {
    type: "update-agent-state",
    scoped: true,
    message: (sessionId) => ({
      type: "update-agent-state",
      sessionId,
      agentState: {},
      expectedVersion: 1,
    }),
  },
  {
    type: "update-todos",
    scoped: true,
    message: (sessionId) => ({
      type: "update-todos",
      sessionId,
      todos: [],
      expectedVersion: 1,
    }),
  },
  {
    type: "machine-alive",
    scoped: false,
    message: () => ({ type: "machine-alive", machineId: "machine-1" }),
  },
  {
    type: "machine-update-metadata",
    scoped: false,
    message: () => ({
      type: "machine-update-metadata",
      machineId: "machine-1",
      metadata: {},
      expectedVersion: 1,
    }),
  },
  {
    type: "machine-update-runner-state",
    scoped: false,
    message: () => ({
      type: "machine-update-runner-state",
      machineId: "machine-1",
      runnerState: {},
      expectedVersion: 1,
    }),
  },
  {
    type: "runner-control-response",
    scoped: false,
    message: () => ({
      type: "runner-control-response",
      requestId: "request-1",
      ok: true,
    }),
  },
];

const GLOBAL_BROADCAST_MESSAGES: ReadonlyArray<WsServerMessage> = [
  { type: "repo-remove", repoId: "repo-1" },
  { type: "env-remove", slug: "env-1" },
  { type: "machine-updated", machine: {} as never },
  { type: "permission-created", permission: {} as never },
  {
    type: "plan-artifact-updated",
    repoId: "repo-1",
    planArtifactId: "plan-1",
  },
  { type: "session-deleted", sessionId: "session-1" },
];

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
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async setAlarm(timestamp: number): Promise<void> {
    this.alarm = timestamp;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  transactionSync<T>(closure: () => T): T {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const result = closure();
      this.sql.exec("COMMIT");
      return result;
    } catch (error) {
      this.sql.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.sql.close();
  }
}

class FakeThreadNamespace {
  private readonly instances = new Map<
    string,
    { storage: FakeStorage; thread: ThreadDO }
  >();

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
          Promise.resolve(
            (value as (...a: unknown[]) => unknown).apply(target, args),
          );
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

  has(id: string): boolean {
    return this.instances.has(id);
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
  setState: (
    next: WsConnectionState | ((state: WsConnectionState) => WsConnectionState),
  ) => WsConnectionState;
  send: (payload: string) => void;
  close: (code: number, reason: string) => void;
  closed: { code: number; reason: string } | null;
};

function createConnection(
  id: string,
  initialState: WsConnectionState = {},
): FakeConnection {
  return {
    id,
    readyState: 1,
    sent: [],
    state: {
      authorization: { kind: "global", source: "local-dev" },
      ...initialState,
    },
    closed: null,
    setState(next) {
      this.state = typeof next === "function" ? next(this.state) : next;
      return this.state;
    },
    send(payload) {
      this.sent.push(payload);
    },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = WebSocket.CLOSED;
    },
  };
}

function createSubject(terminalMetrics = false) {
  const storage = new FakeStorage();
  const threadNamespace = new FakeThreadNamespace();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(
    ctx as any,
    {
      THREAD: threadNamespace,
      LOCAL_DEV_ONLY_BACKEND: "true",
      ...(terminalMetrics ? { TILLER_TERMINAL_METRICS: "1" } : {}),
    } as any,
  );
  const connections = new Map<string, FakeConnection>();

  (subject as any).getConnections = () => connections.values();

  return { subject, storage, threadNamespace, connections };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HubDO thread-backed messages", () => {
  it("closes connections rejected by the HubDO authorization classifier", async () => {
    const { subject, storage, threadNamespace } = createSubject();
    vi.mocked(authenticateWebSocketAuthorization).mockRejectedValueOnce(
      new Error("Unauthorized"),
    );
    const connection = createConnection("unauthorized");

    await subject.onConnect(
      connection as any,
      {
        request: new Request("http://localhost/parties/hub/hub"),
      } as any,
    );

    expect(connection.closed).toEqual({ code: 4001, reason: "Unauthorized" });
    expect(connection.sent.map((entry) => JSON.parse(entry))).toContainEqual({
      type: "error",
      message: "Unauthorized",
    });
    threadNamespace.close();
    storage.close();
  });

  it("sends terminal fast-lane capabilities on connect", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    await subject.onConnect(
      connection as any,
      {
        request: new Request("http://localhost/parties/hub/hub"),
      } as any,
    );

    expect(connection.sent).toHaveLength(1);
    expect(JSON.parse(connection.sent[0])).toEqual({
      type: "capabilities",
      terminalFastLane: true,
      terminalMetrics: false,
    });

    threadNamespace.close();
    storage.close();
  });

  it("accepts only environment handshakes whose selected session belongs to that environment", async () => {
    const { subject, storage, threadNamespace } = createSubject();
    subject.createSession("session-1", "Implementor", null, {
      envSlug: "env-1",
      role: "lead",
      terminalScope: { kind: "environment", envSlug: "env-1", role: "lead" },
    });
    vi.mocked(authenticateWebSocketAuthorization).mockResolvedValueOnce({
      kind: "environment",
      envSlug: "env-1",
      sessionId: "session-1",
    });
    const accepted = createConnection("accepted");
    await subject.onConnect(
      accepted as any,
      {
        request: new Request("http://localhost/parties/hub/hub"),
      } as any,
    );
    expect(accepted.closed).toBeNull();
    expect(accepted.state).toMatchObject({
      authorization: {
        kind: "environment",
        envSlug: "env-1",
        sessionId: "session-1",
      },
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });

    vi.mocked(authenticateWebSocketAuthorization).mockResolvedValueOnce({
      kind: "environment",
      envSlug: "other-env",
      sessionId: "session-1",
    });
    const rejected = createConnection("rejected");
    await subject.onConnect(
      rejected as any,
      {
        request: new Request("http://localhost/parties/hub/hub"),
      } as any,
    );
    expect(rejected.closed).toEqual({
      code: 4003,
      reason: "Runtime session scope mismatch",
    });

    threadNamespace.close();
    storage.close();
  });

  it("accepts only plan-writer handshakes with the stored generation and session scope", async () => {
    const { subject, storage, threadNamespace } = createSubject();
    subject.createSession("writer-1", "Plan Writer", null, {
      terminalScope: {
        kind: "plan-writer",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        generation: 2,
      },
    });
    vi.mocked(authenticateWebSocketAuthorization).mockResolvedValueOnce({
      kind: "planWriter",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      generation: 2,
      sessionId: "writer-1",
    });
    const accepted = createConnection("accepted");
    await subject.onConnect(
      accepted as any,
      {
        request: new Request("http://localhost/parties/hub/hub"),
      } as any,
    );
    expect(accepted.closed).toBeNull();
    expect(accepted.state.authorization).toMatchObject({
      kind: "planWriter",
      generation: 2,
    });

    vi.mocked(authenticateWebSocketAuthorization).mockResolvedValueOnce({
      kind: "planWriter",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      generation: 3,
      sessionId: "writer-1",
    });
    const rejected = createConnection("rejected");
    await subject.onConnect(
      rejected as any,
      {
        request: new Request("http://localhost/parties/hub/hub"),
      } as any,
    );
    expect(rejected.closed).toEqual({
      code: 4003,
      reason: "Plan writer session scope mismatch",
    });

    threadNamespace.close();
    storage.close();
  });

  it("broadcasts session-updated when a managed session is created", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    const observer = createConnection("conn-1");
    connections.set(observer.id, observer);

    const session = subject.createSession("session-1", "demo-env", null, {
      envSlug: "demo-env",
      role: "lead",
    });

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

  it("keeps a terminal revocation fence when cleanup arrives before creation", () => {
    const { subject, storage, threadNamespace } = createSubject();
    const terminalId = planWriterTerminalId("repo-1", "plan-1", 1);
    const metadata = {
      terminalScope: {
        kind: "plan-writer",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        generation: 1,
      },
    };

    expect(
      subject.revokePlanWriterTerminal(terminalId, "repo-1", "plan-1", 1),
    ).toBeNull();
    expect(
      subject.ensurePlanWriterTerminal(
        terminalId,
        "Plan Writer",
        null,
        metadata,
        "repo-1",
        "plan-1",
        1,
      ),
    ).toEqual({ status: "unavailable" });
    expect(subject.getSession(terminalId)).toBeNull();

    threadNamespace.close();
    storage.close();
  });

  it("writes new session messages to ThreadDO while preserving the session message surface", async () => {
    const { subject, storage, threadNamespace } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const result = await subject.addMessage(
      "msg-1",
      "session-1",
      { type: "sync" },
      "local-1",
    );

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

  it("rejects orphan session appends before creating a ThreadDO history", async () => {
    const { subject, storage, threadNamespace } = createSubject();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    await expect(
      subject.addMessage(
        "message-1",
        "missing-session",
        { secret: "hidden" },
        null,
      ),
    ).rejects.toThrow(/^session_message_commit_failed$/);
    expect(threadNamespace.has("session:missing-session")).toBe(false);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(
      "missing-session",
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("hidden");
    errorLog.mockRestore();

    threadNamespace.close();
    storage.close();
  });

  it("returns an identical UUID canonically without advancing or rebroadcasting", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const observer = createConnection("observer", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    connections.set(observer.id, observer);
    subject.createSession("session-1", "demo-env", null, {});
    observer.sent.length = 0;

    const first = await subject.addMessage(
      "same-id",
      "session-1",
      { z: 1, a: [2] },
      "local-1",
    );
    const duplicate = await subject.addMessage(
      "same-id",
      "session-1",
      { a: [2], z: 1 },
      "local-1",
    );

    expect(duplicate).toEqual(first);
    expect(
      observer.sent
        .map((payload) => JSON.parse(payload))
        .filter((event) => event.type === "message-received"),
    ).toHaveLength(1);
    expect(subject.getSession("session-1")?.seq).toBe(0);
    expect(
      threadNamespace.getRaw("session:session-1").getSequenceAuthority(),
    ).toBe("thread-v1");

    threadNamespace.close();
    storage.close();
  });

  it("rejects conflicting UUID reuse with a sanitized error", async () => {
    const { subject, storage, threadNamespace } = createSubject();
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage("same-id", "session-1", { secret: "first" }, null);

    await expect(
      subject.addMessage("same-id", "session-1", { secret: "second" }, null),
    ).rejects.toThrow(/^session_message_conflict$/);
    expect(
      threadNamespace.getRaw("session:session-1").listMessages({ limit: 10 }),
    ).toHaveLength(1);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("first");
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain("second");
    errorLog.mockRestore();

    threadNamespace.close();
    storage.close();
  });

  it("cuts over after legacy history and rejects post-marker external sequences", () => {
    const { subject, storage, threadNamespace } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    const thread = threadNamespace.getRaw("session:session-1");
    thread.createThread({
      id: "session:session-1",
      scope: { type: "session", sessionId: "session-1" },
      kind: "chat",
    });
    thread.appendMessage({
      id: "legacy",
      senderSessionId: "session-1",
      seq: 7,
      kind: "chat",
      body: { type: "legacy" },
    });

    const appended = thread.appendSessionMessage({
      id: "new",
      sessionId: "session-1",
      senderSessionId: "session-1",
      kind: "chat",
      body: { type: "new" },
    });
    expect(appended.message.seq).toBe(8);
    expect(thread.getCanonicalMaxSequence()).toBe(8);
    expect(thread.getSequenceAuthority()).toBe("thread-v1");
    expect(() =>
      thread.appendMessage({
        id: "late-legacy",
        senderSessionId: "session-1",
        seq: 9,
        kind: "chat",
        body: { type: "late" },
      }),
    ).toThrow(/^legacy_sequence_authority_rejected$/);
    expect(subject.getSession("session-1")?.seq).toBe(0);

    threadNamespace.close();
    storage.close();
  });

  it("reports the canonical maximum required by full rollback reconciliation", async () => {
    const { subject, storage, threadNamespace } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage("message-1", "session-1", { type: "one" }, null);
    await subject.addMessage("message-2", "session-1", { type: "two" }, null);

    await expect(subject.getSessionSequenceReconciliation()).resolves.toEqual([
      {
        sessionId: "session-1",
        deprecatedStoredSeq: 0,
        canonicalThreadSeq: 2,
        authority: "thread-v1",
      },
    ]);

    threadNamespace.close();
    storage.close();
  });

  it("serializes append plus broadcast, recovers after rejection, and cleans completed tails", async () => {
    const { subject, storage, threadNamespace, connections } =
      createSubject(true);
    subject.createSession("session-1", "demo-env", null, {});
    const observer = createConnection("observer", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    connections.set(observer.id, observer);
    observer.sent.length = 0;
    const thread = threadNamespace.getRaw("session:session-1");
    const original = thread.appendSessionMessage.bind(thread);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    (thread as any).appendSessionMessage = async (input: any) => {
      if (input.id === "first") await gate;
      if (input.id === "failed") throw new Error("unsafe terminal content");
      return original(input);
    };

    const first = subject.addMessage(
      "first",
      "session-1",
      { type: "terminal-output", data: "1" },
      null,
    );
    const second = subject.addMessage(
      "second",
      "session-1",
      { type: "terminal-output", data: "2" },
      null,
    );
    await Promise.resolve();
    expect(thread.listMessages({ limit: 10 })).toEqual([]);
    subject.createSession("session-2", "other-env", null, {});
    await expect(
      subject.addMessage(
        "other",
        "session-2",
        { type: "terminal-output", data: "other" },
        null,
      ),
    ).resolves.toMatchObject({ sessionSeq: 1 });
    releaseFirst();
    await Promise.all([first, second]);

    const broadcasts = observer.sent
      .map((payload) => JSON.parse(payload))
      .filter(
        (event) =>
          event.type === "message-received" && event.sessionId === "session-1",
      );
    expect(broadcasts.map((event) => [event.id, event.seq])).toEqual([
      ["first", 1],
      ["second", 2],
    ]);
    await expect(
      subject.addMessage(
        "failed",
        "session-1",
        { type: "terminal-output", data: "do-not-log" },
        null,
      ),
    ).rejects.toThrow(/^session_message_commit_failed$/);
    await expect(
      subject.addMessage(
        "third",
        "session-1",
        { type: "terminal-output", data: "3" },
        null,
      ),
    ).resolves.toMatchObject({ sessionSeq: 3 });
    await Promise.resolve();
    expect((subject as any).sessionAppendTails.size).toBe(0);
    expect((subject as any).terminalAppendQueueMetrics.flush()).toMatchObject({
      label: "hub_terminal_append_queue_wait",
      count: 5,
    });
    expect(
      (subject as any).terminalCommitRoundTripMetrics.flush(),
    ).toMatchObject({
      label: "hub_to_thread_commit_round_trip",
      count: 5,
    });
    expect((subject as any).terminalBroadcastMetrics.flush()).toMatchObject({
      label: "hub_commit_to_broadcast",
      count: 4,
    });

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

    await (subject as any).handleReconnect(connection, {
      type: "reconnect",
      lastSeq: 0,
    });

    expect(connection.sent).toHaveLength(2);
    expect(JSON.parse(connection.sent[0])).toMatchObject({
      type: "session-updated",
      session: expect.objectContaining({ id: "session-1", active: 1 }),
    });
    expect(JSON.parse(connection.sent[1])).toMatchObject({
      type: "replay",
      events: [
        {
          id: "msg-1",
          sessionId: "session-1",
          content: { type: "first" },
          seq: 1,
        },
        {
          id: "msg-2",
          sessionId: "session-1",
          content: { type: "threaded" },
          seq: 2,
        },
      ],
    });

    threadNamespace.close();
    storage.close();
  });

  it("registers a capable owner without replaying historical actions", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage(
      "old-input",
      "session-1",
      {
        type: "user-input",
        role: "user",
        data: "do not replay",
      },
      null,
    );
    const connection = createConnection("replacement-harness");
    connections.set(connection.id, connection);

    await (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: true,
      replay: false,
      registrationId: "registration-1",
      terminalOperationProtocol: 1,
    });

    expect(connection.state).toMatchObject({
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOperationProtocol: 1,
    });
    expect(JSON.parse(connection.sent[connection.sent.length - 1])).toEqual({
      type: "replay",
      events: [],
      baselineSeq: 1,
      sessionId: "session-1",
      registrationId: "registration-1",
    });

    threadNamespace.close();
    storage.close();
  });

  it("orders a baseline acknowledgement within the append-and-broadcast chain", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    const connection = createConnection("replacement-harness");
    connections.set(connection.id, connection);

    let releasePriorAppend!: () => void;
    const priorAppend = new Promise<void>((resolve) => {
      releasePriorAppend = resolve;
    });
    (subject as any).sessionAppendTails.set("session-1", priorAppend);

    const reconnect = (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: true,
      replay: false,
      registrationId: "registration-1",
      terminalOperationProtocol: 1,
    });
    const laterAppend = subject.addMessage(
      "new-input",
      "session-1",
      {
        type: "user-input",
        data: "after baseline",
      },
      null,
    );

    await Promise.resolve();
    expect(
      connection.sent.map((payload) => JSON.parse(payload).type),
    ).not.toContain("replay");

    releasePriorAppend();
    await Promise.all([reconnect, laterAppend]);

    const protocolEvents = connection.sent
      .map((payload) => JSON.parse(payload))
      .filter(
        (payload) =>
          payload.type === "replay" || payload.type === "message-received",
      );
    expect(protocolEvents).toEqual([
      {
        type: "replay",
        events: [],
        baselineSeq: 0,
        sessionId: "session-1",
        registrationId: "registration-1",
      },
      expect.objectContaining({
        type: "message-received",
        id: "new-input",
        sessionId: "session-1",
        seq: 1,
      }),
    ]);

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
        {
          id: "msg-2",
          sessionId: "session-1",
          content: { type: "second" },
          seq: 2,
        },
      ],
    });

    threadNamespace.close();
    storage.close();
  });

  it("correlates normal replay and orders later broadcasts behind its response", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage(
      "missed-input",
      "session-1",
      {
        type: "user-input",
        data: "missed",
      },
      null,
    );
    const connection = createConnection("harness");
    connections.set(connection.id, connection);

    let releasePriorOperation!: () => void;
    const priorOperation = new Promise<void>((resolve) => {
      releasePriorOperation = resolve;
    });
    (subject as any).sessionAppendTails.set("session-1", priorOperation);

    const reconnect = (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: true,
      replay: true,
      registrationId: "replay-1",
      terminalOperationProtocol: 1,
    });
    const laterAppend = subject.addMessage(
      "later-input",
      "session-1",
      {
        type: "user-input",
        data: "later",
      },
      null,
    );

    await Promise.resolve();
    expect(
      connection.sent.map((payload) => JSON.parse(payload).type),
    ).not.toContain("replay");

    releasePriorOperation();
    await Promise.all([reconnect, laterAppend]);

    const protocolEvents = connection.sent
      .map((payload) => JSON.parse(payload))
      .filter(
        (payload) =>
          payload.type === "replay" || payload.type === "message-received",
      );
    expect(protocolEvents).toEqual([
      {
        type: "replay",
        sessionId: "session-1",
        registrationId: "replay-1",
        events: [
          expect.objectContaining({
            type: "message-received",
            id: "missed-input",
            sessionId: "session-1",
            seq: 1,
          }),
        ],
      },
      expect.objectContaining({
        type: "message-received",
        id: "later-input",
        sessionId: "session-1",
        seq: 2,
      }),
    ]);

    threadNamespace.close();
    storage.close();
  });

  it("treats reconnect with revive true as an owner reconnect", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage("msg-1", "session-1", { type: "first" }, null);
    subject.setSessionActive("session-1", false);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    await (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: true,
    });

    expect(connection.state).toMatchObject({
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });
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
        {
          id: "msg-1",
          sessionId: "session-1",
          content: { type: "first" },
          seq: 1,
        },
      ],
    });

    threadNamespace.close();
    storage.close();
  });

  it("binds reconnect with revive false as a viewer replay without reviving the session", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    await subject.addMessage("msg-1", "session-1", { type: "first" }, null);
    subject.setSessionActive("session-1", false);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    await (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: false,
    });

    expect(connection.state).toMatchObject({
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    expect(subject.getSession("session-1")).toMatchObject({
      id: "session-1",
      active: 0,
    });
    expect(connection.sent).toHaveLength(1);
    expect(JSON.parse(connection.sent[0])).toMatchObject({
      type: "replay",
      events: [
        {
          id: "msg-1",
          sessionId: "session-1",
          content: { type: "first" },
          seq: 1,
        },
      ],
    });

    threadNamespace.close();
    storage.close();
  });

  it("binds a viewer without entering the durable append queue when replay is disabled", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    const connection = createConnection("browser");
    connections.set(connection.id, connection);
    const serialize = vi.spyOn(subject as any, "serializeSessionAppend");

    await (subject as any).handleReconnect(connection, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: false,
      replay: false,
    });

    expect(serialize).not.toHaveBeenCalled();
    expect(connection.state).toMatchObject({
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    expect(connection.sent.map((payload) => JSON.parse(payload))).toEqual([{
      type: "replay",
      events: [],
      sessionId: "session-1",
    }]);

    threadNamespace.close();
    storage.close();
  });

  it("promotes session-alive connections to owner lifecycle and revives the session", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    subject.setSessionActive("session-1", false);

    const connection = createConnection("conn-1", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    connections.set(connection.id, connection);

    (subject as any).handleSessionAlive(connection, "session-1");

    expect(connection.state).toMatchObject({
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });
    expect(subject.getSession("session-1")).toMatchObject({
      id: "session-1",
      active: 1,
      ended_at: null,
    });
    expect(connection.sent).toHaveLength(1);
    expect(JSON.parse(connection.sent[0])).toMatchObject({
      type: "session-updated",
      session: expect.objectContaining({ id: "session-1", active: 1 }),
    });

    threadNamespace.close();
    storage.close();
  });

  it("routes terminal fast-lane input only to the active owner without persistence", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const sender = createConnection("viewer", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    const olderOwner = createConnection("owner-old", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: false,
    });
    const latestOwner = createConnection("owner-new", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
    });
    connections.set(sender.id, sender);
    connections.set(olderOwner.id, olderOwner);
    connections.set(latestOwner.id, latestOwner);

    (subject as any).handleTerminalInput(sender, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      data: "a",
    });

    expect(sender.sent).toHaveLength(0);
    expect(olderOwner.sent).toHaveLength(0);
    expect(latestOwner.sent).toHaveLength(1);
    expect(JSON.parse(latestOwner.sent[0])).toEqual({
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      data: "a",
    });
    await expect(
      subject.getMessages("session-1", { limit: 10 }),
    ).resolves.toEqual([]);

    threadNamespace.close();
    storage.close();
  });

  it("does not let a standby heartbeat steal ownership and promotes it when the active owner closes", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    const active = createConnection("owner-active", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
      terminalControllerConnectionId: "viewer-old",
      terminalControllerClientId: "client-old",
    });
    const standby = createConnection("owner-standby", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: false,
      terminalOperationProtocol: 1,
    });
    const sender = createConnection("viewer");
    connections.set(active.id, active);
    connections.set(standby.id, standby);
    connections.set(sender.id, sender);

    (subject as any).handleSessionAlive(standby, "session-1");
    expect(active.state.terminalOwnerActive).toBe(true);
    expect(active.state.terminalControllerConnectionId).toBe("viewer-old");
    expect(standby.state.terminalOwnerActive).toBe(false);

    (subject as any).cleanupConnection(active);
    expect(active.state.terminalOwnerActive).toBe(false);
    expect(standby.state.terminalOwnerActive).toBe(true);
    active.sent.length = 0;
    standby.sent.length = 0;
    sender.sent.length = 0;

    (subject as any).handleTerminalInput(sender, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-new",
      inputSeq: 1,
      data: "x",
    });
    expect(active.sent).toHaveLength(0);
    expect(standby.sent.map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ type: "terminal-input", data: "x" }),
    ]);

    threadNamespace.close();
    storage.close();
  });

  it("fails input and abort but accepts best-effort resize when no owner becomes available", async () => {
    vi.useFakeTimers();
    const { subject, storage, threadNamespace, connections } = createSubject();

    try {
      subject.createSession("session-1", "demo-env", null, {});
      const sender = createConnection("viewer", {
        sessionId: "session-1",
        sessionLifecycle: "viewer",
      });
      connections.set(sender.id, sender);

      (subject as any).handleTerminalInput(sender, {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      });
      (subject as any).handleTerminalControl(sender, {
        type: "terminal-control",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        action: "abort",
      });
      (subject as any).handleTerminalControl(sender, {
        type: "terminal-control",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 2,
        action: "resize",
        cols: 120,
        rows: 40,
        claim: true,
      });

      expect(sender.sent).toHaveLength(0);
      await vi.runOnlyPendingTimersAsync();

      expect(sender.sent.map((payload) => JSON.parse(payload))).toEqual([
        {
          type: "terminal-input-ack",
          sessionId: "session-1",
          clientId: "client-1",
          inputSeq: 1,
          ok: false,
          error: "No active terminal owner for session",
        },
        {
          type: "terminal-control-ack",
          sessionId: "session-1",
          clientId: "client-1",
          controlSeq: 1,
          ok: false,
          error: "No active terminal owner for session",
        },
        {
          type: "terminal-control-ack",
          sessionId: "session-1",
          clientId: "client-1",
          controlSeq: 2,
          ok: true,
        },
      ]);
    } finally {
      vi.useRealTimers();
      threadNamespace.close();
      storage.close();
    }
  });

  it("holds terminal input briefly and flushes it when the owner registers", async () => {
    vi.useFakeTimers();
    const { subject, storage, threadNamespace, connections } = createSubject();

    try {
      subject.createSession("session-1", "demo-env", null, {});
      const sender = createConnection("viewer", {
        sessionId: "session-1",
        sessionLifecycle: "viewer",
      });
      const owner = createConnection("owner");
      connections.set(sender.id, sender);
      connections.set(owner.id, owner);

      (subject as any).handleTerminalInput(sender, {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      });

      expect(owner.sent).toHaveLength(0);
      expect(sender.sent).toHaveLength(0);

      (subject as any).handleSessionAlive(owner, "session-1");
      await vi.runOnlyPendingTimersAsync();

      expect(
        owner.sent
          .map((payload) => JSON.parse(payload))
          .filter((msg) => msg.type === "terminal-input"),
      ).toEqual([
        {
          type: "terminal-input",
          sessionId: "session-1",
          clientId: "client-1",
          inputSeq: 1,
          data: "a",
        },
      ]);
      expect(
        sender.sent
          .map((payload) => JSON.parse(payload))
          .filter((msg) => msg.type === "terminal-input-ack"),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
      threadNamespace.close();
      storage.close();
    }
  });

  it("holds Scribe input long enough for the terminal owner to reconnect", async () => {
    vi.useFakeTimers();
    const { subject, storage, threadNamespace, connections } = createSubject();

    try {
      const terminalId = planWriterTerminalId("repo-1", "plan-1", 1);
      subject.createSession(terminalId, "Scribe", null, {
        terminalScope: {
          kind: "plan-writer",
          repoId: "repo-1",
          planArtifactId: "plan-1",
          generation: 1,
        },
      });
      const sender = createConnection("viewer", {
        sessionId: terminalId,
        sessionLifecycle: "viewer",
      });
      const owner = createConnection("owner");
      connections.set(sender.id, sender);
      connections.set(owner.id, owner);

      (subject as any).handleTerminalInput(sender, {
        type: "terminal-input",
        sessionId: terminalId,
        clientId: "client-1",
        inputSeq: 1,
        data: "reviewer feedback",
      });

      await vi.advanceTimersByTimeAsync(2_600);
      expect(
        sender.sent
          .map((payload) => JSON.parse(payload))
          .filter((msg) => msg.type === "terminal-input-ack"),
      ).toEqual([]);

      (subject as any).handleSessionAlive(owner, terminalId);

      expect(
        owner.sent
          .map((payload) => JSON.parse(payload))
          .filter((msg) => msg.type === "terminal-input"),
      ).toEqual([
        {
          type: "terminal-input",
          sessionId: terminalId,
          clientId: "client-1",
          inputSeq: 1,
          data: "reviewer feedback",
        },
      ]);
      expect(
        sender.sent
          .map((payload) => JSON.parse(payload))
          .filter((msg) => msg.type === "terminal-input-ack"),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
      threadNamespace.close();
      storage.close();
    }
  });

  it("fails Scribe input when no terminal owner returns within five seconds", async () => {
    vi.useFakeTimers();
    const { subject, storage, threadNamespace, connections } = createSubject();

    try {
      const terminalId = planWriterTerminalId("repo-1", "plan-1", 1);
      subject.createSession(terminalId, "Scribe", null, {
        terminalScope: {
          kind: "plan-writer",
          repoId: "repo-1",
          planArtifactId: "plan-1",
          generation: 1,
        },
      });
      const sender = createConnection("viewer", {
        sessionId: terminalId,
        sessionLifecycle: "viewer",
      });
      connections.set(sender.id, sender);

      (subject as any).handleTerminalInput(sender, {
        type: "terminal-input",
        sessionId: terminalId,
        clientId: "client-1",
        inputSeq: 1,
        data: "reviewer feedback",
      });

      await vi.advanceTimersByTimeAsync(4_999);
      expect(sender.sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(sender.sent.map((payload) => JSON.parse(payload))).toEqual([
        {
          type: "terminal-input-ack",
          sessionId: terminalId,
          clientId: "client-1",
          inputSeq: 1,
          ok: false,
          error: "No active terminal owner for session",
        },
      ]);
    } finally {
      vi.useRealTimers();
      threadNamespace.close();
      storage.close();
    }
  });

  it("routes terminal ACKs to the originating client and binds its live output", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const owner = createConnection("owner", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
    });
    // The browser's global socket: no session-scoped state at all.
    const client = createConnection("browser");
    const bystander = createConnection("bystander", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    connections.set(owner.id, owner);
    connections.set(client.id, client);
    connections.set(bystander.id, bystander);

    // Full dispatch path: input stamps the sender's route key and reaches the owner.
    await subject.onMessage(
      client as any,
      JSON.stringify({
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      }),
    );

    expect(client.state.terminalAckRouteKey).toBe("session-1:client-1");
    expect(client.state.sessionId).toBe("session-1");
    expect(client.state.sessionLifecycle).toBe("viewer");
    expect(owner.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      },
    ]);

    // The owner's ACK goes back to the originating client only.
    await subject.onMessage(
      owner as any,
      JSON.stringify({
        type: "terminal-input-ack",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        ok: true,
      }),
    );

    expect(client.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-input-ack",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        ok: true,
      },
    ]);
    expect(bystander.sent).toHaveLength(0);
    await expect(
      subject.getMessages("session-1", { limit: 10 }),
    ).resolves.toEqual([]);

    await subject.addMessage(
      "output-1",
      "session-1",
      { type: "terminal-output", data: "live" },
      null,
      owner.id,
    );
    expect(client.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "message-received",
      id: "output-1",
      sessionId: "session-1",
      seq: 1,
      content: { type: "terminal-output", data: "live" },
    });
    expect(bystander.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "message-received",
      id: "output-1",
      sessionId: "session-1",
      seq: 1,
      content: { type: "terminal-output", data: "live" },
    });

    threadNamespace.close();
    storage.close();
  });

  it("accepts an in-flight ACK from the owner that handled an operation before handoff", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const originalOwner = createConnection("owner-original", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
    });
    const replacementOwner = createConnection("owner-replacement", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: false,
      terminalOperationProtocol: 1,
    });
    const client = createConnection("browser");
    connections.set(originalOwner.id, originalOwner);
    connections.set(replacementOwner.id, replacementOwner);
    connections.set(client.id, client);

    await subject.onMessage(
      client as any,
      JSON.stringify({
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      }),
    );
    expect(originalOwner.sent).toHaveLength(1);

    // Ownership changes after the original owner applied the operation but
    // before its ACK reaches the Hub.
    (subject as any).activateSessionOwner(replacementOwner, "session-1");

    const ack = {
      type: "terminal-input-ack",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      ok: true,
    } as const;

    // The replacement cannot claim the original owner's in-flight operation.
    (subject as any).handleTerminalInputAck(replacementOwner, ack);
    expect(client.sent).toHaveLength(0);

    // The delivery route admits the original owner's ACK once, despite its
    // demotion, and then removes the allowance.
    (subject as any).handleTerminalInputAck(originalOwner, ack);
    (subject as any).handleTerminalInputAck(originalOwner, ack);
    expect(client.sent.map((payload) => JSON.parse(payload))).toEqual([ack]);

    threadNamespace.close();
    storage.close();
  });

  it("drops terminal ACKs sent by connections that do not own the session", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const impostor = createConnection("impostor", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    const client = createConnection("browser", {
      terminalAckRouteKey: "session-1:client-1",
    });
    connections.set(impostor.id, impostor);
    connections.set(client.id, client);

    (subject as any).handleTerminalInputAck(impostor, {
      type: "terminal-input-ack",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      ok: true,
    });

    expect(client.sent).toHaveLength(0);

    threadNamespace.close();
    storage.close();
  });

  it("routes terminal input to an owner restored via reconnect", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const harness = createConnection("harness");
    const client = createConnection("client");
    connections.set(harness.id, harness);
    connections.set(client.id, client);

    // A harness reconnect must activate the owner immediately, not only after
    // the next session-alive heartbeat.
    await (subject as any).handleReconnect(harness, {
      type: "reconnect",
      lastSeq: 0,
      sessionId: "session-1",
    });

    expect(harness.state.sessionLifecycle).toBe("owner");
    expect(harness.state.terminalOwnerActive).toBe(true);

    // Drop the session-updated broadcast the reconnect revival emits.
    harness.sent.length = 0;
    client.sent.length = 0;
    await subject.onMessage(
      client as any,
      JSON.stringify({
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      }),
    );

    expect(harness.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "a",
      },
    ]);
    expect(client.sent).toHaveLength(0);

    threadNamespace.close();
    storage.close();
  });

  it("lets a standby heartbeat claim only when no active owner exists", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("session-1", "demo-env", null, {});
    const legacyOwner = createConnection("owner-legacy", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });
    const sender = createConnection("client");
    connections.set(legacyOwner.id, legacyOwner);
    connections.set(sender.id, sender);
    (subject as any).handleSessionAlive(legacyOwner, "session-1");
    legacyOwner.sent.length = 0;
    sender.sent.length = 0;

    (subject as any).handleTerminalInput(sender, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      data: "a",
    });

    expect(legacyOwner.sent).toHaveLength(1);
    expect(sender.sent).toHaveLength(0);

    threadNamespace.close();
    storage.close();
  });

  it("keeps legacy owner routing without activating controller semantics", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("legacy-harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
    });
    const first = createConnection("viewer-1");
    const second = createConnection("viewer-2");
    connections.set(owner.id, owner);
    connections.set(first.id, first);
    connections.set(second.id, second);

    (subject as any).handleTerminalInput(first, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-1",
      inputSeq: 1,
      data: "x",
      cols: 100,
      rows: 40,
    });
    (subject as any).handleTerminalControl(second, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-2",
      controlSeq: 1,
      action: "resize",
      cols: 120,
      rows: 50,
    });

    expect(owner.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "x",
        cols: 100,
        rows: 40,
      },
      {
        type: "terminal-control",
        sessionId: "session-1",
        clientId: "client-2",
        controlSeq: 1,
        action: "resize",
        cols: 120,
        rows: 50,
      },
    ]);
    expect(owner.state.terminalControllerConnectionId).toBeUndefined();

    threadNamespace.close();
    storage.close();
  });

  it("does not claim a controller when delivery to the capable owner fails", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
    });
    const sender = createConnection("viewer");
    owner.send = () => {
      throw new Error("socket closed");
    };
    connections.set(owner.id, owner);
    connections.set(sender.id, sender);

    (subject as any).handleTerminalControl(sender, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "resize",
      cols: 80,
      rows: 24,
    });

    expect(owner.state.terminalControllerConnectionId).toBeUndefined();
    expect(sender.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-control-ack",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        ok: false,
        error: "No active terminal owner for session",
      },
    ]);

    threadNamespace.close();
    storage.close();
  });

  it("claims, no-ops passive resizes, and transfers a capable terminal controller on input", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
    });
    const first = createConnection("viewer-1");
    const second = createConnection("viewer-2");
    connections.set(owner.id, owner);
    connections.set(first.id, first);
    connections.set(second.id, second);

    (subject as any).handleTerminalControl(first, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "resize",
      cols: 80,
      rows: 24,
    });
    expect(owner.state).toMatchObject({
      terminalControllerConnectionId: "viewer-1",
      terminalControllerClientId: "client-1",
    });
    expect(owner.sent.map((payload) => JSON.parse(payload))).toEqual([
      expect.objectContaining({ type: "terminal-control", cols: 80, rows: 24 }),
    ]);

    (subject as any).handleTerminalControl(second, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-2",
      controlSeq: 1,
      action: "resize",
      cols: 120,
      rows: 50,
    });
    expect(owner.sent).toHaveLength(1);
    expect(second.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-control-ack",
        sessionId: "session-1",
        clientId: "client-2",
        controlSeq: 1,
        ok: true,
      },
    ]);

    (subject as any).handleTerminalInput(second, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-2",
      inputSeq: 1,
      data: "",
      cols: 120,
      rows: 50,
    });
    expect(owner.state).toMatchObject({
      terminalControllerConnectionId: "viewer-1",
      terminalControllerClientId: "client-1",
    });
    expect(JSON.parse(owner.sent[owner.sent.length - 1])).toMatchObject({
      type: "terminal-input",
      data: "",
      applyDimensions: false,
    });

    (subject as any).handleTerminalInput(second, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-2",
      inputSeq: 2,
      data: "x",
      deliveryId: "feedback-1",
      cols: 120,
      rows: 50,
    });
    expect(owner.state).toMatchObject({
      terminalControllerConnectionId: "viewer-2",
      terminalControllerClientId: "client-2",
    });
    const latestForwardedInput = JSON.parse(owner.sent[owner.sent.length - 1]);
    expect(latestForwardedInput).toEqual({
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "client-2",
      inputSeq: 2,
      data: "x",
      deliveryId: "feedback-1",
      cols: 120,
      rows: 50,
      applyDimensions: true,
    });

    threadNamespace.close();
    storage.close();
  });

  it("lets an active client reclaim a stale controller without a keystroke", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
      terminalControllerConnectionId: "stale-viewer",
      terminalControllerClientId: "stale-client",
    });
    const active = createConnection("active-viewer");
    connections.set(owner.id, owner);
    connections.set(active.id, active);

    (subject as any).handleTerminalControl(active, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "active-client",
      controlSeq: 1,
      action: "resize",
      cols: 120,
      rows: 50,
      claim: true,
    });

    expect(owner.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-control",
        sessionId: "session-1",
        clientId: "active-client",
        controlSeq: 1,
        action: "resize",
        cols: 120,
        rows: 50,
        claim: true,
      },
    ]);
    expect(owner.state).toMatchObject({
      terminalControllerConnectionId: "active-viewer",
      terminalControllerClientId: "active-client",
    });
    expect(active.sent).toHaveLength(0);

    (subject as any).handleTerminalControl(active, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "active-client",
      controlSeq: 2,
      action: "resize",
      cols: 100,
      rows: 40,
      claim: false,
    });
    expect(JSON.parse(owner.sent[1])).toMatchObject({
      type: "terminal-control",
      controlSeq: 2,
      cols: 100,
      rows: 40,
      claim: false,
    });

    (subject as any).handleTerminalInput(active, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "active-client",
      inputSeq: 1,
      data: "x",
      cols: 120,
      rows: 50,
    });
    expect(JSON.parse(owner.sent[2])).toMatchObject({
      type: "terminal-input",
      data: "x",
      applyDimensions: true,
    });

    threadNamespace.close();
    storage.close();
  });

  it("keeps explicit passive resizes from claiming an unowned terminal", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
    });
    const viewer = createConnection("viewer");
    connections.set(owner.id, owner);
    connections.set(viewer.id, viewer);

    (subject as any).handleTerminalControl(viewer, {
      type: "terminal-control",
      sessionId: "session-1",
      clientId: "client-1",
      controlSeq: 1,
      action: "resize",
      cols: 100,
      rows: 40,
      claim: false,
    });

    expect(owner.sent).toHaveLength(0);
    expect(owner.state.terminalControllerConnectionId).toBeUndefined();
    expect(viewer.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-control-ack",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        ok: true,
      },
    ]);

    threadNamespace.close();
    storage.close();
  });

  it("transfers capable ownership for old input without changing dimensions", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
    });
    const sender = createConnection("viewer");
    connections.set(owner.id, owner);
    connections.set(sender.id, sender);

    (subject as any).handleTerminalInput(sender, {
      type: "terminal-input",
      sessionId: "session-1",
      clientId: "old-client",
      inputSeq: 1,
      data: "old",
    });

    expect(owner.sent.map((payload) => JSON.parse(payload))).toEqual([
      {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "old-client",
        inputSeq: 1,
        data: "old",
        applyDimensions: false,
      },
    ]);
    expect(owner.state.terminalControllerConnectionId).toBe("viewer");

    threadNamespace.close();
    storage.close();
  });

  it("never applies dimensions supplied by input that waited for an owner", async () => {
    vi.useFakeTimers();
    const { subject, storage, threadNamespace, connections } = createSubject();
    try {
      const sender = createConnection("viewer");
      const owner = createConnection("harness");
      connections.set(sender.id, sender);
      connections.set(owner.id, owner);

      (subject as any).handleTerminalInput(sender, {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-1",
        inputSeq: 1,
        data: "queued",
        cols: 200,
        rows: 60,
      });
      await (subject as any).handleReconnect(owner, {
        type: "reconnect",
        sessionId: "session-1",
        lastSeq: 0,
        revive: true,
        terminalOperationProtocol: 1,
      });

      expect(
        owner.sent
          .map((payload) => JSON.parse(payload))
          .filter((message) => message.type === "terminal-input"),
      ).toEqual([
        {
          type: "terminal-input",
          sessionId: "session-1",
          clientId: "client-1",
          inputSeq: 1,
          data: "queued",
          cols: 200,
          rows: 60,
          applyDimensions: false,
        },
      ]);
      expect(owner.state.terminalControllerConnectionId).toBe("viewer");
    } finally {
      vi.useRealTimers();
      threadNamespace.close();
      storage.close();
    }
  });

  it("drops queued terminal work when that client detaches", () => {
    vi.useFakeTimers();
    const { subject, storage, threadNamespace, connections } = createSubject();
    try {
      const sender = createConnection("viewer");
      connections.set(sender.id, sender);

      (subject as any).handleTerminalControl(sender, {
        type: "terminal-control",
        sessionId: "session-1",
        clientId: "client-1",
        controlSeq: 1,
        action: "resize",
        cols: 120,
        rows: 50,
        claim: true,
      });
      (subject as any).handleTerminalInput(sender, {
        type: "terminal-input",
        sessionId: "session-1",
        clientId: "client-2",
        inputSeq: 1,
        data: "keep",
      });
      expect((subject as any).pendingTerminalDeliveries.size).toBe(2);

      (subject as any).handleTerminalDetach(sender, "session-1", "client-1");

      expect(
        [...(subject as any).pendingTerminalDeliveries.values()].map(
          (pending: any) => pending.message.clientId,
        ),
      ).toEqual(["client-2"]);
    } finally {
      vi.useRealTimers();
      threadNamespace.close();
      storage.close();
    }
  });

  it("releases capable controller leases on detach and viewer disconnect", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const owner = createConnection("harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
      terminalControllerConnectionId: "viewer",
      terminalControllerClientId: "client-1",
    });
    const sender = createConnection("viewer");
    connections.set(owner.id, owner);
    connections.set(sender.id, sender);

    (subject as any).handleTerminalDetach(sender, "session-1", "client-1");
    expect(owner.state.terminalControllerConnectionId).toBeUndefined();

    owner.setState({
      ...owner.state,
      terminalControllerConnectionId: "viewer",
      terminalControllerClientId: "client-1",
    });
    (subject as any).cleanupConnection(sender);
    expect(owner.state.terminalControllerConnectionId).toBeUndefined();

    threadNamespace.close();
    storage.close();
  });

  it("releases the prior capable owner's controller when its replacement registers", async () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    subject.createSession("session-1", "demo-env", null, {});
    const priorOwner = createConnection("old-harness", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
      terminalOperationProtocol: 1,
      terminalControllerConnectionId: "viewer",
      terminalControllerClientId: "client-1",
    });
    const replacement = createConnection("new-harness");
    connections.set(priorOwner.id, priorOwner);
    connections.set(replacement.id, replacement);

    await (subject as any).handleReconnect(replacement, {
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: true,
      replay: false,
      terminalOperationProtocol: 1,
    });

    expect(priorOwner.state.terminalControllerConnectionId).toBeUndefined();
    expect(priorOwner.state.terminalControllerClientId).toBeUndefined();
    expect(priorOwner.state.terminalOwnerActive).toBe(false);
    expect(replacement.state).toMatchObject({
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOperationProtocol: 1,
      terminalOwnerActive: true,
    });
    expect(replacement.state.terminalControllerConnectionId).toBeUndefined();

    threadNamespace.close();
    storage.close();
  });

  it("reports only sessions with live owner sockets as routable", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    subject.createSession("owned-session", "demo-env", null, {});
    subject.createSession("viewer-session", "demo-env", null, {});
    subject.createSession("closed-owner-session", "demo-env", null, {});
    const owner = createConnection("owner", {
      sessionId: "owned-session",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
    });
    const viewer = createConnection("viewer", {
      sessionId: "viewer-session",
      sessionLifecycle: "viewer",
    });
    const closedOwner = createConnection("closed-owner", {
      sessionId: "closed-owner-session",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
    });
    closedOwner.readyState = WebSocket.CLOSED;
    connections.set(owner.id, owner);
    connections.set(viewer.id, viewer);
    connections.set(closedOwner.id, closedOwner);

    expect(subject.getRoutableSessionIds()).toEqual(["owned-session"]);

    threadNamespace.close();
    storage.close();
  });

  it("broadcasts session-updated when session active state changes", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();

    const observer = createConnection("conn-1");
    connections.set(observer.id, observer);

    subject.createSession("session-1", "demo-env", null, {
      envSlug: "demo-env",
      role: "lead",
    });
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

  it.each([
    ["environment", "session-1"],
    ["planWriter", "writer-session"],
  ] as const)(
    "gates every %s message by immutable session authority",
    (principal, sessionId) => {
      const { subject, storage, threadNamespace } = createSubject();
      const authorization =
        principal === "environment"
          ? {
              kind: "environment" as const,
              envSlug: "env-1",
              sessionId,
            }
          : {
              kind: "planWriter" as const,
              repoId: "repo-1",
              planArtifactId: "plan-1",
              generation: 1,
              sessionId,
            };
      const scoped = createConnection(principal, {
        authorization,
        sessionId,
        sessionLifecycle: "owner",
      });
      const global = createConnection("global");

      for (const testCase of WS_CLIENT_AUTHORIZATION_CASES) {
        expect(
          (subject as any).authorizeWsMessage(
            scoped,
            testCase.message(sessionId),
          ),
          `${principal} ${testCase.type}`,
        ).toBe(testCase.scoped);
        expect(
          (subject as any).authorizeWsMessage(
            global,
            testCase.message(sessionId),
          ),
          `global ${testCase.type}`,
        ).toBe(true);

        const message = testCase.message("other-session");
        if ("sessionId" in message) {
          expect(
            (subject as any).authorizeWsMessage(scoped, message),
            `${principal} cross-session ${testCase.type}`,
          ).toBe(false);
        }
      }

      expect(WS_CLIENT_AUTHORIZATION_CASES.map(({ type }) => type)).toEqual([
        "ping",
        "reconnect",
        "terminal-input",
        "terminal-control",
        "terminal-input-ack",
        "terminal-control-ack",
        "message",
        "session-alive",
        "terminal-detach",
        "session-end",
        "update-metadata",
        "update-agent-state",
        "update-todos",
        "machine-alive",
        "machine-update-metadata",
        "machine-update-runner-state",
        "runner-control-response",
      ] satisfies WsClientMessage["type"][]);

      threadNamespace.close();
      storage.close();
    },
  );

  it("separates global broadcasts from explicitly bound terminal delivery", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const global = createConnection("global");
    const globalViewer = createConnection("global-viewer", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    const environment = createConnection("environment", {
      authorization: {
        kind: "environment",
        envSlug: "env-1",
        sessionId: "session-1",
      },
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });
    const unrelated = createConnection("unrelated", {
      authorization: {
        kind: "environment",
        envSlug: "env-2",
        sessionId: "session-2",
      },
      sessionId: "session-2",
      sessionLifecycle: "owner",
    });
    for (const connection of [global, globalViewer, environment, unrelated]) {
      connections.set(connection.id, connection);
    }

    for (const message of GLOBAL_BROADCAST_MESSAGES) {
      (subject as any).broadcastGlobal(message);
    }
    expect(global.sent).toHaveLength(GLOBAL_BROADCAST_MESSAGES.length);
    expect(globalViewer.sent).toHaveLength(GLOBAL_BROADCAST_MESSAGES.length);
    expect(environment.sent).toHaveLength(0);
    expect(unrelated.sent).toHaveLength(0);

    (subject as any).sendToSession("session-1", {
      type: "message-received",
      id: "message-1",
      sessionId: "session-1",
      seq: 1,
      content: { type: "terminal-output", data: "scoped" },
      localId: null,
      createdAt: "2026-08-16T00:00:00.000Z",
    });
    expect(global.sent).toHaveLength(GLOBAL_BROADCAST_MESSAGES.length);
    expect(globalViewer.sent).toHaveLength(GLOBAL_BROADCAST_MESSAGES.length + 1);
    expect(environment.sent).toHaveLength(1);
    expect(unrelated.sent).toHaveLength(0);

    threadNamespace.close();
    storage.close();
  });

  it("closes only scoped sockets bound to a deleted or revoked session", () => {
    const { subject, storage, threadNamespace, connections } = createSubject();
    const globalViewer = createConnection("global-viewer", {
      sessionId: "session-1",
      sessionLifecycle: "viewer",
    });
    const environment = createConnection("environment", {
      authorization: {
        kind: "environment",
        envSlug: "env-1",
        sessionId: "session-1",
      },
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });
    const planWriter = createConnection("plan-writer", {
      authorization: {
        kind: "planWriter",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        generation: 1,
        sessionId: "session-1",
      },
      sessionId: "session-1",
      sessionLifecycle: "owner",
    });
    for (const connection of [globalViewer, environment, planWriter]) {
      connections.set(connection.id, connection);
    }

    (subject as any).closeScopedSessionConnections(
      "session-1",
      "Session revoked",
    );
    expect(globalViewer.closed).toBeNull();
    expect(environment.closed).toEqual({
      code: 4003,
      reason: "Session revoked",
    });
    expect(planWriter.closed).toEqual({
      code: 4003,
      reason: "Session revoked",
    });

    threadNamespace.close();
    storage.close();
  });
});
