export const TEST_WORKERS_DEV_HOSTNAME = "tiller.preview.workers.dev";
export const TEST_MAINTAINER_DEV_HOSTNAME = "tiller-dev.maintainer-preview.workers.dev";

export interface TestAccessBindingOptions {
  hostname?: string;
  issuer?: string;
  audience?: string;
  serviceClientId?: string;
  serviceClientSecret?: string;
  ownerEmail?: string;
  tokenExpiresAt?: string;
}

export function installedAccessBindings(options: TestAccessBindingOptions = {}) {
  return {
    TILLER_INSTALLER_SCHEMA: "1",
    DO_LOCATION_HINT: "wnam",
    TILLER_INSTALLATION_ID: "a".repeat(26),
    TILLER_RELEASE_ID: "b".repeat(40),
    TILLER_WORKERS_DEV_HOSTNAME: options.hostname ?? TEST_WORKERS_DEV_HOSTNAME,
    CF_ACCESS_ISSUER: options.issuer ?? "https://team.cloudflareaccess.com",
    CF_ACCESS_AUDIENCE: options.audience ?? "audience-1",
    CF_ACCESS_IDENTITY_PROVIDER_ID: "identity-provider-1",
    CF_ACCESS_APPLICATION_ID: "application-1",
    CF_ACCESS_OWNER_POLICY_ID: "owner-policy-1", // gitleaks:allow -- inert fixture identifier
    CF_ACCESS_SERVICE_POLICY_ID: "service-policy-1",
    CF_ACCESS_PUBLIC_APPLICATION_ID: "public-application-1",
    CF_ACCESS_PUBLIC_POLICY_ID: "public-policy-1",
    CF_ACCESS_SERVICE_TOKEN_ID: "service-token-1",
    CF_ACCESS_SERVICE_CLIENT_ID: options.serviceClientId ?? "service-client.access",
    CF_ACCESS_TOKEN_EXPIRES_AT: options.tokenExpiresAt ?? "2027-07-16T00:00:00.000Z",
    TILLER_OWNER_EMAIL: options.ownerEmail ?? "owner@example.com",
    CF_ACCESS_SERVICE_CLIENT_SECRET: options.serviceClientSecret ?? "service-secret",
  };
}

export function maintainerDevAccessBindings(options: TestAccessBindingOptions = {}) {
  const bindings = installedAccessBindings({
    ...options,
    hostname: options.hostname ?? TEST_MAINTAINER_DEV_HOSTNAME,
  });
  const { TILLER_INSTALLER_SCHEMA: _installerSchema, ...withoutInstallerSchema } = bindings;
  return {
    ...withoutInstallerSchema,
    TILLER_MAINTAINER_DEV_SCHEMA: "1",
  };
}
