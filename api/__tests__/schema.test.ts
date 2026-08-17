import { describe, expect, it } from "vitest";
import { ensureSchema } from "../schema";

describe("ensureSchema", () => {
  it("does not create the retired RPC table for new Durable Objects", () => {
    const statements: string[] = [];
    const sql = {
      exec(query: string) {
        statements.push(query);
        return { toArray: () => [] };
      },
    } as unknown as SqlStorage;

    ensureSchema(sql);

    const schema = statements.join("\n");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS sessions");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS repo_mcp_servers");
    for (const table of [
      "repo_cloudflare_mcp_credentials",
      "repo_cloudflare_mcp_oauth_states",
      "repo_cloudflare_mcp_proxy_tokens",
      "repo_cloudflare_mcp_audit_events",
    ]) {
      expect(schema).toContain(`DROP TABLE IF EXISTS ${table}`);
      expect(schema).not.toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(schema).not.toContain("rpc_methods");
    expect(schema).not.toContain("DROP TABLE IF EXISTS rpc_methods");
  });
});
