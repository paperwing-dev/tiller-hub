import type { Server } from "partyserver";
import type {
  HarnessCredentialRequirement,
  HarnessProviderKind,
} from "../shared/harness-catalog";

// ── Env bindings ────────────────────────────────────────────────────

export interface Env {
  ARTIFACT_STORE: DurableObjectNamespace;
  ENV_REVIEW: DurableObjectNamespace;
  ENV_LIFECYCLE: DurableObjectNamespace;
  SCHEDULED_RUN_CAPACITY: DurableObjectNamespace;
  GITHUB_JOB: DurableObjectNamespace;
  HUB: DurableObjectNamespace<Server<Env>>;
  PLANNER_RUN: DurableObjectNamespace;
  THREAD: DurableObjectNamespace;
  TILLER_VOICE: DurableObjectNamespace;
  REVIEWER_CHAT: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  AI: Ai;
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  ENVS_KV: KVNamespace;
  CODEX_AUTH: DurableObjectNamespace;
  LOCAL_DEV_ONLY_BACKEND?: string;
  TILLER_LOCAL_DEV_ORIGIN?: string;
  /** Present together only on Hubs created by the fresh OAuth installer. */
  TILLER_INSTALLER_SCHEMA?: string;
  /** Present only on the fixed maintainer-owned tiller-dev deployment. */
  TILLER_MAINTAINER_DEV_SCHEMA?: string;
  TILLER_INSTALLATION_ID?: string;
  TILLER_RELEASE_ID?: string;
  TILLER_WORKERS_DEV_HOSTNAME?: string;
  DO_LOCATION_HINT?: string;
  CF_ACCESS_ISSUER?: string;
  CF_ACCESS_AUDIENCE?: string;
  CF_ACCESS_IDENTITY_PROVIDER_ID?: string;
  CF_ACCESS_APPLICATION_ID?: string;
  CF_ACCESS_OWNER_POLICY_ID?: string;
  CF_ACCESS_SERVICE_POLICY_ID?: string;
  CF_ACCESS_PUBLIC_APPLICATION_ID?: string;
  CF_ACCESS_PUBLIC_POLICY_ID?: string;
  CF_ACCESS_SERVICE_TOKEN_ID?: string;
  CF_ACCESS_SERVICE_CLIENT_ID?: string;
  CF_ACCESS_TOKEN_EXPIRES_AT?: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  PLANNER_DEBUG?: string;
  /** Emit hop-local terminal latency histograms; never cross-subtract clocks. */
  TILLER_TERMINAL_METRICS?: string;
  TILLER_ENABLE_FAKE_PLANNER_PROVIDER?: string;
  /** Operational-only Plan Writer startup deadline; never exposed by product APIs. */
  TILLER_PLAN_WRITER_WATCHDOG_MS?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  TILLER_WORKERS_AI_ACCOUNT_ID?: string;
  TILLER_WORKERS_AI_API_TOKEN?: string;
  TILLER_OPENCODE_PROXY_TOKEN?: string;
  ENABLED_ENV_HARNESSES?: string;
  TILLER_OWNER_EMAIL?: string;
  CF_ACCESS_SERVICE_CLIENT_SECRET?: string;
}

export type ResolvedClaudeAuthMode = "subscription" | "api";
export type CodexAuthMode = "subscription" | "api-key";
export type CodexAuthPreference = "subscription" | "api-key";
export type CodexSurface =
  | "implementor"
  | "plan-writer"
  | "plan-reviewer"
  | "environment-reviewer";
export type CodexRuntimeMode = "direct-cli" | "app-server";
export type CodexUnavailableReason =
  | "no_usable_credentials"
  | "subscription_missing"
  | "subscription_needs_reconnect"
  | "subscription_temporarily_unavailable"
  | "api_key_missing";
export type ExecutionSelection =
  | { target: "cf" }
  | { target: "host"; machineId: string };
export type ExecutionPlacement =
  | { backend: "cf"; machineId: null }
  | { backend: "host"; machineId: string };

export function isExecutionPlacement(value: unknown): value is ExecutionPlacement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.backend === "cf" && record.machineId === null)
    || (
      record.backend === "host"
      && typeof record.machineId === "string"
      && Boolean(record.machineId.trim())
    )
  );
}
export type HostIncompatibilityCode =
  | "runner_protocol"
  | "runtime_auth_protocol"
  | "runtime_image";
export type HostStatus =
  | { state: "not_connected" }
  | {
      state: "incompatible";
      machineId: string;
      displayName: string;
      code: HostIncompatibilityCode;
    }
  | {
      state: "ready";
      machineId: string;
      displayName: string;
    };
export type SelectedHostStatus =
  | {
      state: "offline";
      machineId: string;
      displayName: string;
    }
  | Exclude<HostStatus, { state: "not_connected" }>;
export interface ExecutionStatus {
  selected: ExecutionSelection;
  selectedHost: SelectedHostStatus | null;
  candidate: HostStatus;
  executionReady: boolean;
}
export type SetExecutionBackendRequest =
  | { target: "cf" }
  | { target: "host"; expectedMachineId: string };
export type SetExecutionBackendResult =
  | { ok: true; status: ExecutionStatus }
  | {
      ok: false;
      code: "execution_candidate_changed";
      message: string;
      status: ExecutionStatus;
    };
export type CodexTarget = { backend: "cf" | "host" };
export type CodexExecutionProfile =
  | ({ kind: "subscription-app-server"; surface: CodexSurface } & CodexTarget)
  | ({
      kind: "api-key-direct-cli";
      surface: "implementor" | "plan-reviewer" | "environment-reviewer";
    } & CodexTarget)
  | ({ kind: "api-key-app-server"; surface: "implementor" | "plan-writer" } & CodexTarget);
export type CodexExecutionResolution =
  | { kind: "ready"; profile: CodexExecutionProfile }
  | { kind: "unavailable"; reason: CodexUnavailableReason };
export type ChatGPTAuthStatus = "missing" | "connected" | "refreshing" | "needs_reconnect" | "temporarily_unavailable";
export type CodexRouteStatus =
  | "available"
  | "backend_offline"
  | "runtime_update_required"
  | "environment_not_connected"
  | "authentication_unavailable"
  | "direct_api"
  | "unavailable";
export const ENV_HARNESSES = ["claude-code", "codex", "opencode"] as const;
export type EnvHarness = (typeof ENV_HARNESSES)[number];
export const HARNESS_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.5",
  "claude-opus-5",
  "claude-opus-4.8",
  "claude-fable-5",
  "kimi-k2.7-code",
] as const;
export type HarnessModelId = (typeof HARNESS_MODEL_IDS)[number];
export const HARNESS_EFFORTS = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
export type HarnessEffort = (typeof HARNESS_EFFORTS)[number];
export interface HarnessSettings {
  model: HarnessModelId;
  effort: HarnessEffort;
  /** Provider Fast mode. Omitted for Standard mode and unsupported models. */
  fastMode?: boolean;
}
export interface EnvHarnessPresentation {
  modelLabel: string;
  credentialRequirement: HarnessCredentialRequirement;
  providerKind: HarnessProviderKind;
  providerLabel: string;
}
export const SCM_MODELS = ["github"] as const;
export type ScmModel = (typeof SCM_MODELS)[number];
export const ENV_BRANCH_STATUSES = ["up-to-date", "behind-main", "ready-to-merge", "needs-attention"] as const;
export type EnvBranchStatus = "up-to-date" | "behind-main" | "ready-to-merge" | "needs-attention";
export const REPO_GIT_STATUSES = ["pending", "ready", "repair-required"] as const;
export type RepoGitStatus = "pending" | "ready" | "repair-required";
export const GITHUB_PUBLISH_STATUSES = ["publishing", "published", "up-to-date", "failed"] as const;
export type GitHubPublishStatus = (typeof GITHUB_PUBLISH_STATUSES)[number];
export const GITHUB_ENV_PUBLISH_STATUSES = ["idle", "publishing", "published", "up-to-date", "failed", "attention", "merged"] as const;
export type GitHubEnvPublishStatus = (typeof GITHUB_ENV_PUBLISH_STATUSES)[number];
export const GITHUB_PR_STATES = ["open", "closed", "merged"] as const;
export type GitHubPrState = (typeof GITHUB_PR_STATES)[number];
export type ScmOperationType = string;
export type EnvLifecyclePhase = "stopped" | "starting" | "running" | "saving" | "stopping" | "failed";
export type EnvInfraState = "unknown" | "ready" | "stopped";
export const ENV_STATUSES = ["creating", "starting", "running", "saving", "stopping", "stopped", "failed", "deleting", "unknown"] as const;
export type EnvStatus = "creating" | "starting" | "running" | "saving" | "stopping" | "stopped" | "failed" | "deleting" | "unknown";
export type EnvLifecycleDesiredState = "running" | "stopped";
export type EnvLifecycleOperation = "start" | "stop";
export type LeadHarnessStatus = "running" | "failed" | "unknown";
export const STARTUP_DIAGNOSTIC_STEP_IDS = [
  "workspace-sync",
  "stop-control",
  "prereq-check",
  "harness-launch",
  "hub-connect",
  "runner-ready",
  "startup-failed",
] as const;
export type StartupDiagnosticStepId = (typeof STARTUP_DIAGNOSTIC_STEP_IDS)[number];
export type StartupDiagnosticSeverity = "info" | "warn" | "error";

export function isEnvHarness(value: string | null | undefined): value is EnvHarness {
  return typeof value === "string" && (ENV_HARNESSES as readonly string[]).includes(value);
}

export function isEnvBranchStatus(value: string | null | undefined): value is EnvBranchStatus {
  return typeof value === "string" && (ENV_BRANCH_STATUSES as readonly string[]).includes(value);
}

export function isRepoGitStatus(value: string | null | undefined): value is RepoGitStatus {
  return typeof value === "string" && (REPO_GIT_STATUSES as readonly string[]).includes(value);
}

export function isGitHubPublishStatus(value: string | null | undefined): value is GitHubPublishStatus {
  return typeof value === "string" && (GITHUB_PUBLISH_STATUSES as readonly string[]).includes(value);
}

export function isGitHubEnvPublishStatus(value: string | null | undefined): value is GitHubEnvPublishStatus {
  return typeof value === "string" && (GITHUB_ENV_PUBLISH_STATUSES as readonly string[]).includes(value);
}

export function isGitHubPrState(value: string | null | undefined): value is GitHubPrState {
  return typeof value === "string" && (GITHUB_PR_STATES as readonly string[]).includes(value);
}

export function isEnvStatus(value: string | null | undefined): value is EnvStatus {
  return typeof value === "string" && (ENV_STATUSES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

export function isNullableBoolean(value: unknown): value is boolean | null {
  return typeof value === "boolean" || value === null;
}

export function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

export function isNullableInteger(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

export interface StartupDiagnosticEvent {
  at: string;
  opId: string;
  stepId: StartupDiagnosticStepId;
  severity: StartupDiagnosticSeverity;
  message: string;
  detail?: string | null;
}

export interface StartupDiagnosticFailure {
  message: string;
  exitCode?: number | null;
  signal?: string | null;
  lastStepId?: StartupDiagnosticStepId | null;
}

export interface StartupDiagnosticLogTails {
  harness: string | null;
  stopControl: string | null;
  bootstrap: string | null;
}

export interface StartupDiagnosticsSnapshot {
  opId: string;
  backend: "cf" | "host";
  /** Whether this start is interactive or executing the environment's saved plan. */
  implementationMode?: "fresh" | "plan" | null;
  startedAt: string;
  updatedAt: string;
  currentStepId: StartupDiagnosticStepId | null;
  currentStepMessage: string | null;
  events: StartupDiagnosticEvent[];
  failure: StartupDiagnosticFailure | null;
  logTails: StartupDiagnosticLogTails;
}

export interface StartupDiagnosticsState {
  active: StartupDiagnosticsSnapshot | null;
  lastFailed: StartupDiagnosticsSnapshot | null;
}

export interface EnvLifecycleState {
  phase: EnvLifecyclePhase;
  activeOpId: string | null;
  activeOperation: EnvLifecycleOperation | null;
  desiredState: EnvLifecycleDesiredState;
  lastRunnerState: string | null;
  lastWorkspaceSyncedAckOpId: string | null;
  infraState: EnvInfraState;
  runtimeReady: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  updatedAt: string;
}

export interface EnvDefinition {
  slug: string;
  /** Immutable user-facing name captured when the environment is created. */
  displayName?: string;
  /** Immutable identity for a published incarnation of this slug. */
  incarnationId: string;
  /** Stable, repo-wide ordering slot used by the implementor sidebar. */
  sidebarSlot?: number;
  repoId: string;
  scmModel: ScmModel;
  /** Immutable execution provenance. Required for clean-slate workload records. */
  executionPlacement: ExecutionPlacement;
  harness: EnvHarness;
  resolvedAuthMode?: ResolvedClaudeAuthMode;
  codexAuthMode?: CodexAuthMode;
  startupPlanId: string | null;
  branchName: string | null;
  createdAt: string;
}

export type ScheduledRunState = "scheduled" | "running" | "completed" | "interrupted" | "failed";

export interface ScheduledRunProjection {
  state: ScheduledRunState;
  stage?: "implementing" | "saving";
  runAtMs: number;
  timeZone: string;
  error?: string;
  cleanupRequired?: boolean;
}

export interface EnvMutableState {
  status: EnvStatus;
  scmModel: ScmModel;
  harnessSettings: HarnessSettings | null;
  /** Provider-specific auth route pinned by the active environment start claim. */
  startClaudeAuthMode?: ResolvedClaudeAuthMode | null;
  /** Provider-specific auth route pinned by the active environment start claim. */
  startCodexAuthPreference?: CodexAuthPreference | null;
  scheduledRun?: ScheduledRunProjection;
  lifecyclePhase: EnvLifecyclePhase | null;
  lifecycleOpId: string | null;
  lifecycleOperation: EnvLifecycleOperation | null;
  lifecycleDesiredState: EnvLifecycleDesiredState | null;
  lifecycleLastRunnerState: string | null;
  lifecycleLastWorkspaceSyncedAckOpId: string | null;
  lifecycleInfraState: EnvInfraState;
  lifecycleRuntimeReady: boolean;
  lifecycleUpdatedAt: string | null;
  implementorAttentionState: ImplementorAttentionState;
  runnerId: string | null;
  bootMessage: string | null;
  bootStepId?: StartupDiagnosticStepId | null;
  branchStatus: EnvBranchStatus | null;
  workspaceDirty: boolean | null;
  workspaceNeedsAttention: boolean | null;
  workspaceLastSyncedAt: string | null;
  baseMainCommit: string | null;
  lastKnownMainCommit: string | null;
  scmOperationType: ScmOperationType | null;
  scmOperationId: string | null;
  scmOperationPhase: string | null;
  scmOperationStartedAt: string | null;
  scmOperationUpdatedAt: string | null;
  scmLastCompletedAt: string | null;
  scmLastDurationMs: number | null;
  scmLastTimings: string | null;
  githubBaseBranch: string | null;
  githubBaseCommitSha: string | null;
  githubBranch: string | null;
  githubHeadCommitSha: string | null;
  githubPrNumber: number | null;
  githubPrUrl: string | null;
  githubPrState: GitHubPrState | null;
  githubMergedAt: string | null;
  githubPublishStatus: GitHubEnvPublishStatus;
  githubPublishOperationId: string | null;
  githubPublishError: string | null;
  githubLastPublishedAt: string | null;
  githubLastPublishedWorkspaceHash: string | null;
  githubPendingPublish: GitHubEnvPendingPublishProjection | null;
  leadHarnessStatus: LeadHarnessStatus | null;
  leadHarnessError: string | null;
  leadHarnessUpdatedAt: string | null;
  error: string | null;
  errorAt: string | null;
  updatedAt: string;
}

export interface ImplementorAttentionState {
  runtimeStartOpId: string | null;
  lastCompletionSequence: number;
  lastReviewerCompletionRunId?: string | null;
  unreadToken: string | null;
}

// Valid phase/activity values for agent state (Scion pattern)
export const VALID_PHASES = ["starting", "running", "stopped"] as const;
export const VALID_ACTIVITIES = ["idle", "thinking", "executing", "completed"] as const;
export type AgentPhase = (typeof VALID_PHASES)[number];
export type AgentActivity = (typeof VALID_ACTIVITIES)[number];
export type MachineServiceKey = "host";
export type RunnerControlAction = "create" | "status" | "start" | "stop" | "destroy";
export type RunnerCommandDesiredState = "running" | "stopped" | "absent";
export type RunnerControlErrorCode =
  | "runner_not_found"
  | "runner_command_superseded_before_mutation"
  | "runner_command_superseded"
  | "runner_command_conflict";

/**
 * Durable ordering identity for one machine-runner mutation. The lifecycle owner
 * allocates it once and reuses the exact tuple for every ambiguous retry.
 * `operationId` also correlates lifecycle callbacks on the machine runner, so the wire
 * does not carry duplicate action-specific operation ID fields.
 */
export interface RunnerCommandClaim {
  commandGeneration: number;
  operationId: string;
  desiredState: RunnerCommandDesiredState;
}

interface RunnerControlRequestBase {
  type: "runner-control-request";
  requestId: string;
  slug: string;
  repoUrl?: string;
  envVars?: Record<string, string>;
}

export type RunnerControlRequestMessage = RunnerControlRequestBase & (
  | {
      action: "status";
      commandGeneration?: never;
      operationId?: never;
      desiredState?: never;
    }
  | (RunnerCommandClaim & {
      action: "create" | "start";
      desiredState: "running";
    })
  | (RunnerCommandClaim & {
      action: "stop";
      desiredState: "stopped";
    })
  | (RunnerCommandClaim & {
      action: "destroy";
      desiredState: "absent";
    })
);

export interface RunnerControlResponseMessage {
  type: "runner-control-response";
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: RunnerControlErrorCode;
  currentCommandGeneration?: number;
}

export interface RepoSessionEnvRow {
  repo_id: string;
  name: string;
  encrypted_value: string;
  nonce: string;
  updated_at: string;
}

export interface RepoMcpServerRow {
  repo_id: string;
  id: string;
  label: string;
  url: string;
  enabled: number;
  updated_at: string;
}

// ── Hono context variables ──────────────────────────────────────────

export interface ApiRequestTiming {
  startedAt: number;
  phases: Array<{ name: string; durationMs: number }>;
}

export type HonoEnv = {
  Bindings: Env;
  Variables: {
    apiRequestTiming: ApiRequestTiming;
    authorization: RequestAuthorization;
  };
};

export type GlobalAuthorizationSource = "owner" | "control" | "local-dev";

export type RequestAuthorization =
  | { kind: "global"; source: GlobalAuthorizationSource; ownerEmail?: string }
  | { kind: "environment"; envSlug: string; incarnationId: string; startOperationId: string }
  | { kind: "specialized" }
  | { kind: "bootstrap" }
  | { kind: "public" };

export type WsAuthorization =
  | { kind: "global"; source: GlobalAuthorizationSource; ownerEmail?: string }
  | { kind: "environment"; envSlug: string; sessionId: string }
  | {
      kind: "planWriter";
      repoId: string;
      planArtifactId: string;
      generation: number;
      sessionId: string;
    };

// ── Stored row types ────────────────────────────────────────────────

export interface StoredSession {
  id: string;
  tag: string;
  machine_id: string | null;
  metadata: string; // JSON
  agent_state: string; // JSON
  todos: string; // JSON
  allowed_tools: string; // JSON array of tool patterns
  active: number; // 0 | 1
  metadata_version: number;
  agent_state_version: number;
  todos_version: number;
  /**
   * @deprecated Compatibility field only. ThreadDO is the authoritative
   * allocator for durable session-message sequence numbers.
   */
  seq: number;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

export type TerminalScope =
  | {
      kind: "environment";
      envSlug: string;
      role: string;
    }
  | {
      kind: "plan-writer";
      repoId: string;
      planArtifactId: string;
      generation: number;
      revokedAt?: string;
    };

export interface StoredMachine {
  id: string;
  metadata: string; // JSON
  runner_state: string; // JSON
  active: number; // 0 | 1
  metadata_version: number;
  runner_state_version: number;
  seq: number;
  created_at: string;
  updated_at: string;
}

export interface HostServiceRegistration {
  machineId: string;
  displayName: string;
  connectedAt: string;
  /** Machine execution supports durable generation fencing for runner mutations. */
  runnerCommandProtocol?: 1;
  /** Runtime can launch Codex app-server and exchange scoped Hub auth. */
  codexRuntimeAuthProtocol?: 1;
  /** Runtime protects reviewer checkouts and drops provider children. */
  reviewerIsolationProtocol?: 1;
  dockerAvailable: boolean;
  runnerAvailable: boolean;
  claudeSubscription: boolean;
  localRunnerImage?: string;
  localRunnerImageSourceId?: string;
  transport: "session";
}

export interface MachineServiceState {
  host?: HostServiceRegistration;
}

export interface StoredMessage {
  id: string;
  session_id: string;
  content: string; // JSON
  seq: number;
  local_id: string | null;
  created_at: string;
}

export interface StoredPermission {
  id: string;
  session_id: string;
  tool_name: string;
  tool_input: string; // JSON
  status: "pending" | "allowed" | "denied";
  decision_reason: string | null;
  created_at: string;
  resolved_at: string | null;
}

// ── Environment metadata ────────────────────────────────────────────

export interface EnvMeta {
  slug: string;
  /** Immutable user-facing name; absent on environments created by older builds. */
  displayName?: string;
  incarnationId: string;
  /** Stable, repo-wide ordering slot used by the implementor sidebar. */
  sidebarSlot?: number;
  repoUrl: string;
  repoId: string;
  scmModel: ScmModel;
  /** Display projection derived from executionPlacement. */
  backend: "cf" | "host";
  /** Immutable placement copied from the environment definition. */
  executionPlacement: ExecutionPlacement;
  runnerId?: string;
  harness: EnvHarness;
  harnessSettings: HarnessSettings | null;
  /** Catalog-derived display data. Never authoritative or persisted. */
  harnessPresentation?: EnvHarnessPresentation;
  scheduledRun?: ScheduledRunProjection;
  resolvedAuthMode?: ResolvedClaudeAuthMode;
  codexAuthMode?: CodexAuthMode;
  createdAt: string;
  updatedAt: string;
  status: EnvStatus;
  bootMessage?: string;
  bootStepId?: StartupDiagnosticStepId | null;
  startupPlanId: string | null;
  branchName: string | null;
  branchStatus: EnvBranchStatus | null;
  workspaceDirty: boolean | null;
  workspaceNeedsAttention: boolean | null;
  workspaceLastSyncedAt: string | null;
  baseMainCommit: string | null;
  lastKnownMainCommit: string | null;
  scmOperationType: ScmOperationType | null;
  scmOperationId: string | null;
  scmOperationPhase: string | null;
  scmOperationStartedAt: string | null;
  scmOperationUpdatedAt: string | null;
  scmLastCompletedAt: string | null;
  scmLastDurationMs: number | null;
  scmLastTimings: string | null;
  githubBaseBranch: string | null;
  githubBaseCommitSha: string | null;
  githubBranch: string | null;
  githubHeadCommitSha: string | null;
  githubPrNumber: number | null;
  githubPrUrl: string | null;
  githubPrState: GitHubPrState | null;
  githubMergedAt: string | null;
  githubPublishStatus: GitHubEnvPublishStatus;
  githubPublishOperationId: string | null;
  githubPublishError: string | null;
  githubLastPublishedAt: string | null;
  githubLastPublishedWorkspaceHash: string | null;
  githubPendingPublish: GitHubEnvPendingPublishProjection | null;
  lifecyclePhase?: EnvLifecyclePhase | null;
  lifecycleOpId?: string | null;
  lifecycleOperation?: EnvLifecycleOperation | null;
  lifecycleDesiredState?: EnvLifecycleDesiredState | null;
  lifecycleInfraState?: EnvInfraState | null;
  lifecycleRuntimeReady?: boolean;
  lifecycleUpdatedAt?: string | null;
  implementorAttentionToken: string | null;
  leadHarnessStatus?: LeadHarnessStatus | null;
  leadHarnessError?: string | null;
  leadHarnessUpdatedAt?: string | null;
  error?: string;
  errorAt?: string;
}

export type StoredEnvMeta = Omit<EnvMeta, "repoUrl" | "harnessPresentation">;

export interface GitHubEnvPendingPublishProjection {
  operationId: string;
  status: "starting" | "pushed" | "finalizing" | "failed";
  branch: string;
  baseCommitSha: string;
  workspaceHash: string;
  expectedPriorHead: string | null;
  pushedCommitSha: string | null;
  startedAt: string;
  updatedAt: string;
  error: string | null;
}

export interface GitHubPublishMeta {
  status: GitHubPublishStatus;
  branch: string;
  commitSha?: string | null;
  prNumber?: number | null;
  prUrl?: string | null;
  sourceEnvSlug?: string | null;
  operationId?: string | null;
  updatedAt: string;
  error?: string | null;
}

export interface RepoMeta {
  repoId: string;
  /** Null retains the original repoId-named store until this repository is deleted. */
  artifactStoreGeneration: string | null;
  repoUrl: string;
  scmModel: ScmModel;
  githubInstallationId: number;
  githubFullName: string;
  githubDefaultBranch: string | null;
  githubDefaultBranchHeadSha: string | null;
  githubWebhookConfigured: boolean;
  githubWebhookError: string | null;
  mainCommit: string | null;
  gitArtifactId: string | null;
  gitStatus: RepoGitStatus;
  gitError: string | null;
  gitFormatVersion: number | null;
  gitProgressPhase: string | null;
  gitProgressStartedAt: string | null;
  gitProgressUpdatedAt: string | null;
  gitLastBootstrapDurationMs: number | null;
  gitLastBootstrapTimings: string | null;
  createdAt: string;
  updatedAt: string;
  bootstrappedFromRef: string | null;
  lastCommittedFromEnvSlug?: string | null;
  lastCommittedAt?: string | null;
  githubPublish?: GitHubPublishMeta | null;
}

export function hasExplicitEnvDefinitionScmFields(
  value: unknown,
): value is Record<string, unknown> & Pick<EnvDefinition, "scmModel" | "startupPlanId" | "branchName"> {
  return (
    isRecord(value) &&
    value.scmModel === "github" &&
    isNullableString(value.startupPlanId) &&
    isNullableString(value.branchName)
  );
}

export function hasExplicitEnvScmFields(
  value: unknown,
): value is Record<string, unknown> & Pick<
  EnvMeta,
  | "startupPlanId"
  | "branchName"
  | "branchStatus"
  | "workspaceDirty"
  | "workspaceNeedsAttention"
  | "workspaceLastSyncedAt"
  | "baseMainCommit"
  | "lastKnownMainCommit"
  | "scmOperationType"
  | "scmOperationId"
  | "scmOperationPhase"
  | "scmOperationStartedAt"
  | "scmOperationUpdatedAt"
  | "scmLastCompletedAt"
  | "scmLastDurationMs"
  | "scmLastTimings"
> {
  return (
    isRecord(value) &&
    value.scmModel === "github" &&
    isNullableString(value.startupPlanId) &&
    isNullableString(value.branchName) &&
    (value.branchStatus === null || isEnvBranchStatus(typeof value.branchStatus === "string" ? value.branchStatus : null)) &&
    isNullableBoolean(value.workspaceDirty) &&
    isNullableBoolean(value.workspaceNeedsAttention) &&
    isNullableString(value.workspaceLastSyncedAt) &&
    isNullableString(value.baseMainCommit) &&
    isNullableString(value.lastKnownMainCommit) &&
    isNullableString(value.scmOperationType) &&
    isNullableString(value.scmOperationId) &&
    isNullableString(value.scmOperationPhase) &&
    isNullableString(value.scmOperationStartedAt) &&
    isNullableString(value.scmOperationUpdatedAt) &&
    isNullableString(value.scmLastCompletedAt) &&
    isNullableFiniteNumber(value.scmLastDurationMs) &&
    isNullableString(value.scmLastTimings) &&
    isNullableString(value.githubBaseBranch ?? null) &&
    isNullableString(value.githubBaseCommitSha ?? null) &&
    isNullableString(value.githubBranch ?? null) &&
    isNullableString(value.githubHeadCommitSha ?? null) &&
    isNullableInteger(value.githubPrNumber ?? null) &&
    isNullableString(value.githubPrUrl ?? null) &&
    (value.githubPrState === undefined || value.githubPrState === null || isGitHubPrState(typeof value.githubPrState === "string" ? value.githubPrState : null)) &&
    isNullableString(value.githubMergedAt ?? null) &&
    (value.githubPublishStatus === undefined || isGitHubEnvPublishStatus(typeof value.githubPublishStatus === "string" ? value.githubPublishStatus : null)) &&
    isNullableString(value.githubPublishOperationId ?? null) &&
    isNullableString(value.githubPublishError ?? null) &&
    isNullableString(value.githubLastPublishedAt ?? null) &&
    isNullableString(value.githubLastPublishedWorkspaceHash ?? null) &&
    (
      value.githubPendingPublish === undefined ||
      value.githubPendingPublish === null ||
      hasExplicitGitHubEnvPendingPublishProjection(value.githubPendingPublish)
    )
  );
}

export function hasExplicitGitHubEnvPendingPublishProjection(value: unknown): value is GitHubEnvPendingPublishProjection {
  if (!isRecord(value)) return false;
  return (
    typeof value.operationId === "string" &&
    (value.status === "starting" || value.status === "pushed" || value.status === "finalizing" || value.status === "failed") &&
    typeof value.branch === "string" &&
    typeof value.baseCommitSha === "string" &&
    typeof value.workspaceHash === "string" &&
    isNullableString(value.expectedPriorHead) &&
    isNullableString(value.pushedCommitSha) &&
    typeof value.startedAt === "string" &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.error)
  );
}

export function hasExplicitRepoScmFields(
  value: unknown,
): value is Record<string, unknown> & Pick<
  RepoMeta,
  | "scmModel"
  | "githubDefaultBranch"
  | "githubDefaultBranchHeadSha"
  | "githubWebhookConfigured"
  | "githubWebhookError"
  | "mainCommit"
  | "gitArtifactId"
  | "gitStatus"
  | "gitError"
  | "gitFormatVersion"
  | "gitProgressPhase"
  | "gitProgressStartedAt"
  | "gitProgressUpdatedAt"
  | "gitLastBootstrapDurationMs"
  | "gitLastBootstrapTimings"
> {
  return (
    isRecord(value) &&
    (value.scmModel === undefined || value.scmModel === "github") &&
    isNullableString(value.githubDefaultBranch ?? null) &&
    isNullableString(value.githubDefaultBranchHeadSha ?? null) &&
    (value.githubWebhookConfigured === undefined || typeof value.githubWebhookConfigured === "boolean") &&
    isNullableString(value.githubWebhookError ?? null) &&
    isNullableString(value.mainCommit) &&
    isNullableString(value.gitArtifactId) &&
    isRepoGitStatus(typeof value.gitStatus === "string" ? value.gitStatus : null) &&
    isNullableString(value.gitError) &&
    isNullableFiniteNumber(value.gitFormatVersion) &&
    isNullableString(value.gitProgressPhase) &&
    isNullableString(value.gitProgressStartedAt) &&
    isNullableString(value.gitProgressUpdatedAt) &&
    isNullableFiniteNumber(value.gitLastBootstrapDurationMs) &&
    isNullableString(value.gitLastBootstrapTimings)
  );
}

export function hasExplicitGitHubPublishFields(value: unknown): value is GitHubPublishMeta {
  return (
    isRecord(value) &&
    isGitHubPublishStatus(typeof value.status === "string" ? value.status : null) &&
    typeof value.branch === "string" &&
    value.branch.trim().length > 0 &&
    isNullableString(value.commitSha ?? null) &&
    isNullableInteger(value.prNumber ?? null) &&
    isNullableString(value.prUrl ?? null) &&
    isNullableString(value.sourceEnvSlug ?? null) &&
    isNullableString(value.operationId ?? null) &&
    typeof value.updatedAt === "string" &&
    isNullableString(value.error ?? null)
  );
}

export function hasExplicitRepoGitHubPublishFields(
  value: unknown,
): value is Record<string, unknown> & Pick<RepoMeta, "githubPublish"> {
  return (
    isRecord(value) &&
    (
      value.githubPublish === undefined ||
      value.githubPublish === null ||
      hasExplicitGitHubPublishFields(value.githubPublish)
    )
  );
}

// ── Versioned update result ─────────────────────────────────────────

export type VersionedUpdateResult =
  | { ok: true; version: number }
  | {
      ok: false;
      reason: "not_found" | "version_conflict";
      current_version?: number;
    };

// ── WebSocket protocol types ────────────────────────────────────────

export type WsClientRole = "cli" | "web";
export type SessionLifecycle = "owner" | "viewer";

export interface WsConnectionState {
  authorization?: WsAuthorization;
  role?: WsClientRole;
  sessionId?: string;
  sessionLifecycle?: SessionLifecycle;
  /** Exactly one open owner socket per session is active; the rest are standbys. */
  terminalOwnerActive?: boolean;
  // `${sessionId}:${clientId}` of the last terminal fast-lane send on this
  // connection. ACK routing matches on this composite key because the browser
  // sends terminal messages over its global socket.
  terminalAckRouteKey?: string;
  machineId?: string;
  machineServiceKeys?: MachineServiceKey[];
  /** Capability asserted by this live connection, never inherited from DB. */
  runnerCommandProtocol?: 1;
  /** Codex runtime-auth capability asserted by this live host connection. */
  codexRuntimeAuthProtocol?: 1;
  /** Reviewer-isolation capability asserted by this live host connection. */
  reviewerIsolationProtocol?: 1;
  /** Last healthy host advertisement received on this exact socket. */
  hostAdvertisementAt?: number;
  hostDemoted?: boolean;
  /** Live harness-owner capability; never inferred from durable session data. */
  terminalOperationProtocol?: 1;
  /** Controller identity is stored only on the exact capable harness owner. */
  terminalControllerConnectionId?: string;
  terminalControllerClientId?: string;
}

export type TerminalControlAction = "resize" | "abort";

export interface TerminalInputMessage {
  type: "terminal-input";
  sessionId: string;
  clientId: string;
  inputSeq: number;
  data: string;
  /** Stable semantic delivery key for idempotent system-generated input. */
  deliveryId?: string;
  cols?: number;
  rows?: number;
  /** Internal Hub-to-harness authorization bit. Clients cannot grant it. */
  applyDimensions?: boolean;
}

export interface TerminalControlMessage {
  type: "terminal-control";
  sessionId: string;
  clientId: string;
  controlSeq: number;
  action: TerminalControlAction;
  cols?: number;
  rows?: number;
  /** True activates control, false stays passive, and omission preserves legacy claiming. */
  claim?: boolean;
}

export interface TerminalInputAckMessage {
  type: "terminal-input-ack";
  sessionId: string;
  clientId: string;
  inputSeq: number;
  ok: boolean;
  error?: string;
}

export interface TerminalControlAckMessage {
  type: "terminal-control-ack";
  sessionId: string;
  clientId: string;
  controlSeq: number;
  ok: boolean;
  error?: string;
}

export interface EnvReviewSnapshotRequestMessage {
  type: "env-review-snapshot-request";
  sessionId: string;
  opId: string;
  envSlug: string;
  uploadUrl: string;
  uploadToken: string;
  snapshotMode: "github-overlay" | "full";
  maxBytes: number;
  excludePrefixes: string[];
}

// Client → Hub messages
export type WsClientMessage =
  | { type: "ping" }
  | {
      type: "reconnect";
      lastSeq: number;
      sessionId?: string;
      revive?: boolean;
      /** False registers owner capabilities without replaying durable actions. */
      replay?: boolean;
      /** Correlates capability and ordered reconnect-replay acknowledgements. */
      registrationId?: string;
      terminalOperationProtocol?: 1;
    }
  | TerminalInputMessage
  | TerminalControlMessage
  | TerminalInputAckMessage
  | TerminalControlAckMessage
  | {
      type: "message";
      id: string;
      sessionId: string;
      content: unknown;
      localId?: string;
    }
  | { type: "session-alive"; sessionId: string }
  | { type: "terminal-detach"; sessionId: string; clientId: string }
  | { type: "session-end"; sessionId: string }
  | {
      type: "update-metadata";
      sessionId: string;
      metadata: unknown;
      expectedVersion: number;
    }
  | {
      type: "update-agent-state";
      sessionId: string;
      agentState: unknown;
      expectedVersion: number;
    }
  | {
      type: "update-todos";
      sessionId: string;
      todos: unknown;
      expectedVersion: number;
    }
  | { type: "machine-alive"; machineId: string }
  | {
      type: "machine-update-metadata";
      machineId: string;
      metadata: unknown;
      expectedVersion: number;
    }
  | {
      type: "machine-update-runner-state";
      machineId: string;
      runnerState: unknown;
      expectedVersion: number;
    }
  | RunnerControlResponseMessage;

// Hub → Client messages
export type WsServerMessage =
  | { type: "pong" }
  | { type: "capabilities"; terminalFastLane: boolean; terminalMetrics: boolean }
  | { type: "error"; message: string }
  | TerminalInputMessage
  | TerminalControlMessage
  | TerminalInputAckMessage
  | TerminalControlAckMessage
  | EnvReviewSnapshotRequestMessage
  | {
      type: "message-received";
      id: string;
      sessionId: string;
      content: unknown;
      seq: number;
      localId?: string;
    }
  | { type: "session-updated"; session: StoredSession }
  | { type: "session-deleted"; sessionId: string }
  | { type: "machine-updated"; machine: StoredMachine }
  | {
      type: "replay";
      events: WsServerMessage[];
      /** Canonical cursor adopted by a capability-only registration. */
      baselineSeq?: number;
      /** Session and registration echoed by correlated replay acknowledgements. */
      sessionId?: string;
      registrationId?: string;
    }
  | { type: "permission-created"; permission: StoredPermission }
  | { type: "permission-resolved"; permission: StoredPermission }
  | { type: "env-upsert"; env: EnvMeta }
  | { type: "env-remove"; slug: string }
  | { type: "repo-upsert"; repo: RepoMeta }
  | { type: "repo-remove"; repoId: string }
  | { type: "plan-artifact-updated"; repoId: string; planArtifactId: string }
  | { type: "plan-writer-state"; repoId: string; planArtifactId: string }
  | RunnerControlRequestMessage
  | {
      type: "repo-main-changed";
      repoId: string;
      repoUrl: string;
      previousMainCommit: string | null;
      currentMainCommit: string | null;
      sourceEnvSlug?: string | null;
    };
