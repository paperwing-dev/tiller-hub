import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  durableObjectOptions,
  getDurableObjectStub,
} from "../durable-object";

const API_ROOT = new URL("..", import.meta.url);

async function productionApiFiles(dir = API_ROOT.pathname): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "__tests__" ? [] : productionApiFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
      ? [path]
      : [];
  }))).flat();
}

describe("regional Durable Object access", () => {
  it("validates and supplies the configured location hint", () => {
    expect(durableObjectOptions({})).toEqual({});
    expect(durableObjectOptions({ DO_LOCATION_HINT: "wnam" })).toEqual({
      locationHint: "wnam",
    });
    expect(() => durableObjectOptions({ DO_LOCATION_HINT: "WNAM" }))
      .toThrow(/invalid/);
    expect(() => durableObjectOptions({ DO_LOCATION_HINT: "unknown" }))
      .toThrow(/invalid/);
    expect(() => durableObjectOptions({ TILLER_INSTALLER_SCHEMA: "1" }))
      .toThrow(/requires DO_LOCATION_HINT/);
    expect(() => durableObjectOptions({
      TILLER_INSTALLER_SCHEMA: "1",
      DO_LOCATION_HINT: "WNAM",
    })).toThrow(/invalid/);
    expect(durableObjectOptions({
      TILLER_INSTALLER_SCHEMA: "1",
      DO_LOCATION_HINT: "wnam",
    })).toEqual({ locationHint: "wnam" });
  });

  it("constructs named stubs with the shared options", () => {
    const stub = { fetch: vi.fn() };
    const namespace = {
      getByName: vi.fn(() => stub),
    };
    expect(getDurableObjectStub(
      { DO_LOCATION_HINT: "weur" },
      namespace as unknown as DurableObjectNamespace,
      "workspace-1",
    )).toBe(stub);
    expect(namespace.getByName).toHaveBeenCalledWith("workspace-1", { locationHint: "weur" });
  });

  it("supports existing namespace test doubles", () => {
    const stub = { fetch: vi.fn() };
    const namespace = {
      idFromName: vi.fn(() => "durable-id"),
      get: vi.fn(() => stub),
    };
    expect(getDurableObjectStub(
      { DO_LOCATION_HINT: "weur" },
      namespace as unknown as DurableObjectNamespace,
      "workspace-1",
    )).toBe(stub);
    expect(namespace.idFromName).toHaveBeenCalledWith("workspace-1");
    expect(namespace.get).toHaveBeenCalledWith("durable-id", { locationHint: "weur" });
  });

  it("prevents raw production namespace lookups outside the shared primitive", async () => {
    const violations: string[] = [];
    for (const file of await productionApiFiles()) {
      if (file.endsWith("/durable-object.ts")) continue;
      const source = await readFile(file, "utf8");
      for (const pattern of [/\.idFrom(?:Name|String)\s*\(/g, /\.getByName\s*\(/g]) {
        if (pattern.test(source)) {
          violations.push(`${relative(API_ROOT.pathname, file)}: ${pattern.source}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
