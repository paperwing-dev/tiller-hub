import { describe, expect, it } from "vitest";
import type { StoredSession } from "../../api/types";
import {
  getDashboardRouteScope,
  resolveActiveEnvironmentSlug,
} from "../dashboard-route-scope";

function sessionFixture(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    tag: "fallback-env",
    machine_id: null,
    metadata: JSON.stringify({ envSlug: "session-env", role: "lead" }),
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 0,
    ended_at: null,
    created_at: "2026-07-16T00:00:00.000Z",
    updated_at: "2026-07-16T00:00:00.000Z",
    ...overrides,
  };
}

describe("active environment route resolution", () => {
  it.each([
    ["/envs/direct-env", "direct-env"],
    ["/envs/ship-env/ship", "ship-env"],
    ["/sessions/session-1", "session-env"],
    ["/projects/repo-1", null],
    ["/projects/repo-1/plan", null],
    ["/projects/repo-1/plan/plan-1", null],
  ])("resolves %s to %s", (pathname, expected) => {
    expect(resolveActiveEnvironmentSlug(
      getDashboardRouteScope(pathname),
      [sessionFixture()],
      new Map(),
    )).toBe(expected);
  });

  it("uses the remembered session mapping while session data is catching up", () => {
    expect(resolveActiveEnvironmentSlug(
      getDashboardRouteScope("/sessions/session-2"),
      [],
      new Map([["session-2", "remembered-env"]]),
    )).toBe("remembered-env");
  });
});
