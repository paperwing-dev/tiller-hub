import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";

const MAX_BAR_HEIGHT = 240;
const MIN_TERMINAL_CONTENT_HEIGHT = 120;
const KEYBOARD_RESIZE_STEP = 16;

interface ResizableAgentBarProps {
  ariaLabel: string;
  children: ReactNode;
  defaultHeight: number;
  minHeight: number;
  storageKey: string;
}

interface DragState {
  startHeight: number;
  startY: number;
}

function readStoredHeight(storageKey: string): number | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;
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
    // Resizing remains usable without browser storage.
  }
}

export default function ResizableAgentBar({
  ariaLabel,
  children,
  defaultHeight,
  minHeight,
  storageKey,
}: ResizableAgentBarProps) {
  const [height, setHeight] = useState(() => Math.max(
    minHeight,
    readStoredHeight(storageKey) ?? defaultHeight,
  ));
  const [maximumHeight, setMaximumHeight] = useState(MAX_BAR_HEIGHT);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const heightRef = useRef(height);

  const clampHeight = useCallback((nextHeight: number): number => {
    const parentHeight = rootRef.current?.parentElement?.getBoundingClientRect().height ?? 0;
    const availableMaximum = parentHeight > 0
      ? Math.max(minHeight, parentHeight - MIN_TERMINAL_CONTENT_HEIGHT)
      : MAX_BAR_HEIGHT;
    const nextMaximum = Math.min(MAX_BAR_HEIGHT, availableMaximum);
    setMaximumHeight(nextMaximum);
    return Math.min(nextMaximum, Math.max(minHeight, nextHeight));
  }, [minHeight]);

  const updateHeight = useCallback((nextHeight: number) => {
    const clampedHeight = clampHeight(nextHeight);
    heightRef.current = clampedHeight;
    setHeight(clampedHeight);
  }, [clampHeight]);

  const reclampHeight = useCallback(() => {
    updateHeight(heightRef.current);
  }, [updateHeight]);

  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement;
    if (!parent) return;
    reclampHeight();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(reclampHeight);
    observer?.observe(parent);
    window.addEventListener("resize", reclampHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", reclampHeight);
    };
  }, [reclampHeight]);

  const handleDrag = useCallback((event: MouseEvent) => {
    const dragState = dragStateRef.current;
    if (!dragState) return;
    updateHeight(dragState.startHeight + dragState.startY - event.clientY);
  }, [updateHeight]);

  const stopDrag = useCallback(() => {
    if (dragStateRef.current) storeHeight(storageKey, heightRef.current);
    dragStateRef.current = null;
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("mousemove", handleDrag);
    window.removeEventListener("mouseup", stopDrag);
  }, [handleDrag, storageKey]);

  useEffect(() => () => {
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    window.removeEventListener("mousemove", handleDrag);
    window.removeEventListener("mouseup", stopDrag);
  }, [handleDrag, stopDrag]);

  const startDrag = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragStateRef.current = { startHeight: heightRef.current, startY: event.clientY };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", handleDrag);
    window.addEventListener("mouseup", stopDrag);
  }, [handleDrag, stopDrag]);

  const resizeWithKeyboard = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const direction = event.key === "ArrowUp" ? 1 : -1;
    const nextHeight = clampHeight(heightRef.current + direction * KEYBOARD_RESIZE_STEP);
    heightRef.current = nextHeight;
    setHeight(nextHeight);
    storeHeight(storageKey, nextHeight);
  }, [clampHeight, storageKey]);

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      style={{ height, minHeight }}
    >
      <div
        role="separator"
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        aria-valuemin={minHeight}
        aria-valuemax={maximumHeight}
        aria-valuenow={height}
        tabIndex={0}
        title="Drag to resize"
        className="group absolute inset-x-0 -top-1 z-20 h-2 cursor-row-resize outline-none"
        onMouseDown={startDrag}
        onKeyDown={resizeWithKeyboard}
      >
        <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-kumo-line group-hover:h-[2px] group-hover:bg-kumo-focus group-focus-visible:h-[2px] group-focus-visible:bg-kumo-focus" aria-hidden="true" />
      </div>
      <div className="h-full min-h-0">{children}</div>
    </div>
  );
}
