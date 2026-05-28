import { getToolName, isTextUIPart, isToolUIPart, type UIMessage } from "ai";

export interface HostedChatToolCall {
  id: string;
  name: string;
  result?: string;
  error?: string;
  pending: boolean;
}

export interface HostedChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: HostedChatToolCall[];
}

export function serializeHostedToolOutput(output: unknown): string {
  if (typeof output === "string") return output;

  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

export function toHostedChatMessage(message: UIMessage): HostedChatMessage | null {
  if (message.role !== "user" && message.role !== "assistant") {
    return null;
  }

  const content = message.parts
    .filter(isTextUIPart)
    .map((part) => part.text)
    .join("");

  const toolCalls = message.parts
    .filter(isToolUIPart)
    .map((part) => {
      const state = part.state;

      return {
        id: part.toolCallId,
        name: getToolName(part),
        result:
          state === "output-available" ? serializeHostedToolOutput(part.output) : undefined,
        error: state === "output-error" ? part.errorText : undefined,
        pending: state !== "output-available" && state !== "output-error",
      } satisfies HostedChatToolCall;
    });

  return {
    id: message.id,
    role: message.role,
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export function listHostedChatMessages(messages: UIMessage[]): HostedChatMessage[] {
  return messages
    .map(toHostedChatMessage)
    .filter((message): message is HostedChatMessage => message !== null);
}

export function getHostedToolOutputFingerprint(
  messages: UIMessage[],
  toolName: string,
): string {
  return messages
    .flatMap((message) =>
      message.parts
        .filter(isToolUIPart)
        .filter((part) => getToolName(part) === toolName && part.state === "output-available")
        .map((part) => `${part.toolCallId}:${serializeHostedToolOutput(part.output)}`),
    )
    .join("|");
}

export function listHostedToolOutputs(messages: UIMessage[], toolName: string): unknown[] {
  return messages.flatMap((message) =>
    message.parts
      .filter(isToolUIPart)
      .filter((part) => getToolName(part) === toolName && part.state === "output-available")
      .map((part) => part.output),
  );
}
