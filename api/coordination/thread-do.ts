import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  AppendSessionMessageInput,
  AppendSessionMessageResult,
  AppendThreadMessageInput,
  CreateThreadInput,
  Thread,
  ThreadMessage,
  ThreadMessageListFilter,
  ThreadScope,
  ThreadSequenceAuthority,
} from "./types";
import { HopMetricRecorder, safeTerminalIdentifier } from "../terminal-metrics";

const SESSION_THREAD_PREFIX = "session:";
const SESSION_MESSAGE_CONFLICT = "session_message_conflict";
const SESSION_MESSAGE_COMMIT_FAILED = "session_message_commit_failed";
const LEGACY_SEQUENCE_AUTHORITY_REJECTED = "legacy_sequence_authority_rejected";

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

interface SequenceAuthorityRow {
  thread_id: string;
  authority: ThreadSequenceAuthority;
}

class SanitizedSessionMessageError extends Error {}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) {
      return candidate.map((item) => normalize(item));
    }
    if (candidate && typeof candidate === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(candidate as Record<string, unknown>).sort()) {
        const normalized = normalize((candidate as Record<string, unknown>)[key]);
        if (normalized !== undefined) result[key] = normalized;
      }
      return result;
    }
    return candidate;
  };

  const serialized = JSON.stringify(normalize(value));
  if (serialized === undefined) throw new Error("not_json_serializable");
  return serialized;
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
  private readonly commitMetrics: HopMetricRecorder;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.commitMetrics = new HopMetricRecorder(
      "thread_do_session_commit",
      env.TILLER_TERMINAL_METRICS === "1",
    );
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sequence_authority (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        authority TEXT NOT NULL CHECK(authority IN ('external-v0', 'thread-v1'))
      )
    `);

    db.exec(`
      INSERT OR IGNORE INTO thread_sequence_authority (thread_id, authority)
      SELECT id, 'external-v0' FROM threads
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
      ...(row.local_id !== null ? { localId: row.local_id } : {}),
      ...(row.artifact_ids_json !== null ? { artifactIds: JSON.parse(row.artifact_ids_json) as string[] } : {}),
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
    this.db.exec(
      `INSERT OR IGNORE INTO thread_sequence_authority (thread_id, authority) VALUES (?, 'external-v0')`,
      input.id,
    );

    const existing = this.getThread();
    if (!existing) {
      throw new Error(`Failed to create thread ${input.id}`);
    }
    return existing;
  }

  getThread(): Thread | null {
    const row = this.db.exec("SELECT * FROM threads LIMIT 1").toArray()[0] as unknown as ThreadRow | undefined;
    return row ? this.parseThreadRow(row) : null;
  }

  appendMessage(input: AppendThreadMessageInput): ThreadMessage {
    const thread = this.getThread();
    if (!thread) {
      throw new Error("Thread does not exist");
    }

    if (thread.scope.type === "session" && this.getSequenceAuthority(thread.id) === "thread-v1") {
      console.warn("[ThreadDO] rejected legacy session sequence", {
        threadId: safeTerminalIdentifier(thread.id),
        messageId: safeTerminalIdentifier(input.id),
      });
      throw new Error(LEGACY_SEQUENCE_AUTHORITY_REJECTED);
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

    const row = this.db.exec("SELECT * FROM messages WHERE id = ?", id).toArray()[0] as unknown as ThreadMessageRow | undefined;
    if (!row) {
      throw new Error(`Failed to append message ${id}`);
    }
    return this.parseMessageRow(row);
  }

  /**
   * Forward-only session append path. Creation/verification, idempotency,
   * authority cutover, sequence allocation, and insertion share one SQLite
   * transaction so an older externally sequenced writer cannot race the
   * cutover marker.
   */
  appendSessionMessage(input: AppendSessionMessageInput): AppendSessionMessageResult {
    const db = this.db;
    const expectedThreadId = `${SESSION_THREAD_PREFIX}${input.sessionId}`;
    const startedAt = performance.now();

    try {
      const result = this.ctx.storage.transactionSync(() => {
        let threadRow = db.exec("SELECT * FROM threads LIMIT 1").toArray()[0] as unknown as ThreadRow | undefined;
        if (!threadRow) {
          const createdAt = input.createdAt ?? new Date().toISOString();
          db.exec(
            `
              INSERT INTO threads (
                id, scope_type, scope_id, kind, title, created_at, archived_at
              ) VALUES (?, 'session', ?, 'chat', NULL, ?, NULL)
            `,
            expectedThreadId,
            input.sessionId,
            createdAt,
          );
          threadRow = db.exec("SELECT * FROM threads LIMIT 1").toArray()[0] as unknown as ThreadRow | undefined;
        }

        if (
          !threadRow ||
          threadRow.id !== expectedThreadId ||
          threadRow.scope_type !== "session" ||
          threadRow.scope_id !== input.sessionId ||
          threadRow.kind !== "chat"
        ) {
          throw new SanitizedSessionMessageError(SESSION_MESSAGE_COMMIT_FAILED);
        }

        const existing = db.exec(
          "SELECT * FROM messages WHERE thread_id = ? AND id = ?",
          expectedThreadId,
          input.id,
        ).toArray()[0] as unknown as ThreadMessageRow | undefined;
        const bodyJson = canonicalJson(input.body);

        if (existing) {
          const samePayload =
            existing.sender_session_id === input.senderSessionId &&
            existing.kind === input.kind &&
            canonicalJson(JSON.parse(existing.body_json)) === bodyJson &&
            existing.local_id === (input.localId ?? null);
          if (!samePayload) {
            throw new SanitizedSessionMessageError(SESSION_MESSAGE_CONFLICT);
          }
        }

        db.exec(
          `
            INSERT INTO thread_sequence_authority (thread_id, authority)
            VALUES (?, 'thread-v1')
            ON CONFLICT(thread_id) DO UPDATE SET authority = 'thread-v1'
          `,
          expectedThreadId,
        );

        if (existing) {
          return { message: this.parseMessageRow(existing), newlyInserted: false };
        }

        const maxRow = db.exec(
          "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE thread_id = ?",
          expectedThreadId,
        ).toArray()[0] as unknown as { max_seq: number } | undefined;
        const nextSeq = Number(maxRow?.max_seq ?? 0) + 1;
        const createdAt = input.createdAt ?? new Date().toISOString();

        db.exec(
          `
            INSERT INTO messages (
              id, thread_id, seq, sender_session_id, kind, body_json, local_id, artifact_ids_json, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
          `,
          input.id,
          expectedThreadId,
          nextSeq,
          input.senderSessionId,
          input.kind,
          bodyJson,
          input.localId ?? null,
          createdAt,
        );

        const inserted = db.exec(
          "SELECT * FROM messages WHERE thread_id = ? AND id = ?",
          expectedThreadId,
          input.id,
        ).toArray()[0] as unknown as ThreadMessageRow | undefined;
        if (!inserted || inserted.seq !== nextSeq) {
          throw new SanitizedSessionMessageError(SESSION_MESSAGE_COMMIT_FAILED);
        }
        return { message: this.parseMessageRow(inserted), newlyInserted: true };
      });
      this.commitMetrics.record(
        performance.now() - startedAt,
        new TextEncoder().encode(canonicalJson(input.body)).byteLength,
      );
      return result;
    } catch (error) {
      const sanitized = error instanceof SanitizedSessionMessageError
        ? error.message
        : SESSION_MESSAGE_COMMIT_FAILED;
      console.error("[ThreadDO] session append rejected", {
        sessionId: safeTerminalIdentifier(input.sessionId),
        messageId: safeTerminalIdentifier(input.id),
        code: sanitized,
      });
      throw new Error(sanitized);
    }
  }

  getSequenceAuthority(threadId?: string): ThreadSequenceAuthority {
    const thread = this.getThread();
    if (!thread || (threadId && thread.id !== threadId)) return "external-v0";
    const row = this.db.exec(
      "SELECT thread_id, authority FROM thread_sequence_authority WHERE thread_id = ?",
      thread.id,
    ).toArray()[0] as unknown as SequenceAuthorityRow | undefined;
    return row?.authority ?? "external-v0";
  }

  getCanonicalMaxSequence(): number {
    const thread = this.getThread();
    if (!thread) return 0;
    const row = this.db.exec(
      "SELECT COALESCE(MAX(seq), 0) AS max_seq FROM messages WHERE thread_id = ?",
      thread.id,
    ).toArray()[0] as unknown as { max_seq: number } | undefined;
    return Number(row?.max_seq ?? 0);
  }

  getMessage(messageId: string): ThreadMessage | null {
    const thread = this.getThread();
    if (!thread) return null;
    const row = this.db.exec(
      "SELECT * FROM messages WHERE thread_id = ? AND id = ?",
      thread.id,
      messageId,
    ).toArray()[0] as unknown as ThreadMessageRow | undefined;
    return row ? this.parseMessageRow(row) : null;
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
      ).toArray() as unknown as ThreadMessageRow[];
      return rows.map((row) => this.parseMessageRow(row));
    }

    if (filter.beforeSeq != null) {
      const rows = this.db.exec(
        `SELECT * FROM messages WHERE thread_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`,
        thread.id,
        filter.beforeSeq,
        limit,
      ).toArray() as unknown as ThreadMessageRow[];
      return rows.map((row) => this.parseMessageRow(row));
    }

    const rows = this.db.exec(
      `SELECT * FROM messages WHERE thread_id = ? ORDER BY seq DESC LIMIT ?`,
      thread.id,
      limit,
    ).toArray() as unknown as ThreadMessageRow[];
    return rows.map((row) => this.parseMessageRow(row));
  }
}
