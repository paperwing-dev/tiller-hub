import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const WRANGLER_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "wrangler.jsonc"),
  "utf-8",
);

describe("workers.dev Access deployment config", () => {
  it("routes Hub-to-broker fetches through Cloudflare's public front door", () => {
    const flags = WRANGLER_SOURCE.match(/"compatibility_flags":\s*\[([^\]]*)\]/s)?.[1];

    expect(flags, "compatibility_flags missing from wrangler.jsonc").toBeDefined();
    expect(flags).toMatch(/"global_fetch_strictly_public"/);
  });
});
