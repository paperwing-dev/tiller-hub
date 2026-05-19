import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAccessApp,
  createAccessEmailPolicy,
  createAccessServiceTokenPolicy,
  MANAGED_ACCESS_SESSION_DURATION,
} from "../access/cloudflare-api";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockCloudflareFetch() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          errors: [],
          result: { id: "created-id", aud: "aud-123" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
  );
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

function requestBody(
  fetchMock: ReturnType<typeof mockCloudflareFetch>,
  callIndex: number,
) {
  return JSON.parse(
    fetchMock.mock.calls[callIndex]![1]!.body as string,
  ) as Record<string, unknown>;
}

describe("Cloudflare Access API defaults", () => {
  it("uses the managed one-month session duration for apps and policies", async () => {
    const fetchMock = mockCloudflareFetch();

    await createAccessApp("cfat_test", "acc-123", {
      domain: "tiller.example.com",
      name: "Tiller Hub",
    });
    await createAccessEmailPolicy("cfat_test", "acc-123", "app-123", {
      name: "Browser",
      emails: ["owner@example.com"],
      precedence: 100,
    });
    await createAccessServiceTokenPolicy("cfat_test", "acc-123", "app-123", {
      name: "Service token",
      tokenId: "service-token",
      precedence: 200,
    });

    expect(requestBody(fetchMock, 0).session_duration).toBe(
      MANAGED_ACCESS_SESSION_DURATION,
    );
    expect(requestBody(fetchMock, 1).session_duration).toBe(
      MANAGED_ACCESS_SESSION_DURATION,
    );
    expect(requestBody(fetchMock, 2).session_duration).toBe(
      MANAGED_ACCESS_SESSION_DURATION,
    );
    expect(MANAGED_ACCESS_SESSION_DURATION).toBe("720h");
  });
});
