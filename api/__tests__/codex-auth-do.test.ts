import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
}));

const {
  CodexAuthContainerDestroyFence,
  CODEX_AUTH_HELPER_OPERATION_TIMEOUT_MS,
  runCodexAuthHelperCommand,
} = await import("../codex-auth-do");

function output(value: unknown, exitCode = 0) {
  return {
    stdout: new TextEncoder().encode(JSON.stringify(value)).buffer,
    stderr: new ArrayBuffer(0),
    exitCode,
  };
}

describe("CodexAuthDO helper execution boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the successful helper operation inside the documented 7.5 second budget", async () => {
    expect(CODEX_AUTH_HELPER_OPERATION_TIMEOUT_MS).toBe(7_500);
    const destroy = vi.fn(async () => undefined);
    const result = await runCodexAuthHelperCommand({
      authJson: "{}",
      start: async () => undefined,
      container: () => ({
        running: true,
        exec: async () => ({
          output: async () => output({
            version: 1,
            ok: true,
            auth_json: "{}",
            projected: { accessToken: "token", accountId: "acct", expiresAt: 123 },
          }),
          kill: vi.fn(),
        }),
      }),
      destroy,
    });

    expect(result).toMatchObject({ ok: true, projected: { accessToken: "token" } });
    expect(destroy).not.toHaveBeenCalled();
  });

  it("fences every replacement start behind an unfinished Container destroy", async () => {
    let finishDestroy!: () => void;
    const destroy = vi.fn(async () => await new Promise<void>((resolve) => { finishDestroy = resolve; }));
    const fence = new CodexAuthContainerDestroyFence(destroy);
    const destruction = fence.destroy();
    expect(fence.destroy()).toBe(destruction);
    let startAllowed = false;
    const waiting = fence.beforeStart(new AbortController().signal).then(() => { startAllowed = true; });

    await Promise.resolve();
    expect(startAllowed).toBe(false);
    finishDestroy();
    await expect(waiting).resolves.toBeUndefined();
    expect(startAllowed).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("starts its deadline before Container startup and destroys a timed-out instance", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const destroy = vi.fn(async () => undefined);
    const result = runCodexAuthHelperCommand({
      authJson: "{}",
      start: async (receivedSignal) => {
        signal = receivedSignal;
        await new Promise(() => undefined);
      },
      container: () => undefined,
      destroy,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({
      version: 1,
      ok: false,
      error: { code: "refresh_timeout" },
    });
    expect(signal?.aborted).toBe(true);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("signals a stuck helper and destroys the Container before releasing the timeout", async () => {
    vi.useFakeTimers();
    const kill = vi.fn();
    const destroy = vi.fn(async () => undefined);
    const result = runCodexAuthHelperCommand({
      authJson: "{}",
      start: async () => undefined,
      container: () => ({
        running: true,
        exec: async () => ({
          output: async () => await new Promise(() => undefined),
          kill,
        }),
      }),
      destroy,
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({
      version: 1,
      ok: false,
      error: { code: "refresh_timeout" },
    });
    expect(kill.mock.calls.map(([signal]) => signal)).toEqual([15, 9]);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("bounds cleanup when Container destruction never settles", async () => {
    vi.useFakeTimers();
    const result = runCodexAuthHelperCommand({
      authJson: "{}",
      start: async () => await new Promise(() => undefined),
      container: () => undefined,
      destroy: async () => await new Promise(() => undefined),
      timeoutMs: 100,
    });

    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toEqual({
      version: 1,
      ok: false,
      error: { code: "helper_unavailable" },
    });
  });

  it("destroys the Container after a non-timeout helper output failure", async () => {
    const kill = vi.fn();
    const destroy = vi.fn(async () => undefined);
    await expect(runCodexAuthHelperCommand({
      authJson: "{}",
      start: async () => undefined,
      container: () => ({
        running: true,
        exec: async () => ({
          output: async () => { throw new Error("output transport failed"); },
          kill,
        }),
      }),
      destroy,
      timeoutMs: 100,
    })).resolves.toEqual({
      version: 1,
      ok: false,
      error: { code: "helper_unavailable" },
    });
    expect(kill).toHaveBeenCalledWith(15);
    expect(destroy).toHaveBeenCalledOnce();
  });
});
