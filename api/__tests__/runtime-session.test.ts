import { describe, expect, it } from "vitest";
import {
  deriveRuntimeSessionAuthority,
  parseRuntimeSessionCreateRequest,
} from "../runtime-session";

const descriptive = {
  id: "session-1",
  tag: "Implementor",
  cwd: "/workspace",
  host: "sandbox",
  platform: "linux",
  team: "backend",
};

describe("runtime session creation boundary", () => {
  it.each([
    "machine_id",
    "envSlug",
    "repository",
    "repoUrl",
    "backend",
    "runnerId",
    "terminalScope",
    "harness",
    "role",
  ])("rejects runtime authority field %s", (field) => {
    expect(parseRuntimeSessionCreateRequest({
      ...descriptive,
      [field]: "attacker-controlled",
    })).toEqual({
      ok: false,
      error: expect.stringContaining(field),
    });
  });

  it("accepts only the narrow descriptive DTO", () => {
    expect(parseRuntimeSessionCreateRequest(descriptive)).toEqual({
      ok: true,
      request: descriptive,
    });
  });

  it("derives every authority field from the current environment record", () => {
    const parsed = parseRuntimeSessionCreateRequest(descriptive);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(deriveRuntimeSessionAuthority("env-1", {
      executionPlacement: { backend: "host", machineId: "machine-1" },
      harness: "codex",
      runnerId: "runner-1",
      repoUrl: "https://github.com/example/repo",
    }, parsed.request)).toEqual({
      machineId: "machine-1",
      metadata: {
        cwd: "/workspace",
        host: "sandbox",
        platform: "linux",
        team: "backend",
        harness: "codex",
        envSlug: "env-1",
        backend: "host",
        runnerId: "runner-1",
        repoUrl: "https://github.com/example/repo",
        role: "lead",
        terminalScope: { kind: "environment", envSlug: "env-1", role: "lead" },
      },
    });
  });

  it("does not let Cloudflare runtimes invent machine identity", () => {
    const { team: _team, ...withoutTeam } = descriptive;
    const parsed = parseRuntimeSessionCreateRequest(withoutTeam);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    const authority = deriveRuntimeSessionAuthority("env-1", {
      executionPlacement: { backend: "cf", machineId: null },
      harness: "claude-code",
      runnerId: null,
      repoUrl: "https://github.com/example/repo",
    }, parsed.request);
    expect(authority.machineId).toBeNull();
    expect(authority.metadata).toMatchObject({
      backend: "cf",
      runnerId: "env-1",
      harness: "claude-code",
    });
    expect(authority.metadata).not.toHaveProperty("team");
  });
});
