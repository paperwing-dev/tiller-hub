import {
  hasExplicitEnvScmFields,
  hasExplicitRepoScmFields,
  isEnvHarness,
  isEnvStatus,
  isRepoGitStatus,
} from "../api/types";
import type {
  StoredSession,
  StoredMessage,
  StoredPermission,
  StoredMachine,
  WsServerMessage,
  EnvMeta,
  RepoMeta,
  EnvHarness,
  StartupDiagnosticsState,
} from "../api/types";
import type { HostedAgentMetadata } from "../api/agent-core/types";
import type { Artifact, ArtifactRef, PlanArtifact, PlanStatus, ReviewerRegistryEntry } from "../api/coordination/types";
import type {
  HubUpdateRepoCandidate,
  HubUpdateRepoState,
  TillerUpdateMetadata,
  UpdateApplyResult,
  UpdateCheckResult,
} from "../api/update/types";

const DEFAULT_ENABLED_HARNESSES: EnvHarness[] = ["claude-code", "codex", "opencode"];
const HOSTED_AGENT_IDS = [
  "plan-chat",
  "reviewer-chat",
] as const;
const RUNTIME_KINDS = ["think", "direct-tools", "container"] as const;
const MODEL_PROVIDER_KINDS = ["external-codex", "workers-ai"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeArrayResponse<T>(payload: unknown): T[] {
  return Array.isArray(payload) ? payload as T[] : [];
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStringOr(value: unknown, fallback: string): string {
  return readString(value) ?? fallback;
}

function readNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readBooleanOr(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function readIntegerOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function readPlanStatusOr(value: unknown, fallback: PlanStatus = "draft"): PlanStatus {
  return value === "draft" || value === "todo" || value === "completed" || value === "archived"
    ? value
    : fallback;
}

function readNumberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizeStrictArrayResponse<T>(
  payload: unknown,
  normalize: (value: unknown) => T | null,
  errorMessage: string,
): T[] {
  return normalizeArrayResponse(payload).map((value) => {
    const normalized = normalize(value);
    if (!normalized) {
      throw new Error(errorMessage);
    }
    return normalized;
  });
}

function normalizeStoredSession(payload: unknown): StoredSession | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const tag = readString(payload.tag);
  if (!id || !tag) return null;

  return {
    id,
    tag,
    machine_id: readNullableString(payload.machine_id),
    metadata: readStringOr(payload.metadata, "{}"),
    agent_state: readStringOr(payload.agent_state, "{}"),
    todos: readStringOr(payload.todos, "[]"),
    allowed_tools: readStringOr(payload.allowed_tools, "[]"),
    active: payload.active === 1 ? 1 : 0,
    metadata_version: readIntegerOr(payload.metadata_version, 1),
    agent_state_version: readIntegerOr(payload.agent_state_version, 1),
    todos_version: readIntegerOr(payload.todos_version, 1),
    seq: readIntegerOr(payload.seq, 0),
    ended_at: readNullableString(payload.ended_at),
    created_at: readStringOr(payload.created_at, ""),
    updated_at: readStringOr(payload.updated_at, ""),
  };
}

function normalizeStoredMessage(payload: unknown): StoredMessage | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const sessionId = readString(payload.session_id);
  if (!id || !sessionId) return null;

  const content = typeof payload.content === "string"
    ? payload.content
    : JSON.stringify(payload.content ?? null);

  return {
    id,
    session_id: sessionId,
    content,
    seq: readIntegerOr(payload.seq, 0),
    local_id: readNullableString(payload.local_id),
    created_at: readStringOr(payload.created_at, ""),
  };
}

function normalizeStoredPermission(payload: unknown): StoredPermission | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const sessionId = readString(payload.session_id);
  const toolName = readString(payload.tool_name);
  if (!id || !sessionId || !toolName) return null;

  const status = payload.status === "allowed" || payload.status === "denied"
    ? payload.status
    : "pending";

  return {
    id,
    session_id: sessionId,
    tool_name: toolName,
    tool_input: readStringOr(payload.tool_input, "{}"),
    status,
    decision_reason: readNullableString(payload.decision_reason),
    created_at: readStringOr(payload.created_at, ""),
    resolved_at: readNullableString(payload.resolved_at),
  };
}

function normalizeStoredMachine(payload: unknown): StoredMachine | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  if (!id) return null;

  return {
    id,
    metadata: readStringOr(payload.metadata, "{}"),
    runner_state: readStringOr(payload.runner_state, "{}"),
    active: payload.active === 1 ? 1 : 0,
    metadata_version: readIntegerOr(payload.metadata_version, 1),
    runner_state_version: readIntegerOr(payload.runner_state_version, 1),
    seq: readIntegerOr(payload.seq, 0),
    created_at: readStringOr(payload.created_at, ""),
    updated_at: readStringOr(payload.updated_at, ""),
  };
}

function normalizeEnvMetaObject(payload: unknown): EnvMeta | null {
  if (!isRecord(payload)) return null;
  const slug = readString(payload.slug);
  const repoUrl = readString(payload.repoUrl);
  const repoId = readString(payload.repoId);
  const backend = payload.backend === "cf" || payload.backend === "host" ? payload.backend : null;
  const harness = readString(payload.harness);
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  const status = readString(payload.status);
  if (!slug || !repoUrl || !repoId || !backend || !harness || !createdAt || !updatedAt || !status) return null;
  if (!isEnvHarness(harness)) return null;
  if (!isEnvStatus(status)) return null;
  if (!hasExplicitEnvScmFields(payload)) return null;

  return {
    ...(payload as Partial<EnvMeta>),
    slug,
    repoUrl,
    repoId,
    backend,
    harness,
    createdAt,
    updatedAt,
    status,
    startupPlanId: payload.startupPlanId,
    branchName: payload.branchName,
    branchStatus: payload.branchStatus,
    workspaceDirty: payload.workspaceDirty,
    workspaceNeedsAttention: payload.workspaceNeedsAttention,
    workspaceLastSyncedAt: payload.workspaceLastSyncedAt,
    baseMainCommit: payload.baseMainCommit,
    lastKnownMainCommit: payload.lastKnownMainCommit,
    scmOperationType: payload.scmOperationType,
    scmOperationId: payload.scmOperationId,
    scmOperationPhase: payload.scmOperationPhase,
    scmOperationStartedAt: payload.scmOperationStartedAt,
    scmOperationUpdatedAt: payload.scmOperationUpdatedAt,
    scmLastCompletedAt: payload.scmLastCompletedAt,
    scmLastDurationMs: payload.scmLastDurationMs,
    scmLastTimings: payload.scmLastTimings,
  } as EnvMeta;
}

function normalizeRepoMetaObject(payload: unknown): RepoMeta | null {
  if (!isRecord(payload)) return null;
  const repoId = readString(payload.repoId);
  const repoUrl = readString(payload.repoUrl);
  const githubInstallationId = typeof payload.githubInstallationId === "number" && Number.isInteger(payload.githubInstallationId) && payload.githubInstallationId > 0
    ? payload.githubInstallationId
    : null;
  const githubFullName = readString(payload.githubFullName);
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  const gitStatus = readString(payload.gitStatus);
  if (!repoId || !repoUrl || !githubInstallationId || !githubFullName || !createdAt || !updatedAt || !gitStatus) return null;
  if (!isRepoGitStatus(gitStatus)) return null;
  if (!hasExplicitRepoScmFields(payload)) return null;

  return {
    ...(payload as Partial<RepoMeta>),
    repoId,
    repoUrl,
    githubInstallationId,
    githubFullName,
    mainCommit: payload.mainCommit,
    gitArtifactId: payload.gitArtifactId,
    gitStatus,
    gitError: payload.gitError,
    gitFormatVersion: payload.gitFormatVersion,
    gitProgressPhase: payload.gitProgressPhase,
    gitProgressStartedAt: payload.gitProgressStartedAt,
    gitProgressUpdatedAt: payload.gitProgressUpdatedAt,
    gitLastBootstrapDurationMs: payload.gitLastBootstrapDurationMs,
    gitLastBootstrapTimings: payload.gitLastBootstrapTimings,
    createdAt,
    updatedAt,
    bootstrappedFromRef: readNullableString(payload.bootstrappedFromRef),
  } as RepoMeta;
}

function normalizeArtifact(payload: unknown): Artifact | null {
  if (!isRecord(payload) || !isRecord(payload.basis)) return null;
  const id = readString(payload.id);
  const repoId = readString(payload.repoId);
  const type = readString(payload.type);
  const title = readString(payload.title);
  const createdAt = readString(payload.createdAt);
  if (!id || !repoId || !type || title === null || !createdAt) return null;

  return {
    ...(payload as Partial<Artifact>),
    id,
    repoId,
    type: type as Artifact["type"],
    title,
    createdAt,
    status: readPlanStatusOr(payload.status),
    updatedAt: readStringOr(payload.updatedAt, createdAt),
    version: readIntegerOr(payload.version, 1),
    basis: {
      repoId: readStringOr(payload.basis.repoId, repoId),
      mainCommit: readNullableString(payload.basis.mainCommit),
      ...(readNullableString(payload.basis.envSlug)
        ? { envSlug: readNullableString(payload.basis.envSlug) }
        : {}),
    },
  } as Artifact;
}

function normalizeReviewerRegistryEntry(payload: unknown): ReviewerRegistryEntry | null {
  if (!isRecord(payload)) return null;
  const threadId = readString(payload.threadId);
  const planArtifactId = readString(payload.planArtifactId);
  const repoId = readString(payload.repoId);
  const reviewerModel = readString(payload.reviewerModel);
  const createdAt = readString(payload.createdAt);
  const updatedAt = readString(payload.updatedAt);
  if (!threadId || !planArtifactId || !repoId || !reviewerModel || !createdAt || !updatedAt) return null;
  return {
    threadId,
    planArtifactId,
    repoId,
    reviewerModel,
    ...(readNullableString(payload.removedAt) ? { removedAt: readNullableString(payload.removedAt) ?? undefined } : {}),
    createdAt,
    updatedAt,
  };
}

function normalizeArtifactRef(payload: unknown): ArtifactRef | null {
  if (!isRecord(payload)) return null;
  const repoId = readString(payload.repoId);
  const name = readString(payload.name);
  const artifactId = readString(payload.artifactId);
  if (!repoId || !name || !artifactId) return null;

  return {
    repoId,
    name,
    artifactId,
    version: readIntegerOr(payload.version, 1),
    updatedAt: readStringOr(payload.updatedAt, ""),
  };
}

function normalizeStringArray(value: unknown): string[] {
  return normalizeArrayResponse(value).filter((item): item is string => typeof item === "string");
}

function normalizeHostedAgentMetadata(payload: unknown): HostedAgentMetadata | null {
  if (!isRecord(payload)) return null;
  const id = readString(payload.id);
  const name = readString(payload.name);
  const label = readString(payload.label);
  const runtime = readString(payload.runtime);
  const provider = readString(payload.provider);
  const model = readString(payload.model);
  if (!id || !name || !label || !runtime || !provider || !model) return null;
  if (!HOSTED_AGENT_IDS.includes(id as (typeof HOSTED_AGENT_IDS)[number])) return null;
  if (!RUNTIME_KINDS.includes(runtime as (typeof RUNTIME_KINDS)[number])) return null;
  if (!MODEL_PROVIDER_KINDS.includes(provider as (typeof MODEL_PROVIDER_KINDS)[number])) return null;

  return {
    id: id as HostedAgentMetadata["id"],
    name,
    label,
    runtime: runtime as HostedAgentMetadata["runtime"],
    provider: provider as HostedAgentMetadata["provider"],
    model,
  };
}

function normalizeVerifyModelAuthResult(payload: unknown): VerifyModelAuthResult | null {
  if (!isRecord(payload)) return null;
  const key = readString(payload.key);
  const mode = readString(payload.mode);
  if (!key || !mode) return null;

  return {
    key,
    mode,
    ok: payload.ok === true,
    ...(readNullableString(payload.error) ? { error: readNullableString(payload.error) ?? undefined } : {}),
    ...(readNullableString(payload.warning) ? { warning: readNullableString(payload.warning) ?? undefined } : {}),
    ...(readNullableString(payload.note) ? { note: readNullableString(payload.note) ?? undefined } : {}),
  };
}

function normalizeVerifyCloudflareTokenResult(payload: unknown): {
  ok: true;
  hostname: string;
  zoneName: string;
  workerServiceName: string | null;
  gatewayHostname: string | null;
} | null {
  if (!isRecord(payload)) return null;
  const hostname = readString(payload.hostname);
  const zoneName = readString(payload.zoneName);
  if (!hostname || !zoneName) return null;

  return {
    ok: true,
    hostname,
    zoneName,
    workerServiceName: readNullableString(payload.workerServiceName),
    gatewayHostname: readNullableString(payload.gatewayHostname),
  };
}

function normalizeUpdateMetadata(payload: unknown): TillerUpdateMetadata | null {
  if (!isRecord(payload)) return null;
  if (
    payload.schemaVersion !== 1 ||
    payload.channel !== "deploy-button" ||
    payload.updateMode !== "full-source" ||
    payload.sourceRepo !== "paperwing-dev/tiller-hub"
  ) {
    return null;
  }
  const sourceId = readString(payload.sourceId);
  const version = readString(payload.version);
  const label = readString(payload.label);
  const managedFiles = normalizeStringArray(payload.managedFiles);
  if (!sourceId || !version || !label || managedFiles.length === 0) return null;
  return {
    schemaVersion: 1,
    channel: "deploy-button",
    updateMode: "full-source",
    sourceRepo: "paperwing-dev/tiller-hub",
    sourceId,
    version,
    label,
    managedFiles,
  };
}

function normalizeHubUpdateRepoCandidate(payload: unknown): HubUpdateRepoCandidate | null {
  if (!isRecord(payload)) return null;
  const owner = readString(payload.owner);
  const repo = readString(payload.repo);
  const fullName = readString(payload.fullName);
  const label = readString(payload.label);
  const branch = readString(payload.branch);
  const sourceId = readString(payload.sourceId);
  const repoId = readIntegerOr(payload.repoId, 0);
  const installationId = readIntegerOr(payload.installationId, 0);
  if (!owner || !repo || !fullName || !label || !branch || !sourceId || repoId <= 0 || installationId <= 0) return null;
  return {
    owner,
    repo,
    fullName,
    label,
    repoId,
    installationId,
    branch,
    private: readBooleanOr(payload.private, false),
    defaultBranch: readNullableString(payload.defaultBranch),
    sourceId,
  };
}

function normalizeHubUpdateRepoState(payload: unknown): HubUpdateRepoState {
  if (!isRecord(payload)) {
    return { status: "not_checked", lastDetectedAt: null };
  }
  if (payload.status === "detected") {
    const owner = readString(payload.owner);
    const repo = readString(payload.repo);
    const fullName = readString(payload.fullName);
    const label = readString(payload.label);
    const branch = readString(payload.branch);
    const lastDetectedAt = readString(payload.lastDetectedAt);
    const repoId = readIntegerOr(payload.repoId, 0);
    const installationId = readIntegerOr(payload.installationId, 0);
    if (owner && repo && fullName && label && branch && lastDetectedAt && repoId > 0 && installationId > 0) {
      return {
        status: "detected",
        owner,
        repo,
        fullName,
        label,
        repoId,
        installationId,
        branch,
        lastDetectedAt,
        detectedBy: payload.detectedBy === "manual" || payload.detectedBy === "selection" ? payload.detectedBy : "auto",
      };
    }
  }
  if (payload.status === "missing") {
    return {
      status: "missing",
      lastDetectedAt: readNullableString(payload.lastDetectedAt),
      visibleGitHubOwners: normalizeStringArray(payload.visibleGitHubOwners),
    };
  }
  if (payload.status === "ambiguous") {
    return {
      status: "ambiguous",
      lastDetectedAt: readStringOr(payload.lastDetectedAt, ""),
      candidates: normalizeArrayResponse(payload.candidates)
        .map(normalizeHubUpdateRepoCandidate)
        .filter(isPresent),
    };
  }
  return { status: "not_checked", lastDetectedAt: null };
}

function normalizeUpdateCheckResult(payload: unknown): UpdateCheckResult | null {
  if (!isRecord(payload)) return null;
  const currentUpdate = normalizeUpdateMetadata(payload.currentUpdate);
  const latestUpdate = normalizeUpdateMetadata(payload.latestUpdate);
  const releaseNotesUrl = readString(payload.releaseNotesUrl) ?? "https://github.com/paperwing-dev/tiller-hub";
  if (typeof payload.updateAvailable !== "boolean" || !currentUpdate || !latestUpdate || !releaseNotesUrl) {
    return null;
  }

  return {
    updateAvailable: payload.updateAvailable,
    currentUpdate,
    latestUpdate,
    buildDiagnostics: isRecord(payload.buildDiagnostics)
      ? {
          version: readStringOr(payload.buildDiagnostics.version, ""),
          workersCiCommitSha: readNullableString(payload.buildDiagnostics.workersCiCommitSha),
          workersCiBranch: readNullableString(payload.buildDiagnostics.workersCiBranch),
        }
      : {
          version: "",
          workersCiCommitSha: null,
          workersCiBranch: null,
        },
    hubRepo: normalizeHubUpdateRepoState(payload.hubRepo),
    updateMethod: payload.updateMethod === "github_repo" || payload.updateMethod === "connect_hub_repo" || payload.updateMethod === "advanced_repair"
      ? payload.updateMethod
      : "advanced_repair",
    ...(isRecord(payload.issue) && readString(payload.issue.code) && readString(payload.issue.message)
      ? {
          issue: {
            code: readString(payload.issue.code) as NonNullable<UpdateCheckResult["issue"]>["code"],
            message: readString(payload.issue.message) ?? "",
            retryable: readBooleanOr(payload.issue.retryable, false),
          },
        }
      : {}),
    releaseNotesUrl,
  };
}

export class ApiActionError extends Error {
  readonly code?: string;
  readonly hint?: string;
  readonly missingPermissions: string[];

  constructor(body: { error?: string; code?: string; hint?: string; missingPermissions?: string[] }, fallback: string) {
    super(body.error || fallback);
    this.name = "ApiActionError";
    this.code = body.code;
    this.hint = body.hint;
    this.missingPermissions = Array.isArray(body.missingPermissions) ? body.missingPermissions : [];
  }
}

export type {
  HubUpdateRepoCandidate,
  HubUpdateRepoState,
  TillerUpdateMetadata,
  UpdateApplyResult,
  UpdateCheckResult,
} from "../api/update/types";
export type { Artifact, ArtifactRef, PlanArtifact, PlanStatus, ReviewerRegistryEntry } from "../api/coordination/types";

function normalizeRepoArtifactState(
  payload: unknown,
): { artifacts: Artifact[]; refs: ArtifactRef[] } {
  if (!isRecord(payload)) {
    return {
      artifacts: [],
      refs: [],
    };
  }

  return {
    artifacts: normalizeArrayResponse(payload.artifacts)
      .map((artifact) => normalizeArtifact(artifact))
      .filter(isPresent),
    refs: normalizeArrayResponse(payload.refs)
      .map((ref) => normalizeArtifactRef(ref))
      .filter(isPresent),
  };
}

function normalizeEnabledHarnesses(value: unknown): EnvHarness[] {
  const harnesses = normalizeArrayResponse(value)
    .map((item) => (item === "claude-code" || item === "codex" || item === "opencode") ? item : null)
    .filter(isPresent);
  return harnesses.length > 0 ? harnesses : DEFAULT_ENABLED_HARNESSES;
}

function normalizeSetupStatus(payload: unknown, hubUrl: string): SetupStatus {
  const fallbackHostKind = hubUrl.includes(".workers.dev") ? "workers-dev" : "custom-domain";
  if (!isRecord(payload)) {
    return {
      needsSetup: false,
      setupPhase: "complete",
      isLocalDev: false,
      currentOrigin: hubUrl,
      hubUrl,
      deploymentMode: "hosted",
      selfHostStatus: "not-enabled",
      selfHostSetupAttemptId: null,
      workersDevHubUrl: fallbackHostKind === "workers-dev" ? hubUrl : null,
      routeKind: fallbackHostKind,
      workerServiceName: null,
      modelAuthConfigured: false,
      modelAuthMode: null,
      hostedInfrastructureReady: false,
      hostedBlockingReasons: ["Status response was unavailable."],
      hostedModelReady: false,
      hostedModelBlockingReasons: ["Status response was unavailable."],
      selfHostReady: false,
      selfHostBlockingReasons: ["Status response was unavailable."],
      workersAiConfigured: false,
      hasClaudeSubscription: false,
      hasAnthropicKey: false,
      hasChatGPTAuth: false,
      chatgptAuthStatus: "missing",
      hasOpenAIKey: false,
      codexRouteStatus: "unavailable",
      openaiPlannerConfigured: false,
      openaiPlannerAvailable: false,
      openaiPlannerRoute: null,
      openaiPlannerReason: null,
      hostRegistered: false,
      hostRegisteredMode: "none",
      hostGatewayAvailable: false,
      hostGatewayConfigured: false,
      hostGatewayMode: "none",
      enabledHarnesses: DEFAULT_ENABLED_HARNESSES,
      protectionMode: "public",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      gatewayHostname: null,
      browserProtected: false,
      gatewayProvisioned: false,
      gatewayTunnelConfigured: false,
      gatewaySupportAvailable: false,
      gatewaySupportReason: null,
      workersDevCutoverPending: false,
      unsupportedProtectionConfig: false,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
      accessConfigured: false,
      accessIssuer: null,
      accessJwksUrl: null,
      hostConnected: false,
      hostConnectionMode: "none",
      idleTimeoutMinutes: 10,
      canonicalMainBootstrapDepth: 0,
      githubAppAvailable: false,
      githubAppConfigured: false,
      githubAppReady: false,
      githubAppSlug: null,
      githubAppInstallUrl: null,
      githubAppManageUrl: "https://github.com/settings/installations",
      githubAppPublicHubDisabled: true,
      selfUpdateRepo: { status: "not_checked", lastDetectedAt: null },
    };
  }

  const legacyRouteKind = payload.hostKind === "workers-dev" || payload.hostKind === "custom-domain"
    ? payload.hostKind
    : fallbackHostKind;
  const routeKind = payload.routeKind === "workers-dev" || payload.routeKind === "custom-domain"
    ? payload.routeKind
    : legacyRouteKind;
  const deploymentMode = payload.deploymentMode === "self-host" ? "self-host" : "hosted";
  const selfHostStatus = payload.selfHostStatus === "setup-in-progress"
    || payload.selfHostStatus === "enabled"
    || payload.selfHostStatus === "offline"
    || payload.selfHostStatus === "ready"
    || payload.selfHostStatus === "not-enabled"
    ? payload.selfHostStatus
    : deploymentMode === "self-host"
      ? readBooleanOr(payload.selfHostReady)
        ? "ready"
        : "offline"
      : "not-enabled";
  const modelAuthMode = payload.modelAuthMode === "subscription"
    || payload.modelAuthMode === "api"
    || payload.modelAuthMode === "api-key"
    ? payload.modelAuthMode
    : null;
  const hostGatewayMode = payload.hostGatewayMode === "quick"
    || payload.hostGatewayMode === "named"
    || payload.hostGatewayMode === "none"
    ? payload.hostGatewayMode
    : "none";
  const hostRegisteredMode = payload.hostRegisteredMode === "session" ? "session" : "none";
  const protectionMode = payload.protectionMode === "cf-access" ? "cf-access" : "public";
  const hostConnectionMode = payload.hostConnectionMode === "session" ? "session" : "none";
  const setupPhase = payload.setupPhase === "protect-hub"
    || payload.setupPhase === "github-app"
    || payload.setupPhase === "model-access"
    || payload.setupPhase === "complete"
    ? payload.setupPhase
    : readBooleanOr(payload.needsSetup)
      ? "model-access"
      : "complete";

  return {
    needsSetup: setupPhase !== "complete",
    setupPhase,
    isLocalDev: readBooleanOr(payload.isLocalDev),
    currentOrigin: readStringOr(payload.currentOrigin, hubUrl),
    hubUrl: readStringOr(payload.hubUrl, hubUrl),
    deploymentMode,
    selfHostStatus,
    selfHostSetupAttemptId: readNullableString(payload.selfHostSetupAttemptId),
    workersDevHubUrl: readNullableString(payload.workersDevHubUrl),
    routeKind,
    workerServiceName: readNullableString(payload.workerServiceName),
    modelAuthConfigured: readBooleanOr(payload.modelAuthConfigured),
    modelAuthMode,
    hostedInfrastructureReady: readBooleanOr(payload.hostedInfrastructureReady),
    hostedBlockingReasons: normalizeArrayResponse(payload.hostedBlockingReasons)
      .map(readString)
      .filter(isPresent),
    hostedModelReady: readBooleanOr(payload.hostedModelReady),
    hostedModelBlockingReasons: normalizeArrayResponse(payload.hostedModelBlockingReasons)
      .map(readString)
      .filter(isPresent),
    selfHostReady: readBooleanOr(payload.selfHostReady),
    selfHostBlockingReasons: normalizeArrayResponse(payload.selfHostBlockingReasons)
      .map(readString)
      .filter(isPresent),
    workersAiConfigured: readBooleanOr(payload.workersAiConfigured),
    hasClaudeSubscription: readBooleanOr(payload.hasClaudeSubscription),
    hasAnthropicKey: readBooleanOr(payload.hasAnthropicKey),
    hasChatGPTAuth: readBooleanOr(payload.hasChatGPTAuth),
    chatgptAuthStatus: payload.chatgptAuthStatus === "connected"
      || payload.chatgptAuthStatus === "refreshing"
      || payload.chatgptAuthStatus === "needs_reconnect"
      || payload.chatgptAuthStatus === "missing"
      ? payload.chatgptAuthStatus
      : readBooleanOr(payload.hasChatGPTAuth)
        ? "connected"
        : "missing",
    hasOpenAIKey: readBooleanOr(payload.hasOpenAIKey),
    codexRouteStatus: payload.codexRouteStatus === "available"
      || payload.codexRouteStatus === "gateway_offline"
      || payload.codexRouteStatus === "host_offline"
      || payload.codexRouteStatus === "api_fallback"
      || payload.codexRouteStatus === "unavailable"
      ? payload.codexRouteStatus
      : "unavailable",
    openaiPlannerConfigured: readBooleanOr(payload.openaiPlannerConfigured),
    openaiPlannerAvailable: readBooleanOr(payload.openaiPlannerAvailable),
    openaiPlannerRoute: payload.openaiPlannerRoute === "api-key" || payload.openaiPlannerRoute === "subscription-gateway"
      ? payload.openaiPlannerRoute
      : null,
    openaiPlannerReason: readNullableString(payload.openaiPlannerReason),
    hostRegistered: readBooleanOr(payload.hostRegistered),
    hostRegisteredMode,
    hostGatewayAvailable: readBooleanOr(payload.hostGatewayAvailable),
    hostGatewayConfigured: readBooleanOr(payload.hostGatewayConfigured),
    hostGatewayMode,
    enabledHarnesses: normalizeEnabledHarnesses(payload.enabledHarnesses),
    protectionMode,
    protectionCanAutomate: readBooleanOr(payload.protectionCanAutomate),
    serviceTokenConfigured: readBooleanOr(payload.serviceTokenConfigured),
    gatewayHostname: readNullableString(payload.gatewayHostname),
    browserProtected: readBooleanOr(payload.browserProtected),
    gatewayProvisioned: readBooleanOr(payload.gatewayProvisioned),
    gatewayTunnelConfigured: readBooleanOr(payload.gatewayTunnelConfigured),
    gatewaySupportAvailable: readBooleanOr(payload.gatewaySupportAvailable),
    gatewaySupportReason: readNullableString(payload.gatewaySupportReason),
    workersDevCutoverPending: readBooleanOr(payload.workersDevCutoverPending),
    unsupportedProtectionConfig: readBooleanOr(payload.unsupportedProtectionConfig),
    workersDevAliasDisabled: readBooleanOr(payload.workersDevAliasDisabled),
    protectionAppDomain: readNullableString(payload.protectionAppDomain),
    accessConfigured: readBooleanOr(payload.accessConfigured),
    accessIssuer: readNullableString(payload.accessIssuer),
    accessJwksUrl: readNullableString(payload.accessJwksUrl),
    hostConnected: readBooleanOr(payload.hostConnected),
    hostConnectionMode,
    idleTimeoutMinutes: readNumberOr(payload.idleTimeoutMinutes, 10),
    canonicalMainBootstrapDepth: readNumberOr(payload.canonicalMainBootstrapDepth, 0),
    githubAppAvailable: readBooleanOr(payload.githubAppAvailable),
    githubAppConfigured: readBooleanOr(payload.githubAppConfigured),
    githubAppReady: readBooleanOr(payload.githubAppReady),
    githubAppSlug: readNullableString(payload.githubAppSlug),
    githubAppInstallUrl: readNullableString(payload.githubAppInstallUrl),
    githubAppManageUrl: readStringOr(payload.githubAppManageUrl, "https://github.com/settings/installations"),
    githubAppPublicHubDisabled: readBooleanOr(payload.githubAppPublicHubDisabled),
    selfUpdateRepo: normalizeHubUpdateRepoState(payload.selfUpdateRepo),
  };
}

function normalizeWsServerMessage(payload: unknown): WsServerMessage | null {
  if (!isRecord(payload) || typeof payload.type !== "string") return null;

  switch (payload.type) {
    case "pong":
      return { type: "pong" };
    case "error": {
      const message = readString(payload.message);
      return message ? { type: "error", message } : null;
    }
    case "message-received": {
      const id = readString(payload.id);
      const sessionId = readString(payload.sessionId);
      if (!id || !sessionId) return null;
      return {
        type: "message-received",
        id,
        sessionId,
        content: payload.content,
        seq: readIntegerOr(payload.seq, 0),
        ...(readNullableString(payload.localId) ? { localId: readNullableString(payload.localId) ?? undefined } : {}),
      };
    }
    case "session-updated": {
      const session = normalizeStoredSession(payload.session);
      return session ? { type: "session-updated", session } : null;
    }
    case "session-deleted": {
      const sessionId = readString(payload.sessionId);
      return sessionId ? { type: "session-deleted", sessionId } : null;
    }
    case "machine-updated": {
      const machine = normalizeStoredMachine(payload.machine);
      return machine ? { type: "machine-updated", machine } : null;
    }
    case "replay":
      return {
        type: "replay",
        events: normalizeArrayResponse(payload.events)
          .map((event) => normalizeWsServerMessage(event))
          .filter(isPresent),
      };
    case "permission-created": {
      const permission = normalizeStoredPermission(payload.permission);
      return permission ? { type: "permission-created", permission } : null;
    }
    case "permission-resolved": {
      const permission = normalizeStoredPermission(payload.permission);
      return permission ? { type: "permission-resolved", permission } : null;
    }
    case "env-upsert": {
      const env = normalizeEnvMetaObject(payload.env);
      return env ? { type: "env-upsert", env } : null;
    }
    case "env-remove": {
      const slug = readString(payload.slug);
      return slug ? { type: "env-remove", slug } : null;
    }
    case "repo-upsert": {
      const repo = normalizeRepoMetaObject(payload.repo);
      return repo ? { type: "repo-upsert", repo } : null;
    }
    case "repo-remove": {
      const repoId = readString(payload.repoId);
      return repoId ? { type: "repo-remove", repoId } : null;
    }
    case "repo-main-changed": {
      const repoId = readString(payload.repoId);
      const repoUrl = readString(payload.repoUrl);
      if (!repoId || !repoUrl) return null;
      return {
        type: "repo-main-changed",
        repoId,
        repoUrl,
        previousMainCommit: readNullableString(payload.previousMainCommit),
        currentMainCommit: readNullableString(payload.currentMainCommit),
        ...(readNullableString(payload.sourceEnvSlug) ? { sourceEnvSlug: readNullableString(payload.sourceEnvSlug) } : {}),
      };
    }
    default:
      return null;
  }
}

function buildApiActionError(
  body: { error?: string; code?: string; hint?: string; missingPermissions?: string[] },
  fallback: string,
): ApiActionError {
  return new ApiActionError(body, fallback);
}

async function parseApiError(
  res: Response,
  fallback: string,
): Promise<Error> {
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    const body = await res.json().catch(() => null);
    if (isRecord(body)) {
      return buildApiActionError({
        error: readString(body.error) ?? undefined,
        code: readString(body.code) ?? undefined,
        hint: readString(body.hint) ?? undefined,
        missingPermissions: Array.isArray(body.missingPermissions)
          ? body.missingPermissions.filter((value): value is string => typeof value === "string")
          : undefined,
      }, fallback);
    }
  }
  const text = (await res.text().catch(() => "")).trim();
  return new Error(text || fallback);
}

// ── REST helpers ──────────────────────────────────────────────────

export async function fetchSessions(hubUrl: string): Promise<StoredSession[]> {
  const res = await fetch(`${hubUrl}/api/sessions`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch sessions: ${res.status}`);
  return normalizeArrayResponse(await res.json().catch(() => null))
    .map((session) => normalizeStoredSession(session))
    .filter(isPresent);
}

export async function fetchMessages(
  hubUrl: string,
  sessionId: string,
  opts: { limit?: number; beforeSeq?: number; afterSeq?: number } = {},
): Promise<StoredMessage[]> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.beforeSeq != null) params.set("before_seq", String(opts.beforeSeq));
  if (opts.afterSeq != null) params.set("after_seq", String(opts.afterSeq));
  const qs = params.toString() ? `?${params}` : "";
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/messages${qs}`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
  return normalizeArrayResponse(await res.json().catch(() => null))
    .map((message) => normalizeStoredMessage(message))
    .filter(isPresent);
}

export async function fetchPendingPermissions(hubUrl: string, sessionId: string): Promise<StoredPermission[]> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch permissions: ${res.status}`);
  return normalizeArrayResponse(await res.json().catch(() => null))
    .map((permission) => normalizeStoredPermission(permission))
    .filter(isPresent);
}

export async function resolvePermission(
  hubUrl: string,
  sessionId: string,
  permId: string,
  status: string,
  allowForSession = false,
): Promise<StoredPermission> {
  const res = await fetch(`${hubUrl}/api/sessions/${sessionId}/permissions/${permId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status, allow_for_session: allowForSession }),
  });
  if (!res.ok) throw new Error(`Failed to resolve permission: ${res.status}`);
  const permission = normalizeStoredPermission(await res.json().catch(() => null));
  if (!permission) {
    throw new Error("Malformed permission response");
  }
  return permission;
}

// ── Environment (sandbox) helpers ─────────────────────────────────

export type { CodexAuthPreference, EnvHarness, EnvMeta, RepoMeta, StartupDiagnosticsState } from "../api/types";

export type StartupPlanSelection =
  | { mode: "todo" }
  | { mode: "specific"; artifactId: string }
  | { mode: "none" };

export async function fetchEnvs(hubUrl: string): Promise<EnvMeta[]> {
  const res = await fetch(`${hubUrl}/api/envs`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch envs: ${res.status}`);
  return normalizeStrictArrayResponse(
    await res.json().catch(() => null),
    normalizeEnvMetaObject,
    "Malformed env response",
  );
}

export async function fetchEnv(hubUrl: string, slug: string): Promise<EnvMeta> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, { credentials: "include" });
  if (!res.ok) throw new Error(`Failed to fetch env: ${res.status}`);
  const env = normalizeEnvMetaObject(await res.json().catch(() => null));
  if (!env) {
    throw new Error("Malformed env response");
  }
  return env;
}

export async function fetchEnvStartupDiagnostics(
  hubUrl: string,
  slug: string,
): Promise<StartupDiagnosticsState> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/startup-diagnostics`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch startup diagnostics: ${res.status}`);
  const body = await res.json().catch(() => null);
  if (!isRecord(body)) {
    return { active: null, lastFailed: null };
  }
  return {
    active: isRecord(body.active) ? body.active as StartupDiagnosticsState["active"] : null,
    lastFailed: isRecord(body.lastFailed) ? body.lastFailed as StartupDiagnosticsState["lastFailed"] : null,
  };
}

export async function createEnv(
  hubUrl: string,
  repoId: string,
  backend: "cf" | "host",
  harness: EnvHarness,
  authMode?: "auto" | "subscription" | "api",
  codexAuthPreference?: "auto" | "subscription" | "api-key",
  planSelection?: StartupPlanSelection,
): Promise<EnvMeta> {
  const res = await fetch(`${hubUrl}/api/envs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ repoId, backend, harness, authMode, codexAuthPreference, planSelection }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to create env: ${res.status}`);
  }
  const env = normalizeEnvMetaObject(await res.json().catch(() => null));
  if (!env) {
    throw new Error("Malformed env response");
  }
  return env;
}

export async function startEnv(
  hubUrl: string,
  slug: string,
  options?: { planSelection?: StartupPlanSelection },
): Promise<{ ok: boolean; slug: string; status: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(options ?? {}),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to start env: ${res.status}`);
  const body = await res.json().catch(() => null);
  return {
    ok: isRecord(body) ? readBooleanOr(body.ok, true) : true,
    slug: isRecord(body) ? readStringOr(body.slug, slug) : slug,
    status: isRecord(body) ? readStringOr(body.status, "starting") : "starting",
  };
}

export async function stopEnv(hubUrl: string, slug: string): Promise<{ ok: boolean; slug: string; status: string }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/stop`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to stop env: ${res.status}`);
  const body = await res.json().catch(() => null);
  return {
    ok: isRecord(body) ? readBooleanOr(body.ok, true) : true,
    slug: isRecord(body) ? readStringOr(body.slug, slug) : slug,
    status: isRecord(body) ? readStringOr(body.status, "saving") : "saving",
  };
}

export async function syncEnv(hubUrl: string, slug: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/sync`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to sync env: ${res.status}`);
}

export async function mergeEnvIntoMain(
  hubUrl: string,
  slug: string,
): Promise<{
  ok: boolean;
  slug: string;
  repoId: string;
  operationId?: string;
  pending?: boolean;
  action?: "already-current" | "merged" | "conflicted";
  conflictCount?: number;
  previousMainCommit?: string | null;
  currentMainCommit?: string | null;
}> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/merge-into-main`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Promote to Main failed: ${res.status}`);
  return res.json();
}

export type EnvChangeStatus = "added" | "modified" | "deleted";

export interface EnvChangeEntry {
  path: string;
  status: EnvChangeStatus;
  oldSize: number | null;
  newSize: number | null;
  oldHash: string | null;
  newHash: string | null;
  previewableHint?: "unknown" | "text" | "binary" | "too-large";
}

export interface EnvChangesResponse {
  slug: string;
  repoId: string;
  repoUrl: string;
  comparisonBasis: "promote-preview";
  oldCommit: string | null;
  newBaseCommit: string | null;
  branchStatus: "ready-to-merge" | "up-to-date";
  summary: {
    total: number;
    added: number;
    modified: number;
    deleted: number;
  };
  files: EnvChangeEntry[];
}

export interface EnvChangeFileResponse {
  path: string;
  status: EnvChangeStatus;
  previewable: boolean;
  reason?: "binary" | "too-large" | "not-found";
  maxPreviewBytes: number;
  oldString: string;
  newString: string;
  oldSize: number | null;
  newSize: number | null;
}

export async function fetchEnvChanges(hubUrl: string, slug: string): Promise<EnvChangesResponse> {
  const res = await fetch(`${hubUrl}/api/envs/${encodeURIComponent(slug)}/changes`, {
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to load promote preview: ${res.status}`);
  return res.json();
}

export async function fetchEnvChangeFile(
  hubUrl: string,
  slug: string,
  path: string,
): Promise<EnvChangeFileResponse> {
  const url = new URL(`${hubUrl}/api/envs/${encodeURIComponent(slug)}/changes/file`);
  url.searchParams.set("path", path);
  const res = await fetch(url.toString(), {
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to load file diff: ${res.status}`);
  return res.json();
}

export async function updateEnvFromMain(
  hubUrl: string,
  slug: string,
): Promise<{
  ok: boolean;
  slug: string;
  repoId: string;
  operationId?: string;
  pending?: boolean;
  action?: "updated-from-main" | "up-to-date" | "conflicted";
  currentMainCommit?: string | null;
  branchStatus?: "ready-to-merge" | "up-to-date" | "needs-attention";
}> {
  const res = await fetch(`${hubUrl}/api/envs/${encodeURIComponent(slug)}/update-from-main`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Update from Main failed: ${res.status}`);
  return res.json();
}

export async function resetEnvToRepo(
  hubUrl: string,
  slug: string,
): Promise<{ ok: boolean; slug: string; repoId: string; currentMainCommit: string | null }> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}/reset-to-repo`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to reset env to repo: ${res.status}`);
  return res.json();
}

export async function deleteEnv(hubUrl: string, slug: string): Promise<void> {
  const res = await fetch(`${hubUrl}/api/envs/${slug}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to delete env: ${res.status}`);
}

export async function deleteRepo(
  hubUrl: string,
  repoId: string,
): Promise<{ ok: true; repoId: string; deletedEnvSlugs: string[] }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to delete repo: ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  return {
    ok: true,
    repoId: isRecord(body) ? readStringOr(body.repoId, repoId) : repoId,
    deletedEnvSlugs: isRecord(body)
      ? normalizeArrayResponse(body.deletedEnvSlugs).filter((candidate): candidate is string => typeof candidate === "string")
      : [],
  };
}

export async function fetchAgentMetadata(
  hubUrl: string,
): Promise<HostedAgentMetadata[]> {
  const res = await fetch(`${hubUrl}/api/agents`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch agent metadata: ${res.status}`);
  return normalizeArrayResponse(await res.json().catch(() => null))
    .map((agent) => normalizeHostedAgentMetadata(agent))
    .filter(isPresent);
}

export async function fetchRepoArtifacts(
  hubUrl: string,
  repoId: string,
): Promise<{ artifacts: Artifact[]; refs: ArtifactRef[] }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/artifacts`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch artifacts: ${res.status}`);
  return normalizeRepoArtifactState(await res.json().catch(() => null));
}

export async function createPlan(
  hubUrl: string,
  repoId: string,
  title?: string,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to create plan: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed plan response");
  }
  return artifact;
}

export async function updatePlanStatus(
  hubUrl: string,
  repoId: string,
  id: string,
  status: PlanStatus,
  expectedVersion?: number | null,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/artifacts/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ status, expectedVersion }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to update plan status: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed plan status response");
  }
  return artifact;
}

export async function discardPlan(
  hubUrl: string,
  repoId: string,
  id: string,
  expectedVersion?: number | null,
): Promise<Artifact> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${id}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ expectedVersion }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to discard plan: ${res.status}`);
  const body = await res.json().catch(() => null);
  const artifact = isRecord(body) ? normalizeArtifact(body.artifact) : null;
  if (!artifact) {
    throw new Error("Malformed discard plan response");
  }
  return artifact;
}

export async function fetchPlanReviewers(
  hubUrl: string,
  repoId: string,
  artifactId: string,
): Promise<ReviewerRegistryEntry[]> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to fetch reviewers: ${res.status}`);
  const body = await res.json().catch(() => null);
  return isRecord(body)
    ? normalizeArrayResponse(body.reviewers).map(normalizeReviewerRegistryEntry).filter(isPresent)
    : [];
}

export async function addPlanReviewer(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  reviewerModel: string,
): Promise<ReviewerRegistryEntry> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ reviewerModel }),
  });
  if (!res.ok) throw await parseApiError(res, `Failed to add reviewer: ${res.status}`);
  const body = await res.json().catch(() => null);
  const reviewer = isRecord(body) ? normalizeReviewerRegistryEntry(body.reviewer) : null;
  if (!reviewer) {
    throw new Error("Malformed reviewer response");
  }
  return reviewer;
}

export async function removePlanReviewer(
  hubUrl: string,
  repoId: string,
  artifactId: string,
  threadId: string,
): Promise<void> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/plans/${artifactId}/reviewers/${threadId}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to remove reviewer: ${res.status}`);
}

export async function createRepo(
  hubUrl: string,
  selection: GitHubRepositorySelection,
): Promise<RepoMeta> {
  const res = await fetch(`${hubUrl}/api/repos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      repositoryId: selection.repositoryId,
      installationId: selection.installationId,
      fullName: selection.fullName,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to create repo: ${res.status}`);
  }
  const repo = normalizeRepoMetaObject(await res.json().catch(() => null));
  if (!repo) {
    throw new Error("Malformed repo response");
  }
  return repo;
}

export interface GitHubRepositorySelection {
  repositoryId: number;
  installationId: number;
  fullName: string;
  repoUrl: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface GitHubRepositoryWarning {
  installationId?: number;
  code: string;
  message: string;
}

export interface GitHubRepositoriesResponse {
  repositories: GitHubRepositorySelection[];
  warnings: GitHubRepositoryWarning[];
}

function normalizeGitHubRepositorySelection(payload: unknown): GitHubRepositorySelection | null {
  if (!isRecord(payload)) return null;
  const repositoryId = readIntegerOr(payload.repositoryId, 0);
  const installationId = readIntegerOr(payload.installationId, 0);
  const fullName = readString(payload.fullName);
  const repoUrl = readString(payload.repoUrl);
  if (repositoryId <= 0 || installationId <= 0 || !fullName || !repoUrl) return null;
  return {
    repositoryId,
    installationId,
    fullName,
    repoUrl,
    private: readBooleanOr(payload.private, false),
    defaultBranch: readNullableString(payload.defaultBranch),
  };
}

function normalizeGitHubRepositoryWarning(payload: unknown): GitHubRepositoryWarning | null {
  if (!isRecord(payload)) return null;
  const code = readString(payload.code);
  const message = readString(payload.message);
  if (!code || !message) return null;
  return {
    ...(typeof payload.installationId === "number" ? { installationId: payload.installationId } : {}),
    code,
    message,
  };
}

export async function fetchGitHubRepositories(hubUrl: string): Promise<GitHubRepositoriesResponse> {
  const res = await fetch(`${hubUrl}/api/github/repositories`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    if (isRecord(body)) {
      const error = buildApiActionError({
        error: readString(body.error) ?? undefined,
        code: readString(body.code) ?? undefined,
      }, `Failed to fetch GitHub repositories: ${res.status}`);
      throw error;
    }
    throw new Error(`Failed to fetch GitHub repositories: ${res.status}`);
  }
  if (!isRecord(body)) {
    throw new Error("Malformed GitHub repository response");
  }
  return {
    repositories: normalizeArrayResponse<unknown>(body.repositories)
      .map(normalizeGitHubRepositorySelection)
      .filter(isPresent),
    warnings: normalizeArrayResponse<unknown>(body.warnings)
      .map(normalizeGitHubRepositoryWarning)
      .filter(isPresent),
  };
}

export async function fetchRepos(hubUrl: string): Promise<RepoMeta[]> {
  const res = await fetch(`${hubUrl}/api/repos`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch repos: ${res.status}`);
  return normalizeStrictArrayResponse(
    await res.json().catch(() => null),
    normalizeRepoMetaObject,
    "Malformed repo response",
  );
}

export async function fetchRepo(hubUrl: string, repoId: string): Promise<RepoMeta> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to fetch repo: ${res.status}`);
  const repo = normalizeRepoMetaObject(await res.json().catch(() => null));
  if (!repo) {
    throw new Error("Malformed repo response");
  }
  return repo;
}

export async function bootstrapRepoGitArtifact(
  hubUrl: string,
  repoId: string,
): Promise<{ ok: true; repoId: string; gitStatus: string; gitArtifactId?: string | null }> {
  const res = await fetch(`${hubUrl}/api/repos/${repoId}/git-artifact/bootstrap`, {
    method: "POST",
    credentials: "include",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw new Error(body.error || `Failed to bootstrap canonical main: ${res.status}`);
  }
  const body = await res.json().catch(() => null);
  return {
    ok: true,
    repoId: isRecord(body) ? readStringOr(body.repoId, repoId) : repoId,
    gitStatus: isRecord(body) ? readStringOr(body.gitStatus, "pending") : "pending",
    ...(isRecord(body) && ("gitArtifactId" in body)
      ? { gitArtifactId: readNullableString(body.gitArtifactId) }
      : {}),
  };
}

// ── Setup / Settings helpers ─────────────────────────────────────

export interface SetupStatus {
  needsSetup: boolean;
  setupPhase: "protect-hub" | "github-app" | "model-access" | "complete";
  isLocalDev: boolean;
  currentOrigin: string;
  hubUrl: string;
  deploymentMode: "hosted" | "self-host";
  selfHostStatus: "not-enabled" | "setup-in-progress" | "enabled" | "offline" | "ready";
  selfHostSetupAttemptId: string | null;
  workersDevHubUrl: string | null;
  routeKind: "workers-dev" | "custom-domain";
  workerServiceName: string | null;
  modelAuthConfigured: boolean;
  modelAuthMode: "subscription" | "api" | "api-key" | null;
  hostedInfrastructureReady: boolean;
  hostedBlockingReasons: string[];
  hostedModelReady: boolean;
  hostedModelBlockingReasons: string[];
  selfHostReady: boolean;
  selfHostBlockingReasons: string[];
  workersAiConfigured: boolean;
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  chatgptAuthStatus: "missing" | "connected" | "refreshing" | "needs_reconnect";
  hasOpenAIKey: boolean;
  codexRouteStatus: "available" | "gateway_offline" | "host_offline" | "api_fallback" | "unavailable";
  openaiPlannerConfigured: boolean;
  openaiPlannerAvailable: boolean;
  openaiPlannerRoute: "api-key" | "subscription-gateway" | null;
  openaiPlannerReason: string | null;
  hostRegistered: boolean;
  hostRegisteredMode: "none" | "session";
  hostGatewayAvailable: boolean;
  hostGatewayConfigured: boolean;
  hostGatewayMode: "none" | "quick" | "named";
  enabledHarnesses: EnvHarness[];
  protectionMode: "public" | "cf-access";
  protectionCanAutomate: boolean;
  serviceTokenConfigured: boolean;
  gatewayHostname: string | null;
  browserProtected: boolean;
  gatewayProvisioned: boolean;
  gatewayTunnelConfigured: boolean;
  gatewaySupportAvailable: boolean;
  gatewaySupportReason: string | null;
  workersDevCutoverPending: boolean;
  unsupportedProtectionConfig: boolean;
  workersDevAliasDisabled: boolean;
  protectionAppDomain: string | null;
  accessConfigured: boolean;
  accessIssuer: string | null;
  accessJwksUrl: string | null;
  hostConnected: boolean;
  hostConnectionMode: "none" | "session";
  idleTimeoutMinutes: number;
  canonicalMainBootstrapDepth: number;
  githubAppAvailable: boolean;
  githubAppConfigured: boolean;
  githubAppReady: boolean;
  githubAppSlug: string | null;
  githubAppInstallUrl: string | null;
  githubAppManageUrl: string;
  githubAppPublicHubDisabled: boolean;
  selfUpdateRepo: HubUpdateRepoState;
}

export async function fetchSetupStatus(hubUrl: string): Promise<SetupStatus> {
  const res = await fetch(`${hubUrl}/api/setup/status`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch setup status: ${res.status}`);
  return normalizeSetupStatus(await res.json().catch(() => null), hubUrl);
}

export interface SeedOpenAIAuthInput {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
}

export async function seedOpenAIAuth(
  hubUrl: string,
  input: SeedOpenAIAuthInput,
): Promise<{ authenticated: boolean; expires_at?: number; account_id?: string }> {
  const res = await fetch(`${hubUrl}/api/auth/openai/seed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Codex login import failed: ${res.status}`);
  }
  return {
    authenticated: isRecord(body) && body.authenticated === true,
    ...(isRecord(body) && typeof body.expires_at === "number" ? { expires_at: body.expires_at } : {}),
    ...(isRecord(body) && typeof body.account_id === "string" ? { account_id: body.account_id } : {}),
  };
}

export type HostStatusState =
  | "not-registered"
  | "registered-offline"
  | "connected-no-gateway"
  | "gateway-unavailable"
  | "gateway-available";

export interface HostStatusMachine {
  machineId: string;
  connectedAt: string;
  gatewayUrl?: string;
  gatewayTunnelType?: "quick" | "named";
  codexSubscription: boolean;
  claudeSubscription: boolean;
}

export interface HostStatus {
  registered: boolean;
  connected: boolean;
  gatewayConfigured: boolean;
  gatewayAvailable: boolean;
  state: HostStatusState;
  machine: HostStatusMachine | null;
}

function deriveHostStatusState(
  registered: boolean,
  connected: boolean,
  gatewayConfigured: boolean,
  gatewayAvailable: boolean,
): HostStatusState {
  if (!registered) {
    return "not-registered";
  }
  if (!connected) {
    return "registered-offline";
  }
  if (!gatewayConfigured) {
    return "connected-no-gateway";
  }
  if (!gatewayAvailable) {
    return "gateway-unavailable";
  }
  return "gateway-available";
}

function normalizeHostStatus(payload: unknown): HostStatus {
  if (!isRecord(payload)) {
    return {
      registered: false,
      connected: false,
      gatewayConfigured: false,
      gatewayAvailable: false,
      state: "not-registered",
      machine: null,
    };
  }

  const rawMachine = payload.machine;
  let machine: HostStatusMachine | null = null;
  if (isRecord(rawMachine)) {
    const machineId = readString(rawMachine.machineId);
    const connectedAt = readString(rawMachine.connectedAt);
    if (machineId && connectedAt) {
      const tunnelType = rawMachine.gatewayTunnelType === "quick" || rawMachine.gatewayTunnelType === "named"
        ? rawMachine.gatewayTunnelType
        : undefined;
      const gatewayUrl = readNullableString(rawMachine.gatewayUrl) ?? undefined;
      machine = {
        machineId,
        connectedAt,
        ...(gatewayUrl ? { gatewayUrl } : {}),
        ...(tunnelType ? { gatewayTunnelType: tunnelType } : {}),
        codexSubscription: readBooleanOr(rawMachine.codexSubscription),
        claudeSubscription: readBooleanOr(rawMachine.claudeSubscription),
      };
    }
  }

  const registered = readBooleanOr(payload.registered, machine != null);
  const connected = readBooleanOr(payload.connected);
  const gatewayConfigured = readBooleanOr(payload.gatewayConfigured, Boolean(machine?.gatewayUrl));
  const gatewayAvailable = readBooleanOr(payload.gatewayAvailable, connected && gatewayConfigured);
  const state = payload.state === "not-registered"
    || payload.state === "registered-offline"
    || payload.state === "connected-no-gateway"
    || payload.state === "gateway-unavailable"
    || payload.state === "gateway-available"
    ? payload.state
    : deriveHostStatusState(registered, connected, gatewayConfigured, gatewayAvailable);

  return {
    registered,
    connected,
    gatewayConfigured,
    gatewayAvailable,
    state,
    machine,
  };
}

export async function fetchHostStatus(hubUrl: string): Promise<HostStatus> {
  const res = await fetch(`${hubUrl}/api/host/status`, {
    credentials: "include",
  });
  if (!res.ok) throw new Error(`Failed to fetch host status: ${res.status}`);
  return normalizeHostStatus(await res.json().catch(() => null));
}

export interface VerifyModelAuthResult {
  key: string;
  mode: string;
  ok: boolean;
  error?: string;
  warning?: string;
  note?: string;
}

export async function verifyModelAuth(
  hubUrl: string,
): Promise<{ ok: boolean; error?: string; results: VerifyModelAuthResult[] }> {
  const res = await fetch(`${hubUrl}/api/setup/verify-model-auth`, {
    method: "POST",
    credentials: "include",
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Credential verification failed: ${res.status}`);
  }
  return {
    ok: isRecord(body) && body.ok === true,
    ...(isRecord(body) && typeof body.error === "string" ? { error: body.error } : {}),
    results: isRecord(body)
      ? normalizeArrayResponse(body.results)
        .map((result) => normalizeVerifyModelAuthResult(result))
        .filter(isPresent)
      : [],
  };
}

export async function submitSetup(
  hubUrl: string,
  secrets: Record<string, string>,
): Promise<{ ok: boolean; saved?: string[]; error?: string }> {
  const res = await fetch(`${hubUrl}/api/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ secrets }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `Setup failed: ${res.status}`);
  return body;
}

export async function saveGitHubAppConfig(
  hubUrl: string,
  input: {
    appId: string;
    clientId: string;
    slug: string;
    privateKey: string;
  },
): Promise<SetupStatus> {
  const res = await fetch(`${hubUrl}/api/github/app-config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `GitHub App setup failed: ${res.status}`);
  }
  if (isRecord(body) && isRecord(body.status)) {
    return normalizeSetupStatus(body.status, hubUrl);
  }
  return await fetchSetupStatus(hubUrl);
}

export type GitHubAccessTestStatus =
  | "ready"
  | "not_configured"
  | "missing_installation"
  | "repo_not_selected"
  | "missing_permissions"
  | "invalid_repo"
  | "invalid_config"
  | "github_error"
  | "public_hub_disabled";

export interface GitHubAccessTestResult {
  ok: boolean;
  status: GitHubAccessTestStatus;
  message: string;
  repo: string | null;
  installUrl: string | null;
  manageUrl: string | null;
}

export async function testGitHubAppAccess(hubUrl: string, selection: GitHubRepositorySelection): Promise<GitHubAccessTestResult> {
  const res = await fetch(`${hubUrl}/api/github/test-access`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      repositoryId: selection.repositoryId,
      installationId: selection.installationId,
      fullName: selection.fullName,
    }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `GitHub App access test failed: ${res.status}`);
  }
  if (!isRecord(body) || typeof body.status !== "string" || typeof body.ok !== "boolean") {
    throw new Error("Malformed GitHub App access test response");
  }
  return {
    ok: body.ok,
    status: (
      body.status === "ready"
      || body.status === "not_configured"
      || body.status === "missing_installation"
      || body.status === "repo_not_selected"
      || body.status === "missing_permissions"
      || body.status === "invalid_repo"
      || body.status === "invalid_config"
      || body.status === "github_error"
      || body.status === "public_hub_disabled"
    ) ? body.status : "github_error",
    message: readStringOr(body.message, "GitHub App access test failed."),
    repo: readNullableString(body.repo),
    installUrl: readNullableString(body.installUrl),
    manageUrl: readNullableString(body.manageUrl),
  };
}

export async function verifyCloudflareToken(
  hubUrl: string,
  options: { hostname: string; apiToken: string },
): Promise<{
  ok: true;
  hostname: string;
  zoneName: string;
  workerServiceName: string | null;
  gatewayHostname: string | null;
}> {
  const res = await fetch(`${hubUrl}/api/setup/verify-cloudflare-token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(options),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw buildApiActionError(body, `Cloudflare token verification failed: ${res.status}`);
  const result = normalizeVerifyCloudflareTokenResult(body);
  if (!result) {
    throw new Error("Malformed Cloudflare token verification response");
  }
  return result;
}

export async function setupWorkersDevAccess(
  hubUrl: string,
): Promise<SetupStatus> {
  const res = await fetch(`${hubUrl}/api/setup/workers-dev-access`, {
    method: "POST",
    credentials: "include",
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw buildApiActionError(body, `workers.dev Access setup failed: ${res.status}`);
  if (isRecord(body) && isRecord(body.status)) {
    return normalizeSetupStatus(body.status, hubUrl);
  }
  return await fetchSetupStatus(hubUrl);
}

export async function returnToHostedTiller(hubUrl: string): Promise<{ ok: boolean; redirectUrl: string }> {
  const res = await fetch(`${hubUrl}/api/setup/self-host/return-to-hosted`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw buildApiActionError(body, `Return to Hosted Tiller failed: ${res.status}`);
  return {
    ok: isRecord(body) && body.ok === true,
    redirectUrl: isRecord(body) ? readStringOr(body.redirectUrl, hubUrl) : hubUrl,
  };
}

export async function checkForUpdate(hubUrl: string): Promise<UpdateCheckResult> {
  const res = await fetch(`${hubUrl}/api/update/check`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!res.ok) throw await parseApiError(res, `Failed to check for updates: ${res.status}`);
  const result = normalizeUpdateCheckResult(await res.json().catch(() => null));
  if (!result) {
    throw new Error("Malformed update check response");
  }
  return result;
}

export async function applyUpdate(
  hubUrl: string,
): Promise<UpdateApplyResult> {
  const res = await fetch(`${hubUrl}/api/update/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
  });
  const body = await res.json<UpdateApplyResult | { error?: string }>().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Failed to apply update: ${res.status}`);
  return body as UpdateApplyResult;
}

export async function applyCloudflareRepairUpdate(
  hubUrl: string,
  apiToken: string,
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`${hubUrl}/api/update/repair/cloudflare-redeploy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ apiToken }),
  });
  const body = await res.json<{ ok: boolean; error?: string }>().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(body.error || `Failed to apply repair update: ${res.status}`);
  return body;
}

export async function detectSelfUpdateRepo(hubUrl: string): Promise<HubUpdateRepoState> {
  const res = await fetch(`${hubUrl}/api/update/hub-repo/detect`, {
    method: "POST",
    credentials: "include",
    cache: "no-store",
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Self-update repo detection failed: ${res.status}`);
  return normalizeHubUpdateRepoState(body);
}

export async function selectSelfUpdateRepo(
  hubUrl: string,
  candidate: HubUpdateRepoCandidate,
): Promise<HubUpdateRepoState> {
  const res = await fetch(`${hubUrl}/api/update/hub-repo/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      repoId: candidate.repoId,
      installationId: candidate.installationId,
      fullName: candidate.fullName,
      branch: candidate.branch,
    }),
  });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : `Self-update repo selection failed: ${res.status}`);
  return normalizeHubUpdateRepoState(body);
}

// ── WebSocket helper ──────────────────────────────────────────────

const BACKOFF_STEPS = [1, 2, 5, 10, 30]; // seconds

/** Minimal message shape forwarded to the live callback and SessionView. */
export type LiveMessage = {
  sessionId: string;
  content: unknown;
  seq?: number;
};

export interface WsHandlers {
  onConnected?: () => void;
  onDisconnected?: () => void;
  onReconnectExhausted?: () => void;
  onMachineUpdated?: (machine: StoredMachine) => void;
  onMessage?: (msg: Extract<WsServerMessage, { type: "message-received" }>) => void;
  onSessionUpdated?: (session: StoredSession) => void;
  onSessionDeleted?: (sessionId: string) => void;
  onPermissionCreated?: (permission: StoredPermission) => void;
  onPermissionResolved?: (permission: StoredPermission) => void;
  onEnvUpsert?: (env: EnvMeta) => void;
  onEnvRemove?: (slug: string) => void;
  onRepoUpsert?: (repo: RepoMeta) => void;
  onRepoRemove?: (repoId: string) => void;
  onRepoMainChanged?: (
    repoId: string,
    repoUrl: string,
    previousMainCommit: string | null,
    currentMainCommit: string | null,
    sourceEnvSlug?: string | null,
  ) => void;
  onError?: (err: Error) => void;
}

export interface ReconnectingWebSocket {
  close(): void;
  send(data: unknown): void;
  reconnect(): void;
}

/**
 * Manages a WebSocket connection with exponential backoff reconnection.
 */
export function createReconnectingWebSocket(
  hubUrl: string,
  handlers: WsHandlers,
): ReconnectingWebSocket {
  let retryCount = 0;
  let retryTimeout: ReturnType<typeof setTimeout> | null = null;
  let active = true;
  let currentSocket: { close: () => void; send: (data: unknown) => void } | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  function connect() {
    const wsUrl = hubUrl.replace(/^http/, "ws").replace(/\/$/, "");
    const ws = new WebSocket(`${wsUrl}/parties/hub/hub`);

    ws.addEventListener("open", () => {
      pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 30_000);
      retryCount = 0;
      handlers.onConnected?.();
    });

    ws.addEventListener("message", (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const dispatchMessage = (msg: WsServerMessage) => {
        switch (msg.type) {
          case "message-received":
            handlers.onMessage?.(msg);
            break;
          case "machine-updated":
            handlers.onMachineUpdated?.(msg.machine);
            break;
          case "session-updated":
            handlers.onSessionUpdated?.(msg.session);
            break;
          case "session-deleted":
            handlers.onSessionDeleted?.(msg.sessionId);
            break;
          case "permission-created":
            handlers.onPermissionCreated?.(msg.permission);
            break;
          case "permission-resolved":
            handlers.onPermissionResolved?.(msg.permission);
            break;
          case "env-upsert":
            handlers.onEnvUpsert?.(msg.env);
            break;
          case "env-remove":
            handlers.onEnvRemove?.(msg.slug);
            break;
          case "repo-upsert":
            handlers.onRepoUpsert?.(msg.repo);
            break;
          case "repo-remove":
            handlers.onRepoRemove?.(msg.repoId);
            break;
          case "repo-main-changed":
            handlers.onRepoMainChanged?.(
              msg.repoId,
              msg.repoUrl,
              msg.previousMainCommit,
              msg.currentMainCommit,
              msg.sourceEnvSlug,
            );
            break;
          case "error":
            handlers.onError?.(new Error(msg.message));
            break;
          case "replay":
            for (const replayed of msg.events) {
              dispatchMessage(replayed);
            }
            break;
          case "pong":
            break;
        }
      };

      const msg = normalizeWsServerMessage(parsed);
      if (!msg) return;
      dispatchMessage(msg);
    });

    ws.addEventListener("close", (event) => {
      if (pingInterval) clearInterval(pingInterval);
      pingInterval = null;
      currentSocket = null;
      handlers.onDisconnected?.();
      if (!active) return;
      // 4001 = server-side auth rejection; retrying with same credentials won't help
      if (event.code === 4001) {
        handlers.onReconnectExhausted?.();
        return;
      }
      if (retryCount >= 15) {
        handlers.onReconnectExhausted?.();
        return;
      }
      const step = BACKOFF_STEPS[Math.min(retryCount, BACKOFF_STEPS.length - 1)];
      const delay = step * (0.5 + Math.random() * 0.5) * 1000;
      retryCount++;
      retryTimeout = setTimeout(connect, delay);
    });

    currentSocket = {
      close: () => ws.close(),
      send: (data) => ws.send(JSON.stringify(data)),
    };
  }

  connect();

  return {
    close() {
      active = false;
      if (retryTimeout) clearTimeout(retryTimeout);
      currentSocket?.close();
      currentSocket = null;
    },
    send(data) {
      currentSocket?.send(data);
    },
    reconnect() {
      active = true;
      retryCount = 0;
      if (retryTimeout) clearTimeout(retryTimeout);
      currentSocket?.close();
      currentSocket = null;
      connect();
    },
  };
}
