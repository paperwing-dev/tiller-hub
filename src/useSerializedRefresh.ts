import { useCallback, useEffect, useRef } from "react";

export interface SerializedRefresh<T> {
  refresh: () => Promise<T | null>;
  invalidateAndWait: () => Promise<T | null>;
}

export interface SerializedRefreshRequest {
  isCurrent: () => boolean;
}

interface RefreshState<T> {
  dirty: boolean;
  generation: number;
  inFlight: Promise<T | null> | null;
  waiters: Array<{
    resolve: (value: T | null) => void;
    reject: (error: unknown) => void;
  }>;
}

/**
 * Serializes one component-owned read. Ordinary refreshes join an active
 * drain; invalidations queue one trailing generation and wait for the drain
 * to become clean.
 */
export function useSerializedRefresh<T>(
  perform: (request: SerializedRefreshRequest) => Promise<T>,
): SerializedRefresh<T> {
  const performRef = useRef(perform);
  performRef.current = perform;
  const mountedRef = useRef(false);
  const stateRef = useRef<RefreshState<T>>({
    dirty: false,
    generation: 0,
    inFlight: null,
    waiters: [],
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stateRef.current.dirty = false;
      for (const waiter of stateRef.current.waiters.splice(0)) waiter.resolve(null);
    };
  }, []);

  const startDrain = useCallback((): Promise<T | null> => {
    const state = stateRef.current;
    if (state.inFlight) return state.inFlight;

    const drain = async (): Promise<T | null> => {
      let latest: T | null = null;
      let lastError: unknown = null;
      while (mountedRef.current && state.dirty) {
        state.dirty = false;
        const generation = state.generation;
        try {
          latest = await performRef.current({
            isCurrent: () => mountedRef.current && state.generation === generation,
          });
          lastError = null;
        } catch (error) {
          lastError = error;
        }
      }
      if (lastError) throw lastError;
      return latest;
    };

    let outcome: { ok: true; value: T | null } | { ok: false; error: unknown } | null = null;
    const pending = drain()
      .then((value) => {
        outcome = { ok: true, value };
        return value;
      }, (error) => {
        outcome = { ok: false, error };
        throw error;
      })
      .finally(() => {
        if (state.inFlight === pending) state.inFlight = null;
        if (mountedRef.current && state.dirty) {
          void startDrain().catch(() => undefined);
          return;
        }
        const waiters = state.waiters.splice(0);
        if (!outcome || outcome.ok) {
          for (const waiter of waiters) waiter.resolve(outcome?.value ?? null);
        } else {
          for (const waiter of waiters) waiter.reject(outcome.error);
        }
      });
    state.inFlight = pending;
    return pending;
  }, []);

  const refresh = useCallback((): Promise<T | null> => {
    const state = stateRef.current;
    if (state.inFlight) return state.inFlight;
    state.dirty = true;
    return startDrain();
  }, [startDrain]);

  const invalidateAndWait = useCallback((): Promise<T | null> => {
    stateRef.current.generation += 1;
    stateRef.current.dirty = true;
    const result = new Promise<T | null>((resolve, reject) => {
      stateRef.current.waiters.push({ resolve, reject });
    });
    void startDrain().catch(() => undefined);
    return result;
  }, [startDrain]);

  return { refresh, invalidateAndWait };
}
