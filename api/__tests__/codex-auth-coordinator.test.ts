import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTH_CONNECT_GRANTS_KEY,
  CODEX_AUTH_RECORD_KEY,
  CodexAuthCoordinator,
  type CodexAuthHelperResult,
  type CodexAuthRecordV1,
} from "../codex-auth-coordinator";

class MemoryStore {
  readonly values = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

function helperSuccess(
  token: string,
  accountId = "acct-1",
  expiresAt = Date.now() + 60 * 60_000,
  marker = token,
): CodexAuthHelperResult {
  return {
    version: 1,
    ok: true,
    auth_json: JSON.stringify({ marker }),
    projected: { accessToken: token, accountId, expiresAt },
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function subject(options: {
  now?: () => number;
  runHelper?: (authJson: string) => Promise<CodexAuthHelperResult>;
  createGrant?: () => string;
  scheduleRefresh?: (at: Date, revision: number) => Promise<void>;
} = {}) {
  const store = new MemoryStore();
  const schedules: Array<{ at: Date; revision: number }> = [];
  const runHelper = vi.fn(options.runHelper ?? (async () => helperSuccess("token-1")));
  const coordinator = new CodexAuthCoordinator({
    store,
    runHelper,
    scheduleRefresh: options.scheduleRefresh ?? (async (at, revision) => { schedules.push({ at, revision }); }),
    createGrant: options.createGrant ?? (() => `grant-${Math.random()}`),
    now: options.now,
  });
  return { coordinator, runHelper, schedules, store };
}

describe("CodexAuthCoordinator", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("atomically replaces auth only after managed refresh succeeds", async () => {
    let connect = 0;
    const test = subject({
      runHelper: async () => ++connect === 1
        ? helperSuccess("first", "acct-1", Date.now() + 60 * 60_000, "first")
        : { version: 1, ok: false, error: { code: "provider_rejected" } },
    });
    await expect(test.coordinator.connect('{"candidate":1}')).resolves.toMatchObject({ ok: true });
    const before = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    await expect(test.coordinator.connect('{"candidate":2}')).resolves.toMatchObject({
      ok: false,
      reason: "needs_reconnect",
    });
    await expect(test.store.get(CODEX_AUTH_RECORD_KEY)).resolves.toEqual(before);
  });

  it("publishes a successful connection without reporting a later scheduling failure", async () => {
    const now = Date.now();
    const test = subject({
      now: () => now,
      scheduleRefresh: async () => { throw new Error("schedule unavailable"); },
      runHelper: async () => helperSuccess("connected", "acct-1", now + 60 * 60_000),
    });

    await expect(test.coordinator.connect("candidate")).resolves.toMatchObject({
      ok: true,
      credential: { accessToken: "connected" },
    });
    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      revision: 1,
      status: "connected",
      projected: { accessToken: "connected" },
    });
  });

  it("serves the cached projection without waking the helper", async () => {
    const test = subject();
    await test.coordinator.connect("{}");
    test.runHelper.mockClear();
    await expect(test.coordinator.exchange()).resolves.toMatchObject({
      ok: true,
      credential: { accessToken: "token-1", accountId: "acct-1" },
    });
    expect(test.runHelper).not.toHaveBeenCalled();
  });

  it("refreshes on schedule and ignores stale scheduled revisions after reconnect", async () => {
    const base = Date.now();
    const responses = [
      helperSuccess("token-1", "acct-1", base + 60 * 60_000),
      helperSuccess("token-2", "acct-1", base + 120 * 60_000),
      helperSuccess("replacement", "acct-2", base + 180 * 60_000),
    ];
    const test = subject({ runHelper: async () => responses.shift()! });
    await test.coordinator.connect("first");
    const firstRevision = test.schedules[test.schedules.length - 1]!.revision;
    await test.coordinator.scheduledRefresh(firstRevision);
    await expect(test.coordinator.exchange()).resolves.toMatchObject({ credential: { accessToken: "token-2" } });
    const staleRevision = test.schedules[test.schedules.length - 1]!.revision;
    await test.coordinator.connect("replacement");
    test.runHelper.mockClear();
    await test.coordinator.scheduledRefresh(staleRevision);
    expect(test.runHelper).not.toHaveBeenCalled();
    await expect(test.coordinator.exchange()).resolves.toMatchObject({
      credential: { accessToken: "replacement", accountId: "acct-2" },
    });
  });

  it("keeps a valid cached token on scheduled failure and marks an expired one unavailable", async () => {
    let now = Date.now();
    const responses: CodexAuthHelperResult[] = [
      helperSuccess("cached", "acct-1", now + 30_000),
      { version: 1, ok: false, error: { code: "refresh_timeout" } },
      { version: 1, ok: false, error: { code: "refresh_timeout" } },
    ];
    const test = subject({ now: () => now, runHelper: async () => responses.shift()! });
    await test.coordinator.connect("candidate");
    let record = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    await test.coordinator.scheduledRefresh(record!.revision);
    await expect(test.coordinator.status()).resolves.toMatchObject({ authenticated: true, status: "connected" });
    now += 31_000;
    record = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    await test.coordinator.scheduledRefresh(record!.revision);
    await expect(test.coordinator.status()).resolves.toMatchObject({
      authenticated: false,
      status: "temporarily_unavailable",
    });
  });

  it("keeps a valid cached token when scheduling its transient retry fails", async () => {
    const now = Date.now();
    let scheduleCount = 0;
    const responses: CodexAuthHelperResult[] = [
      helperSuccess("cached", "acct-1", now + 10 * 60_000),
      { version: 1, ok: false, error: { code: "refresh_timeout" } },
    ];
    const test = subject({
      now: () => now,
      runHelper: async () => responses.shift()!,
      scheduleRefresh: async () => {
        scheduleCount += 1;
        if (scheduleCount > 1) throw new Error("schedule unavailable");
      },
    });
    await test.coordinator.connect("candidate");
    const before = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);

    await expect(test.coordinator.scheduledRefresh(before!.revision)).resolves.toBeUndefined();

    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      revision: 2,
      status: "connected",
      projected: { accessToken: "cached" },
      errorCode: "helper_timeout",
      failureCount: 1,
      retryAt: now + 15_000,
    });
    await expect(test.coordinator.exchange()).resolves.toMatchObject({
      ok: true,
      credential: { accessToken: "cached" },
    });
  });

  it("never serves a known-rejected current token after transient refresh failure", async () => {
    const now = Date.now();
    const responses: CodexAuthHelperResult[] = [
      helperSuccess("rejected", "acct-1", now + 10 * 60_000),
      { version: 1, ok: false, error: { code: "refresh_timeout" } },
      { version: 1, ok: false, error: { code: "refresh_timeout" } },
    ];
    const test = subject({ now: () => now, runHelper: async () => responses.shift()! });
    await test.coordinator.connect("candidate");

    await expect(test.coordinator.exchange(await sha256("rejected"))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(test.coordinator.exchange()).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(test.coordinator.status()).resolves.toMatchObject({
      authenticated: false,
      status: "temporarily_unavailable",
    });
    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      revision: 2,
      status: "temporarily_unavailable",
      projected: { accessToken: "rejected" },
      failureCount: 1,
      retryAt: now + 15_000,
    });
    let record = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    await test.coordinator.scheduledRefresh(record!.revision);
    record = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    expect(record).toMatchObject({
      status: "temporarily_unavailable",
      projected: { accessToken: "rejected" },
      failureCount: 2,
    });

    const restarted = new CodexAuthCoordinator({
      store: test.store,
      runHelper: async () => { throw new Error("must not refresh on the cached fast path"); },
      scheduleRefresh: async () => undefined,
      createGrant: () => "grant",
      now: () => now,
    });
    await expect(restarted.exchange()).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(restarted.status()).resolves.toMatchObject({
      authenticated: false,
      status: "temporarily_unavailable",
    });
  });

  it("durably marks a rejected token when scheduling its failed refresh retry throws", async () => {
    const now = Date.now();
    let scheduleCount = 0;
    const responses: CodexAuthHelperResult[] = [
      helperSuccess("rejected", "acct-1", now + 10 * 60_000),
      { version: 1, ok: false, error: { code: "refresh_timeout" } },
    ];
    const test = subject({
      now: () => now,
      runHelper: async () => responses.shift()!,
      scheduleRefresh: async () => {
        scheduleCount += 1;
        if (scheduleCount > 1) throw new Error("schedule unavailable");
      },
    });
    await test.coordinator.connect("candidate");

    await expect(test.coordinator.exchange(await sha256("rejected"))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      status: "temporarily_unavailable",
      projected: { accessToken: "rejected" },
    });

    const restarted = new CodexAuthCoordinator({
      store: test.store,
      runHelper: async () => { throw new Error("must not serve or refresh the rejected cache"); },
      scheduleRefresh: async () => undefined,
      createGrant: () => "grant",
      now: () => now,
    });
    await expect(restarted.exchange()).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
  });

  it("durably rejects a no-progress rejection refresh in one revision", async () => {
    const now = Date.now();
    const unchanged = helperSuccess("rejected", "acct-1", now + 10 * 60_000);
    const responses = [unchanged, unchanged];
    const test = subject({ now: () => now, runHelper: async () => responses.shift()! });
    await test.coordinator.connect("candidate");

    await expect(test.coordinator.exchange(await sha256("rejected"))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      revision: 2,
      status: "temporarily_unavailable",
      errorCode: "invalid_refresh_result",
      failureCount: 1,
      retryAt: now + 15_000,
    });
  });

  it("recovers an expired temporarily-unavailable record on demand after backoff", async () => {
    let now = Date.now();
    let helperCall = 0;
    let scheduleCall = 0;
    const test = subject({
      now: () => now,
      runHelper: async () => {
        helperCall += 1;
        if (helperCall === 1) return helperSuccess("expiring", "acct-1", now + 20_000);
        if (helperCall === 2) return { version: 1, ok: false, error: { code: "refresh_timeout" } };
        return helperSuccess("recovered", "acct-1", now + 60 * 60_000);
      },
      scheduleRefresh: async () => {
        scheduleCall += 1;
        if (scheduleCall > 1) throw new Error("schedule unavailable");
      },
    });
    await test.coordinator.connect("candidate");
    now += 21_000;
    const connected = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    await test.coordinator.scheduledRefresh(connected!.revision);
    const unavailable = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
    expect(unavailable).toMatchObject({
      revision: 2,
      status: "temporarily_unavailable",
      retryAt: now + 15_000,
    });

    await expect(test.coordinator.exchange()).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    expect(helperCall).toBe(2);

    now = unavailable!.retryAt!;
    await expect(test.coordinator.exchange()).resolves.toMatchObject({
      ok: true,
      credential: { accessToken: "recovered" },
    });
    expect(helperCall).toBe(3);
    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      revision: 3,
      status: "connected",
      projected: { accessToken: "recovered" },
    });
    expect((await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY))?.retryAt).toBeUndefined();
  });

  it("keeps a rotated credential when scheduling its next refresh fails", async () => {
    const now = Date.now();
    let scheduleCount = 0;
    const responses = [
      helperSuccess("old", "acct-1", now + 60 * 60_000),
      helperSuccess("rotated", "acct-1", now + 120 * 60_000),
    ];
    const test = subject({
      now: () => now,
      runHelper: async () => responses.shift()!,
      scheduleRefresh: async () => {
        scheduleCount += 1;
        if (scheduleCount > 1) throw new Error("schedule unavailable");
      },
    });
    await test.coordinator.connect("candidate");

    await expect(test.coordinator.exchange(await sha256("old"))).resolves.toMatchObject({
      ok: true,
      credential: { accessToken: "rotated" },
    });
    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      revision: 2,
      status: "connected",
      projected: { accessToken: "rotated" },
    });
  });

  it("treats a successful no-op managed refresh as transient failure", async () => {
    const now = Date.now();
    const unchanged = helperSuccess("cached", "acct-1", now + 10 * 60_000, "unchanged");
    const test = subject({ now: () => now, runHelper: async () => unchanged });
    await test.coordinator.connect("candidate");
    const record = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);

    await test.coordinator.scheduledRefresh(record!.revision);

    await expect(test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY)).resolves.toMatchObject({
      status: "connected",
      projected: { accessToken: "cached", expiresAt: now + 10 * 60_000 },
      errorCode: "invalid_refresh_result",
      failureCount: 1,
    });
    expect(test.schedules.at(-1)?.at.getTime()).toBe(now + 15_000);
    await expect(test.coordinator.exchange(await sha256("cached"))).resolves.toMatchObject({
      ok: false,
      reason: "temporarily_unavailable",
    });
    await expect(test.coordinator.status()).resolves.toMatchObject({
      authenticated: false,
      status: "temporarily_unavailable",
    });
  });

  it("marks provider rejection and account drift as reconnect-required without committing candidates", async () => {
    for (const failure of [
      { version: 1, ok: false, error: { code: "provider_rejected" } } as const,
      helperSuccess("drift", "acct-2"),
    ]) {
      const responses: CodexAuthHelperResult[] = [helperSuccess("old"), failure];
      const test = subject({ runHelper: async () => responses.shift()! });
      await test.coordinator.connect("candidate");
      await expect(test.coordinator.exchange(await sha256("old"))).resolves.toMatchObject({
        ok: false,
        reason: "needs_reconnect",
      });
      const stored = await test.store.get<CodexAuthRecordV1>(CODEX_AUTH_RECORD_KEY);
      expect(stored?.authJson).toBe(JSON.stringify({ marker: "old" }));
      expect(stored?.projected.accessToken).toBe("old");
      expect(stored?.status).toBe("needs_reconnect");
    }
  });

  it("coalesces concurrent rejection refreshes and returns the rotated token for stale rejection", async () => {
    const base = Date.now();
    let release!: (value: CodexAuthHelperResult) => void;
    const pending = new Promise<CodexAuthHelperResult>((resolve) => { release = resolve; });
    let call = 0;
    const test = subject({
      runHelper: async () => ++call === 1
        ? helperSuccess("old", "acct-1", base + 60 * 60_000)
        : await pending,
    });
    await test.coordinator.connect("candidate");
    test.runHelper.mockClear();
    const rejected = await sha256("old");
    const first = test.coordinator.exchange(rejected);
    const second = test.coordinator.exchange(rejected);
    await vi.waitFor(() => expect(test.runHelper).toHaveBeenCalledTimes(1));
    release(helperSuccess("new", "acct-1", base + 120 * 60_000));
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ ok: true, credential: expect.objectContaining({ accessToken: "new" }) }),
      expect.objectContaining({ ok: true, credential: expect.objectContaining({ accessToken: "new" }) }),
    ]);
    test.runHelper.mockClear();
    await expect(test.coordinator.exchange(rejected)).resolves.toMatchObject({
      credential: { accessToken: "new" },
    });
    expect(test.runHelper).not.toHaveBeenCalled();
  });

  it("does not let a stale scheduled callback absorb a current-token rejection", async () => {
    const base = Date.now();
    const responses = [
      helperSuccess("old", "acct-1", base + 60 * 60_000),
      helperSuccess("replacement", "acct-1", base + 120 * 60_000),
      helperSuccess("rotated", "acct-1", base + 180 * 60_000),
    ];
    const test = subject({ runHelper: async () => responses.shift()! });
    await test.coordinator.connect("old-candidate");
    const staleRevision = test.schedules.at(-1)!.revision;
    await test.coordinator.connect("replacement-candidate");
    test.runHelper.mockClear();

    const stale = test.coordinator.scheduledRefresh(staleRevision);
    const rejected = test.coordinator.exchange(await sha256("replacement"));

    await stale;
    await expect(rejected).resolves.toMatchObject({
      ok: true,
      credential: { accessToken: "rotated" },
    });
    expect(test.runHelper).toHaveBeenCalledTimes(1);
  });

  it("issues provider-scoped, expiring, single-use grants", async () => {
    let now = Date.now();
    let next = 0;
    const test = subject({ now: () => now, createGrant: () => `secret-grant-${++next}` });
    const grants = await test.coordinator.issueGrants(["codex", "claude"]);
    expect(grants).toEqual({ codex: "secret-grant-1", claude: "secret-grant-2" });
    expect(JSON.stringify([...test.store.values.values()])).not.toContain("secret-grant-");
    await expect(test.coordinator.consumeGrant("claude", grants.codex!)).resolves.toBe(false);
    await expect(test.coordinator.consumeGrant("codex", grants.codex!)).resolves.toBe(true);
    await expect(test.coordinator.consumeGrant("codex", grants.codex!)).resolves.toBe(false);
    now += 5 * 60_000 + 1;
    await expect(test.coordinator.consumeGrant("claude", grants.claude!)).resolves.toBe(false);
    expect(test.store.values.size).toBe(1);
    await expect(test.store.get(AUTH_CONNECT_GRANTS_KEY)).resolves.toEqual({ version: 1, grants: [] });
  });

  it("tracks each Settings connection from approval through provider completion", async () => {
    let next = 0;
    const connectionId = "connection-attempt-1234";
    const test = subject({ createGrant: () => `secret-grant-${++next}` });
    const grants = await test.coordinator.issueGrants(["codex", "claude"], connectionId);

    await expect(test.coordinator.connectionStatus(connectionId)).resolves.toEqual({
      status: "pending",
      providers: { codex: "pending", claude: "pending" },
    });
    await expect(test.coordinator.recordGrantResult("codex", grants.codex!, "success")).resolves.toBe(false);
    await expect(test.coordinator.consumeGrant("codex", grants.codex!)).resolves.toBe(true);
    await expect(test.coordinator.recordGrantResult("codex", grants.codex!, "success")).resolves.toBe(true);
    await expect(test.coordinator.connectionStatus(connectionId)).resolves.toEqual({
      status: "pending",
      providers: { codex: "success", claude: "pending" },
    });

    await expect(test.coordinator.consumeGrant("claude", grants.claude!)).resolves.toBe(true);
    await expect(test.coordinator.recordGrantResult(
      "claude",
      grants.claude!,
      "error",
      "Claude could not be saved.",
    )).resolves.toBe(true);
    await expect(test.coordinator.connectionStatus(connectionId)).resolves.toEqual({
      status: "error",
      providers: { codex: "success", claude: "error" },
      error: "Claude could not be saved.",
    });
  });

  it("reports a tracked connection as successful once all grants finish", async () => {
    const connectionId = "connection-attempt-5678";
    const test = subject({ createGrant: () => "secret-grant" });
    const grants = await test.coordinator.issueGrants(["codex"], connectionId);
    await test.coordinator.consumeGrant("codex", grants.codex!);
    await test.coordinator.recordGrantResult("codex", grants.codex!, "success");

    await expect(test.coordinator.connectionStatus(connectionId)).resolves.toEqual({
      status: "success",
      providers: { codex: "success" },
    });
  });

  it("bounds outstanding and consumed grant storage", async () => {
    let next = 0;
    const test = subject({ createGrant: () => `secret-grant-${++next}` });
    for (let index = 0; index < 80; index += 1) {
      const grants = await test.coordinator.issueGrants(["codex"]);
      if (index % 2 === 0) {
        await expect(test.coordinator.consumeGrant("codex", grants.codex!)).resolves.toBe(true);
      }
    }

    const stored = await test.store.get<{ version: 1; grants: unknown[] }>(AUTH_CONNECT_GRANTS_KEY);
    expect(stored).toMatchObject({ version: 1 });
    expect(stored?.grants).toHaveLength(64);
    expect(test.store.values.size).toBe(1);
    expect(JSON.stringify(stored)).not.toContain("secret-grant-");
  });

  it("fails closed and repairs malformed grant storage", async () => {
    const test = subject();
    test.store.values.set(AUTH_CONNECT_GRANTS_KEY, { version: 1 });

    await expect(test.coordinator.consumeGrant("codex", "candidate")).resolves.toBe(false);
    await expect(test.store.get(AUTH_CONNECT_GRANTS_KEY)).resolves.toEqual({ version: 1, grants: [] });
  });
});
