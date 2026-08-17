import { getSecret } from "./setup/config";
import { getReadOnlyStatus as getOpenAIAuthReadOnlyStatus } from "./openai-auth";
import type {
  CodexAuthPreference,
  CodexAuthMode,
  CodexExecutionProfile,
  CodexExecutionResolution,
  CodexRuntimeMode,
  CodexRouteStatus,
  CodexSurface,
  CodexTarget,
  Env,
} from "./types";

export interface CodexBackendReadinessInput {
  backendConnected: boolean;
  authenticationAvailable: boolean;
  runtimeCompatibilityRequired?: boolean;
  runtimeImageCompatible?: boolean;
  runtimeAuthProtocol?: 1;
  environmentConnected?: boolean;
  directApi?: boolean;
}

/** Shared readiness contract for host and Cloudflare runtime adapters. */
export function resolveCodexBackendReadiness(
  input: CodexBackendReadinessInput,
): CodexRouteStatus {
  if (!input.backendConnected) return "backend_offline";
  if (
    input.runtimeCompatibilityRequired
    && (input.runtimeAuthProtocol !== 1 || input.runtimeImageCompatible !== true)
  ) {
    return "runtime_update_required";
  }
  if (input.environmentConnected === false) return "environment_not_connected";
  if (!input.authenticationAvailable) return "authentication_unavailable";
  return input.directApi ? "direct_api" : "available";
}

export type CodexSubscriptionStatus =
  | "missing"
  | "connected"
  | "refreshing"
  | "needs_reconnect"
  | "temporarily_unavailable";

export type ResolveCodexExecutionInput = CodexTarget & {
  surface: CodexSurface;
  authPreference: CodexAuthPreference;
  subscriptionStatus: CodexSubscriptionStatus;
  apiKeyAvailable: boolean;
};

function subscriptionUnavailableReason(
  status: CodexSubscriptionStatus,
): "subscription_missing" | "subscription_needs_reconnect" | "subscription_temporarily_unavailable" | null {
  if (status === "missing") return "subscription_missing";
  if (status === "needs_reconnect") return "subscription_needs_reconnect";
  if (status === "temporarily_unavailable") return "subscription_temporarily_unavailable";
  return null;
}

function apiKeyProfile(
  target: CodexTarget,
  surface: CodexSurface,
): CodexExecutionProfile {
  return surface === "implementor" || surface === "plan-writer"
    ? { ...target, kind: "api-key-app-server", surface }
    : { ...target, kind: "api-key-direct-cli", surface };
}

export function resolveCodexExecution(input: ResolveCodexExecutionInput): CodexExecutionResolution {
  const target: CodexTarget = { backend: input.backend };

  if (input.authPreference === "api-key") {
    return input.apiKeyAvailable
      ? { kind: "ready", profile: apiKeyProfile(target, input.surface) }
      : { kind: "unavailable", reason: "api_key_missing" };
  }

  if (input.subscriptionStatus === "connected" || input.subscriptionStatus === "refreshing") {
    return {
      kind: "ready",
      profile: { ...target, kind: "subscription-app-server", surface: input.surface },
    };
  }

  return {
    kind: "unavailable",
    reason: subscriptionUnavailableReason(input.subscriptionStatus)
      ?? "subscription_temporarily_unavailable",
  };
}

export function codexExecutionAuthMode(profile: CodexExecutionProfile): CodexAuthMode {
  return profile.kind === "subscription-app-server" ? "subscription" : "api-key";
}

export function codexExecutionRuntimeMode(profile: CodexExecutionProfile): CodexRuntimeMode {
  return profile.kind === "api-key-direct-cli" ? "direct-cli" : "app-server";
}

export function codexUnavailableReasonMessage(
  reason: Extract<CodexExecutionResolution, { kind: "unavailable" }>,
): string {
  switch (reason.reason) {
    case "subscription_missing": return "Codex subscription login is not connected.";
    case "subscription_needs_reconnect": return "Codex subscription login needs reconnection.";
    case "subscription_temporarily_unavailable": return "Codex subscription login is temporarily unavailable.";
    case "api_key_missing": return "Codex API key auth requested, but OPENAI_API_KEY is not configured.";
    case "no_usable_credentials": return "No explicit OpenAI billing route is usable for this Codex launch.";
  }
}

export async function resolveCodexExecutionForEnv(
  env: Env,
  input: {
    surface: CodexSurface;
    backend: "cf" | "host";
    authPreference: CodexAuthPreference;
  },
): Promise<CodexExecutionResolution> {
  const target: CodexTarget = { backend: input.backend };

  const directApiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  const readApiKey = async () => directApiKey
    || (await getSecret(env, "OPENAI_API_KEY", { fresh: true }))?.trim()
    || "";

  if (input.authPreference === "api-key") {
    return resolveCodexExecution({
      ...target,
      surface: input.surface,
      authPreference: input.authPreference,
      subscriptionStatus: "missing",
      apiKeyAvailable: Boolean(await readApiKey()),
    });
  }

  const status = await getOpenAIAuthReadOnlyStatus(env);
  const subscriptionStatus: CodexSubscriptionStatus = status.status;
  return resolveCodexExecution({
    ...target,
    surface: input.surface,
    authPreference: input.authPreference,
    subscriptionStatus,
    apiKeyAvailable: false,
  });
}
