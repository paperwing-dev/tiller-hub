/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact, PlanStatus } from "../../api/coordination/types";
import PlanCategorySidebar from "../PlanCategorySidebar";

let root: Root | null;

function makePlan(
  id: string,
  status: PlanStatus,
  title: string,
  updatedAt: string,
): Artifact {
  return {
    id,
    repoId: "repo-1",
    type: "plan",
    basis: { repoId: "repo-1", mainCommit: "main-a" },
    title,
    body: { markdown: `# ${title}\n\nPlan body.` },
    status,
    createdAt: updatedAt,
    updatedAt,
    version: 1,
  };
}

function renderSidebar(props: Partial<React.ComponentProps<typeof PlanCategorySidebar>> = {}) {
  const artifacts = [
    makePlan("draft-1", "draft", "Draft plan", "2026-05-01T00:00:00.000Z"),
    makePlan("evaluating-1", "evaluating", "Evaluating plan", "2026-05-02T12:00:00.000Z"),
    makePlan("todo-1", "todo", "Todo plan", "2026-05-02T00:00:00.000Z"),
    makePlan("done-1", "completed", "Done plan", "2026-05-03T00:00:00.000Z"),
    makePlan("archived-1", "archived", "Archived plan", "2026-05-04T00:00:00.000Z"),
  ];
  act(() => {
    root?.render(
      <PlanCategorySidebar
        artifacts={artifacts}
        selectedPlanArtifactId={null}
        repoMainCommit="main-a"
        onSelect={vi.fn()}
        onMove={vi.fn()}
        onDiscard={vi.fn()}
        {...props}
      />,
    );
  });
}

describe("PlanCategorySidebar", () => {
  const originalReact = (globalThis as typeof globalThis & { React?: typeof React }).React;
  let container: HTMLDivElement;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: React,
    });
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
    document.body.innerHTML = "";
    Object.defineProperty(globalThis, "React", {
      configurable: true,
      value: originalReact,
    });
  });

  it("renders Done and Archived as collapsed folders by default", () => {
    renderSidebar();

    expect(document.body.textContent).toContain("Draft plan");
    expect(document.body.textContent).toContain("Evaluating plan");
    expect(document.body.textContent).toContain("Todo plan");
    expect(document.body.textContent).not.toContain("Done plan");
    expect(document.body.textContent).not.toContain("Archived plan");

    const doneButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Done"));
    expect(doneButton).toBeInstanceOf(HTMLButtonElement);
    expect(doneButton).toHaveAttribute("aria-expanded", "false");

    act(() => {
      doneButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(doneButton).toHaveAttribute("aria-expanded", "true");
    expect(document.body.textContent).toContain("Done plan");
  });

  it("opens the selected plan folder", () => {
    renderSidebar({ selectedPlanArtifactId: "archived-1" });

    const archivedButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Archived"));
    expect(archivedButton).toHaveAttribute("aria-expanded", "true");
    expect(document.body.textContent).toContain("Archived plan");
  });

  it("keeps completed and archived plans in separate simplified folders", () => {
    renderSidebar({ simplified: true });

    const folderButtons = Array.from(document.body.querySelectorAll("[data-plan-section-toggle]"));
    expect(folderButtons.map((button) => button.getAttribute("data-plan-section-toggle"))).toEqual([
      "draft",
      "review",
      "ready",
      "done",
      "history",
    ]);
    expect(folderButtons.find((button) => button.getAttribute("data-plan-section-toggle") === "done"))
      .toHaveTextContent("Done1");
    expect(folderButtons.find((button) => button.getAttribute("data-plan-section-toggle") === "history"))
      .toHaveTextContent("Archived1");
  });

  it("shows plan revisions instead of reviewer counts", () => {
    const artifacts = [
      { ...makePlan("evaluating-1", "evaluating", "Evaluating plan", "2026-05-02T12:00:00.000Z"), version: 3 },
    ];
    renderSidebar({ simplified: true, artifacts });

    const planButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Evaluating plan"));
    expect(planButton).toHaveTextContent("Version 2");
    expect(planButton).not.toHaveTextContent("review");

    act(() => {
      planButton?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    expect(document.querySelector('[data-testid="plan-hover-card"]')).toHaveTextContent("2 revisions");
  });

  it("shows blue update markers only for active plan folders", () => {
    renderSidebar({ simplified: true, attentionPlanIds: new Set(["draft-1", "archived-1"]) });

    const draftFolder = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Draft") && !button.textContent.includes("Draft plan"));
    const draftPlan = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Draft plan"));
    const archivedFolder = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Archived"));
    expect(draftFolder?.querySelector('[data-workspace-signal="update"]')).not.toBeNull();
    expect(draftPlan?.querySelector('[data-workspace-signal="update"]')).not.toBeNull();
    expect(archivedFolder?.querySelector('[data-workspace-signal="update"]')).toBeNull();

    act(() => {
      archivedFolder?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const archivedPlan = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.textContent?.includes("Archived plan"));
    expect(archivedPlan?.querySelector('[data-workspace-signal="update"]')).toBeNull();
  });

  it("shows Risk and Change Size in Health detail without adding badges", () => {
    const artifacts = [
      makePlan("unknown", "draft", "Unknown risk", "2026-05-01T00:00:00.000Z"),
      {
        ...makePlan("fresh", "evaluating", "Fresh risk", "2026-05-02T00:00:00.000Z"),
        planHealth: {
          schemaVersion: 1 as const,
          assessments: {
            risk: {
              level: "low" as const,
              summary: "Localized and reversible.",
            },
            changeSize: {
              size: "small" as const,
              summary: "Localized to one component.",
            },
          },
          assessedAt: "2026-05-02T01:00:00.000Z",
          basisVersion: 1,
          skillInvocationId: "risk-fresh",
        },
      },
      {
        ...makePlan("stale", "todo", "Stale risk", "2026-05-03T00:00:00.000Z"),
        planHealth: {
          schemaVersion: 1 as const,
          assessments: {
            risk: {
              level: "high" as const,
              summary: "Security boundary changes.",
            },
            changeSize: {
              size: "large" as const,
              summary: "The work crosses system boundaries.",
            },
          },
          assessedAt: "2026-05-03T01:00:00.000Z",
          basisVersion: 1,
          skillInvocationId: "risk-stale",
          staleAt: "2026-05-04T00:00:00.000Z",
        },
      },
    ];
    renderSidebar({ artifacts, simplified: true });

    expect(document.querySelectorAll("[data-risk-level]")).toHaveLength(0);
    expect(document.querySelectorAll("[data-change-size]")).toHaveLength(0);
    for (const [title, riskLabel, sizeLabel, accessible] of [
      ["Unknown risk", "Risk · Unknown", "Change size · Unknown", "Risk Unknown. Change size Unknown."],
      ["Fresh risk", "Risk · Low", "Change size · Small", "Risk Low. Change size Small."],
      ["Stale risk", "Risk · High · stale", "Change size · Large · stale", "Risk High · stale. Change size Large · stale."],
    ]) {
      const planButton = Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.getAttribute("data-plan-row-title") === title);
      act(() => {
        planButton?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      });
      const card = document.querySelector('[data-testid="plan-hover-card"]');
      expect(card).toHaveTextContent(riskLabel);
      expect(card).toHaveTextContent(sizeLabel);
      expect(planButton).toHaveTextContent(accessible);
      expect(document.querySelector('[data-testid="plan-hover-card"] [data-risk-level]')).toBeNull();
      expect(document.querySelector('[data-testid="plan-hover-card"] [data-change-size]')).toBeNull();
    }
    expect(artifacts.map((plan) => [plan.id, plan.updatedAt, plan.version])).toEqual([
      ["unknown", "2026-05-01T00:00:00.000Z", 1],
      ["fresh", "2026-05-02T00:00:00.000Z", 1],
      ["stale", "2026-05-03T00:00:00.000Z", 1],
    ]);
  });

  it("uses the expanded Health hover-card height when clamping placement", () => {
    renderSidebar({ simplified: true });
    const planButton = Array.from(document.body.querySelectorAll("button"))
      .find((button) => button.getAttribute("data-plan-row-title") === "Draft plan")!;
    vi.spyOn(planButton, "getBoundingClientRect").mockReturnValue({
      top: 180,
      right: 200,
      left: 40,
      bottom: 220,
      width: 160,
      height: 40,
      x: 40,
      y: 180,
      toJSON: () => ({}),
    });
    Object.defineProperty(window, "innerHeight", {
      configurable: true,
      value: 200,
    });

    act(() => {
      planButton.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });

    expect(document.querySelector('[data-testid="plan-hover-card"]')).toHaveStyle({ top: "48px" });
  });
});
