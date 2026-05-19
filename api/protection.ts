import type { Env, EnvHarness } from "./types";
import { getStatus as getOpenAIAuthStatus } from "./openai-auth";
import { getSecret } from "./setup/config";
import { isEnabledFlag, isLocalDevMode } from "../shared/local-dev";

export type HostKind = "workers-dev" | "custom-domain";
export type ProtectionMode = "public" | "cf-access";

export interface ModelAuthState {
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  hasOpenAIKey: boolean;
  configured: boolean;
  mode: "subscription" | "api" | "chatgpt" | "openai-api" | null;
}

export interface ProtectionState {
  currentOrigin: string;
  hubUrl: string;
  hostKind: HostKind;
  protectionMode: ProtectionMode;
  protectionCanAutomate: boolean;
  serviceTokenConfigured: boolean;
  unsupportedProtectionConfig: boolean;
  workersDevAliasDisabled: boolean;
  protectionAppDomain: string | null;
}

function normalizeConfiguredUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.replace(/\/+$/, "");
}

function parseStoredBoolean(value: string | undefined): boolean {
  return isEnabledFlag(value);
}

export function getHostKind(url: string): HostKind {
  return new URL(url).hostname.endsWith(".workers.dev") ? "workers-dev" : "custom-domain";
}

export function isLocalDevRequest(
  env: Pick<Env, "LOCAL_DEV_ONLY_BACKEND">,
  request: Request,
): boolean {
  return isLocalDevMode({
    localDevOnlyBackend: env.LOCAL_DEV_ONLY_BACKEND,
    url: request.url,
  });
}

export async function resolveModelAuthState(env: Env): Promise<ModelAuthState> {
  const hasClaudeSubscription = Boolean((await getSecret(env, "CLAUDE_CODE_OAUTH_TOKEN"))?.trim());
  const hasAnthropicKey = Boolean((await getSecret(env, "ANTHROPIC_API_KEY"))?.trim());
  const hasChatGPTAuth = (await getOpenAIAuthStatus(env)).authenticated;
  const hasOpenAIKey = Boolean((await getSecret(env, "OPENAI_API_KEY"))?.trim());

  return {
    hasClaudeSubscription,
    hasAnthropicKey,
    hasChatGPTAuth,
    hasOpenAIKey,
    configured: hasClaudeSubscription || hasAnthropicKey || hasChatGPTAuth || hasOpenAIKey,
    mode: hasClaudeSubscription
      ? "subscription"
      : hasAnthropicKey
        ? "api"
        : hasChatGPTAuth
          ? "chatgpt"
          : hasOpenAIKey
            ? "openai-api"
            : null,
  };
}

export function hasEnabledHarnessModelAuth(
  modelAuth: Pick<ModelAuthState, "hasClaudeSubscription" | "hasAnthropicKey" | "hasChatGPTAuth" | "hasOpenAIKey">
    & { hasLocalCodexAuth?: boolean },
  enabledHarnesses: readonly EnvHarness[],
): boolean {
  return (
    (enabledHarnesses.includes("claude-code") && (modelAuth.hasClaudeSubscription || modelAuth.hasAnthropicKey))
    || (enabledHarnesses.includes("codex") && (modelAuth.hasChatGPTAuth || modelAuth.hasOpenAIKey || Boolean(modelAuth.hasLocalCodexAuth)))
    || enabledHarnesses.includes("opencode")
  );
}

export async function resolveProtectionState(env: Env, requestUrl: string): Promise<ProtectionState> {
  const currentOrigin = new URL(requestUrl).origin.replace(/\/+$/, "");
  const hubUrl = normalizeConfiguredUrl(await getSecret(env, "HUB_PUBLIC_URL")) ?? currentOrigin;
  const hostKind = getHostKind(hubUrl);
  const hasCfAccessAud = Boolean((await getSecret(env, "CF_ACCESS_AUD"))?.trim());
  const hasCfAccessClientId = Boolean((await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim());
  const hasCfAccessClientSecret = Boolean((await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim());
  const hasAnyAccessConfig = hasCfAccessAud || hasCfAccessClientId || hasCfAccessClientSecret;
  const workersDevAliasDisabled = parseStoredBoolean(await getSecret(env, "WORKERS_DEV_ALIAS_DISABLED"));
  const protectionAppDomain = normalizeConfiguredUrl(await getSecret(env, "CF_ACCESS_APP_DOMAIN"));
  const unsupportedProtectionConfig = hostKind === "workers-dev" && hasAnyAccessConfig;

  if (hostKind === "workers-dev") {
    return {
      currentOrigin,
      hubUrl,
      hostKind,
      protectionMode: "public",
      protectionCanAutomate: false,
      serviceTokenConfigured: false,
      unsupportedProtectionConfig,
      workersDevAliasDisabled: false,
      protectionAppDomain: null,
    };
  }

  return {
    currentOrigin,
    hubUrl,
    hostKind,
    protectionMode: hasCfAccessAud ? "cf-access" : "public",
    protectionCanAutomate: true,
    serviceTokenConfigured: hasCfAccessClientId && hasCfAccessClientSecret,
    unsupportedProtectionConfig: false,
    workersDevAliasDisabled,
    protectionAppDomain,
  };
}
