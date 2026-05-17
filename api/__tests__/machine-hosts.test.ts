import { describe, expect, it, vi } from "vitest";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

import { deriveManagedMachineHostnames, resolveManagedMachineHostStatus } from "../machine-hosts";

describe("deriveManagedMachineHostnames", () => {
  it("derives the sibling gateway host from the hub hostname", () => {
    expect(deriveManagedMachineHostnames("https://tiller.paperwing.dev")).toEqual({
      gatewayHostname: "tiller-gateway.paperwing.dev",
    });
  });

  it("returns null hostnames for workers.dev hubs", () => {
    expect(deriveManagedMachineHostnames("https://demo.preview.workers.dev")).toEqual({
      gatewayHostname: null,
    });
  });
});

describe("resolveManagedMachineHostStatus", () => {
  it("reports named tunnel support as unavailable on workers.dev hubs", async () => {
    await expect(resolveManagedMachineHostStatus({} as any, {
      hubUrl: "https://demo.preview.workers.dev",
      routeKind: "workers-dev",
      protectionMode: "public",
      serviceTokenConfigured: false,
      workersDevAliasDisabled: false,
    })).resolves.toMatchObject({
      gatewayHostname: null,
      browserProtected: false,
      gatewayProvisioned: false,
      workersDevCutoverPending: false,
      gatewaySupportAvailable: false,
      gatewaySupportReason: "Switch to Tiller Self Host on a protected custom domain before using the Subscription Gateway.",
    });
  });

  it("derives hostnames but keeps support inactive until sibling hosts are provisioned", async () => {
    await expect(resolveManagedMachineHostStatus({
      CF_ACCESS_APP_ID: "hub-app",
      CF_ACCESS_AUD: "hub-aud",
      CF_ACCESS_BROWSER_POLICY_ID: "browser-policy",
    } as any, {
      hubUrl: "https://tiller.paperwing.dev",
      routeKind: "custom-domain",
      protectionMode: "cf-access",
      serviceTokenConfigured: true,
      workersDevAliasDisabled: false,
    })).resolves.toMatchObject({
      gatewayHostname: "tiller-gateway.paperwing.dev",
      browserProtected: true,
      gatewayProvisioned: false,
      gatewayTunnelConfigured: false,
      workersDevCutoverPending: true,
      gatewaySupportAvailable: false,
      gatewaySupportReason: "The protected Subscription Gateway hostname has not been provisioned yet.",
    });
  });

  it("keeps support inactive until gateway tunnel metadata is persisted", async () => {
    const env = {
      CF_ACCESS_APP_ID: "hub-app",
      CF_ACCESS_AUD: "hub-aud",
      CF_ACCESS_BROWSER_POLICY_ID: "browser-policy",
      TILLER_GATEWAY_HOSTNAME: "tiller-gateway.paperwing.dev",
      CF_ACCESS_GATEWAY_APP_ID: "gateway-app",
      CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: "gateway-policy",
    };

    await expect(resolveManagedMachineHostStatus(env as any, {
      hubUrl: "https://tiller.paperwing.dev",
      routeKind: "custom-domain",
      protectionMode: "cf-access",
      serviceTokenConfigured: true,
      workersDevAliasDisabled: true,
    })).resolves.toMatchObject({
      gatewayHostname: "tiller-gateway.paperwing.dev",
      browserProtected: true,
      gatewayProvisioned: false,
      gatewayTunnelConfigured: false,
      workersDevCutoverPending: false,
      gatewaySupportAvailable: false,
      gatewaySupportReason: "The protected Subscription Gateway tunnel has not been provisioned yet.",
    });
  });

  it("reports named tunnel support once the gateway Access app and tunnel metadata are persisted", async () => {
    const env = {
      CF_ACCESS_APP_ID: "hub-app",
      CF_ACCESS_AUD: "hub-aud",
      CF_ACCESS_BROWSER_POLICY_ID: "browser-policy",
      TILLER_GATEWAY_HOSTNAME: "tiller-gateway.paperwing.dev",
      CF_ACCESS_GATEWAY_APP_ID: "gateway-app",
      CF_ACCESS_GATEWAY_SERVICE_TOKEN_POLICY_ID: "gateway-policy",
      TILLER_GATEWAY_TUNNEL_ID: "tunnel-123",
    };

    await expect(resolveManagedMachineHostStatus(env as any, {
      hubUrl: "https://tiller.paperwing.dev",
      routeKind: "custom-domain",
      protectionMode: "cf-access",
      serviceTokenConfigured: true,
      workersDevAliasDisabled: true,
    })).resolves.toMatchObject({
      gatewayHostname: "tiller-gateway.paperwing.dev",
      browserProtected: true,
      gatewayProvisioned: true,
      gatewayTunnelConfigured: true,
      workersDevCutoverPending: false,
      gatewaySupportAvailable: true,
      gatewaySupportReason: null,
    });
  });
});
