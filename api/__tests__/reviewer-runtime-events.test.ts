import { describe, expect, it } from "vitest";
import {
  MAX_REVIEWER_RUNTIME_EVENT_MESSAGE_CHARS,
  MAX_REVIEWER_RUNTIME_EVENTS_PER_POST,
  parseReviewerRuntimeEventBatch,
} from "../reviewer-runtime-events";

describe("reviewer runtime event contract", () => {
  it("requires an explicit array of current event objects", () => {
    for (const body of [null, {}, { events: null }, { events: [null] }]) {
      expect(parseReviewerRuntimeEventBatch(body).ok).toBe(false);
    }
    expect(parseReviewerRuntimeEventBatch({
      events: [{ type: "progress", message: "legacy" }],
    })).toEqual({ ok: false, error: "Unsupported event type: progress" });
  });

  it("normalizes startup, bounded model activity, and user-facing commentary", () => {
    const parsed = parseReviewerRuntimeEventBatch({
      events: [
        { type: "runtime_startup", message: "provider text", data: { secret: true } },
        { type: "model_activity", message: `  ${"x".repeat(MAX_REVIEWER_RUNTIME_EVENT_MESSAGE_CHARS + 10)}  ` },
        { type: "model_commentary", message: "  I’m checking the event boundary.  " },
      ],
    });

    expect(parsed).toEqual({
      ok: true,
      events: [
        { type: "runtime_startup", message: "Reviewer runtime started." },
        {
          type: "model_activity",
          message: `${"x".repeat(MAX_REVIEWER_RUNTIME_EVENT_MESSAGE_CHARS)}…`,
        },
        { type: "model_commentary", message: "I’m checking the event boundary." },
      ],
    });
  });

  it("enforces the shared per-request batch limit", () => {
    const events = Array.from({ length: MAX_REVIEWER_RUNTIME_EVENTS_PER_POST + 1 }, () => ({
      type: "runtime_startup",
    }));
    expect(parseReviewerRuntimeEventBatch({ events })).toEqual({
      ok: false,
      error: `At most ${MAX_REVIEWER_RUNTIME_EVENTS_PER_POST} events per request`,
    });
  });
});
