import { describe, expect, it } from "vitest";
import type { ThreadMessage } from "../../coordination";
import {
  buildThreadMessageHistory,
  listAllThreadMessages,
} from "../context-window";

function message(seq: number, options: { id?: string; runId?: string; text?: string } = {}): ThreadMessage {
  return {
    id: options.id ?? `message-${seq}`,
    threadId: "thread-1",
    seq,
    senderSessionId: "user",
    kind: "chat",
    body: {
      role: "user",
      text: options.text ?? `turn ${seq}`,
      ...(options.runId ? { runId: options.runId } : {}),
    },
    createdAt: new Date(seq * 1_000).toISOString(),
  };
}

describe("reviewer thread context", () => {
  it("filters the current run and historical setup rows before count and character windowing", () => {
    const messages = [
      message(1, { text: "eligible history" }),
      message(2, { runId: "current-run", text: "x".repeat(100_000) }),
      message(3, { id: "skill-setup:old:agent", text: "x".repeat(100_000) }),
      message(4, { id: "skill-preset:old", text: "x".repeat(100_000) }),
    ];

    expect(buildThreadMessageHistory(messages, "current-run", {
      messageLimit: 1,
      budgetChars: 100,
    })).toEqual({ messages: [messages[0]], truncated: false });
  });

  it("marks truncation only when an otherwise eligible row is omitted", () => {
    const messages = [message(1), message(2), message(3, { runId: "current-run" })];
    expect(buildThreadMessageHistory(messages, "current-run", { messageLimit: 1 })).toEqual({
      messages: [messages[1]],
      truncated: true,
    });
    expect(buildThreadMessageHistory([
      message(1, { runId: "current-run" }),
      message(2, { id: "skill-setup:old:agent" }),
    ], "current-run", { messageLimit: 1 }).truncated).toBe(false);
  });

  it("paginates the complete stored thread and returns chronological history", async () => {
    const stored = Array.from({ length: 2_105 }, (_, index) => message(index + 1));
    const calls: Array<number | undefined> = [];
    const thread = {
      async listMessages(options: { limit?: number; beforeSeq?: number }) {
        calls.push(options.beforeSeq);
        return stored
          .filter((candidate) => options.beforeSeq === undefined || candidate.seq < options.beforeSeq)
          .slice()
          .sort((left, right) => right.seq - left.seq)
          .slice(0, options.limit);
      },
    };

    const result = await listAllThreadMessages(thread);
    expect(calls).toEqual([undefined, 1_106, 106]);
    expect(result).toHaveLength(2_105);
    expect(result[0]?.seq).toBe(1);
    expect(result.at(-1)?.seq).toBe(2_105);
  });
});
