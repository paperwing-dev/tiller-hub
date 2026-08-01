import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

vi.mock("partyserver", () => ({
  Server: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import { HubDO } from "../hub";
import {
  SESSION_ENV_MAX_VARS_PER_REPO,
  SessionEnvValidationError,
  normalizeSessionEnvPatch,
} from "../session-env";

type SqlResultRow = Record<string, unknown>;

function createSqlResult<T extends SqlResultRow>(rows: T[], rowsWritten = 0) {
  return {
    rowsWritten,
    toArray(): T[] {
      return rows;
    },
    *[Symbol.iterator](): IterableIterator<T> {
      yield* rows;
    },
  };
}

class FakeSqlStorage {
  private readonly db = new DatabaseSync(":memory:");

  exec(query: string, ...params: SQLInputValue[]) {
    if (/^\s*(select|pragma)\b/i.test(query)) {
      const rows = this.db.prepare(query).all(...params) as SqlResultRow[];
      return createSqlResult(rows);
    }

    if (params.length > 0) {
      const result = this.db.prepare(query).run(...params);
      return createSqlResult([], Number(result.changes ?? 0));
    }

    this.db.exec(query);
    return createSqlResult([]);
  }

  close(): void {
    this.db.close();
  }
}

class FakeStorage {
  readonly sql = new FakeSqlStorage();
  private readonly kv = new Map<string, unknown>();
  private transactionQueue: Promise<void> = Promise.resolve();

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.kv.get(key) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.kv.set(key, value);
  }

  async transaction<T>(callback: (txn: FakeStorage) => Promise<T>): Promise<T> {
    const run = this.transactionQueue.then(() => callback(this));
    this.transactionQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  close(): void {
    this.sql.close();
  }
}

function createSubject() {
  const storage = new FakeStorage();
  const ctx = {
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn().mockReturnValue([]),
    acceptWebSocket: vi.fn(),
  };
  const subject = new HubDO(ctx as any, {} as any);
  return { subject, storage };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("repo session env storage", () => {
  it("stores encrypted values and lists metadata only", async () => {
    const { subject, storage } = createSubject();

    const metadata = await subject.patchRepoSessionEnv("repo-1", {
      set: { USER_FLAG: "super-secret-value" },
    });

    expect(metadata).toEqual([
      { name: "USER_FLAG", updatedAt: expect.any(String) },
    ]);
    expect(subject.listRepoSessionEnv("repo-1")).toEqual(metadata);
    await expect(subject.resolveRepoSessionEnvVars("repo-1")).resolves.toEqual({
      USER_FLAG: "super-secret-value",
    });

    const rows = storage.sql.exec("SELECT * FROM repo_session_env").toArray();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain("super-secret-value");
    expect(subject.getAllConfig()).toEqual({});

    storage.close();
  });

  it("replaces and deletes values without exposing plaintext metadata", async () => {
    const { subject, storage } = createSubject();

    await subject.patchRepoSessionEnv("repo-1", {
      set: { USER_FLAG: "one", OTHER_FLAG: "two" },
    });
    await subject.patchRepoSessionEnv("repo-1", {
      set: { USER_FLAG: "three" },
      delete: ["OTHER_FLAG"],
    });

    expect(subject.listRepoSessionEnv("repo-1").map((entry) => entry.name)).toEqual(["USER_FLAG"]);
    await expect(subject.resolveRepoSessionEnvVars("repo-1")).resolves.toEqual({
      USER_FLAG: "three",
    });

    storage.close();
  });

  it("rejects invalid names, reserved names, and invalid values", () => {
    expect(() => normalizeSessionEnvPatch({ set: { "BAD-NAME": "value" } })).toThrow(SessionEnvValidationError);
    expect(() => normalizeSessionEnvPatch({ set: { " USER_FLAG ": "value" } })).toThrow(SessionEnvValidationError);
    expect(() => normalizeSessionEnvPatch({ set: { TILLER_HARNESS: "value" } })).toThrow(SessionEnvValidationError);
    expect(() => normalizeSessionEnvPatch({ set: { OPENAI_API_KEY: "value" } })).toThrow(SessionEnvValidationError);
    expect(() => normalizeSessionEnvPatch({ set: { USER_FLAG: "" } })).toThrow(SessionEnvValidationError);
    expect(() => normalizeSessionEnvPatch({ set: { USER_FLAG: "line\nbreak" } })).toThrow(SessionEnvValidationError);
    expect(() => normalizeSessionEnvPatch({ set: { USER_FLAG: "nul\0byte" } })).toThrow(SessionEnvValidationError);
  });

  it("reserves removed placement input while allowing workload Worker naming", () => {
    expect(() => normalizeSessionEnvPatch({ set: { TILLER_REGION: "wnam" } }))
      .toThrow(SessionEnvValidationError);
    expect(normalizeSessionEnvPatch({
      set: {
        TILLER_WORKER_NAME: "tiller-hub",
      },
    })).toEqual({
      set: {
        TILLER_WORKER_NAME: "tiller-hub",
      },
    });

    for (const name of [
      "TILLER_ACCESS_EMAILS",
      "TILLER_ACCESS_TEAM_DOMAIN",
      "TILLER_CUSTOM_DOMAIN",
    ]) {
      expect(() => normalizeSessionEnvPatch({ set: { [name]: "legacy" } }))
        .toThrow(SessionEnvValidationError);
    }
  });

  it("enforces per-repo variable count", async () => {
    const { subject, storage } = createSubject();
    const set: Record<string, string> = {};
    for (let i = 0; i < SESSION_ENV_MAX_VARS_PER_REPO + 1; i += 1) {
      set[`USER_FLAG_${i}`] = "value";
    }

    await expect(subject.patchRepoSessionEnv("repo-1", { set })).rejects.toThrow(SessionEnvValidationError);
    expect(subject.listRepoSessionEnv("repo-1")).toEqual([]);

    storage.close();
  });

  it("supports concurrent first writes with one data-key path", async () => {
    const { subject, storage } = createSubject();

    await Promise.all([
      subject.patchRepoSessionEnv("repo-1", { set: { USER_FLAG: "one" } }),
      subject.patchRepoSessionEnv("repo-2", { set: { OTHER_FLAG: "two" } }),
    ]);

    await expect(subject.resolveRepoSessionEnvVars("repo-1")).resolves.toEqual({ USER_FLAG: "one" });
    await expect(subject.resolveRepoSessionEnvVars("repo-2")).resolves.toEqual({ OTHER_FLAG: "two" });
    expect(subject.getAllConfig()).toEqual({});

    storage.close();
  });

  it("serializes same-repo concurrent patches before enforcing repo limits", async () => {
    const { subject, storage } = createSubject();

    const results = await Promise.allSettled(
      Array.from({ length: SESSION_ENV_MAX_VARS_PER_REPO + 1 }, (_, index) =>
        subject.patchRepoSessionEnv("repo-1", {
          set: { [`USER_FLAG_${index}`]: "value" },
        })
      ),
    );

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(SESSION_ENV_MAX_VARS_PER_REPO);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(subject.listRepoSessionEnv("repo-1")).toHaveLength(SESSION_ENV_MAX_VARS_PER_REPO);

    storage.close();
  });

  it("deletes all session env rows for a repo", async () => {
    const { subject, storage } = createSubject();

    await subject.patchRepoSessionEnv("repo-1", { set: { USER_FLAG: "one" } });
    await subject.patchRepoSessionEnv("repo-2", { set: { OTHER_FLAG: "two" } });
    subject.deleteRepoSessionEnv("repo-1");

    expect(subject.listRepoSessionEnv("repo-1")).toEqual([]);
    await expect(subject.resolveRepoSessionEnvVars("repo-2")).resolves.toEqual({ OTHER_FLAG: "two" });

    storage.close();
  });
});
