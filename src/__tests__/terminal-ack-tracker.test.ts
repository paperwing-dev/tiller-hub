import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalAckTracker } from "../terminal-ack-tracker";

describe("TerminalAckTracker", () => {
  let staleWarnings: string[];
  let failures: string[];
  let drops: string[];

  const createTracker = () =>
    new TerminalAckTracker({
      onStaleWarning: (message) => staleWarnings.push(message),
      onFailure: (message) => failures.push(message),
      onDrop: (message) => drops.push(message),
    });

  beforeEach(() => {
    vi.useFakeTimers();
    staleWarnings = [];
    failures = [];
    drops = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("warns once per stale period, deletes timed-out entries, and re-arms after drain", () => {
    const tracker = createTracker();

    tracker.trackInput(1);
    tracker.trackInput(2);
    vi.advanceTimersByTime(1000);

    expect(staleWarnings).toHaveLength(1);

    // Both entries timed out and were deleted, so the warning re-arms.
    tracker.trackInput(3);
    vi.advanceTimersByTime(1000);

    expect(staleWarnings).toHaveLength(2);
  });

  it("ignores ACKs for entries already removed by timeout", () => {
    const tracker = createTracker();

    tracker.trackInput(1);
    vi.advanceTimersByTime(1000);

    tracker.handleInputAck(1, "boom");

    expect(failures).toHaveLength(0);
  });

  it("clear() drops pending entries so no warning fires after disconnect", () => {
    const tracker = createTracker();

    tracker.trackInput(1);
    tracker.trackControl(1);
    tracker.clear();
    vi.advanceTimersByTime(5000);

    expect(staleWarnings).toHaveLength(0);
  });

  it("coalesces failed-ACK reports on a cooldown, not on drained maps", () => {
    const tracker = createTracker();

    // Each failed ACK drains the map immediately — the second must still be
    // suppressed by the cooldown.
    tracker.trackInput(1);
    tracker.handleInputAck(1, "No active terminal owner for session");
    tracker.trackInput(2);
    tracker.handleInputAck(2, "No active terminal owner for session");
    expect(failures).toHaveLength(1);

    // After the cooldown the next failure reports again.
    vi.advanceTimersByTime(2001);
    tracker.trackInput(3);
    tracker.handleInputAck(3, "No active terminal owner for session");
    expect(failures).toHaveLength(2);
  });

  it("resets failure coalescing on a successful ACK", () => {
    const tracker = createTracker();

    tracker.trackInput(1);
    tracker.handleInputAck(1, "boom");
    tracker.trackInput(2);
    tracker.handleInputAck(2);
    tracker.trackInput(3);
    tracker.handleInputAck(3, "boom again");

    expect(failures).toEqual([
      "Terminal input failed: boom",
      "Terminal input failed: boom again",
    ]);
  });

  it("coalesces send-failure drop warnings on a cooldown", () => {
    const tracker = createTracker();

    tracker.warnSendFailed("terminal input");
    tracker.warnSendFailed("terminal input");
    expect(drops).toHaveLength(1);

    vi.advanceTimersByTime(2001);
    tracker.warnSendFailed("terminal input");
    expect(drops).toEqual([
      "Not connected — terminal input dropped.",
      "Not connected — terminal input dropped.",
    ]);
  });

  it("tracks control ACK failures separately from inputs", () => {
    const tracker = createTracker();

    tracker.trackControl(1);
    tracker.handleControlAck(1, "boom");

    expect(failures).toEqual(["Terminal control failed: boom"]);
  });
});
