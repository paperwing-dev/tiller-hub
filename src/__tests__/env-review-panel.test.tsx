/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addReviewer: vi.fn(),
  cancelInvocation: vi.fn(),
  fetchInvocation: vi.fn(),
  fetchInvocations: vi.fn(),
  fetchMessages: vi.fn(),
  fetchProviders: vi.fn(),
  fetchRun: vi.fn(),
  fetchSkills: vi.fn(),
  fetchState: vi.fn(),
  invokeSkill: vi.fn(),
  markFeedback: vi.fn(),
  removeInvocation: vi.fn(),
  rerunSkill: vi.fn(),
  sendMessage: vi.fn(),
  sendOverview: vi.fn(),
  updateControls: vi.fn(),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    addEnvReviewer: mocks.addReviewer,
    cancelEnvReviewRun: vi.fn(),
    cancelReviewSkillInvocation: mocks.cancelInvocation,
    fetchAgentSkills: mocks.fetchSkills,
    fetchEnvReviewMessages: mocks.fetchMessages,
    fetchEnvReviewRun: mocks.fetchRun,
    fetchEnvReviewState: mocks.fetchState,
    fetchPlannerProviders: mocks.fetchProviders,
    fetchReviewSkillInvocation: mocks.fetchInvocation,
    fetchReviewSkillInvocations: mocks.fetchInvocations,
    invokeReviewSkill: mocks.invokeSkill,
    markEnvReviewFeedback: mocks.markFeedback,
    removeEnvReviewer: vi.fn(),
    removeReviewSkillInvocation: mocks.removeInvocation,
    rerunReviewSkillInvocation: mocks.rerunSkill,
    sendEnvReviewMessage: mocks.sendMessage,
    sendReviewSkillOverview: mocks.sendOverview,
    updateReviewSkillControls: mocks.updateControls,
  };
});

import EnvReviewPanel, {
  formatFeedbackForHarness,
  formatReviewBasis,
  formatReviewBasisSummary,
} from "../EnvReviewPanel";

const providerCapabilities = {
  writer: true,
  reviewer: true,
  chatContinuation: true,
  cancellation: true,
  planDelta: false,
  checklist: false,
};

const providers = [{
  id: "codex",
  displayName: "Codex",
  available: true,
  authStatus: "available" as const,
  disabledReasons: [],
  capabilities: providerCapabilities,
  models: [{ id: "gpt-5.5", displayName: "GPT 5.5", available: true, authStatus: "available" as const }],
  efforts: [
    { id: "low" as const, displayName: "Low" },
    { id: "medium" as const, displayName: "Medium" },
    { id: "high" as const, displayName: "High" },
    { id: "xhigh" as const, displayName: "Extra High" },
  ],
  defaultEffort: "xhigh" as const,
}];

const skillRoutes = [{
  key: "codex:gpt-5.5",
  label: "GPT-5.5",
  harness: "codex" as const,
  provider: "codex",
  model: "gpt-5.5",
  modelId: "gpt-5.5",
  supportedEfforts: ["low", "medium", "high", "xhigh"] as const,
  defaultEffort: "xhigh" as const,
  available: true,
}];

const codeReviewSkill = {
  id: "code-review",
  surface: "review" as const,
  command: "code-review",
  label: "Code Review",
  description: "Three focused implementation reviews.",
  sharedInstructions: "Review the frozen workspace.",
  overviewInstructions: "Deduplicate findings.",
  overviewMode: "auto" as const,
  agents: ["Bug Reviewer", "Simplification Reviewer", "Plan Compliance Reviewer"].map((label, index) => ({
    id: `agent-${index + 1}`,
    label,
    instructions: `Instructions for ${label}.`,
    routeKey: "codex:gpt-5.5",
    effort: "high" as const,
    reportMode: "auto" as const,
  })),
  origin: "builtin" as const,
  customized: false,
  createdAt: null,
  updatedAt: null,
};

const focusedSkill = {
  ...codeReviewSkill,
  id: "focused-review",
  command: "focused-review",
  label: "Focused Review",
  description: "One focused implementation review.",
  overviewInstructions: "",
  overviewMode: "manual" as const,
  agents: [{ ...codeReviewSkill.agents[0]!, label: "Focused Reviewer" }],
};

const baseTab = {
  envSlug: "env-1",
  repoId: "repo-1",
  mainSessionId: "session-1",
  provider: "codex",
  model: "gpt-5.5",
  effort: "xhigh" as const,
  taskKind: "custom" as const,
  customTask: null,
  latestRunId: null,
  removedAt: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:00:00.000Z",
};

const genericTab = {
  ...baseTab,
  threadId: "generic-1",
  roleLabel: "Reviewer",
  status: "idle" as const,
  skillInvocationId: null,
  skillAgentId: null,
  nodeKind: "generic" as const,
  skillRootThreadId: null,
};

function skillTabs(single = false) {
  const root = {
    ...baseTab,
    threadId: single ? "focused-root" : "code-review-root",
    roleLabel: single ? "Focused Review" : "Code Review",
    status: "ready" as const,
    latestRunId: single ? "focused-initial" : null,
    skillInvocationId: single ? "focused-round" : "code-review-round",
    skillAgentId: single ? "agent-1" : null,
    nodeKind: "skill_root" as const,
    skillRootThreadId: single ? "focused-root" : "code-review-root",
  };
  if (single) return [root];
  return [
    root,
    ...codeReviewSkill.agents.map((agent, index) => ({
      ...baseTab,
      threadId: `report-${index + 1}`,
      roleLabel: agent.label,
      status: "ready" as const,
      latestRunId: `report-run-${index + 1}`,
      skillInvocationId: "code-review-round",
      skillAgentId: agent.id,
      nodeKind: "report" as const,
      skillRootThreadId: "code-review-root",
    })),
  ];
}

function runFor(tab: ReturnType<typeof skillTabs>[number], role: "root_initial" | "report_initial") {
  return {
    runId: tab.latestRunId,
    threadId: tab.threadId,
    envSlug: "env-1",
    repoId: "repo-1",
    mainSessionId: "session-1",
    provider: tab.provider,
    model: tab.model,
    effort: tab.effort,
    roleLabel: tab.roleLabel,
    taskKind: "custom" as const,
    customTask: null,
    recipeInstructions: null,
    status: "ready" as const,
    preparationOpId: "snapshot-op",
    preparation: null,
    changeContext: null,
    planBasis: null,
    prompt: "Review the implementation.",
    runtime: null,
    startedAt: "2026-08-12T00:00:00.000Z",
    queuedAt: "2026-08-12T00:00:00.000Z",
    completedAt: "2026-08-12T00:01:00.000Z",
    error: null,
    lastContactAt: null,
    skillInvocationId: tab.skillInvocationId,
    skillAgentId: tab.skillAgentId,
    skillRunRole: role,
    skillDefinitionSnapshot: singleDefinition(role),
    frozenOverview: null,
  };
}

function singleDefinition(role: string) {
  return role === "root_initial" ? focusedSkill : codeReviewSkill;
}

function emptyState() {
  return {
    session: {
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      latestPreparationOpId: null,
      latestPreparation: null,
      latestChangeSummary: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    },
    tabs: [],
    runs: [],
    feedback: [],
  };
}

function multiDetail() {
  const tabs = skillTabs(false);
  const reports = tabs.slice(1);
  return {
    kind: "skill_root" as const,
    invocation: {
      invocationId: "code-review-round",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "code-review-root",
      definitionSnapshot: codeReviewSkill,
      preparationOpId: "snapshot-op",
      status: "active" as const,
      overviewMode: "auto" as const,
      includedMessageIds: ["report-message-1"],
      overviewRunId: null,
      overviewRoute: { provider: "codex", model: "gpt-5.5", effort: "xhigh" as const },
      error: null,
      cancelledAt: null,
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:01:00.000Z",
    },
    tabs: reports,
    runs: reports.map((tab) => runFor(tab, "report_initial")),
  };
}

function singleDetail() {
  const root = skillTabs(true)[0]!;
  return {
    kind: "skill_root" as const,
    invocation: {
      ...multiDetail().invocation,
      invocationId: "focused-round",
      parentThreadId: root.threadId,
      definitionSnapshot: focusedSkill,
      overviewMode: "manual" as const,
      includedMessageIds: [],
      overviewRoute: null,
      status: "completed" as const,
    },
    tabs: [root],
    runs: [runFor(root, "root_initial")],
  };
}

function invocationSummary(detail: ReturnType<typeof multiDetail> | ReturnType<typeof singleDetail>) {
  return {
    invocationId: detail.invocation.invocationId,
    parentThreadId: detail.invocation.parentThreadId,
    command: detail.invocation.definitionSnapshot.command,
    label: detail.invocation.definitionSnapshot.label,
    status: detail.invocation.status,
    agentCount: detail.invocation.definitionSnapshot.agents.length,
    overviewMode: detail.invocation.overviewMode,
    overviewRunId: detail.invocation.overviewRunId,
    createdAt: detail.invocation.createdAt,
    updatedAt: detail.invocation.updatedAt,
  };
}

function stateWithTabs(tabs: ReturnType<typeof skillTabs>) {
  return {
    ...emptyState(),
    tabs,
    runs: tabs.filter((tab) => tab.latestRunId).map((tab) => runFor(
      tab,
      tab.nodeKind === "report" ? "report_initial" : "root_initial",
    )),
  };
}

function renderPanel() {
  return render(
    <EnvReviewPanel
      envSlug="env-1"
      repoId="repo-1"
      sessionId="session-1"
      hubUrl="https://hub.test"
      harnessInputReady
      onSendToHarness={vi.fn(async () => ({ ok: true }))}
    />,
  );
}

async function invokeSlash(command: string) {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: `/${command}` } });
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(`/${command}`, "i") }));
}

beforeEach(() => {
  vi.resetAllMocks();
  HTMLElement.prototype.scrollTo = vi.fn();
  window.localStorage.clear();
  window.sessionStorage.clear();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.fetchState.mockResolvedValue(emptyState());
  mocks.fetchProviders.mockResolvedValue({ providers, skillRoutes });
  mocks.fetchSkills.mockResolvedValue([codeReviewSkill, focusedSkill]);
  mocks.fetchInvocations.mockResolvedValue({ invocations: [], nextCursor: null });
  mocks.fetchMessages.mockResolvedValue([]);
  mocks.fetchRun.mockRejectedValue(new Error("run polling not configured"));
  mocks.addReviewer.mockResolvedValue({ ...emptyState(), tabs: [genericTab] });
  mocks.markFeedback.mockResolvedValue({});
  mocks.removeInvocation.mockResolvedValue({ parentThreadId: "code-review-root", state: emptyState() });
  mocks.cancelInvocation.mockResolvedValue({
    ...multiDetail().invocation,
    status: "cancelled",
    cancelledAt: "2026-08-12T00:02:00.000Z",
  });
  mocks.updateControls.mockResolvedValue(multiDetail().invocation);
  mocks.sendOverview.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("review basis copy", () => {
  const snapshot = {
    snapshotId: "snapshot-1",
    source: "live-harness" as const,
    mode: "full" as const,
    stale: false,
    createdAt: "2026-08-09T04:07:00.000Z",
    snapshotHash: "hash-1",
    baseCommitSha: null,
    githubDeletedPaths: [],
    r2Key: "snapshots/snapshot-1.tar",
  };

  it("labels a current live snapshot without a stale warning", () => {
    expect(formatReviewBasis(snapshot)).toContain("Review basis: live workspace snapshot captured");
    expect(formatReviewBasis(snapshot)).not.toContain("latest changes from the live workspace");
  });

  it("warns only when a saved snapshot is stale", () => {
    expect(formatReviewBasis({ ...snapshot, source: "saved-workspace", stale: true }))
      .toContain("It may not include the latest changes from the live workspace.");
  });

  it("reduces visible review metadata to the changed-file count", () => {
    const run = {
      ...runFor(skillTabs(true)[0]!, "root_initial"),
      preparation: { snapshot },
      changeContext: {
        summary: { total: 4, added: 1, modified: 2, deleted: 1, omitted: 0, truncated: 0 },
      },
    };
    expect(formatReviewBasisSummary(run as any)).toBe("4 files changed");
    expect(formatReviewBasisSummary({
      ...run,
      preparation: { snapshot: { ...snapshot, stale: true } },
    } as any)).toBe("4 files changed · Snapshot may be out of date");
  });
});

describe("Implementation Review workspace", () => {
  it("opens on a lazy home with a central composer and right-side reviewer rail", async () => {
    renderPanel();
    expect(await screen.findByText("Ask a code-aware question or type / to run a Review skill.")).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Reviewers" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add reviewer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reviewer skill settings" })).toBeInTheDocument();
  });

  it("adds a reusable generic reviewer with the selected default model and effort", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Add reviewer" }));
    const popover = await screen.findByText("Start a reusable reviewer conversation or launch a saved skill.");
    const surface = popover.closest("div")?.parentElement ?? document.body;
    await user.click(within(surface).getByRole("button", { name: "Add reviewer" }));

    await waitFor(() => expect(mocks.addReviewer).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      { sessionId: "session-1", provider: "codex", model: "gpt-5.5", effort: "xhigh" },
    ));
  });

  it("lists saved skills with descriptions and agent counts in the plus menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Add reviewer" }));
    expect(await screen.findByText("Three focused implementation reviews.")).toBeInTheDocument();
    expect(screen.getByText("3 agents")).toBeInTheDocument();
    expect(screen.getByText("1 agent")).toBeInTheDocument();
  });

  it("launches a slash skill directly without creating a generic reviewer", async () => {
    const detail = multiDetail();
    const tabs = skillTabs(false);
    mocks.invokeSkill.mockResolvedValue(detail);
    mocks.fetchInvocation.mockResolvedValue(detail);
    mocks.fetchState
      .mockResolvedValueOnce(emptyState())
      .mockResolvedValue(stateWithTabs(tabs));
    mocks.fetchInvocations
      .mockResolvedValueOnce({ invocations: [], nextCursor: null })
      .mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
    renderPanel();

    await invokeSlash("code-review");

    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "code-review",
      expect.objectContaining({ sessionId: "session-1", overviewMode: "auto" }),
    ));
    expect(mocks.addReviewer).not.toHaveBeenCalled();
  });

  it("launches the same root contract from the plus menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const detail = multiDetail();
    mocks.invokeSkill.mockImplementation(async () => {
      mocks.fetchState.mockResolvedValue(stateWithTabs(skillTabs(false)));
      mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
      return detail;
    });
    mocks.fetchInvocation.mockResolvedValue(detail);
    mocks.fetchState.mockResolvedValue(emptyState());
    mocks.fetchInvocations.mockResolvedValue({ invocations: [], nextCursor: null });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Add reviewer" }));
    const description = await screen.findByText("Three focused implementation reviews.");
    await user.click(description.closest("button")!);

    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "code-review",
      expect.objectContaining({ sessionId: "session-1", overviewMode: "auto" }),
    ));
  });

  it("shows a multi-agent skill as an Overview root with Reports collapsed initially", async () => {
    const detail = multiDetail();
    const tabs = skillTabs(false);
    mocks.fetchState.mockResolvedValue(stateWithTabs(tabs));
    mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(detail);
    renderPanel();

    const rail = await screen.findByRole("tree", { name: "Reviewer conversations" });
    expect(within(rail).getByRole("treeitem", { name: "Code Review" })).toBeInTheDocument();
    expect(within(rail).queryByRole("treeitem", { name: "Bug Reviewer" })).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Expand Code Review Reports" }));
    expect(within(rail).getByRole("treeitem", { name: "Bug Reviewer" })).toBeInTheDocument();
    expect(within(rail).getByRole("treeitem", { name: "Simplification Reviewer" })).toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("treeitem", { name: "Code Review" }));
    for (const control of rail.querySelectorAll<HTMLButtonElement>('button:not([role="treeitem"])')) {
      expect(control.tabIndex).toBe(-1);
    }
    expect(await screen.findByText("1 of 3 agent responses included.")).toBeInTheDocument();
    expect(screen.queryByText("Results")).not.toBeInTheDocument();
  });

  it("stops an active multi-agent review from the Plan-style row menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const readyDetail = multiDetail();
    const detail = {
      ...readyDetail,
      runs: readyDetail.runs.map((run, index) => index === 0
        ? { ...run, status: "running" as const }
        : run),
    };
    const tabs = skillTabs(false).map((tab, index) => index === 1
      ? { ...tab, status: "running" as const }
      : tab);
    mocks.fetchState.mockResolvedValue(stateWithTabs(tabs));
    mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(detail);
    renderPanel();

    const root = await screen.findByRole("treeitem", { name: "Code Review" });
    await user.click(root);
    const runStatus = await screen.findByTestId("reviewer-run-status");
    expect(runStatus.closest(".tiller-skill-composer")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Message" })).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Actions for Code Review" }));
    await user.click(await screen.findByRole("menuitem", { name: "Stop review" }));

    await waitFor(() => expect(mocks.cancelInvocation).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "code-review-round",
      "session-1",
    ));
  });

  it("stops the active round even while an older round is selected", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const currentDetail = {
      ...multiDetail(),
      invocation: {
        ...multiDetail().invocation,
        invocationId: "code-review-round-current",
      },
    };
    const olderDetail = {
      ...multiDetail(),
      invocation: {
        ...multiDetail().invocation,
        invocationId: "code-review-round-older",
        status: "completed" as const,
        createdAt: "2026-08-11T00:00:00.000Z",
      },
    };
    mocks.fetchState.mockResolvedValue(stateWithTabs(skillTabs(false)));
    mocks.fetchInvocations.mockResolvedValue({
      invocations: [invocationSummary(currentDetail), invocationSummary(olderDetail)],
      nextCursor: null,
    });
    mocks.fetchInvocation.mockImplementation(async (_hubUrl, _envSlug, _sessionId, invocationId) => (
      invocationId === "code-review-round-older" ? olderDetail : currentDetail
    ));
    renderPanel();

    await user.click(await screen.findByRole("treeitem", { name: "Code Review" }));
    const history = await screen.findByRole("combobox", { name: "Implementation Review round history" });
    await user.selectOptions(history, "code-review-round-older");
    await waitFor(() => expect(mocks.fetchInvocation).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "session-1",
      "code-review-round-older",
    ));
    await user.click(await screen.findByRole("button", { name: "Actions for Code Review" }));
    await user.click(await screen.findByRole("menuitem", { name: "Stop review" }));

    await waitFor(() => expect(mocks.cancelInvocation).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "code-review-round-current",
      "session-1",
    ));
    expect(mocks.removeInvocation).not.toHaveBeenCalled();
  });

  it("removes a finished multi-agent review from the same row menu", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const active = multiDetail();
    const detail = {
      ...active,
      invocation: { ...active.invocation, status: "completed" as const },
    };
    const tabs = skillTabs(false);
    mocks.fetchState.mockResolvedValue(stateWithTabs(tabs));
    mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(detail);
    renderPanel();

    await user.click(await screen.findByRole("treeitem", { name: "Code Review" }));
    await user.click(await screen.findByRole("button", { name: "Actions for Code Review" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove review" }));

    await waitFor(() => expect(mocks.removeInvocation).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "code-review-round",
      "session-1",
    ));
  });

  it("trusts a terminal invocation list row over stale active detail", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const staleDetail = multiDetail();
    const terminalSummary = {
      ...invocationSummary(staleDetail),
      status: "cancelled" as const,
    };
    mocks.fetchState.mockResolvedValue(stateWithTabs(skillTabs(false)));
    mocks.fetchInvocations.mockResolvedValue({ invocations: [terminalSummary], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(staleDetail);
    renderPanel();

    await user.click(await screen.findByRole("treeitem", { name: "Code Review" }));
    await user.click(await screen.findByRole("button", { name: "Actions for Code Review" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove review" }));

    await waitFor(() => expect(mocks.removeInvocation).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "code-review-round",
      "session-1",
    ));
    expect(mocks.cancelInvocation).not.toHaveBeenCalled();
  });

  it("shows a single-agent skill as one standalone skill-named conversation", async () => {
    const detail = singleDetail();
    const tabs = skillTabs(true);
    mocks.fetchState.mockResolvedValue(stateWithTabs(tabs));
    mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(detail);
    mocks.fetchMessages.mockResolvedValue([{
      id: "focused-message",
      threadId: "focused-root",
      seq: 1,
      senderSessionId: "assistant",
      kind: "chat",
      body: { role: "assistant", runId: "focused-initial", text: "Focused finding." },
      createdAt: "2026-08-12T00:01:00.000Z",
    }]);
    renderPanel();

    const focusedReview = await screen.findByRole("treeitem", { name: "Focused Review" });
    expect(focusedReview).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Expand Focused Review/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Overview synthesis mode" })).not.toBeInTheDocument();
    fireEvent.click(focusedReview);
    expect(await screen.findByText("Focused finding.")).toBeInTheDocument();
  });

  it("keeps the changed-file count in the selected reviewer header", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const detail = singleDetail();
    const tabs = skillTabs(true);
    const run = {
      ...detail.runs[0]!,
      preparation: {
        snapshot: {
          snapshotId: "snapshot-1",
          source: "live-harness" as const,
          mode: "full" as const,
          stale: false,
          createdAt: "2026-08-09T04:07:00.000Z",
          snapshotHash: "hash-1",
          baseCommitSha: null,
          githubDeletedPaths: [],
          r2Key: "snapshots/snapshot-1.tar",
        },
      },
      changeContext: {
        summary: { total: 4, added: 1, modified: 2, deleted: 1, omitted: 0, truncated: 0 },
      },
    };
    const nextDetail = { ...detail, runs: [run] };
    mocks.fetchState.mockResolvedValue({ ...stateWithTabs(tabs), runs: [run] });
    mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(nextDetail)], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(nextDetail);
    renderPanel();

    await user.click(await screen.findByRole("treeitem", { name: "Focused Review" }));
    expect(await screen.findByText(/4 files changed/)).toBeInTheDocument();
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
  });

  it("creates a generic reviewer from plain prose on the lazy home", async () => {
    const run = {
      ...runFor({ ...genericTab, latestRunId: "generic-run" } as any, "root_initial"),
      skillInvocationId: null,
      skillAgentId: null,
      skillRunRole: null,
      status: "preparing" as const,
    };
    mocks.sendMessage.mockResolvedValue({
      run,
      messages: [],
      state: { ...emptyState(), tabs: [{ ...genericTab, latestRunId: run.runId, status: "preparing" }], runs: [run] },
    });
    renderPanel();
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Check the implementation." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      null,
      expect.objectContaining({
        sessionId: "session-1",
        text: "Check the implementation.",
        requestId: expect.any(String),
      }),
    ));
  });

  it("binds Report follow-ups to the selected immutable round", async () => {
    const detail = multiDetail();
    const tabs = skillTabs(false);
    mocks.fetchState.mockResolvedValue(stateWithTabs(tabs));
    mocks.fetchInvocations.mockResolvedValue({ invocations: [invocationSummary(detail)], nextCursor: null });
    mocks.fetchInvocation.mockResolvedValue(detail);
    mocks.fetchMessages.mockResolvedValue([]);
    mocks.sendMessage.mockResolvedValue({ run: null, messages: [], state: stateWithTabs(tabs) });
    renderPanel();
    const rail = await screen.findByRole("tree", { name: "Reviewer conversations" });
    fireEvent.click(within(rail).getByRole("button", { name: "Expand Code Review Reports" }));
    fireEvent.click(within(rail).getByRole("treeitem", { name: "Bug Reviewer" }));
    const composer = await screen.findByRole("textbox", { name: "Message" });
    fireEvent.change(composer, { target: { value: "Verify the remaining issue." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(mocks.sendMessage).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "report-1",
      {
        sessionId: "session-1",
        text: "Verify the remaining issue.",
        expectedRoundId: "code-review-round",
      },
    ));
  });

  it("uses resizing instead of a separate collapse control", async () => {
    renderPanel();
    expect(await screen.findByRole("separator", { name: "Resize terminal and Review" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Review" })).toBeInTheDocument();
  });
});

describe("implementation handoff formatting", () => {
  it("attributes ordinary feedback to its reviewer route", () => {
    expect(formatFeedbackForHarness({
      roleLabel: "Bug Reviewer",
      provider: "codex",
      model: "gpt-5.5",
      metadata: null,
    } as any, "Fix the race.")).toContain("Bug Reviewer (codex/gpt-5.5)");
  });

  it("attributes a synthesized Overview to all frozen Report routes", () => {
    const text = formatFeedbackForHarness({
      roleLabel: "Code Review Overview",
      provider: "codex",
      model: "gpt-5.5",
      metadata: {
        reviewHandoff: {
          schemaVersion: 1,
          kind: "fanout_overview",
          skillLabel: "Code Review",
          reviewerCount: 2,
          models: [
            { provider: "codex", model: "gpt-5.5" },
            { provider: "opencode", model: "kimi" },
          ],
        },
      },
    } as any, "Fix the race.");
    expect(text).toContain("synthesized from 2 reviewers (codex/gpt-5.5 and opencode/kimi)");
  });
});
