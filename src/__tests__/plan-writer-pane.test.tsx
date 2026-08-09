/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentRoute,
  PlanContribution,
  PlanWriterState,
} from "../../api/coordination/types";

const mocks = vi.hoisted(() => {
  const terminalAckRef = { current: null as null | ((message: any) => void) };
  const planWriterHintRef = { current: null as null | ((message: any) => void) };
  return {
    terminalAckRef,
    planWriterHintRef,
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
      onInput?: (data: string) => void;
      onRecoveryState?: (state: { status: "ready" }) => void;
    },
  };
});

vi.mock("../DashboardDataProvider", () => ({
  useDashboardData: () => ({
    hubUrl: "http://localhost",
    connected: true,
    terminalFastLane: true,
    liveMessageRef: { current: null },
    terminalAckRef: mocks.terminalAckRef,
    planWriterHintRef: mocks.planWriterHintRef,
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
      onInput?: (data: string) => void;
      onRecoveryState?: (state: { status: "ready" }) => void;
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
      props.onRecoveryState?.({ status: "ready" });
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
  };
}

function renderPane(options: {
  initialWriter?: PlanWriterState;
  contributions?: PlanContribution[];
  contributionPresentations?: ReadonlyMap<string, PlanContributionPresentation>;
  handoff?: { id: string; contributionIds: string[] } | null;
  onHandoffSettled?: (handoffId: string, error?: string) => void;
  onTabStatusChange?: (status: any) => void;
  onArtifactChanged?: () => void;
  onViewContributionSource?: (contributionId: string) => void;
  onAddReviewer?: () => void;
  onOpenSettings?: () => void;
  settingsAvailable?: boolean;
} = {}) {
  const initialWriter = options.initialWriter ?? writer("running");
  mocks.fetchWriter.mockResolvedValue(initialWriter);
  return render(
    <PlanWriterPane
      repoId="repo-1"
      planArtifactId="plan-1"
      initialWriter={initialWriter}
      routes={routes}
      selection={{ routeKey: "codex:gpt-5.5", effort: "xhigh" }}
      contributions={options.contributions ?? []}
      contributionPresentations={options.contributionPresentations}
      handoff={options.handoff}
      onWriterChange={vi.fn()}
      onTabStatusChange={options.onTabStatusChange ?? vi.fn()}
      onArtifactChanged={options.onArtifactChanged ?? vi.fn()}
      onContributionsChanged={vi.fn()}
      onHandoffSettled={options.onHandoffSettled ?? vi.fn<(handoffId: string, error?: string) => void>()}
      onViewContributionSource={options.onViewContributionSource}
      onAddReviewer={options.onAddReviewer}
      onOpenSettings={options.onOpenSettings ?? vi.fn()}
      settingsAvailable={options.settingsAvailable}
    />,
  );
}

describe("PlanWriterPane", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.terminalAckRef.current = null;
    mocks.planWriterHintRef.current = null;
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

  it("keeps Start Scribe for a stopped generation without visible lifecycle text", () => {
    renderPane({ initialWriter: { ...stoppedWriter(), stopReason: "idle" } });

    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
    expect(screen.queryByText("Writer stopped after inactivity")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
  });

  it("uses the compact terminal and control row as the only live writer input", async () => {
    renderPane({
      initialWriter: writer("running", {
        codexAuthMode: "subscription",
        synchronization: { state: "saving" },
      }),
    });

    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    const terminal = screen.getByTestId("terminal");
    expect(terminal).toHaveAttribute("data-font-size", "12");
    expect(terminal.parentElement).toHaveClass("min-h-0", "flex-1");
    expect(mocks.terminalProps?.onInput).toEqual(expect.any(Function));
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

  it("renders an icon-only danger stop control with its hover and focus tooltip", async () => {
    const user = userEvent.setup();
    renderPane();
    const stopControl = screen.getByRole("button", { name: "Stop Scribe" });
    const tooltip = "Ends this Scribe generation and its provider conversation. The saved plan and terminal history remain; Start Scribe creates a new conversation.";

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
    await waitFor(() => expect(screen.getByRole("button", { name: "Start Scribe" })).toBeInTheDocument());
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

  it("keeps an authoritatively running writer live after a missing-owner ACK", async () => {
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
    await waitFor(() => expect(mocks.terminalProps?.interactive).toBe(true));
    const recoverCalls = mocks.terminalRecover.mock.calls.length;

    act(() => mocks.terminalProps?.onInput?.("Update the plan"));

    await waitFor(() => expect(mocks.terminalRecover.mock.calls.length).toBeGreaterThan(recoverCalls));
    expect(screen.getByRole("button", { name: "Stop Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start Scribe" })).not.toBeInTheDocument();
    expect(screen.queryByText("No active terminal owner for session")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByRole("button", { name: "Start Scribe" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
  });

  it("never stops a running writer during refresh or unmount", async () => {
    const rendered = renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());

    mocks.planWriterHintRef.current?.({
      type: "writer",
      repoId: "repo-1",
      planArtifactId: "plan-1",
    });
    await waitFor(() => expect(mocks.fetchWriter.mock.calls.length).toBeGreaterThan(1));
    rendered.unmount();

    expect(mocks.stopWriter).not.toHaveBeenCalled();
  });

  it("ignores a refresh that resolves after a newer stop result", async () => {
    let resolveRefresh!: (value: PlanWriterState) => void;
    renderPane();
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());
    mocks.fetchWriter.mockReturnValueOnce(new Promise((resolve) => { resolveRefresh = resolve; }));

    act(() => mocks.planWriterHintRef.current?.({
      type: "state",
      repoId: "repo-1",
      planArtifactId: "plan-1",
    }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Scribe" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Start Scribe" })).toBeInTheDocument());

    act(() => resolveRefresh(writer("running")));
    await act(async () => {});

    expect(screen.getByRole("button", { name: "Start Scribe" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop Scribe" })).not.toBeInTheDocument();
  });

  it("does not lose an artifact notification when its writer refresh becomes stale", async () => {
    let resolveArtifactRefresh!: (value: PlanWriterState) => void;
    const onArtifactChanged = vi.fn();
    renderPane({ onArtifactChanged });
    await waitFor(() => expect(onArtifactChanged).toHaveBeenCalled());
    const initialNotifications = onArtifactChanged.mock.calls.length;
    mocks.fetchWriter.mockReturnValueOnce(new Promise((resolve) => { resolveArtifactRefresh = resolve; }));

    act(() => mocks.planWriterHintRef.current?.({
      type: "artifact",
      repoId: "repo-1",
      planArtifactId: "plan-1",
    }));
    act(() => mocks.planWriterHintRef.current?.({
      type: "state",
      repoId: "repo-1",
      planArtifactId: "plan-1",
    }));

    act(() => resolveArtifactRefresh(writer("running")));
    await waitFor(() => expect(onArtifactChanged).toHaveBeenCalledTimes(initialNotifications + 1));
  });

  it("keeps offline reviewer context visible with explicit Scribe start choices", () => {
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
    expect(screen.getByRole("button", { name: "Start without shared items" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Scribe with 1 shared item" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "View conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Reviewer" }));
    expect(onViewContributionSource).toHaveBeenCalledWith(item.id);
    expect(onAddReviewer).toHaveBeenCalledOnce();
  });

  it("delivers durable reviewer context when the Scribe starts with shared items", async () => {
    const item = contribution("contribution-1", "Check the migration rollback path");
    renderPane({
      initialWriter: writer("not_running"),
      contributions: [item],
      contributionPresentations: new Map([[item.id, {
        sourceLabel: "GPT 5.5 reviewer",
        canViewSource: false,
      }]]),
    });
    await waitFor(() => expect(mocks.fetchWriter).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Start Scribe with 1 shared item" }));

    await waitFor(() => expect(mocks.startWriter).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      { provider: "codex", model: "gpt-5.5", effort: "xhigh" },
    ));
    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalled());
    expect(mocks.wsSend.mock.calls[0][0].data).toContain(
      "## Context shared with the Scribe\nSource: GPT 5.5 reviewer\n\nCheck the migration rollback path",
    );
    await waitFor(() => expect(mocks.incorporate).toHaveBeenCalledWith(
      "http://localhost",
      "repo-1",
      "plan-1",
      item.id,
    ));
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

    await waitFor(() => expect(mocks.wsSend).toHaveBeenCalled());
    const sent = mocks.wsSend.mock.calls[0][0];
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
