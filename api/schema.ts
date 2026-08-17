/**
 * Database schema initialization — all CREATE TABLE statements.
 * Called on every DO wake-up (onStart) — all statements are idempotent.
 */

function createSessionsGroup(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      tag TEXT NOT NULL,
      machine_id TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      agent_state TEXT NOT NULL DEFAULT '{}',
      todos TEXT NOT NULL DEFAULT '[]',
      active INTEGER NOT NULL DEFAULT 1,
      metadata_version INTEGER NOT NULL DEFAULT 1,
      agent_state_version INTEGER NOT NULL DEFAULT 1,
      todos_version INTEGER NOT NULL DEFAULT 1,
      seq INTEGER NOT NULL DEFAULT 0,
      ended_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS permissions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      tool_input TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      decision_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at TEXT
    )
  `);

  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_permissions_session_status ON permissions(session_id, status)
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS plan_writer_terminal_tombstones (
      id TEXT PRIMARY KEY,
      repo_id TEXT NOT NULL,
      plan_artifact_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      revoked_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function ensureSchema(sql: SqlStorage): void {
  createSessionsGroup(sql);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL DEFAULT '{}',
      runner_state TEXT NOT NULL DEFAULT '{}',
      active INTEGER NOT NULL DEFAULT 1,
      metadata_version INTEGER NOT NULL DEFAULT 1,
      runner_state_version INTEGER NOT NULL DEFAULT 1,
      seq INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(platform, platform_user_id)
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // ── Self-healing migration: drop old UNIQUE(tag, namespace) constraint ──────
  // The UNIQUE constraint breaks concurrent sessions from the same machine.
  // If it exists, wipe sessions/messages/permissions and recreate with new schema.
  const indexes = sql.exec("PRAGMA index_list(sessions)").toArray() as Array<{ unique: number; origin: string }>;
  const hasOldConstraint = indexes.some((idx) => idx.unique === 1 && idx.origin === "u");
  if (hasOldConstraint) {
    sql.exec("DROP TABLE IF EXISTS permissions");
    sql.exec("DROP TABLE IF EXISTS messages");
    sql.exec("DROP TABLE IF EXISTS sessions");
    createSessionsGroup(sql);
  }

  sql.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS repo_session_env (
      repo_id TEXT NOT NULL,
      name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      nonce TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo_id, name)
    )
  `);

  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_repo_session_env_repo ON repo_session_env(repo_id)
  `);

  sql.exec(`
    CREATE TABLE IF NOT EXISTS repo_mcp_servers (
      repo_id TEXT NOT NULL,
      id TEXT NOT NULL,
      label TEXT NOT NULL,
      url TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (repo_id, id)
    )
  `);

  sql.exec(`
    CREATE INDEX IF NOT EXISTS idx_repo_mcp_servers_repo ON repo_mcp_servers(repo_id)
  `);

  // One-way cleanup for the retired authenticated Cloudflare MCP integration.
  sql.exec("DROP TABLE IF EXISTS repo_cloudflare_mcp_audit_events");
  sql.exec("DROP TABLE IF EXISTS repo_cloudflare_mcp_proxy_tokens");
  sql.exec("DROP TABLE IF EXISTS repo_cloudflare_mcp_oauth_states");
  sql.exec("DROP TABLE IF EXISTS repo_cloudflare_mcp_credentials");

  // ── Additive column migrations (safe for existing DOs) ───────────────────────
  const sessionCols = sql.exec("PRAGMA table_info(sessions)").toArray() as { name: string }[];

  if (!sessionCols.some((c) => c.name === "allowed_tools")) {
    sql.exec("ALTER TABLE sessions ADD COLUMN allowed_tools TEXT NOT NULL DEFAULT '[]'");
  }

  if (!sessionCols.some((c) => c.name === "ended_at")) {
    sql.exec("ALTER TABLE sessions ADD COLUMN ended_at TEXT");
  }
}
