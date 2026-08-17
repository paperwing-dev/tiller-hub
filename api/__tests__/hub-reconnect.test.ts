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

vi.mock("../setup/runtime-compatibility", () => ({
  classifyHostRuntimeCompatibility: vi.fn((host: HostServiceRegistration | null) => ({
    compatible: host?.localRunnerImage === "compatible-image",
  })),
}));

import { HubDO } from "../hub";
import * as Q from "../queries";
import { EXECUTION_SELECTION_KEY } from "../execution";
import type { HostServiceRegistration, WsConnectionState } from "../types";

const DEFAULT_MACHINE_ID = "11111111-1111-4111-8111-111111111111";
const MACHINE_ONE = "22222222-2222-4222-8222-222222222222";
const MACHINE_TWO = "33333333-3333-4333-8333-333333333333";

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
    readyState: WebSocket.OPEN,
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

function buildHostRegistration(
  machineId: string,
  supportsFencing = true,
  localRunnerImage = "compatible-image",
): HostServiceRegistration {
  return {
    machineId,
    displayName: machineId,
    connectedAt: "2026-04-11T18:00:00.000Z",
    ...(supportsFencing ? { runnerCommandProtocol: 1 as const } : {}),
    codexRuntimeAuthProtocol: 1,
    localRunnerImage,
    dockerAvailable: true,
    runnerAvailable: true,
    claudeSubscription: true,
    transport: "session",
  };
}

function createSubject() {
  const storage = new FakeStorage();
  const env = {
    ENV_REVIEW: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({})),
    },
  };
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(ctx as any, env as any);
  const connections = new Map<string, FakeConnection>();

  (subject as any).getConnections = () => connections.values();

  return { subject, storage, connections };
}

function seedRegisteredHost(subject: HubDO, machineId = DEFAULT_MACHINE_ID, supportsFencing = true): void {
  subject.getOrCreateMachine(machineId, {});
  Q.updateMachineRunnerState(
    (subject as any).db,
    machineId,
    { host: buildHostRegistration(machineId, supportsFencing) },
    1,
  );
}

function selectHost(subject: HubDO, machineId: string): void {
  subject.setConfig(
    EXECUTION_SELECTION_KEY,
    JSON.stringify({ target: "host", machineId }),
  );
}

function advertiseHost(
  subject: HubDO,
  connection: FakeConnection,
  machineId = DEFAULT_MACHINE_ID,
  host = buildHostRegistration(machineId),
): void {
  (subject as any).handleMachineAlive(connection, machineId);
  const current = Q.getMachine((subject as any).db, machineId);
  (subject as any).handleMachineUpdateRunnerState(connection, {
    type: "machine-update-runner-state",
    machineId,
    runnerState: { host },
    expectedVersion: current!.runner_state_version,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("HubDO reconnect healing", () => {
  it("binds identity only on machine-alive", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);

    expect(connection.state).toMatchObject({
      machineId: DEFAULT_MACHINE_ID,
      role: "cli",
      machineServiceKeys: [],
    });
    expect(subject.isHostRoutable(DEFAULT_MACHINE_ID)).toBe(false);

    storage.close();
  });

  it("broadcasts machine changes for binding, reconnection, and reactivation but not routine heartbeats", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const observer = createConnection("observer");
    const initial = createConnection("initial");
    connections.set(observer.id, observer);
    connections.set(initial.id, initial);

    const machineUpdates = () => observer.sent
      .map((payload) => JSON.parse(payload))
      .filter((message) => message.type === "machine-updated");

    (subject as any).handleMachineAlive(initial, DEFAULT_MACHINE_ID);
    expect(machineUpdates()).toHaveLength(1);

    (subject as any).handleMachineAlive(initial, DEFAULT_MACHINE_ID);
    (subject as any).handleMachineAlive(initial, DEFAULT_MACHINE_ID);
    expect(machineUpdates()).toHaveLength(1);

    const reconnected = createConnection("reconnected");
    connections.set(reconnected.id, reconnected);
    (subject as any).handleMachineAlive(reconnected, DEFAULT_MACHINE_ID);
    expect(machineUpdates()).toHaveLength(2);

    Q.setMachineActive((subject as any).db, DEFAULT_MACHINE_ID, false);
    (subject as any).handleMachineAlive(reconnected, DEFAULT_MACHINE_ID);
    expect(machineUpdates()).toHaveLength(3);
    expect(machineUpdates().at(-1)).toMatchObject({
      type: "machine-updated",
      machine: { id: DEFAULT_MACHINE_ID, active: 1 },
    });

    storage.close();
  });

  it("rejects host advertisements before machine-alive binds the socket identity", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    const current = Q.getMachine((subject as any).db, DEFAULT_MACHINE_ID)!;

    (subject as any).handleMachineUpdateRunnerState(connection, {
      type: "machine-update-runner-state",
      machineId: DEFAULT_MACHINE_ID,
      runnerState: { host: buildHostRegistration(DEFAULT_MACHINE_ID) },
      expectedVersion: current.runner_state_version,
    });

    expect(connection.state.machineId).toBeUndefined();
    expect(subject.isHostRoutable(DEFAULT_MACHINE_ID)).toBe(false);
    expect(Q.getMachine((subject as any).db, DEFAULT_MACHINE_ID)?.runner_state_version)
      .toBe(current.runner_state_version);
    expect(connection.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: "Host advertisement requires machine-alive identity binding.",
    });
    storage.close();
  });

  it("rejects host advertisements with a legacy non-UUID machine identity", () => {
    const { subject, storage, connections } = createSubject();
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, "legacy-hostname-id");
    const current = Q.getMachine((subject as any).db, "legacy-hostname-id")!;

    (subject as any).handleMachineUpdateRunnerState(connection, {
      type: "machine-update-runner-state",
      machineId: "legacy-hostname-id",
      runnerState: { host: buildHostRegistration("legacy-hostname-id") },
      expectedVersion: current.runner_state_version,
    });

    expect(subject.isHostRoutable("legacy-hostname-id")).toBe(false);
    expect(connection.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: "Host machine identity must be a generated UUID.",
    });
    storage.close();
  });

  it("rejects attempts to relabel an already-bound machine socket", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, MACHINE_ONE);
    seedRegisteredHost(subject, MACHINE_TWO);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection, MACHINE_ONE);

    (subject as any).handleMachineAlive(connection, MACHINE_TWO);

    expect(connection.state.machineId).toBe(MACHINE_ONE);
    expect(subject.isHostRoutable(MACHINE_ONE)).toBe(true);
    expect(subject.isHostRoutable(MACHINE_TWO)).toBe(false);
    expect(connection.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: "Machine identity cannot change on an existing connection.",
    });
    storage.close();
  });

  it("sends env-review snapshot requests only to the current owner connection", async () => {
    const { subject, storage, connections } = createSubject();
    const owner = createConnection("owner", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: true,
    });
    const imposter = createConnection("imposter", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: false,
    });
    connections.set(owner.id, owner);
    connections.set(imposter.id, imposter);

    await expect(subject.sendEnvReviewSnapshotRequest("session-1", "op-1", "env-1", "token-1", {
      uploadUrl: "https://hub.example/api/envs/env-1/review/snapshots/op-1",
      snapshotMode: "github-overlay",
      maxBytes: 1234,
      excludePrefixes: ["/.tiller"],
    })).resolves.toEqual({ sent: true });
    expect(owner.sent).toHaveLength(1);
    expect(imposter.sent).toHaveLength(0);
    const snapshotRequest = JSON.parse(owner.sent[0]) as {
      type: string;
      sessionId: string;
      opId: string;
      uploadToken: string;
      uploadUrl: string;
      snapshotMode: string;
      maxBytes: number;
      excludePrefixes: string[];
    };
    expect(snapshotRequest).toMatchObject({
      type: "env-review-snapshot-request",
      sessionId: "session-1",
      opId: "op-1",
      envSlug: "env-1",
      uploadToken: "token-1",
      uploadUrl: "https://hub.example/api/envs/env-1/review/snapshots/op-1",
      snapshotMode: "github-overlay",
      maxBytes: 1234,
      excludePrefixes: ["/.tiller"],
    });

    const reconnectedOwner = createConnection("owner-2", {
      sessionId: "session-1",
      sessionLifecycle: "owner",
      terminalOwnerActive: false,
    });
    connections.set(reconnectedOwner.id, reconnectedOwner);
    (subject as any).activateSessionOwner(reconnectedOwner, "session-1");

    await expect(subject.sendEnvReviewSnapshotRequest("session-1", "op-2", "env-1", "token-2", {
      uploadUrl: "https://hub.example/api/envs/env-1/review/snapshots/op-2",
      snapshotMode: "full",
      maxBytes: 5678,
      excludePrefixes: [],
    })).resolves.toEqual({ sent: true });
    expect(owner.sent).toHaveLength(1);
    expect(reconnectedOwner.sent).toHaveLength(1);
    expect(JSON.parse(reconnectedOwner.sent[0])).toMatchObject({
      type: "env-review-snapshot-request",
      opId: "op-2",
      uploadToken: "token-2",
      snapshotMode: "full",
    });

    storage.close();
  });

  it("reports env-review snapshot request unsent when no owner is connected", async () => {
    const { subject, storage } = createSubject();

    await expect(subject.sendEnvReviewSnapshotRequest("session-1", "op-1", "env-1", "token-1", {
      uploadUrl: "https://hub.example/api/envs/env-1/review/snapshots/op-1",
      snapshotMode: "full",
      maxBytes: 1234,
      excludePrefixes: [],
    })).resolves.toEqual({
      sent: false,
      error: "No active harness session is connected for review snapshot.",
    });

    storage.close();
  });

  it("reports the host offline when only durable registration exists", () => {
    const { subject, storage } = createSubject();
    seedRegisteredHost(subject);

    expect(subject.isHostRoutable()).toBe(false);

    storage.close();
  });

  it("retains durable registration after disconnect while dropping routability", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);

    subject.onClose(connection as any, 1006, "connection lost", false);
    connections.delete(connection.id);
    (subject as any).markMachineInactive(DEFAULT_MACHINE_ID);

    expect(subject.getHostService(DEFAULT_MACHINE_ID)).toMatchObject({
      machineId: DEFAULT_MACHINE_ID,
      transport: "session",
    });
    expect(subject.getRoutableHostService(DEFAULT_MACHINE_ID)).toBeNull();

    storage.close();
  });

  it("requires a fresh healthy advertisement and uses only its runtime protocols", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);

    expect(subject.getRoutableHostService(DEFAULT_MACHINE_ID)).toBeNull();

    advertiseHost(subject, connection);
    expect(subject.getRoutableHostService(DEFAULT_MACHINE_ID)).toMatchObject({
      runnerCommandProtocol: 1,
      codexRuntimeAuthProtocol: 1,
    });

    storage.close();
  });

  it("routes runner requests again after a fresh healthy advertisement", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);

    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    advertiseHost(subject, connection);
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

    (subject as any).handleRunnerControlResponse(createConnection("wrong-connection"), {
      type: "runner-control-response",
      requestId: request.requestId,
      ok: true,
      result: { status: "stopped" },
    });
    expect((subject as any).pendingRunnerRequests.size).toBe(1);

    (subject as any).handleRunnerControlResponse(connection, {
      type: "runner-control-response",
      requestId: request.requestId,
      ok: true,
      result: { status: "running" },
    });

    await expect(requestPromise).resolves.toEqual({
      machineId: DEFAULT_MACHINE_ID,
      result: { status: "running" },
    });

    storage.close();
  });

  it("binds fencing only after advertisement and preserves it across heartbeats", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);
    expect(connection.state.runnerCommandProtocol).toBeUndefined();

    const current = Q.getMachine((subject as any).db, DEFAULT_MACHINE_ID);
    (subject as any).handleMachineUpdateRunnerState(connection, {
      type: "machine-update-runner-state",
      machineId: DEFAULT_MACHINE_ID,
      runnerState: { host: buildHostRegistration(DEFAULT_MACHINE_ID) },
      expectedVersion: current!.runner_state_version,
    });
    expect(connection.state.runnerCommandProtocol).toBe(1);

    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);
    expect(connection.state.runnerCommandProtocol).toBe(1);
    storage.close();
  });

  it("sends the complete fenced command tuple for mutating runner requests", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection);
    connection.sent.length = 0;

    const requestPromise = subject.requestLocalRunner(null, "stop", "demo-env", {
      commandGeneration: 12,
      operationId: "stop-op-12",
      desiredState: "stopped",
    });
    const request = JSON.parse(connection.sent[0]) as { requestId: string };
    expect(request).toMatchObject({
      type: "runner-control-request",
      action: "stop",
      slug: "demo-env",
      commandGeneration: 12,
      operationId: "stop-op-12",
      desiredState: "stopped",
    });

    (subject as any).handleRunnerControlResponse(connection, {
      type: "runner-control-response",
      requestId: request.requestId,
      ok: true,
      result: { callbackExpected: true },
    });
    await expect(requestPromise).resolves.toMatchObject({
      machineId: DEFAULT_MACHINE_ID,
      result: { callbackExpected: true },
    });
    storage.close();
  });

  it("rejects an incomplete or action-incompatible mutating command before dispatch", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);
    connection.sent.length = 0;

    await expect(subject.requestLocalRunner(null, "start", "demo-env", {
      commandGeneration: 13,
      operationId: "start-op-13",
      desiredState: "stopped",
    })).rejects.toThrow(/and running desired state/i);
    expect(connection.sent).toHaveLength(0);
    storage.close();
  });

  it("blocks fenced mutations before dispatch when the connected host uses the legacy protocol", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, DEFAULT_MACHINE_ID, false);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection, DEFAULT_MACHINE_ID, buildHostRegistration(DEFAULT_MACHINE_ID, false));
    connection.sent.length = 0;

    await expect(subject.requestLocalRunner(null, "start", "demo-env", {
      commandGeneration: 15,
      operationId: "start-op-15",
      desiredState: "running",
    })).rejects.toThrow(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
    expect(connection.sent).toHaveLength(0);
    storage.close();
  });

  it("does not trust a stale durable protocol capability after host reconnect", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    (subject as any).handleMachineAlive(connection, DEFAULT_MACHINE_ID);
    connection.sent.length = 0;

    await expect(subject.requestLocalRunner(null, "stop", "demo-env", {
      commandGeneration: 16,
      operationId: "stop-op-16",
      desiredState: "stopped",
    })).rejects.toThrow(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
    expect(connection.sent).toHaveLength(0);
    storage.close();
  });

  it("revalidates live Codex protocol and exact runtime compatibility before dispatch", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection, DEFAULT_MACHINE_ID, {
      ...buildHostRegistration(DEFAULT_MACHINE_ID),
      codexRuntimeAuthProtocol: undefined,
    });

    const command = {
      commandGeneration: 17,
      operationId: "start-op-17",
      desiredState: "running" as const,
      envVars: { TILLER_HARNESS: "codex" },
    };
    await expect(subject.requestLocalRunner(null, "start", "demo-env", command))
      .rejects.toThrow(
        "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
      );

    advertiseHost(subject, connection);
    const requestPromise = subject.requestLocalRunner(null, "start", "demo-env", command);
    const request = JSON.parse(connection.sent[connection.sent.length - 1]!) as { requestId: string };
    (subject as any).handleRunnerControlResponse(connection, {
      type: "runner-control-response",
      requestId: request.requestId,
      ok: true,
      result: { status: "running" },
    });
    await expect(requestPromise).resolves.toMatchObject({ machineId: DEFAULT_MACHINE_ID });

    const current = Q.getMachine((subject as any).db, DEFAULT_MACHINE_ID);
    Q.updateMachineRunnerState(
      (subject as any).db,
      DEFAULT_MACHINE_ID,
      { host: buildHostRegistration(DEFAULT_MACHINE_ID, true, "stale-image") },
      current!.runner_state_version,
    );
    await expect(subject.requestLocalRunner(null, "start", "demo-env", {
      ...command,
      commandGeneration: 18,
      operationId: "start-op-18",
    })).rejects.toThrow(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
    storage.close();
  });

  it("keeps runner command conflicts typed across the websocket response", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection);
    connection.sent.length = 0;

    const requestPromise = subject.requestLocalRunner(null, "destroy", "demo-env", {
      commandGeneration: 14,
      operationId: "destroy-op-14",
      desiredState: "absent",
    });
    const request = JSON.parse(connection.sent[0]) as { requestId: string };
    (subject as any).handleRunnerControlResponse(connection, {
      type: "runner-control-response",
      requestId: request.requestId,
      ok: false,
      error: "Generation 14 conflicts with the accepted operation.",
      errorCode: "runner_command_conflict",
    });

    const failure = await requestPromise.catch((error) => error) as Error & { code?: string };
    expect(failure.message).toContain("runner_command_conflict");
    expect(failure.code).toBe("runner_command_conflict");
    storage.close();
  });

  it("preserves the runner high-water across the websocket response", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection);
    connection.sent.length = 0;

    const requestPromise = subject.requestLocalRunner(null, "create", "demo-env", {
      repoUrl: "https://github.com/example/repo",
      envVars: {},
      commandGeneration: 1,
      operationId: "start-op-1",
      desiredState: "running",
    });
    const request = JSON.parse(connection.sent[0]) as { requestId: string };
    (subject as any).handleRunnerControlResponse(connection, {
      type: "runner-control-response",
      requestId: request.requestId,
      ok: false,
      error: "Runner command generation 1 was superseded by 60.",
      errorCode: "runner_command_superseded_before_mutation",
      currentCommandGeneration: 60,
    });

    const failure = await requestPromise.catch((error) => error) as Error & {
      code?: string;
      currentCommandGeneration?: number;
    };
    expect(failure).toMatchObject({
      code: "runner_command_superseded_before_mutation",
      currentCommandGeneration: 60,
    });
    storage.close();
  });

  it("does not treat a different active host as routable for a stored machine id", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, MACHINE_ONE);
    seedRegisteredHost(subject, MACHINE_TWO);

    const connection = createConnection("conn-2");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection, MACHINE_TWO);

    expect(subject.isHostRoutable(MACHINE_ONE)).toBe(false);
    expect(subject.isHostRoutable(MACHINE_TWO)).toBe(true);

    storage.close();
  });

  it("rejects a different machine while one healthy machine owns the slot", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, MACHINE_ONE);
    seedRegisteredHost(subject, MACHINE_TWO);
    const first = createConnection("conn-1");
    const second = createConnection("conn-2");
    connections.set(first.id, first);
    connections.set(second.id, second);

    advertiseHost(subject, first, MACHINE_ONE);
    advertiseHost(subject, second, MACHINE_TWO);

    expect(subject.getRoutableHostService()).toMatchObject({ machineId: MACHINE_ONE });
    expect(second.state.machineServiceKeys).toEqual([]);
    expect(second.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: `Another execution machine is already connected (${MACHINE_ONE}).`,
    });
    storage.close();
  });

  it("lets the selected machine preempt a different machine that owns the slot", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, MACHINE_ONE);
    seedRegisteredHost(subject, MACHINE_TWO);
    selectHost(subject, MACHINE_TWO);
    const staleMachine = createConnection("stale-machine");
    const selectedMachine = createConnection("selected-machine");
    connections.set(staleMachine.id, staleMachine);
    connections.set(selectedMachine.id, selectedMachine);

    advertiseHost(
      subject,
      staleMachine,
      MACHINE_ONE,
      buildHostRegistration(MACHINE_ONE, true, "stale-image"),
    );
    advertiseHost(subject, selectedMachine, MACHINE_TWO);

    expect(subject.isHostRoutable(MACHINE_ONE)).toBe(false);
    expect(subject.isHostRoutable(MACHINE_TWO)).toBe(true);
    expect(staleMachine.state).toMatchObject({
      hostDemoted: true,
      machineServiceKeys: [],
    });
    expect(staleMachine.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: `The selected execution machine connected (${MACHINE_TWO}); this machine is now on standby.`,
    });
    storage.close();
  });

  it("keeps the current machine active when a selected takeover fails its version fence", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, MACHINE_ONE);
    seedRegisteredHost(subject, MACHINE_TWO);
    selectHost(subject, MACHINE_TWO);
    const currentMachine = createConnection("current-machine");
    const staleSelectedMachine = createConnection("stale-selected-machine");
    connections.set(currentMachine.id, currentMachine);
    connections.set(staleSelectedMachine.id, staleSelectedMachine);
    advertiseHost(subject, currentMachine, MACHINE_ONE);
    (subject as any).handleMachineAlive(staleSelectedMachine, MACHINE_TWO);

    (subject as any).handleMachineUpdateRunnerState(staleSelectedMachine, {
      type: "machine-update-runner-state",
      machineId: MACHINE_TWO,
      runnerState: { host: buildHostRegistration(MACHINE_TWO) },
      expectedVersion: 1,
    });

    expect(subject.isHostRoutable(MACHINE_ONE)).toBe(true);
    expect(subject.isHostRoutable(MACHINE_TWO)).toBe(false);
    expect(currentMachine.state.machineServiceKeys).toContain("host");
    expect(staleSelectedMachine.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: "Version conflict (current: 2)",
    });
    storage.close();
  });

  it("reports a live but Hub-incompatible machine separately from offline", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    advertiseHost(
      subject,
      connection,
      DEFAULT_MACHINE_ID,
      buildHostRegistration(DEFAULT_MACHINE_ID, true, "stale-image"),
    );

    expect(subject.getMachineExecutionStatus(DEFAULT_MACHINE_ID)).toEqual({
      state: "incompatible",
      machineId: DEFAULT_MACHINE_ID,
      displayName: DEFAULT_MACHINE_ID,
      code: "runtime_image",
    });
    storage.close();
  });

  it("makes the newest healthy duplicate active and demotes the older socket", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const older = createConnection("older");
    const newer = createConnection("newer");
    connections.set(older.id, older);
    connections.set(newer.id, newer);

    advertiseHost(subject, older);
    advertiseHost(subject, newer);

    expect((subject as any).getRunnerConnection(DEFAULT_MACHINE_ID)).toBe(newer);
    expect(older.state).toMatchObject({
      hostDemoted: true,
      machineServiceKeys: [],
    });

    advertiseHost(subject, older);
    expect((subject as any).getRunnerConnection(DEFAULT_MACHINE_ID)).toBe(older);
    expect(newer.state).toMatchObject({
      hostDemoted: true,
      machineServiceKeys: [],
    });
    storage.close();
  });

  it("does not route an advertisement rejected by the version fence", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const accepted = createConnection("accepted");
    const stale = createConnection("stale");
    connections.set(accepted.id, accepted);
    connections.set(stale.id, stale);
    advertiseHost(subject, accepted);
    (subject as any).handleMachineAlive(stale, DEFAULT_MACHINE_ID);

    (subject as any).handleMachineUpdateRunnerState(stale, {
      type: "machine-update-runner-state",
      machineId: DEFAULT_MACHINE_ID,
      runnerState: { host: buildHostRegistration(DEFAULT_MACHINE_ID) },
      expectedVersion: 1,
    });

    expect((subject as any).getRunnerConnection(DEFAULT_MACHINE_ID)).toBe(accepted);
    expect(stale.state.machineServiceKeys).toEqual([]);
    expect(stale.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: "error",
      message: "Version conflict (current: 3)",
    });
    storage.close();
  });

  it("withdraws readiness when dependency health is lost or the lease expires", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const connection = createConnection("conn-1");
    connections.set(connection.id, connection);

    advertiseHost(subject, connection);
    expect(subject.isHostRoutable(DEFAULT_MACHINE_ID)).toBe(true);
    expect(subject.getMachineExecutionStatus(DEFAULT_MACHINE_ID)).toMatchObject({
      state: "ready",
      machineId: DEFAULT_MACHINE_ID,
    });

    advertiseHost(subject, connection, DEFAULT_MACHINE_ID, {
      ...buildHostRegistration(DEFAULT_MACHINE_ID),
      runnerAvailable: false,
    });
    expect(subject.isHostRoutable(DEFAULT_MACHINE_ID)).toBe(false);
    expect(subject.getMachineExecutionStatus(DEFAULT_MACHINE_ID)).toEqual({
      state: "not_connected",
    });

    advertiseHost(subject, connection);
    connection.setState({
      ...connection.state,
      hostAdvertisementAt: Date.now() - 75_001,
    });
    expect(subject.isHostRoutable(DEFAULT_MACHINE_ID)).toBe(false);
    expect(subject.getMachineExecutionStatus(DEFAULT_MACHINE_ID)).toEqual({
      state: "not_connected",
    });
    storage.close();
  });

  it("prefers an open fenced runner connection during reconnect overlap", () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject);
    const stale = createConnection("stale", {
      machineId: DEFAULT_MACHINE_ID,
      role: "cli",
      machineServiceKeys: ["host"],
      hostAdvertisementAt: 1,
    });
    const current = createConnection("current", {
      machineId: DEFAULT_MACHINE_ID,
      role: "cli",
      machineServiceKeys: ["host"],
      runnerCommandProtocol: 1,
      hostAdvertisementAt: Date.now(),
    });
    connections.set(stale.id, stale);
    connections.set(current.id, current);

    expect((subject as any).getRunnerConnection(DEFAULT_MACHINE_ID)).toBe(current);
    storage.close();
  });

  it("rejects runner control for an offline stored machine even when another host is active", async () => {
    const { subject, storage, connections } = createSubject();
    seedRegisteredHost(subject, MACHINE_ONE);
    seedRegisteredHost(subject, MACHINE_TWO);

    const connection = createConnection("conn-2");
    connections.set(connection.id, connection);
    advertiseHost(subject, connection, MACHINE_TWO);
    connection.sent.length = 0;

    await expect(
      subject.requestLocalRunner(MACHINE_ONE, "status", "demo-env"),
    ).rejects.toThrow(
      "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    );
    expect(connection.sent).toHaveLength(0);

    storage.close();
  });
});
