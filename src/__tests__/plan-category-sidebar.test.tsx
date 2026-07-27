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
});
