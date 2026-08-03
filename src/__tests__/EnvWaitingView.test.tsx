/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  EnvMeta,
  StartupDiagnosticsSnapshot,
  StartupDiagnosticsState,
} from "../../api/types";
import { createInitialEnvScmState } from "../../api/scm/model";

const mocks = vi.hoisted(() => ({
  fetchDiagnostics: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchEnvStartupDiagnostics: mocks.fetchDiagnostics,
}));

vi.mock("../SailingScene", async () => {
  const ReactModule = await import("react");
  return {
    default: ({ motionVariant }: { motionVariant: string }) => ReactModule.createElement("div", {
      "aria-hidden": "true",
      "data-motion-variant": motionVariant,
      "data-testid": "sailing-scene",
    }),
  };
});

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

function technicalDetails(): HTMLDetailsElement {
  const summary = screen.getByText("Technical details");
  const details = summary.closest("details");
  if (!(details instanceof HTMLDetailsElement)) {
    throw new Error("Technical details disclosure was not rendered");
  }
  return details;
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
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders the animation-led hero and keeps technical details collapsed normally", async () => {
    const active = makeSnapshot();
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics(active));

    render(<EnvWaitingView env={makeEnv()} hubUrl="https://hub.test" />);
    await flushDiagnosticsFetch();

    expect(screen.getByRole("heading", { name: "Preparing your environment" })).toBeInTheDocument();
    const liveAction = screen.getByText("Syncing your workspace…");
    expect(liveAction).toHaveAttribute("aria-live", "polite");
    expect(screen.getByTestId("sailing-scene")).toHaveAttribute("data-motion-variant", "preparing");
    expect(technicalDetails()).not.toHaveAttribute("open");
    expect(technicalDetails()).toContainElement(screen.getByText("Cloning internal workspace data"));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });

  it.each([
    ["saving", "Saving your work", "Syncing your latest changes before shutdown…", "saving"],
    ["stopping", "Stopping your environment", "Your work is saved. Finishing shutdown…", "stopping"],
    ["deleting", "Removing your environment", "Deleting the environment and its stored workspace…", "deleting"],
  ] as const)(
    "uses the friendly %s lifecycle presentation even when diagnostics fetching fails",
    async (status, heading, action, motionVariant) => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      mocks.fetchDiagnostics.mockRejectedValue(new Error("diagnostics unavailable"));

      render(<EnvWaitingView env={makeEnv({ status })} hubUrl="https://hub.test" />);
      await flushDiagnosticsFetch();

      expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument();
      expect(screen.getByText(action)).toBeInTheDocument();
      expect(screen.getByTestId("sailing-scene")).toHaveAttribute(
        "data-motion-variant",
        motionVariant,
      );
      expect(technicalDetails()).not.toHaveAttribute("open");
    },
  );

  it("auto-opens once for a correlated failure and does not reopen after a temporary missing response", async () => {
    const failure = makeSnapshot({
      failure: { message: "Harness exited", lastStepId: "harness-launch" },
    });
    mocks.fetchDiagnostics
      .mockResolvedValueOnce(diagnostics(failure))
      .mockResolvedValueOnce(diagnostics())
      .mockResolvedValueOnce(diagnostics(failure));

    const { rerender } = render(
      <EnvWaitingView
        env={makeEnv({ status: "failed" })}
        hubUrl="https://hub.test"
      />,
    );

    await waitFor(() => expect(technicalDetails()).toHaveAttribute("open"));
    expect(screen.getByRole("heading", {
      name: "We couldn’t prepare your environment",
    })).toBeInTheDocument();

    fireEvent.click(screen.getByText("Technical details"));
    await waitFor(() => expect(technicalDetails()).not.toHaveAttribute("open"));

    rerender(
      <EnvWaitingView
        env={makeEnv({ status: "failed", updatedAt: "2026-07-16T12:00:06.000Z" })}
        hubUrl="https://hub.test"
      />,
    );
    await waitFor(() => expect(screen.getByRole("heading", {
      name: "This environment needs attention",
    })).toBeInTheDocument());
    expect(technicalDetails()).not.toHaveAttribute("open");

    rerender(
      <EnvWaitingView
        env={makeEnv({ status: "failed", updatedAt: "2026-07-16T12:00:07.000Z" })}
        hubUrl="https://hub.test"
      />,
    );
    await waitFor(() => expect(screen.getByRole("heading", {
      name: "We couldn’t prepare your environment",
    })).toBeInTheDocument());
    expect(technicalDetails()).not.toHaveAttribute("open");
  });

  it("opens a new correlated startup operation after the previous operation was closed", async () => {
    const firstFailure = makeSnapshot({ failure: { message: "First failure" } });
    const secondFailure = makeSnapshot({
      opId: "start-2",
      failure: { message: "Second failure" },
      events: [],
    });
    mocks.fetchDiagnostics
      .mockResolvedValueOnce(diagnostics(firstFailure))
      .mockResolvedValueOnce(diagnostics(secondFailure));

    const { rerender } = render(
      <EnvWaitingView env={makeEnv({ status: "failed" })} hubUrl="https://hub.test" />,
    );
    await waitFor(() => expect(technicalDetails()).toHaveAttribute("open"));
    fireEvent.click(screen.getByText("Technical details"));
    await waitFor(() => expect(technicalDetails()).not.toHaveAttribute("open"));

    rerender(
      <EnvWaitingView
        env={makeEnv({
          status: "failed",
          lifecycleOpId: "start-2",
          updatedAt: "2026-07-16T12:01:00.000Z",
        })}
        hubUrl="https://hub.test"
      />,
    );

    await waitFor(() => expect(technicalDetails()).toHaveAttribute("open"));
    expect(screen.getByText("Second failure")).toBeInTheDocument();
  });

  it("does not auto-open stale or previous failure diagnostics", async () => {
    const staleActive = makeSnapshot({
      opId: "old-start",
      failure: { message: "Stale active failure" },
    });
    const previousFailure = makeSnapshot({
      opId: "previous-start",
      failure: { message: "Previous failure" },
    });
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics(staleActive, previousFailure));

    render(
      <EnvWaitingView env={makeEnv({ status: "failed" })} hubUrl="https://hub.test" />,
    );
    await flushDiagnosticsFetch();

    expect(screen.getByRole("heading", {
      name: "This environment needs attention",
    })).toBeInTheDocument();
    expect(technicalDetails()).not.toHaveAttribute("open");
    const previousSummary = screen.getByText("Previous startup failure");
    expect(previousSummary.closest("details")).not.toHaveAttribute("open");
  });

  it("keeps metadata, timeline, logs, raw messages, and copy inside technical details", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const failure = makeSnapshot({
      failure: {
        message: "Harness exited",
        exitCode: 17,
        signal: "SIGTERM",
        lastStepId: "harness-launch",
      },
    });
    mocks.fetchDiagnostics.mockResolvedValue(diagnostics(failure));

    render(
      <EnvWaitingView
        env={makeEnv({
          status: "failed",
          bootMessage: "Raw environment boot message",
        })}
        hubUrl="https://hub.test"
      />,
    );
    await waitFor(() => expect(technicalDetails()).toHaveAttribute("open"));

    const details = technicalDetails();
    for (const text of [
      "Environment metadata",
      "Operation start-1",
      "Raw environment boot message",
      "Raw timeline event",
      "Timeline detail",
      "harness log output",
      "stop-control log output",
      "bootstrap log output",
      "Harness exited",
    ]) {
      expect(details).toContainElement(screen.getByText(text, { exact: false }));
    }

    fireEvent.click(within(details).getByRole("button", { name: "Copy Diagnostics" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('"opId": "start-1"');
    expect(within(details).getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it.each([
    ["stopped", "Start environment"],
    ["failed", "Try again"],
  ] as const)("uses the %s primary action label", async (status, label) => {
    const onStartRequest = vi.fn();
    if (status === "failed") {
      mocks.fetchDiagnostics.mockResolvedValue(diagnostics(makeSnapshot({
        failure: { message: "Startup failed" },
      })));
    }

    render(
      <EnvWaitingView
        env={makeEnv({ status })}
        hubUrl="https://hub.test"
        onStartRequest={onStartRequest}
      />,
    );
    await flushDiagnosticsFetch();

    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(onStartRequest).toHaveBeenCalledWith("demo-env");
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
    expect(vi.getTimerCount()).toBe(1);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
