import { describe, expect, it } from "vitest";
import {
  SCHEDULED_RUN_EFFECT_RETRY_MS,
  SCHEDULED_RUN_PREPARATION_ABANDON_MS,
  SCHEDULED_RUN_PREPARATION_LEASE_MS,
  finishedScheduledRun,
  nextScheduledRunWakeAt,
  projectScheduledRun,
  type ActiveScheduledRunReceipt,
  type EnvironmentPlanSchedule,
} from "../env/scheduled-run-state";

const RUN_AT_MS = Date.parse("2026-07-11T10:00:00.000Z");
const DEADLINE_AT_MS = RUN_AT_MS + 3 * 60 * 60_000;

function schedule(overrides: Partial<EnvironmentPlanSchedule> = {}): EnvironmentPlanSchedule {
  return {
    kind: "schedule",
    incarnationId: "incarnation-1",
    runAtMs: RUN_AT_MS,
    deadlineAtMs: DEADLINE_AT_MS,
    timeZone: "America/Los_Angeles",
    localDevOrigin: null,
    createdAt: "2026-07-10T20:00:00.000Z",
    updatedAt: "2026-07-10T20:00:00.000Z",
    attemptId: null,
    retryAtMs: null,
    lastError: null,
    capacityAcquired: false,
    acquireUncertain: false,
    cancelRequested: false,
    terminalRequested: false,
    ...overrides,
  };
}

function active(overrides: Partial<ActiveScheduledRunReceipt> = {}): ActiveScheduledRunReceipt {
  return {
    ...schedule(),
    kind: "active",
    slug: "demo",
    attemptId: "attempt-1-test",
    startOpId: "start-op-1",
    startCause: "scheduled",
    runnerGeneration: 7,
    harnessSettings: { model: "gpt-5.5", effort: "high" },
    hostMachineId: "host-1",
    preparation: null,
    credentialsMayExist: true,
    credentialIds: {},
    runnerDispatchStarted: true,
    runnerStoppedConfirmed: false,
    persistenceConfirmed: false,
    capacityReleased: false,
    requestedOutcome: null,
    stopOpId: null,
    stopRunnerGeneration: null,
    runnerCleanupRequired: false,
    runnerUncertaintyError: null,
    failure: null,
    startedAt: "2026-07-11T10:00:05.000Z",
    ...overrides,
  };
}

describe("Scheduled Run flat lifecycle record", () => {
  it("projects scheduled, implementing, and saving without exposing internal receipts", () => {
    expect(projectScheduledRun(schedule())).toEqual({
      state: "scheduled",
      runAtMs: RUN_AT_MS,
      timeZone: "America/Los_Angeles",
    });
    expect(projectScheduledRun(active())).toEqual({
      state: "running",
      stage: "implementing",
      runAtMs: RUN_AT_MS,
      timeZone: "America/Los_Angeles",
    });
    expect(projectScheduledRun(active({ requestedOutcome: "completed", stopOpId: "stop-op-1" })))
      .toMatchObject({ state: "running", stage: "saving" });
  });

  it("uses cleanupRequired only when exact runner shutdown is uncertain", () => {
    expect(projectScheduledRun(active({ failure: "credential cleanup is retrying" })))
      .toMatchObject({ state: "running", stage: "saving" });
    expect(projectScheduledRun(active({
      runnerCleanupRequired: true,
      runnerUncertaintyError: "runner response was ambiguous",
    }))).toEqual({
      state: "failed",
      runAtMs: RUN_AT_MS,
      timeZone: "America/Los_Angeles",
      error: "runner response was ambiguous",
      cleanupRequired: true,
    });
  });

  it("creates explicit pre-Start failed receipts and hides archived receipts", () => {
    const finished = finishedScheduledRun(schedule({ attemptId: "attempt-1-test" }), {
      outcome: "failed",
      error: "deadline passed before Start",
      at: "2026-07-11T13:00:00.000Z",
    });
    expect(finished).toMatchObject({
      kind: "finished",
      started: false,
      attemptId: "attempt-1-test",
      startOpId: null,
      outcome: "failed",
      cleanupRequired: false,
    });
    expect(projectScheduledRun(finished)).toMatchObject({ state: "failed" });
    expect(projectScheduledRun({ ...finished, archivedAt: "2026-07-11T14:00:00.000Z" })).toBeNull();
  });

  it("keeps uncertain capacity attempts on a reconciliation wake", () => {
    const now = RUN_AT_MS + 1_000;
    const uncertain = schedule({
      attemptId: "attempt-1-test",
      acquireUncertain: true,
    });
    expect(projectScheduledRun(uncertain)).toMatchObject({
      state: "scheduled",
      stage: "saving",
    });
    expect(nextScheduledRunWakeAt(uncertain, now)).toBe(now + SCHEDULED_RUN_EFFECT_RETRY_MS);
    expect(nextScheduledRunWakeAt(schedule(), now)).toBe(RUN_AT_MS);
  });

  it("backs off cleanup effects after the hard cap instead of arming a past alarm", () => {
    const now = DEADLINE_AT_MS + 1_000;
    expect(nextScheduledRunWakeAt(active({ requestedOutcome: "interrupted" }), now))
      .toBe(now + SCHEDULED_RUN_EFFECT_RETRY_MS);
  });

  it("gives a live preparation effect a longer stale window", () => {
    const now = RUN_AT_MS + 1_000;
    const preparation = { claimedAtMs: now, heartbeatAtMs: now, effectMayBeLive: false };
    expect(nextScheduledRunWakeAt(active({ preparation }), now))
      .toBe(now + SCHEDULED_RUN_PREPARATION_LEASE_MS);
    expect(nextScheduledRunWakeAt(active({
      preparation: { ...preparation, effectMayBeLive: true },
    }), now)).toBe(now + SCHEDULED_RUN_PREPARATION_ABANDON_MS);
  });
});
