import type {
  Env,
  ResolvedClaudeAuthMode,
  CodexAuthMode,
  CodexAuthPreference,
} from "../types";
import type { RunnerBackendKind } from "./runner-backend";
import { getOrCreateSecret, getSecret } from "../setup/config";
import type { HarnessModelCatalogEntry } from "../../shared/harness-catalog";
import { BillingResolutionError } from "../billing-resolution";

export interface ResolvedContainerAuth {
  resolvedAuthMode: ResolvedClaudeAuthMode;
  envVars: Record<string, string>;
}

export interface ResolvedCodexContainerAuth {
  resolvedAuthMode: CodexAuthMode;
  envVars: Record<string, string>;
}

export interface ResolvedOpenCodeContainerAuth {
  model: string;
  baseUrl: string | null;
  token: string;
}

export const OPENCODE_PROXY_TOKEN_KEY = "TILLER_OPENCODE_PROXY_TOKEN";

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

export async function resolveContainerAuth(
  env: Env,
  options: { requested: ResolvedClaudeAuthMode; backend?: RunnerBackendKind },
): Promise<ResolvedContainerAuth> {
  const authMode = options.requested;

  if (authMode === "subscription") {
    const oauthToken = (await getSecret(env, "CLAUDE_CODE_OAUTH_TOKEN", { fresh: true }))?.trim();
    if (!oauthToken) {
      throw new BillingResolutionError(
        "credential-not-configured",
        "The active Claude Subscription credential is not configured.",
      );
    }
    return {
      resolvedAuthMode: "subscription",
      envVars: { CLAUDE_CODE_OAUTH_TOKEN: oauthToken },
    };
  }

  const apiKey = (await getSecret(env, "ANTHROPIC_API_KEY", { fresh: true }))?.trim();
  if (!apiKey) {
    throw new BillingResolutionError(
      "credential-not-configured",
      "The active Claude API credential is not configured.",
    );
  }
  return {
    resolvedAuthMode: "api",
    envVars: { ANTHROPIC_API_KEY: apiKey },
  };
}

export async function resolveCodexContainerAuth(
  env: Env,
  options: {
    authPreference: CodexAuthPreference;
  },
): Promise<ResolvedCodexContainerAuth> {
  const authPreference = options.authPreference;

  if (authPreference === "api-key") {
    const apiKey = (await getSecret(env, "OPENAI_API_KEY", { fresh: true }))?.trim();
    if (!apiKey) {
      throw new BillingResolutionError(
        "credential-not-configured",
        "Codex API key auth requested, but OPENAI_API_KEY is not configured.",
      );
    }
    return {
      resolvedAuthMode: "api-key",
      envVars: { OPENAI_API_KEY: apiKey },
    };
  }

  throw new Error("Codex subscription auth must be launched through app-server runtime auth.");
}

export async function resolveOpenCodeContainerAuth(
  env: Env,
  model: HarnessModelCatalogEntry,
): Promise<ResolvedOpenCodeContainerAuth> {
  if (model.binding.kind !== "opencode") {
    throw new Error(`Model ${model.id} is not an OpenCode model.`);
  }

  switch (model.binding.provider) {
    case "openai":
    case "anthropic": {
      const secretName = model.binding.provider === "openai"
        ? "OPENAI_API_KEY"
        : "ANTHROPIC_API_KEY";
      const apiKey = (await getSecret(env, secretName, { fresh: true }))?.trim();
      if (!apiKey) {
        throw new BillingResolutionError(
          "credential-not-configured",
          `OpenCode ${model.label} requires ${secretName}.`,
        );
      }
      return {
        model: model.binding.model,
        baseUrl: model.binding.baseUrl,
        token: apiKey,
      };
    }
    case "cloudflare-workers-ai": {
      const proxyToken = await getOrCreateSecret(env, OPENCODE_PROXY_TOKEN_KEY, createProxyToken);
      return {
        model: model.binding.model,
        baseUrl: model.binding.baseUrl,
        token: proxyToken,
      };
    }
    default: {
      const unsupportedProvider: never = model.binding.provider;
      throw new Error(`Unsupported OpenCode provider: ${unsupportedProvider}`);
    }
  }
}
