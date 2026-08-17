import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvLifecycleState, EnvMeta, EnvMutableState } from "../types";
import { createGitHubPendingPublishProjection, createInitialEnvScmState, createInitialRepoScmState } from "../scm/model";
import {
  ENV_LIFECYCLE_SAVE_TIMEOUT_MS,
  ENV_LIFECYCLE_START_TIMEOUT_MS,
  ENV_LIFECYCLE_STOP_TIMEOUT_MS,
} from "../env-lifecycle";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { EnvLifecycleDO } from "../env-lifecycle-do";
import { buildMutableStateFromMeta } from "../env/state";

type MemoryStorage = {
  get: <T>(key: string) => Promise<T | null>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string | string[]) => Promise<void>;
  transaction: <T>(callback: (txn: Pick<MemoryStorage, "get" | "put" | "delete" | "setAlarm" | "deleteAlarm">) => Promise<T>) => Promise<T>;
  getAlarm: () => Promise<number | null>;
  setAlarm: (time: number) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

function createMemoryStorage(): MemoryStorage {
  const data = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let transactionTail = Promise.resolve();

  const storage: MemoryStorage = {
    async get<T>(key: string) {
      return (data.get(key) as T | undefined) ?? null;
    },
    async put(key: string, value: unknown) {
      data.set(key, value);
    },
    async delete(key: string | string[]) {
      for (const candidate of Array.isArray(key) ? key : [key]) data.delete(candidate);
    },
    async transaction<T>(callback: (txn: Pick<MemoryStorage, "get" | "put" | "delete" | "setAlarm" | "deleteAlarm">) => Promise<T>) {
      const run = transactionTail.then(() => callback(storage));
      transactionTail = run.then(() => undefined, () => undefined);
      return run;
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(time: number) {
      alarmAt = time;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
  };
  return storage;
}

function createSubject(
  envOverrides: Record<string, unknown> = {},
  storage = createMemoryStorage(),
) {
  const instance = Object.create(EnvLifecycleDO.prototype) as EnvLifecycleDO & {
    ctx: { storage: MemoryStorage };
  };
  instance.ctx = {
    storage,
  } as any;
  (instance as any).env = envOverrides;
  return instance;
}

async function beginStartForTest(subject: ReturnType<typeof createSubject>): Promise<EnvLifecycleState> {
  if (!await subject.peekMutableState()) {
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      status: "stopped",
      workspaceDirty: null,
      workspaceNeedsAttention: null,
      workspaceLastSyncedAt: null,
      baseMainCommit: null,
      lastKnownMainCommit: null,
      branchStatus: null,
    }));
  }
  const claim = await subject.beginStart({ model: "claude-opus-4.8", effort: "xhigh" });
  if (!claim.dispatchGranted || !claim.lifecycle) {
    throw new Error("Expected the test start claim to succeed");
  }
  return claim.lifecycle;
}

function createEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const backend = overrides.backend ?? "cf";
  return {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/test/repo",
    backend,
    executionPlacement: overrides.executionPlacement ?? (
      backend === "cf"
        ? { backend: "cf", machineId: null }
        : { backend: "host", machineId: "machine-1" }
    ),
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    status: "running",
    ...createInitialEnvScmState({
      slug: "demo-env",
      mainCommit: "main-old",
    }),
    workspaceDirty: false,
    workspaceNeedsAttention: false,
    workspaceLastSyncedAt: "2026-04-10T00:00:00.000Z",
    implementorAttentionToken: null,
    ...overrides,
  };
}

function createCodexProjectionSubject() {
  const kv = new Map<string, string>();
  const definition = {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoId: "repo-1",
    scmModel: "github" as const,
    executionPlacement: { backend: "cf" as const, machineId: null },
    harness: "codex" as const,
    codexAuthMode: "api-key" as const,
    startupPlanId: null,
    branchName: "env/demo-env",
    createdAt: "2026-04-10T00:00:00.000Z",
  };
  const repoMeta = {
    repoId: "repo-1",
    repoUrl: "https://github.com/test/repo",
    githubInstallationId: 98765,
    githubFullName: "test/repo",
    ...createInitialRepoScmState(),
    githubDefaultBranch: "main",
    githubDefaultBranchHeadSha: "main-old",
    mainCommit: "main-old",
    createdAt: "2026-04-10T00:00:00.000Z",
    updatedAt: "2026-04-10T00:00:00.000Z",
    bootstrappedFromRef: "main",
  };
  const { repoUrl: _repoUrl, ...storedRepoMeta } = repoMeta;
  kv.set("envdef:demo-env", JSON.stringify(definition));
  kv.set("repo:repo-1", JSON.stringify({ repoId: "repo-1", updatedAt: repoMeta.updatedAt }));
  const broadcastEnvUpsert = vi.fn().mockResolvedValue(undefined);
  const env = {
    ENVS_KV: {
      get: vi.fn(async (key: string) => kv.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
      delete: vi.fn(async (key: string) => { kv.delete(key); }),
    },
    WORKSPACE: {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn(() => ({
        readWorkspaceFile: vi.fn(async (path: string) => path === "/.tiller/repo/meta.json"
          ? JSON.stringify(storedRepoMeta)
          : null),
      })),
    },
    HUB: {
      idFromName: vi.fn(() => "hub-id"),
      get: vi.fn(() => ({ broadcastEnvUpsert })),
    },
  };
  const subject = createSubject(env);
  const storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
  return { subject, storage, definition, broadcastEnvUpsert };
}

describe("EnvLifecycleDO", () => {
  it("allows the runner's complete quiesce and strict-save contract to finish", () => {
    const harnessQuiesceTimeoutMs = 35_000;
    const strictWorkspaceSyncTimeoutMs = 60_000;
    const containerWakeHeadroomMs = 25_000;
    const progressRequestTimeoutMs = 2_000;
    const progressRequestCount = 3;
    const finalAcknowledgementTimeoutMs = 10_000;
    const durableObjectSchedulingHeadroomMs = 30_000;

    expect(ENV_LIFECYCLE_SAVE_TIMEOUT_MS).toBeGreaterThanOrEqual(
      harnessQuiesceTimeoutMs
      + strictWorkspaceSyncTimeoutMs
      + containerWakeHeadroomMs
      + progressRequestTimeoutMs * progressRequestCount
      + finalAcknowledgementTimeoutMs
      + durableObjectSchedulingHeadroomMs,
    );
  });

  beforeEach(() => {
    vi.useRealTimers();
  });

  it("persists an owned projection without acknowledging delivery when broadcast is disabled", async () => {
    const summaries = new Map<string, string>();
    const broadcastEnvUpsert = vi.fn();
    const subject = createSubject({
      ENVS_KV: {
        put: vi.fn(async (key: string, value: string) => { summaries.set(key, value); }),
      },
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({ broadcastEnvUpsert })),
      },
    });
    const meta = createEnvMeta({ status: "stopped" });
    vi.spyOn(subject, "getOwnedEnvView").mockResolvedValue(meta);
    const storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
    await storage.put("env-projection-version", 7);
    await storage.put("env-projection-dirty-version", 7);

    await expect(subject.persistOwnedProjection({ broadcast: false })).resolves.toBe(meta);

    expect(JSON.parse(summaries.get("demo-env") ?? "null")).toMatchObject({
      slug: "demo-env",
      status: "stopped",
    });
    expect(broadcastEnvUpsert).not.toHaveBeenCalled();
    await expect(storage.get("env-projection-dirty-version")).resolves.toBe(7);
  });

  it("acknowledges only the projection version that was broadcast", async () => {
    const summaries = new Map<string, string>();
    let storage: MemoryStorage;
    const broadcastEnvUpsert = vi.fn(async () => {
      await storage.put("env-projection-version", 8);
      await storage.put("env-projection-dirty-version", 8);
    });
    const subject = createSubject({
      ENVS_KV: {
        put: vi.fn(async (key: string, value: string) => { summaries.set(key, value); }),
      },
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => ({ broadcastEnvUpsert })),
      },
    });
    const meta = createEnvMeta({ status: "stopped" });
    vi.spyOn(subject, "getOwnedEnvView").mockResolvedValue(meta);
    storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
    await storage.put("env-projection-version", 7);
    await storage.put("env-projection-dirty-version", 7);

    await expect(subject.persistOwnedProjection()).resolves.toBe(meta);

    expect(broadcastEnvUpsert).toHaveBeenCalledWith(expect.objectContaining({
      slug: "demo-env",
      status: "stopped",
    }));
    await expect(storage.get("env-projection-dirty-version")).resolves.toBe(8);

    broadcastEnvUpsert.mockImplementation(async () => {});
    await expect(subject.persistOwnedProjection()).resolves.toBe(meta);
    await expect(storage.get("env-projection-dirty-version")).resolves.toBeNull();
  });

  it("creates a saving stop operation", async () => {
    const subject = createSubject();

    const state = await subject.requestStop();

    expect(state.phase).toBe("saving");
    expect(state.activeOperation).toBe("stop");
    expect(state.desiredState).toBe("stopped");
    expect(state.activeOpId).toMatch(/^stop-/);
  });

  it("durably queues the exact active Stop for immediate alarm dispatch", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const state = await subject.requestStop();

    await expect(subject.ensureStopDispatchScheduled("stale-stop-op")).resolves.toBe(false);
    await expect(storage.get("stop-retry-v1")).resolves.toBeNull();

    await expect(subject.ensureStopDispatchScheduled(state.activeOpId)).resolves.toBe(true);
    await expect(storage.get("stop-retry-v1")).resolves.toEqual({
      opId: state.activeOpId,
      attempt: 0,
      nextAttemptAtMs: Date.now(),
    });
    await expect(storage.getAlarm()).resolves.toBe(Date.now());
    vi.useRealTimers();
  });

  it("exposes failed Stop finalization only while the exact retry still owns a live runner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    await beginStartForTest(subject);
    await storage.put("env-publication", {
      incarnationId: "incarnation-1",
      state: "visible",
      updatedAt: new Date().toISOString(),
    });
    const stop = await subject.requestStop();
    await subject.ensureStopDispatchScheduled(stop.activeOpId);

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1));
    await subject.getState();
    await expect(subject.getEnvironmentRuntimeSubject()).resolves.toMatchObject({
      failedStopFinalizationAuthorized: true,
      lifecycle: {
        phase: "failed",
        activeOpId: stop.activeOpId,
      },
    });

    await storage.delete("stop-retry-v1");
    await expect(subject.getEnvironmentRuntimeSubject()).resolves.toMatchObject({
      failedStopFinalizationAuthorized: false,
    });
    vi.useRealTimers();
  });

  it("creates a starting start operation", async () => {
    const subject = createSubject();

    const state = await beginStartForTest(subject);

    expect(state.phase).toBe("starting");
    expect(state.activeOperation).toBe("start");
    expect(state.desiredState).toBe("running");
    expect(state.activeOpId).toMatch(/^start-/);
  });

  it("fences completion reports by Start and preserves unread attention across stop and restart", async () => {
    const subject = createSubject();
    const firstStart = await beginStartForTest(subject);
    const firstOpId = firstStart.activeOpId!;

    await expect(subject.reportImplementorCompletion("stale-start", 1)).resolves.toEqual({
      accepted: false,
      changed: false,
    });
    await expect(subject.reportImplementorCompletion(firstOpId, 1)).resolves.toEqual({
      accepted: true,
      changed: true,
    });
    const firstToken = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken;
    expect(firstToken).toEqual(expect.any(String));

    await expect(subject.reportImplementorCompletion(firstOpId, 1)).resolves.toEqual({
      accepted: true,
      changed: false,
    });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toBe(firstToken);

    await expect(subject.acknowledgeImplementorAttention(firstToken!))
      .resolves.toBe("acknowledged");
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toBeNull();
    await expect(subject.reportImplementorCompletion(firstOpId, 1)).resolves.toEqual({
      accepted: true,
      changed: false,
    });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toBeNull();

    await subject.reportImplementorCompletion(firstOpId, 2);
    const unreadBeforeStop = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken;
    expect(unreadBeforeStop).toEqual(expect.any(String));
    await subject.setStatus("stopped", { clearLifecycle: true });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toBe(unreadBeforeStop);

    const secondStart = await beginStartForTest(subject);
    const secondOpId = secondStart.activeOpId!;
    expect(secondOpId).not.toBe(firstOpId);
    expect((await subject.peekMutableState())!.implementorAttentionState).toEqual({
      runtimeStartOpId: secondOpId,
      lastCompletionSequence: 0,
      unreadToken: unreadBeforeStop,
    });
    await expect(subject.reportImplementorCompletion(firstOpId, 3)).resolves.toEqual({
      accepted: false,
      changed: false,
    });
    await expect(subject.reportImplementorCompletion(secondOpId, 1)).resolves.toEqual({
      accepted: true,
      changed: true,
    });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .not.toBe(unreadBeforeStop);
  });

  it("serializes completion and acknowledgement races without clearing a newer token", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);
    await subject.reportImplementorCompletion(start.activeOpId!, 1);
    const firstToken = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken!;

    const [completion, acknowledgement] = await Promise.all([
      subject.reportImplementorCompletion(start.activeOpId!, 2),
      subject.acknowledgeImplementorAttention(firstToken),
    ]);
    const finalToken = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken;

    expect(completion).toEqual({ accepted: true, changed: true });
    expect(["acknowledged", "conflict"]).toContain(acknowledgement);
    expect(finalToken).toEqual(expect.any(String));
    expect(finalToken).not.toBe(firstToken);
  });

  it("records reviewer completion without allowing a callback retry to replace newer attention", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);

    await expect(subject.reportReviewerCompletion("review-run-1")).resolves.toEqual({
      accepted: true,
      changed: true,
    });
    const reviewToken = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken;
    expect(reviewToken).toEqual(expect.any(String));

    await expect(subject.reportReviewerCompletion("review-run-1")).resolves.toEqual({
      accepted: true,
      changed: false,
    });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toBe(reviewToken);

    await subject.reportImplementorCompletion(start.activeOpId!, 1);
    const implementorToken = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken;
    expect(implementorToken).not.toBe(reviewToken);

    await expect(subject.reportReviewerCompletion("review-run-1")).resolves.toEqual({
      accepted: true,
      changed: false,
    });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toBe(implementorToken);

    await expect(subject.reportReviewerCompletion("review-run-2")).resolves.toEqual({
      accepted: true,
      changed: true,
    });
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .not.toBe(implementorToken);
  });

  it("does not reconcile lifecycle alarms for an idempotent acknowledgement", async () => {
    const subject = createSubject();
    await beginStartForTest(subject);
    const scheduleNextAlarm = vi.spyOn(
      subject as unknown as { scheduleNextAlarm: (...args: unknown[]) => Promise<void> },
      "scheduleNextAlarm",
    );

    await expect(subject.acknowledgeImplementorAttention("already-cleared-token"))
      .resolves.toBe("acknowledged");
    expect(scheduleNextAlarm).not.toHaveBeenCalled();
  });

  it("drops unread attention when an environment is deleted and recreated", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);
    await subject.reportImplementorCompletion(start.activeOpId!, 1);
    expect((await subject.peekMutableState())!.implementorAttentionState.unreadToken)
      .toEqual(expect.any(String));

    await subject.clearMutableState();
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      incarnationId: "incarnation-2",
      status: "stopped",
      implementorAttentionToken: null,
    }));

    expect((await subject.peekMutableState())!.implementorAttentionState).toEqual({
      runtimeStartOpId: null,
      lastCompletionSequence: 0,
      unreadToken: null,
    });
  });

  it("atomically rebases an active runner command above the machine high-water", async () => {
    const subject = createSubject();
    const storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      backend: "host",
      status: "stopped",
      lifecyclePhase: "stopped",
    }));
    const start = await subject.beginStart({ model: "gpt-5.6-sol", effort: "high" });
    const operationId = start.lifecycle!.activeOpId!;
    const rejected = await subject.claimRunnerCommand(operationId, "running");

    expect(rejected.commandGeneration).toBe(1);
    const rebased = await subject.rebaseRejectedRunnerCommand({
      rejectedCommand: rejected,
      currentCommandGeneration: 60,
    });

    expect(rebased).toEqual({
      commandGeneration: 61,
      operationId,
      desiredState: "running",
    });
    await expect(storage.get("runner-command-generation")).resolves.toBe(61);
    await expect(storage.get("runner-command-claim")).resolves.toEqual(rebased);
    await expect(subject.rebaseRejectedRunnerCommand({
      rejectedCommand: rejected,
      currentCommandGeneration: 60,
    })).resolves.toEqual(rebased);
  });

  it("refuses invalid, exhausted, mismatched, and superseded runner rebases", async () => {
    const createActiveStart = async () => {
      const subject = createSubject();
      const storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
      await subject.initializeMutableStateFromMeta(createEnvMeta({
        backend: "host",
        status: "stopped",
        lifecyclePhase: "stopped",
      }));
      const start = await subject.beginStart({ model: "gpt-5.6-sol", effort: "high" });
      const rejected = await subject.claimRunnerCommand(start.lifecycle!.activeOpId!, "running");
      return { subject, storage, rejected };
    };

    const invalid = await createActiveStart();
    await expect(invalid.subject.rebaseRejectedRunnerCommand({
      rejectedCommand: invalid.rejected,
      currentCommandGeneration: invalid.rejected.commandGeneration,
    })).rejects.toThrow(/metadata is invalid/i);
    await expect(invalid.subject.rebaseRejectedRunnerCommand({
      rejectedCommand: { ...invalid.rejected, operationId: "another-start" },
      currentCommandGeneration: 60,
    })).rejects.toThrow(/superseded/i);

    const exhausted = await createActiveStart();
    await exhausted.storage.put("runner-command-generation", Number.MAX_SAFE_INTEGER);
    await expect(exhausted.subject.rebaseRejectedRunnerCommand({
      rejectedCommand: exhausted.rejected,
      currentCommandGeneration: 60,
    })).rejects.toThrow(/exhausted/i);

    const stopped = await createActiveStart();
    await stopped.subject.requestStop();
    await expect(stopped.subject.rebaseRejectedRunnerCommand({
      rejectedCommand: stopped.rejected,
      currentCommandGeneration: 60,
    })).rejects.toThrow(/superseded/i);

    const deleted = await createActiveStart();
    await deleted.subject.beginDelete();
    await expect(deleted.subject.rebaseRejectedRunnerCommand({
      rejectedCommand: deleted.rejected,
      currentCommandGeneration: 60,
    })).rejects.toThrow(/superseded/i);
  });

  it("freezes the implementor profile per Start and retains its capability through Stop quiescence", async () => {
    const subject = createSubject();
    const storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
    const firstStart = await beginStartForTest(subject);
    const firstOpId = firstStart.activeOpId!;
    await storage.put("env-publication", {
      incarnationId: "incarnation-1",
      state: "visible",
    });
    const subscriptionProfile = {
      kind: "subscription-app-server" as const,
      surface: "implementor" as const,
      backend: "cf" as const,
    };
    const apiKeyProfile = {
      kind: "api-key-direct-cli" as const,
      surface: "implementor" as const,
      backend: "cf" as const,
    };

    await expect(subject.claimCodexExecutionProfile(firstOpId, subscriptionProfile))
      .resolves.toEqual(subscriptionProfile);
    await expect(subject.claimCodexExecutionProfile(firstOpId, apiKeyProfile))
      .resolves.toEqual(subscriptionProfile);
    await expect(subject.getActiveImplementorCodexRuntimeSubject()).resolves.toEqual({
      envSlug: "demo-env",
      incarnationId: "incarnation-1",
      startOpId: firstOpId,
      profile: subscriptionProfile,
    });
    await expect(subject.acceptImplementorCodexRuntimeAuth(firstOpId, "account-1"))
      .resolves.toBe("accepted");
    await expect(subject.acceptImplementorCodexRuntimeAuth(firstOpId, "account-1"))
      .resolves.toBe("accepted");
    await expect(subject.acceptImplementorCodexRuntimeAuth(firstOpId, "account-2"))
      .resolves.toBe("account_changed");

    const stop = await subject.requestStop();
    await expect(subject.getCodexExecutionProfile(firstOpId)).resolves.toEqual(subscriptionProfile);
    await expect(subject.getActiveImplementorCodexRuntimeSubject()).resolves.toEqual({
      envSlug: "demo-env",
      incarnationId: "incarnation-1",
      startOpId: firstOpId,
      profile: subscriptionProfile,
    });
    await expect(subject.acceptImplementorCodexRuntimeAuth(firstOpId, "account-1"))
      .resolves.toBe("accepted");

    await expect(subject.acceptStopWorkspaceSynced(stop.activeOpId)).resolves.toMatchObject({
      accepted: true,
      state: { phase: "stopping" },
    });
    await expect(subject.getActiveImplementorCodexRuntimeSubject()).resolves.toEqual({
      envSlug: "demo-env",
      incarnationId: "incarnation-1",
      startOpId: firstOpId,
      profile: subscriptionProfile,
    });
    await expect(subject.acceptImplementorCodexRuntimeAuth(firstOpId, "account-1"))
      .resolves.toBe("accepted");

    await expect(subject.noteRunnerStopped(stop.activeOpId, "exit")).resolves.toMatchObject({
      phase: "stopped",
      desiredState: "stopped",
    });
    await expect(subject.getActiveImplementorCodexRuntimeSubject()).resolves.toBeNull();
    await expect(subject.acceptImplementorCodexRuntimeAuth(firstOpId, "account-1"))
      .resolves.toBe("inactive");
    const secondStart = await beginStartForTest(subject);
    const secondOpId = secondStart.activeOpId!;
    expect(secondOpId).not.toBe(firstOpId);
    await expect(subject.claimCodexExecutionProfile(secondOpId, apiKeyProfile))
      .resolves.toEqual(apiKeyProfile);
    await expect(subject.getCodexExecutionProfile(firstOpId)).resolves.toBeNull();
    await expect(subject.getCodexExecutionProfile(secondOpId)).resolves.toEqual(apiKeyProfile);
  });

  it("retries projection scheduling after the profile commit succeeds but the first alarm write fails", async () => {
    const subject = createSubject();
    const storage = (subject as unknown as { ctx: { storage: MemoryStorage } }).ctx.storage;
    const start = await beginStartForTest(subject);
    const profile = {
      kind: "subscription-app-server" as const,
      surface: "implementor" as const,
      backend: "cf" as const,
    };
    await storage.deleteAlarm();
    const setAlarm = vi.spyOn(storage, "setAlarm")
      .mockRejectedValueOnce(new Error("alarm write failed"));

    await expect(subject.claimCodexExecutionProfile(start.activeOpId!, profile))
      .rejects.toThrow("alarm write failed");
    await expect(subject.getCodexExecutionProfile(start.activeOpId!)).resolves.toEqual(profile);
    await expect(storage.get<number>("env-projection-dirty-version")).resolves.not.toBeNull();

    await expect(subject.claimCodexExecutionProfile(start.activeOpId!, profile))
      .resolves.toEqual(profile);
    expect(setAlarm).toHaveBeenCalledTimes(2);
    await expect(storage.getAlarm()).resolves.not.toBeNull();
  });

  it("projects the claimed subscription profile while the stored definition still says API key", async () => {
    const { subject, storage } = createCodexProjectionSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      repoId: "repo-1",
      incarnationId: "incarnation-1",
      harness: "codex",
      harnessSettings: null,
      codexAuthMode: "api-key",
      status: "stopped",
      lifecyclePhase: "stopped",
    }));
    await storage.put("env-publication", {
      incarnationId: "incarnation-1",
      state: "visible",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    const start = await subject.beginStart({ model: "gpt-5.6-sol", effort: "xhigh" });
    const profile = {
      kind: "subscription-app-server" as const,
      surface: "implementor" as const,
      backend: "cf" as const,
    };

    await expect(subject.claimCodexExecutionProfile(start.lifecycle!.activeOpId!, profile))
      .resolves.toEqual(profile);
    await expect(subject.getOwnedEnvView()).resolves.toMatchObject({
      status: "starting",
      codexAuthMode: "subscription",
    });

    await subject.noteRunnerStarted(start.lifecycle!.activeOpId);
    await expect(subject.getOwnedEnvView()).resolves.toMatchObject({
      status: "running",
      codexAuthMode: "subscription",
    });
  });

  it("hides an old profile during restart and publishes a newer timestamp when the new profile is claimed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    try {
      const { subject, storage } = createCodexProjectionSubject();
      await subject.initializeMutableStateFromMeta(createEnvMeta({
        repoId: "repo-1",
        incarnationId: "incarnation-1",
        harness: "codex",
        harnessSettings: null,
        codexAuthMode: "api-key",
        status: "stopped",
        lifecyclePhase: "stopped",
      }));
      await storage.put("env-publication", {
        incarnationId: "incarnation-1",
        state: "visible",
        updatedAt: "2026-04-10T00:00:00.000Z",
      });
      const apiKeyProfile = {
        kind: "api-key-direct-cli" as const,
        surface: "implementor" as const,
        backend: "cf" as const,
      };
      const subscriptionProfile = {
        kind: "subscription-app-server" as const,
        surface: "implementor" as const,
        backend: "cf" as const,
      };
      const firstStart = await subject.beginStart({ model: "gpt-5.6-sol", effort: "xhigh" });
      await subject.claimCodexExecutionProfile(firstStart.lifecycle!.activeOpId!, apiKeyProfile);
      await subject.noteRunnerStarted(firstStart.lifecycle!.activeOpId);
      await subject.requestStop();
      vi.setSystemTime(new Date("2026-04-10T00:00:01.000Z"));
      await subject.setStatus("stopped", { clearLifecycle: true });

      const secondStart = await subject.beginStart({ model: "gpt-5.6-sol", effort: "xhigh" });
      const beforeClaim = await subject.getOwnedEnvView();
      expect(beforeClaim).not.toHaveProperty("codexAuthMode");
      const versionBeforeClaim = await storage.get<number>("env-projection-version");

      await subject.claimCodexExecutionProfile(secondStart.lifecycle!.activeOpId!, subscriptionProfile);
      const afterClaim = await subject.getOwnedEnvView();
      expect(afterClaim).toMatchObject({ codexAuthMode: "subscription" });
      expect(Date.parse(afterClaim!.updatedAt)).toBeGreaterThan(Date.parse(beforeClaim!.updatedAt));
      await expect(storage.get<number>("env-projection-version"))
        .resolves.toBeGreaterThan(versionBeforeClaim!);
      await expect(storage.get<number>("env-projection-dirty-version")).resolves.not.toBeNull();
      await expect(storage.getAlarm()).resolves.not.toBeNull();

      await subject.noteRunnerStarted(secondStart.lifecycle!.activeOpId);
      const running = await subject.getOwnedEnvView();
      expect(running).toMatchObject({ status: "running", codexAuthMode: "subscription" });
      expect(Date.parse(running!.updatedAt)).toBeGreaterThanOrEqual(Date.parse(afterClaim!.updatedAt));
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not trust a definition auth mode when the lifecycle profile is absent", async () => {
    const { subject, storage } = createCodexProjectionSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      repoId: "repo-1",
      incarnationId: "incarnation-1",
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
      codexAuthMode: "api-key",
      status: "running",
      lifecyclePhase: "running",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleOpId: "legacy-start",
    }));
    await storage.put("env-publication", {
      incarnationId: "incarnation-1",
      state: "visible",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });

    await expect(subject.getOwnedEnvView()).resolves.not.toHaveProperty("codexAuthMode");
  });

  it("stores the provider billing route in the Start claim and accepts a fresh route for the next Start", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      status: "stopped",
      workspaceDirty: null,
      workspaceNeedsAttention: null,
      workspaceLastSyncedAt: null,
      baseMainCommit: null,
      lastKnownMainCommit: null,
      branchStatus: null,
    }));

    const firstStart = await subject.beginStart(
      { model: "claude-opus-4.8", effort: "xhigh" },
      { claudeAuthMode: "subscription" },
    );
    expect(firstStart).toMatchObject({
      dispatchGranted: true,
      claudeAuthMode: "subscription",
    });
    await expect(subject.getMutableState()).resolves.toMatchObject({
      startClaudeAuthMode: "subscription",
      startCodexAuthPreference: null,
    });

    await subject.requestStop();
    await subject.setStatus("stopped", { clearLifecycle: true });
    const secondStart = await subject.beginStart(
      { model: "claude-opus-4.8", effort: "xhigh" },
      { claudeAuthMode: "api" },
    );
    expect(secondStart).toMatchObject({
      dispatchGranted: true,
      claudeAuthMode: "api",
    });
    expect(secondStart.lifecycle?.activeOpId).not.toBe(firstStart.lifecycle?.activeOpId);
    await expect(subject.getMutableState()).resolves.toMatchObject({
      startClaudeAuthMode: "api",
      startCodexAuthPreference: null,
    });
  });

  it("lets Stop supersede an undispatched start operation", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);

    const stop = await subject.requestStop();

    expect(stop).toMatchObject({
      phase: "saving",
      activeOperation: "stop",
      desiredState: "stopped",
    });
    expect(stop.activeOpId).toMatch(/^stop-/);
    expect(stop.activeOpId).not.toBe(start.activeOpId);
    await expect(subject.getMutableState()).resolves.toMatchObject({
      lifecycleOpId: stop.activeOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
    });
  });

  it("does not claim the runner stopped when a post-dispatch start failure may have left it alive", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);

    const failed = await subject.reportStartupFailure({
      opId: start.activeOpId,
      stepId: "harness-launch",
      message: "runner dispatch response was ambiguous",
      runnerMayExist: true,
    });

    expect(failed).toMatchObject({
      phase: "failed",
      activeOpId: start.activeOpId,
      desiredState: "running",
      infraState: "unknown",
      runtimeReady: false,
      lastError: "runner dispatch response was ambiguous",
    });
  });

  it("commits settings with the winning restart claim and rejects an overwrite", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({ status: "stopped" }));

    const first = await subject.beginStart({ model: "claude-opus-4.8", effort: "high" });
    const second = await subject.beginStart({ model: "claude-fable-5", effort: "max" });

    expect(first).toMatchObject({
      dispatchGranted: true,
      harnessSettings: { model: "claude-opus-4.8", effort: "high" },
      lifecycle: { phase: "starting" },
    });
    expect(second).toMatchObject({
      dispatchGranted: false,
      harnessSettings: { model: "claude-opus-4.8", effort: "high" },
      lifecycle: { activeOpId: first.lifecycle?.activeOpId },
    });
    expect((await subject.getMutableState())?.harnessSettings).toEqual({
      model: "claude-opus-4.8",
      effort: "high",
    });
  });

  it("initializes a new definition and mutable start claim once", async () => {
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => { kv.delete(key); }),
      },
    });
    const initialMeta = createEnvMeta({
      repoId: "repo-1",
      status: "creating",
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
    });
    const definition = {
      slug: "demo-env",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "cf" as const, machineId: null },
      harness: "claude-code" as const,
      startupPlanId: null,
      branchName: "tiller/env/demo-env",
      createdAt: initialMeta.createdAt,
    };

    const first = await subject.initializeAndBeginStart(
      definition,
      buildMutableStateFromMeta(initialMeta),
      { model: "claude-opus-4.8", effort: "xhigh" },
    );
    const second = await subject.initializeAndBeginStart(
      definition,
      buildMutableStateFromMeta(initialMeta),
      { model: "claude-fable-5", effort: "max" },
    );

    expect(first.dispatchGranted).toBe(true);
    expect(second).toMatchObject({
      dispatchGranted: false,
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
    });
    expect(kv.has("envdef:demo-env")).toBe(true);
  });

  it("cleans an ambiguous KV definition write that applies before rejecting", async () => {
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => {
          kv.set(key, value);
          throw new Error("KV acknowledgement lost");
        }),
        delete: vi.fn(async (key: string) => { kv.delete(key); }),
      },
    });
    const initialMeta = createEnvMeta({
      repoId: "repo-1",
      status: "creating",
      harnessSettings: { model: "claude-opus-4.8", effort: "xhigh" },
    });
    const definition = {
      slug: "demo-env",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "cf" as const, machineId: null },
      harness: "claude-code" as const,
      startupPlanId: null,
      branchName: "tiller/env/demo-env",
      createdAt: initialMeta.createdAt,
    };

    await expect(subject.initializeAndBeginStart(
      definition,
      buildMutableStateFromMeta(initialMeta),
      { model: "claude-opus-4.8", effort: "xhigh" },
    )).rejects.toThrow("KV acknowledgement lost");

    expect(kv.has("envdef:demo-env")).toBe(false);
    expect(await subject.peekMutableState()).toBeNull();
  });

  it("atomically grants only one stopped-environment initialization claim", async () => {
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => { kv.delete(key); }),
      },
    });
    const meta = createEnvMeta({
      repoId: "repo-1",
      status: "stopped",
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    });
    const definition = {
      slug: "demo-env",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "host" as const, machineId: "machine-1" },
      harness: "codex" as const,
      startupPlanId: "plan-1",
      branchName: "tiller/env/demo-env",
      createdAt: meta.createdAt,
    };

    const results = await Promise.all([
      subject.initializeStoppedEnvironment(definition, buildMutableStateFromMeta(meta)),
      subject.initializeStoppedEnvironment(definition, buildMutableStateFromMeta(meta)),
    ]);
    const winner = results.find((result) => result.created);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.filter((result) => !result.created)).toHaveLength(1);
    if (!winner?.created) throw new Error("expected stopped initialization winner");
    expect(kv.has("envdef:demo-env")).toBe(false);
    await expect(subject.isInitialCreationPending()).resolves.toBe(true);
    await expect(subject.publishStoppedInitialization(winner.claimId, definition)).resolves.toBe(true);
    expect(kv.has("envdef:demo-env")).toBe(true);
    await expect(subject.commitStoppedInitialization(winner.claimId)).resolves.toBe(true);
    await expect(subject.commitStoppedInitialization(winner.claimId)).resolves.toBe(true);
    await expect(subject.isInitialCreationPending()).resolves.toBe(false);
    expect(await subject.getMutableState()).toMatchObject({ status: "stopped" });
  });

  it("rolls back stopped initialization only for the owning claim", async () => {
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => { kv.delete(key); }),
      },
    });
    const meta = createEnvMeta({ repoId: "repo-1", status: "stopped" });
    const definition = {
      slug: "demo-env",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "cf" as const, machineId: null },
      harness: "claude-code" as const,
      startupPlanId: "plan-1",
      branchName: "tiller/env/demo-env",
      createdAt: meta.createdAt,
    };
    const result = await subject.initializeStoppedEnvironment(definition, buildMutableStateFromMeta(meta));
    if (!result.created) throw new Error("expected stopped initialization claim");
    await expect(subject.publishStoppedInitialization(result.claimId, definition)).resolves.toBe(true);

    await expect(subject.rollbackStoppedInitialization("wrong-claim")).resolves.toBe(false);
    expect(await subject.getMutableState()).not.toBeNull();
    await expect(subject.rollbackStoppedInitialization(result.claimId)).resolves.toBe(true);
    expect(await subject.getMutableState()).toBeNull();
    expect(kv.has("envdef:demo-env")).toBe(false);
  });

  it("blocks lifecycle transitions until stopped initialization is committed", async () => {
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => { kv.delete(key); }),
      },
    });
    const meta = createEnvMeta({
      status: "stopped",
      harness: "codex",
      harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    });
    const definition = {
      slug: "demo-env",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "cf" as const, machineId: null },
      harness: "codex" as const,
      startupPlanId: null,
      branchName: "tiller/env/demo-env",
      createdAt: meta.createdAt,
    };
    const initialization = await subject.initializeStoppedEnvironment(
      definition,
      buildMutableStateFromMeta(meta),
    );
    if (!initialization.created) throw new Error("expected stopped initialization claim");

    vi.useFakeTimers({ now: Date.now() });
    try {
      vi.advanceTimersByTime(6 * 60_000);
      await expect(subject.isInitialCreationPending()).resolves.toBe(true);
      await expect(subject.beginStart({ model: "gpt-5.6-sol", effort: "high" }))
        .resolves.toMatchObject({ dispatchGranted: false });
      await expect(subject.requestStop()).resolves.toMatchObject({ phase: "stopped", activeOpId: null });
    } finally {
      vi.useRealTimers();
    }
    await expect(subject.publishStoppedInitialization(initialization.claimId, definition)).resolves.toBe(true);
    await expect(subject.beginStart({ model: "gpt-5.6-sol", effort: "high" }))
      .resolves.toMatchObject({ dispatchGranted: false });

    await expect(subject.commitStoppedInitialization(initialization.claimId)).resolves.toBe(true);
    await expect(subject.beginStart({ model: "gpt-5.6-sol", effort: "high" }))
      .resolves.toMatchObject({ dispatchGranted: true });
  });

  it("clears Durable Object initialization state even when KV rollback rejects", async () => {
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => {
          if (key === "envdef:demo-env") throw new Error("definition delete failed");
          kv.delete(key);
        }),
      },
    });
    const meta = createEnvMeta({ status: "stopped" });
    const definition = {
      slug: "demo-env",
      incarnationId: "incarnation-1",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "cf" as const, machineId: null },
      harness: "claude-code" as const,
      startupPlanId: null,
      branchName: "tiller/env/demo-env",
      createdAt: meta.createdAt,
    };
    const initialization = await subject.initializeStoppedEnvironment(
      definition,
      buildMutableStateFromMeta(meta),
    );
    if (!initialization.created) throw new Error("expected stopped initialization claim");
    await subject.publishStoppedInitialization(initialization.claimId, definition);

    await expect(subject.rollbackStoppedInitialization(initialization.claimId))
      .rejects.toThrow("KV rollback was incomplete");
    await expect(subject.getMutableState()).resolves.toBeNull();
    await expect(subject.isInitialCreationPending()).resolves.toBe(false);
    await expect(subject.getPublication()).resolves.toMatchObject({ state: "deleted" });
  });

  it("retains the incarnation claim until rollback KV deletes settle", async () => {
    const kv = new Map<string, string>();
    let signalDefinitionDeleteStarted!: () => void;
    let releaseDefinitionDelete!: () => void;
    const definitionDeleteStarted = new Promise<void>((resolve) => {
      signalDefinitionDeleteStarted = resolve;
    });
    const definitionDeleteReleased = new Promise<void>((resolve) => {
      releaseDefinitionDelete = resolve;
    });
    let blockDefinitionDelete = true;
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => {
          if (key === "envdef:demo-env" && blockDefinitionDelete) {
            blockDefinitionDelete = false;
            signalDefinitionDeleteStarted();
            await definitionDeleteReleased;
          }
          kv.delete(key);
        }),
      },
    });
    const meta = createEnvMeta({ status: "stopped" });
    const oldDefinition = {
      slug: "demo-env",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "host" as const, machineId: "machine-1" },
      harness: "codex" as const,
      startupPlanId: "plan-1",
      branchName: "tiller/env/demo-env",
      createdAt: meta.createdAt,
      incarnationId: "incarnation-old",
    };
    const oldInitialization = await subject.initializeStoppedEnvironment(
      oldDefinition,
      buildMutableStateFromMeta(meta),
    );
    if (!oldInitialization.created) throw new Error("expected old stopped initialization claim");
    expect(oldInitialization.claimId).toBe(oldDefinition.incarnationId);
    await subject.publishStoppedInitialization(oldInitialization.claimId, oldDefinition);

    const rollback = subject.rollbackStoppedInitialization(oldInitialization.claimId);
    await definitionDeleteStarted;

    const newDefinition = {
      ...oldDefinition,
      incarnationId: "incarnation-new",
    };
    await expect(subject.initializeStoppedEnvironment(
      newDefinition,
      buildMutableStateFromMeta(meta),
    )).resolves.toMatchObject({ created: false });
    await expect(subject.isInitialCreationPending()).resolves.toBe(true);
    await expect(subject.getPublication()).resolves.toMatchObject({
      incarnationId: oldDefinition.incarnationId,
      state: "deleted",
    });

    releaseDefinitionDelete();
    await expect(rollback).resolves.toBe(true);

    const newInitialization = await subject.initializeStoppedEnvironment(
      newDefinition,
      buildMutableStateFromMeta(meta),
    );
    if (!newInitialization.created) throw new Error("expected new stopped initialization claim");
    expect(newInitialization.claimId).toBe(newDefinition.incarnationId);
    await expect(subject.publishStoppedInitialization(newInitialization.claimId, newDefinition))
      .resolves.toBe(true);
    await expect(subject.commitStoppedInitialization(newInitialization.claimId)).resolves.toBe(true);
    expect(JSON.parse(kv.get("envdef:demo-env") ?? "null")).toMatchObject({
      incarnationId: newDefinition.incarnationId,
    });
  });

  it("advances starting to running on matching runner-ready event", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);

    const next = await subject.noteRunnerStarted(initial.activeOpId);

    expect(next).toMatchObject({
      phase: "running",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "running",
      infraState: "ready",
      runtimeReady: true,
    });
  });

  it("marks a starting env infra-ready without completing startup", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);

    const next = await subject.noteInfraReady(initial.activeOpId);

    expect(next).toMatchObject({
      phase: "starting",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "running",
      infraState: "ready",
      runtimeReady: false,
    });
  });

  it("fails a matching starting operation when runner startup fails", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);

    const next = await subject.noteRunnerStartFailed(initial.activeOpId, "boot failed");

    expect(next).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "stopped",
    });
    expect(next?.lastError).toContain("boot failed");
  });

  it("ignores stale runner-ready callbacks after a retried start", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);
    await subject.noteRunnerStartFailed(initial.activeOpId, "boot failed");
    const retried = await beginStartForTest(subject);

    const next = await subject.noteRunnerStarted(initial.activeOpId);

    expect(retried.activeOpId).not.toBe(initial.activeOpId);
    expect(next).toMatchObject({
      phase: "starting",
      activeOpId: retried.activeOpId,
      desiredState: "running",
    });
  });

  it("ignores stale infra-ready callbacks after a retried Start", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);
    await subject.noteRunnerStartFailed(initial.activeOpId, "boot failed");
    const retried = await beginStartForTest(subject);

    const next = await subject.noteInfraReady(initial.activeOpId);

    expect(retried.activeOpId).not.toBe(initial.activeOpId);
    expect(next).toMatchObject({
      phase: "starting",
      activeOpId: retried.activeOpId,
      infraState: "unknown",
    });
  });

  it("advances saving to stopping on matching workspace-synced ack", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    const next = await subject.noteStopWorkspaceSynced(initial.activeOpId);

    expect(next).toMatchObject({
      phase: "stopping",
      activeOpId: initial.activeOpId,
      lastWorkspaceSyncedAckOpId: initial.activeOpId,
    });
  });

  it("accepts only the exact Stop acknowledgement and its idempotent replay", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    await expect(subject.acceptStopWorkspaceSynced("stale-stop-op")).resolves.toMatchObject({
      accepted: false,
      opId: null,
    });
    await expect(subject.acceptStopWorkspaceSynced(initial.activeOpId)).resolves.toMatchObject({
      accepted: true,
      opId: initial.activeOpId,
      state: { phase: "stopping" },
    });
    await expect(subject.acceptStopWorkspaceSynced(initial.activeOpId)).resolves.toMatchObject({
      accepted: true,
      opId: initial.activeOpId,
    });
  });

  it("ignores stale workspace-synced acks", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      baseMainCommit: "current-base",
      lastKnownMainCommit: "current-base",
    }));
    const initial = await subject.requestStop();

    const next = await subject.noteStopWorkspaceSynced("stop-stale", {
      baseMainCommit: "stale-base",
      lastKnownMainCommit: "stale-base",
    });

    expect(next).toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
    });
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      baseMainCommit: "current-base",
      lastKnownMainCommit: "current-base",
    });
  });

  it("accepts a late exact workspace ack after a Stop save timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    try {
      const subject = createSubject();
      const initial = await subject.requestStop();

      vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
      await expect(subject.getState()).resolves.toMatchObject({
        phase: "failed",
        activeOpId: initial.activeOpId,
        desiredState: "stopped",
      });

      const recovered = await subject.noteStopWorkspaceSynced(initial.activeOpId, {
        workspaceDirty: false,
        workspaceLastSyncedAt: "2026-04-10T00:02:00.000Z",
      });
      expect(recovered).toMatchObject({
        phase: "stopping",
        activeOpId: initial.activeOpId,
        desiredState: "stopped",
        lastWorkspaceSyncedAckOpId: initial.activeOpId,
        lastError: null,
      });

      await expect(subject.noteRunnerStopped(initial.activeOpId, "exit")).resolves.toMatchObject({
        phase: "stopped",
        activeOpId: initial.activeOpId,
        lastWorkspaceSyncedAckOpId: initial.activeOpId,
        lastError: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("transactionally fences metadata written by an overtaken Start", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);
    const startOpId = start.activeOpId;
    await subject.beginStartupDiagnostics({
      opId: startOpId,
      backend: "host",
      implementationMode: "fresh",
      stepId: "workspace-sync",
      message: "Owned startup",
    });
    await subject.setRunnerBinding({
      opId: startOpId,
      runnerId: "runner-owned",
    });
    await subject.setLeadHarnessFailed("clear this failure");
    await subject.clearLeadHarnessState({ opId: startOpId });
    await subject.setLeadHarnessFailed("preserve this failure");
    await subject.recordStopWorkspaceSynced({
      workspaceDirty: false,
      workspaceLastSyncedAt: "2026-04-10T00:00:10.000Z",
      baseMainCommit: "owned-base",
    }, { opId: startOpId });

    const stop = await subject.requestStop();
    await subject.beginStartupDiagnostics({
      opId: startOpId,
      backend: "host",
      stepId: "harness-launch",
      message: "Stale startup",
    });
    await subject.setRunnerBinding({
      opId: startOpId,
      runnerId: "runner-stale",
    });
    await subject.clearLeadHarnessState({ opId: startOpId });
    await subject.recordStopWorkspaceSynced({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:20.000Z",
      baseMainCommit: "stale-base",
    }, { opId: startOpId, clearError: true });

    await expect(subject.peekMutableState()).resolves.toMatchObject({
      lifecyclePhase: "saving",
      lifecycleOpId: stop.activeOpId,
      lifecycleOperation: "stop",
      runnerId: "runner-owned",
      leadHarnessStatus: "failed",
      leadHarnessError: "preserve this failure",
      workspaceDirty: false,
      workspaceLastSyncedAt: "2026-04-10T00:00:10.000Z",
      baseMainCommit: "owned-base",
      bootMessage: "Owned startup",
    });
    await expect(subject.getStartupDiagnostics()).resolves.toMatchObject({
      active: {
        opId: startOpId,
        implementationMode: "fresh",
        currentStepMessage: "Owned startup",
      },
    });
  });

  it("atomically rejects stale diagnostics and harness failures after a retried Start", async () => {
    const subject = createSubject();
    const first = await beginStartForTest(subject);
    await subject.beginStartupDiagnostics({
      opId: first.activeOpId,
      backend: "host",
      stepId: "workspace-sync",
      message: "First startup",
    });
    await subject.noteRunnerStartFailed(first.activeOpId, "retry this start");
    const replacement = await beginStartForTest(subject);
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      lifecycleOpId: replacement.activeOpId,
      bootMessage: null,
      bootStepId: null,
    });
    await expect(subject.getStartupDiagnostics()).resolves.toMatchObject({
      active: null,
      lastFailed: { opId: first.activeOpId },
    });
    await subject.beginStartupDiagnostics({
      opId: replacement.activeOpId,
      backend: "host",
      stepId: "harness-launch",
      message: "Replacement startup",
    });

    await expect(subject.reportStartupEvent({
      opId: first.activeOpId,
      stepId: "startup-failed",
      severity: "error",
      message: "stale diagnostic",
    })).resolves.toBeNull();
    await expect(subject.reportStartupFailure({
      opId: first.activeOpId,
      message: "stale harness crash",
      runnerMayExist: true,
      leadHarnessFailure: true,
    })).resolves.toMatchObject({
      phase: "starting",
      activeOpId: replacement.activeOpId,
    });

    await expect(subject.peekMutableState()).resolves.toMatchObject({
      lifecyclePhase: "starting",
      lifecycleOpId: replacement.activeOpId,
      bootMessage: "Replacement startup",
      leadHarnessStatus: null,
      error: null,
    });
    await expect(subject.getStartupDiagnostics()).resolves.toMatchObject({
      active: {
        opId: replacement.activeOpId,
        currentStepMessage: "Replacement startup",
        failure: null,
      },
    });
  });

  it("records a matching running harness crash without failing the environment", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);
    await subject.noteRunnerStarted(start.activeOpId);

    const lifecycle = await subject.reportStartupFailure({
      opId: start.activeOpId,
      message: "lead harness exited",
      runnerMayExist: true,
      leadHarnessFailure: true,
    });

    expect(lifecycle).toMatchObject({
      phase: "running",
      activeOpId: start.activeOpId,
      lastError: null,
    });
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      status: "running",
      leadHarnessStatus: "failed",
      leadHarnessError: "lead harness exited",
      error: null,
    });
  });

  it("does not recreate deleted mutable state from late Start metadata", async () => {
    const subject = createSubject();
    const start = await beginStartForTest(subject);
    await subject.finalizeDeletion();

    await expect(subject.beginStartupDiagnostics({
      opId: start.activeOpId,
      backend: "host",
      stepId: "workspace-sync",
      message: "late",
    })).resolves.toEqual({ active: null, lastFailed: null });
    await expect(subject.setRunnerBinding({ opId: start.activeOpId, runnerId: "late" }))
      .resolves.toBeNull();
    await expect(subject.clearLeadHarnessState({ opId: start.activeOpId })).resolves.toBeNull();
    await expect(subject.recordStopWorkspaceSynced({
      workspaceDirty: true,
    }, { opId: start.activeOpId })).resolves.toBeNull();
    await expect(subject.peekMutableState()).resolves.toBeNull();
  });

  it("clears the deleted incarnation alarm before a replacement can arm its alarm", async () => {
    const storage = createMemoryStorage();
    const kv = new Map<string, string>();
    const subject = createSubject({
      ENVS_KV: {
        get: vi.fn(async (key: string) => kv.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { kv.set(key, value); }),
        delete: vi.fn(async (key: string) => { kv.delete(key); }),
      },
    }, storage);
    await subject.initializeMutableStateFromMeta(createEnvMeta({ status: "stopped" }));
    await storage.setAlarm(Date.now() + 1_000);

    let signalAlarmDeleteStarted!: () => void;
    let releaseAlarmDelete!: () => void;
    const alarmDeleteStarted = new Promise<void>((resolve) => {
      signalAlarmDeleteStarted = resolve;
    });
    const alarmDeleteReleased = new Promise<void>((resolve) => {
      releaseAlarmDelete = resolve;
    });
    const deleteAlarm = storage.deleteAlarm.bind(storage);
    storage.deleteAlarm = vi.fn(async () => {
      signalAlarmDeleteStarted();
      await alarmDeleteReleased;
      await deleteAlarm();
    });

    const finalization = subject.finalizeDeletion();
    await alarmDeleteStarted;
    const replacementMeta = createEnvMeta({ status: "stopped" });
    const replacementDefinition = {
      slug: "demo-env",
      repoId: "repo-1",
      scmModel: "github" as const,
      executionPlacement: { backend: "host" as const, machineId: "machine-1" },
      harness: "codex" as const,
      startupPlanId: "plan-1",
      branchName: "tiller/env/demo-env",
      createdAt: replacementMeta.createdAt,
      incarnationId: "replacement-incarnation",
    };
    let replacementSettled = false;
    const replacement = subject.initializeStoppedEnvironment(
      replacementDefinition,
      buildMutableStateFromMeta(replacementMeta),
    ).finally(() => {
      replacementSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(replacementSettled).toBe(false);

    releaseAlarmDelete();
    await finalization;
    await expect(replacement).resolves.toMatchObject({
      created: true,
      claimId: replacementDefinition.incarnationId,
    });
    await expect(storage.getAlarm()).resolves.not.toBeNull();
  });

  it("finalizes when workspace persistence arrives after runner shutdown", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    const waitingForWorkspace = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(waitingForWorkspace).toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
      lastRunnerState: "stopped",
      infraState: "stopped",
    });

    const stopped = await subject.noteStopWorkspaceSynced(initial.activeOpId, {
      workspaceDirty: false,
      workspaceLastSyncedAt: "2026-04-10T00:00:10.000Z",
    });
    expect(stopped).toMatchObject({
      phase: "stopped",
      activeOpId: initial.activeOpId,
      lastRunnerState: "stopped",
      lastWorkspaceSyncedAckOpId: initial.activeOpId,
      lastError: null,
    });
  });

  it("keeps the exact save retry after runner shutdown and preserves the save deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();
    await subject.ensureStopDispatchScheduled(initial.activeOpId);

    vi.setSystemTime(new Date("2026-04-10T00:00:30.000Z"));
    const waitingForWorkspace = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(waitingForWorkspace).toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
      lastRunnerState: "stopped",
      infraState: "stopped",
      updatedAt: initial.updatedAt,
    });
    await expect(storage.get("stop-retry-v1")).resolves.toMatchObject({
      opId: initial.activeOpId,
      attempt: 0,
    });

    vi.setSystemTime(new Date(
      new Date(initial.updatedAt).getTime() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000,
    ));
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      lastRunnerState: "stopped",
    });
    vi.useRealTimers();
  });

  it("retains a legacy Stop retry so a persisted receipt can still be acknowledged", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();
    await subject.noteRunnerStopped(initial.activeOpId, "exit");
    await storage.put("stop-retry-v1", {
      opId: initial.activeOpId,
      attempt: 8,
      nextAttemptAtMs: Date.now(),
    });
    const getOwnedEnvView = vi.spyOn(subject, "getOwnedEnvView");
    const runStopRetryEffect = (
      subject as unknown as { runStopRetryEffect: () => Promise<boolean> }
    ).runStopRetryEffect.bind(subject);

    await expect(runStopRetryEffect()).resolves.toBe(true);
    await expect(storage.get("stop-retry-v1")).resolves.toMatchObject({
      opId: initial.activeOpId,
      attempt: 9,
    });
    expect(getOwnedEnvView).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not move the save deadline while rearming an in-progress Stop retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();
    await subject.ensureStopDispatchScheduled(initial.activeOpId);

    vi.setSystemTime(new Date("2026-04-10T00:00:30.000Z"));
    await expect(subject.resumeStopRetry(initial.activeOpId)).resolves.toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
      updatedAt: initial.updatedAt,
    });

    await expect(subject.peekMutableState()).resolves.toMatchObject({
      lifecyclePhase: "saving",
      lifecycleUpdatedAt: initial.updatedAt,
      updatedAt: "2026-04-10T00:00:30.000Z",
    });
    vi.useRealTimers();
  });

  it("transitions stopping to stopped when the runner exits after persistence", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.noteStopWorkspaceSynced(initial.activeOpId);

    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(next).toMatchObject({
      phase: "stopped",
      activeOpId: initial.activeOpId,
      lastRunnerState: "stopped",
    });
    await expect(subject.noteWorkspaceSyncFailed(initial.activeOpId, "late failure"))
      .resolves.toMatchObject({
        phase: "stopped",
        activeOpId: initial.activeOpId,
        lastError: null,
      });
  });

  it("clears stop progress after the runner fully stops", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.setBootProgress("Confirming workspace saved...", "workspace-sync");
    await subject.noteStopWorkspaceSynced(initial.activeOpId);

    await subject.noteRunnerStopped(initial.activeOpId, "exit");

    const mutable = await subject.getMutableState();
    expect(mutable).toMatchObject({
      status: "stopped",
      bootMessage: null,
      bootStepId: null,
    });
  });

  it("recovers a timed-out stopping env when the matching runner-stop callback arrives late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.noteStopWorkspaceSynced(initial.activeOpId);

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_STOP_TIMEOUT_MS + 1_000));
    const timedOut = await subject.getState();
    const recovered = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(timedOut).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      desiredState: "stopped",
      lastWorkspaceSyncedAckOpId: initial.activeOpId,
    });
    expect(recovered).toMatchObject({
      phase: "stopped",
      activeOpId: initial.activeOpId,
      desiredState: "stopped",
      lastRunnerState: "stopped",
    });
    expect(recovered?.lastError).toBeNull();
    vi.useRealTimers();
  });

  it("retains the same Stop operation across automatic persistence retries", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();
    await subject.noteWorkspaceSyncFailed(initial.activeOpId, "save failed");
    const retried = await subject.requestStop();

    const afterStaleFailure = await subject.noteWorkspaceSyncFailed(
      initial.activeOpId,
      "late save failure",
    );
    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(retried.activeOpId).toBe(initial.activeOpId);
    expect(afterStaleFailure).toMatchObject({
      phase: "saving",
      activeOpId: retried.activeOpId,
      lastError: null,
    });
    expect(next).toMatchObject({
      phase: "saving",
      activeOpId: retried.activeOpId,
      desiredState: "stopped",
      lastRunnerState: "stopped",
    });
  });

  it("schedules capped same-operation retry state until the exact save ack succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();

    await subject.noteWorkspaceSyncFailed(initial.activeOpId, "raw upload detail");

    const retry = await storage.get<{ opId: string; attempt: number; nextAttemptAtMs: number }>("stop-retry-v1");
    expect(retry).toEqual({
      opId: initial.activeOpId,
      attempt: 0,
      nextAttemptAtMs: Date.now() + 2_000,
    });
    await expect(storage.getAlarm()).resolves.toBe(Date.now() + 2_000);
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
      lastError: null,
    });
    await expect(subject.getMutableState()).resolves.toMatchObject({
      bootMessage: "Retrying workspace save…",
    });

    const accepted = await subject.acceptStopWorkspaceSynced(initial.activeOpId);
    expect(accepted).toMatchObject({ accepted: true, opId: initial.activeOpId });
    await expect(storage.get("stop-retry-v1")).resolves.toMatchObject({
      opId: initial.activeOpId,
      attempt: 0,
    });
    await subject.noteRunnerStopped(initial.activeOpId, "exit");
    await expect(storage.get("stop-retry-v1")).resolves.toBeNull();
    vi.useRealTimers();
  });

  it("explains when safe saving is waiting for the active agent turn", async () => {
    const subject = createSubject();
    const initial = await subject.requestStop();

    await subject.noteWorkspaceSyncFailed(
      initial.activeOpId,
      "Timed out waiting for the active agent turn to become idle.",
    );

    await expect(subject.getMutableState()).resolves.toMatchObject({
      status: "saving",
      bootStepId: "workspace-sync",
      bootMessage: "Waiting for the active agent turn to finish safely…",
    });
  });

  it("re-arms only the exact persisted Stop retry after its save deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();
    await subject.noteWorkspaceSyncFailed(initial.activeOpId, "save failed");

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
    });

    await expect(subject.resumeStopRetry("stale-stop-op")).resolves.toBeNull();
    await expect(subject.resumeStopRetry(initial.activeOpId)).resolves.toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastError: null,
    });
    await expect(storage.get<{ opId: string }>("stop-retry-v1")).resolves.toMatchObject({
      opId: initial.activeOpId,
    });
    vi.useRealTimers();
  });

  it("reuses a timed-out Stop ID even when no retry timer was recorded", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();

    expect(await storage.get("stop-retry-v1")).toBeNull();
    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
    });

    const retried = await subject.requestStop();

    expect(retried).toMatchObject({
      phase: "saving",
      activeOpId: initial.activeOpId,
      activeOperation: "stop",
      desiredState: "stopped",
      lastError: null,
    });
    await expect(storage.get<{ opId: string }>("stop-retry-v1")).resolves.toMatchObject({
      opId: initial.activeOpId,
    });
    vi.useRealTimers();
  });

  it("repairs a stale retry timer from the authoritative active Stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    const initial = await subject.requestStop();
    await storage.put("stop-retry-v1", {
      opId: "stale-stop-op",
      attempt: 7,
      nextAttemptAtMs: Date.now(),
    });

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
    await subject.getState();
    const retried = await subject.requestStop();

    expect(retried.activeOpId).toBe(initial.activeOpId);
    await expect(storage.get<{ opId: string; attempt: number }>("stop-retry-v1")).resolves.toMatchObject({
      opId: initial.activeOpId,
      attempt: 0,
    });
    vi.useRealTimers();
  });

  it("keeps the same Stop fence when a delayed lifecycle alarm retries offline host persistence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const hub = {
      isHostRoutable: vi.fn().mockResolvedValue(false),
      broadcastEnvUpsert: vi.fn().mockResolvedValue(undefined),
    };
    const env = {
      ENVS_KV: {
        get: vi.fn().mockResolvedValue(null),
        put: vi.fn().mockResolvedValue(undefined),
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      },
      HUB: {
        idFromName: vi.fn(() => "hub-id"),
        get: vi.fn(() => hub),
      },
      ENV_REVIEW: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({
          listWorkloadStateForPredeploy: vi.fn().mockResolvedValue([]),
        })),
      },
    };
    const storage = createMemoryStorage();
    const subject = createSubject(env, storage);
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      backend: "host",
      executionPlacement: { backend: "host", machineId: "machine-1" },
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-op-1",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
    }));
    const stop = await subject.requestStop();
    await subject.noteWorkspaceSyncFailed(stop.activeOpId, "initial save failure");
    vi.spyOn(subject, "getOwnedEnvView").mockResolvedValue(createEnvMeta({
      backend: "host",
      executionPlacement: { backend: "host", machineId: "machine-1" },
      status: "failed",
      lifecyclePhase: "failed",
      lifecycleOpId: stop.activeOpId,
      lifecycleOperation: "stop",
      lifecycleDesiredState: "stopped",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: false,
    }));
    const resume = vi.spyOn(subject, "resumeStopRetry");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
    try {
      await subject.alarm();
    } finally {
      consoleError.mockRestore();
    }

    expect(resume).toHaveBeenCalledWith(stop.activeOpId);
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "saving",
      activeOpId: stop.activeOpId,
      activeOperation: "stop",
    });
    await expect(storage.get<{ opId: string; attempt: number }>("stop-retry-v1"))
      .resolves.toMatchObject({ opId: stop.activeOpId, attempt: 1 });
    expect(hub.isHostRoutable).toHaveBeenCalledWith("machine-1");
    vi.useRealTimers();
  });

  it("allows restart only after exact fresh runner-absence reconciliation", async () => {
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    await subject.initializeMutableStateFromMeta(createEnvMeta({
      status: "running",
      lifecyclePhase: "running",
      lifecycleOpId: "start-op-old",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
      lifecycleInfraState: "ready",
      lifecycleRuntimeReady: true,
    }));
    const stop = await subject.requestStop();
    await subject.noteWorkspaceSyncFailed(stop.activeOpId, "upload failed");

    await expect(subject.confirmRunnerAbsentForRestart("stale-stop-op")).resolves.toBe(false);
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "saving",
      activeOpId: stop.activeOpId,
    });

    await expect(subject.confirmRunnerAbsentForRestart(stop.activeOpId)).resolves.toBe(true);
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "stopped",
      activeOpId: stop.activeOpId,
      lastRunnerState: "stopped",
    });
    await expect(storage.get("stop-retry-v1")).resolves.toBeNull();

    const restart = await subject.beginStart({ model: "claude-opus-4.8", effort: "xhigh" });
    expect(restart.dispatchGranted).toBe(true);
    expect(restart.lifecycle).toMatchObject({ phase: "starting", desiredState: "running" });
  });

  it("applies a partial workspace patch from the stop-finalize ack", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta({ baseMainCommit: "main-old" }));
    const initial = await subject.requestStop();

    await subject.noteStopWorkspaceSynced(initial.activeOpId, {
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-21T12:00:00.000Z",
    });

    const mutable = await subject.getMutableState();
    expect(mutable).toMatchObject({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-21T12:00:00.000Z",
      baseMainCommit: "main-old",
    });
  });

  it("rejects a workspace acknowledgement that belongs to Start instead of an exact Stop", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);
    await subject.noteRunnerStarted(initial.activeOpId);

    const acknowledgement = await subject.acceptStopWorkspaceSynced(initial.activeOpId);
    const mutable = await subject.getMutableState();

    expect(acknowledgement).toMatchObject({ accepted: false, opId: null });
    expect(mutable).toMatchObject({
      lifecyclePhase: "running",
      lifecycleOperation: "start",
      lifecycleDesiredState: "running",
    });
  });

  it("fails a running env when the runner exits unexpectedly", async () => {
    const subject = createSubject();
    const initial = await beginStartForTest(subject);
    await subject.noteRunnerStarted(initial.activeOpId);

    const next = await subject.noteRunnerStopped(initial.activeOpId, "exit");

    expect(next).toMatchObject({
      phase: "failed",
      activeOpId: initial.activeOpId,
      desiredState: "running",
      lastRunnerState: "stopped",
    });
    expect(next?.lastError).toContain("environment was running");
  });

  it("times out saving operations into failed state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    await subject.requestStop();

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
    const next = await subject.getState();

    expect(next).toMatchObject({
      phase: "failed",
    } satisfies Partial<EnvLifecycleState>);
    expect(next?.lastError).toContain("before timeout");
    vi.useRealTimers();
  });

  it("does not let a stale timeout overwrite a replacement lifecycle operation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    try {
      const subject = createSubject();
      const initial = await beginStartForTest(subject);
      const staleCandidate = await subject.peekMutableState();
      if (!staleCandidate) throw new Error("Expected a stale Start candidate");
      await subject.noteRunnerStartFailed(initial.activeOpId, "first start failed");
      const replacement = await beginStartForTest(subject);
      expect(replacement.activeOpId).not.toBe(initial.activeOpId);

      vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_START_TIMEOUT_MS + 1_000));
      const resolveTimeoutState = (
        subject as unknown as {
          resolveTimeoutState: (state: EnvMutableState | null, now: number) => Promise<EnvMutableState | null>;
        }
      ).resolveTimeoutState.bind(subject);
      await expect(resolveTimeoutState(staleCandidate, Date.now())).resolves.toMatchObject({
        lifecyclePhase: "starting",
        lifecycleOpId: replacement.activeOpId,
      });
      await expect(subject.peekMutableState()).resolves.toMatchObject({
        lifecyclePhase: "starting",
        lifecycleOpId: replacement.activeOpId,
        error: null,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("peeks mutable state without resolving lifecycle timeouts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    await subject.requestStop();

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 1_000));
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      status: "saving",
      lifecyclePhase: "saving",
    });
    await expect(subject.getState()).resolves.toMatchObject({
      phase: "failed",
    });
    vi.useRealTimers();
  });

  it("persists and broadcasts a timed-out stop from the alarm path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const kvWrites = new Map<string, string>();
    const broadcastEnvUpsert = vi.fn().mockResolvedValue(undefined);
    const env = {
      ENVS_KV: {
        get: vi.fn(async (key: string) => {
          if (key === "envdef:demo-env") {
            return JSON.stringify({
              slug: "demo-env",
              incarnationId: "incarnation-1",
              repoId: "repo-1",
              scmModel: "github",
              executionPlacement: { backend: "cf", machineId: null },
              harness: "claude-code",
              startupPlanId: null,
              branchName: "env/demo-env",
              createdAt: "2026-04-10T00:00:00.000Z",
            });
          }
          if (key === "repo:repo-1") {
            return JSON.stringify({
              repoId: "repo-1",
              updatedAt: "2026-04-10T00:00:00.000Z",
            });
          }
          return kvWrites.get(key) ?? null;
        }),
        put: vi.fn(async (key: string, value: string) => {
          kvWrites.set(key, value);
        }),
      },
      HUB: {
        idFromName: vi.fn().mockReturnValue("hub-id"),
        get: vi.fn().mockReturnValue({
          broadcastEnvUpsert,
        }),
      },
      WORKSPACE: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn().mockReturnValue({
          readWorkspaceFile: vi.fn(async (path: string) => {
            if (path !== "/.tiller/repo/meta.json") {
              return null;
            }
            return JSON.stringify({
              repoId: "repo-1",
              githubInstallationId: 98765,
              githubFullName: "test/repo",
              ...createInitialRepoScmState(),
              createdAt: "2026-04-10T00:00:00.000Z",
              updatedAt: "2026-04-10T00:00:00.000Z",
              bootstrappedFromRef: "HEAD",
            });
          }),
        }),
      },
    };
    const storage = createMemoryStorage();
    const subject = createSubject(env, storage);
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    await storage.put("env-publication", {
      incarnationId: "incarnation-1",
      state: "visible",
      updatedAt: "2026-04-10T00:00:00.000Z",
    });
    await subject.requestStop();

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_SAVE_TIMEOUT_MS + 5_000));
    await subject.alarm();

    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("\"status\":\"failed\""),
    );
    expect(env.ENVS_KV.put).toHaveBeenCalledWith(
      "demo-env",
      expect.stringContaining("workspace persistence before timeout"),
    );
    expect(broadcastEnvUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo-env",
        status: "failed",
        error: expect.stringContaining("workspace persistence before timeout"),
      }),
    );
    vi.useRealTimers();
  });

  it("times out starting operations into failed state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-10T00:00:00.000Z"));
    const subject = createSubject();
    await beginStartForTest(subject);

    vi.setSystemTime(new Date(Date.now() + ENV_LIFECYCLE_START_TIMEOUT_MS + 1_000));
    const next = await subject.getState();

    expect(next).toMatchObject({
      phase: "failed",
      desiredState: "running",
    } satisfies Partial<EnvLifecycleState>);
    expect(next?.lastError).toContain("runner readiness");
    vi.useRealTimers();
  });

  it("preserves workspace sync state across boot and harness updates", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta());

    await subject.recordStopWorkspaceSynced({
      workspaceDirty: true,
      workspaceNeedsAttention: false,
      workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
      baseMainCommit: "main-old",
      lastKnownMainCommit: "main-old",
      branchStatus: "ready-to-merge",
    }, { clearError: false });
    await subject.setBootProgress("Booting...");
    await subject.setLeadHarnessFailed("Harness exited");

    await expect(subject.getMutableState()).resolves.toMatchObject({
      workspaceDirty: true,
      workspaceLastSyncedAt: "2026-04-10T00:00:05.000Z",
      branchStatus: "ready-to-merge",
      bootMessage: "Booting...",
      leadHarnessStatus: "failed",
    });
  });

  it("preserves descriptive PR content while a publish operation advances", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    const pullRequestContent = {
      title: "Improve draft PR descriptions",
      featureMarkdown: "## Summary\n\nExplain the published feature.",
    };
    const projection = createGitHubPendingPublishProjection({
      operationId: "publish-1",
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      startedAt: "2026-04-10T00:00:01.000Z",
    });

    await subject.beginGitHubPublishOperation({
      operationId: "publish-1",
      envSlug: "demo-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo.git",
      jobSlug: "github-publish-demo-env-publish-1",
      executionPlacement: { backend: "cf", machineId: null },
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      hmacKey: "hmac-key",
      callbackToken: "callback-token",
      pullRequestContent,
      startedAt: "2026-04-10T00:00:01.000Z",
      projection,
    });
    await expect(subject.claimGitHubPublishResult({
      operationId: "publish-1",
      callbackToken: "callback-token",
      workspaceHash: "workspace-hash",
      claimId: "result-claim-1",
    })).resolves.toMatchObject({ status: "claimed" });

    await expect(subject.getGitHubPublishOperation()).resolves.toMatchObject({
      operationId: "publish-1",
      resultClaim: { claimId: "result-claim-1" },
      pullRequestContent,
    });
  });

  it("atomically grants only one concurrent GitHub publish claim", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    const input = (operationId: string) => ({
      operationId,
      envSlug: "demo-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo.git",
      jobSlug: `github-publish-demo-env-${operationId}`,
      executionPlacement: { backend: "cf" as const, machineId: null },
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      hmacKey: "hmac-key",
      callbackToken: "callback-token",
      pullRequestContent: {
        title: "Publish changes",
        featureMarkdown: "## Summary",
      },
      startedAt: "2026-04-10T00:00:01.000Z",
      projection: createGitHubPendingPublishProjection({
        operationId,
        branch: "tiller/demo-env",
        baseCommitSha: "base-sha",
        workspaceHash: "workspace-hash",
        expectedPriorHead: null,
        startedAt: "2026-04-10T00:00:01.000Z",
      }),
    });

    const results = await Promise.all([
      subject.beginGitHubPublishOperation(input("publish-1")),
      subject.beginGitHubPublishOperation(input("publish-2")),
    ]);

    expect(results.filter((result) => result.claimed)).toHaveLength(1);
    const stored = await subject.getGitHubPublishOperation();
    expect(stored?.operationId).toBe(
      results.find((result) => result.claimed)?.state.githubPublishOperationId,
    );
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      githubPublishOperationId: stored?.operationId,
      githubPublishStatus: "publishing",
    });
  });

  it("gives pending cleanup and result processing mutually exclusive publish ownership", async () => {
    const subject = createSubject();
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    await subject.beginGitHubPublishOperation({
      operationId: "publish-1",
      envSlug: "demo-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo.git",
      jobSlug: "github-publish-demo-env-publish-1",
      executionPlacement: { backend: "cf", machineId: null },
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      hmacKey: "hmac-key",
      callbackToken: "callback-token",
      pullRequestContent: {
        title: "Publish changes",
        featureMarkdown: "## Summary",
      },
      startedAt: "2026-04-10T00:00:01.000Z",
      projection: createGitHubPendingPublishProjection({
        operationId: "publish-1",
        branch: "tiller/demo-env",
        baseCommitSha: "base-sha",
        workspaceHash: "workspace-hash",
        expectedPriorHead: null,
        startedAt: "2026-04-10T00:00:01.000Z",
      }),
    });

    const claims = await Promise.all([
      subject.claimGitHubPublishResult({
        operationId: "publish-1",
        callbackToken: "callback-token",
        workspaceHash: "workspace-hash",
        claimId: "result-claim-1",
      }),
      subject.claimGitHubPublishResult({
        operationId: "publish-1",
        callbackToken: "callback-token",
        workspaceHash: "workspace-hash",
        claimId: "result-claim-2",
      }),
    ]);

    const winner = claims.find((claim) => claim.status === "claimed");
    expect(winner?.status).toBe("claimed");
    expect(claims.filter((claim) => claim.status === "in_progress")).toHaveLength(1);
    expect(await subject.markGitHubPublishCleanupPending({
      operationId: "publish-1",
      terminalError: "Dispatch became uncertain.",
    })).toBe(false);
    expect(await subject.markGitHubPublishCleanupPending({
      operationId: "publish-1",
      resultClaimId: winner?.status === "claimed"
        ? winner.operation.resultClaim?.claimId
        : undefined,
      terminalError: "Result cleanup failed.",
    })).toBe(true);
    await expect(subject.claimGitHubPublishResult({
      operationId: "publish-1",
      callbackToken: "callback-token",
      workspaceHash: "workspace-hash",
      claimId: "late-result-claim",
    })).resolves.toEqual({ status: "cleanup_pending" });
  });

  it("preserves a renewed publish result claim across stale expiry before scheduling abandoned cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    try {
      const subject = createSubject();
      await subject.initializeMutableStateFromMeta(createEnvMeta());
      await subject.beginGitHubPublishOperation({
        operationId: "publish-1",
        envSlug: "demo-env",
        repoId: "repo-1",
        repoUrl: "https://github.com/example/repo.git",
        jobSlug: "github-publish-demo-env-publish-1",
        executionPlacement: { backend: "cf", machineId: null },
        branch: "tiller/demo-env",
        baseCommitSha: "base-sha",
        workspaceHash: "workspace-hash",
        expectedPriorHead: null,
        hmacKey: "hmac-key",
        callbackToken: "callback-token",
        pullRequestContent: {
          title: "Publish changes",
          featureMarkdown: "## Summary",
        },
        startedAt: "2026-07-17T00:00:00.000Z",
        projection: createGitHubPendingPublishProjection({
          operationId: "publish-1",
          branch: "tiller/demo-env",
          baseCommitSha: "base-sha",
          workspaceHash: "workspace-hash",
          expectedPriorHead: null,
          startedAt: "2026-07-17T00:00:00.000Z",
        }),
      });
      await subject.claimGitHubPublishResult({
        operationId: "publish-1",
        callbackToken: "callback-token",
        workspaceHash: "workspace-hash",
        claimId: "result-claim-1",
      });

      const originalClaim = await subject.getGitHubPublishOperation();
      vi.advanceTimersByTime(9 * 60_000);
      await expect(subject.updateGitHubPublishOperation({
        operationId: "publish-1",
        resultClaimId: "result-claim-1",
        patch: {},
      })).resolves.toEqual({ applied: true });
      const renewedClaim = await subject.getGitHubPublishOperation();
      expect(renewedClaim!.resultClaim!.expiresAtMs)
        .toBeGreaterThan(originalClaim!.resultClaim!.expiresAtMs);

      vi.advanceTimersByTime(60_000 + 1);
      await (subject as any).expireGitHubPublishResultClaim();
      await expect(subject.getGitHubPublishOperation()).resolves.toMatchObject({
        resultClaim: { claimId: "result-claim-1" },
        cleanupPending: null,
      });

      vi.advanceTimersByTime(9 * 60_000);
      await (subject as any).expireGitHubPublishResultClaim();
      await expect(subject.getGitHubPublishOperation()).resolves.toMatchObject({
        resultClaim: null,
        cleanupPending: {
          terminalError: expect.stringContaining("result processing was interrupted"),
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and cleans up a GitHub publish that never reports a result", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    try {
      const destroyJob = vi.fn().mockResolvedValue(undefined);
      const subject = createSubject({
        GITHUB_JOB: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({ destroyJob })),
        },
        ENVS_KV: {
          list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
        },
      });
      await subject.initializeMutableStateFromMeta(createEnvMeta());
      await subject.beginGitHubPublishOperation({
        operationId: "publish-1",
        envSlug: "demo-env",
        repoId: "repo-1",
        repoUrl: "https://github.com/example/repo.git",
        jobSlug: "github-publish-demo-env-publish-1",
        executionPlacement: { backend: "cf", machineId: null },
        branch: "tiller/demo-env",
        baseCommitSha: "base-sha",
        workspaceHash: "workspace-hash",
        expectedPriorHead: null,
        hmacKey: "hmac-key",
        callbackToken: "callback-token",
        pullRequestContent: {
          title: "Publish changes",
          featureMarkdown: "## Summary",
        },
        startedAt: "2026-07-17T00:00:00.000Z",
        projection: createGitHubPendingPublishProjection({
          operationId: "publish-1",
          branch: "tiller/demo-env",
          baseCommitSha: "base-sha",
          workspaceHash: "workspace-hash",
          expectedPriorHead: null,
          startedAt: "2026-07-17T00:00:00.000Z",
        }),
      });

      vi.advanceTimersByTime(10 * 60_000);
      await subject.alarm();

      expect(destroyJob).toHaveBeenCalledOnce();
      await expect(subject.getGitHubPublishOperation()).resolves.toBeNull();
      await expect(subject.peekMutableState()).resolves.toMatchObject({
        githubPublishStatus: "failed",
        githubPublishOperationId: null,
        githubPublishError: "GitHub publish timed out before reporting a result. Retry publishing.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("durably schedules exact publish cleanup after a transient cleanup failure", async () => {
    const storage = createMemoryStorage();
    const subject = createSubject({}, storage);
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    const projection = createGitHubPendingPublishProjection({
      operationId: "publish-1",
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      startedAt: "2026-04-10T00:00:01.000Z",
    });
    await subject.beginGitHubPublishOperation({
      operationId: "publish-1",
      envSlug: "demo-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo.git",
      jobSlug: "github-publish-demo-env-publish-1",
      executionPlacement: { backend: "host", machineId: "machine-1" },
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      hmacKey: "hmac-key",
      callbackToken: "callback-token",
      pullRequestContent: {
        title: "Publish changes",
        featureMarkdown: "## Summary",
      },
      startedAt: "2026-04-10T00:00:01.000Z",
      projection,
    });

    await expect(subject.markGitHubPublishCleanupPending({
      operationId: "publish-1",
      terminalError: "Dispatch was uncertain.",
    })).resolves.toBe(true);

    await expect(subject.getGitHubPublishOperation()).resolves.toMatchObject({
      operationId: "publish-1",
      executionPlacement: { backend: "host", machineId: "machine-1" },
      cleanupPending: {
        terminalError: "Dispatch was uncertain.",
      },
    });
    expect(await storage.getAlarm()).not.toBeNull();
    await storage.deleteAlarm();
    await (subject as any).scheduleNextAlarm(await subject.peekMutableState(), null);
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("retries pending publish cleanup and releases the operation only after confirmed absence", async () => {
    const destroyJob = vi.fn().mockResolvedValue(undefined);
    const subject = createSubject({
      GITHUB_JOB: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ destroyJob })),
      },
      ENVS_KV: {
        list: vi.fn().mockResolvedValue({ keys: [], list_complete: true }),
      },
    });
    await subject.initializeMutableStateFromMeta(createEnvMeta());
    const projection = createGitHubPendingPublishProjection({
      operationId: "publish-1",
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      startedAt: "2026-04-10T00:00:01.000Z",
    });
    await subject.beginGitHubPublishOperation({
      operationId: "publish-1",
      envSlug: "demo-env",
      repoId: "repo-1",
      repoUrl: "https://github.com/example/repo.git",
      jobSlug: "github-publish-demo-env-publish-1",
      executionPlacement: { backend: "cf", machineId: null },
      branch: "tiller/demo-env",
      baseCommitSha: "base-sha",
      workspaceHash: "workspace-hash",
      expectedPriorHead: null,
      hmacKey: "hmac-key",
      callbackToken: "callback-token",
      pullRequestContent: {
        title: "Publish changes",
        featureMarkdown: "## Summary",
      },
      startedAt: "2026-04-10T00:00:01.000Z",
      projection,
    });
    await subject.markGitHubPublishCleanupPending({
      operationId: "publish-1",
      terminalError: "Dispatch was uncertain.",
    });

    await (subject as any).runGitHubPublishCleanupEffect();

    expect(destroyJob).toHaveBeenCalledOnce();
    await expect(subject.getGitHubPublishOperation()).resolves.toBeNull();
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      githubPublishStatus: "failed",
      githubPublishOperationId: null,
      githubPublishError: "Dispatch was uncertain.",
    });
  });

  it("rejects hydrated summaries that omit status", async () => {
    const subject = createSubject();

    await expect(
      subject.initializeMutableStateFromMeta(createEnvMeta({ status: undefined })),
    ).rejects.toThrow("Env summary is missing explicit core fields");
  });

  it("rejects hydrated summaries that omit updatedAt", async () => {
    const subject = createSubject();

    await expect(
      subject.initializeMutableStateFromMeta(createEnvMeta({ updatedAt: undefined })),
    ).rejects.toThrow("Env summary is missing explicit core fields");
  });

});
