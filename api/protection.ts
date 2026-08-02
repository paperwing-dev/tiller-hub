import type { ChatGPTAuthStatus, Env, EnvHarness } from "./types";
import { getStatus as getOpenAIAuthStatus } from "./openai-auth";
import { getSecret } from "./setup/config";
import { isLocalDevMode } from "../shared/local-dev";
import { listHarnessModels } from "../shared/harness-catalog";
import {
  readWorkersDevAccessCredential,
  readWorkersDevAccessTrust,
} from "./workers-dev-access/records";

export type ProtectionMode = "public" | "cf-access";

export interface ModelAuthState {
  hasClaudeSubscription: boolean;
  hasAnthropicKey: boolean;
  hasChatGPTAuth: boolean;
  chatgptAuthStatus: ChatGPTAuthStatus;
  hasOpenAIKey: boolean;
  configured: boolean;
}

export interface ProtectionState {
  currentOrigin: string;
  hubUrl: string;
  protectionMode: ProtectionMode;
  serviceTokenConfigured: boolean;
  accessConfigured: boolean;
}

export function isLocalDevRequest(
  env: Pick<Env, "LOCAL_DEV_ONLY_BACKEND">,
  request: Request,
): boolean {
  return isLocalDevMode({
    enabled: env.LOCAL_DEV_ONLY_BACKEND,
    url: request.url,
  });
}

export async function resolveModelAuthState(env: Env): Promise<ModelAuthState> {
  const hasClaudeSubscription = Boolean((await getSecret(env, "CLAUDE_CODE_OAUTH_TOKEN", { fresh: true }))?.trim());
  const hasAnthropicKey = Boolean((await getSecret(env, "ANTHROPIC_API_KEY", { fresh: true }))?.trim());
  const openAIAuthStatus = await getOpenAIAuthStatus(env);
  const hasChatGPTAuth = openAIAuthStatus.authenticated;
  const hasOpenAIKey = Boolean((await getSecret(env, "OPENAI_API_KEY", { fresh: true }))?.trim());

  return {
    hasClaudeSubscription,
    hasAnthropicKey,
    hasChatGPTAuth,
    chatgptAuthStatus: openAIAuthStatus.status,
    hasOpenAIKey,
    configured: hasClaudeSubscription || hasAnthropicKey || hasChatGPTAuth || hasOpenAIKey,
  };
}

export function hasEnabledHarnessModelAuth(
  modelAuth: Pick<ModelAuthState, "hasClaudeSubscription" | "hasAnthropicKey" | "hasChatGPTAuth" | "hasOpenAIKey">
    & {
      hasLocalCodexAuth?: boolean;
      workersAiConfigured?: boolean;
    },
  enabledHarnesses: readonly EnvHarness[],
  backend: "cf" | "host" = "host",
): boolean {
  // Onboarding remains credential-presence based. It deliberately does not
  // infer or activate a billing selection; model availability does that later.
  return enabledHarnesses.some((harness) => listHarnessModels(harness).some((entry) => {
    switch (entry.credential) {
      case "claude-auth":
        return modelAuth.hasClaudeSubscription || modelAuth.hasAnthropicKey;
      case "anthropic-api-key":
        return modelAuth.hasAnthropicKey;
      case "codex-auth":
        return modelAuth.hasChatGPTAuth || modelAuth.hasOpenAIKey;
      case "openai-api-key":
        return modelAuth.hasOpenAIKey;
      case "workers-ai":
        return Boolean(modelAuth.workersAiConfigured);
    }
  }));
}

export async function resolveProtectionState(env: Env, requestUrl: string): Promise<ProtectionState> {
  const currentOrigin = new URL(requestUrl).origin.replace(/\/+$/, "");
  if (isLocalDevMode({
    enabled: env.LOCAL_DEV_ONLY_BACKEND,
    url: requestUrl,
  })) {
    return {
      currentOrigin,
      hubUrl: currentOrigin,
      protectionMode: "public",
      serviceTokenConfigured: false,
      accessConfigured: false,
    };
  }

  const hostname = new URL(currentOrigin).hostname;
  const [trust, credential] = hostname.endsWith(".workers.dev")
    ? await Promise.all([
        readWorkersDevAccessTrust(env, hostname),
        readWorkersDevAccessCredential(env),
      ])
    : [null, null] as const;
  const accessConfigured = Boolean(trust && credential);

  return {
    currentOrigin,
    hubUrl: currentOrigin,
    protectionMode: accessConfigured ? "cf-access" : "public",
    serviceTokenConfigured: Boolean(trust && credential?.currentSecret),
    accessConfigured,
  };
}
