import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  allocateAccessPolicyPrecedence,
  assertNoUnsupportedWildcardCoverage,
  cleanupSupersededManagedHubAccess,
  findExactAndWildcardApps,
  provisionWorkersDevBrowserAccess,
} from "../access/manage";

vi.mock("../access/cloudflare-api", () => ({
  deleteAccessApp: vi.fn(async () => undefined),
  deleteAccessPolicy: vi.fn(async () => undefined),
  deleteServiceToken: vi.fn(async () => undefined),
  listAccessApps: vi.fn(),
  listAccessPolicies: vi.fn(),
  createAccessApp: vi.fn(),
  createAccessEmailPolicy: vi.fn(),
  createAccessServiceTokenPolicy: vi.fn(),
  createServiceToken: vi.fn(),
  getAccessOrganization: vi.fn(async () => ({ auth_domain: "team.cloudflareaccess.com" })),
  updateAccessEmailPolicy: vi.fn(),
}));

import {
  createAccessApp,
  createAccessEmailPolicy,
  deleteAccessApp,
  deleteAccessPolicy,
  listAccessApps,
  listAccessPolicies,
  updateAccessEmailPolicy,
} from "../access/cloudflare-api";

const mockedCreateAccessApp = vi.mocked(createAccessApp);
const mockedCreateAccessEmailPolicy = vi.mocked(createAccessEmailPolicy);
const mockedDeleteAccessApp = vi.mocked(deleteAccessApp);
const mockedListAccessApps = vi.mocked(listAccessApps);
const mockedListAccessPolicies = vi.mocked(listAccessPolicies);
const mockedUpdateAccessEmailPolicy = vi.mocked(updateAccessEmailPolicy);

describe("findExactAndWildcardApps", () => {
  it("reports both the exact-host app and the covering wildcard", () => {
    const result = findExactAndWildcardApps("tiller.acme.dev", [
      { id: "wild", domain: "*.acme.dev" },
      { id: "exact", domain: "tiller.acme.dev" },
    ]);

    expect(result.exactApp?.id).toBe("exact");
    expect(result.overlappingWildcardApp?.id).toBe("wild");
  });

  it("chooses the most specific wildcard app when multiple wildcards match", () => {
    const result = findExactAndWildcardApps("tiller.tools.acme.dev", [
      { id: "broad", domain: "*.acme.dev" },
      { id: "narrow", domain: "*.tools.acme.dev" },
    ]);

    expect(result.exactApp).toBeNull();
    expect(result.overlappingWildcardApp?.id).toBe("narrow");
  });

  it("does not treat the bare zone as matching a wildcard subdomain app", () => {
    const result = findExactAndWildcardApps("acme.dev", [
      { id: "wild", domain: "*.acme.dev" },
    ]);

    expect(result.exactApp).toBeNull();
    expect(result.overlappingWildcardApp).toBeNull();
  });
});

describe("assertNoUnsupportedWildcardCoverage", () => {
  it("throws when a wildcard app covers the hostname", () => {
    expect(() =>
      assertNoUnsupportedWildcardCoverage("tiller.acme.dev", {
        exactApp: null,
        overlappingWildcardApp: { id: "wild", domain: "*.acme.dev" },
      }),
    ).toThrow(
      "The requested hostname tiller.acme.dev is already protected by the existing Cloudflare Access wildcard app *.acme.dev. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside *.acme.dev, or update Cloudflare Access so Tiller can own tiller.acme.dev directly.",
    );
  });

  it("allows hostnames without wildcard coverage", () => {
    expect(() =>
      assertNoUnsupportedWildcardCoverage("tiller.acme.dev", {
        exactApp: { id: "exact", domain: "tiller.acme.dev" },
        overlappingWildcardApp: null,
      }),
    ).not.toThrow();
  });
});

describe("allocateAccessPolicyPrecedence", () => {
  it("uses the preferred precedence when it is free", () => {
    expect(allocateAccessPolicyPrecedence([{ precedence: 50 }, { precedence: 150 }], 100)).toBe(100);
  });

  it("moves to the next free precedence when the preferred slot is already used", () => {
    expect(
      allocateAccessPolicyPrecedence(
        [{ precedence: 100 }, { precedence: 101 }, { precedence: 200 }],
        100,
      ),
    ).toBe(102);
  });

  it("treats numeric string precedences as occupied slots", () => {
    expect(
      allocateAccessPolicyPrecedence(
        [{ precedence: "100" }, { precedence: "101" }, { precedence: 200 }],
        100,
      ),
    ).toBe(102);
  });
});

describe("provisionWorkersDevBrowserAccess", () => {
  beforeEach(() => {
    mockedCreateAccessApp.mockReset();
    mockedCreateAccessEmailPolicy.mockReset();
    mockedDeleteAccessApp.mockReset();
    mockedListAccessApps.mockReset();
    mockedListAccessPolicies.mockReset();
    mockedUpdateAccessEmailPolicy.mockReset();
    mockedDeleteAccessApp.mockResolvedValue(undefined);
  });

  it("creates an exact workers.dev Access app and browser policy without service tokens", async () => {
    mockedListAccessApps.mockResolvedValue([]);
    mockedCreateAccessApp.mockResolvedValue({
      id: "app-123",
      aud: "aud-123",
      domain: "demo.preview.workers.dev",
    });
    mockedListAccessPolicies.mockResolvedValue([]);
    mockedCreateAccessEmailPolicy.mockResolvedValue({
      id: "policy-123",
      name: "Allow hub users",
      precedence: 100,
      decision: "allow",
    });

    const result = await provisionWorkersDevBrowserAccess({
      apiToken: "token",
      accountId: "account-123",
      hostname: "demo.preview.workers.dev",
      emails: ["user@example.com"],
    });

    expect(mockedCreateAccessApp).toHaveBeenCalledWith("token", "account-123", {
      domain: "demo.preview.workers.dev",
      name: "Tiller Hub (demo.preview.workers.dev)",
    });
    expect(mockedCreateAccessEmailPolicy).toHaveBeenCalledWith("token", "account-123", "app-123", {
      name: "Allow hub users",
      emails: ["user@example.com"],
      precedence: 100,
    });
    expect(result).toMatchObject({
      accountId: "account-123",
      hostname: "demo.preview.workers.dev",
      app: { id: "app-123", aud: "aud-123" },
      browserPolicy: { id: "policy-123" },
    });
  });

  it("updates the existing managed browser policy instead of creating duplicates", async () => {
    mockedListAccessApps.mockResolvedValue([
      { id: "app-123", aud: "aud-123", domain: "demo.preview.workers.dev" },
    ]);
    mockedListAccessPolicies.mockResolvedValue([
      {
        id: "policy-123",
        name: "Allow hub users",
        precedence: 104,
        decision: "allow",
      },
    ]);
    mockedUpdateAccessEmailPolicy.mockResolvedValue({
      id: "policy-123",
      name: "Allow hub users",
      precedence: 104,
      decision: "allow",
    });

    await provisionWorkersDevBrowserAccess({
      apiToken: "token",
      accountId: "account-123",
      hostname: "demo.preview.workers.dev",
      emails: ["new@example.com"],
    });

    expect(mockedCreateAccessApp).not.toHaveBeenCalled();
    expect(mockedCreateAccessEmailPolicy).not.toHaveBeenCalled();
    expect(mockedUpdateAccessEmailPolicy).toHaveBeenCalledWith(
      "token",
      "account-123",
      "app-123",
      "policy-123",
      {
        name: "Allow hub users",
        emails: ["new@example.com"],
        precedence: 104,
      },
    );
  });

  it("does not modify an existing wildcard app that covers the route", async () => {
    mockedListAccessApps.mockResolvedValue([
      { id: "wild", aud: "wild-aud", domain: "*.preview.workers.dev" },
    ]);

    const result = await provisionWorkersDevBrowserAccess({
      apiToken: "token",
      accountId: "account-123",
      hostname: "demo.preview.workers.dev",
      emails: ["user@example.com"],
    });

    expect(mockedCreateAccessApp).not.toHaveBeenCalled();
    expect(mockedCreateAccessEmailPolicy).not.toHaveBeenCalled();
    expect(mockedUpdateAccessEmailPolicy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      app: { id: "wild" },
      appDomain: "*.preview.workers.dev",
      browserPolicy: null,
      overlappingWildcardApp: { id: "wild" },
    });
  });

  it("deletes a newly created Access app when policy creation fails", async () => {
    mockedListAccessApps.mockResolvedValue([]);
    mockedCreateAccessApp.mockResolvedValue({
      id: "app-123",
      aud: "aud-123",
      domain: "demo.preview.workers.dev",
    });
    mockedListAccessPolicies.mockResolvedValue([]);
    mockedCreateAccessEmailPolicy.mockRejectedValue(new Error("policy failed"));

    await expect(
      provisionWorkersDevBrowserAccess({
        apiToken: "token",
        accountId: "account-123",
        hostname: "demo.preview.workers.dev",
        emails: ["user@example.com"],
      }),
    ).rejects.toThrow("policy failed");

    expect(mockedDeleteAccessApp).toHaveBeenCalledWith("token", "account-123", "app-123");
  });
});

describe("cleanupSupersededManagedHubAccess", () => {
  it("does not delete the previous browser policy when no new browser policy was created", async () => {
    await cleanupSupersededManagedHubAccess("token", {
      accountId: "acc-123",
      hostname: "tiller.paperwing.dev",
      app: { id: "hub-app", aud: "hub-aud" },
      appDomain: "tiller.paperwing.dev",
      browserPolicy: null,
      serviceToken: {
        id: "service-token",
        client_id: "client-id",
        client_secret: "client-secret",
      },
      serviceTokenPolicy: { id: "service-policy" },
      previousAppId: null,
      previousBrowserPolicyId: "browser-policy",
      previousServiceTokenId: null,
      previousServiceTokenPolicyId: null,
      cleanupDraftResources: async () => undefined,
    });

    expect(deleteAccessPolicy).not.toHaveBeenCalledWith(
      "token",
      "acc-123",
      "hub-app",
      "browser-policy",
    );
  });
});
