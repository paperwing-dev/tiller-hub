import { Server, type Connection, type ConnectionContext, type WSMessage } from "partyserver";
import { ensureSchema } from "./schema";
import { authenticateWebSocketAuthorization } from "./auth";
import * as Q from "./queries";
import type { ThreadDO, ThreadMessage } from "./coordination";
import {
  getMachineServiceKeys,
  isMachineUuid,
  parseMachineServiceState,
} from "./machine-service-state";
import { readOptionalConfigValue } from "./config-row";
import {
  readManagedEnvSlugFromStoredSession,
  readTerminalScopeFromStoredSession,
} from "./session-attachment";
import { classifyHostRuntimeCompatibility } from "./setup/runtime-compatibility";
import { isLocalOnlyRunnerBackendMode } from "./env/runner-backend";
import { HopMetricRecorder, safeTerminalIdentifier } from "./terminal-metrics";
import {
  normalizeBillingSelections,
  type BillingSelections,
} from "../shared/billing";
import {
  LEGACY_CUSTOM_DOMAIN_SETUP_SESSION_KEY,
  LEGACY_CUSTOM_DOMAIN_STATE_KEY,
  parseLegacyCustomDomainState,
} from "./legacy-custom-domain-state";
import {
  VALID_PHASES,
  VALID_ACTIVITIES,
} from "./types";
import {
  readCanonicalWorkersDevAccessTrust,
} from "./workers-dev-access/records";
import { bytesToArrayBuffer } from "./bytes";
import {
  EXECUTION_MIGRATION_KEY,
  EXECUTION_SELECTION_KEY,
  EXISTING_EXECUTION_UNAVAILABLE_MESSAGE,
  LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY,
  NEW_EXECUTION_UNAVAILABLE_MESSAGE,
  deriveExecutionStatus,
  executionSelectionConflict,
  hostStatusFromService,
  parseExecutionSelection,
  parseLegacyCustomDomainCleanupManifest,
  selectionToPlacement,
  type LegacyCustomDomainCleanupManifestV1,
} from "./execution";
import { inspectPredeployCleanSlate } from "./predeploy-clean-slate";
import { getDurableObjectStub } from "./durable-object";
import {
  applySessionEnvPatch,
  normalizeSessionEnvPatch,
  type RepoSessionEnvMetadata,
  type RepoSessionEnvPatch,
} from "./session-env";
import {
  McpServersValidationError,
  normalizeRepoMcpServersRequest,
  type RepoMcpServer,
  type RepoMcpServersPutResult,
} from "./mcp-servers";
import type {
  Env,
  EnvMeta,
  ExecutionPlacement,
  ExecutionSelection,
  ExecutionStatus,
  HostServiceRegistration,
  HostStatus,
  MachineServiceState,
  RepoMeta,
  RunnerCommandDesiredState,
  RunnerControlAction,
  RunnerControlErrorCode,
  RunnerControlRequestMessage,
  StoredSession,
  StoredMachine,
  StoredMessage,
  StoredPermission,
  SetExecutionBackendRequest,
  SetExecutionBackendResult,
  TerminalControlAckMessage,
  TerminalControlMessage,
  TerminalInputAckMessage,
  TerminalInputMessage,
  VersionedUpdateResult,
  WsConnectionState,
  WsClientMessage,
  WsServerMessage,
} from "./types";

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute alarm for stale cleanup
const MACHINE_INACTIVE_GRACE_SECONDS = 90;
const HOST_HEALTH_LEASE_MS = 75_000;
const RUNNER_REQUEST_TIMEOUT_MS = 15_000;
const TERMINAL_OWNER_GRACE_MS = 750;
const PLAN_WRITER_TERMINAL_OWNER_GRACE_MS = 5_000;
const TERMINAL_OWNER_UNAVAILABLE_ERROR = "No active terminal owner for session";
const SCOPED_WS_MESSAGE_TYPES: ReadonlySet<WsClientMessage["type"]> = new Set([
  "ping",
  "reconnect",
  "message",
  "terminal-input-ack",
  "terminal-control-ack",
  "session-alive",
  "session-end",
  "update-agent-state",
  "update-todos",
]);
const MAX_TERMINAL_ACK_OWNER_ROUTES = 4_096;
const SESSION_THREAD_PREFIX = "session:";
const REPO_SESSION_ENV_DATA_KEY = "__private:repo_session_env:data_key:v1";
const LEGACY_REPO_CLOUDFLARE_MCP_DATA_KEY = "__private:repo_cloudflare_mcp:data_key:v1";

interface PendingRunnerRequest {
  connectionId: string;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

class RunnerControlError extends Error {
  readonly code?: RunnerControlErrorCode;
  readonly currentCommandGeneration?: number;

  constructor(
    message: string,
    code?: RunnerControlErrorCode,
    currentCommandGeneration?: number,
  ) {
    super(code ? `[${code}] ${message}` : message);
    this.name = "RunnerControlError";
    this.code = code;
    this.currentCommandGeneration = currentCommandGeneration;
  }
}

type PendingTerminalDelivery = {
  sender: Connection;
  message: TerminalInputMessage | TerminalControlMessage;
  timer: ReturnType<typeof setTimeout>;
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function createDataKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64(bytes);
}

function legacyCleanupManifest(
  rawState: string | undefined,
): LegacyCustomDomainCleanupManifestV1 | null {
  const state = parseLegacyCustomDomainState(rawState);
  if (!state) return null;
  const domain = state.resources.workerCustomDomain;
  const access = state.resources.hubAccess;
  return {
    version: 1,
    capturedAt: new Date().toISOString(),
    customHostname: domain.hostname,
    workerService: domain.service,
    accountId: domain.accountId,
    zoneId: domain.zoneId,
    customDomainId: domain.domainId,
    accessApplicationId: access.appId,
    accessPolicyIds: [
      access.browserPolicyId,
      access.serviceTokenPolicyId,
    ].filter((value, index, values) => Boolean(value) && values.indexOf(value) === index),
  };
}

async function importAesKey(rawKeyBase64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(base64ToBytes(rawKeyBase64)),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
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
  private pendingTerminalDeliveries = new Map<string, PendingTerminalDelivery>();
  private terminalAckOwnerRoutes = new Map<string, string>();
  private sessionAppendTails = new Map<string, Promise<void>>();
  private repoSessionEnvPatchQueues = new Map<string, Promise<void>>();
  private readonly terminalMetricsEnabled = this.env.TILLER_TERMINAL_METRICS === "1";
  private readonly terminalAppendQueueMetrics = new HopMetricRecorder(
    "hub_terminal_append_queue_wait",
    this.terminalMetricsEnabled,
  );
  private readonly terminalCommitRoundTripMetrics = new HopMetricRecorder(
    "hub_to_thread_commit_round_trip",
    this.terminalMetricsEnabled,
  );
  private readonly terminalBroadcastMetrics = new HopMetricRecorder(
    "hub_commit_to_broadcast",
    this.terminalMetricsEnabled,
  );

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
    await this.ctx.storage.delete(LEGACY_REPO_CLOUDFLARE_MCP_DATA_KEY);
    // Handle ping/pong at the edge without waking the DO from hibernation
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}'),
    );
    console.log("[HubDO] onStart done");
  }

  // ── WebSocket lifecycle hooks ─────────────────────────────────

  async onConnect(connection: Connection, ctx: ConnectionContext): Promise<void> {
    let authorization;
    try {
      authorization = await authenticateWebSocketAuthorization(ctx.request, this.env);
    } catch (err) {
      console.warn("[HubDO] onConnect auth failed:", (err as Error).message);
      this.send(connection, { type: "error", message: "Unauthorized" });
      connection.close(4001, "Unauthorized");
      return;
    }

    if (authorization.kind === "environment") {
      const session = Q.getSession(this.db, authorization.sessionId);
      if (!session || readManagedEnvSlugFromStoredSession(session) !== authorization.envSlug) {
        this.send(connection, { type: "error", message: "Runtime session scope mismatch" });
        connection.close(4003, "Runtime session scope mismatch");
        return;
      }
    }
    if (authorization.kind === "planWriter") {
      const session = Q.getSession(this.db, authorization.sessionId);
      const scope = session ? readTerminalScopeFromStoredSession(session) : null;
      if (
        scope?.kind !== "plan-writer"
        || scope.revokedAt
        || scope.repoId !== authorization.repoId
        || scope.planArtifactId !== authorization.planArtifactId
        || scope.generation !== authorization.generation
      ) {
        this.send(connection, { type: "error", message: "Plan writer session scope mismatch" });
        connection.close(4003, "Plan writer session scope mismatch");
        return;
      }
    }

    try {
      await this.ensureExecutionConfiguration();
    } catch (err) {
      console.warn("[HubDO] execution migration failed:", (err as Error).message);
      this.send(connection, { type: "error", message: "Hub execution configuration is unavailable." });
      connection.close(4003, "Execution configuration unavailable");
      return;
    }

    console.log(`[HubDO] onConnect ok, t=${Date.now()}`);
    connection.setState({
      authorization,
      ...(authorization.kind === "environment" || authorization.kind === "planWriter"
        ? { sessionId: authorization.sessionId, sessionLifecycle: "owner" as const }
        : {}),
    } as WsConnectionState);
    this.send(connection, {
      type: "capabilities",
      terminalFastLane: true,
      terminalMetrics: this.terminalMetricsEnabled,
    });
    await this.scheduleAlarm();
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

    if (!this.authorizeWsMessage(connection, data)) return;

    switch (data.type) {
      case "reconnect":
        await this.handleReconnect(connection, data);
        break;
      case "message":
        await this.handleMessage(connection, data);
        break;
      case "terminal-input":
        this.handleTerminalInput(connection, data);
        break;
      case "terminal-control":
        this.handleTerminalControl(connection, data);
        break;
      case "terminal-input-ack":
        this.handleTerminalInputAck(connection, data);
        break;
      case "terminal-control-ack":
        this.handleTerminalControlAck(connection, data);
        break;
      case "terminal-detach":
        this.handleTerminalDetach(connection, data.sessionId, data.clientId);
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
        this.handleRunnerControlResponse(connection, data);
        break;
    }
  }

  private authorizeWsMessage(connection: Connection, data: WsClientMessage): boolean {
    const authorization = (connection.state as WsConnectionState | undefined)?.authorization;
    if (!authorization) {
      this.send(connection, { type: "error", message: "Connection authority is unavailable" });
      connection.close(4001, "Unauthorized");
      return false;
    }
    if (authorization.kind === "global") return true;
    const sessionId = "sessionId" in data && typeof data.sessionId === "string"
      ? data.sessionId
      : null;
    if (sessionId && sessionId !== authorization.sessionId) {
      this.send(connection, { type: "error", message: "Scoped runtime cannot use another session" });
      return false;
    }
    if (!SCOPED_WS_MESSAGE_TYPES.has(data.type)) {
      this.send(connection, { type: "error", message: "Message is not allowed for a scoped runtime" });
      return false;
    }
    if ("envSlug" in data && typeof data.envSlug === "string") {
      if (authorization.kind !== "environment" || data.envSlug !== authorization.envSlug) {
        this.send(connection, { type: "error", message: "Scoped runtime environment mismatch" });
        return false;
      }
    }
    return true;
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
    const sessionBefore = Q.getSession(this.db, sessionId);
    const scope = sessionBefore ? readTerminalScopeFromStoredSession(sessionBefore) : null;
    if ((!sessionBefore && sessionId.startsWith("plan-writer-")) || (scope?.kind === "plan-writer" && scope.revokedAt)) {
      this.send(connection, { type: "error", message: !sessionBefore ? "Session not found" : "Plan writer terminal is read-only" });
      return;
    }
    // Persist owner session context so reconnect replay and liveness cleanup stay scoped.
    const state = (connection.state ?? {}) as WsConnectionState;
    const rebound = state.sessionLifecycle === "owner" && state.sessionId && state.sessionId !== sessionId;
    connection.setState({
      ...state,
      sessionId,
      sessionLifecycle: "owner",
      terminalOwnerActive: rebound ? false : state.terminalOwnerActive,
      ...(rebound
        ? {
            terminalControllerConnectionId: undefined,
            terminalControllerClientId: undefined,
            terminalOperationProtocol: undefined,
          }
        : {}),
    } as WsConnectionState);

    // A heartbeat is not an ownership election. It claims only when the
    // session currently has no open active owner.
    this.claimSessionOwnerIfVacant(connection, sessionId);
    if (rebound && state.terminalOwnerActive && state.sessionId) {
      this.promoteStandbyOwner(state.sessionId, connection.id);
    }

    Q.reviveSession(this.db, sessionId);
    const session = Q.getSession(this.db, sessionId);
    if (session) {
      this.broadcastGlobal({ type: "session-updated", session });
    }
    this.flushPendingTerminalDeliveries(sessionId);
  }

  private handleSessionEnd(sessionId: string): void {
    Q.markSessionEnded(this.db, sessionId);
    this.broadcastGlobal({ type: "session-deleted", sessionId });
    this.closeScopedSessionConnections(sessionId, "Session ended");
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
    const normalizedMachineId = machineId.trim();
    const state = connection.state as WsConnectionState | undefined;
    if (!normalizedMachineId || (state?.machineId && state.machineId !== normalizedMachineId)) {
      this.send(connection, {
        type: "error",
        message: "Machine identity cannot change on an existing connection.",
      });
      return;
    }
    const machineBeforeHeartbeat = Q.getMachine(this.db, normalizedMachineId);
    const newlyBoundConnection = state?.machineId !== normalizedMachineId;
    const reactivatedMachine = machineBeforeHeartbeat?.active !== 1;
    Q.markMachineAlive(this.db, normalizedMachineId);
    connection.setState({
      ...state,
      machineId: normalizedMachineId,
      role: "cli",
      ...(!state?.machineId
        ? {
            machineServiceKeys: [],
            runnerCommandProtocol: undefined,
            codexRuntimeAuthProtocol: undefined,
            reviewerIsolationProtocol: undefined,
            hostAdvertisementAt: undefined,
            hostDemoted: false,
          }
        : {}),
    } as WsConnectionState);
    const machine = Q.getMachine(this.db, normalizedMachineId);

    if (machine && (newlyBoundConnection || reactivatedMachine)) {
      this.broadcastGlobal({ type: "machine-updated", machine });
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

  private demoteHostAdvertisement(connection: Connection): void {
    const state = connection.state as WsConnectionState | undefined;
    connection.setState({
      ...state,
      machineServiceKeys: (state?.machineServiceKeys ?? [])
        .filter((key) => key !== "host"),
      runnerCommandProtocol: undefined,
      codexRuntimeAuthProtocol: undefined,
      reviewerIsolationProtocol: undefined,
      hostAdvertisementAt: undefined,
      hostDemoted: true,
    } as WsConnectionState);
  }

  private handleMachineUpdateRunnerState(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "machine-update-runner-state" }>,
  ): void {
    const state = connection.state as WsConnectionState | undefined;
    const machineId = data.machineId.trim();
    if (!machineId || state?.machineId?.trim() !== machineId) {
      this.send(connection, {
        type: "error",
        message: "Host advertisement requires machine-alive identity binding.",
      });
      return;
    }
    if (!isMachineUuid(machineId)) {
      this.send(connection, {
        type: "error",
        message: "Host machine identity must be a generated UUID.",
      });
      return;
    }
    const serviceKeys = getMachineServiceKeys(data.runnerState);
    const liveHost = parseMachineServiceState(data.runnerState).host;
    if (
      liveHost
      && (
        !liveHost.machineId.trim()
        || liveHost.machineId.trim() !== machineId
      )
    ) {
      this.send(connection, {
        type: "error",
        message: "Host advertisement machine identity did not match this connection.",
      });
      return;
    }
    const liveRunnerCommandProtocol = liveHost?.runnerCommandProtocol;
    const liveCodexRuntimeAuthProtocol = liveHost?.codexRuntimeAuthProtocol;
    const liveReviewerIsolationProtocol = liveHost?.reviewerIsolationProtocol;
    const healthyAdvertisement = Boolean(
      liveHost?.dockerAvailable
      && liveHost.runnerAvailable,
    );
    const competingConnections = serviceKeys.length > 0 && healthyAdvertisement
      ? this.getHealthyRunnerConnections()
          .filter(({ connection: candidate, machineId: candidateMachineId }) =>
            candidate.id !== connection.id && candidateMachineId !== machineId)
      : [];
    const selectedMachineId = this.readSelectedHostMachineId();
    const selectedTakeover = competingConnections.length > 0
      && selectedMachineId === machineId;
    if (competingConnections.length > 0 && !selectedTakeover) {
      const competing = competingConnections[0]!;
      connection.setState({
        ...state,
        machineId,
        role: "cli",
        machineServiceKeys: [],
        runnerCommandProtocol: undefined,
        codexRuntimeAuthProtocol: undefined,
        reviewerIsolationProtocol: undefined,
        hostAdvertisementAt: undefined,
        hostDemoted: false,
      } as WsConnectionState);
      this.send(connection, {
        type: "error",
        message: `Another execution machine is already connected (${competing.machineId}).`,
      });
      return;
    }

    const result = Q.updateMachineRunnerState(
      this.db,
      machineId,
      data.runnerState,
      data.expectedVersion,
    );
    if (!result.ok) {
      this.handleVersionedMachineResult(connection, result, machineId);
      return;
    }

    if (serviceKeys.length > 0 && healthyAdvertisement) {
      const advertisedAt = Date.now();
      if (selectedTakeover) {
        for (const { connection: candidate } of competingConnections) {
          this.demoteHostAdvertisement(candidate);
          this.send(candidate, {
            type: "error",
            message: `The selected execution machine connected (${machineId}); this machine is now on standby.`,
          });
        }
      }
      // The newest healthy advertisement for a repeated UUID becomes active.
      for (const candidate of this.getConnections()) {
        if (candidate.id === connection.id) continue;
        const candidateState = candidate.state as WsConnectionState | undefined;
        if (candidateState?.machineId !== machineId) continue;
        this.demoteHostAdvertisement(candidate);
      }
      connection.setState({
        ...state,
        machineId,
        role: "cli",
        machineServiceKeys: [...new Set([...(state?.machineServiceKeys ?? []), ...serviceKeys])],
        runnerCommandProtocol: liveRunnerCommandProtocol,
        codexRuntimeAuthProtocol: liveCodexRuntimeAuthProtocol,
        reviewerIsolationProtocol: liveReviewerIsolationProtocol,
        hostAdvertisementAt: advertisedAt,
        hostDemoted: false,
      } as WsConnectionState);
      void this.scheduleAlarmAt(advertisedAt + HOST_HEALTH_LEASE_MS);
    } else if (state?.machineId === machineId) {
      connection.setState({
        ...state,
        machineServiceKeys: (state.machineServiceKeys ?? []).filter((key) => key !== "host"),
        runnerCommandProtocol: undefined,
        codexRuntimeAuthProtocol: undefined,
        reviewerIsolationProtocol: undefined,
        hostAdvertisementAt: undefined,
        hostDemoted: false,
      } as WsConnectionState);
    }
    this.handleVersionedMachineResult(connection, result, machineId);
  }

  private handleRunnerControlResponse(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "runner-control-response" }>,
  ): void {
    const pending = this.pendingRunnerRequests.get(data.requestId);
    if (!pending || pending.connectionId !== connection.id) return;

    clearTimeout(pending.timer);
    this.pendingRunnerRequests.delete(data.requestId);

    if (data.ok) {
      pending.resolve(data.result);
      return;
    }

    pending.reject(new RunnerControlError(
      data.error || "Runner request failed",
      data.errorCode,
      data.currentCommandGeneration,
    ));
  }

  private stampTerminalAckRouteKey(
    connection: Connection,
    sessionId: string,
    clientId: string,
  ): void {
    const routeKey = `${sessionId}:${clientId}`;
    const state = (connection.state ?? {}) as WsConnectionState;
    // The dashboard has one global socket. Its first resize/input selects the
    // terminal whose live output should use that socket.
    const bindGlobalViewer =
      state.authorization?.kind === "global" &&
      (state.sessionId !== sessionId || state.sessionLifecycle !== "viewer");
    if (state.terminalAckRouteKey !== routeKey || bindGlobalViewer) {
      connection.setState({
        ...state,
        terminalAckRouteKey: routeKey,
        ...(bindGlobalViewer
          ? { sessionId, sessionLifecycle: "viewer" as const }
          : {}),
      } as WsConnectionState);
    }
  }

  private handleTerminalInput(
    connection: Connection,
    data: TerminalInputMessage,
  ): void {
    this.stampTerminalAckRouteKey(connection, data.sessionId, data.clientId);
    const terminalError = this.terminalMutationError(data.sessionId);
    if (terminalError) {
      this.sendTerminalDeliveryFailure(connection, data, terminalError);
      return;
    }
    if (
      typeof data.data !== "string" ||
      (data.deliveryId !== undefined && (
        typeof data.deliveryId !== "string"
        || !data.deliveryId.trim()
        || data.deliveryId.length > 256
      )) ||
      !this.areOptionalTerminalDimensionsValid(data.cols, data.rows)
    ) {
      this.sendTerminalDeliveryFailure(connection, data, "Invalid terminal input");
      return;
    }
    this.deliverTerminalMessageOrWaitForOwner(connection, data);
  }

  private handleTerminalControl(
    connection: Connection,
    data: TerminalControlMessage,
  ): void {
    this.stampTerminalAckRouteKey(connection, data.sessionId, data.clientId);
    const terminalError = this.terminalMutationError(data.sessionId);
    if (terminalError) {
      this.sendTerminalDeliveryFailure(connection, data, terminalError);
      return;
    }
    if (
      data.action === "resize" &&
      !this.areTerminalDimensionsValid(data.cols, data.rows)
    ) {
      this.sendTerminalDeliveryFailure(connection, data, "Invalid resize dimensions");
      return;
    }
    if (data.claim !== undefined && typeof data.claim !== "boolean") {
      this.sendTerminalDeliveryFailure(connection, data, "Invalid terminal control");
      return;
    }
    this.deliverTerminalMessageOrWaitForOwner(connection, data);
  }

  private handleTerminalDetach(connection: Connection, sessionId: string, clientId: string): void {
    if (this.terminalMutationError(sessionId)) return;
    this.clearPendingTerminalDeliveriesForClient(connection.id, sessionId, clientId);
    this.releaseTerminalController(connection.id, sessionId, clientId);
    const state = (connection.state ?? {}) as WsConnectionState;
    if (
      state.authorization?.kind === "global" &&
      state.sessionLifecycle === "viewer" &&
      state.sessionId === sessionId
    ) {
      connection.setState({
        ...state,
        sessionId: undefined,
        sessionLifecycle: undefined,
        terminalAckRouteKey: undefined,
      } as WsConnectionState);
    }
  }

  private terminalMutationError(sessionId: string): string | null {
    const session = Q.getSession(this.db, sessionId);
    if (!session) return sessionId.startsWith("plan-writer-") ? "Terminal session not found" : null;
    const scope = readTerminalScopeFromStoredSession(session);
    return scope?.kind === "plan-writer" && scope.revokedAt
      ? "Plan writer terminal is read-only"
      : null;
  }

  private terminalDeliveryKey(data: TerminalInputMessage | TerminalControlMessage): string {
    if (data.type === "terminal-input") {
      return `${data.sessionId}:${data.clientId}:input:${data.inputSeq}`;
    }
    return `${data.sessionId}:${data.clientId}:control:${data.controlSeq}`;
  }

  private terminalAckKey(
    data: TerminalInputMessage | TerminalControlMessage | TerminalInputAckMessage | TerminalControlAckMessage,
  ): string {
    if (data.type === "terminal-input" || data.type === "terminal-input-ack") {
      return `${data.sessionId}:${data.clientId}:input:${data.inputSeq}`;
    }
    return `${data.sessionId}:${data.clientId}:control:${data.controlSeq}`;
  }

  private rememberTerminalAckOwner(
    owner: Connection,
    data: TerminalInputMessage | TerminalControlMessage,
  ): void {
    const key = this.terminalAckKey(data);
    this.terminalAckOwnerRoutes.delete(key);
    this.terminalAckOwnerRoutes.set(key, owner.id);
    while (this.terminalAckOwnerRoutes.size > MAX_TERMINAL_ACK_OWNER_ROUTES) {
      const oldest = this.terminalAckOwnerRoutes.keys().next().value;
      if (oldest === undefined) break;
      this.terminalAckOwnerRoutes.delete(oldest);
    }
  }

  private deliverTerminalMessageOrWaitForOwner(
    sender: Connection,
    data: TerminalInputMessage | TerminalControlMessage,
  ): void {
    const terminalError = this.terminalMutationError(data.sessionId);
    if (terminalError) {
      this.sendTerminalDeliveryFailure(sender, data, terminalError);
      return;
    }
    const owner = this.getActiveSessionOwnerConnection(data.sessionId);
    if (owner) {
      if (!this.deliverTerminalMessage(owner, sender, data, false)) {
        this.sendTerminalDeliveryFailure(sender, data, TERMINAL_OWNER_UNAVAILABLE_ERROR);
      }
      return;
    }

    this.queuePendingTerminalDelivery(sender, data);
  }

  private queuePendingTerminalDelivery(
    sender: Connection,
    data: TerminalInputMessage | TerminalControlMessage,
  ): void {
    const key = this.terminalDeliveryKey(data);
    const existing = this.pendingTerminalDeliveries.get(key);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = setTimeout(() => {
      if (data.type === "terminal-control" && data.action === "resize") {
        // Resize/claim is advisory: later input carries the latest dimensions,
        // so an absent owner turns this expected reconnect race into a no-op.
        this.acknowledgePendingTerminalResize(key);
        return;
      }
      this.failPendingTerminalDelivery(key, TERMINAL_OWNER_UNAVAILABLE_ERROR);
    }, this.terminalOwnerGraceMs(data));
    this.pendingTerminalDeliveries.set(key, { sender, message: data, timer });
  }

  private terminalOwnerGraceMs(data: TerminalInputMessage | TerminalControlMessage): number {
    if (data.type !== "terminal-input") return TERMINAL_OWNER_GRACE_MS;
    const session = Q.getSession(this.db, data.sessionId);
    const scope = session ? readTerminalScopeFromStoredSession(session) : null;
    return scope?.kind === "plan-writer"
      ? PLAN_WRITER_TERMINAL_OWNER_GRACE_MS
      : TERMINAL_OWNER_GRACE_MS;
  }

  private failPendingTerminalDelivery(key: string, error: string): void {
    const pending = this.pendingTerminalDeliveries.get(key);
    if (!pending) return;
    this.pendingTerminalDeliveries.delete(key);
    clearTimeout(pending.timer);
    this.sendTerminalDeliveryFailure(pending.sender, pending.message, error);
  }

  private acknowledgePendingTerminalResize(key: string): void {
    const pending = this.pendingTerminalDeliveries.get(key);
    if (!pending || pending.message.type !== "terminal-control") return;
    this.pendingTerminalDeliveries.delete(key);
    clearTimeout(pending.timer);
    this.sendTerminalDeliverySuccess(pending.sender, pending.message);
  }

  private sendTerminalDeliveryFailure(
    connection: Connection,
    data: TerminalInputMessage | TerminalControlMessage,
    error: string,
  ): void {
    if (connection.readyState !== WebSocket.OPEN) return;
    try {
      if (data.type === "terminal-input") {
        this.send(connection, {
          type: "terminal-input-ack",
          sessionId: data.sessionId,
          clientId: data.clientId,
          inputSeq: data.inputSeq,
          ok: false,
          error,
        });
        return;
      }
      this.send(connection, {
        type: "terminal-control-ack",
        sessionId: data.sessionId,
        clientId: data.clientId,
        controlSeq: data.controlSeq,
        ok: false,
        error,
      });
    } catch {
      // The sender disconnected while this short in-memory grace window was open.
    }
  }

  private flushPendingTerminalDeliveries(sessionId: string): void {
    const terminalError = this.terminalMutationError(sessionId);
    if (terminalError) {
      for (const [key, pending] of this.pendingTerminalDeliveries) {
        if (pending.message.sessionId !== sessionId) continue;
        this.failPendingTerminalDelivery(key, terminalError);
      }
      return;
    }
    const owner = this.getActiveSessionOwnerConnection(sessionId);
    if (!owner) return;

    for (const [key, pending] of this.pendingTerminalDeliveries) {
      if (pending.message.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pendingTerminalDeliveries.delete(key);
      if (!this.deliverTerminalMessage(owner, pending.sender, pending.message, true)) {
        this.sendTerminalDeliveryFailure(
          pending.sender,
          pending.message,
          TERMINAL_OWNER_UNAVAILABLE_ERROR,
        );
      }
    }
  }

  private clearPendingTerminalDeliveriesForConnection(connectionId: string): void {
    for (const [key, pending] of this.pendingTerminalDeliveries) {
      if (pending.sender.id !== connectionId) continue;
      clearTimeout(pending.timer);
      this.pendingTerminalDeliveries.delete(key);
    }
  }

  private clearPendingTerminalDeliveriesForClient(
    connectionId: string,
    sessionId: string,
    clientId: string,
  ): void {
    for (const [key, pending] of this.pendingTerminalDeliveries) {
      if (
        pending.sender.id !== connectionId ||
        pending.message.sessionId !== sessionId ||
        pending.message.clientId !== clientId
      ) {
        continue;
      }
      clearTimeout(pending.timer);
      this.pendingTerminalDeliveries.delete(key);
    }
  }

  private areTerminalDimensionsValid(cols: unknown, rows: unknown): cols is number {
    return Number.isInteger(cols) && Number.isInteger(rows) &&
      (cols as number) >= 1 && (cols as number) <= 1000 &&
      (rows as number) >= 1 && (rows as number) <= 1000;
  }

  private areOptionalTerminalDimensionsValid(cols: unknown, rows: unknown): boolean {
    if (cols === undefined && rows === undefined) return true;
    return this.areTerminalDimensionsValid(cols, rows);
  }

  private deliverTerminalMessage(
    owner: Connection,
    sender: Connection,
    data: TerminalInputMessage | TerminalControlMessage,
    wasQueued: boolean,
  ): boolean {
    if (this.terminalMutationError(data.sessionId)) return false;
    const ownerState = (owner.state ?? {}) as WsConnectionState;
    if (ownerState.terminalOperationProtocol !== 1) {
      try {
        if (data.type === "terminal-input") {
          this.send(owner, {
            type: "terminal-input",
            sessionId: data.sessionId,
            clientId: data.clientId,
            inputSeq: data.inputSeq,
            data: data.data,
            ...(data.deliveryId ? { deliveryId: data.deliveryId } : {}),
            ...(data.cols !== undefined ? { cols: data.cols } : {}),
            ...(data.rows !== undefined ? { rows: data.rows } : {}),
          });
        } else {
          this.send(owner, data);
        }
        this.rememberTerminalAckOwner(owner, data);
        return true;
      } catch {
        return false;
      }
    }

    if (data.type === "terminal-control" && data.action === "resize") {
      const controllerMatches =
        ownerState.terminalControllerConnectionId === sender.id &&
        ownerState.terminalControllerClientId === data.clientId;
      const unowned = !ownerState.terminalControllerConnectionId;
      const mayControl =
        controllerMatches ||
        data.claim === true ||
        (data.claim === undefined && unowned);
      if (!mayControl) {
        this.sendTerminalDeliverySuccess(sender, data);
        return true;
      }

      try {
        this.send(owner, data);
      } catch {
        return false;
      }
      this.rememberTerminalAckOwner(owner, data);
      this.setTerminalController(owner, sender.id, data.clientId);
      return true;
    }

    if (data.type === "terminal-input") {
      const applyDimensions =
        data.data.length > 0 &&
        !wasQueued &&
        data.cols !== undefined &&
        data.rows !== undefined;
      try {
        this.send(owner, {
          type: "terminal-input",
          sessionId: data.sessionId,
          clientId: data.clientId,
          inputSeq: data.inputSeq,
          data: data.data,
          ...(data.deliveryId ? { deliveryId: data.deliveryId } : {}),
          ...(data.cols !== undefined ? { cols: data.cols } : {}),
          ...(data.rows !== undefined ? { rows: data.rows } : {}),
          applyDimensions,
        });
      } catch {
        return false;
      }
      this.rememberTerminalAckOwner(owner, data);
      if (data.data.length > 0) {
        this.setTerminalController(owner, sender.id, data.clientId);
      }
      return true;
    }

    try {
      this.send(owner, data);
      this.rememberTerminalAckOwner(owner, data);
      return true;
    } catch {
      return false;
    }
  }

  private sendTerminalDeliverySuccess(
    connection: Connection,
    data: TerminalControlMessage,
  ): void {
    if (connection.readyState !== WebSocket.OPEN) return;
    try {
      this.send(connection, {
        type: "terminal-control-ack",
        sessionId: data.sessionId,
        clientId: data.clientId,
        controlSeq: data.controlSeq,
        ok: true,
      });
    } catch {
      // Passive client disconnected before its no-op ACK.
    }
  }

  private setTerminalController(owner: Connection, connectionId: string, clientId: string): void {
    const state = (owner.state ?? {}) as WsConnectionState;
    if (
      state.terminalControllerConnectionId === connectionId &&
      state.terminalControllerClientId === clientId
    ) {
      return;
    }
    owner.setState({
      ...state,
      terminalControllerConnectionId: connectionId,
      terminalControllerClientId: clientId,
    } as WsConnectionState);
  }

  private releaseTerminalController(
    connectionId: string,
    sessionId?: string,
    clientId?: string,
  ): void {
    for (const candidate of this.getConnections()) {
      const state = candidate.state as WsConnectionState | undefined;
      if (state?.sessionLifecycle !== "owner") continue;
      if (sessionId && state.sessionId !== sessionId) continue;
      if (state.terminalControllerConnectionId !== connectionId) continue;
      if (clientId && state.terminalControllerClientId !== clientId) continue;
      candidate.setState({
        ...state,
        terminalControllerConnectionId: undefined,
        terminalControllerClientId: undefined,
      } as WsConnectionState);
    }
  }

  private activateSessionOwner(connection: Connection, sessionId: string): void {
    for (const candidate of this.getConnections()) {
      const state = candidate.state as WsConnectionState | undefined;
      if (
        state?.sessionId !== sessionId ||
        state.sessionLifecycle !== "owner"
      ) {
        continue;
      }
      const active = candidate.id === connection.id;
      candidate.setState({
        ...state,
        terminalOwnerActive: active,
        ...(!active
          ? {
              terminalControllerConnectionId: undefined,
              terminalControllerClientId: undefined,
            }
          : {}),
      } as WsConnectionState);
    }
  }

  private claimSessionOwnerIfVacant(connection: Connection, sessionId: string): boolean {
    const active = this.getActiveSessionOwnerConnection(sessionId);
    if (active && active.id !== connection.id) return false;
    this.activateSessionOwner(connection, sessionId);
    return true;
  }

  private promoteStandbyOwner(sessionId: string, excludedConnectionId: string): void {
    const candidates = [...this.getConnections()].filter((candidate) => {
      const state = candidate.state as WsConnectionState | undefined;
      return (
        candidate.id !== excludedConnectionId &&
        candidate.readyState === WebSocket.OPEN &&
        state?.sessionId === sessionId &&
        state.sessionLifecycle === "owner"
      );
    });
    const replacement = candidates.find((candidate) =>
      (candidate.state as WsConnectionState | undefined)?.terminalOperationProtocol === 1)
      ?? candidates[0];
    if (!replacement) return;
    this.activateSessionOwner(replacement, sessionId);
    this.flushPendingTerminalDeliveries(sessionId);
  }

  private handleTerminalInputAck(
    connection: Connection,
    data: TerminalInputAckMessage,
  ): void {
    this.relayTerminalAck(connection, data);
  }

  private handleTerminalControlAck(
    connection: Connection,
    data: TerminalControlAckMessage,
  ): void {
    this.relayTerminalAck(connection, data);
  }

  private relayTerminalAck(
    sender: Connection,
    data: TerminalInputAckMessage | TerminalControlAckMessage,
  ): void {
    // A handoff may demote the owner after it applied an operation but before
    // its ACK arrives. Authorize that bounded in-flight route exactly once.
    const ackKey = this.terminalAckKey(data);
    const deliveredOwnerId = this.terminalAckOwnerRoutes.get(ackKey);
    const authorized = deliveredOwnerId !== undefined
      ? deliveredOwnerId === sender.id
      : this.isActiveSessionOwnerConnection(sender, data.sessionId);
    if (!authorized) {
      return;
    }
    this.terminalAckOwnerRoutes.delete(ackKey);

    const routeKey = `${data.sessionId}:${data.clientId}`;
    for (const conn of this.getConnections()) {
      const state = conn.state as WsConnectionState | undefined;
      if (conn.readyState === WebSocket.OPEN && state?.terminalAckRouteKey === routeKey) {
        this.send(conn, data);
      }
    }
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
      this.broadcastGlobal({ type: "session-updated", session });
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
      this.broadcastGlobal({ type: "machine-updated", machine });
    }
  }

  // ── Reconnection ──────────────────────────────────────────────

  private async handleReconnect(
    connection: Connection,
    data: Extract<WsClientMessage, { type: "reconnect" }>,
  ): Promise<void> {
    const state = (connection.state ?? {}) as WsConnectionState;
    const sessionId = data.sessionId?.trim() || state.sessionId;
    const shouldRevive = data.revive !== false;
    if (sessionId) {
      const session = Q.getSession(this.db, sessionId);
      const scope = session ? readTerminalScopeFromStoredSession(session) : null;
      if ((!session && sessionId.startsWith("plan-writer-")) || (shouldRevive && scope?.kind === "plan-writer" && scope.revokedAt)) {
        this.send(connection, { type: "error", message: !session ? "Session not found" : "Plan writer terminal is read-only" });
        this.send(connection, { type: "replay", events: [], sessionId });
        return;
      }
    }
    const sessionLifecycle = shouldRevive ? "owner" : "viewer";
    const ownerRebound = state.sessionLifecycle === "owner" && (
      state.sessionId !== sessionId ||
      sessionLifecycle !== "owner" ||
      state.terminalOperationProtocol !== data.terminalOperationProtocol
    );

    if (sessionId && sessionLifecycle === "owner") {
      connection.setState({
        ...state,
        sessionId,
        sessionLifecycle,
        terminalOwnerActive: ownerRebound ? false : state.terminalOwnerActive,
        terminalOperationProtocol: data.terminalOperationProtocol === 1 ? 1 : undefined,
        ...(ownerRebound
          ? {
              terminalControllerConnectionId: undefined,
              terminalControllerClientId: undefined,
            }
          : {}),
      } as WsConnectionState);
      if (data.terminalOperationProtocol === 1) {
        // A capable explicit reconnect is the ownership election point.
        this.activateSessionOwner(connection, sessionId);
      } else {
        this.claimSessionOwnerIfVacant(connection, sessionId);
      }
      if (
        ownerRebound &&
        state.terminalOwnerActive &&
        state.sessionId &&
        state.sessionId !== sessionId
      ) {
        this.promoteStandbyOwner(state.sessionId, connection.id);
      }
    } else if (
      sessionId &&
      (state.sessionId !== sessionId || state.sessionLifecycle !== sessionLifecycle)
    ) {
      connection.setState({
        ...state,
        sessionId,
        sessionLifecycle,
        terminalOwnerActive: false,
        terminalOperationProtocol: undefined,
        terminalControllerConnectionId: undefined,
        terminalControllerClientId: undefined,
      } as WsConnectionState);
      if (state.terminalOwnerActive && state.sessionId) {
        this.promoteStandbyOwner(state.sessionId, connection.id);
      }
    }

    if (sessionId && shouldRevive) {
      Q.reviveSession(this.db, sessionId);
      const session = Q.getSession(this.db, sessionId);
      if (session) {
        this.broadcastGlobal({ type: "session-updated", session });
      }
      this.flushPendingTerminalDeliveries(sessionId);
    }

    if (!sessionId) {
      // No session context — just ack
      this.send(connection, { type: "replay", events: [] });
      return;
    }

    if (data.replay === false) {
      const registrationId = typeof data.registrationId === "string" && data.registrationId.length <= 128
        ? data.registrationId
        : undefined;
      if (!shouldRevive) {
        this.send(connection, {
          type: "replay",
          events: [],
          sessionId,
          ...(registrationId ? { registrationId } : {}),
        });
        return;
      }
      await this.serializeSessionAppend(sessionId, async () => {
        const baselineSeq = await this.getSessionCanonicalMaxSequence(sessionId);
        this.send(connection, {
          type: "replay",
          events: [],
          baselineSeq,
          sessionId,
          ...(registrationId ? { registrationId } : {}),
        });
      });
      return;
    }

    const registrationId = typeof data.registrationId === "string" && data.registrationId.length <= 128
      ? data.registrationId
      : undefined;
    await this.serializeSessionAppend(sessionId, async () => {
      const missed = await this.getSessionMessagesSince(sessionId, data.lastSeq);
      const events: WsServerMessage[] = missed.map((m) => ({
        type: "message-received" as const,
        id: m.id,
        sessionId: m.session_id,
        content: JSON.parse(m.content),
        seq: m.seq,
        localId: m.local_id ?? undefined,
      }));

      this.send(connection, {
        type: "replay",
        events,
        sessionId,
        ...(registrationId ? { registrationId } : {}),
      });
    });
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
      if (state?.sessionId && state.sessionLifecycle !== "viewer") {
        sessionIds.add(state.sessionId);
      }
    }

    return { hasConnections, machineIds, sessionIds };
  }

  private async scheduleAlarmAt(scheduledAt: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || scheduledAt < current) {
      await this.ctx.storage.setAlarm(scheduledAt);
    }
  }

  private async scheduleAlarm(): Promise<void> {
    await this.scheduleAlarmAt(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private markMachineInactive(machineId: string): void {
    const machine = Q.getMachine(this.db, machineId);
    if (!machine || machine.active !== 1) return;

    Q.setMachineActive(this.db, machineId, false);
    const updated = Q.getMachine(this.db, machineId);
    if (updated) {
      this.broadcastGlobal({ type: "machine-updated", machine: updated });
    }
  }

  // ── Connection cleanup ────────────────────────────────────────

  private cleanupConnection(connection: Connection): void {
    const state = connection.state as WsConnectionState | undefined;
    this.clearPendingTerminalDeliveriesForConnection(connection.id);
    this.releaseTerminalController(connection.id);
    if (state?.terminalOwnerActive && state.sessionId) {
      connection.setState({ ...state, terminalOwnerActive: false } as WsConnectionState);
      this.promoteStandbyOwner(state.sessionId, connection.id);
    }
  }

  broadcastEnvUpsert(env: EnvMeta): void {
    this.broadcastGlobal({ type: "env-upsert", env });
  }

  broadcastEnvRemove(slug: string): void {
    this.broadcastGlobal({ type: "env-remove", slug });
  }

  broadcastRepoUpsert(repo: RepoMeta): void {
    this.broadcastGlobal({ type: "repo-upsert", repo });
  }

  broadcastRepoRemove(repoId: string): void {
    this.broadcastGlobal({ type: "repo-remove", repoId });
  }

  broadcastPlanArtifactUpdated(repoId: string, planArtifactId: string): void {
    this.broadcastGlobal({ type: "plan-artifact-updated", repoId, planArtifactId });
  }

  broadcastPlanWriterState(repoId: string, planArtifactId: string): void {
    this.broadcastGlobal({ type: "plan-writer-state", repoId, planArtifactId });
  }

  broadcastRepoMainChange(
    repoId: string,
    repoUrl: string,
    previousMainCommit: string | null,
    currentMainCommit: string | null,
    sourceEnvSlug?: string | null,
  ): void {
    this.broadcastGlobal({
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
    this.broadcastGlobal({ type: "session-updated", session });
    return session;
  }

  ensurePlanWriterTerminal(
    id: string,
    tag: string,
    machineId: string | null,
    metadata: unknown,
    repoId: string,
    planArtifactId: string,
    generation: number,
  ):
    | { status: "ready"; session: StoredSession; created: boolean }
    | { status: "unavailable" } {
    const result = Q.ensurePlanWriterTerminal(
      this.db,
      id,
      tag,
      machineId,
      metadata,
      repoId,
      planArtifactId,
      generation,
    );
    if (result.status === "ready" && result.created) {
      this.broadcastGlobal({ type: "session-updated", session: result.session });
    }
    return result;
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

  getRoutableSessionIds(): string[] {
    const sessionIds = new Set<string>();
    for (const conn of this.getConnections()) {
      const state = conn.state as WsConnectionState | undefined;
      if (
        state?.sessionId &&
        this.isActiveSessionOwnerConnection(conn, state.sessionId)
      ) {
        const session = Q.getSession(this.db, state.sessionId);
        const scope = session ? readTerminalScopeFromStoredSession(session) : null;
        if (
          (!session && !state.sessionId.startsWith("plan-writer-"))
          || (session && !(scope?.kind === "plan-writer" && scope.revokedAt))
        ) {
          sessionIds.add(state.sessionId);
        }
      }
    }
    return [...sessionIds];
  }

  updateSessionMetadata(id: string, metadata: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionMetadata(this.db, id, metadata, expectedVersion);
  }

  revokePlanWriterTerminal(
    id: string,
    repoId: string,
    planArtifactId: string,
    generation: number,
  ): StoredSession | null {
    const session = Q.revokePlanWriterTerminal(this.db, id, repoId, planArtifactId, generation);
    if (!session) return null;
    const activeOwner = this.getActiveSessionOwnerConnection(id);
    for (const conn of this.getConnections()) {
      const state = conn.state as WsConnectionState | undefined;
      if (state?.sessionId !== id) continue;
      if (activeOwner?.id === conn.id) {
        // Revocation is already durable, so this direct best-effort interrupt
        // cannot re-enable input or race a replacement generation.
        this.send(conn, {
          type: "terminal-control",
          sessionId: id,
          clientId: `tiller-stop-${generation}`,
          controlSeq: generation,
          action: "abort",
        });
      }
      conn.setState({
        ...state,
        terminalControllerConnectionId: undefined,
        terminalControllerClientId: undefined,
      } as WsConnectionState);
    }
    this.flushPendingTerminalDeliveries(id);
    this.broadcastGlobal({ type: "session-updated", session });
    this.closeScopedSessionConnections(id, "Session revoked");
    return session;
  }

  updateSessionAgentState(id: string, agentState: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionAgentState(this.db, id, agentState, expectedVersion);
  }

  updateSessionTodos(id: string, todos: unknown, expectedVersion: number): VersionedUpdateResult {
    return Q.updateSessionTodos(this.db, id, todos, expectedVersion);
  }

  deleteSession(id: string): void {
    Q.deleteSession(this.db, id);
    this.broadcastGlobal({ type: "session-deleted", sessionId: id });
    this.closeScopedSessionConnections(id, "Session deleted");
  }

  setSessionActive(id: string, active: boolean): void {
    Q.setSessionActive(this.db, id, active);
    const session = Q.getSession(this.db, id);
    if (session) {
      this.broadcastGlobal({ type: "session-updated", session });
    }
  }

  getOrCreateMachine(id: string, metadata: unknown): StoredMachine {
    return Q.getOrCreateMachine(this.db, id, metadata);
  }

  getMachines(): StoredMachine[] {
    return Q.getMachines(this.db);
  }

  getMachineExecutionStatus(machineId: string): HostStatus {
    const normalizedMachineId = machineId.trim();
    if (!normalizedMachineId) return { state: "not_connected" };
    return hostStatusFromService(
      this.getRoutableHostService(normalizedMachineId),
    );
  }

  private readRegisteredHostService(machineId?: string | null): HostServiceRegistration | null {
    const preferredMachineId = machineId?.trim() || null;
    let selected: { service: HostServiceRegistration; connectedAtMs: number } | null = null;

    for (const machine of Q.getMachines(this.db)) {
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

  getHostService(machineId?: string | null): HostServiceRegistration | null {
    return this.readRegisteredHostService(machineId);
  }

  getRoutableHostService(preferredMachineId?: string | null): HostServiceRegistration | null {
    try {
      const machineId = this.resolveRunnerMachineId(preferredMachineId);
      const registered = this.readRegisteredHostService(machineId);
      const connection = this.getRunnerConnection(machineId);
      const live = connection?.state as WsConnectionState | undefined;
      if (!registered || !connection || !live) return null;
      return {
        ...registered,
        // A reconnect must advertise capabilities again. Durable runner state
        // identifies the registration but never proves live compatibility.
        runnerCommandProtocol: live.runnerCommandProtocol,
        codexRuntimeAuthProtocol: live.codexRuntimeAuthProtocol,
        reviewerIsolationProtocol: live.reviewerIsolationProtocol,
      };
    } catch {
      return null;
    }
  }

  isHostRoutable(preferredMachineId?: string | null): boolean {
    try {
      this.resolveRunnerMachineId(preferredMachineId);
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
      commandGeneration?: number;
      operationId?: string;
      desiredState?: RunnerCommandDesiredState;
    },
  ): Promise<{ machineId: string; result: unknown }> {
    const expectedDesiredState: RunnerCommandDesiredState | null = action === "create" || action === "start"
      ? "running"
      : action === "stop"
        ? "stopped"
        : action === "destroy"
          ? "absent"
          : null;
    if (expectedDesiredState !== null) {
      const operationId = options?.operationId?.trim();
      if (
        !Number.isSafeInteger(options?.commandGeneration)
        || (options?.commandGeneration ?? 0) <= 0
        || !operationId
        || options?.desiredState !== expectedDesiredState
      ) {
        throw new Error(
          `Your machine ${action} requires a positive command generation, operation ID, and ${expectedDesiredState} desired state.`,
        );
      }
    }
    const resolvedMachineId = this.resolveRunnerMachineId(machineId);
    const routableHost = expectedDesiredState !== null
      ? this.getRoutableHostService(resolvedMachineId)
      : null;
    if (
      expectedDesiredState !== null
      && routableHost?.runnerCommandProtocol !== 1
    ) {
      throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    }
    const codexLaunch = (action === "create" || action === "start")
      && options?.envVars?.TILLER_HARNESS === "codex"
      && !isLocalOnlyRunnerBackendMode(this.env);
    if (
      codexLaunch
      && (
        routableHost?.codexRuntimeAuthProtocol !== 1
        || !classifyHostRuntimeCompatibility(routableHost).compatible
      )
    ) {
      throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    }
    const result = await this.requestRunnerControl(resolvedMachineId, {
      action,
      slug,
      ...(options?.repoUrl ? { repoUrl: options.repoUrl } : {}),
      ...(options?.envVars ? { envVars: options.envVars } : {}),
      ...(options?.commandGeneration !== undefined ? { commandGeneration: options.commandGeneration } : {}),
      ...(options?.operationId ? { operationId: options.operationId.trim() } : {}),
      ...(options?.desiredState ? { desiredState: options.desiredState } : {}),
    });
    return {
      machineId: resolvedMachineId,
      result,
    };
  }

  async sendEnvReviewSnapshotRequest(
    sessionId: string,
    opId: string,
    envSlug: string,
    uploadToken: string,
    payload: {
      uploadUrl: string;
      snapshotMode: "github-overlay" | "full";
      maxBytes: number;
      excludePrefixes: string[];
    },
  ): Promise<{ sent: boolean; error?: string }> {
    const owner = this.getActiveSessionOwnerConnection(sessionId);
    if (!owner) {
      return { sent: false, error: "No active harness session is connected for review snapshot." };
    }
    this.send(owner, {
      type: "env-review-snapshot-request",
      sessionId,
      opId,
      envSlug,
      uploadUrl: payload.uploadUrl,
      uploadToken,
      snapshotMode: payload.snapshotMode,
      maxBytes: payload.maxBytes,
      excludePrefixes: payload.excludePrefixes,
    });
    return { sent: true };
  }

  async addMessage(
    id: string,
    sessionId: string,
    content: unknown,
    localId: string | null,
    excludeConnectionId?: string,
  ): Promise<{ message: StoredMessage; sessionSeq: number }> {
    const terminalOutput = Boolean(
      content &&
      typeof content === "object" &&
      (content as { type?: unknown }).type === "terminal-output",
    );
    return this.serializeSessionAppend(sessionId, async () => {
      if (!Q.getSession(this.db, sessionId)) {
        console.error("[HubDO] session append rejected", {
          sessionId: safeTerminalIdentifier(sessionId),
          messageId: safeTerminalIdentifier(id),
          code: "session_message_commit_failed",
        });
        throw new Error("session_message_commit_failed");
      }
      const thread = this.getSessionThreadStub(sessionId);
      if (!thread) {
        console.error("[HubDO] session append unavailable", {
          sessionId: safeTerminalIdentifier(sessionId),
          messageId: safeTerminalIdentifier(id),
        });
        throw new Error("session_message_commit_failed");
      }

      let appended;
      const contentBytes = terminalOutput && this.terminalMetricsEnabled
        ? new TextEncoder().encode(JSON.stringify(content)).byteLength
        : 0;
      const commitStartedAt = performance.now();
      try {
        appended = await thread.appendSessionMessage({
          id,
          sessionId,
          senderSessionId: sessionId,
          kind: "chat",
          body: content,
          ...(localId !== null ? { localId } : {}),
        });
      } catch (error) {
        const code = error instanceof Error && error.message === "session_message_conflict"
          ? "session_message_conflict"
          : "session_message_commit_failed";
        console.error("[HubDO] session append failed", {
          sessionId: safeTerminalIdentifier(sessionId),
          messageId: safeTerminalIdentifier(id),
          code,
        });
        throw new Error(code);
      } finally {
        if (terminalOutput && this.terminalMetricsEnabled) {
          this.terminalCommitRoundTripMetrics.record(
            performance.now() - commitStartedAt,
            contentBytes,
          );
        }
      }
      const commitCompletedAt = performance.now();

      const message = this.threadMessageToStoredMessage(sessionId, appended.message);
      const result = { message, sessionSeq: message.seq };

      // There is deliberately no Hub storage mutation between the ThreadDO
      // commit and this canonical broadcast.
      if (appended.newlyInserted) {
        const event: WsServerMessage = {
          type: "message-received",
          id: message.id,
          sessionId,
          content: JSON.parse(message.content),
          seq: message.seq,
          localId: message.local_id ?? undefined,
        };
        this.sendToSession(sessionId, event, excludeConnectionId);
        if (terminalOutput && this.terminalMetricsEnabled) {
          this.terminalBroadcastMetrics.record(
            performance.now() - commitCompletedAt,
            new TextEncoder().encode(JSON.stringify(event)).byteLength,
          );
        }
      }

      return result;
    }, terminalOutput);
  }

  private serializeSessionAppend<T>(
    sessionId: string,
    operation: () => Promise<T>,
    recordTerminalQueueWait = false,
  ): Promise<T> {
    const enqueuedAt = performance.now();
    const previous = this.sessionAppendTails.get(sessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(() => {
      if (recordTerminalQueueWait) {
        this.terminalAppendQueueMetrics.record(performance.now() - enqueuedAt);
      }
      return operation();
    });
    const tail = result.then(() => undefined, () => undefined);
    this.sessionAppendTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionAppendTails.get(sessionId) === tail) {
        this.sessionAppendTails.delete(sessionId);
      }
    });
    return result;
  }

  async getMessages(
    sessionId: string,
    opts: { limit?: number; beforeSeq?: number; afterSeq?: number },
  ): Promise<StoredMessage[]> {
    return this.readSessionMessages(sessionId, opts);
  }

  /** Read-only maintenance report used by the full legacy rollback runbook. */
  async getSessionSequenceReconciliation(): Promise<Array<{
    sessionId: string;
    deprecatedStoredSeq: number;
    canonicalThreadSeq: number;
    authority: "external-v0" | "thread-v1";
  }>> {
    const sessions = Q.getAllSessions(this.db);
    const report = [];
    for (const session of sessions) {
      const thread = this.getSessionThreadStub(session.id);
      report.push({
        sessionId: session.id,
        deprecatedStoredSeq: session.seq,
        canonicalThreadSeq: thread ? await thread.getCanonicalMaxSequence() : 0,
        authority: thread ? await thread.getSequenceAuthority() : "external-v0",
      });
    }
    return report;
  }

  private getSessionThreadId(sessionId: string): string {
    return `${SESSION_THREAD_PREFIX}${sessionId}`;
  }

  private getSessionThreadStub(sessionId: string): ThreadDO | null {
    if (!this.env.THREAD) return null;
    return getDurableObjectStub<ThreadDO>(
      this.env,
      this.env.THREAD,
      this.getSessionThreadId(sessionId),
    );
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

  private async getSessionCanonicalMaxSequence(sessionId: string): Promise<number> {
    const thread = this.getSessionThreadStub(sessionId);
    return thread ? await thread.getCanonicalMaxSequence() : 0;
  }

  private getActiveSessionOwnerConnection(sessionId: string): Connection | null {
    for (const conn of this.getConnections()) {
      if (this.isActiveSessionOwnerConnection(conn, sessionId)) return conn;
    }
    return null;
  }

  private isActiveSessionOwnerConnection(connection: Connection, sessionId: string): boolean {
    const state = connection.state as WsConnectionState | undefined;
    return (
      connection.readyState === WebSocket.OPEN &&
      state?.sessionId === sessionId &&
      state.sessionLifecycle === "owner" &&
      state.terminalOwnerActive === true
    );
  }

  private resolveRunnerMachineId(
    preferredMachineId?: string | null,
  ): string {
    const preferred = preferredMachineId?.trim();
    if (preferred) {
      if (this.getRunnerConnection(preferred)) return preferred;
      throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    }

    const connection = this.getRunnerConnection();
    const activeMachineId = (connection?.state as WsConnectionState | undefined)?.machineId?.trim();
    if (activeMachineId) {
      return activeMachineId;
    }

    throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
  }

  private requestRunnerControl(
    machineId: string,
    request: {
      action: RunnerControlAction;
      slug: string;
      repoUrl?: string;
      envVars?: Record<string, string>;
      commandGeneration?: number;
      operationId?: string;
      desiredState?: RunnerCommandDesiredState;
    },
    timeoutMs = RUNNER_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    const connection = this.getRunnerConnection(machineId);
    if (!connection) {
      throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    }
    const connectionState = connection.state as WsConnectionState | undefined;
    if (request.action !== "status" && connectionState?.runnerCommandProtocol !== 1) {
      throw new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE);
    }

    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRunnerRequests.delete(requestId);
        reject(Object.assign(new Error(EXISTING_EXECUTION_UNAVAILABLE_MESSAGE), {
          cause: new Error("Timed out waiting for the execution machine."),
        }));
      }, timeoutMs);

      this.pendingRunnerRequests.set(requestId, {
        connectionId: connection.id,
        resolve,
        reject,
        timer,
      });
      const message = {
        type: "runner-control-request",
        requestId,
        action: request.action,
        slug: request.slug,
        ...(request.repoUrl ? { repoUrl: request.repoUrl } : {}),
        ...(request.envVars ? { envVars: request.envVars } : {}),
        ...(request.commandGeneration !== undefined ? { commandGeneration: request.commandGeneration } : {}),
        ...(request.operationId ? { operationId: request.operationId } : {}),
        ...(request.desiredState ? { desiredState: request.desiredState } : {}),
      } as RunnerControlRequestMessage;
      this.send(connection, message);
    });
  }

  private getRunnerConnection(machineId?: string | null): Connection | null {
    const preferredMachineId = machineId?.trim() || null;
    const candidates = this.getHealthyRunnerConnections()
      .filter(({ machineId: candidateMachineId }) =>
        !preferredMachineId || candidateMachineId === preferredMachineId)
      .sort((left, right) => right.advertisedAt - left.advertisedAt);
    return candidates[0]?.connection ?? null;
  }

  private getHealthyRunnerConnections(): Array<{
    connection: Connection;
    machineId: string;
    advertisedAt: number;
  }> {
    const now = Date.now();
    const result: Array<{
      connection: Connection;
      machineId: string;
      advertisedAt: number;
    }> = [];
    for (const connection of this.getConnections()) {
      const state = connection.state as WsConnectionState | undefined;
      const advertisedAt = state?.hostAdvertisementAt;
      if (
        connection.readyState !== WebSocket.OPEN
        || state?.role !== "cli"
        || !state.machineId?.trim()
        || !(state.machineServiceKeys ?? []).includes("host")
        || typeof advertisedAt !== "number"
        || advertisedAt + HOST_HEALTH_LEASE_MS <= now
      ) {
        continue;
      }
      result.push({
        connection,
        machineId: state.machineId.trim(),
        advertisedAt,
      });
    }
    return result;
  }

  // ── Permission RPC methods ──────────────────────────────────────

  createPermission(
    id: string,
    sessionId: string,
    toolName: string,
    toolInput: unknown,
  ): StoredPermission {
    const permission = Q.createPermission(this.db, id, sessionId, toolName, toolInput);
    this.broadcastGlobal({ type: "permission-created", permission });
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
    this.broadcastGlobal({ type: "permission-resolved", permission });

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

  /**
   * One-way clean-slate configuration migration. It records the identifiers
   * an operator may need for later manual cleanup before clearing the legacy
   * custom-domain and deployment-mode state. It never calls Cloudflare.
  */
  async ensureExecutionConfiguration(): Promise<ExecutionSelection> {
    const trust = await readCanonicalWorkersDevAccessTrust(this.env);
    const localOnly = isLocalOnlyRunnerBackendMode(this.env);
    if (
      !localOnly
      && (
        !trust
        || !trust.workersDevHostname.endsWith(".workers.dev")
      )
    ) {
      throw new Error("Canonical workers.dev Access trust is required.");
    }

    const migrationPending =
      readOptionalConfigValue(this.db, EXECUTION_MIGRATION_KEY) !== "1";
    const existingSelection = parseExecutionSelection(
      readOptionalConfigValue(this.db, EXECUTION_SELECTION_KEY),
    );
    if (!migrationPending && !existingSelection) {
      throw new Error("Persisted execution backend selection is invalid.");
    }
    if (migrationPending && !localOnly) {
      const cleanSlate = await inspectPredeployCleanSlate(this.env, {
        sessions: Q.getAllSessions(this.db),
        routableSessionIds: this.getRoutableSessionIds(),
      });
      if (!cleanSlate.ok) {
        throw new Error(
          `Clean-slate deployment is required before execution configuration migration (${cleanSlate.blockers.length} workload blocker${cleanSlate.blockers.length === 1 ? "" : "s"} remain).`,
        );
      }
    }

    return this.ctx.storage.transactionSync(() => {
      const migrated = readOptionalConfigValue(this.db, EXECUTION_MIGRATION_KEY) === "1";
      const currentSelection = parseExecutionSelection(
        readOptionalConfigValue(this.db, EXECUTION_SELECTION_KEY),
      );
      if (migrated) {
        if (!currentSelection) {
          throw new Error("Persisted execution backend selection is invalid.");
        }
        return currentSelection;
      }

      const existingManifestRaw = readOptionalConfigValue(
        this.db,
        LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY,
      );
      const legacyStateRaw = readOptionalConfigValue(
        this.db,
        LEGACY_CUSTOM_DOMAIN_STATE_KEY,
      );
      if (existingManifestRaw) {
        if (!parseLegacyCustomDomainCleanupManifest(existingManifestRaw)) {
          throw new Error(
            "Legacy custom-domain cleanup manifest is invalid; migration stopped before clearing legacy state.",
          );
        }
      } else if (legacyStateRaw) {
        const manifest = legacyCleanupManifest(legacyStateRaw);
        if (!manifest) {
          throw new Error(
            "Legacy custom-domain state is unreadable; migration stopped before clearing cleanup identifiers.",
          );
        }
        this.setConfig(
          LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY,
          JSON.stringify(manifest),
        );
      }

      for (const key of [
        "TILLER_DEPLOYMENT_MODE",
        "HUB_PUBLIC_URL",
        "WORKER_SERVICE_NAME",
        "CF_ACCESS_CONFIGURED",
        "CF_ACCESS_AUD",
        "CF_ACCESS_TEAM_DOMAIN",
        "CF_ACCESS_JWKS_URL",
        "CF_ACCESS_CLIENT_ID",
        "CF_ACCESS_CLIENT_SECRET",
        LEGACY_CUSTOM_DOMAIN_STATE_KEY,
        LEGACY_CUSTOM_DOMAIN_SETUP_SESSION_KEY,
      ]) {
        this.db.exec("DELETE FROM config WHERE key = ?", key);
      }
      // Hostname-derived machine registrations belong to the retired format.
      this.db.exec("DELETE FROM machines");
      this.setConfig(EXECUTION_MIGRATION_KEY, "1");

      const selection = currentSelection ?? { target: "cf" as const };
      this.setConfig(EXECUTION_SELECTION_KEY, JSON.stringify(selection));
      return selection;
    });
  }

  private readExecutionSelection(): ExecutionSelection {
    const selection = parseExecutionSelection(
      readOptionalConfigValue(this.db, EXECUTION_SELECTION_KEY),
    );
    if (!selection) {
      throw new Error("Persisted execution backend selection is invalid.");
    }
    return selection;
  }

  private readSelectedHostMachineId(): string | null {
    const selection = parseExecutionSelection(
      readOptionalConfigValue(this.db, EXECUTION_SELECTION_KEY),
    );
    return selection?.target === "host" ? selection.machineId : null;
  }

  private readExecutionStatusNow(): ExecutionStatus {
    const selected = this.readExecutionSelection();
    const candidate = hostStatusFromService(this.getRoutableHostService());
    const selectedRegistration = selected.target === "host"
      ? this.readRegisteredHostService(selected.machineId)
      : null;
    return deriveExecutionStatus({
      selected,
      candidate,
      selectedDisplayName: selectedRegistration?.displayName ?? null,
    });
  }

  async getExecutionStatus(): Promise<ExecutionStatus> {
    await this.ensureExecutionConfiguration();
    return this.readExecutionStatusNow();
  }

  async setExecutionBackend(
    request: SetExecutionBackendRequest,
  ): Promise<SetExecutionBackendResult> {
    await this.ensureExecutionConfiguration();
    if (request.target === "cf") {
      this.ctx.storage.transactionSync(() => {
        this.setConfig(
          EXECUTION_SELECTION_KEY,
          JSON.stringify({ target: "cf" } satisfies ExecutionSelection),
        );
      });
      return { ok: true, status: this.readExecutionStatusNow() };
    }

    const current = this.readExecutionSelection();
    if (
      current.target === "host"
      && current.machineId === request.expectedMachineId
    ) {
      return { ok: true, status: this.readExecutionStatusNow() };
    }

    // There are deliberately no awaits between this precondition read and the
    // synchronous write. Durable Object event serialization makes the
    // expectedMachineId check and selection update one linearizable choice.
    const before = this.readExecutionStatusNow();
    if (
      before.candidate.state !== "ready"
      || before.candidate.machineId !== request.expectedMachineId
    ) {
      return executionSelectionConflict(before);
    }
    this.ctx.storage.transactionSync(() => {
      this.setConfig(
        EXECUTION_SELECTION_KEY,
        JSON.stringify({
          target: "host",
          machineId: request.expectedMachineId,
        } satisfies ExecutionSelection),
      );
    });
    return { ok: true, status: this.readExecutionStatusNow() };
  }

  async resolveNewExecutionPlacement(): Promise<ExecutionPlacement> {
    const status = await this.getExecutionStatus();
    if (!status.executionReady) {
      throw new Error(NEW_EXECUTION_UNAVAILABLE_MESSAGE);
    }
    return selectionToPlacement(status.selected);
  }

  async getLegacyCustomDomainCleanupManifest():
  Promise<LegacyCustomDomainCleanupManifestV1 | null> {
    await this.ensureExecutionConfiguration();
    const raw = readOptionalConfigValue(
      this.db,
      LEGACY_CUSTOM_DOMAIN_CLEANUP_KEY,
    );
    if (!raw) return null;
    return parseLegacyCustomDomainCleanupManifest(raw);
  }

  getAllConfig(): Record<string, string> {
    const rows = this.db
      .exec("SELECT key, value FROM config")
      .toArray() as { key: string; value: string }[];
    const result: Record<string, string> = {};
    for (const row of rows) result[row.key] = row.value;
    return result;
  }

  /** Fresh, non-secret billing policy read for launch and availability paths. */
  getBillingSelections(): BillingSelections {
    return normalizeBillingSelections({
      claudeBillingMode: readOptionalConfigValue(this.db, "claudeBillingMode"),
      openaiBillingMode: readOptionalConfigValue(this.db, "openaiBillingMode"),
    });
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

  getOrCreateConfig(key: string, value: string): string {
    const existingValue = readOptionalConfigValue(this.db, key);
    if (existingValue) {
      return existingValue;
    }

    this.setConfig(key, value);
    return value;
  }

  deleteConfig(key: string): void {
    this.db.exec("DELETE FROM config WHERE key = ?", key);
  }

  // ── Repo session env RPC methods ───────────────────────────────

  private async getOrCreateRepoSessionEnvDataKey(): Promise<string> {
    return this.ctx.storage.transaction(async (txn) => {
      const existing = await txn.get<string>(REPO_SESSION_ENV_DATA_KEY);
      if (existing) return existing;

      const created = createDataKey();
      await txn.put(REPO_SESSION_ENV_DATA_KEY, created);
      return created;
    });
  }

  private async getRepoSessionEnvDataKey(): Promise<string | null> {
    const value = await this.ctx.storage.get<string>(REPO_SESSION_ENV_DATA_KEY);
    return value ?? null;
  }

  private async encryptRepoSessionEnvValue(args: {
    key: CryptoKey;
    repoId: string;
    name: string;
    value: string;
  }): Promise<{ encryptedValue: string; nonce: string }> {
    const nonce = new Uint8Array(12);
    crypto.getRandomValues(nonce);
    const aad = new TextEncoder().encode(`${args.repoId}\0${args.name}`);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      args.key,
      new TextEncoder().encode(args.value),
    );
    return {
      encryptedValue: bytesToBase64(new Uint8Array(encrypted)),
      nonce: bytesToBase64(nonce),
    };
  }

  private async decryptRepoSessionEnvValue(args: {
    key: CryptoKey;
    repoId: string;
    name: string;
    encryptedValue: string;
    nonce: string;
  }): Promise<string> {
    const aad = new TextEncoder().encode(`${args.repoId}\0${args.name}`);
    const decrypted = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: bytesToArrayBuffer(base64ToBytes(args.nonce)),
        additionalData: aad,
      },
      args.key,
      bytesToArrayBuffer(base64ToBytes(args.encryptedValue)),
    );
    return new TextDecoder().decode(decrypted);
  }

  private async readRepoSessionEnvValues(repoId: string): Promise<Record<string, string>> {
    const rows = Q.listRepoSessionEnvRows(this.db, repoId);
    if (rows.length === 0) return {};

    const rawKey = await this.getRepoSessionEnvDataKey();
    if (!rawKey) {
      throw new Error("Repo session env data key is missing.");
    }
    const key = await importAesKey(rawKey);
    const values: Record<string, string> = {};
    for (const row of rows) {
      values[row.name] = await this.decryptRepoSessionEnvValue({
        key,
        repoId: row.repo_id,
        name: row.name,
        encryptedValue: row.encrypted_value,
        nonce: row.nonce,
      });
    }
    return values;
  }

  private async withRepoSessionEnvPatchLock<T>(repoId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.repoSessionEnvPatchQueues.get(repoId) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.repoSessionEnvPatchQueues.set(repoId, next);

    await previous.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.repoSessionEnvPatchQueues.get(repoId) === next) {
        this.repoSessionEnvPatchQueues.delete(repoId);
      }
    }
  }

  listRepoSessionEnv(repoId: string): RepoSessionEnvMetadata[] {
    return Q.listRepoSessionEnvRows(this.db, repoId).map((row) => ({
      name: row.name,
      updatedAt: row.updated_at,
    }));
  }

  async patchRepoSessionEnv(repoId: string, input: RepoSessionEnvPatch): Promise<RepoSessionEnvMetadata[]> {
    return this.withRepoSessionEnvPatchLock(repoId, async () => {
      const patch = normalizeSessionEnvPatch(input);
      const existing = await this.readRepoSessionEnvValues(repoId);
      applySessionEnvPatch(existing, patch);

      const setEntries = Object.entries(patch.set ?? {});
      const encryptedEntries: Array<{ name: string; encryptedValue: string; nonce: string }> = [];
      if (setEntries.length > 0) {
        const key = await importAesKey(await this.getOrCreateRepoSessionEnvDataKey());
        for (const [name, value] of setEntries) {
          const encrypted = await this.encryptRepoSessionEnvValue({
            key,
            repoId,
            name,
            value,
          });
          encryptedEntries.push({
            name,
            encryptedValue: encrypted.encryptedValue,
            nonce: encrypted.nonce,
          });
        }
      }
      this.ctx.storage.transactionSync(() => {
        Q.deleteRepoSessionEnvNames(this.db, repoId, patch.delete ?? []);
        for (const encrypted of encryptedEntries) {
          Q.upsertRepoSessionEnvRow(this.db, {
            repo_id: repoId,
            name: encrypted.name,
            encrypted_value: encrypted.encryptedValue,
            nonce: encrypted.nonce,
          });
        }
      });
      return this.listRepoSessionEnv(repoId);
    });
  }

  async resolveRepoSessionEnvVars(repoId: string): Promise<Record<string, string>> {
    return this.readRepoSessionEnvValues(repoId);
  }

  deleteRepoSessionEnv(repoId: string): void {
    Q.deleteRepoSessionEnv(this.db, repoId);
  }

  // ── Repo MCP server RPC methods ───────────────────────────────

  listRepoMcpServers(repoId: string): RepoMcpServer[] {
    return Q.listRepoMcpServerRows(this.db, repoId).map((row) => ({
      id: row.id,
      label: row.label,
      url: row.url,
      enabled: row.enabled === 1,
    }));
  }

  putRepoMcpServers(repoId: string, input: unknown): RepoMcpServersPutResult {
    try {
      const existing = this.listRepoMcpServers(repoId);
      const servers = normalizeRepoMcpServersRequest(input, {
        existingIds: existing.map((server) => server.id),
      });
      this.ctx.storage.transactionSync(() => {
        Q.replaceRepoMcpServerRows(
          this.db,
          repoId,
          servers.map((server) => ({
            id: server.id,
            label: server.label,
            url: server.url,
            enabled: server.enabled ? 1 : 0,
          })),
        );
      });
      return { ok: true, servers: this.listRepoMcpServers(repoId) };
    } catch (error) {
      if (error instanceof McpServersValidationError) {
        return { ok: false, error: error.message };
      }
      throw error;
    }
  }

  listEnabledRepoMcpServers(repoId: string): RepoMcpServer[] {
    return this.listRepoMcpServers(repoId).filter((server) => server.enabled);
  }

  deleteRepoMcpServers(repoId: string): void {
    Q.deleteRepoMcpServers(this.db, repoId);
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
        this.broadcastGlobal({ type: "session-deleted", sessionId: id });
        this.closeScopedSessionConnections(id, "Session expired");
      }
    }

    // Hard-delete sessions whose ended_at is older than 24 hours
    this.db.exec("DELETE FROM sessions WHERE ended_at < datetime('now', '-24 hours')");

    const activeMachineCount =
      (this.db.exec("SELECT COUNT(*) AS count FROM machines WHERE active = 1").toArray()[0] as { count: number } | undefined)
        ?.count ?? 0;

    // Reschedule while there are live connections or active machines still eligible for a future grace-period cleanup.
    const nextHeartbeat = live.hasConnections || activeMachineCount > 0
      ? Date.now() + HEARTBEAT_INTERVAL_MS
      : null;
    if (nextHeartbeat !== null) {
      await this.ctx.storage.setAlarm(nextHeartbeat);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  private send(connection: Connection, message: WsServerMessage): void {
    connection.send(JSON.stringify(message));
  }

  private broadcastGlobal(message: WsServerMessage, excludeId?: string): void {
    const payload = JSON.stringify(message);
    for (const conn of this.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      const authorization = (conn.state as WsConnectionState | undefined)?.authorization;
      if (authorization?.kind !== "global") continue;
      try { conn.send(payload); } catch { /* connection closing */ }
    }
  }

  private sendToSession(sessionId: string, message: WsServerMessage, excludeId?: string): void {
    const payload = JSON.stringify(message);
    for (const conn of this.getConnections()) {
      if (excludeId && conn.id === excludeId) continue;
      const state = conn.state as WsConnectionState | undefined;
      if (state?.sessionId !== sessionId) continue;
      try { conn.send(payload); } catch { /* connection closing */ }
    }
  }

  private closeScopedSessionConnections(sessionId: string, reason: string): void {
    for (const conn of this.getConnections()) {
      const state = conn.state as WsConnectionState | undefined;
      const authorization = state?.authorization;
      if (
        state?.sessionId === sessionId
        && (authorization?.kind === "environment" || authorization?.kind === "planWriter")
      ) {
        try { conn.close(4003, reason); } catch { /* connection already closing */ }
      }
    }
  }
}
