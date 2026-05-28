import type { Env } from "./types";
import type { ProtectionState } from "./protection";
import { getSecret } from "./setup/config";

function trimOptional(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function deriveSiblingHostname(hubUrl: string, prefix: string): string | null {
  try {
    const hostname = new URL(hubUrl).hostname.trim().toLowerCase();
    if (!hostname || hostname.endsWith(".workers.dev")) return null;
    const labels = hostname.split(".");
    if (labels.length < 2) return null;
    return `${prefix}.${labels.slice(1).join(".")}`;
  } catch {
    return null;
  }
}

export interface ManagedMachineHostnames {
  gatewayHostname: string | null;
}

export interface ManagedMachineHostStatus extends ManagedMachineHostnames {
  derivedGatewayHostname: string | null;
  browserProtected: boolean;
  gatewayProvisioned: boolean;
  gatewayTunnelConfigured: boolean;
  gatewaySupportAvailable: boolean;
  gatewaySupportReason: string | null;
  workersDevCutoverPending: boolean;
}

export function deriveManagedMachineHostnames(hubUrl: string): ManagedMachineHostnames {
  return {
    gatewayHostname: deriveSiblingHostname(hubUrl, "tiller-gateway"),
  };
}

export async function resolveManagedMachineHostStatus(
  env: Env,
  protection: Pick<
    ProtectionState,
    "hubUrl" | "routeKind" | "protectionMode" | "serviceTokenConfigured" | "workersDevAliasDisabled"
  >,
): Promise<ManagedMachineHostStatus> {
  const derived = deriveManagedMachineHostnames(protection.hubUrl);
  const gatewayHostname = trimOptional(await getSecret(env, "TILLER_GATEWAY_HOSTNAME")) ?? derived.gatewayHostname;
  const browserProtected = Boolean(
    protection.protectionMode === "cf-access"
      && (
        protection.routeKind === "workers-dev"
        || (
          trimOptional(await getSecret(env, "CF_ACCESS_APP_ID"))
          && trimOptional(await getSecret(env, "CF_ACCESS_AUD"))
          && trimOptional(await getSecret(env, "CF_ACCESS_BROWSER_POLICY_ID"))
        )
      ),
  );
  const gatewayConfigured = Boolean(
    gatewayHostname
      && trimOptional(await getSecret(env, "CF_ACCESS_GATEWAY_APP_ID"))
      && trimOptional(await getSecret(env, "CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID")),
  );
  const gatewayTunnelConfigured = Boolean(
    gatewayHostname
      && trimOptional(await getSecret(env, "TILLER_GATEWAY_TUNNEL_ID")),
  );
  const gatewayProvisioned = gatewayConfigured && gatewayTunnelConfigured;
  const workersDevCutoverPending = protection.routeKind === "custom-domain" && !protection.workersDevAliasDisabled;

  let gatewaySupportReason: string | null = null;
  if (protection.routeKind === "workers-dev") {
    gatewaySupportReason = "Switch to Tiller Self Host on a protected custom domain before using the Subscription Gateway.";
  } else if (!browserProtected) {
    gatewaySupportReason = "Enable Cloudflare Access on the custom hub domain before using the Subscription Gateway.";
  } else if (!protection.serviceTokenConfigured) {
    gatewaySupportReason = "Reissue the Tiller Self Host service token before using the Subscription Gateway.";
  } else if (!gatewayConfigured) {
    gatewaySupportReason = "The protected Subscription Gateway hostname has not been provisioned yet.";
  } else if (!gatewayTunnelConfigured) {
    gatewaySupportReason = "The protected Subscription Gateway tunnel has not been provisioned yet.";
  }

  return {
    gatewayHostname,
    derivedGatewayHostname: derived.gatewayHostname,
    browserProtected,
    gatewayProvisioned,
    gatewayTunnelConfigured,
    gatewaySupportAvailable: gatewaySupportReason == null,
    gatewaySupportReason,
    workersDevCutoverPending,
  };
}
