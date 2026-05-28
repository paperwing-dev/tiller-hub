import type { Env, EnvHarness } from "../types";
import type { ChatGPTAuthStatus, CodexRouteStatus } from "../types";
import { resolveEnabledHarnesses } from "../env/harness";
import { resolveChatGPTAvailability } from "../chatgpt-availability";
import { resolveManagedMachineHostStatus } from "../machine-hosts";
import {
  isQuickTunnelUrl,
  readRegisteredHostService,
  readRoutableHostService,
} from "../service-registry";
import {
  getCanonicalMainBootstrapDepth,
  getIdleTimeoutMinutes,
  getSecret,
  resolveDeploymentMode,
  type DeploymentMode,
  type RouteKind,
} from "./config";
import {
  getRouteKind,
  hasEnabledHarnessModelAuth,
  isLocalDevRequest,
  resolveModelAuthState,
  resolveProtectionState,
} from "../protection";
import {
  expireSelfHostStateIfNeeded,
  isSelfHostSetupInProgress,
  selfHostSetupWorkersDevUrl,
} from "../self-host/state";
import { resolveWorkerServiceName } from "./cloudflare";
import {
  getGitHubAppConfig,
  getGitHubAppInstallUrl,
  getGitHubAppManageUrl,
  isGitHubAppAllowedForRequest,
  listGitHubAppRepositories,
} from "../github/app";
import { requiresWorkersDevAccessProtection } from "./protect-hub";
import { resolveHubUpdateRepoState } from "../update/hub-repo";
import type { HubUpdateRepoState } from "../update/types";

export interface SetupStatusPayload {
  needsSetup: boolean;
  setupPhase: "protect-hub" | "github-app" | "model-access" | "complete";
  isLocalDev: boolean;
  currentOrigin: string;
  hubUrl: string;
  deploymentMode: DeploymentMode;
  selfHostStatus: "not-enabled" | "setup-in-progress" | "enabled" | "offline" | "ready";
  selfHostSetupAttemptId: string | null;
  workersDevHubUrl: string | null;
  routeKind: RouteKind;
  hostKind: "workers-dev" | "custom-domain";
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
  chatgptAuthStatus: ChatGPTAuthStatus;
  hasOpenAIKey: boolean;
  codexRouteStatus: CodexRouteStatus;
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

async function resolveGitHubAppReady(options: {
  allowed: boolean;
  configured: boolean;
  env: Env;
}): Promise<boolean> {
  if (!options.allowed || !options.configured) return false;

  try {
    const result = await listGitHubAppRepositories(options.env);
    return result.repositories.length > 0;
  } catch {
    return false;
  }
}

function buildHostedInfrastructureBlockingReasons(options: {
  isLocalDev: boolean;
  protectionMode: "public" | "cf-access";
}): string[] {
  const reasons: string[] = [];
  if (options.isLocalDev) {
    reasons.push("Hosted Tiller requires a deployed Cloudflare Worker.");
  }
  if (options.protectionMode !== "cf-access") {
    reasons.push("Protect this hub with Cloudflare Access.");
  }
  return reasons;
}

function buildHostedModelBlockingReasons(options: {
  hasOpenAIKey: boolean;
  hasAnthropicKey: boolean;
  workersAiConfigured: boolean;
  enabledHarnesses: readonly EnvHarness[];
}): string[] {
  if (options.enabledHarnesses.includes("claude-code") && options.hasAnthropicKey) return [];
  if (options.enabledHarnesses.includes("codex") && options.hasOpenAIKey) return [];
  if (options.enabledHarnesses.includes("opencode") && options.workersAiConfigured) return [];
  if (options.enabledHarnesses.length === 0 && (options.hasAnthropicKey || options.hasOpenAIKey || options.workersAiConfigured)) return [];

  const expected = [
    ...(options.enabledHarnesses.includes("claude-code") ? ["ANTHROPIC_API_KEY"] : []),
    ...(options.enabledHarnesses.includes("codex") ? ["OPENAI_API_KEY"] : []),
    ...(options.enabledHarnesses.includes("opencode") ? ["Workers AI credentials"] : []),
  ];
  return [`Configure ${expected.length > 0 ? expected.join(", or ") : "model credentials"} for Hosted Tiller models.`];
}

function hasWorkersAiBinding(env: Env): boolean {
  return Boolean((env as Partial<Env>).AI);
}

function buildSelfHostBlockingReasons(options: {
  deploymentMode: DeploymentMode;
  routeKind: RouteKind;
  protectionMode: "public" | "cf-access";
  hostConnected: boolean;
  gatewaySupportAvailable: boolean;
  hostGatewayAvailable: boolean;
}): string[] {
  const reasons: string[] = [];
  if (options.deploymentMode !== "self-host") {
    reasons.push("Switch deployment mode to Tiller Self Host.");
  }
  if (options.routeKind !== "custom-domain") {
    reasons.push("Tiller Self Host requires a custom domain.");
  }
  if (options.protectionMode !== "cf-access") {
    reasons.push("Protect the hub with Cloudflare Access.");
  }
  if (!options.hostConnected) {
    reasons.push("Connect a Tiller Self Host machine.");
  }
  if (!options.gatewaySupportAvailable) {
    reasons.push("Provision the protected Subscription Gateway resources.");
  }
  if (!options.hostGatewayAvailable) {
    reasons.push("Start a healthy, routable Subscription Gateway.");
  }
  return reasons;
}

function resolveOpenAIPlannerStatus(options: {
  deploymentMode: DeploymentMode;
  hasOpenAIKey: boolean;
  chatgptAvailability: Awaited<ReturnType<typeof resolveChatGPTAvailability>>;
}): {
  configured: boolean;
  available: boolean;
  route: "api-key" | "subscription-gateway" | null;
  reason: string | null;
} {
  if (
    options.hasOpenAIKey
    && (
      options.chatgptAvailability.route === "api-fallback"
      || (options.deploymentMode === "self-host" && !options.chatgptAvailability.available)
    )
  ) {
    return {
      configured: true,
      available: true,
      route: "api-key",
      reason: null,
    };
  }

  if (
    options.deploymentMode === "self-host"
    && options.chatgptAvailability.route === "gateway-subscription"
    && options.chatgptAvailability.available
  ) {
    return {
      configured: true,
      available: true,
      route: "subscription-gateway",
      reason: null,
    };
  }

  if (options.deploymentMode === "hosted") {
    return {
      configured: options.hasOpenAIKey,
      available: false,
      route: null,
      reason: options.hasOpenAIKey
        ? "OpenAI planner API key route is not available right now."
        : "Configure OPENAI_API_KEY to use the OpenAI planner in Hosted Tiller.",
    };
  }

  return {
    configured: options.chatgptAvailability.configured || options.hasOpenAIKey,
    available: false,
    route: null,
    reason: options.chatgptAvailability.unavailableReason
      ?? "Start a healthy Subscription Gateway or configure OPENAI_API_KEY.",
  };
}

async function resolveHostExecutionStatus(
  env: Env,
): Promise<{
  registered: boolean;
  registeredMode: "none" | "session";
  connected: boolean;
  connectionMode: "none" | "session";
}> {
  const host = await readRegisteredHostService(env);
  const connectedHost = host?.machineId?.trim()
    ? await readRoutableHostService(env, host.machineId)
    : null;

  if (!host?.machineId?.trim()) {
    return {
      registered: false,
      registeredMode: "none",
      connected: false,
      connectionMode: "none",
    };
  }

  return {
    registered: true,
    registeredMode: "session",
    connected: Boolean(connectedHost),
    connectionMode: connectedHost ? "session" : "none",
  };
}

async function resolveGatewayExecutionStatus(
  env: Env,
): Promise<{
  configured: boolean;
  available: boolean;
  mode: "none" | "quick" | "named";
}> {
  const registeredHost = await readRegisteredHostService(env);
  const routableHost = await readRoutableHostService(env);
  const configuredGatewayUrl = registeredHost?.gatewayUrl?.trim() ?? "";
  const availableGatewayUrl = routableHost?.gatewayUrl?.trim() ?? "";

  if (!configuredGatewayUrl) {
    return { configured: false, available: false, mode: "none" };
  }

  return {
    configured: true,
    available: Boolean(availableGatewayUrl),
    mode: isQuickTunnelUrl(configuredGatewayUrl) ? "quick" : "named",
  };
}

export async function resolveSetupStatus(
  env: Env,
  request: Request,
): Promise<SetupStatusPayload> {
  const selfHostSession = await expireSelfHostStateIfNeeded(env);
  const isLocalDev = isLocalDevRequest(env, request);
  const modelAuth = await resolveModelAuthState(env);
  const enabledHarnesses = resolveEnabledHarnesses(env);
  const modelAuthConfigured = hasEnabledHarnessModelAuth(
    modelAuth,
    enabledHarnesses,
  );
  const protection = await resolveProtectionState(env, request.url);
  const currentRouteKind = getRouteKind(request.url);
  const managedMachineHosts = await resolveManagedMachineHostStatus(env, protection);
  const hostExecution = await resolveHostExecutionStatus(env);
  const gatewayExecution = await resolveGatewayExecutionStatus(env);
  const deploymentMode = await resolveDeploymentMode(env, {
    routeKind: protection.routeKind,
    hostRegistered: hostExecution.registered,
    hostGatewayConfigured: gatewayExecution.configured,
    gatewayProvisioned: managedMachineHosts.gatewayProvisioned,
  });
  const chatgptAvailability = await resolveChatGPTAvailability(env);
  const workerServiceName = await resolveWorkerServiceName(env, request.url);
  const githubAppAllowed = await isGitHubAppAllowedForRequest(env, request);
  const githubAppConfig = githubAppAllowed ? await getGitHubAppConfig(env) : null;
  const githubAppConfigured = githubAppAllowed && Boolean(githubAppConfig);
  const githubAppReady = await resolveGitHubAppReady({
    allowed: githubAppAllowed,
    configured: githubAppConfigured,
    env,
  });
  const selfUpdateRepo = await resolveHubUpdateRepoState(env, { autoDetect: githubAppConfigured });
  const workersAiConfigured = hasWorkersAiBinding(env)
    || Boolean(
      (await getSecret(env, "TILLER_WORKERS_AI_ACCOUNT_ID"))?.trim()
        && (await getSecret(env, "TILLER_WORKERS_AI_API_TOKEN"))?.trim(),
    );
  const hostedBlockingReasons = buildHostedInfrastructureBlockingReasons({
    isLocalDev,
    protectionMode: protection.protectionMode,
  });
  const hostedModelBlockingReasons = buildHostedModelBlockingReasons({
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    hasAnthropicKey: modelAuth.hasAnthropicKey,
    workersAiConfigured,
    enabledHarnesses,
  });
  const selfHostBlockingReasons = buildSelfHostBlockingReasons({
    deploymentMode,
    routeKind: protection.routeKind,
    protectionMode: protection.protectionMode,
    hostConnected: hostExecution.connected,
    gatewaySupportAvailable: managedMachineHosts.gatewaySupportAvailable,
    hostGatewayAvailable: gatewayExecution.available,
  });
  const openaiPlanner = resolveOpenAIPlannerStatus({
    deploymentMode,
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    chatgptAvailability,
  });
  const hostedInfrastructureReady = hostedBlockingReasons.length === 0;
  const hostedModelReady = hostedModelBlockingReasons.length === 0;
  const selfHostReady = selfHostBlockingReasons.length === 0;
  const selfHostSetupInProgress = isSelfHostSetupInProgress(selfHostSession);
  const selfHostStatus: SetupStatusPayload["selfHostStatus"] = selfHostSetupInProgress
    ? "setup-in-progress"
    : deploymentMode !== "self-host"
      ? "not-enabled"
      : selfHostReady
        ? "ready"
        : hostExecution.connected || gatewayExecution.configured
          ? "offline"
          : "enabled";
  const workersDevHubUrl = selfHostSetupWorkersDevUrl(selfHostSession)
    ?? (protection.routeKind === "workers-dev" ? protection.hubUrl : null);
  const modelAccessReady = deploymentMode === "self-host"
    ? modelAuthConfigured
    : hostedModelReady;
  const githubAppRequired = !isLocalDev;
  const setupPhase: SetupStatusPayload["setupPhase"] = requiresWorkersDevAccessProtection({
    isLocalDev,
    currentRouteKind,
    accessConfigured: protection.accessConfigured,
  })
    ? "protect-hub"
    : githubAppRequired && !githubAppReady
      ? "github-app"
      : (modelAccessReady || workersAiConfigured)
        ? "complete"
        : "model-access";

  return {
    needsSetup: setupPhase !== "complete",
    setupPhase,
    isLocalDev,
    currentOrigin: protection.currentOrigin,
    hubUrl: protection.hubUrl,
    deploymentMode,
    selfHostStatus,
    selfHostSetupAttemptId: selfHostSetupInProgress ? selfHostSession?.attemptId ?? null : null,
    workersDevHubUrl,
    routeKind: protection.routeKind,
    hostKind: protection.routeKind,
    workerServiceName,
    modelAuthConfigured,
    modelAuthMode: modelAuth.mode,
    hostedInfrastructureReady,
    hostedBlockingReasons,
    hostedModelReady,
    hostedModelBlockingReasons,
    selfHostReady,
    selfHostBlockingReasons,
    workersAiConfigured,
    hasClaudeSubscription: modelAuth.hasClaudeSubscription,
    hasAnthropicKey: modelAuth.hasAnthropicKey,
    hasChatGPTAuth: modelAuth.hasChatGPTAuth,
    chatgptAuthStatus: modelAuth.chatgptAuthStatus,
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    codexRouteStatus: chatgptAvailability.codexRouteStatus,
    openaiPlannerConfigured: openaiPlanner.configured,
    openaiPlannerAvailable: openaiPlanner.available,
    openaiPlannerRoute: openaiPlanner.route,
    openaiPlannerReason: openaiPlanner.reason,
    hostRegistered: hostExecution.registered,
    hostRegisteredMode: hostExecution.registeredMode,
    hostGatewayAvailable: gatewayExecution.available,
    hostGatewayConfigured: gatewayExecution.configured,
    hostGatewayMode: gatewayExecution.mode,
    enabledHarnesses,
    protectionMode: protection.protectionMode,
    protectionCanAutomate: protection.protectionCanAutomate,
    serviceTokenConfigured: protection.serviceTokenConfigured,
    gatewayHostname: managedMachineHosts.gatewayHostname,
    browserProtected: managedMachineHosts.browserProtected,
    gatewayProvisioned: managedMachineHosts.gatewayProvisioned,
    gatewayTunnelConfigured: managedMachineHosts.gatewayTunnelConfigured,
    gatewaySupportAvailable: managedMachineHosts.gatewaySupportAvailable,
    gatewaySupportReason: managedMachineHosts.gatewaySupportReason,
    workersDevCutoverPending: managedMachineHosts.workersDevCutoverPending,
    unsupportedProtectionConfig: protection.unsupportedProtectionConfig,
    workersDevAliasDisabled: protection.workersDevAliasDisabled,
    protectionAppDomain: protection.protectionAppDomain,
    accessConfigured: protection.accessConfigured,
    accessIssuer: protection.accessIssuer,
    accessJwksUrl: protection.accessJwksUrl,
    hostConnected: hostExecution.connected,
    hostConnectionMode: hostExecution.connectionMode,
    idleTimeoutMinutes: await getIdleTimeoutMinutes(env),
    canonicalMainBootstrapDepth: await getCanonicalMainBootstrapDepth(env),
    githubAppAvailable: githubAppConfigured,
    githubAppConfigured,
    githubAppReady,
    githubAppSlug: githubAppConfig?.slug ?? null,
    githubAppInstallUrl: githubAppConfig ? getGitHubAppInstallUrl(githubAppConfig.slug) : null,
    githubAppManageUrl: getGitHubAppManageUrl(),
    githubAppPublicHubDisabled: !githubAppAllowed,
    selfUpdateRepo,
  };
}
