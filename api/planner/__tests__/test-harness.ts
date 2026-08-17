import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { vi } from "vitest";
import { ArtifactStoreDO, ThreadDO } from "../../coordination";

// Shared pure helpers for the planner test files. The vi.mock blocks stay in
// each test file (they must be hoisted there); importing files mock
// "cloudflare:workers" before this module's coordination import evaluates.

export { ArtifactStoreDO, ThreadDO };

type SqlResultRow = Record<string, unknown>;

export function createSqlResult<T extends SqlResultRow>(rows: T[], rowsWritten = 0) {
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

export class FakeSqlStorage {
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
}

export class FakeStorage {
  readonly sql = new FakeSqlStorage();
  private alarmAt: number | null = null;

  transactionSync<T>(closure: () => T): T {
    return closure();
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmAt = null;
  }
}

function durableContext(storage: FakeStorage) {
  return {
    storage,
    waitUntil(promise: Promise<unknown>) {
      void promise.catch(() => undefined);
    },
  };
}

export function createStore() {
  const storage = new FakeStorage();
  return new ArtifactStoreDO(durableContext(storage) as any, {} as any);
}

export function createThread() {
  const storage = new FakeStorage();
  return new ThreadDO(durableContext(storage) as any, {} as any);
}

export function asAsyncStub<T extends object>(target: T): T {
  return new Proxy(target, {
    get(object, property, receiver) {
      const value = Reflect.get(object, property, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => Promise.resolve(value.apply(object, args));
    },
  }) as T;
}

export function createExecutionCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException: vi.fn(),
    props: {},
  };
}
