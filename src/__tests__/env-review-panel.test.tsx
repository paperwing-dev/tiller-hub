/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchState: vi.fn(),
  fetchProviders: vi.fn(),
  fetchSkills: vi.fn(),
  fetchInvocations: vi.fn(),
  fetchInvocation: vi.fn(),
  fetchMessages: vi.fn(),
  fetchRun: vi.fn(),
  addReviewer: vi.fn(),
  invokeSkill: vi.fn(),
  updateControls: vi.fn(),
  sendOverview: vi.fn(),
  updateSkill: vi.fn(),
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    addEnvReviewer: mocks.addReviewer,
    cancelEnvReviewRun: vi.fn(),
    fetchEnvReviewMessages: mocks.fetchMessages,
    fetchEnvReviewRun: mocks.fetchRun,
    fetchEnvReviewState: mocks.fetchState,
    fetchAgentSkills: mocks.fetchSkills,
    fetchPlannerProviders: mocks.fetchProviders,
    fetchReviewSkillInvocations: mocks.fetchInvocations,
    fetchReviewSkillInvocation: mocks.fetchInvocation,
    invokeReviewSkill: mocks.invokeSkill,
    markEnvReviewFeedback: vi.fn(),
    removeEnvReviewer: vi.fn(),
    sendEnvReviewMessage: vi.fn(),
    sendReviewSkillOverview: mocks.sendOverview,
    updateReviewSkillControls: mocks.updateControls,
    updateAgentSkill: mocks.updateSkill,
  };
});

import EnvReviewPanel from "../EnvReviewPanel";
import { ApiActionError, type EnvReviewTab } from "../api";

const emptyState = {
  session: {
    envSlug: "env-1",
    repoId: "repo-1",
    mainSessionId: "session-1",
    latestPreparationOpId: null,
    latestPreparation: null,
    latestChangeSummary: null,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  },
  tabs: [],
  runs: [],
  feedback: [],
};

const providerCapabilities = {
  writer: true,
  reviewer: true,
  chatContinuation: true,
  cancellation: true,
  planDelta: false,
  checklist: false,
};

const providers = [
  {
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
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    available: true,
    authStatus: "available" as const,
    disabledReasons: [],
    capabilities: providerCapabilities,
    models: [{ id: "sonnet", displayName: "Claude Sonnet 4.6", available: true, authStatus: "available" as const }],
    efforts: [
      { id: "low" as const, displayName: "Low" },
      { id: "medium" as const, displayName: "Medium" },
      { id: "high" as const, displayName: "High" },
      { id: "xhigh" as const, displayName: "Extra High" },
      { id: "max" as const, displayName: "Max" },
    ],
    defaultEffort: "high" as const,
  },
  {
    id: "opencode",
    displayName: "OpenCode",
    available: true,
    authStatus: "available" as const,
    disabledReasons: [],
    capabilities: providerCapabilities,
    models: [{ id: "kimi", displayName: "Kimi K2.7 Code", available: true, authStatus: "available" as const }],
    efforts: [
      { id: "low" as const, displayName: "Low" },
      { id: "medium" as const, displayName: "Medium" },
      { id: "high" as const, displayName: "High" },
    ],
    defaultEffort: "high" as const,
  },
];

const skillRoutes = [
  {
    key: "codex:gpt-5.5",
    label: "GPT-5.5",
    harness: "codex" as const,
    provider: "codex",
    model: "gpt-5.5",
    modelId: "gpt-5.5",
    supportedEfforts: ["low", "medium", "high", "xhigh"] as const,
    defaultEffort: "xhigh" as const,
    available: true,
  },
  {
    key: "opencode:kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    harness: "opencode" as const,
    provider: "opencode",
    model: "kimi",
    modelId: "kimi-k2.7-code",
    supportedEfforts: ["low", "medium", "high"] as const,
    defaultEffort: "high" as const,
    available: true,
  },
];

const codeReviewSkill = {
  id: "code-review",
  surface: "review" as const,
  command: "code-review",
  label: "Code Review",
  description: "Three focused reviews.",
  sharedInstructions: "Review the frozen workspace.",
  overviewInstructions: "Deduplicate findings.",
  overviewMode: "auto" as const,
  agents: ["Bug Reviewer", "Simplification Reviewer", "Plan Compliance Reviewer"].map((label, index) => ({
    id: `agent-${index + 1}`,
    label,
    instructions: `Instructions for ${label}.`,
    routeKey: "opencode:kimi-k2.7-code",
    effort: "high" as const,
    reportMode: "auto" as const,
  })),
  origin: "builtin" as const,
  customized: false,
  createdAt: null,
  updatedAt: null,
};

const idleParent = {
  threadId: "parent-1",
  envSlug: "env-1",
  repoId: "repo-1",
  mainSessionId: "session-1",
  provider: "codex",
  model: "gpt-5.5",
  effort: "xhigh" as const,
  roleLabel: "Reviewer",
  taskKind: "correctness" as const,
  customTask: null,
  status: "idle" as const,
  latestRunId: null,
  removedAt: null,
  createdAt: "2026-07-09T00:00:00.000Z",
  updatedAt: "2026-07-09T00:00:00.000Z",
  skillInvocationId: null,
  skillAgentId: null,
};

function makeFanoutDetail(options: { overviewMode?: "auto" | "manual"; overviewRunId?: string | null } = {}) {
  const tabs = codeReviewSkill.agents.map((agent, index) => ({
    ...idleParent,
    threadId: `child-${index + 1}`,
    provider: "opencode",
    model: "kimi",
    effort: "high" as const,
    roleLabel: agent.label,
    status: "ready" as const,
    latestRunId: `child-run-${index + 1}`,
    skillInvocationId: "invocation-1",
    skillAgentId: agent.id,
  }));
  const runs: any[] = tabs.map((tab, index) => ({
    runId: `child-run-${index + 1}`,
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
    status: "ready" as const,
    prompt: "Review the frozen workspace.",
    preparation: null,
    changeContext: null,
    planBasis: null,
    runtime: null,
    error: null,
    skillInvocationId: "invocation-1",
    skillAgentId: tab.skillAgentId,
    skillRunRole: "child_initial" as const,
  }));
  const overviewRunId = options.overviewRunId ?? null;
  if (overviewRunId) {
    runs.push({
      ...runs[0]!,
      runId: overviewRunId,
      threadId: "parent-1",
      roleLabel: "Overview",
      skillAgentId: null,
      skillRunRole: "overview",
    });
  }
  return {
    kind: "fanout" as const,
    invocation: {
      invocationId: "invocation-1",
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      parentThreadId: "parent-1",
      definitionSnapshot: codeReviewSkill,
      preparationOpId: "op-1",
      status: overviewRunId ? "completed" as const : "active" as const,
      overviewMode: options.overviewMode ?? "auto",
      includedMessageIds: ["message-1"],
      overviewRunId,
      error: null,
      cancelledAt: null,
      createdAt: "2026-07-09T00:00:00.000Z",
      updatedAt: "2026-07-09T00:00:00.000Z",
    },
    tabs,
    runs,
  };
}

function renderPanel(options: { connected?: boolean; onSend?: (text: string) => Promise<{ ok: boolean; error?: string }> } = {}) {
  return render(
    <EnvReviewPanel
      envSlug="env-1"
      repoId="repo-1"
      sessionId="session-1"
      hubUrl="https://hub.test"
      harnessInputReady={options.connected ?? true}
      onSendToHarness={options.onSend ?? vi.fn(async () => ({ ok: true }))}
    />,
  );
}

function rect(height: number): DOMRect {
  return {
    x: 0,
    y: 0,
    width: 900,
    height,
    top: 0,
    right: 900,
    bottom: height,
    left: 0,
    toJSON: () => ({}),
  };
}

function mockPanelGeometry(getContainerHeight: () => number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const element = this;
    if (element.dataset.testid === "env-review-panel") {
      return rect(Number.parseFloat(element.style.height) || 0);
    }
    if ((element.firstElementChild as HTMLElement | null)?.dataset.testid === "env-review-panel") {
      return rect(getContainerHeight());
    }
    return rect(0);
  });
}

function installResizeObserver(): { notify: () => void } {
  let callback: ResizeObserverCallback | null = null;
  vi.stubGlobal("ResizeObserver", class {
    constructor(nextCallback: ResizeObserverCallback) {
      callback = nextCallback;
    }

    observe() {}
    disconnect() {}
    unobserve() {}
  });
  return {
    notify: () => callback?.([], {} as ResizeObserver),
  };
}

function threadMessage(id: string, text: string) {
  return {
    id,
    threadId: "parent-1",
    seq: Number(id.replace(/\D/g, "")) || 1,
    senderSessionId: "assistant",
    kind: "chat" as const,
    body: { role: "assistant", text },
    createdAt: "2026-07-09T00:00:00.000Z",
  };
}

function reviewRunFor(
  tab: Pick<EnvReviewTab, "threadId" | "provider" | "model" | "effort" | "roleLabel" | "taskKind" | "customTask" | "skillInvocationId" | "skillAgentId">,
  status: "preparing" | "queued" | "running" | "ready" | "failed" | "cancelled",
  runId: string,
) {
  return {
    runId,
    threadId: tab.threadId,
    envSlug: "env-1",
    repoId: "repo-1",
    mainSessionId: "session-1",
    provider: tab.provider,
    model: tab.model,
    effort: tab.effort,
    roleLabel: tab.roleLabel,
    taskKind: tab.taskKind,
    customTask: tab.customTask,
    recipeInstructions: null,
    status,
    preparationOpId: "op-1",
    preparation: null,
    changeContext: null,
    planBasis: null,
    prompt: "Review the implementation.",
    runtime: null,
    startedAt: "2026-07-09T00:00:01.000Z",
    queuedAt: "2026-07-09T00:00:01.000Z",
    completedAt: status === "ready" || status === "failed" || status === "cancelled"
      ? "2026-07-09T00:00:02.000Z"
      : null,
    error: status === "failed" ? "Reviewer failed." : null,
    lastContactAt: null,
    skillInvocationId: tab.skillInvocationId,
    skillAgentId: tab.skillAgentId,
    skillRunRole: null,
    skillDefinitionSnapshot: null,
    frozenOverview: null,
  };
}

async function openSkillCommand(command = "code-review") {
  const composer = await screen.findByRole("textbox", { name: "Message" });
  fireEvent.change(composer, { target: { value: `/${command}` } });
  return screen.findByRole("button", { name: new RegExp(`/${command}`, "i") });
}

describe("EnvReviewPanel actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    HTMLElement.prototype.scrollTo = vi.fn();
    window.localStorage.clear();
    window.sessionStorage.clear();
    mocks.fetchState.mockResolvedValue(emptyState);
    mocks.fetchProviders.mockResolvedValue({ providers, skillRoutes });
    mocks.fetchSkills.mockResolvedValue([codeReviewSkill]);
    mocks.fetchInvocations.mockResolvedValue({ invocations: [], nextCursor: null });
    mocks.fetchMessages.mockResolvedValue([]);
    mocks.fetchRun.mockRejectedValue(new Error("run polling not configured"));
    mocks.addReviewer.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.fetchInvocation.mockResolvedValue(makeFanoutDetail());
    mocks.updateControls.mockImplementation(async (_hub, _env, _invocationId, input) => ({
      ...makeFanoutDetail({ overviewMode: input.overviewMode }).invocation,
      includedMessageIds: input.includedMessageIds,
    }));
    mocks.sendOverview.mockResolvedValue({});
    mocks.updateSkill.mockImplementation(async (_hub, _repo, _surface, _id, draft) => ({
      ...codeReviewSkill,
      ...draft,
      customized: true,
    }));
    mocks.invokeSkill.mockResolvedValue({
      kind: "fanout",
      invocation: {
        invocationId: "invocation-1",
        envSlug: "env-1",
        repoId: "repo-1",
        mainSessionId: "session-1",
        parentThreadId: "parent-1",
        definitionSnapshot: codeReviewSkill,
        preparationOpId: "op-1",
        status: "active",
        overviewMode: "auto",
        includedMessageIds: [],
        overviewRunId: null,
        error: null,
        cancelledAt: null,
        createdAt: "2026-07-09T00:00:00.000Z",
        updatedAt: "2026-07-09T00:00:00.000Z",
      },
      tabs: [],
      runs: [],
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds a reviewer with the selected reasoning effort", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();

    await user.click(await screen.findByRole("button", { name: "Add reviewer" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Model")).toHaveTextContent("GPT 5.5");
    expect(within(dialog).getByLabelText("Effort")).toHaveTextContent("Extra High");

    await user.click(within(dialog).getByLabelText("Effort"));
    await user.click(await screen.findByRole("option", { name: "Low" }));
    await user.click(within(dialog).getByRole("button", { name: "Add reviewer" }));

    await waitFor(() => expect(mocks.addReviewer).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      {
        sessionId: "session-1",
        provider: "codex",
        model: "gpt-5.5",
        effort: "low",
      },
    ));
  });

  it("shows thinking and concrete model activity for an active run", async () => {
    const activeTab = {
      ...idleParent,
      status: "running" as const,
      latestRunId: "run-private",
    };
    const activeRun = {
      runId: "run-private",
      threadId: activeTab.threadId,
      envSlug: "env-1",
      repoId: "repo-1",
      mainSessionId: "session-1",
      provider: "codex",
      model: "gpt-5.5",
      effort: "xhigh" as const,
      roleLabel: "Reviewer",
      taskKind: "correctness" as const,
      customTask: null,
      status: "running" as const,
      prompt: "Review privately.",
      preparation: null,
      changeContext: null,
      planBasis: null,
      runtime: null,
      error: null,
    };
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [activeTab], runs: [activeRun] });
    mocks.fetchRun.mockResolvedValue({
      run: activeRun,
      events: [
        { runId: "run-private", seq: 1, type: "model_activity", message: "Thinking" },
        { runId: "run-private", seq: 2, type: "model_activity", message: "Read: packages/hub/src/EnvReviewPanel.tsx" },
      ],
    });

    renderPanel();

    expect(await screen.findByText("Reviewer is working...")).toBeInTheDocument();
    await waitFor(() => expect(mocks.fetchRun).toHaveBeenCalled());
    expect(await screen.findAllByText("Read: packages/hub/src/EnvReviewPanel.tsx")).toHaveLength(2);
    expect(screen.getByText("Activity")).toBeInTheDocument();
  });

  it("uses the shared new-result indicator and keeps a viewed marker after opening it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const readyTab = {
      ...idleParent,
      threadId: "ready-1",
      roleLabel: "Tests Reviewer",
      status: "ready" as const,
      latestRunId: "ready-run-1",
    };
    const readyRun = reviewRunFor(readyTab, "ready", "ready-run-1");
    mocks.fetchState.mockResolvedValue({
      ...emptyState,
      tabs: [idleParent, readyTab],
      runs: [readyRun],
    });

    renderPanel();

    const newResultTab = await screen.findByRole("button", { name: "Tests Reviewer, New result" });
    expect(newResultTab.querySelector('[data-agent-tab-status="finished"]')).toHaveClass("bg-kumo-info");
    expect(screen.getByRole("button", { name: "Reviewer, Ready" })
      .querySelector('[data-agent-tab-status="idle"]')).not.toBeNull();

    await user.click(newResultTab);

    const viewedTab = await screen.findByRole("button", { name: "Tests Reviewer, Viewed" });
    expect(viewedTab.querySelector('[data-agent-tab-status="viewed"]')).toHaveClass("text-kumo-subtle");
  });

  it("invokes the editable Code Review skill with the selected idle reviewer as parent", async () => {
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    renderPanel();

    expect(screen.queryByRole("button", { name: "/code-review" })).not.toBeInTheDocument();
    const reviewButton = await openSkillCommand();
    await waitFor(() => expect(reviewButton).toBeEnabled());
    fireEvent.click(reviewButton);

    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "parent-1",
      "code-review",
      expect.objectContaining({
        sessionId: "session-1",
        requestId: expect.any(String),
        overviewMode: "auto",
      }),
    ));
    expect(screen.queryByRole("button", { name: "Code Review" })).not.toBeInTheDocument();
  });

  it("opens a fanout on the prototype Overview row and lazy-loads child transcripts", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const detail = makeFanoutDetail();
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.invokeSkill.mockResolvedValue(detail);
    mocks.fetchInvocation.mockResolvedValue(detail);
    renderPanel();

    await user.click(await openSkillCommand());

    const nestedRow = await screen.findByTestId("review-skill-tab-row");
    expect(screen.queryByText("Skill history")).not.toBeInTheDocument();
    expect(nestedRow).toHaveTextContent("/code-review");
    expect(within(nestedRow).getByRole("button", { name: "Overview, Working" })).toBeInTheDocument();
    expect(within(nestedRow).getByRole("button", { name: /Bug Reviewer, New result/ })).toBeInTheDocument();
    expect(await screen.findByText("1 of 3 agent responses included.")).toBeInTheDocument();

    const detailLoads = mocks.fetchInvocation.mock.calls.length;
    await user.click(within(nestedRow).getByRole("button", { name: /Bug Reviewer, New result/ }));
    await waitFor(() => expect(mocks.fetchMessages).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "child-1",
      "session-1",
    ));
    await user.click(within(nestedRow).getByRole("button", { name: "Overview, Working" }));
    expect(await screen.findByText("1 of 3 agent responses included.")).toBeInTheDocument();
    expect(mocks.fetchInvocation).toHaveBeenCalledTimes(detailLoads);
  });

  it("restores an active fanout directly without rendering a history strip", async () => {
    const detail = makeFanoutDetail();
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.fetchInvocations.mockResolvedValue({
      invocations: [{
        invocationId: "invocation-1",
        parentThreadId: "parent-1",
        label: "Code Review",
        status: "active",
        createdAt: "2026-07-09T00:00:00.000Z",
      }],
      nextCursor: null,
    });
    mocks.fetchInvocation.mockResolvedValue(detail);
    renderPanel();

    const nestedRow = await screen.findByTestId("review-skill-tab-row");
    expect(nestedRow).toHaveTextContent("/code-review");
    expect(within(nestedRow).getByRole("button", { name: "Cancel fanout" })).toBeInTheDocument();
    expect(screen.queryByText("Skill history")).not.toBeInTheDocument();
  });

  it("sends Manual Overview guidance through the existing action and freezes the view", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const collecting = makeFanoutDetail({ overviewMode: "manual" });
    const frozen = makeFanoutDetail({ overviewMode: "manual", overviewRunId: "overview-run-1" });
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.invokeSkill.mockResolvedValue(collecting);
    mocks.fetchInvocation.mockResolvedValueOnce(collecting).mockResolvedValue(frozen);
    renderPanel();

    await user.click(await openSkillCommand());
    const guidance = await screen.findByRole("textbox", { name: "Overview guidance" });
    await user.type(guidance, "Prioritize lifecycle bugs.");
    await user.click(screen.getByRole("button", { name: "Send to reviewer" }));

    await waitFor(() => expect(mocks.sendOverview).toHaveBeenCalledWith(
      "https://hub.test",
      "env-1",
      "invocation-1",
      { sessionId: "session-1", guidance: "Prioritize lifecycle bugs." },
    ));
    expect(await screen.findByText("Frozen manual Overview · ready")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Overview guidance" })).not.toBeInTheDocument();
  });

  it("reuses the Review launch request id after an ambiguous failure", async () => {
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.invokeSkill
      .mockRejectedValueOnce(new Error("Network response was lost"))
      .mockResolvedValueOnce({
        kind: "fanout",
        invocation: {
          invocationId: "invocation-1",
          envSlug: "env-1",
          repoId: "repo-1",
          mainSessionId: "session-1",
          parentThreadId: "parent-1",
          definitionSnapshot: codeReviewSkill,
          preparationOpId: "op-1",
          status: "active",
          overviewMode: "auto",
          includedMessageIds: [],
          overviewRunId: null,
          error: null,
          cancelledAt: null,
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        tabs: [],
        runs: [],
      });
    renderPanel();
    const reviewButton = await openSkillCommand();
    await waitFor(() => expect(reviewButton).toBeEnabled());
    fireEvent.click(reviewButton);
    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reviewButton).toBeEnabled());
    fireEvent.click(reviewButton);
    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledTimes(2));

    expect(mocks.invokeSkill.mock.calls[1][4].requestId).toBe(mocks.invokeSkill.mock.calls[0][4].requestId);
  });

  it("uses a new Review launch request id after a definitive terminal failure", async () => {
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.invokeSkill
      .mockRejectedValueOnce(new ApiActionError({
        error: "Skill setup failed.",
        code: "skill_invocation_terminal",
      }, "Skill setup failed."))
      .mockResolvedValueOnce({
        kind: "fanout",
        invocation: {
          invocationId: "invocation-2",
          envSlug: "env-1",
          repoId: "repo-1",
          mainSessionId: "session-1",
          parentThreadId: "parent-1",
          definitionSnapshot: codeReviewSkill,
          preparationOpId: "op-2",
          status: "active",
          overviewMode: "auto",
          includedMessageIds: [],
          overviewRunId: null,
          error: null,
          cancelledAt: null,
          createdAt: "2026-07-09T00:00:00.000Z",
          updatedAt: "2026-07-09T00:00:00.000Z",
        },
        tabs: [],
        runs: [],
      });
    renderPanel();
    const reviewButton = await openSkillCommand();
    await waitFor(() => expect(reviewButton).toBeEnabled());
    fireEvent.click(reviewButton);
    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(reviewButton).toBeEnabled());
    fireEvent.click(reviewButton);
    await waitFor(() => expect(mocks.invokeSkill).toHaveBeenCalledTimes(2));

    expect(mocks.invokeSkill.mock.calls[1][4].requestId).not.toBe(mocks.invokeSkill.mock.calls[0][4].requestId);
  });

  it("requires an idle selected reviewer and removes the standalone launcher", async () => {
    renderPanel();
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "/code-review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Code Review" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Code Review settings" })).not.toBeInTheDocument();
  });

  it("edits the built-in through the shared Review Skills editor without launching it", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Review Skills" }));
    expect(await screen.findByRole("heading", { name: "Review Skills" })).toBeInTheDocument();
    await user.click(screen.getByLabelText("Bug Reviewer reasoning"));
    await user.click(await screen.findByRole("option", { name: "Low" }));
    await user.click(screen.getByRole("button", { name: "Save skill" }));

    await waitFor(() => expect(mocks.updateSkill).toHaveBeenCalled());
    expect(mocks.updateSkill.mock.calls[0][4].agents[0].effort).toBe("low");
    expect(mocks.invokeSkill).not.toHaveBeenCalled();
  });

  it("uses the prototype Review skill editor hierarchy without changing the surrounding panel", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Review Skills" }));

    expect(await screen.findByRole("heading", { name: "Review Skills" })).toBeInTheDocument();
    expect(screen.getByText("One slash command configures the agent experience used when invoked.")).toBeInTheDocument();
    expect(screen.getByText("Three focused reviews.")).toBeInTheDocument();
    expect(screen.getByText("3 agents")).toBeInTheDocument();
    expect(screen.getByLabelText("Shared goal")).toHaveValue("Review the frozen workspace.");
    expect(screen.getByLabelText("Reviewer instructions")).toHaveValue("Deduplicate findings.");
    expect(screen.getByRole("group", { name: "Bug Reviewer default report mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();

    const addAgent = screen.getByRole("button", { name: "Add agent" });
    await user.click(addAgent);
    expect(screen.getAllByLabelText(/Agent \d label/)).toHaveLength(4);
    expect(addAgent).toBeDisabled();
  });

  it("uses stable route keys and clamps reasoning when the child model changes", async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    renderPanel();
    await user.click(await screen.findByRole("button", { name: "Review Skills" }));
    const modelSelect = await screen.findByLabelText("Bug Reviewer model");
    const reasoningSelect = screen.getByLabelText("Bug Reviewer reasoning");
    expect(modelSelect).toHaveTextContent("Kimi K2.7 Code");
    await user.click(modelSelect);
    await user.click(await screen.findByRole("option", { name: "GPT-5.5" }));
    expect(reasoningSelect).toHaveTextContent("High");
    await user.click(reasoningSelect);
    await user.click(await screen.findByRole("option", { name: "Extra High" }));
    await user.click(modelSelect);
    await user.click(await screen.findByRole("option", { name: "Kimi K2.7 Code" }));
    expect(reasoningSelect).toHaveTextContent("High");
  });

  it("sends the direct deployment instruction exactly once and waits for acknowledgement", async () => {
    let acknowledge: (value: { ok: boolean }) => void = () => undefined;
    const onSend = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => {
      acknowledge = resolve;
    }));
    renderPanel({ onSend });

    const deployButton = await screen.findByRole("button", { name: "Deploy Directly" });
    fireEvent.click(deployButton);

    expect(onSend).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledWith("Commit all code, push, and deploy.");
    expect(await screen.findByRole("button", { name: "Sending…" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Sending…" }));
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(mocks.invokeSkill).not.toHaveBeenCalled();

    acknowledge({ ok: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Deploy Directly" })).toBeEnabled());
  });

  it("disables direct deployment while disconnected", async () => {
    const onSend = vi.fn(async () => ({ ok: true }));
    renderPanel({ connected: false, onSend });

    expect(await screen.findByRole("button", { name: "Deploy Directly" })).toBeDisabled();
    expect(onSend).not.toHaveBeenCalled();
  });

  it("reports a direct deployment acknowledgement failure without claiming completion", async () => {
    renderPanel({ onSend: vi.fn(async () => ({ ok: false, error: "Terminal rejected input" })) });

    fireEvent.click(await screen.findByRole("button", { name: "Deploy Directly" }));
    expect(await screen.findByText("Terminal rejected input")).toBeInTheDocument();
    expect(screen.queryByText(/deploy(?:ed|ment complete)/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deploy Directly" })).toBeEnabled();
  });

  it("resizes live, clamps normal bounds, persists on completion, and restores after collapse", () => {
    mockPanelGeometry(() => 800);
    renderPanel();
    const divider = screen.getByRole("separator", {
      name: "Resize Implementor and Implementor Reviewers",
    });
    const panel = screen.getByTestId("env-review-panel");

    expect(panel.style.height).toBe("320px");
    fireEvent.mouseDown(divider, { clientY: 500 });
    fireEvent.mouseMove(window, { clientY: 400 });
    expect(panel.style.height).toBe("420px");
    expect(window.localStorage.getItem("tiller:implementor-reviewers-height")).toBeNull();

    fireEvent.mouseMove(window, { clientY: -500 });
    expect(panel.style.height).toBe("560px");
    fireEvent.mouseMove(window, { clientY: 1_000 });
    expect(panel.style.height).toBe("220px");
    fireEvent.mouseMove(window, { clientY: 400 });
    fireEvent.mouseUp(window);
    expect(window.localStorage.getItem("tiller:implementor-reviewers-height")).toBe("420");

    fireEvent.click(screen.getByRole("button", { name: "Reviewers" }));
    expect(screen.getByTestId("env-review-panel").style.height).toBe("");
    expect(window.localStorage.getItem("tiller:implementor-reviewers-height")).toBe("420");
    fireEvent.click(screen.getByRole("button", { name: "Reviewers" }));
    expect(screen.getByTestId("env-review-panel").style.height).toBe("420px");
  });

  it("shrinks below the preferred reviewer minimum to preserve terminal space", () => {
    mockPanelGeometry(() => 350);
    renderPanel();
    const panel = screen.getByTestId("env-review-panel");

    expect(panel.style.height).toBe("150px");
    fireEvent.mouseDown(screen.getByRole("separator"), { clientY: 300 });
    fireEvent.mouseMove(window, { clientY: 0 });
    expect(panel.style.height).toBe("150px");
  });

  it("restores persisted height and re-clamps it when the parent changes size", () => {
    let containerHeight = 800;
    mockPanelGeometry(() => containerHeight);
    const observer = installResizeObserver();
    window.localStorage.setItem("tiller:implementor-reviewers-height", "500");
    renderPanel();
    const panel = screen.getByTestId("env-review-panel");
    expect(panel.style.height).toBe("500px");

    containerHeight = 600;
    act(() => observer.notify());
    expect(panel.style.height).toBe("400px");

    containerHeight = 900;
    act(() => observer.notify());
    expect(panel.style.height).toBe("500px");
  });

  it("ignores a malformed persisted height", () => {
    mockPanelGeometry(() => 800);
    window.localStorage.setItem("tiller:implementor-reviewers-height", "not-a-height");
    renderPanel();

    expect(screen.getByTestId("env-review-panel").style.height).toBe("320px");
  });

  it("only follows transcript updates while already near the bottom", async () => {
    mocks.fetchState.mockResolvedValue({ ...emptyState, tabs: [idleParent] });
    mocks.fetchMessages.mockResolvedValue([threadMessage("message-1", "First review")]);
    const rendered = renderPanel();
    expect(await screen.findByText("First review")).toBeInTheDocument();

    const transcript = screen.getByLabelText("Implementor reviewer conversation");
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);

    mocks.fetchMessages.mockResolvedValue([
      threadMessage("message-1", "First review"),
      threadMessage("message-2", "Second review"),
    ]);
    rendered.rerender(
      <EnvReviewPanel
        envSlug="env-1"
        repoId="repo-1"
        sessionId="session-2"
        hubUrl="https://hub.test"
        harnessInputReady
        onSendToHarness={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(await screen.findByText("Second review")).toBeInTheDocument();
    expect(scrollTo).not.toHaveBeenCalled();

    transcript.scrollTop = 590;
    fireEvent.scroll(transcript);
    mocks.fetchMessages.mockResolvedValue([
      threadMessage("message-1", "First review"),
      threadMessage("message-2", "Second review"),
      threadMessage("message-3", "Third review"),
    ]);
    rendered.rerender(
      <EnvReviewPanel
        envSlug="env-1"
        repoId="repo-1"
        sessionId="session-3"
        hubUrl="https://hub.test"
        harnessInputReady
        onSendToHarness={vi.fn(async () => ({ ok: true }))}
      />,
    );
    expect(await screen.findByText("Third review")).toBeInTheDocument();
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: "auto" });
  });
});
