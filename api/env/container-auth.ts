import type {
  Env,
  ClaudeAuthMode,
  ResolvedClaudeAuthMode,
  CodexAuthMode,
  ModelRoute,
} from "../types";
import type { RunnerBackendKind } from "./runner-backend";
import { getOrCreateSecret, getSecret } from "../setup/config";
import type { ResolvedCodexModelRoute } from "../model-route";

export interface ResolvedContainerAuth {
  authMode: ClaudeAuthMode;
  resolvedAuthMode: ResolvedClaudeAuthMode;
  authWarning?: string;
  envVars: Record<string, string>;
}

export interface ResolvedCodexContainerAuth {
  resolvedAuthMode: CodexAuthMode;
  modelRoute: ModelRoute;
  envVars: Record<string, string>;
}

export interface ResolvedOpenCodeContainerAuth {
  provider: "cloudflare-workers-ai";
  model: "@cf/moonshotai/kimi-k2.5";
  proxyToken: string;
}

export const OPENCODE_PROXY_TOKEN_KEY = "TILLER_OPENCODE_PROXY_TOKEN";
const CLAUDE_OAUTH_PROFILE_URL = "https://api.anthropic.com/api/oauth/profile";
const CLAUDE_SUBSCRIPTION_TYPE_BY_ORG_TYPE: Record<string, string> = {
  claude_enterprise: "enterprise",
  claude_team: "team",
  claude_max: "max",
  claude_pro: "pro",
};

function createProxyToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveClaudeSubscriptionEnvVars(oauthToken: string): Promise<Record<string, string>> {
  const envVars: Record<string, string> = { CLAUDE_CODE_OAUTH_TOKEN: oauthToken };

  try {
    const response = await fetch(CLAUDE_OAUTH_PROFILE_URL, {
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      return envVars;
    }

    const profile = await response.json() as {
      organization?: {
        organization_type?: unknown;
        rate_limit_tier?: unknown;
      };
    };
    const organizationType = readString(profile.organization?.organization_type);
    const subscriptionType = organizationType
      ? CLAUDE_SUBSCRIPTION_TYPE_BY_ORG_TYPE[organizationType]
      : undefined;
    const rateLimitTier = readString(profile.organization?.rate_limit_tier);

    if (subscriptionType) {
      envVars.CLAUDE_CODE_SUBSCRIPTION_TYPE = subscriptionType;
    }
    if (rateLimitTier) {
      envVars.CLAUDE_CODE_RATE_LIMIT_TIER = rateLimitTier;
    }
  } catch {
    // The token is still usable without profile metadata; Claude Code will just
    // fall back to its generic subscription-token label.
  }

  return envVars;
}

export function resolveClaudeAuthMode(options?: {
  requested?: string | null;
  stored?: string | null;
}): ClaudeAuthMode {
  if (options?.requested === "auto" || options?.requested === "subscription" || options?.requested === "api") {
    return options.requested;
  }

  if (options?.stored === "auto" || options?.stored === "subscription" || options?.stored === "api") {
    return options.stored;
  }

  return "auto";
}

export async function resolveContainerAuth(
  env: Env,
  options?: { requested?: string | null; stored?: string | null; backend?: RunnerBackendKind },
): Promise<ResolvedContainerAuth> {
  const authMode = resolveClaudeAuthMode(options);
  const oauthToken = await getSecret(env, "CLAUDE_CODE_OAUTH_TOKEN");
  const apiKey = await getSecret(env, "ANTHROPIC_API_KEY");
  const backend = options?.backend;

  if (authMode === "subscription") {
    if (backend === "cf") {
      throw new Error("Claude subscription auth is only supported on Tiller Host environments. Cloudflare Containers must use ANTHROPIC_API_KEY.");
    }
    if (!oauthToken) {
      throw new Error("Claude subscription auth requested, but CLAUDE_CODE_OAUTH_TOKEN is not configured");
    }
    return {
      authMode,
      resolvedAuthMode: "subscription",
      envVars: await resolveClaudeSubscriptionEnvVars(oauthToken),
    };
  }

  if (authMode === "api") {
    if (!apiKey) {
      throw new Error("Anthropic API auth requested, but ANTHROPIC_API_KEY is not configured");
    }
    return {
      authMode,
      resolvedAuthMode: "api",
      envVars: { ANTHROPIC_API_KEY: apiKey },
    };
  }

  if (backend === "cf") {
    if (!apiKey) {
      throw new Error("Cloudflare Containers require ANTHROPIC_API_KEY for Claude environments.");
    }
    return {
      authMode,
      resolvedAuthMode: "api",
      authWarning: "Cloudflare Containers use the Anthropic API key.",
      envVars: { ANTHROPIC_API_KEY: apiKey },
    };
  }

  if (oauthToken) {
    return {
      authMode,
      resolvedAuthMode: "subscription",
      envVars: await resolveClaudeSubscriptionEnvVars(oauthToken),
    };
  }

  if (apiKey) {
    return {
      authMode,
      resolvedAuthMode: "api",
      authWarning: "This environment is using the Anthropic API key.",
      envVars: { ANTHROPIC_API_KEY: apiKey },
    };
  }

  throw new Error("No auth configured for container: set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY as a Wrangler secret");
}

export async function resolveCodexContainerAuth(
  env: Env,
  options?: {
    backend?: RunnerBackendKind;
    gatewayRoute?: ResolvedCodexModelRoute;
  },
): Promise<ResolvedCodexContainerAuth> {
  if (options?.gatewayRoute?.kind === "gateway-subscription" || options?.gatewayRoute?.kind === "host-gateway") {
    return {
      resolvedAuthMode: "chatgpt",
      modelRoute: options.gatewayRoute.kind,
      envVars: {
        TILLER_CODEX_GATEWAY_BASE_URL: options.gatewayRoute.providerBaseUrl,
        TILLER_CODEX_GATEWAY_ACCESS_TOKEN: options.gatewayRoute.accessToken,
        ...(options.gatewayRoute.accountId
          ? { TILLER_CODEX_GATEWAY_ACCOUNT_ID: options.gatewayRoute.accountId }
          : {}),
      },
    };
  }

  const apiKey = await getSecret(env, "OPENAI_API_KEY");
  if (!apiKey) {
    if (options?.backend === "cf") {
      throw new Error("Codex requires OPENAI_API_KEY for Cloudflare Container environments.");
    }

    if (options?.gatewayRoute?.kind === "api-fallback") {
      return {
        resolvedAuthMode: "openai-api",
        modelRoute: "api-fallback",
        envVars: { OPENAI_API_KEY: options.gatewayRoute.openaiApiKey },
      };
    }

    throw new Error(
      options?.backend === "host"
        ? "Codex requires a connected Tiller Host gateway or an OpenAI API key."
        : "Codex requires a running Tiller Host gateway or an OpenAI API key.",
    );
  }

  return {
    resolvedAuthMode: "openai-api",
    modelRoute: "api-fallback",
    envVars: { OPENAI_API_KEY: apiKey },
  };
}

export async function resolveOpenCodeContainerAuth(
  env: Env,
): Promise<ResolvedOpenCodeContainerAuth> {
  const proxyToken = await getOrCreateSecret(env, OPENCODE_PROXY_TOKEN_KEY, createProxyToken);

  return {
    provider: "cloudflare-workers-ai",
    model: "@cf/moonshotai/kimi-k2.5",
    proxyToken,
  };
}
