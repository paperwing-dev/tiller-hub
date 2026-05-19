import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import type { AgentContext } from "agents";
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type StreamTextOnFinishCallback,
} from "ai";
import { createWorkersAI } from "workers-ai-provider";
import {
  buildSystemPrompt,
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

export class ResearchChatAgent extends AIChatAgent<Env> {
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
    const spec = getAgentSpec("research");

    const workspaceStub = getWorkspaceStub(this.appEnv, this.name);
    const workspace = createWorkspaceAccess(workspaceStub);
    const toolRegistry = createHostedToolRegistry(workspace);
    const hostedTools = getHostedToolsForAgent(toolRegistry, spec);
    const tools = toAiSdkTools(hostedTools);
    const systemPrompt = await buildSystemPrompt(spec, workspace);
    const model = resolveAgentModel(this.appEnv, spec);
    const workersAI = createWorkersAI({ binding: this.appEnv.AI });
    const modelMessages = await convertToModelMessages(this.messages, { tools });

    const result = streamText({
      model: workersAI.chat(model),
      system: systemPrompt,
      messages: modelMessages,
      tools,
      stopWhen: stepCountIs(spec.maxSteps ?? 25),
    });

    return result.toUIMessageStreamResponse();
  }
}

export const RESEARCH_CHAT_AGENT_PATH = "research-chat";
