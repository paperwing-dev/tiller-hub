/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useToast, type AddToast } from "../Toast";

const mocks = vi.hoisted(() => ({
  manager: {
    add: vi.fn(),
  },
}));

vi.mock("@cloudflare/kumo/components/toast", () => ({
  Toast: {
    Description: "p",
    Title: "h2",
  },
  Toasty: ({ children }: { children: unknown }) => children,
  useKumoToastManager: () => mocks.manager,
}));

describe("useToast", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let observedToast: AddToast | null;

  beforeEach(() => {
    (
      globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    observedToast = null;
    mocks.manager = { add: vi.fn() };
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

  it("keeps the addToast callback stable across Kumo manager updates", () => {
    act(() => {
      root?.render(<ToastProbe onToast={(toast) => { observedToast = toast; }} />);
    });

    const firstToast = observedToast;
    expect(firstToast).toBeTypeOf("function");

    const firstManager = mocks.manager;
    const secondManager = { add: vi.fn() };
    mocks.manager = secondManager;

    act(() => {
      root?.render(<ToastProbe onToast={(toast) => { observedToast = toast; }} />);
    });

    expect(observedToast).toBe(firstToast);

    observedToast?.({ title: "Connected", variant: "success", duration: 2000 });

    expect(firstManager.add).not.toHaveBeenCalled();
    expect(secondManager.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Connected",
        description: undefined,
        variant: "success",
        timeout: 2000,
        content: expect.anything(),
      }),
    );
  });

  it("makes toast content selectable without starting a swipe gesture", () => {
    act(() => {
      root?.render(<ToastProbe onToast={(toast) => { observedToast = toast; }} />);
    });

    observedToast?.({ title: "Failed", body: "Copy this error", variant: "error" });

    const content = mocks.manager.add.mock.calls[0]?.[0]?.content;
    expect(React.isValidElement(content)).toBe(true);

    if (!React.isValidElement<{
      className: string;
      "data-base-ui-swipe-ignore": string;
    }>(content)) {
      throw new Error("Expected selectable toast content");
    }

    expect(content.props.className.split(" ")).toContain("select-text");
    expect(content.props["data-base-ui-swipe-ignore"]).toBe("");
  });
});

function ToastProbe({ onToast }: { onToast: (toast: AddToast) => void }) {
  onToast(useToast());
  return null;
}
