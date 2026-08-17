import React from "react";
import AgentTabStatusIndicator, { type AgentTabStatus } from "./AgentTabStatusIndicator";

export type ReviewerResponseState = "ready" | "delivering" | "sent" | "dismissed";

export function ReviewerTranscriptMessage({
  role,
  author,
  createdAt,
  children,
  testId,
}: {
  role: "user" | "assistant";
  author: string;
  createdAt?: string | null;
  children: React.ReactNode;
  testId?: string;
}) {
  const formattedTime = formatReviewerMessageTime(createdAt);
  return (
    <div
      data-reviewer-message-role={role}
      data-testid={testId}
      className={`flex px-5 py-3 ${role === "user" ? "justify-end" : "justify-start"}`}
    >
      <div
        data-reviewer-message-bubble
        className={role === "user"
          ? "max-w-[80%] rounded-lg border border-kumo-line bg-kumo-tint px-3 py-2.5 text-[13px] leading-5 text-kumo-default"
          : "max-w-[80%] rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2.5 text-[13px] leading-5 text-kumo-default"}
      >
        <div className="tiller-reviewer-message-byline mb-1.5 flex items-center justify-between gap-4 text-[10px] font-normal text-kumo-subtle">
          <span>{author}</span>
          {formattedTime && <time dateTime={createdAt ?? undefined}>{formattedTime}</time>}
        </div>
        {children}
      </div>
    </div>
  );
}

export function ReviewerResponseActions({
  state = "ready",
  label,
  children,
}: {
  state?: ReviewerResponseState;
  label?: string;
  children?: React.ReactNode;
}) {
  const status = responseStatus(state, label);
  return (
    <div
      data-reviewer-response-actions
      className="tiller-reviewer-response-actions mt-3 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-t border-kumo-line pt-2"
    >
      <span className="inline-flex h-7 shrink-0 items-center gap-1.5 text-[11px] font-normal text-kumo-subtle">
        <AgentTabStatusIndicator status={status} card />
        {status.label}
      </span>
      {children}
    </div>
  );
}

function responseStatus(state: ReviewerResponseState, label?: string): AgentTabStatus {
  if (state === "ready") {
    return {
      kind: "finished",
      label: label ?? "Response ready",
      detail: "A reviewer response is ready.",
    };
  }
  if (state === "delivering") {
    return {
      kind: "finished",
      label: label ?? "Delivery pending",
      detail: "The reviewer response is waiting to be delivered.",
    };
  }
  return {
    kind: "viewed",
    label: label ?? (state === "sent" ? "Sent" : "Dismissed"),
    detail: state === "sent" ? "The reviewer response was sent." : "The reviewer response was dismissed.",
  };
}

function formatReviewerMessageTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
