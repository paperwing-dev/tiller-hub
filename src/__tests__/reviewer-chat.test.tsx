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
  fetchReviewerMessages: vi.fn(),
  sendReviewerMessage: vi.fn(),
}));

vi.mock("../api", () => ({
  fetchLatestPlannerRun: mocks.fetchLatestPlannerRun,
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

    mocks.fetchReviewerMessages.mockReset();
    mocks.fetchLatestPlannerRun.mockReset();
    mocks.sendReviewerMessage.mockReset();
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: null, events: [] });
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
    expect(onForward).toHaveBeenCalledWith("message-1");

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
    expect(container.textContent).toContain("Shared with Scribe");

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

    expect(onInvokeSkill).toHaveBeenCalledWith(planSkills[0]);
    expect(mocks.sendReviewerMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("shows current model activity from an active run", async () => {
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
        { runId: "run-private", seq: 2, type: "model_activity", message: "Running: rg reviewer packages/hub" },
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
          onForward={vi.fn()}
        />,
      );
    });

    expect(container.textContent).toContain("Reviewer is working…");
    expect(container.textContent).toContain("Running: rg reviewer packages/hub");
    expect(container.textContent).not.toContain("Reviewer runtime started.");
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
    mocks.fetchLatestPlannerRun.mockResolvedValue({ run: completed, events: [] });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(750);
    });

    expect(onLatestRunChange).toHaveBeenCalledTimes(2);
    expect(onLatestRunChange).toHaveBeenLastCalledWith(completed);
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
    );
    expect(textarea.value).toBe("");
    expect(container.querySelector('[data-testid="pending-reviewer-message"]')?.textContent)
      .toContain("Please review the risky parts.");
    expect(container.textContent).toContain("Starting reviewer…");
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });

    await act(async () => {
      mocks.fetchLatestPlannerRun.mockResolvedValue({
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
      events: [{ runId: "run-progress", seq: 1, type: "model_activity", message: "Inspecting files" }],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(container.textContent).toContain("Inspecting files");
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("follows progress immediately while the transcript is already near the bottom", async () => {
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
      events: [{ runId: "run-progress", seq: 1, type: "model_activity", message: "Inspecting files" }],
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
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
