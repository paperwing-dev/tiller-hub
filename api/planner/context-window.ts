import type { ThreadDO, ThreadMessage } from "../coordination";
export { composeReviewerInstructions } from "../reviewer-instructions";

// One total character budget for provider prompts built from run context. The
// harness composes skill instructions + plan + transcript; the hub bounds the
// transcript here so prompts cannot grow without limit as threads age.
export const PLANNER_THREAD_CONTEXT_BUDGET_CHARS = 24_000;
export const PLANNER_THREAD_CONTEXT_MESSAGE_LIMIT = 200;
export const ENV_REVIEW_THREAD_CONTEXT_MESSAGE_LIMIT = 12;
const THREAD_MESSAGE_PAGE_SIZE = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function messageRunId(message: ThreadMessage): string | null {
  return isRecord(message.body) && typeof message.body.runId === "string" && message.body.runId.trim()
    ? message.body.runId.trim()
    : null;
}

/** Reads a complete thread in chronological order, paging beyond ThreadDO's per-call limit. */
export async function listAllThreadMessages(
  thread: Pick<ThreadDO, "listMessages">,
): Promise<ThreadMessage[]> {
  const descending: ThreadMessage[] = [];
  const seen = new Set<string>();
  let beforeSeq: number | undefined;
  while (true) {
    const page = await thread.listMessages({
      limit: THREAD_MESSAGE_PAGE_SIZE,
      ...(beforeSeq === undefined ? {} : { beforeSeq }),
    });
    let nextBefore = Number.POSITIVE_INFINITY;
    for (const message of page) {
      if (!seen.has(message.id)) {
        seen.add(message.id);
        descending.push(message);
      }
      nextBefore = Math.min(nextBefore, message.seq);
    }
    if (page.length < THREAD_MESSAGE_PAGE_SIZE || !Number.isFinite(nextBefore) || nextBefore >= (beforeSeq ?? Infinity)) {
      break;
    }
    beforeSeq = nextBefore;
  }
  return descending.sort((left, right) => left.seq - right.seq);
}

/** Setup display rows and this run's own optimistic turn are never model history. */
export function eligibleThreadMessages(messages: ThreadMessage[], currentRunId: string): ThreadMessage[] {
  return messages.filter((message) => (
    messageRunId(message) !== currentRunId
    && !message.id.startsWith("skill-setup:")
    && !message.id.startsWith("skill-preset:")
  ));
}

export function buildThreadMessageHistory(
  messages: ThreadMessage[],
  currentRunId: string,
  options: { messageLimit: number; budgetChars?: number },
): { messages: ThreadMessage[]; truncated: boolean } {
  const eligible = eligibleThreadMessages(messages, currentRunId);
  const countOmitted = Math.max(0, eligible.length - options.messageLimit);
  const countWindow = countOmitted > 0 ? eligible.slice(-options.messageLimit) : eligible;
  if (options.budgetChars === undefined) {
    return { messages: countWindow, truncated: countOmitted > 0 };
  }
  const characterWindow = windowThreadMessages(countWindow, options.budgetChars);
  return {
    messages: characterWindow.messages,
    truncated: countOmitted > 0 || characterWindow.truncated,
  };
}

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
