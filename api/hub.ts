import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { ensureSchema } from "./schema";
import { maybeVerifyCfAccessRequest } from "./auth";
import { ACCESS_CONFIG_CLAIM_KEYS } from "./access/config-keys";
import * as Q from "./queries";
import type { ThreadDO, ThreadMessage } from "./coordination";
import { clearMachineServiceKeys, getMachineServiceKeys, parseMachineServiceState } from "./machine-service-state";
import { readOptionalConfigValue } from "./config-row";
import { getLocationHintOptions } from "./helpers";
import {
  LEGACY_GATEWAY_TUNNEL_TOKEN_KEY,
  SELF_HOST_SETUP_SESSION_KEY,
  SELF_HOST_STATE_KEY,
  parseSelfHostState,
  type SelfHostMutationInput,
  type SelfHostProgressMutationInput,
} from "./self-host/state";
import {
  VALID_PHASES,
  VALID_ACTIVITIES,
} from "./types";
import type {
  Env,
  EnvMeta,
  HostServiceRegistration,
  MachineServiceKey,
  MachineServiceState,
  RepoMeta,
  RunnerControlAction,
  StoredSession,
  StoredMachine,
  StoredMessage,
  StoredPermission,
  VersionedUpdateResult,
  WsConnectionState,
  WsClientMessage,
  WsServerMessage,
} from "./types";

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute alarm for stale cleanup
const MACHINE_INACTIVE_GRACE_SECONDS = 90;
const RUNNER_REQUEST_TIMEOUT_MS = 15_000;
const SESSION_THREAD_PREFIX = "session:";

interface PendingRunnerRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ── HubDO ───────────────────────────────────────────────────────────

export class HubDO extends Server<Env> {
  static options = { hibernate: true };

  private _db: SqlStorage | null = null;
  private _schemaReady = false;

  // In-memory map for holding long-poll requests open until permission is resolved
  private pendingPolls = new Map<string, {
    resolve: (result: { status: string; decision_reason?: string }) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private pendingRunnerRequests = new Map<string, PendingRunnerRequest>();

  /** Lazy-init SQL — direct RPC stub calls bypass partyserver's onStart(). */
  private get db(): SqlStorage {
    if (!this._db) {
      this._db = this.ctx.storage.sql;
    }
    if (!this._schemaReady) {
      ensureSchema(this._db);
      this._schemaReady = true;
    }
    return this._db;
  }

  // ── Lifecycle ───────────────────────────────────────────────────

  async onStart(): Promise<void> {
    // Force schema init for WebSocket path
    console.time("[HubDO] onStart ensureSchema");
    const _ = this.db;
    console.timeEnd("[HubDO] onStart ensureSchema");
    // Handle ping/pong at the edge without waking the DO from hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    console.log("[HubDO] onStart done");
  }

  // ── WebSocket lifecycle hooks ─────────────────────────────────

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    try {
      await maybeVerifyCfAccessRequest(ctx.request, this.env);
    } catch (err) {
      console.warn("[HubDO] onConnect auth failed:", (err as Error).message);
      this.send(connection, { type: "error", message: "Unauthorized" });
      connection.close(4001, "Unauthorized");
      return;
    }

    console.log(`[HubDO] onConnect ok, t=${Date.now()}`);
    connection.setState({} as WsConnectionState);
    this.scheduleAlarm();
  }

  async onMessage(connection: Connection, message: WSMessage): Promise<void> {
    if (typeof message !== "string") return;

    let data: WsClientMessage;
    try {
      data = JSON.parse(message);
    } catch {
      this.send(connection, { type: "error", message: "Invalid JSON" });
      return;
    }

    switch (data.type) {
      case "reconnect":
        await this.handleReconnect(connection, data);
        break;
      case "message":
        await this.handleMessage(connection, data);
        break;
      case "session-alive":
        this.handleSessionAlive(connection, data.sessionId);
        break;
      case "session-end":
        this.handleSessionEnd(data.sessionId);
        break;
      case "update-metadata":
        this.handleUpdateMetadata(connection, data);
        break;
      case "update-agent-state":
        this.handleUpdateAgentState(connection, data);
        break;
      case "update-todos":
        this.handleUpdateTodos(connection, data);
        break;
      case "machine-alive":
        this.handleMachineAlive(connection, data.machineId);
        break;
      case "machine-update-metadata":
        this.handleMachineUpdateMetadata(connection, data);
        break;
      case "machine-update-runner-state":
        this.handleMachineUpdateRunnerState(connection, data);
        break;
      case "runner-control-response":
        this.handleRunnerControlResponse(data);
        break;
    }
  }

  onClose(connection: Connection, _code: number, _reason: string, _wasClean: boolean): void {
    this.cleanupConnection(connection);
  }

  onError(connection: Connection, _error: unknown): void {
    this.cleanupConnection(connection);
  }

  // ── Message handlers ──────────────────────────────────────────

  private handleMessage(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "message" }>,
  ): Promise<void> {
    return this.addMessage(
      data.id,
      data.sessionId,
      data.content,
      data.localId ?? null,
      connection.id,
    ).then(() => undefined);
  }

  private handleSessionAlive(connection: Connection, sessionId: string): void {
    // Persist sessionId on the connection so handleReconnect can replay missed messages
    const state = connection.state as WsConnectionState;
    if (!state.sessionId) {
      connection.setState({ ...state, sessionId } as WsConnectionState);
    }

    Q.reviveSession(this.db, sessionId);
    const session = Q.getSession(this.db, sessionId);
    if (session) {
      this.broadcastToAll({ type: "session-updated", session });
    }
  }

  private handleSessionEnd(sessionId: string): void {
    Q.markSessionEnded(this.db, sessionId);
    this.broadcastToAll({ type: "session-deleted", sessionId });
  }

  private handleUpdateMetadata(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "update-metadata" }>,
  ): void {
    const result = Q.updateSessionMetadata(
      this.db,
      data.sessionId,
      data.metadata,
      data.expectedVersion,
    );
    this.handleVersionedResult(connection, result, data.sessionId);
  }

  private handleUpdateAgentState(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "update-agent-state" }>,
  ): void {
    // Validate phase/activity if present in agent state
    const state = data.agentState as Record<string, unknown> | null;
    if (state && typeof state === "object") {
      if ("phase" in state && !VALID_PHASES.includes(state.phase as any)) {
        console.warn(`[HubDO] Invalid phase "${state.phase}" for session ${data.sessionId}`);
        this.send(connection, {
          type: "error",
          message: `Invalid phase value: ${state.phase}. Must be one of: ${VALID_PHASES.join(", ")}`,
        });
        return;
      }
      if ("activity" in state && !VALID_ACTIVITIES.includes(state.activity as any)) {
        console.warn(`[HubDO] Invalid activity "${state.activity}" for session ${data.sessionId}`);
        this.send(connection, {
          type: "error",
          message: `Invalid activity value: ${state.activity}. Must be one of: ${VALID_ACTIVITIES.join(", ")}`,
        });
        return;
      }
    }

    const result = Q.updateSessionAgentState(
      this.db,
      data.sessionId,
      data.agentState,
      data.expectedVersion,
    );
    this.handleVersionedResult(connection, result, data.sessionId);
  }

  private handleUpdateTodos(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "update-todos" }>,
  ): void {
    const result = Q.updateSessionTodos(
      this.db,
      data.sessionId,
      data.todos,
      data.expectedVersion,
    );
    this.handleVersionedResult(connection, result, data.sessionId);
  }

  private handleMachineAlive(connection: Connection, machineId: string): void {
    Q.markMachineAlive(this.db, machineId);
    const machine = this.bindRegisteredMachineServicesToConnection(connection, machineId);

    if (machine) {
      this.broadcastToAll({ type: "machine-updated", machine });
    }
  }

  private handleMachineUpdateMetadata(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "machine-update-metadata" }>,
  ): void {
    const result = Q.updateMachineMetadata(
      this.db,
      data.machineId,
      data.metadata,
      data.expectedVersion,
    );
    this.handleVersionedMachineResult(connection, result, data.machineId);
  }

  private handleMachineUpdateRunnerState(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "machine-update-runner-state" }>,
  ): void {
    const state = connection.state as WsConnectionState | undefined;
    const serviceKeys = getMachineServiceKeys(data.runnerState);
    if (serviceKeys.length > 0) {
      connection.setState({
        ...state,
        machineId: data.machineId,
        role: "cli",
        machineServiceKeys: [...new Set([...(state?.machineServiceKeys ?? []), ...serviceKeys])],
      } as WsConnectionState);
    }

    const result = Q.updateMachineRunnerState(
      this.db,
      data.machineId,
      data.runnerState,
      data.expectedVersion,
    );
    this.handleVersionedMachineResult(connection, result, data.machineId);
  }

  private handleRunnerControlResponse(
    data: Extract<WsClientMessage, { type: "runner-control-response" }>,
  ): void {
    const pending = this.pendingRunnerRequests.get(data.requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRunnerRequests.delete(data.requestId);

    if (data.ok) {
      pending.resolve(data.result);
      return;
    }

    pending.reject(new Error(data.error || "Runner request failed"));
  }

  private handleVersionedResult(
    connection: Connection,
    result: VersionedUpdateResult,
    sessionId: string,
  ): void {
    if (!result.ok) {
      this.send(connection, {
        type: "error",
        message: result.reason === "not_found"
          ? `Session ${sessionId} not found`
          : `Version conflict (current: ${result.current_version})`,
      });
      return;
    }
    const session = Q.getSession(this.db, sessionId);
    if (session) {
      this.broadcastToAll({ type: "session-updated", session });
    }
  }

  private handleVersionedMachineResult(
    connection: Connection,
    result: VersionedUpdateResult,
    machineId: string,
  ): void {
    if (!result.ok) {
      this.send(connection, {
        type: "error",
        message: result.reason === "not_found"
          ? `Machine ${machineId} not found`
          : `Version conflict (current: ${result.current_version})`,
      });
      return;
    }
    const machine = Q.getMachine(this.db, machineId);
    if (machine) {
      this.broadcastToAll({ type: "machine-updated", machine });
    }
  }

  // ── Reconnection ──────────────────────────────────────────────

  private async handleReconnect(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "reconnect" }>,
  ): Promise<void> {
    const state = connection.state as WsConnectionState;
    const sessionId = data.sessionId?.trim() || state.sessionId;

    if (data.sessionId?.trim() && state.sessionId !== sessionId) {
      connection.setState({ ...state, sessionId } as WsConnectionState);
    }

    if (sessionId) {
      Q.reviveSession(this.db, sessionId);
      const session = Q.getSession(this.db, sessionId);
      if (session) {
        this.broadcastToAll({ type: "session-updated", session });
      }
    }

    if (!sessionId) {
      // No session context — just ack
      this.send(connection, { type: "replay", events: [] });
      return;
    }

    const missed = await this.getSessionMessagesSince(sessionId, data.lastSeq);
    const events: WsServerMessage[] = missed.map((m) => ({
      type: "message-received" as const,
      id: m.id,
      sessionId: m.session_id,
      content: JSON.parse(m.content),
      seq: m.seq,
      localId: m.local_id ?? undefined,
    }));

    this.send(connection, { type: "replay", events });
  }

  private getLiveReferences(excludeConnectionId?: string): {
    hasConnections: boolean;
    machineIds: Set<string>;
    sessionIds: Set<string>;
  } {
    const machineIds = new Set<string>();
    const sessionIds = new Set<string>();
    let hasConnections = false;

    for (const conn of this.getConnections()) {
      if (excludeConnectionId && conn.id === excludeConnectionId) continue;
      hasConnections = true;
      const state = conn.state as WsConnectionState | undefined;
      if (state?.machineId) machineIds.add(state.machineId);
      if (state?.sessionId) sessionIds.add(state.sessionId);
    }

    return { hasConnections, machineIds, sessionIds };
  }

  private scheduleAlarm(): void {
    this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private markMachineInactive(machineId: string): void {
    const machine = Q.getMachine(this.db, machineId);
    if (!machine || machine.active !== 1) return;

    Q.setMachineActive(this.db, machineId, false);
    const updated = Q.getMachine(this.db, machineId);
    if (updated) {
      this.broadcastToAll({ type: "machine-updated", machine: updated });
    }
  }

  // ── Connection cleanup ────────────────────────────────────────

  private cleanupConnection(connection: Connection): void {
    const state = connection.state as WsConnectionState | undefined;
    if (!state) return;

    if (state.machineId && state.machineServiceKeys && state.machineServiceKeys.length > 0) {
      this.pruneMachineServices(state.machineId, state.machineServiceKeys, connection.id);
    }
  }

  broadcastEnvUpsert(env: EnvMeta): void {
    this.broadcastToAll({ type: "env-upsert", env });
  }

  broadcastEnvRemove(slug: string): void {
    this.broadcastToAll({ type: "env-remove", slug });
  }

  broadcastRepoUpsert(repo: RepoMeta): void {
    this.broadcastToAll({ type: "repo-upsert", repo });
  }

  broadcastRepoRemove(repoId: string): void {
    this.broadcastToAll({ type: "repo-remove", repoId });
  }

  broadcastRepoMainChange(
    repoId: string,
    repoUrl: string,
    previousMainCommit: string | null,
    currentMainCommit: string | null,
    sourceEnvSlug?: string | null,
  ): void {
    this.broadcastToAll({
      type: "repo-main-changed",
      repoId,
      repoUrl,
      previousMainCommit,
      currentMainCommit,
      sourceEnvSlug,
    });
  }

  // ── Typed RPC methods (called from Worker via stub) ───────────

  createSession(
    id: string,
    tag: string,
    machineId: string | null,
    metadata: unknown,
  ): StoredSession {
    const session = Q.createSession(this.db, id, tag, machineId, metadata);
    this.broadcastToAll({ type: "session-updated", session });
    return session;
  }

  getSession(id: string): StoredSession | null {
    return Q.getSession(this.db, id);
  }

  getSessions(): StoredSession[] {
    return Q.getSessions(this.db);
  }

  getAllSessions(): StoredSession[] {
    return Q.getAllSessions(this.db);
  }

  updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionMetadata(this.db, id, metadata, expectedVersion);
  }

  updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionAgentState(this.db, id, agentState, expectedVersion);
  }

  updateSessionTodos(id: string, todos: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionTodos(this.db, id, todos, expectedVersion);
  }

  deleteSession(id: string): void {
    Q.deleteSession(this.db, id);
    this.broadcastToAll({ type: "session-deleted", sessionId: id });
  }

  setSessionActive(id: string, active: boolean): void {
    Q.setSessionActive(this.db, id, active);
    const session = Q.getSession(this.db, id);
    if (session) {
      this.broadcastToAll({ type: "session-updated", session });
    }
  }

  getOrCreateMachine(id: string, metadata: unknown): StoredMachine {
    return Q.getOrCreateMachine(this.db, id, metadata);
  }

  getMachines(): StoredMachine[] {
    return Q.getMachines(this.db);
  }

  private readRegisteredHostService(machineId?: string | null): HostServiceRegistration | null {
    const preferredMachineId = machineId?.trim() || null;
    let selected: { service: HostServiceRegistration; connectedAtMs: number } | null = null;

    for (const machine of Q.getMachines(this.db)) {
      if (machine.active !== 1) continue;
      if (preferredMachineId && machine.id !== preferredMachineId) continue;

      let state: MachineServiceState;
      try {
        state = parseMachineServiceState(machine.runner_state);
      } catch {
        continue;
      }

      const service = state.host;
      const normalizedMachineId = service?.machineId?.trim();
      if (!service || !normalizedMachineId || service.transport !== "session") continue;
      if (preferredMachineId && normalizedMachineId !== preferredMachineId) continue;

      const parsedConnectedAtMs = Date.parse(service.connectedAt ?? "");
      const connectedAtMs = Number.isFinite(parsedConnectedAtMs) ? parsedConnectedAtMs : 0;
      const normalized = {
        ...service,
        machineId: normalizedMachineId,
        ...(service.gatewayUrl?.trim() ? { gatewayUrl: service.gatewayUrl.trim() } : {}),
        ...(service.gatewayServiceTokenHash?.trim()
          ? { gatewayServiceTokenHash: service.gatewayServiceTokenHash.trim() }
          : {}),
        ...(service.codexGatewayAuth === "session-token" ? { codexGatewayAuth: service.codexGatewayAuth } : {}),
      };

      if (preferredMachineId) {
        return normalized;
      }

      if (!selected || connectedAtMs > selected.connectedAtMs) {
        selected = {
          service: normalized,
          connectedAtMs,
        };
      }
    }

    return selected?.service ?? null;
  }

  getActiveHostService(): HostServiceRegistration | null {
    // Durable view only: this reports the most recently registered host service,
    // not whether a live socket is currently routable for runner traffic.
    return this.readRegisteredHostService();
  }

  getHostService(machineId?: string | null): HostServiceRegistration | null {
    return this.readRegisteredHostService(machineId);
  }

  getRoutableHostService(preferredMachineId?: string | null): HostServiceRegistration | null {
    try {
      const machineId = this.resolveRunnerMachineId(preferredMachineId, {
        allowFallbackToActive: !(preferredMachineId?.trim()),
      });
      return this.readRegisteredHostService(machineId);
    } catch {
      return null;
    }
  }

  getActiveService(kind: "host"): HostServiceRegistration | null;
  getActiveService(kind: MachineServiceKey): HostServiceRegistration | null {
    return this.getActiveHostService();
  }

  isHostRoutable(preferredMachineId?: string | null): boolean {
    try {
      this.resolveRunnerMachineId(preferredMachineId, {
        allowFallbackToActive: !(preferredMachineId?.trim()),
      });
      return true;
    } catch {
      return false;
    }
  }

  async requestLocalRunner(
    machineId: string | null,
    action: RunnerControlAction,
    slug: string,
    options?: {
      repoUrl?: string;
      envVars?: Record<string, string>;
      startOpId?: string;
      stopOpId?: string;
    },
  ): Promise<{ machineId: string; result: unknown }> {
    const resolvedMachineId = this.resolveRunnerMachineId(machineId, {
      allowFallbackToActive: !(machineId?.trim()),
    });
    const result = await this.requestRunnerControl(resolvedMachineId, {
      action,
      slug,
      ...(options?.repoUrl ? { repoUrl: options.repoUrl } : {}),
      ...(options?.envVars ? { envVars: options.envVars } : {}),
      ...(options?.startOpId ? { startOpId: options.startOpId } : {}),
      ...(options?.stopOpId ? { stopOpId: options.stopOpId } : {}),
    });
    return {
      machineId: resolvedMachineId,
      result,
    };
  }

  async addMessage(
    id: string,
    sessionId: string,
    content: unknown,
    localId: string | null,
    excludeConnectionId?: string,
  ): Promise<{ message: StoredMessage; sessionSeq: number }> {
    const thread = await this.ensureSessionThread(sessionId);
    const sessionSeq = Q.nextSessionMessageSeq(this.db, sessionId);
    const threadMessage = await thread.appendMessage({
      id,
      senderSessionId: sessionId,
      seq: sessionSeq,
      kind: "chat",
      body: content,
      ...(localId ? { localId } : {}),
    });
    const result = {
      message: this.threadMessageToStoredMessage(sessionId, threadMessage),
      sessionSeq,
    };

    // Broadcast to all WS clients (REST-originated messages need this
    // so CLI picks them up via its message-received handler)
    const event: WsServerMessage = {
      type: "message-received",
      id: result.message.id,
      sessionId,
      content: JSON.parse(result.message.content),
      seq: result.sessionSeq,
      localId: result.message.local_id ?? undefined,
    };
    this.broadcastToAll(event, excludeConnectionId);

    return result;
  }

  async getMessages(
    sessionId: string,
    opts: { limit?: number; beforeSeq?: number; afterSeq?: number },
  ): Promise<StoredMessage[]> {
    return this.readSessionMessages(sessionId, opts);
  }

  private getSessionThreadId(sessionId: string): string {
    return `${SESSION_THREAD_PREFIX}${sessionId}`;
  }

  private getSessionThreadStub(sessionId: string): ThreadDO | null {
    if (!this.env.THREAD) return null;
    const id = this.env.THREAD.idFromName(this.getSessionThreadId(sessionId));
    return this.env.THREAD.get(id, getLocationHintOptions(this.env)) as unknown as ThreadDO;
  }

  private async ensureSessionThread(sessionId: string): Promise<ThreadDO> {
    const thread = this.getSessionThreadStub(sessionId);
    if (!thread) {
      throw new Error("ThreadDO binding is required for session message storage.");
    }
    const existing = await thread.getThread();
    if (existing) return thread;
    await thread.createThread({
      id: this.getSessionThreadId(sessionId),
      scope: { type: "session", sessionId },
      kind: "chat",
    });
    return thread;
  }

  private threadMessageToStoredMessage(sessionId: string, message: ThreadMessage): StoredMessage {
    return {
      id: message.id,
      session_id: sessionId,
      content: JSON.stringify(message.body),
      seq: message.seq,
      local_id: message.localId ?? null,
      created_at: message.createdAt,
    };
  }

  private async listThreadBackedMessages(
    sessionId: string,
    opts: { limit?: number; beforeSeq?: number; afterSeq?: number },
  ): Promise<StoredMessage[]> {
    const thread = this.getSessionThreadStub(sessionId);
    if (!thread) return [];

    const existing = await thread.getThread();
    if (!existing) return [];

    const messages = await thread.listMessages(opts);
    return messages.map((message) => this.threadMessageToStoredMessage(sessionId, message));
  }

  private async readSessionMessages(
    sessionId: string,
    opts: { limit?: number; beforeSeq?: number; afterSeq?: number },
  ): Promise<StoredMessage[]> {
    return this.listThreadBackedMessages(sessionId, opts);
  }

  private async getSessionMessagesSince(sessionId: string, afterSeq: number): Promise<StoredMessage[]> {
    return this.listThreadBackedMessages(sessionId, {
      afterSeq,
      limit: 1000,
    });
  }

  private getLiveMachineServiceKeys(machineId: string, excludeConnectionId?: string): Set<MachineServiceKey> {
    const liveKeys = new Set<MachineServiceKey>();

    for (const conn of this.getConnections()) {
      if (excludeConnectionId && conn.id === excludeConnectionId) continue;
      const state = conn.state as WsConnectionState | undefined;
      if (state?.machineId !== machineId) continue;
      for (const key of state.machineServiceKeys ?? []) {
        liveKeys.add(key);
      }
    }

    return liveKeys;
  }

  private bindRegisteredMachineServicesToConnection(
    connection: Connection,
    machineId: string,
  ): StoredMachine | null {
    const state = connection.state as WsConnectionState | undefined;
    const machine = Q.getMachine(this.db, machineId);
    const registeredServiceKeys = machine ? getMachineServiceKeys(machine.runner_state) : [];

    // `runner_state` is durable registration. `machineServiceKeys` is which live socket
    // currently owns those services. `machine-alive` re-binds them after reconnect.
    connection.setState({
      ...state,
      machineId,
      role: "cli",
      ...(registeredServiceKeys.length > 0
        ? { machineServiceKeys: [...new Set([...(state?.machineServiceKeys ?? []), ...registeredServiceKeys])] }
        : {}),
    } as WsConnectionState);

    return machine;
  }

  private pruneMachineServices(
    machineId: string,
    machineServiceKeys: MachineServiceKey[],
    excludeConnectionId: string,
  ): void {
    const liveKeys = this.getLiveMachineServiceKeys(machineId, excludeConnectionId);
    const staleKeys = machineServiceKeys.filter((key) => !liveKeys.has(key));
    if (staleKeys.length === 0) return;

    const machine = Q.getMachine(this.db, machineId);
    if (!machine) return;

    const currentState = parseMachineServiceState(machine.runner_state);
    const nextState = clearMachineServiceKeys(currentState, staleKeys);
    if (JSON.stringify(currentState) === JSON.stringify(nextState)) {
      return;
    }

    Q.replaceMachineRunnerState(this.db, machineId, nextState);
    const updated = Q.getMachine(this.db, machineId);
    if (updated) {
      this.broadcastToAll({ type: "machine-updated", machine: updated });
    }
  }

  private resolveRunnerMachineId(
    preferredMachineId?: string | null,
    options?: { allowFallbackToActive?: boolean },
  ): string {
    const preferred = preferredMachineId?.trim();
    if (preferred && this.getRunnerConnection(preferred)) {
      return preferred;
    }

    if (preferred && options?.allowFallbackToActive === false) {
      throw new Error("Tiller Self Host is offline. Start `tiller host` on your self-host machine to manage host environments.");
    }

    const activeHost = this.getActiveHostService();
    const activeMachineId = activeHost?.machineId?.trim();
    if (activeMachineId && this.getRunnerConnection(activeMachineId)) {
      return activeMachineId;
    }

    throw new Error("Tiller Self Host is offline. Start `tiller host` on your self-host machine to manage host environments.");
  }

  private requestRunnerControl(
    machineId: string,
    request: {
      action: RunnerControlAction;
      slug: string;
      repoUrl?: string;
      envVars?: Record<string, string>;
      startOpId?: string;
      stopOpId?: string;
    },
    timeoutMs = RUNNER_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const connection = this.getRunnerConnection(machineId);
    if (!connection) {
      throw new Error("Tiller Self Host is offline. Start `tiller host` on your self-host machine to manage host environments.");
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRunnerRequests.delete(requestId);
        reject(new Error("Timed out waiting for Tiller Self Host."));
      }, timeoutMs);

      this.pendingRunnerRequests.set(requestId, { resolve, reject, timer });
      this.send(connection, {
        type: "runner-control-request",
        requestId,
        action: request.action,
        slug: request.slug,
        ...(request.repoUrl ? { repoUrl: request.repoUrl } : {}),
        ...(request.envVars ? { envVars: request.envVars } : {}),
        ...(request.startOpId ? { startOpId: request.startOpId } : {}),
        ...(request.stopOpId ? { stopOpId: request.stopOpId } : {}),
      });
    });
  }

  private getRunnerConnection(machineId: string): Connection | null {
    for (const conn of this.getConnections()) {
      const state = conn.state as WsConnectionState | undefined;
      if (
        state?.machineId === machineId &&
        state.role === "cli" &&
        (state.machineServiceKeys ?? []).includes("host")
      ) {
        return conn;
      }
    }
    return null;
  }

  // ── Permission RPC methods ──────────────────────────────────────

  createPermission(
    id: string,
    sessionId: string,
    toolName: string,
    toolInput: unknown,
  ): StoredPermission {
    const permission = Q.createPermission(this.db, id, sessionId, toolName, toolInput);
    this.broadcastToAll({ type: "permission-created", permission });
    return permission;
  }

  getPermission(permId: string): StoredPermission | null {
    return Q.getPermission(this.db, permId);
  }

  getPendingPermissions(sessionId: string): StoredPermission[] {
    return Q.getPendingPermissions(this.db, sessionId);
  }

  resolvePermission(
    permId: string,
    status: "allowed" | "denied",
    decisionReason?: string,
    allowForSession?: boolean,
  ): StoredPermission | null {
    const permission = Q.resolvePermission(this.db, permId, status, decisionReason);
    if (!permission) return null;

    // If "allow for session", add tool pattern to session's allowed_tools
    if (allowForSession && status === "allowed") {
      Q.addSessionAllowedTool(this.db, permission.session_id, permission.tool_name);
    }

    // Broadcast resolution to all WS clients
    this.broadcastToAll({ type: "permission-resolved", permission });

    // Resolve any waiting long-poll request
    const poll = this.pendingPolls.get(permId);
    if (poll) {
      clearTimeout(poll.timer);
      this.pendingPolls.delete(permId);
      poll.resolve({ status, decision_reason: decisionReason });
    }

    return permission;
  }

  addSessionAllowedTool(sessionId: string, toolPattern: string): void {
    Q.addSessionAllowedTool(this.db, sessionId, toolPattern);
  }

  /**
   * Long-poll: blocks until the permission is resolved or timeout (25s).
   * Returns { status: "timeout" } on timeout, or the resolution status.
   *
   * Registers the poll entry BEFORE checking DB status to close the race
   * window where resolvePermission() fires between the check and registration.
   */
  async waitForPermission(
    permId: string,
    timeout = 25_000,
  ): Promise<{ status: string; decision_reason?: string }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPolls.delete(permId);
        resolve({ status: "timeout" });
      }, timeout);

      // Register poll first so a concurrent resolve won't be missed
      this.pendingPolls.set(permId, { resolve, timer });

      // Now check if already resolved — if so, resolve immediately
      const existing = Q.getPermission(this.db, permId);
      if (existing && existing.status !== "pending") {
        clearTimeout(timer);
        this.pendingPolls.delete(permId);
        resolve({ status: existing.status, decision_reason: existing.decision_reason ?? undefined });
      }
    });
  }

  // ── Config RPC methods (settings page secret storage) ─────────

  getAllConfig(): Record<string, string> {
    const rows = this.db
      .exec("SELECT key, value FROM config")
      .toArray() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  getConfig(key: string): string | undefined {
    return readOptionalConfigValue(this.db, key);
  }

  setConfig(key: string, value: string): void {
    this.db.exec(
      `INSERT INTO config (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      key,
      value,
    );
  }

  compareAndSetConfig(key: string, expectedValue: string, nextValue: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const currentValue = readOptionalConfigValue(this.db, key) ?? "";
      if (currentValue !== expectedValue) {
        return false;
      }
      this.setConfig(key, nextValue);
      return true;
    });
  }

  commitSelfHostMutation(input: SelfHostMutationInput): boolean {
    return this.ctx.storage.transactionSync(() => {
      const currentState = parseSelfHostState(readOptionalConfigValue(this.db, SELF_HOST_STATE_KEY));
      if ("state" in input.expected) {
        if (currentState) return false;
      } else if (
        !currentState
        || currentState.attemptId !== input.expected.attemptId
        || currentState.phase !== input.expected.phase
      ) {
        return false;
      }

      this.setConfig(SELF_HOST_STATE_KEY, input.nextState ? JSON.stringify(input.nextState) : "");
      this.setConfig(SELF_HOST_SETUP_SESSION_KEY, "");
      this.setConfig(LEGACY_GATEWAY_TUNNEL_TOKEN_KEY, "");
      for (const [key, value] of Object.entries(input.configEntries ?? {})) {
        this.setConfig(key, value ?? "");
      }
      return true;
    });
  }

  commitSelfHostProgress(input: SelfHostProgressMutationInput): boolean {
    return this.ctx.storage.transactionSync(() => {
      const currentState = parseSelfHostState(readOptionalConfigValue(this.db, SELF_HOST_STATE_KEY));
      if (
        !currentState
        || currentState.phase !== "promoted"
        || currentState.attemptId !== input.expected.attemptId
      ) {
        return false;
      }

      this.setConfig(SELF_HOST_STATE_KEY, JSON.stringify({
        ...currentState,
        progress: input.progress,
      }));
      return true;
    });
  }

  getOrCreateConfig(key: string, value: string): string {
    const existingValue = readOptionalConfigValue(this.db, key);
    if (existingValue) {
      return existingValue;
    }

    this.setConfig(key, value);
    return value;
  }

  claimWorkersDevAccessConfig(input: {
    audience: string;
    teamDomain: string;
  }): {
    claimed: boolean;
    audience: string | null;
    teamDomain: string | null;
  } {
    return this.ctx.storage.transactionSync(() => {
      const existingAudience = readOptionalConfigValue(this.db, "CF_ACCESS_AUD");
      const existingTeamDomain = readOptionalConfigValue(this.db, "CF_ACCESS_TEAM_DOMAIN");
      if (ACCESS_CONFIG_CLAIM_KEYS.some((key) => readOptionalConfigValue(this.db, key)?.trim())) {
        return {
          claimed: false,
          audience: existingAudience?.trim() || null,
          teamDomain: existingTeamDomain?.trim() || null,
        };
      }

      this.setConfig("CF_ACCESS_AUD", input.audience);
      this.setConfig("CF_ACCESS_TEAM_DOMAIN", input.teamDomain);
      this.setConfig("CF_ACCESS_JWKS_URL", "");
      this.setConfig("CF_ACCESS_CLIENT_ID", "");
      this.setConfig("CF_ACCESS_CLIENT_SECRET", "");
      this.setConfig("CF_ACCESS_CONFIGURED", "true");

      return {
        claimed: true,
        audience: input.audience,
        teamDomain: input.teamDomain,
      };
    });
  }

  deleteConfig(key: string): void {
    this.db.exec("DELETE FROM config WHERE key = ?", key);
  }

  // ── Alarm (stale session/machine cleanup) ─────────────────────

  async onAlarm(): Promise<void> {
    const live = this.getLiveReferences();

    // Mark stale machines with no live connections as inactive after a reconnect grace period.
    const machines = this.db
      .exec(
        `SELECT id
         FROM machines
         WHERE active = 1
           AND updated_at < datetime('now', ?)` ,
        `-${MACHINE_INACTIVE_GRACE_SECONDS} seconds`,
      )
      .toArray() as { id: string }[];
    for (const { id } of machines) {
      if (!live.machineIds.has(id)) {
        this.markMachineInactive(id);
      }
    }

    // For sessions that are inactive but not yet ended (crash/disconnect scenario),
    // soft-delete them: set ended_at and broadcast session-deleted to clean up the web UI.
    const inactiveSessions = this.db
      .exec("SELECT id FROM sessions WHERE active = 0 AND ended_at IS NULL")
      .toArray() as { id: string }[];
    for (const { id } of inactiveSessions) {
      if (!live.sessionIds.has(id)) {
        Q.markSessionEnded(this.db, id);
        this.broadcastToAll({ type: "session-deleted", sessionId: id });
      }
    }

    // Hard-delete sessions whose ended_at is older than 24 hours
    this.db.exec("DELETE FROM sessions WHERE ended_at < datetime('now', '-24 hours')");

    const activeMachineCount =
      (this.db.exec("SELECT COUNT(*) AS count FROM machines WHERE active = 1").toArray()[0] as { count: number } | undefined)
        ?.count ?? 0;

    // Reschedule while there are live connections or active machines still eligible for a future grace-period cleanup.
    if (live.hasConnections || activeMachineCount > 0) {
      this.scheduleAlarm();
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private send(connection: Connection, message: WsServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private broadcastToAll(message: WsServerMessage, excludeId?: string): void {
    const payload = JSON.stringify(message);
    for (const conn of this.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      try { conn.send(payload); } catch { /* connection closing */ }
    }
  }
}
