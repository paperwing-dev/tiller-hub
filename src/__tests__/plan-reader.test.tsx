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

  it("uses a placeholder instead of inserting a title into a newly created plan", () => {
    const emptyPlan: PlanArtifact = {
      ...plan,
      id: "plan-new",
      title: "",
      body: { markdown: "" },
      version: 1,
    };
    act(() => {
      root?.render(<PlanReader plan={emptyPlan} blueprint onSave={async () => undefined} />);
    });

    expect(container.querySelector("textarea")).toBeNull();
    expect(findButton(container, "Edit")).toBeTruthy();

    act(() => {
      findButton(container, "Edit").click();
    });
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Plan Markdown"]');
    expect(textarea?.value).toBe("");
    expect(textarea?.placeholder).toBe("# Untitled Plan");
  });

  it("connects draft discard and disables it for later plan states", () => {
    const onDiscard = vi.fn();
    act(() => {
      root?.render(<PlanReader plan={plan} blueprint onDiscard={onDiscard} />);
    });

    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Discard plan"]')?.click();
    });
    expect(onDiscard).toHaveBeenCalledOnce();

    act(() => {
      root?.render(<PlanReader plan={{ ...plan, status: "todo" }} blueprint onDiscard={onDiscard} />);
    });
    const disabledDiscard = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Discard plan (drafts only)"]',
    );
    expect(disabledDiscard).toBeDisabled();
  });

  it.each([
    ["draft", "Draft"],
    ["evaluating", "Review"],
    ["todo", "Ready"],
    ["completed", "Done"],
    ["archived", "Archived"],
  ] as const)("checks the actual %s plan status", (status, label) => {
    act(() => {
      root?.render(<PlanReader plan={{ ...plan, status }} blueprint showStatus />);
    });

    const radios = [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
    expect(radios).toHaveLength(5);
    expect(radios.every((radio) => radio.classList.contains("sr-only"))).toBe(true);
    expect(container.querySelectorAll("[data-plan-status-indicator]")).toHaveLength(5);
    expect(container.querySelector("[data-plan-status-indicator].rounded-full")).toBeNull();
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1);
    const checkedRadio = radios.find((radio) => radio.checked);
    expect(checkedRadio).toHaveAttribute(
      "aria-label",
      `Plan status: ${label}`,
    );
    expect(checkedRadio?.nextElementSibling).toHaveClass(
      "peer-checked:border-[var(--tiller-theme-action)]",
      "peer-checked:bg-[var(--tiller-theme-action)]",
    );
    expect(checkedRadio?.nextElementSibling?.querySelector(".tiller-plan-status-check"))
      .not.toBeNull();
  });

  it.each([
    ["Done", "completed"],
    ["Archived", "archived"],
  ] as const)("moves a plan to %s using its distinct status", (label, status) => {
    const onStatusChange = vi.fn();
    act(() => {
      root?.render(
        <PlanReader
          plan={plan}
          blueprint
          showStatus
          onStatusChange={onStatusChange}
        />,
      );
    });

    act(() => {
      container.querySelector<HTMLInputElement>(`input[aria-label="Plan status: ${label}"]`)?.click();
    });

    expect(onStatusChange).toHaveBeenCalledWith(status);
  });

  it("preserves rendered plan text across metadata-only refreshes", () => {
    act(() => {
      root?.render(<PlanReader plan={plan} blueprint />);
    });
    const paragraph = [...container.querySelectorAll("p")]
      .find((candidate) => candidate.textContent === "Render headings and lists.");
    const originalTextNode = paragraph?.firstChild;
    expect(originalTextNode).toBeInstanceOf(Text);

    act(() => {
      root?.render(<PlanReader plan={{ ...plan }} blueprint />);
    });
    const refreshedParagraph = [...container.querySelectorAll("p")]
      .find((candidate) => candidate.textContent === "Render headings and lists.");
    expect(refreshedParagraph?.firstChild).toBe(originalTextNode);
    expect(originalTextNode?.isConnected).toBe(true);
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
