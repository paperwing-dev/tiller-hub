import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import { codexExecutionAuthMode } from "../codex-execution";
import type {
  Artifact,
  AgentSkillDefinition,
  ArtifactListFilter,
  ArtifactRef,
  ArtifactType,
  AppendPlannerRunEventInput,
  Basis,
  CreateArtifactInput,
  CreateOrGetPlanContributionResult,
  CreatePlanContributionInput,
  CreatePlannerRunInput,
  DiscardPlanInput,
  PlanContribution,
  PlanContributionListFilter,
  PlanContributionSourceKind,
  PlanContributionStatus,
  PlanArtifactBody,
  PlanWriterStopReason,
  PublishObservedPlanResult,
  ObservedPlanPublication,
  WriterPublicationCursor,
  PlanSkillInvocation,
  PlannerRunBasis,
  PlannerEffort,
  RepoPlanWriterSettings,
  PlannerRun,
  PlannerRunEvent,
  PlannerRunInput,
  PlannerRunRuntimeProvenance,
  PlannerRunLaunchProvenance,
  PlanWriterRuntimeProvenance,
  PlanWriterLaunchProvenance,
  PlannerRunStatus,
  PlanStatus,
  ReviewerRegistryEntry,
  ReviewArtifactBody,
  SavePlanInput,
  SetRefInput,
  UpdatePlannerRunInput,
  UpdateArtifactStatusInput,
  UpsertReviewerInput,
  SkillInvocationStatus,
  SkillRunRole,
  SkillSurface,
} from "./types";
import { derivePlanTitleFromMarkdown, MAX_PLAN_MARKDOWN_BYTES, renderArtifactBodyMarkdown } from "./planning";
import {
  isCurrentLaunchProvenance,
  isCurrentPlannerRuntimeProvenance,
  isCurrentPlanWriterRuntimeProvenance,
  parseStoredLaunchProvenance,
  parseStoredPlanWriterRuntimeProvenance,
  parseStoredRuntimeProvenance,
} from "./execution-provenance";

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

interface EnvironmentSidebarSlotRow {
  env_slug: string;
  slot: number;
  claim_id: string | null;
  state: "reserved" | "committed";
  created_at: string;
  lease_expires_at_ms: number | null;
}

export interface EnvironmentSidebarSlotInput {
  slug: string;
  createdAt: string;
  sidebarSlot?: number;
}

export interface EnvironmentSidebarSlotAssignment {
  slug: string;
  slot: number;
}

const ENVIRONMENT_SIDEBAR_SLOT_CLAIM_TTL_MS = 10 * 60_000;

interface ReviewerRegistryRow {
  thread_id: string;
  plan_artifact_id: string;
  repo_id: string;
  provider: string | null;
  model: string | null;
  effort: string | null;
  fast_mode: number | null;
  skill: string | null;
  role: string | null;
  run_id: string | null;
  status: string | null;
  error: string | null;
  provider_conversation_id: string | null;
  reviewer_model: string;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  job_slug: string | null;
  generation: number | null;
  stopped_at: string | null;
  stop_reason: string | null;
  basis_commit: string | null;
  start_body_digest: string | null;
  publication_cursor_json: string | null;
  synchronization_error: string | null;
  startup_error: string | null;
  cleanup_error: string | null;
  runtime_json: string | null;
  launch_provenance_json: string | null;
  codex_account_id: string | null;
  skill_invocation_id: string | null;
  skill_agent_id: string | null;
}

interface PlanContributionRow {
  id: string;
  repo_id: string;
  plan_artifact_id: string;
  source_kind: string | null;
  source_run_id: string | null;
  source_thread_id: string | null;
  source_message_id: string | null;
  source_plan_version: number | null;
  idempotency_key: string | null;
  provider: string;
  model: string;
  skill: string | null;
  text: string;
  status: PlanContributionStatus;
  created_at: string;
  updated_at: string;
  incorporated_at: string | null;
  dismissed_at: string | null;
}

interface RepoPlanWriterSettingsRow {
  repo_id: string;
  updated_at: string | null;
  route_key: string | null;
  effort: string | null;
  fast_mode: number | null;
  plan_format: string | null;
}

interface AgentSkillRow {
  id: string;
  repo_id: string;
  command: string;
  label: string;
  description: string | null;
  instructions: string;
  kind: string;
  created_at: string;
  updated_at: string;
  surface: string | null;
  definition_json: string | null;
}

interface PlannerRunRow {
  run_id: string;
  repo_id: string;
  plan_artifact_id: string;
  role: PlannerRun["role"];
  provider: string;
  model: string;
  skill: string | null;
  status: PlannerRunStatus;
  started_at: string;
  completed_at: string | null;
  error: string | null;
  thread_id: string | null;
  input_json: string | null;
  runtime_json: string | null;
  launch_provenance_json: string | null;
  codex_account_id: string | null;
  last_contact_at: string | null;
  skill_invocation_id: string | null;
  skill_agent_id: string | null;
  skill_run_role: string | null;
}

interface PlanSkillInvocationRow {
  invocation_id: string;
  repo_id: string;
  plan_artifact_id: string;
  parent_thread_id: string;
  definition_snapshot_json: string;
  basis_json: string;
  status: string;
  error: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

interface PlannerRunEventRow {
  run_id: string;
  repo_id: string;
  plan_artifact_id: string;
  seq: number;
  type: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
}

const MAX_STORED_RUN_EVENTS = 200;

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
  return value === "draft" || value === "evaluating" || value === "todo" || value === "completed" || value === "archived";
}

function isPlannerRunStatus(value: string | null | undefined): value is PlannerRunStatus {
  return value === "queued" || value === "running" || value === "saving" || value === "completed" || value === "failed" || value === "cancelled";
}

function isPlannerEffort(value: string | null | undefined): value is PlannerEffort {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "ultra" || value === "max";
}

function isActiveRunStatus(value: PlannerRunStatus): boolean {
  return value === "queued" || value === "running" || value === "saving";
}

function isPlanContributionStatus(value: string | null | undefined): value is PlanContributionStatus {
  return value === "pending" || value === "incorporated" || value === "dismissed";
}

function isPlanWriterStopReason(value: string | null | undefined): value is PlanWriterStopReason {
  return value === "user"
    || value === "idle"
    || value === "completed"
    || value === "archived"
    || value === "runtime_ended"
    || value === "mode_invalidated"
    || value === "watchdog";
}

function parsePublicationCursor(value: string | null): WriterPublicationCursor | undefined {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(value) as Partial<WriterPublicationCursor>;
    if (
      Number.isInteger(cursor.sequence)
      && (cursor.sequence ?? 0) > 0
      && typeof cursor.providerEventId === "string"
      && typeof cursor.bodyDigest === "string"
      && Number.isInteger(cursor.artifactVersion)
      && (cursor.result === "updated" || cursor.result === "unchanged")
    ) {
      return cursor as WriterPublicationCursor;
    }
  } catch {
    // A malformed cursor is treated as absent and repaired by a fresh generation.
  }
  return undefined;
}

function isPlanContributionSourceKind(value: string | null | undefined): value is PlanContributionSourceKind {
  return value === "manual" || value === "reviewer_message" || value === "reviewer_run" || value === "skill_guidance";
}

function isSkillRunRole(value: string | null | undefined): value is SkillRunRole {
  return value === "child_initial" || value === "child_followup" || value === "overview";
}

function isSkillInvocationStatus(value: string | null | undefined): value is SkillInvocationStatus {
  return value === "setting_up" || value === "active" || value === "completed" || value === "failed" || value === "cancelled";
}

function samePlanWriterRuntime(
  left: PlanWriterRuntimeProvenance,
  right: PlanWriterRuntimeProvenance,
): boolean {
  return left.jobSlug === right.jobSlug
    && left.generation === right.generation;
}

function samePlannerRunRuntime(
  left: PlannerRunRuntimeProvenance,
  right: PlannerRunRuntimeProvenance,
): boolean {
  return left.jobSlug === right.jobSlug;
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
      CREATE TABLE IF NOT EXISTS environment_sidebar_slots (
        env_slug TEXT PRIMARY KEY,
        slot INTEGER NOT NULL UNIQUE,
        claim_id TEXT,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        lease_expires_at_ms INTEGER
      )
    `);
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE environment_sidebar_slots ADD COLUMN lease_expires_at_ms INTEGER",
    );

    db.exec(`
      CREATE TABLE IF NOT EXISTS reviewer_registry (
        thread_id TEXT PRIMARY KEY,
        plan_artifact_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        effort TEXT,
        fast_mode INTEGER NOT NULL DEFAULT 0,
        skill TEXT,
        role TEXT,
        run_id TEXT,
        status TEXT,
        error TEXT,
        provider_conversation_id TEXT,
        reviewer_model TEXT NOT NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN provider TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN model TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN effort TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN skill TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN role TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN run_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN status TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN error TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN provider_conversation_id TEXT");

    this.dropReviewerModelUniqueConstraint(db);

    // The constraint rebuild above recreates reviewer_registry without Plan
    // Writer columns, so these ALTERs must run after it.
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN job_slug TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN generation INTEGER");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN stopped_at TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN stop_reason TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN basis_commit TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN start_body_digest TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN publication_cursor_json TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN synchronization_error TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN startup_error TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN cleanup_error TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN runtime_json TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN launch_provenance_json TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN codex_account_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN skill_invocation_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE reviewer_registry ADD COLUMN skill_agent_id TEXT");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reviewer_registry_repo_plan_removed
      ON reviewer_registry(repo_id, plan_artifact_id, removed_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_reviewer_registry_skill_invocation
      ON reviewer_registry(skill_invocation_id, created_at)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_contributions (
        id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL,
        source_kind TEXT,
        source_run_id TEXT,
        source_thread_id TEXT,
        source_message_id TEXT,
        source_plan_version INTEGER,
        idempotency_key TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        skill TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        incorporated_at TEXT,
        dismissed_at TEXT
      )
    `);

    execIgnoringDuplicateColumn(db, "ALTER TABLE plan_contributions ADD COLUMN source_kind TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE plan_contributions ADD COLUMN source_message_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE plan_contributions ADD COLUMN source_plan_version INTEGER");
    execIgnoringDuplicateColumn(db, "ALTER TABLE plan_contributions ADD COLUMN idempotency_key TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE plan_contributions ADD COLUMN incorporated_at TEXT");
    // Plan Writer is a destructive cutover: obsolete consumed
    // inbox rows are not reinterpreted as the user's explicit incorporation.
    db.exec("DELETE FROM plan_contributions WHERE status = 'consumed'");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_plan_contributions_repo_plan_status
      ON plan_contributions(repo_id, plan_artifact_id, status, created_at ASC)
    `);

    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_plan_contributions_repo_plan_idempotency
      ON plan_contributions(repo_id, plan_artifact_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS repo_plan_writer_settings (
        repo_id TEXT PRIMARY KEY,
        route_key TEXT NOT NULL,
        effort TEXT,
        fast_mode INTEGER NOT NULL DEFAULT 0,
        plan_format TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    execIgnoringDuplicateColumn(db, "ALTER TABLE repo_plan_writer_settings ADD COLUMN effort TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE repo_plan_writer_settings ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0");

    db.exec(`
      CREATE TABLE IF NOT EXISTS planning_skills (
        repo_id TEXT NOT NULL,
        id TEXT NOT NULL,
        command TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        instructions TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, id)
      )
    `);
    execIgnoringDuplicateColumn(db, "ALTER TABLE planning_skills ADD COLUMN surface TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planning_skills ADD COLUMN definition_json TEXT");

    db.exec("DROP INDEX IF EXISTS idx_planning_skills_repo_command");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_planning_skills_repo_surface_command
      ON planning_skills(repo_id, surface, command)
      WHERE surface IS NOT NULL
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS planner_runs (
        run_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        skill TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        thread_id TEXT
      )
    `);

    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN input_json TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN runtime_json TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN launch_provenance_json TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN codex_account_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN last_contact_at TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN skill_invocation_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN skill_agent_id TEXT");
    execIgnoringDuplicateColumn(db, "ALTER TABLE planner_runs ADD COLUMN skill_run_role TEXT");

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_planner_runs_repo_plan_role_started
      ON planner_runs(repo_id, plan_artifact_id, role, started_at DESC)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_planner_runs_skill_invocation
      ON planner_runs(skill_invocation_id, started_at)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_skill_invocations (
        invocation_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        definition_snapshot_json TEXT NOT NULL,
        basis_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_plan_skill_invocations_history
      ON plan_skill_invocations(repo_id, plan_artifact_id, created_at DESC, invocation_id DESC)
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS planner_run_events (
        run_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        data_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (run_id, seq)
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_planner_run_events_repo_plan_run_seq
      ON planner_run_events(repo_id, plan_artifact_id, run_id, seq)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS repository_deletion (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        deleted_at TEXT NOT NULL
      )
    `);
  }

  private assertRepositoryWritable(): void {
    const deleted = this.db.exec(
      "SELECT singleton FROM repository_deletion LIMIT 1",
    ).toArray()[0];
    if (deleted) {
      throw new Error("Repository state has been finalized for deletion.");
    }
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
        provider TEXT,
        model TEXT,
        effort TEXT,
        skill TEXT,
        role TEXT,
        run_id TEXT,
        status TEXT,
        error TEXT,
        provider_conversation_id TEXT,
        reviewer_model TEXT NOT NULL,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
        INSERT INTO reviewer_registry (
        thread_id, plan_artifact_id, repo_id, provider, model, effort, role,
        reviewer_model, removed_at, created_at, updated_at
      )
      SELECT thread_id, plan_artifact_id, repo_id,
             CASE WHEN reviewer_model LIKE '@cf/%' THEN 'workers-ai' ELSE 'unknown' END,
             reviewer_model, effort, 'reviewer', reviewer_model, removed_at, created_at, updated_at
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
    const provider = row.provider?.trim();
    const model = row.model?.trim();
    if (!provider || !model || (row.role !== "reviewer" && row.role !== "writer")) {
      throw new Error(`Malformed planning registry row: ${row.thread_id}`);
    }
    const writer = row.role === "writer";
    const runtime = parseStoredPlanWriterRuntimeProvenance(
      row.runtime_json,
      "plan writer runtime",
    );
    const launchProvenance = parseStoredLaunchProvenance<PlanWriterLaunchProvenance>(
      row.launch_provenance_json,
      "plan writer launch",
    );
    const codexExecution = launchProvenance?.codexExecution;
    return {
      threadId: row.thread_id,
      planArtifactId: row.plan_artifact_id,
      repoId: row.repo_id,
      provider,
      model,
      ...(isPlannerEffort(row.effort) ? { effort: row.effort } : {}),
      ...(row.fast_mode === 1 ? { fastMode: true } : {}),
      ...(row.skill && !writer ? { skill: row.skill } : {}),
      role: writer ? "writer" : "reviewer",
      ...(row.job_slug ? { jobSlug: row.job_slug } : {}),
      ...(runtime ? { runtime } : {}),
      ...(launchProvenance ? { launchProvenance } : {}),
      ...(codexExecution ? {
        codexAuthMode: codexExecutionAuthMode(codexExecution),
      } : {}),
      ...(typeof row.generation === "number" ? { generation: row.generation } : {}),
      ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}),
      ...(isPlanWriterStopReason(row.stop_reason) ? { stopReason: row.stop_reason } : {}),
      ...(row.basis_commit ? { basisCommit: row.basis_commit } : {}),
      ...(row.start_body_digest ? { startBodyDigest: row.start_body_digest } : {}),
      ...(parsePublicationCursor(row.publication_cursor_json)
        ? { publicationCursor: parsePublicationCursor(row.publication_cursor_json) }
        : {}),
      ...(row.synchronization_error ? { synchronizationError: row.synchronization_error } : {}),
      ...(row.startup_error ? { startupError: row.startup_error } : {}),
      ...(row.cleanup_error ? { cleanupError: row.cleanup_error } : {}),
      ...(row.skill_invocation_id ? { skillInvocationId: row.skill_invocation_id } : {}),
      ...(row.skill_agent_id ? { skillAgentId: row.skill_agent_id } : {}),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(isPlannerRunStatus(row.status) ? { status: row.status } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.provider_conversation_id ? { providerConversationId: row.provider_conversation_id } : {}),
      reviewerModel: model,
      ...(row.removed_at ? { removedAt: row.removed_at } : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parsePlanContributionRow(row: PlanContributionRow): PlanContribution {
    return {
      id: row.id,
      repoId: row.repo_id,
      planArtifactId: row.plan_artifact_id,
      sourceKind: isPlanContributionSourceKind(row.source_kind) ? row.source_kind : "manual",
      ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
      ...(row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {}),
      ...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
      ...(typeof row.source_plan_version === "number" ? { sourcePlanVersion: row.source_plan_version } : {}),
      provider: row.provider,
      model: row.model,
      ...(row.skill ? { skill: row.skill } : {}),
      text: row.text,
      status: isPlanContributionStatus(row.status) ? row.status : "pending",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.incorporated_at ? { incorporatedAt: row.incorporated_at } : {}),
      ...(row.dismissed_at ? { dismissedAt: row.dismissed_at } : {}),
    };
  }

  private parsePlannerRunRow(row: PlannerRunRow): PlannerRun {
    const input = row.input_json
      ? JSON.parse(row.input_json) as PlannerRunInput
      : undefined;
    const runtime = parseStoredRuntimeProvenance<PlannerRunRuntimeProvenance>(
      row.runtime_json,
      "planner run runtime",
    );
    const launchProvenance = parseStoredLaunchProvenance<PlannerRunLaunchProvenance>(
      row.launch_provenance_json,
      "planner run launch",
    );
    const codexExecution = launchProvenance?.codexExecution;
    return {
      runId: row.run_id,
      repoId: row.repo_id,
      planArtifactId: row.plan_artifact_id,
      role: row.role,
      provider: row.provider,
      model: row.model,
      ...(row.skill ? { skill: row.skill } : {}),
      status: isPlannerRunStatus(row.status) ? row.status : "failed",
      startedAt: row.started_at,
      ...(row.completed_at ? { completedAt: row.completed_at } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.thread_id ? { threadId: row.thread_id } : {}),
      ...(input ? { input } : {}),
      ...(runtime ? { runtime } : {}),
      ...(launchProvenance ? { launchProvenance } : {}),
      ...(codexExecution ? {
        codexAuthMode: codexExecutionAuthMode(codexExecution),
      } : {}),
      ...(row.skill_invocation_id ? { skillInvocationId: row.skill_invocation_id } : {}),
      ...(row.skill_agent_id ? { skillAgentId: row.skill_agent_id } : {}),
      ...(isSkillRunRole(row.skill_run_role) ? { skillRunRole: row.skill_run_role } : {}),
      ...(row.last_contact_at ? { lastContactAt: row.last_contact_at } : {}),
    };
  }

  private parsePlanSkillInvocationRow(row: PlanSkillInvocationRow): PlanSkillInvocation {
    return {
      invocationId: row.invocation_id,
      repoId: row.repo_id,
      planArtifactId: row.plan_artifact_id,
      parentThreadId: row.parent_thread_id,
      definitionSnapshot: JSON.parse(row.definition_snapshot_json) as AgentSkillDefinition,
      basis: JSON.parse(row.basis_json) as PlannerRunBasis,
      status: isSkillInvocationStatus(row.status) ? row.status : "failed",
      error: row.error,
      cancelledAt: row.cancelled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parsePlannerRunEventRow(row: PlannerRunEventRow): PlannerRunEvent {
    return {
      runId: row.run_id,
      repoId: row.repo_id,
      planArtifactId: row.plan_artifact_id,
      seq: row.seq,
      type: row.type,
      ...(row.message ? { message: row.message } : {}),
      ...(row.data_json ? { data: JSON.parse(row.data_json) } : {}),
      createdAt: row.created_at,
    };
  }

  reconcileEnvironmentSidebarSlots(
    input: EnvironmentSidebarSlotInput[],
  ): EnvironmentSidebarSlotAssignment[] {
    this.assertRepositoryWritable();
    const entries = [...input]
      .filter((entry) => entry.slug.trim())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.slug.localeCompare(right.slug));

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const liveSlugs = new Set(entries.map((entry) => entry.slug));
      const existingRows = this.db.exec(
        "SELECT * FROM environment_sidebar_slots ORDER BY slot ASC",
      ).toArray() as unknown as EnvironmentSidebarSlotRow[];

      for (const row of existingRows) {
        const expiredReservation = row.state === "reserved"
          && (!Number.isFinite(row.lease_expires_at_ms) || row.lease_expires_at_ms! <= now);
        if (
          !liveSlugs.has(row.env_slug)
          && (row.state === "committed" || expiredReservation)
        ) {
          this.db.exec("DELETE FROM environment_sidebar_slots WHERE env_slug = ?", row.env_slug);
        }
      }

      const retainedRows = this.db.exec(
        "SELECT * FROM environment_sidebar_slots ORDER BY slot ASC",
      ).toArray() as unknown as EnvironmentSidebarSlotRow[];
      const bySlug = new Map(retainedRows.map((row) => [row.env_slug, row]));
      const usedSlots = new Set(retainedRows.map((row) => row.slot));
      const nextFreeSlot = () => {
        let slot = 1;
        while (usedSlots.has(slot)) slot += 1;
        return slot;
      };

      return entries.map((entry) => {
        const existing = bySlug.get(entry.slug);
        if (existing) {
          if (existing.state !== "committed" || existing.claim_id !== null) {
            this.db.exec(
              `UPDATE environment_sidebar_slots
               SET claim_id = NULL, state = 'committed', lease_expires_at_ms = NULL
               WHERE env_slug = ?`,
              entry.slug,
            );
          }
          return { slug: entry.slug, slot: existing.slot };
        }

        const preferred = Number.isInteger(entry.sidebarSlot) && (entry.sidebarSlot ?? 0) > 0
          ? entry.sidebarSlot!
          : null;
        const slot = preferred && !usedSlots.has(preferred) ? preferred : nextFreeSlot();
        usedSlots.add(slot);
        this.db.exec(
          `INSERT INTO environment_sidebar_slots (
             env_slug, slot, claim_id, state, created_at, lease_expires_at_ms
           ) VALUES (?, ?, NULL, 'committed', ?, NULL)`,
          entry.slug,
          slot,
          entry.createdAt,
        );
        return { slug: entry.slug, slot };
      });
    });
  }

  claimEnvironmentSidebarSlot(input: {
    slug: string;
    claimId: string;
    createdAt: string;
  }): { status: "claimed"; slot: number } | { status: "conflict" } {
    this.assertRepositoryWritable();
    const slug = input.slug.trim();
    const claimId = input.claimId.trim();
    if (!slug || !claimId) throw new Error("Environment sidebar slot claims require slug and claimId.");

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const existing = this.db.exec(
        "SELECT * FROM environment_sidebar_slots WHERE env_slug = ?",
        slug,
      ).toArray()[0] as unknown as EnvironmentSidebarSlotRow | undefined;
      if (existing) {
        if (existing.state === "reserved" && existing.claim_id === claimId) {
          return { status: "claimed" as const, slot: existing.slot };
        }
        if (
          existing.state === "reserved"
          && (!Number.isFinite(existing.lease_expires_at_ms) || existing.lease_expires_at_ms! <= now)
        ) {
          this.db.exec(
            `UPDATE environment_sidebar_slots
             SET claim_id = ?, created_at = ?, lease_expires_at_ms = ?
             WHERE env_slug = ?`,
            claimId,
            input.createdAt,
            now + ENVIRONMENT_SIDEBAR_SLOT_CLAIM_TTL_MS,
            slug,
          );
          return { status: "claimed" as const, slot: existing.slot };
        }
        return { status: "conflict" as const };
      }

      const rows = this.db.exec(
        "SELECT slot FROM environment_sidebar_slots ORDER BY slot ASC",
      ).toArray() as unknown as Array<{ slot: number }>;
      let slot = 1;
      for (const row of rows) {
        if (row.slot === slot) slot += 1;
        else if (row.slot > slot) break;
      }
      this.db.exec(
        `INSERT INTO environment_sidebar_slots (
           env_slug, slot, claim_id, state, created_at, lease_expires_at_ms
         ) VALUES (?, ?, ?, 'reserved', ?, ?)`,
        slug,
        slot,
        claimId,
        input.createdAt,
        now + ENVIRONMENT_SIDEBAR_SLOT_CLAIM_TTL_MS,
      );
      return { status: "claimed" as const, slot };
    });
  }

  commitEnvironmentSidebarSlot(slug: string, claimId: string): boolean {
    return this.ctx.storage.transactionSync(() => {
      const row = this.db.exec(
        "SELECT * FROM environment_sidebar_slots WHERE env_slug = ?",
        slug,
      ).toArray()[0] as unknown as EnvironmentSidebarSlotRow | undefined;
      if (!row) return false;
      if (row.state === "committed") return true;
      if (row.claim_id !== claimId) return false;
      if (
        !Number.isFinite(row.lease_expires_at_ms)
        || row.lease_expires_at_ms! <= Date.now()
      ) return false;
      this.db.exec(
        `UPDATE environment_sidebar_slots
         SET claim_id = NULL, state = 'committed', lease_expires_at_ms = NULL
         WHERE env_slug = ?`,
        slug,
      );
      return true;
    });
  }

  releaseEnvironmentSidebarSlotClaim(slug: string, claimId: string): boolean {
    const result = this.db.exec(
      `DELETE FROM environment_sidebar_slots
       WHERE env_slug = ? AND claim_id = ? AND state = 'reserved'`,
      slug,
      claimId,
    );
    return result.rowsWritten > 0;
  }

  releaseEnvironmentSidebarSlot(slug: string): boolean {
    const result = this.db.exec(
      "DELETE FROM environment_sidebar_slots WHERE env_slug = ?",
      slug,
    );
    return result.rowsWritten > 0;
  }

  createArtifact<TBody = unknown>(input: CreateArtifactInput<TBody>): Artifact<TBody> {
    this.assertRepositoryWritable();
    if (input.type === "plan" && !input.basis.mainCommit?.trim()) {
      throw new Error("Plan artifacts require a frozen basis commit at creation.");
    }
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

  savePlan(input: SavePlanInput): Artifact<PlanArtifactBody> {
    const existing = this.getArtifact(input.id);
    if (!existing || existing.repoId !== input.repoId || existing.type !== "plan") {
      throw new Error(`Plan artifact not found: ${input.id}`);
    }
    if (existing.status !== "draft" && existing.status !== "evaluating" && existing.status !== "todo") {
      throw new Error("Only draft, evaluating, or todo plans can be edited");
    }
    if (new TextEncoder().encode(input.markdown).byteLength > MAX_PLAN_MARKDOWN_BYTES) {
      throw new Error(`Plan Markdown exceeds ${MAX_PLAN_MARKDOWN_BYTES} UTF-8 bytes`);
    }

    const derivedTitle = derivePlanTitleFromMarkdown(input.markdown);
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE artifacts
        SET body_json = ?,
            title = CASE WHEN ? != '' THEN ? ELSE title END,
            updated_at = ?,
            version = COALESCE(version, 1) + 1
        WHERE id = ? AND repo_id = ?
      `,
      JSON.stringify({ markdown: input.markdown }),
      derivedTitle,
      derivedTitle,
      now,
      input.id,
      input.repoId,
    );

    const updated = this.getArtifact(input.id);
    if (!updated || updated.type !== "plan") {
      throw new Error(`Plan artifact not found after save: ${input.id}`);
    }
    return updated as Artifact<PlanArtifactBody>;
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

    const activeRun = this.db.exec(
      `
        SELECT run_id FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ?
          AND status IN ('queued', 'running', 'saving')
        LIMIT 1
      `,
      input.repoId,
      input.id,
    ).toArray()[0] as unknown as { run_id: string } | undefined;
    if (activeRun) {
      throw new Error(`Plan has an active planner run (${activeRun.run_id}). Stop or cancel it before deleting the plan.`);
    }
    const retainedRunRuntime = this.db.exec(
      `
        SELECT run_id FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ?
          AND runtime_json IS NOT NULL
        LIMIT 1
      `,
      input.repoId,
      input.id,
    ).toArray()[0] as unknown as { run_id: string } | undefined;
    if (retainedRunRuntime) {
      throw new Error(
        `Planner run ${retainedRunRuntime.run_id} retains runtime provenance. Clean it up before deleting the plan.`,
      );
    }
    const liveWriter = this.getPlanWriter(input.repoId, input.id);
    if (liveWriter && !liveWriter.stoppedAt) {
      throw new Error("Stop the Plan Writer before deleting the plan.");
    }
    const runtimeOwner = this.db.exec(
      `
        SELECT thread_id FROM reviewer_registry
        WHERE repo_id = ? AND plan_artifact_id = ?
          AND (runtime_json IS NOT NULL OR job_slug IS NOT NULL)
        LIMIT 1
      `,
      input.repoId,
      input.id,
    ).toArray()[0] as unknown as { thread_id: string } | undefined;
    if (runtimeOwner) {
      throw new Error(`Plan Writer ${runtimeOwner.thread_id} retains runtime provenance. Clean it up before deleting the plan.`);
    }

    this.db.exec("DELETE FROM refs WHERE repo_id = ? AND artifact_id = ?", input.repoId, input.id);
    this.db.exec("DELETE FROM reviewer_registry WHERE repo_id = ? AND plan_artifact_id = ?", input.repoId, input.id);
    const runRows = this.db.exec(
      "SELECT run_id FROM planner_runs WHERE repo_id = ? AND plan_artifact_id = ?",
      input.repoId,
      input.id,
    ).toArray() as unknown as Array<{ run_id: string }>;
    for (const row of runRows) {
      this.db.exec("DELETE FROM planner_run_events WHERE run_id = ?", row.run_id);
    }
    this.db.exec("DELETE FROM planner_runs WHERE repo_id = ? AND plan_artifact_id = ?", input.repoId, input.id);
    this.db.exec("DELETE FROM plan_contributions WHERE repo_id = ? AND plan_artifact_id = ?", input.repoId, input.id);
    this.db.exec("DELETE FROM artifacts WHERE repo_id = ? AND id = ?", input.repoId, input.id);

    return existing as Artifact<PlanArtifactBody>;
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
          AND (role IS NULL OR role = 'reviewer')
          AND skill_invocation_id IS NULL
          ${options.includeRemoved ? "" : "AND removed_at IS NULL"}
        ORDER BY created_at ASC, rowid ASC
      `,
      repoId,
      planArtifactId,
    ).toArray() as unknown as ReviewerRegistryRow[];
    return rows.map((row) => this.parseReviewerRegistryRow(row));
  }

  getPlanWriter(repoId: string, planArtifactId: string): ReviewerRegistryEntry | null {
    const writer = this.getReviewer(`plan-writer-${planArtifactId}`);
    return writer
      && writer.role === "writer"
      && writer.repoId === repoId
      && writer.planArtifactId === planArtifactId
      ? writer
      : null;
  }

  acceptPlanWriterCodexRuntimeAuth(input: {
    repoId: string;
    planArtifactId: string;
    generation: number;
    accountId: string;
  }): "accepted" | "inactive" | "account_changed" {
    const accountId = input.accountId.trim();
    const writer = this.getPlanWriter(input.repoId, input.planArtifactId);
    const profile = writer?.launchProvenance?.codexExecution;
    if (
      !accountId
      || !writer
      || writer.generation !== input.generation
      || writer.stoppedAt
      || writer.startupError
      || writer.cleanupError
      || !writer.runtime
      || profile?.kind !== "subscription-app-server"
      || profile.surface !== "plan-writer"
    ) return "inactive";
    const accountRow = this.db.exec(
      "SELECT codex_account_id FROM reviewer_registry WHERE thread_id = ?",
      writer.threadId,
    ).toArray()[0] as { codex_account_id: string | null } | undefined;
    if (accountRow?.codex_account_id && accountRow.codex_account_id !== accountId) {
      return "account_changed";
    }
    if (!accountRow?.codex_account_id) {
      this.db.exec(
        `UPDATE reviewer_registry SET codex_account_id = ?
         WHERE thread_id = ? AND generation = ? AND stopped_at IS NULL
           AND codex_account_id IS NULL`,
        accountId,
        writer.threadId,
        input.generation,
      );
    }
    return "accepted";
  }

  /**
   * Reserve exactly one next generation. ArtifactStore DO serialization makes
   * concurrent and retried Start calls converge on the same active row.
   */
  startPlanWriter(input: {
    repoId: string;
    planArtifactId: string;
    provider: "claude-code" | "codex";
    model: string;
    effort?: PlannerEffort;
    fastMode?: boolean;
    basisCommit: string;
    startBodyDigest: string;
    launchProvenance: PlanWriterLaunchProvenance;
  }): ReviewerRegistryEntry {
    this.assertRepositoryWritable();
    const plan = this.getArtifact(input.planArtifactId);
    if (!plan || plan.repoId !== input.repoId || plan.type !== "plan") {
      throw new Error(`Plan artifact not found: ${input.planArtifactId}`);
    }
    if (plan.status === "completed" || plan.status === "archived") {
      throw new Error("Completed or archived plans cannot start a writer.");
    }
    const frozenBasisCommit = plan.basis.mainCommit?.trim() ?? "";
    if (!frozenBasisCommit || frozenBasisCommit !== input.basisCommit.trim()) {
      throw new Error("The plan requires its frozen basis commit before a writer can start.");
    }
    const model = input.model.trim();
    const startBodyDigest = input.startBodyDigest.trim().toLowerCase();
    if (!model || !/^[a-f0-9]{64}$/u.test(startBodyDigest)) {
      throw new Error("A model and SHA-256 starting plan digest are required.");
    }
    if (!isCurrentLaunchProvenance(input.launchProvenance)) {
      throw new Error("Plan Writer launch provenance is not from the current workload schema.");
    }

    const existing = this.getPlanWriter(input.repoId, input.planArtifactId);
    if (existing && !existing.stoppedAt && !existing.startupError && !existing.cleanupError) {
      return existing;
    }
    if (existing?.runtime || existing?.jobSlug) {
      throw new Error("Exact cleanup of the previous writer runtime is required before Start.");
    }

    const now = new Date().toISOString();
    const generation = (existing?.generation ?? 0) + 1;
    const threadId = `plan-writer-${input.planArtifactId}`;
    if (!existing) {
      this.db.exec(
        `
          INSERT INTO reviewer_registry (
            thread_id, plan_artifact_id, repo_id, provider, model, effort, fast_mode, role, status,
            reviewer_model, removed_at, created_at, updated_at, generation,
            stopped_at, stop_reason, basis_commit, start_body_digest,
            publication_cursor_json, synchronization_error, startup_error, cleanup_error,
            launch_provenance_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'writer', 'queued', ?, NULL, ?, ?, 1,
            NULL, NULL, ?, ?, NULL, NULL, NULL, NULL, ?)
        `,
        threadId,
        input.planArtifactId,
        input.repoId,
        input.provider,
        model,
        input.effort ?? null,
        input.fastMode ? 1 : 0,
        model,
        now,
        now,
        frozenBasisCommit,
        startBodyDigest,
        JSON.stringify(input.launchProvenance),
      );
    } else {
      this.db.exec(
        `
          UPDATE reviewer_registry
          SET provider = ?, model = ?, effort = ?, fast_mode = ?, reviewer_model = ?, status = 'queued', error = NULL,
              run_id = NULL, provider_conversation_id = NULL, job_slug = NULL,
              generation = ?, stopped_at = NULL, stop_reason = NULL,
              basis_commit = ?, start_body_digest = ?, publication_cursor_json = NULL,
              synchronization_error = NULL, startup_error = NULL, cleanup_error = NULL,
              launch_provenance_json = ?, codex_account_id = NULL, removed_at = NULL, updated_at = ?
          WHERE thread_id = ?
        `,
        input.provider,
        model,
        input.effort ?? null,
        input.fastMode ? 1 : 0,
        model,
        generation,
        frozenBasisCommit,
        startBodyDigest,
        JSON.stringify(input.launchProvenance),
        now,
        threadId,
      );
    }
    return this.getPlanWriter(input.repoId, input.planArtifactId)!;
  }

  registerPlanWriterRuntime(input: {
    repoId: string;
    planArtifactId: string;
    generation: number;
    runtime: PlanWriterRuntimeProvenance;
    providerConversationId: string;
  }): ReviewerRegistryEntry | null {
    const existing = this.getPlanWriter(input.repoId, input.planArtifactId);
    const providerConversationId = input.providerConversationId.trim();
    if (
      !existing
      || existing.stoppedAt
      || existing.startupError
      || existing.cleanupError
      || existing.generation !== input.generation
      || input.runtime.generation !== input.generation
      || !existing.runtime
      || !samePlanWriterRuntime(existing.runtime, input.runtime)
      || !existing.basisCommit
      || !providerConversationId
    ) {
      return null;
    }
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET job_slug = ?, runtime_json = ?, provider_conversation_id = ?,
            status = 'running', updated_at = ?
        WHERE thread_id = ? AND stopped_at IS NULL AND generation = ?
          AND job_slug = ? AND startup_error IS NULL AND cleanup_error IS NULL
      `,
      input.runtime.jobSlug,
      JSON.stringify(input.runtime),
      providerConversationId,
      now,
      existing.threadId,
      input.generation,
      input.runtime.jobSlug,
    );
    const updated = this.getPlanWriter(input.repoId, input.planArtifactId);
    return updated?.runtime?.jobSlug === input.runtime.jobSlug ? updated : null;
  }

  fencePlanWriterStop(input: {
    repoId: string;
    planArtifactId: string;
    expectedGeneration: number;
    reason: PlanWriterStopReason;
  }): { status: "stopped" | "stale" | "not_found"; writer: ReviewerRegistryEntry | null } {
    const existing = this.getPlanWriter(input.repoId, input.planArtifactId);
    if (!existing) return { status: "not_found", writer: null };
    if (existing.generation !== input.expectedGeneration) {
      return { status: "stale", writer: existing };
    }
    if (existing.stoppedAt) return { status: "stopped", writer: existing };
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET stopped_at = ?, stop_reason = ?,
            status = 'cancelled', updated_at = ?
        WHERE thread_id = ? AND generation = ? AND stopped_at IS NULL
      `,
      now,
      input.reason,
      now,
      existing.threadId,
      input.expectedGeneration,
    );
    return {
      status: "stopped",
      writer: this.getPlanWriter(input.repoId, input.planArtifactId),
    };
  }

  setPlanWriterError(input: {
    repoId: string;
    planArtifactId: string;
    generation: number;
    kind: "startup" | "cleanup" | "synchronization";
    error: string | null;
  }): ReviewerRegistryEntry | null {
    const existing = this.getPlanWriter(input.repoId, input.planArtifactId);
    if (!existing || existing.generation !== input.generation) return null;
    const column = input.kind === "startup"
      ? "startup_error"
      : input.kind === "cleanup"
        ? "cleanup_error"
        : "synchronization_error";
    const error = input.error?.trim() || null;
    const stoppedAt = input.kind === "startup" && error ? new Date().toISOString() : null;
    this.db.exec(
      `UPDATE reviewer_registry SET ${column} = ?, stopped_at = COALESCE(?, stopped_at),
       stop_reason = CASE WHEN ? IS NOT NULL AND stopped_at IS NULL THEN 'runtime_ended' ELSE stop_reason END, updated_at = ?
       WHERE thread_id = ? AND generation = ?`,
      error,
      stoppedAt,
      stoppedAt,
      new Date().toISOString(),
      existing.threadId,
      input.generation,
    );
    return this.getPlanWriter(input.repoId, input.planArtifactId);
  }

  async publishObservedPlan(input: ObservedPlanPublication): Promise<PublishObservedPlanResult> {
    const writer = this.getPlanWriter(input.repoId, input.planArtifactId);
    if (!writer) return { status: "rejected", reason: "writer_not_found" };
    const cursor = writer.publicationCursor;

    // The exact current cursor remains replayable after fencing or a status
    // change so a lost response can repair the managed context safely.
    if (cursor && input.sequence === cursor.sequence && input.providerEventId === cursor.providerEventId) {
      if (writer.generation !== input.generation) {
        return { status: "rejected", reason: "generation_mismatch" };
      }
      if (writer.providerConversationId !== input.providerConversationId) {
        return { status: "rejected", reason: "conversation_mismatch" };
      }
      if (input.bodyDigest !== cursor.bodyDigest) {
        return { status: "rejected", reason: "cursor_payload_mismatch" };
      }
      const replayArtifact = this.getArtifact(input.planArtifactId);
      if (!replayArtifact || replayArtifact.type !== "plan") {
        return { status: "rejected", reason: "writer_not_found" };
      }
      return {
        status: "replayed",
        artifactVersion: cursor.artifactVersion,
        cursor,
        artifact: replayArtifact as Artifact<PlanArtifactBody>,
      };
    }
    if (writer.generation !== input.generation) {
      return { status: "rejected", reason: "generation_mismatch" };
    }
    if (writer.stoppedAt || !writer.runtime) {
      return { status: "rejected", reason: "writer_not_running" };
    }
    if (writer.providerConversationId !== input.providerConversationId) {
      return { status: "rejected", reason: "conversation_mismatch" };
    }
    const expectedSequence = (cursor?.sequence ?? 0) + 1;
    if (input.sequence !== expectedSequence) {
      return { status: "rejected", reason: "sequence_mismatch", expectedSequence };
    }
    const artifact = this.getArtifact(input.planArtifactId);
    if (!artifact || artifact.repoId !== input.repoId || artifact.type !== "plan") {
      return { status: "rejected", reason: "writer_not_found" };
    }
    if (artifact.status === "completed" || artifact.status === "archived") {
      return { status: "rejected", reason: "plan_ineligible" };
    }

    const canonicalCurrent = renderArtifactBodyMarkdown(artifact.body)
      .replace(/\r\n?/g, "\n")
      .replace(/(?:\n[ \t]*)+$/u, "");
    const currentMarkdown = canonicalCurrent ? `${canonicalCurrent}\n` : "";
    const unchanged = currentMarkdown === input.markdown;
    const currentVersion = artifact.version ?? 1;
    const artifactVersion = unchanged ? currentVersion : currentVersion + 1;
    const nextCursor: WriterPublicationCursor = {
      sequence: input.sequence,
      providerEventId: input.providerEventId,
      bodyDigest: input.bodyDigest,
      artifactVersion,
      result: unchanged ? "unchanged" : "updated",
    };
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      if (!unchanged) {
        const derivedTitle = derivePlanTitleFromMarkdown(input.markdown);
        this.db.exec(
          `UPDATE artifacts SET body_json = ?, title = CASE WHEN ? != '' THEN ? ELSE title END,
           version = ?, updated_at = ? WHERE id = ? AND repo_id = ?`,
          JSON.stringify({ markdown: input.markdown }),
          derivedTitle,
          derivedTitle,
          artifactVersion,
          now,
          input.planArtifactId,
          input.repoId,
        );
      }
      this.db.exec(
        `UPDATE reviewer_registry SET publication_cursor_json = ?, synchronization_error = NULL, updated_at = ?
         WHERE thread_id = ? AND generation = ?`,
        JSON.stringify(nextCursor),
        now,
        writer.threadId,
        input.generation,
      );
    });
    return {
      status: nextCursor.result,
      artifactVersion,
      cursor: nextCursor,
      artifact: this.getArtifact(input.planArtifactId) as Artifact<PlanArtifactBody>,
    };
  }

  setPlanWriterRuntimeIfCurrent(
    threadId: string,
    runtime: PlanWriterRuntimeProvenance,
  ): ReviewerRegistryEntry | null {
    if (!isCurrentPlanWriterRuntimeProvenance(runtime)) {
      throw new Error("Plan Writer runtime provenance is not from the current workload schema.");
    }
    const existing = this.getReviewer(threadId);
    if (
      !existing
      || existing.role !== "writer"
      || existing.removedAt
      || existing.stoppedAt
      || (existing.generation ?? 0) !== runtime.generation
      || existing.runtime
      || existing.jobSlug
    ) {
      return null;
    }
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET job_slug = ?,
            runtime_json = ?,
            provider_conversation_id = NULL,
            updated_at = ?
        WHERE thread_id = ?
          AND removed_at IS NULL
          AND stopped_at IS NULL
          AND COALESCE(generation, 0) = ?
          AND runtime_json IS NULL
          AND job_slug IS NULL
      `,
      runtime.jobSlug,
      JSON.stringify(runtime),
      now,
      threadId,
      runtime.generation,
    );
    const updated = this.getReviewer(threadId);
    return updated?.runtime?.jobSlug === runtime.jobSlug
      && updated.runtime.generation === runtime.generation
      ? updated
      : null;
  }

  clearPlanWriterRuntimeIfCurrent(
    threadId: string,
    runtime: PlanWriterRuntimeProvenance,
  ): ReviewerRegistryEntry | null {
    const existing = this.getReviewer(threadId);
    if (existing?.role !== "writer" || !existing.runtime || !samePlanWriterRuntime(existing.runtime, runtime)) return null;
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET runtime_json = NULL,
            job_slug = NULL,
            cleanup_error = NULL,
            updated_at = ?
        WHERE thread_id = ?
          AND COALESCE(generation, 0) = ?
          AND job_slug = ?
      `,
      new Date().toISOString(),
      threadId,
      runtime.generation,
      runtime.jobSlug,
    );
    return this.getReviewer(threadId);
  }

  getReviewer(threadId: string): ReviewerRegistryEntry | null {
    const row = this.db.exec(
      "SELECT * FROM reviewer_registry WHERE thread_id = ?",
      threadId,
    ).toArray()[0] as unknown as ReviewerRegistryRow | undefined;
    return row ? this.parseReviewerRegistryRow(row) : null;
  }

  upsertReviewer(input: UpsertReviewerInput): ReviewerRegistryEntry {
    this.assertRepositoryWritable();
    const now = new Date().toISOString();
    const threadId = input.threadId ?? crypto.randomUUID();
    const reviewerModel = input.reviewerModel ?? input.model;
    this.db.exec(
      `
        INSERT INTO reviewer_registry (
          thread_id, plan_artifact_id, repo_id, provider, model, effort, skill, role, status,
          reviewer_model, removed_at, created_at, updated_at, skill_invocation_id, skill_agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewer', 'queued', ?, NULL, ?, ?, ?, ?)
      `,
      threadId,
      input.planArtifactId,
      input.repoId,
      input.provider,
      input.model,
      input.effort ?? null,
      input.skill ?? null,
      reviewerModel,
      now,
      now,
      input.skillInvocationId ?? null,
      input.skillAgentId ?? null,
    );
    const created = this.getReviewer(threadId);
    if (!created) {
      throw new Error(`Reviewer registry row not found after insert: ${threadId}`);
    }
    return created;
  }

  updateReviewerRunState(input: {
    repoId: string;
    planArtifactId: string;
    threadId: string;
    runId?: string | null;
    status?: PlannerRunStatus | null;
    error?: string | null;
  }): ReviewerRegistryEntry {
    const existing = this.getReviewer(input.threadId);
    if (!existing || existing.repoId !== input.repoId || existing.planArtifactId !== input.planArtifactId) {
      throw new Error(`Reviewer registry row not found: ${input.threadId}`);
    }
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET run_id = COALESCE(?, run_id),
            status = COALESCE(?, status),
            error = ?,
            updated_at = ?
        WHERE thread_id = ?
      `,
      input.runId ?? null,
      input.status ?? null,
      input.error ?? null,
      now,
      input.threadId,
    );
    const updated = this.getReviewer(input.threadId);
    if (!updated) {
      throw new Error(`Reviewer registry row not found after update: ${input.threadId}`);
    }
    return updated;
  }

  updateReviewerRunStateIfCurrent(input: {
    repoId: string;
    planArtifactId: string;
    threadId: string;
    runId: string;
    status?: PlannerRunStatus | null;
    error?: string | null;
  }): ReviewerRegistryEntry | null {
    const existing = this.getReviewer(input.threadId);
    if (
      !existing
      || existing.repoId !== input.repoId
      || existing.planArtifactId !== input.planArtifactId
      || existing.runId !== input.runId
    ) {
      return null;
    }
    return this.updateReviewerRunState(input);
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

  getRepoPlanWriterSettings(
    repoId: string,
    defaults: { routeKey: string; effort: PlannerEffort; planFormat: string },
  ): RepoPlanWriterSettings {
    const row = this.db.exec(
      "SELECT * FROM repo_plan_writer_settings WHERE repo_id = ?",
      repoId,
    ).toArray()[0] as unknown as RepoPlanWriterSettingsRow | undefined;
    return {
      repoId,
      routeKey: row?.route_key?.trim() || defaults.routeKey,
      effort: isPlannerEffort(row?.effort) ? row.effort : defaults.effort,
      fastMode: row?.fast_mode === 1,
      planFormat: row?.plan_format?.trim() || defaults.planFormat,
      updatedAt: row?.updated_at ?? null,
    };
  }

  setRepoPlanWriterSettings(input: {
    repoId: string;
    routeKey: string;
    effort: PlannerEffort;
    fastMode: boolean;
    planFormat: string;
  }): RepoPlanWriterSettings {
    this.assertRepositoryWritable();
    const routeKey = input.routeKey.trim();
    const planFormat = input.planFormat.trim();
    if (!routeKey || !isPlannerEffort(input.effort) || !planFormat) {
      throw new Error("routeKey, effort, and planFormat are required");
    }
    const now = new Date().toISOString();
    this.db.exec(
      `
        INSERT INTO repo_plan_writer_settings (
          repo_id, updated_at, route_key, effort, fast_mode, plan_format
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id) DO UPDATE SET
          route_key = excluded.route_key,
          effort = excluded.effort,
          fast_mode = excluded.fast_mode,
          plan_format = excluded.plan_format,
          updated_at = excluded.updated_at
      `,
      input.repoId,
      now,
      routeKey,
      input.effort,
      input.fastMode ? 1 : 0,
      planFormat,
    );
    return this.getRepoPlanWriterSettings(input.repoId, { routeKey, effort: input.effort, planFormat });
  }

  listStoredAgentSkills(repoId: string, surface: SkillSurface): AgentSkillDefinition[] {
    const rows = this.db.exec(
      `
        SELECT * FROM planning_skills
        WHERE repo_id = ? AND surface = ? AND definition_json IS NOT NULL
        ORDER BY kind ASC, command ASC, created_at ASC
      `,
      repoId,
      surface,
    ).toArray() as unknown as AgentSkillRow[];
    return rows.flatMap((row) => {
      try {
        const definition = JSON.parse(row.definition_json ?? "null") as AgentSkillDefinition | null;
        return definition ? [{
          ...definition,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          customized: true,
        }] : [];
      } catch {
        return [];
      }
    });
  }

  getStoredAgentSkill(repoId: string, surface: SkillSurface, skillId: string): AgentSkillDefinition | null {
    return this.listStoredAgentSkills(repoId, surface).find((skill) => skill.id === skillId) ?? null;
  }

  upsertStoredAgentSkill(input: {
    repoId: string;
    definition: AgentSkillDefinition;
  }): AgentSkillDefinition {
    this.assertRepositoryWritable();
    const existing = this.getStoredAgentSkill(input.repoId, input.definition.surface, input.definition.id);
    const now = new Date().toISOString();
    const createdAt = existing?.createdAt ?? now;
    const definition: AgentSkillDefinition = {
      ...input.definition,
      customized: true,
      createdAt,
      updatedAt: now,
      agents: input.definition.agents.map((agent) => ({ ...agent })),
    };
    this.db.exec(
      `
        INSERT INTO planning_skills (
          repo_id, id, command, label, description, instructions, kind,
          created_at, updated_at, surface, definition_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(repo_id, id) DO UPDATE SET
          command = excluded.command,
          label = excluded.label,
          description = excluded.description,
          instructions = excluded.instructions,
          kind = excluded.kind,
          updated_at = excluded.updated_at,
          surface = excluded.surface,
          definition_json = excluded.definition_json
      `,
      input.repoId,
      definition.id,
      definition.command,
      definition.label,
      definition.description,
      definition.sharedInstructions,
      definition.origin,
      createdAt,
      now,
      definition.surface,
      JSON.stringify(definition),
    );
    const updated = this.getStoredAgentSkill(input.repoId, definition.surface, definition.id);
    if (!updated) throw new Error(`Agent skill row not found after upsert: ${definition.id}`);
    return updated;
  }

  deleteStoredAgentSkill(repoId: string, surface: SkillSurface, skillId: string): AgentSkillDefinition | null {
    const existing = this.getStoredAgentSkill(repoId, surface, skillId);
    if (!existing) return null;
    this.db.exec(
      "DELETE FROM planning_skills WHERE repo_id = ? AND surface = ? AND id = ?",
      repoId,
      surface,
      skillId,
    );
    return existing;
  }

  getPlanSkillInvocation(invocationId: string): PlanSkillInvocation | null {
    const row = this.db.exec(
      "SELECT * FROM plan_skill_invocations WHERE invocation_id = ?",
      invocationId,
    ).toArray()[0] as unknown as PlanSkillInvocationRow | undefined;
    return row ? this.parsePlanSkillInvocationRow(row) : null;
  }

  listPlanSkillInvocations(input: {
    repoId: string;
    planArtifactId: string;
    limit?: number;
    cursor?: { createdAt: string; invocationId: string } | null;
  }): PlanSkillInvocation[] {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const rows = input.cursor
      ? this.db.exec(
        `
          SELECT * FROM plan_skill_invocations
          WHERE repo_id = ? AND plan_artifact_id = ?
            AND (created_at < ? OR (created_at = ? AND invocation_id < ?))
          ORDER BY created_at DESC, invocation_id DESC
          LIMIT ?
        `,
        input.repoId,
        input.planArtifactId,
        input.cursor.createdAt,
        input.cursor.createdAt,
        input.cursor.invocationId,
        limit,
      ).toArray()
      : this.db.exec(
        `
          SELECT * FROM plan_skill_invocations
          WHERE repo_id = ? AND plan_artifact_id = ?
          ORDER BY created_at DESC, invocation_id DESC
          LIMIT ?
        `,
        input.repoId,
        input.planArtifactId,
        limit,
      ).toArray();
    return (rows as unknown as PlanSkillInvocationRow[]).map((row) => this.parsePlanSkillInvocationRow(row));
  }

  listPlanSkillInvocationReviewers(invocationId: string): ReviewerRegistryEntry[] {
    const rows = this.db.exec(
      "SELECT * FROM reviewer_registry WHERE skill_invocation_id = ? ORDER BY created_at ASC, thread_id ASC",
      invocationId,
    ).toArray() as unknown as ReviewerRegistryRow[];
    return rows.map((row) => this.parseReviewerRegistryRow(row));
  }

  listPlanSkillInvocationRuns(invocationId: string): PlannerRun[] {
    const rows = this.db.exec(
      "SELECT * FROM planner_runs WHERE skill_invocation_id = ? ORDER BY started_at ASC, run_id ASC",
      invocationId,
    ).toArray() as unknown as PlannerRunRow[];
    return rows.map((row) => this.parsePlannerRunRow(row));
  }

  reservePlanSkillInvocation(input: {
    invocationId: string;
    repoId: string;
    planArtifactId: string;
    parentThreadId: string;
    definitionSnapshot: AgentSkillDefinition;
    basis: PlannerRunBasis;
    agents: Array<{
      id: string;
      provider: string;
      model: string;
      launchProvenance: PlannerRunLaunchProvenance;
    }>;
  }):
    | { status: "created"; invocation: PlanSkillInvocation; reviewers: ReviewerRegistryEntry[]; runs: PlannerRun[] }
    | { status: "existing"; invocation: PlanSkillInvocation; reviewers: ReviewerRegistryEntry[]; runs: PlannerRun[] }
    | { status: "conflict"; invocation: PlanSkillInvocation } {
    this.assertRepositoryWritable();
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getPlanSkillInvocation(input.invocationId);
      if (existing) {
        if (
          existing.repoId !== input.repoId
          || existing.planArtifactId !== input.planArtifactId
          || existing.parentThreadId !== input.parentThreadId
          || existing.definitionSnapshot.id !== input.definitionSnapshot.id
        ) {
          return { status: "conflict" as const, invocation: existing };
        }
        return {
          status: "existing" as const,
          invocation: existing,
          reviewers: this.listPlanSkillInvocationReviewers(existing.invocationId),
          runs: this.listPlanSkillInvocationRuns(existing.invocationId),
        };
      }
      const now = new Date().toISOString();
      this.db.exec(
        `
          INSERT INTO plan_skill_invocations (
            invocation_id, repo_id, plan_artifact_id, parent_thread_id,
            definition_snapshot_json, basis_json, status, error, cancelled_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'setting_up', NULL, NULL, ?, ?)
        `,
        input.invocationId,
        input.repoId,
        input.planArtifactId,
        input.parentThreadId,
        JSON.stringify(input.definitionSnapshot),
        JSON.stringify(input.basis),
        now,
        now,
      );
      for (const agent of input.agents) {
        const definition = input.definitionSnapshot.agents.find((candidate) => candidate.id === agent.id);
        if (!definition) throw new Error(`Skill agent not found: ${agent.id}`);
        const threadId = `plan-skill:${input.invocationId}:${crypto.randomUUID()}`;
        const reviewer = this.upsertReviewer({
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          provider: agent.provider,
          model: agent.model,
          effort: definition.effort,
          skill: input.definitionSnapshot.command,
          threadId,
          skillInvocationId: input.invocationId,
          skillAgentId: agent.id,
        });
        const instructions = [
          input.definitionSnapshot.sharedInstructions,
          definition.instructions,
        ].filter(Boolean).join("\n\n");
        const run = this.createPlannerRun({
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          role: "reviewer",
          provider: agent.provider,
          model: agent.model,
          skill: input.definitionSnapshot.command,
          threadId,
          skillInvocationId: input.invocationId,
          skillAgentId: agent.id,
          skillRunRole: "child_initial",
          launchProvenance: agent.launchProvenance,
          input: {
            instruction: `Run /${input.definitionSnapshot.command} as ${definition.label}.`,
            effort: definition.effort,
            sourcePlanVersion: input.basis.version,
            githubBaseCommitSha: input.basis.gitBaseCommitSha,
            basis: input.basis,
            skillDefinitionSnapshot: input.definitionSnapshot,
            skillSnapshot: {
              id: input.definitionSnapshot.id,
              command: input.definitionSnapshot.command,
              label: input.definitionSnapshot.label,
              instructions,
            },
          },
        });
        this.updateReviewerRunState({
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          threadId: reviewer.threadId,
          runId: run.runId,
          status: "queued",
          error: null,
        });
      }
      const invocation = this.getPlanSkillInvocation(input.invocationId);
      if (!invocation) throw new Error("Failed to reserve plan skill invocation.");
      return {
        status: "created" as const,
        invocation,
        reviewers: this.listPlanSkillInvocationReviewers(input.invocationId),
        runs: this.listPlanSkillInvocationRuns(input.invocationId),
      };
    });
  }

  activatePlanSkillInvocation(invocationId: string): PlanSkillInvocation | null {
    const existing = this.getPlanSkillInvocation(invocationId);
    if (!existing || existing.status !== "setting_up") return existing;
    this.db.exec(
      "UPDATE plan_skill_invocations SET status = 'active', updated_at = ? WHERE invocation_id = ? AND status = 'setting_up'",
      new Date().toISOString(),
      invocationId,
    );
    return this.getPlanSkillInvocation(invocationId);
  }

  failPlanSkillInvocation(invocationId: string, error: string): PlanSkillInvocation | null {
    const existing = this.getPlanSkillInvocation(invocationId);
    if (!existing || existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") return existing;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.db.exec(
        "UPDATE plan_skill_invocations SET status = 'failed', error = ?, updated_at = ? WHERE invocation_id = ?",
        error,
        now,
        invocationId,
      );
      this.db.exec(
        `
          UPDATE planner_runs
          SET status = 'cancelled', completed_at = ?, error = ?
          WHERE skill_invocation_id = ? AND status IN ('queued', 'running', 'saving')
        `,
        now,
        error,
        invocationId,
      );
      this.db.exec(
        `
          UPDATE reviewer_registry
          SET status = 'cancelled', error = ?, updated_at = ?
          WHERE skill_invocation_id = ? AND status IN ('queued', 'running', 'saving')
        `,
        error,
        now,
        invocationId,
      );
    });
    return this.getPlanSkillInvocation(invocationId);
  }

  failStalePlanSkillInvocations(repoId: string, planArtifactId: string, cutoffIso: string): PlanSkillInvocation[] {
    const rows = this.db.exec(
      `
        SELECT * FROM plan_skill_invocations
        WHERE repo_id = ? AND plan_artifact_id = ? AND status = 'setting_up' AND created_at < ?
      `,
      repoId,
      planArtifactId,
      cutoffIso,
    ).toArray() as unknown as PlanSkillInvocationRow[];
    return rows.map((row) => this.failPlanSkillInvocation(
      row.invocation_id,
      "Skill setup timed out before all child threads were ready.",
    )).filter((invocation): invocation is PlanSkillInvocation => Boolean(invocation));
  }

  cancelPlanSkillInvocation(invocationId: string): PlanSkillInvocation | null {
    const existing = this.getPlanSkillInvocation(invocationId);
    if (!existing || existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") return existing;
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      this.db.exec(
        "UPDATE plan_skill_invocations SET status = 'cancelled', cancelled_at = ?, updated_at = ? WHERE invocation_id = ?",
        now,
        now,
        invocationId,
      );
      this.db.exec(
        `
          UPDATE planner_runs SET status = 'cancelled', completed_at = ?, error = 'Skill invocation cancelled.'
          WHERE skill_invocation_id = ? AND status IN ('queued', 'running', 'saving')
        `,
        now,
        invocationId,
      );
      this.db.exec(
        `
          UPDATE reviewer_registry SET status = 'cancelled', error = NULL, updated_at = ?
          WHERE skill_invocation_id = ? AND status IN ('queued', 'running', 'saving')
        `,
        now,
        invocationId,
      );
    });
    return this.getPlanSkillInvocation(invocationId);
  }

  private refreshPlanSkillInvocationStatus(invocationId: string): void {
    const invocation = this.getPlanSkillInvocation(invocationId);
    if (!invocation || invocation.status !== "active") return;
    const runs = this.listPlanSkillInvocationRuns(invocationId)
      .filter((run) => run.skillRunRole === "child_initial");
    if (runs.length === 0 || runs.some((run) => isPlannerRunStatus(run.status) && ["queued", "running", "saving"].includes(run.status))) {
      return;
    }
    const succeeded = runs.some((run) => run.status === "completed");
    this.db.exec(
      "UPDATE plan_skill_invocations SET status = ?, error = ?, updated_at = ? WHERE invocation_id = ? AND status = 'active'",
      succeeded ? "completed" : "failed",
      succeeded ? null : "All child reviewers failed or were cancelled.",
      new Date().toISOString(),
      invocationId,
    );
  }

  createPlanContribution(input: CreatePlanContributionInput): PlanContribution {
    this.assertRepositoryWritable();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const idempotencyKey = input.idempotencyKey ?? `manual:${crypto.randomUUID()}`;
    const contribution: PlanContribution = {
      id: input.id ?? crypto.randomUUID(),
      repoId: input.repoId,
      planArtifactId: input.planArtifactId,
      sourceKind: input.sourceKind ?? "manual",
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      ...(typeof input.sourcePlanVersion === "number" ? { sourcePlanVersion: input.sourcePlanVersion } : {}),
      provider: input.provider,
      model: input.model,
      ...(input.skill ? { skill: input.skill } : {}),
      text: input.text,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
    };

    this.db.exec(
      `
        INSERT INTO plan_contributions (
          id, repo_id, plan_artifact_id, source_kind, source_run_id, source_thread_id,
          source_message_id, source_plan_version, idempotency_key,
          provider, model, skill, text, status, created_at, updated_at, incorporated_at, dismissed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
      `,
      contribution.id,
      contribution.repoId,
      contribution.planArtifactId,
      contribution.sourceKind,
      contribution.sourceRunId ?? null,
      contribution.sourceThreadId ?? null,
      contribution.sourceMessageId ?? null,
      contribution.sourcePlanVersion ?? null,
      idempotencyKey,
      contribution.provider,
      contribution.model,
      contribution.skill ?? null,
      contribution.text,
      contribution.createdAt,
      contribution.updatedAt,
    );

    return contribution;
  }

  createOrGetPlanContribution(input: CreatePlanContributionInput & { idempotencyKey: string }): CreateOrGetPlanContributionResult {
    this.assertRepositoryWritable();
    const textDigest = hashString(input.text);
    const existingRow = this.db.exec(
      `
        SELECT *
        FROM plan_contributions
        WHERE repo_id = ? AND plan_artifact_id = ? AND idempotency_key = ?
        LIMIT 1
      `,
      input.repoId,
      input.planArtifactId,
      input.idempotencyKey,
    ).toArray()[0] as unknown as PlanContributionRow | undefined;
    if (existingRow) {
      const contribution = this.parsePlanContributionRow(existingRow);
      if (existingRow.text !== input.text) {
        return {
          status: "conflict",
          contribution,
          expectedDigest: hashString(existingRow.text),
          actualDigest: textDigest,
        };
      }
      return { status: "existing", contribution };
    }
    return {
      status: "created",
      contribution: this.createPlanContribution(input),
    };
  }

  listPlanContributions(
    repoId: string,
    planArtifactId: string,
    filter: PlanContributionListFilter = {},
  ): PlanContribution[] {
    const values: Array<string | number> = [repoId, planArtifactId];
    const statusClause = filter.status ? "AND status = ?" : "";
    if (filter.status) values.push(filter.status);
    const rows = this.db.exec(
      `
        SELECT *
        FROM plan_contributions
        WHERE repo_id = ? AND plan_artifact_id = ?
          ${statusClause}
        ORDER BY created_at ASC, rowid ASC
      `,
      ...values,
    ).toArray() as unknown as PlanContributionRow[];
    return rows.map((row) => this.parsePlanContributionRow(row));
  }

  getPlanContribution(id: string): PlanContribution | null {
    const row = this.db.exec(
      "SELECT * FROM plan_contributions WHERE id = ?",
      id,
    ).toArray()[0] as unknown as PlanContributionRow | undefined;
    return row ? this.parsePlanContributionRow(row) : null;
  }

  dismissPlanContribution(repoId: string, planArtifactId: string, contributionId: string): PlanContribution {
    const existing = this.getPlanContribution(contributionId);
    if (!existing || existing.repoId !== repoId || existing.planArtifactId !== planArtifactId) {
      throw new Error(`Plan contribution not found: ${contributionId}`);
    }
    if (existing.status !== "pending") {
      throw new Error("Only pending contributions can be dismissed");
    }
    const now = new Date().toISOString();
    this.db.exec(
      `
        UPDATE plan_contributions
        SET status = 'dismissed', dismissed_at = ?, updated_at = ?
        WHERE id = ?
      `,
      now,
      now,
      contributionId,
    );
    const dismissed = this.getPlanContribution(contributionId);
    if (!dismissed) {
      throw new Error(`Plan contribution not found after dismiss: ${contributionId}`);
    }
    return dismissed;
  }

  incorporatePlanContributions(
    repoId: string,
    planArtifactId: string,
    contributionIds: string[],
  ): PlanContribution[] {
    if (contributionIds.length === 0) return [];
    const now = new Date().toISOString();
    const incorporated: PlanContribution[] = [];
    for (const contributionId of contributionIds) {
      const existing = this.getPlanContribution(contributionId);
      if (!existing || existing.repoId !== repoId || existing.planArtifactId !== planArtifactId) {
        throw new Error(`Plan contribution not found: ${contributionId}`);
      }
      if (existing.status !== "pending") {
        throw new Error(`Plan contribution is not pending: ${contributionId}`);
      }
      this.db.exec(
        `
          UPDATE plan_contributions
          SET status = 'incorporated', incorporated_at = ?, updated_at = ?
          WHERE id = ?
        `,
        now,
        now,
        contributionId,
      );
      const updated = this.getPlanContribution(contributionId);
      if (updated) incorporated.push(updated);
    }
    return incorporated;
  }

  getPlanContributionsByIds(repoId: string, planArtifactId: string, contributionIds: string[]): PlanContribution[] {
    const contributions: PlanContribution[] = [];
    for (const contributionId of contributionIds) {
      const contribution = this.getPlanContribution(contributionId);
      if (contribution && contribution.repoId === repoId && contribution.planArtifactId === planArtifactId) {
        contributions.push(contribution);
      }
    }
    return contributions;
  }

  // Consumes only the subset of the given pinned IDs that are still pending.
  // A contribution dismissed mid-run stays dismissed and never fails the run.
  incorporatePendingPlanContributions(
    repoId: string,
    planArtifactId: string,
    contributionIds: string[],
  ): PlanContribution[] {
    const stillPending = this.getPlanContributionsByIds(repoId, planArtifactId, contributionIds)
      .filter((contribution) => contribution.status === "pending")
      .map((contribution) => contribution.id);
    return this.incorporatePlanContributions(repoId, planArtifactId, stillPending);
  }

  createPlannerRun(input: CreatePlannerRunInput): PlannerRun {
    this.assertRepositoryWritable();
    if (input.role !== "reviewer") {
      throw new Error("Only reviewer one-shot runs may use planner_runs.");
    }
    if (!isCurrentLaunchProvenance(input.launchProvenance)) {
      throw new Error("Planner run launch provenance is not from the current workload schema.");
    }
    const startedAt = input.startedAt ?? new Date().toISOString();
    const codexExecution = input.launchProvenance.codexExecution;
    const run: PlannerRun = {
      runId: input.runId ?? crypto.randomUUID(),
      repoId: input.repoId,
      planArtifactId: input.planArtifactId,
      role: input.role,
      provider: input.provider,
      model: input.model,
      ...(input.skill ? { skill: input.skill } : {}),
      status: "queued",
      startedAt,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.input ? { input: input.input } : {}),
      ...(input.skillInvocationId ? { skillInvocationId: input.skillInvocationId } : {}),
      ...(input.skillAgentId ? { skillAgentId: input.skillAgentId } : {}),
      ...(input.skillRunRole ? { skillRunRole: input.skillRunRole } : {}),
      launchProvenance: input.launchProvenance,
      ...(codexExecution ? {
        codexAuthMode: codexExecutionAuthMode(codexExecution),
      } : {}),
    };

    this.db.exec(
      `
        INSERT INTO planner_runs (
          run_id, repo_id, plan_artifact_id, role, provider, model, skill,
          status, started_at, completed_at, error, thread_id, input_json,
          runtime_json, launch_provenance_json, skill_invocation_id, skill_agent_id, skill_run_role
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, NULL, ?, ?, NULL, ?, ?, ?, ?)
      `,
      run.runId,
      run.repoId,
      run.planArtifactId,
      run.role,
      run.provider,
      run.model,
      run.skill ?? null,
      run.startedAt,
      run.threadId ?? null,
      run.input ? JSON.stringify(run.input) : null,
      JSON.stringify(run.launchProvenance),
      run.skillInvocationId ?? null,
      run.skillAgentId ?? null,
      run.skillRunRole ?? null,
    );

    return run;
  }

  // Touched by every runtime callback, INCLUDING empty status polls — this is
  // the run's container-liveness signal, independent of the bounded event log.
  recordPlannerRunContact(runId: string): void {
    this.db.exec(
      "UPDATE planner_runs SET last_contact_at = ? WHERE run_id = ?",
      new Date().toISOString(),
      runId,
    );
  }

  setPlannerRunRuntime(runId: string, runtime: PlannerRunRuntimeProvenance): PlannerRun {
    if (!isCurrentPlannerRuntimeProvenance(runtime)) {
      throw new Error("Planner run runtime provenance is not from the current workload schema.");
    }
    const existing = this.getPlannerRun(runId);
    if (!existing) {
      throw new Error(`Planner run not found: ${runId}`);
    }
    this.db.exec(
      "UPDATE planner_runs SET runtime_json = ? WHERE run_id = ?",
      JSON.stringify(runtime),
      runId,
    );
    const updated = this.getPlannerRun(runId);
    if (!updated) {
      throw new Error(`Planner run not found after runtime update: ${runId}`);
    }
    return updated;
  }

  claimPlannerRunRuntime(runId: string, runtime: PlannerRunRuntimeProvenance): PlannerRun | null {
    if (!isCurrentPlannerRuntimeProvenance(runtime)) {
      throw new Error("Planner run runtime provenance is not from the current workload schema.");
    }
    const existing = this.getPlannerRun(runId);
    if (
      !existing
      || existing.runtime
      || (existing.status !== "queued" && existing.status !== "running")
    ) {
      return null;
    }
    this.db.exec(
      `
        UPDATE planner_runs
        SET runtime_json = ?
        WHERE run_id = ?
          AND runtime_json IS NULL
          AND status IN ('queued', 'running')
      `,
      JSON.stringify(runtime),
      runId,
    );
    const claimed = this.getPlannerRun(runId);
    return claimed?.runtime?.jobSlug === runtime.jobSlug ? claimed : null;
  }

  clearPlannerRunRuntimeIfCurrent(
    runId: string,
    runtime: PlannerRunRuntimeProvenance,
  ): PlannerRun | null {
    const existing = this.getPlannerRun(runId);
    if (!existing?.runtime || !samePlannerRunRuntime(existing.runtime, runtime)) {
      return null;
    }
    this.db.exec(
      `
        UPDATE planner_runs
        SET runtime_json = NULL
        WHERE run_id = ? AND runtime_json = ?
      `,
      runId,
      JSON.stringify(existing.runtime),
    );
    const updated = this.getPlannerRun(runId);
    return updated && !updated.runtime ? updated : null;
  }

  createPlannerRunIfNoActive(input: CreatePlannerRunInput): { ok: true; run: PlannerRun } | { ok: false; active: PlannerRun } {
    const active = input.threadId
      ? this.getActiveRunForThread(input.repoId, input.planArtifactId, input.role, input.threadId)
      : this.getActivePlannerRun(input.repoId, input.planArtifactId, input.role, null);
    if (active) return { ok: false, active };
    return { ok: true, run: this.createPlannerRun(input) };
  }

  getPlannerRun(runId: string): PlannerRun | null {
    const row = this.db.exec(
      "SELECT * FROM planner_runs WHERE run_id = ?",
      runId,
    ).toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  acceptPlannerRunCodexRuntimeAuth(
    runId: string,
    accountIdInput: string,
  ): "accepted" | "inactive" | "account_changed" {
    const accountId = accountIdInput.trim();
    const run = this.getPlannerRun(runId);
    const profile = run?.launchProvenance?.codexExecution;
    if (
      !accountId
      || !run
      || !isActiveRunStatus(run.status)
      || !run.runtime
      || run.provider !== "codex"
      || profile?.kind !== "subscription-app-server"
      || profile.surface !== "plan-reviewer"
    ) return "inactive";
    const accountRow = this.db.exec(
      "SELECT codex_account_id FROM planner_runs WHERE run_id = ?",
      runId,
    ).toArray()[0] as { codex_account_id: string | null } | undefined;
    if (accountRow?.codex_account_id && accountRow.codex_account_id !== accountId) {
      return "account_changed";
    }
    if (!accountRow?.codex_account_id) {
      this.db.exec(
        "UPDATE planner_runs SET codex_account_id = ? WHERE run_id = ? AND codex_account_id IS NULL AND status IN ('queued', 'running', 'saving')",
        accountId,
        runId,
      );
    }
    return "accepted";
  }

  getActivePlannerRun(repoId: string, planArtifactId: string, role: PlannerRun["role"], threadId?: string | null): PlannerRun | null {
    const values: Array<string | number | null> = [repoId, planArtifactId, role];
    const threadClause = threadId ? "AND thread_id = ?" : "";
    if (threadId) values.push(threadId);
    const row = this.db.exec(
      `
        SELECT *
        FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = ?
          AND status IN ('queued', 'running', 'saving')
          ${threadClause}
        ORDER BY started_at DESC
        LIMIT 1
      `,
      ...values,
    ).toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  getActiveRunForThread(
    repoId: string,
    planArtifactId: string,
    role: PlannerRun["role"],
    threadId: string,
  ): PlannerRun | null {
    const row = this.db.exec(
      `
        SELECT *
        FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = ? AND thread_id = ?
          AND status IN ('queued', 'running', 'saving')
        ORDER BY started_at DESC
        LIMIT 1
      `,
      repoId,
      planArtifactId,
      role,
      threadId,
    ).toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  getLatestPlannerRun(repoId: string, planArtifactId: string, role: PlannerRun["role"], threadId?: string | null): PlannerRun | null {
    const values: Array<string | number | null> = [repoId, planArtifactId, role];
    const threadClause = threadId ? "AND thread_id = ?" : "";
    if (threadId) values.push(threadId);
    const row = this.db.exec(
      `
        SELECT *
        FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = ?
          ${threadClause}
        ORDER BY started_at DESC
        LIMIT 1
      `,
      ...values,
    ).toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  listRecentPlannerRuns(
    repoId: string,
    planArtifactId: string,
    input: { role?: PlannerRun["role"]; threadId?: string | null; limit?: number } = {},
  ): PlannerRun[] {
    const values: Array<string | number | null> = [repoId, planArtifactId];
    const roleClause = input.role ? "AND role = ?" : "";
    if (input.role) values.push(input.role);
    const threadClause = input.threadId ? "AND thread_id = ?" : "";
    if (input.threadId) values.push(input.threadId);
    values.push(Math.max(1, Math.min(input.limit ?? 20, 50)));
    const rows = this.db.exec(
      `
        SELECT *
        FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ?
          ${roleClause}
          ${threadClause}
        ORDER BY started_at DESC
        LIMIT ?
      `,
      ...values,
    ).toArray() as unknown as PlannerRunRow[];
    return rows.map((row) => this.parsePlannerRunRow(row));
  }

  listActivePlannerRunsForRepo(repoId: string): PlannerRun[] {
    const rows = this.db.exec(
      `
        SELECT * FROM planner_runs
        WHERE repo_id = ? AND status IN ('queued', 'running', 'saving')
        ORDER BY started_at ASC
      `,
      repoId,
    ).toArray() as unknown as PlannerRunRow[];
    return rows.map((row) => this.parsePlannerRunRow(row));
  }

  listPlannerWorkloadStateForPredeploy(repoId: string): Array<{
    runId: string;
    status: string;
    hasRuntime: boolean;
  }> {
    const rows = this.db.exec(
      `
        SELECT run_id, status, runtime_json
        FROM planner_runs
        WHERE repo_id = ?
        ORDER BY started_at ASC
      `,
      repoId,
    ).toArray() as unknown as Array<Pick<PlannerRunRow, "run_id" | "status" | "runtime_json">>;
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      hasRuntime: row.runtime_json !== null,
    }));
  }

  listPlanWritersForRepo(repoId: string): ReviewerRegistryEntry[] {
    const rows = this.db.exec(
      `
        SELECT * FROM reviewer_registry
        WHERE repo_id = ? AND role = 'writer'
        ORDER BY created_at ASC, rowid ASC
      `,
      repoId,
    ).toArray() as unknown as ReviewerRegistryRow[];
    return rows.map((row) => this.parseReviewerRegistryRow(row));
  }

  finalizeRepositoryDeletion(repoId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.db.exec(
        `DELETE FROM environment_sidebar_slots
         WHERE state = 'reserved'
           AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)`,
        Date.now(),
      );
      const runBlocker = this.db.exec(
        `
          SELECT run_id, status, runtime_json
          FROM planner_runs
          WHERE repo_id = ?
            AND (
              status IN ('queued', 'running', 'saving')
              OR runtime_json IS NOT NULL
            )
          LIMIT 1
        `,
        repoId,
      ).toArray()[0] as unknown as {
        run_id: string;
        status: string;
        runtime_json: string | null;
      } | undefined;
      if (runBlocker) {
        throw new Error(
          runBlocker.runtime_json
            ? `Planner run ${runBlocker.run_id} retains runtime provenance.`
            : `Planner run ${runBlocker.run_id} is still ${runBlocker.status}.`,
        );
      }
      const writerBlocker = this.db.exec(
        `
          SELECT thread_id, stopped_at, removed_at, runtime_json, job_slug, cleanup_error
          FROM reviewer_registry
          WHERE repo_id = ? AND role = 'writer'
            AND (
              (stopped_at IS NULL AND removed_at IS NULL)
              OR runtime_json IS NOT NULL
              OR job_slug IS NOT NULL
              OR cleanup_error IS NOT NULL
            )
          LIMIT 1
        `,
        repoId,
      ).toArray()[0] as unknown as {
        thread_id: string;
      } | undefined;
      if (writerBlocker) {
        throw new Error(`Plan Writer ${writerBlocker.thread_id} is not fully cleaned up.`);
      }
      const sidebarSlotBlocker = this.db.exec(
        `
          SELECT env_slug, state
          FROM environment_sidebar_slots
          LIMIT 1
        `,
      ).toArray()[0] as unknown as {
        env_slug: string;
        state: "reserved" | "committed";
      } | undefined;
      if (sidebarSlotBlocker) {
        throw new Error(
          sidebarSlotBlocker.state === "reserved"
            ? `Environment ${sidebarSlotBlocker.env_slug} is still being created.`
            : `Environment ${sidebarSlotBlocker.env_slug} is still attached to this repository.`,
        );
      }
      this.db.exec(
        `INSERT INTO repository_deletion (singleton, deleted_at)
         VALUES (1, ?)
         ON CONFLICT(singleton) DO NOTHING`,
        new Date().toISOString(),
      );
      for (const table of [
        "planner_run_events",
        "plan_skill_invocations",
        "planner_runs",
        "planning_skills",
        "repo_plan_writer_settings",
        "plan_contributions",
        "reviewer_registry",
        "environment_sidebar_slots",
        "refs",
        "artifacts",
      ]) {
        this.db.exec(`DELETE FROM ${table}`);
      }
    });
  }

  updatePlannerRun(input: UpdatePlannerRunInput): PlannerRun {
    const existing = this.getPlannerRun(input.runId);
    if (!existing) {
      throw new Error(`Planner run not found: ${input.runId}`);
    }

    this.db.exec(
      `
        UPDATE planner_runs
        SET status = ?,
            completed_at = ?,
            error = ?
        WHERE run_id = ?
      `,
      input.status,
      input.completedAt === undefined ? existing.completedAt ?? null : input.completedAt,
      input.error === undefined ? existing.error ?? null : input.error,
      input.runId,
    );

    const updated = this.getPlannerRun(input.runId);
    if (!updated) {
      throw new Error(`Planner run not found after update: ${input.runId}`);
    }
    if (updated.skillInvocationId && updated.skillRunRole === "child_initial" && !isActiveRunStatus(updated.status)) {
      this.refreshPlanSkillInvocationStatus(updated.skillInvocationId);
    }
    return updated;
  }

  updateActivePlannerRun(input: UpdatePlannerRunInput): PlannerRun {
    const existing = this.getPlannerRun(input.runId);
    if (!existing) {
      throw new Error(`Planner run not found: ${input.runId}`);
    }
    if (existing.status !== "queued" && existing.status !== "running" && existing.status !== "saving") {
      return existing;
    }
    return this.updatePlannerRun(input);
  }

  claimPlannerRunSaving(runId: string): PlannerRun | null {
    const existing = this.getPlannerRun(runId);
    if (
      !existing
      || existing.role !== "reviewer"
      || (existing.status !== "queued" && existing.status !== "running")
    ) {
      return null;
    }
    return this.updatePlannerRun({ runId, status: "saving" });
  }

  cancelActivePlannerRun(
    runId: string,
    options: { allowSaving?: boolean; completedAt?: string } = {},
  ): PlannerRun {
    const existing = this.getPlannerRun(runId);
    if (!existing) {
      throw new Error(`Planner run not found: ${runId}`);
    }
    const cancellable = existing.status === "queued"
      || existing.status === "running"
      || (options.allowSaving === true && existing.status === "saving");
    if (!cancellable) return existing;
    return this.updatePlannerRun({
      runId,
      status: "cancelled",
      completedAt: options.completedAt ?? new Date().toISOString(),
    });
  }

  appendPlannerRunEvent(input: AppendPlannerRunEventInput): PlannerRunEvent {
    this.assertRepositoryWritable();
    const createdAt = input.createdAt ?? new Date().toISOString();
    const maxRow = this.db.exec(
      "SELECT MAX(seq) AS seq FROM planner_run_events WHERE run_id = ?",
      input.runId,
    ).toArray()[0] as unknown as { seq: number | null } | undefined;
    const seq = (maxRow?.seq ?? 0) + 1;
    this.db.exec(
      `
        INSERT INTO planner_run_events (
          run_id, repo_id, plan_artifact_id, seq, type, message, data_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.runId,
      input.repoId,
      input.planArtifactId,
      seq,
      input.type,
      input.message ?? null,
      input.data === undefined ? null : JSON.stringify(input.data),
      createdAt,
    );

    const deleteBeforeOrAt = seq - MAX_STORED_RUN_EVENTS;
    if (deleteBeforeOrAt > 0) {
      this.db.exec(
        "DELETE FROM planner_run_events WHERE run_id = ? AND seq <= ?",
        input.runId,
        deleteBeforeOrAt,
      );
    }

    return {
      runId: input.runId,
      repoId: input.repoId,
      planArtifactId: input.planArtifactId,
      seq,
      type: input.type,
      ...(input.message ? { message: input.message } : {}),
      ...(input.data === undefined ? {} : { data: input.data }),
      createdAt,
    };
  }

  // Server-owned lifecycle events are a secondary watchdog signal. Runtime
  // callbacks, including empty status polls, update last_contact_at directly.
  getLastPlannerRunEventAt(runId: string): string | null {
    const row = this.db.exec(
      "SELECT created_at FROM planner_run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
      runId,
    ).toArray()[0] as unknown as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  listPlannerRunEvents(runId: string, options: { afterSeq?: number | null; limit?: number } = {}): PlannerRunEvent[] {
    const limit = Math.max(1, Math.min(options.limit ?? MAX_STORED_RUN_EVENTS, MAX_STORED_RUN_EVENTS));
    const afterSeq = Number.isInteger(options.afterSeq) ? Number(options.afterSeq) : null;
    const rows = afterSeq !== null
      ? this.db.exec(
        `
          SELECT *
          FROM planner_run_events
          WHERE run_id = ? AND seq > ?
          ORDER BY seq ASC
          LIMIT ?
        `,
        runId,
        afterSeq,
        limit,
      ).toArray() as unknown as PlannerRunEventRow[]
      : this.db.exec(
        `
          SELECT *
          FROM planner_run_events
          WHERE run_id = ?
          ORDER BY seq ASC
          LIMIT ?
        `,
        runId,
        limit,
      ).toArray() as unknown as PlannerRunEventRow[];
    return rows.map((row) => this.parsePlannerRunEventRow(row));
  }

  setRef(input: SetRefInput): ArtifactRef {
    this.assertRepositoryWritable();
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
