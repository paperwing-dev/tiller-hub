import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnvDefinition, EnvMeta } from "../types";
import { createInitialEnvScmState } from "../scm/model";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));

import { EnvLifecycleDO } from "../env-lifecycle-do";
import { buildMutableStateFromMeta } from "../env/state";
import {
  SCHEDULED_RUN_EFFECT_RETRY_MS,
  SCHEDULED_RUN_PREPARATION_ABANDON_MS,
} from "../env/scheduled-run-state";

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
    async put(key, value) {
      data.set(key, value);
    },
    async delete(key) {
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
    async setAlarm(time) {
      alarmAt = time;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
  };
  return storage;
}

function createKvEnv(options: { rejectDelete?: boolean } = {}) {
  const values = new Map<string, string>();
  const remove = vi.fn(async (key: string) => {
    if (options.rejectDelete) throw new Error("KV delete failed");
    values.delete(key);
  });
  return {
    values,
    env: {
      ENVS_KV: {
        get: vi.fn(async (key: string) => values.get(key) ?? null),
        put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
        delete: remove,
      },
    },
  };
}

function createSubject(
  envOverrides: Record<string, unknown> = {},
  storage = createMemoryStorage(),
) {
  const instance = Object.create(EnvLifecycleDO.prototype) as EnvLifecycleDO & {
    ctx: { storage: MemoryStorage; waitUntil: (promise: Promise<unknown>) => void };
  };
  instance.ctx = { storage, waitUntil: () => {} } as never;
  (instance as unknown as { env: Record<string, unknown> }).env = envOverrides;
  return { subject: instance, storage };
}

function createDefinition(
  executionPlacement: EnvDefinition["executionPlacement"] = {
    backend: "host",
    machineId: "machine-1",
  },
): EnvDefinition {
  return {
    slug: "demo-env",
    repoId: "repo-1",
    scmModel: "github",
    executionPlacement,
    harness: "codex",
    startupPlanId: "plan-1",
    branchName: "tiller/env/demo-env",
    createdAt: "2026-07-10T00:00:00.000Z",
    incarnationId: "incarnation-1",
  };
}

function createEnvMeta(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const executionPlacement = overrides.executionPlacement ?? {
    backend: "host" as const,
    machineId: "machine-1",
  };
  return {
    slug: "demo-env",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    ...createInitialEnvScmState({
      slug: "demo-env",
      startupPlanId: "plan-1",
      branchName: "tiller/env/demo-env",
      mainCommit: "main-old",
    }),
    backend: executionPlacement.backend,
    executionPlacement,
    harness: "codex",
    harnessSettings: { model: "gpt-5.6-sol", effort: "xhigh" },
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    status: "stopped",
    implementorAttentionToken: null,
    ...overrides,
  };
}

async function initializeScheduled(
  subject: EnvLifecycleDO,
  runAtMs = Date.now() + 60_000,
  executionPlacement: EnvDefinition["executionPlacement"] = {
    backend: "host",
    machineId: "machine-1",
  },
) {
  const definition = createDefinition(executionPlacement);
  const initialized = await subject.initializeStoppedEnvironment(
    definition,
    buildMutableStateFromMeta(createEnvMeta({ executionPlacement })),
    {
      incarnationId: definition.incarnationId!,
      schedule: {
        runAtMs,
        timeZone: "America/Los_Angeles",
        localDevOrigin: null,
      },
      plan: {
        artifactId: "plan-1",
        version: 7,
        renderedPlanDocument: "# Approved plan\n\nImplement and verify the change.",
      },
    },
  );
  if (!initialized.created || !initialized.claimId) throw new Error("Expected Scheduled Run initialization");
  return { definition, initialized };
}

async function publishScheduled(
  subject: EnvLifecycleDO,
  runAtMs = Date.now() - 1_000,
  executionPlacement?: EnvDefinition["executionPlacement"],
) {
  const created = await initializeScheduled(subject, runAtMs, executionPlacement);
  await subject.publishStoppedInitialization(created.initialized.claimId!, created.definition);
  await subject.commitStoppedInitialization(created.initialized.claimId!);
  return created;
}

async function claimScheduledStart(
  subject: EnvLifecycleDO,
  options: {
    hostMachineId?: string | null;
    authClaim?: {
      claudeAuthMode: "subscription" | "api" | null;
      codexAuthPreference: "subscription" | "api-key" | null;
    };
  } = {},
) {
  const attempt = await subject.beginScheduledRunAttempt("incarnation-1");
  expect(await subject.recordScheduledCapacityAcquired(attempt.attemptId)).toBe(true);
  const claim = await subject.claimScheduledRunStart({
    attemptId: attempt.attemptId,
    harnessSettings: { model: "gpt-5.5", effort: "high" },
    hostMachineId: options.hostMachineId === undefined ? "host-1" : options.hostMachineId,
    ...(options.authClaim ? { authClaim: options.authClaim } : {}),
  });
  expect(claim.dispatchGranted).toBe(true);
  const active = await subject.getScheduledRun();
  if (active?.kind !== "active" || !active.preparation) throw new Error("Expected active Scheduled Run");
  return active;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("EnvLifecycleDO Scheduled Run ownership", () => {
  it("keeps creation hidden until atomic visibility commit and stores one immutable plan", async () => {
    const { env, values } = createKvEnv();
    const { subject, storage } = createSubject(env);
    const { definition, initialized } = await initializeScheduled(subject);

    expect(values.has("envdef:demo-env")).toBe(false);
    await expect(subject.isInitialCreationPending()).resolves.toBe(true);
    await expect(subject.peekVisibleMutableState("incarnation-1")).resolves.toBeNull();
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "schedule",
      incarnationId: "incarnation-1",
      attemptId: null,
    });
    await expect(subject.getImmutablePlan()).resolves.toEqual({
      incarnationId: "incarnation-1",
      artifactId: "plan-1",
      version: 7,
      renderedPlanDocument: "# Approved plan\n\nImplement and verify the change.",
      createdAt: expect.any(String),
    });

    expect(await subject.publishStoppedInitialization(initialized.claimId!, definition)).toBe(true);
    expect(values.has("envdef:demo-env")).toBe(true);
    await expect(subject.peekVisibleMutableState("incarnation-1")).resolves.toBeNull();
    expect(await subject.commitStoppedInitialization(initialized.claimId!)).toBe(true);
    await expect(subject.peekVisibleMutableState("incarnation-1")).resolves.toMatchObject({
      status: "stopped",
      scheduledRun: { state: "scheduled" },
    });
    expect(await storage.getAlarm()).not.toBeNull();
  });

  it("claims a Cloudflare schedule without machine provenance and retains its auth claim", async () => {
    const { env } = createKvEnv();
    const { subject } = createSubject(env);
    await publishScheduled(
      subject,
      Date.now() - 1_000,
      { backend: "cf", machineId: null },
    );

    const active = await claimScheduledStart(subject, {
      hostMachineId: null,
      authClaim: {
        claudeAuthMode: null,
        codexAuthPreference: "subscription",
      },
    });

    expect(active).toMatchObject({ hostMachineId: null });
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      startCodexAuthPreference: "subscription",
    });
  });

  it("makes an alarm from a replaced incarnation a no-op", async () => {
    const { env } = createKvEnv();
    const { subject, storage } = createSubject(env);
    await publishScheduled(subject);
    const stale = await subject.getScheduledRun();
    if (stale?.kind !== "schedule") throw new Error("Expected a schedule");
    await storage.put("env-publication", {
      incarnationId: "incarnation-2",
      state: "visible",
      updatedAt: new Date().toISOString(),
    });
    const beginAttempt = vi.spyOn(subject, "beginScheduledRunAttempt");

    await (subject as unknown as {
      runScheduledRunStartEffect(record: typeof stale): Promise<void>;
    }).runScheduledRunStartEffect(stale);

    expect(beginAttempt).not.toHaveBeenCalled();
    await expect(subject.getScheduledRun()).resolves.toEqual(stale);
  });

  it("clears failed pending initialization even when KV cleanup fails and retains fences", async () => {
    const { env } = createKvEnv({ rejectDelete: true });
    const { subject, storage } = createSubject(env);
    const { initialized } = await initializeScheduled(subject);
    await storage.put("env-scheduled-run-attempt-sequence", 41);
    await storage.put("runner-command-generation", 19);

    await expect(subject.rollbackStoppedInitialization(initialized.claimId!))
      .rejects.toThrow("Initial environment KV rollback was incomplete");
    await expect(subject.isInitialCreationPending()).resolves.toBe(false);
    await expect(subject.getScheduledRun()).resolves.toBeNull();
    await expect(subject.getImmutablePlan()).resolves.toBeNull();
    await expect(subject.getPublication()).resolves.toMatchObject({ state: "deleted" });
    await expect(storage.get("env-scheduled-run-attempt-sequence")).resolves.toBe(41);
    await expect(storage.get("runner-command-generation")).resolves.toBe(19);
  });

  it("settles cancellation only after an uncertain exact capacity acquire is released", async () => {
    const { env } = createKvEnv();
    const { subject } = createSubject(env);
    await publishScheduled(subject);
    const attempt = await subject.beginScheduledRunAttempt("incarnation-1");
    expect(await subject.markScheduledCapacityAcquireUncertain(attempt.attemptId, "RPC response lost"))
      .toBe(true);

    await expect(subject.cancelScheduledRun()).resolves.toEqual({ cancelled: true, finalizing: true });
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "schedule",
      attemptId: attempt.attemptId,
      acquireUncertain: true,
      cancelRequested: true,
    });
    await expect(subject.prepareScheduledRunLeaseRelease()).resolves.toEqual({
      slug: "demo-env",
      attemptId: attempt.attemptId,
    });
    await expect(subject.confirmScheduledRunLeaseReleased(attempt.attemptId)).resolves.toBeNull();
    await expect(subject.getScheduledRun()).resolves.toBeNull();
  });

  it("keeps stale exact releases queued when a newer attempt claims Start", async () => {
    const { env } = createKvEnv();
    const { subject, storage } = createSubject(env);
    await publishScheduled(subject);
    await storage.put("env-scheduled-run-attempt-sequence", 1);
    const attempt = await subject.beginScheduledRunAttempt("incarnation-1");
    expect(await subject.recordScheduledCapacityAcquired(attempt.attemptId)).toBe(true);
    await storage.put("env-scheduled-run-lease-release", [
      { slug: "demo-env", attemptId: "attempt-1-stale", nextAttemptAtMs: Date.now() },
      { slug: "demo-env", attemptId: attempt.attemptId, nextAttemptAtMs: Date.now() },
    ]);

    await subject.claimScheduledRunStart({
      attemptId: attempt.attemptId,
      harnessSettings: { model: "gpt-5.5", effort: "high" },
      hostMachineId: "host-1",
    });

    await expect(storage.get("env-scheduled-run-lease-release")).resolves.toEqual([
      { slug: "demo-env", attemptId: "attempt-1-stale", nextAttemptAtMs: expect.any(Number) },
    ]);
  });

  it("atomically locks the first outcome, Stop operation, and newer runner generation", async () => {
    const { env } = createKvEnv();
    const { subject, storage } = createSubject(env);
    await publishScheduled(subject);
    const active = await claimScheduledStart(subject);

    const completed = await subject.requestScheduledRunOutcome({
      opId: active.startOpId,
      outcome: "completed",
    });
    expect(completed).toMatchObject({
      status: "accepted",
      outcome: "completed",
      preparationInFlight: true,
      stop: { desiredState: "stopped" },
    });
    if (completed.status === "rejected" || !completed.stop || !completed.lifecycle?.activeOpId) {
      throw new Error("Expected an accepted completion claim");
    }
    expect(completed.stop.commandGeneration).toBeGreaterThan(active.runnerGeneration);
    await expect(subject.requestScheduledRunOutcome({
      opId: active.startOpId,
      outcome: "interrupted",
    })).resolves.toMatchObject({ status: "rejected" });

    expect(await subject.finishScheduledRunPreparation({
      opId: active.startOpId,
      claimedAtMs: active.preparation!.claimedAtMs,
    })).toBe(true);
    expect(await subject.noteFencedRunnerAbsentBeforeScheduledStart(completed.lifecycle.activeOpId))
      .toBe(true);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "active",
      requestedOutcome: "completed",
      runnerStoppedConfirmed: true,
      persistenceConfirmed: true,
      capacityReleased: false,
    });
    await subject.confirmScheduledRunLeaseReleased(active.attemptId);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "finished",
      started: true,
      outcome: "completed",
      cleanupRequired: false,
    });

    const pinned = await subject.getImmutablePlan();
    const ordinary = await subject.beginStart({ model: "gpt-5.5", effort: "high" });
    expect(ordinary.dispatchGranted).toBe(true);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "finished",
      archivedAt: expect.any(String),
    });
    await expect(subject.getImmutablePlan()).resolves.toEqual(pinned);

    const generation = await storage.get<number>("runner-command-generation");
    const attemptSequence = await storage.get<number>("env-scheduled-run-attempt-sequence");
    await subject.finalizeDeletion();
    await expect(storage.get("runner-command-generation")).resolves.toBe(generation);
    await expect(storage.get("env-scheduled-run-attempt-sequence")).resolves.toBe(attemptSequence);
  });

  it("keeps a completed scheduled implementor turn unread after the environment stops", async () => {
    const { env } = createKvEnv();
    const { subject } = createSubject(env);
    await publishScheduled(subject);
    const active = await claimScheduledStart(subject);
    await subject.noteRunnerStarted(active.startOpId);

    await expect(subject.reportImplementorCompletion(active.startOpId, 1)).resolves.toEqual({
      accepted: true,
      changed: true,
    });
    const unreadToken = (await subject.peekMutableState())!
      .implementorAttentionState.unreadToken;
    expect(unreadToken).toEqual(expect.any(String));

    const requested = await subject.requestScheduledRunOutcome({
      opId: active.startOpId,
      outcome: "completed",
    });
    if (requested.status === "rejected" || !requested.lifecycle?.activeOpId) {
      throw new Error("Expected completion to claim Scheduled Run Stop");
    }
    await subject.finishScheduledRunPreparation({
      opId: active.startOpId,
      claimedAtMs: active.preparation!.claimedAtMs,
    });
    await subject.noteStopWorkspaceSynced(requested.lifecycle.activeOpId);
    await subject.noteRunnerStopped(requested.lifecycle.activeOpId, "exit");
    await subject.confirmScheduledRunLeaseReleased(active.attemptId);

    await expect(subject.peekMutableState()).resolves.toMatchObject({
      status: "stopped",
      implementorAttentionState: {
        runtimeStartOpId: active.startOpId,
        lastCompletionSequence: 1,
        unreadToken,
      },
      scheduledRun: { state: "completed" },
    });
  });

  it("keeps Scheduled Run Start and Stop generation pins aligned when rebasing", async () => {
    const { env } = createKvEnv();
    const { subject, storage } = createSubject(env);
    await publishScheduled(subject);
    const active = await claimScheduledStart(subject);
    const startCommand = await subject.claimRunnerCommand(active.startOpId, "running");

    const rebasedStart = await subject.rebaseRejectedRunnerCommand({
      rejectedCommand: startCommand,
      currentCommandGeneration: 60,
    });
    expect(rebasedStart.commandGeneration).toBe(61);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "active",
      runnerGeneration: 61,
    });

    const outcome = await subject.requestScheduledRunOutcome({
      opId: active.startOpId,
      outcome: "completed",
    });
    if (outcome.status === "rejected" || !outcome.stop) {
      throw new Error("Expected the Scheduled Run to claim Stop");
    }
    const rebasedStop = await subject.rebaseRejectedRunnerCommand({
      rejectedCommand: outcome.stop,
      currentCommandGeneration: 80,
    });
    expect(rebasedStop.commandGeneration).toBe(81);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "active",
      runnerGeneration: 61,
      stopRunnerGeneration: 81,
    });
    await expect(storage.get("runner-command-generation")).resolves.toBe(81);
    await expect(storage.get("runner-command-claim")).resolves.toEqual(rebasedStop);
  });

  it("uses cleanupRequired only for runner uncertainty and permits exact Stop recovery", async () => {
    const { env } = createKvEnv();
    const { subject } = createSubject(env);
    await publishScheduled(subject);
    const active = await claimScheduledStart(subject);
    const requested = await subject.requestScheduledRunOutcome({
      opId: active.startOpId,
      outcome: "completed",
    });
    if (requested.status === "rejected" || !requested.lifecycle?.activeOpId) {
      throw new Error("Expected completion to claim Stop");
    }
    const stopOpId = requested.lifecycle.activeOpId;
    expect(await subject.finishScheduledRunPreparation({
      opId: active.startOpId,
      claimedAtMs: active.preparation!.claimedAtMs,
    })).toBe(true);
    expect(await subject.recordScheduledRunnerUncertainty({
      stopOpId,
      error: "Self Host Stop response was ambiguous",
    })).toBe(true);
    await expect(subject.peekMutableState()).resolves.toMatchObject({
      scheduledRun: {
        state: "failed",
        cleanupRequired: true,
        error: "Self Host Stop response was ambiguous",
      },
    });
    await expect(subject.beginDelete()).resolves.toMatchObject({
      allowed: false,
      error: "This workload’s execution backend is unavailable. Delete and recreate it to use your current Settings choice.",
    });

    await subject.noteStopWorkspaceSynced(stopOpId);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "active",
      persistenceConfirmed: true,
      runnerStoppedConfirmed: false,
      runnerCleanupRequired: true,
    });
    await subject.noteRunnerStopped(stopOpId, "exit");
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "active",
      runnerStoppedConfirmed: true,
      runnerCleanupRequired: false,
      runnerUncertaintyError: null,
    });
    await subject.confirmScheduledRunLeaseReleased(active.attemptId);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "finished",
      requestedOutcome: "completed",
      outcome: "completed",
      cleanupRequired: false,
    });
  });

  it("keeps heartbeating a live preparation effect and expires it only when abandoned", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T10:00:00.000Z"));
    const { env } = createKvEnv();
    const { subject } = createSubject(env);
    await publishScheduled(subject);
    const active = await claimScheduledStart(subject);
    const claim = {
      opId: active.startOpId,
      claimedAtMs: active.preparation!.claimedAtMs,
    };

    expect(await subject.beginScheduledRunPreparationEffect(claim)).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(await subject.renewScheduledRunPreparation(claim)).toBe(true);
    const renewed = await subject.getScheduledRun();
    if (renewed?.kind !== "active" || !renewed.preparation) {
      throw new Error("Expected live Scheduled Run preparation");
    }
    expect(renewed.preparation).toMatchObject({
      effectMayBeLive: true,
      heartbeatAtMs: Date.now(),
    });

    expect(await subject.expireScheduledRunPreparation({
      ...claim,
      heartbeatAtMs: renewed.preparation.heartbeatAtMs,
      now: renewed.preparation.heartbeatAtMs + SCHEDULED_RUN_PREPARATION_ABANDON_MS - 1,
    })).toBe(false);
    expect(await subject.expireScheduledRunPreparation({
      ...claim,
      heartbeatAtMs: renewed.preparation.heartbeatAtMs,
      now: renewed.preparation.heartbeatAtMs + SCHEDULED_RUN_PREPARATION_ABANDON_MS,
    })).toBe(true);
    await expect(subject.getScheduledRun()).resolves.toMatchObject({
      kind: "active",
      preparation: null,
      failure: expect.stringContaining("preparation was interrupted"),
    });
  });

  it("re-arms its own alarm after an unexpected alarm pass failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-11T10:00:00.000Z"));
    const { subject, storage } = createSubject();
    vi.spyOn(
      subject as unknown as { runAlarmPass(): Promise<void> },
      "runAlarmPass",
    ).mockRejectedValueOnce(new Error("transient alarm failure"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await subject.alarm();

    expect(await storage.getAlarm()).toBe(Date.now() + SCHEDULED_RUN_EFFECT_RETRY_MS);
    consoleError.mockRestore();
  });
});
