import { resolveCodexModelRoute, type AvailableCodexModelRoute } from "./model-route";
import { getStatus as getOpenAIAuthStatus } from "./openai-auth";
import type { CodexRouteStatus, Env } from "./types";

export interface ChatGPTAvailability {
  configured: boolean;
  available: boolean;
  unavailableReason: string | null;
  codexRouteStatus: CodexRouteStatus;
  gatewayUrl: string | null;
  route: "gateway-subscription" | "api-fallback" | null;
  codexRoute: AvailableCodexModelRoute | null;
}

export async function resolveChatGPTAvailability(env: Env): Promise<ChatGPTAvailability> {
  const authStatus = await getOpenAIAuthStatus(env);
  const route = await resolveCodexModelRoute(env);

  if (route.kind === "gateway-subscription" && authStatus.authenticated) {
    return {
      configured: authStatus.authenticated,
      available: true,
      unavailableReason: null,
      codexRouteStatus: "available",
      gatewayUrl: route.gatewayUrl,
      route: "gateway-subscription",
      codexRoute: route,
    };
  }

  if (route.kind === "api-fallback") {
    return {
      configured: true,
      available: true,
      unavailableReason: null,
      codexRouteStatus: "api_fallback",
      gatewayUrl: null,
      route: "api-fallback",
      codexRoute: route,
    };
  }

  const authMissingReason = "Import a Codex subscription login in Tiller Self Host and keep the Subscription Gateway online to use the subscription-backed OpenAI planner.";
  const unavailableReason = authStatus.authenticated && route.kind === "unavailable"
    ? route.reason
    : !authStatus.authenticated
      ? authMissingReason
      : "The OpenAI planner is unavailable right now.";

  return {
    configured: authStatus.authenticated,
    available: false,
    unavailableReason,
    codexRouteStatus: route.codexRouteStatus,
    gatewayUrl: null,
    route: null,
    codexRoute: null,
  };
}
