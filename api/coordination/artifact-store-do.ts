import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  Artifact,
  ArtifactListFilter,
  ArtifactRef,
  ArtifactType,
  Basis,
  CreateArtifactInput,
  DiscardPlanInput,
  PlanArtifactBody,
  PlanStatus,
  ReviewerRegistryEntry,
  ReviewArtifactBody,
  SavePlanInput,
  SavePlanResult,
  SetRefInput,
  UpdateArtifactStatusInput,
  UpsertReviewerInput,
} from "./types";
import { renderArtifactBodyMarkdown } from "./planning";

interface ArtifactRow {
  id: string;
  repo_id: string;
  type: ArtifactType;
  basis_json: string;
  title: string;
  body_json: string;
  parent_artifact_id: string | null;
  supersedes_artifact_id: string | null;
  created_by: string | null;
  created_at: string;
  status: PlanStatus | null;
  updated_at: string | null;
  version: number | null;
}

interface RefRow {
  repo_id: string;
  name: string;
  artifact_id: string;
  version: number;
  updated_at: string;
}

interface ReviewerRegistryRow {
  thread_id: string;
  plan_artifact_id: string;
  repo_id: string;
  reviewer_model: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
}

function execIgnoringDuplicateColumn(db: SqlStorage, sql: string): void {
  try {
    db.exec(sql);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/duplicate column|already exists/i.test(message)) {
      throw error;
    }
  }
}

function isPlanStatus(value: string | null | undefined): value is PlanStatus {
  return value === "draft" || value === "todo" || value === "completed" || value === "archived";
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${value.length}`;
}

export class ArtifactStoreDO extends DurableObject<Env> {
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
      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        type TEXT NOT NULL,
        basis_json TEXT NOT NULL,
        basis_main_commit TEXT,
        basis_env_slug TEXT,
        title TEXT NOT NULL,
        body_json TEXT NOT NULL,
        parent_artifact_id TEXT,
        supersedes_artifact_id TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        status TEXT,
        updated_at TEXT,
        version INTEGER
      )
    `);

    execIgnoringDuplicateColumn(db, "ALTER TABLE artifacts ADD COLUMN status TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE artifacts ADD COLUMN updated_at TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE artifacts ADD COLUMN version INTEGER");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_repo_type_created_at
      ON artifacts(repo_id, type, created_at DESC)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_repo_parent
      ON artifacts(repo_id, parent_artifact_id)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_repo_main_commit
      ON artifacts(repo_id, basis_main_commit, created_at DESC)
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_artifacts_repo_type_status_main_updated
      ON artifacts(repo_id, type, status, basis_main_commit, updated_at DESC)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS refs (
        repo_id TEXT NOT NULL,
        name TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, name)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS reviewer_registry (
        thread_id TEXT PRIMARY KEY,
        plan_artifact_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        reviewer_model TEXT NOT NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    this.dropReviewerModelUniqueConstraint(db);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reviewer_registry_repo_plan_removed
      ON reviewer_registry(repo_id, plan_artifact_id, removed_at)
    `);
  }

  private dropReviewerModelUniqueConstraint(db: SqlStorage): void {
    const indexes = db.exec("PRAGMA index_list(reviewer_registry)").toArray() as Array<{
      unique: number;
      origin?: string;
    }>;
    const hasModelUniqueConstraint = indexes.some((index) => Number(index.unique) === 1 && index.origin === "u");
    if (!hasModelUniqueConstraint) return;

    db.exec(`
      ALTER TABLE reviewer_registry RENAME TO reviewer_registry_with_model_unique
    `);
    db.exec(`
      CREATE TABLE reviewer_registry (
        thread_id TEXT PRIMARY KEY,
        plan_artifact_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        reviewer_model TEXT NOT NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      INSERT INTO reviewer_registry (
        thread_id, plan_artifact_id, repo_id, reviewer_model, removed_at, created_at, updated_at
      )
      SELECT thread_id, plan_artifact_id, repo_id, reviewer_model, removed_at, created_at, updated_at
      FROM reviewer_registry_with_model_unique
    `);
    db.exec("DROP TABLE reviewer_registry_with_model_unique");
  }

  private parseArtifactRow(row: ArtifactRow): Artifact {
    return {
      id: row.id,
      repoId: row.repo_id,
      type: row.type,
      basis: JSON.parse(row.basis_json),
      title: row.title,
      body: JSON.parse(row.body_json),
      ...(row.parent_artifact_id ? { parentArtifactId: row.parent_artifact_id } : {}),
      ...(row.supersedes_artifact_id ? { supersedesArtifactId: row.supersedes_artifact_id } : {}),
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: row.created_at,
      status: isPlanStatus(row.status) ? row.status : "draft",
      updatedAt: row.updated_at ?? row.created_at,
      version: row.version ?? 1,
    };
  }

  private parseRefRow(row: RefRow): ArtifactRef {
    return {
      repoId: row.repo_id,
      name: row.name,
      artifactId: row.artifact_id,
      version: row.version,
      updatedAt: row.updated_at,
    };
  }

  private parseReviewerRegistryRow(row: ReviewerRegistryRow): ReviewerRegistryEntry {
    return {
      threadId: row.thread_id,
      planArtifactId: row.plan_artifact_id,
      repoId: row.repo_id,
      reviewerModel: row.reviewer_model,
      ...(row.removed_at ? { removedAt: row.removed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  createArtifact<TBody = unknown>(input: CreateArtifactInput<TBody>): Artifact<TBody> {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const artifact: Artifact<TBody> = {
      id: input.id ?? crypto.randomUUID(),
      repoId: input.repoId,
      type: input.type,
      basis: input.basis,
      title: input.title,
      body: input.body,
      status: input.status ?? "draft",
      ...(input.parentArtifactId ? { parentArtifactId: input.parentArtifactId } : {}),
      ...(input.supersedesArtifactId ? { supersedesArtifactId: input.supersedesArtifactId } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
      version: input.version ?? 1,
    };

    this.db.exec(
      `
        INSERT INTO artifacts (
          id, repo_id, type, basis_json, basis_main_commit, basis_env_slug,
          title, body_json, parent_artifact_id, supersedes_artifact_id, created_by, created_at,
          status, updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      artifact.id,
      artifact.repoId,
      artifact.type,
      JSON.stringify(artifact.basis),
      artifact.basis.mainCommit,
      artifact.basis.envSlug ?? null,
      artifact.title,
      JSON.stringify(artifact.body),
      artifact.parentArtifactId ?? null,
      artifact.supersedesArtifactId ?? null,
      artifact.createdBy ?? null,
      artifact.createdAt,
      artifact.status,
      artifact.updatedAt,
      artifact.version,
    );

    return artifact;
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.exec("SELECT * FROM artifacts WHERE id = ?", id).toArray()[0] as unknown as ArtifactRow | undefined;
    return row ? this.parseArtifactRow(row) : null;
  }

  listArtifacts(filter: ArtifactListFilter = {}): Artifact[] {
    const clauses = ["1 = 1"];
    const values: Array<string | number | null> = [];

    if (filter.type) {
      clauses.push("type = ?");
      values.push(filter.type);
    }
    if (filter.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    if (filter.parentArtifactId !== undefined) {
      if (filter.parentArtifactId === null) {
        clauses.push("parent_artifact_id IS NULL");
      } else {
        clauses.push("parent_artifact_id = ?");
        values.push(filter.parentArtifactId);
      }
    }
    if (filter.basisMainCommit !== undefined) {
      if (filter.basisMainCommit === null) {
        clauses.push("basis_main_commit IS NULL");
      } else {
        clauses.push("basis_main_commit = ?");
        values.push(filter.basisMainCommit);
      }
    }

    const limit = Math.max(1, Math.min(filter.limit ?? 100, 500));
    values.push(limit);

    const rows = this.db.exec(
      `
        SELECT *
        FROM artifacts
        WHERE ${clauses.join(" AND ")}
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT ?
      `,
      ...values,
    ).toArray() as unknown as ArtifactRow[];

    return rows.map((row) => this.parseArtifactRow(row));
  }

  updateArtifactStatus(input: UpdateArtifactStatusInput): Artifact {
    const existing = this.getArtifact(input.id);
    if (!existing || existing.repoId !== input.repoId) {
      throw new Error(`Artifact not found: ${input.id}`);
    }
    if (existing.type !== "plan") {
      throw new Error("Only plan artifacts can be moved between plan categories");
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      (existing.version ?? 1) !== input.expectedVersion
    ) {
      throw new Error(`Artifact version mismatch for ${input.id}: expected ${input.expectedVersion}, found ${existing.version ?? 1}`);
    }

    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE artifacts
        SET status = ?, updated_at = ?, version = COALESCE(version, 1) + 1
        WHERE id = ? AND repo_id = ?
      `,
      input.status,
      now,
      input.id,
      input.repoId,
    );

    const updated = this.getArtifact(input.id);
    if (!updated) {
      throw new Error(`Artifact not found after update: ${input.id}`);
    }
    return updated;
  }

  discardPlan(input: DiscardPlanInput): Artifact<PlanArtifactBody> {
    const existing = this.getArtifact(input.id);
    if (!existing || existing.repoId !== input.repoId) {
      throw new Error(`Plan artifact not found: ${input.id}`);
    }
    if (existing.type !== "plan") {
      throw new Error("Only plan artifacts can be discarded");
    }
    if ((existing.status ?? "draft") !== "draft") {
      throw new Error("Only draft plans can be discarded");
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      (existing.version ?? 1) !== input.expectedVersion
    ) {
      throw new Error(`Artifact version mismatch for ${input.id}: expected ${input.expectedVersion}, found ${existing.version ?? 1}`);
    }

    this.db.exec("DELETE FROM refs WHERE repo_id = ? AND artifact_id = ?", input.repoId, input.id);
    this.db.exec("DELETE FROM reviewer_registry WHERE repo_id = ? AND plan_artifact_id = ?", input.repoId, input.id);
    this.db.exec("DELETE FROM artifacts WHERE repo_id = ? AND id = ?", input.repoId, input.id);

    return existing as Artifact<PlanArtifactBody>;
  }

  savePlan(input: SavePlanInput): SavePlanResult {
    const existing = this.getArtifact(input.id);
    if (!existing || existing.repoId !== input.repoId || existing.type !== "plan") {
      throw new Error(`Plan artifact not found: ${input.id}`);
    }
    const existingVersion = existing.version ?? 1;
    if (existingVersion !== input.expectedVersion) {
      return {
        status: "conflict",
        currentVersion: existingVersion,
        currentTitle: existing.title,
        currentMarkdownDigest: hashString(renderArtifactBodyMarkdown(existing.body)),
      };
    }

    const now = new Date().toISOString();
    const basis: Basis = {
      ...existing.basis,
      repoId: input.repoId,
      mainCommit: input.currentMainCommit,
    };
    const title = input.title?.trim() || existing.title;
    const body: PlanArtifactBody = { markdown: input.markdown };

    this.db.exec(
      `
        UPDATE artifacts
        SET title = ?,
            body_json = ?,
            basis_json = ?,
            basis_main_commit = ?,
            updated_at = ?,
            version = COALESCE(version, 1) + 1
        WHERE id = ? AND repo_id = ?
      `,
      title,
      JSON.stringify(body),
      JSON.stringify(basis),
      basis.mainCommit,
      now,
      input.id,
      input.repoId,
    );

    const updated = this.getArtifact(input.id) as Artifact<PlanArtifactBody> | null;
    if (!updated) {
      throw new Error(`Plan artifact not found after save: ${input.id}`);
    }
    return {
      status: "ok",
      version: updated.version ?? 1,
      artifact: updated,
    };
  }

  listLatestTodoPlansForMain(repoId: string, mainCommit: string | null, limit = 1): Artifact<PlanArtifactBody>[] {
    if (!mainCommit) return [];
    const rows = this.db.exec(
      `
        SELECT *
        FROM artifacts
        WHERE repo_id = ? AND type = 'plan' AND status = 'todo' AND basis_main_commit = ?
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT ?
      `,
      repoId,
      mainCommit,
      Math.max(1, Math.min(limit, 50)),
    ).toArray() as unknown as ArtifactRow[];
    return rows.map((row) => this.parseArtifactRow(row) as Artifact<PlanArtifactBody>);
  }

  listReviewers(repoId: string, planArtifactId: string, options: { includeRemoved?: boolean } = {}): ReviewerRegistryEntry[] {
    const rows = this.db.exec(
      `
        SELECT *
        FROM reviewer_registry
        WHERE repo_id = ? AND plan_artifact_id = ?
          ${options.includeRemoved ? "" : "AND removed_at IS NULL"}
        ORDER BY created_at ASC, rowid ASC
      `,
      repoId,
      planArtifactId,
    ).toArray() as unknown as ReviewerRegistryRow[];
    return rows.map((row) => this.parseReviewerRegistryRow(row));
  }

  getReviewer(threadId: string): ReviewerRegistryEntry | null {
    const row = this.db.exec(
      "SELECT * FROM reviewer_registry WHERE thread_id = ?",
      threadId,
    ).toArray()[0] as unknown as ReviewerRegistryRow | undefined;
    return row ? this.parseReviewerRegistryRow(row) : null;
  }

  upsertReviewer(input: UpsertReviewerInput): ReviewerRegistryEntry {
    const now = new Date().toISOString();
    const threadId = crypto.randomUUID();
    this.db.exec(
      `
        INSERT INTO reviewer_registry (
          thread_id, plan_artifact_id, repo_id, reviewer_model, removed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?)
      `,
      threadId,
      input.planArtifactId,
      input.repoId,
      input.reviewerModel,
      now,
      now,
    );
    const created = this.getReviewer(threadId);
    if (!created) {
      throw new Error(`Reviewer registry row not found after insert: ${threadId}`);
    }
    return created;
  }

  removeReviewer(repoId: string, planArtifactId: string, threadId: string): ReviewerRegistryEntry {
    const existing = this.getReviewer(threadId);
    if (!existing || existing.repoId !== repoId || existing.planArtifactId !== planArtifactId) {
      throw new Error(`Reviewer registry row not found: ${threadId}`);
    }
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET removed_at = ?, updated_at = ?
        WHERE thread_id = ?
      `,
      now,
      now,
      threadId,
    );
    const removed = this.getReviewer(threadId);
    if (!removed) {
      throw new Error(`Reviewer registry row not found after remove: ${threadId}`);
    }
    return removed;
  }

  setRef(input: SetRefInput): ArtifactRef {
    const now = new Date().toISOString();
    const existing = this.getRef(input.name);
    if (existing) {
      if (input.expectedVersion !== undefined && input.expectedVersion !== null && existing.version !== input.expectedVersion) {
        throw new Error(`Ref version mismatch for ${input.name}: expected ${input.expectedVersion}, found ${existing.version}`);
      }
      const next: ArtifactRef = {
        repoId: input.repoId,
        name: input.name,
        artifactId: input.artifactId,
        version: existing.version + 1,
        updatedAt: now,
      };
      this.db.exec(
        `
          UPDATE refs
          SET artifact_id = ?, version = ?, updated_at = ?
          WHERE repo_id = ? AND name = ?
        `,
        next.artifactId,
        next.version,
        next.updatedAt,
        next.repoId,
        next.name,
      );
      return next;
    }

    if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== 0) {
      throw new Error(`Ref version mismatch for ${input.name}: expected ${input.expectedVersion}, found none`);
    }

    const created: ArtifactRef = {
      repoId: input.repoId,
      name: input.name,
      artifactId: input.artifactId,
      version: 1,
      updatedAt: now,
    };
    this.db.exec(
      `
        INSERT INTO refs (repo_id, name, artifact_id, version, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      created.repoId,
      created.name,
      created.artifactId,
      created.version,
      created.updatedAt,
    );
    return created;
  }

  getRef(name: string): ArtifactRef | null {
    const row = this.db.exec("SELECT * FROM refs WHERE name = ?", name).toArray()[0] as unknown as RefRow | undefined;
    return row ? this.parseRefRow(row) : null;
  }

  listRefs(): ArtifactRef[] {
    const rows = this.db.exec("SELECT * FROM refs ORDER BY name ASC").toArray() as unknown as RefRow[];
    return rows.map((row) => this.parseRefRow(row));
  }
}
