import { describe, expect, it } from "vitest";
import type { EnvReviewRun, EnvReviewTab } from "../api";
import {
  envReviewTabStatus,
  envReviewViewedStorageKey,
  implementationReviewStatus,
  readEnvReviewViewedRuns,
  writeEnvReviewViewedRuns,
} from "../env-review-tab-status";

const tab: EnvReviewTab = {
  threadId: "reviewer-1",
  envSlug: "env-1",
  repoId: "repo-1",
  mainSessionId: "session-1",
  provider: "codex",
  model: "gpt-5.5",
  effort: "high",
  roleLabel: "Tests Reviewer",
  taskKind: "tests",
  customTask: null,
  status: "idle",
  latestRunId: null,
  removedAt: null,
  createdAt: "2026-07-14T12:00:00.000Z",
  updatedAt: "2026-07-14T12:00:00.000Z",
  skillInvocationId: null,
  skillAgentId: null,
};

function run(status: EnvReviewRun["status"], overrides: Partial<EnvReviewRun> = {}): EnvReviewRun {
  return {
    runId: "run-1",
    threadId: tab.threadId,
    envSlug: tab.envSlug,
    repoId: tab.repoId,
    mainSessionId: tab.mainSessionId,
    provider: tab.provider,
    model: tab.model,
    effort: tab.effort,
    roleLabel: tab.roleLabel,
    taskKind: tab.taskKind,
    customTask: null,
    recipeInstructions: null,
    status,
    preparationOpId: "op-1",
    preparation: null,
    changeContext: null,
    planBasis: null,
    prompt: "Review the implementation.",
    runtime: null,
    startedAt: "2026-07-14T12:01:00.000Z",
    queuedAt: "2026-07-14T12:01:00.000Z",
    completedAt: null,
    error: null,
    lastContactAt: null,
    skillInvocationId: null,
    skillAgentId: null,
    skillRunRole: null,
    skillDefinitionSnapshot: null,
    frozenOverview: null,
    ...overrides,
  };
}

describe("envReviewTabStatus", () => {
  it("uses a quiet persistent marker before a reviewer has results", () => {
    expect(envReviewTabStatus({ tab })).toMatchObject({ kind: "idle", label: "Ready" });
  });

  it("uses blue attention for a new result and a muted viewed state after acknowledgement", () => {
    const ready = run("ready", { completedAt: "2026-07-14T12:02:00.000Z" });
    expect(envReviewTabStatus({ tab, latestRun: ready })).toMatchObject({
      kind: "finished",
      label: "New result",
      runId: ready.runId,
    });
    expect(envReviewTabStatus({ tab, latestRun: ready, acknowledgedRunId: ready.runId })).toMatchObject({
      kind: "viewed",
      label: "Viewed",
      runId: ready.runId,
    });
  });

  it("shares active, stopped, and error meanings with Plan reviewers", () => {
    expect(envReviewTabStatus({ tab, latestRun: run("running") }).kind).toBe("working");
    expect(envReviewTabStatus({ tab, latestRun: run("cancelled") }).kind).toBe("stopped");
    expect(envReviewTabStatus({ tab, latestRun: run("failed", { error: "Container exited." }) })).toMatchObject({
      kind: "error",
      detail: expect.stringContaining("Container exited"),
    });
    expect(implementationReviewStatus({ status: "setting_up" }).kind).toBe("starting");
  });
});

describe("implementation reviewer acknowledgements", () => {
  it("stores viewed runs per environment session", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };

    expect(envReviewViewedStorageKey("env-1", "session-1"))
      .not.toBe(envReviewViewedStorageKey("env-1", "session-2"));
    writeEnvReviewViewedRuns(storage, "env-1", "session-1", { "reviewer-1": "run-1" });
    expect(readEnvReviewViewedRuns(storage, "env-1", "session-1"))
      .toEqual({ "reviewer-1": "run-1" });
    expect(readEnvReviewViewedRuns(storage, "env-1", "session-2")).toEqual({});
  });
});
