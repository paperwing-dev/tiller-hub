import { describe, expect, it } from "vitest";
import type {
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
} from "../../api/types";
import { getEnvWaitingPresentation } from "../env-waiting-presentation";

type PresentationEnv = Parameters<typeof getEnvWaitingPresentation>[0];

function makeEnv(overrides: Partial<PresentationEnv> = {}): PresentationEnv {
  return {
    status: "creating",
    harness: "codex",
    bootStepId: null,
    lifecycleOpId: "start-1",
    lifecycleOperation: "start",
    lifecycleDesiredState: "running",
    lifecycleInfraState: "unknown",
    ...overrides,
  };
}

function makeSnapshot(
  overrides: Partial<StartupDiagnosticsSnapshot> = {},
): StartupDiagnosticsSnapshot {
  return {
    opId: "start-1",
    backend: "cf",
    startedAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:01.000Z",
    currentStepId: "workspace-sync",
    currentStepMessage: "raw startup message",
    events: [],
    failure: null,
    logTails: { harness: null, stopControl: null, bootstrap: null },
    ...overrides,
  };
}

function makeDiagnostics(
  active: StartupDiagnosticsSnapshot | null = null,
  lastFailed: StartupDiagnosticsSnapshot | null = null,
): StartupDiagnosticsState {
  return { active, lastFailed };
}

describe("getEnvWaitingPresentation", () => {
  it.each([
    ["saving", "saving", "Saving your work", "Saving workspace…"],
    ["stopping", "stopping", "Stopping your environment", "Your work is saved. Finishing shutdown…"],
    ["deleting", "deleting", "Removing your environment", "Deleting the environment and its stored workspace…"],
  ] as const)(
    "lets the %s lifecycle state take precedence over startup diagnostics",
    (status, displayState, heading, actionText) => {
      const diagnostics = makeDiagnostics(makeSnapshot({
        failure: { message: "old startup failure" },
      }));

      expect(getEnvWaitingPresentation(makeEnv({ status }), diagnostics)).toMatchObject({
        displayState,
        heading,
        actionText,
        primaryAction: "none",
      });
    },
  );

  it.each([
    ["workspace-sync", "Syncing your workspace…"],
    ["stop-control", "Starting environment services…"],
    ["prereq-check", "Checking required tools…"],
    ["hub-connect", "Connecting your environment…"],
    ["runner-ready", "Almost ready…"],
    ["startup-failed", "Getting everything ready…"],
    [null, "Getting everything ready…"],
    ["new-unknown-step", "Getting everything ready…"],
  ] as const)("maps startup step %s to friendly copy", (currentStepId, actionText) => {
    const diagnostics = makeDiagnostics(makeSnapshot({
      currentStepId: currentStepId as StartupDiagnosticsSnapshot["currentStepId"],
    }));

    expect(getEnvWaitingPresentation(makeEnv(), diagnostics)).toMatchObject({
      displayState: "preparing",
      actionText,
      elapsedTimeEligible: true,
    });
  });

  it.each([
    ["claude-code", "Starting Claude Code…"],
    ["codex", "Starting Codex…"],
    ["opencode", "Starting Open Code…"],
  ] as const)("uses the %s harness label", (harness, actionText) => {
    const diagnostics = makeDiagnostics(makeSnapshot({ currentStepId: "harness-launch" }));

    expect(getEnvWaitingPresentation(makeEnv({ harness }), diagnostics).actionText).toBe(actionText);
  });

  it("ignores stale active diagnostics while retaining the environment's lifecycle step", () => {
    const diagnostics = makeDiagnostics(makeSnapshot({
      opId: "old-start",
      currentStepId: "runner-ready",
      currentStepMessage: "A stale raw message",
    }));

    expect(getEnvWaitingPresentation(makeEnv({ bootStepId: "prereq-check" }), diagnostics)).toMatchObject({
      displayState: "preparing",
      actionText: "Checking required tools…",
    });
  });

  it("does not expose raw diagnostic or boot messages in the presentation", () => {
    const diagnostics = makeDiagnostics(makeSnapshot({
      currentStepId: "hub-connect",
      currentStepMessage: "Connected 4 of 7 internal sockets",
    }));

    expect(getEnvWaitingPresentation(makeEnv(), diagnostics).actionText).toBe(
      "Connecting your environment…",
    );
  });

  it.each([
    ["all correlation fields match", {}, {}, "startup-failure"],
    ["operation is absent", { lifecycleOperation: null }, {}, "failure"],
    ["operation is not start", { lifecycleOperation: "stop" }, {}, "failure"],
    ["desired state is absent", { lifecycleDesiredState: null }, {}, "failure"],
    ["desired state is stopped", { lifecycleDesiredState: "stopped" }, {}, "failure"],
    ["lifecycle op ID is absent", { lifecycleOpId: null }, {}, "failure"],
    ["active diagnostics are absent", {}, { active: null }, "runtime-failure"],
    ["diagnostics belong to another op", {}, { activeOpId: "old-start" }, "runtime-failure"],
    ["active diagnostics have no failure", {}, { failure: null }, "runtime-failure"],
  ] as const)(
    "requires exact startup failure correlation when %s",
    (_label, envOverrides, diagnosticOverrides, displayState) => {
      const active = "active" in diagnosticOverrides && diagnosticOverrides.active === null
        ? null
        : makeSnapshot({
            opId: "activeOpId" in diagnosticOverrides
              ? diagnosticOverrides.activeOpId
              : "start-1",
            failure: "failure" in diagnosticOverrides
              ? diagnosticOverrides.failure
              : { message: "Harness exited" },
          });

      const presentation = getEnvWaitingPresentation(
        makeEnv({ status: "failed", ...envOverrides } as Partial<PresentationEnv>),
        makeDiagnostics(active),
      );

      expect(presentation.displayState).toBe(displayState);
      expect(presentation.primaryAction).toBe(
        displayState === "startup-failure" || displayState === "runtime-failure"
          ? "retry"
          : "none",
      );
    },
  );

  it("does not correlate a previous failure without matching active diagnostics", () => {
    const previousFailure = makeSnapshot({
      opId: "start-1",
      failure: { message: "Previous failure" },
    });

    expect(
      getEnvWaitingPresentation(
        makeEnv({ status: "failed" }),
        makeDiagnostics(null, previousFailure),
      ).displayState,
    ).toBe("runtime-failure");
  });

  it("offers recovery from the last saved workspace after an unacknowledged Stop", () => {
    expect(
      getEnvWaitingPresentation(
        makeEnv({
          status: "failed",
          lifecycleOpId: "stop-1",
          lifecycleOperation: "stop",
          lifecycleDesiredState: "stopped",
          lifecycleInfraState: "stopped",
        }),
        makeDiagnostics(),
      ),
    ).toMatchObject({
      displayState: "save-failure",
      heading: "Workspace saving wasn’t confirmed",
      actionText: "Start again to restore the latest saved workspace. Recent changes may be missing.",
      primaryAction: "retry",
    });
  });

  it.each([
    ["stopped", makeDiagnostics(), "stopped", "start"],
    ["failed", makeDiagnostics(makeSnapshot({ failure: { message: "failed" } })), "startup-failure", "retry"],
    ["failed", makeDiagnostics(), "runtime-failure", "retry"],
    ["running", makeDiagnostics(), "running", "none"],
    ["unknown", makeDiagnostics(), "unknown", "none"],
  ] as const)(
    "derives the primary action for %s / %s",
    (status, diagnostics, displayState, primaryAction) => {
      expect(getEnvWaitingPresentation(makeEnv({ status }), diagnostics)).toMatchObject({
        displayState,
        primaryAction,
      });
    },
  );
});
