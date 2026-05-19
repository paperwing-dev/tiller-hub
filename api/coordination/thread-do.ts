import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  AppendThreadMessageInput,
  CreateThreadInput,
  Thread,
  ThreadMessage,
  ThreadMessageListFilter,
  ThreadScope,
} from "./types";

interface ThreadRow {
  id: string;
  scope_type: string;
  scope_id: string;
  kind: string;
  title: string | null;
  created_at: string;
  archived_at: string | null;
}

interface ThreadMessageRow {
  id: string;
  thread_id: string;
  seq: number;
  sender_session_id: string;
  kind: string;
  body_json: string;
  local_id: string | null;
  artifact_ids_json: string | null;
  created_at: string;
}

function scopeToColumns(scope: ThreadScope): { type: string; id: string } {
  switch (scope.type) {
    case "session":
      return { type: "session", id: scope.sessionId };
    case "repo":
      return { type: "repo", id: scope.repoId };
    case "env":
      return { type: "env", id: scope.envSlug };
  }
}

function columnsToScope(scopeType: string, scopeId: string): ThreadScope {
  switch (scopeType) {
    case "session":
      return { type: "session", sessionId: scopeId };
    case "repo":
      return { type: "repo", repoId: scopeId };
    case "env":
      return { type: "env", envSlug: scopeId };
    default:
      throw new Error(`Unknown thread scope type: ${scopeType}`);
  }
}

export class ThreadDO extends DurableObject<Env> {
  private _db: SqlStorage | null = null;
  private _schemaReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  private get db(): SqlStorage {
    if (!this._db) {
      this._db = this.ctx.storage.sql;
    }
    if (!this._schemaReady) {
      this.ensureSchema(this._db);
      this._schemaReady = true;
    }
    return this._db;
  }

  private ensureSchema(db: SqlStorage): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        archived_at TEXT
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        sender_session_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        body_json TEXT NOT NULL,
        local_id TEXT,
        artifact_ids_json TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(thread_id, seq)
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_thread_messages_seq
      ON messages(thread_id, seq)
    `);
  }

  private parseThreadRow(row: ThreadRow): Thread {
    return {
      id: row.id,
      scope: columnsToScope(row.scope_type, row.scope_id),
      kind: row.kind as Thread["kind"],
      ...(row.title ? { title: row.title } : {}),
      createdAt: row.created_at,
      ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    };
  }

  private parseMessageRow(row: ThreadMessageRow): ThreadMessage {
    return {
      id: row.id,
      threadId: row.thread_id,
      seq: row.seq,
      senderSessionId: row.sender_session_id,
      kind: row.kind as ThreadMessage["kind"],
      body: JSON.parse(row.body_json),
      ...(row.local_id ? { localId: row.local_id } : {}),
      ...(row.artifact_ids_json ? { artifactIds: JSON.parse(row.artifact_ids_json) as string[] } : {}),
      createdAt: row.created_at,
    };
  }

  createThread(input: CreateThreadInput): Thread {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const scope = scopeToColumns(input.scope);
    this.db.exec(
      `
        INSERT OR IGNORE INTO threads (
          id, scope_type, scope_id, kind, title, created_at, archived_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      input.id,
      scope.type,
      scope.id,
      input.kind,
      input.title ?? null,
      createdAt,
      input.archivedAt ?? null,
    );

    const existing = this.getThread();
    if (!existing) {
      throw new Error(`Failed to create thread ${input.id}`);
    }
    return existing;
  }

  getThread(): Thread | null {
    const row = this.db.exec("SELECT * FROM threads LIMIT 1").toArray()[0] as ThreadRow | undefined;
    return row ? this.parseThreadRow(row) : null;
  }

  appendMessage(input: AppendThreadMessageInput): ThreadMessage {
    const thread = this.getThread();
    if (!thread) {
      throw new Error("Thread does not exist");
    }

    const id = input.id ?? crypto.randomUUID();
    const createdAt = input.createdAt ?? new Date().toISOString();
    this.db.exec(
      `
        INSERT OR IGNORE INTO messages (
          id, thread_id, seq, sender_session_id, kind, body_json, local_id, artifact_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      id,
      thread.id,
      input.seq,
      input.senderSessionId,
      input.kind,
      JSON.stringify(input.body),
      input.localId ?? null,
      input.artifactIds ? JSON.stringify(input.artifactIds) : null,
      createdAt,
    );

    const row = this.db.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0] as ThreadMessageRow | undefined;
    if (!row) {
      throw new Error(`Failed to append message ${id}`);
    }
    return this.parseMessageRow(row);
  }

  listMessages(filter: ThreadMessageListFilter = {}): ThreadMessage[] {
    const thread = this.getThread();
    if (!thread) return [];

    const limit = Math.max(1, Math.min(filter.limit ?? 50, 1000));
    if (filter.afterSeq != null) {
      const rows = this.db.exec(
        `SELECT * FROM messages WHERE thread_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
        thread.id,
        filter.afterSeq,
        limit,
      ).toArray() as ThreadMessageRow[];
      return rows.map((row) => this.parseMessageRow(row));
    }

    if (filter.beforeSeq != null) {
      const rows = this.db.exec(
        `SELECT * FROM messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
        thread.id,
        filter.beforeSeq,
        limit,
      ).toArray() as ThreadMessageRow[];
      return rows.map((row) => this.parseMessageRow(row));
    }

    const rows = this.db.exec(
      `SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`,
      thread.id,
      limit,
    ).toArray() as ThreadMessageRow[];
    return rows.map((row) => this.parseMessageRow(row));
  }
}
