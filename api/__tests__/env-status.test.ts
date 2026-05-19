import { describe, expect, it } from "vitest";
import { normalizeRunnerStatus } from "../env/status";

describe("normalizeRunnerStatus", () => {
  it("maps Docker running to running", () => {
    expect(normalizeRunnerStatus("running")).toBe("running");
  });

  it("maps Docker terminal states to stopped", () => {
    expect(normalizeRunnerStatus("exited")).toBe("stopped");
    expect(normalizeRunnerStatus("dead")).toBe("stopped");
  });

  it("preserves transition-like statuses", () => {
    expect(normalizeRunnerStatus("restarting")).toBe("starting");
    expect(normalizeRunnerStatus("removing")).toBe("deleting");
  });
});
