/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancel: vi.fn(),
  createOverview: vi.fn(),
  fetchHistory: vi.fn(),
  fetchInvocation: vi.fn(),
  fetchLatest: vi.fn(),
  fetchMessages: vi.fn(),
  rerun: vi.fn(),
  sendMessage: vi.fn(),
  shareOverview: vi.fn(),
  updateControls: vi.fn(),
}));

vi.mock("../api", () => ({
  cancelPlanSkillInvocation: mocks.cancel,
  createPlanSkillOverview: mocks.createOverview,
  fetchPlanSkillInvocation: mocks.fetchInvocation,
  fetchPlanSkillInvocations: mocks.fetchHistory,
  fetchLatestPlanSkillInvocation: mocks.fetchLatest,
  fetchReviewerMessages: mocks.fetchMessages,
  rerunPlanSkillInvocation: mocks.rerun,
  sendReviewerMessage: mocks.sendMessage,
  sharePlanSkillOverview: mocks.shareOverview,
  updatePlanSkillControls: mocks.updateControls,
}));

const { default: PlanSkillFanout } = await import("../PlanSkillFanout");

beforeEach(() => {
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.fetchHistory.mockResolvedValue({ invocations: [], nextCursor: null });
  mocks.shareOverview.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function reportRun(agentId: string, index: number) {
  return {
    runId: `run-${agentId}`,
    repoId: "repo-1",
    planArtifactId: "plan-1",
    role: "reviewer",
    provider: "fake",
    model: "fake-fast",
    status: "completed",
    startedAt: `2026-08-12T00:0${index}:00.000Z`,
    completedAt: `2026-08-12T00:0${index}:30.000Z`,
    skillInvocationId: "round-1",
    skillAgentId: agentId,
    skillRunRole: "report_initial",
    input: { effort: "high" },
    launchProvenance: { schemaVersion: 1, backend: "cf", machineId: null },
  };
}

function assistantMessage(threadId: string, runId: string, id: string, text: string) {
  return {
    id,
    threadId,
    senderSessionId: "assistant",
    seq: 1,
    kind: "chat",
    body: { role: "assistant", runId, text },
    artifactIds: ["plan-1"],
    createdAt: "2026-08-12T00:01:00.000Z",
  };
}

function detail(overrides: Record<string, unknown> = {}) {
  const runs = [reportRun("architecture", 1), reportRun("risk", 2)];
  return {
    invocation: {
      invocationId: "round-1",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      parentThreadId: "skill-root-1",
      status: "active",
      error: null,
      basis: {
        artifactId: "plan-1",
        title: "Plan",
        markdown: "# Frozen plan",
        version: 7,
        gitBaseCommitSha: "abcdef123456",
      },
      definitionSnapshot: {
        id: "review-plan",
        surface: "plan",
        command: "review-plan",
        label: "Plan Review",
        description: "Review the plan.",
        sharedInstructions: "Review carefully.",
        overviewInstructions: "Synthesize the reports.",
        overviewMode: "manual",
        agents: [
          {
            id: "architecture",
            label: "Architecture",
            instructions: "Review architecture.",
            routeKey: "fake",
            effort: "high",
            reportMode: "auto",
          },
          {
            id: "risk",
            label: "Risk",
            instructions: "Review risk.",
            routeKey: "fake",
            effort: "high",
            reportMode: "auto",
          },
        ],
        createdAt: null,
        updatedAt: null,
      },
      overviewMode: "manual",
      includedMessageIds: ["message-architecture"],
      overviewRunId: null,
      overviewRoute: { provider: "fake", model: "fake-fast", effort: "high" },
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:02:00.000Z",
      ...overrides,
    },
    reviewers: [
      { threadId: "thread-architecture", skillAgentId: "architecture" },
      { threadId: "thread-risk", skillAgentId: "risk" },
    ],
    runs,
  } as any;
}

function arrangeTranscripts(currentDetail: ReturnType<typeof detail>) {
  mocks.fetchLatest.mockResolvedValue(currentDetail);
  mocks.fetchMessages.mockImplementation(async (
    _hub: string,
    _repo: string,
    _plan: string,
    threadId: string,
  ) => {
    const agentId = threadId === "thread-architecture" ? "architecture" : "risk";
    return {
      messages: [assistantMessage(
        threadId,
        `run-${agentId}`,
        `message-${agentId}`,
        agentId === "architecture" ? "Architecture report." : "Risk report.",
      )],
      runAttributions: {},
    };
  });
}

function renderOverview(currentDetail: ReturnType<typeof detail>) {
  arrangeTranscripts(currentDetail);
  return render(
    <PlanSkillFanout
      repoId="repo-1"
      planArtifactId="plan-1"
      parentThreadId="skill-root-1"
      initialDetail={currentDetail}
      active
    />,
  );
}

describe("PlanSkillFanout", () => {
  it("does not add an Overview wrapper to a single-agent skill", () => {
    const current = detail();
    current.invocation.definitionSnapshot.agents = [
      current.invocation.definitionSnapshot.agents[0],
    ];
    current.reviewers = [current.reviewers[0]];
    current.runs = [current.runs[0]];

    const { container } = render(
      <PlanSkillFanout
        repoId="repo-1"
        planArtifactId="plan-1"
        parentThreadId="skill-root-1"
        initialDetail={current}
        active={false}
      />,
    );

    expect(container).toHaveTextContent("Plan Review");
    expect(container).toHaveTextContent("Plan snapshot from when this review started");
    expect(container).not.toHaveTextContent("abcdef12");
    expect(screen.queryByText("Overview mode")).not.toBeInTheDocument();
  });

  it("shows the frozen basis and exact Reports selected for a Manual Overview", async () => {
    const current = detail();
    mocks.updateControls.mockImplementation(async (
      _hub: string,
      _repo: string,
      _plan: string,
      _root: string,
      _round: string,
      input: { overviewMode: "auto" | "manual"; includedMessageIds: string[] },
    ) => detail({
      overviewMode: input.overviewMode,
      includedMessageIds: input.includedMessageIds,
    }));
    renderOverview(current);

    expect(await screen.findByText(/Plan snapshot from when this review started/)).toBeInTheDocument();
    expect(screen.queryByText(/abcdef12/)).not.toBeInTheDocument();
    expect(screen.getByText(/2 Reports/)).toBeInTheDocument();
    expect(await screen.findByText("Architecture report.")).toBeInTheDocument();
    expect(screen.getByText("Risk report.")).toBeInTheDocument();

    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.map((checkbox) => checkbox.checked)).toEqual([true, false]);
    fireEvent.click(checkboxes[1]!);

    await waitFor(() => expect(mocks.updateControls).toHaveBeenCalledWith(
      expect.any(String),
      "repo-1",
      "plan-1",
      "skill-root-1",
      "round-1",
      { overviewMode: "manual", includedMessageIds: ["message-architecture", "message-risk"] },
    ));
  });

  it("creates one Manual Overview with optional guidance", async () => {
    const current = detail();
    mocks.createOverview.mockResolvedValue(detail({ overviewRunId: "overview-1" }));
    renderOverview(current);
    await screen.findByText("Architecture report.");

    fireEvent.change(screen.getByLabelText("Optional Overview guidance"), {
      target: { value: "Prioritize rollout safety." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Overview" }));

    await waitFor(() => expect(mocks.createOverview).toHaveBeenCalledWith(
      expect.any(String),
      "repo-1",
      "plan-1",
      "skill-root-1",
      "round-1",
      "Prioritize rollout safety.",
    ));
  });

  it("shares a completed Manual Overview with the Scribe exactly once per click", async () => {
    const current = detail({ overviewRunId: "overview-1", status: "completed" });
    current.runs.push({
      ...reportRun("architecture", 3),
      runId: "overview-1",
      skillAgentId: undefined,
      skillRunRole: "overview",
    });
    renderOverview(current);

    const share = await screen.findByRole("button", { name: "Share with Scribe" });
    fireEvent.click(share);
    await waitFor(() => expect(mocks.shareOverview).toHaveBeenCalledTimes(1));
    expect(mocks.shareOverview).toHaveBeenCalledWith(
      expect.any(String),
      "repo-1",
      "plan-1",
      "skill-root-1",
      "round-1",
    );
  });
});
