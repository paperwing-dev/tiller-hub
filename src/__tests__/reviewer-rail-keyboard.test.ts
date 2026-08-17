import { describe, expect, it } from "vitest";
import { resolveReviewerRailKeyboardAction } from "../reviewer-rail-keyboard";

const expandedTree = [
  { id: "scribe" },
  { id: "skill", expandable: true, expanded: true, firstChildId: "report" },
  { id: "report", parentId: "skill" },
  { id: "reviewer" },
];

describe("reviewer rail keyboard navigation", () => {
  it("moves through visible rows and supports Home and End", () => {
    expect(resolveReviewerRailKeyboardAction("ArrowDown", "skill", expandedTree))
      .toEqual({ kind: "focus", id: "report" });
    expect(resolveReviewerRailKeyboardAction("ArrowUp", "skill", expandedTree))
      .toEqual({ kind: "focus", id: "scribe" });
    expect(resolveReviewerRailKeyboardAction("Home", "reviewer", expandedTree))
      .toEqual({ kind: "focus", id: "scribe" });
    expect(resolveReviewerRailKeyboardAction("End", "scribe", expandedTree))
      .toEqual({ kind: "focus", id: "reviewer" });
  });

  it("expands, enters, collapses, and exits skill roots", () => {
    expect(resolveReviewerRailKeyboardAction("ArrowRight", "skill", [
      { id: "skill", expandable: true, expanded: false, firstChildId: "report" },
    ])).toEqual({ kind: "expand", id: "skill" });
    expect(resolveReviewerRailKeyboardAction("ArrowRight", "skill", expandedTree))
      .toEqual({ kind: "focus", id: "report" });
    expect(resolveReviewerRailKeyboardAction("ArrowLeft", "skill", expandedTree))
      .toEqual({ kind: "collapse", id: "skill" });
    expect(resolveReviewerRailKeyboardAction("ArrowLeft", "report", expandedTree))
      .toEqual({ kind: "focus", id: "skill" });
  });
});
