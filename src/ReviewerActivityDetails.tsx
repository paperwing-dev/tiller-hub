import React from "react";
import { CaretDownIcon } from "@phosphor-icons/react";

export interface ReviewerActivityMessage {
  id: string;
  text: string;
}

interface ReviewerActivityDetailsProps {
  messages: ReviewerActivityMessage[];
}

export default function ReviewerActivityDetails({
  messages,
}: ReviewerActivityDetailsProps) {
  const latestMessage = messages[messages.length - 1];
  if (!latestMessage) return null;

  return (
    <details className="group/activity mt-1 min-w-0 text-xs">
      <summary
        className="flex min-w-0 cursor-pointer list-none items-center gap-1.5 text-kumo-default [&::-webkit-details-marker]:hidden"
        title="Show past thoughts"
      >
        <CaretDownIcon
          aria-hidden="true"
          className="size-3 shrink-0 transition-transform group-open/activity:rotate-180"
          weight="bold"
        />
        <span className="shrink-0 font-medium text-kumo-info">Activity</span>
        <span aria-hidden="true" className="shrink-0 text-kumo-subtle">·</span>
        <span className="min-w-0 truncate">
          {latestMessage.text}
        </span>
      </summary>
      <div className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-kumo-line pt-2">
        {messages.map((message) => (
          <div
            key={message.id}
            className="whitespace-pre-wrap break-words rounded border border-kumo-line bg-kumo-base p-1.5 text-[11px] text-kumo-default"
          >
            {message.text}
          </div>
        ))}
      </div>
    </details>
  );
}
