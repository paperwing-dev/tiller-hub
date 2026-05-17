import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import HostedChatTranscript from "./HostedChatTranscript";
import PlanChatInput from "./PlanChatInput";
import {
  getHostedToolOutputFingerprint,
  listHostedToolOutputs,
} from "./hosted-chat";
import { getPlanChatName } from "./plan-repo";
import { PLAN_DEFAULT_MODEL, getPlanModelLabel } from "./plan-models";

export interface ForwardedReviewerMessage {
  id: string;
  reviewerModel: string;
  text: string;
}

interface PlanWriterChatProps {
  repoId: string;
  planArtifactId: string;
  forwardedMessages: ForwardedReviewerMessage[];
  onForwardedMessageSent: (id: string) => void;
  onSaved: () => void;
  onConflict: () => void;
  resetToken?: number;
  onStreamingChange?: (streaming: boolean) => void;
}

export default function PlanWriterChat({
  repoId,
  planArtifactId,
  forwardedMessages,
  onForwardedMessageSent,
  onSaved,
  onConflict,
  resetToken = 0,
  onStreamingChange,
}: PlanWriterChatProps) {
  const handledSaveFingerprintRef = useRef("");
  const handledResetTokenRef = useRef(resetToken);
  const sentForwardedMessageIdsRef = useRef(new Set<string>());
  const [sentForwardNotice, setSentForwardNotice] =
    useState<ForwardedReviewerMessage | null>(null);

  const agentName = useMemo(
    () => getPlanChatName(repoId, planArtifactId),
    [repoId, planArtifactId],
  );
  const agentOptions = useMemo(
    () => ({
      agent: "plan-chat",
      name: agentName,
    }),
    [agentName],
  );
  const agent = useAgent(agentOptions);
  const chatBody = useCallback(
    () => ({ repoId, planArtifactId }),
    [repoId, planArtifactId],
  );
  const chatOptions = useMemo(
    () => ({
      agent,
      body: chatBody,
    }),
    [agent, chatBody],
  );
  const { messages, sendMessage, clearHistory, status, error } =
    useAgentChat(chatOptions);
  const streaming = status === "submitted" || status === "streaming";
  const saveFingerprint = useMemo(
    () => getHostedToolOutputFingerprint(messages, "save_plan"),
    [messages],
  );

  useEffect(() => {
    onStreamingChange?.(streaming);
  }, [onStreamingChange, streaming]);

  useEffect(() => {
    if (resetToken === handledResetTokenRef.current) return;
    handledResetTokenRef.current = resetToken;
    clearHistory();
  }, [clearHistory, resetToken]);

  useEffect(() => {
    if (streaming) return;
    const next = forwardedMessages.find(
      (message) => !sentForwardedMessageIdsRef.current.has(message.id),
    );
    if (!next) return;

    sentForwardedMessageIdsRef.current.add(next.id);
    sendMessage({
      role: "user",
      parts: [{ type: "text", text: formatForwardedReviewerMessage(next) }],
    } as UIMessage);
    onForwardedMessageSent(next.id);
    setSentForwardNotice(next);
  }, [forwardedMessages, onForwardedMessageSent, sendMessage, streaming]);

  useEffect(() => {
    if (!sentForwardNotice) return;
    const timeoutId = window.setTimeout(() => setSentForwardNotice(null), 3500);
    return () => window.clearTimeout(timeoutId);
  }, [sentForwardNotice]);

  useEffect(() => {
    if (
      !saveFingerprint ||
      saveFingerprint === handledSaveFingerprintRef.current
    )
      return;
    handledSaveFingerprintRef.current = saveFingerprint;
    const outputs = listHostedToolOutputs(messages, "save_plan");
    const latest = outputs[outputs.length - 1];
    if (isRecord(latest) && latest.status === "conflict") {
      onConflict();
      return;
    }
    if (isRecord(latest) && latest.status === "ok") {
      onSaved();
    }
  }, [messages, onConflict, onSaved, saveFingerprint]);

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

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-b border-[#d0d7de] bg-[#f6f8fa] px-4 py-2">
        <div className="text-xs font-medium text-[#57606a]">
          Plan Writer · {getPlanModelLabel(PLAN_DEFAULT_MODEL)}
        </div>
      </div>
      <HostedChatTranscript
        messages={messages}
        loading={!agent.identified && messages.length === 0}
        error={error}
        status={status}
        emptyState="Tell the writer what plan to create or revise."
      />
      {sentForwardNotice && (
        <div className="border-t border-[#d0d7de] bg-[#f6f8fa] px-4 py-2 text-xs text-[#57606a]">
          Sent reviewer feedback from{" "}
          {getPlanModelLabel(sentForwardNotice.reviewerModel)} to the writer.
        </div>
      )}
      <PlanChatInput
        disabled={streaming}
        placeholder="Ask the writer to update the plan..."
        onSend={handleSend}
      />
    </div>
  );
}

function formatForwardedReviewerMessage(
  message: ForwardedReviewerMessage,
): string {
  const quotedText = message.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return [
    "Please evaluate this reviewer feedback and update the plan if it improves the plan.",
    "---",
    `Forwarded from reviewer ${message.reviewerModel}:`,
    quotedText,
  ].join("\n\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
