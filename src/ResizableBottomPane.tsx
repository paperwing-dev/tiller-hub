import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";

export const BOTTOM_PANE_DIVIDER_HEIGHT = 4;
const KEYBOARD_RESIZE_STEP = 24;

interface ResizeLimits {
  dividerHeight: number;
  minBottomHeight: number;
  minTopHeight: number;
}

interface DragState {
  pointerId: number;
  startY: number;
  startBottomHeight: number;
  containerHeight: number;
  bodyCursor: string;
  bodyUserSelect: string;
}

interface UseResizableBottomPaneOptions {
  defaultHeight: number | null;
  minBottomHeight: number;
  minTopHeight: number;
  storageKey: string;
  dividerHeight?: number;
}

function readStoredHeight(storageKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null || stored.trim() === "") return null;
    const parsed = Number(stored);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function storeHeight(storageKey: string, height: number): void {
  try {
    window.localStorage.setItem(storageKey, String(height));
  } catch {
    // Resizing remains available when browser storage is disabled or full.
  }
}

export function clampBottomPaneHeight(
  height: number,
  containerHeight: number,
  limits: ResizeLimits,
): number {
  const availableHeight = Math.max(0, containerHeight - limits.dividerHeight);
  const sharedMinimum = Math.max(0, Math.floor(availableHeight / 2));
  const minimum = Math.min(limits.minBottomHeight, sharedMinimum);
  const topMinimum = Math.min(limits.minTopHeight, sharedMinimum);
  const maximum = Math.max(minimum, availableHeight - topMinimum);
  return Math.min(maximum, Math.max(minimum, height));
}

export function useResizableBottomPane<T extends HTMLElement = HTMLDivElement>({
  defaultHeight,
  minBottomHeight,
  minTopHeight,
  storageKey,
  dividerHeight = BOTTOM_PANE_DIVIDER_HEIGHT,
}: UseResizableBottomPaneOptions) {
  const [initialHeight] = useState(() => readStoredHeight(storageKey) ?? defaultHeight);
  const [height, setHeight] = useState<number | null>(initialHeight);
  const paneRef = useRef<T | null>(null);
  const preferredHeightRef = useRef<number | null>(initialHeight);
  const renderedHeightRef = useRef<number | null>(initialHeight);
  const dragStateRef = useRef<DragState | null>(null);
  const limitsRef = useRef({ dividerHeight, minBottomHeight, minTopHeight });
  limitsRef.current = { dividerHeight, minBottomHeight, minTopHeight };

  const updateHeight = useCallback((nextHeight: number) => {
    renderedHeightRef.current = nextHeight;
    setHeight(nextHeight);
  }, []);

  const getContainerHeight = useCallback(() => {
    const container = paneRef.current?.parentElement;
    if (!container) return null;
    const containerHeight = container.getBoundingClientRect().height;
    return Number.isFinite(containerHeight) && containerHeight > 0
      ? containerHeight
      : null;
  }, []);

  const reclampHeight = useCallback(() => {
    const preferredHeight = preferredHeightRef.current;
    const containerHeight = getContainerHeight();
    if (preferredHeight === null || containerHeight === null) return;
    updateHeight(clampBottomPaneHeight(preferredHeight, containerHeight, limitsRef.current));
  }, [getContainerHeight, updateHeight]);

  useLayoutEffect(() => {
    const container = paneRef.current?.parentElement;
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

  const restoreDragStyles = useCallback(() => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    document.body.style.cursor = dragState.bodyCursor;
    document.body.style.userSelect = dragState.bodyUserSelect;
  }, []);

  const handlePointerMove = useCallback((event: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    const nextHeight = dragState.startBottomHeight + dragState.startY - event.clientY;
    const clampedHeight = clampBottomPaneHeight(
      nextHeight,
      dragState.containerHeight,
      limitsRef.current,
    );
    preferredHeightRef.current = clampedHeight;
    updateHeight(clampedHeight);
  }, [updateHeight]);

  const stopResize = useCallback((event?: PointerEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState || (event && event.pointerId !== dragState.pointerId)) return;
    const committedHeight = renderedHeightRef.current ?? dragState.startBottomHeight;
    preferredHeightRef.current = committedHeight;
    storeHeight(storageKey, committedHeight);
    restoreDragStyles();
    dragStateRef.current = null;
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", stopResize);
    window.removeEventListener("pointercancel", stopResize);
  }, [handlePointerMove, restoreDragStyles, storageKey]);

  useEffect(
    () => () => {
      restoreDragStyles();
      dragStateRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", stopResize);
      window.removeEventListener("pointercancel", stopResize);
    },
    [handlePointerMove, restoreDragStyles, stopResize],
  );

  const startResize = useCallback((
    event: ReactPointerEvent<HTMLElement>,
    startHeight?: number,
  ) => {
    if (event.button !== 0) return;
    const containerHeight = getContainerHeight();
    const pane = paneRef.current;
    if (containerHeight === null || !pane) return;
    event.preventDefault();
    const measuredHeight = startHeight ?? pane.getBoundingClientRect().height;
    const normalizedHeight = clampBottomPaneHeight(
      measuredHeight,
      containerHeight,
      limitsRef.current,
    );
    preferredHeightRef.current = normalizedHeight;
    renderedHeightRef.current = normalizedHeight;
    dragStateRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startBottomHeight: normalizedHeight,
      containerHeight,
      bodyCursor: document.body.style.cursor,
      bodyUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResize);
    window.addEventListener("pointercancel", stopResize);
  }, [getContainerHeight, handlePointerMove, stopResize]);

  const resizeWithKeyboard = useCallback((
    event: ReactKeyboardEvent<HTMLElement>,
    currentHeight?: number,
  ) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    const containerHeight = getContainerHeight();
    const pane = paneRef.current;
    if (containerHeight === null || !pane) return;
    event.preventDefault();
    const renderedHeight = currentHeight
      ?? height
      ?? pane.getBoundingClientRect().height;
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const nextHeight = clampBottomPaneHeight(
      renderedHeight + direction * KEYBOARD_RESIZE_STEP,
      containerHeight,
      limitsRef.current,
    );
    preferredHeightRef.current = nextHeight;
    updateHeight(nextHeight);
    storeHeight(storageKey, nextHeight);
  }, [getContainerHeight, height, storageKey, updateHeight]);

  return {
    height,
    paneRef,
    reclampHeight,
    resizeWithKeyboard,
    startResize,
  };
}

export function BottomPaneResizeHandle({
  label,
  value,
  onKeyDown,
  onPointerDown,
}: {
  label: string;
  value?: number;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation="horizontal"
      aria-valuenow={value}
      tabIndex={0}
      className="group relative z-10 h-1 shrink-0 touch-none cursor-row-resize bg-kumo-line/60 outline-none transition-colors hover:bg-kumo-focus focus-visible:bg-kumo-focus"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
    >
      <span className="absolute inset-x-0 -inset-y-1" aria-hidden="true" />
      <span className="pointer-events-none absolute left-1/2 top-1/2 h-0.5 w-8 -translate-x-1/2 -translate-y-1/2 rounded bg-kumo-subtle/30 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden="true" />
    </div>
  );
}
