/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRoute,
  PlanContribution,
  PlanWriterState,
} from "../../api/coordination/types";

const mocks = vi.hoisted(() => {
  const terminalAckRef = { current: null as null | ((message: any) => void) };
  const planWriterRefreshHintRef = {
    current: null as null | ((repoId: string, planArtifactId: string) => void),
  };
  return {
    connected: true,
    terminalFastLane: true,
    autoRecoveryReady: true,
    terminalAckRef,
    planWriterRefreshHintRef,
    wsSend: vi.fn(),
    incorporate: vi.fn(),
    dismiss: vi.fn(),
    fetchWriter: vi.fn(),
    startWriter: vi.fn(),
    stopWriter: vi.fn(),
    terminalRecover: vi.fn(),
    terminalProps: null as null | {
      fontSize?: number;
      interactive?: boolean;
      visible?: boolean;
      onInput?: (data: string) => void;
      onPaste?: (text: string) => void;
      onResize?: (cols: number, rows: number, request?: { claim?: boolean }) => void;
      onRecoveryState?: (state: { status: "recovering" | "ready" | "fault"; code?: string }) => void;
    },
  };
});

vi.mock("../DashboardDataProvider", () => ({
  useDashboardData: () => ({
    hubUrl: "http://localhost",
    connected: mocks.connected,
    terminalFastLane: mocks.terminalFastLane,
    liveMessageRef: { current: null },
    terminalAckRef: mocks.terminalAckRef,
    planWriterRefreshHintRef: mocks.planWriterRefreshHintRef,
    wsRef: { current: { send: mocks.wsSend } },
    updateLastSeq: vi.fn(),
  }),
}));

vi.mock("../TerminalView", async () => {
  const ReactModule = await import("react");
  const Terminal = ReactModule.forwardRef(function MockTerminal(
    props: {
      fontSize?: number;
      interactive?: boolean;
      visible?: boolean;
      onInput?: (data: string) => void;
      onPaste?: (text: string) => void;
      onResize?: (cols: number, rows: number, request?: { claim?: boolean }) => void;
      onRecoveryState?: (state: { status: "recovering" | "ready" | "fault"; code?: string }) => void;
    },
    ref,
  ) {
    mocks.terminalProps = props;
    ReactModule.useImperativeHandle(ref, () => ({
      acceptMessage: vi.fn(),
      recover: mocks.terminalRecover,
      clear: vi.fn(),
    }));
    ReactModule.useEffect(() => {
      if (mocks.autoRecoveryReady) props.onRecoveryState?.({ status: "ready" });
    }, [props.onRecoveryState]);
    return <div data-testid="terminal" data-font-size={props.fontSize} />;
  });
  return { default: Terminal };
});

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    dismissPlanContribution: mocks.dismiss,
    fetchPlanWriter: mocks.fetchWriter,
    incorporatePlanContribution: mocks.incorporate,
    startPlanWriter: mocks.startWriter,
    stopPlanWriter: mocks.stopWriter,
  };
});

import PlanWriterPane, { type PlanContributionPresentation } from "../PlanWriterPane";

const routes: AgentRoute[] = [{
  key: "codex:gpt-5.5",
  label: "GPT 5.5",
  harness: "codex",
  provider: "codex",
  model: "gpt-5.5",
  modelId: "gpt-5.5",
  supportedEfforts: ["low", "high", "xhigh"],
  defaultEffort: "xhigh",
  available: true,
}];

function writer(
  lifecycle: PlanWriterState["lifecycle"],
  overrides: Partial<PlanWriterState> = {},
): PlanWriterState {
  const running = lifecycle !== "not_running";
  return {
    lifecycle,
    generation: running ? 1 : null,
    provider: running ? "codex" : null,
    model: running ? "gpt-5.5" : null,
    effort: running ? "high" : null,
    basisCommit: running ? "main-1" : null,
    terminalId: running ? "plan-writer-1" : null,
    synchronization: { state: "up_to_date" },
    editable: true,
    ...overrides,
  };
}

function stoppedWriter(): PlanWriterState {
  return {
    ...writer("not_running"),
    generation: 1,
    provider: "codex",
    model: "gpt-5.5",
    effort: "high",
    basisCommit: "main-1",
    terminalId: "plan-writer-1",
    stopReason: "user",
  };
}

function contribution(
  id: string,
  text: string,
  overrides: Partial<PlanContribution> = {},
): PlanContribution {
  return {
    id,
    repoId: "repo-1",
    planArtifactId: "plan-1",
    sourceKind: "reviewer_message",
    provider: "codex",
    model: "gpt-5.5",
    text,
    status: "pending",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    ...overrides,
    sourceRefs: overrides.sourceRefs ?? [],
  };
}

function renderPane(options: {
  initialWriter?: PlanWriterState;
  contributions?: PlanContribution[];
  contributionPresentations?: ReadonlyMap<string, PlanContributionPresentation>;
  handoff?: { id: string; contributionIds: string[] } | null;
  queuedHandoffContributionIds?: string[];
  onHandoffSettled?: (handoffId: string, error?: string) => void;
  onWriterChange?: (writer: PlanWriterState) => void;
  onTabStatusChange?: (status: any) => void;
  onViewContributionSource?: (contributionId: string) => void;
  onAddReviewer?: () => void;
  onOpenSettings?: () => void;
  settingsAvailable?: boolean;
  hidden?: boolean;
  compact?: boolean;
} = {}) {
  const initialWriter = options.initialWriter ?? writer("running");
  mocks.fetchWriter.mockResolvedValue(initialWriter);
  const pane = (hidden = options.hidden ?? false) => (
    <PlanWriterPane
      repoId="repo-1"
      planArtifactId="plan-1"
      initialWriter={initialWriter}
      routes={routes}
      selection={{ routeKey: "codex:gpt-5.5", effort: "xhigh" }}
      contributions={options.contributions ?? []}
      contributionPresentations={options.contributionPresentations}
      handoff={options.handoff}
      queuedHandoffContributionIds={options.queuedHandoffContributionIds}
      hidden={hidden}
      compact={options.compact}
      onWriterChange={options.onWriterChange ?? vi.fn()}
      onTabStatusChange={options.onTabStatusChange ?? vi.fn()}
      onContributionsChanged={vi.fn()}
      onHandoffSettled={options.onHandoffSettled ?? vi.fn<(handoffId: string, error?: string) => void>()}
      onViewContributionSource={options.onViewContributionSource}
      onAddReviewer={options.onAddReviewer}
      onOpenSettings={options.onOpenSettings ?? vi.fn()}
      settingsAvailable={options.settingsAvailable}
    />
  );
  const rendered = render(pane());
  return {
    ...rendered,
    rerenderPane: (hidden: boolean) => rendered.rerender(pane(hidden)),
  };
}

describe("PlanWriterPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connected = true;
    mocks.terminalFastLane = true;
    mocks.autoRecoveryReady = true;
    mocks.terminalAckRef.current = null;
    mocks.planWriterRefreshHintRef.current = null;
    mocks.terminalProps = null;
    mocks.incorporate.mockResolvedValue({});
    mocks.startWriter.mockReset();
    mocks.startWriter.mockResolvedValue(writer("running"));
    mocks.stopWriter.mockReset();
    mocks.stopWriter.mockResolvedValue(stoppedWriter());
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: true,
      }));
      return true;
    });
  });

  afterEach(cleanup);

  it("opens Scribe Settings from the Scribe header", () => {
    const onOpenSettings = vi.fn();
    renderPane({ initialWriter: writer("not_running"), onOpenSettings });

    expect(screen.getByText(/GPT 5\.5 · Extra High reasoning/)).toBeInTheDocument();
    expect(screen.queryByText("Not running")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Scribe in Plan Mode" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Scribe Settings" }));
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Change" })).not.toBeInTheDocument();
  });

  it("shows a restart surface for a stopped generation without the old terminal", () => {
    renderPane({ initialWriter: { ...stoppedWriter(), stopReason: "idle" } });

    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
    expect(screen.queryByText("Writer stopped after inactivity")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
  });

  it("replaces compact terminal history with the restart surface after stopping", () => {
    renderPane({ initialWriter: stoppedWriter(), compact: true });

    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument();
  });

  it("keeps an obvious Stop Scribe control below a live compact terminal", async () => {
    renderPane({ compact: true });

    expect(screen.getByText("Scribe is live · ready for input")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Stop Scribe" }));

    await waitFor(() => expect(mocks.stopWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      1,
    ));
  });

  it("shows the compact launch animation immediately while start is pending", async () => {
    let resolveStart!: (value: PlanWriterState) => void;
    mocks.startWriter.mockReturnValue(new Promise((resolve) => { resolveStart = resolve; }));
    renderPane({ initialWriter: writer("not_running"), compact: true });

    fireEvent.click(screen.getByRole("button", { name: "Start Scribe" }));

    expect(screen.getByRole("heading", { name: "Starting Scribe" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Animated ASCII ocean waves" })).toBeInTheDocument();
    expect(screen.getByText("Requesting")).toBeInTheDocument();
    expect(screen.getByText("Current: Reserving a Scribe session for this plan…")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();

    act(() => resolveStart(writer("running")));
    await waitFor(() => expect(screen.getByTestId("terminal")).toBeInTheDocument());
  });

  it("makes an unusually slow Scribe start diagnosable and recoverable", async () => {
    const starting = writer("starting", {
      startup: {
        stage: "launching",
        updatedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
      },
    });
    mocks.startWriter.mockResolvedValue(starting);
    renderPane({ initialWriter: starting, compact: true });

    expect(screen.getByText("Connecting")).toBeInTheDocument();
    expect(screen.getByText("Current: Waiting for Codex to open its terminal…")).toBeInTheDocument();
    expect(screen.getByText(/The Scribe has not connected yet/)).toBeInTheDocument();
    expect(screen.getByTestId("scribe-startup-elapsed")).toHaveTextContent(/Waiting 3m/);
    expect(screen.queryByRole("button", { name: "Check connection" })).not.toBeInTheDocument();

    const launchStatus = screen.getByTestId("scribe-launch-status");
    const cancelStart = within(launchStatus).getByRole("button", { name: "Cancel start" });
    expect(cancelStart).toBeEnabled();
    fireEvent.click(cancelStart);
    await waitFor(() => expect(mocks.stopWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      1,
    ));
  });

  it("makes a stopped-generation restart include every waiting item", () => {
    renderPane({
      initialWriter: stoppedWriter(),
      contributions: [
        contribution("contribution-1", "First waiting review"),
        contribution("contribution-2", "Second waiting review"),
      ],
    });

    expect(screen.queryByRole("button", { name: /Restart without/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Scribe and share 2 items" })).toBeInTheDocument();
  });

  it("uses the compact terminal and control row as the only live writer input", async () => {
    renderPane({
      initialWriter: writer("running", {
        codexAuthMode: "subscription",
        synchronization: { state: "saving" },
      }),
    });

    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    expect(mocks.wsSend).toHaveBeenCalledWith({
      type: "reconnect",
      sessionId: "plan-writer-1",
      lastSeq: 0,
      revive: false,
      replay: false,
    });
    const terminal = screen.getByTestId("terminal");
    expect(terminal).toHaveAttribute("data-font-size", "12");
    expect(terminal.parentElement).toHaveClass("min-h-0", "flex-1");
    expect(mocks.terminalProps?.onInput).toEqual(expect.any(Function));
    act(() => mocks.terminalProps?.onResize?.(120, 50, { claim: true }));
    expect(mocks.wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "terminal-control",
      action: "resize",
      cols: 120,
      rows: 50,
      claim: true,
    }));
    act(() => mocks.terminalProps?.onResize?.(121, 50, { claim: false }));
    expect(mocks.wsSend).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "terminal-control",
      action: "resize",
      cols: 121,
      rows: 50,
      claim: false,
    }));
    const configuration = screen.getByText(/GPT 5\.5 · High reasoning/);
    expect(configuration).toBeInTheDocument();
    expect(configuration.closest(".shrink-0")).toHaveClass("px-3", "py-1");
    const subscription = screen.getByText("Subscription");
    expect(configuration.parentElement).toContainElement(subscription);
    expect(screen.getByRole("button", { name: "Scribe Settings" }).parentElement)
      .not.toBe(configuration.parentElement);
    expect(screen.queryByText("Running")).not.toBeInTheDocument();
    expect(screen.queryByText("Saving")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Message")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("uses the TUI as the only compact Scribe input surface", async () => {
    renderPane({ initialWriter: writer("running"), compact: true });

    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    expect(screen.getByTestId("terminal").parentElement).toHaveClass(
      "tiller-scribe-terminal-surface",
    );
    expect(screen.queryByPlaceholderText(/Message Scribe/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();
  });

  it("keeps the terminal mounted while the Scribe tab is hidden", async () => {
    const rendered = renderPane();
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    const terminal = screen.getByTestId("terminal");

    rendered.rerenderPane(true);
    expect(screen.getByTestId("terminal")).toBe(terminal);
    expect(terminal.closest(".hidden")).not.toBeNull();
    expect(mocks.terminalProps?.visible).toBe(false);

    rendered.rerenderPane(false);
    expect(screen.getByTestId("terminal")).toBe(terminal);
    expect(terminal.closest(".hidden")).toBeNull();
    expect(mocks.terminalProps?.visible).toBe(true);
  });

  it("sends a Codex clipboard paste once as an explicit frame without submitting", async () => {
    renderPane();
    await waitFor(() => expect(mocks.terminalProps?.onPaste).toEqual(expect.any(Function)));
    const callsBeforePaste = mocks.wsSend.mock.calls.length;

    act(() => mocks.terminalProps?.onPaste?.("# Plan\n- First step"));

    expect(mocks.wsSend).toHaveBeenCalledTimes(callsBeforePaste + 1);
    expect(mocks.wsSend).toHaveBeenLastCalledWith(expect.objectContaining({
      type: "terminal-input",
      sessionId: "plan-writer-1",
      data: "\u001b[200~# Plan\n- First step\u001b[201~",
    }));
  });

  it("leaves non-Codex Scribe paste behavior with the provider TUI", async () => {
    renderPane({
      initialWriter: writer("running", { provider: "claude-code", model: "opus-4.6" }),
    });

    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    expect(mocks.terminalProps?.onPaste).toBeUndefined();
  });

  it("renders an icon-only danger stop control with its hover and focus tooltip", async () => {
    const user = userEvent.setup();
    renderPane();
    const stopControl = screen.getByRole("button", { name: "Stop Scribe" });
    const tooltip = "Stops this Scribe immediately. The saved plan remains, and runtime cleanup continues in the background.";

    expect(stopControl).toHaveClass("h-6", "w-6", "bg-kumo-danger");
    expect(stopControl).not.toHaveTextContent(/\S/);
    expect(stopControl.querySelector("svg")).toHaveAttribute("width", "14");

    await user.hover(stopControl);
    expect(await screen.findByText(tooltip)).toBeInTheDocument();
    await user.unhover(stopControl);
    await waitFor(() => expect(screen.queryByText(tooltip)).not.toBeInTheDocument());

    fireEvent.focus(stopControl);
    expect(await screen.findByText(tooltip)).toBeInTheDocument();
  });

  it("stops the current generation once and disables duplicate activation while pending", async () => {
    let resolveStop!: (value: PlanWriterState) => void;
    mocks.stopWriter.mockReturnValue(new Promise((resolve) => { resolveStop = resolve; }));
    renderPane();

    const stopControl = screen.getByRole("button", { name: "Stop Scribe" });
    fireEvent.click(stopControl);

    expect(mocks.stopWriter).toHaveBeenCalledWith("http://localhost", "repo-1", "plan-1", 1);
    await waitFor(() => expect(stopControl).toBeDisabled());
    fireEvent.click(stopControl);
    expect(mocks.stopWriter).toHaveBeenCalledTimes(1);

    act(() => resolveStop(stoppedWriter()));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument());
  });

  it("shows that stopped offline runtime cleanup will finish in the background", async () => {
    mocks.stopWriter.mockResolvedValue({
      ...stoppedWriter(),
      cleanupPending: true,
      cleanupCode: "runtime_cleanup_deferred",
      cleanupWarning: "Scribe stopped. Runtime cleanup will finish when the execution backend is available; you can restart it now.",
    });
    renderPane();

    fireEvent.click(screen.getByRole("button", { name: "Stop Scribe" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "Scribe stopped. Runtime cleanup will finish when the execution backend is available; you can restart it now.",
    );
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument();
  });

  it("renders only the highest-precedence durable error notice", () => {
    renderPane({
      initialWriter: {
        ...stoppedWriter(),
        cleanupError: "cleanup failed",
        startupError: "startup failed",
        synchronization: { state: "sync_failed", error: "sync failed" },
      },
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Cleanup failed: cleanup failed");
    expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(/Startup failed:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sync failed:/)).not.toBeInTheDocument();
  });

  it("keeps a live writer status while surfacing local operation errors", async () => {
    mocks.wsSend.mockReturnValue(false);
    mocks.stopWriter.mockRejectedValue(new Error("Stop failed"));
    const onTabStatusChange = vi.fn();
    renderPane({ onTabStatusChange });

    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    act(() => mocks.terminalProps?.onInput?.("Update the plan"));
    expect(screen.getByRole("alert")).toHaveTextContent("Terminal input could not be delivered");
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(onTabStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "running", label: "Live" }));

    fireEvent.click(screen.getByRole("button", { name: "Stop Scribe" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Stop failed"));
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(onTabStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "running", label: "Live" }));
  });

  it("makes terminal history read-only after a missing-owner ACK", async () => {
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: false,
        error: "No active terminal owner for session",
      }));
      return true;
    });
    const onTabStatusChange = vi.fn();
    renderPane({ compact: true, onTabStatusChange });
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    const recoverCalls = mocks.terminalRecover.mock.calls.length;

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Scribe terminal disconnected. Your last input was not delivered.",
    );
    expect(mocks.terminalProps?.interactive).toBe(false);
    expect(screen.getByTestId("terminal")).toBeInTheDocument();
    expect(screen.getByText("Scribe terminal unavailable · history is read-only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check & recover" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Scribe" })).not.toBeInTheDocument();
    expect(screen.queryByText("No active terminal owner for session")).not.toBeInTheDocument();
    expect(mocks.terminalRecover).toHaveBeenCalledTimes(recoverCalls);
    expect(onTabStatusChange).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: "error",
      label: "Error",
      detail: expect.stringContaining("Your last input was not delivered"),
    }));
  });

  it("lets the user explicitly retry without resending failed input", async () => {
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: false,
        error: "No active terminal owner for session",
      }));
      return true;
    });
    renderPane({ compact: true });
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));
    await screen.findByRole("alert");
    const inputCount = mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input").length;
    const recoverCalls = mocks.terminalRecover.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    expect(screen.queryByTestId("scribe-terminal-unavailable")).not.toBeInTheDocument();
    expect(mocks.terminalRecover).toHaveBeenCalledTimes(recoverCalls + 1);
    expect(mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input")).toHaveLength(inputCount);
  });

  it("checks a live workload without resending input or queued reviewer context", async () => {
    const item = contribution("contribution-1", "Review this without sharing it automatically");
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: false,
        error: "No active terminal owner for session",
      }));
      return true;
    });
    renderPane({ compact: true, contributions: [item] });
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));
    await screen.findByRole("alert");
    const inputCount = mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input").length;

    fireEvent.click(screen.getByRole("button", { name: "Check & recover" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The Scribe workload is running, but its terminal has not reconnected.",
    );
    expect(mocks.startWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      { routeKey: "codex:gpt-5.5", effort: "xhigh" },
    );
    expect(mocks.terminalProps?.interactive).toBe(false);
    expect(mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input")).toHaveLength(inputCount);
    expect(mocks.incorporate).not.toHaveBeenCalled();
  });

  it("stays read-only when Check & recover cannot inspect the workload", async () => {
    mocks.startWriter.mockRejectedValue(new Error("Runtime inspection failed"));
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: false,
        error: "No active terminal owner for session",
      }));
      return true;
    });
    renderPane({ compact: true });
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));
    await screen.findByRole("alert");
    const inputCount = mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input").length;

    fireEvent.click(screen.getByRole("button", { name: "Check & recover" }));

    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(
      "Recovery check failed: Runtime inspection failed",
    ));
    expect(mocks.terminalProps?.interactive).toBe(false);
    expect(screen.getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Check & recover" })).toBeEnabled();
    expect(mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input")).toHaveLength(inputCount);
  });

  it("uses a replacement generation returned by Check & recover", async () => {
    const replacement = writer("running", { generation: 2, terminalId: "plan-writer-2" });
    const onWriterChange = vi.fn();
    mocks.startWriter.mockResolvedValue(replacement);
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: false,
        error: "No active terminal owner for session",
      }));
      return true;
    });
    renderPane({ compact: true, onWriterChange });
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));
    await screen.findByRole("alert");
    const inputCount = mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input").length;

    fireEvent.click(screen.getByRole("button", { name: "Check & recover" }));

    await waitFor(() => expect(onWriterChange).toHaveBeenCalledWith(replacement));
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    expect(screen.queryByTestId("scribe-terminal-unavailable")).not.toBeInTheDocument();
    expect(mocks.wsSend.mock.calls
      .filter(([message]) => message.type === "terminal-input")).toHaveLength(inputCount);
  });

  it("shows a stopped writer when missing-owner reconciliation says it stopped", async () => {
    mocks.wsSend.mockImplementation((message: any) => {
      queueMicrotask(() => mocks.terminalAckRef.current?.({
        type: "terminal-input-ack",
        sessionId: message.sessionId,
        clientId: message.clientId,
        inputSeq: message.inputSeq,
        ok: false,
        error: "No active terminal owner for session",
      }));
      return true;
    });
    renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());
    mocks.fetchWriter.mockResolvedValue(stoppedWriter());
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));

    await waitFor(() => expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal")).not.toBeInTheDocument();
  });

  it("never stops a running writer during refresh or unmount", async () => {
    const rendered = renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());

    mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1");
    await waitFor(() => expect(mocks.fetchWriter.mock.calls.length).toBeGreaterThan(1));
    rendered.unmount();

    expect(mocks.stopWriter).not.toHaveBeenCalled();
    expect(mocks.wsSend).toHaveBeenCalledWith(expect.objectContaining({
      type: "terminal-detach",
      sessionId: "plan-writer-1",
    }));
  });

  it("ignores a refresh that resolves after a newer stop result", async () => {
    let resolveRefresh!: (value: PlanWriterState) => void;
    renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());
    mocks.fetchWriter.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));

    act(() => mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1"));
    fireEvent.click(screen.getByRole("button", { name: "Stop Scribe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument());

    act(() => resolveRefresh(writer("running")));
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
  });

  it("does not publish a refresh result after the pane unmounts", async () => {
    const onWriterChange = vi.fn();
    const rendered = renderPane({ onWriterChange });
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());
    await waitFor(() => expect(onWriterChange).toHaveBeenCalled());
    const acceptedBeforeUnmount = onWriterChange.mock.calls.length;

    let resolveRefresh!: (value: PlanWriterState) => void;
    mocks.fetchWriter.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    act(() => mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1"));
    await waitFor(() => expect(mocks.fetchWriter.mock.calls.length).toBeGreaterThan(1));
    rendered.unmount();

    await act(async () => resolveRefresh(stoppedWriter()));
    expect(onWriterChange).toHaveBeenCalledTimes(acceptedBeforeUnmount);
  });

  it("coalesces overlapping refresh hints and keeps the last successful state", async () => {
    renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());
    const initialRefreshes = mocks.fetchWriter.mock.calls.length;
    let resolveRefresh!: (value: PlanWriterState) => void;
    mocks.fetchWriter
      .mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }))
      .mockRejectedValueOnce(new Error("duplicate refresh failed"));

    act(() => {
      mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1");
      mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1");
    });
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalledTimes(initialRefreshes + 1));

    await act(async () => resolveRefresh(stoppedWriter()));
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalledTimes(initialRefreshes + 2));
    expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument();
  });

  it("refreshes writer state when a refresh hint arrives", async () => {
    renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());
    const initialRefreshes = mocks.fetchWriter.mock.calls.length;
    mocks.fetchWriter.mockResolvedValue(stoppedWriter());

    act(() => mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1"));

    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalledTimes(initialRefreshes + 1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Restart Scribe" })).toBeInTheDocument());
  });

  it("keeps the Scribe live while a generic refresh is in flight", async () => {
    const onTabStatusChange = vi.fn();
    renderPane({ onTabStatusChange });
    await waitFor(() => expect(onTabStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "running", label: "Live" }),
    ));

    let resolveRefresh!: (value: PlanWriterState) => void;
    mocks.fetchWriter.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));
    act(() => mocks.planWriterRefreshHintRef.current?.("repo-1", "plan-1"));
    await act(async () => {});

    expect(onTabStatusChange).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "saving" }),
    );
    expect(onTabStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "running", label: "Live" }),
    );

    act(() => resolveRefresh(writer("running")));
    await act(async () => {});
  });

  it("does not show a running Scribe as ready while its terminal is offline", async () => {
    const onTabStatusChange = vi.fn();
    const rendered = renderPane({ onTabStatusChange });
    await waitFor(() => expect(onTabStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "running", label: "Live" }),
    ));

    mocks.connected = false;
    rendered.rerenderPane(false);

    await waitFor(() => expect(onTabStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "starting",
        label: "Connecting",
        detail: expect.stringContaining("Hub connection is offline"),
      }),
    ));
    expect(mocks.terminalProps?.interactive).toBe(false);
  });

  it("surfaces terminal recovery faults instead of spinning as Connecting", async () => {
    const onTabStatusChange = vi.fn();
    renderPane({ onTabStatusChange });
    await waitFor(() => expect(mocks.terminalProps?.onRecoveryState).toEqual(expect.any(Function)));

    act(() => mocks.terminalProps?.onRecoveryState?.({ status: "fault", code: "fetch_failed" }));

    await waitFor(() => expect(onTabStatusChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: "error",
        label: "Error",
        detail: expect.stringContaining("Terminal recovery stopped (fetch failed)"),
      }),
    ));
    expect(mocks.terminalProps?.interactive).toBe(false);
  });

  it("keeps offline reviewer context visible and makes Start share it", () => {
    const item = contribution("contribution-1", "Check the migration rollback path", {
      sourceThreadId: "reviewer-thread-1",
      sourceMessageId: "message-1",
      sourcePlanVersion: 4,
    });
    const onViewContributionSource = vi.fn();
    const onAddReviewer = vi.fn();
    renderPane({
      initialWriter: writer("not_running"),
      contributions: [item],
      contributionPresentations: new Map([[item.id, {
        sourceLabel: "GPT 5.5 reviewer",
        sourceDetail: "Plan Review Plan Skill",
        canViewSource: true,
      }]]),
      onViewContributionSource,
      onAddReviewer,
    });

    expect(screen.getByTestId("scribe-context-tray")).toHaveTextContent("From reviewers");
    expect(screen.getByTestId("scribe-context-tray")).toHaveTextContent("GPT 5.5 reviewer");
    expect(screen.getByTestId("scribe-context-tray")).toHaveTextContent("Plan Review Plan Skill · Plan v4");
    expect(screen.getByTestId("scribe-context-tray")).toHaveTextContent("Waiting for Scribe");
    expect(screen.queryByRole("button", { name: /Start without/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Scribe and share 1 item" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Reviewer" }));
    expect(onViewContributionSource).toHaveBeenCalledWith(item.id);
    expect(onAddReviewer).toHaveBeenCalledOnce();
  });

  it("delivers every pending reviewer contribution when the Scribe starts", async () => {
    const firstItem = contribution("contribution-1", "Check the migration rollback path");
    const secondItem = contribution("contribution-2", "Document the fallback behavior");
    renderPane({
      initialWriter: writer("not_running"),
      contributions: [firstItem, secondItem],
      contributionPresentations: new Map([
        [firstItem.id, {
          sourceLabel: "GPT 5.5 reviewer",
          canViewSource: false,
        }],
        [secondItem.id, {
          sourceLabel: "Claude reviewer",
          canViewSource: false,
        }],
      ]),
    });
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Start Scribe and share 2 items" }));

    await waitFor(() => expect(mocks.startWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      { routeKey: "codex:gpt-5.5", effort: "xhigh" },
    ));
    await waitFor(() => expect(
      mocks.wsSend.mock.calls.some(([message]) => message.type === "terminal-input"),
    ).toBe(true));
    const sent = mocks.wsSend.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "terminal-input");
    expect(sent.data).toContain(
      "## Context shared with the Scribe\nSource: GPT 5.5 reviewer\n\nCheck the migration rollback path",
    );
    expect(sent.data).toContain(
      "## Context shared with the Scribe\nSource: Claude reviewer\n\nDocument the fallback behavior",
    );
    await waitFor(() => {
      expect(mocks.incorporate).toHaveBeenCalledWith(
        "http://localhost",
        "repo-1",
        "plan-1",
        firstItem.id,
      );
      expect(mocks.incorporate).toHaveBeenCalledWith(
        "http://localhost",
        "repo-1",
        "plan-1",
        secondItem.id,
      );
    });
  });

  it("starts a stopped Scribe and delivers a queued reviewer handoff", async () => {
    const item = contribution("contribution-1", "Address this reviewer feedback");
    const onHandoffSettled = vi.fn();
    renderPane({
      initialWriter: writer("not_running"),
      contributions: [item],
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      onHandoffSettled,
    });

    await waitFor(() => expect(mocks.startWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      { routeKey: "codex:gpt-5.5", effort: "xhigh" },
    ));
    await waitFor(() => expect(mocks.incorporate).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      item.id,
    ));
    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith("handoff-1", undefined));

    const inputs = mocks.wsSend.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toHaveLength(1);
  });

  it("uses stored Scribe settings when an automatic handoff arrives before settings load", async () => {
    const item = contribution("contribution-1", "Address this reviewer feedback");
    renderPane({
      initialWriter: writer("not_running"),
      contributions: [item],
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      settingsAvailable: false,
    });

    await waitFor(() => expect(mocks.startWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      {},
    ));
  });

  it("uses the replacement generation returned while ensuring a stale running Scribe", async () => {
    const item = contribution("contribution-1", "Address this reviewer feedback");
    const replacement = writer("running", { generation: 2, terminalId: "plan-writer-2" });
    const onWriterChange = vi.fn();
    mocks.startWriter.mockResolvedValue(replacement);
    renderPane({
      contributions: [item],
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      onWriterChange,
    });

    await waitFor(() => expect(onWriterChange).toHaveBeenCalledWith(replacement));
    await waitFor(() => expect(mocks.incorporate).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      item.id,
    ));
    const inputs = mocks.wsSend.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ sessionId: "plan-writer-2" });
  });

  it.each([
    { priorState: { status: "ready" } as const, label: "ready" },
    { priorState: { status: "fault", code: "fetch_failed" } as const, label: "faulted" },
  ])("waits for replacement terminal recovery when the prior terminal was $label", async ({ priorState }) => {
    const item = contribution("contribution-1", "Address this reviewer feedback");
    const replacement = writer("running", { generation: 2, terminalId: "plan-writer-2" });
    const onHandoffSettled = vi.fn();
    const onWriterChange = vi.fn();
    let resolveStart!: (value: PlanWriterState) => void;
    mocks.autoRecoveryReady = false;
    mocks.startWriter.mockImplementationOnce(() => new Promise((resolve) => {
      resolveStart = resolve;
    }));
    renderPane({
      contributions: [item],
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      onHandoffSettled,
      onWriterChange,
    });

    await waitFor(() => expect(mocks.startWriter).toHaveBeenCalledOnce());
    act(() => mocks.terminalProps?.onRecoveryState?.(priorState));
    await act(async () => { resolveStart(replacement); });
    await waitFor(() => expect(onWriterChange).toHaveBeenCalledWith(replacement));
    expect(onHandoffSettled).not.toHaveBeenCalled();
    expect(mocks.wsSend.mock.calls.some(([message]) => message.type === "terminal-input")).toBe(false);

    act(() => mocks.terminalProps?.onRecoveryState?.({ status: "ready" }));
    await waitFor(() => expect(mocks.incorporate).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      item.id,
    ));
    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith("handoff-1", undefined));
  });

  it("leaves a handoff pending without retrying when the Scribe cannot be ensured", async () => {
    const item = contribution("contribution-1", "Address this reviewer feedback");
    const onHandoffSettled = vi.fn();
    mocks.startWriter.mockRejectedValue(new Error("Runtime inspection failed"));
    renderPane({
      contributions: [item],
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      onHandoffSettled,
    });

    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith(
      "handoff-1",
      "Runtime inspection failed",
    ));
    await act(async () => undefined);
    expect(mocks.startWriter).toHaveBeenCalledOnce();
    expect(mocks.wsSend.mock.calls.some(([message]) => message.type === "terminal-input")).toBe(false);
    expect(mocks.incorporate).not.toHaveBeenCalled();
    expect(screen.getByTestId("scribe-context-tray")).toHaveTextContent("Address this reviewer feedback");
  });

  it("does not retry or incorporate a handoff rejected before terminal delivery", async () => {
    const item = contribution("contribution-1", "Address this reviewer feedback");
    const onHandoffSettled = vi.fn();
    mocks.wsSend.mockImplementation((message: any) => {
      if (message.type === "terminal-input") {
        queueMicrotask(() => mocks.terminalAckRef.current?.({
          type: "terminal-input-ack",
          sessionId: message.sessionId,
          clientId: message.clientId,
          inputSeq: message.inputSeq,
          ok: false,
          error: "No active terminal owner for session",
        }));
      }
      return true;
    });
    renderPane({
      contributions: [item],
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      onHandoffSettled,
    });

    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith(
      "handoff-1",
      "The Scribe stopped before receiving the message",
    ));
    await act(async () => undefined);
    expect(mocks.startWriter).toHaveBeenCalledOnce();
    expect(mocks.wsSend.mock.calls.filter(([message]) => message.type === "terminal-input")).toHaveLength(1);
    expect(mocks.incorporate).not.toHaveBeenCalled();
  });

  it("processes queued handoffs serially without resending the first prompt", async () => {
    const firstItem = contribution("contribution-1", "First reviewer handoff");
    const secondItem = contribution("contribution-2", "Second reviewer handoff");
    const onHandoffSettled = vi.fn();
    const options: Parameters<typeof renderPane>[0] = {
      contributions: [firstItem, secondItem],
      handoff: { id: "handoff-1", contributionIds: [firstItem.id] },
      queuedHandoffContributionIds: [firstItem.id, secondItem.id],
      onHandoffSettled,
    };
    const rendered = renderPane(options);

    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith("handoff-1", undefined));
    options.handoff = { id: "handoff-2", contributionIds: [secondItem.id] };
    rendered.rerenderPane(false);

    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith("handoff-2", undefined));
    const inputs = mocks.wsSend.mock.calls
      .map(([message]) => message)
      .filter((message) => message.type === "terminal-input");
    expect(inputs).toHaveLength(2);
    expect(inputs[0].data).toContain("First reviewer handoff");
    expect(inputs[0].data).not.toContain("Second reviewer handoff");
    expect(inputs[1].data).toContain("Second reviewer handoff");
    expect(inputs[1].data).not.toContain("First reviewer handoff");
    expect(mocks.startWriter).toHaveBeenCalledTimes(2);
  });

  it("pastes, waits for an ACK, and incorporates a queued one-shot handoff", async () => {
    mocks.wsSend.mockReturnValue(true);
    const item = contribution("contribution-1", "Address this reviewer feedback", {
      sourceThreadId: "reviewer-thread-1",
      sourceMessageId: "message-1",
      sourcePlanVersion: 3,
    });
    const onHandoffSettled = vi.fn();
    renderPane({
      contributions: [item],
      contributionPresentations: new Map([[item.id, {
        sourceLabel: "GPT 5.5 reviewer",
        sourceDetail: "Plan Review Plan Skill",
        canViewSource: true,
      }]]),
      handoff: { id: "handoff-1", contributionIds: [item.id] },
      onHandoffSettled,
    });

    await waitFor(() => expect(mocks.startWriter).toHaveBeenCalledOnce());
    await waitFor(() => expect(
      mocks.wsSend.mock.calls.some(([message]) => message.type === "terminal-input"),
    ).toBe(true));
    const sent = mocks.wsSend.mock.calls
      .map(([message]) => message)
      .find((message) => message.type === "terminal-input");
    if (!sent) throw new Error("Expected Scribe terminal input");
    expect(sent.data).toBe(
      "\u001b[200~## Context shared with the Scribe\n"
      + "Source: GPT 5.5 reviewer\n"
      + "Context: Plan Review Plan Skill\n"
      + "Plan version: 3\n\n"
      + "Address this reviewer feedback\u001b[201~\r",
    );
    expect(mocks.incorporate).not.toHaveBeenCalled();

    act(() => mocks.terminalAckRef.current?.({
      type: "terminal-input-ack",
      sessionId: sent.sessionId,
      clientId: sent.clientId,
      inputSeq: sent.inputSeq,
      ok: true,
    }));

    await waitFor(() => expect(mocks.incorporate).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      "contribution-1",
    ));
    await waitFor(() => expect(onHandoffSettled).toHaveBeenCalledWith("handoff-1", undefined));
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Insert/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Mark incorporated/i })).not.toBeInTheDocument();
  });
});
