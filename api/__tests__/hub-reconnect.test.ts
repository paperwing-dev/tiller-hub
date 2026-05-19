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
  },
}));

import { HubDO } from "../hub";
import * as Q from "../queries";
import type { HostServiceRegistration, WsConnectionState } from "../types";

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
    readyState: WebSocket.OPEN,
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

function buildHostRegistration(machineId: string): HostServiceRegistration {
  return {
    machineId,
    connectedAt: "2026-04-11T18:00:00.000Z",
    dockerAvailable: true,
    codexSubscription: true,
    claudeSubscription: true,
    gatewayPort: 8788,
    transport: "session",
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

function seedRegisteredHost(subject: HubDO, machineId = "raspberrypi"): void {
  subject.getOrCreateMachine(machineId, {});
  Q.updateMachineRunnerState(
    (subject as any).db,
    machineId,
    { host: buildHostRegistration(machineId) },
    1,
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HubDO reconnect healing", () => {
  it("restores db-backed host service keys on machine-alive", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    (subject as any).handleMachineAlive(connection, "raspberrypi");

    expect(connection.state).toMatchObject({
      machineId: "raspberrypi",
      role: "cli",
      machineServiceKeys: ["host"],
    });

    storage.close();
  });

  it("reports the host offline when only durable registration exists", () => {
    const { subject, storage } = createSubject();
    seedRegisteredHost(subject);

    expect(subject.isHostRoutable()).toBe(false);

    storage.close();
  });

  it("routes runner requests again after machine-alive rebinds the live connection", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    (subject as any).handleMachineAlive(connection, "raspberrypi");
    connection.sent.length = 0;

    const requestPromise = subject.requestLocalRunner(null, "status", "demo-env");
    expect(subject.isHostRoutable()).toBe(true);
    expect(connection.sent).toHaveLength(1);

    const request = JSON.parse(connection.sent[0]) as { requestId: string; type: string; action: string; slug: string };
    expect(request).toMatchObject({
      type: "runner-control-request",
      action: "status",
      slug: "demo-env",
    });

    (subject as any).handleRunnerControlResponse({
      type: "runner-control-response",
      requestId: request.requestId,
      ok: true,
      result: { status: "running" },
    });

    await expect(requestPromise).resolves.toEqual({
      machineId: "raspberrypi",
      result: { status: "running" },
    });

    storage.close();
  });

  it("does not treat a different active host as routable for a stored machine id", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, "host-1");
    seedRegisteredHost(subject, "host-2");

    const connection = createConnection("conn-2");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, "host-2");

    expect(subject.isHostRoutable("host-1")).toBe(false);
    expect(subject.isHostRoutable("host-2")).toBe(true);

    storage.close();
  });

  it("rejects runner control for an offline stored machine even when another host is active", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, "host-1");
    seedRegisteredHost(subject, "host-2");

    const connection = createConnection("conn-2");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, "host-2");
    connection.sent.length = 0;

    await expect(
      subject.requestLocalRunner("host-1", "status", "demo-env"),
    ).rejects.toThrow("Tiller Host is offline");
    expect(connection.sent).toHaveLength(0);

    storage.close();
  });
});
