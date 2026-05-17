import { rpcError } from "./errors";
import { mergeMachineServiceState, parseMachineServiceState } from "./machine-service-state";
import { isManagedSessionMetadataUpdateValid } from "./session-attachment";
import type {
  MachineServiceState,
  StoredSession,
  StoredMachine,
  StoredPermission,
  VersionedUpdateResult,
} from "./types";

// ── Sessions ────────────────────────────────────────────────────────

export function createSession(
  sql: SqlStorage,
  id: string,
  tag: string,
  machineId: string | null,
  metadata: unknown,
): StoredSession {
  sql.exec(
    `INSERT INTO sessions (id, tag, machine_id, metadata) VALUES (?, ?, ?, ?)`,
    id,
    tag,
    machineId,
    JSON.stringify(metadata ?? {}),
  );
  return sql.exec("SELECT * FROM sessions WHERE id = ?", id)
    .toArray()[0] as unknown as StoredSession;
}

export function getSession(sql: SqlStorage, id: string): StoredSession | null {
  const rows = sql.exec("SELECT * FROM sessions WHERE id = ?", id).toArray();
  return (rows[0] as unknown as StoredSession) ?? null;
}

export function getSessions(sql: SqlStorage): StoredSession[] {
  return sql
    .exec("SELECT * FROM sessions WHERE active = 1 ORDER BY updated_at DESC")
    .toArray() as unknown as StoredSession[];
}

export function getAllSessions(sql: SqlStorage): StoredSession[] {
  return sql
    .exec("SELECT * FROM sessions ORDER BY updated_at DESC")
    .toArray() as unknown as StoredSession[];
}

export function updateSessionMetadata(
  sql: SqlStorage,
  id: string,
  metadata: unknown,
  expectedVersion: number,
): VersionedUpdateResult {
  const session = getSession(sql, id);
  if (!session) return { ok: false, reason: "not_found" };
  if (!isManagedSessionMetadataUpdateValid(session, metadata)) {
    throw rpcError("BadRequest", "session metadata must preserve envSlug and role");
  }
  if (session.metadata_version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", current_version: session.metadata_version };
  }
  const newVersion = expectedVersion + 1;
  sql.exec(
    `UPDATE sessions SET metadata = ?, metadata_version = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(metadata),
    newVersion,
    id,
  );
  return { ok: true, version: newVersion };
}

export function updateSessionAgentState(
  sql: SqlStorage,
  id: string,
  agentState: unknown,
  expectedVersion: number,
): VersionedUpdateResult {
  const session = getSession(sql, id);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.agent_state_version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", current_version: session.agent_state_version };
  }
  const newVersion = expectedVersion + 1;
  sql.exec(
    `UPDATE sessions SET agent_state = ?, agent_state_version = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(agentState),
    newVersion,
    id,
  );
  return { ok: true, version: newVersion };
}

export function updateSessionTodos(
  sql: SqlStorage,
  id: string,
  todos: unknown,
  expectedVersion: number,
): VersionedUpdateResult {
  const session = getSession(sql, id);
  if (!session) return { ok: false, reason: "not_found" };
  if (session.todos_version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", current_version: session.todos_version };
  }
  const newVersion = expectedVersion + 1;
  sql.exec(
    `UPDATE sessions SET todos = ?, todos_version = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(todos),
    newVersion,
    id,
  );
  return { ok: true, version: newVersion };
}

export function setSessionActive(sql: SqlStorage, id: string, active: boolean): void {
  const updated = sql.exec(
    `UPDATE sessions SET active = ?, updated_at = datetime('now') WHERE id = ?`,
    active ? 1 : 0,
    id,
  );
  if (!updated.rowsWritten) throw rpcError("NotFound", `Session ${id} not found`);
}

/** Soft-delete: marks session inactive and records end time for 24h TTL cleanup. */
export function markSessionEnded(sql: SqlStorage, id: string): void {
  sql.exec(
    `UPDATE sessions SET active = 0, ended_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`,
    id,
  );
}

/** Revive a session (e.g. CLI WebSocket reconnect): clears ended_at and marks active. */
export function reviveSession(sql: SqlStorage, id: string): void {
  sql.exec(
    `UPDATE sessions SET active = 1, ended_at = NULL, updated_at = datetime('now') WHERE id = ?`,
    id,
  );
}

export function deleteSession(sql: SqlStorage, id: string): void {
  const result = sql.exec("DELETE FROM sessions WHERE id = ?", id);
  if (!result.rowsWritten) throw rpcError("NotFound", `Session ${id} not found`);
}

// ── Machines ────────────────────────────────────────────────────────

export function getOrCreateMachine(
  sql: SqlStorage,
  id: string,
  metadata: unknown,
): StoredMachine {
  sql.exec(
    `INSERT INTO machines (id, metadata)
     VALUES (?, ?)
     ON CONFLICT (id) DO UPDATE SET
       metadata = excluded.metadata,
       active = 1,
       updated_at = datetime('now')`,
    id,
    JSON.stringify(metadata ?? {}),
  );
  return sql.exec("SELECT * FROM machines WHERE id = ?", id).toArray()[0] as unknown as StoredMachine;
}

export function markMachineAlive(sql: SqlStorage, id: string): void {
  sql.exec(
    `INSERT INTO machines (id, active)
     VALUES (?, 1)
     ON CONFLICT (id) DO UPDATE SET
       active = 1,
       updated_at = datetime('now')`,
    id,
  );
}

export function getMachine(sql: SqlStorage, id: string): StoredMachine | null {
  const rows = sql.exec("SELECT * FROM machines WHERE id = ?", id).toArray();
  return (rows[0] as unknown as StoredMachine) ?? null;
}

export function getMachines(sql: SqlStorage): StoredMachine[] {
  return sql
    .exec("SELECT * FROM machines ORDER BY updated_at DESC")
    .toArray() as unknown as StoredMachine[];
}

export function updateMachineMetadata(
  sql: SqlStorage,
  id: string,
  metadata: unknown,
  expectedVersion: number,
): VersionedUpdateResult {
  const machine = getMachine(sql, id);
  if (!machine) return { ok: false, reason: "not_found" };
  if (machine.metadata_version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", current_version: machine.metadata_version };
  }
  const newVersion = expectedVersion + 1;
  sql.exec(
    `UPDATE machines SET metadata = ?, metadata_version = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(metadata),
    newVersion,
    id,
  );
  return { ok: true, version: newVersion };
}

export function updateMachineRunnerState(
  sql: SqlStorage,
  id: string,
  runnerState: unknown,
  expectedVersion: number,
): VersionedUpdateResult {
  const machine = getMachine(sql, id);
  if (!machine) return { ok: false, reason: "not_found" };
  if (machine.runner_state_version !== expectedVersion) {
    return { ok: false, reason: "version_conflict", current_version: machine.runner_state_version };
  }
  const newVersion = expectedVersion + 1;
  const nextState = mergeMachineServiceState(parseMachineServiceState(machine.runner_state), runnerState);
  sql.exec(
    `UPDATE machines SET runner_state = ?, runner_state_version = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(nextState),
    newVersion,
    id,
  );
  return { ok: true, version: newVersion };
}

export function replaceMachineRunnerState(
  sql: SqlStorage,
  id: string,
  runnerState: MachineServiceState,
): void {
  sql.exec(
    `UPDATE machines SET runner_state = ?, updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify(runnerState),
    id,
  );
}

export function setMachineActive(sql: SqlStorage, id: string, active: boolean): void {
  sql.exec(
    `UPDATE machines SET active = ?, updated_at = datetime('now') WHERE id = ?`,
    active ? 1 : 0,
    id,
  );
}

export function nextSessionMessageSeq(sql: SqlStorage, sessionId: string): number {
  sql.exec(
    `UPDATE sessions SET seq = seq + 1, updated_at = datetime('now') WHERE id = ?`,
    sessionId,
  );
  const session = sql.exec("SELECT seq FROM sessions WHERE id = ?", sessionId).toArray()[0] as { seq: number } | undefined;
  if (!session) throw rpcError("NotFound", `Session ${sessionId} not found`);
  return session.seq;
}

// ── Permissions ─────────────────────────────────────────────────────

export function createPermission(
  sql: SqlStorage,
  id: string,
  sessionId: string,
  toolName: string,
  toolInput: unknown,
): StoredPermission {
  sql.exec(
    `INSERT INTO permissions (id, session_id, tool_name, tool_input) VALUES (?, ?, ?, ?)`,
    id,
    sessionId,
    toolName,
    JSON.stringify(toolInput ?? {}),
  );
  return sql.exec("SELECT * FROM permissions WHERE id = ?", id)
    .toArray()[0] as unknown as StoredPermission;
}

export function getPermission(sql: SqlStorage, id: string): StoredPermission | null {
  const rows = sql.exec("SELECT * FROM permissions WHERE id = ?", id).toArray();
  return (rows[0] as unknown as StoredPermission) ?? null;
}

export function getPendingPermissions(sql: SqlStorage, sessionId: string): StoredPermission[] {
  return sql
    .exec("SELECT * FROM permissions WHERE session_id = ? AND status = 'pending' ORDER BY created_at ASC", sessionId)
    .toArray() as unknown as StoredPermission[];
}

export function resolvePermission(
  sql: SqlStorage,
  id: string,
  status: "allowed" | "denied",
  decisionReason?: string,
): StoredPermission | null {
  const result = sql.exec(
    `UPDATE permissions SET status = ?, decision_reason = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'pending'`,
    status,
    decisionReason ?? null,
    id,
  );
  if (!result.rowsWritten) return null;
  return getPermission(sql, id);
}

export function addSessionAllowedTool(sql: SqlStorage, sessionId: string, toolPattern: string): void {
  const session = getSession(sql, sessionId);
  if (!session) throw rpcError("NotFound", `Session ${sessionId} not found`);
  const allowed: string[] = JSON.parse(session.allowed_tools || "[]");
  if (!allowed.includes(toolPattern)) {
    allowed.push(toolPattern);
    sql.exec(
      `UPDATE sessions SET allowed_tools = ?, updated_at = datetime('now') WHERE id = ?`,
      JSON.stringify(allowed),
      sessionId,
    );
  }
}
