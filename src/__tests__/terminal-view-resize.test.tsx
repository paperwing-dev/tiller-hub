/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DurableTerminalMessage } from "../terminal-recovery";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  fit: vi.fn(),
  scrollToBottom: vi.fn(),
  disposeTerminal: vi.fn(),
  disposeRecovery: vi.fn(),
  writes: [] as string[],
  serialized: "",
  serialize: vi.fn(),
  recoveryOptions: [] as any[],
  recoveryControllers: [] as any[],
  terminal: null as any,
  keyEventHandler: null as ((event: KeyboardEvent) => boolean) | null,
  inputs: [] as Array<{ data: string; wasUserInput: boolean | undefined }>,
  nextSize: null as { cols: number; rows: number } | null,
  observerCallback: null as ResizeObserverCallback | null,
  frameCallbacks: new Map<number, FrameRequestCallback>(),
  nextFrameId: 1,
  cancelFrame: vi.fn(),
  dataHandler: null as null | ((data: string) => void),
  fetchMessages: vi.fn(),
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

    onData(handler: (data: string) => void) {
      mocks.dataHandler = handler;
      return { dispose: vi.fn() };
    }

    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
      mocks.keyEventHandler = handler;
    }

    input(data: string, wasUserInput?: boolean) {
      mocks.inputs.push({ data, wasUserInput });
      mocks.dataHandler?.(data);
    }

    focus() {}
    reset() {}
    clear() {}

    write(data: string, callback?: () => void) {
      mocks.writes.push(data);
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
      mocks.serialize();
      return mocks.serialized;
    }
  },
}));

vi.mock("../api", () => ({
  fetchMessages: mocks.fetchMessages,
}));

vi.mock("../theme", () => ({
  useResolvedTheme: () => "light",
}));

vi.mock("../LoadingIndicator", () => ({
  default: ({ label }: { label?: string }) => <div role="status" aria-label={label} />,
}));

vi.mock("../terminal-recovery", () => ({
  TerminalRecoveryController: class MockTerminalRecoveryController {
    recoveryState: { status: "ready" | "fault"; code?: string } = { status: "ready" };
    lastSeq = 0;
    isSettled = true;
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
    window.localStorage.clear();
    mocks.order.length = 0;
    mocks.writes.length = 0;
    mocks.serialized = "";
    mocks.serialize.mockReset();
    mocks.terminal = null;
    mocks.recoveryOptions.length = 0;
    mocks.recoveryControllers.length = 0;
    mocks.keyEventHandler = null;
    mocks.inputs.length = 0;
    mocks.nextSize = null;
    mocks.observerCallback = null;
    mocks.frameCallbacks.clear();
    mocks.nextFrameId = 1;
    mocks.dataHandler = null;
    mocks.fetchMessages.mockResolvedValue([]);
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

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
    vi.restoreAllMocks();
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
    expect(mocks.terminal.options.fontSize).toBe(12);
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: false });

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
    expect(onResize).toHaveBeenLastCalledWith(100, 30, { claim: false });
  });

  it("reveals the fetched canonical screen while newer live output keeps recovering", async () => {
    mocks.fetchMessages.mockResolvedValue([{
      id: "message-10",
      session_id: "session-1",
      content: { type: "terminal-output", data: "canonical screen" },
      seq: 10,
      local_id: null,
      created_at: "2026-08-15T00:00:00.000Z",
    }]);
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );
    expect(screen.getByRole("status", { name: "Loading terminal history" })).toBeTruthy();

    const options = mocks.recoveryOptions[0];
    let page: DurableTerminalMessage[] = [];
    await act(async () => {
      page = await options.fetchPage({
        limit: 200,
        maxBytes: 1024,
        signal: new AbortController().signal,
        onBytes: vi.fn(),
      });
    });
    expect(screen.getByRole("status", { name: "Loading terminal history" })).toBeTruthy();

    act(() => {
      options.write(page[0], vi.fn());
      options.onSequenceComplete(10);
    });
    expect(screen.queryByRole("status", { name: "Loading terminal history" })).toBeNull();

    act(() => options.onStateChange({ status: "recovering" }));
    expect(screen.queryByRole("status", { name: "Loading terminal history" })).toBeNull();
  });

  it("intercepts a custom clipboard paste before xterm can emit it again", () => {
    const onInput = vi.fn();
    const onPaste = vi.fn();
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        onInput={onInput}
        onPaste={onPaste}
      />,
    );
    const terminalTarget = rendered.container.querySelector(".xterm-viewport");
    expect(terminalTarget).not.toBeNull();
    const plan = `# Plan\n${"- A large step\n".repeat(1_000)}`;
    terminalTarget!.addEventListener("paste", () => mocks.dataHandler?.(plan));

    expect(fireEvent.paste(terminalTarget!, {
      clipboardData: { getData: (type: string) => type === "text/plain" ? plan : "" },
    })).toBe(false);

    expect(onPaste).toHaveBeenCalledOnce();
    expect(onPaste).toHaveBeenCalledWith(plan);
    expect(onInput).not.toHaveBeenCalled();
  });

  it("leaves paste handling unchanged when no custom handler is supplied", () => {
    const onInput = vi.fn();
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        onInput={onInput}
      />,
    );
    const terminalTarget = rendered.container.querySelector(".xterm-viewport");
    expect(terminalTarget).not.toBeNull();
    terminalTarget!.addEventListener("paste", () => mocks.dataHandler?.("ordinary paste"));

    expect(fireEvent.paste(terminalTarget!, {
      clipboardData: { getData: () => "ordinary paste" },
    })).toBe(true);

    expect(onInput).toHaveBeenCalledOnce();
    expect(onInput).toHaveBeenCalledWith("ordinary paste");
  });

  it("defers fitting while hidden and refits when shown", () => {
    const onResize = vi.fn();
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        visible={false}
        onResize={onResize}
      />,
    );

    expect(mocks.fit).not.toHaveBeenCalled();
    expect(onResize).not.toHaveBeenCalled();
    notifyContainerResize();
    expect(requestAnimationFrame).not.toHaveBeenCalled();

    rendered.rerender(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        visible
        onResize={onResize}
      />,
    );
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    flushFrame();
    expect(mocks.fit).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: false });
  });

  it("claims control when an interactive terminal becomes visible again", () => {
    const onResize = vi.fn();
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        visible={false}
        onResize={onResize}
      />,
    );

    rendered.rerender(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        visible
        onResize={onResize}
      />,
    );

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    flushFrame();
    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: true });
  });

  it("refits and claims on window focus in case the viewport changed while away", () => {
    const onResize = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        onResize={onResize}
      />,
    );
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: true });
    onResize.mockClear();

    act(() => window.dispatchEvent(new Event("focus")));

    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    flushFrame();
    expect(mocks.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenCalledOnce();
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: true });
  });

  it("refits a visible read-only terminal on window focus without claiming control", () => {
    const onResize = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        onResize={onResize}
      />,
    );
    onResize.mockClear();

    act(() => window.dispatchEvent(new Event("focus")));
    flushFrame();

    expect(mocks.fit).toHaveBeenCalledTimes(2);
    expect(onResize).not.toHaveBeenCalled();
  });

  it("keeps terminal insets off the canvas measured by FitAddon", () => {
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );

    const canvas = rendered.container.querySelector(".tiller-terminal-canvas");
    expect(canvas).toHaveClass("tiller-terminal-canvas--default");
    expect(canvas).not.toHaveClass("px-2", "py-1");

    rendered.rerender(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        surface="implementation"
      />,
    );
    expect(canvas).toHaveClass("tiller-terminal-canvas--implementation");
    expect(canvas).not.toHaveClass("px-2", "py-1");
  });

  it("claims when the terminal is clicked without requiring a window-focus edge", () => {
    const onResize = vi.fn();
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        onResize={onResize}
      />,
    );
    onResize.mockClear();
    const terminalTarget = rendered.container.querySelector(".xterm-viewport");
    expect(terminalTarget).not.toBeNull();

    fireEvent.pointerDown(terminalTarget!);
    flushFrame();

    expect(mocks.fit).toHaveBeenCalledTimes(1);
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: true });
  });

  it("drops a queued claim if the window loses focus before the frame runs", () => {
    const onResize = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        onResize={onResize}
      />,
    );
    onResize.mockClear();

    act(() => window.dispatchEvent(new Event("focus")));
    vi.mocked(document.hasFocus).mockReturnValue(false);
    flushFrame();

    expect(onResize).not.toHaveBeenCalled();
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
    expect(onResize).toHaveBeenCalledWith(120, 40, { claim: false });

    mocks.nextSize = { cols: 132, rows: 48 };
    notifyContainerResize();
    flushFrame();

    expect(mocks.fit).toHaveBeenCalledTimes(2);
    expect(onResize).toHaveBeenLastCalledWith(132, 48, { claim: false });
  });

  it("resizes with command or control shortcuts and persists the shared preference", () => {
    const rendered = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );
    const terminalTarget = rendered.container.querySelector(".xterm-viewport");
    expect(terminalTarget).not.toBeNull();

    expect(fireEvent.keyDown(terminalTarget!, { key: "=", metaKey: true })).toBe(false);
    expect(mocks.terminal.options.fontSize).toBe(13);
    expect(window.localStorage.getItem("tiller:terminal-font-size")).toBe("13");

    rendered.unmount();
    const remounted = render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
      />,
    );
    const remountedTarget = remounted.container.querySelector(".xterm-viewport");
    expect(mocks.terminal.options.fontSize).toBe(13);

    fireEvent.keyDown(remountedTarget!, { key: "-", ctrlKey: true });
    expect(mocks.terminal.options.fontSize).toBe(12);
    fireEvent.keyDown(remountedTarget!, { key: "+" });
    expect(mocks.terminal.options.fontSize).toBe(12);
    fireEvent.keyDown(remountedTarget!, { key: "+", ctrlKey: true });
    expect(mocks.terminal.options.fontSize).toBe(13);
    fireEvent.keyDown(remountedTarget!, { key: "0", ctrlKey: true });
    expect(mocks.terminal.options.fontSize).toBe(12);
    expect(window.localStorage.getItem("tiller:terminal-font-size")).toBe("12");
  });

  it("emits one Ctrl+U and suppresses xterm Backspace for interactive Meta+Backspace", () => {
    const onInput = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
        onInput={onInput}
      />,
    );
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    const allowXtermDefault = mocks.keyEventHandler?.(event);
    if (allowXtermDefault) mocks.dataHandler?.("\x7f");

    expect(allowXtermDefault).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(mocks.inputs).toEqual([{ data: "\x15", wasUserInput: true }]);
    expect(onInput).toHaveBeenCalledOnce();
    expect(onInput).toHaveBeenCalledWith("\x15");
    expect(onInput).not.toHaveBeenCalledWith("\x7f");
  });

  it("keeps the translated input behind the interactive guard", () => {
    const onInput = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive={false}
        onInput={onInput}
      />,
    );
    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      metaKey: true,
      cancelable: true,
    });

    expect(mocks.keyEventHandler?.(event)).toBe(false);
    expect(mocks.inputs).toEqual([{ data: "\x15", wasUserInput: true }]);
    expect(onInput).not.toHaveBeenCalled();
  });

  it.each([
    ["ordinary Backspace", { key: "Backspace" }],
    ["Option+Backspace", { key: "Backspace", altKey: true }],
    ["Control+Backspace", { key: "Backspace", ctrlKey: true }],
    ["an unrelated Command shortcut", { key: "c", metaKey: true }],
  ])("leaves %s to xterm", (_label, init) => {
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        interactive
      />,
    );
    const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
    const preventDefault = vi.spyOn(event, "preventDefault");
    const stopPropagation = vi.spyOn(event, "stopPropagation");

    expect(mocks.keyEventHandler?.(event)).toBe(true);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(stopPropagation).not.toHaveBeenCalled();
    expect(mocks.inputs).toEqual([]);
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

  it("keeps the canonical checkpoint baseline until recent output is requested", async () => {
    const onRecoveryState = vi.fn();
    const session = { ...makeSession(), id: "overflow-stable-session" };
    render(
      <TerminalView
        session={session}
        hubUrl="https://hub.test"
        onRecoveryState={onRecoveryState}
      />,
    );

    const options = mocks.recoveryOptions[0];
    const controller = mocks.recoveryControllers[0];
    mocks.serialized = "stable terminal screen";
    act(() => {
      controller.lastSeq = 10;
      options.onSettled(10);
    });
    await waitFor(() => expect(mocks.serialize).toHaveBeenCalledTimes(1));
    act(() => {
      controller.recoveryState = { status: "fault", code: "overflow" };
      options.onStateChange({ status: "fault", code: "overflow" });
    });

    expect(mocks.recoveryOptions).toHaveLength(1);
    expect(options.getStableSequence()).toBe(10);
    expect(screen.getByText("Terminal history is too large to restore safely.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show recent output" })).toBeTruthy();
    expect(onRecoveryState).toHaveBeenCalledWith({ status: "fault", code: "overflow" });

    act(() => options.restoreStableScreen(() => {}));
    expect(mocks.writes).toEqual(["stable terminal screen"]);
  });

  it("restarts an overflowed terminal from recent output without reloading the page", async () => {
    const session = { ...makeSession(), id: "overflow-recent-session" };
    render(
      <TerminalView
        session={session}
        hubUrl="https://hub.test"
      />,
    );

    const options = mocks.recoveryOptions[0];
    const controller = mocks.recoveryControllers[0];
    mocks.serialized = "stable terminal screen";
    act(() => {
      controller.lastSeq = 10;
      options.onSettled(10);
    });
    await waitFor(() => expect(mocks.serialize).toHaveBeenCalledTimes(1));
    act(() => {
      controller.recoveryState = { status: "fault", code: "overflow" };
      options.onStateChange({ status: "fault", code: "overflow" });
    });

    fireEvent.click(screen.getByRole("button", { name: "Show recent output" }));

    await waitFor(() => expect(mocks.recoveryOptions).toHaveLength(2));
    expect(controller.retry).not.toHaveBeenCalled();
    expect(mocks.disposeRecovery).toHaveBeenCalledTimes(1);
    expect(mocks.disposeTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.order.filter((entry) => entry === "recover")).toHaveLength(2);
    expect(mocks.order).not.toContain("cache-recover");

    act(() => options.onStateChange({ status: "fault", code: "collision" }));
    expect(screen.queryByText("Terminal recovery stopped (collision).")).toBeNull();
  });

  it("shows a temporary notice after recent output becomes ready", async () => {
    vi.useFakeTimers();
    const session = { ...makeSession(), id: "overflow-notice-session" };
    try {
      render(
        <TerminalView
          session={session}
          hubUrl="https://hub.test"
        />,
      );

      const controller = mocks.recoveryControllers[0];
      act(() => {
        controller.recoveryState = { status: "fault", code: "overflow" };
        mocks.recoveryOptions[0].onStateChange({ status: "fault", code: "overflow" });
      });
      fireEvent.click(screen.getByRole("button", { name: "Show recent output" }));
      expect(mocks.recoveryOptions).toHaveLength(2);

      act(() => mocks.recoveryOptions[1].onStateChange({ status: "ready" }));
      expect(screen.getByText("Showing recent output; older terminal output was skipped.")).toBeTruthy();

      act(() => vi.advanceTimersByTime(7_999));
      expect(screen.getByText("Showing recent output; older terminal output was skipped.")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText("Showing recent output; older terminal output was skipped.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("automatically retries a deadline once from recent output", async () => {
    const session = { ...makeSession(), id: "deadline-recent-session" };
    render(
      <TerminalView
        session={session}
        hubUrl="https://hub.test"
      />,
    );

    const firstController = mocks.recoveryControllers[0];
    act(() => {
      firstController.recoveryState = { status: "fault", code: "deadline" };
      mocks.recoveryOptions[0].onStateChange({ status: "fault", code: "deadline" });
    });

    await waitFor(() => expect(mocks.recoveryOptions).toHaveLength(2));
    expect(screen.queryByText("Terminal recovery stopped (deadline).")).toBeNull();

    const fallbackController = mocks.recoveryControllers[1];
    act(() => {
      fallbackController.recoveryState = { status: "fault", code: "deadline" };
      mocks.recoveryOptions[1].onStateChange({ status: "fault", code: "deadline" });
    });

    expect(mocks.recoveryOptions).toHaveLength(2);
    expect(screen.getByText("Terminal recovery stopped (deadline).")).toBeTruthy();
  });

  it("clears the recent-output notice when the terminal session changes", () => {
    const firstSession = { ...makeSession(), id: "overflow-notice-first-session" };
    const rendered = render(
      <TerminalView
        session={firstSession}
        hubUrl="https://hub.test"
      />,
    );

    const controller = mocks.recoveryControllers[0];
    act(() => {
      controller.recoveryState = { status: "fault", code: "overflow" };
      mocks.recoveryOptions[0].onStateChange({ status: "fault", code: "overflow" });
    });
    fireEvent.click(screen.getByRole("button", { name: "Show recent output" }));
    act(() => mocks.recoveryOptions[1].onStateChange({ status: "ready" }));
    expect(screen.getByText("Showing recent output; older terminal output was skipped.")).toBeTruthy();

    rendered.rerender(
      <TerminalView
        session={{ ...makeSession(), id: "overflow-notice-second-session" }}
        hubUrl="https://hub.test"
      />,
    );
    expect(screen.queryByText("Showing recent output; older terminal output was skipped.")).toBeNull();
  });

  it("captures a throttled checkpoint after the user clears the terminal", async () => {
    vi.useFakeTimers();
    const ref = React.createRef<TerminalViewHandle>();
    const session = { ...makeSession(), id: "clear-checkpoint-session" };
    try {
      render(
        <TerminalView
          ref={ref}
          session={session}
          hubUrl="https://hub.test"
        />,
      );
      const options = mocks.recoveryOptions[0];
      const controller = mocks.recoveryControllers[0];

      mocks.serialized = "before-clear";
      controller.lastSeq = 10;
      act(() => options.onSettled(10));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(mocks.serialize).toHaveBeenCalledTimes(1);

      mocks.serialized = "after-clear";
      act(() => ref.current?.clear());
      await act(async () => vi.advanceTimersByTimeAsync(1_999));
      expect(mocks.serialize).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(mocks.serialize).toHaveBeenCalledTimes(2);
      expect(options.getStableSequence()).toBe(10);
    } finally {
      vi.useRealTimers();
    }
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

  it("keeps routine catch-up silent after the terminal is ready", () => {
    const onRecoveryState = vi.fn();
    render(
      <TerminalView
        session={makeSession()}
        hubUrl="https://hub.test"
        onRecoveryState={onRecoveryState}
      />,
    );
    const recoveryOptions = mocks.recoveryOptions[0];

    act(() => recoveryOptions.onStateChange({ status: "ready" }));
    onRecoveryState.mockClear();
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => recoveryOptions.onStateChange({ status: "recovering" }));
    expect(onRecoveryState).not.toHaveBeenCalled();

    act(() => recoveryOptions.onStateChange({ status: "fault", code: "fetch_failed" }));
    act(() => recoveryOptions.onStateChange({ status: "recovering" }));
    expect(onRecoveryState.mock.calls.map(([state]) => state.status)).toEqual(["fault", "recovering"]);
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

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(mocks.recoveryControllers[0].retry).toHaveBeenCalledOnce();
    expect(mocks.recoveryOptions).toHaveLength(1);
  });

  it("coalesces canonical checkpoints and never serializes more than once per two seconds", async () => {
    vi.useFakeTimers();
    const session = { ...makeSession(), id: "checkpoint-throttle-session" };
    try {
      render(
        <TerminalView
          session={session}
          hubUrl="https://hub.test"
        />,
      );
      const options = mocks.recoveryOptions[0];
      const controller = mocks.recoveryControllers[0];

      controller.lastSeq = 1;
      act(() => options.onSettled(1));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(mocks.serialize).toHaveBeenCalledTimes(1);
      expect(options.getStableSequence()).toBe(1);

      controller.lastSeq = 2;
      act(() => options.onSettled(2));
      controller.lastSeq = 3;
      act(() => options.onSettled(3));
      await act(async () => vi.advanceTimersByTimeAsync(1_999));
      expect(mocks.serialize).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(mocks.serialize).toHaveBeenCalledTimes(2);
      expect(options.getStableSequence()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips hidden checkpoints and captures the durable catch-up after visibility returns", async () => {
    vi.useFakeTimers();
    let hidden = false;
    const hiddenSpy = vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const session = { ...makeSession(), id: "hidden-checkpoint-session" };
    try {
      render(
        <TerminalView
          session={session}
          hubUrl="https://hub.test"
        />,
      );
      const options = mocks.recoveryOptions[0];
      const controller = mocks.recoveryControllers[0];

      mocks.serialized = "visible-seq-1";
      controller.lastSeq = 1;
      act(() => options.onSettled(1));
      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(mocks.serialize).toHaveBeenCalledTimes(1);
      expect(options.getStableSequence()).toBe(1);

      hidden = true;
      act(() => {
        options.write({
          id: "message-2",
          sessionId: session.id,
          seq: 2,
          content: { type: "terminal-output", data: "hidden-output" },
        }, () => {});
        controller.lastSeq = 2;
        options.onSettled(2);
      });
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(mocks.serialize).toHaveBeenCalledTimes(1);
      expect(options.getStableSequence()).toBe(1);

      hidden = false;
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      expect(controller.recoverGap).toHaveBeenCalledOnce();

      mocks.serialized = "repaired-seq-3";
      act(() => {
        options.write({
          id: "message-3",
          sessionId: session.id,
          seq: 3,
          content: { type: "terminal-output", data: "durable-catch-up" },
        }, () => {});
        controller.lastSeq = 3;
        options.onSettled(3);
      });
      await act(async () => vi.advanceTimersByTimeAsync(0));

      expect(mocks.writes).toContain("durable-catch-up");
      expect(mocks.serialize).toHaveBeenCalledTimes(2);
      expect(options.getStableSequence()).toBe(3);
    } finally {
      hiddenSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
