import { deriveManagedMachineHostnames } from "../machine-hosts";
import {
  buildPersistedManagedAccessConfig,
  buildPersistedManagedServiceHostAccessConfig,
  prepareManagedExactHostAccess,
  prepareManagedServiceHostAccess,
  provisionManagedGatewayTunnel,
} from "../access/manage";
import { detachWorkerCustomDomain, ensureWorkerCustomDomain } from "../setup/cloudflare";
import type { Env } from "../types";
import {
  accessCertsUrl,
  type SelfHostResources,
} from "./state";

export interface PreparedSelfHostResources {
  customHubUrl: string;
  gatewayHostname: string;
  resources: SelfHostResources;
  clientSecret: string;
  tunnelToken: string;
  cleanupDraftResources(): Promise<void>;
}

export async function prepareSelfHostResources(input: {
  env: Env;
  requestUrl: string;
  apiToken: string;
  hostname: string;
  emails: string[];
}): Promise<PreparedSelfHostResources> {
  const connected = await ensureWorkerCustomDomain(input.env, input.requestUrl, input.apiToken, input.hostname);
  let preparedHub: Awaited<ReturnType<typeof prepareManagedExactHostAccess>> | null = null;
  let preparedGateway: Awaited<ReturnType<typeof prepareManagedServiceHostAccess>> | null = null;

  const cleanupDraftResources = async () => {
    await preparedGateway?.cleanupDraftResources().catch(() => {});
    await preparedHub?.cleanupDraftResources().catch(() => {});
    if (connected.attachedNow) {
      await detachWorkerCustomDomain(input.apiToken, connected.accountId, connected.domainId).catch(() => {});
    }
  };

  try {
    const managedHosts = deriveManagedMachineHostnames(connected.hubUrl);
    preparedHub = await prepareManagedExactHostAccess(input.env, {
      apiToken: input.apiToken,
      accountId: connected.accountId,
      hostname: connected.hostname,
      emails: input.emails,
      reuseExistingServiceToken: false,
    });
    const persistedHub = buildPersistedManagedAccessConfig(preparedHub);

    preparedGateway = await prepareManagedServiceHostAccess(input.env, {
      apiToken: input.apiToken,
      accountId: connected.accountId,
      hostname: managedHosts.gatewayHostname,
      serviceTokenId: preparedHub.serviceToken.id,
    });
    const gatewayTunnel = await provisionManagedGatewayTunnel(input.env, {
      apiToken: input.apiToken,
      accountId: connected.accountId,
      zoneId: connected.zoneId,
      hostname: preparedGateway.hostname,
      forceFreshTunnel: true,
    });
    const persistedGateway = buildPersistedManagedServiceHostAccessConfig(preparedGateway, gatewayTunnel);
    const issuer = `https://${preparedHub.accessTeamDomain}`;

    return {
      customHubUrl: connected.hubUrl,
      gatewayHostname: persistedGateway.hostname,
      clientSecret: persistedHub.clientSecret,
      tunnelToken: gatewayTunnel.tunnelToken,
      resources: {
        workerCustomDomain: {
          hostname: connected.hostname,
          hubUrl: connected.hubUrl,
          service: connected.service,
          zoneName: connected.zoneName,
          accountId: connected.accountId,
          zoneId: connected.zoneId,
          domainId: connected.domainId,
        },
        hubAccess: {
          appId: persistedHub.appId,
          aud: persistedHub.appAud,
          appDomain: persistedHub.appDomain,
          issuer,
          jwksUrl: accessCertsUrl(issuer),
          accessTeamDomain: preparedHub.accessTeamDomain,
          browserPolicyId: persistedHub.browserPolicyId,
          serviceTokenId: persistedHub.serviceTokenId,
          serviceTokenPolicyId: persistedHub.serviceTokenPolicyId,
          clientId: persistedHub.clientId,
        },
        gateway: {
          hostname: persistedGateway.hostname,
          appId: persistedGateway.appId,
          appDomain: persistedGateway.appDomain,
          serviceTokenPolicyId: persistedGateway.serviceTokenPolicyId,
          tunnelId: persistedGateway.tunnelId,
          tunnelName: persistedGateway.tunnelName,
          tunnelTargetPort: persistedGateway.tunnelTargetPort,
        },
      },
      cleanupDraftResources,
    };
  } catch (error) {
    await cleanupDraftResources();
    throw error;
  }
}
