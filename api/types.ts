import type { Server } from "partyserver";

// ── Env bindings ────────────────────────────────────────────────────

export interface Env {
  ARTIFACT_STORE: DurableObjectNamespace;
  ENV_LIFECYCLE: DurableObjectNamespace;
  HUB: DurableObjectNamespace<Server<Env>>;
  REPO_MERGE_LOCK: DurableObjectNamespace;
  SCM_BOOTSTRAP: DurableObjectNamespace;
  SCM_OPERATION: DurableObjectNamespace;
  THREAD: DurableObjectNamespace;
  TILLER_VOICE: DurableObjectNamespace;
  PLAN_CHAT: DurableObjectNamespace;
  REVIEWER_CHAT: DurableObjectNamespace;
  SANDBOX: DurableObjectNamespace;
  WORKSPACE: DurableObjectNamespace;
  AI: Ai;
  LOADER: WorkerLoader;
  ASSETS: Fetcher;
  BUCKET: R2Bucket;
  ENVS_KV: KVNamespace;
  CF_ACCESS_AUD: string;
  LOCAL_DEV_ONLY_BACKEND?: string;
  HUB_PUBLIC_URL?: string;
  WORKER_SERVICE_NAME?: string;
  WORKERS_DEV_ALIAS_DISABLED?: string;
  TILLER_DEPLOYMENT_MODE?: string;
  CF_ACCESS_CONFIGURED?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_JWKS_URL?: string;
  CF_ACCESS_APP_DOMAIN?: string;
  CF_ACCESS_APP_TYPE?: string;
  CF_ACCESS_OVERLAPPING_WILDCARD_APP_DOMAIN?: string;
  CF_ACCESS_BROWSER_POLICY_ID?: string;
  CF_ACCESS_SERVICE_TOKEN_ID?: string;
  CF_ACCESS_SERVICE_TOKEN_POLICY_ID?: string;
  TILLER_GATEWAY_HOSTNAME?: string;
  CF_ACCESS_GATEWAY_APP_ID?: string;
  CF_ACCESS_GATEWAY_APP_DOMAIN?: string;
  CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID?: string;
  TILLER_GATEWAY_TUNNEL_ID?: string;
  TILLER_GATEWAY_TUNNEL_NAME?: string;
  TILLER_GATEWAY_TUNNEL_TARGET_PORT?: string;
  ANTHROPIC_API_KEY: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  PLAN_CHAT_DEBUG?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  TILLER_WORKERS_AI_ACCOUNT_ID?: string;
  TILLER_WORKERS_AI_API_TOKEN?: string;
  TILLER_OPENCODE_PROXY_TOKEN?: string;
  ENABLED_ENV_HARNESSES?: string;
  CF_ACCESS_CLIENT_ID: string;
  CF_ACCESS_CLIENT_SECRET: string;
  CF_ACCESS_APP_ID?: string;
  DO_LOCATION_HINT?: string; // Optional HubDO locationHint, usually derived at deploy time or set manually.
}

export type ClaudeAuthMode = "auto" | "subscription" | "api";
export type ResolvedClaudeAuthMode = "subscription" | "api";
export type CodexAuthMode = "subscription" | "api-key";
export type CodexAuthPreference = "auto" | "subscription" | "api-key";
export type CodexGatewayAuth = "session-token";
export type ModelRoute = "host-gateway" | "gateway-subscription" | "api-fallback";
export type ChatGPTAuthStatus = "missing" | "connected" | "refreshing" | "needs_reconnect";
export type CodexRouteStatus = "available" | "gateway_offline" | "host_offline" | "api_fallback" | "unavailable";
export const ENV_HARNESSES = ["claude-code", "codex", "opencode"] as const;
export type EnvHarness = (typeof ENV_HARNESSES)[number];
export const ENV_BRANCH_STATUSES = ["up-to-date", "behind-main", "ready-to-merge", "needs-attention"] as const;
export type EnvBranchStatus = "up-to-date" | "behind-main" | "ready-to-merge" | "needs-attention";
export const REPO_GIT_STATUSES = ["pending", "ready", "repair-required"] as const;
export type RepoGitStatus = "pending" | "ready" | "repair-required";
export const SCM_OPERATION_TYPES = ["merge-into-main", "update-from-main"] as const;
export type ScmOperationType = "merge-into-main" | "update-from-main";
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

export function isScmOperationType(value: string | null | undefined): value is ScmOperationType {
  return typeof value === "string" && (SCM_OPERATION_TYPES as readonly string[]).includes(value);
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
  repoId: string;
  backend: "cf" | "host";
  harness: EnvHarness;
  authMode?: ClaudeAuthMode;
  resolvedAuthMode?: ResolvedClaudeAuthMode;
  codexAuthPreference?: CodexAuthPreference;
  codexAuthMode?: CodexAuthMode;
  opencodeProvider?: "cloudflare-workers-ai";
  opencodeModel?: "@cf/moonshotai/kimi-k2.5";
  modelRoute?: ModelRoute;
  startupPlanId: string | null;
  branchName: string | null;
  createdAt: string;
}

export interface EnvMutableState {
  status: EnvStatus;
  lifecyclePhase: EnvLifecyclePhase | null;
  lifecycleOpId: string | null;
  lifecycleOperation: EnvLifecycleOperation | null;
  lifecycleDesiredState: EnvLifecycleDesiredState | null;
  lifecycleLastRunnerState: string | null;
  lifecycleLastWorkspaceSyncedAckOpId: string | null;
  lifecycleInfraState: EnvInfraState;
  lifecycleRuntimeReady: boolean;
  lifecycleUpdatedAt: string | null;
  runnerId: string | null;
  runnerMachineId: string | null;
  bootMessage: string | null;
  bootStepId?: StartupDiagnosticStepId | null;
  authWarning: string | null;
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
  leadHarnessStatus: LeadHarnessStatus | null;
  leadHarnessError: string | null;
  leadHarnessUpdatedAt: string | null;
  error: string | null;
  errorAt: string | null;
  updatedAt: string;
}

// Valid phase/activity values for agent state (Scion pattern)
export const VALID_PHASES = ["starting", "running", "stopped"] as const;
export const VALID_ACTIVITIES = ["idle", "thinking", "executing", "completed"] as const;
export type AgentPhase = (typeof VALID_PHASES)[number];
export type AgentActivity = (typeof VALID_ACTIVITIES)[number];
export type MachineServiceKey = "host";
export type RunnerControlAction = "create" | "status" | "start" | "stop" | "destroy";

// ── Hono context variables ──────────────────────────────────────────

export type HonoEnv = {
  Bindings: Env;
  Variables: {};
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
  seq: number;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
}

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
  connectedAt: string;
  dockerAvailable: boolean;
  codexSubscription: boolean;
  codexGatewayAuth?: CodexGatewayAuth;
  claudeSubscription: boolean;
  gatewayPort?: number;
  gatewayUrl?: string;
  gatewayServiceTokenHash?: string;
  gatewayTunnelType?: "quick" | "named";
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
  repoUrl: string;
  repoId: string;
  backend: "cf" | "host";
  runnerId?: string;
  runnerMachineId?: string;
  harness: EnvHarness;
  authMode?: ClaudeAuthMode;
  resolvedAuthMode?: ResolvedClaudeAuthMode;
  codexAuthPreference?: CodexAuthPreference;
  codexAuthMode?: CodexAuthMode;
  opencodeProvider?: "cloudflare-workers-ai";
  opencodeModel?: "@cf/moonshotai/kimi-k2.5";
  modelRoute?: ModelRoute;
  authWarning?: string;
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
  lifecyclePhase?: EnvLifecyclePhase | null;
  lifecycleOpId?: string | null;
  lifecycleOperation?: EnvLifecycleOperation | null;
  lifecycleDesiredState?: EnvLifecycleDesiredState | null;
  lifecycleInfraState?: EnvInfraState | null;
  lifecycleRuntimeReady?: boolean;
  lifecycleUpdatedAt?: string | null;
  leadHarnessStatus?: LeadHarnessStatus | null;
  leadHarnessError?: string | null;
  leadHarnessUpdatedAt?: string | null;
  error?: string;
  errorAt?: string;
}

export type StoredEnvMeta = Omit<EnvMeta, "repoUrl">;

export interface RepoMeta {
  repoId: string;
  repoUrl: string;
  githubInstallationId: number;
  githubFullName: string;
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
}

export function hasExplicitEnvDefinitionScmFields(
  value: unknown,
): value is Pick<EnvDefinition, "startupPlanId" | "branchName"> {
  return (
    isRecord(value) &&
    isNullableString(value.startupPlanId) &&
    isNullableString(value.branchName)
  );
}

export function hasExplicitEnvScmFields(
  value: unknown,
): value is Pick<
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
    isNullableString(value.startupPlanId) &&
    isNullableString(value.branchName) &&
    (value.branchStatus === null || isEnvBranchStatus(typeof value.branchStatus === "string" ? value.branchStatus : null)) &&
    isNullableBoolean(value.workspaceDirty) &&
    isNullableBoolean(value.workspaceNeedsAttention) &&
    isNullableString(value.workspaceLastSyncedAt) &&
    isNullableString(value.baseMainCommit) &&
    isNullableString(value.lastKnownMainCommit) &&
    (value.scmOperationType === null || isScmOperationType(typeof value.scmOperationType === "string" ? value.scmOperationType : null)) &&
    isNullableString(value.scmOperationId) &&
    isNullableString(value.scmOperationPhase) &&
    isNullableString(value.scmOperationStartedAt) &&
    isNullableString(value.scmOperationUpdatedAt) &&
    isNullableString(value.scmLastCompletedAt) &&
    isNullableFiniteNumber(value.scmLastDurationMs) &&
    isNullableString(value.scmLastTimings)
  );
}

export function hasExplicitRepoScmFields(
  value: unknown,
): value is Pick<
  RepoMeta,
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

export interface WsConnectionState {
  role?: WsClientRole;
  sessionId?: string;
  machineId?: string;
  machineServiceKeys?: MachineServiceKey[];
}

// Client → Hub messages
export type WsClientMessage =
  | { type: "ping" }
  | { type: "reconnect"; lastSeq: number; sessionId?: string }
  | {
      type: "message";
      id: string;
      sessionId: string;
      content: unknown;
      localId?: string;
    }
  | { type: "session-alive"; sessionId: string }
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
  | {
      type: "runner-control-response";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    };

// Hub → Client messages
export type WsServerMessage =
  | { type: "pong" }
  | { type: "error"; message: string }
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
  | { type: "replay"; events: WsServerMessage[] }
  | { type: "permission-created"; permission: StoredPermission }
  | { type: "permission-resolved"; permission: StoredPermission }
  | { type: "env-upsert"; env: EnvMeta }
  | { type: "env-remove"; slug: string }
  | { type: "repo-upsert"; repo: RepoMeta }
  | { type: "repo-remove"; repoId: string }
  | {
      type: "runner-control-request";
      requestId: string;
      action: RunnerControlAction;
      slug: string;
      repoUrl?: string;
      envVars?: Record<string, string>;
      startOpId?: string;
      stopOpId?: string;
    }
  | {
      type: "repo-main-changed";
      repoId: string;
      repoUrl: string;
      previousMainCommit: string | null;
      currentMainCommit: string | null;
      sourceEnvSlug?: string | null;
    };
