/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewerRegistryEntry } from "../../api/coordination/types";
import PlanChatTabs from "../PlanChatTabs";
import type { PlanTabStatus } from "../plan-tab-status";
import type { PlannerProviderMetadata } from "../api";

const providers: PlannerProviderMetadata[] = [
  {
    id: "codex",
    displayName: "Codex",
    available: true,
    authStatus: "available",
    disabledReasons: [],
    capabilities: {
      writer: true,
      reviewer: true,
      chatContinuation: true,
      cancellation: true,
      planDelta: true,
      checklist: true,
    },
    models: [
      {
        id: "gpt-5.5",
        displayName: "GPT-5.5",
        available: true,
        authStatus: "available",
      },
    ],
    efforts: [{ id: "high", displayName: "High" }],
    defaultEffort: "high",
  },
];

const reviewers: ReviewerRegistryEntry[] = [
  {
    threadId: "reviewer-1",
    repoId: "repo-1",
    planArtifactId: "plan-1",
    provider: "codex",
    model: "gpt-5.5",
    role: "reviewer",
    reviewerModel: "gpt-5.5",
    createdAt: "2026-06-20T00:00:00.000Z",
    updatedAt: "2026-06-20T00:00:00.000Z",
  },
];

const writerTabStatus: PlanTabStatus = {
  kind: "running",
  label: "Live",
  detail: "The live Scribe is ready. GPT-5.5 · High reasoning.",
};

const reviewerTabStatuses = new Map<string, PlanTabStatus>([[
  "reviewer-1",
  {
    kind: "working",
    label: "Working",
    detail: "The reviewer is analyzing the plan. GPT-5.5 · High reasoning.",
    runId: "run-1",
  },
]]);

describe("PlanChatTabs", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    container.remove();
    root = null;
  });

  it("always renders descriptive, accessible status indicators for writer and reviewers", () => {
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="writer"
          writerTabStatus={writerTabStatus}
          pendingScribeCount={2}
          reviewerTabStatuses={reviewerTabStatuses}
          onActiveTabChange={vi.fn()}
          onOpenPlanSkills={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="Scribe, Live, 2 items waiting"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="GPT-5.5, Working"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-tab-status="running"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-tab-status="working"]')).not.toBeNull();
    expect(container.textContent).toContain("Scribe");
    expect(container.textContent).toContain("2");
    expect(container.textContent).not.toContain("Plan Writer");
  });

  it("does not show the pending-item count beside Scribe in the compact agent rail", () => {
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={[]}
          providers={providers}
          activeTab="writer"
          writerTabStatus={writerTabStatus}
          pendingScribeCount={1}
          compact
          onActiveTabChange={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="Scribe, Live"]')).not.toBeNull();
    expect(container.textContent).not.toContain("1");
    expect(container.textContent).toContain("Edits the plan");
    expect(container.textContent).toContain("Advises on this plan");
    expect(container.textContent).toContain("Live");
    expect(container.querySelector('[data-agent-card-signal][data-agent-tab-status="running"]')).not.toBeNull();
  });

  it("keeps the active compact reviewer label and status readable", () => {
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="reviewer-1"
          writerTabStatus={writerTabStatus}
          reviewerTabStatuses={reviewerTabStatuses}
          compact
          onActiveTabChange={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    const reviewerButton = container.querySelector<HTMLButtonElement>('button[aria-label="GPT-5.5, Working"]');
    expect(reviewerButton).not.toBeNull();
    expect(reviewerButton?.textContent).toContain("Reviewer");
    expect(reviewerButton?.textContent).toContain("Working");
    expect(reviewerButton).toHaveClass("w-0", "flex-1");
    const workingSignal = reviewerButton?.querySelector('[data-agent-card-signal][data-agent-tab-status="working"]');
    expect(workingSignal?.tagName).toBe("SPAN");
    expect(workingSignal).toHaveClass("animate-spin", "rounded-full", "border-r-transparent");

    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="reviewer-1"
          writerTabStatus={writerTabStatus}
          reviewerTabStatuses={new Map([[
            "reviewer-1",
            {
              kind: "finished",
              label: "New result",
              detail: "The reviewer response is ready.",
              runId: "run-1",
            },
          ]])}
          compact
          onActiveTabChange={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    const finishedSignal = container.querySelector('[data-agent-card-signal][data-agent-tab-status="finished"]');
    expect(finishedSignal?.tagName).toBe("svg");
    expect(finishedSignal).toHaveClass("text-[var(--paperwing-signal-update)]");
    expect(container.querySelector('[data-agent-card-signal][data-agent-tab-status="working"]')).toBeNull();
  });

  it("keeps one tab stop per compact tree row and opens row actions from the keyboard", () => {
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="reviewer-1"
          writerTabStatus={writerTabStatus}
          reviewerTabStatuses={reviewerTabStatuses}
          compact
          onActiveTabChange={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
          onOpenReviewerSettings={vi.fn()}
        />,
      );
    });

    const tree = container.querySelector<HTMLElement>('[role="tree"]');
    expect(tree).not.toBeNull();
    expect(tree?.querySelectorAll('[role="treeitem"][tabindex="0"]')).toHaveLength(1);
    for (const control of tree?.querySelectorAll<HTMLButtonElement>('button:not([role="treeitem"])') ?? []) {
      expect(control.tabIndex).toBe(-1);
    }

    const reviewer = tree?.querySelectorAll<HTMLButtonElement>('[role="treeitem"]')[1];
    act(() => {
      reviewer?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "F10",
        shiftKey: true,
      }));
    });
    expect(container.querySelector<HTMLButtonElement>('button[aria-label^="Actions for"]')?.getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("explains what a reviewer does in the compact add flow", () => {
    const onOpenPlanSkills = vi.fn();
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={[]}
          providers={providers}
          activeTab="writer"
          writerTabStatus={writerTabStatus}
          compact
          onActiveTabChange={vi.fn()}
          onOpenPlanSkills={onOpenPlanSkills}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    const addReviewer = container.querySelector<HTMLButtonElement>('button[aria-label="Add reviewer"]');
    const planSkillSettings = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Reviewer skill settings"]',
    );
    const headerButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        ".tiller-agent-switcher-header button",
      ),
    );
    expect(addReviewer).toHaveClass("size-8");
    expect(addReviewer).not.toHaveClass("size-10");
    expect(headerButtons.indexOf(planSkillSettings as HTMLButtonElement))
      .toBeLessThan(headerButtons.indexOf(addReviewer as HTMLButtonElement));

    act(() => {
      planSkillSettings?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenPlanSkills).toHaveBeenCalledOnce();

    act(() => {
      addReviewer?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      "Start a reusable reviewer conversation or launch a saved skill.",
    );
  });

  it("keeps plan skills on the settings icon instead of duplicating them in Scribe actions", () => {
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={[]}
          providers={providers}
          activeTab="writer"
          writerTabStatus={writerTabStatus}
          compact
          onActiveTabChange={vi.fn()}
          onOpenPlanSkills={vi.fn()}
          onWriterSettings={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    const writerActions = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Actions for Scribe"]',
    );
    act(() => {
      writerActions?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(document.body.textContent).toContain("Scribe settings");
    expect(document.body.textContent).not.toContain("Plan workflows");
  });

  it("shows Scribe attention without replacing its live lifecycle status", () => {
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="reviewer-1"
          writerTabStatus={writerTabStatus}
          writerNeedsAttention={true}
          reviewerTabStatuses={reviewerTabStatuses}
          onActiveTabChange={vi.fn()}
          onOpenPlanSkills={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    expect(container.querySelector('button[aria-label="Scribe, Live, needs attention"]')).not.toBeNull();
    expect(container.querySelector('[data-agent-tab-status="running"]')).not.toBeNull();
  });

  it("groups the Scribe as editor and reviewers as advisors", () => {
    const onOpenPlanSkills = vi.fn();
    const onActiveTabChange = vi.fn();
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="reviewer-1"
          writerTabStatus={writerTabStatus}
          onActiveTabChange={onActiveTabChange}
          onOpenPlanSkills={onOpenPlanSkills}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    const editorGroup = container.querySelector('[role="group"][aria-label="Edits the plan"]');
    const advisorGroup = container.querySelector('[role="group"][aria-label="Advises on this plan"]');
    expect(editorGroup?.textContent).toContain("Scribe");
    expect(advisorGroup?.textContent).toContain("GPT-5.5");
    expect(advisorGroup?.textContent).toContain("+ Reviewer");

    const removeReviewerButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Remove reviewer");
    expect(removeReviewerButton).toHaveClass("text-kumo-danger", "border-kumo-danger/30");
    expect(removeReviewerButton).not.toHaveClass("text-kumo-subtle");

    const planSkillsButton = Array.from(container.querySelectorAll("button"))
      .find((button) => button.textContent?.trim() === "Plan Skills");
    expect(planSkillsButton).toBeInstanceOf(HTMLButtonElement);

    act(() => {
      planSkillsButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onOpenPlanSkills).toHaveBeenCalledOnce();
    expect(onActiveTabChange).not.toHaveBeenCalled();
  });

  it("keeps status indicators non-interactive and separates writer from reviewer tabs", () => {
    const onActiveTabChange = vi.fn();
    act(() => {
      root?.render(
        <PlanChatTabs
          reviewers={reviewers}
          providers={providers}
          activeTab="writer"
          writerTabStatus={writerTabStatus}
          reviewerTabStatuses={reviewerTabStatuses}
          onActiveTabChange={onActiveTabChange}
          onOpenPlanSkills={vi.fn()}
          onAddReviewer={vi.fn()}
          onCloseReviewer={vi.fn()}
        />,
      );
    });

    const reviewerStatus = container.querySelector<HTMLElement>('[data-agent-tab-status="working"]');
    expect(reviewerStatus).not.toBeNull();
    expect(container.querySelector('[role="separator"][aria-orientation="vertical"]')).not.toBeNull();

    act(() => {
      reviewerStatus?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onActiveTabChange).toHaveBeenCalledOnce();
    expect(onActiveTabChange).toHaveBeenCalledWith("reviewer-1");
  });

  it("renders stopped neutrally and errors in red", () => {
    const renderWithStatus = (status: PlanTabStatus) => {
      act(() => {
        root?.render(
          <PlanChatTabs
            reviewers={reviewers}
            providers={providers}
            activeTab="writer"
            writerTabStatus={writerTabStatus}
            reviewerTabStatuses={new Map([["reviewer-1", status]])}
            onActiveTabChange={vi.fn()}
            onOpenPlanSkills={vi.fn()}
            onAddReviewer={vi.fn()}
            onCloseReviewer={vi.fn()}
          />,
        );
      });
    };

    renderWithStatus({ kind: "stopped", label: "Stopped", detail: "The reviewer was stopped." });
    expect(container.querySelector('[data-agent-tab-status="stopped"]')?.getAttribute("class"))
      .toContain("text-kumo-subtle");

    renderWithStatus({ kind: "error", label: "Error", detail: "The reviewer failed." });
    expect(container.querySelector('[data-agent-tab-status="error"]')?.getAttribute("class"))
      .toContain("text-kumo-danger");
  });

  it("uses an accent notification for new results without painting a square behind it", () => {
    const renderWithStatus = (status: PlanTabStatus) => {
      act(() => {
        root?.render(
          <PlanChatTabs
            reviewers={reviewers}
            providers={providers}
            activeTab="writer"
            writerTabStatus={writerTabStatus}
            reviewerTabStatuses={new Map([["reviewer-1", status]])}
            onActiveTabChange={vi.fn()}
            onOpenPlanSkills={vi.fn()}
            onAddReviewer={vi.fn()}
            onCloseReviewer={vi.fn()}
          />,
        );
      });
    };

    renderWithStatus({ kind: "finished", label: "New result", detail: "A new result is ready." });
    expect(container.querySelector('[data-agent-tab-status="finished"]')?.getAttribute("class"))
      .toContain("text-[var(--paperwing-signal-update)]");
    expect(container.querySelector('[data-agent-tab-status="finished"]')?.getAttribute("class"))
      .not.toContain("bg-kumo-info");

    renderWithStatus({ kind: "viewed", label: "Viewed", detail: "The result was viewed." });
    expect(container.querySelector('[data-agent-tab-status="viewed"]')?.getAttribute("class"))
      .toContain("text-kumo-subtle");
    expect(container.querySelector('button[aria-label="GPT-5.5, Viewed"]')).not.toBeNull();
  });
});
