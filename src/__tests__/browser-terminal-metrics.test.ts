import { describe, expect, it, vi } from "vitest";
import { BrowserTerminalMetricRecorder } from "../browser-terminal-metrics";

describe("BrowserTerminalMetricRecorder", () => {
  it("aggregates hop-local samples without logging raw session identifiers", () => {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const recorder = new BrowserTerminalMetricRecorder(
      "secret-session-id",
      () => true,
      logger,
    );

    recorder.observeRecoveryQueue(12, 34_000);
    recorder.record("browser_xterm_write", 10);
    recorder.record("browser_xterm_write", 20);
    const summaries = recorder.flush();

    expect(summaries).toEqual([{
      label: "browser_xterm_write",
      session: expect.stringMatching(/^ref_/),
      count: 2,
      p50Ms: 10,
      p95Ms: 20,
      p99Ms: 20,
      peakRecoveryMessages: 12,
      peakRecoveryBytes: 34_000,
    }]);
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain("secret-session-id");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("emits slow samples immediately and discards disabled samples", () => {
    let enabled = true;
    const logger = { info: vi.fn(), warn: vi.fn() };
    const recorder = new BrowserTerminalMetricRecorder(
      "session-1",
      () => enabled,
      logger,
    );

    recorder.record("browser_checkpoint", 100);
    expect(logger.warn).toHaveBeenCalledOnce();

    enabled = false;
    recorder.reset();
    recorder.record("browser_checkpoint", 200);
    expect(recorder.flush()).toEqual([]);
    expect(logger.info).not.toHaveBeenCalled();
  });
});
