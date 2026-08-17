/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvMeta,
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
} from "../../api/types";
import { createInitialEnvScmState } from "../../api/scm/model";

const mocks = vi.hoisted(() => ({
  fetchDiagnostics: vi.fn(),
  startEnv: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchEnvStartupDiagnostics: mocks.fetchDiagnostics,
  startEnv: mocks.startEnv,
}));

import EnvWaitingView from "../EnvWaitingView";

function makeEnv(overrides: Partial<EnvMeta> = {}): EnvMeta {
  const env: EnvMeta = {
    slug: "demo-env",
    incarnationId: "incarnation-1",
    repoUrl: "https://github.com/test/repo",
    repoId: "repo-1",
    backend: "cf",
    executionPlacement: { backend: "cf", machineId: null },
    harness: "claude-code",
    harnessSettings: null,
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:05.000Z",
    status: "creating",
    lifecycleOpId: "start-1",
    lifecycleOperation: "start",
    lifecycleDesiredState: "running",
    ...createInitialEnvScmState({
      slug: "demo-env",
      mainCommit: "main-old",
    }),
  };
  return Object.assign(env, overrides);
}

function makeSnapshot(
  overrides: Partial<StartupDiagnosticsSnapshot> = {},
): StartupDiagnosticsSnapshot {
  return {
    opId: "start-1",
    backend: "cf",
    startedAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:05.000Z",
    currentStepId: "workspace-sync",
    currentStepMessage: "Cloning internal workspace data",
    events: [{
      at: "2026-07-16T12:00:01.000Z",
      opId: "start-1",
      stepId: "workspace-sync",
      severity: "info",
      message: "Raw timeline event",
      detail: "Timeline detail",
    }],
    failure: null,
    logTails: {
      harness: "harness log output",
      stopControl: "stop-control log output",
      bootstrap: "bootstrap log output",
    },
    ...overrides,
  };
}

function diagnostics(
  active: StartupDiagnosticsSnapshot | null = null,
  lastFailed: StartupDiagnosticsSnapshot | null = null,
): StartupDiagnosticsState {
  return { active, lastFailed };
}

async function flushDiagnosticsFetch() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("EnvWaitingView", () => {
  beforeEach(() => {
    mocks.fetchDiagnostics.mockReset();
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics());
    mocks.startEnv.mockReset();
    mocks.startEnv.mockResolvedValue({ ok: true, slug: "demo-env", status: "starting" });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the animation-led hero without a technical-details disclosure", async () => {
    const active = makeSnapshot();
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics(active));

    render(<EnvWaitingView env={makeEnv()} hubUrl="https://hub.test" />);
    await flushDiagnosticsFetch();

    expect(screen.getByRole("heading", { name: "Preparing your environment" })).toBeInTheDocument();
    const liveAction = screen.getByText("Syncing your workspace…");
    expect(liveAction).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("img", { name: "Animated ASCII ocean waves" })).toBeInTheDocument();
    expect(screen.getByText("Current: Cloning internal workspace data")).toBeInTheDocument();
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it.each([
    ["fresh", "No plan", "Fixed plan"],
    ["plan", "Fixed plan", "No plan"],
  ] as const)(
    "labels a %s start from the active launch mode, not the saved plan",
    async (implementationMode, expected, unexpected) => {
      mocks.fetchDiagnostics.mockResolvedValue(diagnostics(makeSnapshot({ implementationMode })));

      render(
        <EnvWaitingView
          env={makeEnv({ startupPlanId: "plan-1" })}
          hubUrl="https://hub.test"
        />,
      );
      await flushDiagnosticsFetch();

      const metadata = screen.getByLabelText(new RegExp(`${expected}$`));
      expect(metadata).toBeInTheDocument();
      expect(metadata.getAttribute("aria-label")).not.toContain(unexpected);
    },
  );

  it("uses a static wave illustration when stopped", async () => {
    render(<EnvWaitingView env={makeEnv({ status: "stopped" })} hubUrl="https://hub.test" />);
    await flushDiagnosticsFetch();

    expect(screen.getByRole("heading", { name: "Your environment is stopped" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ASCII ocean waves" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Animated ASCII ocean waves" })).not.toBeInTheDocument();
  });

  it.each([
    ["saving", "Saving your work", "Saving workspace…", true, "Workspace Sync"],
    ["stopping", "Stopping your environment", "Your work is saved. Finishing shutdown…", true, "Stopping"],
    ["deleting", "Removing your environment", "Deleting the environment and its stored workspace…", false, null],
  ] as const)(
    "uses the friendly %s lifecycle presentation even when diagnostics fetching fails",
    async (status, heading, action, animated, detail) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mocks.fetchDiagnostics.mockRejectedValue(new Error("diagnostics unavailable"));

      render(<EnvWaitingView env={makeEnv({ status })} hubUrl="https://hub.test" />);
      await flushDiagnosticsFetch();

      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.getByText(action)).toBeInTheDocument();
      if (animated) {
        expect(screen.getByRole("img", { name: "Animated ASCII ocean waves" })).toBeInTheDocument();
        expect(screen.getByText(detail)).toBeInTheDocument();
      } else {
        expect(screen.getByRole("img", { name: "ASCII ocean waves" })).toBeInTheDocument();
      }
      expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    },
  );

  it("shows the safe reason when saving is waiting for an active agent turn", async () => {
    render(
      <EnvWaitingView
        env={makeEnv({
          status: "saving",
          bootStepId: "workspace-sync",
          bootMessage: "Waiting for the active agent turn to finish safely…",
        })}
        hubUrl="https://hub.test"
      />,
    );
    await flushDiagnosticsFetch();

    expect(screen.getByText("Current: Waiting for the active agent turn to finish safely…"))
      .toBeInTheDocument();
  });

  it("uses correlated failure diagnostics without exposing a technical-details panel", async () => {
    const failure = makeSnapshot({
      failure: { message: "Harness exited", lastStepId: "harness-launch" },
    });
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics(failure));

    render(
      <EnvWaitingView
        env={makeEnv({ status: "failed" })}
        hubUrl="https://hub.test"
      />,
    );
    await flushDiagnosticsFetch();
    expect(screen.getByRole("heading", {
      name: "We couldn’t prepare your environment",
    })).toBeInTheDocument();
    expect(screen.queryByText("Technical details")).not.toBeInTheDocument();
    expect(screen.queryByText("Harness exited")).not.toBeInTheDocument();
  });

  it.each([
    "stopped",
    "failed",
  ] as const)("starts a %s environment fresh without another confirmation", async (status) => {
    const onRecoverEnv = vi.fn();
    if (status === "failed") {
      mocks.fetchDiagnostics.mockResolvedValue(diagnostics(makeSnapshot({
        failure: { message: "Startup failed" },
      })));
    }

    render(
      <EnvWaitingView
        env={makeEnv({ status })}
        hubUrl="https://hub.test"
        onRecoverEnv={onRecoverEnv}
      />,
    );
    await flushDiagnosticsFetch();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    });
    expect(mocks.startEnv).toHaveBeenCalledWith(
      "https://hub.test",
      "demo-env",
      { implementationMode: "fresh" },
    );
    expect(onRecoverEnv).toHaveBeenCalledWith("demo-env", "starting");
  });

  it("offers a restart when a previously running environment failed without startup diagnostics", async () => {
    render(
      <EnvWaitingView
        env={makeEnv({ status: "failed" })}
        hubUrl="https://hub.test"
      />,
    );
    await flushDiagnosticsFetch();

    expect(screen.getByText("Start it again to restore the latest saved workspace.")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ASCII ocean waves" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start fresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start with plan" })).toBeDisabled();
  });

  it("offers an explicit last-saved recovery after Stop persistence times out", async () => {
    const onRecoverEnv = vi.fn();
    render(
      <EnvWaitingView
        env={makeEnv({
          status: "failed",
          lifecycleOpId: "stop-1",
          lifecycleOperation: "stop",
          lifecycleDesiredState: "stopped",
          lifecycleInfraState: "stopped",
        })}
        hubUrl="https://hub.test"
        onRecoverEnv={onRecoverEnv}
      />,
    );
    await flushDiagnosticsFetch();

    expect(screen.getByRole("heading", { name: "Workspace saving wasn’t confirmed" }))
      .toBeInTheDocument();
    expect(screen.getByText(
      "Start again to restore the latest saved workspace. Recent changes may be missing.",
    )).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start fresh" }));
    });
    expect(mocks.startEnv).toHaveBeenCalledWith(
      "https://hub.test",
      "demo-env",
      { implementationMode: "fresh" },
    );
    expect(onRecoverEnv).toHaveBeenCalledWith("demo-env", "starting");
  });

  it("uses the static wave illustration while a ready environment opens", async () => {
    render(<EnvWaitingView env={makeEnv({ status: "running" })} hubUrl="https://hub.test" />);
    await flushDiagnosticsFetch();

    expect(screen.getByRole("heading", { name: "Your environment is ready" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "ASCII ocean waves" })).toBeInTheDocument();
  });

  it("starts directly with the environment's saved plan", async () => {
    const onRecoverEnv = vi.fn();
    render(
      <EnvWaitingView
        env={makeEnv({ status: "stopped", startupPlanId: "plan-1" })}
        hubUrl="https://hub.test"
        onRecoverEnv={onRecoverEnv}
      />,
    );
    await flushDiagnosticsFetch();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start with plan" }));
    });
    expect(mocks.startEnv).toHaveBeenCalledWith(
      "https://hub.test",
      "demo-env",
      { implementationMode: "plan" },
    );
    expect(onRecoverEnv).toHaveBeenCalledWith("demo-env", "starting");
  });
});

describe("EnvWaitingView elapsed time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-16T12:00:05.000Z"));
    mocks.fetchDiagnostics.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("derives each tick from the timestamp, including a suspended-tab time jump", async () => {
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics(makeSnapshot()));
    render(<EnvWaitingView env={makeEnv()} hubUrl="https://hub.test" />);
    await flushDiagnosticsFetch();

    expect(screen.getByTestId("startup-elapsed")).toHaveTextContent("Elapsed 5s");

    act(() => {
      vi.setSystemTime(new Date("2026-07-16T12:01:10.000Z"));
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId("startup-elapsed")).toHaveTextContent("Elapsed 1m 11s");
    expect(screen.getByText("Syncing your workspace…")).not.toContainElement(
      screen.getByTestId("startup-elapsed"),
    );
  });

  it("omits invalid and future timestamps", async () => {
    mocks.fetchDiagnostics.mockResolvedValueOnce(diagnostics(makeSnapshot({
      startedAt: "not-a-timestamp",
    })));
    const { rerender } = render(
      <EnvWaitingView env={makeEnv()} hubUrl="https://hub.test" />,
    );
    await flushDiagnosticsFetch();
    expect(screen.queryByTestId("startup-elapsed")).not.toBeInTheDocument();

    mocks.fetchDiagnostics.mockResolvedValueOnce(diagnostics(makeSnapshot({
      opId: "start-2",
      startedAt: "2026-07-16T12:10:00.000Z",
      events: [],
    })));
    rerender(
      <EnvWaitingView
        env={makeEnv({
          lifecycleOpId: "start-2",
          updatedAt: "2026-07-16T12:00:06.000Z",
        })}
        hubUrl="https://hub.test"
      />,
    );
    await flushDiagnosticsFetch();
    expect(screen.queryByTestId("startup-elapsed")).not.toBeInTheDocument();
  });

  it("resets the timer for a new operation and cleans it up on unmount", async () => {
    mocks.fetchDiagnostics
      .mockResolvedValueOnce(diagnostics(makeSnapshot()))
      .mockResolvedValueOnce(diagnostics(makeSnapshot({
        opId: "start-2",
        startedAt: "2026-07-16T12:00:04.000Z",
        events: [],
      })));
    const { rerender, unmount } = render(
      <EnvWaitingView env={makeEnv()} hubUrl="https://hub.test" />,
    );
    await flushDiagnosticsFetch();
    expect(screen.getByTestId("startup-elapsed")).toHaveTextContent("Elapsed 5s");

    rerender(
      <EnvWaitingView
        env={makeEnv({
          lifecycleOpId: "start-2",
          updatedAt: "2026-07-16T12:00:06.000Z",
        })}
        hubUrl="https://hub.test"
      />,
    );
    await flushDiagnosticsFetch();
    expect(screen.getByTestId("startup-elapsed")).toHaveTextContent("Elapsed 1s");
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
