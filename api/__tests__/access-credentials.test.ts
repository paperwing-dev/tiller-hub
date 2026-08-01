import { beforeEach, describe, expect, it, vi } from "vitest";
import { readAccessServiceCredential } from "../access/credentials";
import type { Env } from "../types";
import { clearWorkersDevAccessTrustCache } from "../workers-dev-access/records";
import type {
  WorkersDevAccessCredentialV1,
  WorkersDevAccessTrustV1,
} from "../workers-dev-access/types";
import { installedAccessBindings, TEST_WORKERS_DEV_HOSTNAME } from "./access-binding-fixture";

vi.mock("../setup/config", () => ({
  getSecret: async (env: Record<string, unknown>, key: string) => env[key] || undefined,
}));

const trust: WorkersDevAccessTrustV1 = {
  version: 1,
  ownerEmail: "owner@example.com",
  accountId: "",
  workerName: "tiller",
  workersDevHostname: TEST_WORKERS_DEV_HOSTNAME,
  issuer: "https://team.cloudflareaccess.com",
  audience: "audience-1",
  serviceTokenId: "token-1",
  serviceClientId: "service-client.access",
  configuredAt: "2026-07-16T00:00:00.000Z",
};

const credential: WorkersDevAccessCredentialV1 = {
  version: 1,
  currentSecret: "service-secret",
  tokenExpiresAt: "2027-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
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

beforeEach(() => clearWorkersDevAccessTrustCache());

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
