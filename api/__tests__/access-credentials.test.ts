import { describe, expect, it, vi } from "vitest";
import { readAccessServiceCredential } from "../access/credentials";
import type { Env } from "../types";
import type {
  WorkersDevAccessRuntimeCredential,
  WorkersDevAccessRuntimeTrust,
} from "../workers-dev-access/types";
import { installedAccessBindings, TEST_WORKERS_DEV_HOSTNAME } from "./access-binding-fixture";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

const trust: WorkersDevAccessRuntimeTrust = {
  ownerEmail: "owner@example.com",
  workersDevHostname: TEST_WORKERS_DEV_HOSTNAME,
  issuer: "https://team.cloudflareaccess.com",
  audience: "audience-1",
  serviceClientId: "service-client.access",
};

const credential: WorkersDevAccessRuntimeCredential = {
  currentSecret: "service-secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
};

function canonicalEnv(): Env {
  return {
    ...installedAccessBindings({
      hostname: trust.workersDevHostname,
      issuer: trust.issuer,
      audience: trust.audience,
      serviceClientId: trust.serviceClientId,
      serviceClientSecret: credential.currentSecret,
      ownerEmail: trust.ownerEmail,
      tokenExpiresAt: credential.tokenExpiresAt,
    }),
  } as unknown as Env;
}

describe("outbound Cloudflare Access credentials", () => {
  it("reads the canonical workers.dev credential fresh without stripping headers", async () => {
    await expect(readAccessServiceCredential(
      canonicalEnv(),
      `https://${TEST_WORKERS_DEV_HOSTNAME}`,
    )).resolves.toEqual({
      clientId: "service-client.access",
      clientSecret: "service-secret",
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });
  });

  it("does not reuse canonical trust for a different workers.dev hostname", async () => {
    await expect(readAccessServiceCredential(
      canonicalEnv(),
      "https://other.preview.workers.dev",
    )).resolves.toBeNull();
  });

  it("does not use the canonical credential for a custom-domain origin", async () => {
    await expect(readAccessServiceCredential(
      canonicalEnv(),
      "https://tiller.example.com",
    )).resolves.toBeNull();
  });
});
