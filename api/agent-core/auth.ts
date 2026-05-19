import type { Env } from "../types";
import { resolveCodexModelRoute, type AvailableCodexModelRoute } from "../model-route";
import type { AgentSpec } from "./types";

export interface ResolvedAgentAuth {
  accessToken: string | null;
  accountId: string | null;
  codexRoute: AvailableCodexModelRoute | null;
}

export async function resolveAgentAuth(
  env: Env,
  spec: AgentSpec,
  preResolvedCodexRoute?: AvailableCodexModelRoute | null,
): Promise<ResolvedAgentAuth> {
  switch (spec.modelTarget.provider) {
    case "external-codex": {
      const route = preResolvedCodexRoute ?? await resolveCodexModelRoute(env);
      if (route.kind === "gateway-subscription" || route.kind === "host-gateway") {
        return {
          accessToken: route.accessToken,
          accountId: route.accountId,
          codexRoute: route,
        };
      }
      if (route.kind === "api-fallback") {
        return {
          accessToken: null,
          accountId: null,
          codexRoute: route,
        };
      }
      throw new Error(route.reason);
    }
    case "workers-ai":
      return {
        accessToken: null,
        accountId: null,
        codexRoute: null,
      };
  }

  const unexpectedProvider: never = spec.modelTarget.provider;
  throw new Error(`Unsupported auth provider: ${unexpectedProvider}`);
}
