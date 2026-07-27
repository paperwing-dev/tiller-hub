import { describe, expect, it } from "vitest";
import type { StoredSession } from "../types";
import {
  filterRoutableActiveManagedSessions,
  isManagedSessionMetadataUpdateValid,
  listManagedSessionIdsForEnv,
  partitionManagedSessions,
  partitionManagedSessionsByLookup,
  readManagedEnvSlugFromMetadata,
  readManagedRoleFromStoredSession,
  readManagedRoleFromMetadata,
  readManagedEnvSlugFromStoredSession,
  readTerminalScopeFromStoredSession,
} from "../session-attachment";

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

describe("readManagedEnvSlugFromMetadata", () => {
  it("reads envSlug from object metadata", () => {
    expect(readManagedEnvSlugFromMetadata({ envSlug: "test-env" })).toBe("test-env");
  });

  it("returns null when envSlug is missing", () => {
    expect(readManagedEnvSlugFromMetadata({ role: "lead" })).toBeNull();
  });
});

describe("readManagedRoleFromMetadata", () => {
  it("reads role from object metadata", () => {
    expect(readManagedRoleFromMetadata({ envSlug: "test-env", role: "lead" })).toBe("lead");
  });

  it("returns null when role is missing", () => {
    expect(readManagedRoleFromMetadata({ envSlug: "test-env" })).toBeNull();
  });
});

describe("readManagedEnvSlugFromStoredSession", () => {
  it("reads envSlug from stored session metadata", () => {
    expect(readManagedEnvSlugFromStoredSession(makeSession())).toBe("test-env");
  });

  it("returns null for malformed metadata", () => {
    expect(readManagedEnvSlugFromStoredSession(makeSession({ metadata: "not-json" }))).toBeNull();
  });
});

describe("readManagedRoleFromStoredSession", () => {
  it("reads role from stored session metadata", () => {
    expect(readManagedRoleFromStoredSession(makeSession())).toBe("lead");
  });

  it("returns null when role is missing", () => {
    expect(readManagedRoleFromStoredSession(makeSession({ metadata: JSON.stringify({ envSlug: "test-env" }) }))).toBeNull();
  });
});

describe("partitionManagedSessions", () => {
  it("keeps only sessions attached to existing managed envs", () => {
    const result = partitionManagedSessions(
      [
        makeSession(),
        makeSession({
          id: "session-2",
          metadata: JSON.stringify({ envSlug: "missing-env", role: "lead" }),
        }),
        makeSession({
          id: "session-3",
          metadata: JSON.stringify({ role: "lead" }),
        }),
        makeSession({
          id: "session-4",
          metadata: JSON.stringify({ envSlug: "test-env" }),
        }),
      ],
      new Set(["test-env"]),
    );

    expect(result.managedSessions.map((session) => session.id)).toEqual(["session-1"]);
    expect(result.orphanSessionIds).toEqual(["session-2", "session-3", "session-4"]);
  });

  it("excludes plan-writer terminals from environment listings without pruning them as orphans", () => {
    const planWriter = makeSession({
      id: "plan-writer-1",
      metadata: JSON.stringify({
        terminalScope: {
          kind: "plan-writer",
          repoId: "repo-1",
          planArtifactId: "plan-1",
          generation: 1,
        },
      }),
    });
    const result = partitionManagedSessions([makeSession(), planWriter], new Set(["test-env"]));
    expect(result.managedSessions.map((session) => session.id)).toEqual(["session-1"]);
    expect(result.orphanSessionIds).toEqual([]);
    expect(readTerminalScopeFromStoredSession(planWriter)).toMatchObject({ kind: "plan-writer", generation: 1 });
  });
});

describe("partitionManagedSessionsByLookup", () => {
  it("uses the provided env existence lookup instead of a precomputed slug set", async () => {
    const result = await partitionManagedSessionsByLookup(
      [
        makeSession(),
        makeSession({
          id: "session-2",
          metadata: JSON.stringify({ envSlug: "definition-only-env", role: "lead" }),
        }),
        makeSession({
          id: "session-3",
          metadata: JSON.stringify({ envSlug: "missing-env", role: "lead" }),
        }),
      ],
      async (envSlug) => envSlug === "test-env" || envSlug === "definition-only-env",
    );

    expect(result.managedSessions.map((session) => session.id)).toEqual(["session-1", "session-2"]);
    expect(result.orphanSessionIds).toEqual(["session-3"]);
  });
});

describe("filterRoutableActiveManagedSessions", () => {
  it("keeps only active sessions with live terminal owners", () => {
    const sessions = [
      makeSession({ id: "routable" }),
      makeSession({ id: "stale" }),
      makeSession({ id: "inactive", active: 0 }),
      makeSession({ id: "ended", ended_at: "2024-01-01T00:10:00.000Z" }),
    ];

    expect(
      filterRoutableActiveManagedSessions(
        sessions,
        ["routable", "inactive", "ended"],
      ).map((session) => session.id),
    ).toEqual(["routable"]);
  });
});

describe("listManagedSessionIdsForEnv", () => {
  it("returns all session ids attached to the env slug", () => {
    expect(
      listManagedSessionIdsForEnv(
        [
          makeSession({ id: "lead" }),
          makeSession({ id: "worker", metadata: JSON.stringify({ envSlug: "test-env", role: "worker" }) }),
          makeSession({ id: "other", metadata: JSON.stringify({ envSlug: "other-env", role: "lead" }) }),
        ],
        "test-env",
      ),
    ).toEqual(["lead", "worker"]);
  });
});

describe("isManagedSessionMetadataUpdateValid", () => {
  it("accepts metadata updates that preserve envSlug and role", () => {
    expect(
      isManagedSessionMetadataUpdateValid(
        makeSession(),
        { envSlug: "test-env", role: "lead" },
      ),
    ).toBe(true);
  });

  it("rejects metadata updates that change role or envSlug", () => {
    expect(
      isManagedSessionMetadataUpdateValid(
        makeSession(),
        { envSlug: "test-env", role: "worker" },
      ),
    ).toBe(false);

    expect(
      isManagedSessionMetadataUpdateValid(
        makeSession(),
        { envSlug: "other-env", role: "lead" },
      ),
    ).toBe(false);
  });

  it("keeps a plan-writer generation immutable and never removes revocation", () => {
    const metadata = {
      terminalScope: {
        kind: "plan-writer",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        generation: 2,
        revokedAt: "2026-07-13T00:00:00.000Z",
      },
    };
    const session = makeSession({ metadata: JSON.stringify(metadata) });
    expect(isManagedSessionMetadataUpdateValid(session, metadata)).toBe(true);
    expect(isManagedSessionMetadataUpdateValid(session, {
      terminalScope: { ...metadata.terminalScope, generation: 3 },
    })).toBe(false);
    expect(isManagedSessionMetadataUpdateValid(session, {
      terminalScope: { ...metadata.terminalScope, revokedAt: undefined },
    })).toBe(false);
  });
});
