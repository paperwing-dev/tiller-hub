import { getValidOpenAIAuth } from "./openai-auth";
import { getSecret } from "./setup/config";
import {
  readRegisteredHostService,
  readRoutableHostService,
} from "./service-registry";
import type { Env } from "./types";

const DEFAULT_HOST_GATEWAY_HOSTNAME = "host.docker.internal";

export type ResolvedCodexModelRoute =
  | {
      kind: "gateway-subscription";
      gatewayUrl: string;
      providerBaseUrl: string;
      responsesUrl: string;
      accessToken: string;
      accountId: string | null;
    }
  | {
      kind: "host-gateway";
      providerBaseUrl: string;
      responsesUrl: string;
      accessToken: string;
      accountId: string | null;
    }
  | {
      kind: "api-fallback";
      openaiApiKey: string;
    }
  | {
      kind: "unavailable";
      reason: string;
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

async function isGatewayHealthy(env: Env, gatewayUrl: string): Promise<boolean> {
  try {
    const response = await fetch(gatewayHealthUrl(gatewayUrl), {
      headers: await buildGatewayAccessHeaders(env),
      signal: AbortSignal.timeout(2500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function resolveHostedGatewayRoute(
  env: Env,
): Promise<ResolvedCodexModelRoute | null> {
  const host = await readRoutableHostService(env);
  const gatewayUrl = host?.gatewayUrl?.trim() ?? "";
  if (!gatewayUrl || host?.codexSubscription !== true) {
    return null;
  }

  try {
    const auth = await getValidOpenAIAuth(env);
    if (await isGatewayHealthy(env, gatewayUrl)) {
      return {
        kind: "gateway-subscription",
        gatewayUrl,
        providerBaseUrl: gatewayCodexProviderBaseUrl(gatewayUrl),
        responsesUrl: gatewayCodexResponsesUrl(gatewayUrl),
        accessToken: auth.access_token,
        accountId: auth.account_id ?? null,
      };
    }
  } catch {
    // Fall through to API fallback when ChatGPT auth is not available.
  }

  return null;
}

async function resolveHostGatewayRoute(
  env: Env,
  machineId?: string | null,
): Promise<ResolvedCodexModelRoute | null> {
  const host = await readRoutableHostService(env, machineId ?? null);
  if (!host || host.codexSubscription !== true || !host.gatewayPort) {
    return null;
  }

  try {
    const auth = await getValidOpenAIAuth(env);
    const gatewayUrl = hostGatewayOrigin(host.gatewayPort);
    return {
      kind: "host-gateway",
      providerBaseUrl: gatewayCodexProviderBaseUrl(gatewayUrl),
      responsesUrl: gatewayCodexResponsesUrl(gatewayUrl),
      accessToken: auth.access_token,
      accountId: auth.account_id ?? null,
    };
  } catch {
    return null;
  }
}

async function resolveHostUnavailableReason(
  env: Env,
  machineId?: string | null,
): Promise<string> {
  const registeredHost = await readRegisteredHostService(env, machineId ?? null);
  const routableHost = await readRoutableHostService(env, machineId ?? null);

  if (!routableHost) {
    return machineId?.trim()
      ? "Codex requires the selected Tiller Host to be connected or an OpenAI API key."
      : "Codex requires a connected Tiller Host or an OpenAI API key.";
  }

  if (!routableHost.gatewayPort) {
    return "Codex requires a connected Tiller Host gateway or an OpenAI API key.";
  }

  if (routableHost.codexSubscription === true || registeredHost?.codexSubscription === true) {
    return "Codex requires ChatGPT auth in Tiller or an OpenAI API key.";
  }

  return "Codex requires a connected Tiller Host gateway or an OpenAI API key.";
}

async function resolveHostedUnavailableReason(env: Env): Promise<string> {
  const registeredHost = await readRegisteredHostService(env);
  const routableHost = await readRoutableHostService(env);

  if (!routableHost?.gatewayUrl) {
    return "Codex requires a running Tiller Host gateway or an OpenAI API key.";
  }

  if (routableHost.codexSubscription === true || registeredHost?.codexSubscription === true) {
    return "Codex requires a running Tiller Host gateway to use the connected subscription, or an OpenAI API key.";
  }

  return "Codex requires a running Tiller Host gateway or an OpenAI API key.";
}

export async function resolveCodexModelRoute(
  env: Env,
  options?: { target?: CodexModelRouteTarget; machineId?: string | null },
): Promise<ResolvedCodexModelRoute> {
  const target = options?.target ?? "hosted";
  const gatewayRoute = target === "host"
    ? await resolveHostGatewayRoute(env, options?.machineId ?? null)
    : await resolveHostedGatewayRoute(env);

  if (gatewayRoute) {
    return gatewayRoute;
  }

  const apiKey = (await getSecret(env, "OPENAI_API_KEY"))?.trim();
  if (apiKey) {
    return {
      kind: "api-fallback",
      openaiApiKey: apiKey,
    };
  }

  return {
    kind: "unavailable",
    reason: target === "host"
      ? await resolveHostUnavailableReason(env, options?.machineId ?? null)
      : await resolveHostedUnavailableReason(env),
  };
}

export async function getGatewayAccessHeaders(env: Env): Promise<Record<string, string>> {
  const headers = await buildGatewayAccessHeaders(env);
  return Object.fromEntries(headers.entries());
}
