/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResizablePlanPanes from "../ResizablePlanPanes";

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

function mockLayoutHeight(getHeight: () => number): void {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const element = this;
    if (element.dataset.testid === "plan-pane-layout") return rect(getHeight());
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

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ResizablePlanPanes", () => {
  it("gives the Plan artifact a constrained flex scroll context", () => {
    render(
      <ResizablePlanPanes
        artifact={<div className="min-h-0 flex-1 overflow-y-auto">Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );

    expect(screen.getByTestId("plan-artifact-pane"))
      .toHaveClass("flex", "min-h-0", "flex-col", "overflow-hidden");
    expect(screen.queryByRole("button", { name: "Minimize agent terminal" }))
      .not.toBeInTheDocument();
    expect(screen.getByTestId("plan-reviewers-pane")).not.toHaveAttribute("hidden");
  });

  it("resizes the Plan artifact and Plan Reviewers panes by dragging the divider", () => {
    render(
      <ResizablePlanPanes
        artifact={<div>Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );

    const layout = screen.getByTestId("plan-pane-layout");
    const reviewers = screen.getByTestId("plan-reviewers-pane");
    const divider = screen.getByRole("separator", {
      name: "Resize Plan and Plan Collaborators",
    });
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect(800));
    vi.spyOn(reviewers, "getBoundingClientRect").mockReturnValue(rect(320));

    expect(divider).toHaveAttribute("aria-orientation", "horizontal");
    fireEvent.pointerDown(divider, { button: 0, clientY: 500, pointerId: 1 });
    fireEvent.pointerMove(window, { clientY: 400, pointerId: 1 });

    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 420px");

    fireEvent.pointerUp(window, { pointerId: 1 });
    expect(window.localStorage.getItem("tiller:plan-reviewers-height")).toBe("420");
    fireEvent.pointerMove(window, { clientY: 300, pointerId: 1 });
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 420px");

    fireEvent.pointerDown(divider, { button: 0, clientY: 500, pointerId: 2 });
    fireEvent.pointerMove(window, { clientY: 1_000, pointerId: 2 });
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 160px");
    fireEvent.pointerUp(window, { pointerId: 2 });
    expect(window.localStorage.getItem("tiller:plan-reviewers-height")).toBe("160");
  });

  it("supports keyboard resizing and keeps both panes usable", () => {
    render(
      <ResizablePlanPanes
        artifact={<div>Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );

    const layout = screen.getByTestId("plan-pane-layout");
    const reviewers = screen.getByTestId("plan-reviewers-pane");
    const divider = screen.getByRole("separator", {
      name: "Resize Plan and Plan Collaborators",
    });
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect(800));
    vi.spyOn(reviewers, "getBoundingClientRect").mockReturnValue(rect(320));

    fireEvent.keyDown(divider, { key: "ArrowUp" });
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 344px");
    expect(window.localStorage.getItem("tiller:plan-reviewers-height")).toBe("344");

    fireEvent.pointerDown(divider, { button: 0, clientY: 500, pointerId: 2 });
    fireEvent.pointerMove(window, { clientY: -500, pointerId: 2 });
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 668px");
    fireEvent.pointerUp(window, { pointerId: 2 });
  });

  it("restores and clamps a persisted reviewer height", () => {
    mockLayoutHeight(() => 800);
    window.localStorage.setItem("tiller:plan-reviewers-height", "700");

    render(
      <ResizablePlanPanes
        artifact={<div>Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );

    expect(screen.getByTestId("plan-pane-layout").style.gridTemplateRows)
      .toBe("minmax(0, 1fr) 4px 668px");
  });

  it("ignores malformed persisted heights", () => {
    mockLayoutHeight(() => 800);
    window.localStorage.setItem("tiller:plan-reviewers-height", "not-a-height");

    render(
      <ResizablePlanPanes
        artifact={<div>Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );

    expect(screen.getByTestId("plan-pane-layout").style.gridTemplateRows)
      .toBe("minmax(0, 1fr) 4px minmax(160px, 0.9fr)");
  });

  it("re-clamps the preferred height when its container changes size", () => {
    let containerHeight = 800;
    mockLayoutHeight(() => containerHeight);
    const observer = installResizeObserver();
    window.localStorage.setItem("tiller:plan-reviewers-height", "500");

    render(
      <ResizablePlanPanes
        artifact={<div>Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );
    const layout = screen.getByTestId("plan-pane-layout");
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 500px");

    containerHeight = 500;
    act(() => observer.notify());
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 368px");

    containerHeight = 900;
    act(() => observer.notify());
    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 500px");
  });

  it("keeps keyboard resizing available when storage writes fail", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage disabled");
    });
    render(
      <ResizablePlanPanes
        artifact={<div>Plan artifact</div>}
        reviewers={<div>Plan Reviewers</div>}
      />,
    );
    const layout = screen.getByTestId("plan-pane-layout");
    const reviewers = screen.getByTestId("plan-reviewers-pane");
    vi.spyOn(layout, "getBoundingClientRect").mockReturnValue(rect(800));
    vi.spyOn(reviewers, "getBoundingClientRect").mockReturnValue(rect(320));

    fireEvent.keyDown(screen.getByRole("separator"), { key: "ArrowUp" });

    expect(layout.style.gridTemplateRows).toBe("minmax(0, 1fr) 4px 344px");
  });
});
