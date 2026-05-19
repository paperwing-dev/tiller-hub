import { describe, expect, it } from "vitest";
import { CloudflareApiError, normalizeCloudflareUiError } from "../cloudflare-errors";

describe("normalizeCloudflareUiError", () => {
  it("maps zone lookup misses to a hostname-scoping hint", () => {
    const error = normalizeCloudflareUiError(
      new Error("No accessible Cloudflare zone matched that hostname"),
      "tiller.acme.dev",
    );

    expect(error.code).toBe("hostname_not_in_zone");
    expect(error.status).toBe(403);
    expect(error.missingPermissions).toEqual(["Zone -> Zone -> Read"]);
  });

  it("maps account-level service token permission failures to the correct hint", () => {
    const error = normalizeCloudflareUiError(
      new CloudflareApiError({
        message: "Forbidden",
        status: 403,
        path: "/accounts/acc/access/service_tokens?page=1&per_page=50",
        method: "GET",
      }),
      "tiller.acme.dev",
    );

    expect(error.code).toBe("access_service_tokens_permission_missing");
    expect(error.status).toBe(403);
    expect(error.hint).toMatch(/Access: Service Tokens/);
  });

  it("maps wildcard coverage failures to a conflict response", () => {
    const error = normalizeCloudflareUiError(
      new Error(
        "The requested hostname tiller.acme.dev is already protected by the existing Cloudflare Access wildcard app *.acme.dev. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside *.acme.dev, or update Cloudflare Access so Tiller can own tiller.acme.dev directly.",
      ),
      "tiller.acme.dev",
    );

    expect(error.code).toBe("wildcard_access_unsupported");
    expect(error.status).toBe(409);
    expect(error.error).toContain("tiller.acme.dev");
    expect(error.error).toContain("*.acme.dev");
    expect(error.hint).toBe("Choose a hostname outside *.acme.dev, or update Cloudflare Access so Tiller can own tiller.acme.dev directly.");
  });

  it("maps duplicate precedence errors to a friendlier conflict response", () => {
    const error = normalizeCloudflareUiError(
      new Error("access.api.error.invalid_request: policy precedences must be unique"),
      "tiller.acme.dev",
    );

    expect(error.code).toBe("access_policy_precedence_conflict");
    expect(error.status).toBe(409);
    expect(error.error).toContain("Access policy update");
    expect(error.hint).toContain("remove duplicate or stale policies");
  });
});
