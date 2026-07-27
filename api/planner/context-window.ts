import type { ThreadMessage } from "../coordination";

// One total character budget for provider prompts built from run context. The
// harness composes skill instructions + plan + transcript; the hub bounds the
// transcript here so prompts cannot grow without limit as threads age.
export const PLANNER_THREAD_CONTEXT_BUDGET_CHARS = 24_000;

function messageWeight(message: ThreadMessage): number {
  const body = message.body as { text?: unknown } | null | undefined;
  if (body && typeof body === "object" && typeof body.text === "string") {
    return body.text.length + 64;
  }
  try {
    return JSON.stringify(message.body ?? null).length + 64;
  } catch {
    return 64;
  }
}

// Keeps the most recent messages whose combined size fits the budget.
// Input and output are in chronological order (oldest first).
export function windowThreadMessages(
  messages: ThreadMessage[],
  budgetChars = PLANNER_THREAD_CONTEXT_BUDGET_CHARS,
): { messages: ThreadMessage[]; truncated: boolean } {
  const kept: ThreadMessage[] = [];
  let used = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const weight = messageWeight(messages[index]);
    if (kept.length > 0 && used + weight > budgetChars) {
      return { messages: kept.reverse(), truncated: true };
    }
    kept.push(messages[index]);
    used += weight;
  }
  return { messages: kept.reverse(), truncated: false };
}
