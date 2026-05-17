import { describe, expect, it } from "vitest";
import {
  LEGACY_GATEWAY_TUNNEL_TOKEN_KEY,
  parseSelfHostState,
  rollbackConfigEntries,
  type SelfHostRollbackConfig,
} from "../self-host/state";

describe("Self Host state parsing", () => {
  it("treats legacy setup sessions as absent", () => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      attemptId: "old-attempt",
      status: "promoted",
      pendingAccess: { clientSecret: "old-secret" },
    });

    expect(parseSelfHostState(legacy)).toBeNull();
    expect(parseSelfHostState("{not-json")).toBeNull();
  });

  it("preserves valid setup progress", () => {
    const state = {
      schemaVersion: 2,
      phase: "enabled",
      attemptId: "attempt-1",
      rollback: {
        workersDevHubUrl: "https://demo.preview.workers.dev",
        workerServiceName: "tiller",
        workersDevAliasDisabled: "false",
        cfAccessConfigured: "true",
        browserAccess: {
          appId: "workers-app",
          aud: "workers-aud",
          issuer: "https://workers.cloudflareaccess.com",
          jwksUrl: "https://workers.cloudflareaccess.com/cdn-cgi/access/certs",
          appDomain: "demo.preview.workers.dev",
          appType: null,
          overlappingWildcardAppDomain: null,
          browserPolicyId: "workers-browser-policy",
        },
      },
      resources: {
        workerCustomDomain: {
          hostname: "tiller.example.com",
          hubUrl: "https://tiller.example.com",
          service: "tiller",
          zoneName: "example.com",
          accountId: "acc-1",
          zoneId: "zone-1",
          domainId: "domain-1",
        },
        hubAccess: {
          appId: "hub-app",
          aud: "hub-aud",
          appDomain: "tiller.example.com",
          issuer: "https://team.cloudflareaccess.com",
          jwksUrl: "https://team.cloudflareaccess.com/cdn-cgi/access/certs",
          accessTeamDomain: "team.cloudflareaccess.com",
          browserPolicyId: "browser-policy",
          serviceTokenId: "service-token",
          serviceTokenPolicyId: "service-policy",
          clientId: "client-id.access",
        },
        gateway: {
          hostname: "tiller-gateway.example.com",
          appId: "gateway-app",
          appDomain: "tiller-gateway.example.com",
          serviceTokenPolicyId: "gateway-policy",
          tunnelId: "tunnel-1",
          tunnelName: "tiller-gateway-abcd1234",
          tunnelTargetPort: 8788,
        },
      },
      progress: {
        step: "complete",
        message: "Tiller Self Host is enabled.",
        updatedAt: "2026-05-27T00:00:00.000Z",
      },
    };

    expect(parseSelfHostState(JSON.stringify(state))?.progress).toEqual(state.progress);
  });

  it("rejects malformed setup progress", () => {
    const state = {
      schemaVersion: 2,
      phase: "enabled",
      attemptId: "attempt-1",
      rollback: {
        workersDevHubUrl: "https://demo.preview.workers.dev",
        browserAccess: { aud: "workers-aud" },
      },
      resources: {
        workerCustomDomain: {
          hostname: "tiller.example.com",
          hubUrl: "https://tiller.example.com",
          service: "tiller",
          zoneName: "example.com",
          accountId: "acc-1",
          zoneId: "zone-1",
          domainId: "domain-1",
        },
        hubAccess: {
          appId: "hub-app",
          aud: "hub-aud",
          appDomain: "tiller.example.com",
          issuer: "https://team.cloudflareaccess.com",
          jwksUrl: null,
          accessTeamDomain: "team.cloudflareaccess.com",
          browserPolicyId: null,
          serviceTokenId: "service-token",
          serviceTokenPolicyId: "service-policy",
          clientId: "client-id.access",
        },
        gateway: {
          hostname: "tiller-gateway.example.com",
          appId: "gateway-app",
          appDomain: "tiller-gateway.example.com",
          serviceTokenPolicyId: "gateway-policy",
          tunnelId: "tunnel-1",
          tunnelName: "tiller-gateway-abcd1234",
          tunnelTargetPort: 8788,
        },
      },
      progress: {
        step: "resources",
        message: "Bad progress",
        updatedAt: "2026-05-27T00:00:00.000Z",
      },
    };

    expect(parseSelfHostState(JSON.stringify(state))).toBeNull();
  });

  it("restores only explicit workers.dev rollback and non-secret custom-domain clears", () => {
    const rollback: SelfHostRollbackConfig = {
      workersDevHubUrl: "https://demo.preview.workers.dev",
      workerServiceName: "tiller",
      workersDevAliasDisabled: "false",
      cfAccessConfigured: "true",
      browserAccess: {
        appId: "workers-app",
        aud: "workers-aud",
        issuer: "https://workers.cloudflareaccess.com",
        jwksUrl: "https://workers.cloudflareaccess.com/cdn-cgi/access/certs",
        appDomain: "demo.preview.workers.dev",
        appType: null,
        overlappingWildcardAppDomain: null,
        browserPolicyId: "workers-browser-policy",
      },
    };

    const entries = rollbackConfigEntries(rollback);
    expect(entries).toMatchObject({
      HUB_PUBLIC_URL: "https://demo.preview.workers.dev",
      TILLER_DEPLOYMENT_MODE: "hosted",
      CF_ACCESS_AUD: "workers-aud",
      CF_ACCESS_CLIENT_SECRET: null,
      TILLER_GATEWAY_TUNNEL_ID: null,
      [LEGACY_GATEWAY_TUNNEL_TOKEN_KEY]: null,
    });
    expect(entries).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(entries).not.toHaveProperty("OPENAI_API_KEY");
  });
});
