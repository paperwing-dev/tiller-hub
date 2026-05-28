import React, { useCallback, useMemo, useState } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import HostedChatTranscript from "./HostedChatTranscript";
import PlanChatInput from "./PlanChatInput";
import type { HostedChatMessage } from "./hosted-chat";
import { getReviewerChatName } from "./plan-repo";
import { getPlanModelLabel } from "./plan-models";

interface ReviewerChatProps {
  repoId: string;
  threadId: string;
  reviewerModel: string;
  hidden?: boolean;
  onForward: (text: string) => void;
}

export default function ReviewerChat({
  repoId,
  threadId,
  reviewerModel,
  hidden = false,
  onForward,
}: ReviewerChatProps) {
  const [forwardedMessageIds, setForwardedMessageIds] = useState<Set<string>>(
    () => new Set(),
  );

  const agentName = useMemo(
    () => getReviewerChatName(repoId, threadId),
    [repoId, threadId],
  );
  const agentOptions = useMemo(
    () => ({
      agent: "reviewer-chat",
      name: agentName,
    }),
    [agentName],
  );
  const agent = useAgent(agentOptions);
  const chatBody = useCallback(
    () => ({ repoId, threadId }),
    [repoId, threadId],
  );
  const chatOptions = useMemo(
    () => ({
      agent,
      body: chatBody,
    }),
    [agent, chatBody],
  );
  const { messages, sendMessage, status, error } = useAgentChat(chatOptions);
  const streaming = status === "submitted" || status === "streaming";

  const handleSend = useCallback(
    (message: string) => {
      if (streaming) return;
      sendMessage({
        role: "user",
        parts: [{ type: "text", text: message }],
      } as UIMessage);
    },
    [sendMessage, streaming],
  );

  const handleForward = useCallback(
    (messageId: string, text: string) => {
      onForward(text);
      setForwardedMessageIds((current) => new Set(current).add(messageId));
    },
    [onForward],
  );

  const renderMessageActions = useCallback(
    (message: HostedChatMessage) =>
      message.role === "assistant" && message.content.trim() ? (
        <button
          onClick={() => handleForward(message.id, message.content)}
          disabled={forwardedMessageIds.has(message.id)}
          className="mt-2 rounded border border-[#d0d7de] bg-white px-2 py-1 text-xs text-[#57606a] hover:bg-[#f6f8fa] disabled:border-[#bbf7d0] disabled:bg-[#f0fdf4] disabled:text-[#15803d]"
        >
          {forwardedMessageIds.has(message.id)
            ? "Sent to Writer"
            : "Send to Writer"}
        </button>
      ) : null,
    [forwardedMessageIds, handleForward],
  );

  return (
    <div
      className={`h-full min-h-0 flex-1 flex-col ${hidden ? "hidden" : "flex"}`}
    >
      <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2 text-xs font-medium text-[#57606a]">
        Reviewer · {getPlanModelLabel(reviewerModel)}
      </div>
      <HostedChatTranscript
        messages={messages}
        loading={!agent.identified && messages.length === 0}
        error={error}
        status={status}
        emptyState="Ask this reviewer to critique the current plan."
        messageActions={renderMessageActions}
      />
      <PlanChatInput
        disabled={streaming}
        placeholder="Ask for a code-aware critique..."
        onSend={handleSend}
      />
    </div>
  );
}
