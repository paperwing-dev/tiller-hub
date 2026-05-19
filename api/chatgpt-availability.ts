import { resolveCodexModelRoute, type AvailableCodexModelRoute } from "./model-route";
import { getStatus as getOpenAIAuthStatus } from "./openai-auth";
import type { Env } from "./types";

export interface ChatGPTAvailability {
  configured: boolean;
  available: boolean;
  unavailableReason: string | null;
  gatewayUrl: string | null;
  route: "gateway-subscription" | null;
  codexRoute: AvailableCodexModelRoute | null;
}

export async function resolveChatGPTAvailability(env: Env): Promise<ChatGPTAvailability> {
  const authStatus = await getOpenAIAuthStatus(env);
  const route = await resolveCodexModelRoute(env, { target: "hosted" });

  if (route.kind === "gateway-subscription") {
    return {
      configured: authStatus.authenticated,
      available: true,
      unavailableReason: null,
      gatewayUrl: route.gatewayUrl,
      route: "gateway-subscription",
      codexRoute: route,
    };
  }

  return {
    configured: authStatus.authenticated,
    available: false,
    unavailableReason: authStatus.authenticated
      ? route.reason
      : "Connect ChatGPT in Tiller and keep a Tiller Host gateway online to use hosted ChatGPT planning.",
    gatewayUrl: null,
    route: null,
    codexRoute: null,
  };
}

export async function requireChatGPTAvailability(
  env: Env,
  action = "Codex",
): Promise<ChatGPTAvailability> {
  const availability = await resolveChatGPTAvailability(env);
  if (!availability.available) {
    throw new Error(availability.unavailableReason ?? `${action} is unavailable right now.`);
  }
  return availability;
}
