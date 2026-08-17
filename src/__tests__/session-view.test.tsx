/**
 * @vitest-environment jsdom
 */
import React from "react";
import { renderToString } from "react-dom/server";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WsClientMessage, WsServerMessage } from "../../api/types";
import SessionView from "../SessionView";

type TerminalAckMessage =
  | Extract<WsServerMessage, { type: "terminal-input-ack" }>
  | Extract<WsServerMessage, { type: "terminal-control-ack" }>;

const mocks = vi.hoisted(() => ({
  terminalProps: null as null | {
    interactive?: boolean;
    onResize?: (cols: number, rows: number, request?: { claim?: boolean }) => void;
    onRecoveryState?: (state: { status: "ready" }) => void;
  },
  reviewProps: null as null | {
    harnessInputReady: boolean;
    onSendToHarness: (text: string, deliveryId?: string) => Promise<{ ok: boolean; error?: string }>;
  },
}));

vi.mock("../TerminalView", () => ({
  default: React.forwardRef(function MockTerminalView(props: {
    interactive?: boolean;
    onResize?: (cols: number, rows: number, request?: { claim?: boolean }) => void;
    onRecoveryState?: (state: { status: "ready" }) => void;
  }) {
    mocks.terminalProps = props;
    return React.createElement("div", null, "terminal");
  }),
}));

vi.mock("../PermissionBanner", () => ({
  default: () => null,
}));

vi.mock("../StatusBar", () => ({
  default: () => null,
}));

vi.mock("../VoiceAgent", () => ({
  default: () => null,
}));

vi.mock("../EnvReviewPanel", () => ({
  default: ({ harnessInputReady, onSendToHarness, onLayoutChange }: {
    harnessInputReady: boolean;
    onSendToHarness: (text: string, deliveryId?: string) => Promise<{ ok: boolean; error?: string }>;
    onLayoutChange?: () => void;
  }) => {
    mocks.reviewProps = { harnessInputReady, onSendToHarness };
    return React.createElement(
      "div",
      {
        "data-testid": "env-review-panel",
        "data-harness-input-ready": String(harnessInputReady),
        "data-has-layout-change": String(Boolean(onLayoutChange)),
      },
    );
  },
}));

vi.mock("@cloudflare/voice/react", () => ({
  useVoiceAgent: () => ({
    status: "idle",
    transcript: [],
    interimTranscript: "",
    audioLevel: 0,
    isMuted: false,
    connected: false,
    error: null,
    metrics: null,
    startCall: vi.fn(),
    endCall: vi.fn(),
    toggleMute: vi.fn(),
    sendJSON: vi.fn(),
    lastCustomMessage: null,
  }),
}));

function makeSession() {
  return {
    id: "session-1",
    tag: "demo-env",
    machine_id: null,
    metadata: "{}",
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 1,
    ended_at: null,
    created_at: "2026-04-10T00:00:00.000Z",
    updated_at: "2026-04-10T00:00:00.000Z",
  } as const;
}

describe("SessionView", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    mocks.terminalProps = null;
    mocks.reviewProps = null;
  });

  it("makes review handoff depend on transport readiness instead of terminal recovery", () => {
    const render = (terminalFastLane: boolean) => renderToString(
      <SessionView
        session={makeSession()}
        env={{ slug: "demo-env", repoId: "repo-1", status: "running" }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        terminalFastLane={terminalFastLane}
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(render(false)).toContain('data-harness-input-ready="false"');
    expect(render(true)).toContain('data-harness-input-ready="true"');
    expect(render(true)).toContain('data-has-layout-change="true"');
  });

  it("binds the visible terminal as a viewer as soon as the fast lane is ready", () => {
    const send = vi.fn(() => true);
    render(
      <SessionView
        session={makeSession()}
        env={{ slug: "demo-env", status: "running" }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{
          current: {
            close: () => undefined,
            reconnect: () => undefined,
            send,
          },
        }}
        connected
        terminalFastLane
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
      />,
    );

    expect(send).toHaveBeenCalledWith({
      type: "reconnect",
      sessionId: "session-1",
      lastSeq: 0,
      revive: false,
      replay: false,
    });
  });

  it("submits review feedback while terminal history is still recovering", async () => {
    const terminalAckRef: {
      current: null | ((message: TerminalAckMessage) => void);
    } = { current: null };
    const sentMessages: WsClientMessage[] = [];
    const send = vi.fn((message: unknown) => {
      sentMessages.push(message as WsClientMessage);
      return true;
    });

    render(
      <SessionView
        session={makeSession()}
        env={{ slug: "demo-env", repoId: "repo-1", status: "running" }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        onTerminalAck={terminalAckRef}
        wsSend={{
          current: {
            close: () => undefined,
            reconnect: () => undefined,
            send,
          },
        }}
        connected
        terminalFastLane
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
      />,
    );

    expect(mocks.terminalProps?.interactive).toBe(false);
    expect(mocks.reviewProps?.harnessInputReady).toBe(true);

    const resultPromise = mocks.reviewProps?.onSendToHarness(
      "review feedback",
      "feedback-1",
    );
    expect(resultPromise).toBeDefined();
    const input = sentMessages.find((message) => message.type === "terminal-input");
    expect(input).toMatchObject({
      type: "terminal-input",
      data: "\u001b[200~review feedback\u001b[201~\r",
      deliveryId: "feedback-1",
    });
    if (!input || input.type !== "terminal-input") {
      throw new Error("Expected review terminal input");
    }

    act(() => terminalAckRef.current?.({
      type: "terminal-input-ack",
      sessionId: input.sessionId,
      clientId: input.clientId,
      inputSeq: input.inputSeq,
      ok: true,
    }));
    await expect(resultPromise).resolves.toEqual({ ok: true });
  });

  it("renders the terminal as the session input surface", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "running",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).toContain("terminal");
    expect(html).not.toContain("<textarea");
  });

  it("becomes interactive only after recovery and fast-lane capability are both ready", () => {
    const view = (terminalFastLane: boolean) => (
      <SessionView
        session={makeSession()}
        env={{ slug: "demo-env", status: "running" }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        terminalFastLane={terminalFastLane}
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
      />
    );
    const rendered = render(view(false));

    expect(mocks.terminalProps?.interactive).toBe(false);
    act(() => mocks.terminalProps?.onRecoveryState?.({ status: "ready" }));
    expect(mocks.terminalProps?.interactive).toBe(false);

    rendered.rerender(view(true));
    expect(mocks.terminalProps?.interactive).toBe(true);
  });

  it("disables review handoff as soon as the environment starts stopping", () => {
    const view = (status: "running" | "stopping") => (
      <SessionView
        session={makeSession()}
        env={{ slug: "demo-env", repoId: "repo-1", status }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        terminalFastLane
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
      />
    );
    const rendered = render(view("running"));

    act(() => mocks.terminalProps?.onRecoveryState?.({ status: "ready" }));
    expect(screen.getByTestId("env-review-panel"))
      .toHaveAttribute("data-harness-input-ready", "true");

    rendered.rerender(view("stopping"));
    expect(screen.getByTestId("env-review-panel"))
      .toHaveAttribute("data-harness-input-ready", "false");
  });

  it("shows the global CLI install command in the reminder", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "running",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).toContain("npm install -g @paperwing-dev/tiller");
    expect(html).not.toContain("npm install @paperwing.dev/tiller");
  });

  it("does not render a duplicate Stop control for interactive env-backed sessions", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "running",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).not.toContain(">Stop<");
  });

  it("does not render a duplicate Stop control while the env metadata is catching up from starting", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "starting",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).not.toContain(">Stop<");
  });

  it("does not render a duplicate Stop control when the session activity bit lags behind a running env", () => {
    const html = renderToString(
      <SessionView
        session={{
          ...makeSession(),
          active: 0,
        }}
        env={{
          slug: "demo-env",
          status: "running",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).not.toContain(">Stop<");
  });

  it("hides the Stop control once the env is saving changes", () => {
    const html = renderToString(
      <SessionView
        session={makeSession()}
        env={{
          slug: "demo-env",
          status: "saving",
        }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        wsSend={{ current: null }}
        connected
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
        onRecoverEnv={() => undefined}
      />,
    );

    expect(html).not.toContain(">Stop<");
  });

  it("clears or dismisses a transient resize warning", () => {
    vi.useFakeTimers();
    const terminalAckRef: {
      current: null | ((message: TerminalAckMessage) => void);
    } = { current: null };
    const sentMessages: WsClientMessage[] = [];
    const send = vi.fn((message: unknown) => {
      sentMessages.push(message as WsClientMessage);
      return true;
    });

    render(
      <SessionView
        session={makeSession()}
        env={{ slug: "demo-env", status: "running" }}
        hubUrl="https://example.com"
        onWsMessage={{ current: null }}
        onTerminalAck={terminalAckRef}
        wsSend={{
          current: {
            close: () => undefined,
            reconnect: () => undefined,
            send,
          },
        }}
        connected
        terminalFastLane
        updateLastSeq={() => undefined}
        permissions={[]}
        onPermissionResolved={() => undefined}
      />,
    );

    act(() => mocks.terminalProps?.onResize?.(100, 40, { claim: true }));
    const control = sentMessages
      .find((message) => message.type === "terminal-control");
    expect(control).toMatchObject({ action: "resize", cols: 100, rows: 40, claim: true });
    if (!control || control.type !== "terminal-control") {
      throw new Error("Expected a terminal resize control");
    }

    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Terminal resize acknowledgement is delayed; terminal input may still work.",
    );
    expect(screen.getByRole("status")).toHaveClass("text-kumo-warning");

    act(() => terminalAckRef.current?.({
      type: "terminal-control-ack",
      sessionId: control.sessionId,
      clientId: control.clientId,
      controlSeq: control.controlSeq,
      ok: true,
    }));
    expect(screen.queryByText("Terminal resize acknowledgement is delayed", { exact: false }))
      .not.toBeInTheDocument();

    act(() => mocks.terminalProps?.onResize?.(101, 40, { claim: false }));
    const resizeMessages = sentMessages.filter((message) => message.type === "terminal-control");
    expect(resizeMessages[resizeMessages.length - 1])
      .toMatchObject({ action: "resize", cols: 101, rows: 40, claim: false });
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Terminal resize acknowledgement is delayed",
    );

    act(() => vi.advanceTimersByTime(4000));
    expect(screen.queryByText("Terminal resize acknowledgement is delayed", { exact: false }))
      .not.toBeInTheDocument();
  });
});
