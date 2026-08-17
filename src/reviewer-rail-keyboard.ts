export interface ReviewerRailKeyboardNode {
  id: string;
  parentId?: string;
  expandable?: boolean;
  expanded?: boolean;
  firstChildId?: string;
}

export type ReviewerRailKeyboardAction =
  | { kind: "focus"; id: string }
  | { kind: "expand"; id: string }
  | { kind: "collapse"; id: string };

export function resolveReviewerRailKeyboardAction(
  key: string,
  currentId: string,
  visibleNodes: ReviewerRailKeyboardNode[],
): ReviewerRailKeyboardAction | null {
  const index = visibleNodes.findIndex((node) => node.id === currentId);
  if (index < 0) return null;
  const current = visibleNodes[index]!;
  if (key === "Home") return { kind: "focus", id: visibleNodes[0]!.id };
  if (key === "End") {
    return { kind: "focus", id: visibleNodes[visibleNodes.length - 1]!.id };
  }
  if (key === "ArrowUp") {
    return { kind: "focus", id: visibleNodes[Math.max(0, index - 1)]!.id };
  }
  if (key === "ArrowDown") {
    return {
      kind: "focus",
      id: visibleNodes[Math.min(visibleNodes.length - 1, index + 1)]!.id,
    };
  }
  if (key === "ArrowRight" && current.expandable) {
    if (!current.expanded) return { kind: "expand", id: current.id };
    if (current.firstChildId) {
      return { kind: "focus", id: current.firstChildId };
    }
  }
  if (key === "ArrowLeft") {
    if (current.expandable && current.expanded) {
      return { kind: "collapse", id: current.id };
    }
    if (current.parentId) return { kind: "focus", id: current.parentId };
  }
  return null;
}
