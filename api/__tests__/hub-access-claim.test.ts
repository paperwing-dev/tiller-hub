import { describe, expect, it, vi } from "vitest";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

vi.mock("partyserver", () => ({
  Server: class {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    getConnections() {
      return [];
    }
  },
}));

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
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  transactionDepth = 0;
  alarmSetInTransaction = false;

  transactionSync<T>(callback: () => T): T {
    return callback();
  }

  async transaction<T>(callback: (txn: FakeStorage) => Promise<T>): Promise<T> {
    this.transactionDepth += 1;
    try {
      return await callback(this);
    } finally {
      this.transactionDepth -= 1;
    }
  }

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(keyOrKeys: string | string[]): Promise<boolean> {
    if (Array.isArray(keyOrKeys)) {
      let deleted = false;
      for (const key of keyOrKeys) deleted = this.values.delete(key) || deleted;
      return deleted;
    }
    return this.values.delete(keyOrKeys);
  }

  async list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    return new Map([...this.values.entries()]
      .filter(([key]) => !options.prefix || key.startsWith(options.prefix))) as Map<string, T>;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmAt;
  }

  async setAlarm(scheduledAt: number | Date): Promise<void> {
    if (this.transactionDepth > 0) this.alarmSetInTransaction = true;
    this.alarmAt = scheduledAt instanceof Date ? scheduledAt.getTime() : scheduledAt;
  }

  close(): void {
    this.sql.close();
  }
}

import { HubDO } from "../hub";

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

describe("HubDO canonical workers.dev Access jobs", () => {
  it("atomically commits bootstrap and rejects a changed duplicate", async () => {
    const { subject, storage } = createSubject();
    const started = await subject.beginWorkersDevAccessJob({
      operation: "bootstrap",
      origin: "https://demo.preview.workers.dev",
      workerName: "demo",
    });
    expect(started.status).toBe("created");
    if (started.status !== "created") throw new Error("job was not created");
    const authentication = {
      jobId: started.job.jobId,
      jobSecret: started.jobSecret,
      operation: "bootstrap" as const,
      origin: started.job.origin,
      workerName: started.job.workerName,
    };
    await expect(subject.verifyWorkersDevAccessJobProof({
      ...authentication,
      intent: "bind",
    })).resolves.toEqual({
      ok: true,
      registrationState: "registering",
      completionDeadline: started.job.completionDeadline,
    });
    await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
      jobId: started.job.jobId,
      jobSecretSha256: started.job.jobSecretSha256,
    })).resolves.toMatchObject({ status: "confirmed" });
    await expect(subject.verifyWorkersDevAccessJobProof({
      ...authentication,
      intent: "bind",
    })).resolves.toEqual({
      ok: true,
      registrationState: "registered",
      completionDeadline: started.job.completionDeadline,
    });
    const result = {
      trust: {
        version: 1 as const,
        ownerEmail: "owner@example.com",
        accountId: "account-1",
        workerName: "demo",
        workersDevHostname: "demo.preview.workers.dev",
        issuer: "https://team.cloudflareaccess.com",
        audience: "aud-123",
        serviceTokenId: "token-1",
        serviceClientId: "client.access",
        configuredAt: "2026-07-16T00:00:00.000Z",
      },
      credential: {
        version: 1 as const,
        currentSecret: "secret",
        tokenExpiresAt: "2027-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
      },
    };
    await expect(subject.completeWorkersDevAccessJob({
      ...authentication,
      result,
    })).rejects.toThrow(/invalid or expired/i);
    await expect(subject.verifyWorkersDevAccessJobProof({
      ...authentication,
      intent: "mutation_start",
    })).resolves.toEqual({
      ok: true,
      registrationState: "registered",
      completionDeadline: started.job.completionDeadline,
      mutationState: "started",
    });
    await expect(subject.completeWorkersDevAccessJob({ ...authentication, result }))
      .resolves.toEqual({ status: "applied" });
    await expect(subject.completeWorkersDevAccessJob({ ...authentication, result }))
      .resolves.toEqual({ status: "already_applied" });
    await expect(subject.completeWorkersDevAccessJob({
      ...authentication,
      result: { ...result, credential: { ...result.credential, currentSecret: "changed" } },
    })).rejects.toThrow(/did not match/i);
    await expect(subject.getWorkersDevAccessLifecycle()).resolves.toMatchObject({
      configured: true,
      tokenExpiresAt: "2027-07-16T00:00:00.000Z",
    });

    const renewal = await subject.beginWorkersDevAccessJob({
      operation: "renew",
      origin: "https://demo.preview.workers.dev",
      workerName: "demo",
    });
    expect(renewal.status).toBe("created");
    if (renewal.status !== "created") throw new Error("renewal was not created");
    await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
      jobId: renewal.job.jobId,
      jobSecretSha256: renewal.job.jobSecretSha256,
    })).resolves.toMatchObject({ status: "confirmed" });
    await expect(subject.verifyWorkersDevAccessJobProof({
      jobId: renewal.job.jobId,
      jobSecret: renewal.jobSecret,
      operation: "renew",
      origin: renewal.job.origin,
      workerName: renewal.job.workerName,
      intent: "mutation_start",
    })).resolves.toMatchObject({ ok: true, mutationState: "started" });
    await expect(subject.completeWorkersDevAccessJob({
      jobId: renewal.job.jobId,
      jobSecret: renewal.jobSecret,
      operation: "renew",
      origin: renewal.job.origin,
      workerName: renewal.job.workerName,
      result: {
        accountId: "account-1",
        serviceTokenId: "token-1",
        serviceClientId: "client.access",
        tokenExpiresAt: "2027-07-16T00:00:00.000Z",
        updatedAt: "2026-07-17T00:00:00.000Z",
      },
    })).rejects.toThrow(/did not advance/i);
    await expect(subject.completeWorkersDevAccessJob({
      jobId: renewal.job.jobId,
      jobSecret: renewal.jobSecret,
      operation: "renew",
      origin: renewal.job.origin,
      workerName: renewal.job.workerName,
      result: {
        accountId: "account-1",
        serviceTokenId: "token-1",
        serviceClientId: "client.access",
        tokenExpiresAt: "2028-07-16T00:00:00.000Z",
        updatedAt: "2027-07-16T00:00:00.000Z",
      },
    })).resolves.toEqual({ status: "applied" });
    await expect(subject.getWorkersDevAccessCredential()).resolves.toEqual({
      ...result.credential,
      tokenExpiresAt: "2028-07-16T00:00:00.000Z",
      updatedAt: "2027-07-16T00:00:00.000Z",
    });
    expect([...storage.values.keys()].filter((key) => key.includes("completed_job"))).toHaveLength(2);

    storage.close();
  });

  it("reports an unconfirmed job as registering, then reuses it only after confirmation", async () => {
    const { subject, storage } = createSubject();
    const first = await subject.beginWorkersDevAccessJob({
      operation: "bootstrap",
      origin: "https://demo.preview.workers.dev",
      workerName: "demo",
    });
    const repeated = await subject.beginWorkersDevAccessJob({
      operation: "bootstrap",
      origin: "https://demo.preview.workers.dev",
      workerName: "demo",
    });
    expect(first.status).toBe("created");
    expect(repeated.status).toBe("registering");
    if (first.status === "created" && repeated.status === "registering") {
      expect(repeated.job.jobId).toBe(first.job.jobId);
      expect(repeated.job.registrationDeadline).toBe(first.job.registrationDeadline);
      expect(repeated.job.completionDeadline).toBe(first.job.completionDeadline);
      expect(JSON.stringify([...storage.values.values()])).not.toContain(first.jobSecret);

      await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: first.job.jobId,
        jobSecretSha256: first.job.jobSecretSha256,
      })).resolves.toMatchObject({ status: "confirmed" });
      const confirmed = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      expect(confirmed).toMatchObject({
        status: "existing",
        job: {
          jobId: first.job.jobId,
          registrationState: "registered",
          registrationDeadline: first.job.registrationDeadline,
          completionDeadline: first.job.completionDeadline,
        },
      });
    }

    storage.close();
  });

  it("cancels only the exact matching job while it is still registering", async () => {
    const { subject, storage } = createSubject();
    const first = await subject.beginWorkersDevAccessJob({
      operation: "bootstrap",
      origin: "https://demo.preview.workers.dev",
      workerName: "demo",
    });
    if (first.status !== "created") throw new Error("job was not created");

    await expect(subject.cancelWorkersDevAccessJob({
      jobId: first.job.jobId,
      jobSecretSha256: "wrong-hash",
    })).resolves.toBe(false);
    await expect(subject.cancelWorkersDevAccessJob({
      jobId: first.job.jobId,
      jobSecretSha256: first.job.jobSecretSha256,
    })).resolves.toBe(true);

    const replacement = await subject.beginWorkersDevAccessJob({
      operation: "bootstrap",
      origin: "https://demo.preview.workers.dev",
      workerName: "demo",
    });
    if (replacement.status !== "created") throw new Error("replacement was not created");
    expect(replacement.job.jobId).not.toBe(first.job.jobId);
    await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
      jobId: replacement.job.jobId,
      jobSecretSha256: replacement.job.jobSecretSha256,
    })).resolves.toMatchObject({ status: "confirmed" });
    await expect(subject.cancelWorkersDevAccessJob({
      jobId: replacement.job.jobId,
      jobSecretSha256: replacement.job.jobSecretSha256,
    })).resolves.toBe(false);

    storage.close();
  });

  it("atomically replaces an unconfirmed job after its registration deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
      const { subject, storage } = createSubject();
      const first = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      expect(first.status).toBe("created");
      if (first.status !== "created") throw new Error("job was not created");

      vi.setSystemTime(new Date(first.job.registrationDeadline));
      const replacement = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      expect(replacement.status).toBe("created");
      if (replacement.status !== "created") throw new Error("replacement was not created");
      expect(replacement.job.jobId).not.toBe(first.job.jobId);
      expect(replacement.job.registrationDeadline).not.toBe(first.job.registrationDeadline);

      await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: first.job.jobId,
        jobSecretSha256: first.job.jobSecretSha256,
      })).resolves.toEqual({ status: "stale" });
      await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: replacement.job.jobId,
        jobSecretSha256: "wrong-hash",
      })).resolves.toEqual({ status: "stale" });
      await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: replacement.job.jobId,
        jobSecretSha256: replacement.job.jobSecretSha256,
      })).resolves.toMatchObject({
        status: "confirmed",
        job: { jobId: replacement.job.jobId, registrationState: "registered" },
      });

      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not confirm a matching registration after its immutable deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
      const { subject, storage } = createSubject();
      const started = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      if (started.status !== "created") throw new Error("job was not created");
      vi.setSystemTime(new Date(started.job.registrationDeadline));
      await expect(subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: started.job.jobId,
        jobSecretSha256: started.job.jobSecretSha256,
      })).resolves.toEqual({ status: "expired" });
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a registered job that never started mutation after its mutation deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
      const { subject, storage } = createSubject();
      const started = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      if (started.status !== "created") throw new Error("job was not created");
      await subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: started.job.jobId,
        jobSecretSha256: started.job.jobSecretSha256,
      });

      const mutationDeadline = Date.parse(started.job.completionDeadline) - 60 * 60 * 1_000;
      vi.setSystemTime(new Date(mutationDeadline));
      const replacement = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: started.job.origin,
        workerName: started.job.workerName,
      });

      expect(replacement.status).toBe("created");
      if (replacement.status === "created") {
        expect(replacement.job.jobId).not.toBe(started.job.jobId);
      }
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a mutation-started job recoverable through its completion deadline", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
      const { subject, storage } = createSubject();
      const started = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      if (started.status !== "created") throw new Error("job was not created");
      await subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: started.job.jobId,
        jobSecretSha256: started.job.jobSecretSha256,
      });
      const authentication = {
        jobId: started.job.jobId,
        jobSecret: started.jobSecret,
        operation: "bootstrap" as const,
        origin: started.job.origin,
        workerName: started.job.workerName,
      };
      await expect(subject.verifyWorkersDevAccessJobProof({
        ...authentication,
        intent: "mutation_start",
      })).resolves.toMatchObject({ ok: true, mutationState: "started" });

      const mutationDeadline = Date.parse(started.job.completionDeadline) - 60 * 60 * 1_000;
      vi.setSystemTime(new Date(mutationDeadline + 1));
      await expect(subject.verifyWorkersDevAccessJobProof({
        ...authentication,
        intent: "bind",
      })).resolves.toMatchObject({ ok: true, registrationState: "registered" });
      await expect(subject.verifyWorkersDevAccessJobProof({
        ...authentication,
        intent: "mutation_start",
      })).resolves.toMatchObject({ ok: true, mutationState: "started" });
      await expect(subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: started.job.origin,
        workerName: started.job.workerName,
      })).resolves.toMatchObject({ status: "existing", job: { jobId: started.job.jobId } });
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedules and prunes completion tombstones at their own expiration", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-16T20:00:00.000Z"));
      const { subject, storage } = createSubject();
      const started = await subject.beginWorkersDevAccessJob({
        operation: "bootstrap",
        origin: "https://demo.preview.workers.dev",
        workerName: "demo",
      });
      if (started.status !== "created") throw new Error("job was not created");
      await subject.markWorkersDevAccessJobRegistrationConfirmed({
        jobId: started.job.jobId,
        jobSecretSha256: started.job.jobSecretSha256,
      });
      await subject.verifyWorkersDevAccessJobProof({
        jobId: started.job.jobId,
        jobSecret: started.jobSecret,
        operation: "bootstrap",
        origin: started.job.origin,
        workerName: started.job.workerName,
        intent: "mutation_start",
      });
      await subject.completeWorkersDevAccessJob({
        jobId: started.job.jobId,
        jobSecret: started.jobSecret,
        operation: "bootstrap",
        origin: started.job.origin,
        workerName: started.job.workerName,
        result: {
          trust: {
            version: 1,
            ownerEmail: "owner@example.com",
            accountId: "account-1",
            workerName: "demo",
            workersDevHostname: "demo.preview.workers.dev",
            issuer: "https://team.cloudflareaccess.com",
            audience: "aud-123",
            serviceTokenId: "token-1",
            serviceClientId: "client.access",
            configuredAt: "2026-07-16T20:00:00.000Z",
          },
          credential: {
            version: 1,
            currentSecret: "secret",
            tokenExpiresAt: "2027-07-16T20:00:00.000Z",
            updatedAt: "2026-07-16T20:00:00.000Z",
          },
        },
      });

      const tombstoneEntry = [...storage.values.entries()].find(([key]) => (
        key.includes("completed_job")
      ));
      expect(tombstoneEntry).toBeDefined();
      const tombstone = tombstoneEntry?.[1] as { expiresAt: string };
      expect(storage.alarmAt).toBe(Date.parse(tombstone.expiresAt));
      expect(storage.alarmSetInTransaction).toBe(true);

      vi.setSystemTime(new Date(tombstone.expiresAt));
      storage.alarmAt = null;
      await subject.onAlarm();
      expect(storage.values.has(tombstoneEntry?.[0] ?? "")).toBe(false);
      expect(storage.alarmAt).toBeNull();
      storage.close();
    } finally {
      vi.useRealTimers();
    }
  });

});

describe("HubDO billing selections", () => {
  it("returns only fresh normalized non-secret selections", () => {
    const { subject, storage } = createSubject();
    subject.setConfig("ANTHROPIC_API_KEY", "anthropic-secret");
    subject.setConfig("OPENAI_API_KEY", "openai-secret");
    subject.setConfig("claudeBillingMode", "subscription");
    subject.setConfig("openaiBillingMode", "malformed");

    expect(subject.getBillingSelections()).toEqual({
      claudeBillingMode: "subscription",
      openaiBillingMode: null,
    });
    expect(JSON.stringify(subject.getBillingSelections())).not.toContain("secret");

    subject.setConfig("claudeBillingMode", "api");
    subject.setConfig("openaiBillingMode", "subscription");
    expect(subject.getBillingSelections()).toEqual({
      claudeBillingMode: "api",
      openaiBillingMode: "subscription",
    });

    storage.close();
  });

  it("normalizes malformed providers independently", () => {
    const { subject, storage } = createSubject();
    subject.setConfig("claudeBillingMode", "bad");
    subject.setConfig("openaiBillingMode", "api");
    expect(subject.getBillingSelections()).toEqual({
      claudeBillingMode: null,
      openaiBillingMode: "api",
    });
    storage.close();
  });
});
