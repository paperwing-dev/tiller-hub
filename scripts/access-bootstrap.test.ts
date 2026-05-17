import { describe, expect, it } from "vitest";
import {
  normalizeScriptCloudflareError,
  ensureProtectedCustomDomain,
  probeHubState,
  ScriptCloudflareApiError,
  verifyBootstrapAccess,
  waitForHubAvailability,
} from "./access-bootstrap.mjs";

describe("waitForHubAvailability", () => {
  it("treats 401 as protected even when stale headers were supplied", async () => {
    const state = await waitForHubAvailability(
      "https://tiller.example.com",
      { "CF-Access-Client-Id": "stale-id", "CF-Access-Client-Secret": "stale-secret" },
      {
        fetchImpl: async () => new Response("denied", { status: 401 }),
      },
    );

    expect(state).toBe("protected");
  });

  it("reports DNS failures through the retry callback", async () => {
    const messages = [];

    await expect(
      waitForHubAvailability(
        "https://tiller.example.com",
        {},
        {
          attempts: 2,
          delayMs: 0,
          sleep: async () => {},
          resolveViaPublicDnsImpl: async () => [],
          onRetry: ({ message }) => {
            messages.push(message);
          },
          fetchImpl: async () => {
            throw new Error("getaddrinfo ENOTFOUND tiller.example.com");
          },
        },
      ),
    ).rejects.toThrow(/DNS for tiller\.example\.com is not resolvable on public DNS yet/i);

    expect(messages).toEqual(["DNS for tiller.example.com is not resolvable on public DNS yet."]);
  });

  it("falls back to public DNS edge probes when the local resolver is stale", async () => {
    const fetchFailed = new TypeError("fetch failed");
    Object.assign(fetchFailed, {
      cause: {
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND tiller.example.com",
      },
    });

    const state = await waitForHubAvailability(
      "https://tiller.example.com",
      {},
      {
        attempts: 2,
        delayMs: 0,
        sleep: async () => {
          throw new Error("should not retry");
        },
        resolveViaPublicDnsImpl: async () => ["104.21.24.4", "172.67.215.65"],
        probeViaResolvedAddressImpl: async (_hubUrl, _headers, address) => ({
          status: address === "104.21.24.4" ? 302 : 525,
        }),
        fetchImpl: async () => {
          throw fetchFailed;
        },
      },
    );

    expect(state).toBe("protected");
  });
});

describe("probeHubState", () => {
  it("reports protected when the hub responds with 403", async () => {
    const state = await probeHubState(
      "https://tiller.example.com",
      {},
      {
        fetchImpl: async () => new Response("denied", { status: 403 }),
      },
    );

    expect(state).toBe("protected");
  });
});

describe("verifyBootstrapAccess", () => {
  it("fails early when the token cannot list Access apps", async () => {
    await expect(
      verifyBootstrapAccess("cfat_test", "tiller.example.com", {
        fetchImpl: async (url) => {
          if (String(url).includes("/zones?")) {
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ name: "example.com", account: { id: "acc-1" } }],
              }),
              { status: 200 },
            );
          }

          return new Response(
            JSON.stringify({
              success: false,
              errors: [{ message: "Authentication error" }],
            }),
            { status: 401 },
          );
        },
      }),
    ).rejects.toThrow(/Authentication error/);
  });

  it("rejects wildcard-covered hostnames", async () => {
    await expect(
      verifyBootstrapAccess("cfat_test", "tiller.acme.dev", {
        fetchImpl: async (url) => {
          if (String(url).includes("/zones?")) {
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ name: "acme.dev", account: { id: "acc-1" } }],
              }),
              { status: 200 },
            );
          }

          if (String(url).includes("/access/apps")) {
            return new Response(
              JSON.stringify({
                success: true,
                result: [{ id: "wild", domain: "*.acme.dev" }],
              }),
              { status: 200 },
            );
          }

          return new Response(
            JSON.stringify({
              success: true,
              result: [],
            }),
            { status: 200 },
          );
        },
      }),
    ).rejects.toThrow(
      "The requested hostname tiller.acme.dev is already protected by the existing Cloudflare Access wildcard app *.acme.dev. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside *.acme.dev, or update Cloudflare Access so Tiller can own tiller.acme.dev directly.",
    );
  });
});

describe("normalizeScriptCloudflareError", () => {
  it("turns Access app authentication failures into a permission hint", () => {
    const message = normalizeScriptCloudflareError(
      new ScriptCloudflareApiError({
        message: "Authentication error",
        status: 401,
        path: "/accounts/acc-1/access/apps?page=1&per_page=50",
        method: "GET",
      }),
      "tiller.example.com",
    );

    expect(message).toMatch(/Access apps or policies/);
    expect(message).toMatch(/Scope Account, Permission Access: Apps and Policies, Access Edit/);
    expect(message).toMatch(/tiller\.example\.com/);
  });

  it("preserves detailed wildcard coverage failures for arbitrary domains", () => {
    const message = normalizeScriptCloudflareError(
      new Error(
        "The requested hostname console.northwind.dev is already protected by the existing Cloudflare Access wildcard app *.northwind.dev. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside *.northwind.dev, or update Cloudflare Access so Tiller can own console.northwind.dev directly.",
      ),
      "console.northwind.dev",
    );

    expect(message).toBe(
      "The requested hostname console.northwind.dev is already protected by the existing Cloudflare Access wildcard app *.northwind.dev. Tiller only supports exact hosts that it can protect with its own dedicated Access app. Choose a hostname outside *.northwind.dev, or update Cloudflare Access so Tiller can own console.northwind.dev directly.",
    );
  });
});

describe("ensureProtectedCustomDomain", () => {
  it("falls back to public DNS when local DNS cannot resolve the custom domain", async () => {
    const fetchFailed = new TypeError("fetch failed");
    Object.assign(fetchFailed, {
      cause: {
        code: "ENOTFOUND",
        message: "getaddrinfo ENOTFOUND tiller.example.com",
      },
    });

    const result = await ensureProtectedCustomDomain(
      "https://tiller.example.com",
      {
        apiToken: "cfat_test",
        emails: ["owner@example.com"],
      },
      {
        fetchImpl: async () => {
          throw fetchFailed;
        },
        resolveViaPublicDnsImpl: async () => ["104.21.24.4"],
        fetchViaResolvedAddressImpl: async () =>
          new Response(
            JSON.stringify({
              ok: true,
              hostname: "tiller.example.com",
              appDomain: "tiller.example.com",
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      },
    );

    expect(result).toEqual({
      ok: true,
      hostname: "tiller.example.com",
      appDomain: "tiller.example.com",
    });
  });
});
