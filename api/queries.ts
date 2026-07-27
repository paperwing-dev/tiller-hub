import { rpcError } from "./errors";
import { mergeMachineServiceState, parseMachineServiceState } from "./machine-service-state";
import { isManagedSessionMetadataUpdateValid } from "./session-attachment";
import type {
  MachineServiceState,
  RepoCloudflareMcpAuditEventRow,
  RepoCloudflareMcpCredentialRow,
  RepoCloudflareMcpPendingOAuthRow,
  RepoCloudflareMcpProxyTokenRow,
  RepoMcpServerRow,
  RepoSessionEnvRow,
  StoredSession,
  StoredMachine,
  StoredPermission,
  VersionedUpdateResult,
} from "./types";
import { readTerminalScopeFromStoredSession } from "./session-attachment";

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

export function revokePlanWriterTerminal(
  sql: SqlStorage,
  id: string,
  repoId: string,
  planArtifactId: string,
  generation: number,
): StoredSession | null {
  const session = getSession(sql, id);
  if (!session) return null;
  const scope = readTerminalScopeFromStoredSession(session);
  if (
    scope?.kind !== "plan-writer"
    || scope.repoId !== repoId
    || scope.planArtifactId !== planArtifactId
    || scope.generation !== generation
  ) {
    return null;
  }
  if (scope.revokedAt) return session;
  const metadata = JSON.parse(session.metadata) as Record<string, unknown>;
  const revokedAt = new Date().toISOString();
  sql.exec(
    `UPDATE sessions SET metadata = ?, metadata_version = metadata_version + 1,
     active = 0, ended_at = COALESCE(ended_at, ?), updated_at = datetime('now') WHERE id = ?`,
    JSON.stringify({ ...metadata, terminalScope: { ...scope, revokedAt } }),
    revokedAt,
    id,
  );
  return getSession(sql, id);
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

// ── Repo session environment ────────────────────────────────────────

export function listRepoSessionEnvRows(sql: SqlStorage, repoId: string): RepoSessionEnvRow[] {
  return sql
    .exec(
      `SELECT repo_id, name, encrypted_value, nonce, updated_at
       FROM repo_session_env
       WHERE repo_id = ?
       ORDER BY name ASC`,
      repoId,
    )
    .toArray() as unknown as RepoSessionEnvRow[];
}

export function upsertRepoSessionEnvRow(
  sql: SqlStorage,
  row: Omit<RepoSessionEnvRow, "updated_at">,
): void {
  sql.exec(
    `INSERT INTO repo_session_env (repo_id, name, encrypted_value, nonce, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(repo_id, name) DO UPDATE SET
       encrypted_value = excluded.encrypted_value,
       nonce = excluded.nonce,
       updated_at = excluded.updated_at`,
    row.repo_id,
    row.name,
    row.encrypted_value,
    row.nonce,
  );
}

export function deleteRepoSessionEnvNames(sql: SqlStorage, repoId: string, names: string[]): void {
  for (const name of names) {
    sql.exec(
      "DELETE FROM repo_session_env WHERE repo_id = ? AND name = ?",
      repoId,
      name,
    );
  }
}

export function deleteRepoSessionEnv(sql: SqlStorage, repoId: string): void {
  sql.exec("DELETE FROM repo_session_env WHERE repo_id = ?", repoId);
}

// ── Repo MCP servers ────────────────────────────────────────────────

export function listRepoMcpServerRows(sql: SqlStorage, repoId: string): RepoMcpServerRow[] {
  return sql
    .exec(
      `SELECT repo_id, id, label, url, enabled, updated_at
       FROM repo_mcp_servers
       WHERE repo_id = ?
       ORDER BY label ASC, id ASC`,
      repoId,
    )
    .toArray() as unknown as RepoMcpServerRow[];
}

export function replaceRepoMcpServerRows(
  sql: SqlStorage,
  repoId: string,
  rows: Array<Omit<RepoMcpServerRow, "repo_id" | "updated_at">>,
): void {
  sql.exec("DELETE FROM repo_mcp_servers WHERE repo_id = ?", repoId);
  for (const row of rows) {
    sql.exec(
      `INSERT INTO repo_mcp_servers (repo_id, id, label, url, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
      repoId,
      row.id,
      row.label,
      row.url,
      row.enabled,
    );
  }
}

export function deleteRepoMcpServers(sql: SqlStorage, repoId: string): void {
  sql.exec("DELETE FROM repo_mcp_servers WHERE repo_id = ?", repoId);
}

// ── Repo Cloudflare MCP integration ────────────────────────────────

export function getRepoCloudflareMcpCredentialRow(
  sql: SqlStorage,
  repoId: string,
): RepoCloudflareMcpCredentialRow | null {
  const row = sql
    .exec(
      `SELECT repo_id, client_id,
              encrypted_access_token, access_token_nonce, encrypted_refresh_token, refresh_token_nonce,
              token_type, scopes, expires_at, account_id, account_name, enabled,
              last_auth_error, last_auth_error_at, connected_at, updated_at
       FROM repo_cloudflare_mcp_credentials
       WHERE repo_id = ?`,
      repoId,
    )
    .toArray()[0] as unknown as RepoCloudflareMcpCredentialRow | undefined;
  return row ?? null;
}

export function upsertRepoCloudflareMcpCredentialRow(
  sql: SqlStorage,
  row: Omit<RepoCloudflareMcpCredentialRow, "connected_at" | "updated_at">,
): void {
  sql.exec(
    `INSERT INTO repo_cloudflare_mcp_credentials (
       repo_id, client_id,
       encrypted_access_token, access_token_nonce, encrypted_refresh_token, refresh_token_nonce,
       token_type, scopes, expires_at, account_id, account_name, enabled,
       last_auth_error, last_auth_error_at, connected_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
     ON CONFLICT(repo_id) DO UPDATE SET
       client_id = excluded.client_id,
       encrypted_access_token = excluded.encrypted_access_token,
       access_token_nonce = excluded.access_token_nonce,
       encrypted_refresh_token = excluded.encrypted_refresh_token,
       refresh_token_nonce = excluded.refresh_token_nonce,
       token_type = excluded.token_type,
       scopes = excluded.scopes,
       expires_at = excluded.expires_at,
       account_id = excluded.account_id,
       account_name = excluded.account_name,
       enabled = excluded.enabled,
       last_auth_error = excluded.last_auth_error,
       last_auth_error_at = excluded.last_auth_error_at,
       updated_at = excluded.updated_at`,
    row.repo_id,
    row.client_id,
    row.encrypted_access_token,
    row.access_token_nonce,
    row.encrypted_refresh_token,
    row.refresh_token_nonce,
    row.token_type,
    row.scopes,
    row.expires_at,
    row.account_id,
    row.account_name,
    row.enabled,
    row.last_auth_error,
    row.last_auth_error_at,
  );
}

export function setRepoCloudflareMcpEnabled(
  sql: SqlStorage,
  repoId: string,
  enabled: boolean,
): void {
  sql.exec(
    `UPDATE repo_cloudflare_mcp_credentials
     SET enabled = ?, updated_at = datetime('now')
     WHERE repo_id = ?`,
    enabled ? 1 : 0,
    repoId,
  );
}

export function setRepoCloudflareMcpAuthError(
  sql: SqlStorage,
  repoId: string,
  error: string | null,
): void {
  sql.exec(
    `UPDATE repo_cloudflare_mcp_credentials
     SET last_auth_error = ?, last_auth_error_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END,
         enabled = CASE WHEN ? IS NULL THEN enabled ELSE 0 END,
         updated_at = datetime('now')
     WHERE repo_id = ?`,
    error,
    error,
    error,
    repoId,
  );
}

export function deleteRepoCloudflareMcpCredentials(sql: SqlStorage, repoId: string): void {
  sql.exec("DELETE FROM repo_cloudflare_mcp_credentials WHERE repo_id = ?", repoId);
}

export function upsertRepoCloudflareMcpPendingOAuthRow(
  sql: SqlStorage,
  row: Omit<RepoCloudflareMcpPendingOAuthRow, "created_at">,
): void {
  sql.exec(
    `INSERT INTO repo_cloudflare_mcp_oauth_states (
       state, repo_id, redirect_uri, pkce_verifier, client_id,
       initiating_identity, expires_at, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(state) DO UPDATE SET
       repo_id = excluded.repo_id,
       redirect_uri = excluded.redirect_uri,
       pkce_verifier = excluded.pkce_verifier,
       client_id = excluded.client_id,
       initiating_identity = excluded.initiating_identity,
       expires_at = excluded.expires_at`,
    row.state,
    row.repo_id,
    row.redirect_uri,
    row.pkce_verifier,
    row.client_id,
    row.initiating_identity,
    row.expires_at,
  );
}

export function getRepoCloudflareMcpPendingOAuthRow(
  sql: SqlStorage,
  state: string,
): RepoCloudflareMcpPendingOAuthRow | null {
  const row = sql
    .exec(
      `SELECT state, repo_id, redirect_uri, pkce_verifier, client_id,
              initiating_identity, expires_at, created_at
       FROM repo_cloudflare_mcp_oauth_states
       WHERE state = ?`,
      state,
    )
    .toArray()[0] as unknown as RepoCloudflareMcpPendingOAuthRow | undefined;
  return row ?? null;
}

export function deleteRepoCloudflareMcpPendingOAuthState(sql: SqlStorage, state: string): void {
  sql.exec("DELETE FROM repo_cloudflare_mcp_oauth_states WHERE state = ?", state);
}

export function deleteRepoCloudflareMcpPendingOAuth(sql: SqlStorage, repoId: string): void {
  sql.exec("DELETE FROM repo_cloudflare_mcp_oauth_states WHERE repo_id = ?", repoId);
}

export function deleteExpiredRepoCloudflareMcpPendingOAuth(sql: SqlStorage, nowMs: number): void {
  sql.exec("DELETE FROM repo_cloudflare_mcp_oauth_states WHERE expires_at <= ?", nowMs);
}

export function insertRepoCloudflareMcpProxyToken(
  sql: SqlStorage,
  row: Omit<RepoCloudflareMcpProxyTokenRow, "created_at" | "revoked_at">,
): void {
  sql.exec(
    `INSERT INTO repo_cloudflare_mcp_proxy_tokens (
       token_hash, repo_id, env_slug, server_id, incarnation_id, start_op_id,
       expires_at, revoked_at, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'))`,
    row.token_hash,
    row.repo_id,
    row.env_slug,
    row.server_id,
    row.incarnation_id,
    row.start_op_id,
    row.expires_at,
  );
}

export function getRepoCloudflareMcpProxyTokenRow(
  sql: SqlStorage,
  tokenHash: string,
): RepoCloudflareMcpProxyTokenRow | null {
  const row = sql
    .exec(
      `SELECT token_hash, repo_id, env_slug, server_id, incarnation_id, start_op_id,
              expires_at, revoked_at, created_at
       FROM repo_cloudflare_mcp_proxy_tokens
       WHERE token_hash = ?`,
      tokenHash,
    )
    .toArray()[0] as unknown as RepoCloudflareMcpProxyTokenRow | undefined;
  return row ?? null;
}

export function revokeRepoCloudflareMcpProxyTokenForStart(
  sql: SqlStorage,
  input: { tokenHash: string; envSlug: string; incarnationId: string; startOpId: string },
): boolean {
  const row = getRepoCloudflareMcpProxyTokenRow(sql, input.tokenHash);
  if (!row) return true;
  if (
    row.env_slug !== input.envSlug
    || row.incarnation_id !== input.incarnationId
    || row.start_op_id !== input.startOpId
  ) return false;
  sql.exec(
    `UPDATE repo_cloudflare_mcp_proxy_tokens
     SET revoked_at = datetime('now')
     WHERE token_hash = ? AND revoked_at IS NULL`,
    input.tokenHash,
  );
  return true;
}

export function revokeRepoCloudflareMcpProxyTokensForStart(
  sql: SqlStorage,
  input: { envSlug: string; incarnationId: string; startOpId: string },
): void {
  sql.exec(
    `UPDATE repo_cloudflare_mcp_proxy_tokens
     SET revoked_at = datetime('now')
     WHERE env_slug = ? AND incarnation_id = ? AND start_op_id = ? AND revoked_at IS NULL`,
    input.envSlug,
    input.incarnationId,
    input.startOpId,
  );
}

export function revokeRepoCloudflareMcpProxyTokensForEnv(sql: SqlStorage, envSlug: string): void {
  sql.exec(
    `UPDATE repo_cloudflare_mcp_proxy_tokens
     SET revoked_at = datetime('now')
     WHERE env_slug = ? AND revoked_at IS NULL`,
    envSlug,
  );
}

export function revokeRepoCloudflareMcpProxyTokensForRepo(sql: SqlStorage, repoId: string): void {
  sql.exec(
    `UPDATE repo_cloudflare_mcp_proxy_tokens
     SET revoked_at = datetime('now')
     WHERE repo_id = ? AND revoked_at IS NULL`,
    repoId,
  );
}

export function deleteRepoCloudflareMcpProxyTokens(sql: SqlStorage, repoId: string): void {
  sql.exec("DELETE FROM repo_cloudflare_mcp_proxy_tokens WHERE repo_id = ?", repoId);
}

export function insertRepoCloudflareMcpAuditEvent(
  sql: SqlStorage,
  row: Omit<RepoCloudflareMcpAuditEventRow, "created_at">,
): void {
  sql.exec(
    `INSERT INTO repo_cloudflare_mcp_audit_events (
       id, repo_id, env_slug, server_id, http_method, json_rpc_method,
       response_status, error_code, created_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    row.id,
    row.repo_id,
    row.env_slug,
    row.server_id,
    row.http_method,
    row.json_rpc_method,
    row.response_status,
    row.error_code,
  );
}

export function deleteRepoCloudflareMcpAuditEvents(sql: SqlStorage, repoId: string): void {
  sql.exec("DELETE FROM repo_cloudflare_mcp_audit_events WHERE repo_id = ?", repoId);
}
