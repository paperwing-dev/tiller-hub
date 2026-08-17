/**
 * @vitest-environment jsdom
 */
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  TerminalRecoveryController,
  type DurableTerminalMessage,
  type TerminalRecoveryState,
} from "../terminal-recovery";

const REDRAW_RECORD_COUNT = 125;
const CSI_PER_RECORD = 2_000;
const REDRAW_RECORD = `x\x1b[0m`.repeat(CSI_PER_RECORD);
let TerminalConstructor: typeof import("@xterm/xterm").Terminal;

function redrawMessages(count = REDRAW_RECORD_COUNT): DurableTerminalMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `redraw-${index + 1}`,
    sessionId: "benchmark-session",
    seq: index + 1,
    content: { type: "terminal-output", data: REDRAW_RECORD },
  }));
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function measurePlainXterm(messages: DurableTerminalMessage[]): Promise<number> {
  const terminal = new TerminalConstructor({ cols: 120, rows: 40, scrollback: 0 });
  const startedAt = performance.now();
  try {
    for (const message of messages) {
      await writeTerminal(
        terminal,
        (message.content as { data: string }).data,
      );
    }
    return performance.now() - startedAt;
  } finally {
    terminal.dispose();
  }
}

async function measureRecoveryCatchUp(messages: DurableTerminalMessage[]): Promise<number> {
  const terminal = new TerminalConstructor({ cols: 120, rows: 40, scrollback: 0 });
  let resolveSettled!: () => void;
  let rejectSettled!: (error: Error) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });
  const controller = new TerminalRecoveryController({
    sessionId: "benchmark-session",
    fetchPage: async () => messages,
    write: (message, callback) => {
      terminal.write((message.content as { data: string }).data, callback);
    },
    onSequenceComplete: () => {},
    onStateChange: (state: TerminalRecoveryState) => {
      if (state.status === "fault") {
        rejectSettled(new Error(`recovery benchmark faulted: ${state.code}`));
      }
    },
    onSettled: () => resolveSettled(),
  });
  const startedAt = performance.now();
  try {
    controller.startCacheRestore(0, 0, (callback) => callback());
    await settled;
    return performance.now() - startedAt;
  } finally {
    controller.dispose();
    terminal.dispose();
  }
}

describe("terminal recovery performance", () => {
  it("catches up a deterministic 1.25 MB redraw within 25% of plain xterm parsing", {
    timeout: 30_000,
  }, async () => {
    const canvasContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    try {
      ({ Terminal: TerminalConstructor } = await import("@xterm/xterm"));
      const messages = redrawMessages();

      // Warm both code paths so module initialization and parser JIT work are
      // outside the measured representative burst.
      await measurePlainXterm(messages.slice(0, 4));
      await measureRecoveryCatchUp(messages.slice(0, 4));

      const plainSamples: number[] = [];
      const recoverySamples: number[] = [];
      for (let iteration = 0; iteration < 2; iteration += 1) {
        if (iteration % 2 === 0) {
          plainSamples.push(await measurePlainXterm(messages));
          recoverySamples.push(await measureRecoveryCatchUp(messages));
        } else {
          recoverySamples.push(await measureRecoveryCatchUp(messages));
          plainSamples.push(await measurePlainXterm(messages));
        }
      }

      const plainMs = Math.min(...plainSamples);
      const recoveryMs = Math.min(...recoverySamples);
      expect(recoveryMs).toBeLessThanOrEqual(plainMs * 1.25);
    } finally {
      canvasContext.mockRestore();
    }
  });
});
