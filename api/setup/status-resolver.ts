import type { Env, EnvHarness } from "../types";
import { resolveEnabledHarnesses } from "../env/harness";
import { resolveChatGPTAvailability } from "../chatgpt-availability";
import { resolveManagedMachineHostStatus } from "../machine-hosts";
import {
  isQuickTunnelUrl,
  readRegisteredHostService,
  readRoutableHostService,
} from "../service-registry";
import { getCanonicalMainBootstrapDepth, getIdleTimeoutMinutes } from "./config";
import {
  hasEnabledHarnessModelAuth,
  isLocalDevRequest,
  resolveModelAuthState,
  resolveProtectionState,
} from "../protection";
import { resolveWorkerServiceName } from "./cloudflare";

export interface SetupStatusPayload {
  needsSetup: boolean;
  isLocalDev: boolean;
  currentOrigin: string;
  hubUrl: string;
  hostKind: "workers-dev" | "custom-domain";
  workerServiceName: string | null;
  modelAuthConfigured: boolean;
  modelAuthMode: "subscription" | "api" | "chatgpt" | "openai-api" | null;
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  hasOpenAIKey: boolean;
  planChatgptConfigured: boolean;
  planChatgptAvailable: boolean;
  planChatgptReason: string | null;
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
  hostConnected: boolean;
  hostConnectionMode: "none" | "session";
  idleTimeoutMinutes: number;
  canonicalMainBootstrapDepth: number;
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
  const isLocalDev = isLocalDevRequest(env, request);
  const modelAuth = await resolveModelAuthState(env);
  const chatgptAvailability = await resolveChatGPTAvailability(env);
  const enabledHarnesses = resolveEnabledHarnesses(env);
  const modelAuthConfigured = hasEnabledHarnessModelAuth(
    modelAuth,
    enabledHarnesses,
  );
  const protection = await resolveProtectionState(env, request.url);
  const managedMachineHosts = await resolveManagedMachineHostStatus(env, protection);
  const hostExecution = await resolveHostExecutionStatus(env);
  const gatewayExecution = await resolveGatewayExecutionStatus(env);
  const workerServiceName = await resolveWorkerServiceName(env, request.url);

  return {
    needsSetup: !modelAuthConfigured,
    isLocalDev,
    currentOrigin: protection.currentOrigin,
    hubUrl: protection.hubUrl,
    hostKind: protection.hostKind,
    workerServiceName,
    modelAuthConfigured,
    modelAuthMode: modelAuth.mode,
    hasClaudeSubscription: modelAuth.hasClaudeSubscription,
    hasAnthropicKey: modelAuth.hasAnthropicKey,
    hasChatGPTAuth: modelAuth.hasChatGPTAuth,
    hasOpenAIKey: modelAuth.hasOpenAIKey,
    planChatgptConfigured: chatgptAvailability.configured,
    planChatgptAvailable: chatgptAvailability.available,
    planChatgptReason: chatgptAvailability.unavailableReason,
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
    hostConnected: hostExecution.connected,
    hostConnectionMode: hostExecution.connectionMode,
    idleTimeoutMinutes: await getIdleTimeoutMinutes(env),
    canonicalMainBootstrapDepth: await getCanonicalMainBootstrapDepth(env),
  };
}
