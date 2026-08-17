import { DurableObject } from "cloudflare:workers";
import type { Env } from "../types";
import {
  reviewSkillRerunRunId,
  type EnvReviewChangeContext,
  type EnvReviewFeedback,
  type EnvReviewFanoutHandoff,
  type EnvReviewFeedbackStatus,
  type EnvReviewPlanBasis,
  type EnvReviewPreparationOperation,
  type EnvReviewPreparationResult,
  type EnvReviewRun,
  type EnvReviewRunEvent,
  type EnvReviewRunStatus,
  type EnvReviewSession,
  type EnvReviewSnapshot,
  type EnvReviewSnapshotRequestContract,
  type EnvReviewState,
  type EnvReviewTab,
  type EnvReviewTabStatus,
  type EnvReviewTaskKind,
  type ReviewSkillInvocation,
} from "./types";
import type {
  AgentSkillDefinition,
  FrozenOverviewPayload,
  PlannerEffort,
  PlannerRunLaunchProvenance,
  PlannerRunRuntimeProvenance,
  SkillAutomationMode,
  SkillInvocationStatus,
  SkillRunRole,
} from "../coordination";
import {
  isCurrentLaunchProvenance,
  isCurrentPlannerRuntimeProvenance,
  parseStoredLaunchProvenance,
  parseStoredRuntimeProvenance,
} from "../coordination/execution-provenance";
import { processEnvReviewOrchestration } from "./orchestrator";
import { composeReviewerInstructions } from "../reviewer-instructions";
import { REVIEW_SKILL_RERUN_INSTRUCTION } from "./active-instructions";

const MAX_STORED_RUN_EVENTS = 200;

interface SessionRow {
  env_slug: string;
  repo_id: string;
  main_session_id: string;
  latest_sync_op_id: string | null;
  latest_sync_json: string | null;
  latest_change_summary_json: string | null;
  created_at: string;
  updated_at: string;
}

interface TabRow {
  thread_id: string;
  env_slug: string;
  repo_id: string;
  main_session_id: string;
  provider: string;
  model: string;
  effort: string;
  role_label: string;
  task_kind: string;
  custom_task: string | null;
  status: string;
  latest_run_id: string | null;
  removed_at: string | null;
  created_at: string;
  updated_at: string;
  skill_invocation_id: string | null;
  skill_agent_id: string | null;
  node_kind: string | null;
  skill_root_thread_id: string | null;
}

interface RunRow {
  run_id: string;
  thread_id: string;
  env_slug: string;
  repo_id: string;
  main_session_id: string;
  provider: string;
  model: string;
  effort: string;
  role_label: string;
  task_kind: string;
  custom_task: string | null;
  recipe_instructions: string | null;
  status: string;
  sync_op_id: string;
  sync_json: string | null;
  change_context_json: string | null;
  plan_basis_json: string | null;
  prompt_text: string | null;
  runtime_json: string | null;
  launch_provenance_json: string | null;
  codex_account_id: string | null;
  started_at: string;
  queued_at: string | null;
  completed_at: string | null;
  error: string | null;
  last_contact_at: string | null;
  skill_invocation_id: string | null;
  skill_agent_id: string | null;
  skill_run_role: string | null;
  skill_definition_snapshot_json: string | null;
  frozen_overview_json: string | null;
}

interface ReviewSkillInvocationRow {
  invocation_id: string;
  env_slug: string;
  repo_id: string;
  main_session_id: string;
  parent_thread_id: string;
  definition_snapshot_json: string;
  preparation_op_id: string;
  status: string;
  overview_mode: string;
  included_message_ids_json: string;
  overview_run_id: string | null;
  error: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
  overview_route_json: string | null;
}

interface EventRow {
  run_id: string;
  seq: number;
  type: string;
  message: string | null;
  data_json: string | null;
  created_at: string;
}

interface PreparationRow {
  op_id: string;
  env_slug: string;
  session_id: string;
  status: string;
  result_json: string | null;
  request_url: string | null;
  ack_token: string | null;
  sync_requested_at: string | null;
  sync_attempts: number;
  snapshot_request_json: string | null;
  timeout_at: string | null;
  started_at: string;
  completed_at: string | null;
  error: string | null;
}

interface FeedbackRow {
  feedback_id: string;
  env_slug: string;
  repo_id: string;
  main_session_id: string;
  thread_id: string;
  run_id: string;
  message_id: string;
  provider: string;
  model: string;
  role_label: string;
  sync_completed_at: string | null;
  text: string;
  status: string;
  delivered_text: string | null;
  metadata_json: string;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  dismissed_at: string | null;
}

const ACTIVE_SYNC_TIMEOUT_MS = 130_000;
const ORCHESTRATION_ALARM_DELAY_MS = 50;

type SnapshotPreparationCompletion =
  | { status: "completed"; operation: EnvReviewPreparationOperation }
  | { status: "already_completed"; operation: EnvReviewPreparationOperation; sameSnapshotHash: boolean }
  | { status: "rejected"; reason: string; operation: EnvReviewPreparationOperation | null };

interface CreateEnvReviewRunInput {
  runId: string;
  threadId: string;
  envSlug: string;
  repoId: string;
  mainSessionId: string;
  provider: string;
  model: string;
  effort: PlannerEffort;
  roleLabel: string;
  taskKind: EnvReviewTaskKind;
  customTask?: string | null;
  recipeInstructions?: string | null;
  preparationOpId: string;
  skillInvocationId?: string | null;
  skillAgentId?: string | null;
  skillRunRole?: SkillRunRole | null;
  skillDefinitionSnapshot?: AgentSkillDefinition | null;
  frozenOverview?: FrozenOverviewPayload | null;
  preparation?: EnvReviewPreparationResult | null;
  changeContext?: EnvReviewChangeContext | null;
  planBasis?: EnvReviewPlanBasis | null;
  prompt?: string | null;
  initialStatus?: EnvReviewRunStatus;
  launchProvenance?: PlannerRunLaunchProvenance | null;
}

function parseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function terminalStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "timed_out";
}

function terminalRunStatus(status: EnvReviewRunStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

function sameRunRuntime(
  left: PlannerRunRuntimeProvenance,
  right: PlannerRunRuntimeProvenance,
): boolean {
  return left.jobSlug === right.jobSlug;
}

function preparationStatusFromStorage(status: string): EnvReviewPreparationOperation["status"] {
  return status === "syncing" ? "preparing" : status as EnvReviewPreparationOperation["status"];
}

function preparationStatusToStorage(status: EnvReviewPreparationOperation["status"]): string {
  return status === "preparing" ? "syncing" : status;
}

function runStatusFromStorage(status: string): EnvReviewRunStatus {
  return status === "syncing" ? "preparing" : status as EnvReviewRunStatus;
}

function runStatusToStorage(status: EnvReviewRunStatus): string {
  return status === "preparing" ? "syncing" : status;
}

function tabStatusFromStorage(status: string): EnvReviewTabStatus {
  return status === "syncing" ? "preparing" : status as EnvReviewTabStatus;
}

function tabStatusToStorage(status: EnvReviewTabStatus): string {
  return status === "preparing" ? "syncing" : status;
}

function tabStatusForRunStatus(status: EnvReviewRunStatus): EnvReviewTabStatus {
  if (status === "ready") return "ready";
  if (status === "failed" || status === "cancelled") return "failed";
  return status;
}

function isTerminalRunStatus(status: EnvReviewRunStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

function sameStringSet(left: string[], right: string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function skillInvocationStatus(status: string): SkillInvocationStatus {
  return status === "setting_up" || status === "active" || status === "completed" || status === "cancelled"
    ? status
    : "failed";
}

function skillRunRole(status: string | null): SkillRunRole | null {
  return status === "root_initial"
    || status === "root_followup"
    || status === "report_initial"
    || status === "report_followup"
    || status === "overview"
    ? status
    : null;
}

function snapshotIdentityMatches(left: EnvReviewSnapshot, right: EnvReviewSnapshot): boolean {
  return left.snapshotId === right.snapshotId
    && left.r2Key === right.r2Key
    && left.snapshotHash === right.snapshotHash
    && left.baseCommitSha === right.baseCommitSha
    && left.source === right.source
    && left.mode === right.mode;
}

export class EnvReviewDO extends DurableObject<Env> {
  private _db: SqlStorage | null = null;
  private _schemaReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async scheduleOrchestration(delayMs = ORCHESTRATION_ALARM_DELAY_MS): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + Math.max(0, delayMs));
  }

  async alarm(): Promise<void> {
    try {
      await processEnvReviewOrchestration(this, this.env);
    } catch (error) {
      console.error("[env-review] orchestration alarm failed:", error);
      await this.scheduleOrchestration(5_000);
    }
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
      CREATE TABLE IF NOT EXISTS env_review_sessions (
        env_slug TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        main_session_id TEXT NOT NULL,
        latest_sync_op_id TEXT,
        latest_sync_json TEXT,
        latest_change_summary_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(env_slug, main_session_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_deleted_sessions (
        main_session_id TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_tabs (
        thread_id TEXT PRIMARY KEY,
        env_slug TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        main_session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'high',
        role_label TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        custom_task TEXT,
        status TEXT NOT NULL,
        latest_run_id TEXT,
        removed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        node_kind TEXT NOT NULL DEFAULT 'generic',
        skill_root_thread_id TEXT
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_tabs_env_removed
      ON env_review_tabs(env_slug, main_session_id, removed_at)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_runs (
        run_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        env_slug TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        main_session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'high',
        role_label TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        custom_task TEXT,
        recipe_instructions TEXT,
        status TEXT NOT NULL,
        sync_op_id TEXT NOT NULL,
        sync_json TEXT,
        change_context_json TEXT,
        plan_basis_json TEXT,
        prompt_text TEXT,
        runtime_json TEXT,
        started_at TEXT NOT NULL,
        queued_at TEXT,
        completed_at TEXT,
        error TEXT,
        last_contact_at TEXT
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_runs_env_started
      ON env_review_runs(env_slug, main_session_id, started_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_runs_thread_started
      ON env_review_runs(thread_id, started_at)
    `);
    for (const statement of [
      "ALTER TABLE env_review_tabs ADD COLUMN effort TEXT NOT NULL DEFAULT 'high'",
      "ALTER TABLE env_review_tabs ADD COLUMN skill_invocation_id TEXT",
      "ALTER TABLE env_review_tabs ADD COLUMN skill_agent_id TEXT",
      "ALTER TABLE env_review_tabs ADD COLUMN node_kind TEXT NOT NULL DEFAULT 'generic'",
      "ALTER TABLE env_review_tabs ADD COLUMN skill_root_thread_id TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN effort TEXT NOT NULL DEFAULT 'high'",
      "ALTER TABLE env_review_runs ADD COLUMN recipe_instructions TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN skill_invocation_id TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN skill_agent_id TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN skill_run_role TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN skill_definition_snapshot_json TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN frozen_overview_json TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN launch_provenance_json TEXT",
      "ALTER TABLE env_review_runs ADD COLUMN codex_account_id TEXT",
    ]) {
      try {
        db.exec(statement);
      } catch {
        // Column already exists.
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_tabs_skill_invocation
      ON env_review_tabs(skill_invocation_id, created_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_runs_skill_invocation
      ON env_review_runs(skill_invocation_id, started_at)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_skill_invocations (
        invocation_id TEXT PRIMARY KEY,
        env_slug TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        main_session_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        definition_snapshot_json TEXT NOT NULL,
        preparation_op_id TEXT NOT NULL,
        status TEXT NOT NULL,
        overview_mode TEXT NOT NULL,
        included_message_ids_json TEXT NOT NULL DEFAULT '[]',
        overview_run_id TEXT UNIQUE,
        error TEXT,
        cancelled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
        ,overview_route_json TEXT
      )
    `);
    try {
      db.exec("ALTER TABLE env_review_skill_invocations ADD COLUMN overview_route_json TEXT");
    } catch {
      // Column already exists.
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_skill_invocations_history
      ON env_review_skill_invocations(env_slug, main_session_id, created_at DESC, invocation_id DESC)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_run_events (
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        message TEXT,
        data_json TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY(run_id, seq)
      )
    `);
    db.exec("DELETE FROM env_review_run_events WHERE type IN ('progress', 'assistant_message')");
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_sync_ops (
        op_id TEXT PRIMARY KEY,
        env_slug TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        result_json TEXT,
        request_url TEXT,
        ack_token TEXT,
        sync_requested_at TEXT,
        sync_attempts INTEGER NOT NULL DEFAULT 0,
        snapshot_request_json TEXT,
        timeout_at TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT
      )
    `);
    for (const statement of [
      "ALTER TABLE env_review_sync_ops ADD COLUMN request_url TEXT",
      "ALTER TABLE env_review_sync_ops ADD COLUMN ack_token TEXT",
      "ALTER TABLE env_review_sync_ops ADD COLUMN sync_requested_at TEXT",
      "ALTER TABLE env_review_sync_ops ADD COLUMN sync_attempts INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE env_review_sync_ops ADD COLUMN snapshot_request_json TEXT",
      "ALTER TABLE env_review_sync_ops ADD COLUMN timeout_at TEXT",
    ]) {
      try {
        db.exec(statement);
      } catch {
        // Column already exists.
      }
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_sync_active_session
      ON env_review_sync_ops(env_slug, session_id, status, started_at)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS env_review_feedback (
        feedback_id TEXT PRIMARY KEY,
        env_slug TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        main_session_id TEXT NOT NULL DEFAULT '',
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        role_label TEXT NOT NULL,
        sync_completed_at TEXT,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        delivered_text TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        sent_at TEXT,
        dismissed_at TEXT
      )
    `);
    try {
      db.exec("ALTER TABLE env_review_feedback ADD COLUMN main_session_id TEXT NOT NULL DEFAULT ''");
    } catch {
      // Column already exists.
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_env_review_feedback_env
      ON env_review_feedback(env_slug, main_session_id, updated_at)
    `);
  }

  private parseSession(row: SessionRow): EnvReviewSession {
    const latestPreparation = parseJson<EnvReviewPreparationResult>(row.latest_sync_json);
    return {
      envSlug: row.env_slug,
      repoId: row.repo_id,
      mainSessionId: row.main_session_id,
      latestPreparationOpId: row.latest_sync_op_id,
      latestPreparation,
      latestChangeSummary: parseJson<EnvReviewChangeContext["summary"]>(row.latest_change_summary_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parseTab(row: TabRow): EnvReviewTab {
    return {
      threadId: row.thread_id,
      envSlug: row.env_slug,
      repoId: row.repo_id,
      mainSessionId: row.main_session_id,
      provider: row.provider,
      model: row.model,
      effort: row.effort as PlannerEffort,
      roleLabel: row.role_label,
      taskKind: row.task_kind as EnvReviewTaskKind,
      customTask: row.custom_task,
      status: tabStatusFromStorage(row.status),
      latestRunId: row.latest_run_id,
      removedAt: row.removed_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      skillInvocationId: row.skill_invocation_id,
      skillAgentId: row.skill_agent_id,
      nodeKind:
        row.node_kind === "skill_root" || row.node_kind === "report"
          ? row.node_kind
          : "generic",
      skillRootThreadId: row.skill_root_thread_id,
    };
  }

  private parseRun(row: RunRow): EnvReviewRun {
    const preparation = parseJson<EnvReviewPreparationResult>(row.sync_json);
    return {
      runId: row.run_id,
      threadId: row.thread_id,
      envSlug: row.env_slug,
      repoId: row.repo_id,
      mainSessionId: row.main_session_id,
      provider: row.provider,
      model: row.model,
      effort: row.effort as PlannerEffort,
      roleLabel: row.role_label,
      taskKind: row.task_kind as EnvReviewTaskKind,
      customTask: row.custom_task,
      recipeInstructions: row.recipe_instructions,
      status: runStatusFromStorage(row.status),
      preparationOpId: row.sync_op_id,
      preparation,
      changeContext: parseJson<EnvReviewChangeContext>(row.change_context_json),
      planBasis: parseJson<EnvReviewPlanBasis>(row.plan_basis_json),
      prompt: row.prompt_text,
      runtime: parseStoredRuntimeProvenance(
        row.runtime_json,
        "environment review runtime",
      ),
      launchProvenance: parseStoredLaunchProvenance<PlannerRunLaunchProvenance>(
        row.launch_provenance_json,
        "environment review launch",
      ),
      startedAt: row.started_at,
      queuedAt: row.queued_at,
      completedAt: row.completed_at,
      error: row.error,
      lastContactAt: row.last_contact_at,
      skillInvocationId: row.skill_invocation_id,
      skillAgentId: row.skill_agent_id,
      skillRunRole: skillRunRole(row.skill_run_role),
      skillDefinitionSnapshot: parseJson<AgentSkillDefinition>(row.skill_definition_snapshot_json),
      frozenOverview: parseJson<FrozenOverviewPayload>(row.frozen_overview_json),
    };
  }

  private parseSkillInvocation(row: ReviewSkillInvocationRow): ReviewSkillInvocation {
    return {
      invocationId: row.invocation_id,
      envSlug: row.env_slug,
      repoId: row.repo_id,
      mainSessionId: row.main_session_id,
      parentThreadId: row.parent_thread_id,
      definitionSnapshot: JSON.parse(row.definition_snapshot_json) as AgentSkillDefinition,
      preparationOpId: row.preparation_op_id,
      status: skillInvocationStatus(row.status),
      overviewMode: row.overview_mode === "manual" ? "manual" : "auto",
      includedMessageIds: parseJson<string[]>(row.included_message_ids_json) ?? [],
      overviewRunId: row.overview_run_id,
      overviewRoute: parseJson(row.overview_route_json),
      error: row.error,
      cancelledAt: row.cancelled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private parsePreparation(row: PreparationRow): EnvReviewPreparationOperation {
    return {
      opId: row.op_id,
      envSlug: row.env_slug,
      sessionId: row.session_id,
      status: preparationStatusFromStorage(row.status),
      result: parseJson<EnvReviewPreparationResult>(row.result_json),
      requestUrl: row.request_url,
      ackToken: row.ack_token,
      snapshotRequestedAt: row.sync_requested_at,
      snapshotAttempts: Number(row.sync_attempts ?? 0),
      snapshotRequest: parseJson<EnvReviewSnapshotRequestContract>(row.snapshot_request_json),
      timeoutAt: row.timeout_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      error: row.error,
    };
  }

  private parseEvent(row: EventRow): EnvReviewRunEvent {
    return {
      runId: row.run_id,
      seq: row.seq,
      type: row.type,
      ...(row.message ? { message: row.message } : {}),
      ...(row.data_json ? { data: parseJson<unknown>(row.data_json) } : {}),
      createdAt: row.created_at,
    };
  }

  private parseFeedback(row: FeedbackRow): EnvReviewFeedback {
    return {
      feedbackId: row.feedback_id,
      envSlug: row.env_slug,
      repoId: row.repo_id,
      mainSessionId: row.main_session_id,
      threadId: row.thread_id,
      runId: row.run_id,
      messageId: row.message_id,
      provider: row.provider,
      model: row.model,
      roleLabel: row.role_label,
      preparationCompletedAt: row.sync_completed_at,
      text: row.text,
      status: row.status as EnvReviewFeedbackStatus,
      deliveredText: row.delivered_text,
      metadata: parseJson<Record<string, unknown>>(row.metadata_json) ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      sentAt: row.sent_at,
      dismissedAt: row.dismissed_at,
    };
  }

  private assertSessionWritable(mainSessionId: string): void {
    const deleted = this.db.exec(
      "SELECT main_session_id FROM env_review_deleted_sessions WHERE main_session_id = ? LIMIT 1",
      mainSessionId,
    ).toArray()[0];
    if (deleted) {
      throw new Error("Environment review session was finalized for deletion.");
    }
  }

  getOrCreateSession(input: { envSlug: string; repoId: string; mainSessionId: string }): EnvReviewSession {
    this.assertSessionWritable(input.mainSessionId);
    const now = nowIso();
    this.db.exec(
      `
        INSERT INTO env_review_sessions (
          env_slug, repo_id, main_session_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(env_slug, main_session_id) DO UPDATE SET
          repo_id = excluded.repo_id,
          updated_at = excluded.updated_at
      `,
      input.envSlug,
      input.repoId,
      input.mainSessionId,
      now,
      now,
    );
    const row = this.db.exec(
      "SELECT * FROM env_review_sessions WHERE env_slug = ? AND main_session_id = ?",
      input.envSlug,
      input.mainSessionId,
    ).one() as unknown as SessionRow;
    return this.parseSession(row);
  }

  private getSessionForState(input: {
    envSlug: string;
    repoId: string;
    mainSessionId: string;
  }): EnvReviewSession {
    this.assertSessionWritable(input.mainSessionId);
    const existing = this.db.exec(
      "SELECT * FROM env_review_sessions WHERE env_slug = ? AND main_session_id = ? LIMIT 1",
      input.envSlug,
      input.mainSessionId,
    ).toArray()[0] as unknown as SessionRow | undefined;
    if (existing) return this.parseSession(existing);
    return this.getOrCreateSession(input);
  }

  getState(input: { envSlug: string; repoId: string; mainSessionId: string }): EnvReviewState {
    const session = this.getSessionForState(input);
    const tabs = (this.db.exec(
      "SELECT * FROM env_review_tabs WHERE env_slug = ? AND main_session_id = ? AND removed_at IS NULL ORDER BY created_at ASC",
      input.envSlug,
      input.mainSessionId,
    ).toArray() as unknown as TabRow[]).map((row) => this.parseTab(row));
    const runs = (this.db.exec(
      "SELECT * FROM env_review_runs WHERE env_slug = ? ORDER BY started_at DESC LIMIT 100",
      input.envSlug,
    ).toArray() as unknown as RunRow[]).map((row) => this.parseRun(row));
    const feedback = (this.db.exec(
      "SELECT * FROM env_review_feedback WHERE env_slug = ? AND status != 'dismissed' ORDER BY created_at DESC LIMIT 100",
      input.envSlug,
    ).toArray() as unknown as FeedbackRow[]).map((row) => this.parseFeedback(row));
    return { session, tabs, runs, feedback };
  }

  inheritReviewerTabsFromLatestSession(input: {
    envSlug: string;
    repoId: string;
    mainSessionId: string;
  }): { status: "existing" | "inherited" | "empty"; tabs: EnvReviewTab[] } {
    this.assertSessionWritable(input.mainSessionId);
    return this.ctx.storage.transactionSync(() => {
      const currentSession = this.db.exec(
        "SELECT main_session_id FROM env_review_sessions WHERE env_slug = ? AND main_session_id = ? LIMIT 1",
        input.envSlug,
        input.mainSessionId,
      ).toArray()[0] as { main_session_id: string } | undefined;
      if (currentSession) {
        const tabs = (this.db.exec(
          "SELECT * FROM env_review_tabs WHERE env_slug = ? AND main_session_id = ? AND removed_at IS NULL ORDER BY created_at ASC",
          input.envSlug,
          input.mainSessionId,
        ).toArray() as unknown as TabRow[]).map((row) => this.parseTab(row));
        return { status: "existing" as const, tabs };
      }

      const sourceSession = this.db.exec(
        `
          SELECT sessions.main_session_id
          FROM env_review_sessions AS sessions
          WHERE sessions.env_slug = ?
            AND sessions.repo_id = ?
            AND sessions.main_session_id != ?
            AND EXISTS (
              SELECT 1
              FROM env_review_tabs AS tabs
              WHERE tabs.env_slug = sessions.env_slug
                AND tabs.main_session_id = sessions.main_session_id
                AND tabs.removed_at IS NULL
            )
          ORDER BY sessions.updated_at DESC, sessions.created_at DESC
          LIMIT 1
        `,
        input.envSlug,
        input.repoId,
        input.mainSessionId,
      ).toArray()[0] as { main_session_id: string } | undefined;

      this.getOrCreateSession(input);
      if (!sourceSession) return { status: "empty" as const, tabs: [] };

      const sourceTabs = this.db.exec(
        "SELECT * FROM env_review_tabs WHERE env_slug = ? AND main_session_id = ? AND removed_at IS NULL ORDER BY created_at ASC",
        input.envSlug,
        sourceSession.main_session_id,
      ).toArray() as unknown as TabRow[];
      const now = nowIso();
      for (const row of sourceTabs) {
        // A reviewer is an environment-level collaborator. Move its registry
        // row to the new lead session so the same ThreadDO (and conversation)
        // survives a stop/start cycle, while prior runs remain session-scoped.
        this.db.exec(
          `
            UPDATE env_review_tabs
            SET repo_id = ?, main_session_id = ?, status = 'idle', latest_run_id = NULL,
                removed_at = NULL, updated_at = ?
            WHERE thread_id = ?
          `,
          input.repoId,
          input.mainSessionId,
          now,
          row.thread_id,
        );
      }
      const tabs = (this.db.exec(
        "SELECT * FROM env_review_tabs WHERE env_slug = ? AND main_session_id = ? AND removed_at IS NULL ORDER BY created_at ASC",
        input.envSlug,
        input.mainSessionId,
      ).toArray() as unknown as TabRow[]).map((row) => this.parseTab(row));
      return { status: "inherited" as const, tabs };
    });
  }

  addReviewerTab(input: {
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    threadId: string;
    provider: string;
    model: string;
    effort: PlannerEffort;
    roleLabel?: string;
    taskKind?: EnvReviewTaskKind;
    customTask?: string | null;
    skillInvocationId?: string | null;
    skillAgentId?: string | null;
    nodeKind?: "generic" | "skill_root" | "report";
    skillRootThreadId?: string | null;
  }): EnvReviewTab {
    this.getOrCreateSession(input);
    const now = nowIso();
    this.db.exec(
      `
        INSERT INTO env_review_tabs (
          thread_id, env_slug, repo_id, main_session_id, provider, model, effort, role_label,
          task_kind, custom_task, status, latest_run_id, removed_at, created_at, updated_at,
          skill_invocation_id, skill_agent_id
          ,node_kind, skill_root_thread_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'idle', NULL, NULL, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id) DO UPDATE SET
          provider = excluded.provider,
          model = excluded.model,
          effort = excluded.effort,
          role_label = excluded.role_label,
          task_kind = excluded.task_kind,
          custom_task = excluded.custom_task,
          skill_invocation_id = excluded.skill_invocation_id,
          skill_agent_id = excluded.skill_agent_id,
          node_kind = excluded.node_kind,
          skill_root_thread_id = excluded.skill_root_thread_id,
          removed_at = NULL,
          updated_at = excluded.updated_at
      `,
      input.threadId,
      input.envSlug,
      input.repoId,
      input.mainSessionId,
      input.provider,
      input.model,
      input.effort,
      input.roleLabel ?? "Reviewer",
      input.taskKind ?? "correctness",
      input.customTask ?? null,
      now,
      now,
      input.skillInvocationId ?? null,
      input.skillAgentId ?? null,
      input.nodeKind ?? "generic",
      input.skillRootThreadId ?? null,
    );
    const tab = this.getTab(input.threadId);
    if (!tab) throw new Error("Failed to create env reviewer tab.");
    return tab;
  }

  ensurePrimaryReviewerTab(input: {
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    provider: string;
    model: string;
    effort: PlannerEffort;
  }): { status: "created" | "existing"; tab: EnvReviewTab } {
    this.assertSessionWritable(input.mainSessionId);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.db.exec(
        `
          SELECT * FROM env_review_tabs
          WHERE env_slug = ?
            AND main_session_id = ?
            AND removed_at IS NULL
            AND node_kind = 'generic'
          ORDER BY created_at ASC
          LIMIT 1
        `,
        input.envSlug,
        input.mainSessionId,
      ).toArray()[0] as unknown as TabRow | undefined;
      if (existing) {
        return { status: "existing" as const, tab: this.parseTab(existing) };
      }

      const tab = this.addReviewerTab({
        ...input,
        threadId: `env-review:${input.envSlug}:${crypto.randomUUID()}`,
        roleLabel: "Reviewer",
        taskKind: "correctness",
      });
      return { status: "created" as const, tab };
    });
  }

  getTab(threadId: string): EnvReviewTab | null {
    const row = this.db.exec("SELECT * FROM env_review_tabs WHERE thread_id = ?", threadId).toArray()[0] as unknown as TabRow | undefined;
    return row ? this.parseTab(row) : null;
  }

  removeReviewerTab(threadId: string, mainSessionId: string): EnvReviewTab | null {
    const now = nowIso();
    const activeRows = this.db.exec(
      `
        SELECT run_id, sync_op_id FROM env_review_runs
        WHERE thread_id = ?
          AND main_session_id = ?
          AND status IN ('syncing', 'queued', 'running')
      `,
      threadId,
      mainSessionId,
    ).toArray() as unknown as Array<{ run_id: string; sync_op_id: string }>;
    const preparationOpIds = new Set<string>();
    for (const row of activeRows) {
      preparationOpIds.add(row.sync_op_id);
      this.appendRunEvent({
        runId: row.run_id,
        type: "run_cancelled",
        message: "Reviewer removed before the run completed.",
      });
      this.updateRun({
        runId: row.run_id,
        status: "cancelled",
        completedAt: now,
        error: "Reviewer removed before the run completed.",
      });
    }
    this.completePreparationOperationsWithoutActiveRuns(preparationOpIds, "Review preparation cancelled because all waiting reviewers were removed.");
    this.db.exec(
      "UPDATE env_review_tabs SET removed_at = ?, updated_at = ? WHERE thread_id = ? AND main_session_id = ?",
      now,
      now,
      threadId,
      mainSessionId,
    );
    return this.getTab(threadId);
  }

  removeReviewerTabIfUnlocked(threadId: string, envSlug: string, mainSessionId: string):
    | { status: "removed"; tab: EnvReviewTab }
    | { status: "not_found" | "skill_child" | "parent_locked"; tab: EnvReviewTab | null } {
    return this.ctx.storage.transactionSync(() => {
      const tab = this.getTab(threadId);
      if (!tab || tab.envSlug !== envSlug || tab.mainSessionId !== mainSessionId) {
        return { status: "not_found" as const, tab };
      }
      if (tab.skillInvocationId) return { status: "skill_child" as const, tab };
      if (this.getActiveSkillInvocationForParent(threadId, mainSessionId)) {
        return { status: "parent_locked" as const, tab };
      }
      const removed = this.removeReviewerTab(threadId, mainSessionId);
      return removed
        ? { status: "removed" as const, tab: removed }
        : { status: "not_found" as const, tab: null };
    });
  }

  cancelRun(runId: string, message = "Reviewer run cancelled."): EnvReviewRun | null {
    const existing = this.getRun(runId);
    if (!existing) return null;
    if (isTerminalRunStatus(existing.status)) return existing;
    const now = nowIso();
    this.appendRunEvent({ runId, type: "run_cancelled", message });
    const cancelled = this.updateRun({
      runId,
      status: "cancelled",
      completedAt: now,
      error: message,
    });
    this.completePreparationOperationsWithoutActiveRuns(new Set([existing.preparationOpId]), "Review preparation cancelled because no active reviewers are waiting for it.");
    return cancelled;
  }

  private completePreparationOperationsWithoutActiveRuns(opIds: Set<string>, message: string): void {
    for (const opId of opIds) {
      const active = this.db.exec(
        `
          SELECT COUNT(*) AS count FROM env_review_runs
          WHERE sync_op_id = ?
            AND status IN ('syncing', 'queued', 'running')
        `,
        opId,
      ).one() as unknown as { count: number };
      if ((active.count ?? 0) > 0) continue;
      const op = this.getPreparationOperation(opId);
      if (!op || terminalStatus(op.status)) continue;
      this.completePreparationOperation({
        opId,
        result: {
          status: "failed",
          opId,
          changedCount: 0,
          deletedCount: 0,
          uploadedBytes: 0,
          completedAt: nowIso(),
          error: message,
        },
        status: "failed",
        error: message,
      });
    }
  }

  beginPreparationOperation(input: {
    opId: string;
    envSlug: string;
    sessionId: string;
    timeoutMs?: number;
    requestUrl?: string | null;
  }): { status: "created" | "existing"; operation: EnvReviewPreparationOperation } {
    this.assertSessionWritable(input.sessionId);
    const timeoutMs = input.timeoutMs ?? ACTIVE_SYNC_TIMEOUT_MS;
    const active = this.db.exec(
      "SELECT * FROM env_review_sync_ops WHERE env_slug = ? AND session_id = ? AND status = 'syncing' ORDER BY started_at DESC LIMIT 1",
      input.envSlug,
      input.sessionId,
    ).toArray()[0] as unknown as PreparationRow | undefined;
    if (active) {
      const startedAtMs = Date.parse(active.started_at);
      if (Number.isFinite(startedAtMs) && Date.now() - startedAtMs < timeoutMs) {
        if (input.requestUrl && !active.request_url) {
          this.db.exec(
            "UPDATE env_review_sync_ops SET request_url = ? WHERE op_id = ?",
            input.requestUrl,
            active.op_id,
          );
        }
        const current = this.getPreparationOperation(active.op_id);
        return { status: "existing", operation: current ?? this.parsePreparation(active) };
      }
      this.completePreparationOperation({
        opId: active.op_id,
        status: "timed_out",
        error: "Timed out waiting for review preparation.",
      });
    }
    const now = nowIso();
    const timeoutAt = new Date(Date.now() + timeoutMs).toISOString();
    this.db.exec(
      `
        INSERT OR IGNORE INTO env_review_sync_ops (
          op_id, env_slug, session_id, status, request_url, sync_attempts, timeout_at, started_at, completed_at, error
        ) VALUES (?, ?, ?, 'syncing', ?, 0, ?, ?, NULL, NULL)
      `,
      input.opId,
      input.envSlug,
      input.sessionId,
      input.requestUrl ?? null,
      timeoutAt,
      now,
    );
    const row = this.db.exec("SELECT * FROM env_review_sync_ops WHERE op_id = ?", input.opId).one() as unknown as PreparationRow;
    return { status: "created", operation: this.parsePreparation(row) };
  }

  getPreparationOperation(opId: string): EnvReviewPreparationOperation | null {
    const row = this.db.exec("SELECT * FROM env_review_sync_ops WHERE op_id = ?", opId).toArray()[0] as unknown as PreparationRow | undefined;
    return row ? this.parsePreparation(row) : null;
  }

  listActivePreparationOperations(): EnvReviewPreparationOperation[] {
    const rows = this.db.exec(
      "SELECT * FROM env_review_sync_ops WHERE status = 'syncing' ORDER BY started_at ASC",
    ).toArray() as unknown as PreparationRow[];
    return rows.map((row) => this.parsePreparation(row));
  }

  listDispatchablePreparationOperations(): EnvReviewPreparationOperation[] {
    const rows = this.db.exec(
      `
        SELECT DISTINCT sync.*
        FROM env_review_sync_ops sync
        JOIN env_review_runs run ON run.sync_op_id = sync.op_id
        WHERE sync.status = 'succeeded'
          AND run.status IN ('syncing', 'queued')
        ORDER BY sync.completed_at ASC
      `,
    ).toArray() as unknown as PreparationRow[];
    return rows.map((row) => this.parsePreparation(row));
  }

  listRunsForPreparationOperation(opId: string): EnvReviewRun[] {
    const rows = this.db.exec(
      "SELECT * FROM env_review_runs WHERE sync_op_id = ? ORDER BY started_at ASC",
      opId,
    ).toArray() as unknown as RunRow[];
    return rows.map((row) => this.parseRun(row));
  }

  markPreparationRequestAttempt(input: {
    opId: string;
    ackToken: string;
    requestedAt?: string;
    snapshotRequest?: EnvReviewSnapshotRequestContract | null;
  }): EnvReviewPreparationOperation | null {
    const existing = this.getPreparationOperation(input.opId);
    if (!existing || terminalStatus(existing.status)) return existing;
    const snapshotRequest = input.snapshotRequest === undefined
      ? existing.snapshotRequest
      : input.snapshotRequest;
    this.db.exec(
      `
        UPDATE env_review_sync_ops
        SET ack_token = ?,
            sync_requested_at = ?,
            sync_attempts = sync_attempts + 1,
            snapshot_request_json = ?
        WHERE op_id = ?
      `,
      input.ackToken,
      input.requestedAt ?? nowIso(),
      snapshotRequest ? JSON.stringify(snapshotRequest) : null,
      input.opId,
    );
    return this.getPreparationOperation(input.opId);
  }

  updatePreparationResult(input: {
    opId: string;
    result: EnvReviewPreparationResult;
    changeSummary?: EnvReviewChangeContext["summary"] | null;
  }): EnvReviewPreparationOperation | null {
    const existing = this.getPreparationOperation(input.opId);
    if (!existing) return null;
    const result = this.preserveImmutableSnapshot(existing.result, input.result);
    this.db.exec(
      `
        UPDATE env_review_sync_ops
        SET result_json = ?
        WHERE op_id = ?
      `,
      JSON.stringify(result),
      input.opId,
    );
    this.db.exec(
      `
        UPDATE env_review_sessions
        SET latest_sync_op_id = ?,
            latest_sync_json = ?,
            latest_change_summary_json = COALESCE(?, latest_change_summary_json),
            updated_at = ?
        WHERE env_slug = ? AND main_session_id = ?
      `,
      input.opId,
      JSON.stringify(result),
      input.changeSummary ? JSON.stringify(input.changeSummary) : null,
      nowIso(),
      existing.envSlug,
      existing.sessionId,
    );
    return this.getPreparationOperation(input.opId);
  }

  completeSnapshotPreparation(input: {
    envSlug: string;
    sessionId: string;
    opId: string;
    uploadToken: string;
    result: EnvReviewPreparationResult;
  }): SnapshotPreparationCompletion {
    const existing = this.getPreparationOperation(input.opId);
    if (!existing) return { status: "rejected", reason: "Review preparation operation not found.", operation: null };
    if (
      existing.envSlug !== input.envSlug
      || existing.sessionId !== input.sessionId
      || existing.ackToken !== input.uploadToken
      || input.result.opId !== input.opId
    ) {
      return { status: "rejected", reason: "Review snapshot upload token is invalid.", operation: existing };
    }
    if (!input.result.snapshot) {
      return { status: "rejected", reason: "Review snapshot metadata is missing.", operation: existing };
    }
    return this.completePreparedSnapshotOperation(existing, input.opId, input.result);
  }

  completeSavedSnapshotPreparation(input: {
    envSlug: string;
    sessionId: string;
    opId: string;
    result: EnvReviewPreparationResult;
  }): SnapshotPreparationCompletion {
    const existing = this.getPreparationOperation(input.opId);
    if (!existing) return { status: "rejected", reason: "Review preparation operation not found.", operation: null };
    if (
      existing.envSlug !== input.envSlug
      || existing.sessionId !== input.sessionId
      || input.result.opId !== input.opId
    ) {
      return { status: "rejected", reason: "Review snapshot preparation operation is invalid.", operation: existing };
    }
    if (!input.result.snapshot) {
      return { status: "rejected", reason: "Review snapshot metadata is missing.", operation: existing };
    }
    return this.completePreparedSnapshotOperation(existing, input.opId, input.result);
  }

  private completePreparedSnapshotOperation(
    existing: EnvReviewPreparationOperation,
    opId: string,
    result: EnvReviewPreparationResult,
  ): SnapshotPreparationCompletion {
    if (terminalStatus(existing.status)) {
      const currentSnapshot = existing.result?.snapshot ?? null;
      if (existing.status === "succeeded" && currentSnapshot) {
        return {
          status: "already_completed",
          operation: existing,
          sameSnapshotHash: currentSnapshot.snapshotHash === result.snapshot?.snapshotHash,
        };
      }
      return { status: "rejected", reason: `Review preparation is already ${existing.status}.`, operation: existing };
    }

    const completed = this.completePreparationOperation({
      opId,
      result,
      status: "succeeded",
      error: null,
    });
    if (!completed) return { status: "rejected", reason: "Review preparation could not be completed.", operation: null };
    return { status: "completed", operation: completed };
  }

  failPreparationOperationIfPreparing(input: {
    opId: string;
    result: EnvReviewPreparationResult;
    error: string;
  }):
    | { status: "failed"; operation: EnvReviewPreparationOperation }
    | { status: "not_preparing"; operation: EnvReviewPreparationOperation | null } {
    const existing = this.getPreparationOperation(input.opId);
    if (!existing || existing.status !== "preparing") {
      return { status: "not_preparing", operation: existing };
    }
    const completed = this.completePreparationOperation({
      opId: input.opId,
      result: input.result,
      status: "failed",
      error: input.error,
    });
    if (!completed || completed.status !== "failed") {
      return { status: "not_preparing", operation: completed };
    }
    return { status: "failed", operation: completed };
  }

  completePreparationOperation(input: {
    opId: string;
    result?: EnvReviewPreparationResult | null;
    status?: EnvReviewPreparationOperation["status"];
    error?: string | null;
    changeSummary?: EnvReviewChangeContext["summary"] | null;
  }): EnvReviewPreparationOperation | null {
    const existing = this.getPreparationOperation(input.opId);
    if (!existing) return null;
    if (terminalStatus(existing.status)) return existing;
    const status = input.status ?? (input.result?.status === "succeeded" ? "succeeded" : "failed");
    const result = input.result ? this.preserveImmutableSnapshot(existing.result, input.result) : input.result;
    const error = input.error ?? result?.error ?? null;
    const completedAt = result?.completedAt ?? nowIso();
    this.db.exec(
      `
        UPDATE env_review_sync_ops
        SET status = ?, result_json = ?, completed_at = ?, error = ?
        WHERE op_id = ?
      `,
      preparationStatusToStorage(status),
      result ? JSON.stringify(result) : null,
      completedAt,
      error,
      input.opId,
    );
    if (result) {
      this.db.exec(
        `
          UPDATE env_review_sessions
          SET latest_sync_op_id = ?, latest_sync_json = ?, latest_change_summary_json = COALESCE(?, latest_change_summary_json), updated_at = ?
          WHERE env_slug = ? AND main_session_id = ?
        `,
        input.opId,
        JSON.stringify(result),
        input.changeSummary ? JSON.stringify(input.changeSummary) : null,
        nowIso(),
        existing.envSlug,
        existing.sessionId,
      );
    }
    return this.getPreparationOperation(input.opId);
  }

  private preserveImmutableSnapshot(
    existing: EnvReviewPreparationResult | null,
    next: EnvReviewPreparationResult,
  ): EnvReviewPreparationResult {
    const snapshot = existing?.snapshot ?? null;
    if (!snapshot) return next;
    if (next.status !== "succeeded") {
      return existing ?? next;
    }
    if (next.snapshot && !snapshotIdentityMatches(snapshot, next.snapshot)) {
      return {
        ...next,
        formatVersion: existing?.formatVersion ?? next.formatVersion,
        snapshot,
      };
    }
    return {
      ...next,
      formatVersion: existing?.formatVersion ?? next.formatVersion,
      snapshot,
    };
  }

  recordChangeSummary(input: {
    envSlug: string;
    mainSessionId: string;
    opId: string;
    summary: EnvReviewChangeContext["summary"];
  }): EnvReviewSession | null {
    this.db.exec(
      `
        UPDATE env_review_sessions
        SET latest_sync_op_id = ?, latest_change_summary_json = ?, updated_at = ?
        WHERE env_slug = ? AND main_session_id = ?
      `,
      input.opId,
      JSON.stringify(input.summary),
      nowIso(),
      input.envSlug,
      input.mainSessionId,
    );
    const row = this.db.exec(
      "SELECT * FROM env_review_sessions WHERE env_slug = ? AND main_session_id = ?",
      input.envSlug,
      input.mainSessionId,
    ).toArray()[0] as unknown as SessionRow | undefined;
    return row ? this.parseSession(row) : null;
  }

  getSkillInvocation(invocationId: string): ReviewSkillInvocation | null {
    const row = this.db.exec(
      "SELECT * FROM env_review_skill_invocations WHERE invocation_id = ?",
      invocationId,
    ).toArray()[0] as unknown as ReviewSkillInvocationRow | undefined;
    return row ? this.parseSkillInvocation(row) : null;
  }

  listSkillInvocations(input: {
    envSlug: string;
    mainSessionId: string;
    limit?: number;
    cursor?: { createdAt: string; invocationId: string } | null;
  }): ReviewSkillInvocation[] {
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const rows = input.cursor
      ? this.db.exec(
        `
          SELECT * FROM env_review_skill_invocations
          WHERE env_slug = ?
            AND (created_at < ? OR (created_at = ? AND invocation_id < ?))
          ORDER BY created_at DESC, invocation_id DESC LIMIT ?
        `,
        input.envSlug,
        input.cursor.createdAt,
        input.cursor.createdAt,
        input.cursor.invocationId,
        limit,
      ).toArray()
      : this.db.exec(
        `
          SELECT * FROM env_review_skill_invocations
          WHERE env_slug = ?
          ORDER BY created_at DESC, invocation_id DESC LIMIT ?
        `,
        input.envSlug,
        limit,
      ).toArray();
    return (rows as unknown as ReviewSkillInvocationRow[]).map((row) => this.parseSkillInvocation(row));
  }

  listSkillInvocationTabs(invocationId: string): EnvReviewTab[] {
    const invocation = this.getSkillInvocation(invocationId);
    if (!invocation) return [];
    const rows = this.db.exec(
      `SELECT * FROM env_review_tabs
       WHERE (thread_id = ? OR skill_root_thread_id = ?)
         AND skill_agent_id IS NOT NULL
       ORDER BY CASE WHEN thread_id = ? THEN 0 ELSE 1 END, created_at ASC, thread_id ASC`,
      invocation.parentThreadId,
      invocation.parentThreadId,
      invocation.parentThreadId,
    ).toArray() as unknown as TabRow[];
    return rows.map((row) => this.parseTab(row));
  }

  listSkillInvocationRuns(invocationId: string): EnvReviewRun[] {
    const rows = this.db.exec(
      "SELECT * FROM env_review_runs WHERE skill_invocation_id = ? ORDER BY started_at ASC, run_id ASC",
      invocationId,
    ).toArray() as unknown as RunRow[];
    return rows.map((row) => this.parseRun(row));
  }

  getActiveSkillInvocationForParent(parentThreadId: string, _mainSessionId?: string): ReviewSkillInvocation | null {
    const row = this.db.exec(
      `
        SELECT * FROM env_review_skill_invocations
        WHERE parent_thread_id = ? AND status IN ('setting_up', 'active')
        ORDER BY created_at DESC LIMIT 1
      `,
      parentThreadId,
    ).toArray()[0] as unknown as ReviewSkillInvocationRow | undefined;
    return row ? this.parseSkillInvocation(row) : null;
  }

  getLatestSkillInvocationForRoot(rootThreadId: string): ReviewSkillInvocation | null {
    const row = this.db.exec(
      `SELECT * FROM env_review_skill_invocations
       WHERE parent_thread_id = ?
       ORDER BY created_at DESC, invocation_id DESC LIMIT 1`,
      rootThreadId,
    ).toArray()[0] as unknown as ReviewSkillInvocationRow | undefined;
    return row ? this.parseSkillInvocation(row) : null;
  }

  reserveTopLevelRun(input: CreateEnvReviewRunInput & {
    requestUrl?: string | null;
    preparationTimeoutMs?: number;
  }):
    | { status: "created" | "existing"; run: EnvReviewRun }
    | { status: "conflict" | "not_found" | "parent_locked"; run?: EnvReviewRun } {
    this.assertSessionWritable(input.mainSessionId);
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getRun(input.runId);
      if (existing) {
        const existingSkillId = existing.skillDefinitionSnapshot?.id ?? null;
        const requestedSkillId = input.skillDefinitionSnapshot?.id ?? null;
        if (
          existing.envSlug !== input.envSlug
          || existing.repoId !== input.repoId
          || existing.mainSessionId !== input.mainSessionId
          || existing.threadId !== input.threadId
          || existingSkillId !== requestedSkillId
          || existing.skillInvocationId
        ) {
          return { status: "conflict" as const, run: existing };
        }
        return { status: "existing" as const, run: existing };
      }
      const parent = this.getTab(input.threadId);
      if (
        !parent
        || parent.envSlug !== input.envSlug
        || parent.repoId !== input.repoId
        || parent.mainSessionId !== input.mainSessionId
      ) {
        return { status: "not_found" as const };
      }
      if (parent.removedAt || parent.skillInvocationId) {
        return { status: "parent_locked" as const };
      }
      if (this.getActiveSkillInvocationForParent(parent.threadId, input.mainSessionId)) {
        return { status: "parent_locked" as const };
      }
      const activeRun = this.db.exec(
        `
          SELECT run_id FROM env_review_runs
          WHERE thread_id = ? AND main_session_id = ? AND status IN ('syncing', 'queued', 'running')
          LIMIT 1
        `,
        parent.threadId,
        input.mainSessionId,
      ).toArray()[0];
      if (activeRun) return { status: "parent_locked" as const };
      const preparation = this.beginPreparationOperation({
        opId: input.preparationOpId,
        envSlug: input.envSlug,
        sessionId: input.mainSessionId,
        timeoutMs: input.preparationTimeoutMs,
        requestUrl: input.requestUrl,
      });
      return {
        status: "created" as const,
        run: this.createRun({ ...input, preparationOpId: preparation.operation.opId }),
      };
    });
  }

  reserveSkillInvocation(input: {
    invocationId: string;
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    parentThreadId: string;
    definitionSnapshot: AgentSkillDefinition;
    overviewMode: SkillAutomationMode;
    preparationOpId: string;
    requestUrl: string;
    overviewRoute?: {
      provider: string;
      model: string;
      effort: PlannerEffort;
    } | null;
    agents: Array<{
      id: string;
      provider: string;
      model: string;
      effort: PlannerEffort;
      launchProvenance: PlannerRunLaunchProvenance;
    }>;
  }):
    | { status: "created" | "existing"; invocation: ReviewSkillInvocation; tabs: EnvReviewTab[]; runs: EnvReviewRun[] }
    | { status: "conflict"; invocation: ReviewSkillInvocation }
    | { status: "parent_locked"; invocation?: ReviewSkillInvocation } {
    this.assertSessionWritable(input.mainSessionId);
    return this.ctx.storage.transactionSync(() => {
      if (input.definitionSnapshot.agents.length === 0) {
        throw new Error("A Review skill must contain at least one agent.");
      }
      if (input.definitionSnapshot.agents.length > 1 && !input.overviewRoute) {
        throw new Error("A multi-agent Review skill requires an Overview route.");
      }
      const existing = this.getSkillInvocation(input.invocationId);
      if (existing) {
        if (
          existing.envSlug !== input.envSlug
          || existing.repoId !== input.repoId
          || existing.mainSessionId !== input.mainSessionId
          || existing.parentThreadId !== input.parentThreadId
          || existing.definitionSnapshot.id !== input.definitionSnapshot.id
        ) {
          return { status: "conflict" as const, invocation: existing };
        }
        return {
          status: "existing" as const,
          invocation: existing,
          tabs: this.listSkillInvocationTabs(existing.invocationId),
          runs: this.listSkillInvocationRuns(existing.invocationId),
        };
      }
      const locked = this.getActiveSkillInvocationForParent(input.parentThreadId);
      if (locked) return { status: "parent_locked" as const, invocation: locked };
      const now = nowIso();
      const preparationStart = this.beginPreparationOperation({
        opId: input.preparationOpId,
        envSlug: input.envSlug,
        sessionId: input.mainSessionId,
        timeoutMs: ACTIVE_SYNC_TIMEOUT_MS,
        requestUrl: input.requestUrl,
      });
      const preparationOpId = preparationStart.operation.opId;
      this.db.exec(
        `
          INSERT INTO env_review_skill_invocations (
            invocation_id, env_slug, repo_id, main_session_id, parent_thread_id,
            definition_snapshot_json, preparation_op_id, status, overview_mode,
            included_message_ids_json, overview_run_id, error, cancelled_at, created_at, updated_at,
            overview_route_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'setting_up', ?, '[]', NULL, NULL, NULL, ?, ?, ?)
        `,
        input.invocationId,
        input.envSlug,
        input.repoId,
        input.mainSessionId,
        input.parentThreadId,
        JSON.stringify(input.definitionSnapshot),
        preparationOpId,
        input.overviewMode,
        now,
        now,
        input.overviewRoute ? JSON.stringify(input.overviewRoute) : null,
      );
      const singleAgent = input.definitionSnapshot.agents.length === 1;
      const rootAgentRoute = singleAgent ? input.agents[0] : null;
      const rootAgent = singleAgent ? input.definitionSnapshot.agents[0] : null;
      const rootRoute = singleAgent ? rootAgentRoute : input.overviewRoute;
      if (!rootRoute) throw new Error("The Review skill root route is unavailable.");
      const root = this.addReviewerTab({
        envSlug: input.envSlug,
        repoId: input.repoId,
        mainSessionId: input.mainSessionId,
        threadId: input.parentThreadId,
        provider: rootRoute.provider,
        model: rootRoute.model,
        effort: rootAgent?.effort ?? input.overviewRoute!.effort,
        roleLabel: input.definitionSnapshot.label,
        taskKind: "custom",
        customTask: rootAgent?.instructions ?? input.definitionSnapshot.overviewInstructions,
        skillInvocationId: input.invocationId,
        ...(rootAgent ? { skillAgentId: rootAgent.id } : {}),
        nodeKind: "skill_root",
        skillRootThreadId: input.parentThreadId,
      });
      for (const agentRoute of input.agents) {
        const agent = input.definitionSnapshot.agents.find((candidate) => candidate.id === agentRoute.id);
        if (!agent) throw new Error(`Skill agent not found: ${agentRoute.id}`);
        const tab = singleAgent
          ? root
          : this.addReviewerTab({
              envSlug: input.envSlug,
              repoId: input.repoId,
              mainSessionId: input.mainSessionId,
              threadId: `env-review-report:${input.invocationId}:${agent.id}`,
              provider: agentRoute.provider,
              model: agentRoute.model,
              effort: agentRoute.effort,
              roleLabel: agent.label,
              taskKind: "custom",
              customTask: agent.instructions,
              skillInvocationId: input.invocationId,
              skillAgentId: agent.id,
              nodeKind: "report",
              skillRootThreadId: input.parentThreadId,
            });
        this.createRun({
          runId: crypto.randomUUID(),
          threadId: tab.threadId,
          envSlug: input.envSlug,
          repoId: input.repoId,
          mainSessionId: input.mainSessionId,
          provider: agentRoute.provider,
          model: agentRoute.model,
          effort: agentRoute.effort,
          roleLabel: agent.label,
          taskKind: "custom",
          customTask: agent.instructions,
          recipeInstructions: composeReviewerInstructions(input.definitionSnapshot.sharedInstructions, agent.instructions),
          preparationOpId,
          skillInvocationId: input.invocationId,
          skillAgentId: agent.id,
          skillRunRole: singleAgent ? "root_initial" : "report_initial",
          skillDefinitionSnapshot: input.definitionSnapshot,
          launchProvenance: agentRoute.launchProvenance,
        });
      }
      const invocation = this.getSkillInvocation(input.invocationId);
      if (!invocation) throw new Error("Failed to reserve review skill invocation.");
      return {
        status: "created" as const,
        invocation,
        tabs: this.listSkillInvocationTabs(input.invocationId),
        runs: this.listSkillInvocationRuns(input.invocationId),
      };
    });
  }

  restartSkillInvocation(input: {
    invocationId: string;
    requestId: string;
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    requestUrl: string;
    overviewRoute?: {
      provider: string;
      model: string;
      effort: PlannerEffort;
    } | null;
    agents: Array<{
      id: string;
      launchProvenance?: PlannerRunLaunchProvenance;
    }>;
  }):
    | { status: "created" | "existing"; invocation: ReviewSkillInvocation; tabs: EnvReviewTab[]; runs: EnvReviewRun[] }
    | { status: "conflict" | "not_found" | "parent_locked"; invocation?: ReviewSkillInvocation } {
    this.assertSessionWritable(input.mainSessionId);
    return this.ctx.storage.transactionSync(() => {
      const invocation = this.getSkillInvocation(input.invocationId);
      if (
        !invocation
        || invocation.envSlug !== input.envSlug
        || invocation.repoId !== input.repoId
      ) {
        return { status: "not_found" as const };
      }
      const definitionAgents = invocation.definitionSnapshot.agents;
      if (
        input.agents.length !== definitionAgents.length
        || definitionAgents.some((agent) => !input.agents.some((candidate) => candidate.id === agent.id))
      ) {
        return { status: "conflict" as const, invocation };
      }
      const replay = this.getSkillInvocation(input.requestId);
      if (replay) {
        if (
          replay.envSlug !== invocation.envSlug
          || replay.repoId !== invocation.repoId
          || replay.parentThreadId !== invocation.parentThreadId
          || replay.definitionSnapshot.id !== invocation.definitionSnapshot.id
        ) return { status: "conflict" as const, invocation: replay };
        return {
          status: "existing" as const,
          invocation: replay,
          tabs: this.listSkillInvocationTabs(replay.invocationId),
          runs: this.listSkillInvocationRuns(replay.invocationId),
        };
      }
      if (
        invocation.status !== "completed"
        && invocation.status !== "failed"
        && invocation.status !== "cancelled"
      ) {
        return { status: "parent_locked" as const, invocation };
      }
      const latest = this.db.exec(
        `SELECT invocation_id FROM env_review_skill_invocations
         WHERE parent_thread_id = ?
         ORDER BY created_at DESC, invocation_id DESC LIMIT 1`,
        invocation.parentThreadId,
      ).toArray()[0] as { invocation_id: string } | undefined;
      if (latest?.invocation_id !== invocation.invocationId) {
        return { status: "conflict" as const, invocation };
      }
      const locked = this.getActiveSkillInvocationForParent(invocation.parentThreadId);
      if (locked) {
        return { status: "parent_locked" as const, invocation: locked };
      }
      const parent = this.getTab(invocation.parentThreadId);
      if (
        !parent
        || parent.envSlug !== input.envSlug
        || parent.repoId !== input.repoId
        || parent.mainSessionId !== input.mainSessionId
        || parent.removedAt
        || parent.nodeKind !== "skill_root"
      ) {
        return { status: "not_found" as const, invocation };
      }
      if (this.listSkillInvocationRuns(invocation.invocationId).some((run) => !isTerminalRunStatus(run.status))) {
        return { status: "parent_locked" as const, invocation };
      }
      const tabs = this.listSkillInvocationTabs(invocation.invocationId);
      const tabByAgentId = new Map(tabs.map((tab) => [tab.skillAgentId, tab]));
      if (definitionAgents.some((agent) => !tabByAgentId.get(agent.id))) {
        return { status: "conflict" as const, invocation };
      }
      if (input.agents.some((agent) => !agent.launchProvenance)) {
        return { status: "conflict" as const, invocation };
      }

      const preparation = this.beginPreparationOperation({
        opId: input.requestId,
        envSlug: input.envSlug,
        sessionId: input.mainSessionId,
        timeoutMs: ACTIVE_SYNC_TIMEOUT_MS,
        requestUrl: input.requestUrl,
      }).operation;
      const now = nowIso();
      this.db.exec(
        `
          INSERT INTO env_review_skill_invocations (
            invocation_id, env_slug, repo_id, main_session_id, parent_thread_id,
            definition_snapshot_json, preparation_op_id,
            status, overview_mode, included_message_ids_json, overview_run_id,
            error, cancelled_at, created_at, updated_at, overview_route_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'setting_up', ?, '[]', NULL, NULL, NULL, ?, ?, ?)
        `,
        input.requestId,
        input.envSlug,
        input.repoId,
        input.mainSessionId,
        invocation.parentThreadId,
        JSON.stringify(invocation.definitionSnapshot),
        preparation.opId,
        invocation.overviewMode,
        now,
        now,
        input.overviewRoute ? JSON.stringify(input.overviewRoute) : null,
      );
      this.db.exec(
        `UPDATE env_review_tabs
         SET skill_invocation_id = ?, updated_at = ?
         WHERE thread_id = ? OR skill_root_thread_id = ?`,
        input.requestId,
        now,
        invocation.parentThreadId,
        invocation.parentThreadId,
      );
      if (input.overviewRoute) {
        this.db.exec(
          `UPDATE env_review_tabs
           SET provider = ?, model = ?, effort = ?, updated_at = ?
           WHERE thread_id = ?`,
          input.overviewRoute.provider,
          input.overviewRoute.model,
          input.overviewRoute.effort,
          now,
          invocation.parentThreadId,
        );
      }
      const runs = definitionAgents.map((agent) => {
        const tab = tabByAgentId.get(agent.id)!;
        const launchProvenance = input.agents.find((candidate) => candidate.id === agent.id)!.launchProvenance!;
        return this.createRun({
          runId: reviewSkillRerunRunId(input.requestId, agent.id),
          threadId: tab.threadId,
          envSlug: input.envSlug,
          repoId: input.repoId,
          mainSessionId: input.mainSessionId,
          provider: tab.provider,
          model: tab.model,
          effort: tab.effort,
          roleLabel: tab.roleLabel,
          taskKind: "custom",
          customTask: REVIEW_SKILL_RERUN_INSTRUCTION,
          recipeInstructions: composeReviewerInstructions(invocation.definitionSnapshot.sharedInstructions, agent.instructions),
          preparationOpId: preparation.opId,
          skillInvocationId: input.requestId,
          skillAgentId: agent.id,
          skillRunRole:
            definitionAgents.length === 1 ? "root_initial" : "report_initial",
          skillDefinitionSnapshot: invocation.definitionSnapshot,
          launchProvenance,
        });
      });
      const restarted = this.getSkillInvocation(input.requestId);
      if (!restarted) throw new Error("Failed to restart Review skill invocation.");
      return {
        status: "created" as const,
        invocation: restarted,
        tabs: this.listSkillInvocationTabs(input.requestId),
        runs,
      };
    });
  }

  activateSkillInvocation(invocationId: string): ReviewSkillInvocation | null {
    const existing = this.getSkillInvocation(invocationId);
    if (!existing || existing.status !== "setting_up") return existing;
    this.db.exec(
      "UPDATE env_review_skill_invocations SET status = 'active', updated_at = ? WHERE invocation_id = ? AND status = 'setting_up'",
      nowIso(),
      invocationId,
    );
    return this.getSkillInvocation(invocationId);
  }

  recordSkillReport(runId: string, messageId: string): ReviewSkillInvocation | null {
    const run = this.getRun(runId);
    if (run?.status !== "ready" || !run.skillInvocationId || run.skillRunRole !== "report_initial" || !run.skillAgentId) return null;
    const invocation = this.getSkillInvocation(run.skillInvocationId);
    if (
      !invocation
      || invocation.definitionSnapshot.agents.length === 1
      || run.preparationOpId !== invocation.preparationOpId
      || invocation.overviewRunId
      || invocation.status !== "active"
    ) return invocation;
    const agent = invocation.definitionSnapshot.agents.find((candidate) => candidate.id === run.skillAgentId);
    if (!agent || agent.reportMode !== "auto") return invocation;
    const included = [...new Set([...invocation.includedMessageIds, messageId])];
    this.db.exec(
      `
        UPDATE env_review_skill_invocations
        SET included_message_ids_json = ?, updated_at = ?
        WHERE invocation_id = ? AND overview_run_id IS NULL AND status = 'active'
      `,
      JSON.stringify(included),
      nowIso(),
      invocation.invocationId,
    );
    return this.getSkillInvocation(invocation.invocationId);
  }

  updateSkillInvocationControls(input: {
    invocationId: string;
    overviewMode: SkillAutomationMode;
    includedMessageIds: string[];
  }): ReviewSkillInvocation | null {
    const existing = this.getSkillInvocation(input.invocationId);
    if (!existing || existing.status !== "active" || existing.overviewRunId) return existing;
    this.db.exec(
      `
        UPDATE env_review_skill_invocations
        SET overview_mode = ?, included_message_ids_json = ?, updated_at = ?
        WHERE invocation_id = ? AND status = 'active' AND overview_run_id IS NULL
      `,
      input.overviewMode,
      JSON.stringify([...new Set(input.includedMessageIds)]),
      nowIso(),
      input.invocationId,
    );
    return this.getSkillInvocation(input.invocationId);
  }

  assignSkillOverview(input: {
    invocationId: string;
    overviewRunId: string;
    expectedOverviewMode: SkillAutomationMode;
    expectedIncludedMessageIds: string[];
    payload: FrozenOverviewPayload;
    provider: string;
    model: string;
    effort: PlannerEffort;
    roleLabel: string;
    preparation: EnvReviewPreparationResult;
    changeContext: EnvReviewChangeContext;
    planBasis: EnvReviewPlanBasis | null;
    prompt: string;
    launchProvenance: PlannerRunLaunchProvenance;
  }): { status: "created" | "existing" | "not_active" | "controls_changed"; invocation: ReviewSkillInvocation; run: EnvReviewRun | null } | null {
    return this.ctx.storage.transactionSync(() => {
      const invocation = this.getSkillInvocation(input.invocationId);
      if (!invocation) return null;
      if (invocation.definitionSnapshot.agents.length === 1) {
        return { status: "not_active" as const, invocation, run: null };
      }
      if (invocation.overviewRunId) {
        return { status: "existing" as const, invocation, run: this.getRun(invocation.overviewRunId) };
      }
      if (invocation.status !== "active") {
        return { status: "not_active" as const, invocation, run: null };
      }
      if (
        invocation.overviewMode !== input.expectedOverviewMode
        || !sameStringSet(invocation.includedMessageIds, input.expectedIncludedMessageIds)
      ) {
        return { status: "controls_changed" as const, invocation, run: null };
      }
      const activeRootRun = this.db.exec(
        `SELECT run_id FROM env_review_runs
         WHERE skill_invocation_id = ?
           AND status IN ('syncing', 'queued', 'running')
         LIMIT 1`,
        invocation.invocationId,
      ).toArray()[0];
      if (activeRootRun) {
        return { status: "controls_changed" as const, invocation, run: null };
      }
      this.db.exec(
        `
          UPDATE env_review_skill_invocations
          SET overview_run_id = ?, updated_at = ?
          WHERE invocation_id = ? AND status = 'active' AND overview_run_id IS NULL
        `,
        input.overviewRunId,
        nowIso(),
        input.invocationId,
      );
      const claimed = this.getSkillInvocation(input.invocationId);
      if (!claimed?.overviewRunId) return { status: "not_active" as const, invocation: claimed ?? invocation, run: null };
      if (claimed.overviewRunId !== input.overviewRunId) {
        return { status: "existing" as const, invocation: claimed, run: this.getRun(claimed.overviewRunId) };
      }
      const run = this.createRun({
        runId: input.overviewRunId,
        threadId: claimed.parentThreadId,
        envSlug: claimed.envSlug,
        repoId: claimed.repoId,
        mainSessionId: claimed.mainSessionId,
        provider: input.provider,
        model: input.model,
        effort: input.effort,
        roleLabel: input.roleLabel,
        taskKind: "custom",
        customTask: "Synthesize the frozen skill reports into one overview.",
        recipeInstructions: claimed.definitionSnapshot.overviewInstructions,
        preparationOpId: claimed.preparationOpId,
        skillInvocationId: claimed.invocationId,
        skillRunRole: "overview",
        skillDefinitionSnapshot: claimed.definitionSnapshot,
        frozenOverview: input.payload,
        preparation: input.preparation,
        changeContext: input.changeContext,
        planBasis: input.planBasis,
        prompt: input.prompt,
        initialStatus: "queued",
        launchProvenance: input.launchProvenance,
      });
      return { status: "created" as const, invocation: claimed, run };
    });
  }

  failSkillInvocation(invocationId: string, error: string): ReviewSkillInvocation | null {
    const existing = this.getSkillInvocation(invocationId);
    if (!existing || existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") return existing;
    const now = nowIso();
    this.db.exec(
      "UPDATE env_review_skill_invocations SET status = 'failed', error = ?, updated_at = ? WHERE invocation_id = ?",
      error,
      now,
      invocationId,
    );
    for (const run of this.listSkillInvocationRuns(invocationId)) {
      if (!isTerminalRunStatus(run.status)) this.updateRun({ runId: run.runId, status: "cancelled", completedAt: now, error });
    }
    this.completePreparationOperationsWithoutActiveRuns(
      new Set([existing.preparationOpId]),
      "Review preparation cancelled because the skill invocation failed.",
    );
    return this.getSkillInvocation(invocationId);
  }

  failStaleSkillInvocations(envSlug: string, mainSessionId: string, cutoffIso: string): ReviewSkillInvocation[] {
    const rows = this.db.exec(
      `
        SELECT * FROM env_review_skill_invocations
        WHERE env_slug = ? AND main_session_id = ? AND status = 'setting_up' AND updated_at < ?
      `,
      envSlug,
      mainSessionId,
      cutoffIso,
    ).toArray() as unknown as ReviewSkillInvocationRow[];
    return rows.map((row) => this.failSkillInvocation(
      row.invocation_id,
      "Skill setup timed out before all child threads were ready.",
    )).filter((invocation): invocation is ReviewSkillInvocation => Boolean(invocation));
  }

  cancelSkillInvocation(invocationId: string): ReviewSkillInvocation | null {
    const existing = this.getSkillInvocation(invocationId);
    if (!existing || existing.status === "completed" || existing.status === "failed" || existing.status === "cancelled") return existing;
    const now = nowIso();
    this.db.exec(
      `
        UPDATE env_review_skill_invocations
        SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE invocation_id = ?
      `,
      now,
      now,
      invocationId,
    );
    for (const run of this.listSkillInvocationRuns(invocationId)) {
      if (!isTerminalRunStatus(run.status)) this.updateRun({
        runId: run.runId,
        status: "cancelled",
        completedAt: now,
        error: "Skill invocation cancelled.",
      });
    }
    this.completePreparationOperationsWithoutActiveRuns(
      new Set([existing.preparationOpId]),
      "Review preparation cancelled because the skill invocation was cancelled.",
    );
    return this.getSkillInvocation(invocationId);
  }

  removeSkillInvocation(input: {
    invocationId: string;
    envSlug: string;
    mainSessionId: string;
  }):
    | { status: "removed"; parentThreadId: string; childThreadIds: string[] }
    | { status: "not_found" }
    | { status: "active" }
    | { status: "runtime_retained" } {
    return this.ctx.storage.transactionSync(() => {
      const invocation = this.getSkillInvocation(input.invocationId);
      if (
        !invocation
        || invocation.envSlug !== input.envSlug
      ) {
        return { status: "not_found" as const };
      }

      const runs = (this.db.exec(
        `SELECT runs.* FROM env_review_runs AS runs
         JOIN env_review_skill_invocations AS invocations
           ON invocations.invocation_id = runs.skill_invocation_id
         WHERE invocations.parent_thread_id = ?`,
        invocation.parentThreadId,
      ).toArray() as unknown as RunRow[]).map((row) => this.parseRun(row));
      const activeInvocation = this.getActiveSkillInvocationForParent(
        invocation.parentThreadId,
      );
      if (
        activeInvocation
        || runs.some((run) => !isTerminalRunStatus(run.status))
      ) {
        return { status: "active" as const };
      }
      if (runs.some((run) => Boolean(run.runtime))) {
        return { status: "runtime_retained" as const };
      }

      const childThreadIds = (this.db.exec(
        `SELECT thread_id FROM env_review_tabs
         WHERE thread_id = ? OR skill_root_thread_id = ?
         ORDER BY created_at ASC, thread_id ASC`,
        invocation.parentThreadId,
        invocation.parentThreadId,
      ).toArray() as Array<{ thread_id: string }>).map((row) => row.thread_id);
      const removedAt = nowIso();
      this.db.exec(
        `UPDATE env_review_tabs
         SET removed_at = ?, updated_at = ?
         WHERE thread_id = ? OR skill_root_thread_id = ?`,
        removedAt,
        removedAt,
        invocation.parentThreadId,
        invocation.parentThreadId,
      );

      return {
        status: "removed" as const,
        parentThreadId: invocation.parentThreadId,
        childThreadIds,
      };
    });
  }

  private refreshSkillInvocationForRun(run: EnvReviewRun): void {
    if (!run.skillInvocationId || !run.skillRunRole || !isTerminalRunStatus(run.status)) return;
    const invocation = this.getSkillInvocation(run.skillInvocationId);
    if (!invocation || invocation.status !== "active") return;
    if (invocation.definitionSnapshot.agents.length === 1) {
      if (run.skillRunRole !== "root_initial" && run.skillRunRole !== "root_followup") return;
      const status = run.status === "ready"
        ? "completed"
        : run.status === "cancelled"
          ? "cancelled"
          : "failed";
      const now = nowIso();
      this.db.exec(
        `UPDATE env_review_skill_invocations
         SET status = ?, error = ?, cancelled_at = ?, updated_at = ?
         WHERE invocation_id = ? AND status = 'active'`,
        status,
        status === "completed" ? null : (run.error ?? `One-agent reviewer ${status}.`),
        status === "cancelled" ? now : null,
        now,
        invocation.invocationId,
      );
      return;
    }
    if (run.skillRunRole === "overview") {
      this.db.exec(
        "UPDATE env_review_skill_invocations SET status = ?, error = ?, updated_at = ? WHERE invocation_id = ? AND status = 'active'",
        run.status === "ready" ? "completed" : "failed",
        run.status === "ready" ? null : (run.error ?? "Overview run failed."),
        nowIso(),
        invocation.invocationId,
      );
      return;
    }
    if (
      (run.skillRunRole !== "report_initial" && run.skillRunRole !== "report_followup")
      || invocation.overviewMode !== "manual"
      || invocation.overviewRunId
    ) return;
    const initialRuns = this.listSkillInvocationRuns(invocation.invocationId).filter((candidate) => (
      candidate.skillRunRole === "report_initial"
      && candidate.preparationOpId === invocation.preparationOpId
    ));
    const childRuns = this.listSkillInvocationRuns(invocation.invocationId).filter((candidate) =>
      candidate.preparationOpId === invocation.preparationOpId
      && (candidate.skillRunRole === "report_initial" || candidate.skillRunRole === "report_followup")
    );
    if (
      initialRuns.length > 0
      && initialRuns.every((candidate) => isTerminalRunStatus(candidate.status))
      && !childRuns.some((candidate) => candidate.status === "ready")
      && !childRuns.some((candidate) => !isTerminalRunStatus(candidate.status))
    ) {
      this.db.exec(
        "UPDATE env_review_skill_invocations SET status = 'failed', error = ?, updated_at = ? WHERE invocation_id = ? AND status = 'active'",
        "No child reviewer produced an eligible report.",
        nowIso(),
        invocation.invocationId,
      );
    }
  }

  createRun(input: CreateEnvReviewRunInput): EnvReviewRun {
    this.assertSessionWritable(input.mainSessionId);
    if (!isCurrentLaunchProvenance(input.launchProvenance)) {
      throw new Error("New Environment Review runs require stored execution provenance.");
    }
    this.getOrCreateSession(input);
    const now = nowIso();
    this.db.exec(
      `
        INSERT INTO env_review_runs (
          run_id, thread_id, env_slug, repo_id, main_session_id, provider, model, effort,
          role_label, task_kind, custom_task, recipe_instructions, status, sync_op_id, started_at,
          skill_invocation_id, skill_agent_id, skill_run_role, skill_definition_snapshot_json,
          frozen_overview_json, sync_json, change_context_json, plan_basis_json, prompt_text, queued_at,
          launch_provenance_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      input.runId,
      input.threadId,
      input.envSlug,
      input.repoId,
      input.mainSessionId,
      input.provider,
      input.model,
      input.effort,
      input.roleLabel,
      input.taskKind,
      input.customTask ?? null,
      input.recipeInstructions ?? null,
      runStatusToStorage(input.initialStatus ?? "preparing"),
      input.preparationOpId,
      now,
      input.skillInvocationId ?? null,
      input.skillAgentId ?? null,
      input.skillRunRole ?? null,
      input.skillDefinitionSnapshot ? JSON.stringify(input.skillDefinitionSnapshot) : null,
      input.frozenOverview ? JSON.stringify(input.frozenOverview) : null,
      input.preparation ? JSON.stringify(input.preparation) : null,
      input.changeContext ? JSON.stringify(input.changeContext) : null,
      input.planBasis ? JSON.stringify(input.planBasis) : null,
      input.prompt ?? null,
      input.initialStatus === "queued" ? now : null,
      input.launchProvenance ? JSON.stringify(input.launchProvenance) : null,
    );
    this.setTabRunState(input.threadId, input.runId, tabStatusForRunStatus(input.initialStatus ?? "preparing"));
    const run = this.getRun(input.runId);
    if (!run) throw new Error("Failed to create env review run.");
    return run;
  }

  createSkillFollowupIfNoActive(input: CreateEnvReviewRunInput):
    | { ok: true; run: EnvReviewRun }
    | { ok: false; active: EnvReviewRun } {
    this.assertSessionWritable(input.mainSessionId);
    return this.ctx.storage.transactionSync(() => {
      if (!input.skillInvocationId) {
        throw new Error("A skill follow-up requires a Review round.");
      }
      const invocation = this.getSkillInvocation(input.skillInvocationId);
      if (
        !invocation
        || invocation.envSlug !== input.envSlug
        || invocation.repoId !== input.repoId
        || invocation.mainSessionId !== input.mainSessionId
      ) {
        throw new Error("Review round not found.");
      }
      const activeRow = this.db.exec(
        `SELECT r.run_id
         FROM env_review_runs r
         JOIN env_review_skill_invocations i
           ON i.invocation_id = r.skill_invocation_id
         WHERE i.parent_thread_id = ?
           AND r.status IN ('syncing', 'queued', 'running')
         LIMIT 1`,
        invocation.parentThreadId,
      ).toArray()[0] as { run_id: string } | undefined;
      if (activeRow) {
        const active = this.getRun(activeRow.run_id);
        if (active) return { ok: false as const, active };
      }
      return { ok: true as const, run: this.createRun(input) };
    });
  }

  getRun(runId: string): EnvReviewRun | null {
    const row = this.db.exec("SELECT * FROM env_review_runs WHERE run_id = ?", runId).toArray()[0] as unknown as RunRow | undefined;
    return row ? this.parseRun(row) : null;
  }

  acceptCodexRuntimeAuth(
    runId: string,
    accountIdInput: string,
  ): "accepted" | "inactive" | "account_changed" {
    const accountId = accountIdInput.trim();
    const run = this.getRun(runId);
    const profile = run?.launchProvenance?.codexExecution;
    if (
      !accountId
      || !run
      || (run.status !== "preparing" && run.status !== "queued" && run.status !== "running")
      || !run.runtime
      || run.provider !== "codex"
      || profile?.kind !== "subscription-app-server"
      || profile.surface !== "environment-reviewer"
    ) return "inactive";
    const accountRow = this.db.exec(
      "SELECT codex_account_id FROM env_review_runs WHERE run_id = ?",
      runId,
    ).toArray()[0] as { codex_account_id: string | null } | undefined;
    if (accountRow?.codex_account_id && accountRow.codex_account_id !== accountId) {
      return "account_changed";
    }
    if (!accountRow?.codex_account_id) {
      this.db.exec(
        "UPDATE env_review_runs SET codex_account_id = ? WHERE run_id = ? AND codex_account_id IS NULL AND status IN ('syncing', 'queued', 'running')",
        accountId,
        runId,
      );
    }
    return "accepted";
  }

 listRuns(runIds: string[]): EnvReviewRun[] {
    if (runIds.length === 0) return [];
    return runIds.map((runId) => this.getRun(runId)).filter((run): run is EnvReviewRun => Boolean(run));
  }

  listActiveRuns(): EnvReviewRun[] {
    const rows = this.db.exec(
      `
        SELECT * FROM env_review_runs
        WHERE status IN ('syncing', 'queued', 'running')
        ORDER BY started_at ASC
      `,
    ).toArray() as unknown as RunRow[];
    return rows.map((row) => this.parseRun(row));
  }

  listWorkloadStateForPredeploy(): Array<{
    runId: string;
    status: string;
    hasRuntime: boolean;
  }> {
    const rows = this.db.exec(
      `
        SELECT run_id, status, runtime_json
        FROM env_review_runs
        ORDER BY started_at ASC
      `,
    ).toArray() as unknown as Array<Pick<RunRow, "run_id" | "status" | "runtime_json">>;
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      hasRuntime: row.runtime_json !== null,
    }));
  }

  updateRun(input: {
    runId: string;
    status?: EnvReviewRunStatus;
    preparation?: EnvReviewPreparationResult | null;
    changeContext?: EnvReviewChangeContext | null;
    planBasis?: EnvReviewPlanBasis | null;
    prompt?: string | null;
    runtime?: EnvReviewRun["runtime"];
    error?: string | null;
    queuedAt?: string | null;
    completedAt?: string | null;
  }): EnvReviewRun | null {
    if (input.runtime && !isCurrentPlannerRuntimeProvenance(input.runtime)) {
      throw new Error("Environment Review runtime provenance is not from the current workload schema.");
    }
    const existing = this.getRun(input.runId);
    if (!existing) return null;
    if (terminalRunStatus(existing.status)) return existing;
    const status = input.status ?? existing.status;
    const queuedAt = input.queuedAt === undefined ? existing.queuedAt : input.queuedAt;
    const completedAt = input.completedAt === undefined ? existing.completedAt : input.completedAt;
    const error = input.error === undefined ? existing.error : input.error;
    this.db.exec(
      `
        UPDATE env_review_runs
        SET status = ?,
            sync_json = ?,
            change_context_json = ?,
            plan_basis_json = ?,
            prompt_text = ?,
            runtime_json = ?,
            queued_at = ?,
            completed_at = ?,
            error = ?
        WHERE run_id = ?
      `,
      runStatusToStorage(status),
      input.preparation === undefined ? (existing.preparation ? JSON.stringify(existing.preparation) : null) : input.preparation ? JSON.stringify(input.preparation) : null,
      input.changeContext === undefined ? (existing.changeContext ? JSON.stringify(existing.changeContext) : null) : input.changeContext ? JSON.stringify(input.changeContext) : null,
      input.planBasis === undefined ? (existing.planBasis ? JSON.stringify(existing.planBasis) : null) : input.planBasis ? JSON.stringify(input.planBasis) : null,
      input.prompt === undefined ? existing.prompt : input.prompt,
      input.runtime === undefined ? (existing.runtime ? JSON.stringify(existing.runtime) : null) : input.runtime ? JSON.stringify(input.runtime) : null,
      queuedAt,
      completedAt,
      error,
      input.runId,
    );
    this.setTabRunState(existing.threadId, input.runId, tabStatusForRunStatus(status));
    const updated = this.getRun(input.runId);
    if (updated) this.refreshSkillInvocationForRun(updated);
    return updated;
  }

  clearRunRuntimeIfCurrent(
    runId: string,
    runtime: PlannerRunRuntimeProvenance,
  ): EnvReviewRun | null {
    const existing = this.getRun(runId);
    if (!existing?.runtime || !sameRunRuntime(existing.runtime, runtime)) {
      return null;
    }
    this.db.exec(
      `
        UPDATE env_review_runs
        SET runtime_json = NULL
        WHERE run_id = ? AND runtime_json = ?
      `,
      runId,
      JSON.stringify(existing.runtime),
    );
    const updated = this.getRun(runId);
    return updated && !updated.runtime ? updated : null;
  }

  async finalizeEnvironmentDeletion(mainSessionIds: string[] = []): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      const retainedRuntime = this.db.exec(
        "SELECT run_id FROM env_review_runs WHERE runtime_json IS NOT NULL LIMIT 1",
      ).toArray()[0] as unknown as { run_id: string } | undefined;
      if (retainedRuntime) {
        throw new Error(
          `Environment review ${retainedRuntime.run_id} retains runtime provenance.`,
        );
      }
      const activeRun = this.db.exec(
        `
          SELECT run_id FROM env_review_runs
          WHERE status IN ('syncing', 'preparing', 'queued', 'running', 'saving')
          LIMIT 1
        `,
      ).toArray()[0] as unknown as { run_id: string } | undefined;
      if (activeRun) {
        throw new Error(`Environment review ${activeRun.run_id} is still active.`);
      }
      const activeSync = this.db.exec(
        "SELECT op_id FROM env_review_sync_ops WHERE status = 'syncing' LIMIT 1",
      ).toArray()[0] as unknown as { op_id: string } | undefined;
      if (activeSync) {
        throw new Error(`Environment review synchronization ${activeSync.op_id} is still active.`);
      }
      const storedSessionIds = this.db.exec(
        "SELECT main_session_id FROM env_review_sessions",
      ).toArray() as unknown as Array<{ main_session_id: string }>;
      const deletedAt = nowIso();
      for (const mainSessionId of new Set([
        ...mainSessionIds.map((value) => value.trim()).filter(Boolean),
        ...storedSessionIds.map((row) => row.main_session_id),
      ])) {
        this.db.exec(
          `INSERT INTO env_review_deleted_sessions (main_session_id, deleted_at)
           VALUES (?, ?)
           ON CONFLICT(main_session_id) DO NOTHING`,
          mainSessionId,
          deletedAt,
        );
      }
      for (const table of [
        "env_review_run_events",
        "env_review_feedback",
        "env_review_skill_invocations",
        "env_review_runs",
        "env_review_tabs",
        "env_review_sync_ops",
        "env_review_sessions",
      ]) {
        this.db.exec(`DELETE FROM ${table}`);
      }
    });
    await this.ctx.storage.deleteAlarm();
  }

  completeRunSuccessfully(input: {
    runId: string;
    messageId: string;
    text: string;
    completedAt?: string;
    eventMessage?: string;
  }):
    | { status: "completed"; run: EnvReviewRun; feedback: EnvReviewFeedback | null }
    | { status: "terminal"; run: EnvReviewRun; feedback: EnvReviewFeedback | null }
    | { status: "not_found"; run: null; feedback: null } {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getRun(input.runId);
      if (!existing) return { status: "not_found" as const, run: null, feedback: null };
      const invocation = existing.skillInvocationId ? this.getSkillInvocation(existing.skillInvocationId) : null;
      const directSkillFeedback = invocation?.definitionSnapshot.agents.length === 1
        && (existing.skillRunRole === "root_initial" || existing.skillRunRole === "root_followup");
      const feedbackId = existing.skillInvocationId && existing.skillRunRole === "overview"
        ? `skill-overview:${existing.runId}`
        : `env-review:${existing.runId}`;
      const shouldCreateFeedback = !existing.skillInvocationId || existing.skillRunRole === "overview" || directSkillFeedback;
      const reviewHandoff = this.fanoutHandoffForRun(existing);
      if (isTerminalRunStatus(existing.status)) {
        return {
          status: "terminal" as const,
          run: existing,
          feedback: shouldCreateFeedback ? this.getFeedback(feedbackId) : null,
        };
      }
      const feedback = shouldCreateFeedback
        ? this.createFeedback({
            feedbackId,
            envSlug: existing.envSlug,
            repoId: existing.repoId,
            mainSessionId: existing.mainSessionId,
            threadId: existing.threadId,
            runId: existing.runId,
            messageId: input.messageId,
            provider: existing.provider,
            model: existing.model,
            roleLabel: existing.roleLabel,
            preparationCompletedAt: existing.preparation?.completedAt ?? null,
            text: input.text,
            metadata: {
              role: existing.roleLabel,
              provider: existing.provider,
              model: existing.model,
              preparationCompletedAt: existing.preparation?.completedAt ?? null,
              runId: existing.runId,
              ...(existing.skillInvocationId ? {
                skillInvocationId: existing.skillInvocationId,
                ...(existing.frozenOverview?.mode ? { overviewMode: existing.frozenOverview.mode } : {}),
              } : {}),
              ...(reviewHandoff ? { reviewHandoff } : {}),
            },
          })
        : null;
      if (feedback && (
        feedback.runId !== existing.runId
        || feedback.messageId !== input.messageId
        || feedback.text !== input.text
      )) {
        throw new Error(`Feedback output conflicts with completed run ${existing.runId}.`);
      }
      const run = this.updateRun({
        runId: existing.runId,
        status: "ready",
        completedAt: input.completedAt ?? nowIso(),
        error: null,
      });
      if (!run || run.status !== "ready") {
        return { status: "terminal" as const, run: run ?? existing, feedback: null };
      }
      if (run.skillInvocationId && run.skillRunRole === "report_initial") {
        this.recordSkillReport(run.runId, input.messageId);
      }
      this.appendRunEvent({
        runId: run.runId,
        type: "run_completed",
        message: input.eventMessage ?? "Reviewer feedback is ready.",
      });
      return { status: "completed" as const, run, feedback };
    });
  }

  private fanoutHandoffForRun(run: EnvReviewRun): EnvReviewFanoutHandoff | null {
    if (!run.skillInvocationId || run.skillRunRole !== "overview" || !run.frozenOverview) return null;
    const definition = run.skillDefinitionSnapshot;
    if (!definition) return null;
    const childRuns = this.listSkillInvocationRuns(run.skillInvocationId)
      .filter((candidate) => (
        candidate.skillRunRole === "report_initial"
        && candidate.preparationOpId === run.preparationOpId
      ));
    const models = definition.agents.reduce<EnvReviewFanoutHandoff["models"]>((unique, agent) => {
      const childRun = childRuns.find((candidate) => candidate.skillAgentId === agent.id);
      if (!childRun) return unique;
      if (!unique.some((target) => target.provider === childRun.provider && target.model === childRun.model)) {
        unique.push({ provider: childRun.provider, model: childRun.model });
      }
      return unique;
    }, []);
    return {
      schemaVersion: 1,
      kind: "fanout_overview",
      skillLabel: definition.label,
      reviewerCount: definition.agents.length,
      models,
    };
  }

  recordRunContact(runId: string): void {
    this.db.exec("UPDATE env_review_runs SET last_contact_at = ? WHERE run_id = ?", nowIso(), runId);
  }

  appendRunEvent(input: { runId: string; type: string; message?: string; data?: unknown }): EnvReviewRunEvent {
    const nextSeq = ((this.db.exec(
      "SELECT COALESCE(MAX(seq), 0) AS seq FROM env_review_run_events WHERE run_id = ?",
      input.runId,
    ).one() as unknown as { seq: number }).seq ?? 0) + 1;
    const createdAt = nowIso();
    this.db.exec(
      `
        INSERT INTO env_review_run_events (
          run_id, seq, type, message, data_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      input.runId,
      nextSeq,
      input.type,
      input.message ?? null,
      input.data === undefined ? null : JSON.stringify(input.data),
      createdAt,
    );
    const deleteBeforeOrAt = nextSeq - MAX_STORED_RUN_EVENTS;
    if (deleteBeforeOrAt > 0) {
      this.db.exec(
        "DELETE FROM env_review_run_events WHERE run_id = ? AND seq <= ?",
        input.runId,
        deleteBeforeOrAt,
      );
    }
    return {
      runId: input.runId,
      seq: nextSeq,
      type: input.type,
      ...(input.message ? { message: input.message } : {}),
      ...(input.data === undefined ? {} : { data: input.data }),
      createdAt,
    };
  }

  listRunEvents(runId: string, afterSeq?: number | null): EnvReviewRunEvent[] {
    const rows = afterSeq != null
      ? this.db.exec(
        "SELECT * FROM env_review_run_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT 200",
        runId,
        afterSeq,
      ).toArray()
      : this.db.exec(
        "SELECT * FROM env_review_run_events WHERE run_id = ? ORDER BY seq ASC LIMIT 200",
        runId,
      ).toArray();
    return (rows as unknown as EventRow[]).map((row) => this.parseEvent(row));
  }

  createFeedback(input: {
    feedbackId?: string;
    envSlug: string;
    repoId: string;
    mainSessionId: string;
    threadId: string;
    runId: string;
    messageId: string;
    provider: string;
    model: string;
    roleLabel: string;
    preparationCompletedAt?: string | null;
    text: string;
    metadata?: Record<string, unknown>;
  }): EnvReviewFeedback {
    this.assertSessionWritable(input.mainSessionId);
    const feedbackId = input.feedbackId ?? crypto.randomUUID();
    const now = nowIso();
    this.db.exec(
      `
        INSERT OR IGNORE INTO env_review_feedback (
          feedback_id, env_slug, repo_id, main_session_id, thread_id, run_id, message_id,
          provider, model, role_label, sync_completed_at, text, status,
          delivered_text, metadata_json, created_at, updated_at, sent_at, dismissed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', NULL, ?, ?, ?, NULL, NULL)
      `,
      feedbackId,
      input.envSlug,
      input.repoId,
      input.mainSessionId,
      input.threadId,
      input.runId,
      input.messageId,
      input.provider,
      input.model,
      input.roleLabel,
      input.preparationCompletedAt ?? null,
      input.text,
      JSON.stringify(input.metadata ?? {}),
      now,
      now,
    );
    const feedback = this.getFeedback(feedbackId);
    if (!feedback) throw new Error("Failed to create env review feedback.");
    return feedback;
  }

  getFeedback(feedbackId: string): EnvReviewFeedback | null {
    const row = this.db.exec("SELECT * FROM env_review_feedback WHERE feedback_id = ?", feedbackId).toArray()[0] as unknown as FeedbackRow | undefined;
    return row ? this.parseFeedback(row) : null;
  }

  claimFeedbackPending(input: {
    feedbackId: string;
    deliveredText: string;
  }): { status: "claimed" | "conflict" | "not_found"; feedback: EnvReviewFeedback | null } {
    const existing = this.getFeedback(input.feedbackId);
    if (!existing) return { status: "not_found", feedback: null };
    if (existing.status !== "ready") return { status: "conflict", feedback: existing };
    const deliveredText = input.deliveredText.trim();
    if (!deliveredText) throw new Error("deliveredText is required");
    this.db.exec(
      `
        UPDATE env_review_feedback
        SET status = 'pending', delivered_text = ?, updated_at = ?
        WHERE feedback_id = ? AND status = 'ready'
      `,
      deliveredText,
      nowIso(),
      input.feedbackId,
    );
    const feedback = this.getFeedback(input.feedbackId);
    return feedback?.status === "pending" && feedback.deliveredText === deliveredText
      ? { status: "claimed", feedback }
      : { status: "conflict", feedback };
  }

  updateFeedbackStatus(input: {
    feedbackId: string;
    status: EnvReviewFeedbackStatus;
    deliveredText?: string | null;
  }): EnvReviewFeedback | null {
    const existing = this.getFeedback(input.feedbackId);
    if (!existing) return null;
    const now = nowIso();
    this.db.exec(
      `
        UPDATE env_review_feedback
        SET status = ?,
            delivered_text = COALESCE(?, delivered_text),
            updated_at = ?,
            sent_at = CASE WHEN ? = 'sent' THEN ? ELSE sent_at END,
            dismissed_at = CASE WHEN ? = 'dismissed' THEN ? ELSE dismissed_at END
        WHERE feedback_id = ?
      `,
      input.status,
      input.deliveredText ?? null,
      now,
      input.status,
      now,
      input.status,
      now,
      input.feedbackId,
    );
    return this.getFeedback(input.feedbackId);
  }

  private setTabRunState(threadId: string, runId: string, status: EnvReviewTabStatus): void {
    this.db.exec(
      "UPDATE env_review_tabs SET latest_run_id = ?, status = ?, updated_at = ? WHERE thread_id = ?",
      runId,
      tabStatusToStorage(status),
      nowIso(),
      threadId,
    );
  }
}
