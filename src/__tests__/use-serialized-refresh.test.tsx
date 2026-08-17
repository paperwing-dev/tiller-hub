/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSerializedRefresh, type SerializedRefresh } from "../useSerializedRefresh";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useSerializedRefresh", () => {
  afterEach(cleanup);

  it("joins equivalent reads and drains multiple invalidations as one non-overlapping trailing read", async () => {
    const first = deferred<number>();
    const trailing = deferred<number>();
    const responses = [first, trailing];
    let active = 0;
    let maxActive = 0;
    const perform = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        return await responses[perform.mock.calls.length - 1].promise;
      } finally {
        active -= 1;
      }
    });
    let refresh!: SerializedRefresh<number>;

    function Harness() {
      refresh = useSerializedRefresh(perform);
      return null;
    }
    render(<Harness />);

    const initial = refresh.refresh();
    expect(refresh.refresh()).toBe(initial);
    expect(perform).toHaveBeenCalledOnce();

    const invalidation = refresh.invalidateAndWait();
    const joinedInvalidation = refresh.invalidateAndWait();
    expect(perform).toHaveBeenCalledOnce();

    await act(async () => first.resolve(1));
    expect(perform).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);

    await act(async () => trailing.resolve(2));
    await expect(initial).resolves.toBe(2);
    await expect(invalidation).resolves.toBe(2);
    await expect(joinedInvalidation).resolves.toBe(2);
    expect(perform).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it("keeps a failed invalidation eligible when a trailing refresh succeeds", async () => {
    const first = deferred<number>();
    const trailing = deferred<number>();
    const perform = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => trailing.promise);
    let refresh!: SerializedRefresh<number>;

    function Harness() {
      refresh = useSerializedRefresh(perform);
      return null;
    }
    render(<Harness />);

    const pending = refresh.refresh();
    refresh.invalidateAndWait();
    await act(async () => first.reject(new Error("temporary")));
    expect(perform).toHaveBeenCalledTimes(2);
    await act(async () => trailing.resolve(3));

    await expect(pending).resolves.toBe(3);
  });

  it("waits for an invalidation arriving at the drain completion boundary", async () => {
    const first = deferred<number>();
    const trailing = deferred<number>();
    const perform = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => trailing.promise);
    let refresh!: SerializedRefresh<number>;

    function Harness() {
      refresh = useSerializedRefresh(perform);
      return null;
    }
    render(<Harness />);

    const initial = refresh.refresh();
    let boundaryInvalidation!: Promise<number | null>;
    void first.promise.then(() => {
      boundaryInvalidation = refresh.invalidateAndWait();
    });

    await act(async () => first.resolve(1));
    expect(perform).toHaveBeenCalledTimes(2);
    await expect(initial).resolves.toBe(1);

    let settled = false;
    void boundaryInvalidation.then(() => { settled = true; });
    await act(async () => Promise.resolve());
    expect(settled).toBe(false);

    await act(async () => trailing.resolve(2));
    await expect(boundaryInvalidation).resolves.toBe(2);
  });
});
