/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let releaseModule: () => void = () => undefined;
  const moduleReady = new Promise<void>((resolve) => {
    releaseModule = resolve;
  });
  return {
    animate: vi.fn(),
    moduleReady,
    releaseModule,
  };
});

vi.mock("animejs/waapi", async () => {
  await mocks.moduleReady;
  return {
    waapi: {
      animate: mocks.animate,
    },
  };
});

import SailingScene from "../SailingScene";

interface FakeAnimation {
  revert: ReturnType<typeof vi.fn>;
}

interface MutableMediaQueryList extends MediaQueryList {
  matches: boolean;
}

describe("SailingScene", () => {
  const originalMatchMedia = window.matchMedia;
  let animations: FakeAnimation[];
  let mediaQuery: MutableMediaQueryList;
  let motionListeners: Set<(event: MediaQueryListEvent) => void>;

  beforeEach(() => {
    animations = [];
    motionListeners = new Set();
    mediaQuery = {
      matches: false,
      media: "(prefers-reduced-motion: reduce)",
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "change" && typeof listener === "function") {
          motionListeners.add(listener as (event: MediaQueryListEvent) => void);
        }
      }),
      removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
        if (type === "change" && typeof listener === "function") {
          motionListeners.delete(listener as (event: MediaQueryListEvent) => void);
        }
      }),
      dispatchEvent: vi.fn(() => true),
    };
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => mediaQuery),
    });

    mocks.animate.mockReset();
    mocks.animate.mockImplementation(() => {
      const animation = { revert: vi.fn() };
      animations.push(animation);
      return animation;
    });
  });

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  function setReducedMotion(matches: boolean) {
    mediaQuery.matches = matches;
    act(() => {
      for (const listener of motionListeners) {
        listener({ matches, media: mediaQuery.media } as MediaQueryListEvent);
      }
    });
  }

  it("does not let a stale dynamic import start animation", async () => {
    const { rerender } = render(<SailingScene motionVariant="preparing" />);
    rerender(<SailingScene motionVariant="static" />);

    await act(async () => {
      mocks.releaseModule();
      await mocks.moduleReady;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.animate).not.toHaveBeenCalled();
    expect(screen.getByTestId("sailing-scene")).toHaveAttribute(
      "data-motion-variant",
      "static",
    );
  });

  it("reverts the complete variant before creating the next one and on unmount", async () => {
    const { rerender, unmount } = render(<SailingScene motionVariant="preparing" />);
    await waitFor(() => expect(mocks.animate).toHaveBeenCalledTimes(4));
    const preparingAnimations = animations.slice();

    rerender(<SailingScene motionVariant="stopping" />);
    await waitFor(() => expect(mocks.animate).toHaveBeenCalledTimes(6));
    for (const animation of preparingAnimations) {
      expect(animation.revert).toHaveBeenCalledTimes(1);
    }

    const stoppingAnimations = animations.slice(4);
    unmount();
    for (const animation of stoppingAnimations) {
      expect(animation.revert).toHaveBeenCalledTimes(1);
    }
  });

  it("switches live reduced-motion changes between animated and static scenes", async () => {
    const { unmount } = render(<SailingScene motionVariant="preparing" />);
    await waitFor(() => expect(mocks.animate).toHaveBeenCalledTimes(4));
    const firstAnimations = animations.slice();

    setReducedMotion(true);
    expect(screen.getByTestId("sailing-scene")).toHaveAttribute(
      "data-motion-variant",
      "static",
    );
    for (const animation of firstAnimations) {
      expect(animation.revert).toHaveBeenCalledTimes(1);
    }

    setReducedMotion(false);
    await waitFor(() => expect(mocks.animate).toHaveBeenCalledTimes(8));
    expect(screen.getByTestId("sailing-scene")).toHaveAttribute(
      "data-motion-variant",
      "preparing",
    );

    const secondAnimations = animations.slice(4);
    unmount();
    for (const animation of secondAnimations) {
      expect(animation.revert).toHaveBeenCalledTimes(1);
    }
    expect(mediaQuery.removeEventListener).toHaveBeenCalledWith(
      "change",
      expect.any(Function),
    );
  });

  it("never imports animation behavior for a static or initially reduced scene", async () => {
    mediaQuery.matches = true;
    const { rerender } = render(<SailingScene motionVariant="preparing" />);
    await act(async () => Promise.resolve());

    expect(screen.getByTestId("sailing-scene")).toHaveAttribute(
      "data-motion-variant",
      "static",
    );
    expect(mocks.animate).not.toHaveBeenCalled();

    rerender(<SailingScene motionVariant="static" />);
    await act(async () => Promise.resolve());
    expect(mocks.animate).not.toHaveBeenCalled();
  });
});
