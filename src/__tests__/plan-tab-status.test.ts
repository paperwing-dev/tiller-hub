import { describe, expect, it } from "vitest";
import type {
  PlannerRun,
  PlanWriterState,
  ReviewerRegistryEntry,
} from "../../api/coordination/types";
import {
  newestReviewerRun,
  planWriterTabStatus,
  reviewerTabStatus,
} from "../plan-tab-status";

const reviewer: ReviewerRegistryEntry = {
  threadId: "reviewer-1",
  repoId: "repo-1",
  planArtifactId: "plan-1",
  provider: "codex",
  model: "gpt-5.5",
  effort: "high",
  role: "reviewer",
  reviewerModel: "gpt-5.5",
  createdAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:00:00.000Z",
};

function run(status: PlannerRun["status"], overrides: Partial<PlannerRun> = {}): PlannerRun {
  return {
    runId: "run-1",
    repoId: "repo-1",
    planArtifactId: "plan-1",
    role: "reviewer",
    provider: "codex",
    model: "gpt-5.5",
    status,
    startedAt: "2026-07-14T12:01:00.000Z",
    threadId: "reviewer-1",
    input: { effort: "high" },
    ...overrides,
  };
}

function writer(lifecycle: PlanWriterState["lifecycle"]): PlanWriterState {
  const started = lifecycle !== "not_running";
  return {
    lifecycle,
    generation: started ? 1 : null,
    provider: started ? "codex" : null,
    model: started ? "gpt-5.5" : null,
    effort: started ? "high" : null,
    basisCommit: started ? "main-1" : null,
    terminalId: started ? "terminal-1" : null,
    synchronization: { state: "up_to_date" },
    editable: true,
  };
}

describe("reviewerTabStatus", () => {
  it("treats a registry-only queued reviewer without a run as ready", () => {
    expect(reviewerTabStatus({ reviewer: { ...reviewer, status: "queued" } })).toMatchObject({
      kind: "idle",
      label: "Ready",
    });
  });

  it.each([
    ["queued", "starting", "Queued"],
    ["running", "working", "Working"],
    ["saving", "saving", "Saving"],
    ["cancelled", "stopped", "Stopped"],
    ["failed", "error", "Error"],
  ] as const)("maps %s runs to %s", (runStatus, kind, label) => {
    expect(reviewerTabStatus({
      reviewer,
      latestRun: run(runStatus, runStatus === "failed" ? { error: "Container exited." } : {}),
      modelLabel: "GPT-5.5",
      effortLabel: "High",
    })).toMatchObject({ kind, label, runId: "run-1" });
  });

  it("shows an unseen completion as new and keeps a viewed marker after opening it", () => {
    const completed = run("completed", { completedAt: "2026-07-14T12:02:00.000Z" });
    expect(reviewerTabStatus({ reviewer, latestRun: completed }).kind).toBe("finished");
    expect(reviewerTabStatus({
      reviewer,
      latestRun: completed,
      hasUnreadResult: false,
    })).toMatchObject({ kind: "viewed", label: "Viewed", runId: completed.runId });
  });

  it("keeps failed reviewers in the error state after acknowledgement", () => {
    const failed = run("failed", { error: "Container exited." });
    expect(reviewerTabStatus({
      reviewer,
      latestRun: failed,
      hasUnreadResult: false,
    })).toMatchObject({ kind: "error", label: "Error", runId: failed.runId });
  });
});

describe("planWriterTabStatus", () => {
  it("uses a steady running state and exposes the selected effort in details", () => {
    expect(planWriterTabStatus(writer("running"), {
      routeLabel: "GPT-5.5",
      effortLabel: "Extra High",
    })).toMatchObject({
      kind: "running",
      label: "Live",
      detail: expect.stringContaining("Extra High reasoning"),
    });
  });

  it("describes transitional, stopped, and error states", () => {
    expect(planWriterTabStatus(writer("not_running"), { operation: "starting" }).kind).toBe("starting");
    expect(planWriterTabStatus(writer("running"), {
      connecting: true,
      connectingDetail: "The Hub connection is offline.",
    })).toMatchObject({
      kind: "starting",
      label: "Connecting",
      detail: expect.stringContaining("Hub connection is offline"),
    });
    expect(planWriterTabStatus(writer("running"), { operation: "stopping" })).toMatchObject({
      kind: "stopping",
      label: "Stopping",
    });
    expect(planWriterTabStatus({ ...writer("running"), synchronization: { state: "saving" } }).kind).toBe("saving");
    expect(planWriterTabStatus({ ...writer("not_running"), generation: 1, stopReason: "user" })).toMatchObject({
      kind: "stopped",
      label: "Stopped",
    });
    expect(planWriterTabStatus({ ...writer("running"), startupError: "No runtime" })).toMatchObject({
      kind: "error",
      label: "Error",
    });
    expect(planWriterTabStatus({
      ...writer("running"),
      synchronization: { state: "sync_failed", error: "Hub callback timed out" },
    })).toMatchObject({
      kind: "error",
      label: "Sync issue",
      detail: expect.stringContaining("Hub callback timed out"),
    });
  });
});

describe("newestReviewerRun", () => {
  it("does not let delayed status polls regress a terminal run", () => {
    const completed = run("completed", { completedAt: "2026-07-14T12:02:00.000Z" });
    expect(newestReviewerRun(completed, run("running"))).toBe(completed);
  });

  it("does not let an older run replace a newer dispatch", () => {
    const newer = run("queued", {
      runId: "run-2",
      startedAt: "2026-07-14T12:03:00.000Z",
    });
    const older = run("completed", {
      runId: "run-1",
      startedAt: "2026-07-14T12:01:00.000Z",
    });
    expect(newestReviewerRun(newer, older)).toBe(newer);
    expect(newestReviewerRun(older, newer)).toBe(newer);
  });
});
