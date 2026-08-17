/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Artifact,
  PlanAttentionItem,
  PlanContribution,
  ReviewerRegistryEntry,
} from "../../api/coordination/types";

const mocks = vi.hoisted(() => ({
  acknowledgePlanAttention: vi.fn(),
  addToast: vi.fn(),
  connected: false,
  createPlan: vi.fn(),
  createScribeHandoff: vi.fn(),
  discardPlan: vi.fn(),
  fetchAgentSkills: vi.fn(),
  fetchPlanContributions: vi.fn(),
  fetchPlannerProviders: vi.fn(),
  fetchPlanReviewers: vi.fn(),
  fetchPlanWriter: vi.fn(),
  fetchRepoArtifacts: vi.fn(),
  fetchRepoPlanWriterSettings: vi.fn(),
  invokePlanSkill: vi.fn(),
  navigate: vi.fn(),
  planArtifactHintRef: { current: null as ((repoId: string, planArtifactId: string) => void) | null },
  planChatTabsProps: null as null | {
    onInvokeSkill(skill: unknown): void;
  },
  savePlan: vi.fn(),
  reviewerChatProps: null as null | {
    disabled: boolean;
    disabledReason: string | null;
    onHandoff(sources: Array<{ threadId: string; messageId: string }>, content: string): Promise<void>;
    planSkillHistoryRefreshToken: number;
    threadId: string;
    nodeKind?: string;
  },
  writerPaneProps: null as null | {
    planArtifactId: string;
    contributions: PlanContribution[];
    handoff?: { id: string; contributionIds: string[] } | null;
    queuedHandoffContributionIds?: string[];
    onHandoffSettled(handoffId: string, error?: string): void;
    onWriterChange(writer: unknown): void;
    onTabStatusChange(status: { kind: string; label: string; detail: string }): void;
  },
}));

vi.mock("react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router")>(),
  useNavigate: () => mocks.navigate,
}));

vi.mock("../DashboardDataProvider", () => ({
  useDashboardData: () => ({
    connected: mocks.connected,
    planArtifactHintRef: mocks.planArtifactHintRef,
  }),
}));

vi.mock("../Toast", () => ({
  useToast: () => mocks.addToast,
}));

vi.mock("../api", () => ({
  ApiActionError: class ApiActionError extends Error {
    code?: string;
    retryable: boolean;
    status: number | null;

    constructor(
      body: { error?: string; code?: string; retryable?: boolean },
      fallback: string,
      status: number | null = null,
    ) {
      super(body.error ?? fallback);
      this.code = body.code;
      this.retryable = body.retryable === true;
      this.status = status;
    }
  },
  ApiReadTimeoutError: class ApiReadTimeoutError extends Error {},
  acknowledgePlanAttention: mocks.acknowledgePlanAttention,
  addPlanReviewer: vi.fn(),
  createPlan: mocks.createPlan,
  createScribeHandoff: mocks.createScribeHandoff,
  discardPlan: mocks.discardPlan,
  fetchAgentSkills: mocks.fetchAgentSkills,
  fetchPlanContributions: mocks.fetchPlanContributions,
  fetchPlannerProviders: mocks.fetchPlannerProviders,
  fetchPlanReviewers: mocks.fetchPlanReviewers,
  fetchPlanWriter: mocks.fetchPlanWriter,
  fetchRepoArtifacts: mocks.fetchRepoArtifacts,
  fetchRepoPlanWriterSettings: mocks.fetchRepoPlanWriterSettings,
  isApiAuthenticationError: () => false,
  invokePlanSkill: mocks.invokePlanSkill,
  removePlanReviewer: vi.fn(),
  savePlan: mocks.savePlan,
  updatePlanStatus: vi.fn(),
  updateRepoPlanWriterSettings: vi.fn(),
}));

vi.mock("../PlanCategorySidebar", () => ({
  default: (props: {
    artifacts: Artifact[];
    attentionPlanIds: ReadonlySet<string>;
    onSelect(artifactId: string): void;
  }) => (
    <div>
      <div
        data-testid="sidebar-state"
        data-status={props.artifacts[0]?.status ?? "none"}
        data-attention={[...props.attentionPlanIds].sort().join(",")}
      />
      <button type="button" onClick={() => props.onSelect("plan-1")}>Select current plan</button>
      <button type="button" onClick={() => props.onSelect("plan-2")}>Select other plan</button>
    </div>
  ),
}));

vi.mock("../PlanChatTabs", () => ({
  default: (props: {
    reviewers: ReviewerRegistryEntry[];
    activeTab: string;
    writerTabStatus: { kind: string; label: string; detail: string };
    writerNeedsAttention: boolean;
    onActiveTabChange(tab: string): void;
    onInvokeSkill(skill: unknown): void;
  }) => {
    mocks.planChatTabsProps = props;
    return <div>
      <div
        data-testid="chat-tabs-state"
        data-active-tab={props.activeTab}
        data-reviewer-count={props.reviewers.length}
      />
      <div
        data-testid="writer-tab-status"
        data-kind={props.writerTabStatus.kind}
        data-label={props.writerTabStatus.label}
        data-needs-attention={String(props.writerNeedsAttention)}
      >
        {props.writerTabStatus.detail}
      </div>
      <button type="button" onClick={() => props.onActiveTabChange("writer")}>Scribe tab</button>
      {props.reviewers.map((reviewer) => (
        <button
          type="button"
          key={reviewer.threadId}
          onClick={() => props.onActiveTabChange(reviewer.threadId)}
        >
          Reviewer tab
        </button>
      ))}
    </div>;
  },
}));

vi.mock("../ResizablePlanPanes", () => ({
  default: (props: { artifact: React.ReactNode; reviewers: React.ReactNode }) => (
    <>{props.artifact}{props.reviewers}</>
  ),
}));

vi.mock("../PlanReader", () => ({
  default: (props: {
    onSave(markdown: string): Promise<void>;
    onDiscard?(): void;
  }) => (
    <>
      <button type="button" onClick={() => void props.onSave("# Saved plan\n")}>Save plan</button>
      {props.onDiscard && (
        <button type="button" onClick={props.onDiscard}>Discard current plan</button>
      )}
    </>
  ),
}));
vi.mock("../ReviewerChat", () => ({
  default: (props: typeof mocks.reviewerChatProps) => {
    mocks.reviewerChatProps = props;
    return <div data-testid="reviewer-chat" />;
  },
}));
vi.mock("../PlanWriterPane", () => ({
  default: (props: typeof mocks.writerPaneProps) => {
    mocks.writerPaneProps = props;
    return <div data-testid="writer-pane" data-plan-id={props?.planArtifactId} />;
  },
}));
vi.mock("../SkillEditorDialog", () => ({ default: () => null }));
vi.mock("../LoadingIndicator", () => ({ default: () => <div>Loading</div> }));
vi.mock("../PlanWriterModelPicker", () => ({ default: () => null }));

const [{ default: PlanView }, { ApiActionError }] = await Promise.all([
  import("../PlanView"),
  import("../api"),
]);

function plan(status: "draft" | "completed" = "draft"): Artifact {
  return {
    id: "plan-1",
    repoId: "repo-1",
    type: "plan",
    basis: { repoId: "repo-1", mainCommit: "main-1" },
    title: "Plan",
    body: { markdown: "# Plan\n" },
    status,
    createdAt: "2026-08-10T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
    version: 1,
  };
}

const reviewer: ReviewerRegistryEntry = {
  threadId: "reviewer-1",
  repoId: "repo-1",
  planArtifactId: "plan-1",
  provider: "codex",
  model: "gpt-5.5",
  role: "reviewer",
  runId: "run-1",
  status: "completed",
  reviewerModel: "gpt-5.5",
  createdAt: "2026-08-10T00:00:00.000Z",
  updatedAt: "2026-08-10T00:01:00.000Z",
};

function handoffContribution(id = "contribution-1"): PlanContribution {
  return {
    id,
    repoId: "repo-1",
    planArtifactId: "plan-1",
    sourceKind: "curated_reviewer_handoff",
    sourceThreadId: "reviewer-1",
    sourceMessageId: "message-1",
    sourceRefs: [{ threadId: "reviewer-1", messageId: "message-1", runId: "run-1" }],
    provider: "codex",
    model: "gpt-5.5",
    text: "Address this feedback",
    status: "pending",
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

function renderPlanView(planArtifactId: string | null = "plan-1") {
  return render(
    <PlanView
      repoId="repo-1"
      repoUrl="https://github.com/test/repo"
      repoMainCommit="main-1"
      planArtifactId={planArtifactId}
      chatgptAvailable={true}
      chatgptUnavailableReason={null}
    />,
  );
}

describe("PlanView attention", () => {
  let serverAttention: PlanAttentionItem[];

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connected = false;
    mocks.planArtifactHintRef.current = null;
    mocks.planChatTabsProps = null;
    mocks.reviewerChatProps = null;
    mocks.writerPaneProps = null;
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    serverAttention = [];
    mocks.fetchRepoArtifacts.mockImplementation(async () => ({
      artifacts: [plan()],
      refs: [],
      attention: serverAttention.map((item) => ({ ...item })),
    }));
    mocks.acknowledgePlanAttention.mockImplementation(async (
      _hubUrl: string,
      _repoId: string,
      _planArtifactId: string,
      item: PlanAttentionItem,
    ) => {
      serverAttention = serverAttention.filter((candidate) => !(
        candidate.planArtifactId === item.planArtifactId
        && candidate.sourceKind === item.sourceKind
        && candidate.sourceId === item.sourceId
        && candidate.token === item.token
      ));
      return "acknowledged";
    });
    mocks.fetchPlanReviewers.mockResolvedValue([reviewer]);
    mocks.fetchPlanContributions.mockResolvedValue([]);
    mocks.createScribeHandoff.mockReset();
    mocks.createPlan.mockReset();
    mocks.createPlan.mockResolvedValue({ ...plan(), id: "plan-new", title: "", body: { markdown: "" } });
    mocks.invokePlanSkill.mockReset();
    mocks.fetchAgentSkills.mockResolvedValue([]);
    mocks.fetchPlannerProviders.mockResolvedValue({ providers: [], writerRoutes: [], skillRoutes: [] });
    mocks.fetchRepoPlanWriterSettings.mockResolvedValue({
      repoId: "repo-1",
      routeKey: "codex:gpt-5.5",
      effort: "high",
      planFormat: "Write a plan.",
      updatedAt: null,
    });
    mocks.fetchPlanWriter.mockImplementation(async (
      _hubUrl: string,
      _repoId: string,
      artifactId: string,
    ) => ({
      lifecycle: "not_running",
      threadId: `plan-writer-${artifactId}`,
      generation: null,
      provider: null,
      model: null,
      effort: null,
      basisCommit: null,
      terminalId: null,
      synchronization: { state: "up_to_date" },
      editable: true,
    }));
    mocks.savePlan.mockResolvedValue({
      ...plan(),
      body: { markdown: "# Saved plan\n" },
      version: 2,
    });
    mocks.discardPlan.mockResolvedValue(plan());
  });

  afterEach(() => {
    cleanup();
  });

  it("confirms draft-plan deletion in an app modal", async () => {
    const confirmSpy = vi.spyOn(globalThis, "confirm").mockReturnValue(true);
    renderPlanView();

    fireEvent.click(await screen.findByRole("button", { name: "Discard current plan" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Discard draft plan?");
    expect(dialog).toHaveTextContent('"Plan" will be permanently removed.');
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(mocks.discardPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mocks.discardPlan).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Discard current plan" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard plan" }));

    await waitFor(() => expect(mocks.discardPlan).toHaveBeenCalledWith(
      window.location.origin,
      "repo-1",
      "plan-1",
      1,
    ));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("creates the first plan from the zero-data state", async () => {
    mocks.fetchRepoArtifacts.mockResolvedValue({ artifacts: [], refs: [], attention: [] });
    renderPlanView(null);

    expect(await screen.findByText("Create your first plan")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Create plan" }));

    await waitFor(() => expect(mocks.createPlan).toHaveBeenCalledWith(
      window.location.origin,
      "repo-1",
    ));
  });

  it("acknowledges only the visible collaborator and keeps the aggregate plan dot", async () => {
    serverAttention = [
      {
        planArtifactId: "plan-1",
        sourceKind: "scribe",
        sourceId: "plan-writer-plan-1",
        token: "1:1",
      },
      {
        planArtifactId: "plan-1",
        sourceKind: "reviewer",
        sourceId: "reviewer-1",
        token: "run-1",
      },
    ];
    renderPlanView();

    await waitFor(() => {
      expect(mocks.acknowledgePlanAttention).toHaveBeenCalledWith(
        expect.any(String),
        "repo-1",
        "plan-1",
        expect.objectContaining({ sourceKind: "scribe", token: "1:1" }),
      );
    });
    expect(mocks.acknowledgePlanAttention).not.toHaveBeenCalledWith(
      expect.any(String),
      "repo-1",
      "plan-1",
      expect.objectContaining({ sourceKind: "reviewer" }),
    );
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "plan-1");
    });

    fireEvent.click(await screen.findByRole("button", { name: "Reviewer tab" }));
    await waitFor(() => {
      expect(mocks.acknowledgePlanAttention).toHaveBeenCalledWith(
        expect.any(String),
        "repo-1",
        "plan-1",
        expect.objectContaining({ sourceKind: "reviewer", sourceId: "reviewer-1", token: "run-1" }),
      );
      expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "");
    });
  });

  it("does not duplicate the initial artifact load when already connected", async () => {
    mocks.connected = true;
    renderPlanView(null);
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledOnce());
    await act(async () => undefined);
    expect(mocks.fetchRepoArtifacts).toHaveBeenCalledOnce();
  });

  it("reuses a Plan Skill request ID after an unmarked ambiguous 502", async () => {
    const skill = {
      id: "review-plan",
      surface: "plan",
      command: "review-plan",
      label: "Review Plan",
      description: "",
      sharedInstructions: "Review it.",
      overviewInstructions: "",
      overviewMode: "manual",
      agents: [],
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
    } as any;
    mocks.fetchAgentSkills.mockResolvedValue([skill]);
    mocks.invokePlanSkill
      .mockRejectedValueOnce(new ApiActionError({ error: "Bad gateway" }, "Invocation failed", 502))
      .mockResolvedValueOnce({
        kind: "skill_root",
        invocation: { parentThreadId: "skill-root-1" },
      });
    renderPlanView();
    await waitFor(() => expect(mocks.planChatTabsProps).not.toBeNull());

    await act(async () => {
      mocks.planChatTabsProps!.onInvokeSkill(skill);
      await Promise.resolve();
      mocks.planChatTabsProps!.onInvokeSkill(skill);
      await Promise.resolve();
    });

    expect(mocks.invokePlanSkill).toHaveBeenCalledTimes(2);
    expect(mocks.invokePlanSkill.mock.calls[1]![4]).toBe(mocks.invokePlanSkill.mock.calls[0]![4]);
  });

  it("releases a Plan Skill request ID after a definitive command conflict", async () => {
    const skill = {
      id: "review-plan",
      surface: "plan",
      command: "review-plan",
      label: "Review Plan",
      description: "",
      sharedInstructions: "Review it.",
      overviewInstructions: "",
      overviewMode: "manual",
      agents: [],
      origin: "custom",
      customized: true,
      createdAt: null,
      updatedAt: null,
    } as any;
    mocks.fetchAgentSkills.mockResolvedValue([skill]);
    mocks.invokePlanSkill
      .mockRejectedValueOnce(new ApiActionError({
        error: "Command conflict",
        code: "skill_command_conflict",
      }, "Invocation failed", 409))
      .mockResolvedValueOnce({
        kind: "skill_root",
        invocation: { parentThreadId: "skill-root-1" },
      });
    renderPlanView();
    await waitFor(() => expect(mocks.planChatTabsProps).not.toBeNull());

    await act(async () => {
      mocks.planChatTabsProps!.onInvokeSkill(skill);
      await Promise.resolve();
      mocks.planChatTabsProps!.onInvokeSkill(skill);
      await Promise.resolve();
    });

    expect(mocks.invokePlanSkill).toHaveBeenCalledTimes(2);
    expect(mocks.invokePlanSkill.mock.calls[1]![4]).not.toBe(mocks.invokePlanSkill.mock.calls[0]![4]);
  });

  it("queues reviewer feedback sent while the Scribe probe is still loading", async () => {
    let resolveWriter!: (value: {
      lifecycle: "not_running";
      generation: null;
      provider: null;
      model: null;
      effort: null;
      basisCommit: null;
      terminalId: null;
      synchronization: { state: "up_to_date" };
      editable: true;
    }) => void;
    mocks.fetchPlanWriter.mockImplementationOnce(() => new Promise((resolve) => {
      resolveWriter = resolve;
    }));
    const contribution = handoffContribution();
    mocks.createScribeHandoff.mockResolvedValue({ contribution, created: true });
    renderPlanView();

    await waitFor(() => expect(mocks.reviewerChatProps).not.toBeNull());
    await act(async () => {
      await mocks.reviewerChatProps!.onHandoff(
        [{ threadId: "reviewer-1", messageId: "message-1" }],
        contribution.text,
      );
    });
    expect(mocks.writerPaneProps).toBeNull();

    await act(async () => {
      resolveWriter({
        lifecycle: "not_running",
        generation: null,
        provider: null,
        model: null,
        effort: null,
        basisCommit: null,
        terminalId: null,
        synchronization: { state: "up_to_date" },
        editable: true,
      });
    });
    await waitFor(() => expect(mocks.writerPaneProps?.handoff).toMatchObject({
      contributionIds: [contribution.id],
    }));
    expect(mocks.writerPaneProps?.queuedHandoffContributionIds).toEqual([contribution.id]);

    const handoffId = mocks.writerPaneProps!.handoff!.id;
    act(() => mocks.writerPaneProps!.onHandoffSettled(handoffId));
    await waitFor(() => expect(mocks.writerPaneProps?.handoff).toBeNull());
    expect(mocks.addToast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Context delivered to Scribe",
      body: "The Scribe received the reviewer context.",
      variant: "success",
    }));
  });

  it("keeps a new handoff when an older contribution read resolves afterward", async () => {
    let resolveContributions!: (value: PlanContribution[]) => void;
    const contribution = handoffContribution();
    mocks.fetchPlanContributions.mockImplementationOnce(() => new Promise((resolve) => {
      resolveContributions = resolve;
    }));
    mocks.createScribeHandoff.mockResolvedValue({ contribution, created: true });
    renderPlanView();

    await waitFor(() => expect(mocks.fetchPlanContributions).toHaveBeenCalledOnce());
    await waitFor(() => expect(mocks.reviewerChatProps).not.toBeNull());
    await act(async () => {
      await mocks.reviewerChatProps!.onHandoff(
        [{ threadId: "reviewer-1", messageId: "message-1" }],
        contribution.text,
      );
    });
    expect(mocks.writerPaneProps?.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: contribution.id }),
    ]));

    await act(async () => { resolveContributions([]); });
    await waitFor(() => expect(mocks.writerPaneProps?.contributions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: contribution.id }),
    ])));
    expect(mocks.writerPaneProps?.handoff).toMatchObject({ contributionIds: [contribution.id] });
  });

  it("keeps delayed handoffs scoped to their originating plan", async () => {
    let resolveHandoff!: (value: { contribution: PlanContribution; created: boolean }) => void;
    const contribution = handoffContribution();
    mocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [plan(), { ...plan(), id: "plan-2", title: "Second plan" }],
      refs: [],
      attention: [],
    });
    mocks.createScribeHandoff.mockImplementationOnce(() => new Promise((resolve) => {
      resolveHandoff = resolve;
    }));
    const rendered = renderPlanView();
    await waitFor(() => expect(mocks.reviewerChatProps).not.toBeNull());
    const sendFromPlanOne = mocks.reviewerChatProps!.onHandoff;
    let request!: Promise<void>;
    act(() => {
      request = sendFromPlanOne(
        [{ threadId: "reviewer-1", messageId: "message-1" }],
        contribution.text,
      );
    });
    await waitFor(() => expect(mocks.createScribeHandoff).toHaveBeenCalledOnce());

    rendered.rerender(
      <PlanView
        repoId="repo-1"
        repoUrl="https://github.com/test/repo"
        repoMainCommit="main-1"
        planArtifactId="plan-2"
        chatgptAvailable={true}
        chatgptUnavailableReason={null}
      />,
    );
    await waitFor(() => expect(mocks.writerPaneProps?.planArtifactId).toBe("plan-2"));
    await act(async () => {
      resolveHandoff({ contribution, created: true });
      await request;
    });
    expect(mocks.writerPaneProps?.handoff).toBeNull();
    expect(mocks.writerPaneProps?.queuedHandoffContributionIds).toEqual([]);

    rendered.rerender(
      <PlanView
        repoId="repo-1"
        repoUrl="https://github.com/test/repo"
        repoMainCommit="main-1"
        planArtifactId="plan-1"
        chatgptAvailable={true}
        chatgptUnavailableReason={null}
      />,
    );
    await waitFor(() => expect(mocks.writerPaneProps?.handoff).toMatchObject({
      contributionIds: [contribution.id],
    }));
  });

  it("does not acknowledge in a hidden document and converges after visibility restoration", async () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    serverAttention = [{
      planArtifactId: "plan-1",
      sourceKind: "scribe",
      sourceId: "plan-writer-plan-1",
      token: "1:1",
    }];
    renderPlanView();
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalled());
    expect(mocks.acknowledgePlanAttention).not.toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => expect(mocks.acknowledgePlanAttention).toHaveBeenCalledOnce());
  });

  it("does not acknowledge the old Scribe while navigating to a different plan", async () => {
    renderPlanView();
    fireEvent.click(await screen.findByRole("button", { name: "Reviewer tab" }));
    serverAttention = [{
      planArtifactId: "plan-1",
      sourceKind: "scribe",
      sourceId: "plan-writer-plan-1",
      token: "1:1",
    }];
    act(() => {
      mocks.planArtifactHintRef.current?.("repo-1", "plan-1");
    });
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "plan-1");
    });

    fireEvent.click(screen.getByRole("button", { name: "Select other plan" }));
    await act(async () => undefined);
    expect(mocks.acknowledgePlanAttention).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Select current plan" }));
    await waitFor(() => expect(mocks.acknowledgePlanAttention).toHaveBeenCalledOnce());
  });

  it("shows unread Scribe work on its tab until that pane is opened", async () => {
    renderPlanView();
    fireEvent.click(await screen.findByRole("button", { name: "Reviewer tab" }));
    serverAttention = [{
      planArtifactId: "plan-1",
      sourceKind: "scribe",
      sourceId: "plan-writer-plan-1",
      token: "1:1",
    }];
    act(() => {
      mocks.planArtifactHintRef.current?.("repo-1", "plan-1");
    });

    await waitFor(() => {
      expect(screen.getByTestId("writer-tab-status")).toHaveAttribute("data-label", "Not started");
      expect(screen.getByTestId("writer-tab-status")).toHaveAttribute("data-needs-attention", "true");
      expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "plan-1");
    });
    expect(mocks.acknowledgePlanAttention).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Scribe tab" }));
    await waitFor(() => {
      expect(mocks.acknowledgePlanAttention).toHaveBeenCalledWith(
        expect.any(String),
        "repo-1",
        "plan-1",
        expect.objectContaining({ sourceKind: "scribe", token: "1:1" }),
      );
      expect(screen.getByTestId("writer-tab-status")).toHaveAttribute("data-label", "Not started");
      expect(screen.getByTestId("writer-tab-status")).toHaveAttribute("data-needs-attention", "false");
    });
  });

  it("removes a reviewer in another tab when the shared artifact hint arrives", async () => {
    renderPlanView();
    fireEvent.click(await screen.findByRole("button", { name: "Reviewer tab" }));
    expect(screen.getByTestId("chat-tabs-state")).toHaveAttribute("data-active-tab", "reviewer-1");
    mocks.fetchPlanReviewers.mockResolvedValueOnce([]);

    act(() => mocks.planArtifactHintRef.current?.("repo-1", "plan-1"));

    await waitFor(() => {
      expect(mocks.fetchPlanReviewers).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("chat-tabs-state")).toHaveAttribute("data-reviewer-count", "0");
      expect(screen.getByTestId("chat-tabs-state")).toHaveAttribute("data-active-tab", "writer");
    });
    expect(screen.queryByRole("button", { name: "Reviewer tab" })).not.toBeInTheDocument();
  });

  it("opens a Plan Skill as a visible reviewer root", async () => {
    mocks.fetchPlanReviewers.mockResolvedValueOnce([{
      ...reviewer,
      threadId: "skill-root-1",
      nodeKind: "skill_root",
      skillRootThreadId: "skill-root-1",
      skillInvocationId: "round-1",
      skillLabel: "Review Plan",
    }]);
    renderPlanView();

    fireEvent.click(await screen.findByRole("button", { name: "Reviewer tab" }));
    await waitFor(() => expect(mocks.reviewerChatProps).toMatchObject({
      threadId: "skill-root-1",
      nodeKind: "skill_root",
      planSkillHistoryRefreshToken: 0,
    }));
  });

  it("disables reviewer commands on terminal plans", async () => {
    mocks.fetchRepoArtifacts.mockResolvedValueOnce({
      artifacts: [plan("completed")],
      refs: [],
      attention: [],
    });
    renderPlanView();

    await waitFor(() => {
      expect(mocks.reviewerChatProps).toMatchObject({
        disabled: true,
        disabledReason:
          "Completed or archived plans cannot start reviewer work.",
      });
    });
  });

  it("coalesces equal-version selected-plan hints and refreshes Plan Skill history", async () => {
    renderPlanView();
    await waitFor(() => {
      expect(mocks.fetchRepoArtifacts).toHaveBeenCalledOnce();
      expect(mocks.reviewerChatProps?.planSkillHistoryRefreshToken).toBe(0);
    });

    act(() => {
      mocks.planArtifactHintRef.current?.("repo-1", "plan-1");
      mocks.planArtifactHintRef.current?.("repo-1", "plan-1");
      mocks.planArtifactHintRef.current?.("repo-1", "plan-1");
    });

    await waitFor(() => {
      expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2);
      expect(mocks.reviewerChatProps?.planSkillHistoryRefreshToken).toBe(1);
    });
  });

  it("cancels a pending Plan Skill hint refresh when the selected plan changes", async () => {
    mocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [plan(), { ...plan(), id: "plan-2", title: "Second plan" }],
      refs: [],
      attention: [],
    });
    const rendered = renderPlanView();
    await waitFor(() => {
      expect(mocks.fetchRepoArtifacts).toHaveBeenCalledOnce();
      expect(mocks.planArtifactHintRef.current).not.toBeNull();
    });

    act(() => mocks.planArtifactHintRef.current?.("repo-1", "plan-1"));
    rendered.rerender(
      <PlanView
        repoId="repo-1"
        repoUrl="https://github.com/test/repo"
        repoMainCommit="main-1"
        planArtifactId="plan-2"
        chatgptAvailable={true}
        chatgptUnavailableReason={null}
      />,
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(mocks.fetchRepoArtifacts).toHaveBeenCalledOnce();
    expect(mocks.reviewerChatProps?.planSkillHistoryRefreshToken).toBe(0);
  });

  it("ignores callbacks from the Scribe pane after another plan is selected", async () => {
    mocks.fetchRepoArtifacts.mockResolvedValue({
      artifacts: [plan(), { ...plan(), id: "plan-2", title: "Second plan" }],
      refs: [],
      attention: [],
    });
    const rendered = renderPlanView();
    await waitFor(() => expect(screen.getByTestId("writer-pane")).toHaveAttribute("data-plan-id", "plan-1"));
    const staleWriterChange = mocks.writerPaneProps!.onWriterChange;
    const staleStatusChange = mocks.writerPaneProps!.onTabStatusChange;

    rendered.rerender(
      <PlanView
        repoId="repo-1"
        repoUrl="https://github.com/test/repo"
        repoMainCommit="main-1"
        planArtifactId="plan-2"
        chatgptAvailable={true}
        chatgptUnavailableReason={null}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("writer-pane")).toHaveAttribute("data-plan-id", "plan-2"));

    act(() => {
      staleWriterChange({});
      staleStatusChange({ kind: "error", label: "Stale error", detail: "Old plan" });
    });

    expect(screen.getByTestId("writer-pane")).toHaveAttribute("data-plan-id", "plan-2");
    expect(screen.getByTestId("writer-tab-status")).toHaveAttribute("data-label", "Not started");
  });

  it("replaces an invalidated foreground load instead of accepting its stale response", async () => {
    let resolveInitial!: (value: {
      artifacts: Artifact[];
      refs: [];
      attention: PlanAttentionItem[];
    }) => void;
    let resolveReplacement!: (value: {
      artifacts: Artifact[];
      refs: [];
      attention: PlanAttentionItem[];
    }) => void;
    mocks.fetchRepoArtifacts
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReplacement = resolve; }));
    renderPlanView(null);
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.planArtifactHintRef.current).not.toBeNull());
    act(() => {
      mocks.planArtifactHintRef.current?.("repo-1", "plan-1");
    });
    expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    await act(async () => {
      resolveInitial({
        artifacts: [plan("draft")],
        refs: [],
        attention: [{
          planArtifactId: "plan-1",
          sourceKind: "reviewer",
          sourceId: "reviewer-1",
          token: "run-1",
        }],
      });
    });
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-status", "none");

    await act(async () => {
      resolveReplacement({ artifacts: [plan("completed")], refs: [], attention: [] });
    });
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-status", "completed");
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "");
  });

  it("starts a foreground replacement when an initial quiet refresh fails", async () => {
    let resolveInitial!: (value: {
      artifacts: Artifact[];
      refs: [];
      attention: PlanAttentionItem[];
    }) => void;
    let resolveReplacement!: (value: {
      artifacts: Artifact[];
      refs: [];
      attention: PlanAttentionItem[];
    }) => void;
    mocks.fetchRepoArtifacts
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
      .mockRejectedValueOnce(new Error("quiet refresh failed"))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveReplacement = resolve; }));
    renderPlanView(null);
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(mocks.planArtifactHintRef.current).not.toBeNull());
    act(() => mocks.planArtifactHintRef.current?.("repo-1", "plan-1"));
    expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    await act(async () => {
      resolveInitial({ artifacts: [plan("draft")], refs: [], attention: [] });
    });
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(3));
    await act(async () => resolveReplacement({ artifacts: [plan("completed")], refs: [], attention: [] }));
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-status", "completed");
  });

  it("does not accept an older quiet response after a newer refresh fails", async () => {
    let resolveOlder!: (value: {
      artifacts: Artifact[];
      refs: [];
      attention: PlanAttentionItem[];
    }) => void;
    mocks.fetchRepoArtifacts
      .mockResolvedValueOnce({ artifacts: [plan("completed")], refs: [], attention: [] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockRejectedValueOnce(new Error("newer refresh failed"));
    renderPlanView(null);
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-status", "completed");
      expect(mocks.planArtifactHintRef.current).not.toBeNull();
    });

    act(() => mocks.planArtifactHintRef.current?.("repo-1", "plan-1"));
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2));
    act(() => mocks.planArtifactHintRef.current?.("repo-1", "plan-1"));
    expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 110));
    });

    await act(async () => {
      resolveOlder({
        artifacts: [plan("draft")],
        refs: [],
        attention: [{
          planArtifactId: "plan-1",
          sourceKind: "reviewer",
          sourceId: "reviewer-1",
          token: "run-1",
        }],
      });
    });
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-status", "completed");
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "");
  });

  it("starts an authoritative replacement load after a local save invalidates an older refresh", async () => {
    let resolveOlder!: (value: {
      artifacts: Artifact[];
      refs: [];
      attention: PlanAttentionItem[];
    }) => void;
    mocks.fetchRepoArtifacts
      .mockResolvedValueOnce({ artifacts: [plan()], refs: [], attention: [] })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({
        artifacts: [{ ...plan(), version: 2 }],
        refs: [],
        attention: [{
          planArtifactId: "plan-1",
          sourceKind: "reviewer",
          sourceId: "reviewer-1",
          token: "run-2",
        }],
      });
    renderPlanView();
    await waitFor(() => {
      expect(mocks.fetchRepoArtifacts).toHaveBeenCalledOnce();
      expect(mocks.planArtifactHintRef.current).not.toBeNull();
    });

    act(() => mocks.planArtifactHintRef.current?.("repo-1", "plan-1"));
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole("button", { name: "Save plan" }));
    await waitFor(() => expect(mocks.savePlan).toHaveBeenCalledOnce());
    expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveOlder({ artifacts: [plan()], refs: [], attention: [] });
    });
    await waitFor(() => expect(mocks.fetchRepoArtifacts).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "plan-1");
    });
    expect(screen.getByTestId("sidebar-state")).toHaveAttribute("data-attention", "plan-1");
  });
  it("keeps exhausted Scribe probes terminal until manual Retry", async () => {
    vi.useFakeTimers();
    try {
      mocks.fetchPlanWriter.mockRejectedValue(new TypeError("Network unavailable"));
      renderPlanView();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      for (const delay of [3_000, 6_000, 12_000, 24_000]) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(delay);
        });
      }
      expect(mocks.fetchPlanWriter).toHaveBeenCalledTimes(5);
      expect(screen.getByRole("alert")).toHaveTextContent("Scribe could not be loaded.");

      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.fetchPlanWriter).toHaveBeenCalledTimes(5);

      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mocks.fetchPlanWriter).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores the complete Scribe retry budget after a successful probe", async () => {
    vi.useFakeTimers();
    try {
      const writer = {
        lifecycle: "not_running",
        generation: null,
        provider: null,
        model: null,
        effort: null,
        basisCommit: null,
        terminalId: null,
        synchronization: { state: "up_to_date" },
        editable: true,
      };
      mocks.fetchPlanWriter
        .mockRejectedValueOnce(new TypeError("Network unavailable"))
        .mockRejectedValueOnce(new TypeError("Network unavailable"))
        .mockResolvedValueOnce(writer)
        .mockRejectedValue(new TypeError("Network unavailable"));
      renderPlanView();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(mocks.fetchPlanWriter).toHaveBeenCalledTimes(3);

      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      act(() => document.dispatchEvent(new Event("visibilitychange")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(3_000);
      });
      expect(mocks.fetchPlanWriter).toHaveBeenCalledTimes(5);
    } finally {
      vi.useRealTimers();
    }
  });

});
