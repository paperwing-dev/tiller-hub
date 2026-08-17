import type { Env, EnvHarness, HostServiceRegistration } from "../types";
import type { ChatGPTAuthStatus, CodexRouteStatus } from "../types";
import { resolveEnabledHarnesses } from "../env/harness";
import {
  readRegisteredHostService,
  readRoutableHostService,
} from "../service-registry";
import {
  getBillingSelections,
  getIdleTimeoutMinutes,
  getSecret,
  loadConfig,
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
import { getBuildDiagnostics } from "../update/release-info";
import {
  classifyHostRuntimeCompatibilityForExpectedRuntime,
  resolveExpectedHostRuntime,
} from "./runtime-compatibility";
import type { UpdateBuildDiagnostics } from "../update/types";
import { resolveCodexBackendReadiness } from "../codex-execution";
import { readWorkersDevAccessLifecycle } from "../workers-dev-access/records";
import { readExecutionStatus } from "../execution";
import { CLOUDFLARE_IDLE_TIMEOUT_DEFAULT_MINUTES } from "../../shared/cloudflare-timeout";
import { isPlacementRegion, type PlacementRegion } from "../../shared/placement";

export interface SetupStatusPayload {
  needsSetup: boolean;
  setupPhase: "github-app" | "complete";
  isLocalDev: boolean;
  installerManaged: boolean;
  installationRegion: PlacementRegion | null;
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
  githubAppAvailable: boolean;
  githubAppConfigured: boolean;
  githubAppReady: boolean;
  githubAppSlug: string | null;
  githubAppInstallUrl: string | null;
  githubAppManageUrl: string;
  githubAppPublicHubDisabled: boolean;
  buildDiagnostics: UpdateBuildDiagnostics;
  dashboardOnboarding: {
    dismissed: boolean;
    executionReady: boolean;
  };
}

export const DASHBOARD_ONBOARDING_DISMISSED_KEY = "DASHBOARD_ONBOARDING_DISMISSED_V1";

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
    if (options.chatgptAuthStatus === "connected" || options.chatgptAuthStatus === "refreshing") {
      return {
        configured: true,
        available: true,
        route: "subscription-app-server",
        reason: null,
      };
    }
  }

  return {
    configured: options.chatgptAuthStatus !== "missing",
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
              ? "The active Codex subscription login needs reconnection."
              : options.chatgptAuthStatus === "refreshing" || options.chatgptAuthStatus === "temporarily_unavailable"
                ? "The active Codex subscription login is temporarily unavailable."
                : "Connect a Codex subscription login with `tiller auth connect codex`.",
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
      && (modelAuth.chatgptAuthStatus === "connected"
        || modelAuth.chatgptAuthStatus === "refreshing");
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
  const installerManaged = Boolean(env.TILLER_INSTALLER_SCHEMA?.trim());
  const configuredRegion = isPlacementRegion(env.DO_LOCATION_HINT)
    ? env.DO_LOCATION_HINT
    : null;
  if (!isLocalDev && installerManaged) {
    if (configuredRegion === null) {
      throw new Error("Installer-managed installation region configuration is invalid");
    }
  }
  const installationRegion: PlacementRegion | null = isLocalDev
    ? null
    : configuredRegion;
  const githubAppRequired = !isLocalDev;
  // Model, execution, and machine configuration are dashboard onboarding. Only
  // a usable GitHub App installation blocks first entry to the dashboard.
  // Temporary GitHub API failures fail closed instead of bypassing required setup.
  const setupPhase: SetupStatusPayload["setupPhase"] = githubAppRequired && githubAppReadiness !== "ready"
    ? "github-app"
    : "complete";

  return {
    needsSetup: setupPhase !== "complete",
    setupPhase,
    isLocalDev,
    installerManaged,
    installationRegion,
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
    renewalRecommended: installerManaged && workersDevAccess.renewalRecommended,
    hostConnected: hostExecution.connected,
    idleTimeoutMinutes: await getIdleTimeoutMinutes(env),
    githubAppAvailable: githubAppConfigured,
    githubAppConfigured,
    githubAppReady,
    githubAppSlug: githubAppConfig?.slug ?? null,
    githubAppInstallUrl: githubAppConfig ? getGitHubAppInstallUrl(githubAppConfig.slug) : null,
    githubAppManageUrl: getGitHubAppManageUrl(),
    githubAppPublicHubDisabled: !githubAppAllowed,
    buildDiagnostics,
    dashboardOnboarding: {
      dismissed: (await loadConfig(env))[DASHBOARD_ONBOARDING_DISMISSED_KEY] === "1",
      executionReady: execution.executionReady,
    },
  };
}
