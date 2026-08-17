import { DurableObject } from "cloudflare:workers";
import { isExecutionPlacement, type Env, type ExecutionPlacement } from "../types";
import { codexExecutionAuthMode } from "../codex-execution";
import type { ReviewerRuntimeEvent } from "../reviewer-runtime-events";
import { composeReviewerInstructions } from "../reviewer-instructions";
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
  CreateCuratedPlanContributionResult,
  CreatePlanContributionInput,
  CreatePlannerRunInput,
  DiscardPlanInput,
  FinishActiveReviewerRunInput,
  FinishActiveReviewerRunResult,
  FrozenOverviewPayload,
  PlanContribution,
  PlanContributionSourceRef,
  PlanContributionListFilter,
  PlanContributionSourceKind,
  PlanContributionStatus,
  PlanArtifactBody,
  PlanAttentionItem,
  PlanHealthAssessment,
  PlanHealthCompletionResult,
  PlanHealthSkillResult,
  PlanWriterStopReason,
  PublishObservedPlanResult,
  ObservedPlanPublication,
  WriterPublicationCursor,
  PlanSkillInvocation,
  PlannerRunBasis,
  PlannerEffort,
  RepoPlanWriterSettings,
  RepoPlanMutationInput,
  RepoPlanMutationResult,
  ResetPlanAgentsInput,
  ResetPlanAgentsResult,
  PlannerRun,
  PlannerRunEvent,
  PlannerRunInput,
  StoredPlannerRunInput,
  PlannerRunRuntimeProvenance,
  PlannerRunLaunchProvenance,
  PlanWriterRuntimeProvenance,
  PlanWriterLaunchProvenance,
  PlanRuntimeCleanupTarget,
  PlannerRunStatus,
  PlanStatus,
  ReviewerRegistryEntry,
  SavePlanInput,
  SavePlanResult,
  SetRefInput,
  UpdatePlannerRunInput,
  UpdateArtifactStatusInput,
  UpsertReviewerInput,
  SkillInvocationStatus,
  SkillAutomationMode,
  SkillRunRole,
  SkillSurface,
} from "./types";
import {
  derivePlanTitleFromMarkdown,
  MAX_PLAN_MARKDOWN_BYTES,
  normalizePlanMarkdown,
  normalizePlanMarkdownAtVersion,
  PLAN_MARKDOWN_NORMALIZATION_VERSION,
  renderArtifactBodyMarkdown,
} from "./planning";
import {
  isCurrentLaunchProvenance,
  isCurrentPlanWriterLaunchProvenance,
  isCurrentPlannerRuntimeProvenance,
  isCurrentPlanWriterRuntimeProvenance,
  parseStoredLaunchProvenance,
  parseStoredPlanWriterRuntimeProvenance,
  parseStoredPlanWriterLaunchProvenance,
  parseStoredRuntimeProvenance,
} from "./execution-provenance";
import { cleanupPlanRuntimeTarget } from "../planner/runtime-cleanup";
import {
  plannerJobSlug,
  planWriterTerminalId,
} from "../planner/runtime-identity";
import {
  BUILTIN_PLAN_HEALTH_SKILL_ID,
  trustedBuiltInInitialResultHandler,
} from "../planner/agent-skills";
import {
  PLAN_HEALTH_RESULT_HANDLER,
  PLAN_HEALTH_TRANSPORT_INSTRUCTION,
  parsePlanHealthAssessment,
  parsePlanHealthOutput,
  parsePlanHealthSkillResult,
  renderPlanHealthResult,
} from "../planner/plan-health";

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
  plan_health_json: string | null;
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
  unread_attention_token: string | null;
  last_settled_sequence: number;
  node_kind: string | null;
  skill_root_thread_id: string | null;
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
  source_refs_json: string | null;
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
  result_json: string | null;
  overview_mode: string | null;
  included_message_ids_json: string | null;
  overview_run_id: string | null;
  overview_route_json: string | null;
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

export interface TerminalPlanCleanupWork {
  terminalWriter: ReviewerRegistryEntry | null;
  runtimeCleanupRuns: PlannerRun[];
  cleanupTargets: PlanRuntimeCleanupTarget[];
}

export interface AbandonPlanWriterResult {
  status: "abandoned" | "stale" | "not_found";
  writer: ReviewerRegistryEntry | null;
  cleanupTargets: PlanRuntimeCleanupTarget[];
}

interface PlanRuntimeCleanupRow {
  cleanup_id: string;
  repo_id: string;
  plan_artifact_id: string;
  target_json: string;
  attempt_count: number;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

interface PlanAgentResetReceiptRow {
  request_hash: string;
  result_json: string;
}

interface PlanAgentResetPreparation {
  plansPreserved: number;
  scribesRemoved: number;
  reviewersRemoved: number;
  runIds: string[];
  writerGenerations: Map<string, number>;
  cleanupTargets: PlanRuntimeCleanupTarget[];
  blockers: Array<{
    kind: "writer" | "reviewer" | "cleanup";
    planArtifactId: string;
    ownerId: string;
    cleanupId?: string;
  }>;
}

class RepositoryFinalizedError extends Error {
  constructor() {
    super("Repository state has been finalized for deletion.");
    this.name = "RepositoryFinalizedError";
  }
}

const MAX_STORED_RUN_EVENTS = 200;
const PLAN_RUNTIME_CLEANUP_RETRY_MS = 30_000;
const PLAN_RUNTIME_CLEANUP_MAX_RETRY_MS = 15 * 60_000;
const PLAN_RUNTIME_CLEANUP_BATCH_SIZE = 25;

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
  return (
    value === "draft" ||
    value === "evaluating" ||
    value === "todo" ||
    value === "completed" ||
    value === "archived"
  );
}

function isPlannerRunStatus(
  value: string | null | undefined,
): value is PlannerRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "saving" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function isPlannerEffort(
  value: string | null | undefined,
): value is PlannerEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "ultra" ||
    value === "max"
  );
}

function isActiveRunStatus(value: PlannerRunStatus): boolean {
  return value === "queued" || value === "running" || value === "saving";
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === left.length && left.every((value) => rightSet.has(value));
}

function isPlanContributionStatus(
  value: string | null | undefined,
): value is PlanContributionStatus {
  return (
    value === "pending" || value === "incorporated" || value === "dismissed"
  );
}

function parseStoredPlannerRunInput(
  value: string | null,
): StoredPlannerRunInput | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as StoredPlannerRunInput;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function stalePlanHealth(
  planHealth: PlanHealthAssessment | undefined,
  staleAt: string,
): PlanHealthAssessment | undefined {
  return planHealth && !planHealth.staleAt
    ? { ...planHealth, staleAt }
    : planHealth;
}

function publicPlannerRunInput(
  input: StoredPlannerRunInput | undefined,
): PlannerRunInput | undefined {
  if (!input) return undefined;
  return {
    ...(typeof input.instruction === "string"
      ? { instruction: input.instruction }
      : {}),
    ...(typeof input.sourcePlanVersion === "number"
      ? { sourcePlanVersion: input.sourcePlanVersion }
      : {}),
    ...(typeof input.githubBaseCommitSha === "string" ||
    input.githubBaseCommitSha === null
      ? { githubBaseCommitSha: input.githubBaseCommitSha }
      : {}),
    ...(input.skillSnapshot ? { skillSnapshot: input.skillSnapshot } : {}),
    ...(input.skillDefinitionSnapshot
      ? { skillDefinitionSnapshot: input.skillDefinitionSnapshot }
      : {}),
    ...(input.basis ? { basis: input.basis } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
    ...(input.frozenOverview
      ? { frozenOverview: input.frozenOverview }
      : {}),
  };
}

function isPlanWriterStopReason(
  value: string | null | undefined,
): value is PlanWriterStopReason {
  return (
    value === "user" ||
    value === "idle" ||
    value === "completed" ||
    value === "archived" ||
    value === "runtime_ended" ||
    value === "mode_invalidated" ||
    value === "watchdog"
  );
}

function parsePublicationCursor(
  value: string | null,
): WriterPublicationCursor | undefined {
  if (!value) return undefined;
  try {
    const cursor = JSON.parse(value) as Partial<WriterPublicationCursor>;
    if (
      Number.isInteger(cursor.sequence) &&
      (cursor.sequence ?? 0) > 0 &&
      typeof cursor.providerEventId === "string" &&
      typeof cursor.bodyDigest === "string" &&
      Number.isInteger(cursor.artifactVersion) &&
      (cursor.result === "updated" || cursor.result === "unchanged")
    ) {
      return cursor as WriterPublicationCursor;
    }
  } catch {
    // A malformed cursor is treated as absent and repaired by a fresh generation.
  }
  return undefined;
}

function isPlanContributionSourceKind(
  value: string | null | undefined,
): value is PlanContributionSourceKind {
  return (
    value === "manual" ||
    value === "reviewer_message" ||
    value === "reviewer_run" ||
    value === "skill_guidance" ||
    value === "skill_overview" ||
    value === "curated_reviewer_handoff"
  );
}

function parsePlanContributionSourceRefs(
  value: string | null,
): PlanContributionSourceRef[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.every(
      (source) =>
        source &&
        typeof source === "object" &&
        typeof (source as PlanContributionSourceRef).threadId === "string" &&
        typeof (source as PlanContributionSourceRef).messageId === "string" &&
        typeof (source as PlanContributionSourceRef).runId === "string",
    )
      ? (parsed as PlanContributionSourceRef[])
      : [];
  } catch {
    return [];
  }
}

function isSkillRunRole(
  value: string | null | undefined,
): value is SkillRunRole {
  return (
    value === "root_initial" ||
    value === "root_followup" ||
    value === "report_initial" ||
    value === "report_followup" ||
    value === "overview"
  );
}

function isSkillInvocationStatus(
  value: string | null | undefined,
): value is SkillInvocationStatus {
  return (
    value === "setting_up" ||
    value === "active" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  );
}

function trustedInitialResultHandler(
  definition: AgentSkillDefinition,
  agents: Array<{ id: string }>,
): typeof PLAN_HEALTH_RESULT_HANDLER | null {
  return trustedBuiltInInitialResultHandler(definition, agents);
}

function samePlanWriterRuntime(
  left: PlanWriterRuntimeProvenance,
  right: PlanWriterRuntimeProvenance,
): boolean {
  return left.jobSlug === right.jobSlug && left.generation === right.generation;
}

function samePlannerRunRuntime(
  left: PlannerRunRuntimeProvenance,
  right: PlannerRunRuntimeProvenance,
): boolean {
  return left.jobSlug === right.jobSlug;
}

function parseCleanupExecutionPlacement(
  value: string | null,
): ExecutionPlacement | null {
  if (!value) return null;
  try {
    return normalizeExecutionPlacement(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function normalizeExecutionPlacement(
  value: unknown,
): ExecutionPlacement | null {
  if (!isExecutionPlacement(value)) return null;
  return value.backend === "cf"
    ? { backend: "cf", machineId: null }
    : { backend: "host", machineId: value.machineId };
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a:${(hash >>> 0).toString(16)}:${value.length}`;
}

function planRuntimeCleanupId(parts: string[]): string {
  return [
    "plan-runtime-cleanup-v1",
    ...parts.map((part) => `${part.length}:${part}`),
  ].join("|");
}

function parsePlanRuntimeCleanupTarget(
  row: PlanRuntimeCleanupRow,
): PlanRuntimeCleanupTarget {
  let value: unknown;
  try {
    value = JSON.parse(row.target_json) as unknown;
  } catch {
    throw new Error(
      `Malformed persisted plan runtime cleanup target: ${row.cleanup_id}`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `Malformed persisted plan runtime cleanup target: ${row.cleanup_id}`,
    );
  }
  const target = value as Record<string, unknown>;
  if (
    (target.schemaVersion !== 1 && target.schemaVersion !== 2) ||
    target.cleanupId !== row.cleanup_id ||
    target.repoId !== row.repo_id ||
    target.planArtifactId !== row.plan_artifact_id ||
    typeof target.ownerId !== "string" ||
    !target.ownerId.trim()
  ) {
    throw new Error(
      `Malformed persisted plan runtime cleanup target: ${row.cleanup_id}`,
    );
  }
  if (target.kind === "writer") {
    const runtime = target.runtime;
    const generation = target.generation;
    if (
      typeof generation !== "number" ||
      !Number.isInteger(generation) ||
      generation < 1
    ) {
      throw new Error(
        `Malformed persisted plan runtime cleanup target: ${row.cleanup_id}`,
      );
    }
    const rawPlacement =
      target.schemaVersion === 2 ? target.placement : target.launchProvenance;
    const placement = normalizeExecutionPlacement(rawPlacement);
    const expectedCleanupId = planRuntimeCleanupId([
      "writer",
      target.repoId as string,
      target.planArtifactId as string,
      target.ownerId as string,
      String(generation),
      runtime && typeof runtime === "object" && "jobSlug" in runtime
        ? String(runtime.jobSlug)
        : "terminal-only",
    ]);
    if (
      target.cleanupId !== expectedCleanupId ||
      (runtime !== null && !isCurrentPlanWriterRuntimeProvenance(runtime)) ||
      (runtime !== null && runtime.generation !== generation) ||
      (runtime !== null && !placement) ||
      (runtime === null && rawPlacement !== null)
    ) {
      throw new Error(
        `Malformed persisted plan runtime cleanup target: ${row.cleanup_id}`,
      );
    }
    return {
      schemaVersion: 2,
      cleanupId: target.cleanupId as string,
      kind: "writer",
      repoId: target.repoId as string,
      planArtifactId: target.planArtifactId as string,
      ownerId: target.ownerId as string,
      generation,
      runtime: runtime as PlanWriterRuntimeProvenance | null,
      placement,
    };
  }
  const runtimeJobSlug = isCurrentPlannerRuntimeProvenance(target.runtime)
    ? target.runtime.jobSlug
    : null;
  const expectedReviewerCleanupId = runtimeJobSlug
    ? planRuntimeCleanupId([
        "reviewer",
        target.repoId as string,
        target.planArtifactId as string,
        target.ownerId as string,
        runtimeJobSlug,
      ])
    : null;
  if (
    target.kind !== "reviewer" ||
    !isCurrentPlannerRuntimeProvenance(target.runtime) ||
    target.cleanupId !== expectedReviewerCleanupId ||
    !normalizeExecutionPlacement(
      target.schemaVersion === 2 ? target.placement : target.launchProvenance,
    )
  ) {
    throw new Error(
      `Malformed persisted plan runtime cleanup target: ${row.cleanup_id}`,
    );
  }
  return {
    schemaVersion: 2,
    cleanupId: target.cleanupId as string,
    kind: "reviewer",
    repoId: target.repoId as string,
    planArtifactId: target.planArtifactId as string,
    ownerId: target.ownerId as string,
    runtime: target.runtime,
    placement: normalizeExecutionPlacement(
      target.schemaVersion === 2 ? target.placement : target.launchProvenance,
    )!,
  };
}

function normalizePlanRuntimeCleanupTarget(
  target: PlanRuntimeCleanupTarget,
): PlanRuntimeCleanupTarget {
  return parsePlanRuntimeCleanupTarget({
    cleanup_id: target.cleanupId,
    repo_id: target.repoId,
    plan_artifact_id: target.planArtifactId,
    target_json: JSON.stringify(target),
    attempt_count: 0,
    last_error: null,
    created_at: "",
    updated_at: "",
  });
}

function samePlanRuntimeCleanupTarget(
  left: PlanRuntimeCleanupTarget,
  right: PlanRuntimeCleanupTarget,
): boolean {
  return (
    JSON.stringify(normalizePlanRuntimeCleanupTarget(left)) ===
    JSON.stringify(normalizePlanRuntimeCleanupTarget(right))
  );
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
        version INTEGER,
        risk_assessment_json TEXT,
        plan_health_json TEXT
      )
    `);

    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE artifacts ADD COLUMN status TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE artifacts ADD COLUMN updated_at TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE artifacts ADD COLUMN version INTEGER",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE artifacts ADD COLUMN plan_health_json TEXT",
    );

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
        ,node_kind TEXT NOT NULL DEFAULT 'generic'
        ,skill_root_thread_id TEXT
      )
    `);

    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN provider TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN model TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN effort TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN skill TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN role TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN run_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN status TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN error TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN provider_conversation_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN node_kind TEXT NOT NULL DEFAULT 'generic'",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN skill_root_thread_id TEXT",
    );

    this.dropReviewerModelUniqueConstraint(db);

    // The constraint rebuild above recreates reviewer_registry without Plan
    // Writer columns, so these ALTERs must run after it.
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN node_kind TEXT NOT NULL DEFAULT 'generic'",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN skill_root_thread_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN job_slug TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN generation INTEGER",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN stopped_at TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN stop_reason TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN basis_commit TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN start_body_digest TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN publication_cursor_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN synchronization_error TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN startup_error TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN cleanup_error TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN runtime_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN launch_provenance_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN codex_account_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN skill_invocation_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN skill_agent_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN unread_attention_token TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE reviewer_registry ADD COLUMN last_settled_sequence INTEGER NOT NULL DEFAULT 0",
    );

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
        source_refs_json TEXT,
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

    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_contributions ADD COLUMN source_kind TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_contributions ADD COLUMN source_message_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_contributions ADD COLUMN source_plan_version INTEGER",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_contributions ADD COLUMN source_refs_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_contributions ADD COLUMN idempotency_key TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_contributions ADD COLUMN incorporated_at TEXT",
    );
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
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE repo_plan_writer_settings ADD COLUMN effort TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE repo_plan_writer_settings ADD COLUMN fast_mode INTEGER NOT NULL DEFAULT 0",
    );

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
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planning_skills ADD COLUMN surface TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planning_skills ADD COLUMN definition_json TEXT",
    );

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

    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN input_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN runtime_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN launch_provenance_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN codex_account_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN last_contact_at TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN skill_invocation_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN skill_agent_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE planner_runs ADD COLUMN skill_run_role TEXT",
    );

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
        updated_at TEXT NOT NULL,
        result_json TEXT,
        overview_mode TEXT NOT NULL DEFAULT 'auto',
        included_message_ids_json TEXT NOT NULL DEFAULT '[]',
        overview_run_id TEXT,
        overview_route_json TEXT
      )
    `);
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_skill_invocations ADD COLUMN result_json TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_skill_invocations ADD COLUMN overview_mode TEXT NOT NULL DEFAULT 'auto'",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_skill_invocations ADD COLUMN included_message_ids_json TEXT NOT NULL DEFAULT '[]'",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_skill_invocations ADD COLUMN overview_run_id TEXT",
    );
    execIgnoringDuplicateColumn(
      db,
      "ALTER TABLE plan_skill_invocations ADD COLUMN overview_route_json TEXT",
    );
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
      CREATE TABLE IF NOT EXISTS plan_runtime_cleanup (
        cleanup_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL,
        target_json TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_plan_runtime_cleanup_repo_plan_created
      ON plan_runtime_cleanup(repo_id, plan_artifact_id, created_at ASC)
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_writer_generation_fences (
        repo_id TEXT NOT NULL,
        plan_artifact_id TEXT NOT NULL,
        last_generation INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, plan_artifact_id)
      )
    `);
    db.exec(`
      INSERT INTO plan_writer_generation_fences (
        repo_id, plan_artifact_id, last_generation, updated_at
      )
      SELECT repo_id, plan_artifact_id, MAX(generation), MAX(updated_at)
      FROM reviewer_registry
      WHERE role = 'writer' AND generation IS NOT NULL AND generation >= 1
      GROUP BY repo_id, plan_artifact_id
      ON CONFLICT(repo_id, plan_artifact_id) DO UPDATE SET
        last_generation = MAX(last_generation, excluded.last_generation),
        updated_at = CASE
          WHEN excluded.last_generation > last_generation THEN excluded.updated_at
          ELSE updated_at
        END
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS retired_planner_run_ids (
        repo_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        PRIMARY KEY (repo_id, run_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS plan_agent_reset_receipts (
        repo_id TEXT NOT NULL,
        reset_id TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo_id, reset_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS repository_deletion (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        deleted_at TEXT NOT NULL
      )
    `);
  }

  private assertRepositoryWritable(): void {
    const deleted = this.db
      .exec("SELECT singleton FROM repository_deletion LIMIT 1")
      .toArray()[0];
    if (deleted) {
      throw new RepositoryFinalizedError();
    }
  }

  private dropReviewerModelUniqueConstraint(db: SqlStorage): void {
    const indexes = db
      .exec("PRAGMA index_list(reviewer_registry)")
      .toArray() as Array<{
      unique: number;
      origin?: string;
    }>;
    const hasModelUniqueConstraint = indexes.some(
      (index) => Number(index.unique) === 1 && index.origin === "u",
    );
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
    const planHealth =
      row.type === "plan"
        ? parsePlanHealthAssessment(row.plan_health_json)
        : undefined;
    return {
      id: row.id,
      repoId: row.repo_id,
      type: row.type,
      basis: JSON.parse(row.basis_json),
      title: row.title,
      body: JSON.parse(row.body_json),
      ...(row.parent_artifact_id
        ? { parentArtifactId: row.parent_artifact_id }
        : {}),
      ...(row.supersedes_artifact_id
        ? { supersedesArtifactId: row.supersedes_artifact_id }
        : {}),
      ...(row.created_by ? { createdBy: row.created_by } : {}),
      createdAt: row.created_at,
      status: isPlanStatus(row.status) ? row.status : "draft",
      updatedAt: row.updated_at ?? row.created_at,
      version: row.version ?? 1,
      ...(planHealth ? { planHealth } : {}),
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

  private parseReviewerRegistryRow(
    row: ReviewerRegistryRow,
  ): ReviewerRegistryEntry {
    const provider = row.provider?.trim();
    const model = row.model?.trim();
    if (
      !provider ||
      !model ||
      (row.role !== "reviewer" && row.role !== "writer")
    ) {
      throw new Error(`Malformed planning registry row: ${row.thread_id}`);
    }
    const writer = row.role === "writer";
    const runtime = parseStoredPlanWriterRuntimeProvenance(
      row.runtime_json,
      "plan writer runtime",
    );
    const launchProvenance = writer
      ? parseStoredPlanWriterLaunchProvenance(
          row.launch_provenance_json,
          "plan writer launch",
          {
            repositoryId: row.repo_id,
            planId: row.plan_artifact_id,
            generation: row.generation ?? 0,
          },
        )
      : null;
    if (
      writer &&
      launchProvenance &&
      (launchProvenance.skillProjection.repositoryId !== row.repo_id ||
        launchProvenance.skillProjection.planId !== row.plan_artifact_id ||
        launchProvenance.skillProjection.generation !== row.generation)
    ) {
      throw new Error(`Malformed planning registry row: ${row.thread_id}`);
    }
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
      ...(codexExecution
        ? {
            codexAuthMode: codexExecutionAuthMode(codexExecution),
          }
        : {}),
      ...(typeof row.generation === "number"
        ? { generation: row.generation }
        : {}),
      ...(row.stopped_at ? { stoppedAt: row.stopped_at } : {}),
      ...(isPlanWriterStopReason(row.stop_reason)
        ? { stopReason: row.stop_reason }
        : {}),
      ...(row.basis_commit ? { basisCommit: row.basis_commit } : {}),
      ...(row.start_body_digest
        ? { startBodyDigest: row.start_body_digest }
        : {}),
      ...(parsePublicationCursor(row.publication_cursor_json)
        ? {
            publicationCursor: parsePublicationCursor(
              row.publication_cursor_json,
            ),
          }
        : {}),
      ...(row.synchronization_error
        ? { synchronizationError: row.synchronization_error }
        : {}),
      ...(row.startup_error ? { startupError: row.startup_error } : {}),
      ...(row.cleanup_error ? { cleanupError: row.cleanup_error } : {}),
      ...(row.skill_invocation_id
        ? { skillInvocationId: row.skill_invocation_id }
        : {}),
      ...(row.skill_agent_id ? { skillAgentId: row.skill_agent_id } : {}),
      nodeKind:
        row.node_kind === "skill_root" || row.node_kind === "report"
          ? row.node_kind
          : "generic",
      skillRootThreadId: row.skill_root_thread_id,
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(isPlannerRunStatus(row.status) ? { status: row.status } : {}),
      ...(row.error ? { error: row.error } : {}),
      ...(row.provider_conversation_id
        ? { providerConversationId: row.provider_conversation_id }
        : {}),
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
      sourceKind: isPlanContributionSourceKind(row.source_kind)
        ? row.source_kind
        : "manual",
      ...(row.source_run_id ? { sourceRunId: row.source_run_id } : {}),
      ...(row.source_thread_id ? { sourceThreadId: row.source_thread_id } : {}),
      ...(row.source_message_id
        ? { sourceMessageId: row.source_message_id }
        : {}),
      ...(typeof row.source_plan_version === "number"
        ? { sourcePlanVersion: row.source_plan_version }
        : {}),
      sourceRefs: parsePlanContributionSourceRefs(row.source_refs_json),
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
    const input = publicPlannerRunInput(
      parseStoredPlannerRunInput(row.input_json),
    );
    const runtime = parseStoredRuntimeProvenance<PlannerRunRuntimeProvenance>(
      row.runtime_json,
      "planner run runtime",
    );
    const launchProvenance =
      parseStoredLaunchProvenance<PlannerRunLaunchProvenance>(
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
      ...(codexExecution
        ? {
            codexAuthMode: codexExecutionAuthMode(codexExecution),
          }
        : {}),
      ...(row.skill_invocation_id
        ? { skillInvocationId: row.skill_invocation_id }
        : {}),
      ...(row.skill_agent_id ? { skillAgentId: row.skill_agent_id } : {}),
      ...(isSkillRunRole(row.skill_run_role)
        ? { skillRunRole: row.skill_run_role }
        : {}),
      ...(row.last_contact_at ? { lastContactAt: row.last_contact_at } : {}),
    };
  }

  private parsePlanSkillInvocationRow(
    row: PlanSkillInvocationRow,
  ): PlanSkillInvocation {
    return {
      invocationId: row.invocation_id,
      repoId: row.repo_id,
      planArtifactId: row.plan_artifact_id,
      parentThreadId: row.parent_thread_id,
      definitionSnapshot: JSON.parse(
        row.definition_snapshot_json,
      ) as AgentSkillDefinition,
      basis: JSON.parse(row.basis_json) as PlannerRunBasis,
      status: isSkillInvocationStatus(row.status) ? row.status : "failed",
      overviewMode: row.overview_mode === "manual" ? "manual" : "auto",
      includedMessageIds: row.included_message_ids_json
        ? (JSON.parse(row.included_message_ids_json) as string[])
        : [],
      overviewRunId: row.overview_run_id,
      overviewRoute: row.overview_route_json
        ? JSON.parse(row.overview_route_json)
        : null,
      error: row.error,
      cancelledAt: row.cancelled_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      result: parsePlanHealthSkillResult(row.result_json),
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
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          left.slug.localeCompare(right.slug),
      );

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const liveSlugs = new Set(entries.map((entry) => entry.slug));
      const existingRows = this.db
        .exec("SELECT * FROM environment_sidebar_slots ORDER BY slot ASC")
        .toArray() as unknown as EnvironmentSidebarSlotRow[];

      for (const row of existingRows) {
        const expiredReservation =
          row.state === "reserved" &&
          (!Number.isFinite(row.lease_expires_at_ms) ||
            row.lease_expires_at_ms! <= now);
        if (
          !liveSlugs.has(row.env_slug) &&
          (row.state === "committed" || expiredReservation)
        ) {
          this.db.exec(
            "DELETE FROM environment_sidebar_slots WHERE env_slug = ?",
            row.env_slug,
          );
        }
      }

      const retainedRows = this.db
        .exec("SELECT * FROM environment_sidebar_slots ORDER BY slot ASC")
        .toArray() as unknown as EnvironmentSidebarSlotRow[];
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

        const preferred =
          Number.isInteger(entry.sidebarSlot) && (entry.sidebarSlot ?? 0) > 0
            ? entry.sidebarSlot!
            : null;
        const slot =
          preferred && !usedSlots.has(preferred) ? preferred : nextFreeSlot();
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
    if (!slug || !claimId)
      throw new Error(
        "Environment sidebar slot claims require slug and claimId.",
      );

    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const existing = this.db
        .exec(
          "SELECT * FROM environment_sidebar_slots WHERE env_slug = ?",
          slug,
        )
        .toArray()[0] as unknown as EnvironmentSidebarSlotRow | undefined;
      if (existing) {
        if (existing.state === "reserved" && existing.claim_id === claimId) {
          return { status: "claimed" as const, slot: existing.slot };
        }
        if (
          existing.state === "reserved" &&
          (!Number.isFinite(existing.lease_expires_at_ms) ||
            existing.lease_expires_at_ms! <= now)
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

      const rows = this.db
        .exec("SELECT slot FROM environment_sidebar_slots ORDER BY slot ASC")
        .toArray() as unknown as Array<{ slot: number }>;
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
      const row = this.db
        .exec(
          "SELECT * FROM environment_sidebar_slots WHERE env_slug = ?",
          slug,
        )
        .toArray()[0] as unknown as EnvironmentSidebarSlotRow | undefined;
      if (!row) return false;
      if (row.state === "committed") return true;
      if (row.claim_id !== claimId) return false;
      if (
        !Number.isFinite(row.lease_expires_at_ms) ||
        row.lease_expires_at_ms! <= Date.now()
      )
        return false;
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

  createArtifact<TBody = unknown>(
    input: CreateArtifactInput<TBody>,
  ): Artifact<TBody> {
    this.assertRepositoryWritable();
    if (input.type === "plan" && !input.basis.mainCommit?.trim()) {
      throw new Error(
        "Plan artifacts require a frozen basis commit at creation.",
      );
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
      ...(input.parentArtifactId
        ? { parentArtifactId: input.parentArtifactId }
        : {}),
      ...(input.supersedesArtifactId
        ? { supersedesArtifactId: input.supersedesArtifactId }
        : {}),
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
    const row = this.db
      .exec("SELECT * FROM artifacts WHERE id = ?", id)
      .toArray()[0] as unknown as ArtifactRow | undefined;
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

    const rows = this.db
      .exec(
        `
        SELECT *
        FROM artifacts
        WHERE ${clauses.join(" AND ")}
        ORDER BY COALESCE(updated_at, created_at) DESC
        LIMIT ?
      `,
        ...values,
      )
      .toArray() as unknown as ArtifactRow[];

    return rows.map((row) => this.parseArtifactRow(row));
  }

  /** Atomic mutation boundary for repository-scoped Scribe plan tools. */
  mutateRepoPlan(input: RepoPlanMutationInput): RepoPlanMutationResult {
    return this.ctx.storage.transactionSync((): RepoPlanMutationResult => {
      // Repository deletion finalization must be the first store read in this
      // transaction so it wins over validation, no-op, and replay paths.
      try {
        this.assertRepositoryWritable();
      } catch (error) {
        if (!(error instanceof RepositoryFinalizedError)) throw error;
        return { ok: false, code: "source_inactive" };
      }

      const sourceWriter = this.getPlanWriter(input.repoId, input.sourcePlanId);
      const sourcePlan = this.getArtifact(input.sourcePlanId);
      if (
        !sourceWriter ||
        sourceWriter.generation !== input.sourceGeneration ||
        sourceWriter.stoppedAt ||
        !sourceWriter.runtime ||
        !sourceWriter.basisCommit?.trim() ||
        !sourcePlan ||
        sourcePlan.repoId !== input.repoId ||
        sourcePlan.type !== "plan" ||
        sourcePlan.basis.repoId !== input.repoId ||
        sourcePlan.basis.mainCommit !== sourceWriter.basisCommit
      ) {
        return { ok: false, code: "source_inactive" };
      }
      const targetPlanId =
        input.kind === "create"
          ? `plan-tool-${input.requestId}`
          : input.targetPlanId;
      if (targetPlanId === input.sourcePlanId) {
        return { ok: false, code: "self_target" };
      }

      const existing = this.getArtifact(targetPlanId);
      if (input.kind === "create") {
        const title = derivePlanTitleFromMarkdown(input.markdown).trim();
        if (!title) return { ok: false, code: "invalid_request" };
        const creator = `plan-writer:${input.sourcePlanId}:${input.sourceGeneration}`;
        if (existing) {
          const samePlan =
            existing.repoId === input.repoId &&
            existing.type === "plan" &&
            existing.createdBy === creator &&
            !existing.parentArtifactId &&
            existing.basis.repoId === input.repoId &&
            existing.basis.mainCommit === sourceWriter.basisCommit &&
            normalizePlanMarkdown(renderArtifactBodyMarkdown(existing.body)) ===
              input.markdown;
          if (!samePlan) return { ok: false, code: "idempotency_conflict" };
          return {
            ok: true,
            outcome: "replayed",
            artifact: existing as Artifact<PlanArtifactBody>,
          };
        }

        const artifact = this.createArtifact<PlanArtifactBody>({
          id: targetPlanId,
          repoId: input.repoId,
          type: "plan",
          basis: {
            repoId: input.repoId,
            mainCommit: sourceWriter.basisCommit,
          },
          title,
          body: { markdown: input.markdown },
          status: "draft",
          createdBy: creator,
          version: 2,
        });
        return { ok: true, outcome: "created", artifact };
      }

      if (
        !existing ||
        existing.repoId !== input.repoId ||
        existing.type !== "plan" ||
        existing.basis.repoId !== input.repoId ||
        !existing.basis.mainCommit?.trim()
      ) {
        return { ok: false, code: "plan_not_found" };
      }
      const currentVersion = existing.version ?? 1;
      const currentMarkdown = normalizePlanMarkdown(
        renderArtifactBodyMarkdown(existing.body),
      );

      if (
        currentVersion === input.expectedVersion + 1 &&
        currentMarkdown === input.markdown
      ) {
        return {
          ok: true,
          outcome: "replayed",
          artifact: existing as Artifact<PlanArtifactBody>,
        };
      }
      if (currentVersion !== input.expectedVersion) {
        return { ok: false, code: "version_conflict", currentVersion };
      }
      if (
        existing.status !== "draft" &&
        existing.status !== "evaluating" &&
        existing.status !== "todo"
      ) {
        return { ok: false, code: "plan_not_editable" };
      }
      const targetWriter = this.getPlanWriter(input.repoId, input.targetPlanId);
      if (targetWriter && !targetWriter.stoppedAt) {
        return { ok: false, code: "target_writer_active" };
      }

      const saved = this.savePlan({
        repoId: input.repoId,
        id: targetPlanId,
        markdown: input.markdown,
      });
      return {
        ok: true,
        outcome: saved.changed ? "updated" : "unchanged",
        artifact: saved.artifact,
      };
    });
  }

  private fencePlanRuntimeWork(
    repoId: string,
    planArtifactId: string,
    reason: PlanWriterStopReason,
    now: string,
  ): void {
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET unread_attention_token = NULL
        WHERE repo_id = ? AND plan_artifact_id = ?
      `,
      repoId,
      planArtifactId,
    );
    this.db.exec(
      `
        UPDATE plan_skill_invocations
        SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?),
            error = NULL, updated_at = ?
        WHERE repo_id = ? AND plan_artifact_id = ?
          AND status IN ('setting_up', 'active')
      `,
      now,
      now,
      repoId,
      planArtifactId,
    );
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET status = 'cancelled', error = NULL, updated_at = ?
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = 'reviewer'
          AND run_id IN (
            SELECT run_id
            FROM planner_runs
            WHERE repo_id = ? AND plan_artifact_id = ?
              AND status IN ('queued', 'running', 'saving')
          )
      `,
      now,
      repoId,
      planArtifactId,
      repoId,
      planArtifactId,
    );
    this.db.exec(
      `
        UPDATE planner_runs
        SET status = 'cancelled', completed_at = COALESCE(completed_at, ?), error = NULL
        WHERE repo_id = ? AND plan_artifact_id = ?
          AND status IN ('queued', 'running', 'saving')
      `,
      now,
      repoId,
      planArtifactId,
    );
    this.db.exec(
      `
        UPDATE reviewer_registry
        SET stopped_at = ?, stop_reason = ?, status = 'cancelled', updated_at = ?
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = 'writer'
          AND stopped_at IS NULL
      `,
      now,
      reason,
      now,
      repoId,
      planArtifactId,
    );
  }

  private readRetainedPlanCleanupWork(
    repoId: string,
    planArtifactId: string,
  ): TerminalPlanCleanupWork {
    const writer = this.getPlanWriter(repoId, planArtifactId);
    const rows = this.db
      .exec(
        `
        SELECT *
        FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = 'reviewer'
          AND runtime_json IS NOT NULL
        ORDER BY started_at ASC, run_id ASC
      `,
        repoId,
        planArtifactId,
      )
      .toArray() as unknown as PlannerRunRow[];
    const terminalWriter =
      writer && (!writer.stoppedAt || writer.runtime || writer.jobSlug)
        ? writer
        : null;
    const runtimeCleanupRuns = rows.map((row) => this.parsePlannerRunRow(row));
    const cleanupTargets = this.listPlanRuntimeCleanupTargetsForPlan(
      repoId,
      planArtifactId,
    );
    const appendCleanupTarget = (target: PlanRuntimeCleanupTarget) => {
      if (
        !cleanupTargets.some(
          (existing) => existing.cleanupId === target.cleanupId,
        )
      ) {
        cleanupTargets.push(target);
      }
    };
    if (terminalWriter) {
      appendCleanupTarget(this.planWriterCleanupTarget(terminalWriter));
    }
    for (const run of runtimeCleanupRuns) {
      if (!run.runtime) continue;
      if (!run.launchProvenance) {
        throw new Error(
          `Planner run ${run.runId} cleanup ownership is missing its launch provenance.`,
        );
      }
      const cleanupId = planRuntimeCleanupId([
        "reviewer",
        repoId,
        planArtifactId,
        run.runId,
        run.runtime.jobSlug,
      ]);
      appendCleanupTarget({
        schemaVersion: 2,
        cleanupId,
        kind: "reviewer",
        repoId,
        planArtifactId,
        ownerId: run.runId,
        runtime: run.runtime,
        placement: normalizeExecutionPlacement(run.launchProvenance)!,
      });
    }
    return { terminalWriter, runtimeCleanupRuns, cleanupTargets };
  }

  private planWriterCleanupTarget(
    writer: ReviewerRegistryEntry,
  ): PlanRuntimeCleanupTarget {
    const generation = writer.generation;
    if (!generation) {
      throw new Error(
        "Plan Writer cleanup ownership is missing its generation.",
      );
    }
    const runtime =
      writer.runtime ??
      (writer.jobSlug ? { jobSlug: writer.jobSlug, generation } : null);
    if (runtime && !writer.launchProvenance) {
      throw new Error(
        "Plan Writer cleanup ownership is missing its launch provenance.",
      );
    }
    return {
      schemaVersion: 2,
      cleanupId: planRuntimeCleanupId([
        "writer",
        writer.repoId,
        writer.planArtifactId,
        writer.threadId,
        String(generation),
        runtime?.jobSlug ?? "terminal-only",
      ]),
      kind: "writer",
      repoId: writer.repoId,
      planArtifactId: writer.planArtifactId,
      ownerId: writer.threadId,
      generation,
      runtime,
      placement: runtime
        ? normalizeExecutionPlacement(writer.launchProvenance)!
        : null,
    };
  }

  private enqueuePlanRuntimeCleanupTargets(
    targets: PlanRuntimeCleanupTarget[],
    now: string,
  ): void {
    for (const candidate of targets) {
      const target = normalizePlanRuntimeCleanupTarget(candidate);
      const encoded = JSON.stringify(target);
      this.db.exec(
        `
          INSERT INTO plan_runtime_cleanup (
            cleanup_id, repo_id, plan_artifact_id, target_json,
            attempt_count, last_error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)
          ON CONFLICT(cleanup_id) DO NOTHING
        `,
        target.cleanupId,
        target.repoId,
        target.planArtifactId,
        encoded,
        now,
        now,
      );
      const stored = this.db
        .exec(
          "SELECT * FROM plan_runtime_cleanup WHERE cleanup_id = ?",
          target.cleanupId,
        )
        .toArray()[0] as unknown as PlanRuntimeCleanupRow | undefined;
      const storedTarget = stored
        ? parsePlanRuntimeCleanupTarget(stored)
        : null;
      if (
        !storedTarget ||
        !samePlanRuntimeCleanupTarget(storedTarget, target)
      ) {
        throw new Error(
          `Conflicting plan runtime cleanup ownership: ${target.cleanupId}`,
        );
      }
      if (stored!.target_json !== encoded) {
        this.db.exec(
          `UPDATE plan_runtime_cleanup
           SET target_json = ?, updated_at = ?
           WHERE cleanup_id = ? AND target_json = ?`,
          encoded,
          now,
          target.cleanupId,
          stored!.target_json,
        );
      }
    }
  }

  /**
   * Once an immutable cleanup target exists, plan-facing rows no longer own
   * the external runtime. This is the boundary that lets a plan move, reopen,
   * or start a replacement Scribe without waiting for the old machine.
   */
  private releasePlanRuntimeOwnership(
    targets: PlanRuntimeCleanupTarget[],
    now: string,
  ): void {
    for (const target of targets) {
      if (target.kind === "writer") {
        this.db.exec(
          `
            UPDATE reviewer_registry
            SET runtime_json = NULL, job_slug = NULL, cleanup_error = NULL, updated_at = ?
            WHERE thread_id = ? AND generation = ?
          `,
          now,
          target.ownerId,
          target.generation,
        );
      } else {
        this.db.exec(
          "UPDATE planner_runs SET runtime_json = NULL WHERE run_id = ? AND runtime_json = ?",
          target.ownerId,
          JSON.stringify(target.runtime),
        );
      }
    }
  }

  private preparePlanAgentReset(repoId: string): PlanAgentResetPreparation {
    const countRow = this.db
      .exec(
        "SELECT COUNT(*) AS count FROM artifacts WHERE repo_id = ? AND type = 'plan'",
        repoId,
      )
      .toArray()[0] as unknown as { count: number } | undefined;
    const registryRows = this.db
      .exec("SELECT * FROM reviewer_registry WHERE repo_id = ?", repoId)
      .toArray() as unknown as ReviewerRegistryRow[];
    const runRows = this.db
      .exec("SELECT * FROM planner_runs WHERE repo_id = ?", repoId)
      .toArray() as unknown as PlannerRunRow[];
    const retiredRunRows = this.db
      .exec(
        `SELECT run_id FROM planner_runs WHERE repo_id = ?
         UNION
         SELECT run_id FROM reviewer_registry
         WHERE repo_id = ? AND run_id IS NOT NULL AND TRIM(run_id) <> ''
         UNION
         SELECT run_id FROM planner_run_events WHERE repo_id = ?`,
        repoId,
        repoId,
        repoId,
      )
      .toArray() as unknown as Array<{ run_id: string }>;
    const cleanupRows = this.db
      .exec("SELECT * FROM plan_runtime_cleanup WHERE repo_id = ?", repoId)
      .toArray() as unknown as PlanRuntimeCleanupRow[];

    const blockers: PlanAgentResetPreparation["blockers"] = [];
    const writerGenerations = new Map<string, number>();
    const cleanupTargets = new Map<string, PlanRuntimeCleanupTarget>();
    const addBlocker = (
      blocker: PlanAgentResetPreparation["blockers"][number],
    ) => {
      if (
        !blockers.some(
          (existing) =>
            existing.kind === blocker.kind &&
            existing.planArtifactId === blocker.planArtifactId &&
            existing.ownerId === blocker.ownerId &&
            existing.cleanupId === blocker.cleanupId,
        )
      ) {
        blockers.push(blocker);
      }
    };
    const appendCleanupTarget = (
      candidate: PlanRuntimeCleanupTarget,
      blocker: PlanAgentResetPreparation["blockers"][number],
    ) => {
      let target: PlanRuntimeCleanupTarget;
      try {
        target = normalizePlanRuntimeCleanupTarget(candidate);
      } catch {
        addBlocker(blocker);
        return;
      }
      const existing = cleanupTargets.get(target.cleanupId);
      if (existing && !samePlanRuntimeCleanupTarget(existing, target)) {
        addBlocker({ ...blocker, cleanupId: target.cleanupId });
        return;
      }
      cleanupTargets.set(target.cleanupId, target);
      if (target.kind === "writer") {
        const current = writerGenerations.get(target.planArtifactId) ?? 0;
        writerGenerations.set(
          target.planArtifactId,
          Math.max(current, target.generation),
        );
      }
    };

    for (const row of cleanupRows) {
      try {
        const target = parsePlanRuntimeCleanupTarget(row);
        appendCleanupTarget(target, {
          kind: "cleanup",
          planArtifactId: row.plan_artifact_id,
          ownerId: target.ownerId,
          cleanupId: row.cleanup_id,
        });
      } catch {
        addBlocker({
          kind: "cleanup",
          planArtifactId: row.plan_artifact_id,
          ownerId: row.cleanup_id,
          cleanupId: row.cleanup_id,
        });
      }
    }

    for (const row of registryRows) {
      if (row.role !== "writer") continue;
      let generation =
        Number.isInteger(row.generation) && (row.generation ?? 0) >= 1
          ? row.generation!
          : 0;
      let parsedRuntime: Record<string, unknown> | null = null;
      if (row.runtime_json) {
        try {
          const parsed = JSON.parse(row.runtime_json) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            parsedRuntime = parsed as Record<string, unknown>;
            if (
              generation === 0 &&
              Number.isInteger(parsedRuntime.generation) &&
              (parsedRuntime.generation as number) >= 1
            ) {
              generation = parsedRuntime.generation as number;
            }
          }
        } catch {
          // A separately persisted job slug can still provide exact ownership.
        }
      }
      if (generation >= 1) {
        writerGenerations.set(
          row.plan_artifact_id,
          Math.max(
            writerGenerations.get(row.plan_artifact_id) ?? 0,
            generation,
          ),
        );
      }

      const ownsTerminal = row.stopped_at === null;
      const runtimeJobSlug =
        row.job_slug?.trim() ||
        (typeof parsedRuntime?.jobSlug === "string"
          ? parsedRuntime.jobSlug.trim()
          : "");
      const conflictingRuntimeSlug = Boolean(
        row.job_slug?.trim() &&
        typeof parsedRuntime?.jobSlug === "string" &&
        parsedRuntime.jobSlug.trim() &&
        row.job_slug.trim() !== parsedRuntime.jobSlug.trim(),
      );
      const conflictingRuntimeGeneration = Boolean(
        generation >= 1 &&
        Number.isInteger(parsedRuntime?.generation) &&
        (parsedRuntime?.generation as number) >= 1 &&
        parsedRuntime?.generation !== generation,
      );
      if (!ownsTerminal && !row.runtime_json && !runtimeJobSlug) continue;
      const blocker = {
        kind: "writer" as const,
        planArtifactId: row.plan_artifact_id,
        ownerId: row.thread_id,
      };
      if (
        generation < 1 ||
        conflictingRuntimeSlug ||
        conflictingRuntimeGeneration ||
        (Boolean(row.runtime_json) && !runtimeJobSlug)
      ) {
        addBlocker(blocker);
        continue;
      }

      const cleanupId = planRuntimeCleanupId([
        "writer",
        repoId,
        row.plan_artifact_id,
        row.thread_id,
        String(generation),
        runtimeJobSlug || "terminal-only",
      ]);
      if (cleanupTargets.has(cleanupId)) continue;

      let runtime: PlanWriterRuntimeProvenance | null = null;
      let placement: ExecutionPlacement | null = null;
      if (row.runtime_json || runtimeJobSlug) {
        if (!runtimeJobSlug) {
          addBlocker(blocker);
          continue;
        }
        placement = parseCleanupExecutionPlacement(row.launch_provenance_json);
        if (!placement) {
          addBlocker(blocker);
          continue;
        }
        runtime = { jobSlug: runtimeJobSlug, generation };
      }
      appendCleanupTarget(
        {
          schemaVersion: 2,
          cleanupId,
          kind: "writer",
          repoId,
          planArtifactId: row.plan_artifact_id,
          ownerId: row.thread_id,
          generation,
          runtime,
          placement,
        },
        blocker,
      );
    }

    for (const row of runRows) {
      if (!row.runtime_json) continue;
      const blocker = {
        kind: "reviewer" as const,
        planArtifactId: row.plan_artifact_id,
        ownerId: row.run_id,
      };
      let runtimeJobSlug = "";
      try {
        const parsed = JSON.parse(row.runtime_json) as unknown;
        if (
          parsed &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          typeof (parsed as { jobSlug?: unknown }).jobSlug === "string"
        ) {
          runtimeJobSlug = (parsed as { jobSlug: string }).jobSlug.trim();
        }
      } catch {
        // Reported below as unsupported cleanup ownership.
      }
      const cleanupId = runtimeJobSlug
        ? planRuntimeCleanupId([
            "reviewer",
            repoId,
            row.plan_artifact_id,
            row.run_id,
            runtimeJobSlug,
          ])
        : null;
      if (cleanupId && cleanupTargets.has(cleanupId)) continue;
      const placement = parseCleanupExecutionPlacement(
        row.launch_provenance_json,
      );
      if (!cleanupId || !placement) {
        addBlocker(blocker);
        continue;
      }
      appendCleanupTarget(
        {
          schemaVersion: 2,
          cleanupId,
          kind: "reviewer",
          repoId,
          planArtifactId: row.plan_artifact_id,
          ownerId: row.run_id,
          runtime: { jobSlug: runtimeJobSlug },
          placement,
        },
        blocker,
      );
    }

    return {
      plansPreserved: Number(countRow?.count ?? 0),
      scribesRemoved: registryRows.filter((row) => row.role === "writer")
        .length,
      reviewersRemoved: registryRows.filter((row) => row.role !== "writer")
        .length,
      runIds: retiredRunRows.map((row) => row.run_id),
      writerGenerations,
      cleanupTargets: [...cleanupTargets.values()],
      blockers,
    };
  }

  async resetPlanAgents(
    input: ResetPlanAgentsInput,
  ): Promise<ResetPlanAgentsResult> {
    const result = this.ctx.storage.transactionSync(
      (): ResetPlanAgentsResult => {
        this.assertRepositoryWritable();
        const existing = this.db
          .exec(
            `SELECT request_hash, result_json
           FROM plan_agent_reset_receipts
           WHERE repo_id = ? AND reset_id = ?`,
            input.repoId,
            input.resetId,
          )
          .toArray()[0] as unknown as PlanAgentResetReceiptRow | undefined;
        if (existing) {
          if (existing.request_hash !== input.requestHash) {
            return { status: "idempotency_conflict" };
          }
          return {
            status: "replayed",
            report: JSON.parse(existing.result_json),
          };
        }

        const prepared = this.preparePlanAgentReset(input.repoId);
        if (prepared.blockers.length > 0) {
          return {
            status: "unsupported_cleanup_ownership",
            blockerCount: prepared.blockers.length,
            blockers: prepared.blockers.slice(0, 25),
          };
        }

        const now = new Date().toISOString();
        for (const [planArtifactId, generation] of prepared.writerGenerations) {
          this.db.exec(
            `
            INSERT INTO plan_writer_generation_fences (
              repo_id, plan_artifact_id, last_generation, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(repo_id, plan_artifact_id) DO UPDATE SET
              last_generation = MAX(last_generation, excluded.last_generation),
              updated_at = CASE
                WHEN excluded.last_generation > last_generation THEN excluded.updated_at
                ELSE updated_at
              END
          `,
            input.repoId,
            planArtifactId,
            generation,
            now,
          );
        }
        for (const runId of prepared.runIds) {
          this.db.exec(
            `INSERT INTO retired_planner_run_ids (repo_id, run_id, retired_at, reason)
           VALUES (?, ?, ?, 'reset')
           ON CONFLICT(repo_id, run_id) DO NOTHING`,
            input.repoId,
            runId,
            now,
          );
        }
        this.enqueuePlanRuntimeCleanupTargets(prepared.cleanupTargets, now);

        for (const table of [
          "plan_contributions",
          "planner_run_events",
          "planner_runs",
          "plan_skill_invocations",
          "reviewer_registry",
        ]) {
          this.db.exec(`DELETE FROM ${table} WHERE repo_id = ?`, input.repoId);
        }
        // Plan Health is reviewer-derived provenance. Keeping it after the
        // invocation and run rows are removed would leave an assessment that
        // can no longer identify or open its source.
        this.db.exec(
          "UPDATE artifacts SET plan_health_json = NULL WHERE repo_id = ? AND type = 'plan'",
          input.repoId,
        );

        const report = {
          resetId: input.resetId,
          resetAt: now,
          plansPreserved: prepared.plansPreserved,
          scribesRemoved: prepared.scribesRemoved,
          reviewersRemoved: prepared.reviewersRemoved,
          runsRetired: prepared.runIds.length,
          cleanupQueued: prepared.cleanupTargets.length,
        };
        this.db.exec(
          `INSERT INTO plan_agent_reset_receipts (
           repo_id, reset_id, request_hash, result_json, created_at
         ) VALUES (?, ?, ?, ?, ?)`,
          input.repoId,
          input.resetId,
          input.requestHash,
          JSON.stringify(report),
          now,
        );
        return { status: "reset", report };
      },
    );

    if (
      (result.status === "reset" || result.status === "replayed") &&
      this.hasPlanRuntimeCleanupRows()
    ) {
      // Await the wake-up before acknowledging success. If this fails after
      // the SQL commit, replaying the same reset id safely retries the alarm.
      await this.ctx.storage.setAlarm(Date.now());
    }
    return result;
  }

  private schedulePlanRuntimeCleanup(delayMs = 0): void {
    // Arm directly whenever intent is committed. A harmless early alarm is
    // preferable to a durable target with no wake-up after a process failure.
    this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + delayMs));
  }

  getRetainedTerminalPlanCleanupWork(
    repoId: string,
    planArtifactId: string,
  ): TerminalPlanCleanupWork {
    const now = new Date().toISOString();
    const work = this.ctx.storage.transactionSync(() => {
      const plan = this.getArtifact(planArtifactId);
      if (!plan || plan.repoId !== repoId || plan.type !== "plan") {
        throw new Error(`Plan artifact not found: ${planArtifactId}`);
      }
      if (plan.status !== "completed" && plan.status !== "archived") {
        return {
          terminalWriter: null,
          runtimeCleanupRuns: [],
          cleanupTargets: [],
        };
      }
      const retained = this.readRetainedPlanCleanupWork(repoId, planArtifactId);
      this.fencePlanRuntimeWork(repoId, planArtifactId, "completed", now);
      this.enqueuePlanRuntimeCleanupTargets(retained.cleanupTargets, now);
      this.releasePlanRuntimeOwnership(retained.cleanupTargets, now);
      return retained;
    });
    if (work.cleanupTargets.length > 0) this.schedulePlanRuntimeCleanup();
    return work;
  }

  listPlanRuntimeCleanupTargetsForRepo(
    repoId: string,
    limit = 100,
  ): PlanRuntimeCleanupTarget[] {
    const rows = this.db
      .exec(
        `
        SELECT * FROM plan_runtime_cleanup
        WHERE repo_id = ?
        ORDER BY created_at ASC, cleanup_id ASC
        LIMIT ?
      `,
        repoId,
        Math.max(1, Math.min(limit, 500)),
      )
      .toArray() as unknown as PlanRuntimeCleanupRow[];
    return rows.map(parsePlanRuntimeCleanupTarget);
  }

  private listPlanRuntimeCleanupTargetsForPlan(
    repoId: string,
    planArtifactId: string,
  ): PlanRuntimeCleanupTarget[] {
    const rows = this.db
      .exec(
        `
        SELECT * FROM plan_runtime_cleanup
        WHERE repo_id = ? AND plan_artifact_id = ?
        ORDER BY created_at ASC, cleanup_id ASC
      `,
        repoId,
        planArtifactId,
      )
      .toArray() as unknown as PlanRuntimeCleanupRow[];
    return rows.map(parsePlanRuntimeCleanupTarget);
  }

  private findPlanWriterRuntimeCleanupTarget(
    repoId: string,
    planArtifactId: string,
    ownerId: string,
    generation: number,
  ): PlanRuntimeCleanupTarget | null {
    return (
      this.listPlanRuntimeCleanupTargetsForPlan(repoId, planArtifactId).find(
        (target) =>
          target.kind === "writer" &&
          target.ownerId === ownerId &&
          target.generation === generation,
      ) ?? null
    );
  }

  private listPlanRuntimeCleanupRows(
    limit = PLAN_RUNTIME_CLEANUP_BATCH_SIZE,
  ): PlanRuntimeCleanupRow[] {
    return this.db
      .exec(
        `SELECT * FROM plan_runtime_cleanup
       ORDER BY attempt_count ASC, updated_at ASC, created_at ASC, cleanup_id ASC
       LIMIT ?`,
        Math.max(1, Math.min(limit, 100)),
      )
      .toArray() as unknown as PlanRuntimeCleanupRow[];
  }

  private listPlanRuntimeCleanupTargets(
    limit = PLAN_RUNTIME_CLEANUP_BATCH_SIZE,
  ): PlanRuntimeCleanupTarget[] {
    return this.listPlanRuntimeCleanupRows(limit).map(
      parsePlanRuntimeCleanupTarget,
    );
  }

  private hasPlanRuntimeCleanupRows(): boolean {
    return Boolean(
      this.db
        .exec("SELECT cleanup_id FROM plan_runtime_cleanup LIMIT 1")
        .toArray()[0],
    );
  }

  private recordMalformedPlanRuntimeCleanupFailure(
    row: PlanRuntimeCleanupRow,
    error: string,
  ): void {
    this.db.exec(
      `
        UPDATE plan_runtime_cleanup
        SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
        WHERE cleanup_id = ? AND target_json = ?
      `,
      error,
      new Date().toISOString(),
      row.cleanup_id,
      row.target_json,
    );
  }

  private nextPlanRuntimeCleanupRetryMs(): number {
    const row = this.db
      .exec(
        "SELECT MIN(attempt_count) AS attempt_count FROM plan_runtime_cleanup",
      )
      .toArray()[0] as unknown as { attempt_count: number | null } | undefined;
    const attempts = Math.max(0, Math.min(Number(row?.attempt_count ?? 0), 5));
    return Math.min(
      PLAN_RUNTIME_CLEANUP_RETRY_MS * 2 ** attempts,
      PLAN_RUNTIME_CLEANUP_MAX_RETRY_MS,
    );
  }

  completePlanRuntimeCleanup(target: PlanRuntimeCleanupTarget): boolean {
    return this.ctx.storage.transactionSync(() => {
      const expected = normalizePlanRuntimeCleanupTarget(target);
      const row = this.db
        .exec(
          "SELECT * FROM plan_runtime_cleanup WHERE cleanup_id = ?",
          target.cleanupId,
        )
        .toArray()[0] as unknown as PlanRuntimeCleanupRow | undefined;
      if (!row) return false;
      const stored = parsePlanRuntimeCleanupTarget(row);
      if (!samePlanRuntimeCleanupTarget(stored, expected)) {
        throw new Error(
          `Plan runtime cleanup ownership changed: ${target.cleanupId}`,
        );
      }
      if (expected.kind === "writer") {
        const writer = this.getReviewer(expected.ownerId);
        if (
          writer?.role === "writer" &&
          writer.generation === expected.generation &&
          (!expected.runtime ||
            (writer.runtime &&
              samePlanWriterRuntime(writer.runtime, expected.runtime)) ||
            (!writer.runtime && writer.jobSlug === expected.runtime.jobSlug))
        ) {
          this.db.exec(
            `
              UPDATE reviewer_registry
              SET runtime_json = NULL, job_slug = NULL, cleanup_error = NULL, updated_at = ?
              WHERE thread_id = ? AND generation = ?
            `,
            new Date().toISOString(),
            expected.ownerId,
            expected.generation,
          );
        }
      } else {
        const run = this.getPlannerRun(expected.ownerId);
        if (
          run?.runtime &&
          samePlannerRunRuntime(run.runtime, expected.runtime)
        ) {
          this.db.exec(
            "UPDATE planner_runs SET runtime_json = NULL WHERE run_id = ?",
            expected.ownerId,
          );
        }
      }
      this.db.exec(
        "DELETE FROM plan_runtime_cleanup WHERE cleanup_id = ?",
        expected.cleanupId,
      );
      return true;
    });
  }

  recordPlanRuntimeCleanupFailure(
    target: PlanRuntimeCleanupTarget,
    error: string,
  ): void {
    const now = new Date().toISOString();
    this.ctx.storage.transactionSync(() => {
      const expected = normalizePlanRuntimeCleanupTarget(target);
      const row = this.db
        .exec(
          "SELECT * FROM plan_runtime_cleanup WHERE cleanup_id = ?",
          expected.cleanupId,
        )
        .toArray()[0] as unknown as PlanRuntimeCleanupRow | undefined;
      if (!row) return;
      const stored = parsePlanRuntimeCleanupTarget(row);
      if (!samePlanRuntimeCleanupTarget(stored, expected)) {
        throw new Error(
          `Plan runtime cleanup ownership changed: ${expected.cleanupId}`,
        );
      }
      this.db.exec(
        `
          UPDATE plan_runtime_cleanup
          SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ?
          WHERE cleanup_id = ?
        `,
        error,
        now,
        expected.cleanupId,
      );
    });
  }

  async alarm(): Promise<void> {
    try {
      for (const row of this.listPlanRuntimeCleanupRows()) {
        let target: PlanRuntimeCleanupTarget;
        try {
          target = parsePlanRuntimeCleanupTarget(row);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.recordMalformedPlanRuntimeCleanupFailure(row, message);
          console.warn(
            `[planner] malformed deferred cleanup is still pending for ${row.cleanup_id}:`,
            message,
          );
          continue;
        }
        try {
          await cleanupPlanRuntimeTarget(this.env, this, target);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `[planner] deferred ${target.kind} cleanup is still pending for ${target.ownerId}:`,
            message,
          );
        }
      }
      if (this.hasPlanRuntimeCleanupRows()) {
        await this.ctx.storage.setAlarm(
          Date.now() + this.nextPlanRuntimeCleanupRetryMs(),
        );
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch (error) {
      console.error(
        "[planner] deferred plan cleanup pass failed; scheduling recovery:",
        error instanceof Error ? error.message : String(error),
      );
      await this.ctx.storage.setAlarm(
        Date.now() + PLAN_RUNTIME_CLEANUP_RETRY_MS,
      );
    }
  }

  updateArtifactStatus(
    input: UpdateArtifactStatusInput,
  ): TerminalPlanCleanupWork & { artifact: Artifact } {
    const existing = this.getArtifact(input.id);
    if (!existing || existing.repoId !== input.repoId) {
      throw new Error(`Artifact not found: ${input.id}`);
    }
    if (existing.type !== "plan") {
      throw new Error(
        "Only plan artifacts can be moved between plan categories",
      );
    }
    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      (existing.version ?? 1) !== input.expectedVersion
    ) {
      throw new Error(
        `Artifact version mismatch for ${input.id}: expected ${input.expectedVersion}, found ${existing.version ?? 1}`,
      );
    }

    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const terminal =
        input.status === "completed" || input.status === "archived";
      const cleanupCandidates = terminal
        ? this.readRetainedPlanCleanupWork(input.repoId, input.id)
        : { terminalWriter: null, runtimeCleanupRuns: [], cleanupTargets: [] };
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
      let terminalWriter: ReviewerRegistryEntry | null = null;
      let runtimeCleanupRuns: PlannerRun[] = [];
      if (terminal) {
        this.fencePlanRuntimeWork(
          input.repoId,
          input.id,
          input.status === "completed" ? "completed" : "archived",
          now,
        );
        this.enqueuePlanRuntimeCleanupTargets(
          cleanupCandidates.cleanupTargets,
          now,
        );
        terminalWriter = cleanupCandidates.terminalWriter
          ? this.getPlanWriter(input.repoId, input.id)
          : null;
        runtimeCleanupRuns = cleanupCandidates.runtimeCleanupRuns.flatMap(
          (run) => {
            const updated = this.getPlannerRun(run.runId);
            return updated ? [updated] : [];
          },
        );
        this.releasePlanRuntimeOwnership(cleanupCandidates.cleanupTargets, now);
      }
      const artifact = this.getArtifact(input.id);
      if (!artifact)
        throw new Error(`Artifact not found after update: ${input.id}`);
      return {
        artifact,
        terminalWriter,
        runtimeCleanupRuns,
        cleanupTargets: cleanupCandidates.cleanupTargets,
      };
    });
    if (result.cleanupTargets.length > 0) this.schedulePlanRuntimeCleanup();
    return result;
  }

  savePlan(input: SavePlanInput): SavePlanResult {
    const existing = this.getArtifact(input.id);
    if (
      !existing ||
      existing.repoId !== input.repoId ||
      existing.type !== "plan"
    ) {
      throw new Error(`Plan artifact not found: ${input.id}`);
    }
    if (
      existing.status !== "draft" &&
      existing.status !== "evaluating" &&
      existing.status !== "todo"
    ) {
      throw new Error("Only draft, evaluating, or todo plans can be edited");
    }
    const markdown = normalizePlanMarkdown(input.markdown);
    if (
      new TextEncoder().encode(markdown).byteLength > MAX_PLAN_MARKDOWN_BYTES
    ) {
      throw new Error(
        `Plan Markdown exceeds ${MAX_PLAN_MARKDOWN_BYTES} UTF-8 bytes`,
      );
    }

    const currentMarkdown = normalizePlanMarkdown(
      renderArtifactBodyMarkdown(existing.body),
    );
    if (currentMarkdown === markdown) {
      return {
        artifact: existing as Artifact<PlanArtifactBody>,
        changed: false,
      };
    }
    const derivedTitle = derivePlanTitleFromMarkdown(markdown);
    const now = new Date().toISOString();
    const planHealth = stalePlanHealth(existing.planHealth, now);
    this.db.exec(
      `
        UPDATE artifacts
        SET body_json = ?,
            title = CASE WHEN ? != '' THEN ? ELSE title END,
            updated_at = ?,
            version = COALESCE(version, 1) + 1,
            plan_health_json = ?
        WHERE id = ? AND repo_id = ?
      `,
      JSON.stringify({ markdown }),
      derivedTitle,
      derivedTitle,
      now,
      planHealth ? JSON.stringify(planHealth) : null,
      input.id,
      input.repoId,
    );

    const updated = this.getArtifact(input.id);
    if (!updated || updated.type !== "plan") {
      throw new Error(`Plan artifact not found after save: ${input.id}`);
    }
    return { artifact: updated as Artifact<PlanArtifactBody>, changed: true };
  }

  discardPlan(
    input: DiscardPlanInput,
  ): TerminalPlanCleanupWork & { artifact: Artifact<PlanArtifactBody> } {
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
      throw new Error(
        `Artifact version mismatch for ${input.id}: expected ${input.expectedVersion}, found ${existing.version ?? 1}`,
      );
    }

    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(() => {
      const cleanupCandidates = this.readRetainedPlanCleanupWork(
        input.repoId,
        input.id,
      );
      this.fencePlanRuntimeWork(input.repoId, input.id, "user", now);
      this.enqueuePlanRuntimeCleanupTargets(
        cleanupCandidates.cleanupTargets,
        now,
      );
      const terminalWriter = cleanupCandidates.terminalWriter
        ? this.getPlanWriter(input.repoId, input.id)
        : null;
      const runtimeCleanupRuns = cleanupCandidates.runtimeCleanupRuns.flatMap(
        (run) => {
          const updated = this.getPlannerRun(run.runId);
          return updated ? [updated] : [];
        },
      );

      for (const target of cleanupCandidates.cleanupTargets) {
        if (target.kind !== "writer") continue;
        this.db.exec(
          `
            INSERT INTO plan_writer_generation_fences (
              repo_id, plan_artifact_id, last_generation, updated_at
            ) VALUES (?, ?, ?, ?)
            ON CONFLICT(repo_id, plan_artifact_id) DO UPDATE SET
              last_generation = MAX(last_generation, excluded.last_generation),
              updated_at = CASE
                WHEN excluded.last_generation > last_generation THEN excluded.updated_at
                ELSE updated_at
              END
          `,
          input.repoId,
          input.id,
          target.generation,
          now,
        );
      }
      this.db.exec(
        `
          WITH removed_run_ids AS (
            SELECT repo_id, run_id
            FROM planner_runs
            WHERE repo_id = ? AND plan_artifact_id = ?
            UNION
            SELECT repo_id, run_id
            FROM reviewer_registry
            WHERE repo_id = ? AND plan_artifact_id = ?
              AND run_id IS NOT NULL AND TRIM(run_id) <> ''
            UNION
            SELECT repo_id, run_id
            FROM planner_run_events
            WHERE repo_id = ? AND plan_artifact_id = ?
          )
          INSERT OR IGNORE INTO retired_planner_run_ids (
            repo_id, run_id, retired_at, reason
          )
          SELECT repo_id, run_id, ?, 'discard'
          FROM removed_run_ids
        `,
        input.repoId,
        input.id,
        input.repoId,
        input.id,
        input.repoId,
        input.id,
        now,
      );

      // The plan-facing state disappears atomically. The immutable cleanup
      // targets above survive independently, so late callbacks cannot revive
      // a deleted plan while an offline backend waits to reconnect.
      this.db.exec(
        "DELETE FROM refs WHERE repo_id = ? AND artifact_id = ?",
        input.repoId,
        input.id,
      );
      this.db.exec(
        "DELETE FROM plan_contributions WHERE repo_id = ? AND plan_artifact_id = ?",
        input.repoId,
        input.id,
      );
      this.db.exec(
        "DELETE FROM planner_run_events WHERE repo_id = ? AND plan_artifact_id = ?",
        input.repoId,
        input.id,
      );
      this.db.exec(
        "DELETE FROM planner_runs WHERE repo_id = ? AND plan_artifact_id = ?",
        input.repoId,
        input.id,
      );
      this.db.exec(
        "DELETE FROM plan_skill_invocations WHERE repo_id = ? AND plan_artifact_id = ?",
        input.repoId,
        input.id,
      );
      this.db.exec(
        "DELETE FROM reviewer_registry WHERE repo_id = ? AND plan_artifact_id = ?",
        input.repoId,
        input.id,
      );
      this.db.exec(
        "DELETE FROM artifacts WHERE repo_id = ? AND id = ?",
        input.repoId,
        input.id,
      );

      return {
        artifact: existing as Artifact<PlanArtifactBody>,
        terminalWriter,
        runtimeCleanupRuns,
        cleanupTargets: cleanupCandidates.cleanupTargets,
      };
    });
    if (result.cleanupTargets.length > 0) this.schedulePlanRuntimeCleanup();
    return result;
  }

  listLatestTodoPlansForMain(
    repoId: string,
    mainCommit: string | null,
    limit = 1,
  ): Artifact<PlanArtifactBody>[] {
    if (!mainCommit) return [];
    const rows = this.db
      .exec(
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
      )
      .toArray() as unknown as ArtifactRow[];
    return rows.map(
      (row) => this.parseArtifactRow(row) as Artifact<PlanArtifactBody>,
    );
  }

  listReviewers(
    repoId: string,
    planArtifactId: string,
    options: { includeRemoved?: boolean } = {},
  ): ReviewerRegistryEntry[] {
    const rows = this.db
      .exec(
        `
        SELECT *
        FROM reviewer_registry
        WHERE repo_id = ? AND plan_artifact_id = ?
          AND (role IS NULL OR role = 'reviewer')
          ${options.includeRemoved ? "" : "AND removed_at IS NULL"}
        ORDER BY created_at ASC, rowid ASC
      `,
        repoId,
        planArtifactId,
      )
      .toArray() as unknown as ReviewerRegistryRow[];
    return rows.map((row) => this.withReviewerDisplayLabel(
      this.parseReviewerRegistryRow(row),
    ));
  }

  private withReviewerDisplayLabel(
    reviewer: ReviewerRegistryEntry,
  ): ReviewerRegistryEntry {
    if (reviewer.nodeKind === "generic") return reviewer;
    const rootThreadId = reviewer.skillRootThreadId ?? reviewer.threadId;
    const invocation = this.getLatestPlanSkillInvocationForParent(
      reviewer.repoId,
      reviewer.planArtifactId,
      rootThreadId,
    );
    if (!invocation) return reviewer;
    if (reviewer.nodeKind === "skill_root") {
      return { ...reviewer, displayLabel: invocation.definitionSnapshot.label };
    }
    const agent = invocation.definitionSnapshot.agents.find(
      (candidate) => candidate.id === reviewer.skillAgentId,
    );
    return { ...reviewer, displayLabel: agent?.label ?? "Report" };
  }

  listPlanAttention(repoId: string): PlanAttentionItem[] {
    const rows = this.db
      .exec(
        `
        SELECT rr.thread_id, rr.plan_artifact_id, rr.role, rr.unread_attention_token
        FROM reviewer_registry rr
        INNER JOIN artifacts a
          ON a.repo_id = rr.repo_id AND a.id = rr.plan_artifact_id
        WHERE rr.repo_id = ?
          AND rr.unread_attention_token IS NOT NULL
          AND rr.removed_at IS NULL
          AND a.type = 'plan'
          AND COALESCE(a.status, 'draft') IN ('draft', 'evaluating', 'todo')
          AND (
            rr.role = 'writer'
            OR rr.role = 'reviewer'
          )
        ORDER BY rr.plan_artifact_id ASC,
                 CASE rr.role WHEN 'writer' THEN 0 ELSE 1 END ASC,
                 rr.created_at ASC,
                 rr.thread_id ASC
      `,
        repoId,
      )
      .toArray() as unknown as Array<{
      thread_id: string;
      plan_artifact_id: string;
      role: "writer" | "reviewer";
      unread_attention_token: string;
    }>;
    return rows.map((row) => ({
      planArtifactId: row.plan_artifact_id,
      sourceKind: row.role === "writer" ? "scribe" : "reviewer",
      sourceId: row.thread_id,
      token: row.unread_attention_token,
    }));
  }

  getRepoArtifactState(repoId: string): {
    artifacts: Artifact[];
    refs: ArtifactRef[];
    attention: PlanAttentionItem[];
  } {
    return this.ctx.storage.transactionSync(() => ({
      artifacts: this.listArtifacts({ limit: 500 }),
      refs: this.listRefs(),
      attention: this.listPlanAttention(repoId),
    }));
  }

  acknowledgePlanAttention(input: {
    repoId: string;
    planArtifactId: string;
    sourceKind: "scribe" | "reviewer";
    sourceId: string;
    token: string;
  }): "acknowledged" | "absent" | "conflict" {
    return this.ctx.storage.transactionSync(() => {
      const role = input.sourceKind === "scribe" ? "writer" : "reviewer";
      const row = this.db
        .exec(
          `
          SELECT unread_attention_token
          FROM reviewer_registry
          WHERE repo_id = ? AND plan_artifact_id = ? AND thread_id = ? AND role = ?
          LIMIT 1
        `,
          input.repoId,
          input.planArtifactId,
          input.sourceId,
          role,
        )
        .toArray()[0] as unknown as
        { unread_attention_token: string | null } | undefined;
      if (!row?.unread_attention_token) return "absent";
      if (row.unread_attention_token !== input.token) return "conflict";
      this.db.exec(
        `
          UPDATE reviewer_registry
          SET unread_attention_token = NULL
          WHERE repo_id = ? AND plan_artifact_id = ? AND thread_id = ? AND role = ?
            AND unread_attention_token = ?
        `,
        input.repoId,
        input.planArtifactId,
        input.sourceId,
        role,
        input.token,
      );
      return "acknowledged";
    });
  }

  getPlanWriter(
    repoId: string,
    planArtifactId: string,
  ): ReviewerRegistryEntry | null {
    const writer = this.getReviewer(`plan-writer-${planArtifactId}`);
    return writer &&
      writer.role === "writer" &&
      writer.repoId === repoId &&
      writer.planArtifactId === planArtifactId
      ? writer
      : null;
  }

  private reservePlanWriterGeneration(
    repoId: string,
    planArtifactId: string,
    existingGeneration: number,
    now: string,
  ): number {
    const fence = this.db
      .exec(
        `SELECT last_generation
         FROM plan_writer_generation_fences
         WHERE repo_id = ? AND plan_artifact_id = ?`,
        repoId,
        planArtifactId,
      )
      .toArray()[0] as unknown as { last_generation: number } | undefined;
    const generation =
      Math.max(existingGeneration, Number(fence?.last_generation ?? 0)) + 1;
    this.db.exec(
      `
        INSERT INTO plan_writer_generation_fences (
          repo_id, plan_artifact_id, last_generation, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(repo_id, plan_artifact_id) DO UPDATE SET
          last_generation = excluded.last_generation,
          updated_at = excluded.updated_at
      `,
      repoId,
      planArtifactId,
      generation,
      now,
    );
    return generation;
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
      !accountId ||
      !writer ||
      writer.generation !== input.generation ||
      writer.stoppedAt ||
      writer.startupError ||
      writer.cleanupError ||
      !writer.runtime ||
      profile?.kind !== "subscription-app-server" ||
      profile.surface !== "plan-writer"
    )
      return "inactive";
    const accountRow = this.db
      .exec(
        "SELECT codex_account_id FROM reviewer_registry WHERE thread_id = ?",
        writer.threadId,
      )
      .toArray()[0] as { codex_account_id: string | null } | undefined;
    if (
      accountRow?.codex_account_id &&
      accountRow.codex_account_id !== accountId
    ) {
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
    expectedPlanVersion?: number;
    provider: "claude-code" | "codex" | "opencode";
    model: string;
    effort?: PlannerEffort;
    fastMode?: boolean;
    basisCommit: string;
    startBodyDigest: string;
    launchProvenance: PlannerRunLaunchProvenance;
    skills: AgentSkillDefinition[];
  }): ReviewerRegistryEntry {
    this.assertRepositoryWritable();
    const plan = this.getArtifact(input.planArtifactId);
    if (!plan || plan.repoId !== input.repoId || plan.type !== "plan") {
      throw new Error(`Plan artifact not found: ${input.planArtifactId}`);
    }
    if (plan.status === "completed" || plan.status === "archived") {
      throw new Error("Completed or archived plans cannot start a writer.");
    }
    if (
      input.expectedPlanVersion !== undefined &&
      (plan.version ?? 1) !== input.expectedPlanVersion
    ) {
      throw new Error(
        `Plan version mismatch: expected ${input.expectedPlanVersion}, found ${plan.version ?? 1}.`,
      );
    }
    const frozenBasisCommit = plan.basis.mainCommit?.trim() ?? "";
    if (!frozenBasisCommit || frozenBasisCommit !== input.basisCommit.trim()) {
      throw new Error(
        "The plan requires its frozen basis commit before a writer can start.",
      );
    }
    const model = input.model.trim();
    const startBodyDigest = input.startBodyDigest.trim().toLowerCase();
    if (!model || !/^[a-f0-9]{64}$/u.test(startBodyDigest)) {
      throw new Error("A model and SHA-256 starting plan digest are required.");
    }
    if (!isCurrentLaunchProvenance(input.launchProvenance)) {
      throw new Error(
        "Plan Writer launch provenance is not from the current workload schema.",
      );
    }

    const existing = this.getPlanWriter(input.repoId, input.planArtifactId);
    if (
      existing &&
      !existing.stoppedAt &&
      !existing.startupError &&
      !existing.cleanupError
    ) {
      return existing;
    }
    if (existing?.runtime || existing?.jobSlug) {
      throw new Error(
        "Exact cleanup of the previous writer runtime is required before Start.",
      );
    }

    const now = new Date().toISOString();
    const generation = this.reservePlanWriterGeneration(
      input.repoId,
      input.planArtifactId,
      existing?.generation ?? 0,
      now,
    );
    const launchProvenance: PlanWriterLaunchProvenance = {
      ...input.launchProvenance,
      schemaVersion: 2,
      skillProjection: {
        version: 1,
        repositoryId: input.repoId,
        planId: input.planArtifactId,
        generation,
        skills: input.skills.map((skill) => ({
          ...skill,
          agents: skill.agents.map((agent) => ({ ...agent })),
        })),
      },
    };
    if (!isCurrentPlanWriterLaunchProvenance(launchProvenance)) {
      throw new Error("Plan Writer skill projection is invalid.");
    }
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
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'writer', 'queued', ?, NULL, ?, ?, ?,
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
        generation,
        frozenBasisCommit,
        startBodyDigest,
        JSON.stringify(launchProvenance),
      );
    } else {
      this.db.exec(
        `
          UPDATE reviewer_registry
          SET provider = ?, model = ?, effort = ?, fast_mode = ?, reviewer_model = ?, status = 'queued', error = NULL,
              run_id = NULL, provider_conversation_id = NULL, job_slug = NULL,
              generation = ?, stopped_at = NULL, stop_reason = NULL,
              basis_commit = ?, start_body_digest = ?, publication_cursor_json = NULL,
              last_settled_sequence = 0,
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
        JSON.stringify(launchProvenance),
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
      !existing ||
      existing.stoppedAt ||
      existing.startupError ||
      existing.cleanupError ||
      existing.generation !== input.generation ||
      input.runtime.generation !== input.generation ||
      !existing.runtime ||
      !samePlanWriterRuntime(existing.runtime, input.runtime) ||
      !existing.basisCommit ||
      !providerConversationId
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

  recordPlanWriterCompletion(input: {
    repoId: string;
    planArtifactId: string;
    generation: number;
    sequence: number;
  }):
    { status: "recorded" | "replayed" } | { status: "stale"; reason: string } {
    if (!Number.isInteger(input.sequence) || input.sequence < 1) {
      return { status: "stale", reason: "sequence" };
    }
    return this.ctx.storage.transactionSync(() => {
      const writer = this.db
        .exec(
          `
          SELECT generation, stopped_at, status, runtime_json, job_slug,
                 provider_conversation_id, last_settled_sequence
          FROM reviewer_registry
          WHERE repo_id = ? AND plan_artifact_id = ? AND role = 'writer'
          LIMIT 1
        `,
          input.repoId,
          input.planArtifactId,
        )
        .toArray()[0] as unknown as
        | {
            generation: number | null;
            stopped_at: string | null;
            status: string | null;
            runtime_json: string | null;
            job_slug: string | null;
            provider_conversation_id: string | null;
            last_settled_sequence: number | null;
          }
        | undefined;
      if (!writer) return { status: "stale" as const, reason: "writer" };
      if (writer.generation !== input.generation) {
        return { status: "stale" as const, reason: "generation" };
      }
      if (
        writer.stopped_at ||
        writer.status !== "running" ||
        !writer.runtime_json ||
        !writer.job_slug ||
        !writer.provider_conversation_id
      ) {
        return { status: "stale" as const, reason: "runtime" };
      }
      const plan = this.db
        .exec(
          "SELECT status FROM artifacts WHERE repo_id = ? AND id = ? AND type = 'plan' LIMIT 1",
          input.repoId,
          input.planArtifactId,
        )
        .toArray()[0] as unknown as { status: PlanStatus | null } | undefined;
      if (!plan || plan.status === "completed" || plan.status === "archived") {
        return { status: "stale" as const, reason: "plan" };
      }
      const lastSettledSequence = writer.last_settled_sequence ?? 0;
      if (input.sequence < lastSettledSequence) {
        return { status: "stale" as const, reason: "sequence" };
      }
      if (input.sequence === lastSettledSequence) {
        return { status: "replayed" as const };
      }
      this.db.exec(
        `
          UPDATE reviewer_registry
          SET last_settled_sequence = ?, unread_attention_token = ?, updated_at = ?
          WHERE repo_id = ? AND plan_artifact_id = ? AND role = 'writer'
            AND generation = ? AND stopped_at IS NULL
        `,
        input.sequence,
        `${input.generation}:${input.sequence}`,
        new Date().toISOString(),
        input.repoId,
        input.planArtifactId,
        input.generation,
      );
      return { status: "recorded" as const };
    });
  }

  fencePlanWriterStop(input: {
    repoId: string;
    planArtifactId: string;
    expectedGeneration: number;
    reason: PlanWriterStopReason;
  }): {
    status: "stopped" | "stale" | "not_found";
    writer: ReviewerRegistryEntry | null;
  } {
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

  /**
   * Permanently fences one Scribe generation and transfers any external
   * workload to the cleanup outbox. The plan-facing writer row is detached in
   * the same transaction, so a replacement generation never waits for the
   * original execution backend.
   */
  abandonPlanWriter(input: {
    repoId: string;
    planArtifactId: string;
    expectedGeneration: number;
    reason: PlanWriterStopReason;
  }): AbandonPlanWriterResult {
    const now = new Date().toISOString();
    const result = this.ctx.storage.transactionSync(
      (): AbandonPlanWriterResult => {
        const existing = this.getPlanWriter(input.repoId, input.planArtifactId);
        if (!existing) {
          return { status: "not_found", writer: null, cleanupTargets: [] };
        }
        if (existing.generation !== input.expectedGeneration) {
          return { status: "stale", writer: existing, cleanupTargets: [] };
        }

        const wasActive = !existing.stoppedAt;
        if (wasActive) {
          this.db.exec(
            `
            UPDATE reviewer_registry
            SET stopped_at = ?, stop_reason = ?, status = 'cancelled',
                unread_attention_token = NULL, updated_at = ?
            WHERE thread_id = ? AND generation = ? AND stopped_at IS NULL
          `,
            now,
            input.reason,
            now,
            existing.threadId,
            input.expectedGeneration,
          );
        }

        const alreadyQueued = this.findPlanWriterRuntimeCleanupTarget(
          input.repoId,
          input.planArtifactId,
          existing.threadId,
          input.expectedGeneration,
        );
        const target =
          alreadyQueued ??
          (wasActive || existing.runtime || existing.jobSlug
            ? this.planWriterCleanupTarget(existing)
            : null);
        const cleanupTargets = target ? [target] : [];
        this.enqueuePlanRuntimeCleanupTargets(cleanupTargets, now);
        this.releasePlanRuntimeOwnership(cleanupTargets, now);
        this.db.exec(
          `
          UPDATE reviewer_registry
          SET cleanup_error = NULL, updated_at = ?
          WHERE thread_id = ? AND generation = ? AND cleanup_error IS NOT NULL
        `,
          now,
          existing.threadId,
          input.expectedGeneration,
        );

        return {
          status: "abandoned",
          writer: this.getPlanWriter(input.repoId, input.planArtifactId),
          cleanupTargets,
        };
      },
    );
    if (result.cleanupTargets.length > 0) this.schedulePlanRuntimeCleanup();
    return result;
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
    const column =
      input.kind === "startup"
        ? "startup_error"
        : input.kind === "cleanup"
          ? "cleanup_error"
          : "synchronization_error";
    const error = input.error?.trim() || null;
    const stoppedAt =
      input.kind === "startup" && error ? new Date().toISOString() : null;
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

  async publishObservedPlan(
    input: ObservedPlanPublication,
  ): Promise<PublishObservedPlanResult> {
    const writer = this.getPlanWriter(input.repoId, input.planArtifactId);
    if (!writer) return { status: "rejected", reason: "writer_not_found" };
    const cursor = writer.publicationCursor;

    // The exact current cursor remains replayable after fencing or a status
    // change so a lost response can repair the managed context safely.
    if (
      cursor &&
      input.sequence === cursor.sequence &&
      input.providerEventId === cursor.providerEventId
    ) {
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
        changed: false,
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
      return {
        status: "rejected",
        reason: "sequence_mismatch",
        expectedSequence,
      };
    }
    const artifact = this.getArtifact(input.planArtifactId);
    if (
      !artifact ||
      artifact.repoId !== input.repoId ||
      artifact.type !== "plan"
    ) {
      return { status: "rejected", reason: "writer_not_found" };
    }
    if (artifact.status === "completed" || artifact.status === "archived") {
      return { status: "rejected", reason: "plan_ineligible" };
    }

    const currentMarkdown = normalizePlanMarkdown(
      renderArtifactBodyMarkdown(artifact.body),
    );
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
        const planHealth = stalePlanHealth(artifact.planHealth, now);
        this.db.exec(
          `UPDATE artifacts SET body_json = ?, title = CASE WHEN ? != '' THEN ? ELSE title END,
           version = ?, updated_at = ?, plan_health_json = ? WHERE id = ? AND repo_id = ?`,
          JSON.stringify({ markdown: input.markdown }),
          derivedTitle,
          derivedTitle,
          artifactVersion,
          now,
          planHealth ? JSON.stringify(planHealth) : null,
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
      changed: !unchanged,
      artifactVersion,
      cursor: nextCursor,
      artifact: this.getArtifact(
        input.planArtifactId,
      ) as Artifact<PlanArtifactBody>,
    };
  }

  setPlanWriterRuntimeIfCurrent(
    threadId: string,
    runtime: PlanWriterRuntimeProvenance,
  ): ReviewerRegistryEntry | null {
    if (!isCurrentPlanWriterRuntimeProvenance(runtime)) {
      throw new Error(
        "Plan Writer runtime provenance is not from the current workload schema.",
      );
    }
    const existing = this.getReviewer(threadId);
    if (
      !existing ||
      existing.role !== "writer" ||
      existing.removedAt ||
      existing.stoppedAt ||
      (existing.generation ?? 0) !== runtime.generation ||
      existing.runtime ||
      existing.jobSlug
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
    return updated?.runtime?.jobSlug === runtime.jobSlug &&
      updated.runtime.generation === runtime.generation
      ? updated
      : null;
  }

  clearPlanWriterRuntimeIfCurrent(
    threadId: string,
    runtime: PlanWriterRuntimeProvenance,
  ): ReviewerRegistryEntry | null {
    const existing = this.getReviewer(threadId);
    if (
      existing?.role !== "writer" ||
      !existing.runtime ||
      !samePlanWriterRuntime(existing.runtime, runtime)
    )
      return null;
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
    const row = this.db
      .exec("SELECT * FROM reviewer_registry WHERE thread_id = ?", threadId)
      .toArray()[0] as unknown as ReviewerRegistryRow | undefined;
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
          reviewer_model, removed_at, created_at, updated_at, skill_invocation_id, skill_agent_id,
          node_kind, skill_root_thread_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reviewer', 'queued', ?, NULL, ?, ?, ?, ?, ?, ?)
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
      input.nodeKind ?? "generic",
      input.skillRootThreadId ?? null,
    );
    const created = this.getReviewer(threadId);
    if (!created) {
      throw new Error(
        `Reviewer registry row not found after insert: ${threadId}`,
      );
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
    if (
      !existing ||
      existing.repoId !== input.repoId ||
      existing.planArtifactId !== input.planArtifactId
    ) {
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
      throw new Error(
        `Reviewer registry row not found after update: ${input.threadId}`,
      );
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
      !existing ||
      existing.repoId !== input.repoId ||
      existing.planArtifactId !== input.planArtifactId ||
      existing.runId !== input.runId
    ) {
      return null;
    }
    return this.updateReviewerRunState(input);
  }

  removeReviewer(
    repoId: string,
    planArtifactId: string,
    threadId: string,
  ): ReviewerRegistryEntry {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getReviewer(threadId);
      if (
        !existing ||
        existing.repoId !== repoId ||
        existing.planArtifactId !== planArtifactId
      ) {
        throw new Error(`Reviewer registry row not found: ${threadId}`);
      }
      if (existing.nodeKind === "report") {
        throw new Error("Report conversations are archived with their skill root.");
      }
      const activeParentRun = this.getActiveRunForThread(
        repoId,
        planArtifactId,
        "reviewer",
        threadId,
      );
      const activeFanout = this.db
        .exec(
          `
          SELECT invocation_id
          FROM plan_skill_invocations
          WHERE repo_id = ? AND plan_artifact_id = ? AND parent_thread_id = ?
            AND status IN ('setting_up', 'active')
          LIMIT 1
        `,
          repoId,
          planArtifactId,
          threadId,
        )
        .toArray()[0] as unknown as { invocation_id: string } | undefined;
      const activeLinkedRun = this.db
        .exec(
          `
          SELECT r.run_id
          FROM planner_runs r
          JOIN plan_skill_invocations i ON i.invocation_id = r.skill_invocation_id
          WHERE i.repo_id = ? AND i.plan_artifact_id = ? AND i.parent_thread_id = ?
            AND r.status IN ('queued', 'running', 'saving')
          LIMIT 1
        `,
          repoId,
          planArtifactId,
          threadId,
        )
        .toArray()[0] as unknown as { run_id: string } | undefined;
      if (activeParentRun || activeFanout || activeLinkedRun) {
        throw new Error(
          "Reviewer has active work. Cancel it before removing the reviewer.",
        );
      }
      const now = new Date().toISOString();
      this.db.exec(
        `
          UPDATE reviewer_registry
          SET removed_at = ?, unread_attention_token = NULL, updated_at = ?
          WHERE thread_id = ? OR skill_root_thread_id = ?
        `,
        now,
        now,
        threadId,
        threadId,
      );
      const removed = this.getReviewer(threadId);
      if (!removed) {
        throw new Error(
          `Reviewer registry row not found after remove: ${threadId}`,
        );
      }
      return removed;
    });
  }

  getRepoPlanWriterSettings(
    repoId: string,
    defaults: { routeKey: string; effort: PlannerEffort; planFormat: string },
  ): RepoPlanWriterSettings {
    const row = this.db
      .exec("SELECT * FROM repo_plan_writer_settings WHERE repo_id = ?", repoId)
      .toArray()[0] as unknown as RepoPlanWriterSettingsRow | undefined;
    return {
      repoId,
      routeKey: row?.route_key?.trim() || defaults.routeKey,
      effort: isPlannerEffort(row?.effort) ? row.effort : defaults.effort,
      planFormat: row?.plan_format?.trim() || defaults.planFormat,
      updatedAt: row?.updated_at ?? null,
    };
  }

  setRepoPlanWriterSettings(input: {
    repoId: string;
    routeKey: string;
    effort: PlannerEffort;
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
        ) VALUES (?, ?, ?, ?, 0, ?)
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
      planFormat,
    );
    return this.getRepoPlanWriterSettings(input.repoId, {
      routeKey,
      effort: input.effort,
      planFormat,
    });
  }

  listStoredAgentSkills(
    repoId: string,
    surface: SkillSurface,
  ): AgentSkillDefinition[] {
    const rows = this.db
      .exec(
        `
        SELECT * FROM planning_skills
        WHERE repo_id = ? AND surface = ? AND definition_json IS NOT NULL
        ORDER BY kind ASC, command ASC, created_at ASC
      `,
        repoId,
        surface,
      )
      .toArray() as unknown as AgentSkillRow[];
    return rows.flatMap((row) => {
      try {
        const definition = JSON.parse(
          row.definition_json ?? "null",
        ) as AgentSkillDefinition | null;
        return definition
          ? [
              {
                ...definition,
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                customized: true,
              },
            ]
          : [];
      } catch {
        return [];
      }
    });
  }

  getStoredAgentSkill(
    repoId: string,
    surface: SkillSurface,
    skillId: string,
  ): AgentSkillDefinition | null {
    return (
      this.listStoredAgentSkills(repoId, surface).find(
        (skill) => skill.id === skillId,
      ) ?? null
    );
  }

  upsertStoredAgentSkill(input: {
    repoId: string;
    definition: AgentSkillDefinition;
  }): AgentSkillDefinition {
    this.assertRepositoryWritable();
    const existing = this.getStoredAgentSkill(
      input.repoId,
      input.definition.surface,
      input.definition.id,
    );
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
    const updated = this.getStoredAgentSkill(
      input.repoId,
      definition.surface,
      definition.id,
    );
    if (!updated)
      throw new Error(
        `Agent skill row not found after upsert: ${definition.id}`,
      );
    return updated;
  }

  deleteStoredAgentSkill(
    repoId: string,
    surface: SkillSurface,
    skillId: string,
  ): AgentSkillDefinition | null {
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
    const row = this.db
      .exec(
        "SELECT * FROM plan_skill_invocations WHERE invocation_id = ?",
        invocationId,
      )
      .toArray()[0] as unknown as PlanSkillInvocationRow | undefined;
    return row ? this.parsePlanSkillInvocationRow(row) : null;
  }

  listPlanSkillInvocations(input: {
    repoId: string;
    planArtifactId: string;
    parentThreadId?: string;
    limit?: number;
    cursor?: { createdAt: string; invocationId: string } | null;
  }): PlanSkillInvocation[] {
    // Routes request one look-ahead row to determine whether another page exists.
    const limit = Math.max(1, Math.min(input.limit ?? 20, 51));
    const clauses = ["repo_id = ?", "plan_artifact_id = ?"];
    const values: Array<string | number> = [input.repoId, input.planArtifactId];
    if (input.parentThreadId) {
      clauses.push("parent_thread_id = ?");
      values.push(input.parentThreadId);
    }
    if (input.cursor) {
      clauses.push(
        "(created_at < ? OR (created_at = ? AND invocation_id < ?))",
      );
      values.push(
        input.cursor.createdAt,
        input.cursor.createdAt,
        input.cursor.invocationId,
      );
    }
    values.push(limit);
    const rows = this.db
      .exec(
        `
        SELECT * FROM plan_skill_invocations
        WHERE ${clauses.join(" AND ")}
        ORDER BY created_at DESC, invocation_id DESC
        LIMIT ?
      `,
        ...values,
      )
      .toArray();
    return (rows as unknown as PlanSkillInvocationRow[]).map((row) =>
      this.parsePlanSkillInvocationRow(row),
    );
  }

  getLatestPlanSkillInvocationForParent(
    repoId: string,
    planArtifactId: string,
    parentThreadId: string,
  ): PlanSkillInvocation | null {
    const row = this.db
      .exec(
        `
        SELECT * FROM plan_skill_invocations
        WHERE repo_id = ? AND plan_artifact_id = ? AND parent_thread_id = ?
        ORDER BY created_at DESC, invocation_id DESC
        LIMIT 1
      `,
        repoId,
        planArtifactId,
        parentThreadId,
      )
      .toArray()[0] as unknown as PlanSkillInvocationRow | undefined;
    return row ? this.parsePlanSkillInvocationRow(row) : null;
  }

  listPlanSkillInvocationReviewers(
    invocationId: string,
  ): ReviewerRegistryEntry[] {
    const invocation = this.getPlanSkillInvocation(invocationId);
    if (!invocation) return [];
    const rows = this.db
      .exec(
        `SELECT * FROM reviewer_registry
         WHERE (thread_id = ? OR skill_root_thread_id = ?)
           AND skill_agent_id IS NOT NULL
         ORDER BY CASE WHEN thread_id = ? THEN 0 ELSE 1 END, created_at ASC, thread_id ASC`,
        invocation.parentThreadId,
        invocation.parentThreadId,
        invocation.parentThreadId,
      )
      .toArray() as unknown as ReviewerRegistryRow[];
    return rows.map((row) => this.withReviewerDisplayLabel(
      this.parseReviewerRegistryRow(row),
    ));
  }

  listPlanSkillInvocationRuns(invocationId: string): PlannerRun[] {
    const rows = this.db
      .exec(
        "SELECT * FROM planner_runs WHERE skill_invocation_id = ? ORDER BY started_at ASC, rowid ASC",
        invocationId,
      )
      .toArray() as unknown as PlannerRunRow[];
    return rows.map((row) => this.parsePlannerRunRow(row));
  }

  inspectPlanSkillInvocationRerun(input: {
    invocationId: string;
    requestId: string;
    repoId: string;
    planArtifactId: string;
  }): {
    status: "missing" | "existing" | "conflict";
    invocation: PlanSkillInvocation | null;
    reviewers: ReviewerRegistryEntry[];
    runs: PlannerRun[];
  } {
    const source = this.getPlanSkillInvocation(input.invocationId);
    if (
      !source ||
      source.repoId !== input.repoId ||
      source.planArtifactId !== input.planArtifactId
    ) {
      return {
        status: "conflict",
        invocation: source,
        reviewers: [],
        runs: [],
      };
    }
    const invocation = this.getPlanSkillInvocation(input.requestId);
    if (!invocation) {
      return {
        status: "missing",
        invocation: source,
        reviewers: this.listPlanSkillInvocationReviewers(source.invocationId),
        runs: [],
      };
    }
    const exact =
      invocation.repoId === source.repoId &&
      invocation.planArtifactId === source.planArtifactId &&
      invocation.parentThreadId === source.parentThreadId &&
      invocation.definitionSnapshot.id === source.definitionSnapshot.id;
    return {
      status: exact ? "existing" : "conflict",
      invocation,
      reviewers: exact
        ? this.listPlanSkillInvocationReviewers(invocation.invocationId)
        : [],
      runs: exact ? this.listPlanSkillInvocationRuns(invocation.invocationId) : [],
    };
  }

  reservePlanSkillInvocation(input: {
    invocationId: string;
    repoId: string;
    planArtifactId: string;
    expectedPlanVersion?: number;
    parentThreadId: string;
    definitionSnapshot: AgentSkillDefinition;
    basis: PlannerRunBasis;
    overviewMode?: SkillAutomationMode;
    overviewRoute?: {
      provider: string;
      model: string;
      effort: PlannerEffort;
    } | null;
    agents: Array<{
      id: string;
      provider: string;
      model: string;
      launchProvenance: PlannerRunLaunchProvenance;
    }>;
  }):
    | {
        status: "created";
        invocation: PlanSkillInvocation;
        reviewers: ReviewerRegistryEntry[];
        runs: PlannerRun[];
      }
    | {
        status: "existing";
        invocation: PlanSkillInvocation;
        reviewers: ReviewerRegistryEntry[];
        runs: PlannerRun[];
      }
    | { status: "conflict"; invocation: PlanSkillInvocation } {
    this.assertRepositoryWritable();
    return this.ctx.storage.transactionSync(() => {
      const initialResultHandler = trustedInitialResultHandler(
        input.definitionSnapshot,
        input.agents,
      );
      const existing = this.getPlanSkillInvocation(input.invocationId);
      if (existing) {
        if (
          existing.repoId !== input.repoId ||
          existing.planArtifactId !== input.planArtifactId ||
          existing.parentThreadId !== input.parentThreadId ||
          existing.definitionSnapshot.id !== input.definitionSnapshot.id
        ) {
          return { status: "conflict" as const, invocation: existing };
        }
        return {
          status: "existing" as const,
          invocation: existing,
          reviewers: this.listPlanSkillInvocationReviewers(
            existing.invocationId,
          ),
          runs: this.listPlanSkillInvocationRuns(existing.invocationId),
        };
      }
      const plan = this.getArtifact(input.planArtifactId);
      if (!plan || plan.repoId !== input.repoId || plan.type !== "plan") {
        throw new Error(`Plan artifact not found: ${input.planArtifactId}`);
      }
      if (plan.status === "completed" || plan.status === "archived") {
        throw new Error(
          "Completed or archived plans cannot start Plan Skill work.",
        );
      }
      if (
        input.expectedPlanVersion !== undefined &&
        (plan.version ?? 1) !== input.expectedPlanVersion
      ) {
        throw new Error(
          `Plan version mismatch: expected ${input.expectedPlanVersion}, found ${plan.version ?? 1}.`,
        );
      }
      if (initialResultHandler === PLAN_HEALTH_RESULT_HANDLER) {
        if (input.basis.normalizationVersion === undefined) {
          input.basis = {
            ...input.basis,
            normalizationVersion: PLAN_MARKDOWN_NORMALIZATION_VERSION,
          };
        } else if (
          input.basis.normalizationVersion !==
          PLAN_MARKDOWN_NORMALIZATION_VERSION
        ) {
          throw new Error(
            "Plan Health basis uses an unsupported Markdown normalization contract.",
          );
        }
        const activeRows = this.db
          .exec(
            `
            SELECT r.input_json
            FROM planner_runs r
            JOIN plan_skill_invocations i ON i.invocation_id = r.skill_invocation_id
            WHERE i.repo_id = ? AND i.plan_artifact_id = ?
              AND i.status IN ('setting_up', 'active')
              AND r.skill_run_role IN ('root_initial', 'report_initial')
          `,
            input.repoId,
            input.planArtifactId,
          )
          .toArray() as unknown as Array<{ input_json: string | null }>;
        if (
          activeRows.some(
            (row) =>
              parseStoredPlannerRunInput(row.input_json)
                ?.initialResultHandler === PLAN_HEALTH_RESULT_HANDLER,
          )
        ) {
          throw new Error(
            "A Plan Health assessment is already active for this plan.",
          );
        }
      }
      if (input.definitionSnapshot.agents.length === 0) {
        throw new Error("A Plan Skill must contain at least one agent.");
      }
      if (input.definitionSnapshot.agents.length > 1 && !input.overviewRoute) {
        throw new Error("A multi-agent Plan Skill requires an Overview route.");
      }
      const activeFanout = this.db
        .exec(
          `
          SELECT invocation_id
          FROM plan_skill_invocations
          WHERE repo_id = ? AND plan_artifact_id = ? AND parent_thread_id = ?
            AND status IN ('setting_up', 'active')
          LIMIT 1
        `,
          input.repoId,
          input.planArtifactId,
          input.parentThreadId,
        )
        .toArray()[0] as unknown as { invocation_id: string } | undefined;
      const activeLinkedRun = this.db
        .exec(
          `
          SELECT r.run_id
          FROM planner_runs r
          JOIN plan_skill_invocations i ON i.invocation_id = r.skill_invocation_id
          WHERE i.repo_id = ? AND i.plan_artifact_id = ? AND i.parent_thread_id = ?
            AND r.status IN ('queued', 'running', 'saving')
          LIMIT 1
        `,
          input.repoId,
          input.planArtifactId,
          input.parentThreadId,
        )
        .toArray()[0] as unknown as { run_id: string } | undefined;
      if (activeFanout || activeLinkedRun) {
        throw new Error(
          "A Plan Skill operation is already active for this conversation.",
        );
      }
      const now = new Date().toISOString();
      this.db.exec(
        `
          INSERT INTO plan_skill_invocations (
            invocation_id, repo_id, plan_artifact_id, parent_thread_id,
            definition_snapshot_json, basis_json, status, error, cancelled_at,
            created_at, updated_at, overview_mode, included_message_ids_json,
            overview_run_id, overview_route_json
          ) VALUES (?, ?, ?, ?, ?, ?, 'setting_up', NULL, NULL, ?, ?, ?, '[]', NULL, ?)
        `,
        input.invocationId,
        input.repoId,
        input.planArtifactId,
        input.parentThreadId,
        JSON.stringify(input.definitionSnapshot),
        JSON.stringify(input.basis),
        now,
        now,
        input.overviewMode ?? input.definitionSnapshot.overviewMode,
        input.overviewRoute ? JSON.stringify(input.overviewRoute) : null,
      );
      const singleAgent = input.definitionSnapshot.agents.length === 1;
      const rootAgent = singleAgent ? input.agents[0] : null;
      const rootDefinition = singleAgent
        ? input.definitionSnapshot.agents[0]
        : null;
      const rootRoute = singleAgent ? rootAgent : input.overviewRoute;
      if (!rootRoute) throw new Error("The skill root route is unavailable.");
      const root = this.upsertReviewer({
        repoId: input.repoId,
        planArtifactId: input.planArtifactId,
        provider: rootRoute.provider,
        model: rootRoute.model,
        effort: rootDefinition?.effort ?? input.overviewRoute!.effort,
        skill: input.definitionSnapshot.command,
        threadId: input.parentThreadId,
        skillInvocationId: input.invocationId,
        ...(rootDefinition ? { skillAgentId: rootDefinition.id } : {}),
        nodeKind: "skill_root",
        skillRootThreadId: input.parentThreadId,
      });
      for (const agent of input.agents) {
        const definition = input.definitionSnapshot.agents.find(
          (candidate) => candidate.id === agent.id,
        );
        if (!definition) throw new Error(`Skill agent not found: ${agent.id}`);
        const reviewer = singleAgent
          ? root
          : this.upsertReviewer({
              repoId: input.repoId,
              planArtifactId: input.planArtifactId,
              provider: agent.provider,
              model: agent.model,
              effort: definition.effort,
              skill: input.definitionSnapshot.command,
              threadId: `plan-skill-report:${input.invocationId}:${agent.id}`,
              skillInvocationId: input.invocationId,
              skillAgentId: agent.id,
              nodeKind: "report",
              skillRootThreadId: input.parentThreadId,
            });
        const editableInstructions = composeReviewerInstructions(
          input.definitionSnapshot.sharedInstructions,
          definition.instructions,
        );
        const instructions =
          initialResultHandler === PLAN_HEALTH_RESULT_HANDLER
            ? `${editableInstructions}\n\n${PLAN_HEALTH_TRANSPORT_INSTRUCTION}`
            : editableInstructions;
        const run = this.createPlannerRun({
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          role: "reviewer",
          provider: agent.provider,
          model: agent.model,
          skill: input.definitionSnapshot.command,
          threadId: reviewer.threadId,
          skillInvocationId: input.invocationId,
          skillAgentId: agent.id,
          skillRunRole: singleAgent ? "root_initial" : "report_initial",
          launchProvenance: agent.launchProvenance,
          input: {
            ...(initialResultHandler ? { initialResultHandler } : {}),
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
      if (!invocation)
        throw new Error("Failed to reserve plan skill invocation.");
      return {
        status: "created" as const,
        invocation,
        reviewers: this.listPlanSkillInvocationReviewers(input.invocationId),
        runs: this.listPlanSkillInvocationRuns(input.invocationId),
      };
    });
  }

  reservePlanSkillInvocationRerun(input: {
    invocationId: string;
    requestId: string;
    repoId: string;
    planArtifactId: string;
    expectedPlanVersion?: number;
    basis: PlannerRunBasis;
    overviewRoute?: {
      provider: string;
      model: string;
      effort: PlannerEffort;
    } | null;
    agents: Array<{
      id: string;
      provider: string;
      model: string;
      launchProvenance: PlannerRunLaunchProvenance;
    }>;
  }): {
    status: "created" | "existing";
    invocation: PlanSkillInvocation;
    reviewers: ReviewerRegistryEntry[];
    runs: PlannerRun[];
  } {
    this.assertRepositoryWritable();
    return this.ctx.storage.transactionSync(() => {
      const invocation = this.getPlanSkillInvocation(input.invocationId);
      if (
        !invocation ||
        invocation.repoId !== input.repoId ||
        invocation.planArtifactId !== input.planArtifactId
      ) {
        throw new Error("Skill invocation not found.");
      }
      const replay = this.inspectPlanSkillInvocationRerun({
        invocationId: input.invocationId,
        requestId: input.requestId,
        repoId: input.repoId,
        planArtifactId: input.planArtifactId,
      });
      if (replay.status === "conflict") {
        throw new Error("requestId is already used by a different rerun.");
      }
      if (replay.status === "existing") {
        return {
          status: "existing",
          invocation: replay.invocation!,
          reviewers: replay.reviewers,
          runs: replay.runs,
        };
      }
      const latest = this.getLatestPlanSkillInvocationForParent(
        input.repoId,
        input.planArtifactId,
        invocation.parentThreadId,
      );
      if (latest?.invocationId !== invocation.invocationId) {
        throw new Error("Only the latest Plan Skill round can be re-reviewed.");
      }
      const activeRoot = this.db.exec(
        `SELECT invocation_id FROM plan_skill_invocations
         WHERE repo_id = ? AND plan_artifact_id = ? AND parent_thread_id = ?
           AND status IN ('setting_up', 'active')
         LIMIT 1`,
        input.repoId,
        input.planArtifactId,
        invocation.parentThreadId,
      ).toArray()[0];
      const activeLinkedRun = this.db.exec(
        `SELECT r.run_id
         FROM planner_runs r
         JOIN plan_skill_invocations i
           ON i.invocation_id = r.skill_invocation_id
         WHERE i.repo_id = ? AND i.plan_artifact_id = ?
           AND i.parent_thread_id = ?
           AND r.status IN ('queued', 'running', 'saving')
         LIMIT 1`,
        input.repoId,
        input.planArtifactId,
        invocation.parentThreadId,
      ).toArray()[0];
      if (activeRoot || activeLinkedRun) {
        throw new Error("A Plan Skill operation is already active for this conversation.");
      }
      const reviewers = this.listPlanSkillInvocationReviewers(
        invocation.invocationId,
      );
      const expectedRuns = input.agents.map((agent) => ({
        agent,
        reviewer: reviewers.find(
          (candidate) => candidate.skillAgentId === agent.id,
        ),
        runId: `plan-skill-round:${input.requestId}:${agent.id}`,
      }));
      if (expectedRuns.some((entry) => !entry.reviewer)) {
        throw new Error("A frozen child reviewer is unavailable.");
      }
      const parent = this.getReviewer(invocation.parentThreadId);
      if (
        !parent ||
        parent.repoId !== input.repoId ||
        parent.planArtifactId !== input.planArtifactId ||
        parent.nodeKind !== "skill_root" ||
        parent.removedAt
      ) {
        throw new Error(
          "The skill root conversation is unavailable.",
        );
      }
      if (
        invocation.status === "setting_up" ||
        invocation.status === "active"
      ) {
        throw new Error("The Plan Skill round is still active.");
      }
      const activeLinked = this.listPlanSkillInvocationRuns(
        invocation.invocationId,
      ).find((run) => isActiveRunStatus(run.status));
      if (activeLinked)
        throw new Error("A child reviewer still has active work.");
      const plan = this.getArtifact(input.planArtifactId);
      if (!plan || plan.repoId !== input.repoId || plan.type !== "plan") {
        throw new Error(`Plan artifact not found: ${input.planArtifactId}`);
      }
      if (plan.status === "completed" || plan.status === "archived") {
        throw new Error(
          "Completed or archived plans cannot rerun Plan Skill work.",
        );
      }
      if (
        input.expectedPlanVersion !== undefined &&
        (plan.version ?? 1) !== input.expectedPlanVersion
      ) {
        throw new Error(
          `Plan version mismatch: expected ${input.expectedPlanVersion}, found ${plan.version ?? 1}.`,
        );
      }
      const now = new Date().toISOString();
      this.db.exec(
        `INSERT INTO plan_skill_invocations (
           invocation_id, repo_id, plan_artifact_id, parent_thread_id,
           definition_snapshot_json, basis_json,
           status, error, cancelled_at, created_at, updated_at, overview_mode,
           included_message_ids_json, overview_run_id, overview_route_json
         ) VALUES (?, ?, ?, ?, ?, ?, 'setting_up', NULL, NULL, ?, ?, ?, '[]', NULL, ?)`,
        input.requestId,
        input.repoId,
        input.planArtifactId,
        invocation.parentThreadId,
        JSON.stringify(invocation.definitionSnapshot),
        JSON.stringify(input.basis),
        now,
        now,
        invocation.overviewMode,
        input.overviewRoute ? JSON.stringify(input.overviewRoute) : null,
      );
      this.db.exec(
        `UPDATE reviewer_registry
         SET skill_invocation_id = ?, updated_at = ?
         WHERE thread_id = ? OR skill_root_thread_id = ?`,
        input.requestId,
        now,
        invocation.parentThreadId,
        invocation.parentThreadId,
      );
      if (input.overviewRoute) {
        this.db.exec(
          `UPDATE reviewer_registry
           SET provider = ?, model = ?, effort = ?, updated_at = ?
           WHERE thread_id = ?`,
          input.overviewRoute.provider,
          input.overviewRoute.model,
          input.overviewRoute.effort,
          now,
          invocation.parentThreadId,
        );
      }
      for (const entry of expectedRuns) {
        const definition = invocation.definitionSnapshot.agents.find(
          (candidate) => candidate.id === entry.agent.id,
        );
        if (!definition || !entry.reviewer)
          throw new Error(`Frozen skill agent not found: ${entry.agent.id}`);
        const instructions = [
          invocation.definitionSnapshot.sharedInstructions,
          definition.instructions,
        ]
          .filter(Boolean)
          .join("\n\n");
        const run = this.createPlannerRun({
          runId: entry.runId,
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          role: "reviewer",
          provider: entry.agent.provider,
          model: entry.agent.model,
          skill: invocation.definitionSnapshot.command,
          threadId: entry.reviewer.threadId,
          startedAt: now,
          skillInvocationId: input.requestId,
          skillAgentId: entry.agent.id,
          skillRunRole:
            invocation.definitionSnapshot.agents.length === 1
              ? "root_initial"
              : "report_initial",
          launchProvenance: entry.agent.launchProvenance,
          input: {
            instruction: `Run /${invocation.definitionSnapshot.command} as ${definition.label}.`,
            effort: definition.effort,
            sourcePlanVersion: input.basis.version,
            githubBaseCommitSha: input.basis.gitBaseCommitSha,
            basis: input.basis,
            skillDefinitionSnapshot: invocation.definitionSnapshot,
            skillSnapshot: {
              id: invocation.definitionSnapshot.id,
              command: invocation.definitionSnapshot.command,
              label: invocation.definitionSnapshot.label,
              instructions,
            },
          },
        });
        this.updateReviewerRunState({
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          threadId: entry.reviewer.threadId,
          runId: run.runId,
          status: "queued",
          error: null,
        });
      }
      const updated = this.getPlanSkillInvocation(input.requestId);
      if (!updated) throw new Error("Failed to reserve Plan Skill rerun.");
      return {
        status: "created",
        invocation: updated,
        reviewers: this.listPlanSkillInvocationReviewers(
          input.requestId,
        ),
        runs: expectedRuns
          .map((entry) => this.getPlannerRun(entry.runId)!)
          .filter(Boolean),
      };
    });
  }

  activatePlanSkillInvocation(
    invocationId: string,
  ): PlanSkillInvocation | null {
    const existing = this.getPlanSkillInvocation(invocationId);
    if (!existing || existing.status !== "setting_up") return existing;
    this.db.exec(
      "UPDATE plan_skill_invocations SET status = 'active', updated_at = ? WHERE invocation_id = ? AND status = 'setting_up'",
      new Date().toISOString(),
      invocationId,
    );
    return this.getPlanSkillInvocation(invocationId);
  }

  recordPlanSkillReport(
    runId: string,
    messageId: string,
  ): PlanSkillInvocation | null {
    const run = this.getPlannerRun(runId);
    if (
      run?.status !== "completed" ||
      !run.skillInvocationId ||
      run.skillRunRole !== "report_initial" ||
      !run.skillAgentId
    )
      return null;
    const invocation = this.getPlanSkillInvocation(run.skillInvocationId);
    if (
      !invocation ||
      invocation.definitionSnapshot.agents.length < 2 ||
      invocation.status !== "active" ||
      invocation.overviewRunId
    )
      return invocation;
    const agent = invocation.definitionSnapshot.agents.find(
      (candidate) => candidate.id === run.skillAgentId,
    );
    if (!agent || agent.reportMode !== "auto") return invocation;
    const included = [...new Set([...invocation.includedMessageIds, messageId])];
    this.db.exec(
      `UPDATE plan_skill_invocations
       SET included_message_ids_json = ?, updated_at = ?
       WHERE invocation_id = ? AND status = 'active' AND overview_run_id IS NULL`,
      JSON.stringify(included),
      new Date().toISOString(),
      invocation.invocationId,
    );
    return this.getPlanSkillInvocation(invocation.invocationId);
  }

  updatePlanSkillInvocationControls(input: {
    invocationId: string;
    overviewMode: SkillAutomationMode;
    includedMessageIds: string[];
  }): PlanSkillInvocation | null {
    const invocation = this.getPlanSkillInvocation(input.invocationId);
    if (
      !invocation ||
      invocation.definitionSnapshot.agents.length < 2 ||
      invocation.status !== "active" ||
      invocation.overviewRunId
    )
      return invocation;
    this.db.exec(
      `UPDATE plan_skill_invocations
       SET overview_mode = ?, included_message_ids_json = ?, updated_at = ?
       WHERE invocation_id = ? AND status = 'active' AND overview_run_id IS NULL`,
      input.overviewMode,
      JSON.stringify([...new Set(input.includedMessageIds)]),
      new Date().toISOString(),
      input.invocationId,
    );
    return this.getPlanSkillInvocation(input.invocationId);
  }

  assignPlanSkillOverview(input: {
    invocationId: string;
    overviewRunId: string;
    expectedOverviewMode: SkillAutomationMode;
    expectedIncludedMessageIds: string[];
    payload: FrozenOverviewPayload;
    prompt: string;
    launchProvenance: PlannerRunLaunchProvenance;
  }):
    | {
        status: "created" | "existing" | "not_active" | "controls_changed";
        invocation: PlanSkillInvocation;
        run: PlannerRun | null;
      }
    | null {
    return this.ctx.storage.transactionSync(() => {
      const invocation = this.getPlanSkillInvocation(input.invocationId);
      if (!invocation) return null;
      if (invocation.definitionSnapshot.agents.length < 2) {
        return { status: "not_active" as const, invocation, run: null };
      }
      if (invocation.overviewRunId) {
        return {
          status: "existing" as const,
          invocation,
          run: this.getPlannerRun(invocation.overviewRunId),
        };
      }
      if (invocation.status !== "active" || !invocation.overviewRoute) {
        return { status: "not_active" as const, invocation, run: null };
      }
      if (
        invocation.overviewMode !== input.expectedOverviewMode ||
        !sameStringSet(
          invocation.includedMessageIds,
          input.expectedIncludedMessageIds,
        )
      ) {
        return { status: "controls_changed" as const, invocation, run: null };
      }
      const activeRootRun = this.db.exec(
        `SELECT run_id FROM planner_runs
         WHERE skill_invocation_id = ?
           AND status IN ('queued', 'running', 'saving')
         LIMIT 1`,
        invocation.invocationId,
      ).toArray()[0];
      if (activeRootRun) {
        return { status: "controls_changed" as const, invocation, run: null };
      }
      this.db.exec(
        `UPDATE plan_skill_invocations SET overview_run_id = ?, updated_at = ?
         WHERE invocation_id = ? AND status = 'active' AND overview_run_id IS NULL`,
        input.overviewRunId,
        new Date().toISOString(),
        input.invocationId,
      );
      const claimed = this.getPlanSkillInvocation(input.invocationId);
      if (!claimed?.overviewRunId) {
        return {
          status: "not_active" as const,
          invocation: claimed ?? invocation,
          run: null,
        };
      }
      if (claimed.overviewRunId !== input.overviewRunId) {
        return {
          status: "existing" as const,
          invocation: claimed,
          run: this.getPlannerRun(claimed.overviewRunId),
        };
      }
      const run = this.createPlannerRun({
        runId: input.overviewRunId,
        repoId: claimed.repoId,
        planArtifactId: claimed.planArtifactId,
        role: "reviewer",
        provider: claimed.overviewRoute!.provider,
        model: claimed.overviewRoute!.model,
        skill: claimed.definitionSnapshot.command,
        threadId: claimed.parentThreadId,
        skillInvocationId: claimed.invocationId,
        skillRunRole: "overview",
        launchProvenance: input.launchProvenance,
        input: {
          instruction: input.prompt,
          effort: claimed.overviewRoute!.effort,
          sourcePlanVersion: claimed.basis.version,
          githubBaseCommitSha: claimed.basis.gitBaseCommitSha,
          basis: claimed.basis,
          skillDefinitionSnapshot: claimed.definitionSnapshot,
          frozenOverview: input.payload,
          skillSnapshot: {
            id: claimed.definitionSnapshot.id,
            command: claimed.definitionSnapshot.command,
            label: `${claimed.definitionSnapshot.label} Overview`,
            instructions: claimed.definitionSnapshot.overviewInstructions,
          },
        },
      });
      this.updateReviewerRunState({
        repoId: claimed.repoId,
        planArtifactId: claimed.planArtifactId,
        threadId: claimed.parentThreadId,
        runId: run.runId,
        status: "queued",
        error: null,
      });
      return { status: "created" as const, invocation: claimed, run };
    });
  }

  failPlanSkillInvocation(
    invocationId: string,
    error: string,
  ): PlanSkillInvocation | null {
    const existing = this.getPlanSkillInvocation(invocationId);
    if (
      !existing ||
      existing.status === "completed" ||
      existing.status === "failed" ||
      existing.status === "cancelled"
    )
      return existing;
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

  failStalePlanSkillInvocations(
    repoId: string,
    planArtifactId: string,
    cutoffIso: string,
  ): PlanSkillInvocation[] {
    const rows = this.db
      .exec(
        `
        SELECT * FROM plan_skill_invocations
        WHERE repo_id = ? AND plan_artifact_id = ? AND status = 'setting_up' AND updated_at < ?
      `,
        repoId,
        planArtifactId,
        cutoffIso,
      )
      .toArray() as unknown as PlanSkillInvocationRow[];
    const error = "Skill setup timed out before all child threads were ready.";
    return rows
      .map((row) => {
        const structuredRun = this.db
          .exec(
            `
          SELECT run_id, input_json
          FROM planner_runs
          WHERE skill_invocation_id = ? AND skill_run_role IN ('root_initial', 'report_initial')
          ORDER BY started_at ASC, run_id ASC
          LIMIT 1
        `,
            row.invocation_id,
          )
          .toArray()[0] as unknown as
          | {
              run_id: string;
              input_json: string | null;
            }
          | undefined;
        const resultHandler = structuredRun
          ? parseStoredPlannerRunInput(structuredRun.input_json)
              ?.initialResultHandler
          : undefined;
        if (structuredRun && resultHandler === PLAN_HEALTH_RESULT_HANDLER) {
          this.completePlanHealthReviewerOutput(structuredRun.run_id, {
            status: "failed",
            error,
          });
          return this.getPlanSkillInvocation(row.invocation_id);
        }
        return this.failPlanSkillInvocation(row.invocation_id, error);
      })
      .filter((invocation): invocation is PlanSkillInvocation =>
        Boolean(invocation),
      );
  }

  cancelPlanSkillInvocation(invocationId: string): PlanSkillInvocation | null {
    const existing = this.getPlanSkillInvocation(invocationId);
    if (!existing) return existing;
    const hasActiveLinkedRun = this.listPlanSkillInvocationRuns(
      invocationId,
    ).some((run) => isActiveRunStatus(run.status));
    if (
      !hasActiveLinkedRun &&
      (existing.status === "completed" ||
        existing.status === "failed" ||
        existing.status === "cancelled")
    )
      return existing;
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
    const allRuns = this.listPlanSkillInvocationRuns(invocationId);
    if (invocation.definitionSnapshot.agents.length > 1) {
      const overview = invocation.overviewRunId
        ? allRuns.find((run) => run.runId === invocation.overviewRunId)
        : null;
      if (!overview || isActiveRunStatus(overview.status)) return;
      this.db.exec(
        "UPDATE plan_skill_invocations SET status = ?, error = ?, updated_at = ? WHERE invocation_id = ? AND status = 'active'",
        overview.status === "completed" ? "completed" : "failed",
        overview.status === "completed"
          ? null
          : (overview.error ?? "Overview run failed."),
        new Date().toISOString(),
        invocationId,
      );
      return;
    }
    const newestByAgent = new Map<string, PlannerRun>();
    for (const run of allRuns) {
      if (run.skillRunRole !== "root_initial" || !run.skillAgentId) continue;
      const current = newestByAgent.get(run.skillAgentId);
      if (!current || run.startedAt >= current.startedAt)
        newestByAgent.set(run.skillAgentId, run);
    }
    const runs = invocation.definitionSnapshot.agents
      .map((agent) => newestByAgent.get(agent.id))
      .filter((run): run is PlannerRun => Boolean(run));
    if (
      runs.length !== invocation.definitionSnapshot.agents.length ||
      runs.some(
        (run) =>
          isPlannerRunStatus(run.status) &&
          ["queued", "running", "saving"].includes(run.status),
      )
    ) {
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
    const idempotencyKey =
      input.idempotencyKey ?? `manual:${crypto.randomUUID()}`;
    const contribution: PlanContribution = {
      id: input.id ?? crypto.randomUUID(),
      repoId: input.repoId,
      planArtifactId: input.planArtifactId,
      sourceKind: input.sourceKind ?? "manual",
      ...(input.sourceRunId ? { sourceRunId: input.sourceRunId } : {}),
      ...(input.sourceThreadId ? { sourceThreadId: input.sourceThreadId } : {}),
      ...(input.sourceMessageId
        ? { sourceMessageId: input.sourceMessageId }
        : {}),
      ...(typeof input.sourcePlanVersion === "number"
        ? { sourcePlanVersion: input.sourcePlanVersion }
        : {}),
      sourceRefs: input.sourceRefs?.map((source) => ({ ...source })) ?? [],
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
          source_message_id, source_plan_version, source_refs_json, idempotency_key,
          provider, model, skill, text, status, created_at, updated_at, incorporated_at, dismissed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, NULL, NULL)
      `,
      contribution.id,
      contribution.repoId,
      contribution.planArtifactId,
      contribution.sourceKind,
      contribution.sourceRunId ?? null,
      contribution.sourceThreadId ?? null,
      contribution.sourceMessageId ?? null,
      contribution.sourcePlanVersion ?? null,
      contribution.sourceRefs.length > 0
        ? JSON.stringify(contribution.sourceRefs)
        : null,
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

  createOrGetPlanContribution(
    input: CreatePlanContributionInput & { idempotencyKey: string },
  ): CreateOrGetPlanContributionResult {
    this.assertRepositoryWritable();
    const textDigest = hashString(input.text);
    const existingRow = this.db
      .exec(
        `
        SELECT *
        FROM plan_contributions
        WHERE repo_id = ? AND plan_artifact_id = ? AND idempotency_key = ?
        LIMIT 1
      `,
        input.repoId,
        input.planArtifactId,
        input.idempotencyKey,
      )
      .toArray()[0] as unknown as PlanContributionRow | undefined;
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

  createOrGetCuratedPlanContribution(
    input: CreatePlanContributionInput & {
      idempotencyKey: string;
      sourceRefs: PlanContributionSourceRef[];
    },
  ): CreateCuratedPlanContributionResult {
    this.assertRepositoryWritable();
    return this.ctx.storage.transactionSync(() => {
      const existingRow = this.db
        .exec(
          `
          SELECT * FROM plan_contributions
          WHERE repo_id = ? AND plan_artifact_id = ? AND idempotency_key = ?
          LIMIT 1
        `,
          input.repoId,
          input.planArtifactId,
          input.idempotencyKey,
        )
        .toArray()[0] as unknown as PlanContributionRow | undefined;
      if (existingRow) {
        const contribution = this.parsePlanContributionRow(existingRow);
        if (
          existingRow.text !== input.text ||
          JSON.stringify(contribution.sourceRefs) !==
            JSON.stringify(input.sourceRefs)
        ) {
          return {
            status: "conflict" as const,
            contribution,
            reason: "request_payload_changed" as const,
          };
        }
        return { status: "existing" as const, contribution };
      }

      const sourceKey = (
        source: Pick<PlanContributionSourceRef, "threadId" | "messageId">,
      ) =>
        `${source.threadId.length}:${source.threadId}${source.messageId.length}:${source.messageId}`;
      const requested = new Map(
        input.sourceRefs.map((source) => [sourceKey(source), source]),
      );
      const rows = this.db
        .exec(
          "SELECT * FROM plan_contributions WHERE repo_id = ? AND plan_artifact_id = ?",
          input.repoId,
          input.planArtifactId,
        )
        .toArray() as unknown as PlanContributionRow[];
      for (const row of rows) {
        if (
          row.source_thread_id &&
          row.source_message_id
        ) {
          const used = requested.get(
            sourceKey({
              threadId: row.source_thread_id,
              messageId: row.source_message_id,
            }),
          );
          if (used) return { status: "source_used" as const, source: used };
        }
        for (const source of parsePlanContributionSourceRefs(
          row.source_refs_json,
        )) {
          const used = requested.get(sourceKey(source));
          if (used) return { status: "source_used" as const, source: used };
        }
      }
      return {
        status: "created" as const,
        contribution: this.createPlanContribution({
          ...input,
          sourceKind: "curated_reviewer_handoff",
        }),
      };
    });
  }

  listPlanContributions(
    repoId: string,
    planArtifactId: string,
    filter: PlanContributionListFilter = {},
  ): PlanContribution[] {
    const values: Array<string | number> = [repoId, planArtifactId];
    const statusClause = filter.status ? "AND status = ?" : "";
    if (filter.status) values.push(filter.status);
    const rows = this.db
      .exec(
        `
        SELECT *
        FROM plan_contributions
        WHERE repo_id = ? AND plan_artifact_id = ?
          ${statusClause}
        ORDER BY created_at ASC, rowid ASC
      `,
        ...values,
      )
      .toArray() as unknown as PlanContributionRow[];
    return rows.map((row) => this.parsePlanContributionRow(row));
  }

  getPlanContribution(id: string): PlanContribution | null {
    const row = this.db
      .exec("SELECT * FROM plan_contributions WHERE id = ?", id)
      .toArray()[0] as unknown as PlanContributionRow | undefined;
    return row ? this.parsePlanContributionRow(row) : null;
  }

  dismissPlanContribution(
    repoId: string,
    planArtifactId: string,
    contributionId: string,
  ): PlanContribution {
    const existing = this.getPlanContribution(contributionId);
    if (
      !existing ||
      existing.repoId !== repoId ||
      existing.planArtifactId !== planArtifactId
    ) {
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
      throw new Error(
        `Plan contribution not found after dismiss: ${contributionId}`,
      );
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
      if (
        !existing ||
        existing.repoId !== repoId ||
        existing.planArtifactId !== planArtifactId
      ) {
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

  getPlanContributionsByIds(
    repoId: string,
    planArtifactId: string,
    contributionIds: string[],
  ): PlanContribution[] {
    const contributions: PlanContribution[] = [];
    for (const contributionId of contributionIds) {
      const contribution = this.getPlanContribution(contributionId);
      if (
        contribution &&
        contribution.repoId === repoId &&
        contribution.planArtifactId === planArtifactId
      ) {
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
    const stillPending = this.getPlanContributionsByIds(
      repoId,
      planArtifactId,
      contributionIds,
    )
      .filter((contribution) => contribution.status === "pending")
      .map((contribution) => contribution.id);
    return this.incorporatePlanContributions(
      repoId,
      planArtifactId,
      stillPending,
    );
  }

  createPlannerRun(input: CreatePlannerRunInput): PlannerRun {
    this.assertRepositoryWritable();
    if (input.role !== "reviewer") {
      throw new Error("Only reviewer one-shot runs may use planner_runs.");
    }
    if (!isCurrentLaunchProvenance(input.launchProvenance)) {
      throw new Error(
        "Planner run launch provenance is not from the current workload schema.",
      );
    }
    const runId = input.runId ?? crypto.randomUUID();
    const retired = this.db
      .exec(
        `SELECT run_id FROM retired_planner_run_ids
         WHERE repo_id = ? AND run_id = ?`,
        input.repoId,
        runId,
      )
      .toArray()[0];
    if (retired) {
      throw new Error(
        `Planner run id was retired by a plan-agent reset or discard: ${runId}. Use a new requestId.`,
      );
    }
    const startedAt = input.startedAt ?? new Date().toISOString();
    const codexExecution = input.launchProvenance.codexExecution;
    const publicInput = publicPlannerRunInput(input.input);
    const run: PlannerRun = {
      runId,
      repoId: input.repoId,
      planArtifactId: input.planArtifactId,
      role: input.role,
      provider: input.provider,
      model: input.model,
      ...(input.skill ? { skill: input.skill } : {}),
      status: "queued",
      startedAt,
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(publicInput ? { input: publicInput } : {}),
      ...(input.skillInvocationId
        ? { skillInvocationId: input.skillInvocationId }
        : {}),
      ...(input.skillAgentId ? { skillAgentId: input.skillAgentId } : {}),
      ...(input.skillRunRole ? { skillRunRole: input.skillRunRole } : {}),
      launchProvenance: input.launchProvenance,
      ...(codexExecution
        ? {
            codexAuthMode: codexExecutionAuthMode(codexExecution),
          }
        : {}),
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
      input.input ? JSON.stringify(input.input) : null,
      JSON.stringify(run.launchProvenance),
      run.skillInvocationId ?? null,
      run.skillAgentId ?? null,
      run.skillRunRole ?? null,
    );

    return run;
  }

  setPlannerRunRuntime(
    runId: string,
    runtime: PlannerRunRuntimeProvenance,
  ): PlannerRun {
    if (!isCurrentPlannerRuntimeProvenance(runtime)) {
      throw new Error(
        "Planner run runtime provenance is not from the current workload schema.",
      );
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

  claimPlannerRunRuntime(
    runId: string,
    runtime: PlannerRunRuntimeProvenance,
  ): PlannerRun | null {
    if (!isCurrentPlannerRuntimeProvenance(runtime)) {
      throw new Error(
        "Planner run runtime provenance is not from the current workload schema.",
      );
    }
    const existing = this.getPlannerRun(runId);
    if (
      !existing ||
      existing.runtime ||
      (existing.status !== "queued" && existing.status !== "running")
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

  claimQueuedPlannerRunForInProcess(runId: string): PlannerRun | null {
    return this.ctx.storage.transactionSync(() => {
      const existing = this.getPlannerRun(runId);
      if (
        !existing ||
        existing.role !== "reviewer" ||
        existing.status !== "queued" ||
        existing.runtime
      ) {
        return null;
      }
      const now = new Date().toISOString();
      this.db.exec(
        `
          UPDATE planner_runs
          SET status = 'running', last_contact_at = ?
          WHERE run_id = ? AND role = 'reviewer' AND status = 'queued' AND runtime_json IS NULL
        `,
        now,
        runId,
      );
      if (existing.threadId) {
        this.db.exec(
          `
            UPDATE reviewer_registry
            SET status = 'running', error = NULL, updated_at = ?
            WHERE repo_id = ? AND plan_artifact_id = ? AND thread_id = ?
              AND role = 'reviewer' AND run_id = ?
          `,
          now,
          existing.repoId,
          existing.planArtifactId,
          existing.threadId,
          existing.runId,
        );
      }
      const claimed = this.getPlannerRun(runId);
      return claimed?.status === "running" && claimed.runtime === undefined
        ? claimed
        : null;
    });
  }

  clearPlannerRunRuntimeIfCurrent(
    runId: string,
    runtime: PlannerRunRuntimeProvenance,
  ): PlannerRun | null {
    const existing = this.getPlannerRun(runId);
    if (
      !existing?.runtime ||
      !samePlannerRunRuntime(existing.runtime, runtime)
    ) {
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

  createPlannerRunIfNoActive(
    input: CreatePlannerRunInput,
  ):
    | { ok: true; run: PlannerRun; created: boolean }
    | { ok: false; active: PlannerRun } {
    return this.ctx.storage.transactionSync(() => {
      if (input.runId) {
        const existing = this.getPlannerRun(input.runId);
        if (existing) {
          if (
            existing.repoId !== input.repoId ||
            existing.planArtifactId !== input.planArtifactId ||
            existing.role !== input.role ||
            existing.threadId !== input.threadId ||
            existing.input?.skillDefinitionSnapshot?.id !==
              input.input?.skillDefinitionSnapshot?.id
          )
            throw new Error(
              "runId is already used by a different reviewer run.",
            );
          return { ok: true as const, run: existing, created: false };
        }
      }
      const plan = this.getArtifact(input.planArtifactId);
      if (!plan || plan.repoId !== input.repoId || plan.type !== "plan") {
        throw new Error(`Plan artifact not found: ${input.planArtifactId}`);
      }
      if (plan.status === "completed" || plan.status === "archived") {
        throw new Error(
          "Completed or archived plans cannot start reviewer work.",
        );
      }
      if (
        input.expectedPlanVersion !== undefined &&
        (plan.version ?? 1) !== input.expectedPlanVersion
      ) {
        throw new Error(
          `Plan version mismatch: expected ${input.expectedPlanVersion}, found ${plan.version ?? 1}.`,
        );
      }
      const linkedInvocation = input.skillInvocationId
        ? this.getPlanSkillInvocation(input.skillInvocationId)
        : null;
      const activeRootRunId = linkedInvocation
        ? (this.db.exec(
            `SELECT r.run_id
             FROM planner_runs r
             JOIN plan_skill_invocations i
               ON i.invocation_id = r.skill_invocation_id
             WHERE i.repo_id = ? AND i.plan_artifact_id = ?
               AND i.parent_thread_id = ?
               AND r.status IN ('queued', 'running', 'saving')
             LIMIT 1`,
            input.repoId,
            input.planArtifactId,
            linkedInvocation.parentThreadId,
          ).toArray()[0] as { run_id: string } | undefined)
        : undefined;
      const active = activeRootRunId
        ? this.getPlannerRun(activeRootRunId.run_id)
        : input.threadId
          ? this.getActiveRunForThread(
              input.repoId,
              input.planArtifactId,
              input.role,
              input.threadId,
            )
          : this.getActivePlannerRun(
              input.repoId,
              input.planArtifactId,
              input.role,
              null,
            );
      if (active) return { ok: false as const, active };
      const reviewer = input.threadId ? this.getReviewer(input.threadId) : null;
      if (input.threadId) {
        if (
          !reviewer ||
          reviewer.role !== "reviewer" ||
          reviewer.repoId !== input.repoId ||
          reviewer.planArtifactId !== input.planArtifactId ||
          reviewer.removedAt
        ) {
          throw new Error(
            `Reviewer registry row is not active: ${input.threadId}`,
          );
        }
      }
      const run = this.createPlannerRun(input);
      if (input.threadId) {
        this.updateReviewerRunState({
          repoId: input.repoId,
          planArtifactId: input.planArtifactId,
          threadId: input.threadId,
          runId: run.runId,
          status: "queued",
          error: null,
        });
      }
      return { ok: true as const, run, created: true };
    });
  }

  getPlannerRun(runId: string): PlannerRun | null {
    const row = this.db
      .exec("SELECT * FROM planner_runs WHERE run_id = ?", runId)
      .toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  // Result callbacks use one store operation to announce liveness and load
  // their run. This closes the watchdog race between a separate read and
  // contact write while leaving invalid/terminal callbacks side-effect free.
  getPlannerRunAndRecordContact(runId: string): PlannerRun | null {
    return this.ctx.storage.transactionSync(() => {
      const current = this.getPlannerRun(runId);
      if (!current || !isActiveRunStatus(current.status)) return current;
      this.db.exec(
        "UPDATE planner_runs SET last_contact_at = ? WHERE run_id = ?",
        new Date().toISOString(),
        runId,
      );
      return this.getPlannerRun(runId);
    });
  }

  // Accepts one already-validated heartbeat batch as a single transition so a
  // terminal result cannot land between contact, queued→running projection,
  // reviewer projection, and event persistence.
  acceptReviewerRuntimeEventBatch(
    runId: string,
    events: ReviewerRuntimeEvent[],
  ): PlannerRun | null {
    return this.ctx.storage.transactionSync(() => {
      const current = this.getPlannerRun(runId);
      if (
        !current ||
        current.role !== "reviewer" ||
        !isActiveRunStatus(current.status)
      ) {
        return current;
      }
      const now = new Date().toISOString();
      this.db.exec(
        "UPDATE planner_runs SET last_contact_at = ? WHERE run_id = ?",
        now,
        runId,
      );
      let status = current.status;
      for (const event of events) {
        if (event.type === "runtime_startup" && status === "queued") {
          this.db.exec(
            "UPDATE planner_runs SET status = 'running' WHERE run_id = ? AND status = 'queued'",
            runId,
          );
          status = "running";
          if (current.threadId) {
            this.db.exec(
              `
                UPDATE reviewer_registry
                SET status = 'running', error = NULL, updated_at = ?
                WHERE repo_id = ? AND plan_artifact_id = ? AND thread_id = ?
                  AND role = 'reviewer' AND run_id = ?
              `,
              now,
              current.repoId,
              current.planArtifactId,
              current.threadId,
              current.runId,
            );
          }
        }
        this.appendPlannerRunEvent({
          runId: current.runId,
          repoId: current.repoId,
          planArtifactId: current.planArtifactId,
          type: event.type,
          message: event.message,
          createdAt: now,
        });
      }
      return this.getPlannerRun(runId);
    });
  }

  acceptPlannerRunCodexRuntimeAuth(
    runId: string,
    accountIdInput: string,
  ): "accepted" | "inactive" | "account_changed" {
    const accountId = accountIdInput.trim();
    const run = this.getPlannerRun(runId);
    const profile = run?.launchProvenance?.codexExecution;
    if (
      !accountId ||
      !run ||
      !isActiveRunStatus(run.status) ||
      !run.runtime ||
      run.provider !== "codex" ||
      profile?.kind !== "subscription-app-server" ||
      profile.surface !== "plan-reviewer"
    )
      return "inactive";
    const accountRow = this.db
      .exec("SELECT codex_account_id FROM planner_runs WHERE run_id = ?", runId)
      .toArray()[0] as { codex_account_id: string | null } | undefined;
    if (
      accountRow?.codex_account_id &&
      accountRow.codex_account_id !== accountId
    ) {
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

  getActivePlannerRun(
    repoId: string,
    planArtifactId: string,
    role: PlannerRun["role"],
    threadId?: string | null,
  ): PlannerRun | null {
    const values: Array<string | number | null> = [
      repoId,
      planArtifactId,
      role,
    ];
    const threadClause = threadId ? "AND thread_id = ?" : "";
    if (threadId) values.push(threadId);
    const row = this.db
      .exec(
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
      )
      .toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  getActiveRunForThread(
    repoId: string,
    planArtifactId: string,
    role: PlannerRun["role"],
    threadId: string,
  ): PlannerRun | null {
    const row = this.db
      .exec(
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
      )
      .toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  getLatestPlannerRun(
    repoId: string,
    planArtifactId: string,
    role: PlannerRun["role"],
    threadId?: string | null,
  ): PlannerRun | null {
    const values: Array<string | number | null> = [
      repoId,
      planArtifactId,
      role,
    ];
    const threadClause = threadId ? "AND thread_id = ?" : "";
    if (threadId) values.push(threadId);
    const row = this.db
      .exec(
        `
        SELECT *
        FROM planner_runs
        WHERE repo_id = ? AND plan_artifact_id = ? AND role = ?
          ${threadClause}
        ORDER BY started_at DESC
        LIMIT 1
      `,
        ...values,
      )
      .toArray()[0] as unknown as PlannerRunRow | undefined;
    return row ? this.parsePlannerRunRow(row) : null;
  }

  listRecentPlannerRuns(
    repoId: string,
    planArtifactId: string,
    input: {
      role?: PlannerRun["role"];
      threadId?: string | null;
      limit?: number;
    } = {},
  ): PlannerRun[] {
    const values: Array<string | number | null> = [repoId, planArtifactId];
    const roleClause = input.role ? "AND role = ?" : "";
    if (input.role) values.push(input.role);
    const threadClause = input.threadId ? "AND thread_id = ?" : "";
    if (input.threadId) values.push(input.threadId);
    values.push(Math.max(1, Math.min(input.limit ?? 20, 50)));
    const rows = this.db
      .exec(
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
      )
      .toArray() as unknown as PlannerRunRow[];
    return rows.map((row) => this.parsePlannerRunRow(row));
  }

  listActivePlannerRunsForRepo(repoId: string): PlannerRun[] {
    const rows = this.db
      .exec(
        `
        SELECT * FROM planner_runs
        WHERE repo_id = ? AND status IN ('queued', 'running', 'saving')
        ORDER BY started_at ASC
      `,
        repoId,
      )
      .toArray() as unknown as PlannerRunRow[];
    return rows.map((row) => this.parsePlannerRunRow(row));
  }

  listPlannerWorkloadStateForPredeploy(repoId: string): Array<{
    runId: string;
    status: string;
    hasRuntime: boolean;
  }> {
    const rows = this.db
      .exec(
        `
        SELECT run_id, status, runtime_json
        FROM planner_runs
        WHERE repo_id = ?
        ORDER BY started_at ASC
      `,
        repoId,
      )
      .toArray() as unknown as Array<
      Pick<PlannerRunRow, "run_id" | "status" | "runtime_json">
    >;
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      hasRuntime: row.runtime_json !== null,
    }));
  }

  listPlanWritersForRepo(repoId: string): ReviewerRegistryEntry[] {
    const rows = this.db
      .exec(
        `
        SELECT * FROM reviewer_registry
        WHERE repo_id = ? AND role = 'writer'
        ORDER BY created_at ASC, rowid ASC
      `,
        repoId,
      )
      .toArray() as unknown as ReviewerRegistryRow[];
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
      const runBlocker = this.db
        .exec(
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
        )
        .toArray()[0] as unknown as
        | {
            run_id: string;
            status: string;
            runtime_json: string | null;
          }
        | undefined;
      if (runBlocker) {
        throw new Error(
          runBlocker.runtime_json
            ? `Planner run ${runBlocker.run_id} retains runtime provenance.`
            : `Planner run ${runBlocker.run_id} is still ${runBlocker.status}.`,
        );
      }
      const writerBlocker = this.db
        .exec(
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
        )
        .toArray()[0] as unknown as
        | {
            thread_id: string;
          }
        | undefined;
      if (writerBlocker) {
        throw new Error(
          `Plan Writer ${writerBlocker.thread_id} is not fully cleaned up.`,
        );
      }
      const cleanupBlocker = this.db
        .exec(
          `
          SELECT cleanup_id
          FROM plan_runtime_cleanup
          WHERE repo_id = ?
          LIMIT 1
        `,
          repoId,
        )
        .toArray()[0] as unknown as { cleanup_id: string } | undefined;
      if (cleanupBlocker) {
        throw new Error(
          `Plan runtime cleanup ${cleanupBlocker.cleanup_id} is still pending.`,
        );
      }
      const sidebarSlotBlocker = this.db
        .exec(
          `
          SELECT env_slug, state
          FROM environment_sidebar_slots
          LIMIT 1
        `,
        )
        .toArray()[0] as unknown as
        | {
            env_slug: string;
            state: "reserved" | "committed";
          }
        | undefined;
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
        "plan_runtime_cleanup",
        "plan_agent_reset_receipts",
        "retired_planner_run_ids",
        "plan_writer_generation_fences",
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
      input.completedAt === undefined
        ? (existing.completedAt ?? null)
        : input.completedAt,
      input.error === undefined ? (existing.error ?? null) : input.error,
      input.runId,
    );

    const updated = this.getPlannerRun(input.runId);
    if (!updated) {
      throw new Error(`Planner run not found after update: ${input.runId}`);
    }
    if (
      updated.skillInvocationId &&
      (updated.skillRunRole === "root_initial" ||
        updated.skillRunRole === "report_initial" ||
        updated.skillRunRole === "overview") &&
      !isActiveRunStatus(updated.status)
    ) {
      this.refreshPlanSkillInvocationStatus(updated.skillInvocationId);
    }
    return updated;
  }

  updateActivePlannerRun(input: UpdatePlannerRunInput): PlannerRun {
    const existing = this.getPlannerRun(input.runId);
    if (!existing) {
      throw new Error(`Planner run not found: ${input.runId}`);
    }
    if (
      existing.status !== "queued" &&
      existing.status !== "running" &&
      existing.status !== "saving"
    ) {
      return existing;
    }
    return this.updatePlannerRun(input);
  }

  finishActiveReviewerRun(
    input: FinishActiveReviewerRunInput,
  ): FinishActiveReviewerRunResult {
    return this.ctx.storage.transactionSync(() => {
      const current = this.getPlannerRun(input.runId);
      if (
        !current ||
        current.role !== "reviewer" ||
        current.repoId !== input.repoId ||
        current.planArtifactId !== input.planArtifactId
      ) {
        throw new Error(`Reviewer run not found: ${input.runId}`);
      }
      const staleActiveCutoffMs = Date.parse(input.staleActiveCutoff ?? "");
      const staleActiveSignals =
        input.status === "failed" &&
        input.staleActiveCutoff !== undefined &&
        isActiveRunStatus(current.status)
          ? [
              Date.parse(current.startedAt),
              Date.parse(current.lastContactAt ?? ""),
              Date.parse(this.getLastPlannerRunEventAt(current.runId) ?? ""),
            ].filter((value) => Number.isFinite(value))
          : [];
      const canAbandonStaleActive =
        Number.isFinite(staleActiveCutoffMs) &&
        staleActiveSignals.length > 0 &&
        Math.max(...staleActiveSignals) <= staleActiveCutoffMs;
      const runtimeMatches =
        input.expectedRuntime === undefined ||
        (input.expectedRuntime === null
          ? current.runtime === null
          : current.runtime?.jobSlug === input.expectedRuntime.jobSlug);
      const canFinalizeForStatus =
        input.status === "completed"
          ? current.status === "queued" ||
            current.status === "running" ||
            current.status === "saving"
          : input.staleActiveCutoff !== undefined
            ? canAbandonStaleActive
            : current.status === "queued" || current.status === "running";
      const canFinalize = runtimeMatches && canFinalizeForStatus;
      if (!canFinalize) {
        return { run: current, finalized: false };
      }

      for (const event of input.events) {
        this.appendPlannerRunEvent({
          runId: current.runId,
          repoId: current.repoId,
          planArtifactId: current.planArtifactId,
          type: event.type,
          ...(event.message ? { message: event.message } : {}),
          ...(event.data === undefined ? {} : { data: event.data }),
          createdAt: input.completedAt,
        });
      }

      const error =
        input.status === "failed"
          ? input.error?.trim() || "Reviewer run failed."
          : null;
      this.db.exec(
        `
          UPDATE planner_runs
          SET status = ?, completed_at = ?, error = ?
          WHERE run_id = ? AND status = ?
        `,
        input.status,
        input.completedAt,
        error,
        current.runId,
        current.status,
      );

      let attentionSet = false;
      if (current.threadId) {
        const reviewer = this.db
          .exec(
            `
            SELECT removed_at, skill_invocation_id
            FROM reviewer_registry
            WHERE repo_id = ? AND plan_artifact_id = ? AND thread_id = ?
              AND role = 'reviewer' AND run_id = ?
            LIMIT 1
          `,
            current.repoId,
            current.planArtifactId,
            current.threadId,
            current.runId,
          )
          .toArray()[0] as unknown as
          | {
              removed_at: string | null;
              skill_invocation_id: string | null;
            }
          | undefined;
        const plan = this.db
          .exec(
            "SELECT status FROM artifacts WHERE repo_id = ? AND id = ? AND type = 'plan' LIMIT 1",
            current.repoId,
            current.planArtifactId,
          )
          .toArray()[0] as unknown as { status: PlanStatus | null } | undefined;
        attentionSet = Boolean(
          reviewer &&
          !reviewer.removed_at &&
          plan &&
          plan.status !== "completed" &&
          plan.status !== "archived",
        );
        this.db.exec(
          `
            UPDATE reviewer_registry
            SET status = ?, error = ?,
                unread_attention_token = CASE WHEN ? = 1 THEN ? ELSE unread_attention_token END,
                updated_at = ?
            WHERE repo_id = ? AND plan_artifact_id = ? AND thread_id = ?
              AND role = 'reviewer' AND run_id = ?
          `,
          input.status,
          error,
          attentionSet ? 1 : 0,
          current.runId,
          input.completedAt,
          current.repoId,
          current.planArtifactId,
          current.threadId,
          current.runId,
        );
      }

      const finished = this.getPlannerRun(current.runId);
      if (!finished)
        throw new Error(
          `Reviewer run not found after finalization: ${current.runId}`,
        );
      if (
        finished.skillInvocationId &&
        (finished.skillRunRole === "root_initial" ||
          finished.skillRunRole === "report_initial" ||
          finished.skillRunRole === "overview")
      ) {
        if (
          finished.status === "completed" &&
          finished.skillRunRole === "report_initial"
        ) {
          this.recordPlanSkillReport(
            finished.runId,
            `reviewer-result:${finished.runId}`,
          );
        }
        this.refreshPlanSkillInvocationStatus(finished.skillInvocationId);
      }
      return { run: finished, finalized: true };
    });
  }

  completePlanHealthReviewerOutput(
    runId: string,
    output:
      | { status: "succeeded"; text: string }
      | { status: "failed"; error: string },
    options: {
      expectedRuntime?: PlannerRunRuntimeProvenance | null;
      staleActiveCutoff?: string;
    } = {},
  ): PlanHealthCompletionResult {
    const raw = this.db
      .exec("SELECT * FROM planner_runs WHERE run_id = ?", runId)
      .toArray()[0] as unknown as PlannerRunRow | undefined;
    const storedInput = parseStoredPlannerRunInput(raw?.input_json ?? null);
    if (!raw) {
      return { handled: false };
    }
    const run = this.parsePlannerRunRow(raw);
    if (storedInput?.initialResultHandler !== PLAN_HEALTH_RESULT_HANDLER) {
      return { handled: false };
    }
    const invocation = run.skillInvocationId
      ? this.getPlanSkillInvocation(run.skillInvocationId)
      : null;
    const reviewer = run.threadId ? this.getReviewer(run.threadId) : null;
    const definition = invocation?.definitionSnapshot;
    const trusted = Boolean(
      run.role === "reviewer" &&
      (run.skillRunRole === "root_initial" ||
        run.skillRunRole === "report_initial") &&
      run.skillInvocationId &&
      definition &&
      run.skillAgentId &&
      trustedBuiltInInitialResultHandler(definition, [
        { id: run.skillAgentId },
      ]) === PLAN_HEALTH_RESULT_HANDLER &&
      reviewer?.role === "reviewer" &&
      reviewer.skillInvocationId === invocation?.invocationId &&
      reviewer.skillAgentId === run.skillAgentId,
    );
    if (!trusted || !invocation) {
      throw new Error("Structured reviewer completion provenance is invalid.");
    }

    if (!isActiveRunStatus(run.status)) {
      if (run.status === "completed" && invocation.result) {
        return {
          handled: true,
          run,
          finalized: false,
          result: invocation.result,
        };
      }
      return {
        handled: true,
        run,
        finalized: false,
        error:
          run.status === "cancelled"
            ? "Skill invocation cancelled."
            : (run.error ??
              invocation.error ??
              "Plan Health assessment failed."),
      };
    }

    let parsed: ReturnType<typeof parsePlanHealthOutput> | null = null;
    let terminalError: string | null = null;
    if (output.status === "succeeded") {
      try {
        parsed = parsePlanHealthOutput(output.text);
      } catch (error) {
        terminalError =
          error instanceof Error
            ? error.message
            : "Plan Health output is invalid.";
      }
    } else {
      terminalError =
        output.error.trim() || "Planner runtime reported a failure.";
    }

    return this.ctx.storage.transactionSync(() => {
      const currentRaw = this.db
        .exec("SELECT * FROM planner_runs WHERE run_id = ?", runId)
        .toArray()[0] as unknown as PlannerRunRow | undefined;
      if (!currentRaw) throw new Error(`Reviewer run not found: ${runId}`);
      const current = this.parsePlannerRunRow(currentRaw);
      const currentInvocation = this.getPlanSkillInvocation(
        invocation.invocationId,
      );
      if (!currentInvocation)
        throw new Error(
          `Skill invocation not found: ${invocation.invocationId}`,
        );
      if (!isActiveRunStatus(current.status)) {
        if (current.status === "completed" && currentInvocation.result) {
          return {
            handled: true,
            run: current,
            finalized: false,
            result: currentInvocation.result,
          };
        }
        return {
          handled: true,
          run: current,
          finalized: false,
          error:
            current.status === "cancelled"
              ? "Skill invocation cancelled."
              : (current.error ??
                currentInvocation.error ??
                "Plan Health assessment failed."),
        };
      }
      const runtimeMatches =
        options.expectedRuntime === undefined ||
        (options.expectedRuntime === null
          ? current.runtime === undefined
          : current.runtime?.jobSlug === options.expectedRuntime.jobSlug);
      const staleActiveCutoffMs = Date.parse(options.staleActiveCutoff ?? "");
      const staleActiveSignals =
        options.staleActiveCutoff !== undefined && output.status === "failed"
          ? [
              Date.parse(current.startedAt),
              Date.parse(current.lastContactAt ?? ""),
              Date.parse(this.getLastPlannerRunEventAt(current.runId) ?? ""),
            ].filter((value) => Number.isFinite(value))
          : [];
      const canAbandonStaleActive =
        Number.isFinite(staleActiveCutoffMs) &&
        staleActiveSignals.length > 0 &&
        Math.max(...staleActiveSignals) <= staleActiveCutoffMs;
      if (
        !runtimeMatches ||
        (options.staleActiveCutoff !== undefined && !canAbandonStaleActive)
      ) {
        return { handled: true, run: current, finalized: false };
      }
      if (currentInvocation.status === "cancelled") {
        this.db.exec(
          "UPDATE planner_runs SET status = 'cancelled', completed_at = COALESCE(completed_at, ?), error = 'Skill invocation cancelled.' WHERE run_id = ?",
          new Date().toISOString(),
          runId,
        );
        return {
          handled: true,
          run: this.getPlannerRun(runId)!,
          finalized: true,
          error: "Skill invocation cancelled.",
        };
      }

      const completedAt = new Date().toISOString();
      if (terminalError || !parsed) {
        const error = terminalError ?? "Plan Health output is invalid.";
        this.appendPlannerRunEvent({
          runId,
          repoId: current.repoId,
          planArtifactId: current.planArtifactId,
          type: "run_failed",
          message: error,
          createdAt: completedAt,
        });
        this.db.exec(
          "UPDATE planner_runs SET status = 'failed', completed_at = ?, error = ? WHERE run_id = ?",
          completedAt,
          error,
          runId,
        );
        this.db.exec(
          "UPDATE reviewer_registry SET status = 'failed', error = ?, updated_at = ? WHERE thread_id = ? AND run_id = ?",
          error,
          completedAt,
          current.threadId ?? "",
          runId,
        );
        this.db.exec(
          "UPDATE plan_skill_invocations SET status = 'failed', error = ?, result_json = NULL, updated_at = ? WHERE invocation_id = ?",
          error,
          completedAt,
          currentInvocation.invocationId,
        );
        return {
          handled: true,
          run: this.getPlannerRun(runId)!,
          finalized: true,
          error,
        };
      }

      const plan = this.getArtifact(current.planArtifactId);
      if (!plan || plan.repoId !== current.repoId || plan.type !== "plan") {
        throw new Error(`Plan artifact not found: ${current.planArtifactId}`);
      }
      if (plan.status === "completed" || plan.status === "archived") {
        this.db.exec(
          "UPDATE planner_runs SET status = 'cancelled', completed_at = ?, error = 'Skill invocation cancelled.' WHERE run_id = ?",
          completedAt,
          runId,
        );
        this.db.exec(
          "UPDATE plan_skill_invocations SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, ?), updated_at = ? WHERE invocation_id = ?",
          completedAt,
          completedAt,
          currentInvocation.invocationId,
        );
        return {
          handled: true,
          run: this.getPlannerRun(runId)!,
          finalized: true,
          error: "Skill invocation cancelled.",
        };
      }
      const normalizationVersion =
        currentInvocation.basis.normalizationVersion ??
        PLAN_MARKDOWN_NORMALIZATION_VERSION;
      const application =
        normalizePlanMarkdownAtVersion(
          renderArtifactBodyMarkdown(plan.body),
          normalizationVersion,
        ) ===
        normalizePlanMarkdownAtVersion(
          currentInvocation.basis.markdown,
          normalizationVersion,
        )
          ? ("applied" as const)
          : ("plan_changed" as const);
      const result: PlanHealthSkillResult = {
        kind: "plan-health",
        schemaVersion: 1,
        assessments: parsed,
        assessedAt: completedAt,
        basisVersion: currentInvocation.basis.version,
        application,
      };
      this.appendPlannerRunEvent({
        runId,
        repoId: current.repoId,
        planArtifactId: current.planArtifactId,
        type: "run_completed",
        message: "Plan Health assessment completed.",
        createdAt: completedAt,
      });
      this.db.exec(
        "UPDATE planner_runs SET status = 'completed', completed_at = ?, error = NULL WHERE run_id = ?",
        completedAt,
        runId,
      );
      this.db.exec(
        "UPDATE reviewer_registry SET status = 'completed', error = NULL, updated_at = ? WHERE thread_id = ? AND run_id = ?",
        completedAt,
        current.threadId ?? "",
        runId,
      );
      this.db.exec(
        "UPDATE plan_skill_invocations SET status = 'completed', error = NULL, result_json = ?, updated_at = ? WHERE invocation_id = ?",
        JSON.stringify(result),
        completedAt,
        currentInvocation.invocationId,
      );
      if (application === "applied") {
        const assessment: PlanHealthAssessment = {
          schemaVersion: 1,
          assessments: result.assessments,
          assessedAt: result.assessedAt,
          basisVersion: result.basisVersion,
          skillInvocationId: currentInvocation.invocationId,
        };
        this.db.exec(
          "UPDATE artifacts SET plan_health_json = ? WHERE id = ? AND repo_id = ?",
          JSON.stringify(assessment),
          current.planArtifactId,
          current.repoId,
        );
      }
      return {
        handled: true,
        run: this.getPlannerRun(runId)!,
        finalized: true,
        result,
      };
    });
  }

  getPlanHealthVirtualMessage(
    threadId: string,
  ): import("./types").ThreadMessage | null {
    const reviewer = this.getReviewer(threadId);
    if (!reviewer?.skillInvocationId || reviewer.role !== "reviewer")
      return null;
    const invocation = this.getPlanSkillInvocation(reviewer.skillInvocationId);
    if (
      !invocation?.result ||
      invocation.definitionSnapshot.id !== BUILTIN_PLAN_HEALTH_SKILL_ID
    )
      return null;
    const runs = this.listPlanSkillInvocationRuns(invocation.invocationId)
      .filter(
        (run) =>
          run.threadId === threadId && run.skillRunRole === "root_initial",
      )
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt));
    const initial = runs[0];
    if (!initial) return null;
    return {
      id: `plan-health-result:${invocation.invocationId}`,
      threadId,
      seq: 0,
      senderSessionId: "assistant",
      kind: "chat",
      body: {
        role: "assistant",
        text: renderPlanHealthResult(invocation.result),
        runId: initial.runId,
        planVersion: invocation.result.basisVersion,
        virtual: "plan-health-result",
        forwardable: false,
      },
      artifactIds: [invocation.planArtifactId],
      createdAt: invocation.result.assessedAt,
    };
  }

  claimPlannerRunSaving(runId: string): PlannerRun | null {
    const existing = this.getPlannerRun(runId);
    if (existing?.role === "reviewer" && existing.status === "saving") {
      return existing;
    }
    if (
      !existing ||
      existing.role !== "reviewer" ||
      (existing.status !== "queued" && existing.status !== "running")
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
    const cancellable =
      existing.status === "queued" ||
      existing.status === "running" ||
      (options.allowSaving === true && existing.status === "saving");
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
    const maxRow = this.db
      .exec(
        "SELECT MAX(seq) AS seq FROM planner_run_events WHERE run_id = ?",
        input.runId,
      )
      .toArray()[0] as unknown as { seq: number | null } | undefined;
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

  ensurePlannerRunQueuedEvent(
    input: AppendPlannerRunEventInput,
  ): PlannerRunEvent {
    if (input.type !== "run_queued") {
      throw new Error("Only run_queued events can be ensured by type.");
    }
    return this.ctx.storage.transactionSync(() => {
      const existing = this.db
        .exec(
          "SELECT * FROM planner_run_events WHERE run_id = ? AND type = 'run_queued' ORDER BY seq ASC LIMIT 1",
          input.runId,
        )
        .toArray()[0] as unknown as PlannerRunEventRow | undefined;
      return existing
        ? this.parsePlannerRunEventRow(existing)
        : this.appendPlannerRunEvent(input);
    });
  }

  // Server-owned lifecycle events are a secondary watchdog signal. Runtime
  // callbacks, including empty status polls, update last_contact_at directly.
  getLastPlannerRunEventAt(runId: string): string | null {
    const row = this.db
      .exec(
        "SELECT created_at FROM planner_run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1",
        runId,
      )
      .toArray()[0] as unknown as { created_at: string } | undefined;
    return row?.created_at ?? null;
  }

  listPlannerRunEvents(
    runId: string,
    options: { afterSeq?: number | null; limit?: number } = {},
  ): PlannerRunEvent[] {
    const limit = Math.max(
      1,
      Math.min(options.limit ?? MAX_STORED_RUN_EVENTS, MAX_STORED_RUN_EVENTS),
    );
    const afterSeq = Number.isInteger(options.afterSeq)
      ? Number(options.afterSeq)
      : null;
    const rows =
      afterSeq !== null
        ? (this.db
            .exec(
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
            )
            .toArray() as unknown as PlannerRunEventRow[])
        : (this.db
            .exec(
              `
          SELECT *
          FROM planner_run_events
          WHERE run_id = ?
          ORDER BY seq ASC
          LIMIT ?
        `,
              runId,
              limit,
            )
            .toArray() as unknown as PlannerRunEventRow[]);
    return rows.map((row) => this.parsePlannerRunEventRow(row));
  }

  setRef(input: SetRefInput): ArtifactRef {
    this.assertRepositoryWritable();
    const now = new Date().toISOString();
    const existing = this.getRef(input.name);
    if (existing) {
      if (
        input.expectedVersion !== undefined &&
        input.expectedVersion !== null &&
        existing.version !== input.expectedVersion
      ) {
        throw new Error(
          `Ref version mismatch for ${input.name}: expected ${input.expectedVersion}, found ${existing.version}`,
        );
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

    if (
      input.expectedVersion !== undefined &&
      input.expectedVersion !== null &&
      input.expectedVersion !== 0
    ) {
      throw new Error(
        `Ref version mismatch for ${input.name}: expected ${input.expectedVersion}, found none`,
      );
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
    const row = this.db
      .exec("SELECT * FROM refs WHERE name = ?", name)
      .toArray()[0] as unknown as RefRow | undefined;
    return row ? this.parseRefRow(row) : null;
  }

  listRefs(): ArtifactRef[] {
    const rows = this.db
      .exec("SELECT * FROM refs ORDER BY name ASC")
      .toArray() as unknown as RefRow[];
    return rows.map((row) => this.parseRefRow(row));
  }
}
