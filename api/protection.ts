import type { ChatGPTAuthStatus, Env, EnvHarness } from "./types";
import { getStatus as getOpenAIAuthStatus } from "./openai-auth";
import { getSecret } from "./setup/config";
import { isEnabledFlag, isLocalDevMode } from "../shared/local-dev";

export type HostKind = "workers-dev" | "custom-domain";
export type RouteKind = HostKind;
export type ProtectionMode = "public" | "cf-access";

export interface ModelAuthState {
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  chatgptAuthStatus: ChatGPTAuthStatus;
  hasOpenAIKey: boolean;
  configured: boolean;
  mode: "subscription" | "api" | "api-key" | null;
}

export interface ProtectionState {
  currentOrigin: string;
  hubUrl: string;
  routeKind: RouteKind;
  hostKind: HostKind;
  protectionMode: ProtectionMode;
  protectionCanAutomate: boolean;
  serviceTokenConfigured: boolean;
  unsupportedProtectionConfig: boolean;
  workersDevAliasDisabled: boolean;
  protectionAppDomain: string | null;
  accessConfigured: boolean;
  accessIssuer: string | null;
  accessJwksUrl: string | null;
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

export const getRouteKind = getHostKind;

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
  const openAIAuthStatus = await getOpenAIAuthStatus(env);
  const hasChatGPTAuth = openAIAuthStatus.authenticated;
  const hasOpenAIKey = Boolean((await getSecret(env, "OPENAI_API_KEY"))?.trim());

  return {
    hasClaudeSubscription,
    hasAnthropicKey,
    hasChatGPTAuth,
    chatgptAuthStatus: openAIAuthStatus.status,
    hasOpenAIKey,
    configured: hasClaudeSubscription || hasAnthropicKey || hasChatGPTAuth || hasOpenAIKey,
    mode: hasClaudeSubscription
      ? "subscription"
      : hasAnthropicKey
        ? "api"
        : hasChatGPTAuth
          ? "subscription"
          : hasOpenAIKey
            ? "api-key"
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
    || (enabledHarnesses.includes("codex") && (modelAuth.hasChatGPTAuth || modelAuth.hasOpenAIKey))
    || enabledHarnesses.includes("opencode")
  );
}

export async function resolveProtectionState(env: Env, requestUrl: string): Promise<ProtectionState> {
  const currentOrigin = new URL(requestUrl).origin.replace(/\/+$/, "");
  const hubUrl = normalizeConfiguredUrl(await getSecret(env, "HUB_PUBLIC_URL")) ?? currentOrigin;
  const routeKind = getRouteKind(hubUrl);
  const hasCfAccessAud = Boolean((await getSecret(env, "CF_ACCESS_AUD"))?.trim());
  const hasCfAccessClientId = Boolean((await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim());
  const hasCfAccessClientSecret = Boolean((await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim());
  const accessIssuer = normalizeConfiguredUrl(await getSecret(env, "CF_ACCESS_TEAM_DOMAIN"));
  const accessJwksUrl = normalizeConfiguredUrl(await getSecret(env, "CF_ACCESS_JWKS_URL"));
  const accessConfiguredFlag = parseStoredBoolean(await getSecret(env, "CF_ACCESS_CONFIGURED"));
  const workersDevAliasDisabled = parseStoredBoolean(await getSecret(env, "WORKERS_DEV_ALIAS_DISABLED"));
  const protectionAppDomain = normalizeConfiguredUrl(await getSecret(env, "CF_ACCESS_APP_DOMAIN"));
  const hasVerifiableAccessJwtConfig = Boolean(accessIssuer || accessJwksUrl);
  const accessConfigured = Boolean(
    hasCfAccessAud
      && hasVerifiableAccessJwtConfig
      && (routeKind === "custom-domain" || accessConfiguredFlag),
  );

  return {
    currentOrigin,
    hubUrl,
    routeKind,
    hostKind: routeKind,
    protectionMode: accessConfigured ? "cf-access" : "public",
    protectionCanAutomate: routeKind === "custom-domain",
    serviceTokenConfigured: hasCfAccessClientId && hasCfAccessClientSecret,
    unsupportedProtectionConfig: hasCfAccessAud && !hasVerifiableAccessJwtConfig,
    workersDevAliasDisabled: routeKind === "custom-domain" ? workersDevAliasDisabled : false,
    protectionAppDomain,
    accessConfigured,
    accessIssuer,
    accessJwksUrl,
  };
}
