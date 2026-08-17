import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getEnvLifecycleStub: vi.fn(),
  getThreadStub: vi.fn(),
  resolveLaunchProvenance: vi.fn(),
}));

vi.mock("../../helpers", () => ({
  getEnvLifecycleStub: mocks.getEnvLifecycleStub,
  getThreadStub: mocks.getThreadStub,
}));
vi.mock("../dispatch", () => ({
  resolveNewEnvReviewLaunchProvenance: mocks.resolveLaunchProvenance,
}));

import { assignSkillOverview, finalizeSuccessfulReviewOutput } from "../skill-orchestration";

describe("Reviewer completion attention", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("publishes environment attention when reviewer feedback becomes ready", async () => {
    const reportReviewerCompletion = vi.fn(async () => ({ accepted: true, changed: true }));
    const persistOwnedProjection = vi.fn(async () => null);
    mocks.getEnvLifecycleStub.mockReturnValue({
      reportReviewerCompletion,
      persistOwnedProjection,
    });
    const run = {
      runId: "review-run-1",
      envSlug: "env-1",
      skillInvocationId: null,
      skillRunRole: null,
      status: "running",
    };
    const readyRun = { ...run, status: "ready" };
    const review = {
      completeRunSuccessfully: vi.fn(async () => ({
        status: "completed" as const,
        run: readyRun,
        feedback: { feedbackId: "env-review:review-run-1" },
      })),
    };

    await finalizeSuccessfulReviewOutput({
      env: {} as any,
      review: review as any,
      run: run as any,
      message: {
        id: "message-1",
        body: { role: "assistant", text: "Review result", runId: "review-run-1" },
      } as any,
    });

    expect(mocks.getEnvLifecycleStub).toHaveBeenCalledWith(expect.anything(), "env-1");
    expect(reportReviewerCompletion).toHaveBeenCalledWith("review-run-1");
    expect(persistOwnedProjection).toHaveBeenCalledOnce();
  });

  it("does not alert for an internal reviewer result without feedback", async () => {
    const run = {
      runId: "review-run-internal",
      envSlug: "env-1",
      skillInvocationId: null,
      skillRunRole: null,
      status: "running",
    };
    const review = {
      completeRunSuccessfully: vi.fn(async () => ({
        status: "completed" as const,
        run: { ...run, status: "ready" },
        feedback: null,
      })),
    };

    await finalizeSuccessfulReviewOutput({
      env: {} as any,
      review: review as any,
      run: run as any,
      message: {
        id: "message-internal",
        body: { role: "assistant", text: "Internal result", runId: "review-run-internal" },
      } as any,
    });

    expect(mocks.getEnvLifecycleStub).not.toHaveBeenCalled();
  });
});

describe("Review skill re-review orchestration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveLaunchProvenance.mockResolvedValue({
      schemaVersion: 1,
      backend: "cf",
      machineId: null,
    });
  });

  it("builds the next Overview only from the fresh preparation", async () => {
    const definition = {
      id: "code-review",
      command: "code-review",
      label: "Code Review",
      overviewInstructions: "Deduplicate findings.",
      agents: [
        { id: "bugs", label: "Bug Reviewer" },
        { id: "tests", label: "Test Reviewer" },
      ],
    };
    const invocation = {
      invocationId: "invocation-1",
      parentThreadId: "parent-1",
      mainSessionId: "session-1",
      definitionSnapshot: definition,
      preparationOpId: "fresh-op",
      status: "active",
      overviewMode: "auto",
      includedMessageIds: ["fresh-message-1", "fresh-message-2"],
      overviewRunId: null,
      overviewRoute: { provider: "codex", model: "gpt-5.5", effort: "high" },
    };
    const preparation = {
      status: "succeeded",
      opId: "fresh-op",
      snapshot: { snapshotId: "fresh-snapshot" },
      completedAt: "2026-08-09T00:00:00.000Z",
    };
    const changeContext = { summary: { total: 1 } };
    const planBasis = { source: "none", artifactId: null, version: null, title: null, markdown: null };
    const oldRun = {
      runId: "old-run",
      threadId: "thread-1",
      preparationOpId: "old-op",
      skillRunRole: "report_initial",
      skillAgentId: "bugs",
      status: "running",
    };
    const freshRuns = definition.agents.map((agent, index) => ({
      runId: `fresh-run-${index + 1}`,
      threadId: `thread-${index + 1}`,
      preparationOpId: "fresh-op",
      skillRunRole: "report_initial",
      skillAgentId: agent.id,
      roleLabel: agent.label,
      status: "ready",
      preparation,
      changeContext,
      planBasis,
    }));
    mocks.getThreadStub.mockImplementation((_env, threadId) => ({
      getMessage: vi.fn(async (messageId) => {
        const index = freshRuns.findIndex((run, runIndex) => (
          run.threadId === threadId && messageId === `fresh-message-${runIndex + 1}`
        ));
        if (index < 0) return null;
        const run = freshRuns[index]!;
        return {
          id: messageId,
          threadId,
          senderSessionId: "assistant",
          body: { role: "assistant", text: `${run.roleLabel} fresh report`, runId: run.runId },
        };
      }),
    }));
    const assignOverviewRecord = vi.fn(async (input) => ({
      status: "created",
      invocation: { ...invocation, overviewRunId: input.overviewRunId },
      run: { runId: input.overviewRunId },
    }));
    const review = {
      getSkillInvocation: vi.fn(async () => invocation),
      listSkillInvocationRuns: vi.fn(async () => [oldRun, ...freshRuns]),
      getTab: vi.fn(async () => ({
        threadId: "parent-1",
        mainSessionId: "session-1",
        removedAt: null,
        provider: "codex",
        model: "gpt-5.5",
        effort: "high",
      })),
      assignSkillOverview: assignOverviewRecord,
      appendRunEvent: vi.fn(async () => undefined),
      scheduleOrchestration: vi.fn(async () => undefined),
      failSkillInvocation: vi.fn(async () => null),
      getRun: vi.fn(async () => null),
    };

    const result = await assignSkillOverview({
      env: {} as any,
      review: review as any,
      invocationId: "invocation-1",
      automatic: true,
    });

    expect(result.status).toBe("created");
    expect(assignOverviewRecord).toHaveBeenCalledWith(expect.objectContaining({
      preparation,
      changeContext,
      planBasis,
      payload: expect.objectContaining({
        reports: [
          expect.objectContaining({ runId: "fresh-run-1", text: "Bug Reviewer fresh report" }),
          expect.objectContaining({ runId: "fresh-run-2", text: "Test Reviewer fresh report" }),
        ],
      }),
    }));
  });
});
