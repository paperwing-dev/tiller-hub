import type { Env, EnvHarness, HostServiceRegistration } from "../types";
import type { ChatGPTAuthStatus, CodexRouteStatus } from "../types";
import { resolveEnabledHarnesses } from "../env/harness";
import {
  readRegisteredHostService,
  readRoutableHostService,
} from "../service-registry";
import {
  getCanonicalMainBootstrapDepth,
  getBillingSelections,
  getIdleTimeoutMinutes,
  getSecret,
} from "./config";
import type { BillingMode } from "../../shared/billing";
import {
  hasEnabledHarnessModelAuth,
  isLocalDevRequest,
  resolveModelAuthState,
  resolveProtectionState,
} from "../protection";
import {
  getGitHubAppConfig,
  getGitHubAppInstallUrl,
  getGitHubAppManageUrl,
  isGitHubAppAllowedForRequest,
  isGitHubAppInstallationReady,
} from "../github/app";
import { requiresWorkersDevAccessProtection } from "./protect-hub";
import { resolveHubUpdateRepoState } from "../update/hub-repo";
import { getBuildDiagnostics } from "../update/metadata";
import {
  classifyHostRuntimeCompatibilityForExpectedRuntime,
  resolveExpectedHostRuntime,
} from "./runtime-compatibility";
import type { HubUpdateRepoState, UpdateBuildDiagnostics } from "../update/types";
import { resolveCodexBackendReadiness } from "../codex-execution";
import {
  hasAvailableHarnessModel,
  listHarnessModelRequirementMessages,
} from "../../shared/harness-catalog";
import { readWorkersDevAccessLifecycle } from "../workers-dev-access/records";
import { readExecutionStatus } from "../execution";
import { CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES } from "../../shared/cloudflare-timeout";

export interface SetupStatusPayload {
  needsSetup: boolean;
  setupPhase: "protect-hub" | "github-app" | "model-access" | "complete";
  isLocalDev: boolean;
  workersDevHubUrl: string | null;
  modelAuthConfigured: boolean;
  claudeBillingMode: BillingMode | null;
  openaiBillingMode: BillingMode | null;
  workersAiConfigured: boolean;
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  chatgptAuthStatus: ChatGPTAuthStatus;
  hasOpenAIKey: boolean;
  codexRouteStatus: CodexRouteStatus;
  openaiPlannerConfigured: boolean;
  openaiPlannerAvailable: boolean;
  openaiPlannerRoute: "api-key" | "subscription-app-server" | null;
  openaiPlannerReason: string | null;
  codexBackendReadiness: { cf: CodexRouteStatus; host: CodexRouteStatus };
  hostRegistered: boolean;
  enabledHarnesses: EnvHarness[];
  protectionMode: "public" | "cf-access";
  tokenExpiresAt: string | null;
  renewalRecommended: boolean;
  hostConnected: boolean;
  idleTimeoutMinutes: number;
  canonicalMainBootstrapDepth: number;
  githubAppAvailable: boolean;
  githubAppConfigured: boolean;
  githubAppReady: boolean;
  githubAppSlug: string | null;
  githubAppInstallUrl: string | null;
  githubAppManageUrl: string;
  githubAppPublicHubDisabled: boolean;
  buildDiagnostics: UpdateBuildDiagnostics;
  selfUpdateRepo: HubUpdateRepoState;
}

export function resolveWorkersDevAccessOnboardingStatus(
  env: Env,
  canonicalOrigin: string,
): SetupStatusPayload {
  return {
    needsSetup: true,
    setupPhase: "protect-hub",
    isLocalDev: false,
    workersDevHubUrl: canonicalOrigin,
    modelAuthConfigured: false,
    claudeBillingMode: null,
    openaiBillingMode: null,
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
    codexBackendReadiness: { cf: "unavailable", host: "unavailable" },
    hostRegistered: false,
    enabledHarnesses: resolveEnabledHarnesses(env),
    protectionMode: "public",
    tokenExpiresAt: null,
    renewalRecommended: false,
    hostConnected: false,
    idleTimeoutMinutes: CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES,
    canonicalMainBootstrapDepth: 0,
    githubAppAvailable: false,
    githubAppConfigured: false,
    githubAppReady: false,
    githubAppSlug: null,
    githubAppInstallUrl: null,
    githubAppManageUrl: getGitHubAppManageUrl(),
    githubAppPublicHubDisabled: true,
    buildDiagnostics: getBuildDiagnostics(),
    selfUpdateRepo: { status: "not_checked", lastDetectedAt: null },
  };
}

type GitHubAppSetupReadiness = "ready" | "not_ready" | "unavailable";

async function resolveGitHubAppReadiness(options: {
  allowed: boolean;
  configured: boolean;
  env: Env;
}): Promise<GitHubAppSetupReadiness> {
  if (!options.allowed || !options.configured) return "not_ready";

  try {
    return await isGitHubAppInstallationReady(options.env) ? "ready" : "not_ready";
  } catch (error) {
    console.warn("[setup] GitHub App installation readiness is temporarily unavailable:", error);
    return "unavailable";
  }
}

function buildCloudflareModelBlockingReasons(options: {
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  workersAiConfigured: boolean;
  enabledHarnesses: readonly EnvHarness[];
}): string[] {
  const credentialStatus = {
    hasAnthropicKey: options.hasAnthropicKey,
    hasOpenAIKey: options.hasOpenAIKey,
    workersAiConfigured: options.workersAiConfigured,
    // Cloudflare Containers onboarding remains credential-based in v1. Global billing is
    // enforced by model pickers and launches after onboarding completes.
    claudeBillingMode: "api" as const,
    openaiBillingMode: "api" as const,
  };
  if (hasAvailableHarnessModel(options.enabledHarnesses, "cf", credentialStatus)) return [];

  const expected = listHarnessModelRequirementMessages(
    options.enabledHarnesses,
    "cf",
    credentialStatus,
  ).map((message) => message.replace(/^Requires\s+/, "").replace(/\.$/, ""));
  return [`Configure ${expected.length > 0 ? expected.join(", or ") : "model credentials"} for Cloudflare Containers.`];
}

function hasWorkersAiBinding(env: Env): boolean {
  return Boolean((env as Partial<Env>).AI);
}

function resolveOpenAIPlannerStatus(options: {
  hasOpenAIKey: boolean;
  chatgptAuthStatus: ChatGPTAuthStatus;
  selectedMode: BillingMode | null;
  codexRouteStatus: CodexRouteStatus;
}): {
  configured: boolean;
  available: boolean;
  route: "api-key" | "subscription-app-server" | null;
  reason: string | null;
} {
  if (!options.selectedMode) {
    return {
      configured: options.hasOpenAIKey || options.chatgptAuthStatus !== "missing",
      available: false,
      route: null,
      reason: "Select an OpenAI billing mode in Global Settings.",
    };
  }

  if (options.selectedMode === "api") {
    return {
      configured: options.hasOpenAIKey,
      available: options.hasOpenAIKey,
      route: options.hasOpenAIKey ? "api-key" : null,
      reason: options.hasOpenAIKey ? null : "Configure the active OpenAI API key in Global Settings.",
    };
  }

  if (options.codexRouteStatus === "available") {
    if (options.chatgptAuthStatus === "connected") {
      return {
        configured: true,
        available: true,
        route: "subscription-app-server",
        reason: null,
      };
    }
    if (options.hasOpenAIKey) {
      return {
        configured: true,
        available: true,
        route: "api-key",
        reason: null,
      };
    }
  }

  return {
    configured: options.hasOpenAIKey || options.chatgptAuthStatus !== "missing",
    available: false,
    route: null,
    reason: options.codexRouteStatus === "runtime_update_required"
      ? "The selected execution backend needs a compatible runtime update."
      : options.codexRouteStatus === "backend_offline"
        ? "The selected execution backend is offline."
        : options.codexRouteStatus === "environment_not_connected"
          ? "The selected machine is registered but not connected."
          : options.codexRouteStatus === "authentication_unavailable"
            ? "The selected OpenAI authentication route is unavailable."
            : options.chatgptAuthStatus === "needs_reconnect"
              ? "The active Codex subscription login needs re-import."
              : options.chatgptAuthStatus === "refreshing" || options.chatgptAuthStatus === "temporarily_unavailable"
                ? "The active Codex subscription login is temporarily unavailable."
                : "Import a Codex subscription login or configure an OpenAI API key in Global Settings.",
  };
}

function resolveHostExecutionStatus(
  host: HostServiceRegistration | null,
  connectedHost: HostServiceRegistration | null,
): {
  registered: boolean;
  connected: boolean;
} {
  if (!host?.machineId?.trim()) {
    return {
      registered: false,
      connected: false,
    };
  }

  return {
    registered: true,
    connected: Boolean(connectedHost),
  };
}

export async function resolveSetupStatus(
  env: Env,
  request: Request,
): Promise<SetupStatusPayload> {
  const isLocalDev = isLocalDevRequest(env, request);
  const [modelAuth, billingSelections] = await Promise.all([
    resolveModelAuthState(env),
    getBillingSelections(env),
  ]);
  const enabledHarnesses = resolveEnabledHarnesses(env);
  const workersAiConfigured = hasWorkersAiBinding(env)
    || Boolean(
      (await getSecret(env, "TILLER_WORKERS_AI_ACCOUNT_ID", { fresh: true }))?.trim()
        && (await getSecret(env, "TILLER_WORKERS_AI_API_TOKEN", { fresh: true }))?.trim(),
    );
  const modelAuthConfigured = hasEnabledHarnessModelAuth(
    {
      ...modelAuth,
      workersAiConfigured,
    },
    enabledHarnesses,
    "host",
  );
  const protection = await resolveProtectionState(env, request.url);
  const workersDevAccess = await readWorkersDevAccessLifecycle(env);
  const registeredHost = await readRegisteredHostService(env);
  const routableHost = registeredHost?.machineId?.trim()
    ? await readRoutableHostService(env, registeredHost.machineId)
    : null;
  const hostExecution = resolveHostExecutionStatus(registeredHost, routableHost);
  const hostRuntime = classifyHostRuntimeCompatibilityForExpectedRuntime(
    registeredHost,
    resolveExpectedHostRuntime(),
  );
  const execution = protection.accessConfigured || isLocalDev
    ? await readExecutionStatus(env)
    : {
        selected: { target: "cf" as const },
        selectedHost: null,
        candidate: { state: "not_connected" as const },
        executionReady: Boolean(env.PLANNER_RUN),
      };
  const authenticationAvailable = billingSelections.openaiBillingMode === "api"
    ? modelAuth.hasOpenAIKey
    : billingSelections.openaiBillingMode === "subscription"
      && (modelAuth.chatgptAuthStatus === "connected" || modelAuth.hasOpenAIKey);
  const directApi = billingSelections.openaiBillingMode === "api";
  const cfCodexReadiness = resolveCodexBackendReadiness({
    backendConnected: Boolean(env.PLANNER_RUN),
    authenticationAvailable,
    directApi,
  });
  const hostCodexReadiness: CodexRouteStatus = resolveCodexBackendReadiness({
      backendConnected: hostExecution.registered,
      authenticationAvailable,
      directApi,
      runtimeCompatibilityRequired: hostExecution.connected,
      runtimeImageCompatible: hostRuntime.compatible,
      runtimeAuthProtocol: routableHost?.codexRuntimeAuthProtocol,
      environmentConnected: hostExecution.connected,
    });
  const codexBackendReadiness = {
    cf: cfCodexReadiness,
    host: hostCodexReadiness,
  } satisfies SetupStatusPayload["codexBackendReadiness"];
  const isReadyCodexStatus = (status: CodexRouteStatus) => status === "available" || status === "direct_api";
  const codexRouteStatus: CodexRouteStatus = execution.selected.target === "cf"
    ? cfCodexReadiness
    : hostCodexReadiness;
  const githubAppAllowed = await isGitHubAppAllowedForRequest(env, request);
  const githubAppConfig = githubAppAllowed ? await getGitHubAppConfig(env) : null;
  const githubAppConfigured = githubAppAllowed && Boolean(githubAppConfig);
  const buildDiagnostics = getBuildDiagnostics();
  const githubAppReadiness = await resolveGitHubAppReadiness({
    allowed: githubAppAllowed,
    configured: githubAppConfigured,
    env,
  });
  const githubAppReady = githubAppReadiness === "ready";
  const selfUpdateRepo = buildDiagnostics.channel === "development"
    ? { status: "not_checked" as const, lastDetectedAt: null }
    : await resolveHubUpdateRepoState(env, { autoDetect: githubAppConfigured });
  const cloudflareModelBlockingReasons = buildCloudflareModelBlockingReasons({
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    hasAnthropicKey: modelAuth.hasAnthropicKey,
    workersAiConfigured,
    enabledHarnesses,
  });
  const openaiPlanner = resolveOpenAIPlannerStatus({
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    chatgptAuthStatus: modelAuth.chatgptAuthStatus,
    selectedMode: billingSelections.openaiBillingMode,
    codexRouteStatus,
  });
  const workersDevHubUrl = workersDevAccess.workersDevHostname
    ? `https://${workersDevAccess.workersDevHostname}`
    : isLocalDev
      ? null
      : protection.hubUrl;
  const modelAccessReady = cloudflareModelBlockingReasons.length === 0;
  const githubAppRequired = !isLocalDev;
  const setupPhase: SetupStatusPayload["setupPhase"] = requiresWorkersDevAccessProtection({
    isLocalDev,
    accessConfigured: protection.accessConfigured,
  })
    ? "protect-hub"
    : githubAppRequired && githubAppReadiness === "not_ready"
      ? "github-app"
      : modelAccessReady
        ? "complete"
        : "model-access";

  return {
    needsSetup: setupPhase !== "complete",
    setupPhase,
    isLocalDev,
    workersDevHubUrl,
    modelAuthConfigured,
    claudeBillingMode: billingSelections.claudeBillingMode,
    openaiBillingMode: billingSelections.openaiBillingMode,
    workersAiConfigured,
    hasClaudeSubscription: modelAuth.hasClaudeSubscription,
    hasAnthropicKey: modelAuth.hasAnthropicKey,
    hasChatGPTAuth: modelAuth.hasChatGPTAuth,
    chatgptAuthStatus: modelAuth.chatgptAuthStatus,
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    codexRouteStatus,
    openaiPlannerConfigured: openaiPlanner.configured,
    openaiPlannerAvailable: openaiPlanner.available,
    openaiPlannerRoute: openaiPlanner.route,
    openaiPlannerReason: openaiPlanner.reason,
    codexBackendReadiness,
    hostRegistered: hostExecution.registered,
    enabledHarnesses,
    protectionMode: protection.protectionMode,
    tokenExpiresAt: workersDevAccess.tokenExpiresAt,
    renewalRecommended: workersDevAccess.renewalRecommended,
    hostConnected: hostExecution.connected,
    idleTimeoutMinutes: await getIdleTimeoutMinutes(env),
    canonicalMainBootstrapDepth: await getCanonicalMainBootstrapDepth(env),
    githubAppAvailable: githubAppConfigured,
    githubAppConfigured,
    githubAppReady,
    githubAppSlug: githubAppConfig?.slug ?? null,
    githubAppInstallUrl: githubAppConfig ? getGitHubAppInstallUrl(githubAppConfig.slug) : null,
    githubAppManageUrl: getGitHubAppManageUrl(),
    githubAppPublicHubDisabled: !githubAppAllowed,
    buildDiagnostics,
    selfUpdateRepo,
  };
}
