import { describe, expect, it } from "vitest";
import type { StoredSession } from "../../api/types";
import { getManagedEnvSlug, pickPrimaryEnvSession } from "../session-attachment";

function makeSession(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: "session-1",
    tag: "test-env",
    machine_id: null,
    metadata: JSON.stringify({ envSlug: "test-env", role: "lead" }),
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 1,
    ended_at: null,
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("getManagedEnvSlug", () => {
  it("reads envSlug from session metadata", () => {
    expect(getManagedEnvSlug(makeSession())).toBe("test-env");
  });

  it("returns null when metadata.envSlug is missing", () => {
    expect(getManagedEnvSlug(makeSession({ metadata: JSON.stringify({ role: "lead" }) }))).toBeNull();
  });
});

describe("pickPrimaryEnvSession", () => {
  it("returns the lead session for an env", () => {
    const session = pickPrimaryEnvSession(
      [
        makeSession({ id: "worker", tag: "worker-1", metadata: JSON.stringify({ envSlug: "test-env", role: "worker" }) }),
        makeSession({ id: "lead" }),
      ],
      "test-env",
    );

    expect(session?.id).toBe("lead");
  });

  it("rejects a session without an explicit lead role", () => {
    const session = pickPrimaryEnvSession(
      [makeSession({ id: "unscoped", metadata: JSON.stringify({ envSlug: "test-env" }) })],
      "test-env",
    );

    expect(session).toBeNull();
  });
});
