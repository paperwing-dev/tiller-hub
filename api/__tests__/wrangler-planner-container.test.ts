import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Deploy-config assertions for the hosted planner runtime. String-based on
// purpose: wrangler.jsonc carries comments, and these invariants are exactly
// what a refactor could silently break.
const WRANGLER_SOURCE = readFileSync(
  path.resolve(import.meta.dirname, "..", "..", "wrangler.jsonc"),
  "utf-8",
);

function plannerContainerBlock(): string {
  const match = WRANGLER_SOURCE.match(/\{[^{}]*"class_name":\s*"PlannerRunDO"[^{}]*\}/);
  expect(match, "PlannerRunDO container entry missing from wrangler.jsonc").not.toBeNull();
  return match![0];
}

function sandboxContainerBlock(): string {
  const match = WRANGLER_SOURCE.match(/\{[^{}]*"class_name":\s*"SandboxDO"[^{}]*\}/);
  expect(match, "SandboxDO container entry missing from wrangler.jsonc").not.toBeNull();
  return match![0];
}

function codexAuthContainerBlock(): string {
  const match = WRANGLER_SOURCE.match(/\{[^{}]*"class_name":\s*"CodexAuthDO"[^{}]*\}/);
  expect(match, "CodexAuthDO container entry missing from wrangler.jsonc").not.toBeNull();
  return match![0];
}

describe("wrangler implementor container config", () => {
  it("allows the agreed number of concurrent implementation environments", () => {
    const block = sandboxContainerBlock();
    expect(block).toMatch(/"max_instances":\s*30/);
    expect(block).toMatch(/"instance_type":\s*"standard-1"/);
  });
});

describe("wrangler planner container config", () => {
  it("pins the planner container to the sandbox image, never the GitHub job image", () => {
    const block = plannerContainerBlock();
    expect(block).toMatch(/"image":\s*"docker\.io\/jamieatlason\/tiller-sandbox[^"]*"/);
    expect(block).not.toMatch(/"image":\s*"[^"]*tiller-scm/);
  });

  it("uses the agreed instance budget", () => {
    const block = plannerContainerBlock();
    expect(block).toMatch(/"max_instances":\s*10/);
    expect(block).toMatch(/"instance_type":\s*"standard-1"/);
  });

  it("declares the PLANNER_RUN binding and authoritative SQLite export", () => {
    expect(WRANGLER_SOURCE).toMatch(/"name":\s*"PLANNER_RUN",\s*"class_name":\s*"PlannerRunDO"/s);
    expect(WRANGLER_SOURCE).toMatch(/"PlannerRunDO":\s*\{\s*"type":\s*"durable-object",\s*"storage":\s*"sqlite"\s*\}/s);
    expect(WRANGLER_SOURCE).not.toContain('"migrations"');
  });
});

describe("wrangler Codex auth container config", () => {
  it("uses the singleton basic sandbox topology", () => {
    const block = codexAuthContainerBlock();
    expect(block).toMatch(/"image":\s*"docker\.io\/jamieatlason\/tiller-sandbox[^"]*"/);
    expect(block).toMatch(/"max_instances":\s*1/);
    expect(block).toMatch(/"instance_type":\s*"basic"/);
  });

  it("declares the CODEX_AUTH binding and authoritative SQLite export", () => {
    expect(WRANGLER_SOURCE).toMatch(/"name":\s*"CODEX_AUTH",\s*"class_name":\s*"CodexAuthDO"/s);
    expect(WRANGLER_SOURCE).toMatch(/"CodexAuthDO":\s*\{\s*"type":\s*"durable-object",\s*"storage":\s*"sqlite"\s*\}/s);
  });
});
