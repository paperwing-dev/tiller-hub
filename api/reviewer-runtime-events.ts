export const REVIEWER_RUNTIME_STARTUP_MESSAGE = "Reviewer runtime started.";
export const MAX_REVIEWER_RUNTIME_EVENTS_PER_POST = 20;
export const MAX_REVIEWER_RUNTIME_EVENT_MESSAGE_CHARS = 2_000;

export type ReviewerRuntimeEvent =
  | { type: "runtime_startup"; message: typeof REVIEWER_RUNTIME_STARTUP_MESSAGE }
  | { type: "model_activity"; message: string }
  | { type: "model_commentary"; message: string };

export type ReviewerRuntimeEventBatchResult =
  | { ok: true; events: ReviewerRuntimeEvent[] }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(value: string): string {
  return value.length > MAX_REVIEWER_RUNTIME_EVENT_MESSAGE_CHARS
    ? `${value.slice(0, MAX_REVIEWER_RUNTIME_EVENT_MESSAGE_CHARS)}…`
    : value;
}

/** Validate and normalize the complete container-owned reviewer event contract. */
export function parseReviewerRuntimeEventBatch(body: unknown): ReviewerRuntimeEventBatchResult {
  if (!isRecord(body) || !Object.prototype.hasOwnProperty.call(body, "events") || !Array.isArray(body.events)) {
    return { ok: false, error: "events must be an array" };
  }
  if (body.events.length > MAX_REVIEWER_RUNTIME_EVENTS_PER_POST) {
    return { ok: false, error: `At most ${MAX_REVIEWER_RUNTIME_EVENTS_PER_POST} events per request` };
  }

  const events: ReviewerRuntimeEvent[] = [];
  for (const candidate of body.events) {
    if (!isRecord(candidate)) {
      return { ok: false, error: "Each event must be an object" };
    }
    const type = typeof candidate.type === "string" ? candidate.type : "";
    if (type === "runtime_startup") {
      events.push({ type, message: REVIEWER_RUNTIME_STARTUP_MESSAGE });
      continue;
    }
    if (type === "model_activity" || type === "model_commentary") {
      if (typeof candidate.message !== "string" || !candidate.message.trim()) {
        return { ok: false, error: `${type} requires a message` };
      }
      events.push({ type, message: truncate(candidate.message.trim()) });
      continue;
    }
    return { ok: false, error: `Unsupported event type: ${type || "(missing)"}` };
  }
  return { ok: true, events };
}
