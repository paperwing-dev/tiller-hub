import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { AgentContext } from "agents";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  generateText,
  isTextUIPart,
  stepCountIs,
  type StreamTextOnFinishCallback,
  type UIMessage,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  buildSystemPrompt,
  createCodemodeTool,
  createHostedToolRegistry,
  createWorkspaceAccess,
  getAgentSpec,
  getHostedToolsForAgent,
  resolveAgentModel,
  toAiSdkTools,
  type WorkspaceStub,
} from "../agent-core";
import { getWorkspaceStub } from "../helpers";
import type { Env } from "../types";

function getLatestUserPrompt(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role !== "user") continue;

    const text = message.parts
      .filter(isTextUIPart)
      .map((part) => part.text)
      .join("")
      .trim();

    if (text) return text;
  }

  return "Explore the workspace and summarize what you found.";
}

function serializeToolResult(result: unknown): string {
  if (typeof result === "string") return result;

  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

export class CartographerChatAgent extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  declare readonly name: string;
  private readonly appEnv: Env;

  constructor(ctx: AgentContext, env: Env) {
    super(ctx, env);
    this.appEnv = env;
  }

  async onChatMessage(
    _onFinish: StreamTextOnFinishCallback<any>,
    _options?: OnChatMessageOptions,
  ): Promise<Response> {
    const spec = getAgentSpec("cartographer");
    const workspaceStub = getWorkspaceStub(this.appEnv, this.name) as WorkspaceStub;
    const workspace = createWorkspaceAccess(workspaceStub);
    const toolRegistry = createHostedToolRegistry(workspace);
    const hostedTools = getHostedToolsForAgent(toolRegistry, spec);
    const workspaceTools = toAiSdkTools(hostedTools);
    const codemode = createCodemodeTool({
      loader: this.appEnv.LOADER,
      tools: workspaceTools,
    });
    const tools = { codemode };
    const systemPrompt = await buildSystemPrompt(spec, workspace);
    const model = resolveAgentModel(this.appEnv, spec);
    const workersAI = createWorkersAI({ binding: this.appEnv.AI });
    const modelMessages = await convertToModelMessages(this.messages, { tools });
    const latestUserPrompt = getLatestUserPrompt(this.messages);

    const stream = createUIMessageStream({
      originalMessages: this.messages,
      execute: async ({ writer }) => {
        const exploration = await generateText({
          model: workersAI.chat(model),
          system: systemPrompt,
          messages: modelMessages,
          tools,
          stopWhen: stepCountIs(1),
        });

        for (const toolCall of exploration.toolCalls) {
          writer.write({
            type: "tool-input-available",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            input: toolCall.input,
          });
        }

        for (const toolResult of exploration.toolResults) {
          writer.write({
            type: "tool-output-available",
            toolCallId: toolResult.toolCallId,
            output: toolResult.output,
          });
        }

        let summary = exploration.text.trim();

        if (!summary) {
          const serializedOutputs = exploration.toolResults
            .map((toolResult) => {
              return [
                `Tool: ${toolResult.toolName}`,
                `Input: ${serializeToolResult(toolResult.input)}`,
                `Output: ${serializeToolResult(toolResult.output)}`,
              ].join("\n");
            })
            .join("\n\n---\n\n")
            .slice(0, 20_000);

          const summaryResult = await generateText({
            model: workersAI.chat(model),
            system:
              "You are summarizing the result of a repository cartography run for a user. " +
              "Write a concise direct answer in normal prose. " +
              "If an artifact was saved, mention that the fuller result is available in the artifact panel. " +
              "Do not dump raw tool payloads or generated code.",
            prompt: [
              `User request: ${latestUserPrompt}`,
              "Repository cartography result:",
              serializedOutputs || "(no tool result output)",
            ].join("\n\n"),
          });

          summary = summaryResult.text.trim();
        }

        if (!summary) {
          summary =
            "The cartography run completed and saved an artifact. Open the artifact panel for the full result.";
        }

        const textId = `text-${crypto.randomUUID()}`;
        writer.write({ type: "text-start", id: textId });
        writer.write({ type: "text-delta", id: textId, delta: summary });
        writer.write({ type: "text-end", id: textId });
      },
    });

    return createUIMessageStreamResponse({ stream });
  }
}

export const CARTOGRAPHER_CHAT_AGENT_PATH = "cartographer-chat";
