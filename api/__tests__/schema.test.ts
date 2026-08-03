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
    expect(schema).not.toContain("rpc_methods");
    expect(schema).not.toContain("DROP TABLE IF EXISTS rpc_methods");
  });
});
