import React, { useEffect, useMemo, useRef, type RefObject } from "react";
import type { UIMessage } from "ai";
import { listHostedChatMessages } from "./hosted-chat";

interface HostedChatTranscriptProps {
  messages: UIMessage[];
  loading?: boolean;
  error?: Error | null;
  status?: string;
  emptyState: string;
  thinkingLabel?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
}

export default function HostedChatTranscript({
  messages,
  loading = false,
  error = null,
  status,
  emptyState,
  thinkingLabel = "Thinking...",
  scrollRef,
}: HostedChatTranscriptProps) {
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const activeScrollRef = scrollRef ?? internalScrollRef;
  const renderedMessages = useMemo(() => listHostedChatMessages(messages), [messages]);
  const streaming = status === "submitted" || status === "streaming";

  useEffect(() => {
    activeScrollRef.current?.scrollTo({
      top: activeScrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [activeScrollRef, renderedMessages.length, status]);

  return (
    <div ref={activeScrollRef} className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {loading && (
        <div className="py-8 text-center text-sm text-[#57606a]">Loading...</div>
      )}

      {!loading && renderedMessages.length === 0 && !error && (
        <div className="py-8 text-center text-sm text-[#57606a]">
          {emptyState}
        </div>
      )}

      {renderedMessages.map((message) => (
        <div
          key={message.id}
          className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
        >
          <div
            className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
              message.role === "user"
                ? "bg-[#0969da] text-white"
                : "border border-[#d0d7de] bg-[#f6f8fa] text-[#24292f]"
            }`}
          >
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="mb-2 space-y-1">
                {message.toolCalls.map((toolCall) => (
                  <details key={toolCall.id} className="text-xs">
                    <summary className="cursor-pointer font-medium text-[#7c3aed]">
                      {toolCall.name}
                      {toolCall.pending ? " (running...)" : ""}
                      {toolCall.error ? " (failed)" : ""}
                    </summary>
                    {(toolCall.result || toolCall.error) && (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-[#e1e4e8] bg-white p-1.5 text-[10px]">
                        {(toolCall.error ?? toolCall.result ?? "").slice(0, 2000)}
                        {(toolCall.error ?? toolCall.result ?? "").length > 2000 ? "..." : ""}
                      </pre>
                    )}
                  </details>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          </div>
        </div>
      ))}

      {error && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {error.message}
          </div>
        </div>
      )}

      {streaming &&
        renderedMessages[renderedMessages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="animate-pulse rounded-lg border border-[#d0d7de] bg-[#f6f8fa] px-3 py-2 text-sm text-[#57606a]">
              {thinkingLabel}
            </div>
          </div>
        )}
    </div>
  );
}
