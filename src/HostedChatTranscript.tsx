import React, { useEffect, useMemo, useRef, type RefObject } from "react";
import type { UIMessage } from "ai";
import { listHostedChatMessages, type HostedChatMessage } from "./hosted-chat";
import LoadingIndicator from "./LoadingIndicator";

interface HostedChatTranscriptProps {
  messages: UIMessage[];
  loading?: boolean;
  error?: Error | null;
  status?: string;
  emptyState: string;
  thinkingLabel?: string;
  scrollRef?: RefObject<HTMLDivElement | null>;
  messageActions?: (message: HostedChatMessage) => React.ReactNode;
}

export default function HostedChatTranscript({
  messages,
  loading = false,
  error = null,
  status,
  emptyState,
  thinkingLabel = "Thinking...",
  scrollRef,
  messageActions,
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
    <div ref={activeScrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
      {loading && (
        <LoadingIndicator label="Loading messages" className="py-8" />
      )}

      {!loading && renderedMessages.length === 0 && !error && (
        <div className="py-8 text-center text-sm text-kumo-subtle">
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
                ? "bg-kumo-brand text-white"
                : "border border-kumo-line bg-kumo-recessed text-kumo-default"
            }`}
          >
            {message.toolCalls && message.toolCalls.length > 0 && (
              <div className="mb-2 space-y-1">
                {message.toolCalls.map((toolCall) => (
                  <details key={toolCall.id} className="text-xs">
                    <summary className="cursor-pointer font-medium text-kumo-info">
                      {toolCall.name}
                      {toolCall.pending ? " (running...)" : ""}
                      {toolCall.error ? " (failed)" : ""}
                    </summary>
                    {(toolCall.result || toolCall.error) && (
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded border border-kumo-line bg-kumo-base p-1.5 text-[10px]">
                        {(toolCall.error ?? toolCall.result ?? "").slice(0, 2000)}
                        {(toolCall.error ?? toolCall.result ?? "").length > 2000 ? "..." : ""}
                      </pre>
                    )}
                  </details>
                ))}
              </div>
            )}
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
            {messageActions?.(message)}
          </div>
        </div>
      ))}

      {error && (
        <div className="flex justify-start">
          <div className="max-w-[80%] rounded-lg border border-kumo-danger/30 bg-kumo-danger-tint px-3 py-2 text-sm text-kumo-danger">
            {error.message}
          </div>
        </div>
      )}

      {streaming &&
        renderedMessages[renderedMessages.length - 1]?.role !== "assistant" && (
          <div className="flex justify-start">
            <div className="animate-pulse rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-sm text-kumo-subtle">
              {thinkingLabel}
            </div>
          </div>
        )}
    </div>
  );
}
