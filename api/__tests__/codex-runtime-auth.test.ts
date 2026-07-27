import { describe, expect, it } from "vitest";
import { parseCodexRuntimeAuthRequest } from "../codex-runtime-auth";

describe("Codex runtime-auth request parsing", () => {
  it("accepts an empty body", async () => {
    await expect(parseCodexRuntimeAuthRequest(new Request("https://hub.test/runtime-auth", {
      method: "POST",
    }))).resolves.toEqual({
      ok: true,
      rejectedAccessTokenSha256: undefined,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    ["a JSON array", "[]"],
    ["a JSON primitive", "true"],
  ])("rejects %s consistently", async (_label, body) => {
    const result = await parseCodexRuntimeAuthRequest(new Request("https://hub.test/runtime-auth", {
      method: "POST",
      body,
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toEqual({
      error: "Request body must be a valid JSON object.",
    });
  });

  it("normalizes a rejected access-token digest", async () => {
    await expect(parseCodexRuntimeAuthRequest(new Request("https://hub.test/runtime-auth", {
      method: "POST",
      body: JSON.stringify({ rejected_access_token_sha256: "A".repeat(64) }),
    }))).resolves.toEqual({
      ok: true,
      rejectedAccessTokenSha256: "a".repeat(64),
    });
  });

  it("rejects an invalid rejected access-token digest", async () => {
    const result = await parseCodexRuntimeAuthRequest(new Request("https://hub.test/runtime-auth", {
      method: "POST",
      body: JSON.stringify({ rejected_access_token_sha256: "not-a-digest" }),
    }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    await expect(result.response.json()).resolves.toEqual({
      error: "rejected_access_token_sha256 must be a SHA-256 hex digest",
    });
  });
});
