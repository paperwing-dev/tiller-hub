import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import type {
  Artifact,
  ArtifactListFilter,
  ArtifactRef,
  ArtifactType,
  Basis,
  CreateArtifactInput,
  PlanArtifactBody,
  ReviewArtifactBody,
  SetRefInput,
} from "./types";

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
}

interface RefRow {
  repo_id: string;
  name: string;
  artifact_id: string;
  version: number;
  updated_at: string;
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
        created_at TEXT NOT NULL
      )
    `);

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
      CREATE TABLE IF NOT EXISTS refs (
        repo_id TEXT NOT NULL,
        name TEXT NOT NULL,
        artifact_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, name)
      )
    `);
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

  createArtifact<TBody = unknown>(input: CreateArtifactInput<TBody>): Artifact<TBody> {
    const artifact: Artifact<TBody> = {
      id: input.id ?? crypto.randomUUID(),
      repoId: input.repoId,
      type: input.type,
      basis: input.basis,
      title: input.title,
      body: input.body,
      ...(input.parentArtifactId ? { parentArtifactId: input.parentArtifactId } : {}),
      ...(input.supersedesArtifactId ? { supersedesArtifactId: input.supersedesArtifactId } : {}),
      ...(input.createdBy ? { createdBy: input.createdBy } : {}),
      createdAt: input.createdAt ?? new Date().toISOString(),
    };

    this.db.exec(
      `
        INSERT INTO artifacts (
          id, repo_id, type, basis_json, basis_main_commit, basis_env_slug,
          title, body_json, parent_artifact_id, supersedes_artifact_id, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    );

    return artifact;
  }

  getArtifact(id: string): Artifact | null {
    const row = this.db.exec("SELECT * FROM artifacts WHERE id = ?", id).toArray()[0] as ArtifactRow | undefined;
    return row ? this.parseArtifactRow(row) : null;
  }

  listArtifacts(filter: ArtifactListFilter = {}): Artifact[] {
    const clauses = ["1 = 1"];
    const values: Array<string | number | null> = [];

    if (filter.type) {
      clauses.push("type = ?");
      values.push(filter.type);
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
        ORDER BY created_at DESC
        LIMIT ?
      `,
      ...values,
    ).toArray() as ArtifactRow[];

    return rows.map((row) => this.parseArtifactRow(row));
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
    const row = this.db.exec("SELECT * FROM refs WHERE name = ?", name).toArray()[0] as RefRow | undefined;
    return row ? this.parseRefRow(row) : null;
  }

  listRefs(): ArtifactRef[] {
    const rows = this.db.exec("SELECT * FROM refs ORDER BY name ASC").toArray() as RefRow[];
    return rows.map((row) => this.parseRefRow(row));
  }
}
