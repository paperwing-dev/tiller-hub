/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  fit: vi.fn(),
  scrollToBottom: vi.fn(),
  disposeTerminal: vi.fn(),
  disposeRecovery: vi.fn(),
  recoveryOptions: [] as any[],
  recoveryControllers: [] as any[],
  terminal: null as any,
  nextSize: null as { cols: number; rows: number } | null,
  observerCallback: null as ResizeObserverCallback | null,
  frameCallbacks: new Map<number, FrameRequestCallback>(),
  nextFrameId: 1,
  cancelFrame: vi.fn(),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    cols: number;
    rows: number;
    options: Record<string, unknown>;
    buffer = { active: { viewportY: 10, baseY: 10 } };

    constructor(options: { cols: number; rows: number }) {
      this.cols = options.cols;
      this.rows = options.rows;
      this.options = { ...options };
      mocks.terminal = this;
    }

    loadAddon() {}

    open(container: HTMLElement) {
      mocks.order.push("open");
      const viewport = document.createElement("div");
      viewport.className = "xterm-viewport";
      container.appendChild(viewport);
    }

    onData() {
      return { dispose: vi.fn() };
    }

    focus() {}
    reset() {}
    clear() {}

    write(_data: string, callback?: () => void) {
      callback?.();
    }

    scrollToBottom() {
      mocks.scrollToBottom();
      this.buffer.active.viewportY = this.buffer.active.baseY;
    }

    dispose() {
      mocks.disposeTerminal();
    }
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit() {
      mocks.order.push("fit");
      mocks.fit();
      if (mocks.nextSize && mocks.terminal) {
        mocks.terminal.cols = mocks.nextSize.cols;
        mocks.terminal.rows = mocks.nextSize.rows;
        mocks.nextSize = null;
      }
    }
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {},
}));

vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class MockSerializeAddon {
    serialize() {
      return "";
    }
  },
}));

vi.mock("../api", () => ({
  fetchMessages: vi.fn(),
}));

vi.mock("../theme", () => ({
  useResolvedTheme: () => "light",
}));

vi.mock("../LoadingIndicator", () => ({
  default: () => null,
}));

vi.mock("../terminal-recovery", () => ({
  TerminalRecoveryController: class MockTerminalRecoveryController {
    recoveryState: { status: "ready" | "fault"; code?: string } = { status: "ready" };
    recoverGap = vi.fn();
    retry = vi.fn();

    constructor(options: unknown) {
      mocks.order.push("recovery-controller");
      mocks.recoveryOptions.push(options);
      mocks.recoveryControllers.push(this);
    }

    startCold() {
      mocks.order.push("recover");
      return Promise.resolve();
    }

    startCacheRestore() {
      mocks.order.push("cache-recover");
    }
    acceptLive() {}
    dispose() {
      mocks.disposeRecovery();
    }
  },
}));

import TerminalView, { type TerminalViewHandle } from "../TerminalView";

function makeSession() {
  return {
    id: "terminal-resize-session",
    tag: "terminal",
    machine_id: null,
    metadata: "{}",
    agent_state: "{}",
    todos: "[]",
    allowed_tools: "[]",
    active: 1,
    metadata_version: 1,
    agent_state_version: 1,
    todos_version: 1,
    seq: 0,
    ended_at: null,
    created_at: "2026-07-14T00:00:00.000Z",
    updated_at: "2026-07-14T00:00:00.000Z",
  } as const;
}

function notifyContainerResize(): void {
  act(() => {
    mocks.observerCallback?.([], {} as ResizeObserver);
  });
}

function flushFrame(): void {
  const entry = mocks.frameCallbacks.entries().next().value as
    | [number, FrameRequestCallback]
    | undefined;
  if (!entry) throw new Error("Expected a scheduled animation frame");
  mocks.frameCallbacks.delete(entry[0]);
  act(() => entry[1](performance.now()));
}

describe("TerminalView resizing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.terminal = null;
    mocks.recoveryOptions.length = 0;
    mocks.recoveryControllers.length = 0;
    mocks.nextSize = null;
    mocks.observerCallback = null;
    mocks.frameCallbacks.clear();
    mocks.nextFrameId = 1;

    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        mocks.observerCallback = callback;
      }

      observe() {}
      disconnect() {}
      unobserve() {}
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
      const id = mocks.nextFrameId++;
      mocks.frameCallbacks.set(id, callback);
      return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => {
      mocks.cancelFrame(id);
      mocks.frameCallbacks.delete(id);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps initial fit ordering and coalesces window and container notifications", () => {
    const onResize = vi.fn(() => mocks.order.push("report"));
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        onResize={onResize}
      />,
    );

    expect(mocks.order).toEqual([
      "open",
      "fit",
      "report",
      "recovery-controller",
      "recover",
    ]);
    expect(mocks.terminal.options.fontSize).toBe(15);
    expect(onResize).toHaveBeenCalledWith(120, 40);

    notifyContainerResize();
    notifyContainerResize();
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
    });
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    expect(mocks.fit).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(mocks.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledTimes(1);

    mocks.nextSize = { cols: 100, rows: 30 };
    notifyContainerResize();
    flushFrame();
    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(100, 30);
  });

  it("refits through its handle after a sibling changes the available layout", () => {
    const ref = React.createRef<TerminalViewHandle>();
    render(
      <TerminalView
        ref={ref}
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );

    expect(mocks.fit).toHaveBeenCalledTimes(1);
    act(() => ref.current?.refit());
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(mocks.fit).toHaveBeenCalledTimes(2);
  });

  it("fits and reports dimensions using a supplied font size", () => {
    const onResize = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        fontSize={13}
        onResize={onResize}
      />,
    );

    expect(mocks.terminal.options.fontSize).toBe(13);
    expect(mocks.fit).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(120, 40);

    mocks.nextSize = { cols: 132, rows: 48 };
    notifyContainerResize();
    flushFrame();

    expect(mocks.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(132, 48);
  });

  it("restores the bottom only when the terminal was following output", () => {
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );

    notifyContainerResize();
    flushFrame();
    expect(mocks.scrollToBottom).toHaveBeenCalledTimes(1);

    mocks.terminal.buffer.active.viewportY = 4;
    mocks.terminal.buffer.active.baseY = 10;
    notifyContainerResize();
    flushFrame();
    expect(mocks.scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("cancels a scheduled fit when unmounted", () => {
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );
    notifyContainerResize();
    const scheduledId = mocks.frameCallbacks.keys().next().value as number;

    rendered.unmount();

    expect(mocks.cancelFrame).toHaveBeenCalledWith(scheduledId);
    expect(mocks.frameCallbacks.has(scheduledId)).toBe(false);
    expect(mocks.disposeRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.disposeTerminal).toHaveBeenCalledTimes(1);
  });

  it("cold-mounts recent output again after each successful fallback", async () => {
    const onRecoveryState = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        onRecoveryState={onRecoveryState}
      />,
    );

    const first = mocks.recoveryOptions[0];
    act(() => {
      first.onSettled(12);
      first.onStateChange({ status: "fault", code: "overflow" });
    });

    await waitFor(() => expect(mocks.recoveryOptions).toHaveLength(2));
    expect(mocks.order.filter((entry) => entry === "recover")).toHaveLength(2);
    expect(mocks.order).not.toContain("cache-recover");
    expect(mocks.disposeRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.disposeTerminal).toHaveBeenCalledTimes(1);
    expect(onRecoveryState).toHaveBeenCalledWith({ status: "recovering" });

    const fallback = mocks.recoveryOptions[1];
    act(() => fallback.onStateChange({ status: "ready" }));
    expect(screen.getByText("Showing recent output; older missed output was skipped.")).toBeTruthy();

    act(() => fallback.onStateChange({ status: "fault", code: "deadline" }));
    await waitFor(() => expect(mocks.recoveryOptions).toHaveLength(3));
    expect(mocks.order.filter((entry) => entry === "recover")).toHaveLength(3);
    expect(screen.queryByText("Terminal recovery stopped (deadline).")).toBeNull();
  });

  it("recovers gaps while healthy and retries faults on visibility resume", () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );
    const controller = mocks.recoveryControllers[0];

    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(controller.recoverGap).toHaveBeenCalledOnce();
    expect(controller.retry).not.toHaveBeenCalled();

    controller.recoveryState = { status: "fault", code: "fetch_failed" };
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(controller.retry).toHaveBeenCalledOnce();

    controller.recoveryState = { status: "fault", code: "collision" };
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(controller.retry).toHaveBeenCalledOnce();
    hidden.mockRestore();
  });

  it("keeps integrity faults on the existing blocking path", () => {
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );

    act(() => mocks.recoveryOptions[0].onStateChange({ status: "fault", code: "collision" }));

    expect(mocks.recoveryOptions).toHaveLength(1);
    expect(screen.getByText("Terminal recovery stopped (collision).")).toBeTruthy();
  });
});
