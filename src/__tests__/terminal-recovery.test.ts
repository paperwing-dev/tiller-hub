import { describe, expect, it, vi } from "vitest";
import {
  COLD_MOUNT_PAGE_SIZE,
  MAX_RECOVERY_BYTES,
  RECOVERY_PAGE_SIZE,
  TerminalRecoveryController,
  TerminalRecoveryOverflowError,
  type DurableTerminalMessage,
  type TerminalRecoveryFetchOptions,
  type TerminalRecoveryState,
} from "../terminal-recovery";

function message(seq: number, overrides: Partial<DurableTerminalMessage> = {}): DurableTerminalMessage {
  return {
    id: `message-${seq}`,
    sessionId: "session-1",
    seq,
    content: { type: "terminal-output", data: String(seq) },
    ...overrides,
  };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("TerminalRecoveryController", () => {
  it("adopts a cold-tail baseline and advances only from write callbacks", async () => {
    const writes: Array<{ event: DurableTerminalMessage; callback: () => void }> = [];
    const completed: number[] = [];
    const states: TerminalRecoveryState[] = [];
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: vi.fn(async (options) => {
        expect(options).toEqual(expect.objectContaining({ limit: COLD_MOUNT_PAGE_SIZE }));
        return [message(205), message(204)];
      }),
      write: (event, callback) => writes.push({ event, callback }),
      onSequenceComplete: (seq) => completed.push(seq),
      onStateChange: (state) => states.push(state),
      onSettled: vi.fn(),
    });

    await controller.startCold();
    expect(writes.map((entry) => entry.event.seq)).toEqual([204]);
    expect(controller.lastSeq).toBe(203);
    expect(completed).toEqual([]);

    writes.shift()!.callback();
    expect(controller.lastSeq).toBe(204);
    expect(writes.map((entry) => entry.event.seq)).toEqual([205]);
    writes.shift()!.callback();
    expect(controller.lastSeq).toBe(205);
    expect(completed).toEqual([204, 205]);
    expect(states[states.length - 1]).toEqual({ status: "ready" });
    controller.dispose();
  });

  it("pages cache recovery forward and merges identical HTTP/live races", async () => {
    const fetched = vi.fn(async (options: { limit: number; afterSeq?: number }) => {
      if (options.afterSeq === 10) {
        return Array.from({ length: RECOVERY_PAGE_SIZE }, (_, index) => message(11 + index));
      }
      if (options.afterSeq === 1010) return [message(1011), message(1012)];
      return [];
    });
    const completed: number[] = [];
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: fetched,
      write: (_event, callback) => callback(),
      onSequenceComplete: (seq) => completed.push(seq),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
    });

    controller.startCacheRestore(10, 100, (callback) => callback());
    controller.acceptLive(message(1012));
    await flushAsync();

    expect(fetched).toHaveBeenNthCalledWith(1, expect.objectContaining({
      afterSeq: 10,
      limit: RECOVERY_PAGE_SIZE,
    }));
    expect(fetched).toHaveBeenNthCalledWith(2, expect.objectContaining({
      afterSeq: 1010,
      limit: RECOVERY_PAGE_SIZE,
    }));
    expect(controller.recoveryState).toEqual({ status: "ready" });
    expect(controller.lastSeq).toBe(1012);
    expect(completed[completed.length - 1]).toBe(1012);
    controller.dispose();
  });

  it("drops live events already covered by the completed cache baseline", async () => {
    let completeRestore!: () => void;
    const completed: number[] = [];
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: vi.fn(async () => []),
      write: vi.fn(),
      onSequenceComplete: (seq) => completed.push(seq),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
    });

    controller.startCacheRestore(10, 100, (callback) => { completeRestore = callback; });
    controller.acceptLive(message(10));
    completeRestore();
    await flushAsync();

    expect(controller.lastSeq).toBe(10);
    expect(controller.pendingMessageCount).toBe(0);
    expect(controller.recoveryState).toEqual({ status: "ready" });
    expect(completed).toEqual([10]);
    controller.dispose();
  });

  it("fails closed when HTTP and WebSocket payloads collide", async () => {
    let resolvePage!: (events: DurableTerminalMessage[]) => void;
    const page = new Promise<DurableTerminalMessage[]>((resolve) => { resolvePage = resolve; });
    const states: TerminalRecoveryState[] = [];
    const restoreStable = vi.fn();
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: () => page,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: (state) => states.push(state),
      onSettled: vi.fn(),
      restoreStableScreen: restoreStable,
    });

    controller.startCacheRestore(0, 0, (callback) => callback());
    controller.acceptLive(message(1));
    resolvePage([message(1, { content: { type: "terminal-output", data: "different" } })]);
    await flushAsync();

    expect(states[states.length - 1]).toEqual({ status: "fault", code: "collision" });
    expect(restoreStable).toHaveBeenCalled();
    expect(controller.lastSeq).toBe(0);
    controller.dispose();
  });

  it("fails closed when one pending id appears at two sequences", async () => {
    let resolvePage!: (events: DurableTerminalMessage[]) => void;
    const page = new Promise<DurableTerminalMessage[]>((resolve) => { resolvePage = resolve; });
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: () => page,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
    });

    controller.startCacheRestore(0, 0, (callback) => callback());
    controller.acceptLive(message(1, { id: "shared-id" }));
    controller.acceptLive(message(2, { id: "shared-id" }));

    expect(controller.recoveryState).toEqual({ status: "fault", code: "collision" });
    expect(controller.lastSeq).toBe(0);
    resolvePage([]);
    controller.dispose();
  });

  it("passes only the remaining recovery byte budget to HTTP fetches", async () => {
    let completeRestore!: () => void;
    const fetchPage = vi.fn(async (_options: TerminalRecoveryFetchOptions) => [] as DurableTerminalMessage[]);
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
    });

    controller.startCacheRestore(0, 0, (callback) => { completeRestore = callback; });
    controller.acceptLive(message(1));
    completeRestore();
    await flushAsync();

    expect(fetchPage.mock.calls[0]?.[0].maxBytes).toBeLessThan(MAX_RECOVERY_BYTES);
    controller.dispose();
  });

  it("treats a bounded HTTP response overflow as non-retryable", async () => {
    const fetchPage = vi.fn(async () => { throw new TerminalRecoveryOverflowError(); });
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
    });

    await controller.startCold();

    expect(fetchPage).toHaveBeenCalledOnce();
    expect(controller.recoveryState).toEqual({ status: "fault", code: "overflow" });
    controller.dispose();
  });

  it("retries through the bounded cold tail when no checkpoint has completed", async () => {
    const fetchPage = vi.fn(async (
      _options: TerminalRecoveryFetchOptions,
    ): Promise<DurableTerminalMessage[]> => [message(900)]);
    fetchPage.mockRejectedValueOnce(new TerminalRecoveryOverflowError());
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      getStableSequence: () => undefined,
      restoreStableScreen: (callback) => callback(),
    });

    await controller.startCold();
    expect(controller.recoveryState).toEqual({ status: "fault", code: "overflow" });

    controller.retry();
    await flushAsync();

    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({
      limit: COLD_MOUNT_PAGE_SIZE,
    }));
    expect(fetchPage.mock.calls[1]?.[0]).not.toHaveProperty("afterSeq");
    expect(controller.lastSeq).toBe(900);
    expect(controller.recoveryState).toEqual({ status: "ready" });
    controller.dispose();
  });

  it("counts pending writes and steady-state backpressure against both limits", async () => {
    const states: TerminalRecoveryState[] = [];
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: async () => [],
      write: () => {
        // Deliberately hold the xterm callback.
      },
      onSequenceComplete: vi.fn(),
      onStateChange: (state) => states.push(state),
      onSettled: vi.fn(),
      maxMessages: 2,
      maxBytes: 1_000_000,
    });

    controller.startCacheRestore(0, 0, (callback) => callback());
    await flushAsync();
    controller.acceptLive(message(1));
    controller.acceptLive(message(2));
    controller.acceptLive(message(3));
    expect(states[states.length - 1]).toEqual({ status: "fault", code: "overflow" });
    expect(controller.pendingMessageCount).toBe(2);
    controller.dispose();
  });

  it("reserves HTTP page slots against the combined message limit", () => {
    let completeRestore!: () => void;
    let resolvePage!: (events: DurableTerminalMessage[]) => void;
    const fetchPage = vi.fn(() => new Promise<DurableTerminalMessage[]>((resolve) => {
      resolvePage = resolve;
    }));
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      maxMessages: 4,
    });

    controller.startCacheRestore(0, 0, (callback) => { completeRestore = callback; });
    controller.acceptLive(message(2));
    controller.acceptLive(message(3));
    controller.acceptLive(message(4));
    completeRestore();

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    controller.acceptLive(message(5));
    expect(controller.recoveryState).toEqual({ status: "fault", code: "overflow" });
    expect(controller.pendingMessageCount).toBe(3);
    resolvePage([]);
    controller.dispose();
  });

  it("aborts an HTTP response when live messages consume its byte budget", async () => {
    let completeRestore!: () => void;
    let fetchSignal!: AbortSignal;
    const fetchPage = vi.fn((options) => {
      fetchSignal = options.signal;
      options.onBytes(599);
      return new Promise<DurableTerminalMessage[]>((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    });
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      maxBytes: 600,
    });

    controller.startCacheRestore(0, 0, (callback) => { completeRestore = callback; });
    completeRestore();
    controller.acceptLive(message(1));
    await flushAsync();

    expect(controller.recoveryState).toEqual({ status: "fault", code: "overflow" });
    expect(fetchSignal.aborted).toBe(true);
    controller.dispose();
  });

  it("applies the fixed retry schedule only while inside the total deadline", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const states: TerminalRecoveryState[] = [];
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: async () => { throw new Error("transient"); },
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: (state) => states.push(state),
      onSettled: vi.fn(),
      now: () => now,
      sleep: async (ms) => { sleeps.push(ms); now += ms; },
      deadlineMs: 700,
    });

    controller.startCacheRestore(0, 0, (callback) => callback());
    await flushAsync();

    expect(sleeps).toEqual([250]);
    expect(states[states.length - 1]).toEqual({ status: "fault", code: "deadline" });
    controller.dispose();
  });

  it("faults on a non-advancing full forward page", async () => {
    const states: TerminalRecoveryState[] = [];
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: async () => Array.from(
        { length: RECOVERY_PAGE_SIZE },
        (_, index) => message(index + 1),
      ),
      write: (_event, callback) => callback(),
      onSequenceComplete: vi.fn(),
      onStateChange: (state) => states.push(state),
      onSettled: vi.fn(),
    });

    controller.startCacheRestore(RECOVERY_PAGE_SIZE, 0, (callback) => callback());
    await flushAsync();
    expect(states[states.length - 1]).toEqual({ status: "fault", code: "non_progress" });
    controller.dispose();
  });

  it("defers reconnect recovery until an in-flight xterm callback completes", async () => {
    const callbacks: Array<() => void> = [];
    const fetchPage = vi.fn(async () => [] as DurableTerminalMessage[]);
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callbacks.push(callback),
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
    });
    controller.startCacheRestore(0, 0, (callback) => callback());
    await flushAsync();
    expect(controller.recoveryState).toEqual({ status: "ready" });

    controller.acceptLive(message(1));
    controller.recoverGap();
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(controller.recoveryState).toEqual({ status: "recovering" });
    callbacks.shift()!();
    await flushAsync();

    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({
      afterSeq: 1,
      limit: RECOVERY_PAGE_SIZE,
    }));
    expect(controller.lastSeq).toBe(1);
    expect(controller.recoveryState).toEqual({ status: "ready" });
    controller.dispose();
  });

  it("includes an in-flight xterm callback in the reconnect deadline", async () => {
    vi.useFakeTimers();
    const restoreStable = vi.fn();
    let completeWrite!: () => void;
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage: vi.fn(async () => []),
      write: (_event, callback) => {
        // Hold the callback beyond the recovery deadline.
        completeWrite = callback;
      },
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      restoreStableScreen: (callback) => {
        restoreStable();
        callback();
      },
      deadlineMs: 100,
    });

    try {
      controller.startCacheRestore(0, 0, (callback) => callback());
      await flushAsync();
      controller.acceptLive(message(1));
      controller.recoverGap();

      await vi.advanceTimersByTimeAsync(100);

      expect(controller.recoveryState).toEqual({ status: "fault", code: "deadline" });
      expect(controller.lastSeq).toBe(0);
      expect(restoreStable).not.toHaveBeenCalled();

      completeWrite();
      expect(restoreStable).toHaveBeenCalledOnce();
    } finally {
      controller.dispose();
      vi.useRealTimers();
    }
  });

  it("waits for the stable-screen callback before an immediate retry", async () => {
    let staleWriteCallback!: () => void;
    let restoreCallback!: () => void;
    let writeCount = 0;
    let screen = "stable-0";
    const order: string[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([message(1)]);
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (event, callback) => {
        writeCount += 1;
        if (writeCount === 1) {
          order.push("stale-write");
          screen = "unstable-1";
          staleWriteCallback = callback;
          return;
        }
        order.push("retry-write");
        screen = String((event.content as { data: string }).data);
        callback();
      },
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      restoreStableScreen: (callback) => {
        order.push("restore");
        screen = "stable-0";
        restoreCallback = callback;
      },
    });

    controller.startCacheRestore(0, 0, (callback) => callback());
    await flushAsync();
    controller.acceptLive(message(1));
    controller.acceptLive(message(1, {
      content: { type: "terminal-output", data: "collision" },
    }));
    controller.retry();

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["stale-write"]);
    staleWriteCallback();
    expect(order).toEqual(["stale-write", "restore"]);
    expect(fetchPage).toHaveBeenCalledTimes(1);

    restoreCallback();
    await flushAsync();

    expect(order).toEqual(["stale-write", "restore", "retry-write"]);
    expect(screen).toBe("1");
    expect(controller.lastSeq).toBe(1);
    expect(controller.recoveryState).toEqual({ status: "ready" });
    controller.dispose();
  });

  it("keeps a completed cache restore as the rollback point after a fault", async () => {
    let completeCacheWrite!: () => void;
    let screen = "";
    let stableScreen = "";
    let stableSeq = 10;
    let restoreCount = 0;
    const completed: number[] = [];
    const fetchPage = vi.fn(async () => [] as DurableTerminalMessage[]);
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (_event, callback) => callback(),
      onSequenceComplete: (seq) => completed.push(seq),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      getStableSequence: () => stableSeq,
      restoreStableScreen: (callback) => {
        restoreCount += 1;
        screen = stableScreen;
        callback();
      },
    });

    controller.startCacheRestore(10, 100, (callback) => {
      screen = "cached-screen-10";
      stableScreen = screen;
      stableSeq = 10;
      completeCacheWrite = callback;
    });
    controller.acceptLive(message(11));
    controller.acceptLive(message(11, {
      content: { type: "terminal-output", data: "collision" },
    }));

    expect(controller.recoveryState).toEqual({ status: "fault", code: "collision" });
    expect(controller.lastSeq).toBe(10);
    expect(restoreCount).toBe(0);

    completeCacheWrite();

    expect(stableScreen).toBe("cached-screen-10");
    expect(screen).toBe("cached-screen-10");
    expect(controller.lastSeq).toBe(10);
    expect(completed).toEqual([10]);
    expect(restoreCount).toBe(1);

    controller.retry();
    await flushAsync();

    expect(fetchPage).toHaveBeenCalledWith(expect.objectContaining({ afterSeq: 10 }));
    expect(controller.recoveryState).toEqual({ status: "ready" });
    controller.dispose();
  });

  it("rolls back to the checkpoint sequence and refetches canonical records after it", async () => {
    let heldWrite!: () => void;
    let stableSeq = 10;
    const restored: number[] = [];
    const fetchPage = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([message(11), message(12)]);
    const controller = new TerminalRecoveryController({
      sessionId: "session-1",
      fetchPage,
      write: (event, callback) => {
        if (event.seq === 12 && !heldWrite) {
          heldWrite = callback;
          return;
        }
        callback();
      },
      onSequenceComplete: vi.fn(),
      onStateChange: vi.fn(),
      onSettled: vi.fn(),
      getStableSequence: () => stableSeq,
      restoreStableScreen: (callback) => {
        restored.push(stableSeq);
        callback();
      },
    });

    controller.startCacheRestore(10, 100, (callback) => callback());
    await flushAsync();
    controller.acceptLive(message(11));
    controller.acceptLive(message(12));
    controller.acceptLive(message(12, {
      content: { type: "terminal-output", data: "collision" },
    }));

    expect(controller.recoveryState).toEqual({ status: "fault", code: "collision" });
    expect(controller.lastSeq).toBe(10);
    expect(restored).toEqual([]);
    heldWrite();
    expect(restored).toEqual([10]);

    controller.retry();
    await flushAsync();
    expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ afterSeq: 10 }));
    expect(controller.lastSeq).toBe(12);
    controller.dispose();
  });
});
