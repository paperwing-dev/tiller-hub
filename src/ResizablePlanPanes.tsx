import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

const DIVIDER_HEIGHT = 4;
const MIN_ARTIFACT_HEIGHT = 180;
const MIN_REVIEWERS_HEIGHT = 220;
const KEYBOARD_RESIZE_STEP = 24;
const REVIEWERS_HEIGHT_STORAGE_KEY = "tiller:plan-reviewers-height";

interface ResizablePlanPanesProps {
  artifact: ReactNode;
  reviewers: ReactNode;
}

interface DragState {
  startY: number;
  startReviewersHeight: number;
  containerHeight: number;
}

function clampReviewersHeight(height: number, containerHeight: number): number {
  const availableHeight = Math.max(0, containerHeight - DIVIDER_HEIGHT);
  const sharedMinimum = Math.max(0, Math.floor(availableHeight / 2));
  const minimum = Math.min(MIN_REVIEWERS_HEIGHT, sharedMinimum);
  const artifactMinimum = Math.min(MIN_ARTIFACT_HEIGHT, sharedMinimum);
  const maximum = Math.max(minimum, availableHeight - artifactMinimum);
  return Math.min(maximum, Math.max(minimum, height));
}

function readStoredReviewersHeight(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(REVIEWERS_HEIGHT_STORAGE_KEY);
    if (stored === null || stored.trim() === "") return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeReviewersHeight(height: number): void {
  try {
    window.localStorage.setItem(REVIEWERS_HEIGHT_STORAGE_KEY, String(height));
  } catch {
    // Resizing remains available when browser storage is disabled or full.
  }
}

export default function ResizablePlanPanes({
  artifact,
  reviewers,
}: ResizablePlanPanesProps) {
  const [initialReviewersHeight] = useState(readStoredReviewersHeight);
  const [reviewersHeight, setReviewersHeight] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const reviewersRef = useRef<HTMLDivElement | null>(null);
  const preferredHeightRef = useRef<number | null>(initialReviewersHeight);
  const renderedHeightRef = useRef<number | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  const updateReviewersHeight = useCallback((nextHeight: number) => {
    renderedHeightRef.current = nextHeight;
    setReviewersHeight(nextHeight);
  }, []);

  const reclampHeight = useCallback(() => {
    const container = containerRef.current;
    const preferredHeight = preferredHeightRef.current;
    if (!container || preferredHeight === null) return;
    const containerHeight = container.getBoundingClientRect().height;
    if (!Number.isFinite(containerHeight) || containerHeight <= 0) return;
    updateReviewersHeight(clampReviewersHeight(preferredHeight, containerHeight));
  }, [updateReviewersHeight]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    reclampHeight();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(reclampHeight);
    observer?.observe(container);
    window.addEventListener("resize", reclampHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reclampHeight);
    };
  }, [reclampHeight]);

  const handleDrag = useCallback((event: MouseEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    const nextHeight =
      dragState.startReviewersHeight + dragState.startY - event.clientY;
    const clampedHeight = clampReviewersHeight(nextHeight, dragState.containerHeight);
    preferredHeightRef.current = clampedHeight;
    updateReviewersHeight(clampedHeight);
  }, [updateReviewersHeight]);

  const stopDrag = useCallback(() => {
    if (dragStateRef.current) {
      const committedHeight = renderedHeightRef.current
        ?? dragStateRef.current.startReviewersHeight;
      preferredHeightRef.current = committedHeight;
      storeReviewersHeight(committedHeight);
      dragStateRef.current = null;
    }
    window.removeEventListener("mousemove", handleDrag);
    window.removeEventListener("mouseup", stopDrag);
  }, [handleDrag]);

  useEffect(
    () => () => {
      window.removeEventListener("mousemove", handleDrag);
      window.removeEventListener("mouseup", stopDrag);
    },
    [handleDrag, stopDrag],
  );

  const startDrag = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      const reviewersPane = reviewersRef.current;
      if (!container || !reviewersPane) return;
      event.preventDefault();
      dragStateRef.current = {
        startY: event.clientY,
        startReviewersHeight: reviewersPane.getBoundingClientRect().height,
        containerHeight: container.getBoundingClientRect().height,
      };
      preferredHeightRef.current = dragStateRef.current.startReviewersHeight;
      renderedHeightRef.current = dragStateRef.current.startReviewersHeight;
      window.addEventListener("mousemove", handleDrag);
      window.addEventListener("mouseup", stopDrag);
    },
    [handleDrag, stopDrag],
  );

  const resizeWithKeyboard = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      const container = containerRef.current;
      const reviewersPane = reviewersRef.current;
      if (!container || !reviewersPane) return;
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? 1 : -1;
      const currentHeight =
        reviewersHeight ?? reviewersPane.getBoundingClientRect().height;
      const nextHeight = clampReviewersHeight(
        currentHeight + direction * KEYBOARD_RESIZE_STEP,
        container.getBoundingClientRect().height,
      );
      preferredHeightRef.current = nextHeight;
      updateReviewersHeight(nextHeight);
      storeReviewersHeight(nextHeight);
    },
    [reviewersHeight, updateReviewersHeight],
  );

  return (
    <div
      ref={containerRef}
      data-testid="plan-pane-layout"
      className="grid min-h-0 flex-1"
      style={{
        gridTemplateRows:
          reviewersHeight === null
            ? "minmax(0, 1fr) 4px minmax(220px, 0.9fr)"
            : `minmax(0, 1fr) 4px ${reviewersHeight}px`,
      }}
    >
      <div
        data-testid="plan-artifact-pane"
        className="flex min-h-0 flex-col overflow-hidden"
      >
        {artifact}
      </div>
      <div
        role="separator"
        aria-label="Resize Plan and Plan Reviewers"
        aria-orientation="horizontal"
        aria-valuenow={reviewersHeight ?? undefined}
        tabIndex={0}
        className="group relative z-10 cursor-row-resize bg-kumo-line/60 outline-none transition-colors hover:bg-kumo-focus focus-visible:bg-kumo-focus"
        onMouseDown={startDrag}
        onKeyDown={resizeWithKeyboard}
      >
        <span className="absolute inset-x-0 -inset-y-1" aria-hidden="true" />
      </div>
      <div
        ref={reviewersRef}
        data-testid="plan-reviewers-pane"
        className="min-h-0 overflow-hidden"
      >
        {reviewers}
      </div>
    </div>
  );
}
