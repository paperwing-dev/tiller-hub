/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanArtifact } from "../../api/coordination/types";
import PlanReader from "../PlanReader";

const plan: PlanArtifact = {
  id: "plan-1",
  repoId: "repo-1",
  type: "plan",
  basis: { repoId: "repo-1", mainCommit: "abc123" },
  title: "Markdown Plan",
  body: {
    markdown: [
      "## Summary",
      "",
      "Render headings and lists.",
      "",
      "## Test Plan",
      "",
      "- Open the plan.",
      "- Confirm headings are visible.",
    ].join("\n"),
  },
  status: "draft",
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  version: 2,
};

describe("PlanReader", () => {
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

  it("renders plan markdown headings and lists as semantic elements", () => {
    act(() => {
      root?.render(<PlanReader plan={plan} />);
    });

    expect(container.querySelector("h2")?.textContent).toBe("Summary");
    expect([...container.querySelectorAll("li")].map((item) => item.textContent)).toEqual([
      "Open the plan.",
      "Confirm headings are visible.",
    ]);
  });

  it("shows main refresh progress beneath the plan title", () => {
    act(() => {
      root?.render(<PlanReader plan={plan} mainUpdating />);
    });

    expect(container.querySelector('[role="status"]')?.textContent).toContain("Main updating");
  });

  it("edits, saves, and cancels plain Markdown", async () => {
    const onSave = vi.fn(async () => undefined);
    act(() => {
      root?.render(<PlanReader plan={plan} onSave={onSave} />);
    });

    act(() => {
      findButton(container, "Edit").click();
    });
    setTextareaValue(container.querySelector("textarea")!, "# Pasted plan\n\nReplacement.");
    await act(async () => {
      findButton(container, "Save").click();
      await Promise.resolve();
    });
    expect(onSave).toHaveBeenCalledWith("# Pasted plan\n\nReplacement.");
    expect(container.querySelector("textarea")).toBeNull();

    act(() => {
      findButton(container, "Edit").click();
    });
    setTextareaValue(container.querySelector("textarea")!, "Unsaved change");
    act(() => {
      findButton(container, "Cancel").click();
    });
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("h2")?.textContent).toBe("Summary");
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("requires clicking Edit before editing a newly created plan", () => {
    const emptyPlan: PlanArtifact = {
      ...plan,
      id: "plan-new",
      title: "",
      body: { markdown: "" },
      version: 1,
    };
    act(() => {
      root?.render(<PlanReader plan={emptyPlan} onSave={async () => undefined} />);
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect(container.textContent).toContain("This plan is empty.");
    expect(findButton(container, "Edit")).toBeTruthy();

    act(() => {
      findButton(container, "Edit").click();
    });
    expect(container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Plan Markdown"]')?.value).toBe("");
  });

  it.each(["completed", "archived"] as const)("keeps %s plans read-only", (status) => {
    act(() => {
      root?.render(
        <PlanReader
          plan={{ ...plan, status }}
          onSave={async () => undefined}
        />,
      );
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect([...container.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Edit")).toBe(false);
  });
});

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`Missing ${label} button`);
  return button;
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
