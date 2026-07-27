/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchInvocations: vi.fn(),
  fetchInvocation: vi.fn(),
  fetchMessages: vi.fn(),
  forwardReports: vi.fn(),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    cancelPlanSkillInvocation: vi.fn(),
    fetchPlanSkillInvocations: mocks.fetchInvocations,
    fetchPlanSkillInvocation: mocks.fetchInvocation,
    fetchReviewerMessages: mocks.fetchMessages,
    forwardPlanSkillReports: mocks.forwardReports,
    sendReviewerMessage: vi.fn(),
  };
});

import PlanSkillHistory from "../PlanSkillHistory";

const definition = {
  id: "plan-review",
  surface: "plan" as const,
  command: "plan-review",
  label: "Plan Review",
  description: "",
  sharedInstructions: "Review the plan.",
  overviewInstructions: "",
  overviewMode: "manual" as const,
  agents: [{
    id: "reviewer",
    label: "Reviewer",
    instructions: "Review it.",
    routeKey: "codex:gpt-5.5",
    effort: "high" as const,
    reportMode: "manual" as const,
  }],
  origin: "builtin" as const,
  customized: false,
  createdAt: null,
  updatedAt: null,
};

describe("PlanSkillHistory", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.fetchInvocations.mockResolvedValue({
      invocations: [{ invocationId: "invocation-1", label: "Plan Review", status: "completed" }],
      nextCursor: null,
    });
    mocks.fetchInvocation.mockResolvedValue({
      invocation: {
        invocationId: "invocation-1",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        parentThreadId: "plan-writer-plan-1",
        definitionSnapshot: definition,
        basis: { artifactId: "plan-1", title: "Plan", markdown: "# Plan", version: 1, gitBaseCommitSha: "base-1" },
        status: "completed",
        error: null,
        cancelledAt: null,
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:01:00.000Z",
      },
      reviewers: [{
        threadId: "child-1",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        provider: "codex",
        model: "gpt-5.5",
        role: "reviewer",
        status: "completed",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:01:00.000Z",
        skillInvocationId: "invocation-1",
        skillAgentId: "reviewer",
      }],
      runs: [{
        runId: "run-1",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        role: "reviewer",
        provider: "codex",
        model: "gpt-5.5",
        status: "completed",
        startedAt: "2026-07-10T00:00:00.000Z",
        threadId: "child-1",
        skillInvocationId: "invocation-1",
        skillAgentId: "reviewer",
        skillRunRole: "child_initial",
      }],
    });
    mocks.fetchMessages.mockResolvedValue([{
      id: "report-1",
      threadId: "child-1",
      seq: 2,
      senderSessionId: "assistant",
      kind: "chat",
      body: { role: "assistant", text: "Useful report", runId: "run-1" },
      createdAt: "2026-07-10T00:01:00.000Z",
    }]);
  });

  afterEach(() => cleanup());

  it("reuses a forwarding-action id after an ambiguous failure", async () => {
    mocks.forwardReports
      .mockRejectedValueOnce(new Error("Network response was lost"))
      .mockResolvedValueOnce({ contributions: [] });
    render(<PlanSkillHistory repoId="repo-1" planArtifactId="plan-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "Plan Review · completed" }));
    const checkbox = await screen.findByLabelText("Forward to Plan Writer");
    fireEvent.click(checkbox);
    const send = screen.getByRole("button", { name: "Send to Plan Writer" });
    fireEvent.click(send);
    await waitFor(() => expect(mocks.forwardReports).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(send).toBeEnabled());
    fireEvent.click(send);
    await waitFor(() => expect(mocks.forwardReports).toHaveBeenCalledTimes(2));

    expect(mocks.forwardReports.mock.calls[1][4].requestId).toBe(mocks.forwardReports.mock.calls[0][4].requestId);
  });

  it("hands one-shot reports directly to the live writer flow", async () => {
    const contribution = {
      id: "contribution-1",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      sourceKind: "reviewer_run",
      provider: "codex",
      model: "gpt-5.5",
      text: "Useful report",
      status: "pending",
      createdAt: "2026-07-10T00:01:00.000Z",
      updatedAt: "2026-07-10T00:01:00.000Z",
    };
    mocks.forwardReports.mockResolvedValue({ contributions: [contribution] });
    const onForwarded = vi.fn();
    render(
      <PlanSkillHistory
        repoId="repo-1"
        planArtifactId="plan-1"
        onForwarded={onForwarded}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Plan Review · completed" }));
    fireEvent.click(await screen.findByLabelText("Forward to Plan Writer"));
    fireEvent.click(screen.getByRole("button", { name: "Send to Plan Writer" }));

    await waitFor(() => expect(onForwarded).toHaveBeenCalledWith([contribution]));
  });
});
