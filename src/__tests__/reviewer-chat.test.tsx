/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReviewerChat from "../ReviewerChat";
import type { AgentSkillDefinition } from "../api";

const planSkills: AgentSkillDefinition[] = [{
  id: "plan-review",
  surface: "plan",
  command: "plan-review",
  label: "Plan Review",
  description: "Review the plan from several angles.",
  sharedInstructions: "Review the plan.",
  overviewInstructions: "Synthesize the reports.",
  overviewMode: "auto",
  agents: [{
    id: "correctness",
    label: "Correctness",
    instructions: "Find correctness gaps.",
    routeKey: "codex:gpt-5.5",
    effort: "high",
    reportMode: "auto",
  }],
  origin: "builtin",
  customized: false,
  createdAt: null,
  updatedAt: null,
}];

const mocks = vi.hoisted(() => ({
  fetchLatestPlannerRun: vi.fn(),
  fetchPlannerRun: vi.fn(),
  fetchReviewerMessages: vi.fn(),
  sendReviewerMessage: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchLatestPlannerRun: mocks.fetchLatestPlannerRun,
  fetchPlannerRun: mocks.fetchPlannerRun,
  fetchReviewerMessages: mocks.fetchReviewerMessages,
  sendReviewerMessage: mocks.sendReviewerMessage,
}));

describe("ReviewerChat", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });

    mocks.fetchReviewerMessages.mockReset();
    mocks.fetchLatestPlannerRun.mockReset();
    mocks.fetchPlannerRun.mockReset();
    mocks.sendReviewerMessage.mockReset();
    window.sessionStorage.clear();
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: null, events: [] });
    mocks.fetchPlannerRun.mockResolvedValue({ run: null, events: [] });
    mocks.fetchReviewerMessages.mockResolvedValue([
      {
        id: "message-1",
        threadId: "reviewer-thread-1",
        seq: 1,
        senderSessionId: "assistant",
        kind: "chat",
        body: { role: "assistant", text: "Initial review" },
        createdAt: "2026-06-01T00:00:00.000Z",
      },
    ]);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    root = null;
    vi.useRealTimers();
  });

  it("loads reviewer thread messages without sending while typing", async () => {
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    expect(mocks.fetchReviewerMessages).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Initial review");

    const textarea = container.querySelector("textarea");
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);

    await act(async () => {
      setTextareaValue(
        textarea as HTMLTextAreaElement,
        "Please review the risky parts.",
      );
    });

    expect(mocks.fetchReviewerMessages).toHaveBeenCalledTimes(1);
    expect(mocks.sendReviewerMessage).not.toHaveBeenCalled();
  });

  it("explains a new reviewer's purpose in the compact plan pane", async () => {
    mocks.fetchReviewerMessages.mockResolvedValue([]);

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          compact
          onForward={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("This reviewer critiques the plan without editing it.");
    expect(container.textContent).toContain("risks, missing steps, or alternatives");
  });

  it("shows a failed inline skill command as one attributed terminal turn", async () => {
    mocks.fetchReviewerMessages.mockResolvedValue({
      messages: [{
        id: "skill-command",
        threadId: "reviewer-thread-1",
        seq: 1,
        senderSessionId: "user",
        kind: "chat",
        body: { role: "user", text: "/api-review", runId: "skill-run-1" },
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      runAttributions: {
        "skill-run-1": {
          status: "failed",
          error: "The command marker could not be persisted.",
          provider: "codex",
          model: "gpt-5.5",
          effort: "high",
          command: "api-review",
          agentLabel: "API Reviewer",
        },
      },
    });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("/api-review");
    expect(container.textContent).toContain("Failed · The command marker could not be persisted.");
    expect(container.textContent).not.toContain("Running /api-review");
  });

  it("keeps the reviewer relationship clear and reflects Scribe handoff status", async () => {
    const onForward = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onForward={onForward}
        />,
      );
    });

    expect(container.textContent).toContain("Advises on the plan · conversation retained");
    const share = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Share with Scribe");
    expect(share).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      share?.click();
      await Promise.resolve();
    });
    expect(onForward).toHaveBeenCalledWith("message-1", undefined);

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          handoffStatuses={new Map([["message-1", "waiting"]])}
          onForward={onForward}
        />,
      );
    });
    expect(container.textContent).toContain("Waiting for Scribe");

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          handoffStatuses={new Map([["message-1", "shared"]])}
          onForward={onForward}
        />,
      );
    });
    expect(container.textContent).toContain("Sent to Plan Writer");

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          handoffStatuses={new Map([["message-1", "removed"]])}
          onForward={onForward}
        />,
      );
    });
    expect(container.textContent).toContain("Removed from Scribe");
  });

  it("edits reviewer feedback before sending it to the Scribe", async () => {
    const onForward = vi.fn().mockResolvedValue(undefined);
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onForward={onForward}
        />,
      );
    });

    const editAndSend = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent === "Edit & Send to Scribe");
    expect(editAndSend).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      editAndSend?.click();
    });

    const editor = document.body.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message to Scribe"]');
    expect(editor).toBeInstanceOf(HTMLTextAreaElement);
    expect(editor?.value).toBe("Initial review");
    await act(async () => {
      setTextareaValue(editor!, "Edited review for the Scribe");
    });

    const send = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent === "Send to Scribe");
    expect(send).toBeInstanceOf(HTMLButtonElement);
    await act(async () => {
      send?.click();
      await Promise.resolve();
    });

    expect(onForward).toHaveBeenCalledWith("message-1", "Edited review for the Scribe");
  });

  it("does not expose generic Scribe actions for a canonical Overview", async () => {
    mocks.fetchReviewerMessages.mockResolvedValue({
      messages: [{
        id: "overview-message",
        threadId: "reviewer-thread-1",
        seq: 1,
        senderSessionId: "assistant",
        kind: "chat",
        body: { role: "assistant", text: "Canonical Overview", runId: "overview-run" },
        createdAt: "2026-06-01T00:00:00.000Z",
      }],
      runAttributions: {
        "overview-run": {
          status: "completed",
          provider: "codex",
          model: "gpt-5.5",
          skillRunRole: "overview",
        },
      },
    });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onForward={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Canonical Overview");
    expect(container.textContent).not.toContain("Share with Scribe");
    expect(container.textContent).not.toContain("Edit & Send to Scribe");
  });

  it("returns to and highlights a reviewer message from the Scribe context tray", async () => {
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onForward={vi.fn()}
        />,
      );
    });
    const message = container.querySelector<HTMLElement>('[data-reviewer-message-id="message-1"]');
    const scrollIntoView = vi.fn();
    Object.defineProperty(message!, "scrollIntoView", { configurable: true, value: scrollIntoView });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          focusMessage={{ messageId: "message-1", requestId: "focus-1" }}
          onForward={vi.fn()}
        />,
      );
    });

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "smooth" });
    expect(message).toHaveClass("ring-2", "ring-kumo-focus");
  });

  it("offers Plan skills from the reviewer slash composer", async () => {
    const onInvokeSkill = vi.fn().mockResolvedValue(true);
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          skills={planSkills}
          onInvokeSkill={onInvokeSkill}
          onForward={vi.fn()}
        />,
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(textarea, "/");
    });

    const skillButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("/plan-review"));
    expect(skillButton).toBeInstanceOf(HTMLButtonElement);
    expect(skillButton?.textContent).toContain("Review the plan from several angles.");

    await act(async () => {
      skillButton?.click();
      await Promise.resolve();
    });

    expect(onInvokeSkill).toHaveBeenCalledWith(planSkills[0], "reviewer-thread-1");
    expect(mocks.sendReviewerMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("defers hidden transcripts and idle polling until the reviewer is opened", async () => {
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          hidden
          onForward={vi.fn()}
        />,
      );
    });

    expect(mocks.fetchReviewerMessages).not.toHaveBeenCalled();
    expect(container.innerHTML).toBe("");
    expect(mocks.fetchLatestPlannerRun).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(mocks.fetchLatestPlannerRun).not.toHaveBeenCalled();

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    expect(mocks.fetchReviewerMessages).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain("Initial review");
  });

  it("does not render or poll a working reviewer while its tab is hidden", async () => {
    const onLatestRunChange = vi.fn();
    const running = {
      runId: "run-hidden",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer" as const,
      provider: "codex",
      model: "gpt-5.5",
      status: "running" as const,
      startedAt: "2026-06-01T00:00:01.000Z",
    };
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: running, events: [] });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          hidden
          onLatestRunChange={onLatestRunChange}
          onForward={vi.fn()}
        />,
      );
    });

    expect(container.innerHTML).toBe("");
    expect(mocks.fetchReviewerMessages).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(mocks.fetchLatestPlannerRun).not.toHaveBeenCalled();
    expect(mocks.fetchPlannerRun).not.toHaveBeenCalled();
    expect(onLatestRunChange).not.toHaveBeenCalled();
    expect(mocks.fetchReviewerMessages).not.toHaveBeenCalled();
  });

  it("polls an active reviewer immediately every 3 seconds and resumes immediately", async () => {
    const running = {
      runId: "run-lifecycle",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer" as const,
      provider: "codex",
      model: "gpt-5.5",
      status: "running" as const,
      startedAt: "2026-06-01T00:00:01.000Z",
    };
    const completed = {
      ...running,
      status: "completed" as const,
      completedAt: "2026-06-01T00:00:02.000Z",
    };
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: running, events: [] });
    mocks.fetchPlannerRun.mockResolvedValue({ run: running, events: [] });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onForward={vi.fn()}
        />,
      );
    });
    expect(mocks.fetchLatestPlannerRun).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPlannerRun).not.toHaveBeenCalled();

    await act(async () => vi.advanceTimersByTimeAsync(2_999));
    expect(mocks.fetchPlannerRun).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(mocks.fetchPlannerRun).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(mocks.fetchLatestPlannerRun).toHaveBeenCalledTimes(1);
    expect(mocks.fetchPlannerRun).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(mocks.fetchLatestPlannerRun).toHaveBeenCalledTimes(2);

    await act(async () => window.dispatchEvent(new Event("offline")));
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(mocks.fetchLatestPlannerRun).toHaveBeenCalledTimes(2);
    expect(mocks.fetchPlannerRun).toHaveBeenCalledTimes(1);

    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: completed, events: [] });
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(mocks.fetchLatestPlannerRun).toHaveBeenCalledTimes(3);
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(mocks.fetchLatestPlannerRun).toHaveBeenCalledTimes(3);
    expect(mocks.fetchPlannerRun).toHaveBeenCalledTimes(1);
  });

  it("shows the full user-facing commentary history without raw tool activity", async () => {
    mocks.fetchReviewerMessages.mockResolvedValue([]);
    mocks.fetchLatestPlannerRun.mockResolvedValue({
      run: {
        runId: "run-private",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        role: "reviewer",
        provider: "codex",
        model: "gpt-5.5",
        status: "running",
      },
      events: [
        { runId: "run-private", seq: 1, type: "runtime_startup", message: "Reviewer runtime started." },
        { runId: "run-private", seq: 2, type: "model_commentary", message: "I’m checking the reviewer callback path." },
        ...Array.from({ length: 45 }, (_, index) => ({
          runId: "run-private",
          seq: index + 3,
          type: "model_commentary",
          message: `Review update ${index + 1}.`,
        })),
        { runId: "run-private", seq: 48, type: "model_activity", message: "Running: rg reviewer packages/hub" },
        { runId: "run-private", seq: 49, type: "model_commentary", message: "I’m comparing the plan against the implementation." },
      ],
    });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          compact
          onForward={vi.fn()}
        />,
      );
    });

    const runStatus = container.querySelector('[data-testid="reviewer-run-status"]');
    expect(runStatus).not.toBeNull();
    expect(runStatus?.querySelector("[data-reviewer-message-bubble]")).toHaveClass(
      "max-w-[80%]",
      "rounded-lg",
      "border",
      "bg-kumo-recessed",
    );
    expect(runStatus?.closest(".tiller-skill-composer")).toBeNull();
    expect(container.querySelector(".tiller-skill-composer textarea")).toBeInstanceOf(HTMLTextAreaElement);
    expect(container.textContent).toContain("Reviewer is working…");
    expect(container.textContent).toContain("Activity");
    expect(container.textContent).toContain("I’m checking the reviewer callback path.");
    expect(container.textContent).toContain("Review update 1.");
    expect(container.textContent).toContain("Review update 45.");
    expect(container.textContent).toContain("I’m comparing the plan against the implementation.");
    expect(container.textContent).not.toContain("Running: rg reviewer packages/hub");
    expect(container.textContent).not.toContain("Reviewer runtime started.");
    const activityDetails = container.querySelector("details");
    expect(activityDetails?.open).toBe(false);
    expect(activityDetails?.querySelector("summary")).toHaveAttribute("title", "Show past thoughts");
    act(() => activityDetails?.querySelector("summary")?.click());
    expect(activityDetails?.open).toBe(true);
  });

  it("reports run transitions to the tab status owner without repeating unchanged polls", async () => {
    const onLatestRunChange = vi.fn();
    const running = {
      runId: "run-status",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer" as const,
      provider: "codex",
      model: "gpt-5.5",
      status: "running" as const,
      startedAt: "2026-06-01T00:00:01.000Z",
    };
    mocks.fetchReviewerMessages.mockResolvedValue([]);
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: running, events: [] });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onLatestRunChange={onLatestRunChange}
          onForward={vi.fn()}
        />,
      );
    });

    expect(onLatestRunChange).toHaveBeenCalledTimes(1);
    expect(onLatestRunChange).toHaveBeenLastCalledWith(running);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });
    expect(onLatestRunChange).toHaveBeenCalledTimes(1);

    const completed = {
      ...running,
      status: "completed" as const,
      completedAt: "2026-06-01T00:00:02.000Z",
    };
    mocks.fetchPlannerRun.mockResolvedValue({ run: completed, events: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_249);
    });
    expect(onLatestRunChange).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(onLatestRunChange).toHaveBeenCalledTimes(2);
    expect(onLatestRunChange).toHaveBeenLastCalledWith(completed);
  });

  it("keeps a failed terminal transcript eligible for the next activation without idle polling", async () => {
    const running = {
      runId: "run-terminal-retry",
      repoId: "repo-1",
      planArtifactId: "plan-1",
      role: "reviewer" as const,
      provider: "codex",
      model: "gpt-5.5",
      status: "running" as const,
    };
    const completed = {
      ...running,
      status: "completed" as const,
      completedAt: "2026-06-01T00:00:02.000Z",
    };
    const finalMessage = {
      id: "message-final",
      threadId: "reviewer-thread-1",
      seq: 2,
      senderSessionId: "assistant",
      kind: "chat",
      body: { role: "assistant", text: "Terminal result" },
      createdAt: "2026-06-01T00:00:02.000Z",
    };
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: running, events: [] });
    mocks.fetchPlannerRun.mockResolvedValue({ run: completed, events: [] });
    mocks.fetchReviewerMessages
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new TypeError("temporary transcript failure"))
      .mockResolvedValueOnce([finalMessage]);

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="codex"
          model="gpt-5.5"
          onForward={vi.fn()}
        />,
      );
    });
    expect(mocks.fetchReviewerMessages).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(mocks.fetchReviewerMessages).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("Terminal result");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.fetchReviewerMessages).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(mocks.fetchReviewerMessages).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain("Terminal result");
  });

  it("shows the submitted message and startup state before the send request resolves", async () => {
    let resolveSend: ((value: unknown) => void) | null = null;
    const sendPromise = new Promise((resolve) => {
      resolveSend = resolve;
    });
    mocks.sendReviewerMessage.mockReturnValue(sendPromise);

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    const transcript = container.querySelector('[aria-label="Reviewer conversation"]') as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperty(transcript, "scrollTo", { configurable: true, value: scrollTo });
    await act(async () => {
      setTextareaValue(textarea, "Please review the risky parts.");
    });

    act(() => sendWithEnter(textarea));

    expect(mocks.sendReviewerMessage).toHaveBeenCalledWith(
      window.location.origin,
      "repo-1",
      "plan-1",
      "reviewer-thread-1",
      "Please review the risky parts.",
      undefined,
    );
    expect(textarea.value).toBe("");
    expect(container.querySelector('[data-testid="pending-reviewer-message"]')?.textContent)
      .toContain("Please review the risky parts.");
    expect(container.textContent).toContain("Starting reviewer…");
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });

    await act(async () => {
      mocks.fetchPlannerRun.mockResolvedValue({
        run: {
          runId: "run-2",
          repoId: "repo-1",
          planArtifactId: "plan-1",
          role: "reviewer",
          provider: "fake",
          model: "fake-fast",
          status: "queued",
        },
        events: [],
      });
      resolveSend?.({
        message: {
          id: "message-2",
          threadId: "reviewer-thread-1",
          seq: 2,
          senderSessionId: "user",
          kind: "chat",
          body: { role: "user", text: "Please review the risky parts." },
          createdAt: "2026-06-01T00:00:01.000Z",
        },
        run: {
          runId: "run-2",
          repoId: "repo-1",
          planArtifactId: "plan-1",
          role: "reviewer",
          provider: "fake",
          model: "fake-fast",
          status: "queued",
        },
      });
      await sendPromise;
    });

    expect(container.querySelector('[data-testid="pending-reviewer-message"]')).toBeNull();
    expect(container.textContent).toContain("Reviewer is working…");
    expect(container.textContent).not.toContain("Starting reviewer…");
  });

  it("does not let an older transcript response erase a newly sent message", async () => {
    let resolveTranscript!: (messages: unknown[]) => void;
    mocks.fetchReviewerMessages.mockReturnValue(new Promise((resolve) => {
      resolveTranscript = resolve;
    }));
    mocks.sendReviewerMessage.mockResolvedValue({
      message: {
        id: "message-new",
        threadId: "reviewer-thread-1",
        seq: 2,
        senderSessionId: "user",
        kind: "chat",
        body: { role: "user", text: "Keep the new message" },
        createdAt: "2026-06-01T00:00:01.000Z",
      },
      run: null,
    });

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(textarea, "Keep the new message");
      sendWithEnter(textarea);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Keep the new message");

    await act(async () => {
      resolveTranscript([]);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("Keep the new message");
  });

  it("restores the draft when starting the reviewer fails", async () => {
    mocks.sendReviewerMessage.mockRejectedValue(new Error("Could not start reviewer"));

    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(textarea, "Keep this draft");
      sendWithEnter(textarea);
      await Promise.resolve();
    });

    expect(textarea.value).toBe("Keep this draft");
    expect(container.textContent).toContain("Could not start reviewer");
    expect(container.querySelector('[data-testid="pending-reviewer-message"]')).toBeNull();
  });

  it("does not pull the transcript down when progress arrives while reading older messages", async () => {
    mocks.fetchLatestPlannerRun.mockResolvedValue({
      run: {
        runId: "run-progress",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        role: "reviewer",
        provider: "fake",
        model: "fake-fast",
        status: "running",
      },
      events: [],
    });
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    const transcript = container.querySelector('[aria-label="Reviewer conversation"]') as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    transcript.scrollTop = 100;
    act(() => transcript.dispatchEvent(new Event("scroll", { bubbles: true })));

    mocks.fetchPlannerRun.mockResolvedValue({
      run: {
        runId: "run-progress",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        role: "reviewer",
        provider: "fake",
        model: "fake-fast",
        status: "running",
      },
      events: [{ runId: "run-progress", seq: 1, type: "model_commentary", message: "Inspecting the relevant files." }],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(container.textContent).toContain("Inspecting the relevant files.");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows progress immediately while the transcript is already near the bottom", async () => {
    mocks.fetchLatestPlannerRun.mockResolvedValue({
      run: {
        runId: "run-progress",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        role: "reviewer",
        provider: "fake",
        model: "fake-fast",
        status: "running",
      },
      events: [],
    });
    await act(async () => {
      root?.render(
        <ReviewerChat
          repoId="repo-1"
          planArtifactId="plan-1"
          threadId="reviewer-thread-1"
          provider="fake"
          model="fake-fast"
          onForward={vi.fn()}
        />,
      );
    });

    const transcript = container.querySelector('[aria-label="Reviewer conversation"]') as HTMLDivElement;
    const scrollTo = vi.fn();
    Object.defineProperties(transcript, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 800 },
      scrollTo: { configurable: true, value: scrollTo },
    });
    transcript.scrollTop = 580;
    act(() => transcript.dispatchEvent(new Event("scroll", { bubbles: true })));

    mocks.fetchPlannerRun.mockResolvedValue({
      run: {
        runId: "run-progress",
        repoId: "repo-1",
        planArtifactId: "plan-1",
        role: "reviewer",
        provider: "fake",
        model: "fake-fast",
        status: "running",
      },
      events: [{ runId: "run-progress", seq: 1, type: "model_commentary", message: "Inspecting the relevant files." }],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });

    expect(scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: "auto" });
  });
});

function sendWithEnter(textarea: HTMLTextAreaElement): void {
  textarea.dispatchEvent(new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
  }));
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  const valueSetter = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}
