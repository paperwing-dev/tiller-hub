import { getSecret, resolveDeploymentModeForRuntime } from "./setup/config";
import {
  readRegisteredHostService,
  readRoutableHostService,
} from "./service-registry";
import type { CodexRouteStatus, Env, HostServiceRegistration } from "./types";

const DEFAULT_HOST_GATEWAY_HOSTNAME = "host.docker.internal";
const REQUIRED_CODEX_GATEWAY_AUTH = "session-token";

export type ResolvedCodexModelRoute =
  | {
      kind: "gateway-subscription";
      gatewayUrl: string;
      machineId: string;
      providerBaseUrl: string;
      responsesUrl: string;
      codexRouteStatus: "available";
    }
  | {
      kind: "host-gateway";
      machineId: string;
      providerBaseUrl: string;
      responsesUrl: string;
      codexRouteStatus: "available";
    }
  | {
      kind: "api-fallback";
      openaiApiKey: string;
      codexRouteStatus: "api_fallback";
    }
  | {
      kind: "unavailable";
      reason: string;
      codexRouteStatus: Exclude<CodexRouteStatus, "available" | "api_fallback">;
    };

export type AvailableCodexModelRoute = Exclude<ResolvedCodexModelRoute, { kind: "unavailable" }>;
export type CodexModelRouteTarget = "hosted" | "host";

function gatewayHealthUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/healthz`;
}

export function gatewayCodexResponsesUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/codex/responses`;
}

export function gatewayCodexProviderBaseUrl(gatewayUrl: string): string {
  return `${gatewayUrl.replace(/\/+$/, "")}/v1`;
}

function hostGatewayOrigin(port: number): string {
  return `http://${DEFAULT_HOST_GATEWAY_HOSTNAME}:${port}`;
}

async function buildGatewayAccessHeaders(env: Env): Promise<Headers> {
  const headers = new Headers();
  const clientId = (await getSecret(env, "CF_ACCESS_CLIENT_ID"))?.trim();
  const clientSecret = (await getSecret(env, "CF_ACCESS_CLIENT_SECRET"))?.trim();

  if (clientId && clientSecret) {
    headers.set("CF-Access-Client-Id", clientId);
    headers.set("CF-Access-Client-Secret", clientSecret);
  }

  return headers;
}

interface GatewayHealth {
  ok: boolean;
  supportsSessionTokenAuth: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readCodexGatewayAuth(payload: unknown): string | null {
  if (!isRecord(payload)) return null;

  if (payload.codexGatewayAuth === REQUIRED_CODEX_GATEWAY_AUTH) {
    return REQUIRED_CODEX_GATEWAY_AUTH;
  }

  const capabilities = payload.capabilities;
  if (isRecord(capabilities) && capabilities.codexGatewayAuth === REQUIRED_CODEX_GATEWAY_AUTH) {
    return REQUIRED_CODEX_GATEWAY_AUTH;
  }

  return null;
}

async function checkGatewayHealth(env: Env, gatewayUrl: string): Promise<GatewayHealth> {
  try {
    const response = await fetch(gatewayHealthUrl(gatewayUrl), {
      headers: await buildGatewayAccessHeaders(env),
      signal: AbortSignal.timeout(2500),
    });
    const payload = await response.json().catch(() => null);
    return {
      ok: response.ok,
      supportsSessionTokenAuth: readCodexGatewayAuth(payload) === REQUIRED_CODEX_GATEWAY_AUTH,
    };
  } catch {
    return { ok: false, supportsSessionTokenAuth: false };
  }
}

function supportsSessionTokenGateway(host: HostServiceRegistration): boolean {
  return host.codexGatewayAuth === REQUIRED_CODEX_GATEWAY_AUTH;
}

interface UnavailableCodexModelRoute {
  kind: "unavailable";
  reason: string;
  codexRouteStatus: Exclude<CodexRouteStatus, "available" | "api_fallback">;
}

function unavailableCodexRoute(
  reason: string,
  codexRouteStatus: UnavailableCodexModelRoute["codexRouteStatus"],
): UnavailableCodexModelRoute {
  return {
    kind: "unavailable",
    reason,
    codexRouteStatus,
  };
}

function withoutApiFallbackReason(route: UnavailableCodexModelRoute): UnavailableCodexModelRoute {
  return {
    ...route,
    reason: route.reason.replace(/ or an API key/g, ""),
  };
}

async function resolveHostedGatewayRoute(
  env: Env,
): Promise<Exclude<ResolvedCodexModelRoute, { kind: "api-fallback" }> | null> {
  const registeredHost = await readRegisteredHostService(env);
  const host = await readRoutableHostService(env);
  const deploymentMode = await resolveDeploymentModeForRuntime(env, {
    hostRegistered: Boolean(registeredHost?.machineId?.trim()),
    hostGatewayConfigured: Boolean(registeredHost?.gatewayUrl?.trim()),
  });
  if (deploymentMode !== "self-host") {
    return unavailableCodexRoute(
      "Codex subscription gateway routing is only available in Tiller Self Host mode.",
      "unavailable",
    );
  }

  const gatewayUrl = host?.gatewayUrl?.trim() ?? "";
  if (!host) {
    return unavailableCodexRoute(
      registeredHost?.machineId?.trim()
        ? "Codex requires a connected Tiller Self Host or an API key."
        : "Codex requires a running Subscription Gateway or an API key.",
      "host_offline",
    );
  }

  if (!gatewayUrl) {
    return unavailableCodexRoute(
      "Codex requires a running Subscription Gateway or an API key.",
      "gateway_offline",
    );
  }

  if (host.codexSubscription !== true) {
    return unavailableCodexRoute(
      "Codex requires a Subscription Gateway with subscription support or an API key.",
      "unavailable",
    );
  }

  if (!supportsSessionTokenGateway(host)) {
    return unavailableCodexRoute(
      "Codex requires an updated Subscription Gateway with subscription session-token support.",
      "unavailable",
    );
  }

  const gatewayHealth = await checkGatewayHealth(env, gatewayUrl);
  if (!gatewayHealth.ok) {
    return unavailableCodexRoute(
      "Codex requires a healthy Subscription Gateway or an API key.",
      "gateway_offline",
    );
  }

  if (!gatewayHealth.supportsSessionTokenAuth) {
    return unavailableCodexRoute(
      "Codex requires an updated Subscription Gateway with subscription session-token support.",
      "unavailable",
    );
  }

  return {
    kind: "gateway-subscription",
    gatewayUrl,
    machineId: host.machineId,
    providerBaseUrl: gatewayCodexProviderBaseUrl(gatewayUrl),
    responsesUrl: gatewayCodexResponsesUrl(gatewayUrl),
    codexRouteStatus: "available",
  };
}

async function resolveHostGatewayRoute(
  env: Env,
  machineId?: string | null,
): Promise<Exclude<ResolvedCodexModelRoute, { kind: "api-fallback" }> | null> {
  const registeredHost = await readRegisteredHostService(env, machineId ?? null);
  const host = await readRoutableHostService(env, machineId ?? null);
  if (!host) {
    return unavailableCodexRoute(
      machineId?.trim() || registeredHost?.machineId?.trim()
        ? "Codex requires the selected Tiller Self Host to be connected or an API key."
        : "Codex requires a connected Tiller Self Host or an API key.",
      "host_offline",
    );
  }

  if (!host.gatewayPort) {
    return unavailableCodexRoute(
      "Codex requires a connected Subscription Gateway or an API key.",
      "gateway_offline",
    );
  }

  if (host.codexSubscription !== true) {
    return unavailableCodexRoute(
      "Codex requires a Subscription Gateway with subscription support or an API key.",
      "unavailable",
    );
  }

  if (!supportsSessionTokenGateway(host)) {
    return unavailableCodexRoute(
      "Codex requires an updated Subscription Gateway with subscription session-token support.",
      "unavailable",
    );
  }

  const gatewayUrl = hostGatewayOrigin(host.gatewayPort);
  return {
    kind: "host-gateway",
    machineId: host.machineId,
    providerBaseUrl: gatewayCodexProviderBaseUrl(gatewayUrl),
    responsesUrl: gatewayCodexResponsesUrl(gatewayUrl),
    codexRouteStatus: "available",
  };
}

export async function resolveCodexModelRoute(
  env: Env,
  options?: { target?: CodexModelRouteTarget; machineId?: string | null; allowApiFallback?: boolean },
): Promise<ResolvedCodexModelRoute> {
  const target = options?.target ?? "hosted";
  const gatewayRoute = target === "host"
    ? await resolveHostGatewayRoute(env, options?.machineId ?? null)
    : await resolveHostedGatewayRoute(env);

  if (gatewayRoute && gatewayRoute.kind !== "unavailable") {
    return gatewayRoute;
  }

  if (options?.allowApiFallback !== false) {
    const apiKey = (await getSecret(env, "OPENAI_API_KEY"))?.trim();
    if (apiKey) {
      return {
        kind: "api-fallback",
        openaiApiKey: apiKey,
        codexRouteStatus: "api_fallback",
      };
    }
  }

  const unavailableRoute = gatewayRoute ?? unavailableCodexRoute(
    target === "host"
      ? "Codex requires a connected Subscription Gateway or an API key."
      : "Codex requires a running Subscription Gateway or an API key.",
    target === "host" ? "host_offline" : "gateway_offline",
  );
  return options?.allowApiFallback === false ? withoutApiFallbackReason(unavailableRoute) : unavailableRoute;
}

export async function getGatewayAccessHeaders(env: Env): Promise<Record<string, string>> {
  const headers = await buildGatewayAccessHeaders(env);
  return Object.fromEntries(headers.entries());
}
